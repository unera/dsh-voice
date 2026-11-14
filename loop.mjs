// The voice loop: what happens between "the person pressed talk" and "the phone answers".
//
// A device cannot push a recording by itself — the transfer endpoint accepts an answer to a
// `copyFromDevice` command, so the host has to ask. That inverts the obvious design: the
// phone says "I want to talk" (an event, no text, nothing delivered), and this side does
// the asking, transcribing, delivering and speaking back.
//
// Every outside world dependency is passed in, so the whole loop can be exercised on stubs:
// no device, no model, no speech service.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
/** What we say when the recording produced no words. */
const NOT_HEARD = 'Не расслышал, повтори пожалуйста.'

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
 * @param deps.sessions - the session service (`flush`).
 * @param deps.sessionController - resolves and creates sessions.
 * @param {string} deps.cacheDir - where a recording is kept on the host while it is used.
 * @param {object} [deps.log] - `{info, warn, debug}`; console-like.
 * @param {Function} [deps.createUserMessage] - DSH message constructor, for `source`.
 * @param {Function} [deps.on] - subscription for session events.
 * @returns `{ handle, observeSessionEvent, pending, dispose }`
 */
export function createVoiceLoop ({
  nodes,
  speechToText = null,
  textToSpeech = null,
  sessions = null,
  sessionController = null,
  cacheDir,
  log = console,
  createUserMessage = null,
  on = null,
  emit = null,
  exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS,
  language = DEFAULT_LANGUAGE,
  minSeconds = MIN_SECONDS,
}) {
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

  /** Where a synthesized answer waits for the device to fetch it. */
  const outputDir = join(cacheDir, 'out')

  /** Nodes whose "new session" arrived while an exchange was still running. */
  const resetPending = new Set()

  /** Recording ids already handled: a retry must not become a second answer. */
  const seen = new Map()
  const SEEN_LIMIT = 200

  /**
   * Show one line on the device screen.
   *
   * This is a side command: it never joins the exchange queue, and its failure never costs the
   * answer. A phone whose screen is off, a build without `voice.chat`, a full queue — all of it is
   * a log line, and the turn goes on.
   *
   * @param args - node, role, text, the exchange id, and the trace to stamp.
   */
  function pushChat ({ node, role, text, speak = null, id = null, trace = null, say = false, audio = null }) {
    const body = String(text ?? '').trim()
    if (!body) return
    const stage = role === 'user' ? 'chat-user' : 'chat-assistant'
    try {
      const pending = nodes.call(node, 'voice', 'chat', {
        role,
        text: body,
        ...speak === null ? {} : { speak: String(speak) },
        ...id ? { id } : {},
        ...say ? { say: true } : {},
        ...audio ? { audio } : {},
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

  /** Everything that has to disappear after one exchange. */
  function cleanup (paths) {
    for (const path of paths) {
      try {
        rmSync(path, { force: true })
      } catch {}
    }
  }

  /** Say something short on the device through its own engine, best effort. */
  async function say (node, text) {
    const answer = await nodes.call(node, 'voice', 'say', { text })
    if (answer?.status !== 'ok') log.warn?.('[dsh-voice] the device did not speak:', answer?.message ?? answer?.code)
    return answer
  }

  /** Ask the device how much of the words it heard. */
  async function transcribe (audioPath, trace = null) {
    if (!speechToText) throw Object.assign(new Error('speech recognition is not installed'), { code: 'no_speech' })
    const audio = readFileSync(audioPath)
    // The language is named, not inherited: a Host default of `auto` lets a short noisy take drift
    // into any language the model likes, and the person's words are then translated by accident.
    let spec = null
    try {
      spec = speechToText.resolve({ audio, language })
    } catch (error) {
      // A provider that does not take this language is not an emergency: say so and let the
      // service pick its own default rather than losing the recording.
      log.warn?.('[dsh-voice] the recognizer does not take the configured language:', error?.message ?? error)
      spec = speechToText.resolve({ audio })
    }
    trace?.mark('stt-request', { provider: spec?.provider?.info?.id ?? 'default', language })
    return await speechToText.transcribe(spec, new AbortController().signal)
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
    // A press is a promise: it must end in an answer, even while the previous
    // exchange is still waiting for the model. Refusing it as "busy" used to drop
    // the press, park its take, and then answer the previous question only when
    // the *next* press asked for a recording — the words arrived one message late
    // and the delay grew with every press.
    const chain = queues.get(nodeName) ?? Promise.resolve()
    const mine = chain.then(async () => await exchange(want, nodeName)).catch((error) => {
      log.warn?.('[dsh-voice] voice exchange failed:', error?.message ?? error)
      return { status: 'failed' }
    })
    queues.set(nodeName, mine.then(() => {}).catch(() => {}))
    return await mine
  }

  /**
   * Run one exchange, now that the queue reached it.
   *
   * @param want - the device event that asked for it.
   * @param nodeName - the node to talk to.
   * @returns a short outcome for the log.
   */
  async function exchange (want, nodeName) {
    const trace = createTrace({ id: `pull-${nodeName}-${Date.now()}`, node: nodeName, log })
    trace.mark('received')
    active.set(nodeName, { sessionId: want?.sessionId ?? bindings.get(nodeName) ?? null })
    mkdirSync(cacheDir, { recursive: true })
    const record = await nodes.call(nodeName, 'voice', 'record', {
      mode: want?.mode ?? 'ptt',
      maxSeconds: 30,
      timeout: RECORD_TIMEOUT_SECONDS,
    })
    if (record?.status !== 'ok' || !record?.payload?.path) {
      releaseNode(nodeName)
      log.info?.('[dsh-voice] no recording', { node: nodeName, code: record?.code ?? record?.status })
      if (record?.code === 'voice_timeout') await say(nodeName, 'Не услышал попробуй ещё раз.')
      trace.done('no-recording', { code: record?.code ?? null, language })
      return { status: 'no-recording', code: record?.code ?? null }
    }
    const devicePath = record.payload.path
    const localPath = join(cacheDir, `take-${Date.now()}-${basename(devicePath)}`)
    const copy = await nodes.call(nodeName, 'files', 'copyFromDevice', { path: devicePath, hostPath: localPath })
    // The take belongs to the person's words: once it is here, the device copy is litter.
    await nodes.call(nodeName, 'shell', 'exec', { command: `rm -f ${JSON.stringify(devicePath)}` })
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
      cleanup([localPath])
      trace.done('too-short', { language, seconds: recordedSeconds })
      return { status: 'too-short', code: 'too-short' }
    }
    let text = ''
    try {
      const transcript = await transcribe(localPath, trace)
      text = String(typeof transcript === 'string' ? transcript : transcript?.text ?? '').trim()
    } catch (error) {
      log.warn?.('[dsh-voice] transcription failed:', error?.message ?? error)
    }
    trace.mark('transcribed')
    // The screen shows what the person said before the model sees it: a long silence is
    // otherwise indistinguishable from a lost recording.
    if (text) pushChat({ node: nodeName, role: 'user', text, trace })
    if (!text) {
      releaseNode(nodeName)
      cleanup([localPath])
      await say(nodeName, NOT_HEARD)
      trace.done('empty', { language })
      return { status: 'empty' }
    }
    const sessionId = await sessionFor(nodeName, want?.sessionId ?? null, want?.node ?? null)
    active.set(nodeName, { sessionId })
    // The wait is registered before the message is delivered: a turn that starts
    // and ends quickly otherwise finishes before anyone is awaiting it, and the
    // answer to the *previous* question is what gets spoken.
    awaiting.set(sessionId, watchForAnswer({
      sessionId, node: nodeName, mode: want?.mode ?? 'ptt', trace, synth: 'device',
    }))
    try {
      await deliver({ sessionId, text, node: nodeName, mode: want?.mode ?? 'ptt' })
      trace.mark('delivered')
    } catch (error) {
      releaseNode(nodeName)
      cleanup([localPath])
      awaiting.delete(sessionId)
      log.warn?.('[dsh-voice] delivery failed:', error?.message ?? error)
      await say(nodeName, 'Не смог передать запрос.')
      trace.done('no-session', { language })
      return { status: 'no-session' }
    }
    cleanup([localPath])
    return { status: 'delivered', session: sessionId, text }
  }

  /**
   * Remember one recording id, and say whether it is new.
   *
   * A device that retries must not be answered twice: the id is the identity of one
   * exchange, not of one request. Old ids are dropped in insertion order, so the map cannot
   * grow for the lifetime of the host.
   *
   * @param id - the recording id from the device.
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
    if (id && !rememberId(id)) {
      log.info?.('[dsh-voice] the same recording arrived again, ignoring', { id })
      return { status: 'already', id }
    }
    const nodeName = event?.nodeName ?? String(event?.node ?? '')
    // The same per-node order as a press: two takes cannot overtake each other, and the
    // second waits instead of being dropped.
    const chain = queues.get(nodeName) ?? Promise.resolve()
    const mine = chain
      .then(async () => await exchangeFromFile(event, nodeName))
      .catch((error) => {
        log.warn?.('[dsh-voice] uploaded exchange failed:', error?.message ?? error)
        return { status: 'failed' }
      })
    queues.set(nodeName, mine.then(() => {}).catch(() => {}))
    return await mine
  }

  /**
   * Transcribe a file that is already on disk and answer it.
   *
   * @param event - the upload event.
   * @param nodeName - the node to speak to.
   * @returns a short outcome for the log.
   */
  async function exchangeFromFile (event, nodeName) {
    const trace = createTrace({ id: event?.id ?? null, node: nodeName, at: event?.at ?? null, log })
    trace.mark('received')
    const seconds = Number(event?.seconds)
    if (Number.isFinite(seconds) && seconds > 0 && seconds < minSeconds) {
      // Nothing worth recognizing: the file goes, the session stays untouched, and the device is
      // told nothing — the person knows they only brushed the button.
      cleanup([event.path])
      trace.done('too-short', { language, seconds })
      return { status: 'too-short', id: event?.id ?? null, seconds }
    }
    let text = ''
    try {
      const transcript = await transcribe(event.path, trace)
      text = String(typeof transcript === 'string' ? transcript : transcript?.text ?? '').trim()
    } catch (error) {
      log.warn?.('[dsh-voice] transcription failed:', error?.message ?? error)
    }
    trace.mark('transcribed')
    if (text) pushChat({ node: nodeName, role: 'user', text, id: event?.id ?? null, trace })
    if (!text) {
      cleanup([event.path])
      await say(nodeName, NOT_HEARD)
      trace.done('empty', { language })
      return { status: 'empty', id: event?.id ?? null }
    }
    const sessionId = await sessionFor(nodeName, event?.sessionId ?? null, event?.node ?? null)
    active.set(nodeName, { sessionId })
    // The wait is registered before the message is delivered: a turn that starts and ends
    // quickly would otherwise finish before anyone awaits it.
    awaiting.set(sessionId, watchForAnswer({
      sessionId, node: nodeName, mode: event?.mode ?? 'upload', trace, synth: event?.synth ?? 'device',
    }))
    try {
      await deliver({ sessionId, text, node: nodeName, mode: 'upload' })
      trace.mark('delivered')
    } catch (error) {
      awaiting.delete(sessionId)
      releaseNode(nodeName)
      cleanup([event.path])
      log.warn?.('[dsh-voice] delivery failed:', error?.message ?? error)
      await say(nodeName, 'Не смог передать запрос.')
      trace.done('no-session', { language })
      return { status: 'no-session' }
    }
    // The recording has done its job: keeping it would only grow the cache.
    cleanup([event.path])
    return { status: 'delivered', session: sessionId, text, id: event?.id ?? null }
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
      id: target.trace?.id ?? null,
    })
  }

  /** The configured playback tempo, applied to host audio only. */
  function tempo () {
    const configured = Number(textToSpeech?.snapshot?.().selection?.speed ?? 1)
    return Number.isFinite(configured) && configured > 0 ? configured : 1
  }

  /** Ask the service for audio; a missing service is a failure, not a silence. */
  async function synthesize (text) {
    if (!textToSpeech?.resolve || !textToSpeech?.synthesize) throw new Error('text-to-speech is not installed')
    // The provider speaks at its own rate: a tempo belongs to playback, not to synthesis.
    const spec = textToSpeech.resolve({ text, speed: 1, format: 'wav' })
    return await textToSpeech.synthesize(spec, new AbortController().signal)
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
  async function answerWith ({ sessionId, text, speak = '', node, trace = null, synth = 'device', id = null }) {
    const spoken = String(speak ?? '').trim()
    let audioPath = null
    // Audio is rendered from what must be heard, never from what must be read.
    if (synth === 'host' && spoken) {
      try {
        const speech = await synthesize(spoken)
        const wavPath = join(cacheDir, `say-${Date.now()}.wav`)
        writeFileSync(wavPath, speech.audio)
        trace?.mark('synthesized', { seconds: Number(speech.seconds?.toFixed?.(2) ?? speech.seconds) })
        mkdirSync(outputDir, { recursive: true })
        audioPath = join(outputDir, `${id ?? Date.now()}.ogg`)
        try {
          await toVoiceNote(wavPath, audioPath, tempo(), { signal: new AbortController().signal })
        } finally {
          cleanup([wavPath])
        }
      } catch (error) {
        // The device engine is always there; a broken synthesizer costs the voice, not the answer.
        log.warn?.('[dsh-voice] synthesis failed, the device will speak:', error?.message ?? error)
        trace?.mark('tts-failed', { error: error?.message?.slice(0, 80) ?? String(error) })
        audioPath = null
      }
    }
    // `say` only when there are words to say: an empty `# say` means the answer is silent.
    pushChat({ node, role: 'assistant', text, speak: spoken, id, say: Boolean(spoken), audio: audioPath, trace })
    // The device fetches the file by the command it answers; until then it must stay.
    if (audioPath) setTimeout(() => cleanup([audioPath]), AUDIO_TTL_MS).unref?.()
    trace?.done(synth === 'host' && spoken && !audioPath ? 'tts-failed' : 'ok',
      { synth: audioPath ? 'host' : 'device', language })
    log.info?.('[dsh-voice] answered', { session: sessionId, synth: audioPath ? 'host' : 'device', speakChars: spoken.length })
    return { answered: true }
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
    observeSessionEvent,
    awaiting,
    dispose () {
      stopWatching()
      awaiting.clear()
      drafts.clear()
      active.clear()
    },
  }
}
