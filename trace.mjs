// Measurement of one voice exchange.
//
// A person notices a slow answer long before anyone can say which part was slow: the phone
// recording, the upload, recognition, the model, synthesis, or playback. Each of those is a
// different owner, so every stage is stamped with milliseconds since the event arrived, and one
// closing line carries the deltas.
//
// The clock and the logger are injected: a test asserts the exact lines without waiting.
import { randomUUID } from 'node:crypto'

/** Order of the segments in the closing line, and of the stages in the log. */
const STAGE_ORDER = ['received', 'transcribed', 'delivered', 'turn-start', 'turn-end', 'split', 'synthesized', 'spoken']

/** Segment: which two marks (or client times) are subtracted. */
const SEGMENTS = [
  ['record', 'client:recordStop', 'client:recordStart'],
  ['upload', 'at:receivedAt', 'at:sentAt'],
  ['stt', 'mark:transcribed', 'mark:received'],
  ['model', 'mark:turn-end', 'mark:turn-start'],
  ['tts', 'mark:synthesized', 'mark:split'],
  ['play', 'mark:spoken', 'mark:synthesized'],
]

/** Whole positive milliseconds only: anything else in a header is a rumour, not a fact. */
export function epochMs (value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

/** `k: v` pairs in the order given, joined for one log line. */
function fields (pairs) {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

/**
 * Read one value by its reference: `mark:<stage>`, `at:<field>`, `client:<field>`.
 *
 * @param ref - the reference from the segment table.
 * @param marks - stage timestamps, relative to the exchange start.
 * @param at - the client and server times of the upload.
 * @returns a number or undefined when the fact never arrived.
 */
function valueOf (ref, marks, at) {
  const [kind, name] = ref.split(':')
  if (kind === 'mark') return marks[name]
  if (kind === 'at') return at?.[name] ?? undefined
  if (kind === 'client') return at?.[name] ?? undefined
  return undefined
}

/**
 * Build a trace for one exchange.
 *
 * @param args - `id`, `node`, the `at` times from the upload, a logger, and a clock.
 * @returns `{ mark, stage, done, marks }` — the marks are exposed for tests.
 */
export function createTrace ({ id = randomUUID(), node = null, at = null, log = console, now = () => Date.now() } = {}) {
  const started = now()
  /** Stage name → milliseconds since the exchange started. */
  const marks = {}
  const head = `[dsh-voice] exchange ${id}${node ? ` node=${node}` : ''}`

  /**
   * Record one stage and write its line.
   *
   * @param stage - stage name; the first occurrence wins, a repeat is ignored.
   * @param extra - additional fields for the line (`turn`, `reason`, `speakChars`).
   * @returns milliseconds since the exchange started.
   */
  function mark (stage, extra = {}) {
    const ms = now() - started
    if (marks[stage] === undefined) marks[stage] = ms
    log.info?.(`${head} stage=${stage} ms=${ms} ${fields(Object.entries(extra))}`.trimEnd())
    return ms
  }

  /** The deltas that actually happened, in the canonical order. */
  function segments () {
    const out = []
    for (const [name, to, from] of SEGMENTS) {
      const end = valueOf(to, marks, at)
      const begin = valueOf(from, marks, at)
      if (typeof end !== 'number' || typeof begin !== 'number') continue
      const delta = end - begin
      // A clock that went backwards says nothing useful; a negative segment is dropped rather
      // than printed as a fact.
      if (!Number.isFinite(delta) || delta < 0) continue
      out.push([name, delta])
    }
    return out
  }

  /**
   * Close the exchange with one line: total time, the segments that happened, and the reason
   * when it did not finish with an answer.
   *
   * @param reason - `ok`, `empty`, `no-session`, `no-recording`, and so on.
   * @param extra - further fields for the closing line.
   */
  function done (reason = 'ok', extra = {}) {
    const total = now() - started
    const parts = segments().map(([name, ms]) => `${name}: ${ms}`).join(', ')
    const tail = [
      `total=${total}ms`,
      parts ? `segments={${parts}}` : null,
      reason === 'ok' ? null : `reason=${reason}`,
      fields(Object.entries(extra)),
    ].filter(Boolean).join(' ')
    log.info?.(`${head} done ${tail}`)
    return { total, segments: Object.fromEntries(segments()), reason }
  }

  return { id, mark, done, marks, order: STAGE_ORDER }
}
