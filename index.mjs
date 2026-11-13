// dsh-voice: the service half of a spoken turn.
//
// Two things live here, and neither of them synthesizes or sends anything:
//
// 1. an input marker. A channel that received speech writes its transcript as a
//    `--- # voice` block into the prompt text (the prompt RPC cannot carry a
//    message source), or — when the message is assembled in-process, as the
//    Android node does — sets `source.voice = true`. `agent/pre-step` is the one
//    point where the claimed messages are known and nothing is committed yet:
//    the service block is lifted out of the text there and recorded as its own
//    plugin-sourced context message beside the user's words.
// 2. the reply contract: a prompt section that says how a spoken answer is
//    written and what it may not contain.
//
// What the answer is later done with — synthesized, attached, played — belongs
// to the layer above, which reads the same markup through `splitReply`.
import { randomUUID } from 'node:crypto'

import { join } from 'node:path'

import { readVoiceMarkup } from './markup.mjs'
import { createVoiceLoop } from './loop.mjs'

export const name = 'dsh-voice'

/** Source plugin name recorded on every message this plugin adds. */
const PLUGIN = 'dsh-voice'

/** Prompt section that carries the reply contract. */
const REPLY_CONTRACT = `## Голосовые ответы

Запрос может прийти голосом: тогда в контексте есть пометка «пришло голосом» либо сообщение помечено служебным блоком \`--- # voice\`. Такой ответ произносят вслух.

- \`--- # say\` — то, что прозвучит: одна–три фразы, до ~300 знаков, живой разговорной речью;
- \`--- # screen\` — всё, что нужно показать, а не сказать: детали, цифры, код, таблицы;
- в \`# say\` нельзя markdown, таблицы, блоки кода и ссылки; короткий список проговаривай словами («во-первых…», «во-вторых…»);
- не начинай с «Конечно» и не пересказывай вопрос;
- если \`# screen\` не нужен — не добавляй его;
- если запрос пришёл текстом, отвечай обычным текстом без этих блоков.`

/**
 * Build the context message that tells the model how this turn arrived.
 *
 * @param voice - `{options}` read from the marker, or `null` for the metadata path.
 * @returns one user-role message sourced to this plugin.
 */
export function voiceNotice (voice) {
  const device = voice?.options?.device
  const speed = voice?.options?.speed
  const facts = [
    device ? `устройство: ${device}` : null,
    speed ? `желаемый темп: ${speed}` : null,
  ].filter(Boolean).join(', ')
  const text = `Этот запрос пришёл голосом${facts ? ` (${facts})` : ''}. `
    + 'Ответ прозвучит вслух: начни с блока `--- # say` и держи его коротким, '
    + 'а всё, что нужно показать, а не сказать, положи в `--- # screen`.'
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: `plugin:${PLUGIN}`, form: 'notice', summary: 'Voice request' },
  }
}

/** The text of a message, joined from its text parts. */
function messageText (message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Replace the text parts of a message with one cleaned body, keeping every
 * non-text part (images, files) in place and in order.
 *
 * @param message - the original user message.
 * @param text - the user's own words, marker removed.
 * @returns a new message; the original is left untouched.
 */
function withCleanText (message, text) {
  const content = Array.isArray(message.content) ? message.content : []
  const attachments = content.filter((part) => part?.type !== 'text')
  const cleaned = text.trim() ? [{ type: 'text', text: text.trim() }, ...attachments] : attachments
  return { ...message, content: cleaned }
}

/**
 * Rewrite one step's messages: lift voice markers out of user messages and put
 * a notice in their place.
 *
 * Exported for tests and for a host that owns the step loop itself; the plugin
 * calls it from its `agent/pre-step` listener.
 *
 * @param messages - the messages about to enter the step.
 * @returns a new array when something changed, otherwise null.
 */
export function annotateVoiceMessages (messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const rewritten = []
  let changed = false
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || message.role !== 'user') {
      rewritten.push(message)
      continue
    }
    const marked = message.source?.voice === true
    const text = messageText(message)
    const read = marked ? { text, voice: { options: {} } } : readVoiceMarkup(text)
    if (!read.voice) {
      rewritten.push(message)
      continue
    }
    changed = true
    // The marker itself is never user text: it is lifted out, and the notice
    // says what the model would otherwise have had to infer from the wrapper.
    rewritten.push(withCleanText(message, read.text), voiceNotice(read.voice))
  }
  return changed ? rewritten : null
}

