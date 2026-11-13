import assert from 'node:assert/strict'
import test from 'node:test'

import { annotateVoiceMessages, install, voiceNotice } from '../index.mjs'

/** Minimal Host stand-in: records listeners and prompt sections, no framework. */
function stubHost () {
  const listeners = []
  const sections = []
  const state = {
    listeners,
    sections,
    on (event, listener, options) {
      listeners.push({ event, listener, options })
      return () => listeners.splice(0, listeners.length)
    },
    inject (deps, callback) {
      callback({ systemPrompt: { context: (section) => { sections.push(section); return () => {} } } })
    },
    logger: () => ({ warn: () => {} }),
  }
  return state
}

const preStep = (host) => host.listeners.find((entry) => entry.event === 'agent/pre-step')

test('a voice-marked message gets clean text and a notice beside it', () => {
  const messages = [{
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: '--- # voice device=pixel\nвключи свет в коридоре' }],
    source: { kind: 'user', rpcId: 'r1' },
  }]

  const rewritten = annotateVoiceMessages(messages)

  assert.equal(rewritten.length, 2)
  assert.deepEqual(rewritten[0].content, [{ type: 'text', text: 'включи свет в коридоре' }])
  assert.equal(rewritten[0].id, 'm1')
  assert.equal(rewritten[1].role, 'user')
  assert.equal(rewritten[1].source.kind, 'plugin:dsh-voice')
  assert.match(rewritten[1].content[0].text, /пришёл голосом/)
  assert.match(rewritten[1].content[0].text, /pixel/)
  // The original message object is never mutated: the channel may still own it.
  assert.match(messages[0].content[0].text, /--- # voice/)
})

test('an Android message marked in its source needs no marker in the text', () => {
  const messages = [{
    id: 'm2',
    role: 'user',
    content: [{ type: 'text', text: 'включи свет' }],
    source: { kind: 'dsh-nodes', voice: true },
  }]

  const rewritten = annotateVoiceMessages(messages)

  assert.equal(rewritten.length, 2)
  assert.deepEqual(rewritten[0].content, [{ type: 'text', text: 'включи свет' }])
  assert.equal(rewritten[1].source.kind, 'plugin:dsh-voice')
})

test('text messages, assistant messages and other plugins are untouched', () => {
  const messages = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: 'обычный текст' }], source: { kind: 'user' } },
    { id: 'b', role: 'assistant', content: [{ type: 'text', text: '--- # say\nответ' }] },
    { id: 'c', role: 'user', content: [{ type: 'text', text: 'служебка' }], source: { kind: 'plugin:dsh-im' } },
  ]

  assert.equal(annotateVoiceMessages(messages), null)
})

test('attachments travel with the cleaned text', () => {
  const messages = [{
    id: 'm3',
    role: 'user',
    content: [
      { type: 'text', text: '--- # voice\nпосмотри на фото' },
      { type: 'image', attachment: 'img-1' },
    ],
    source: { kind: 'user' },
  }]

  const [cleaned] = annotateVoiceMessages(messages)
  assert.deepEqual(cleaned.content, [
    { type: 'text', text: 'посмотри на фото' },
    { type: 'image', attachment: 'img-1' },
  ])
})

test('a marker with no body is not a voice request and stays untouched', () => {
  const messages = [{
    id: 'm4',
    role: 'user',
    content: [{ type: 'text', text: '--- # voice' }],
    source: { kind: 'user' },
  }]

  // The contract drops empty blocks, so a bare marker carries no transcript to
  // announce; the message is passed through exactly as the channel wrote it.
  assert.equal(annotateVoiceMessages(messages), null)
})

test('install registers the listener globally and the reply contract', async () => {
  const host = stubHost()
  install(host)

  const entry = preStep(host)
  assert.ok(entry, 'agent/pre-step listener must be registered')
  assert.deepEqual(entry.options, { global: true })

  const section = host.sections[0]
  assert.equal(section.name, 'dsh-voice:reply-contract')
  assert.equal(section.order, 119)
  assert.match(section.text, /--- # say/)
  assert.match(section.text, /не пересказывай вопрос/)
})

test('the listener rewrites an enter decision and passes anything else through', async () => {
  const host = stubHost()
  install(host)
  const { listener } = preStep(host)

  const messages = [{
    id: 'm5',
    role: 'user',
    content: [{ type: 'text', text: '--- # voice\nвключи свет' }],
    source: { kind: 'user' },
  }]

  const entered = await listener({ agent: {} }, async () => ({ kind: 'enter', messages }))
  assert.equal(entered.kind, 'enter')
  assert.equal(entered.messages.length, 2)

  const skipped = { kind: 'skip' }
  assert.equal(await listener({ agent: {} }, async () => skipped), skipped)
})

test('a broken message does not cost the turn', async () => {
  const host = stubHost()
  install(host)
  const { listener } = preStep(host)

  const broken = {
    id: 'm6',
    role: 'user',
    get content () { throw new Error('exploded') },
    source: { kind: 'user' },
  }

  const decision = { kind: 'enter', messages: [broken] }
  const result = await listener({ agent: {} }, async () => decision)
  assert.equal(result, decision)
})

test('the notice names only the facts the marker carried', () => {
  assert.match(voiceNotice(null).content[0].text, /пришёл голосом\./)
  const withFacts = voiceNotice({ options: { device: 'pixel', speed: '1.2' } }).content[0].text
  assert.match(withFacts, /устройство: pixel/)
  assert.match(withFacts, /желаемый темп: 1\.2/)
})
