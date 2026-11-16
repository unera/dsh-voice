// Reading the spoken protocol out of one answer.
//
// The protocol is the owner's decision, and it is data, not a guess: an answer
// that wants to be heard is written as three marker lines and nothing else is
// ever read into it.
//
//     ---
//     текст для голоса
//     ---
//     текст без звука
//     ...
//
// The parser is deliberately unforgiving. The old version guessed at intent
// from the words of the person's message, which only worked for the languages
// and the phrasings someone happened to write down; this one asks the text a
// question with one answer — did the model write the documented structure? — and
// anything short of an exact match means "not spoken" rather than "probably
// spoken". A wrong guess here is worse than a missing voice note: the person
// hears something they did not ask for, or hears the wrong part of the answer.
//
// Two things are not leniency and are handled on purpose:
//
// * line endings — a `\r\n` reply is split on `\n` and the `\r` is stripped, so
//   the protocol survives a model that writes CRLF; the markers themselves must
//   still be exactly `---` and `...`, with no spaces, no indentation, no `--- ###`;
// * blank lines around the document — the first non-empty line and the last
//   non-empty line are the ones that carry markers, so a blank line above or
//   below the answer changes nothing.

/** The line that opens the document and separates its two parts. */
export const SEPARATOR = '---'

/** The line that closes the document. */
export const END = '...'

/** Characters the spoken part may have when the configuration names no limit. */
export const DEFAULT_MAX_CHARS = 600

/** The largest limit a configuration may set; a bigger one is a config error. */
export const MAX_CHARS_LIMIT = 5000

/**
 * Length of a text in characters, not bytes.
 *
 * `[...text].length` iterates code points, so a Cyrillic letter and an emoji
 * count as one each — which is what a person means by "600 characters", and what
 * the model is told the limit is. `text.length` would count UTF-16 units (an
 * emoji is two, a Cyrillic letter one) and `Buffer.byteLength` would let a
 * Russian answer be half as long as an English one.
 *
 * @param text - any text.
 * @returns the number of code points.
 */
export function charCount (text) {
  return typeof text === 'string' ? [...text].length : 0
}

/** Lines of a text, with a CRLF ending reduced to LF. */
function linesOf (text) {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** A refusal that names its reason, so the log says why nothing was spoken. */
function refusal (reason) {
  return { ok: false, reason, spoken: '', rest: '' }
}

/**
 * Read the three markers and the two parts they enclose.
 *
 * The document is valid only when all of this holds:
 *
 * 1. the first non-empty line is exactly `---`;
 * 2. exactly one more line after it is exactly `---` (a third one is a
 *    deviation, not a nested document);
 * 3. the last non-empty line is exactly `...`, after that separator;
 * 4. the spoken part and the remaining text are both non-empty after `trim()`.
 *
 * @param answer - the final answer text of the turn, as the model wrote it.
 * @returns `{ok, reason, spoken, rest}`: the two parts as they will be used —
 *   `spoken` is what synthesis receives, verbatim — or the reason the answer is
 *   not a spoken document and therefore must travel as it is.
 */
export function parseVoiceDocument (answer) {
  const source = typeof answer === 'string' ? answer : ''
  if (!source.trim()) return refusal('no-answer')
  const lines = linesOf(source)

  const first = lines.findIndex((line) => line.trim() !== '')
  if (first === -1) return refusal('no-answer')
  if (lines[first] !== SEPARATOR) return refusal('not-a-document')

  // Every later `---` is a candidate separator; there must be exactly one.
  const separators = []
  for (let index = first + 1; index < lines.length; index += 1) {
    if (lines[index] === SEPARATOR) separators.push(index)
  }
  if (separators.length === 0) return refusal('one-marker')
  if (separators.length > 1) return refusal('extra-marker')
  const separator = separators[0]

  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last -= 1
  if (last === -1 || lines[last] !== END) return refusal('no-end-marker')
  // `...` above the separator leaves no room for text without sound.
  if (last <= separator) return refusal('empty-rest')

  const spoken = lines.slice(first + 1, separator).join('\n').trim()
  const rest = lines.slice(separator + 1, last).join('\n').trim()
  if (!spoken) return refusal('empty-spoken')
  if (!rest) return refusal('empty-rest')

  return { ok: true, reason: 'ok', spoken, rest }
}

/**
 * The instructions the model is given, built from the configured limit.
 *
 * Short on purpose: the format is three lines, and a prompt that explains it at
 * length invites the model to improvise around it. The limit is a number, so the
 * model cannot "approximately" obey it.
 *
 * @param options.maxChars - the limit the plugin will enforce.
 * @returns the text of the system-prompt section.
 */
export function replyContract ({ maxChars = DEFAULT_MAX_CHARS, enabled = true } = {}) {
  const state = enabled
    ? 'Озвучка сейчас включена: первая часть действительно уйдёт голосом.'
    : 'Озвучка сейчас выключена: формат остаётся допустимым ответом, но звука не будет, пока её не включат на странице плагина.'
  return `## Ответ голосом

Ответ, который должен прозвучать, оформляется ровно так — тремя маркерами:

---
текст для голоса
---
текст без звука
...

- первая непустая строка — \`---\`; ниже то, что произносят; затем ещё одна строка \`---\`; затем остальной текст; последняя непустая строка — \`...\`;
- первая часть — не длиннее ${maxChars} символов, без markdown, ссылок и блоков кода;
- обе части непустые; при любом отклонении от формата звука не будет — ответ уйдёт как есть;
- маркеры остаются в ответе, их видит человек;
- ${state}`
}
