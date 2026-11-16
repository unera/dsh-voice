// The closing-turn hook end to end: one answer in, one delivery record out.
//
// The decision is the answer's own structure, so every test below is one shape of
// answer. Two things are asserted everywhere: what reached the synthesizer, and
// that the answer text the person reads is byte for byte the text the model wrote
// — markers included.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CALL_ID_PREFIX, PRESENTED_EVENT, installReply } from '../reply.mjs'
import { apply, installVoiceReply } from '../index.mjs'
import { Config, normalizeReplySettings } from '../settings.mjs'
import { DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT } from '../structure.mjs'
import {
  assistantMessage,
  fakeLogger,
  fakeSession,
  hangingService,
  stubHost,
  stubService,
  turnStart,
  userMessage,
  voiceDocument,
} from './helpers.mjs'

async function cacheDir (t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voice-reply-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** One closing turn: a question in, one answer text out. */
function closingTurn (answer, { turn = 9 } = {}) {
  return [turnStart(turn), userMessage('посчитай курсы'), assistantMessage(answer, { turn })]
}

const listenerOf = (host) => host.listeners.find((entry) => entry.event === 'agent/turn-stopping')

/**
 * Run one closing turn. The configuration object stays by reference, so a test can
 * flip the switch after mounting and see the next turn obey it — which is what the
 * Plugins page does through `loader/volatile-update`.
 */
async function runTurn ({ answer, cacheDir: directory, config = {}, service = stubService(), logger = fakeLogger(), events }) {
  const session = fakeSession({ events: events ?? closingTurn(answer) })
  const host = stubHost({ services: {}, logger })
  const live = { speakReplies: true, ...config }
  installReply(host, { config: live, logger, service, deps: {} })
  const outcome = await listenerOf(host).listener({ agent: { session }, turn: 9 })
  return { outcome, session, host, logger, service, config: live }
}

/** The text of the answer as it sits in the Session log, unchanged by anyone. */
const answerInLog = (session) => session.snapshotEvents()[2].data.message.content[0].text

test('install registers one global turn-stopping listener', () => {
  const host = stubHost()
  installReply(host, { config: { speakReplies: true } })
  assert.equal(host.listeners.length, 1)
  const entry = listenerOf(host)
  assert.deepEqual(entry.options, { global: true })
  assert.equal(typeof entry.listener, 'function')
})

test('a documented answer produces an OGG declared on the closing turn', async (t) => {
  const directory = await cacheDir(t)
  const spoken = 'Курс вырос на два процента.'
  const rest = 'Закрытие 98,4.'
  const { outcome, session, logger, service } = await runTurn({ answer: voiceDocument(spoken, rest), cacheDir: directory })

  assert.equal(outcome.delivered, true)
  assert.equal(outcome.reason, 'document')
  assert.equal(outcome.chars, spoken.length)
  assert.equal(outcome.limit, DEFAULT_MAX_CHARS)
  // The synthesizer got the first part and only it: no markers, no second part.
  assert.equal(service.calls.resolve.length, 1)
  assert.equal(service.calls.resolve[0].text, spoken)
  assert.equal(service.calls.resolve[0].format, 'wav')
  assert.equal(service.calls.resolve[0].text.includes(rest), false)

  const [event] = session.appended
  assert.equal(event.type, PRESENTED_EVENT)
  assert.equal(event.data.turn, 9)
  assert.equal(typeof event.data.callId, 'string')
  assert.equal(event.data.callId.startsWith(CALL_ID_PREFIX), true)
  assert.equal(event.data.files.length, 1)
  assert.notEqual(event.data.files[0].description.trim(), '')
  assert.equal(event.data.files[0].path.endsWith('.ogg'), true)
  assert.equal(outcome.handoff, null, 'the diagnostic is off by default')

  const bytes = await readFile(event.data.files[0].path)
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'OggS')

  const logged = logger.entries.info.find(([text]) => /озвучен/u.test(text))
  assert.ok(logged, 'a delivered reply is logged')
  assert.equal(logged[1].chars, spoken.length)
})

