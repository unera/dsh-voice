// The card's behaviour, without a browser or a React tree.
//
// Everything the settings card decides — what the form currently says, whether the
// switch may be pressed, whether the typed limit is a number the Host will accept
// — lives here as plain functions over plain values. The components in `card.js`
// paint the result; `test/client.test.mjs` checks the decisions themselves.

/** The field names, exactly as the Host schema spells them. */
export const SPEAK_FIELD = 'speakReplies'
export const LIMIT_FIELD = 'maxChars'

/** The range the Host enforces; the card refuses to send anything else. */
export const LIMIT_MIN = 1
export const LIMIT_MAX = 5000
export const LIMIT_DEFAULT = 600

/**
 * One dictionary line with `{name}` holes filled.
 *
 * @param t - the bound translate function.
 * @param key - dictionary key.
 * @param vars - values for the holes.
 * @returns the line as text.
 */
export function format (t, key, vars = {}) {
  const text = typeof t === 'function' ? t(key) : key
  return String(text).replace(/\{(\w+)\}/gu, (whole, name) => (name in vars ? String(vars[name]) : whole))
}

/**
 * The values the form currently holds.
 *
 * A missing or unparsable limit falls back to the schema default instead of an
 * empty input: the person then sees what the Host will use.
 *
 * @param form - `{state, mutate}` as the Plugins page passes it.
 * @returns `{status, writable, known, speakReplies, maxChars}`.
 */
export function readValues (form) {
  const state = form?.state ?? null
  const value = state?.value ?? null
  const status = typeof state?.status === 'string' ? state.status : 'loading'
  const raw = Number(value?.[LIMIT_FIELD])
  const maxChars = Number.isInteger(raw) && raw >= LIMIT_MIN && raw <= LIMIT_MAX ? raw : LIMIT_DEFAULT
  return {
    status,
    writable: state?.writable === true,
    known: status === 'ready',
    speakReplies: value?.[SPEAK_FIELD] === true,
    maxChars,
  }
}

/**
 * What the limit input shows.
 *
 * @param maxChars - the value the Host holds.
 * @returns the text of the input.
 */
export function limitDraft (maxChars) {
  return String(maxChars)
}

/**
 * Read the limit input.
 *
 * @param text - what the person typed.
 * @returns `{ok: true, value}` or `{ok: false, code}` with `empty`,
 *   `not-integer` or `range` — three different answers to the same field, so the
 *   card can say which one it got.
 */
export function parseLimit (text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { ok: false, code: 'empty' }
  if (!/^\d+$/u.test(trimmed)) return { ok: false, code: 'not-integer' }
  const value = Number(trimmed)
  if (value < LIMIT_MIN || value > LIMIT_MAX) return { ok: false, code: 'range' }
  return { ok: true, value }
}

/**
 * Read the host's answer about its synthesizer.
 *
 * @param answer - `{textToSpeech}` from the route, `null` before it is read, or
 *   `{error}` when the read failed.
 * @returns `{known, canSpeak, code}` with `checking`, `ok`, `no-synth` or
 *   `failed`.
 */
export function availabilityOf (answer) {
  if (answer === null || answer === undefined) return { known: false, canSpeak: false, code: 'checking' }
  if (answer.error !== undefined && answer.error !== null) return { known: false, canSpeak: false, code: 'failed' }
  const ready = answer.textToSpeech === true
  return { known: true, canSpeak: ready, code: ready ? 'ok' : 'no-synth' }
}

/**
 * The one line the bundle's page shows instead of the card.
 *
 * @param t - the bound translate function.
 * @param values - from {@link readValues}.
 * @returns the summary text.
 */
export function summaryLine (t, values) {
  if (!values.known) return typeof t === 'function' ? t('summary.unknown') : 'summary.unknown'
  return values.speakReplies ? format(t, 'summary.on', { limit: values.maxChars }) : t('summary.off')
}

/**
 * Whether the switch may be pressed.
 *
 * Two independent reasons it may not: the Host document refuses writes, or there
 * is no synthesizer to honour the setting. The card never offers a switch that
 * would store something nothing can do.
 *
 * @param values - from {@link readValues}.
 * @param answer - the host's state answer.
 * @returns whether the checkbox is disabled.
 */
export function switchDisabled (values, answer) {
  return !values.writable || !availabilityOf(answer).canSpeak
}

/** The line under the switch: why it may be inactive. */
export function availabilityText (t, availability) {
  if (availability.code === 'ok') return ''
  if (availability.code === 'no-synth') return t('availability.noSynth')
  if (availability.code === 'failed') return t('availability.failed')
  return t('availability.checking')
}
