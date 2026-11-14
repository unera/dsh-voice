import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { assistantTextOf, createVoiceLoop } from '../loop.mjs'

/** A short WAV with real silence in it: ffmpeg has to be able to encode it. */
function wavBytes (seconds = 0.2, sampleRate = 16000) {
  const frames = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(frames * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Record every call, answer with a table of canned outcomes. */
function stubNodes (answers = {}) {
  const calls = []
  return {
    calls,
    async call (node, api, method, data, options) {
      calls.push({ node, api, method, data, options })
      const key = `${api}.${method}`
      const answer = answers[key]
      const value = typeof answer === 'function' ? answer({ node, api, method, data }) : answer
      return value ?? { status: 'ok', payload: null, results: null }
    },
  }
}

function makeLoop (overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-loop-'))
  const loops = []
  const delivered = []
  const loop = createVoiceLoop({
    nodes: overrides.nodes ?? stubNodes(),
    speechToText: overrides.speechToText ?? null,
    textToSpeech: overrides.textToSpeech ?? null,
    sessions: { flush: async () => {} },
    sessionController: overrides.sessionController ?? {
      resolveAgent: async (id) => ({ agent: { followup: (message) => delivered.push(message) } }),
      create: async () => ({ sessionId: 'session-new' }),
    },
    cacheDir: join(dir, 'voice'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    createUserMessage: overrides.createUserMessage,
  })
  loops.push({ loop, dir, delivered })
  return { loop, dir, delivered }
}

test('a successful exchange records, transcribes, delivers and speaks the spoken part', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-voice-src-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const take = join(work, 'take.wav')
  writeFileSync(take, wavBytes())

  const nodes = stubNodes({
    'voice.record': { status: 'ok', payload: { path: '/storage/emulated/0/DSH/voice/a.wav', seconds: 1.4 } },
    'files.copyFromDevice': async ({ data }) => {
      writeFileSync(data.hostPath, wavBytes())
      return { status: 'ok', payload: { sent: 44 } }
    },
    'shell.exec': { status: 'ok' },
    'voice.say': { status: 'ok' },
  })
  const { loop, delivered } = makeLoop({
    nodes,
    speechToText: {
      resolve: (request) => request,
      transcribe: async () => ({ text: 'включи свет в коридоре' }),
    },
  })

  const outcome = await loop.handle({ node: 19, nodeName: 'A059P', mode: 'ptt', sessionId: 'session-1' })
  assert.equal(outcome.status, 'delivered')
  assert.equal(outcome.session, 'session-1')

  const methods = nodes.calls.map((call) => `${call.api}.${call.method}`)
  assert.deepEqual(methods, ['voice.record', 'files.copyFromDevice', 'shell.exec', 'voice.chat'])
  assert.equal(nodes.calls[0].data.mode, 'ptt')
  assert.ok(nodes.calls[0].data.maxSeconds > 0)

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].role, 'user')
  assert.equal(delivered[0].source.voice, true)
  assert.equal(delivered[0].source.device, 'A059P')
  assert.match(delivered[0].content[0].text, /коридоре/)

  // The awaited answer: an assistant message, then the end of a completed turn.
  await loop.observeSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: 'session-1' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '--- # say\nСвет включил.\n--- # screen\nДатчик сработал.' }] } },
  })
  await loop.observeSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].node, 'A059P')
  assert.equal(answered[0].data.text, 'Датчик сработал.', 'the screen part is what the message shows')
  assert.equal(answered[0].data.say, true, 'the speech travels with the message, not as a command')
})

test('a silent take is answered out loud and never reaches a session', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-voice-src-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const take = join(work, 'take.wav')
  writeFileSync(take, wavBytes())

  const nodes = stubNodes({
    'voice.record': { status: 'ok', payload: { path: '/device/a.wav', seconds: 0.2 } },
    'files.copyFromDevice': async ({ data }) => {
      writeFileSync(data.hostPath, wavBytes())
      return { status: 'ok' }
    },
    'shell.exec': { status: 'ok' },
    'voice.say': { status: 'ok' },
  })
  const { loop, delivered } = makeLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: '   ' }) },
  })

  const outcome = await loop.handle({ node: 19, nodeName: 'A059P', mode: 'toggle' })
  assert.equal(outcome.status, 'empty')
  assert.equal(delivered.length, 0)
  const said = nodes.calls.filter((call) => call.method === 'say')
  assert.equal(said.length, 1)
  assert.match(said[0].data.text, /Не расслышал/)
})

