// The built bundle, loaded the way the page loads it.
//
// A client bundle is a script that calls `window.__ModuleLoader__.load(...)`; this
// test stands in for that loader and for `react`, so "the package ships a client
// half that mounts and renders" is checked without a browser. It proves the file
// in `lib/` is the one the host will fetch, and that the registration carries the
// key the Plugins page addresses this plugin by.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** The two React powers the card uses, reduced to plain data. */
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: () => {},
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** Load `lib/client.js` and return its exports. */
async function loadBundle () {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  let entry = null
  const window = { __ModuleLoader__: { load: (loaded) => { entry = loaded } } }
  const require = (name) => {
    if (name === 'react') return react
    throw new Error(`the bundle asked for a module the page does not seed: ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  assert.ok(entry, 'the bundle registered a factory')
  return { entry, module: entry.factory(require) }
}

/** A client context stand-in: slots, locale and effects, nothing else. */
function clientContext () {
  const registered = []
  const effects = []
  const dictionaries = []
  return {
    registered,
    effects,
    dictionaries,
    effect (run, label) {
      effects.push(label)
      const dispose = run()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    slots: {
      inject (name, run) { return run() },
      register (options, view) {
        registered.push({ options, view })
        return () => {}
      },
    },
    locale: {
      bind: () => (key) => `t:${key}`,
      register: (ns, id, dictionary) => { dictionaries.push({ ns, id, dictionary }) },
      addLanguage: () => () => {},
    },
  }
}

test('the bundle loads and exports the client entry point', async () => {
  const { entry, module } = await loadBundle()
  assert.equal(entry.id, '@dr-co/dsh-voice')
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.VoiceSettingsView, 'function')
  assert.deepEqual(Object.keys(module.DICTIONARIES).sort(), ['en', 'ru', 'zh'])
})

test('mounting registers one configuration page, keyed by package and row', async () => {
  const { module } = await loadBundle()
  const ctx = clientContext()
  module.apply(ctx)

  const page = ctx.registered.find((item) => item.options.name === 'plugins.row.config')
  assert.ok(page, 'the card is registered into the Plugins page')
  assert.equal(page.options.key, '@dr-co/dsh-voice#dsh-voice', 'the key the page addresses the row by')
  assert.equal(page.options.locale, 'dsh-voice')
  assert.equal(page.view, module.VoiceSettingsView)
  assert.deepEqual(Object.keys(page.options.inject()), ['t'], 'the card travels with its translator')
  assert.equal(page.options.inject().t('title'), 't:title')

  // All three dictionaries are handed to the locale service, English first.
  assert.deepEqual(ctx.dictionaries.map((item) => item.id), ['en', 'ru', 'zh'])
  for (const item of ctx.dictionaries) assert.equal(item.ns, 'dsh-voice')
})

test('the summary view renders the state the form holds', async () => {
  const { module } = await loadBundle()
  const t = (key) => `t:${key}`
  const form = (value) => ({ state: { status: 'ready', value, writable: true }, mutate: async () => true })

  // The summary is one inline element whose only child is the line.
  const line = (form) => module.VoiceSettingsView({ view: 'summary', form, t }).children.join('')

  assert.equal(line(form({ speakReplies: false, maxChars: 600 })), 't:summary.off')
  assert.equal(line(form({ speakReplies: true, maxChars: 250 })), 't:summary.on')
  // A form the page could not read says so instead of claiming a state.
  assert.equal(line({ state: { status: 'loading' } }), 't:summary.unknown')
})
