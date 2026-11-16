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

/** A settings controller stand-in: the snapshot a page or the card would read. */
function settingsController (value, { status = 'ready', writable = true } = {}) {
  const listeners = new Set()
  const writes = []
  let snapshot = { status, writable, revision: 7, value }
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe (listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async mutate (ops, revision) {
      writes.push({ ops, revision })
      return true
    },
    publish (next) {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A client context stand-in: slots, locale, effects and the settings service. */
function clientContext (form = settingsController({ speakReplies: false, maxChars: 600 })) {
  const registered = []
  const effects = []
  const dictionaries = []
  const asked = []
  return {
    form,
    asked,
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
    configForms: {
      get (namespace) {
        asked.push(namespace)
        return form
      },
    },
    locale: {
      bind: () => (key) => `t:${key}`,
      register: (ns, id, dictionary) => { dictionaries.push({ ns, id, dictionary }) },
      addLanguage: () => () => {},
    },
  }
}

/** The injected props of one placement, or a failure that names the missing one. */
function faceFor (ctx, name) {
  const page = ctx.registered.find((item) => item.options.name === name)
  assert.ok(page, `the card is registered into ${name}`)
  return page.options.inject()
}

/** Find the first node in the stub element tree that matches. */
function find (node, match) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (match(node)) return node
  return find(node.children ?? [], match)
}

/** The page view, rendered: the view hands off to the page component. */
function pageOf (module, props) {
  const element = module.VoiceSettingsView(props)
  return typeof element.type === 'function' ? element.type(element.props) : element
}

test('the bundle loads and exports the client entry point', async () => {
  const { entry, module } = await loadBundle()
  assert.equal(entry.id, '@dr-co/dsh-voice')
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.VoiceSettingsView, 'function')
  assert.deepEqual(Object.keys(module.DICTIONARIES).sort(), ['en', 'ru', 'zh'])
})

test('mounting registers the card on the bundle page and on the row page', async () => {
  const { module } = await loadBundle()
  const ctx = clientContext()
  module.apply(ctx)

  const row = ctx.registered.find((item) => item.options.name === 'plugins.row.config')
  assert.ok(row, 'the card is registered as the row configuration page')
  assert.equal(row.options.key, '@dr-co/dsh-voice#dsh-voice', 'the key the page addresses the row by')

  // The plugin's own page is the one a person opens first, and its slot hands the
  // entry no form: without this registration the card is reachable only through a
  // row control, and with no form behind it.
  const bundle = ctx.registered.find((item) => item.options.name === 'plugins.bundle.config')
  assert.ok(bundle, 'the card is registered on the plugin page itself')
  assert.equal(bundle.options.key, '@dr-co/dsh-voice', 'a bundle page entry is keyed by the package name')

  for (const page of [row, bundle]) {
    assert.equal(page.options.locale, 'dsh-voice')
    assert.equal(page.view, module.VoiceSettingsView)
    const face = page.options.inject()
    assert.equal(face.t('title'), 't:title', 'the card travels with its translator')
    assert.equal(typeof face.mutateSettings, 'function', 'and with the settings write action')
    assert.equal(typeof face.hooks.voiceSettings.getSnapshot, 'function')
    assert.equal(typeof face.hooks.voiceSettings.subscribe, 'function')
  }

  // All three dictionaries are handed to the locale service, English first.
  assert.deepEqual(ctx.dictionaries.map((item) => item.id), ['en', 'ru', 'zh'])
  for (const item of ctx.dictionaries) assert.equal(item.ns, 'dsh-voice')
})

test('the card takes the row page form when the page hands one', async () => {
  const { module } = await loadBundle()
  const page = settingsController({ speakReplies: false, maxChars: 600 })
  const ctx = clientContext(page)
  module.apply(ctx)
  const face = faceFor(ctx, 'plugins.row.config')
  const owner = { state: { status: 'ready', writable: true, value: { speakReplies: true, maxChars: 250 } }, mutate: () => true }

  const tree = module.VoiceSettingsView({ view: 'summary', form: owner, ...face })
  assert.equal(tree.children.join(''), 't:summary.on', 'the page owns the values it is rendering')
})

test('without an owner form the card still shows its controls from the settings service', async () => {
  const { module } = await loadBundle()
  const settings = settingsController({ speakReplies: true, maxChars: 480 })
  const ctx = clientContext(settings)
  module.apply(ctx)
  const face = faceFor(ctx, 'plugins.bundle.config')

  // Exactly what the Plugins page passes a bundle-config entry: the view, and no form.
  const live = { getSnapshot: face.hooks.voiceSettings.getSnapshot, subscribe: face.hooks.voiceSettings.subscribe }
  const props = {
    view: 'page',
    t: face.t,
    mutateSettings: face.mutateSettings,
    useVoiceSettings: (selector = (snapshot) => snapshot) => selector(live.getSnapshot()),
  }
  const tree = pageOf(module, props)
  assert.notEqual(tree.type, 'p', 'the card is a card, not the "form unavailable" line')

  const box = find(tree, (node) => node.props?.type === 'checkbox')
  assert.ok(box, 'the switch is on the page')
  assert.equal(box.props.checked, true, 'it shows the value the host holds')
  const input = find(tree, (node) => node.props?.type === 'number')
  assert.ok(input, 'the character limit is on the page')
  assert.equal(input.props.value, '480')
  assert.equal(input.props.min, 1)
  assert.equal(input.props.max, 5000)

  // A press writes through the settings service, not into a local copy.
  box.props.onChange({ target: { checked: false } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(settings.writes, [{ ops: [{ op: 'set', path: ['speakReplies'], value: false }], revision: undefined }])
})

test('a host without a settings form says so instead of drawing a dead switch', async () => {
  const { module } = await loadBundle()
  const ctx = clientContext()
  module.apply(ctx)
  const face = faceFor(ctx, 'plugins.bundle.config')

  const tree = pageOf(module, { view: 'page', t: face.t, mutateSettings: face.mutateSettings })
  assert.equal(tree.type, 'p', 'the page says the form is unavailable')
  assert.equal(tree.children.join(''), 't:form.unavailable')
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
