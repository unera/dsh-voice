// Client half of @dr-co/dsh-voice: the settings card of the spoken reply.
//
// It is a real client plugin, not a script injected into the page: the package
// declares `dsh.client` in package.json, the host loads `lib/client.js` and calls
// `apply(ctx)`, and everything below is a slot registration through the public
// registry.
//
// One card, two placements, both on Settings → Plugins → @dr-co/dsh-voice:
//
// - `plugins.bundle.config`, keyed by this package, renders the card as a section
//   of the plugin's own page — the page a person opens first.
// - `plugins.row.config`, keyed by this package and the row it declares, renders
//   the same card as the row's configuration page.
//
// The settings form is the host's own: `configForms.get(entry)` is read ONCE, at
// mount, and the resulting controller travels to the card as the `scope` prop —
// the same shape `@dr-co/dsh-graceful-restart` uses. The card subscribes to it
// with `useSyncExternalStore` and never keeps a copy of a value it could disagree
// with the host about. A page that hands the entry its own owner form still wins:
// that form is the one the host is rendering.
//
// Nothing here may fail silently. Every early return writes a `[dsh-voice]` line
// to the browser console naming the reason: a card that does not appear must be a
// sentence in the console rather than an absence nobody can explain.

import { VoiceSettingsPage, VoiceSettingsView } from './card.js'
import { DICTIONARIES, NS } from './locales.js'

export { DICTIONARIES, NS, VoiceSettingsPage, VoiceSettingsView }
export {
  LIMIT_DEFAULT, LIMIT_FIELD, LIMIT_MAX, LIMIT_MIN, SPEAK_FIELD,
  availabilityOf, availabilityText, formFromProps, format, limitDraft, parseLimit, readValues, summaryLine,
  switchDisabled,
} from './card.js'

/** The npm package name: the key a bundle's own page addresses this plugin by. */
export const PACKAGE = '@dr-co/dsh-voice'

/**
 * The Loader entry id of this plugin — the id the settings service knows it by,
 * and therefore the id whose form the card reads.
 */
export const ENTRY = 'dsh-voice'

/** The settings namespace of this plugin: where its keys live in the document. */
export const SETTINGS_NAMESPACE = ENTRY

/** The key of the row's configuration page: `<package name>#<row id>`. */
export const SECTION_KEY = `${PACKAGE}#${ENTRY}`

/**
 * The key of the section on the plugin's own page: the package name.
 *
 * This is the placement a person reaches without hunting for a row control, and
 * the Plugins page renders it whenever this package is configured — which it is,
 * as soon as this client bundle is mounted.
 */
export const BUNDLE_SECTION_KEY = PACKAGE

/** Order among the rows' configuration pages; no neighbour is close. */
export const SECTION_ORDER = 40

/**
 * Where the card is registered: the plugin's own page first, then its row's page.
 *
 * Both cells point at the same settings namespace, so the person sees one set of
 * values whichever page they reached.
 */
const PLACEMENTS = [
  ['plugins.bundle.config', BUNDLE_SECTION_KEY],
  ['plugins.row.config', SECTION_KEY],
]

/** Every line this module writes starts with the plugin's name. */
function say (message, detail) {
  // eslint-disable-next-line no-console
  console.warn(`[dsh-voice] ${message}`, ...(detail === undefined ? [] : [detail]))
}

// Declared, not grabbed: without this the host refuses the property access itself
// ("cannot get property \"locale\" without inject") and the card never mounts.
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount one contribution; a failure is reported and the rest still mount.
 *
 * An exception escaping `apply` marks the whole client bundle as failed, which on
 * this host shows up as a plugin that did not load rather than as a card that did
 * not appear.
 *
 * @param ctx - client root context.
 * @param label - what is being mounted, for the warning.
 * @param run - the mounting itself.
 * @returns whether it mounted.
 */
function safeMount (ctx, label, run) {
  try {
    run()
    return true
  } catch (error) {
    say(`${label} не смонтирован: ${error?.message ?? error}`)
    return false
  }
}

/**
 * Read the settings form of this plugin, once, at mount.
 *
 * A host without the settings service, an id the service does not know, and a
 * controller that cannot be subscribed to are three different failures, and each
 * one has its own sentence: the person reading the console should not have to
 * guess which one happened.
 *
 * @param ctx - client root context.
 * @returns the controller, or `null` when the card cannot be built here.
 */
function readScope (ctx) {
  let scope = null
  try {
    scope = ctx.configForms.get(ENTRY)
  } catch (error) {
    say(`configForms.get('${ENTRY}') упал: ${error?.message ?? error}`)
    return null
  }
  if (!scope) {
    say(`configForms.get('${ENTRY}') вернул пусто: форма настроек этого плагина не найдена`)
    return null
  }
  const missing = ['getSnapshot', 'subscribe'].filter((name) => typeof scope[name] !== 'function')
  if (missing.length > 0) {
    say(`форма настроек '${ENTRY}' не годится в стор: нет ${missing.join(', ')}`)
    return null
  }
  return scope
}

/**
 * Client plugin entry.
 *
 * @param ctx - client root context: `slots`, `locale`, `effect`.
 * @returns nothing; failures are reported and the rest still mounts.
 */
export function apply (ctx) {
  // The first line of the trace: seeing it in the console means the host loaded
  // this bundle and called `apply`, so a missing card is a later failure.
  say('client apply: старт', {
    package: PACKAGE,
    entry: ENTRY,
    services: ['slots', 'locale', 'configForms'].filter((name) => ctx?.[name] !== undefined),
  })

  let t = (key) => key
  try {
    t = ctx.locale.bind(NS)
  } catch (error) {
    say(`locale недоступна, показываю ключи: ${error?.message ?? error}`)
  }

  safeMount(ctx, 'dictionaries', () => {
    ctx.effect(() => {
      ctx.locale.register(NS, 'en', DICTIONARIES.en)
      ctx.locale.register(NS, 'ru', DICTIONARIES.ru)
      ctx.locale.register(NS, 'zh', DICTIONARIES.zh)
      return () => {}
    }, 'dsh-voice: dictionaries')
  })

  // Another plugin may have registered a language first; the registry throws on a
  // duplicate id, and that must not take this card down with it.
  for (const [id, label] of [['ru', 'Русский'], ['zh', '中文']]) {
    safeMount(ctx, `${id} language`, () => {
      ctx.effect(() => {
        try {
          return ctx.locale.addLanguage({ id, label, fallback: 'en' })
        } catch (error) {
          if (!/already/i.test(String(error?.message ?? error))) throw error
          return () => {}
        }
      }, `dsh-voice: ${id} language`)
    })
  }

  if (typeof ctx?.slots?.inject !== 'function' || typeof ctx.slots.register !== 'function') {
    say('слоты недоступны: ctx.slots.inject/register отсутствуют, карточка не зарегистрирована')
    return
  }

  const scope = readScope(ctx)
  if (!scope) return

  for (const [name, key] of PLACEMENTS) {
    safeMount(ctx, name, () => {
      ctx.slots.inject(name, () =>
        ctx.slots.register(
          {
            name,
            key,
            order: SECTION_ORDER,
            // Without `locale` the host does not inject `t` and the card draws keys.
            locale: NS,
            label: () => t('title'),
            // The store travels as one prop, read once above: the card owns no
            // path back to the settings service and cannot ask for a form twice.
            inject: () => ({ t, scope }),
          },
          VoiceSettingsView,
        ),
      )
      say(`карточка зарегистрирована: ${name} key=${key}`)
    })
  }
}
