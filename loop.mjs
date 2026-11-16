// The voice loop: what happens between "the person pressed talk" and "the phone answers".
//
// A device cannot push a recording by itself — the transfer endpoint accepts an answer to a
// `copyFromDevice` command, so the host has to ask. That inverts the obvious design: the
// phone says "I want to talk" (an event, no text, nothing delivered), and this side does
// the asking, transcribing, delivering and speaking back.
//
// Every outside world dependency is passed in, so the whole loop can be exercised on stubs:
// no device, no model, no speech service.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

import { splitReply } from './markup.mjs'
import { createTrace } from './trace.mjs'
import { toVoiceNote } from './audio.mjs'

/**
 * How long the device may take to hand over a recording, in seconds.
 *
 * A press means "I am talking now", so the take arrives within seconds. The
 * previous 45s was the whole command timeout: every exchange whose take had
 * already been consumed waited it out, and the phone's command queue piled up
 * behind it, so answers arrived three or four questions late.
 */
const RECORD_TIMEOUT_SECONDS = 12
/** How long a synthesized file waits for the device to fetch it before it is litter. */
const AUDIO_TTL_MS = 120_000
/**
 * How long one exchange may wait for an answer before it is declared stuck.
 *
 * Without this a dropped turn held the device forever: the next press queued behind a wait that
 * nobody would ever end.
 */
const EXCHANGE_TIMEOUT_MS = 180_000
/** The language we ask the recognizer for, unless the host says otherwise. */
const DEFAULT_LANGUAGE = 'ru'
/**
 * Below this a recording is a button click, not speech.
 *
 * A 0.2-second take has almost no signal in it, and a recognizer asked to decode noise happily
 * answers in whatever language its model drifts to — that is how a cough became a Japanese
 * sentence and went into the session as the person's words.
 */
const MIN_SECONDS = 0.4
/**
 * What happens to a recording once the exchange is over.
 *
 * `last` keeps the newest take of every node, so "what was actually heard" can be listened to
 * afterwards; `none` is the old behaviour, where the file went as soon as it was used.
 */
export const KEEP_LAST = 'last'
export const KEEP_NONE = 'none'
/** How long a kept recording lives: a day is enough to go back and listen to it. */
export const RECORDING_TTL_MS = 24 * 60 * 60 * 1000
/** The age sweep runs once a boot and then once a day: nothing else has to hold the timer. */
const SWEEP_INTERVAL_MS = RECORDING_TTL_MS
/** Where the device uploads land: `<cacheDir>/incoming/<run>/<node>/<id>.wav`. */
const INCOMING_DIR = 'incoming'
/** Where a synthesized answer waits for the device: `<cacheDir>/out/<run>/<id>.ogg`. */
const OUTPUT_DIR = 'out'
/**
 * How long the leftovers of a finished run may stay on disk before a boot removes them.
 *
 * Age is the rule, not ownership: a second process may share this cache, and a file may still be
 * read or downloaded right after a restart, so "everything that is not mine" would delete live
 * work. An hour is longer than any take or answer lives here, and it is the same grace a rendered
 * answer gets while the device fetches it.
 */
export const RUN_STALE_MS = 60 * 60 * 1000

/**
 * A fresh identifier for one run of the loop: `<pid>-<six hex>`.
 *
 * The cache is shared by everything that starts with the same `cacheDir`, and before this a
 * restart found the previous process's takes under the very same `<node>` names, with no way to
 * tell whose they were. A run id in the path makes the question answerable and keeps the
 * directories of two processes apart — for reading, and for cleaning.
 *
 * The pid alone is not identity enough: the kernel reuses a number, so a directory left by a
 * process that had that number would look like this one's own. The random tail makes the pair
 * unique in practice; both parts stay short and safe as one path segment.
 *
 * @returns `<pid>-<6 hex>`.
 */
export function newRunId () {
  return `${process.pid}-${randomBytes(3).toString('hex')}`
}

/**
 * Read a run id from the config, and keep it usable as one path segment.
 *
 * The value becomes a directory name, so a separator, a `..` or an absolute path would decide
 * where the loop writes. Anything that is not a plain name character is replaced; a value that
 * carries nothing usable falls back to a fresh id, because a missing run must not become a shared
 * directory again.
 *
 * @param value - the configured run id, or anything else.
 * @returns the sanitised id, or a fresh one.
 */
export function resolveRunId (value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  // `.` and `..` are the two names a path segment may not be.
  if (!safe || /^\.+$/.test(safe)) return newRunId()
  return safe
}

/**
 * The same path with every symlink on the way resolved.
 *
 * A lexical `resolve` compares strings, and a symlink is a string that looks local while pointing
 * anywhere: `cache/incoming/A059P/link.wav -> /etc/shadow` passed a lexical check, and the
 * recognizer was handed the target's bytes. So the check has to ask the filesystem.
 *
 * A path that does not exist yet — a retry naming a file the device is about to write — is
 * resolved through its nearest existing ancestor, with the missing tail kept as written. A
 * failure that is not "no such file" (a symlink loop, a permission wall) is not resolvable at
 * all, and the caller refuses it.
 *
 * @param path - the path to resolve.
 * @returns the real path, or null when it cannot be resolved.
 */
function realPath (path) {
  try {
    return realpathSync(path)
  } catch {}
  let current = resolve(path)
  const tail = []
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return null
    tail.unshift(basename(current))
    current = parent
    try {
      return join(realpathSync(current), ...tail)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null
    }
  }
}

/**
 * Do these two paths name the same file, however each was spelled?
 *
 * Both sides are already known to be inside the cache, so they resolve; a path that does not is
 * not the same file as anything.
 *
 * @param a - one path.
 * @param b - the other path.
 * @returns true when both resolve to the same real path.
 */
function sameFile (a, b) {
  const left = realPath(a)
  return Boolean(left) && left === realPath(b)
}

/**
 * Is this path strictly under that directory, with symlinks resolved on both sides?
 *
 * @param path - the path from an event.
 * @param root - the directory it has to be inside.
 * @returns true only for a real path strictly under the real root.
 */
function underReal (path, root) {
  return underResolved(realPath(path), realPath(root))
}

/**
 * The same test on two paths that are already resolved: one `realPath` per side, not two.
 *
 * @param target - an already resolved path.
 * @param base - an already resolved directory.
 * @returns true only for a real path strictly under the real root.
 */
function underResolved (target, base) {
  if (!target || !base) return false
  return target.startsWith(base + sep)
}

/**
 * Is this path a recording the loop may read and delete?
 *
 * A recording path arrives in an event, and the file is read and then removed: `keepRecording:
 * none` unlinks it, `last` prunes its directory whole. The event source is internal, but the
 * boundary belongs to this plugin, so every path is checked before it is touched — against this
 * run's `incoming/`, never against the cache root: the root holds `sessions.json`, and pruning
 * "the directory of the take" there deletes the node → session bindings.
 *
 * @param path - the path from the event.
 * @param cacheDir - the voice cache.
 * @param runId - the run whose uploads may be touched.
 * @returns true only for a path strictly under `<cacheDir>/incoming/<run>/`.
 */
export function insideCache (path, cacheDir, runId) {
  if (typeof path !== 'string' || !path) return false
  return underReal(path, runIncomingDir(cacheDir, runId))
}

/**
 * Which node directory a path belongs to, and which of the two layouts matched.
 *
 * The device event carries both the node number and its name, and `dsh-nodes` names the
 * directory after the number while older code used the name. A check against one of them
 * refuses a perfectly good recording, so both are tried.
 *
 * The directory that really holds the file is returned with the segment, not just the segment:
 * a caller that removes or prunes decides by the path that matched, and the two layouts differ
 * in depth (`<incoming>/<node>/` against `<incoming>/<run>/<node>/`). Composing the directory
 * from the segment is how the cleanup kept looking in a place where the file never was.
 *
 * @param path - the path from the event.
 * @param cacheDir - the voice cache.
 * @param segments - candidate directory names, in order of preference.
 * @param runId - the run whose uploads may be touched; another run's directory never matches.
 * @returns `{segment, dir, path}` with `dir` resolved, or null when no layout matched.
 */
export function matchNodeDir (path, cacheDir, segments, runId) {
  if (typeof path !== 'string' || !path) return null
  const target = realPath(path)
  if (!target) return null
  for (const segment of segments) {
    if (typeof segment !== 'string' || !segment) continue
    // Our own per-run layout first, then the one `dsh-nodes` writes and knows nothing about.
    // Both are genuine: refusing the other one is how the voice chat went silent twice.
    for (const candidate of [nodeDir(cacheDir, segment, runId), nodeDir(cacheDir, segment)]) {
      const base = realPath(candidate)
      if (underResolved(target, base)) return { segment, dir: base, path: target }
    }
  }
  return null
}

/**
 * Which node segment of this run a path belongs to, if any.
 *
 * @param path - the path from the event.
 * @param cacheDir - the voice cache.
 * @param segments - candidate directory names, in order of preference.
 * @param runId - the run whose uploads may be touched; another run's directory never matches.
 * @returns the segment that matched, or null.
 */
