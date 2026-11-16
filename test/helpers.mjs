// Shared stand-ins for a Host, a Session and a synthesizer.
//
// No test in this package talks to a real Host, a real engine or the network: the
// synthesizer answers with a silent WAV built here, and only `ffmpeg` is real,
// because "the file is an OGG a channel will call a voice note" is not something a
// fake can prove.
import { Buffer } from 'node:buffer'

/** One second of 16-bit mono PCM silence, wrapped in a RIFF/WAVE header. */
export function silentWav (seconds = 0.2, rate = 16_000) {
  const samples = Math.max(1, Math.round(seconds * rate))
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * The `textToSpeech` service as this plugin uses it: `resolve` names the
 * candidates, `synthesize` returns audio. Both are spies so a test can see what
 * was asked for.
 */
export function stubService ({ seconds = 0.4, voice = 'test-voice', preferredSpeed = 1, audio } = {}) {
  const calls = { resolve: [], synthesize: [] }
  return {
    calls,
    preferredSpeed: () => preferredSpeed,
    resolve (request) {
      calls.resolve.push(request)
      return { text: request.text, candidates: [{ id: 'stub' }] }
    },
    async synthesize (plan, signal) {
      calls.synthesize.push({ plan, signal })
      signal?.throwIfAborted()
      return { audio: audio ?? silentWav(Math.min(seconds, 0.3)), seconds, voice, format: 'wav' }
    },
  }
}

/** A synthesizer that never answers, so the timeout is the only way out. */
export function hangingService () {
  const calls = { resolve: [], synthesize: [] }
  return {
    calls,
    preferredSpeed: () => 1,
    resolve (request) {
      calls.resolve.push(request)
      return { text: request.text, candidates: [{ id: 'hang' }] }
    },
    synthesize () {
      calls.synthesize.push({})
      return new Promise(() => {})
    },
  }
}

/**
 * A Session stand-in: the durable log and nothing else.
 *
 * `append` writes into the same array `snapshotEvents()` reads, which is how the
 * real thing behaves and how the idempotency test can see its own earlier work.
 */
export function fakeSession ({ events = [], header = {} } = {}) {
  const log = [...events]
  const appended = []
  return {
    header: { id: 'session-test', cwd: '/tmp', isSeeded: false, ...header },
    appended,
    snapshotEvents: () => log,
    append (type, data) {
      if (typeof type !== 'string' || !type) throw new Error('append requires a type')
      const event = { type, seq: log.length, time: Date.now(), data }
      log.push(event)
      appended.push(event)
      return event
    },
    push (event) {
      log.push(event)
    },
  }
}

/** A logger that keeps every call, so a test can read the reason that was logged. */
export function fakeLogger () {
  const entries = { info: [], warn: [], debug: [], error: [] }
  const record = (level) => (...args) => { entries[level].push(args) }
  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    debug: record('debug'),
    error: record('error'),
  }
}

/**
 * A Host stand-in: listener registry, prompt sections, services, a connection
 * that accepts routes, and a logger. Deliberately as small as the plugin's needs —
 * anything more would be a fake that tests itself.
 */
export function stubHost ({ services = {}, logger = fakeLogger() } = {}) {
  const listeners = []
  const sections = []
  const injected = []
  const routes = []
  const settingsCalls = []
  const fiber = { id: 'fiber-test' }
  const connection = {
    fetch: {
      register (route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
  return {
    listeners,
    sections,
    injected,
    routes,
    connection,
    settingsCalls,
    fiber,
    logger,
    on (event, listener, options) {
      const entry = { event, listener, options }
      listeners.push(entry)
      return () => {
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect (run) {
      const dispose = run()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    inject (deps, callback) {
      injected.push(deps)
      const child = {
        systemPrompt: { context: (section) => { sections.push(section); return () => {} } },
        connection: deps.includes('connection') ? connection : undefined,
        settings: deps.includes('settings')
          ? {
              configure (presentation, owner) {
                settingsCalls.push({ presentation, owner })
                return () => {}
              },
            }
          : undefined,
        effect (run) { return run() },
      }
      return callback(child)
    },
    get (serviceName) {
      if (serviceName === 'connection') return connection
      return services[serviceName] ?? undefined
    },
    logger: () => logger,
  }
}

/** One `user/message` event. */
export function userMessage (text, source = { kind: 'user' }) {
  return {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], ...source ? { source } : {} },
  }
}

/** One `assistant/message` event for the given turn and step. */
export function assistantMessage (text, { turn = 1, step = 0, parts } = {}) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        content: parts ?? (text ? [{ type: 'text', text }] : []),
      },
    },
  }
}

/** A turn boundary. */
export const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })

/**
 * An answer written in the spoken protocol: the first part is what a listener
 * hears, everything below the second `---` is read as text.
 */
export function voiceDocument (spoken, rest = 'Детали ниже.') {
  return `---\n${spoken}\n---\n${rest}\n...`
}