/**
 * Mount the plugin.
 *
 * @param ctx - owning Host context; `agent/pre-step` and `systemPrompt` are the
 *   only services this plugin needs.
 * @param options - `logger` for a rewrite that could not be trusted.
 * @returns a disposer, or undefined when the context cannot be listened to.
 */
export function install (ctx, { logger } = {}) {
  if (typeof ctx?.on !== 'function') return undefined
  const log = logger ?? ctx.logger?.('dsh-voice') ?? console

  const startContract = (promptCtx) => {
    if (typeof promptCtx?.systemPrompt?.context !== 'function') return null
    return promptCtx.systemPrompt.context({
      name: 'dsh-voice:reply-contract',
      order: 119,
      text: REPLY_CONTRACT,
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], startContract)
  else startContract(ctx)

  const listener = async (payload, next) => {
    const decision = await next()
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
    try {
      const rewritten = annotateVoiceMessages(decision.messages)
      return rewritten === null ? decision : { ...decision, messages: rewritten }
    } catch (error) {
      // A failed split must never cost the user their message: the marker then
      // stays inline, exactly as it would on a Host without this plugin.
      log.warn?.('[dsh-voice] unable to lift the voice marker:', error?.message ?? error)
      return decision
    }
  }
  return ctx.on('agent/pre-step', listener, { global: true })
}

/**
 * Read one service without declaring it in `inject`.
 *
 * `inject` is a hard promise: a plugin that names a service it cannot have does not load at
 * all. The voice loop needs four of them, and a Host may legitimately have none (no nodes,
 * no recognizer) — so they are read defensively and the loop degrades instead of refusing.
 */
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

/** Where recordings and rendered speech live on the host. */
function cacheDirectory (config) {
  if (typeof config?.cacheDir === 'string' && config.cacheDir.trim()) return config.cacheDir.trim()
  const home = process.env.DSH_HOME ?? '.dsh'
  return join(home, 'cache', 'voice')
}

/**
 * Start the loop and wire it to the events the node plugin emits.
 *
 * @param ctx - owning Host context.
 * @param config - `cacheDir`, `logger`.
 * @returns a disposer.
 */
export function installLoop (ctx, config = {}) {
  if (typeof ctx?.on !== 'function') return undefined
  const log = config.logger ?? (typeof ctx.logger === 'function' ? ctx.logger('dsh-voice') : console)
  const nodes = service(ctx, 'nodes')
  if (!nodes?.call) {
    log.warn?.('[dsh-voice] the nodes service is absent: the voice loop stays off')
    return undefined
  }
  let createUserMessage = null
  const loop = createVoiceLoop({
    nodes,
    speechToText: service(ctx, 'speechToText'),
    textToSpeech: service(ctx, 'textToSpeech'),
    sessions: service(ctx, 'sessions'),
    sessionController: service(ctx, 'sessionController'),
    cacheDir: cacheDirectory(config),
    log,
    on: (name, handler) => ctx.on(name, handler, { global: true }),
    // The message constructor lives in the LLM package, which a plugin may import lazily:
    // without it the loop still builds a correct message by hand.
    createUserMessage: (input) => {
      if (!createUserMessage) return null
      return createUserMessage(input)
    },
  })
  void (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') createUserMessage = mod.createUserMessage
    } catch {}
  })()

  const disposeWant = ctx.on('dsh-nodes/voice-want', (want) => {
    void loop.handle(want).catch((error) => {
      log.warn?.('[dsh-voice] voice exchange failed:', error?.message ?? error)
    })
  }, { global: true })

  ctx.effect(() => () => {
    try {
      disposeWant?.()
    } catch {}
    loop.dispose()
  })
  return loop
}

/**
 * Plugin entry point.
 * @param ctx - owning Host context.
 * @param config - `cacheDir` for recordings, `logger`.
 */
export function apply (ctx, config = {}) {
  install(ctx, config)
  installLoop(ctx, config)
}

export default Object.freeze({ name, apply, install })