export function matchNodeSegment (path, cacheDir, segments, runId) {
  return matchNodeDir(path, cacheDir, segments, runId)?.segment ?? null
}

/**
 * The uploads of one run: `<cacheDir>/incoming/<run>`.
 *
 * @param cacheDir - the voice cache.
 * @param runId - the run.
 * @returns the run's incoming directory.
 */
export function runIncomingDir (cacheDir, runId) {
  return join(cacheDir, INCOMING_DIR, runId)
}

/**
 * The rendered answers of one run: `<cacheDir>/out/<run>`.
 *
 * @param cacheDir - the voice cache.
 * @param runId - the run.
 * @returns the run's output directory.
 */
export function runOutputDir (cacheDir, runId) {
  return join(cacheDir, OUTPUT_DIR, runId)
}

/**
 * The directory of one node inside one run.
 *
 * The node name comes from an event and becomes a path segment, so anything that is not a plain
 * name character is replaced instead of being read as a separator.
 *
 * @param cacheDir - the voice cache.
 * @param nodeName - the device name.
 * @param runId - the run.
 * @returns `<cacheDir>/incoming/<run>/<safe node>`.
 */
export function nodeDir (cacheDir, nodeName, runId) {
  const safe = String(nodeName ?? '').replace(/[^A-Za-z0-9._-]/g, '_') || '_'
  // Without a run there is no run segment: that is the layout `dsh-nodes` writes, and the
  // guard has to understand it as well as our own.
  if (runId === undefined || runId === null || runId === '') return join(cacheDir, INCOMING_DIR, safe)
  return join(runIncomingDir(cacheDir, runId), safe)
}

/**
 * Read the `keepRecording` setting.
 *
 * Anything other than `none` means `last`: a typo must not silently throw the takes away, and
 * keeping a recording is the harmless direction for a mistake to lean.
 *
 * @param value - the value from the plugin config.
 * @returns `last` or `none`.
 */
export function resolveKeepRecording (value) {
  return typeof value === 'string' && value.trim().toLowerCase() === KEEP_NONE ? KEEP_NONE : KEEP_LAST
}

/** Files of one directory, with the mtime the retention rules look at. */
function filesIn (dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (stat.isFile()) files.push({ path, mtimeMs: stat.mtimeMs })
    } catch {}
  }
  return files
}

/**
 * Everything a directory holds, with the type the cleanup rules need.
 *
 * `lstat`, not `stat`: a symlink is an entry of this directory, and neither its target's age nor
 * its target's type may decide whether the link is removed.
 *
 * @param dir - the directory to read.
 * @returns one entry per name: `{path, name, isDirectory, mtimeMs}`; empty for a missing directory.
 */
function entriesIn (dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      entries.push({ path, name, isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs })
    } catch {}
  }
  return entries
}

/**
 * Every file under a directory, down to `depth` levels.
 *
 * The cache nests `<incoming>/<run>/<node>/<id>` and `<out>/<run>/<id>`, so two walks replace the
 * two hard-coded levels the sweep used to know about.
 *
 * @param dir - the directory to read.
 * @param depth - how many levels below `dir` to look.
 * @returns the files, with their mtimes.
 */
function filesUnder (dir, depth) {
  if (depth <= 0) return []
  const files = []
  for (const entry of entriesIn(dir)) {
    if (entry.isDirectory) files.push(...filesUnder(entry.path, depth - 1))
    else files.push({ path: entry.path, mtimeMs: entry.mtimeMs })
  }
  return files
}

/**
 * Remove every recording of one node directory except the newest one.
 *
 * The take that has just been used is passed as `prefer`: it is the last one by construction, and
 * on an equal mtime (two files written inside the same millisecond) it is the one meant to stay.
 *
 * @param dir - the node directory.
 * @param options - `prefer`, the path that must survive; `log` for a failed unlink.
 * @returns the path that was kept, or null for an empty or missing directory.
 */
export function pruneRecordings (dir, { prefer = null, log = null } = {}) {
  const files = filesIn(dir)
  if (files.length === 0) return null
  let keep = files[0]
  for (const file of files.slice(1)) {
    const newer = file.mtimeMs > keep.mtimeMs
    const sameAndPreferred = file.mtimeMs === keep.mtimeMs && file.path === prefer
    if (newer || sameAndPreferred) keep = file
  }
  for (const file of files) {
    if (file.path === keep.path) continue
    try {
      rmSync(file.path, { force: true })
    } catch (error) {
      log?.warn?.('[dsh-voice] could not remove an old recording:', error?.message ?? error)
    }
  }
  return keep.path
}

/**
 * Delete recordings older than the retention window, in every run directory.
 *
 * A plain mtime sweep: no bookkeeping file, so a take left behind by a crash is removed by the
 * same rule as one that was kept on purpose. It is the insurance policy for a process that lives
 * for weeks — the boot cleanup (below) is what handles the leftovers of a process that is gone.
 *
 * @param cacheDir - the voice cache, whose `incoming/` holds the uploads.
 * @param options - `now`, `maxAgeMs` and `log`, all for tests and for a quiet failure.
 * @returns the removed paths.
 */
export function sweepRecordings (cacheDir, { now = Date.now(), maxAgeMs = RECORDING_TTL_MS, log = null } = {}) {
  const removed = []
  const expire = (file) => {
    if (now - file.mtimeMs <= maxAgeMs) return
    try {
      rmSync(file.path, { force: true })
      removed.push(file.path)
    } catch (error) {
      log?.warn?.('[dsh-voice] could not remove an expired recording:', error?.message ?? error)
    }
  }
  // A rendered answer is removed as soon as the device takes it, with a two-minute guard for a
  // device that never answers. A crash between the two leaves an orphan, and this sweep is what
  // keeps it from living forever; the age window is the recording one, the guard is the fast path.
  for (const file of filesUnder(join(cacheDir, OUTPUT_DIR), 3)) expire(file)
  for (const file of filesUnder(join(cacheDir, INCOMING_DIR), 3)) expire(file)
  return removed
}

/**
 * The mtime of a directory, or infinity when it cannot be read.
 *
 * Infinity keeps an unreadable directory: a failed `stat` is not evidence of age.
 *
 * @param path - the directory.
 * @returns its mtime in milliseconds.
 */
