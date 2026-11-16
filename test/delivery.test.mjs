// Synthesis, the file, and the record — without a Host or a turn in the way.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CALL_ID_PREFIX,
  PRESENTED_EVENT,
  defaultCacheDir,
  deliverVoice,
  hasVoiceDeliverable,
  pruneOldFiles,
} from '../reply.mjs'
import { fakeSession, silentWav, stubService } from './helpers.mjs'

async function workdir (t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voice-delivery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const isOgg = (bytes) => bytes.subarray(0, 4).toString('latin1') === 'OggS'

test('a spoken reply becomes an OGG file declared on its own turn', async (t) => {
  const directory = await workdir(t)
  const service = stubService()
  const session = fakeSession()

  const result = await deliverVoice({
    service,
    session,
    turn: 4,
    text: 'Готово, всё поднялось.',
    cacheDir: directory,
    speed: 1,
    description: 'Озвучка ответа',
  })

  const bytes = await readFile(result.path)
  assert.ok(isOgg(bytes), 'the delivered file is an OGG container')
  assert.equal(result.callId.startsWith(CALL_ID_PREFIX), true)
  assert.equal(service.calls.resolve[0].text, 'Готово, всё поднялось.')
  assert.equal(service.calls.resolve[0].format, 'wav')

  assert.equal(session.appended.length, 1)
  const [event] = session.appended
  assert.equal(event.type, PRESENTED_EVENT)
  assert.equal(event.data.turn, 4)
  assert.equal(event.data.callId, result.callId)
  assert.equal(result.seq, event.seq, 'the result carries the record sequence')
  assert.equal(result.size, bytes.byteLength, 'and the size the channel will see')
  assert.deepEqual(event.data.files, [{ path: result.path, description: 'Озвучка ответа' }])
  assert.ok(event.data.files[0].path.startsWith('/'), 'the declared path is absolute')
})

test('a record without a description is refused before anything is written', async (t) => {
  const directory = await workdir(t)
  const session = fakeSession()
  for (const description of ['', '   ', undefined, null]) {
    await assert.rejects(deliverVoice({
      service: stubService(), session, turn: 1, text: 'Проверка.', cacheDir: directory, speed: 1, description,
    }), /описания файла/u)
  }
  assert.equal(session.appended.length, 0)
  assert.deepEqual(await readdir(directory), [])
})

test('the intermediate WAV does not survive the delivery', async (t) => {
  const directory = await workdir(t)
  await deliverVoice({
    service: stubService(),
    session: fakeSession(),
    turn: 1,
    text: 'Проверка.',
    cacheDir: directory,
    speed: 1,
    description: 'x',
  })

  const left = await readdir(directory)
  assert.equal(left.filter((name) => name.endsWith('.wav')).length, 0)
  assert.equal(left.filter((name) => name.endsWith('.ogg')).length, 1)
})

test('a refused conversion leaves no WAV behind and appends nothing', async (t) => {
  const directory = await workdir(t)
  const session = fakeSession()

  await assert.rejects(deliverVoice({
    service: stubService(),
    session,
    turn: 2,
    text: 'Проверка.',
    cacheDir: directory,
    speed: 1,
    description: 'x',
    deps: { toVoiceNote: async () => { throw new Error('ffmpeg упал') } },
  }), /ffmpeg упал/u)

  assert.equal(session.appended.length, 0)
  assert.deepEqual(await readdir(directory), [])
})

test('a synthesizer that fails appends nothing', async (t) => {
  const directory = await workdir(t)
  const session = fakeSession()
  const service = { resolve: () => ({ candidates: [] }), synthesize: async () => { throw new Error('движок молчит') } }

  await assert.rejects(deliverVoice({
    service, session, turn: 3, text: 'Проверка.', cacheDir: directory, speed: 1, description: 'x',
  }), /движок молчит/u)

  assert.equal(session.appended.length, 0)
})

test('a missing service or an empty text is refused before anything is written', async () => {
  const session = fakeSession()
  await assert.rejects(deliverVoice({ service: null, session, turn: 1, text: 'x', description: 'x' }), /textToSpeech/u)
  await assert.rejects(
    deliverVoice({ service: stubService(), session, turn: 1, text: '   ', description: 'x' }),
    /текст пуст/u,
  )
  assert.equal(session.appended.length, 0)
})

test('hasVoiceDeliverable sees our own record and a voice note the model attached', () => {
  const ours = { type: PRESENTED_EVENT, data: { turn: 5, callId: `${CALL_ID_PREFIX}abc`, files: [] } }
  const manual = {
    type: PRESENTED_EVENT,
    data: { turn: 5, callId: 'call_123', files: [{ path: '/tmp/say.ogg', description: 'voice_say' }] },
  }
  const image = {
    type: PRESENTED_EVENT,
    data: { turn: 5, callId: 'call_456', files: [{ path: '/tmp/chart.png' }] },
  }

  assert.equal(hasVoiceDeliverable([ours], 5), true)
  assert.equal(hasVoiceDeliverable([manual], 5), true)
  assert.equal(hasVoiceDeliverable([image], 5), false)
  assert.equal(hasVoiceDeliverable([ours], 6), false, 'another turn is another question')
  assert.equal(hasVoiceDeliverable([], 5), false)
})

test('pruning removes only own files older than a day', async (t) => {
  const directory = await workdir(t)
  const old = join(directory, '11111111-2222-3333-4444-555555555555.ogg')
  const fresh = join(directory, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.ogg')
  const foreign = join(directory, 'notes.ogg')
  await writeFile(old, silentWav())
  await writeFile(fresh, silentWav())
  await writeFile(foreign, 'не наше')

  const now = Date.now()
  const oldTime = new Date(now - 48 * 3600_000)
  await utimes(old, oldTime, oldTime)

  const removed = await pruneOldFiles(directory, { maxAgeMs: 86_400_000, now })

  assert.equal(removed, 1)
  const left = (await readdir(directory)).sort()
  assert.deepEqual(left, ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.ogg', 'notes.ogg'])
})

test('pruning a directory that does not exist is not an error', async () => {
  assert.equal(await pruneOldFiles('/nonexistent/voice-reply-cache'), 0)
})

test('pruning survives a file that vanishes between the listing and the stat', async () => {
  const removed = await pruneOldFiles('/tmp/whatever', {
    deps: {
      readdir: async () => ['11111111-2222-3333-4444-555555555555.ogg'],
      stat: async () => { throw Object.assign(new Error('нет файла'), { code: 'ENOENT' }) },
      rm: async () => {},
    },
  })
  assert.equal(removed, 0)
})

test('pruning ignores entries that are not files', async () => {
  const removed = await pruneOldFiles('/tmp/whatever', {
    now: Date.now(),
    deps: {
      readdir: async () => ['11111111-2222-3333-4444-555555555555.ogg'],
      stat: async () => ({ isFile: () => false }),
      rm: async () => { throw new Error('must not be called') },
    },
  })
  assert.equal(removed, 0)
})

test('rendered replies live under the plugin cache root, in their own directory', () => {
  assert.equal(defaultCacheDir({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/cache/voice/reply')
  // A configured cache moves the replies with it; the loop sweeps `work/` and
  // `out/`, so a sibling directory of the root is never collected by that sweep.
  assert.equal(defaultCacheDir({ DSH_HOME: '/tmp/dsh-home' }, '/srv/voice'), '/srv/voice/reply')
  assert.equal(defaultCacheDir({ DSH_HOME: '/tmp/dsh-home' }, '  '), '/tmp/dsh-home/cache/voice/reply')
  assert.ok(defaultCacheDir({}).startsWith('/'), 'a relative cache path would be resolved by a channel')
})
