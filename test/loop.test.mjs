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
    'voice.record': { status: 'ok', payload: { path: '/device/a.wav', seconds: 1.4 } },
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
    ['received', 'stt-request', 'transcribed', 'delivered', 'turn-start', 'turn-end', 'split', 'synthesized', 'answered'])
  assert.ok(stages.includes('chat-user'), 'the transcript reaches the screen')
  // On the host path the answer is one command that carries both halves: no separate chat line.
  assert.ok(stages.includes('answered'), 'the answer command was sent')
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
  const chats = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(chats.length, 0, 'one command carries both halves: no separate chat line')
  const answers = nodes.calls.filter((call) => call.method === 'answer')
  assert.equal(answers.length, 1, 'exactly one answer command')
  const args = answers[0].data
  assert.equal(args.id, 'host-1')
  assert.equal(args.text, 'готово')
  assert.equal(args.speak, 'готово')
  assert.match(args.path, /\/cache\/out\/host-1\.ogg$/)
  assert.equal(args.seconds, 1.5)

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
  const answers = nodes.calls.filter((call) => call.method === 'answer')
  assert.equal(answers.length, 1, 'the audio is offered even though the screen refused chat')
  assert.match(answers[0].data.path, /\.ogg$/)
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

test('a recording shorter than the threshold never reaches the recognizer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-short-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'click.wav')
  writeFileSync(take, wavBytes())

  let transcribed = 0
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => { transcribed += 1; return { text: '良いです。' } } },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-short' }),
    },
    cacheDir: join(dir, 'cache'),
    minSeconds: 0.4,
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })

  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'click-1', path: take, seconds: 0.216 })
  assert.equal(outcome.status, 'too-short')
  assert.equal(transcribed, 0, 'a button click is not speech')
  assert.equal(existsSync(take), false, 'the file is removed')
  assert.equal(nodes.calls.filter((call) => call.method === 'chat').length, 0, 'nothing is shown')
  assert.equal(nodes.calls.filter((call) => call.method === 'say').length, 0, 'and nothing is said')
  assert.match(lines.find((line) => line.includes(' done ')), /reason=too-short/)
})

test('the configured language is what the recognizer is asked for', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-lang-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'take.wav')
  writeFileSync(take, wavBytes())

  const asked = []
  const lines = []
  const loop = createVoiceLoop({
    nodes: stubNodes({ 'voice.chat': { status: 'ok' } }),
    speechToText: {
      resolve: (request) => { asked.push(request.language); return { ...request, provider: { info: { id: 'openai-transcribe' } } } },
      transcribe: async () => ({ text: 'привет' }),
    },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-lang' }),
    },
    cacheDir: join(dir, 'cache'),
    language: 'ru',
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })

  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'lang-1', path: take, seconds: 1.2 })
  // finish the turn: the closing line is written when the answer is dispatched
  await loop.observeSessionEvent({ id: outcome.session }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: outcome.session }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '--- # say\nготово' }] } },
  })
  await loop.observeSessionEvent({ id: outcome.session }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  assert.deepEqual(asked, ['ru'])
  const sttRequest = lines.find((line) => line.includes('stage=stt-request'))
  assert.match(sttRequest, /provider=openai-transcribe/)
  assert.match(sttRequest, /language=ru/)
  assert.match(lines.find((line) => line.includes(' done ')), /language=ru/)
})

test('a language the provider refuses falls back instead of losing the recording', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-lang-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const take = join(dir, 'take.wav')
  writeFileSync(take, wavBytes())

  const asked = []
  const warnings = []
  const loop = createVoiceLoop({
    nodes: stubNodes({ 'voice.chat': { status: 'ok' } }),
    speechToText: {
      resolve: (request) => {
        asked.push(request.language ?? null)
        if (request.language === 'ru') throw new Error('provider does not support ru')
        return request
      },
      transcribe: async () => ({ text: 'привет' }),
    },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-fallback' }),
    },
    cacheDir: join(dir, 'cache'),
    language: 'ru',
    log: { info: () => {}, warn: (line) => warnings.push(line), debug: () => {} },
  })

  const outcome = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'fallback-1', path: take, seconds: 1.2 })
  assert.equal(outcome.status, 'delivered')
  assert.deepEqual(asked, ['ru', null], 'the second attempt lets the service choose')
  assert.ok(warnings.some((line) => line.includes('does not take the configured language')), 'the fallback is not silent')
})

