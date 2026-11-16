// The closing-turn reply: one OGG, declared as a deliverable of the turn.
//
// The protocol itself is in `structure.mjs`. This file is what happens after it
// says yes: the first part goes to the `textToSpeech` service, the WAV becomes an
// OGG, and `deliverables/presented` is appended — the same durable record the
// `present` tool writes. Every channel that already carries files picks it up
// from there: `dsh-im` uploads it as a voice note, the Web client lists it under
// the answer. No `voice_say`, no `present`, no channel taught about voice.
//
// Two constraints decide the shape of the code:
//
// * the hook must be `agent/turn-stopping`. It is serial, it runs before
//   `turn/end`, and the turn is still open inside it — which is exactly what
//   `dsh-im` requires to accept a presented file, and the last moment the text of
//   the answer is known. Synthesis therefore happens inside the hook, and a
//   timeout bounds how long a slow engine may hold the turn.
// * the answer text is never touched. The markers stay in the message, the parts
//   are read and nothing is written back; the plugin only appends a record.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { toVoiceNote } from './audio.mjs'
import { charCount, parseVoiceDocument, replyContract } from './structure.mjs'
import { defaultCacheDir, normalizeReplySettings } from './settings.mjs'
import { waitForSnapshot } from './probe.mjs'

/** Durable Session event the Host `present` tool appends, reused verbatim. */
export const PRESENTED_EVENT = 'deliverables/presented'

/** Prefix of every `callId` this plugin writes; it is also the dedup marker. */
export const CALL_ID_PREFIX = 'dsh-voice:'

export { defaultCacheDir }

/** Extensions a channel turns into a voice note rather than a document. */
export const AUDIO_EXTENSIONS = Object.freeze(['.ogg', '.oga', '.opus'])

/** Text parts of one message, joined the way the harness writes them. */
export function messageText (message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * The slice of the log that belongs to one turn.
 *
 * A `turn/start` is the only marker the harness writes at the turn boundary, so
 * the last one naming this turn opens the slice and everything after it belongs
 * here: while `agent/turn-stopping` runs, no later turn can have started.
 *
 * @param events - the Session log, oldest first.
 * @param turn - the turn being closed.
 * @returns the events after that turn's `turn/start`; the whole log when the
 *   marker is missing, so a caller is never handed an empty answer.
 */
export function turnEvents (events, turn) {
  if (!Array.isArray(events)) return []
  if (!Number.isInteger(turn)) return events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) {
      return events.slice(index + 1)
    }
  }
  return events
}

/**
 * The answer a reader is left with: the text after the last tool call.
 *
 * This mirrors the rule the IM channel applies to the same log
 * (`accumulateFinalAssistantText` in dsh-im): a tool call means the text before
 * it was a preamble, and an assistant message that carries a tool call — or no
 * text at all — clears whatever came before. The point is that the person
 * listening and the person reading get the same answer, so a turn that first said
 * "сейчас посмотрю" does not have that line spoken.
 *
 * @param events - the Session log.
 * @param turn - the turn being closed.
 * @returns the final answer text, empty when the turn produced none.
 */
export function finalAnswerText (events, turn) {
  let answer = ''
  for (const event of turnEvents(events, turn)) {
    if (event?.type === 'tool/call') {
      answer = ''
      continue
    }
    if (event?.type !== 'assistant/message') continue
    if (event.data?.turn !== turn) continue
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const text = messageText(event.data.message).trim()
    // A canonical tool message can arrive before or after the separate call;
    // either way there is nothing to speak, and an earlier preamble is stale.
    if (!text || content.some((part) => part?.type === 'tool-call')) {
      answer = ''
      continue
    }
    answer = text
  }
  return answer.trim()
}

/**
 * Whether this turn already carries a voice note.
 *
 * Two cases, one predicate: our own earlier run (a turn can reach its stop
 * boundary twice when steering arrives) and a voice note the model attached
 * itself through `voice_say` + `present`. Speaking twice would make the person
 * listen to the same answer two times.
 *
 * @param events - the Session log.
 * @param turn - the turn being closed.
 * @returns whether the turn already declared audio.
 */
export function hasVoiceDeliverable (events, turn) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== PRESENTED_EVENT || event.data?.turn !== turn) continue
    const callId = event.data?.callId
    if (typeof callId === 'string' && callId.startsWith(CALL_ID_PREFIX)) return true
    const files = Array.isArray(event.data?.files) ? event.data.files : []
    if (files.some((file) => AUDIO_EXTENSIONS.includes(extname(String(file?.path ?? '')).toLowerCase()))) {
      return true
    }
  }
  return false
}