test('a recording that times out says so instead of waiting forever', async () => {
  const nodes = stubNodes({
    'voice.record': { status: 'timeout', code: 'voice_timeout', message: 'запись не поступила' },
    'voice.say': { status: 'ok' },
  })
  const { loop, delivered } = makeLoop({ nodes })

  const outcome = await loop.handle({ node: 19, nodeName: 'A059P', mode: 'ptt' })
  assert.equal(outcome.status, 'no-recording')
  assert.equal(outcome.code, 'voice_timeout')
  assert.equal(delivered.length, 0)
  assert.equal(nodes.calls.filter((call) => call.method === 'say').length, 1)
})

test('a second press while one exchange runs is queued, never dropped', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const nodes = stubNodes({
    'voice.record': async () => {
      calls += 1
      if (calls === 1) await gate
      return { status: 'timeout', code: 'voice_timeout' }
    },
    'voice.say': { status: 'ok' },
  })
  const { loop } = makeLoop({ nodes })

  const first = loop.handle({ node: 19, nodeName: 'A059P', mode: 'ptt' })
  const second = loop.handle({ node: 19, nodeName: 'A059P', mode: 'ptt' })
  // The second press must not be refused: a dropped press is a lost take, and the
  // person then hears the previous answer only after speaking again.
  release()
  const [one, two] = await Promise.all([first, second])
  assert.equal(calls, 2, 'both presses reached the device')
  assert.notEqual(one.status, 'queued')
  assert.notEqual(two.status, 'queued')
})

test('a turn without a spoken part stays silent', async () => {
  const nodes = stubNodes({
    'voice.record': { status: 'ok', payload: { path: '/device/a.wav' } },
    'files.copyFromDevice': async ({ data }) => {
      writeFileSync(data.hostPath, wavBytes())
      return { status: 'ok' }
    },
    'shell.exec': { status: 'ok' },
    'voice.say': { status: 'ok' },
  })
  const { loop } = makeLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
  })
  await loop.handle({ node: 19, nodeName: 'A059P', mode: 'ptt', sessionId: 'session-1' })

  await loop.observeSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: 'session-1' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'bash' }] } },
  })
  await loop.observeSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })

  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 0)
  assert.equal(loop.awaiting.size, 0, 'the expectation is cleared even when nothing is said')
})

test('an assistant message is read only when it carries text and no tool call', () => {
  const text = assistantTextOf({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '  готово  ' }] } },
  })
  assert.equal(text.text, 'готово')
  assert.equal(assistantTextOf({ type: 'assistant/message', data: { message: { content: [] } } }), null)
  assert.equal(assistantTextOf({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'x' }, { type: 'tool-call' }] } },
  }), null)
  assert.equal(assistantTextOf({ type: 'tool/result' }), null)
})

