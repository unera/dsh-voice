import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { assistantTextOf, createVoiceLoop } from '../loop.mjs'

/** A tiny silent WAV: the recognizer stub never reads it, the loop only needs bytes. */
function wavBytes () {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(0, 40)
  return header
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
  assert.deepEqual(methods, ['voice.record', 'files.copyFromDevice', 'shell.exec'])
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

  const said = nodes.calls.filter((call) => call.api === 'voice' && call.method === 'say')
  assert.equal(said.length, 1)
  assert.equal(said[0].node, 'A059P')
  assert.equal(said[0].data.text, 'Свет включил.')
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

  assert.equal(nodes.calls.filter((call) => call.method === 'say').length, 0)
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
      'voice.say': ({ data }) => {
        spoken.push(data.text)
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
  assert.deepEqual(methods, [], 'nothing may be asked of the device before the answer')
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