/**
 * Speak one text and append it to the turn as a presented file.
 *
 * @param options.service - the `textToSpeech` service (`resolve`/`synthesize`).
 * @param options.session - the Session the turn belongs to; `append` is used.
 * @param options.turn - the open turn this audio belongs to.
 * @param options.text - the first part of the answer, verbatim.
 * @param options.cacheDir - where the OGG is written.
 * @param options.speed - playback tempo applied by ffmpeg, 0.5–2.
 * @param options.description - the line the Web client shows for the file.
 * @param options.signal - the turn's cancellation.
 * @param options.deps - test seams (`writeFile`, `mkdir`, `rm`, `toVoiceNote`, `randomUUID`).
 * @returns `{path, callId, seq, size, seconds, voice}`: what was declared.
 */
export async function deliverVoice ({
  service,
  session,
  turn,
  text,
  cacheDir,
  speed,
  description,
  signal,
  deps = {},
}) {
  if (typeof service?.synthesize !== 'function' || typeof service?.resolve !== 'function') {
    throw new Error('нет сервиса синтеза речи: textToSpeech недоступен')
  }
  if (typeof session?.append !== 'function') throw new Error('нет сессии: событие доставки некуда записать')
  if (typeof text !== 'string' || !text.trim()) throw new Error('нечего озвучивать: текст пуст')
  // The record is not accepted without a line the surfaces can show: a file with
  // no description is a nameless attachment in the Web client. `callId` is the
  // other half of the same contract and is always generated below.
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('нет описания файла: запись с пустым description не принимается')
  }
  const caption = description.trim()

  const write = deps.writeFile ?? writeFile
  const makeDirectory = deps.mkdir ?? mkdir
  const remove = deps.rm ?? rm
  const convert = deps.toVoiceNote ?? toVoiceNote
  const uuid = (deps.randomUUID ?? randomUUID)()
  const directory = cacheDir ?? defaultCacheDir()

  // The engine speaks at its natural rate and the tempo is applied by ffmpeg,
  // exactly as `voice_say` does it: a provider `speed` moves phoneme durations
  // but leaves the pauses alone, so asking the engine for 1.5 gives about 1.25.
  const plan = service.resolve({ text, speed: 1, format: 'wav' })
  const speech = await service.synthesize(plan, signal)
  signal?.throwIfAborted()

  await makeDirectory(directory, { recursive: true })
  // The name starts with a letter on purpose: a UUID's first character is a hex
  // digit about six times in ten, and a file whose name begins with a digit is the
  // one shape a receiving side may refuse without saying why.
  const wavPath = join(directory, `voice-${uuid}.wav`)
  const oggPath = join(directory, `voice-${uuid}.ogg`)
  await write(wavPath, speech.audio)
  try {
    await convert(wavPath, oggPath, speed, { signal })
  } finally {
    // The intermediate is never a deliverable: leaving one per reply would fill
    // the cache with files nothing can play.
    await Promise.resolve(remove(wavPath, { force: true })).catch(() => undefined)
  }
  signal?.throwIfAborted()

  const callId = `${CALL_ID_PREFIX}${uuid}`
  const event = session.append(PRESENTED_EVENT, {
    turn,
    callId,
    files: [{ path: oggPath, description: caption }],
  })
  const size = Number((await Promise.resolve((deps.stat ?? stat)(oggPath))).size)
  return {
    path: oggPath,
    callId,
    // The sequence the record took in the Session log, and its size: the two
    // facts needed to compare this delivery with what the receiving side saw.
    seq: Number.isInteger(event?.seq) ? event.seq : null,
    size,
    // The provider measures the audio before the tempo change; a listener hears
    // it divided by the speed.
    seconds: typeof speech.seconds === 'number' ? Number((speech.seconds / speed).toFixed(2)) : 0,
    voice: speech.voice ?? '',
  }
}

/** Name of a rendered voice note, so pruning never touches a foreign file. */
const OWN_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:ogg|wav)$/u

/**
 * Delete rendered speech older than a day.
 *
 * The manual path tells the model to remove the file after delivery; with no
 * model in the loop nobody does, and a voice note per reply would grow the cache
 * without a bound. Only files this plugin names are touched, so a cache directory
 * shared with something else stays intact.
 *
 * @param directory - the cache directory.
 * @param options.maxAgeMs - age above which a file is removed.
 * @param options.now - clock, for tests.
 * @param options.deps - test seams (`readdir`, `stat`, `rm`).
 * @returns how many files were removed.
 */