function mtimeOf (path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Remove the files of one tree that are older than the window, and the directories they empty.
 *
 * The age that decides is the file's own. Both writers — the loop and `dsh-nodes` — update the
 * mtime of `<node>/` when a take lands, and neither touches `<run>/`: a fresh recording can sit in
 * a run directory that looks two hours old, and a decision made at directory level deletes the
 * words a neighbour has just put there.
 *
 * An empty directory goes only when it is old itself or when this pass has just emptied it: a
 * neighbour may have created it a second ago and be about to write its first take.
 *
 * @param dir - the directory to sweep.
 * @param ctx - `now`, `maxAgeMs`, `log` and the `removed` list to fill.
 * @returns true when the directory itself is now empty and may be removed.
 */
function sweepStaleTree (dir, ctx) {
  let emptied = false
  for (const entry of entriesIn(dir)) {
    if (entry.isDirectory) {
      if (!sweepStaleTree(entry.path, ctx)) continue
      ctx.remove(entry.path)
      emptied = true
      continue
    }
    if (ctx.now - entry.mtimeMs <= ctx.maxAgeMs) continue
    ctx.remove(entry.path)
    emptied = true
  }
  if (entriesIn(dir).length > 0) return false
  return emptied || ctx.now - mtimeOf(dir) > ctx.maxAgeMs
}

/**
 * Remove what earlier runs left behind, before this one talks to anybody.
 *
 * The rule is age, not ownership. Another process may share this `cacheDir`, and a recording or an
 * answer may still be read or downloading right after a restart; deleting "everything that is not
 * mine" would delete live work of a neighbour. An hour of age is the safe signal, and it is the
 * same grace the device gets to fetch a rendered answer.
 *
 * Age is measured on the files, not on the directories that hold them: writing a take updates
 * `<node>/` and nothing above it, so a run started this morning can hold a file written a minute
 * ago. What is left empty behind the removed files is swept as well. The directories of this run
 * are never touched, however old the clock says they are — this process is the one using them.
 *
 * @param cacheDir - the voice cache.
 * @param runId - the run that is starting.
 * @param options - `now`, `maxAgeMs` and `log`, for tests and a quiet failure.
 * @returns the removed paths.
 */
export function cleanRunCache (cacheDir, runId, { now = Date.now(), maxAgeMs = RUN_STALE_MS, log = null } = {}) {
  const removed = []
  const remove = (path) => {
    try {
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    } catch (error) {
      log?.warn?.('[dsh-voice] could not remove a stale cache entry:', error?.message ?? error)
    }
  }
  const ctx = { now, maxAgeMs, log, remove }
  // A symlink is compared by its target: a link in `incoming/` that points into this run would
  // otherwise let the sweep walk straight into the directories it must never touch.
  const mine = new Set([runIncomingDir(cacheDir, runId), runOutputDir(cacheDir, runId)].map((dir) => realPath(dir)))
  // The run's own directory is created here, before the first exchange and before any timer: a
  // device may write into it at any moment, and an empty directory is cheaper to explain than a
  // missing one.
  mkdirSync(runIncomingDir(cacheDir, runId), { recursive: true })
  for (const root of [join(cacheDir, INCOMING_DIR), join(cacheDir, OUTPUT_DIR)]) {
    for (const entry of entriesIn(root)) {
      if (mine.has(realPath(entry.path))) continue
      // A stray file directly under `incoming/` or `out/`: the same age rule, one level less.
      if (!entry.isDirectory) {
        if (now - entry.mtimeMs > maxAgeMs) remove(entry.path)
        continue
      }
      if (sweepStaleTree(entry.path, ctx)) remove(entry.path)
    }
  }
  return removed
}

/**
 * Quote one path for a POSIX shell.
 *
 * `JSON.stringify` is not shell quoting: it escapes for JSON, and a path containing `$(…)` or a
 * backtick would still be executed by `sh -c`.
 *
 * @param value - the path to quote.
 * @returns the path inside single quotes, safe to paste into a command.
 */
export function shellQuote (value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** How often one node may warm the model up: entering and leaving a screen is not a reason. */
const WARMUP_DEBOUNCE_MS = 60_000
/** What we say when the recording produced no words. */
const NOT_HEARD = 'Не расслышал, повтори пожалуйста.'
/**
 * What we say when there is no recognizer at all.
 *
 * Without it nothing can be transcribed, so the press cannot be answered — but it must be said:
 * a press that ends in silence is indistinguishable from a broken button.
 */
const NO_TRANSCRIBER = 'Не могу распознать речь: на хосте нет сервиса распознавания.'
/** What we say when the device could not even start a recording. */
const RECORD_REFUSED = 'Не смог начать запись'

/**
 * Turn a refused `voice.record` into one short sentence for the person.
 *
 * A timeout is the expected case and keeps its own wording; everything else — permission, a
 * cancelled take, a `status: ok` without a path, a rejected call — names the reason it carried.
 *
 * @param record - the answer of `voice.record`, or the failure the call produced.
 * @returns a sentence to speak on the device.
 */
export function refusalText (record) {
  if (record?.code === 'voice_timeout') return 'Не услышал попробуй ещё раз.'
  const raw = String(record?.message ?? record?.code ?? record?.status ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
  // `status: ok` without a path names no reason at all: it is said like one.
  const reason = !raw || raw === 'ok' || raw === 'failed' ? 'устройство не отдало запись' : raw
  return `${RECORD_REFUSED}: ${reason.slice(0, 120)}.`
}

/** File that remembers which session a node talks to, next to the recordings. */
const BINDINGS_FILE = 'sessions.json'

/**
 * Read the node → session bindings.
 *
 * A missing or broken file is not an error: the loop then creates a session on
 * the next take, which is exactly what a fresh install does anyway.
 *
 * @param cacheDir - directory shared with the recordings.
 * @param log - logger for a file that could not be parsed.
 * @returns a map of node name to session id.
 */
export function loadBindings (cacheDir, log = console) {
  const file = join(cacheDir, BINDINGS_FILE)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Map(Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value))
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log.warn?.('[dsh-voice] bindings file is unusable, starting empty:', error?.message ?? error)
  }
  return new Map()
}

/**
 * Write the bindings back; the directory is created when it is missing.
 *
 * @param cacheDir - directory shared with the recordings.
 * @param bindings - the map to persist.
 * @param log - logger for a write that failed.
 */
export function saveBindings (cacheDir, bindings, log = console) {
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, BINDINGS_FILE), JSON.stringify(Object.fromEntries(bindings), null, 2))
  } catch (error) {
    log.warn?.('[dsh-voice] could not save bindings:', error?.message ?? error)
  }
}

/**
 * The tool calls this assistant message asks for, in order.
 *
 * `assistantTextOf` deliberately ignores them (a message of calls says nothing out loud), but the
 * screen needs exactly them: while the model works, the only honest thing to show is which tool is
 * running.
 *
 * @param event - one session event.
 * @returns tool names, possibly an empty list.
 */
export function toolCallNamesOf (event) {
  if (event?.type !== 'assistant/message') return []
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block?.type === 'tool-call')
    .map((block) => String(block.name ?? block.toolName ?? '').trim())
    .filter(Boolean)
}

/** Read the text out of one assistant message event, or null when it carries none. */
export function assistantTextOf (event) {
  if (event?.type !== 'assistant/message') return null
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return null
  const text = content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
    .trim()
  // A message that is only tool calls says nothing out loud.
  if (!text || content.some((block) => block?.type === 'tool-call')) return null
  return text ? { turn: event.data?.turn ?? null, text } : null
}

/**
 * Build the loop.
 *
 * @param deps - everything the loop touches, so a test can replace all of it.
 * @param deps.nodes - the `nodes` service: `call(node, api, method, data, options)`.
 * @param deps.speechToText - the recognition service, or null when it is not installed.
 * @param deps.textToSpeech - the synthesis service; optional.
 * @param deps.serviceFor - the Host's lazy getter: `(name) => service | null`. When given, it is
 *   what every optional service read goes through, so a plugin that registers after this one is
 *   still found and a missing one degrades instead of stopping the loop.
 * @param deps.sessions - the session service (`flush`).
 * @param deps.sessionController - resolves and creates sessions.
 * @param {string} deps.cacheDir - where a recording is kept on the host while it is used.
 * @param {object} [deps.log] - `{info, warn, debug}`; console-like.
 * @param {Function} [deps.createUserMessage] - DSH message constructor, for `source`.
 * @param {Function} [deps.on] - subscription for session events.
 * @param {string} [deps.keepRecording] - `last` (default) keeps the newest take of every node,
 *   `none` removes every take once it is used.
 * @param {number} [deps.warmupDebounceMs] - how long one node's warmup holds; a test value.
 * @param {string} [deps.runId] - the name of this process inside the cache; a fresh
 *   `<pid>-<6 hex>` when it is not given.
 * @returns `{ handle, handleUpload, observeSessionEvent, runId, pending, dispose }`
 */
