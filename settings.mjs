// The knobs of the spoken reply, and the schema that makes two of them editable.
//
// A field marked `.volatile()` is a field the settings service can change in a
// running Host without remounting the plugin; the Plugins page in the Web client
// builds its form from exactly those fields. `speakReplies` and `maxChars` are
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

/** Every configuration field of this plugin. */
export const Config = Schema.object({
  cacheDir: Schema.string().description('Каталог записей и озвучки; по умолчанию $DSH_HOME/cache/voice'),
  language: Schema.string().default('ru').description('Язык распознавания речи'),
  minSeconds: Schema.number().min(0).description('Короче этого — не речь, а нажатие кнопки'),
  runId: Schema.string().description('Имя каталога этого процесса внутри cacheDir'),
  speakReplies: Schema.boolean().default(false).volatile()
    .description('Озвучивать ответы: первая часть ответа между маркерами уходит голосом'),
  maxChars: Schema.number().step(1).min(1).max(MAX_CHARS_LIMIT).default(DEFAULT_MAX_CHARS).volatile()
    .description('Сколько символов озвучивать: длиннее — ответ уходит без звука'),
  timeoutMs: Schema.number().min(1).default(DEFAULT_TIMEOUT_MS)
    .description('Сколько медленный синтез может держать закрывающийся ход'),
  speed: Schema.number().min(0.5).max(2).description('Темп озвучки; по умолчанию — темп сервиса'),
  description: Schema.string().default('Озвучка ответа').description('Подпись файла в Web-клиенте'),
  subagents: Schema.boolean().default(false).description('Озвучивать и ходы субагентов'),
  prompt: Schema.boolean().default(true).description('Регистрировать секцию промпта с форматом'),
  diagnose: Schema.boolean().default(false)
    .description('Ждать, забрал ли канал запись, и писать это в журнал'),
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
  // The settings service hands back an empty object for a volatile field that has
  // no saved value yet; that is a placeholder, not something a person typed, and
  // treating it as an error stopped the whole plugin from mounting.
  const unset = value === undefined || value === null
    || (typeof value === 'object' && value !== null && Object.keys(value).length === 0)
  if (unset) return DEFAULT_MAX_CHARS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CHARS_LIMIT) {
    throw new RangeError(
      `dsh-voice: maxChars должен быть целым числом от 1 до ${MAX_CHARS_LIMIT}, получено ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * Turn one plugin configuration into the settings the reply hook reads.
 *
 * @param config - the plugin configuration, as the loader parsed it.
 * @returns the settings every later call uses.
 */
export function normalizeReplySettings (config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const speed = typeof source.speed === 'number' && source.speed >= 0.5 && source.speed <= 2
    ? source.speed
    : null
  return {
    speakReplies: source.speakReplies === true,
    maxChars: maxCharsSetting(source.maxChars),
    timeoutMs: positive(source.timeoutMs, DEFAULT_TIMEOUT_MS),
    speed,
    // One cache root for the plugin; the replies get their own subdirectory.
    cacheDir: defaultCacheDir(process.env, typeof source.cacheDir === 'string' ? source.cacheDir : null),
    subagents: source.subagents === true,
    prompt: source.prompt !== false,
    description: typeof source.description === 'string' && source.description.trim()
      ? source.description.trim()
      : 'Озвучка ответа',
    diagnose: source.diagnose === true,
    diagnoseTimeoutMs: positive(source.diagnoseTimeoutMs, 400),
    logger: source.logger ?? null,
    // The synthesized engine, for a test that supplies its own; production reads
    // the `textToSpeech` service from the context at call time.
    service: source.service ?? null,
    // Test seams, never set from a profile in anger.
    deps: source.deps !== null && typeof source.deps === 'object' ? source.deps : {},
  }
}
