// Did the delivery side take the record — and, while it has not, keep the turn open.
//
// The record this package appends is read by whoever listens to
// `deliverables/presented`. `dsh-im` accepts it only while the turn is open and
// a channel delivery consumer owns that turn, and it returns silently otherwise
// — so a rejected record looks exactly like a delivered one from here.
//
// This probe answers the question without reading that code: when `dsh-im`
// accepts the record it copies the file into its own managed directory
// (`/tmp/dsh-im-outbound-*`, one `.artifact` per file) before the channel claims
// it. Seeing a byte-identical copy appear after our append therefore means the
// record was taken; seeing none within the window means it was dropped, and the
// reason is on the consumer side, not in this package.
//
// It is also more than a diagnostic: that copy is the work `dsh-im` does *after*
// the record lands, and its registry re-checks the open turn once the copy and
// its digest are done (`semantic/artifact.mjs:506`). A copy that finishes after
// `turn/end` is dropped without a word, which is exactly what a record appended
// at the last moment of the turn used to suffer. Waiting here while the hook is
// still running keeps the turn open until the channel owns the file.
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Prefix of the directory `dsh-im` creates for its own snapshots. */
export const SNAPSHOT_PREFIX = 'dsh-im-outbound-'

/** Suffix of one snapshot file inside it. */
const SNAPSHOT_SUFFIX = '.artifact'

/**
 * How long an absent snapshot directory is waited for.
 *
 * `dsh-im` creates one directory per process, lazily, together with its first
 * copy. So an empty listing means either "the first copy is being written right
 * now" or "there is no channel in this Host at all", and the two are told apart by
 * this window: a Host without `dsh-im` pays it once per spoken reply, not a whole
 * budget.
 */
export const DEFAULT_CREATION_WINDOW_MS = 150

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** sha256 of a file, or null when it cannot be read. */
async function digestOf (path, read) {
  try {
    return createHash('sha256').update(await read(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * One round of the search: is a byte-identical copy of this file in a snapshot?
 *
 * @param options.candidates - snapshot directory names under `dir`.
 * @param options.digest - sha256 of the delivered file.
 * @param options.size - its size, used to skip the hashing of everything else.
 * @param options.since - a directory unwritten since then cannot hold the copy.
 * @param options.deps - test seams (`readdir`, `stat`, `readFile`).
 * @returns the matching snapshot path, or null.
 */
async function findSnapshot ({ candidates, digest, size, since, dir, deps }) {
  const list = deps.readdir ?? readdir
  const inspect = deps.stat ?? stat
  const read = deps.readFile ?? readFile
  for (const name of candidates) {
    const directory = join(dir, name)
    // A directory `dsh-im` has not written into since this delivery cannot hold
    // its copy, and there is one such directory per process — so this check is
    // what keeps the poll from walking every session's leftovers.
    let dirInfo
    try {
      dirInfo = await inspect(directory)
    } catch {
      continue
    }
    if (Number(dirInfo?.mtimeMs) + 5 < since) continue
    let entries
    try {
      entries = await list(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!String(entry).endsWith(SNAPSHOT_SUFFIX)) continue
      const path = join(directory, String(entry))
      let info
      try {
        info = await inspect(path)
      } catch {
        continue
      }
      if (!info?.isFile?.() || Number(info.size) !== size) continue
      // A snapshot may be written a moment before its size settles; the mtime
      // check keeps this probe from mistaking an older same-sized file.
      if (Number(info.mtimeMs) + 5 < since) continue
      if (await digestOf(path, read) !== digest) continue
      return path
    }
  }
  return null
}

/**
 * Wait a short while for `dsh-im` to take a copy of the delivered file.
 *
 * @param options.path - the file this package declared.
 * @param options.since - when it was declared (epoch ms); older copies do not count.
 * @param options.timeoutMs - how long to look; the turn is open, so this is a delay.
 * @param options.intervalMs - pause between rounds.
 * @param options.creationWindowMs - how long an as yet absent snapshot directory is waited for.
 * @param options.dir - directory holding the snapshot directories.
 * @param options.deps - test seams (`readdir`, `stat`, `readFile`, `sleep`, `now`).
 * @returns `{taken, snapshot, rounds, reason}`; `reason` is `'no-directory'` when no
 *   snapshot directory appeared within the creation window, `'timed-out'` otherwise.
 */
export async function waitForSnapshot ({
  path,
  since = Date.now(),
  timeoutMs = 400,
  intervalMs = 25,
  creationWindowMs = DEFAULT_CREATION_WINDOW_MS,
  dir = tmpdir(),
  deps = {},
}) {
  const list = deps.readdir ?? readdir
  const inspect = deps.stat ?? stat
  const read = deps.readFile ?? readFile
  const pause = deps.sleep ?? sleep
  const now = deps.now ?? Date.now
  let size
  try {
    size = Number((await inspect(path)).size)
  } catch {
    return { taken: false, snapshot: null, rounds: 0, reason: 'no-file' }
  }
  const digest = await digestOf(path, read)
  if (digest === null) return { taken: false, snapshot: null, rounds: 0, reason: 'no-file' }

  // One listing of the parent; later rounds reuse it, because a snapshot lands
  // inside a directory that already exists. An empty listing is listed again —
  // that is the case of the very first copy, which is what creates the directory.
  const startedAt = now()
  const deadline = startedAt + Math.max(0, Number(timeoutMs) || 0)
  const directoryDeadline = Math.min(deadline, startedAt + Math.max(0, Number(creationWindowMs) || 0))
  let candidates = null
  let rounds = 0
  for (;;) {
    rounds += 1
    if (candidates === null || candidates.length === 0) {
      try {
        candidates = (await list(dir)).map(String).filter((name) => name.startsWith(SNAPSHOT_PREFIX))
      } catch {
        candidates = []
      }
    }
    if (candidates.length > 0) {
      const snapshot = await findSnapshot({ candidates, digest, size, since, dir, deps })
      if (snapshot !== null) return { taken: true, snapshot, rounds, reason: 'taken' }
    } else if (now() >= directoryDeadline) {
      return { taken: false, snapshot: null, rounds, reason: 'no-directory' }
    }
    if (now() >= deadline) return { taken: false, snapshot: null, rounds, reason: 'timed-out' }
    const until = candidates.length > 0 ? deadline : directoryDeadline
    await pause(Math.min(intervalMs, Math.max(1, until - now())))
  }
}
