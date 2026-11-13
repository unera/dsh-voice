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

/**
 * How long the device may take to hand over a recording, in seconds.
 *
 * A press means "I am talking now", so the take arrives within seconds. The
 * previous 45s was the whole command timeout: every exchange whose take had
 * already been consumed waited it out, and the phone's command queue piled up
 * behind it, so answers arrived three or four questions late.
 */
const RECORD_TIMEOUT_SECONDS = 12
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

  /** Recording ids already handled: a retry must not become a second answer. */
  const seen = new Map()
  const SEEN_LIMIT = 200

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
  async function transcribe (audioPath) {
    if (!speechToText) throw Object.assign(new Error('speech recognition is not installed'), { code: 'no_speech' })
    const audio = readFileSync(audioPath)
    const spec = speechToText.resolve({ audio })
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
      active.delete(nodeName)
      log.info?.('[dsh-voice] no recording', { node: nodeName, code: record?.code ?? record?.status })
      if (record?.code === 'voice_timeout') await say(nodeName, 'Не услышал попробуй ещё раз.')
      trace.done('no-recording', { code: record?.code ?? null })
      return { status: 'no-recording', code: record?.code ?? null }
    }
    const devicePath = record.payload.path
    const localPath = join(cacheDir, `take-${Date.now()}-${basename(devicePath)}`)
    const copy = await nodes.call(nodeName, 'files', 'copyFromDevice', { path: devicePath, hostPath: localPath })
    // The take belongs to the person's words: once it is here, the device copy is litter.
    await nodes.call(nodeName, 'shell', 'exec', { command: `rm -f ${JSON.stringify(devicePath)}` })
    if (copy?.status !== 'ok') {
      active.delete(nodeName)
      cleanup([localPath])
      log.warn?.('[dsh-voice] the recording did not arrive', { node: nodeName, message: copy?.message })
      await say(nodeName, 'Не смог забрать запись.')
      trace.done('no-copy')
      return { status: 'no-copy' }
    }
    let text = ''
    try {
      const transcript = await transcribe(localPath)
      text = String(typeof transcript === 'string' ? transcript : transcript?.text ?? '').trim()
    } catch (error) {
      log.warn?.('[dsh-voice] transcription failed:', error?.message ?? error)
    }
    trace.mark('transcribed')
    if (!text) {
      active.delete(nodeName)
      cleanup([localPath])
      await say(nodeName, NOT_HEARD)
      trace.done('empty')
      return { status: 'empty' }
    }
    const sessionId = await sessionFor(nodeName, want?.sessionId ?? null, want?.node ?? null)
    active.set(nodeName, { sessionId })
    // The wait is registered before the message is delivered: a turn that starts
    // and ends quickly otherwise finishes before anyone is awaiting it, and the
    // answer to the *previous* question is what gets spoken.
    awaiting.set(sessionId, { node: nodeName, mode: want?.mode ?? 'ptt', turn: null, trace })
    try {
      await deliver({ sessionId, text, node: nodeName, mode: want?.mode ?? 'ptt' })
      trace.mark('delivered')
    } catch (error) {
      active.delete(nodeName)
      cleanup([localPath])
      awaiting.delete(sessionId)
      log.warn?.('[dsh-voice] delivery failed:', error?.message ?? error)
      await say(nodeName, 'Не смог передать запрос.')
      trace.done('no-session')
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
    let text = ''
    try {
      const transcript = await transcribe(event.path)
      text = String(typeof transcript === 'string' ? transcript : transcript?.text ?? '').trim()
    } catch (error) {
      log.warn?.('[dsh-voice] transcription failed:', error?.message ?? error)
    }
    trace.mark('transcribed')
    if (!text) {
      cleanup([event.path])
      await say(nodeName, NOT_HEARD)
      trace.done('empty')
      return { status: 'empty', id: event?.id ?? null }
    }
    const sessionId = await sessionFor(nodeName, event?.sessionId ?? null, event?.node ?? null)
    active.set(nodeName, { sessionId })
    // The wait is registered before the message is delivered: a turn that starts and ends
    // quickly would otherwise finish before anyone awaits it.
    awaiting.set(sessionId, { node: nodeName, mode: event?.mode ?? 'upload', turn: null, trace })
    try {
      await deliver({ sessionId, text, node: nodeName, mode: 'upload' })
      trace.mark('delivered')
    } catch (error) {
      awaiting.delete(sessionId)
      active.delete(nodeName)
      cleanup([event.path])
      log.warn?.('[dsh-voice] delivery failed:', error?.message ?? error)
      await say(nodeName, 'Не смог передать запрос.')
      trace.done('no-session')
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
    const assistant = assistantTextOf(event)
    if (assistant) {
      drafts.set(sessionId, assistant.text)
      return
    }
    if (event?.type !== 'turn/end') return
    const reason = event.data?.reason?.kind ?? event.data?.reason
    if (reason !== 'completed') return
    const waiting = awaiting.get(sessionId)
    if (!waiting) return
    // Before the awaited turn opens, any end belongs to work that started
    // earlier — the previous question — and must not consume this wait.
    if (waiting.turn === null) return
    if (event.data?.turn !== waiting.turn) return
    const text = drafts.get(sessionId) ?? ''
    const target = awaiting.get(sessionId)
    awaiting.delete(sessionId)
    drafts.delete(sessionId)
    if (!target) return
    if (target.node) active.delete(target.node)
    target.trace?.mark('turn-end', { reason })
    const { speak } = splitReply(text)
    target.trace?.mark('split', { speakChars: speak.trim().length })
    if (!speak.trim()) {
      target.trace?.done('silent')
      return
    }
    try {
      await speakAnswer({ sessionId, text: speak, node: target.node, trace: target.trace })
    } catch (error) {
      log.warn?.('[dsh-voice] speech failed:', error?.message ?? error)
    }
  }

  /**
   * Turn the spoken part into audio and make the device say it.
   *
   * The audio is synthesized here even though the device currently speaks the text with its
   * own engine: that keeps the synthesis path exercised, and the moment `voice.play` exists
   * the file is already there. Until then the text is what the phone actually plays.
   */
  async function speakAnswer ({ sessionId, text, node, trace = null }) {
    let audioPath = null
    if (textToSpeech?.resolve && textToSpeech?.synthesize) {
      try {
        // The provider speaks at its own rate: Silero refuses a tempo it cannot
        // honour, and a tempo belongs to the playback step, not to synthesis.
        const spec = textToSpeech.resolve({ text, speed: 1, format: 'wav' })
        const speech = await textToSpeech.synthesize(spec, new AbortController().signal)
        audioPath = join(cacheDir, `say-${Date.now()}.wav`)
        writeFileSync(audioPath, speech.audio)
        trace?.mark('synthesized', { seconds: Number(speech.seconds?.toFixed?.(2) ?? speech.seconds) })
        log.info?.('[dsh-voice] synthesized', { session: sessionId, seconds: speech.seconds })
      } catch (error) {
        // The device can still speak the text; a missing model must not silence the answer.
        log.warn?.('[dsh-voice] synthesis failed, speaking with the device engine:', error?.message ?? error)
      }
    }
    await say(node, text)
    trace?.mark('spoken')
    trace?.done('ok')
    if (audioPath) cleanup([audioPath])
    return { spoken: true }
  }

  if (typeof on === 'function') {
    const dispose = on('session/event', (session, event) => {
      void observeSessionEvent(session, event)
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  return {
    handle,
    handleUpload,
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
