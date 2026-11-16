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
import { installReply } from './reply.mjs'
import { registerVoiceRoutes, voiceState } from './routes.mjs'
import { Config } from './settings.mjs'

export const name = 'dsh-voice'

/** The configuration schema the Loader validates and the Plugins page edits. */
export { Config }

/** Source plugin name recorded on every message this plugin adds. */
const PLUGIN = 'dsh-voice'

/** Prompt section that carries the reply contract. */
const REPLY_CONTRACT = `## Голосовые ответы

Запрос может прийти голосом: тогда в контексте есть пометка «пришло голосом» либо сообщение помечено служебным блоком \`--- # voice\`. Такой ответ произносят вслух.

- \`--- # say\` — то, что прозвучит: одна–три фразы, до ~300 знаков, живой разговорной речью;
- \`--- # screen\` — всё, что нужно показать, а не сказать: детали, цифры, код, таблицы;
- в \`# say\` нельзя markdown, таблицы, блоки кода и ссылки; короткий список проговаривай словами («во-первых…», «во-вторых…»);
- не начинай с «Конечно» и не пересказывай вопрос;
- \`# screen\` — это текст для чтения человеком, а не вывод команды: перескажи результат словами и цифрами, не вставляй блоки кода, тройные кавычки и сырые таблицы терминала;
- \`# say\` — законченный ответ словами, как в разговоре;
- если \`# screen\` не нужен — не добавляй его;
- если запрос пришёл текстом, отвечай обычным текстом без этих блоков;
- минимизируй обращения к инструментам: в разговоре голосом каждый вызов — это пауза, поэтому обходись без инструмента, если можешь ответить тем, что уже знаешь, и не проверяй одно и то же дважды.`

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
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], startContract)
    } catch (error) {
      // The contract is the smaller half of this plugin: a Host whose prompt service cannot be
      // declared here must still get the marker lifted and the voice loop running.
      log.warn?.('[dsh-voice] the reply contract was not registered:', error?.message ?? error)
      try {
        startContract(ctx)
      } catch {}
    }
  } else startContract(ctx)

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
 * The nodes plugin may register its service after this one loads: cordis announces every
 * registration on `internal/service`, so a missing service is a reason to wait, not to give up.
 * Without this the loop stayed off on every boot where the profile order put voice before nodes.
 *
 * Only `nodes` is waited for. Everything else is read lazily by the loop (`serviceFor`): a Host
 * may legitimately have no synthesizer — `synth=device` is the default — and refusing to start
 * over an optional service left the chat dead where a device voice was all that was needed. A
 * missing recognizer is the opposite case, and the loop says it to the person instead of going
 * quiet when a press arrives.
 *
 * @param ctx - owning Host context.
 * @param config - `cacheDir`, `logger`, `language`, `minSeconds`, `runId`.
 * @returns a disposer.
 */
export function installLoop (ctx, config = {}) {
  if (typeof ctx?.on !== 'function') return undefined
  const log = config.logger ?? (typeof ctx.logger === 'function' ? ctx.logger('dsh-voice') : console)
  const noNodes = () => !service(ctx, 'nodes')?.call
  if (noNodes()) {
    log.info?.('[dsh-voice] waiting for services: nodes')
    let disposeWait = null
    disposeWait = ctx.on('internal/service', () => {
      if (noNodes()) return
      try {
        disposeWait?.()
      } catch {}
      startLoop(ctx, { ...config, logger: log })
    }, { global: true })
    return undefined
  }
  return startLoop(ctx, { ...config, logger: log, nodes: service(ctx, 'nodes') })
}

/**
 * Build and wire the loop once its services are known to exist.
 *
 * @param ctx - owning Host context.
 * @param config - `cacheDir`, `logger`, and the resolved `nodes` service.
 * @returns the loop, or undefined when the host cannot listen to nodes.
 */