test('the answer text is never changed: markers stay, bytes match', async (t) => {
  const directory = await cacheDir(t)
  const answer = voiceDocument('Коротко о главном.', 'Детали: порт 8080.')
  const before = Buffer.from(answer, 'utf8')
  const { session } = await runTurn({ answer, cacheDir: directory })

  assert.deepEqual(Buffer.from(answerInLog(session), 'utf8'), before, 'the answer is byte for byte the original')
  assert.deepEqual(
    session.snapshotEvents().map((event) => event.type),
    ['turn/start', 'user/message', 'assistant/message', PRESENTED_EVENT],
    'the plugin only adds a delivery record',
  )
})

test('with the switch off nothing happens at all', async (t) => {
  const directory = await cacheDir(t)
  const answer = voiceDocument('Готово.')
  const { outcome, session, service, logger } = await runTurn({
    answer, cacheDir: directory, config: { speakReplies: false },
  })

  assert.deepEqual([outcome.delivered, outcome.reason], [false, 'off'])
  assert.equal(service.calls.resolve.length, 0, 'the synthesizer is not even asked')
  assert.equal(session.appended.length, 0)
  assert.equal(answerInLog(session), answer)
  assert.equal(logger.entries.info.length, 0)
})

test('the switch is read per turn, so the Plugins page needs no restart', async (t) => {
  const directory = await cacheDir(t)
  const { session, host, config } = await runTurn({
    answer: voiceDocument('Готово.'), cacheDir: directory, config: { speakReplies: false },
  })
  const listener = listenerOf(host).listener
  assert.deepEqual(await listener({ agent: { session }, turn: 9 }), { delivered: false, reason: 'off' })

  // What the settings service does to the configuration reference it keeps live.
  config.speakReplies = true
  const second = await listener({ agent: { session }, turn: 9 })
  assert.equal(second.delivered, true)
})

test('the prompt section follows the switch and the limit', async (t) => {
  const host = stubHost()
  installReply(host, { config: { speakReplies: false, maxChars: 120 } })
  const section = host.sections.find((entry) => entry.name === 'dsh-voice:spoken-reply-contract')
  assert.ok(section, 'the section is registered even while the switch is off')
  assert.equal(section.order, 118)
  assert.equal(section.text(), '', 'off means the model is told nothing')

  const live = stubHost()
  const config = { speakReplies: true, maxChars: 120 }
  installReply(live, { config })
  const text = live.sections[0].text()
  assert.match(text, /^---$/mu)
  assert.match(text, /^\.\.\.$/mu)
  assert.match(text, /120/u)
  assert.match(text, /как есть/u)

  config.speakReplies = false
  assert.equal(live.sections[0].text(), '')
})

test('an answer without markers is passed through with no sound at all', async (t) => {
  const directory = await cacheDir(t)
  const answer = 'Готово, всё поднялось.\n\n---\n\nПорт 8080.'
  const { outcome, session, service, logger } = await runTurn({ answer, cacheDir: directory })

  assert.deepEqual([outcome.delivered, outcome.reason, outcome.asIs], [false, 'not-a-document', true])
  assert.equal(service.calls.resolve.length, 0, 'the synthesizer is not even asked')
  assert.equal(service.calls.synthesize.length, 0)
  assert.equal(session.appended.length, 0)
  assert.deepEqual(Buffer.from(answerInLog(session), 'utf8'), Buffer.from(answer, 'utf8'))
  const skipped = logger.entries.debug.find(([text]) => /как есть/u.test(text))
  assert.equal(skipped[1].reason, 'not-a-document')
})

test('one marker instead of two is passed through as it is', async (t) => {
  const directory = await cacheDir(t)
  const answer = '---\nГотово, всё поднялось.\nПорт 8080.\n...'
  const { outcome, session, service } = await runTurn({ answer, cacheDir: directory })

  assert.deepEqual([outcome.delivered, outcome.reason, outcome.asIs], [false, 'one-marker', true])
  assert.equal(service.calls.resolve.length, 0)
  assert.equal(session.appended.length, 0)
  assert.equal(answerInLog(session), answer)
})