test('the message carries what to show and, separately, what to say', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-split-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = bareLoop({ dir, nodes, lines, synthService: null })

  await drive(loop, {
    id: 'split-1',
    dir,
    synth: 'device',
    answer: '--- # say\nСвет включил.\n--- # screen\nbash: 3 files changed, 12 insertions',
  })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.text, 'bash: 3 files changed, 12 insertions')
  assert.equal(answered[0].data.speak, 'Свет включил.')
  assert.equal(answered[0].data.say, true)

  const stage = lines.find((line) => line.includes('stage=chat-assistant'))
  assert.match(stage, /speakChars=13/)
  assert.match(stage, /textChars=36/)
})

test('an empty # say means the answer is shown but not spoken', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-split-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = bareLoop({ dir, nodes, synthService: null })

  await drive(loop, { id: 'silent-say', dir, synth: 'device', answer: '--- # screen\nТолько текст на экране.' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1, 'the screen still gets its line')
  assert.equal(answered[0].data.text, 'Только текст на экране.')
  assert.equal(answered[0].data.say, false, 'the line is shown, nothing is said')
})

test('host audio is synthesized from speak, not from the screen text', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-split-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const spoken = []
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'сравни' }) },
    textToSpeech: {
      snapshot: () => ({ selection: { speed: 1 } }),
      resolve: (r) => r,
      synthesize: async (spec) => { spoken.push(spec.text); return { audio: wavBytes(), seconds: 1 } },
    },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-tts-split' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  await drive(loop, {
    id: 'tts-split',
    dir,
    synth: 'host',
    answer: '--- # say\nТри магазина дороже.\n--- # screen\n| магазин | цена |\n| a | 100 |',
  })
  assert.deepEqual(spoken, ['Три магазина дороже.'], 'the engine reads the spoken part only')
  const answers = nodes.calls.filter((call) => call.method === 'answer')
  assert.equal(answers.length, 1)
  assert.equal(answers[0].data.speak, 'Три магазина дороже.')
  assert.match(answers[0].data.text, /\| магазин \| цена \|/)
  assert.match(answers[0].data.path, /\.ogg$/)
})

test('a new-session event drops the binding, so the next take starts a new conversation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-new-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let created = 0
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => { created += 1; return { sessionId: `session-${created}` } },
    },
    cacheDir: join(dir, 'cache'),
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })

  const take = () => { const p = join(dir, `t-${Math.random().toString(36).slice(2, 6)}.wav`); writeFileSync(p, wavBytes()); return p }
  const first = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'n1', path: take(), seconds: 1.2 })
  assert.equal(first.session, 'session-1')
  // finish the exchange: a reset while it runs is deferred, which the next test covers
  await loop.observeSessionEvent({ id: first.session }, { type: 'turn/start', data: { turn: 1 } })
  await loop.observeSessionEvent({ id: first.session }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '--- # say\nответ' }] } },
  })
  await loop.observeSessionEvent({ id: first.session }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })

  const reset = loop.handleNewSession({ node: 19, nodeName: 'A059P' })
  assert.equal(reset.status, 'ok')
  assert.ok(lines.some((line) => line.includes('stage=new-session')), 'the reset leaves a trace')

  const second = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'n2', path: take(), seconds: 1.2 })
  assert.equal(created, 2, 'a fresh session was created')
  assert.equal(second.session, 'session-2')
})

test('a reset during a running exchange waits for it to finish', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-new-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let created = 0
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const lines = []
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => { created += 1; return { sessionId: `session-${created}` } },
    },
    cacheDir: join(dir, 'cache'),
    log: { info: (line) => lines.push(line), warn: () => {}, debug: () => {} },
  })

  const take = () => { const p = join(dir, `t-${Math.random().toString(36).slice(2, 6)}.wav`); writeFileSync(p, wavBytes()); return p }
  const first = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'r1', path: take(), seconds: 1.2 })
  await loop.observeSessionEvent({ id: first.session }, { type: 'turn/start', data: { turn: 1 } })

  // the person asks for a new session while the answer to what they already said is still coming
  const reset = loop.handleNewSession({ node: 19, nodeName: 'A059P' })
  assert.equal(reset.status, 'deferred')
  assert.equal(created, 1, 'the running exchange keeps its session')

  await loop.observeSessionEvent({ id: first.session }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '--- # say\nответ' }] } },
  })
  await loop.observeSessionEvent({ id: first.session }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })

  // the answer was still delivered to the old session, and only then did the reset apply
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)

  const second = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'r2', path: take(), seconds: 1.2 })
  assert.equal(created, 2)
  assert.equal(second.session, 'session-2')
})