function startLoop (ctx, config) {
  const log = config.logger
  const nodes = config.nodes ?? service(ctx, 'nodes')
  if (!nodes?.call) return undefined
  if (!service(ctx, 'speechToText')) {
    // Nothing can be transcribed without it, so every press will be answered with an apology
    // (`reason=no-stt` in the closing line). The warning is what makes the reason readable later.
    log.warn?.('[dsh-voice] speech recognition is not installed: a press will be answered with an apology')
  }
  if (!service(ctx, 'textToSpeech')) {
    log.info?.('[dsh-voice] no synthesizer: synth=host answers with the device voice and degraded')
  }
  let createUserMessage = null
  const loop = createVoiceLoop({
    nodes,
    // Read at the moment they are needed: a provider may register after this plugin, and an
    // absent synthesizer is a degradation, not a reason to have no loop at all.
    serviceFor: (name) => service(ctx, name),
    // Optional: names the assistant on the device screen. Absent on a Host without it.
    assistants: service(ctx, 'assistants'),
    sessions: service(ctx, 'sessions'),
    sessionController: service(ctx, 'sessionController'),
    cacheDir: cacheDirectory(config),
    log,
    // Named, not inherited from the host default: `auto` lets a short noisy take drift into
    // another language, and the transcript then reaches the session as the person's own words.
    language: typeof config.language === 'string' && config.language.trim() ? config.language.trim() : 'ru',
    ...typeof config.minSeconds === 'number' && config.minSeconds > 0 ? { minSeconds: config.minSeconds } : {},
    // The directory this process owns inside the cache. Normally left out and made fresh at every
    // boot; a host that wants a stable name can say so, and the value is made safe as a segment.
    ...typeof config.runId === 'string' && config.runId.trim() ? { runId: config.runId.trim() } : {},
    on: (name, handler) => ctx.on(name, handler, { global: true }),
    // The loop announces the binding of a fresh session before creating it, the
    // way a messenger does, so dsh-assistants knows the transport and the device.
    emit: (name, payload) => ctx.emit(name, payload),
    // The message constructor lives in the LLM package, which a plugin may import lazily:
    // without it the loop still builds a correct message by hand.
    createUserMessage: (input) => {
      if (!createUserMessage) return null
      return createUserMessage(input)
    },
  })
  // One line so a boot can be read afterwards: without it "no log" meant both "the loop is up"
  // and "the loop never started", and telling them apart cost a restart each time. The run id
  // names the directory this process owns under the cache, so a leftover on disk can be traced
  // to the boot that wrote it.
  log.info?.('[dsh-voice] the voice loop is up', {
    run: loop.runId,
    speechToText: Boolean(service(ctx, 'speechToText')),
    textToSpeech: Boolean(service(ctx, 'textToSpeech')),
    sessions: Boolean(service(ctx, 'sessions')),
  })
  void (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') createUserMessage = mod.createUserMessage
    } catch {}
  })()

  // The old path: the device asks the host to record for it. Kept while the clients
  // migrate — the phone cannot be updated in the same minute as the server.
  const disposeWant = ctx.on('dsh-nodes/voice-want', (want) => {
    void loop.handle(want).catch((error) => {
      log.warn?.('[dsh-voice] voice exchange failed:', error?.message ?? error)
    })
  }, { global: true })

  // The new path: the device pushed the recording itself, so the file is already on disk.
  const disposeVoice = ctx.on('dsh-nodes/voice', (event) => {
    void loop.handleUpload(event).catch((error) => {
      log.warn?.('[dsh-voice] uploaded recording failed:', error?.message ?? error)
    })
  }, { global: true })

  // The voice screen opened: warm the model up, quietly.
  const disposeWarmup = ctx.on('dsh-nodes/voice-warmup', (event) => {
    void loop.handleWarmup(event).catch((error) => {
      log.warn?.('[dsh-voice] warmup failed:', error?.message ?? error)
    })
  }, { global: true })

  // A report about the app: delivered as a fact, never spoken.
  const disposeBugReport = ctx.on('dsh-nodes/bug-report', (report) => {
    void loop.handleBugReport(report).catch((error) => {
      log.warn?.('[dsh-voice] bug report failed:', error?.message ?? error)
    })
  }, { global: true })

  // "New session": forget which conversation this device was in. The next input creates a fresh
  // one; a running exchange is left to finish, because its words are already spoken.
  const disposeNewSession = ctx.on('dsh-nodes/voice-new-session', (event) => {
    try {
      loop.handleNewSession(event)
    } catch (error) {
      log.warn?.('[dsh-voice] the reset failed:', error?.message ?? error)
    }
  }, { global: true })

  ctx.effect(() => () => {
    try {
      disposeWant?.()
    } catch {}
    try {
      disposeVoice?.()
    } catch {}
    try {
      disposeNewSession?.()
    } catch {}
    try {
      disposeBugReport?.()
    } catch {}
    try {
      disposeWarmup?.()
    } catch {}
    loop.dispose()
  })
  return loop
}

