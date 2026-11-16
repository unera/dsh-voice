// The closing turn against the channel's real order of work.
//
// A `deliverables/presented` record is not delivered when it is written: `dsh-im`
// accepts it only while the turn is open, copies the file into its own snapshot
// directory afterwards, and re-checks the turn once the copy and its digest are
// done (`semantic/artifact.mjs:493` and `:506`). The claim itself happens later
// still, after `turn/end`. So three moments decide whether a voice note arrives:
//
//   append the record  ->  channel copies the file (turn still open?)  ->  turn/end  ->  claim
//
// This file plays exactly those three moments, in that order, against the real
// hook. The control case is the bug: with no wait (`settleMs: 0`) the copy
// finishes after the turn has closed and the channel drops the file without a
// word — which is what a Host showed, and why the wait exists.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PRESENTED_EVENT, installReply } from '../reply.mjs'
import {
  assistantMessage,
  fakeLogger,
  stubHost,
  stubService,
  turnStart,
  userMessage,
  voiceDocument,
} from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * The channel's side of the delivery, reduced to the three facts that decide it.
 *
 * `copyMs` is the copy into `/tmp/dsh-im-outbound-*`, `hashMs` the digest taken
 * of that copy afterwards — the registry does both before it looks at the turn
 * again, and a copy that outlives the turn is deleted, not queued.
 */
function channel ({ dir, copyMs = 30, hashMs = 10 }) {
  const state = { turn: 9, open: true, queue: [], copies: 0, copiesDone: 0, dropped: 0, claimed: [] }
  const copies = []
  const snapshotDir = join(dir, 'dsh-im-outbound-TEST')
  const copy = async (source) => {
    state.copies += 1
    const target = join(snapshotDir, `copy-${state.copies}.artifact`)
    await mkdir(snapshotDir, { recursive: true })
    await copyFile(source, target)
    await sleep(hashMs)
    state.copiesDone += 1
    if (!state.open) {
      state.dropped += 1
      await rm(target, { force: true })
      return
    }
    state.queue.push({ path: target, source })
  }
  return {
    state,
    /** What `session/event` dispatch does: synchronously, inside `append`. */
    observe (type, data) {
      if (type !== PRESENTED_EVENT || data?.turn !== state.turn || !state.open) return
      for (const file of Array.isArray(data.files) ? data.files : []) copies.push(copy(file.path))
    },
    /** The Host closes the turn once the hook has returned. */
    close (log) {
      state.open = false
      log.push({ type: 'turn/end', seq: log.length, time: Date.now(), data: { turn: state.turn, reason: { kind: 'completed' } } })
    },
    /** `deliverArtifacts`: settle the copies still in flight, then take the queue. */
    async claim () {
      await Promise.allSettled(copies)
      state.claimed = state.queue.splice(0)
      return state.claimed
    },
  }
}

/** A Session that dispatches its own appends, the way the real one does. */
function session ({ channel: sink, events }) {
  const log = [...events]
  return {
    header: { id: 'session-order', cwd: '/tmp' },
    snapshotEvents: () => log,
    append (type, data) {
      const event = { type, seq: log.length, time: Date.now(), data }
      log.push(event)
      sink.observe(type, data)
      return event
    },
    log,
  }
}

/** One spoken closing turn, played to the end of the delivery order. */
async function speak (t, { settleMs, copyMs, hashMs, withChannel = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-order-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // A private stand-in for the Host's temp directory: the probe must never look at
  // the real /tmp, where a running dsh-im keeps its own snapshots.
  const dir = join(root, 'tmp')
  await mkdir(dir)

  // No channel at all: nothing listens, so no snapshot directory ever appears.
  const sink = channel({ dir, copyMs, hashMs })
  const sess = session({
    channel: withChannel ? sink : { observe () {} },
    events: [turnStart(9), userMessage('курс?'), assistantMessage(voiceDocument('Курс вырос.'), { turn: 9 })],
  })
  const host = stubHost({ logger: fakeLogger() })
  const config = {
    ...(settleMs === undefined ? {} : { settleMs }),
    deps: { probe: { dir } },
  }
  installReply(host, { config, service: stubService() })
  const listener = host.listeners.find((entry) => entry.event === 'agent/turn-stopping').listener

  const startedAt = Date.now()
  const outcome = await listener({ agent: { session: sess }, turn: 9 })
  const heldMs = Date.now() - startedAt

  if (withChannel) sink.close(sess.log)
  const claimed = withChannel ? await sink.claim() : []
  return { outcome, sink, claimed, heldMs, log: sess.log, dir }
}

test('the record is declared before the turn closes, and held until the channel copied it', async (t) => {
  const { outcome, sink, claimed, heldMs, log } = await speak(t, { settleMs: 600 })

  // The order the channel depends on: the record is in the log before turn/end.
  const presented = log.find((event) => event.type === PRESENTED_EVENT)
  const ended = log.find((event) => event.type === 'turn/end')
  assert.ok(presented && ended, 'both the record and the turn boundary are in the log')
  assert.ok(presented.seq < ended.seq, 'the record precedes turn/end')

  // And the copy the channel makes after that record found the turn open.
  assert.equal(sink.state.copies, 1)
  assert.equal(sink.state.copiesDone, 1)
  assert.equal(sink.state.dropped, 0, 'the copy was not thrown away for a closed turn')
  assert.equal(claimed.length, 1, 'the channel claimed the voice note')
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.handoff, 'taken')
  // The claimed snapshot is the audio this package announced, byte for byte.
  assert.deepEqual(await readFile(claimed[0].path), await readFile(presented.data.files[0].path))
  assert.ok(heldMs < 3000, `the turn was held for the copy, not for a budget: ${heldMs}ms`)
})

test('without the wait the channel drops the file and nobody hears why', async (t) => {
  // The control: the same turn, the same channel, no hold. This is the failure
  // the wait fixes, reproduced — a test that passes without the fix tests nothing.
  const { outcome, sink, claimed, log } = await speak(t, { settleMs: 0 })

  assert.equal(sink.state.copies, 1, 'the channel did try to copy the file')
  assert.equal(sink.state.dropped, 1, 'the copy outlived the turn and was dropped')
  assert.equal(claimed.length, 0, 'there was nothing left to claim')
  assert.equal(outcome.delivered, true, 'the record itself was still appended')
  assert.equal(outcome.handoff, 'unknown', 'no budget, no answer to the question')
  assert.ok(log.some((event) => event.type === PRESENTED_EVENT), 'the record is in the log either way')
})

test('a host with no channel pays a short window, not the whole budget', async (t) => {
  const { outcome, heldMs } = await speak(t, { settleMs: 600, withChannel: false })

  assert.equal(outcome.delivered, true)
  assert.equal(outcome.handoff, 'no-channel')
  // The creation window is 150ms by default; the answer must not wait for the
  // budget of a channel that is not there.
  assert.ok(heldMs < 1000, `a missing channel cost ${heldMs}ms`)
})

test('the answer text is untouched by the wait', async (t) => {
  const answer = voiceDocument('Курс вырос.')
  for (const settleMs of [600, 0]) {
    const { log } = await speak(t, { settleMs })
    const message = log.find((event) => event.type === 'assistant/message')
    assert.equal(message.data.message.content[0].text, answer, `settleMs=${settleMs} leaves the answer alone`)
    assert.deepEqual(
      log.map((event) => event.type),
      ['turn/start', 'user/message', 'assistant/message', PRESENTED_EVENT, 'turn/end'],
      'the plugin adds one record and nothing else',
    )
  }
})
