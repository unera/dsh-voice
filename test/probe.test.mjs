// The snapshot probe: what it waits for, and how long it waits when nobody is there.
//
// `dsh-im` creates one snapshot directory per process, lazily, together with its
// first copy. The probe therefore has two cases that look alike from the outside —
// "the first copy is being written right now" and "this Host has no channel at all"
// — and they are told apart by a short creation window instead of a full budget.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_CREATION_WINDOW_MS, SNAPSHOT_PREFIX, waitForSnapshot } from '../probe.mjs'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function scratch (t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('the prefix the probe looks for is the one dsh-im creates', () => {
  assert.equal(SNAPSHOT_PREFIX, 'dsh-im-outbound-')
})

test('no snapshot directory means no channel: the creation window ends the wait', async (t) => {
  const root = await scratch(t)
  const file = join(root, 'voice.ogg')
  await writeFile(file, 'audio')

  const startedAt = Date.now()
  const result = await waitForSnapshot({
    path: file,
    since: startedAt,
    timeoutMs: 2000,
    creationWindowMs: 60,
    dir: root,
  })

  const waited = Date.now() - startedAt
  assert.deepEqual([result.taken, result.reason], [false, 'no-directory'])
  assert.ok(waited >= 60, `the window is honoured: ${waited}ms`)
  assert.ok(waited < 1000, `the whole budget is not spent on nobody: ${waited}ms`)
  assert.equal(result.snapshot, null)
})

test('a directory created while the probe is running is still found', async (t) => {
  // The first copy of a fresh process creates the directory it copies into, so the
  // probe has to re-list instead of remembering an empty answer.
  const root = await scratch(t)
  const file = join(root, 'voice.ogg')
  await writeFile(file, 'audio')

  const since = Date.now() - 1000
  const waiting = waitForSnapshot({
    path: file,
    since,
    timeoutMs: 3000,
    intervalMs: 10,
    creationWindowMs: 1000,
    dir: root,
  })
  await sleep(60)
  const snapshotDir = join(root, `${SNAPSHOT_PREFIX}late`)
  await mkdir(snapshotDir, { recursive: true })
  await copyFile(file, join(snapshotDir, 'copy.artifact'))

  const result = await waiting
  assert.equal(result.taken, true)
  assert.equal(result.snapshot, join(snapshotDir, 'copy.artifact'))
})

test('a copy of the same size but other bytes is not the delivered file', async (t) => {
  const root = await scratch(t)
  const file = join(root, 'voice.ogg')
  await writeFile(file, 'audio')
  const snapshotDir = join(root, `${SNAPSHOT_PREFIX}TEST`)
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(join(snapshotDir, 'other.artifact'), 'AXdio')

  const result = await waitForSnapshot({ path: file, since: Date.now() - 1000, timeoutMs: 200, dir: root })
  assert.deepEqual([result.taken, result.reason], [false, 'timed-out'])
})

test('a copy older than the declaration is not ours', async (t) => {
  const root = await scratch(t)
  const file = join(root, 'voice.ogg')
  await writeFile(file, 'audio')
  const snapshotDir = join(root, `${SNAPSHOT_PREFIX}TEST`)
  await mkdir(snapshotDir, { recursive: true })
  await copyFile(file, join(snapshotDir, 'old.artifact'))
  await sleep(30)

  // Declared now, so the copy written before it cannot be the one this delivery
  // is waiting for — an earlier turn of the same session has the same file.
  const result = await waitForSnapshot({ path: file, since: Date.now(), timeoutMs: 150, dir: root })
  assert.equal(result.taken, false)
})

test('the creation window is short enough to be a default', () => {
  assert.ok(DEFAULT_CREATION_WINDOW_MS > 0 && DEFAULT_CREATION_WINDOW_MS <= 500)
})
