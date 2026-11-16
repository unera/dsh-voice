// The settings card's behaviour, and the promise that all three languages say the
// same thing.
//
// No React tree and no browser: `model.js` holds every decision as a plain
// function, and the bundle is checked as text for the two things that only exist
// after the build — the registration key and the disabled switch.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  LIMIT_DEFAULT, LIMIT_MAX, LIMIT_MIN, SPEAK_FIELD, LIMIT_FIELD,
  availabilityOf, availabilityText, formFromProps, format, limitDraft, parseLimit, readValues, summaryLine,
  switchDisabled,
} from '../src/client/model.js'
import { DICTIONARIES } from '../src/client/locales.js'
import { DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT } from '../structure.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const t = (key) => key

/** A form snapshot as the Plugins page passes it. */
function formWith (value, { status = 'ready', writable = true } = {}) {
  return { state: { status, value, writable, base: undefined, user: undefined, revision: 3 }, mutate: async () => true }
}

test('every language carries the same keys', () => {
  const keys = Object.keys(DICTIONARIES.en).sort()
  for (const [id, dictionary] of Object.entries(DICTIONARIES)) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys, `${id} has the same key set`)
    for (const key of keys) {
      assert.equal(typeof dictionary[key], 'string', `${id}.${key} is text`)
      assert.notEqual(dictionary[key].trim(), '', `${id}.${key} is not empty`)
    }
  }
  assert.equal(Object.keys(DICTIONARIES).sort().join(','), 'en,ru,zh')
})

test('the card limits are the ones the Host enforces', () => {
  assert.equal(LIMIT_DEFAULT, DEFAULT_MAX_CHARS)
  assert.equal(LIMIT_MAX, MAX_CHARS_LIMIT)
  assert.equal(LIMIT_MIN, 1)
})

test('the form values are read with the schema default behind them', () => {
  const ready = readValues(formWith({ [SPEAK_FIELD]: true, [LIMIT_FIELD]: 250 }))
  assert.deepEqual(ready, { status: 'ready', writable: true, known: true, speakReplies: true, maxChars: 250 })

  // Nothing accepted yet, or a host that cannot answer: the card shows nothing
  // to edit rather than a guess.
  assert.equal(readValues(formWith(undefined, { status: 'loading' })).known, false)
  assert.equal(readValues(null).known, false)
  assert.equal(readValues(formWith(undefined)).known, true)
  assert.equal(readValues(formWith(undefined)).maxChars, LIMIT_DEFAULT)
  assert.equal(readValues(formWith({ [LIMIT_FIELD]: 99_999 })).maxChars, LIMIT_DEFAULT, 'a value outside the range falls back')
  assert.equal(readValues(formWith({ [SPEAK_FIELD]: false })).speakReplies, false)
})

test('the limit input is read in three distinct ways', () => {
  assert.deepEqual(parseLimit('600'), { ok: true, value: 600 })
  assert.deepEqual(parseLimit('  1 '), { ok: true, value: 1 })
  assert.deepEqual(parseLimit(String(LIMIT_MAX)), { ok: true, value: LIMIT_MAX })
  assert.deepEqual(parseLimit(''), { ok: false, code: 'empty' })
  assert.deepEqual(parseLimit('   '), { ok: false, code: 'empty' })
  assert.deepEqual(parseLimit('6.5'), { ok: false, code: 'not-integer' })
  assert.deepEqual(parseLimit('шесть'), { ok: false, code: 'not-integer' })
  assert.deepEqual(parseLimit('-1'), { ok: false, code: 'not-integer' })
  assert.deepEqual(parseLimit('0'), { ok: false, code: 'range' })
  assert.deepEqual(parseLimit(String(LIMIT_MAX + 1)), { ok: false, code: 'range' })
  assert.equal(limitDraft(250), '250')
})

test('a host without a synthesizer makes the switch inactive, not silent', () => {
  assert.deepEqual(availabilityOf({ textToSpeech: true }), { known: true, canSpeak: true, code: 'ok' })
  assert.deepEqual(availabilityOf({ textToSpeech: false }), { known: true, canSpeak: false, code: 'no-synth' })
  assert.deepEqual(availabilityOf(null), { known: false, canSpeak: false, code: 'checking' })
  assert.deepEqual(availabilityOf({ error: 'нет связи' }), { known: false, canSpeak: false, code: 'failed' })
  // ...and it says why, in the language on screen.
  assert.equal(availabilityText(t, { code: 'ok' }), '')
  assert.equal(availabilityText(t, { code: 'no-synth' }), 'availability.noSynth')
  assert.equal(availabilityText(t, { code: 'failed' }), 'availability.failed')
  assert.equal(availabilityText(t, { code: 'checking' }), 'availability.checking')
  for (const id of ['en', 'ru', 'zh']) {
    assert.notEqual(DICTIONARIES[id]['availability.noSynth'].trim(), '', `${id} explains the missing synthesizer`)
  }
})

