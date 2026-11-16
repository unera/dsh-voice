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
//   of the plugin's own page — the page a person opens first. The owner passes no
//   form to that slot, so the card reads the settings service itself.
// - `plugins.row.config`, keyed by this package and the row it declares, renders
//   the same card as the row's configuration page; that slot does hand a form over.
//
// Either way the values come from the settings service: `speakReplies` and
// `maxChars` are volatile configuration, and the card never keeps a copy of a
// value it could disagree with the Host about.

import { VoiceSettingsPage, VoiceSettingsView } from './card.js'
import { DICTIONARIES, NS } from './locales.js'

export { DICTIONARIES, NS, VoiceSettingsPage, VoiceSettingsView }
export {
  LIMIT_DEFAULT, LIMIT_FIELD, LIMIT_MAX, LIMIT_MIN, SPEAK_FIELD,
  availabilityOf, availabilityText, formFromProps, format, limitDraft, parseLimit, readValues, summaryLine,
  switchDisabled,
} from './card.js'

/** The Loader entry id of this plugin — and therefore its settings namespace. */
export const SETTINGS_NAMESPACE = 'dsh-voice'

/** The key of the row's configuration page: `<package name>#<row id>`. */
export const SECTION_KEY = '@dr-co/dsh-voice#dsh-voice'

/**
 * The key of the section on the plugin's own page: the package name.
 *
 * This is the placement a person reaches without hunting for a row control, and
 * the Plugins page renders it whenever this package is configured — which it is,
 * as soon as this client bundle is mounted.
 */
export const BUNDLE_SECTION_KEY = '@dr-co/dsh-voice'

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

/**
 * What the card is handed besides the page's owner props.
 *
 * `t` travels with the entry: the page passes owner props only, and a card that
 * renders keys is a card nobody read.
 *
 * `hooks`/`mutateSettings` are the settings service's own form, read live. A row
 * page hands the entry `{state, mutate}` and that is preferred; a bundle page
 * hands nothing at all, so without this the card had no values to show and could
 * only say "the form is unavailable". The controller is fetched per call because
 * the card mounts before the settings mirror has finished loading.
 *
 * @param ctx - client root context with the `configForms` service.
 * @param t - the bound translate function.
 * @returns the injected props of one placement.
 */
function cardFace (ctx, t) {
  const form = () => ctx.configForms.get(SETTINGS_NAMESPACE)
  return {
    t,
    mutateSettings: (ops, revision) => form().mutate(ops, revision),
    hooks: {
      voiceSettings: {
        getSnapshot: () => form().getSnapshot(),
        subscribe: (listener) => form().subscribe(listener),
      },
    },
  }
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
    // eslint-disable-next-line no-console
    console.warn(`[dsh-voice] ${label} не смонтирован: ${error?.message ?? error}`)
    return false
  }
}

/**
 * Client plugin entry.
 *
 * @param ctx - client root context: `slots`, `locale`, `effect`.
 * @returns nothing; failures are reported and the rest still mounts.
 */
export function apply (ctx) {
  let t = (key) => key
  try {
    t = ctx.locale.bind(NS)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[dsh-voice] locale недоступна, показываю ключи: ${error?.message ?? error}`)
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

  // One face, built once: the renderer caches its hook by source identity, and a
  // fresh object per render would resubscribe the card on every paint.
  const face = cardFace(ctx, t)

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
            inject: () => face,
          },
          VoiceSettingsView,
        ),
      )
    })
  }
}