export function createVoiceLoop ({
  nodes,
  speechToText = null,
  textToSpeech = null,
  serviceFor = null,
  sessions = null,
  sessionController = null,
  cacheDir,
  log = console,
  createUserMessage = null,
  // Who is talking: the assistants service names the persona for a session. Optional — a Host
  // without that plugin simply shows no name.
  assistants = null,
  on = null,
  emit = null,
  exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS,
  language = DEFAULT_LANGUAGE,
  minSeconds = MIN_SECONDS,
  keepRecording = KEEP_LAST,
  warmupDebounceMs = WARMUP_DEBOUNCE_MS,
  // The directory this process owns inside the cache. Left out, a fresh one is made here; a test
  // (or a host that wants a stable name) may pass its own.
  runId = null,
}) {
  /**
   * A service, read at the moment it is needed.
   *
   * The synthesizer may legitimately be absent (`synth=device` is the default) or may register
   * after this plugin: reading it once at build time was how a host with nodes and recognition
   * lost the whole loop over an optional service.
   */
  const stt = () => (typeof serviceFor === 'function' ? serviceFor('speechToText') : speechToText)
  const tts = () => (typeof serviceFor === 'function' ? serviceFor('textToSpeech') : textToSpeech)

  /** `last` or `none`, decided once: the config cannot change under a running loop. */
  const keeping = resolveKeepRecording(keepRecording)
  /**
   * This process's own directory inside the cache: decided once, at build time.
   *
   * Everything the loop writes goes under it, so the files of one run are never confusable with
   * those of another and a boot can tell whom a leftover belongs to.
   */
  const run = resolveRunId(runId)
  /** One entry per node that is currently being talked to. */
  const active = new Map()
  /** node → session id, kept across exchanges and restarts (`sessions.json`). */
  const bindings = loadBindings(cacheDir, log)
  /** Serialise binding writes: two exchanges may finish at once. */
  let saving = Promise.resolve()
  /** node → tail of its exchange queue: one press, one answer, in order. */
  const queues = new Map()
  /** session id → { node, mode } for the turns whose answer must be spoken. */
  const awaiting = new Map()
  /** assistant text collected for the turn being awaited, keyed by session id. */
  const drafts = new Map()
  const disposers = []

  function stopWatching () {
    while (disposers.length) {
      const dispose = disposers.pop()
      try {
        dispose?.()
      } catch {}
    }
  }

  /** Where a synthesized answer waits for the device to fetch it: `<cacheDir>/out/<run>`. */
  const answersDir = runOutputDir(cacheDir, run)

  /** Nodes whose "new session" arrived while an exchange was still running. */
  const resetPending = new Set()

  /** When each node last warmed the synthesizer up, for the debounce. */
  const warmups = new Map()

  /** Recording ids already delivered: a retry must not become a second answer. */
  const seen = new Map()
  const SEEN_LIMIT = 200
  /**
   * Recording ids whose exchange is running right now.
   *
   * The id used to be remembered only after a delivery, so two copies of one recording that
   * arrived while the first was still waiting for the model (up to three minutes) both passed the
   * check and the person was answered twice. The reservation is taken when the event is accepted
   * and released when the exchange ends, whatever the outcome — a failed exchange must leave the
   * id free, because the client re-sends it on purpose.
   *
   * The value is the path that exchange is reading. A retry of one id is written to the same
   * `<cacheDir>/incoming/<node>/<id>.wav`, so "drop the duplicate's file" would delete the take
   * the running exchange still has to read — and with `keepRecording: last` the person's
   * recording was gone after a perfectly normal retry.
   */
  const inFlight = new Map()

  /**
   * Show one line on the device screen.
   *
   * This is a side command: it never joins the exchange queue, and its failure never costs the
   * answer. A phone whose screen is off, a build without `voice.chat`, a full queue — all of it is
   * a log line, and the turn goes on.
   *
   * @param args - node, role, text, the exchange id, and the trace to stamp.
   */
  function pushChat ({ node, role, text, speak = null, id = null, trace = null, say = null, audio = null, who = null, degraded = null }) {
    const body = String(text ?? '').trim()
    if (!body) return
    const stage = role === 'user' ? 'chat-user' : 'chat-assistant'
    try {
      const pending = nodes.call(node, 'voice', 'chat', {
        role,
        text: body,
        ...speak === null ? {} : { speak: String(speak) },
        ...id ? { id } : {},
        ...typeof say === 'boolean' ? { say } : {},
        ...audio ? { audio } : {},
        // The screen draws the assistant's name and icon beside the line.
        ...role === 'assistant' && who?.name ? { who } : {},
        ...degraded ? { degraded } : {},
      })
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => log.warn?.('[dsh-voice] the screen did not take the line:', error?.message ?? error))
      }
    } catch (error) {
      log.warn?.('[dsh-voice] the screen did not take the line:', error?.message ?? error)
    }
    // Two sizes side by side: a short `speak` next to a long `text` is normal (the screen shows
    // details), a `speak` that does not come from the model's words is what this stage exposes.
    trace?.mark(stage, role === 'assistant' ? { speakChars: String(speak ?? '').length, textChars: body.length } : {})
  }

  /**
   * The assistant's name for this session, asked at most once per exchange.
   *
   * @param sessionId - the session whose persona to read.
   * @returns `{name, icon}` or null when nobody is assigned or the service is absent.
   */
  function whoFor (sessionId) {
    if (!assistants?.personaOf || !sessionId) return null
    try {
      const persona = assistants.personaOf(sessionId)?.assistant
      if (!persona?.name) return null
      return persona.icon ? { name: persona.name, icon: persona.icon } : { name: persona.name }
    } catch (error) {
      log.warn?.('[dsh-voice] could not read the assistant name:', error?.message ?? error)
      return null
    }
  }

  /** Everything that has to disappear after one exchange. */
  function cleanup (paths) {
    for (const path of paths) {
      try {
        rmSync(path, { force: true })
      } catch {}
    }
  }

  /**
   * Put a used recording away.
   *
   * `keepRecording: last` leaves the take in place — the question "what did it actually hear"
   * can only be answered while the file exists — and removes the node's older ones, so the
   * directory holds exactly one file. `none` is the old behaviour: the file goes at once.
   *
   * The question asked here is the one the receiving path asks, through the same check: both
   * layouts of a take are genuine, `<incoming>/<run>/<node>/` when the loop wrote it and
   * `<incoming>/<node>/` when `dsh-nodes` did. A single-layout guard refused the second one, so
   * `none` left the file on disk and `last` never pruned it — and every upload logged a false
   * "refusing to touch a file outside the voice cache".
   *
   * @param path - the recording the exchange just used.
   * @param nodeName - the device the exchange belongs to; when known the take must sit in its
   *   directory, because `last` prunes the whole directory the file is really in.
   * @returns the kept path, or null when it was removed.
   */
  function discardRecording (path, nodeName = null) {
    // The directory comes from the path that matched, never from the segment: the flat layout has
    // one level fewer, so a directory composed from the name is a place the file is not.
    const known = nodeName !== null && nodeName !== undefined && nodeName !== ''
    const matched = known
      ? matchNodeDir(path, cacheDir, [nodeName], run)
      : (insideCache(path, cacheDir, run) ? { dir: dirname(path) } : null)
    if (!matched) {
      // A path that is not ours is neither read nor removed: `none` would unlink an arbitrary
      // file, and `last` would prune a directory belonging to somebody else — `cacheDir` itself
      // included, which is where `sessions.json` lives.
      log.warn?.('[dsh-voice] refusing to touch a file outside the voice cache', { path, node: nodeName })
      return null
    }
    if (keeping !== KEEP_LAST) {
      cleanup([path])
      return null
    }
    try {
      return pruneRecordings(matched.dir, { prefer: path, log })
    } catch (error) {
      log.warn?.('[dsh-voice] could not tidy the recordings:', error?.message ?? error)
      return path
    }
  }

  // The previous process is gone, and its directories are litter — but only once they are old
  // enough that no neighbour sharing this cache and no half-finished download can still be using
  // them. Nothing here runs on a timer, and nothing speaks to a device before it has finished.
  try {
    const cleaned = cleanRunCache(cacheDir, run, { log })
    if (cleaned.length > 0) log.info?.('[dsh-voice] removed what an earlier run left', { count: cleaned.length, run })
  } catch (error) {
    log.warn?.('[dsh-voice] the startup cleanup failed:', error?.message ?? error)
  }

  // A kept recording must not live forever: one sweep at boot, then once a day. The timer is
  // unref'd, so it never keeps a process alive on its own.
  const sweep = () => {
    try {
      const removed = sweepRecordings(cacheDir, { log })
      if (removed.length > 0) log.info?.('[dsh-voice] removed expired recordings', { count: removed.length })
    } catch (error) {
      log.warn?.('[dsh-voice] the recording sweep failed:', error?.message ?? error)
    }
  }
  sweep()
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
  if (typeof sweepTimer?.unref === 'function') sweepTimer.unref()

  /** Say something short on the device through its own engine, best effort. */
  async function say (node, text) {
    // A device that cannot be reached must not turn a report into a crash: the caller is already
    // in the middle of telling the person what went wrong.
    try {
      const answer = await nodes.call(node, 'voice', 'say', { text })
      if (answer?.status !== 'ok') log.warn?.('[dsh-voice] the device did not speak:', answer?.message ?? answer?.code)
      return answer
    } catch (error) {
      log.warn?.('[dsh-voice] the device did not speak:', error?.message ?? error)
      return null
    }
  }

  /** Ask the device how much of the words it heard. */
  async function transcribe (audioPath, trace = null) {
    const recognizer = stt()
    if (!recognizer) throw Object.assign(new Error('speech recognition is not installed'), { code: 'no_speech' })
    const audio = readFileSync(audioPath)
    // The language is named, not inherited: a Host default of `auto` lets a short noisy take drift
    // into any language the model likes, and the person's words are then translated by accident.
    let spec = null
    try {
      spec = recognizer.resolve({ audio, language })
    } catch (error) {
      // A provider that does not take this language is not an emergency: say so and let the
      // service pick its own default rather than losing the recording.
      log.warn?.('[dsh-voice] the recognizer does not take the configured language:', error?.message ?? error)
      spec = recognizer.resolve({ audio })
    }
    trace?.mark('stt-request', { provider: spec?.provider?.info?.id ?? 'default', language })
    return await recognizer.transcribe(spec, new AbortController().signal)
  }

  /**
   * Deliver the transcript as a user message whose source says it came from a voice.
   *
   * Same shape dsh-nodes uses for device events: the model gets a `kind` it can trust, and
   * `voice: true` is what the pre-step annotation and any future dispatcher read.
   */
  async function deliver ({ sessionId, text, node, mode }) {
    const resolved = await sessionController.resolveAgent(sessionId)
    if (!resolved || resolved.error || !resolved.agent) {
      throw new Error(`сессия ${sessionId} недоступна: ${resolved?.error?.message ?? 'не найдена'}`)
    }
    const built = typeof createUserMessage === 'function'
      ? createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-nodes', voice: true, device: node, mode },
      })
      : null
    // The constructor may be unavailable (or not loaded yet); the hand-built message keeps the
    // same `source`, which is the only part the rest of the Host reads.
    const message = built ?? {
      id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-nodes', voice: true, device: node, mode },
    }
    resolved.agent.followup(message)
    Promise.resolve(sessions?.flush?.(resolved.agent.session)).catch(() => {})
    return resolved.agent
  }

  /**
   * Tell the Host who is talking and through what, before the Session exists.
   *
   * `dsh-assistants` keeps the pairing of a session with its transport, bot and
   * chat from this very event: without it a voice session is `unknown`, so rules
   * like "transport=telegram -> user UNera" never match it and only the defaults
   * apply — the assistant was attached, the person was not.
   *
   * The device id goes into `botId` on purpose: rules can then name one phone and
   * leave the others alone.
   *
   * @param sessionId - the id the session is about to be created with.
   * @param node - the node id, the same number the admin calls a device.
   * @param nodeName - the human name of that device.
   */
  function announceBinding (sessionId, node, nodeName) {
    if (typeof emit !== 'function') return
    try {
      emit('dsh-im/session-pre-bind', Object.freeze({
        sessionId,
        transport: 'nodes',
        channel: 'nodes',
        botId: `nodes_${node}`,
        conversationKey: `nodes:${node}`,
        chatType: 'direct',
        chatId: String(node),
        threadId: null,
        senderId: null,
        senderName: nodeName ?? null,
      }))
    } catch (error) {
      log.warn?.('[dsh-voice] could not announce the binding:', error?.message ?? error)
    }
  }

  /** Which session this node talks to: the one it was told, the bound one, or a new one. */
  async function sessionFor (nodeName, requested, nodeId = null) {
    if (requested) {
      bind(nodeName, requested)
      return requested
    }
    const bound = bindings.get(nodeName)
    if (bound) return bound
    if (!sessionController?.create) throw new Error('нет сессии для голоса и нечем создать новую')
    const sessionId = `session-${randomUUID()}`
    // The announcement comes first and names the id the session will have: the
    // Host resolves identity synchronously while the prompt is assembled, so a
    // binding written afterwards would be too late for the first turn.
    announceBinding(sessionId, nodeId, nodeName)
    const created = await sessionController.create({ sessionId })
    if (!created?.sessionId) throw new Error('не удалось создать сессию под голос')
    log.info?.('[dsh-voice] created a session for voice', { session: created.sessionId, node: nodeName })
    bind(nodeName, created.sessionId)
    return created.sessionId
  }

  /** Remember that this node talks to this session, now and after a restart. */
  function bind (nodeName, sessionId) {
    if (!nodeName || !sessionId) return
    if (bindings.get(nodeName) === sessionId) return
    bindings.set(nodeName, sessionId)
    saving = saving.then(() => saveBindings(cacheDir, bindings, log)).catch(() => {})
  }

  /**
   * One full exchange: ask for a recording, transcribe, deliver, wait, speak.
   *
   * @param want - `{node, nodeName, mode, sessionId}` from the device event.
   * @returns a short outcome for the caller (and for the log).
   */
  async function handle (want) {
    const nodeName = want?.nodeName ?? String(want?.node ?? '')
    /** The directory key: the node number when there is one, the name only for old events. */
    const nodeKey = want?.node === undefined || want?.node === null ? nodeName : String(want.node)
    // A press is a promise: it must end in an answer, even while the previous
    // exchange is still waiting for the model. Refusing it as "busy" used to drop
    // the press, park its take, and then answer the previous question only when
    // the *next* press asked for a recording — the words arrived one message late
    // and the delay grew with every press.
    return await enqueue(nodeName, async () => await exchange(want, nodeName, nodeKey))
  }

  /**
   * Run one exchange behind whatever this node is already doing.
   *
   * The queue is keyed by a name that comes from an event: a key that is never removed is one
   * entry per device ever seen, held for the lifetime of the host. It is dropped once its chain
   * is the current one again and nothing waits behind it.
   *
   * @param nodeName - the node the exchange talks to.
   * @param run - the exchange itself.
   * @param label - the warning for a failure that escaped the exchange.
   * @returns what the exchange returned, or `{status: 'failed'}`.
   */
  function enqueue (nodeName, run, label = 'voice exchange failed') {
    const chain = queues.get(nodeName) ?? Promise.resolve()
    const mine = chain.then(run).catch((error) => {
      log.warn?.(`[dsh-voice] ${label}:`, error?.message ?? error)
      return { status: 'failed' }
    })
    const settled = mine.then(() => {}).catch(() => {})
    queues.set(nodeName, settled)
    void settled.then(() => {
      if (queues.get(nodeName) === settled) queues.delete(nodeName)
    })
    return mine
  }

  /**
   * Ask one node for something, and never let the call itself throw.
   *
   * A rejected `voice.record` or `copyFromDevice` used to travel to the outer catch, where it
   * became a single warning line: the person pressed, heard nothing, and had no way to know why.
   *
   * @param node - the node to call.
   * @param api - the node API number.
   * @param method - the method name.
   * @param data - its arguments.
   * @returns the answer, or a failure shaped like one.
   */
  async function callNode (node, api, method, data) {
    try {
      return await nodes.call(node, api, method, data)
    } catch (error) {
      return { status: 'failed', code: 'rejected', message: String(error?.message ?? error) }
    }
  }

  /**
   * Run one exchange, now that the queue reached it.
   *
   * @param want - the device event that asked for it.
   * @param nodeName - the node to talk to.
   * @returns a short outcome for the log.
   */
  async function exchange (want, nodeName, nodeKey = nodeName) {
    const trace = createTrace({ id: `pull-${nodeName}-${Date.now()}`, node: nodeName, log })
    trace.mark('received')
    active.set(nodeName, { sessionId: want?.sessionId ?? bindings.get(nodeName) ?? null })
    mkdirSync(cacheDir, { recursive: true })
    const record = await callNode(nodeName, 'voice', 'record', {
      mode: want?.mode ?? 'ptt',
      maxSeconds: 30,
      timeout: RECORD_TIMEOUT_SECONDS,
    })
    if (record?.status !== 'ok' || !record?.payload?.path) {
      releaseNode(nodeName)
      log.info?.('[dsh-voice] no recording', { node: nodeName, code: record?.code ?? record?.status })
      // Every refusal is said out loud: permission, a cancelled take, a `status: ok` with no
      // path, a rejected call — a press that ends in silence is indistinguishable from a button
      // that does not work.
      await say(nodeName, refusalText(record))
      trace.done('no-recording', { code: record?.code ?? record?.status ?? null, language })
      return { status: 'no-recording', code: record?.code ?? null }
    }
    const devicePath = record.payload.path
    // The take lands in the node's own directory, the same one a pushed recording uses: then
    // `keepRecording` and the age sweep treat both paths alike.
    const localPath = join(nodeDir(cacheDir, nodeKey, run), `take-${Date.now()}-${basename(devicePath)}`)
    mkdirSync(dirname(localPath), { recursive: true })
    const copy = await callNode(nodeName, 'files', 'copyFromDevice', { path: devicePath, hostPath: localPath })
    // The take belongs to the person's words: once it is here, the device copy is litter.
    await callNode(nodeName, 'shell', 'exec', { command: `rm -f -- ${shellQuote(devicePath)}` })
    if (copy?.status !== 'ok') {
      releaseNode(nodeName)
      cleanup([localPath])
      log.warn?.('[dsh-voice] the recording did not arrive', { node: nodeName, message: copy?.message })
      await say(nodeName, 'Не смог забрать запись.')
      trace.done('no-copy', { language })
      return { status: 'no-copy' }
    }
    const recordedSeconds = Number(record.payload.seconds)
    if (Number.isFinite(recordedSeconds) && recordedSeconds > 0 && recordedSeconds < minSeconds) {
      releaseNode(nodeName)
      discardRecording(localPath, nodeKey)
      trace.done('too-short', { language, seconds: recordedSeconds })
      return { status: 'too-short', code: 'too-short' }
    }
    let text = ''
    let failure = null
    try {
      const transcript = await transcribe(localPath, trace)
      text = String(typeof transcript === 'string' ? transcript : transcript?.text ?? '').trim()
    } catch (error) {
      failure = error
      log.warn?.('[dsh-voice] transcription failed:', error?.message ?? error)
    }
    trace.mark('transcribed')
    // The screen shows what the person said before the model sees it: a long silence is
    // otherwise indistinguishable from a lost recording.
    if (text) pushChat({ node: nodeName, role: 'user', text, trace })
    if (!text) {
      releaseNode(nodeName)
      discardRecording(localPath, nodeKey)
      // "I did not hear you" is a lie when there is no recognizer at all: the reason is named.
      const noRecognizer = failure?.code === 'no_speech'
      await say(nodeName, noRecognizer ? NO_TRANSCRIBER : NOT_HEARD)
      trace.done(noRecognizer ? 'no-stt' : 'empty', { language })
      return { status: noRecognizer ? 'no-stt' : 'empty' }
    }
    let sessionId
    try {
      sessionId = await sessionFor(nodeName, want?.sessionId ?? null, want?.node ?? null)
    } catch (error) {
      // This used to disappear into the outer catch: the words were never delivered, nothing was
      // said, and no closing line was written.
      releaseNode(nodeName)
      discardRecording(localPath, nodeKey)
      log.warn?.('[dsh-voice] could not get a session:', error?.message ?? error)
      await say(nodeName, 'Не смог начать новую сессию.')
      trace.done('no-session', { language })
      return { status: 'no-session' }
    }
    active.set(nodeName, { sessionId })
    // The wait is registered before the message is delivered: a turn that starts
    // and ends quickly otherwise finishes before anyone is awaiting it, and the
    // answer to the *previous* question is what gets spoken.
    awaiting.set(sessionId, watchForAnswer({
      sessionId, node: nodeName, mode: want?.mode ?? 'ptt', trace, synth: 'device',
      who: whoFor(sessionId),
    }))
    try {
      await deliver({ sessionId, text, node: nodeName, mode: want?.mode ?? 'ptt' })
      trace.mark('delivered')
    } catch (error) {
      releaseNode(nodeName)
      discardRecording(localPath, nodeKey)
      awaiting.delete(sessionId)
      log.warn?.('[dsh-voice] delivery failed:', error?.message ?? error)
      await say(nodeName, 'Не смог передать запрос.')
      trace.done('no-session', { language })
      return { status: 'no-session' }
    }
    discardRecording(localPath, nodeKey)
    return { status: 'delivered', session: sessionId, text }
  }

  /**
   * Remember one delivered recording id.
   *
   * A device that retries must not be answered twice: the id is the identity of one
   * exchange, not of one request. Old ids are dropped in insertion order, so the map cannot
   * grow for the lifetime of the host.
   *
   * This memory is deliberately not written to disk. A restart kills every exchange in flight,
   * so the client's retry of one has to be handled again — persisting the id would turn that
   * retry into "already answered" and lose the person's words, which is the worse failure. The
   * only case a file would cover is a delivery whose answer never reached the client, and that
   * one is better answered twice than never.
   *
   * @param id - the recording id, already keyed by node.
   * @returns true the first time this id is seen.
   */
  function rememberId (id) {
    if (seen.has(id)) return false
    seen.set(id, Date.now())
    while (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value)
    return true
  }

  /**
   * Handle a recording the device pushed itself: no command, the file is already here.
   *
   * @param event - `{node, nodeName, id, path, bytes, seconds}` from `dsh-nodes/voice`.
   * @returns a short outcome: `delivered`, `already`, `empty`, `no-file`.
   */
  async function handleUpload (event) {
    const id = String(event?.id ?? '')
    const path = typeof event?.path === 'string' ? event.path : ''
    if (!path) return { status: 'no-file' }
    const nodeName = event?.nodeName ?? String(event?.node ?? '')
    // The device number and the device name are both legitimate directory names: `dsh-nodes`
    // uses the number, older code used the name. Trying only one of them refused every real
    // recording once the two disagreed, so both are tried and the match decides the directory.
    // The number is the key; the name is only a fallback for recordings written by older
    // versions, which named the directory after the device.
    const segments = [event?.node, event?.nodeName].map((value) => (value === undefined || value === null ? '' : String(value))).filter(Boolean)
    const segment = matchNodeSegment(path, cacheDir, segments, run) ?? (segments.length === 0 ? (insideCache(path, cacheDir, run) ? '' : null) : null)
    // Symlinks are resolved, and the path has to be inside this node's own upload directory:
    // `cacheDir` itself and its `out/` are not recordings, and pruning "their" directory would
    // delete `sessions.json` and the answers waiting for the device.
    const mine = segment !== null
    if (!mine) {
      // This path is read and then removed: `keepRecording: none` unlinks it, `last` prunes its
      // directory. The event source is internal, and this is the plugin's own boundary — one
      // event with a strange path must not delete files anywhere else, so it is refused whole.
      log.warn?.('[dsh-voice] refusing a recording outside the voice cache of this run', {
        path,
        node: nodeName,
        id: id || null,
        stack: new Error('a recording path outside the voice cache of this run').stack,
      })
      const refused = createTrace({ id: event?.id ?? null, node: nodeName, at: event?.at ?? null, log })
      refused.mark('received')
      refused.done('refused-path', { language })
      return { status: 'refused-path', id: event?.id ?? null }
    }
    // Two devices may well produce the same id: the key is the pair. The number is the identity,
    // not the name — a name is edited by hand and two devices can carry the same one, so keying by
    // the name glued the words of the second device onto an `already` of the first. The upload
    // directory has been named after the number since 0.1.20 for the same reason.
    const key = `${event?.node ?? nodeName}:${id}`
    if (id && (seen.has(key) || inFlight.has(key))) {
      // A retry of something already answered, or of one still being worked on. The server has
      // just written a fresh file for it, and leaving every repeat behind would grow the cache
      // without end: after a delivery the repeat becomes the node's one kept recording and its
      // predecessors go.
      // While the first exchange runs, only a *different* file is litter. A retry of the same id
      // is written to the same `<node>/<id>.wav`, so removing "the duplicate" would delete the
      // take the running exchange is about to read — the person's recording then disappeared
      // under `keepRecording: last`, and a synchronous double delivery ended as `empty`.
      const held = inFlight.get(key)
      if (inFlight.has(key)) {
        if (!held || !sameFile(held, path)) cleanup([path])
      } else discardRecording(path, segment || nodeName)
      log.info?.('[dsh-voice] the same recording arrived again, ignoring', {
        id,
        node: nodeName,
        inFlight: inFlight.has(key),
      })
      return { status: 'already', id }
    }
    // The id is taken now, not when the answer is delivered: the model may take three minutes,
    // and a second copy of the same recording arriving meanwhile must not become a second answer.
    if (id) inFlight.set(key, path)
    // The same per-node order as a press: two takes cannot overtake each other, and the
    // second waits instead of being dropped.
    return await enqueue(nodeName, async () => {
      try {
        const outcome = await exchangeFromFile(event, nodeName, segment)
        // Only a delivered turn owns the id. A failure — recognition, delivery, an empty take —
        // must leave the retry path open: the client re-sends the same id on purpose.
        if (id && outcome?.status === 'delivered') rememberId(key)
        return outcome
      } finally {
        if (id) inFlight.delete(key)
      }
    }, 'uploaded exchange failed')
  }

  /**
   * Transcribe a file that is already on disk and answer it.
   *
   * @param event - the upload event.
   * @param nodeName - the node to speak to.
   * @returns a short outcome for the log.
   */
  async function exchangeFromFile (event, nodeName, segment = '') {
    const trace = createTrace({ id: event?.id ?? null, node: nodeName, at: event?.at ?? null, log })
    trace.mark('received')
    const seconds = Number(event?.seconds)
    if (Number.isFinite(seconds) && seconds > 0 && seconds < minSeconds) {
      // Nothing worth recognizing: the session stays untouched and the device is told nothing —
      // the person knows they only brushed the button. The take itself is kept like any other,
      // because a click that was heard as words is exactly what one wants to listen to.
      discardRecording(event.path, segment || nodeName)
      trace.done('too-short', { language, seconds })
      return { status: 'too-short', id: event?.id ?? null, seconds }
    }
    let text = ''
    let failure = null
    try {
      const transcript = await transcribe(event.path, trace)
      text = String(typeof transcript === 'string' ? transcript : transcript?.text ?? '').trim()
    } catch (error) {
      failure = error
      log.warn?.('[dsh-voice] transcription failed:', error?.message ?? error)
    }
    trace.mark('transcribed')
    if (text) pushChat({ node: nodeName, role: 'user', text, id: event?.id ?? null, trace })
    if (!text) {
      discardRecording(event.path, segment || nodeName)
      const noRecognizer = failure?.code === 'no_speech'
      await say(nodeName, noRecognizer ? NO_TRANSCRIBER : NOT_HEARD)
      trace.done(noRecognizer ? 'no-stt' : 'empty', { language })
      return { status: noRecognizer ? 'no-stt' : 'empty', id: event?.id ?? null }
    }
    let sessionId
    try {
      sessionId = await sessionFor(nodeName, event?.sessionId ?? null, event?.node ?? null)
    } catch (error) {
      // The exception used to reach the outer catch: no answer, no words, and no closing line.
      discardRecording(event.path, segment || nodeName)
      log.warn?.('[dsh-voice] could not get a session:', error?.message ?? error)
      await say(nodeName, 'Не смог начать новую сессию.')
      trace.done('no-session', { language })
      return { status: 'no-session', id: event?.id ?? null }
    }
    active.set(nodeName, { sessionId })
    // The wait is registered before the message is delivered: a turn that starts and ends
    // quickly would otherwise finish before anyone awaits it.
    awaiting.set(sessionId, watchForAnswer({
      sessionId, node: nodeName, mode: event?.mode ?? 'upload', trace, synth: event?.synth ?? 'device',
      who: whoFor(sessionId),
    }))
    try {
      await deliver({ sessionId, text, node: nodeName, mode: 'upload' })
      trace.mark('delivered')
    } catch (error) {
      awaiting.delete(sessionId)
      releaseNode(nodeName)
      discardRecording(event.path, segment || nodeName)
      log.warn?.('[dsh-voice] delivery failed:', error?.message ?? error)
      await say(nodeName, 'Не смог передать запрос.')
      trace.done('no-session', { language })
      return { status: 'no-session' }
    }
    // The recording has done its job: the newest take stays (unless keepRecording says `none`),
    // the node's older ones do not.
    discardRecording(event.path, segment || nodeName)
    return { status: 'delivered', session: sessionId, text, id: event?.id ?? null }
  }

  /**
   * Warm the synthesizer up when the person opens the voice screen.
   *
   * The model sleeps after ten idle minutes, and the first answer after that pays for the wake-up.
   * Opening the screen is the earliest honest signal that words are coming.
   *
   * Nothing is created here: no session, no exchange, no line on the screen. A node without a
   * `voice` API is not a partner in this at all, and a press that follows within a minute finds the
   * work already done.
   *
   * @param event - `{node, nodeName}` from `dsh-nodes/voice-warmup`.
   * @returns `{status}`: `ready`, `skipped`, `failed` or `not-voice`.
   */
  async function handleWarmup (event) {
    const nodeName = event?.nodeName ?? String(event?.node ?? '')
    if (!nodeName) return { status: 'failed' }
    const trace = createTrace({ id: `warmup-${nodeName}`, node: nodeName, log })
    // A device that does not speak is not ours to warm.
    if (typeof nodes.api === 'function' && !nodes.api(nodeName, 'voice')) {
      trace.mark('warmup', { result: 'not-voice' })
      trace.done('not-voice', { language })
      return { status: 'not-voice' }
    }
    const now = Date.now()
    // The map is keyed by a name that comes from an event, and only the names warmed inside the
    // debounce window can change an answer: the rest are dropped instead of being held for the
    // lifetime of the host.
    for (const [name, at] of warmups) if (now - at >= warmupDebounceMs) warmups.delete(name)
    const last = warmups.get(nodeName) ?? 0
    if (now - last < warmupDebounceMs) {
      // Entering, leaving and entering again within a minute must not wake the model twice.
      trace.mark('warmup', { result: 'skipped' })
      trace.done('skipped', { language })
      return { status: 'skipped' }
    }
    warmups.set(nodeName, now)
    trace.mark('warmup', { result: 'ready' })
    const speech = tts()
    if (typeof speech?.warmup !== 'function') {
      trace.done('ready', { language, warmup: 'no-service' })
      return { status: 'ready' }
    }
    try {
      await speech.warmup()
      trace.done('ready', { language })
      return { status: 'ready' }
    } catch (error) {
      // A cold model costs a slow first answer; a broken warmup must cost nothing at all.
      log.warn?.('[dsh-voice] the warmup failed:', error?.message ?? error)
      trace.done('failed', { language, error: String(error?.message ?? error).slice(0, 80) })
      return { status: 'failed' }
    }
  }

  /**
   * A report about a broken thing on the device, delivered as a fact for the host.
   *
   * It is not a person speaking and not an answer to anything: the message is injected without
   * waking an idle session (when the runner allows it) and marked with `source.bugReport`, so both
   * the model and a later reader can tell it from a human turn. Nothing is spoken.
   *
   * @param report - `{node, nodeName, id, kind, text, app}` from `dsh-nodes/bug-report`.
   * @returns `{status}` for the log.
   */
  async function handleBugReport (report) {
    const nodeName = report?.nodeName ?? String(report?.node ?? '')
    const sessionId = bindings.get(nodeName) ?? null
    if (!sessionId) {
      log.info?.('[dsh-voice] a bug report arrived for a node with no session', { node: nodeName, kind: report?.kind ?? null })
      return { status: 'no-session' }
    }
    const lines = [
      'отчёт с устройства: ' + (report?.kind === 'tts-failed' ? 'синтез речи не удался' : (report?.kind || 'неизвестная деградация')),
      report?.id ? `обмен: ${report.id}` : null,
      report?.app ? `приложение: ${report.app}` : null,
      report?.text ? `ошибка: ${report.text}` : null,
    ].filter(Boolean)
    try {
      const resolved = await sessionController.resolveAgent(sessionId)
      if (!resolved || resolved.error || !resolved.agent) throw new Error(`сессия ${sessionId} недоступна`)
      const built = typeof createUserMessage === 'function'
        ? createUserMessage({
          content: [{ type: 'text', text: lines.join('\n') }],
          source: { kind: 'dsh-nodes', bugReport: true, device: nodeName, exchange: report?.id ?? null },
        })
        : null
      const message = built ?? {
        id: `bug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: 'dsh-nodes', bugReport: true, device: nodeName, exchange: report?.id ?? null },
      }
      // `inject` never wakes an idle driver, which is exactly what a fact needs; a runner without
      // it still records the message through the ordinary path.
      if (typeof resolved.agent.inject === 'function') resolved.agent.inject(message)
      else resolved.agent.followup(message)
      Promise.resolve(sessions?.flush?.(resolved.agent.session)).catch(() => {})
      log.info?.('[dsh-voice] bug report delivered', { session: sessionId, kind: report?.kind ?? null })
      return { status: 'delivered' }
    } catch (error) {
      log.warn?.('[dsh-voice] could not deliver the bug report:', error?.message ?? error)
      return { status: 'failed' }
    }
  }

  /**
   * Feed every session event here; the answer is spoken when its turn completes.
   *
   * @param session - the session the event belongs to (`session.id`).
   * @param event - one committed session event.
   */
  async function observeSessionEvent (session, event) {
    const sessionId = session?.id ?? session?.sessionId ?? null
    if (!sessionId || !awaiting.has(sessionId)) return
    if (event?.type === 'turn/start') {
      drafts.delete(sessionId)
      const waiting = awaiting.get(sessionId)
      // The first turn that opens after the delivery is the one to answer; a
      // later turn belongs to whoever writes into the session next.
      if (waiting && waiting.turn === null) {
        waiting.turn = event.data?.turn ?? null
        waiting.trace?.mark('turn-start', { turn: waiting.turn })
      }
      return
    }
    if (event?.type === 'assistant/message') {
      const assistant = assistantTextOf(event)
      if (assistant) drafts.set(sessionId, assistant.text)
      // One `activity` per tool call, in order: the flag on the screen must move while the
      // answer is being built, and each step names the tool that is running.
      const waiting = awaiting.get(sessionId)
      if (waiting) {
        for (const name of toolCallNamesOf(event)) {
          waiting.activity = (waiting.activity ?? 0) + 1
          pushActivity({ node: waiting.node, n: waiting.activity, name, id: waiting.trace?.id ?? null, trace: waiting.trace })
        }
      }
      return
    }
    if (event?.type !== 'turn/end') return
    const reason = rawReasonOf(event)
    const waiting = awaiting.get(sessionId)
    if (!waiting) return
    // Before the awaited turn opens, any end belongs to work that started
    // earlier — the previous question — and must not consume this wait.
    if (waiting.turn === null) return
    if (event.data?.turn !== waiting.turn) return
    const text = drafts.get(sessionId) ?? ''
    const target = finishAwaiting(sessionId)
    if (!target) return
    target.trace?.mark('turn-end', { reason })
    if (reason !== 'completed') {
      // A cancelled or failed turn is closed, not spoken: there is no answer to read, and a
      // stale wait would hold the device until the next press.
      target.trace?.done(reason, { synth: target.synth ?? 'device', language })
      return
    }
    const { speak, screen } = splitReply(text)
    const spoken = speak.trim()
    // What to show and what to say are two different things: the screen may want the `# screen`
    // block, while the voice must say exactly what the model wrote for saying. Handing the screen
    // text to a speech engine was how a command dump got read aloud instead of the answer.
    const forScreen = screen?.trim() ? screen : spoken
    target.trace?.mark('split', { speakChars: spoken.length, textChars: forScreen.length })
    if (!spoken && !forScreen) {
      target.trace?.done('silent', { synth: target.synth ?? 'device', language })
      return
    }
    // The answer travels as one chat message that carries the speech: the device queues it
    // itself, so nothing here waits for a voice to finish.
    await answerWith({
      sessionId,
      text: forScreen,
      speak: spoken,
      node: target.node,
      trace: target.trace,
      synth: target.synth,
      who: target.who ?? null,
      id: target.trace?.id ?? null,
    })
  }

  /** The configured playback tempo, applied to host audio only. */
  function tempo () {
    const configured = Number(tts()?.snapshot?.().selection?.speed ?? 1)
    return Number.isFinite(configured) && configured > 0 ? configured : 1
  }

  /**
   * Ask the service for audio; a missing service is a failure, not a silence.
   *
   * `synth=host` on a host without a synthesizer lands here: the answer takes the same degraded
   * path as a broken provider — the device engine reads it and the screen says why.
   */
  async function synthesize (text) {
    const speech = tts()
    if (!speech?.resolve || !speech?.synthesize) throw new Error('синтез речи на хосте не установлен')
    // The provider speaks at its own rate: a tempo belongs to playback, not to synthesis.
    const spec = speech.resolve({ text, speed: 1, format: 'wav' })
    return await speech.synthesize(spec, new AbortController().signal)
  }

  /**
   * Register the expectation of an answer, with a deadline.
   *
   * @param entry - what the exchange knows: the session, the node, the trace and the synth mode.
   * @returns the entry, with its activity counter at zero and a timer armed.
   */
  function watchForAnswer (entry) {
    const record = { ...entry, turn: null, activity: 0 }
    record.timer = setTimeout(() => {
      // The turn never came back. Say so, free the node, and let the next press through.
      const stuck = finishAwaiting(entry.sessionId)
      if (!stuck) return
      stuck.trace?.mark('turn-end', { reason: 'timeout' })
      stuck.trace?.done('timeout', { synth: stuck.synth ?? 'device', language })
      log.warn?.('[dsh-voice] the answer never came, releasing the exchange', { session: entry.sessionId })
    }, exchangeTimeoutMs)
    record.timer.unref?.()
    return record
  }

  /**
   * Take the waiting entry off the books, together with its timer and its node slot.
   *
   * @param sessionId - the session whose answer is no longer expected.
   * @returns the entry that was waiting, or null.
   */
  function finishAwaiting (sessionId) {
    const entry = awaiting.get(sessionId)
    if (!entry) return null
    awaiting.delete(sessionId)
    drafts.delete(sessionId)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.node) releaseNode(entry.node)
    return entry
  }

  /**
   * Free the node and, if a reset was asked for while it was busy, apply it now.
   *
   * The reset is deliberately late: the person may press "new session" while the answer to the
   * sentence they just said is still being prepared, and dropping that exchange would lose words
   * they have already spoken.
   *
   * @param nodeName - the node that is no longer busy.
   */
  function releaseNode (nodeName) {
    active.delete(nodeName)
    if (!resetPending.delete(nodeName)) return
    forgetBinding(nodeName)
    log.info?.('[dsh-voice] the deferred reset is applied', { node: nodeName })
  }

  /** Drop the node → session binding so the next input starts a new conversation. */
  function forgetBinding (nodeName) {
    if (!bindings.has(nodeName)) return false
    bindings.delete(nodeName)
    saving = saving.then(() => saveBindings(cacheDir, bindings, log)).catch(() => {})
    return true
  }

  /**
   * "New session" from the device.
   *
   * A reset never interrupts a running exchange: the binding is dropped right away when the node is
   * idle, and deferred to its end when it is not.
   *
   * @param event - `{node, nodeName}` from `dsh-nodes/voice-new-session`.
   * @returns `{status}` for the log.
   */
  function handleNewSession (event) {
    const nodeName = event?.nodeName ?? String(event?.node ?? '')
    if (!nodeName) return { status: 'no-node' }
    const trace = createTrace({ id: `new-session-${nodeName}`, node: nodeName, log })
    trace.mark('new-session')
    if (active.has(nodeName) || [...awaiting.values()].some((entry) => entry.node === nodeName)) {
      resetPending.add(nodeName)
      trace.done('deferred', { language })
      return { status: 'deferred' }
    }
    forgetBinding(nodeName)
    trace.done('ok', { language })
    return { status: 'ok' }
  }

  /**
   * The reason of a turn end in either shape DSH may hand it over: a plain string or an object
   * with a `kind`. A completed turn is the only one that speaks.
   *
   * @param event - the `turn/end` event.
   * @returns a reason string, `unknown` when it carries none.
   */
  function rawReasonOf (event) {
    const reason = event?.data?.reason
    const value = typeof reason === 'string' ? reason : reason?.kind
    return typeof value === 'string' && value ? value : 'unknown'
  }

  /**
   * Show the progress of one tool call.
   *
   * @param args - node, the counter inside the exchange, the tool name, the exchange id, trace.
   */
  function pushActivity ({ node, n, name, id = null, trace = null }) {
    try {
      const pending = nodes.call(node, 'voice', 'activity', { n, name, ...id ? { id } : {} })
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => log.warn?.('[dsh-voice] the screen did not take the activity:', error?.message ?? error))
      }
    } catch (error) {
      log.warn?.('[dsh-voice] the screen did not take the activity:', error?.message ?? error)
    }
    trace?.mark('activity', { n, name })
  }

  /**
   * Send the answer as one chat message, with the audio when the host is the one speaking.
   *
   * @param args - session, the text to show, the node, the trace, the synth mode and the id.
   */
  async function answerWith ({ sessionId, text, speak = '', node, trace = null, synth = 'device', who = null, id = null }) {
    const spoken = String(speak ?? '').trim()
    const hostAudio = synth === 'host' && Boolean(spoken)
    let audioPath = null
    let audioSeconds = null
    // The device shows the degradation to the person: a silent fallback that looks like success is
    // worse than a slightly ugly line.
    let degraded = null
    // Audio is rendered from what must be heard, never from what must be read.
    if (hostAudio) {
      try {
        const speech = await synthesize(spoken)
        audioSeconds = Number(speech.seconds?.toFixed?.(2) ?? speech.seconds)
        // Both files live under this run's `out/`: the wav is temporary, the answer waits there
        // for the device to fetch it, and neither can be confused with another run's answer.
        mkdirSync(answersDir, { recursive: true })
        const wavPath = join(answersDir, `say-${Date.now()}.wav`)
        writeFileSync(wavPath, speech.audio)
        trace?.mark('synthesized', { seconds: audioSeconds })
        audioPath = join(answersDir, `${id ?? Date.now()}.ogg`)
        try {
          await toVoiceNote(wavPath, audioPath, tempo(), { signal: new AbortController().signal })
        } finally {
          cleanup([wavPath])
        }
      } catch (error) {
        // The device engine is always there; a broken synthesizer costs the voice, not the answer.
        log.warn?.('[dsh-voice] synthesis failed, the device will speak:', error?.message ?? error)
        trace?.mark('tts-failed', { error: error?.message?.slice(0, 80) ?? String(error) })
        degraded = { kind: 'tts-failed', message: String(error?.message ?? error).slice(0, 200) }
        audioPath = null
      }
    }
    if (audioPath) {
      // One command carries both halves: the line to show and the file to play. The device
      // downloads it by this command's `seq` — the only live ticket there is — and answers at once.
      await answerCommand({ node, id, text, speak: spoken, who, audioPath, seconds: audioSeconds, trace })
    } else {
      // No audio: the line goes to the screen and the device engine reads it, if there is anything
      // to read at all.
      pushChat({ node, role: 'assistant', text, speak: spoken, id, say: Boolean(spoken), who, degraded, trace })
    }
    trace?.done(hostAudio && !audioPath ? 'tts-failed' : 'ok',
      { synth: audioPath ? 'host' : 'device', language })
    log.info?.('[dsh-voice] answered', { session: sessionId, synth: audioPath ? 'host' : 'device', speakChars: spoken.length })
    return { answered: true }
  }

  /**
   * Hand the answer to the device as one command that carries the line and the audio.
   *
   * `voice.answer` stays open while the device downloads the file by its `seq` and then answers
   * `{"status":"ok","payload":{"queued":true}}`; the file is removed once that answer arrives, with
   * a timer as the guard against a device that never replies.
   *
   * @param args - node, exchange id, what to show, what to say, the persona, the file and its length.
   */
  async function answerCommand ({ node, id, text, speak, who, audioPath, seconds, trace = null }) {
    const pending = nodes.call(node, 'voice', 'answer', {
      ...id ? { id } : {},
      text,
      ...speak ? { speak } : {},
      ...who?.name ? { who } : {},
      ...Number.isFinite(Number(seconds)) ? { seconds: Number(seconds) } : {},
      // The path travels even though the device does not read it: the download route resolves the
      // file from `command.args.path`, and the command is the ticket.
      path: audioPath,
    })
    const guard = setTimeout(() => cleanup([audioPath]), AUDIO_TTL_MS)
    guard.unref?.()
    try {
      const outcome = await pending
      if (outcome?.status !== 'ok') {
        log.warn?.('[dsh-voice] the device did not take the answer:', outcome?.message ?? outcome?.code)
      }
      trace?.mark('answered', { via: 'voice.answer' })
      return outcome
    } catch (error) {
      log.warn?.('[dsh-voice] the answer command failed:', error?.message ?? error)
      return null
    } finally {
      clearTimeout(guard)
      cleanup([audioPath])
    }
  }

  if (typeof on === 'function') {
    const dispose = on('session/event', (session, event) => {
      void observeSessionEvent(session, event)
    })
    if (typeof dispose === 'function') disposers.push(dispose)
    // A session can be closed while an answer is still expected: nothing will arrive then, and
    // the device must not stay booked.
    const disposeDisposed = on('session/disposed', (session) => {
      const sessionId = session?.id ?? session?.sessionId ?? null
      if (!sessionId) return
      const gone = finishAwaiting(sessionId)
      gone?.trace?.done('disposed', { synth: gone.synth ?? 'device', language })
    })
    if (typeof disposeDisposed === 'function') disposers.push(disposeDisposed)
  }

  return {
    handle,
    handleUpload,
    handleNewSession,
    handleBugReport,
    handleWarmup,
    observeSessionEvent,
    /** The directory name this run owns inside the cache. */
    runId: run,
    awaiting,
    /** The per-node exchange queues: exposed so a test can see that none is left behind. */
    queues,
    /** When each node last warmed the synthesizer up: the same, for the debounce map. */
    warmups,
    dispose () {
      clearInterval(sweepTimer)
      stopWatching()
      awaiting.clear()
      drafts.clear()
      active.clear()
      queues.clear()
      warmups.clear()
    },
  }
}
