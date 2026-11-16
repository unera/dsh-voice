// The knobs of the spoken reply, and the schema that makes two of them editable.
//
// A field marked `.volatile()` is a field the settings service can change in a
// running Host without remounting the plugin; the Plugins page in the Web client
// builds its form from exactly those fields. `mute` and `maxChars` are
// volatile because they are the two a person decides by ear; everything else is
// ordinary configuration, written in the profile and read at boot.
//
// Validation is strict where the owner asked for it: a character limit outside
// `1..MAX_CHARS_LIMIT` is a configuration error, not a number quietly clamped to
// something else. The schema refuses it at mount, and `normalizeReplySettings`
// refuses it again for a caller that builds the settings itself.
import { join, resolve } from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT } from './structure.mjs'

/** A slow engine may hold the closing turn for this long, no longer. */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * How long the channel may hold the closing turn while it copies the announced
 * file. The copy is one small file: tens of milliseconds when the filesystem is
 * awake, and nothing at all from this side once the budget is spent.
 */
export const DEFAULT_SETTLE_MS = 600

/** Upper bound of the turn-hold budget, matching the schema. */
export const SETTLE_LIMIT_MS = 5000

/** Every configuration field of this plugin. */
export const Config = Schema.object({
  cacheDir: Schema.string().description('Каталог записей и озвучки; по умолчанию $DSH_HOME/cache/voice'),
  language: Schema.string().default('ru').description('Язык распознавания речи'),
  minSeconds: Schema.number().min(0).description('Короче этого — не речь, а нажатие кнопки'),
  runId: Schema.string().description('Имя каталога этого процесса внутри cacheDir'),
  mute: Schema.boolean().default(false).volatile()
    .description('Отключить озвучивание ответов: разметка остаётся, плагин на неё не реагирует'),
  maxChars: Schema.number().step(1).min(1).max(MAX_CHARS_LIMIT).default(DEFAULT_MAX_CHARS).volatile()
    .description('Сколько символов озвучивать: длиннее — ответ уходит без звука'),
  timeoutMs: Schema.number().min(1).default(DEFAULT_TIMEOUT_MS)
    .description('Сколько медленный синтез может держать закрывающийся ход'),
  speed: Schema.number().min(0.5).max(2).description('Темп озвучки; по умолчанию — темп сервиса'),
  description: Schema.string().default('Озвучка ответа').description('Подпись файла в Web-клиенте'),
  subagents: Schema.boolean().default(false).description('Озвучивать и ходы субагентов'),
  prompt: Schema.boolean().default(true).description('Регистрировать секцию промпта с форматом'),
  settleMs: Schema.number().min(0).max(5000).default(DEFAULT_SETTLE_MS)
    .description('Сколько канал может держать закрывающийся ход, забирая объявленный файл'),
})

/**
 * Where rendered replies live.
 *
 * Under the plugin's own cache root — the same `cacheDir` the loop uses — in a
 * `reply/` subdirectory: the loop sweeps `work/` and `out/`, never the root, so
 * nothing here is collected by a sweep that does not know about it, and a
 * deployment that moved the cache moves this with it.
 *
 * @param env - the environment, for `DSH_HOME`.
 * @param base - the configured `cacheDir`, if any.
 * @returns an absolute directory.
 */
export function defaultCacheDir (env = process.env, base = null) {
  const configured = typeof base === 'string' && base.trim() ? base.trim() : null
  const root = configured === null
    ? resolve(typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : '.dsh', 'cache', 'voice')
    : resolve(configured)
  return join(root, 'reply')
}

/**
 * The value behind a volatile field.
 *
 * A field declared `.volatile()` is owned by the settings service, and the Loader
 * hands the plugin a live *accessor* for it — `{ get(), [cosmokit.volatile.write]() }`
 * — not the value itself. Comparing that object with `=== true` is always false,
 * which is how this plugin spent an evening convinced that a switch saved as on was
 * off: the card said on, the profile said on, the prompt said off, and only the
 * mount-time log line showed an accessor where a boolean was expected.
 *
 * A failing accessor is "not set", never a reason to refuse to mount.
 *
 * @param value - a configuration field as the Loader delivered it.
 * @returns the plain value, or `undefined` when the accessor cannot answer.
 */