export async function pruneOldFiles (directory, { maxAgeMs = 86_400_000, now = Date.now(), deps = {} } = {}) {
  const list = deps.readdir ?? readdir
  const inspect = deps.stat ?? stat
  const remove = deps.rm ?? rm
  let names
  try {
    names = await list(directory)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!OWN_FILE.test(name)) continue
    const path = join(directory, name)
    try {
      const info = await inspect(path)
      if (!info?.isFile?.()) continue
      const age = now - Number(info.mtimeMs ?? now)
      if (age < maxAgeMs) continue
      await remove(path, { force: true })
      removed += 1
    } catch {
      // A file that vanished between the listing and the unlink is not a fault.
    }
  }
  return removed
}

/** Race a promise against a timer, leaving nothing behind when the timer wins. */
export function withTimeout (work, ms, message = 'озвучка не успела') {
  if (!(typeof ms === 'number') || !Number.isFinite(ms) || ms <= 0) return Promise.resolve(work)
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message)
      error.code = 'voice-reply-timeout'
      reject(error)
    }, ms)
    timer.unref?.()
  })
  const running = Promise.resolve(work)
  // The loser of the race must not surface later as an unhandled rejection.
  running.catch(() => {})
  return Promise.race([running, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/** Read one service without declaring it in `inject`. */
function service (ctx, name) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet) return viaGet
  } catch {}
  try {
    return ctx[name] ?? null
  } catch {
    return null
  }
}

/**
 * Do the work for one closing turn. Never throws: the hook is serial and an
 * exception here would end the turn with an error, so a voice note that could not
 * be made must cost the answer nothing.
 *
 * @returns `{delivered, reason, ...}`: what happened, and — for a reply passed
 *   through untouched — `asIs: true`.
 */
async function speakClosingTurn ({ agent, turn, signal }, settings, { ctx, log }) {
  const session = agent?.session
  if (!session || typeof session.append !== 'function' || typeof session.snapshotEvents !== 'function') {
    return { delivered: false, reason: 'no-session' }
  }
  const header = session.header ?? {}
  if (!settings.subagents && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) {
    return { delivered: false, reason: 'subagent' }
  }
  const events = session.snapshotEvents()
  if (hasVoiceDeliverable(events, turn)) return { delivered: false, reason: 'already-presented' }

  // Rules 1 and 2: only the documented structure can be spoken, and an answer
  // that is not one passes through exactly as written.
  const document = parseVoiceDocument(finalAnswerText(events, turn))
  if (!document.ok) return { delivered: false, reason: document.reason, asIs: true }

  // Rule 3: the limit is in characters, not bytes.
  const chars = charCount(document.spoken)
  if (chars > settings.maxChars) {
    return { delivered: false, reason: 'too-long', asIs: true, chars, limit: settings.maxChars }
  }

  const engine = settings.service ?? service(ctx, 'textToSpeech')
  if (typeof engine?.synthesize !== 'function' || typeof engine?.resolve !== 'function') {
    return { delivered: false, reason: 'no-tts' }
  }

  const speed = settings.speed ?? (Number(engine.preferredSpeed?.() ?? 1) || 1)
  const cacheDir = settings.cacheDir ?? defaultCacheDir()
  const result = await withTimeout(deliverVoice({
    service: engine,
    session,
    turn,
    // Rule 4: the first part is spoken as written; synthesis cleans nothing.
    text: document.spoken,
    cacheDir,
    speed,
    description: settings.description,
    signal,
    deps: settings.deps,
  }), settings.timeoutMs)

  // Pruning is housekeeping, not part of the answer: a failure there is silent.
  void pruneOldFiles(cacheDir).catch(() => undefined)

  // Whether the receiving side took the record. The append succeeds either way:
  // `dsh-im` drops a record it cannot own without saying so, and a delivery that
  // silently goes nowhere must be visible in the log rather than inferred from
  // the absence of a voice note.
  let handoff = null
  if (settings.diagnose) {
    try {
      const probe = await waitForSnapshot({
        path: result.path,
        since: Date.now(),
        timeoutMs: settings.diagnoseTimeoutMs,
        // A test injects a temporary directory and its own seams here.
        ...(settings.deps.probe ?? {}),
      })
      handoff = probe.taken ? 'taken' : 'not-taken'
    } catch {
      handoff = 'unknown'
    }
  }

  return {
    delivered: true,
    reason: 'document',
    sessionId: session.header?.id ?? session.id ?? null,
    turn,
    callId: result.callId,
    seq: result.seq,
    path: result.path,
    bytes: result.size,
    seconds: result.seconds,
    chars,
    limit: settings.maxChars,
    handoff,
  }
}