/** A loop whose only extra is the assistants service and a counter of its calls. */
function loopWithAssistants ({ dir, persona, calls = [] }) {
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  return {
    nodes,
    loop: createVoiceLoop({
      nodes,
      assistants: {
        personaOf (sessionId) {
          calls.push(sessionId)
          return typeof persona === 'function' ? persona(sessionId) : persona
        },
      },
      speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
      sessions: { flush: async () => {} },
      sessionController: {
        resolveAgent: async () => ({ agent: { followup: () => {} } }),
        create: async () => ({ sessionId: 'session-who' }),
      },
      cacheDir: join(dir, 'cache'),
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    }),
  }
}

test('the assistant name and icon travel with the answer, asked once per exchange', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-who-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const asked = []
  const { nodes, loop } = loopWithAssistants({
    dir,
    calls: asked,
    persona: { assistant: { id: 'a-kesha', name: 'Кеша', icon: '🦜' }, user: null, transport: 'nodes' },
  })

  await drive(loop, { id: 'who-1', dir, synth: 'device' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.deepEqual(answered[0].data.who, { name: 'Кеша', icon: '🦜' })

  const userLine = nodes.calls.find((call) => call.method === 'chat' && call.data.role === 'user')
  assert.equal(userLine.data.who, undefined, 'the person needs no label')
  assert.equal(asked.length, 1, 'one lookup per exchange, not per message')
})

test('an assistant without an icon sends only the name', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-who-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { nodes, loop } = loopWithAssistants({
    dir,
    persona: { assistant: { id: 'a-plain', name: 'Плейн', icon: '' }, user: null, transport: 'nodes' },
  })

  await drive(loop, { id: 'who-2', dir, synth: 'device' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.deepEqual(answered[0].data.who, { name: 'Плейн' })
})

test('without the assistants service there is no who at all', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-who-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-no-service' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  await drive(loop, { id: 'who-3', dir, synth: 'device' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.who, undefined, 'a Host without the service still answers')
})

test('an assistant that is not assigned leaves who out', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-who-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { nodes, loop } = loopWithAssistants({
    dir,
    persona: { assistant: null, user: null, transport: 'nodes' },
  })
  await drive(loop, { id: 'who-4', dir, synth: 'device' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.who, undefined)
})

test('a broken assistants service does not cost the answer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-who-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    assistants: { personaOf: () => { throw new Error('rules are broken') } },
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-broken-who' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  await drive(loop, { id: 'who-5', dir, synth: 'device' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.who, undefined)
})

test('the audio file lives until the answer command settles, and is gone afterwards', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-play-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let seenPath = null
  let existedDuring = null
  let resolveAnswer = null
  const nodes = {
    calls: [],
    call (node, api, method, data) {
      this.calls.push({ node, api, method, data })
      if (method === 'answer') {
        seenPath = data.path
        existedDuring = existsSync(data.path)
        // the device downloads the file while this command is open
        return new Promise((resolve) => { resolveAnswer = () => resolve({ status: 'ok', payload: { queued: true } }) })
      }
      return Promise.resolve({ status: 'ok' })
    },
  }
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    textToSpeech: {
      snapshot: () => ({ selection: { speed: 1 } }),
      resolve: (r) => r,
      synthesize: async () => ({ audio: wavBytes(), seconds: 1 }),
    },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-play' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  const exchange = drive(loop, { id: 'play-1', dir, synth: 'host' })
  for (let i = 0; i < 60 && resolveAnswer === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(resolveAnswer, 'the answer command was issued')
  assert.equal(existedDuring, true, 'the file exists while the device is fetching it')
  assert.equal(existsSync(seenPath), true)
  resolveAnswer()
  await exchange
  assert.equal(existsSync(seenPath), false, 'and it is removed once the command answered')
})

