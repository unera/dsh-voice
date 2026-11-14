// The voice markup: one format for both directions of a spoken turn.
//
// A channel that received speech writes a service block into the prompt text,
// because the prompt RPC cannot carry a message source:
//
//   --- # voice device=pixel speed=1.2
//   включи свет в коридоре
//
// The model answers in the same shape, naming what is meant to be heard and
// what is only meant to be read:
//
//   --- # say
//   Свет включил, в коридоре горит.
//   --- # screen
//   Датчик сработал в 21:14.
//
// A marker is a whole line that starts with `---` and carries a `#` comment.
// A bare `---` is a markdown rule, a table separator or a code fence body far
// more often than it is our marker, so it is deliberately NOT one. Lines inside
// an unterminated ``` fence are ignored as well: a half-written answer must not
// have its code sample arm the parser.

/** Marker roles this format knows; unknown ones are not markers at all. */
const MARKER_KINDS = new Set(['voice', 'say', 'screen', 'text'])

/** `--- # kind options…` — the whole line, nothing else around it. */
const MARKER_LINE = /^---[ \t]*#[ \t]*([a-z]+)\b[ \t]*(.*)$/i

/** `key=value`, `key="two words"`, `key='two words'`. */
const OPTION_PAIR = /([a-z_][\w-]*)=("([^"]*)"|'([^']*)'|[^\s,;]+)/gi

/** Roles that name the spoken part, and roles that name the visible part. */
const SPEAK_KINDS = new Set(['voice', 'say'])
const SCREEN_KINDS = new Set(['screen', 'text'])

/** Trim one block body without eating the indentation of its inner lines. */
function trimBlock(text) {
  return text.replace(/^[\r\n]+/, '').replace(/[\s\r\n]+$/, '')
}

/**
 * Read the `key=value` tail of a marker.
 * @param tail - everything after the marker kind on its line.
 * @returns a lower-cased option map; unknown keys are kept, they are the model's business.
 */
export function parseMarkerOptions(tail) {
  /** @type {Record<string, string>} */
  const options = {}
  if (typeof tail !== 'string' || !tail) return options
  for (const match of tail.matchAll(OPTION_PAIR)) {
    const key = match[1].toLowerCase()
    const value = match[3] ?? match[4] ?? match[2]
    options[key] = value
  }
  return options
}

/**
 * Walk the text and collect marker-led blocks.
 *
 * @param text - message body.
 * @returns `{ blocks, plain }`: blocks in source order, each `{kind, options, text}`,
 *   and the text before the first marker. A text with no marker yields no blocks
 *   and puts everything into `plain`.
 */
export function splitVoiceMarkers(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source.trim()) return { blocks: [], plain: '' }

  const lines = source.split('\n')
  /** @type {Array<{kind: string, options: Record<string, string>, text: string}>} */
  const blocks = []
  let plainLines = []
  let current = null
  let body = []
  let inFence = false

  const flush = () => {
    if (current === null) return
    const bodyText = trimBlock(body.join('\n'))
    if (bodyText) blocks.push({ ...current, text: bodyText })
    current = null
    body = []
  }

  for (const raw of lines) {
    // A model that glues the marker to the sentence before it — `…процентов.--- # screen`
    // — meant the same thing as a marker on its own line. Split it out before the
    // line rules run, but never inside a code fence, where such text is content.
    let line = raw
    if (!inFence) {
      const glued = /^(.+?)(---[ \t]*#[ \t]*[a-z]+\b.*)$/i.exec(raw)
      if (glued && !MARKER_LINE.test(raw)) {
        plainLines.push(glued[1])
        line = glued[2]
      }
    }
    // A fence is opened and closed by the same marker; while it is open every
    // line is content, including something that looks like our marker.
    if (/^\s*```/.test(line)) inFence = !inFence
    const marker = inFence ? null : MARKER_LINE.exec(line)
    const kind = marker ? marker[1].toLowerCase() : ''
    if (marker && MARKER_KINDS.has(kind)) {
      flush()
      current = { kind, options: parseMarkerOptions(marker[2]) }
      continue
    }
    if (current === null) plainLines.push(line)
    else body.push(line)
  }
  flush()

  return { blocks, plain: trimBlock(plainLines.join('\n')) }
}

/**
 * Join the named parts of a reply into the text that is spoken and the text
 * that is shown.
 *
 * @param parts - blocks in order, each with its role (`null` when unlabeled).
 * @returns the `speak` and `screen` strings, empty when the part is absent.
 */
function joinParts(parts) {
  const speak = []
  const screen = []
  for (const part of parts) {
    if (part.role === 'speak') speak.push(part.text)
    else if (part.role === 'screen') screen.push(part.text)
    else {
      // An unlabeled document is the answer itself the first time and an
      // appendix every time after that: only the first one is also spoken.
      if (part.first) speak.push(part.text)
      screen.push(part.text)
    }
  }
  return { speak: speak.join('\n\n').trim(), screen: screen.join('\n\n').trim() }
}

/**
 * Split a model reply into the part that is spoken and the part that is read.
 *
 * @param text - the whole assistant message.
 * @returns `{ speak, screen, parts }`: the spoken text, the visible text, and the
 *   blocks the parse was made of (`parts` is empty when the reply had no marker).
 */
export function splitReply(text) {
  const source = typeof text === 'string' ? text : ''
  const { blocks, plain } = splitVoiceMarkers(source)

  if (blocks.length === 0) {
    const whole = source.trim()
    return {
      speak: whole,
      screen: whole,
      parts: whole ? [{ kind: null, role: null, first: true, text: whole }] : [],
    }
  }

  /** @type {Array<{kind: string|null, role: string|null, first: boolean, text: string}>} */
  const parts = []
  // Text before the first marker is an unlabeled leading document: it counts as
  // the first one, so `Привет\n--- # screen\n…` still speaks the greeting.
  if (plain) parts.push({ kind: null, role: null, first: true, text: plain })
  for (const block of blocks) {
    const role = SPEAK_KINDS.has(block.kind) ? 'speak'
      : SCREEN_KINDS.has(block.kind) ? 'screen'
        : null
    parts.push({ kind: block.kind, role, first: parts.length === 0, text: block.text })
  }

  const { speak, screen } = joinParts(parts)
  return {
    speak,
    // A reply that names only its spoken part is still shown: nobody should get
    // a voice note with no text to look back at.
    screen: screen || speak,
    parts,
  }
}

/**
 * Read the voice instructions carried by an incoming message.
 *
 * @param text - the message body as the channel wrote it.
 * @returns `{ text, voice }`: the user's own words, and how the message was spoken.
 */
export function readVoiceMarkup(text) {
  const { blocks, plain } = splitVoiceMarkers(text)
  const voice = blocks.find((block) => block.kind === 'voice')
  if (!voice) return { text: typeof text === 'string' ? text : '', voice: null }
  // Everything that is not the voice block belongs to the user as well: a
  // channel may append its own blocks after the transcript.
  const rest = blocks
    .filter((block) => block !== voice)
    .map((block) => block.text)
    .join('\n\n')
  const body = [plain, voice.text, rest].filter(Boolean).join('\n\n')
  return { text: body, voice: { options: voice.options } }
}