/**
 * Mount the reply hook.
 *
 * The listener is installed once and stays; the switch is read at every closing
 * turn from the configuration reference the Loader keeps live, so turning
 * "speak replies" on or off in the Plugins page takes effect on the next answer
 * instead of on the next restart. The prompt section works the same way: its text
 * is a function, and it contributes nothing while the switch is off — otherwise
 * the model would wrap every reply in markers for a feature nobody enabled.
 *
 * @param ctx - owning Host context; `on` is the only method required.
 * @param options.config - the plugin configuration, kept by reference.
 * @param options.logger - where the reasons are written.
 * @param options.service - a synthesizer to use instead of the `textToSpeech`
 *   service; a test supplies one.
 * @param options.deps - test seams, forwarded to {@link deliverVoice}.
 * @returns a disposer, or undefined when the context cannot be listened to.
 */
export function installReply (ctx, { config = {}, logger = null, service: engine = null, deps = {} } = {}) {
  if (typeof ctx?.on !== 'function') return undefined
  const log = logger ?? (typeof ctx.logger === 'function' ? ctx.logger('dsh-voice') : console)

  /** The settings of this moment: every field read fresh, so a live edit lands. */
  const settingsNow = () => normalizeReplySettings({
    ...config,
    logger: null,
    service: engine ?? config.service ?? null,
    deps: config.deps ?? deps,
  })

  // Validate once, at mount: a limit outside the range is a configuration error
  // and belongs at the profile, not on the first answer that tries to speak.
  settingsNow()

  const register = (promptCtx) => {
    if (typeof promptCtx?.systemPrompt?.context !== 'function') return null
    return promptCtx.systemPrompt.context({
      name: 'dsh-voice:spoken-reply-contract',
      order: 118,
      // Evaluated at assembly: the switch and the limit are whatever they are now.
      text: () => {
        try {
          const settings = settingsNow()
          if (!settings.prompt) return ''
          // The contract is shown whether or not the switch is on: a model that
          // only learns the format after the switch flips can never produce one,
          // and the switch is exactly what a person reaches for second. The text
          // itself says what happens while voicing is off.
          return replyContract({ maxChars: settings.maxChars, enabled: settings.speakReplies })
        } catch {
          return ''
        }
      },
    })
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], register)
    else register(ctx)
  } catch (error) {
    // The contract is the smaller half: a Host whose prompt service cannot be
    // declared here must still get its answer spoken.
    log.warn?.('[dsh-voice] the spoken reply contract was not registered:', error?.message ?? error)
    try {
      register(ctx)
    } catch {}
  }

  const listener = async (payload) => {
    try {
      const settings = settingsNow()
      if (!settings.speakReplies) return { delivered: false, reason: 'off' }
      const outcome = await speakClosingTurn(payload ?? {}, settings, { ctx, log })
      if (outcome.delivered) {
        // One line with everything needed to compare this delivery with what the
        // channel saw: the session, the turn, the record's own identity, the file
        // and whether the receiving side took it.
        log.info?.('[dsh-voice] ответ озвучен', {
          sessionId: outcome.sessionId,
          turn: outcome.turn,
          callId: outcome.callId,
          seq: outcome.seq,
          chars: outcome.chars,
          limit: outcome.limit,
          seconds: outcome.seconds,
          bytes: outcome.bytes,
          path: outcome.path,
          handoff: outcome.handoff,
        })
        if (outcome.handoff === 'not-taken') {
          // The record is in the log and the file exists; the channel did not take
          // it. Saying so is the difference between "the audio never arrived" and
          // "the audio never arrived and nobody knows why".
          log.warn?.('[dsh-voice] запись не забрал канал: dsh-im не поставил файл в доставку', {
            sessionId: outcome.sessionId,
            turn: outcome.turn,
            callId: outcome.callId,
            seq: outcome.seq,
            path: outcome.path,
          })
        }
      } else if (outcome.asIs) {
        log.debug?.('[dsh-voice] ответ уходит как есть, без звука', {
          turn: payload?.turn,
          reason: outcome.reason,
          chars: outcome.chars ?? null,
          limit: outcome.limit ?? settings.maxChars,
        })
      } else {
        log.debug?.('[dsh-voice] ответ не озвучен', { turn: payload?.turn, reason: outcome.reason })
      }
      return outcome
    } catch (error) {
      // A missing voice note is a degradation, never a failed answer.
      log.warn?.('[dsh-voice] озвучка не удалась:', {
        turn: payload?.turn,
        reason: error?.code ?? error?.message ?? String(error),
      })
      return { delivered: false, reason: error?.code ?? 'error', message: error?.message ?? String(error) }
    }
  }

  return ctx.on('agent/turn-stopping', listener, { global: true })
}