test('a missing closing marker is passed through as it is', async (t) => {
  const directory = await cacheDir(t)
  const answer = '---\nГотово, всё поднялось.\n---\nПорт 8080.'
  const { outcome, session, service } = await runTurn({ answer, cacheDir: directory })

  assert.deepEqual([outcome.delivered, outcome.reason, outcome.asIs], [false, 'no-end-marker', true])
  assert.equal(service.calls.resolve.length, 0)
  assert.equal(session.appended.length, 0)
  assert.equal(answerInLog(session), answer)
})

test('an empty first part is passed through as it is', async (t) => {
  const directory = await cacheDir(t)
  const answer = '---\n\n   \n---\nПорт 8080.\n...'
  const { outcome, session, service } = await runTurn({ answer, cacheDir: directory })

  assert.deepEqual([outcome.delivered, outcome.reason, outcome.asIs], [false, 'empty-spoken', true])
  assert.equal(service.calls.resolve.length, 0)
  assert.equal(session.appended.length, 0)
  assert.equal(answerInLog(session), answer)
})

test('the limit is the configured X: exactly X speaks, X+1 does not', async (t) => {
  const directory = await cacheDir(t)
  const limit = 40
  const fits = 'а'.repeat(limit)
  const overflows = 'а'.repeat(limit + 1)

  const good = await runTurn({ answer: voiceDocument(fits), cacheDir: directory, config: { maxChars: limit } })
  assert.equal(good.outcome.delivered, true)
  assert.equal(good.outcome.chars, limit)
  assert.equal(good.outcome.limit, limit)

  const bad = await runTurn({ answer: voiceDocument(overflows), cacheDir: directory, config: { maxChars: limit } })
  assert.deepEqual([bad.outcome.delivered, bad.outcome.reason, bad.outcome.asIs], [false, 'too-long', true])
  assert.equal(bad.outcome.chars, limit + 1)
  assert.equal(bad.service.calls.resolve.length, 0)
  assert.equal(bad.session.appended.length, 0)
  assert.equal(answerInLog(bad.session), voiceDocument(overflows))
})

test('Cyrillic is counted in characters, not bytes: 600 speaks, 601 does not', async (t) => {
  const directory = await cacheDir(t)
  const fits = 'я'.repeat(DEFAULT_MAX_CHARS)
  const overflows = 'я'.repeat(DEFAULT_MAX_CHARS + 1)
  assert.equal(Buffer.byteLength(fits, 'utf8'), 1200, 'the text that must pass is 1200 bytes')

  const good = await runTurn({ answer: voiceDocument(fits), cacheDir: directory })
  assert.equal(good.outcome.delivered, true)
  assert.equal(good.outcome.chars, 600)
  assert.equal(good.service.calls.resolve[0].text, fits)

  const bad = await runTurn({ answer: voiceDocument(overflows), cacheDir: directory })
  assert.deepEqual([bad.outcome.delivered, bad.outcome.reason], [false, 'too-long'])
  assert.equal(bad.outcome.chars, 601)
  assert.equal(bad.service.calls.resolve.length, 0)
})

test('the limit set in the configuration is the one applied', async (t) => {
  const directory = await cacheDir(t)
  const good = await runTurn({ answer: voiceDocument('ок!'), cacheDir: directory, config: { maxChars: 3 } })
  assert.equal(good.outcome.delivered, true)
  assert.equal(good.outcome.chars, 3)

  const bad = await runTurn({ answer: voiceDocument('ок!!'), cacheDir: directory, config: { maxChars: 3 } })
  assert.deepEqual([bad.outcome.delivered, bad.outcome.reason], [false, 'too-long'])
})