test('the switch is disabled for both reasons, and only those', () => {
  const writable = readValues(formWith({ [SPEAK_FIELD]: false }, { writable: true }))
  const readOnly = readValues(formWith({ [SPEAK_FIELD]: false }, { writable: false }))
  assert.equal(switchDisabled(writable, { textToSpeech: true }), false)
  assert.equal(switchDisabled(writable, { textToSpeech: false }), true, 'no synthesizer, no switch')
  assert.equal(switchDisabled(writable, null), true, 'the check has not answered yet')
  assert.equal(switchDisabled(readOnly, { textToSpeech: true }), true, 'a host that refuses writes')
})

test('the summary line says the state and the limit', () => {
  assert.equal(summaryLine(t, { known: true, speakReplies: false, maxChars: 600 }), 'summary.off')
  assert.equal(summaryLine(t, { known: true, speakReplies: true, maxChars: 250 }), 'summary.on')
  assert.equal(summaryLine(t, { known: false, speakReplies: true, maxChars: 250 }), 'summary.unknown')
  assert.equal(format(t, 'summary.on', { limit: 250 }), 'summary.on', 'a key without holes is unchanged')
  assert.equal(format((key) => `до ${'{limit}'}`, 'summary.on', { limit: 250 }), 'до 250')
  assert.equal(format((key) => `x ${'{missing}'} y`, 'k', {}), 'x {missing} y')
})

test('formFromProps: the page form wins, the registered scope is the fallback, none is none', () => {
  const owner = { state: { status: 'ready', writable: true, value: { speakReplies: true, maxChars: 200 } }, mutate: () => 'owner' }
  const snapshot = { status: 'ready', writable: true, value: { speakReplies: false, maxChars: 600 } }
  const writes = []
  const scope = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: (...ops) => { writes.push(ops); return 'settings' } }

  assert.equal(formFromProps({ form: owner, scope }, snapshot), owner, 'a row page form is preferred')
  const fallback = formFromProps({ scope }, snapshot)
  assert.equal(fallback.state, snapshot, 'a bundle page reads the live snapshot')
  assert.equal(fallback.mutate([{ op: 'set', path: ['speakReplies'], value: true }]), 'settings', 'writes go to the settings service')
  assert.deepEqual(writes, [[[{ op: 'set', path: ['speakReplies'], value: true }], undefined]], 'and carry no revision of their own')
  assert.equal(formFromProps({}, snapshot), null, 'no page form and no scope is no form')
  assert.equal(formFromProps({ scope }, undefined), null, 'a scope without a snapshot is no form')
  assert.equal(formFromProps({ scope: { getSnapshot: () => snapshot } }, snapshot), null, 'a scope with no write action is no form')
  assert.equal(formFromProps({ form: { state: snapshot } }, undefined), null, 'a form object with no write action is no form')
})

test('the bundle registers the plugin’s own page and keeps the disabled switch', async () => {
  const bundle = await readFile(join(root, 'lib/client.js'), 'utf8')
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{/u)
  assert.match(bundle, /id: "@dr-co\/dsh-voice"/u)
  assert.match(bundle, /plugins\.row\.config/u)
  // The row key is package plus row id, spelled from the two constants rather than
  // typed twice: a literal here would drift from the package name.
  assert.match(bundle, /var PACKAGE = "@dr-co\/dsh-voice"/u)
  assert.ok(bundle.includes('var SECTION_KEY = `${PACKAGE}#${ENTRY}`'), 'the row key is built from the package and the entry id')
  // The decision itself, not a hardcoded attribute: a disabled switch that never
  // consults the availability has no reason to exist.
  assert.match(bundle, /switchDisabled/u)

  // Both placements, as data: the plugin's page (keyed by the package) and its row
  // page (keyed by package and row id).
  assert.match(bundle, /plugins\.bundle\.config/u)
  assert.match(bundle, /var BUNDLE_SECTION_KEY = PACKAGE/u)
  const source = await readFile(join(root, 'src/client/index.js'), 'utf8')
  assert.match(source, /\['plugins\.bundle\.config', BUNDLE_SECTION_KEY\]/u)
  assert.match(source, /\['plugins\.row\.config', SECTION_KEY\]/u)
  assert.match(source, /locale: NS/u)
})

test('the card asks the route the plugin actually mounts', async () => {
  const { BASE_PATH } = await import('../routes.mjs')
  const source = await readFile(join(root, 'src/client/api.js'), 'utf8')
  assert.ok(source.includes(`'${BASE_PATH}'`), `api.js must use ${BASE_PATH}`)
  assert.ok(source.includes('${BASE}/state'), 'the request goes to the state route')
  const bundle = await readFile(join(root, 'lib/client.js'), 'utf8')
  assert.ok(bundle.includes(`"${BASE_PATH}"`), 'the bundle carries the same path')
})