test('nothing is left on disk after an exchange', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-voice-src-'))
  try {
    const take = join(work, 'take.wav')
    writeFileSync(take, wavBytes())
    const nodes = stubNodes({
      'voice.record': { status: 'ok', payload: { path: '/device/a.wav' } },
      'files.copyFromDevice': async ({ data }) => {
        writeFileSync(data.hostPath, wavBytes())
        return { status: 'ok' }
      },
      'shell.exec': { status: 'ok' },
      'voice.say': { status: 'ok' },
    })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-cache-'))
    try {
      const loop = createVoiceLoop({
        nodes,
        speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'раз' }) },
        sessions: { flush: async () => {} },
        sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-upload' }),
    },
        cacheDir: dir,
        log: { info: () => {}, warn: () => {}, debug: () => {} },
      })
      await loop.handle({ node: 19, nodeName: 'A059P', mode: 'ptt', sessionId: 's-1' })
      // copyFromDevice is a stub, so the loop must not leave its own copy behind either
      assert.equal(existsSync(join(dir, 'take-1.wav')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('a second take from the same node reuses the session it already has', async (t) => {
  const created = []
  const { loop, dir } = makeLoop({
    nodes: stubNodes({
      'voice.record': () => ({ status: 'ok', payload: { path: '/dev/x.wav' } }),
      'files.copyFromDevice': ({ data }) => {
        writeFileSync(data.hostPath, wavBytes())
        return { status: 'ok' }
      },
      'voice.say': { status: 'ok' },
    }),
    speechToText: { resolve: ({ audio }) => ({ audio }), transcribe: async () => 'привет' },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => {
        const id = `session-${created.length + 1}`
        created.push(id)
        return { sessionId: id }
      },
    },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await loop.handle({ node: 'phone', nodeName: 'phone', mode: 'ptt' })
  await loop.handle({ node: 'phone', nodeName: 'phone', mode: 'ptt' })

  assert.deepEqual(created, ['session-1'], 'a session is created once, not per take')
})

test('an answer to the previous question is not spoken for a new take', async (t) => {
  const spoken = []
  const { loop, dir } = makeLoop({
    nodes: stubNodes({
      'voice.record': () => ({ status: 'ok', payload: { path: '/dev/y.wav' } }),
      'files.copyFromDevice': ({ data }) => {
        writeFileSync(data.hostPath, wavBytes())
        return { status: 'ok' }
      },
      'voice.chat': ({ data }) => {
        if (data.role === 'assistant' && data.say) spoken.push(data.text)
        return { status: 'ok' }
      },
    }),
    speechToText: { resolve: ({ audio }) => ({ audio }), transcribe: async () => 'вопрос' },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await loop.handle({ node: 'phone', nodeName: 'phone', mode: 'ptt' })

  // The previous turn, still finishing, must be ignored.
  await loop.observeSessionEvent({ id: 'session-new' }, { type: 'turn/end', data: { turn: 7, reason: 'completed' } })
  assert.deepEqual(spoken, [])

  // The awaited turn is the first one that opens after delivery.
  await loop.observeSessionEvent({ id: 'session-new' }, { type: 'turn/start', data: { turn: 8 } })
  await loop.observeSessionEvent({ id: 'session-new' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '--- # say\nответ' }] } },
  })
  await loop.observeSessionEvent({ id: 'session-new' }, { type: 'turn/end', data: { turn: 8, reason: 'completed' } })

  assert.deepEqual(spoken, ['ответ'])
})

test('an uploaded recording is answered without asking the device for anything', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-upload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'incoming-id1.wav')
  writeFileSync(take, wavBytes())

  const nodes = stubNodes({ 'voice.say': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'какая сегодня погода' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-upload' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'id-1', path: take, bytes: 44, seconds: 1.2 })
  assert.equal(outcome.status, 'delivered')
  assert.equal(outcome.text, 'какая сегодня погода')
  // the whole point of the new protocol: no record, no copy — the file was already here
  const methods = nodes.calls.map((call) => `${call.api}.${call.method}`)
  assert.deepEqual(methods, ['voice.chat'], 'only the screen line — no record, no copy')
  assert.equal(existsSync(take), false, 'the recording is removed once it is used')
})

test('a repeated recording id does not become a second turn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-upload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.say': { status: 'ok' } })
  const delivered = []
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'раз' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: (message) => delivered.push(message) } }),
      create: async () => ({ sessionId: 'session-upload' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  const makeTake = (name) => {
    const path = join(dir, name)
    writeFileSync(path, wavBytes())
    return path
  }

  const first = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'same', path: makeTake('a.wav') })
  const second = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'same', path: makeTake('b.wav') })

  assert.equal(first.status, 'delivered')
  assert.equal(second.status, 'already')
  assert.equal(delivered.length, 1, 'one id means one turn')
})

test('an empty transcript from an upload is answered out loud and closes the exchange', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-upload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'silence.wav')
  writeFileSync(take, wavBytes())

  const nodes = stubNodes({ 'voice.say': { status: 'ok' } })
  const delivered = []
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: '' }) },
    sessions: { flush: async () => {} },
    sessionController: { resolveAgent: async () => ({ agent: { followup: (m) => delivered.push(m) } }) },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'silent', path: take })
  assert.equal(outcome.status, 'empty')
  assert.equal(delivered.length, 0)
  const said = nodes.calls.filter((call) => call.method === 'say')
  assert.equal(said.length, 1)
  assert.match(said[0].data.text, /Не расслышал/)
  assert.equal(existsSync(take), false)
})

