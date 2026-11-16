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

/**
 * The one mark that starts the spoken part.
 *
 * Two `---` lines alone say "a document", not "speech": a YAML multi-document, an
 * answer that happens to start with a horizontal rule, anything with two rules in
 * it would be voiced by accident. The speaker symbol is the signature: the first
 * part is spoken exactly when the person who wrote the answer put it there, and a
 * reader sees which part will be heard. One mark only — two spellings of the same
 * intent would mean two formats to explain.
 */
export const SPOKEN_MARK = '🔊'

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
 * Split a leading play mark off the spoken part.
 *
 * @param text - the first part of the document, as written.
 * @returns `{marked, text}`: whether a mark was there, and the words without it.
 */
export function splitSpokenMark (text) {
  const trimmed = String(text ?? '').replace(/^\s+/u, '')
  if (!trimmed.startsWith(SPOKEN_MARK)) return { marked: false, text: trimmed.trim() }
  return {
    marked: true,
    // `🔊ответ` and `🔊 ответ` are the same intent; a dash or colon after the sign
    // is decoration and does not belong in the synthesis.
    text: trimmed.slice(SPOKEN_MARK.length).replace(/^[\s:—–-]+/u, '').trim(),
  }
}

/**
 * Read the three markers and the two parts they enclose.
 *
 * The document is valid only when all of this holds:
 *
 * 1. the first non-empty line is exactly `---`, after an optional Markdown quote
 *    block that a reply may open with (a quotation is not part of the answer and
 *    must not cost it its voice);
 * 2. exactly one more line after it is exactly `---` (a third one is a
 *    deviation, not a nested document);
 * 3. the first part starts with a play mark ({@link SPOKEN_MARK}) — that is what
 *    says "speak this", rather than an accidental pair of horizontal rules;
 * 4. the spoken part and the remaining text are both non-empty after `trim()`
 *    and after the mark itself is removed.
 *
 * There is no closing marker: YAML's `...` would read as "the document ends here",
 * which promises a following document that never comes, and a third `---` reads as
 * "another document starts". Two markers say exactly what is true — spoken part,
 * then the rest.
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

  let first = lines.findIndex((line) => line.trim() !== '')
  if (first === -1) return refusal('no-answer')

  // A reply may open by quoting the message it answers: `>` lines, one or more,
  // then the document. The quote is shown to the reader and is not spoken, so it
  // is stepped over rather than treated as a broken format.
  if (lines[first].trim().startsWith('>')) {
    while (first < lines.length && (lines[first].trim() === '' || lines[first].trim().startsWith('>'))) first += 1
    if (first >= lines.length) return refusal('not-a-document')
  }
  if (lines[first] !== SEPARATOR) return refusal('not-a-document')

  // Every later `---` is a candidate separator; there must be exactly one.
  const separators = []
  for (let index = first + 1; index < lines.length; index += 1) {
    if (lines[index] === SEPARATOR) separators.push(index)
  }
  if (separators.length === 0) return refusal('one-marker')
  if (separators.length > 1) return refusal('extra-marker')
  const separator = separators[0]

  const written = lines.slice(first + 1, separator).join('\n').trim()
  const rest = lines.slice(separator + 1).join('\n').trim()
  if (!written) return refusal('empty-spoken')
  if (!rest) return refusal('empty-rest')
  // The play mark is what makes the first part speech rather than a paragraph
  // that happens to sit between two rules.
  const marked = splitSpokenMark(written)
  if (!marked.marked) return refusal('no-mark')
  if (!marked.text) return refusal('empty-spoken')

  return { ok: true, reason: 'ok', spoken: marked.text, rest }
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
    ? 'Озвучка включена: первая часть уйдёт голосом, если ответ размечен.'
    : 'Озвучка сейчас отключена галкой «Отключить озвучивание ответов»: разметку писать можно, звука не будет.'
  return `## Ответ голосом

Если ответ просят озвучить, он оформляется так:

---

${SPOKEN_MARK}ответ голосом

---

расширенный ответ

конец файла

- первая непустая строка — \`---\` (ровно три дефиса); ниже — то, что произносят, и эта строка обязана начинаться со значка ${SPOKEN_MARK}; затем ещё одна строка \`---\`; закрывающего маркера нет;
- значок ${SPOKEN_MARK} — единственный признак «это произносить»: без него ответ не озвучивается, даже если маркеры на месте. Так не озвучивается случайный YAML-мультидокумент или просто ответ с двумя горизонтальными чертами;
- до и после каждого маркера ставь пустую строку: иначе markdown прочитает строку над \`---\` как заголовок;
- ровно два \`---\` на ответ: третий сделает ответ не документом;
- ответ может начинаться с цитаты (\`>\` строки) — она не мешает: документ начинается со следующего \`---\`;
- между значком и текстом пробел не обязателен, пробел или тире после значка в озвучку не попадут;
- первая часть — не длиннее ${maxChars} символов, без markdown, ссылок и блоков кода;
- обе части непустые; при любом отклонении звука не будет — ответ уйдёт как есть;
- маркеры остаются в ответе, их видит человек;
- для ответа в чате НЕ вызывай voice_say и не показывай файл через present: этот документ и есть озвучка, хост синтезирует его сам;
- не пересказывай, какими инструментами ты пользовался: отвечай по существу;
- ${state}`
}