export function unwrapVolatile (value) {
  if (value === null || typeof value !== 'object') return value
  const read = value.get
  if (typeof read !== 'function') return value
  try {
    return read.call(value)
  } catch {
    return undefined
  }
}

/** A positive finite number, or the fallback. */
function positive (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The character limit, or a configuration error.
 *
 * @param value - `config.maxChars`, if any.
 * @returns the limit to enforce.
 * @throws {RangeError} when the value is present and outside `1..5000` or is not
 *   an integer: a clamp would change what the owner asked for without saying so.
 */
export function maxCharsSetting (value) {
  // The settings service answers an object for a volatile field before a value is
  // saved (an empty one, or a schema placeholder with symbol keys). That is "not
  // set" and falls back to the default: treating it as a bad number took the whole
  // voice loop down at mount. Everything else is checked strictly — a person types
  // a number here, and a string or an out-of-range number is a configuration
  // mistake that must be reported, not quietly replaced.
  const plain = unwrapVolatile(value)
  if (plain === undefined || plain === null) return DEFAULT_MAX_CHARS
  value = plain
  if (typeof value === 'object') return DEFAULT_MAX_CHARS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CHARS_LIMIT) {
    throw new RangeError(
      `dsh-voice: maxChars должен быть целым числом от 1 до ${MAX_CHARS_LIMIT}, получено ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * The turn-hold budget, or the default for anything that is not a number.
 *
 * Unlike `maxChars` this is not a person's decision but a timeout: a value out of
 * range is clamped to the nearest end, because refusing to mount over it would
 * take the whole voice loop down for a knob that only bounds a wait.
 *
 * @param value - `config.settleMs`, if any.
 * @returns milliseconds in `0..SETTLE_LIMIT_MS`.
 */
export function settleSetting (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTLE_MS
  return Math.min(SETTLE_LIMIT_MS, Math.max(0, Math.round(value)))
}

/**
 * Turn one plugin configuration into the settings the reply hook reads.
 *
 * @param config - the plugin configuration, as the loader parsed it.
 * @returns the settings every later call uses.
 */
export function normalizeReplySettings (config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  // Every field below may arrive as a live accessor (see `unwrapVolatile`).
  const mute = unwrapVolatile(source.mute)
  const maxChars = unwrapVolatile(source.maxChars)
  const speedValue = unwrapVolatile(source.speed)
  const speed = typeof speedValue === 'number' && speedValue >= 0.5 && speedValue <= 2
    ? speedValue
    : null
  return {
    // What the answer sounds like is decided by the markup; this switch only takes
    // the sound away.
    // One switch: the markup stays in the answer and the plugin ignores it. A
    // marked answer is spoken without any switch at all.
    mute: mute === true,
    maxChars: maxCharsSetting(maxChars),
    timeoutMs: positive(unwrapVolatile(source.timeoutMs), DEFAULT_TIMEOUT_MS),
    speed,
    // One cache root for the plugin; the replies get their own subdirectory.
    cacheDir: defaultCacheDir(process.env, typeof source.cacheDir === 'string' ? source.cacheDir : null),
    subagents: unwrapVolatile(source.subagents) === true,
    prompt: unwrapVolatile(source.prompt) !== false,
    description: typeof unwrapVolatile(source.description) === 'string' && unwrapVolatile(source.description).trim()
      ? unwrapVolatile(source.description).trim()
      : 'Озвучка ответа',
    // A negative or absurd budget is a configuration mistake, but it costs only
    // the wait: without it the record is still appended and the answer still goes out.
    settleMs: settleSetting(unwrapVolatile(source.settleMs)),
    logger: source.logger ?? null,
    // The synthesized engine, for a test that supplies its own; production reads
    // the `textToSpeech` service from the context at call time.
    service: source.service ?? null,
    // Test seams, never set from a profile in anger.
    deps: source.deps !== null && typeof source.deps === 'object' ? source.deps : {},
  }
}