test('one exchange writes every stage it reached and exactly one closing line', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-trace-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'take.wav')
  writeFileSync(take, wavBytes())

  const lines = []
  const nodes = stubNodes({ 'voice.say': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    textToSpeech: {
      resolve: (request) => request,
      synthesize: async () => ({ audio: wavBytes(), seconds: 1.5 }),
    },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-trace' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })

  await loop.handleUpload({
    node: 19,
    nodeName: 'A059P',
    id: 'trace-1',
    path: take,
    synth: 'host',
    at: { recordStart: 1000, recordStop: 2200, sentAt: 2300, receivedAt: 2500 },
  })
  await loop.observeSessionEvent({ id: 'session-trace' }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: 'session-trace' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '--- # say\nготово' }] } },
  })
  await loop.observeSessionEvent({ id: 'session-trace' }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })

  const stages = lines.filter((line) => line.includes('stage=')).map((line) => /stage=(\S+)/.exec(line)[1])
  // The two screen pushes are side commands: they may land between any two stages, so the
  // assertion is on the backbone plus their presence, not on one brittle total order.
  assert.deepEqual(stages.filter((stage) => !stage.startsWith('chat-')),
    ['received', 'transcribed', 'delivered', 'turn-start', 'turn-end', 'split', 'synthesized'])
  assert.ok(stages.includes('chat-user'), 'the transcript reaches the screen')
  assert.ok(stages.includes('chat-assistant'), 'the answer reaches the screen')
  for (const line of lines.filter((item) => item.includes('stage='))) {
    assert.match(line, /^\[dsh-voice] exchange trace-1 node=A059P stage=/)
    assert.match(line, / ms=\d+/)
  }

  const doneLines = lines.filter((line) => line.includes(' done '))
  assert.equal(doneLines.length, 1, 'exactly one closing line per exchange')
  const done = doneLines[0]
  assert.match(done, /^\[dsh-voice] exchange trace-1 node=A059P done total=\d+ms /)
  for (const segment of ['record: 1200', 'upload: 200', 'stt:', 'model:', 'tts:']) {
    assert.ok(done.includes(segment), `done must carry ${segment}: ${done}`)
  }
})

test('an exchange without client times has no record or upload segment', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-trace-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'take.wav')
  writeFileSync(take, wavBytes())

  const lines = []
  const loop = createVoiceLoop({
    nodes: stubNodes({ 'voice.say': { status: 'ok' } }),
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-plain' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })

  await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'plain-1', path: take })
  await loop.observeSessionEvent({ id: 'session-plain' }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: 'session-plain' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '--- # screen\nтолько текст' }] } },
  })
  await loop.observeSessionEvent({ id: 'session-plain' }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  const done = lines.find((line) => line.includes(' done '))
  assert.ok(done, 'a closing line is written even without client times')
  assert.doesNotMatch(done, /record:/)
  assert.doesNotMatch(done, /upload:/)
})

test('an empty transcript closes the exchange with reason=empty', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-trace-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'take.wav')
  writeFileSync(take, wavBytes())

  const lines = []
  const loop = createVoiceLoop({
    nodes: stubNodes({ 'voice.say': { status: 'ok' } }),
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: '' }) },
    sessions: { flush: async () => {} },
    sessionController: { resolveAgent: async () => ({ agent: { followup: () => {} } }) },
    cacheDir: join(dir, 'cache'),
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })

  await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'empty-1', path: take })
  const done = lines.filter((line) => line.includes(' done '))
  assert.equal(done.length, 1)
  assert.match(done[0], /reason=empty/)
})

/** Drive a full exchange by event: upload, a completed turn with one answer. */
async function drive (loop, { id, dir, synth, answer = '--- # say\nготово' }) {
  const take = join(dir, `${id}.wav`)
  writeFileSync(take, wavBytes())
  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id, path: take, synth })
  await loop.observeSessionEvent({ id: outcome.session }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: outcome.session }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: answer }] } },
  })
  await loop.observeSessionEvent({ id: outcome.session }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  return outcome
}

function bareLoop ({ dir, synthService, nodes, lines = [], exchangeTimeoutMs = undefined, on = undefined }) {
  return createVoiceLoop({
    ...(exchangeTimeoutMs === undefined ? {} : { exchangeTimeoutMs }),
    ...(on === undefined ? {} : { on }),
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    textToSpeech: synthService,
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: `session-${Math.random().toString(36).slice(2, 8)}` }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })
}

test('synth=device never touches the synthesizer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-synth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let synthesized = 0
  const nodes = stubNodes({ 'voice.say': { status: 'ok' } })
  const loop = bareLoop({
    dir,
    nodes,
    synthService: {
      resolve: (r) => r,
      synthesize: async () => { synthesized += 1; return { audio: wavBytes(), seconds: 1 } },
    },
  })

  await drive(loop, { id: 'device-1', dir, synth: 'device' })
  assert.equal(synthesized, 0, 'the device engine speaks, the host does not synthesize')
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.say, true)
  assert.equal(answered[0].data.audio, undefined, 'no audio is produced on the device path')
})

