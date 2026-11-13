import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTrace, epochMs } from '../trace.mjs'

/** A logger that keeps every line, so the exact text can be asserted. */
function recorder () {
  const lines = []
  return {
    lines,
    log: {
      info: (line) => lines.push(line),
      warn: () => {},
      debug: () => {},
    },
  }
}

/** A clock that moves only when told to. */
function clock (start = 1_763_038_800_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => { now += ms },
  }
}

test('only whole positive milliseconds count', () => {
  assert.equal(epochMs('1763038800123'), 1763038800123)
  assert.equal(epochMs(42), 42)
  assert.equal(epochMs('12.5'), null)
  assert.equal(epochMs('-1'), null)
  assert.equal(epochMs('0'), null)
  assert.equal(epochMs('x'), null)
  assert.equal(epochMs(undefined), null)
})

test('stages are written in the order they happen, each with its milliseconds', () => {
  const { lines, log } = recorder()
  const time = clock()
  const trace = createTrace({ id: 'take-1', node: 'A059P', log, now: time.now })

  trace.mark('received')
  time.advance(120)
  trace.mark('transcribed')
  time.advance(30)
  trace.mark('delivered')
  time.advance(700)
  trace.mark('turn-start', { turn: 3 })
  time.advance(400)
  trace.mark('turn-end', { reason: 'completed' })

  assert.deepEqual(lines, [
    '[dsh-voice] exchange take-1 node=A059P stage=received ms=0',
    '[dsh-voice] exchange take-1 node=A059P stage=transcribed ms=120',
    '[dsh-voice] exchange take-1 node=A059P stage=delivered ms=150',
    '[dsh-voice] exchange take-1 node=A059P stage=turn-start ms=850 turn=3',
    '[dsh-voice] exchange take-1 node=A059P stage=turn-end ms=1250 reason=completed',
  ])
})

test('the closing line carries the segments that actually happened', () => {
  const { lines, log } = recorder()
  const time = clock()
  const at = {
    recordStart: 1_763_038_800_000,
    recordStop: 1_763_038_801_200,
    sentAt: 1_763_038_801_300,
    receivedAt: 1_763_038_801_550,
  }
  const trace = createTrace({ id: 'take-2', node: 'A059P', at, log, now: time.now })

  trace.mark('received')
  time.advance(300)
  trace.mark('transcribed')
  time.advance(20)
  trace.mark('delivered')
  time.advance(1000)
  trace.mark('turn-start', { turn: 1 })
  time.advance(2000)
  trace.mark('turn-end', { reason: 'completed' })
  trace.mark('split', { speakChars: 24 })
  time.advance(250)
  trace.mark('synthesized', { seconds: 3.1 })
  time.advance(80)
  trace.mark('spoken')

  const closing = trace.done('ok')
  const done = lines.at(-1)
  assert.equal(done, '[dsh-voice] exchange take-2 node=A059P done total=3650ms '
    + 'segments={record: 1200, upload: 250, stt: 300, model: 2000, tts: 250, play: 80}')
  assert.deepEqual(closing.segments, { record: 1200, upload: 250, stt: 300, model: 2000, tts: 250, play: 80 })
  assert.equal(closing.total, 3650)
})

test('without client times the record and upload segments simply do not exist', () => {
  const { lines, log } = recorder()
  const time = clock()
  const trace = createTrace({ id: 'take-3', log, now: time.now })
  trace.mark('received')
  time.advance(100)
  trace.mark('transcribed')
  trace.done('ok')

  const done = lines.at(-1)
  assert.doesNotMatch(done, /record:/)
  assert.doesNotMatch(done, /upload:/)
  assert.match(done, /stt: 100/)
  assert.doesNotMatch(done, /model:/)
  assert.doesNotMatch(done, /reason=/)
})

test('a failed exchange says why in the same closing line', () => {
  const { lines, log } = recorder()
  const time = clock()
  const trace = createTrace({ id: 'take-4', node: 'X', log, now: time.now })
  trace.mark('received')
  time.advance(50)
  trace.mark('transcribed')
  trace.done('empty')

  assert.match(lines.at(-1), /done total=50ms segments=\{stt: 50\} reason=empty/)
})

test('a segment that went backwards is dropped, not printed as a fact', () => {
  const { lines, log } = recorder()
  const time = clock()
  // the device clock says it sent the file after the server received it
  const trace = createTrace({
    id: 'take-5',
    at: { sentAt: 1_763_038_900_000, receivedAt: 1_763_038_800_000 },
    log,
    now: time.now,
  })
  trace.mark('received')
  trace.done('ok')
  assert.doesNotMatch(lines.at(-1), /upload:/)
})

test('a missing id is generated rather than leaving the line nameless', () => {
  const { lines, log } = recorder()
  const trace = createTrace({ log, now: clock().now })
  trace.mark('received')
  const first = lines[0]
  assert.ok(first.startsWith('[dsh-voice] exchange '), first)
  assert.ok(first.endsWith('stage=received ms=0'), first)
  const id = first.slice('[dsh-voice] exchange '.length, first.indexOf(' stage='))
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})