test('no synthesizer means no voice note, and no error either', async (t) => {
  const directory = await cacheDir(t)
  const session = fakeSession({ events: closingTurn(voiceDocument('Готово.')) })
  const host = stubHost({ logger: fakeLogger() })

  installReply(host, { config: { speakReplies: true }, service: null })
  const outcome = await listenerOf(host).listener({ agent: { session }, turn: 9 })

  assert.deepEqual([outcome.delivered, outcome.reason], [false, 'no-tts'])
  assert.equal(session.appended.length, 0)
  assert.equal(answerInLog(session), voiceDocument('Готово.'))
})

test('a synthesizer that throws costs the voice note and nothing else', async (t) => {
  const directory = await cacheDir(t)
  const answer = voiceDocument('Готово.')
  const service = {
    preferredSpeed: () => 1,
    resolve: () => ({ candidates: [{}] }),
    synthesize: async () => { throw new Error('нет ключа') },
  }
  const logger = fakeLogger()
  const { outcome, session } = await runTurn({ answer, cacheDir: directory, service, logger })

  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, 'error')
  assert.equal(outcome.message, 'нет ключа', 'the reason travels back with the outcome')
  assert.equal(session.appended.length, 0)
  assert.equal(answerInLog(session), answer)
  assert.ok(logger.entries.warn.length > 0, 'the failure is logged')
  assert.match(String(logger.entries.warn[0][1].reason), /нет ключа/u)
})

test('a slow synthesizer is cut off by the timeout, and the answer still goes out', async (t) => {
  const directory = await cacheDir(t)
  const answer = voiceDocument('Отвечаю коротко.')
  const logger = fakeLogger()
  const started = Date.now()
  const { outcome, session } = await runTurn({
    answer, cacheDir: directory, service: hangingService(), logger, config: { timeoutMs: 30 },
  })

  assert.ok(Date.now() - started < 2000, 'the hook returned instead of waiting for the engine')
  assert.deepEqual([outcome.delivered, outcome.reason], [false, 'voice-reply-timeout'])
  assert.equal(session.appended.length, 0)
  assert.equal(answerInLog(session), answer)
  assert.ok(logger.entries.warn.length > 0, 'the timeout is logged')
})

test('a second stop of the same turn does not speak twice', async (t) => {
  const directory = await cacheDir(t)
  const session = fakeSession({ events: closingTurn(voiceDocument('Готово.')) })
  const host = stubHost({ services: {}, logger: fakeLogger() })
  installReply(host, { config: { speakReplies: true }, service: stubService() })
  const listener = listenerOf(host).listener

  await listener({ agent: { session }, turn: 9 })
  const second = await listener({ agent: { session }, turn: 9 })

  assert.equal(session.appended.length, 1)
  assert.deepEqual([second.delivered, second.reason], [false, 'already-presented'])
})

test('a voice note the model attached itself wins over ours', async (t) => {
  const directory = await cacheDir(t)
  const events = closingTurn(voiceDocument('Готово.'))
  events.push({
    type: PRESENTED_EVENT,
    data: { turn: 9, callId: 'call_manual', files: [{ path: '/tmp/say.ogg', description: 'voice_say' }] },
  })
  const { outcome, session } = await runTurn({ answer: '', cacheDir: directory, events })

  assert.deepEqual([outcome.delivered, outcome.reason], [false, 'already-presented'])
  assert.equal(session.appended.length, 0, 'the plugin never rewrites what the model did')
})

test('a subagent session is left alone unless it is asked for', async (t) => {
  const directory = await cacheDir(t)
  const session = fakeSession({
    events: closingTurn(voiceDocument('Готово.')),
    header: { origin: 'subagent', delegationDepth: 1 },
  })
  const host = stubHost({ logger: fakeLogger() })
  installReply(host, { config: { speakReplies: true }, service: stubService() })
  const outcome = await listenerOf(host).listener({ agent: { session }, turn: 9 })
  assert.deepEqual([outcome.delivered, outcome.reason], [false, 'subagent'])
  assert.equal(session.appended.length, 0)

  const opting = stubHost({ logger: fakeLogger() })
  installReply(opting, { config: { speakReplies: true, subagents: true }, service: stubService() })
  const allowed = await listenerOf(opting).listener({
    agent: { session: fakeSession({ events: closingTurn(voiceDocument('Готово.')), header: { origin: 'subagent' } }) },
    turn: 9,
  })
  assert.equal(allowed.delivered, true)
})