test('synth=host synthesizes, converts and plays the file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-synth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let synthesized = 0
  const nodes = stubNodes({ 'voice.play': { status: 'ok' } })
  const lines = []
  const loop = bareLoop({
    dir,
    nodes,
    lines,
    synthService: {
      resolve: (r) => r,
      synthesize: async () => { synthesized += 1; return { audio: wavBytes(), seconds: 1.5 } },
    },
  })

  await drive(loop, { id: 'host-1', dir, synth: 'host' })
  assert.equal(synthesized, 1)
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.say, true)
  assert.match(answered[0].data.audio, /\/cache\/out\/host-1\.ogg$/)
  assert.deepEqual(nodes.calls.map((call) => call.method).filter((method) => method === 'play' || method === 'say'), [])

  const done = lines.find((line) => line.includes(' done '))
  assert.match(done, /synth=host/)
  assert.match(done, /tts:/)
})

test('a broken synthesizer falls back to the device engine with reason=tts-failed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-synth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.say': { status: 'ok' } })
  const lines = []
  const loop = bareLoop({
    dir,
    nodes,
    lines,
    synthService: {
      resolve: (r) => r,
      synthesize: async () => { throw new Error('silero is not ready') },
    },
  })

  await drive(loop, { id: 'broken-1', dir, synth: 'host' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.say, true)
  assert.equal(answered[0].data.audio, undefined, 'no audio was produced, so the device engine speaks')
  const done = lines.find((line) => line.includes(' done '))
  assert.match(done, /reason=tts-failed/)
  assert.doesNotMatch(done, /tts:/, 'no synthesis happened, so there is no tts segment')
})

test('an unanswered answer does not hold the next exchange', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-synth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let chatResolve = null
  const nodes = {
    calls: [],
    call (node, api, method, data) {
      this.calls.push({ node, api, method, data })
      // the device confirms the message only after it has spoken it — which never happens here
      if (method === 'chat' && data?.role === 'assistant') {
        return new Promise((resolve) => { chatResolve = resolve })
      }
      return Promise.resolve({ status: 'ok' })
    },
  }
  const loop = bareLoop({
    dir,
    nodes,
    synthService: { resolve: (r) => r, synthesize: async () => ({ audio: wavBytes(), seconds: 1 }) },
  })

  await drive(loop, { id: 'slow-1', dir, synth: 'device' })
  // the first answer is still being spoken; the next press must not queue behind it
  const second = await loop.handleUpload({
    node: 19,
    nodeName: 'A059P',
    id: 'fast-2',
    path: (() => { const path = join(dir, 'fast.wav'); writeFileSync(path, wavBytes()); return path })(),
    synth: 'device',
  })
  assert.equal(second.status, 'delivered')
  assert.equal(
    nodes.calls.filter((call) => call.method === 'chat' && call.data?.role === 'assistant').length,
    1,
    'the second answer is not sent while the first is still being spoken',
  )
  chatResolve?.({ status: 'ok' })
})

test('the transcript reaches the screen with the exchange id and role user', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-chat-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'take.wav')
  writeFileSync(take, wavBytes())

  const nodes = stubNodes({ 'voice.chat': { status: 'ok' }, 'voice.say': { status: 'ok' } })
  const loop = bareLoop({ dir, nodes, synthService: null })

  await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'chat-1', path: take })
  const chats = nodes.calls.filter((call) => call.method === 'chat')
  assert.equal(chats.length, 1)
  assert.deepEqual(chats[0].data, { role: 'user', text: 'привет', id: 'chat-1' })
})

test('the answer reaches the screen: # screen when present, # say when not', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-chat-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' }, 'voice.say': { status: 'ok' } })
  const loop = bareLoop({ dir, nodes, synthService: null })

  await drive(loop, {
    id: 'screen-1',
    dir,
    synth: 'device',
    answer: '--- # say\nСвет включил.\n--- # screen\nДатчик: 21:14, лампа горела 40 минут.',
  })
  const assistant = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0].data.text, 'Датчик: 21:14, лампа горела 40 минут.')
  assert.equal(assistant[0].data.id, 'screen-1')

  const second = stubNodes({ 'voice.chat': { status: 'ok' }, 'voice.say': { status: 'ok' } })
  const loop2 = bareLoop({ dir, nodes: second, synthService: null })
  await drive(loop2, { id: 'noscreen-1', dir, synth: 'device', answer: '--- # say\nТолько голос.' })
  const only = second.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(only.length, 1)
  assert.equal(only[0].data.text, 'Только голос.')
})