test('device mode never issues play', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-play-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = bareLoop({ dir, nodes, synthService: null })

  await drive(loop, { id: 'dev-1', dir, synth: 'device' })
  assert.equal(nodes.calls.filter((call) => call.method === 'play').length, 0)
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered[0].data.say, true)
})

test('a failed synthesis is visible to the person as degraded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-degraded-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    textToSpeech: {
      resolve: (r) => r,
      synthesize: async () => { throw new Error('silero provider has been stopped') },
    },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-degraded' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  await drive(loop, { id: 'degraded-1', dir, synth: 'host' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered.length, 1, 'the answer still goes out, spoken by the device')
  assert.deepEqual(answered[0].data.degraded, {
    kind: 'tts-failed',
    message: 'silero provider has been stopped',
  })
})

test('a healthy answer carries no degraded field', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-degraded-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = bareLoop({ dir, nodes, synthService: null })

  await drive(loop, { id: 'ok-1', dir, synth: 'device' })
  const answered = nodes.calls.filter((call) => call.method === 'chat' && call.data.role === 'assistant')
  assert.equal(answered[0].data.degraded, undefined)
})

test('a bug report reaches the session marked as a fact, not spoken', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-bug-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const delivered = []
  let injected = 0
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({
        agent: {
          followup: (message) => delivered.push(message),
          inject: (message) => { injected += 1; delivered.push(message) },
        },
      }),
      create: async () => ({ sessionId: 'session-bug' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  // bind the node to a session first: a report has nowhere to go without one
  await loop.handleUpload({
    node: 19,
    nodeName: 'A059P',
    id: 'bind-1',
    path: (() => { const p = join(dir, 'a.wav'); writeFileSync(p, wavBytes()); return p })(),
    seconds: 1.2,
  })

  const outcome = await loop.handleBugReport({
    node: 19,
    nodeName: 'A059P',
    id: 'ex-1',
    kind: 'tts-failed',
    text: 'silero provider has been stopped',
    app: '0.10.41',
  })
  assert.equal(outcome.status, 'delivered')
  assert.equal(injected, 1, 'the fact is injected, so an idle session is not woken')

  const report = delivered.at(-1)
  assert.equal(report.source.bugReport, true)
  assert.equal(report.source.kind, 'dsh-nodes')
  assert.match(report.content[0].text, /отчёт с устройства: синтез речи не удался/)
  assert.match(report.content[0].text, /обмен: ex-1/)
  assert.match(report.content[0].text, /приложение: 0\.10\.41/)
  assert.match(report.content[0].text, /ошибка: silero provider has been stopped/)
  // nothing was spoken for it
  assert.equal(nodes.calls.filter((call) => call.method === 'say').length, 0)
})

/** A loop with a warmup counter and a voice API that may or may not exist. */
function warmLoop ({ dir, hasVoice = true, warmup = async () => {}, lines = [] }) {
  let warmed = 0
  const nodes = {
    calls: [],
    call (node, api, method, data) { this.calls.push({ node, api, method, data }); return Promise.resolve({ status: 'ok' }) },
    api (nodeRef, name) { return hasVoice && name === 'voice' ? { id: 1, name: 'voice' } : null },
  }
  const loop = createVoiceLoop({
    nodes,
    textToSpeech: { warmup: async () => { warmed += 1; await warmup() }, resolve: (r) => r, synthesize: async () => ({ audio: wavBytes(), seconds: 1 }) },
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-warm' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(`WARN ${line}`), debug: () => {} },
  })
  return { loop, nodes, calls: () => warmed }
}

test('opening the screen warms the model up once, and a second entry is skipped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-warm-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lines = []
  const { loop, nodes, calls } = warmLoop({ dir, lines })

  const first = await loop.handleWarmup({ node: 19, nodeName: 'A059P' })
  assert.equal(first.status, 'ready')
  assert.equal(calls(), 1)
  assert.equal(loop.awaiting.size, 0, 'a warmup creates no exchange')
  assert.equal(nodes.calls.filter((call) => call.method !== 'chat').length, 0, 'and nothing is sent to the device')
  assert.deepEqual(nodes.calls, [], 'no command at all')

  const second = await loop.handleWarmup({ node: 19, nodeName: 'A059P' })
  assert.equal(second.status, 'skipped')
  assert.equal(calls(), 1, 'entering and leaving again within a minute does not wake the model twice')
  assert.ok(lines.some((line) => line.includes('stage=warmup') && line.includes('result=skipped')))
})