/**
 * Mount the spoken reply: the closing-turn hook and its prompt section.
 *
 * Installed whether or not the switch is on: both read the configuration through
 * the reference the Loader keeps live, so the switch works from the Plugins page
 * without a restart. With it off the hook answers `off` and the prompt section
 * contributes nothing.
 *
 * @param ctx - owning Host context.
 * @param config - the plugin configuration.
 * @returns a disposer, or undefined when the context cannot be listened to.
 */
export function installVoiceReply (ctx, config = {}) {
  return installReply(ctx, {
    config,
    logger: config?.logger ?? null,
    service: config?.service ?? null,
    deps: config?.deps ?? {},
  })
}

/**
 * Mount the settings card's state route.
 *
 * The route answers one question — is there a synthesizer here — and it is
 * mounted whether or not the switch is on, because the card has to read the
 * answer before it can decide whether the switch may be pressed at all.
 *
 * @param ctx - owning Host context.
 * @returns the child fibre's disposal handle, or undefined when this Host has no
 *   `connection` service to mount a route on.
 */
export function installVoiceRoutes (ctx) {
  if (typeof ctx?.inject !== 'function') return undefined
  try {
    return ctx.inject(['connection'], (child) => {
      const connection = child?.connection ?? service(ctx, 'connection')
      const disposers = registerVoiceRoutes(connection, () => voiceState({ textToSpeech: service(ctx, 'textToSpeech') }))
      const dispose = () => {
        for (const one of disposers) {
          try {
            one?.()
          } catch {}
        }
      }
      if (typeof child?.effect === 'function') return child.effect(() => dispose, 'dsh-voice: state route')
      return undefined
    })
  } catch (error) {
    // A Host without the seam simply has no card route; the rest of the plugin
    // works exactly as before.
    return undefined
  }
}

/**
 * Tell the settings service that this plugin ships its own page.
 *
 * Settings renders a form from the schema for every entry that does not say
 * otherwise; ours is drawn by the client half, with the switch's own reason for
 * being inactive, so the automatic page would be a second, poorer copy of it.
 * The call belongs to an optional child: a Host without the settings service
 * must be able to speak all the same.
 *
 * @param ctx - owning Host context.
 * @returns the child fibre's disposal handle, or undefined when there is no
 *   settings service to tell.
 */
export function installSettingsPolicy (ctx) {
  if (typeof ctx?.inject !== 'function') return undefined
  try {
    return ctx.inject(['settings'], (child) => {
      if (typeof child?.settings?.configure !== 'function') return undefined
      const run = () => child.settings.configure({ auto: false }, ctx.fiber)
      if (typeof child.effect === 'function') return child.effect(run, 'dsh-voice: own settings page')
      return run()
    })
  } catch (error) {
    // A Host whose settings service cannot be declared here keeps its schema
    // page; this plugin still works.
    return undefined
  }
}

/**
 * Plugin entry point.
 * @param ctx - owning Host context.
 * @param config - `cacheDir` for the cache, `logger`, `language`, `speakReplies`,
 *   `maxChars`.
 */
export function apply (ctx, config = {}) {
  install(ctx, config)
  installLoop(ctx, config)
  installVoiceReply(ctx, config)
  installVoiceRoutes(ctx)
  installSettingsPolicy(ctx)
}

// The Loader reads the schema off the entry point and the settings service
// projects its volatile fields into the Plugins page.
apply.Config = Config

export default Object.freeze({ name, apply, install, Config })