test('a session that cannot take the event does not fail the turn', async (t) => {
  const directory = await cacheDir(t)
  const session = {
    header: {},
    snapshotEvents: () => closingTurn(voiceDocument('Готово.')),
    append () { throw new Error('сессия архивируется') },
  }
  const logger = fakeLogger()
  const host = stubHost({ logger })
  installReply(host, { config: { speakReplies: true }, logger, service: stubService(), deps: { } })
  const outcome = await listenerOf(host).listener({ agent: { session }, turn: 9 })

  assert.equal(outcome.delivered, false)
  assert.equal(logger.entries.warn.length, 1)
})

test('a payload without a session is ignored rather than thrown at', async () => {
  const host = stubHost({ logger: fakeLogger() })
  installReply(host, { config: { speakReplies: true }, logger: fakeLogger() })
  assert.deepEqual(await listenerOf(host).listener({ turn: 1 }), { delivered: false, reason: 'no-session' })
  assert.deepEqual(await listenerOf(host).listener(undefined), { delivered: false, reason: 'no-session' })
})

test('a turn that produced no text is silent', async (t) => {
  const directory = await cacheDir(t)
  const { outcome, service } = await runTurn({ answer: '', cacheDir: directory })

  assert.deepEqual([outcome.delivered, outcome.reason], [false, 'no-answer'])
  assert.equal(service.calls.resolve.length, 0)
})

test('a limit out of range is a configuration error, not a quiet clamp', () => {
  for (const value of [0, -1, 1.5, MAX_CHARS_LIMIT + 1, '600', Number.NaN, Infinity]) {
    assert.throws(() => normalizeReplySettings({ speakReplies: true, maxChars: value }), RangeError,
      `maxChars ${String(value)} is refused`)
    // The schema refuses it at mount, which is what a profile gets.
    assert.throws(() => Config({ maxChars: value }), undefined, `the schema refuses ${String(value)}`)
  }
  assert.equal(normalizeReplySettings({ maxChars: 1 }).maxChars, 1)
  assert.equal(normalizeReplySettings({ maxChars: MAX_CHARS_LIMIT }).maxChars, MAX_CHARS_LIMIT)
  assert.equal(normalizeReplySettings({}).maxChars, DEFAULT_MAX_CHARS)
  assert.equal(normalizeReplySettings({}).speakReplies, false, 'the switch is off by default')
})

test('the diagnostic is off unless the configuration asks for it', async (t) => {
  const directory = await cacheDir(t)
  // A probe seam that must not be touched: reaching it would be a bug.
  const probe = {
    dir: '/virtual',
    deps: { readdir: async () => { throw new Error('диагностика не должна запускаться') } },
  }
  const { outcome } = await runTurn({ answer: voiceDocument('Готово.'), cacheDir: directory, config: { deps: { probe } } })

  assert.equal(outcome.delivered, true)
  assert.equal(outcome.handoff, null)
})

test('the log says the channel took the record when the probe is on', async (t) => {
  const directory = await cacheDir(t)
  const bytes = Buffer.from('snapshot-bytes')
  const probe = {
    dir: '/virtual',
    deps: {
      readdir: async (path) => (path === '/virtual' ? ['dsh-im-outbound-TEST'] : ['copy.artifact']),
      stat: async () => ({ isFile: () => true, size: bytes.length, mtimeMs: Date.now() }),
      readFile: async () => bytes,
    },
  }
  const logger = fakeLogger()
  const { outcome } = await runTurn({
    answer: voiceDocument('Готово.'), cacheDir: directory, logger, config: { diagnose: true, deps: { probe } },
  })

  assert.equal(outcome.handoff, 'taken')
  const logged = logger.entries.info.find(([text]) => /озвучен/u.test(text))
  assert.equal(logged[1].handoff, 'taken')
  assert.equal(logged[1].turn, 9)
  assert.equal(typeof logged[1].callId, 'string')
})