test('a node without a voice API is not warmed at all', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-warm-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { loop, calls } = warmLoop({ dir, hasVoice: false })

  const outcome = await loop.handleWarmup({ node: 5, nodeName: 'laptop' })
  assert.equal(outcome.status, 'not-voice')
  assert.equal(calls(), 0)
})

test('a broken warmup is a warning, not a failure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-warm-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const lines = []
  const { loop } = warmLoop({ dir, lines, warmup: async () => { throw new Error('silero is not there') } })

  const outcome = await loop.handleWarmup({ node: 19, nodeName: 'A059P' })
  assert.equal(outcome.status, 'failed')
  assert.ok(lines.some((line) => line.includes('WARN') && line.includes('warmup failed')))
  assert.ok(lines.some((line) => line.includes('done') && line.includes('reason=failed')))
})

test('a repeat of an answered id leaves no file behind', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-dup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = bareLoop({ dir, nodes, synthService: null })

  const take = () => { const p = join(dir, `t-${Math.random().toString(36).slice(2, 6)}.wav`); writeFileSync(p, wavBytes()); return p }
  const first = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'dup-1', path: take(), seconds: 1.2 })
  assert.equal(first.status, 'delivered')

  const secondPath = take()
  const second = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'dup-1', path: secondPath, seconds: 1.2 })
  assert.equal(second.status, 'already')
  assert.equal(existsSync(secondPath), false, 'the freshly written file is removed, not leaked')
})

test('a failed exchange leaves the id free for a retry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-retry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let transcribeCalls = 0
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: {
      resolve: (r) => r,
      transcribe: async () => {
        transcribeCalls += 1
        if (transcribeCalls === 1) throw new Error('the recognizer is down')
        return { text: 'со второго раза' }
      },
    },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: 'session-retry' }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  const take = () => { const p = join(dir, `t-${Math.random().toString(36).slice(2, 6)}.wav`); writeFileSync(p, wavBytes()); return p }
  // the first attempt recognizes nothing, so the take never becomes a turn
  const first = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'retry-1', path: take(), seconds: 1.2 })
  assert.equal(first.status, 'empty')

  // the client re-sends the same id on purpose: it must be handled, not swallowed as a duplicate
  const second = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'retry-1', path: take(), seconds: 1.2 })
  assert.equal(second.status, 'delivered')
  assert.equal(second.text, 'со второго раза')
})

test('two devices with the same id are two different exchanges', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-dup2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const nodes = stubNodes({ 'voice.chat': { status: 'ok' } })
  const loop = createVoiceLoop({
    nodes,
    speechToText: { resolve: (r) => r, transcribe: async () => ({ text: 'привет' }) },
    sessions: { flush: async () => {} },
    sessionController: {
      resolveAgent: async () => ({ agent: { followup: () => {} } }),
      create: async () => ({ sessionId: `session-${Math.random().toString(36).slice(2, 8)}` }),
    },
    cacheDir: join(dir, 'cache'),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  const take = () => { const p = join(dir, `t-${Math.random().toString(36).slice(2, 6)}.wav`); writeFileSync(p, wavBytes()); return p }
  const phone = await loop.handleUpload({ node: 19, nodeName: 'A059P', id: 'same', path: take(), seconds: 1.2 })
  const tablet = await loop.handleUpload({ node: 20, nodeName: 'Tablet', id: 'same', path: take(), seconds: 1.2 })
  assert.equal(phone.status, 'delivered')
  assert.equal(tablet.status, 'delivered', 'the id is one per device, not one globally')
})

test('a path with a dollar sign is quoted, not executed', async () => {
  const { shellQuote } = await import('../loop.mjs')
  const quoted = shellQuote("/tmp/$(rm -rf /).wav")
  assert.equal(quoted, "'/tmp/$(rm -rf /).wav'")
  assert.equal(shellQuote("/tmp/it's.wav"), "'/tmp/it'\\''s.wav'")
})
