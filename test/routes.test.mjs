// The one route the settings card reads.
import assert from 'node:assert/strict'
import test from 'node:test'

import { BASE_PATH, registerVoiceRoutes, voiceState } from '../routes.mjs'
import { installVoiceRoutes } from '../index.mjs'
import { stubHost, stubService } from './helpers.mjs'

/** Call the registered route the way the web server would. */
async function call (route, method = 'GET') {
  const response = await route.fetch(new Request(`http://localhost${route.path}`, { method }))
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null
  return { status: response.status, body, contentType: response.headers.get('content-type') }
}

test('the state says whether this host can speak at all', () => {
  assert.deepEqual(voiceState({ textToSpeech: stubService() }), { textToSpeech: true })
  assert.deepEqual(voiceState({ textToSpeech: null }), { textToSpeech: false })
  assert.deepEqual(voiceState({}), { textToSpeech: false })
  // A service that cannot synthesize is no better than none.
  assert.deepEqual(voiceState({ textToSpeech: { resolve: () => ({}) } }), { textToSpeech: false })
})

test('the route answers JSON at the documented path', async () => {
  const connection = { fetch: { register: (route) => route } }
  const [route] = registerVoiceRoutes(connection, () => voiceState({ textToSpeech: stubService() }))

  assert.equal(route.path, `${BASE_PATH}/state`)
  assert.deepEqual(route.methods, ['GET'])
  const answer = await call(route)
  assert.equal(answer.status, 200)
  assert.equal(answer.contentType.includes('application/json'), true)
  assert.deepEqual(answer.body, { textToSpeech: true })
})

test('a broken read is reported, not thrown at the browser', async () => {
  const connection = { fetch: { register: (route) => route } }
  const [route] = registerVoiceRoutes(connection, () => { throw new Error('сервис сломан') })
  const answer = await call(route)
  assert.equal(answer.status, 500)
  assert.equal(answer.body.code, 'VOICE_STATE_FAILED')
  assert.match(answer.body.error, /сервис сломан/u)
})

test('a host without the route seam is not an error', () => {
  assert.deepEqual(registerVoiceRoutes(null), [])
  assert.deepEqual(registerVoiceRoutes({}), [])
  assert.deepEqual(registerVoiceRoutes({ fetch: {} }), [])
})

test('the plugin mounts the route through the connection service', async () => {
  const host = stubHost()
  installVoiceRoutes(host)

  assert.deepEqual(host.injected[0], ['connection'], 'the child asks for the connection service')
  const [route] = host.routes
  assert.ok(route, 'one route is registered')
  const answer = await call(route)
  assert.deepEqual(answer.body, { textToSpeech: false }, 'this fake host has no synthesizer')

  // The service is read per request, so a provider that mounts later is seen.
  host.get = (name) => (name === 'textToSpeech' ? stubService() : undefined)
  const later = await call(route)
  assert.deepEqual(later.body, { textToSpeech: true })
})

test('a host that cannot inject gets no route and no exception', () => {
  assert.equal(installVoiceRoutes({}), undefined)
  assert.equal(installVoiceRoutes(null), undefined)
  assert.equal(installVoiceRoutes({ inject () { throw new Error('нет такого сервиса') } }), undefined)
})