test('the plugin entry point mounts the reply hook, the card route and the loop', async (t) => {
  const directory = await cacheDir(t)
  const host = stubHost({ logger: fakeLogger() })
  apply(host, { cacheDir: directory })

  const events = host.listeners.map((entry) => entry.event)
  assert.ok(events.includes('agent/turn-stopping'), 'the spoken reply is wired')
  assert.ok(events.includes('agent/pre-step'), 'the input marker is still lifted')
  assert.ok(events.includes('internal/service'), 'the loop still waits for its services')
  assert.equal(host.routes.length, 1, 'the card can ask whether there is a synthesizer')

  // The switch is off in this configuration, so a closing turn does nothing.
  const session = fakeSession({ events: closingTurn(voiceDocument('Готово.')) })
  const outcome = await listenerOf(host).listener({ agent: { session }, turn: 9 })
  assert.deepEqual([outcome.delivered, outcome.reason], [false, 'off'])
})

test('the two fields the card edits are volatile, the rest is ordinary configuration', () => {
  assert.equal(Config.dict.speakReplies.meta.volatile, true)
  assert.equal(Config.dict.maxChars.meta.volatile, true)
  assert.equal(Config.dict.speakReplies.meta.default, false, 'the switch is off by default')
  assert.equal(Config.dict.maxChars.meta.default, DEFAULT_MAX_CHARS)
  // Ordinary configuration stays in the profile: it is not offered as a live field.
  for (const field of ['cacheDir', 'language', 'subagents', 'diagnose', 'prompt']) {
    assert.ok(Config.dict[field], `${field} is declared, or the Loader would reject it`)
    assert.equal(Config.dict[field].meta.volatile, undefined, `${field} is not a live field`)
  }
})

test('a bad limit stops the mount instead of surfacing on the first answer', () => {
  const host = stubHost()
  assert.throws(() => installReply(host, { config: { speakReplies: true, maxChars: 0 } }), RangeError)
  assert.equal(host.listeners.length, 0, 'nothing is mounted')
  assert.equal(host.sections.length, 0)
})

test('the configured cache moves the reply directory with it', () => {
  assert.equal(normalizeReplySettings({ cacheDir: '/tmp/voice' }).cacheDir, '/tmp/voice/reply')
  assert.ok(normalizeReplySettings({}).cacheDir.endsWith('/cache/voice/reply'))
})

test('the plugin tells the settings service it ships its own page', () => {
  const host = stubHost({ logger: fakeLogger() })
  apply(host, {})
  assert.equal(host.settingsCalls.length, 1)
  assert.deepEqual(host.settingsCalls[0].presentation, { auto: false })
  assert.equal(host.settingsCalls[0].owner, host.fiber, 'the policy belongs to this plugin instance')
})

test('a host without a settings service still speaks', async () => {
  const host = stubHost({ logger: fakeLogger() })
  delete host.inject
  assert.doesNotThrow(() => installVoiceReply(host, { speakReplies: true }))
  assert.ok(listenerOf(host), 'the hook is mounted all the same')
})

test('a volatile field with no saved value mounts instead of failing', () => {
  // The settings service answers `{}` for a volatile field nobody has set yet.
  // Treating that as a bad number stopped dsh-voice from mounting at all.
  const settings = normalizeReplySettings({ speakReplies: false, maxChars: {} })
  assert.equal(settings.maxChars, 600)
  assert.equal(settings.speakReplies, false)
  // A schema placeholder is not a plain object either, so anything that is not a
  // number reads as unset; only a real number outside the range is an error.
  assert.equal(normalizeReplySettings({ maxChars: new Map() }).maxChars, 600)
  assert.throws(() => normalizeReplySettings({ maxChars: 0 }), /целым числом/u)
  assert.throws(() => normalizeReplySettings({ maxChars: 6000 }), /целым числом/u)
  assert.throws(() => normalizeReplySettings({ maxChars: 2.5 }), /целым числом/u)
})
