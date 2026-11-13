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

import { splitReply } from './markup.mjs'

/** How long the device may take to hand over a recording, in seconds. */
const RECORD_TIMEOUT_SECONDS = 45
/** What we say when the recording produced no words. */
const NOT_HEARD = 'Не расслышал, повтори пожалуйста.'

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
}) {
  /** One entry per node that is currently being talked to. */
  const active = new Map()
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

  /** Which session this node talks to: the one it was told, the bound one, or a new one. */
  async function sessionFor (nodeName, requested) {
    if (requested) return requested
    const bound = active.get(nodeName)?.sessionId
    if (bound) return bound
    if (!sessionController?.create) throw new Error('нет сессии для голоса и нечем создать новую')
    const created = await sessionController.create({})
    if (!created?.sessionId) throw new Error('не удалось создать сессию под голос')
    log.info?.('[dsh-voice] created a session for voice', { session: created.sessionId, node: nodeName })
    return created.sessionId
  }

  /**
   * One full exchange: ask for a recording, transcribe, deliver, wait, speak.
   *
   * @param want - `{node, nodeName, mode, sessionId}` from the device event.
   * @returns a short outcome for the caller (and for the log).
   */
  async function handle (want) {
    const nodeName = want?.nodeName ?? String(want?.node ?? '')
    if (active.has(nodeName)) return { status: 'busy' }
    active.set(nodeName, { sessionId: want?.sessionId ?? null })
    mkdirSync(cacheDir, { recursive: true })
    const record = await nodes.call(nodeName, 'voice', 'record', {
      mode: want?.mode ?? 'ptt',
      maxSeconds: 30,
      timeout: RECORD_TIMEOUT_SECONDS,
    })
    if (record?.status !== 'ok' || !record?.payload?.path) {
      active.delete(nodeName)
      log.info?.('[dsh-voice] no recording', { node: nodeName, code: record?.code ?? record?.status })
      if (record?.code === 'voice_timeout') await say(nodeName, 'Не услышал, попробуй ещё раз.')
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
      return { status: 'no-copy' }
    }
    let text = ''
    try {
      const transcript = await transcribe(localPath)
      text = String(typeof transcript === 'string' ? transcript : transcript?.text ?? '').trim()
    } catch (error) {
      log.warn?.('[dsh-voice] transcription failed:', error?.message ?? error)
    }
    if (!text) {
      active.delete(nodeName)
      cleanup([localPath])
      await say(nodeName, NOT_HEARD)
      return { status: 'empty' }
    }
    const sessionId = await sessionFor(nodeName, want?.sessionId ?? null)
    active.set(nodeName, { sessionId })
    try {
      await deliver({ sessionId, text, node: nodeName, mode: want?.mode ?? 'ptt' })
    } catch (error) {
      active.delete(nodeName)
      cleanup([localPath])
      log.warn?.('[dsh-voice] delivery failed:', error?.message ?? error)
      await say(nodeName, 'Не смог передать запрос.')
      return { status: 'no-session' }
    }
    awaiting.set(sessionId, { node: nodeName, mode: want?.mode ?? 'ptt' })
    cleanup([localPath])
    return { status: 'delivered', session: sessionId, text }
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
    const text = drafts.get(sessionId) ?? ''
    const target = awaiting.get(sessionId)
    awaiting.delete(sessionId)
    drafts.delete(sessionId)
    if (!target) return
    if (target.node) active.delete(target.node)
    const { speak } = splitReply(text)
    if (!speak.trim()) return
    try {
      await speakAnswer({ sessionId, text: speak, node: target.node })
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
  async function speakAnswer ({ sessionId, text, node }) {
    let audioPath = null
    if (textToSpeech?.resolve && textToSpeech?.synthesize) {
      try {
        const spec = textToSpeech.resolve({ text, format: 'wav' })
        const speech = await textToSpeech.synthesize(spec, new AbortController().signal)
        audioPath = join(cacheDir, `say-${Date.now()}.wav`)
        writeFileSync(audioPath, speech.audio)
        log.info?.('[dsh-voice] synthesized', { session: sessionId, seconds: speech.seconds })
      } catch (error) {
        // The device can still speak the text; a missing model must not silence the answer.
        log.warn?.('[dsh-voice] synthesis failed, speaking with the device engine:', error?.message ?? error)
      }
    }
    await say(node, text)
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