test('a failing screen push does not break the exchange or the speech', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-chat-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let synthesized = 0
  const nodes = {
    calls: [],
    call (node, api, method, data) {
      this.calls.push({ node, api, method, data })
      if (method === 'chat') return Promise.reject(new Error('screen is off'))
      if (method === 'play') return Promise.resolve({ status: 'ok' })
      return Promise.resolve({ status: 'ok' })
    },
  }
  const loop = bareLoop({
    dir,
    nodes,
    synthService: {
      resolve: (r) => r,
      synthesize: async () => { synthesized += 1; return { audio: wavBytes(), seconds: 1 } },
    },
  })

  const outcome = await drive(loop, { id: 'broken-screen', dir, synth: 'host' })
  assert.equal(outcome.status, 'delivered')
  assert.equal(synthesized, 1, 'the answer is still synthesized')
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.match(answered[0].data.audio, /\.ogg$/, 'the audio is offered even though the screen refused')
})

/** One assistant message that asks for several tools, in order. */
function toolCalls (...names) {
  return {
    type: 'assistant/message',
    data: { turn: 1, message: { content: names.map((name) => ({ type: 'tool-call', name })) } },
  }
}

test('the cadence counts tool calls from one and starts over on a new exchange', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-cadence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = bareLoop({ dir, nodes, lines, synthService: null })

  const first = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'cad-1', path: (() => { const p = join(dir, 'a.wav'); writeFileSync(p, wavBytes()); return p })() })
  await loop.observeSessionEvent({ id: first.session }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: first.session }, toolCalls('bash', 'web_search', 'nodes_call'))
  await loop.observeSessionEvent({ id: first.session }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '--- # say\nготово' }] } },
  })
  await loop.observeSessionEvent({ id: first.session }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })

  const activity = nodes.calls.filter((call) => call.method === 'activity').map((call) => call.data)
  assert.deepEqual(activity, [
    { n: 1, name: 'bash', id: 'cad-1' },
    { n: 2, name: 'web_search', id: 'cad-1' },
    { n: 3, name: 'nodes_call', id: 'cad-1' },
  ])
  assert.equal(lines.filter((line) => line.includes('stage=activity')).length, 3)

  // a second press starts the counter again
  const second = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'cad-2', path: (() => { const p = join(dir, 'b.wav'); writeFileSync(p, wavBytes()); return p })() })
  await loop.observeSessionEvent({ id: second.session }, { type: 'turn/start', data: { turn: 2 } })
  await loop.observeSessionEvent({ id: second.session }, toolCalls('bash'))
  const secondActivity = nodes.calls.filter((call) => call.method === 'activity').at(-1).data
  assert.deepEqual(secondActivity, { n: 1, name: 'bash', id: 'cad-2' })
})

test('a cancelled turn closes the wait and says nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-cancel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = bareLoop({ dir, nodes, lines, synthService: null })

  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'cancel-1', path: (() => { const p = join(dir, 'a.wav'); writeFileSync(p, wavBytes()); return p })() })
  await loop.observeSessionEvent({ id: outcome.session }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: outcome.session }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } })

  assert.equal(loop.awaiting.size, 0, 'the wait is gone')
  assert.equal(nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant').length, 0, 'nothing is spoken')
  const done = lines.find((line) => line.includes(' done '))
  assert.match(done, /reason=cancelled/)
})

test('a disposed session releases the wait', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-disposed-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const handlers = new Map()
  const on = (name, handler) => {
    handlers.set(name, handler)
    return () => handlers.delete(name)
  }
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = bareLoop({ dir, nodes, lines, synthService: null, on })

  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'gone-1', path: (() => { const p = join(dir, 'a.wav'); writeFileSync(p, wavBytes()); return p })() })
  await loop.observeSessionEvent({ id: outcome.session }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(loop.awaiting.size, 1)

  handlers.get('session/disposed')({ id: outcome.session })
  assert.equal(loop.awaiting.size, 0)
  assert.match(lines.find((line) => line.includes(' done ')), /reason=disposed/)
})

test('an answer that never comes is released by the deadline', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-timeout-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = bareLoop({ dir, nodes, lines, synthService: null, exchangeTimeoutMs: 40 })

  await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'stuck-1', path: (() => { const p = join(dir, 'a.wav'); writeFileSync(p, wavBytes()); return p })() })
  assert.equal(loop.awaiting.size, 1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(loop.awaiting.size, 0, 'the stuck exchange is released')
  assert.match(lines.find((line) => line.includes(' done ')), /reason=timeout/)
})
