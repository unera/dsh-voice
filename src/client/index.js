// Client half of @dr-co/dsh-voice: the settings card of the spoken reply.
//
// It is a real client plugin, not a script injected into the page: the package
// declares `dsh.client` in package.json, the host loads `lib/client.js` and calls
// `apply(ctx)`, and everything below is a slot registration through the public
// registry.
//
// One contribution: `plugins.row.config`, keyed by this bundle and the row it
// declares. That is the configuration page of the plugin under Settings →
// Plugins → @dr-co/dsh-voice, and the page hands the card its own form — the two
// editable fields are volatile configuration, so the settings service already
// knows how to read and write them. The card never keeps a copy of a value it
// could disagree with the Host about.

import { VoiceSettingsPage, VoiceSettingsView } from './card.js'
import { DICTIONARIES, NS } from './locales.js'

export { DICTIONARIES, NS, VoiceSettingsPage, VoiceSettingsView }
export {
  LIMIT_DEFAULT, LIMIT_FIELD, LIMIT_MAX, LIMIT_MIN, SPEAK_FIELD,
  availabilityOf, availabilityText, format, limitDraft, parseLimit, readValues, summaryLine, switchDisabled,
} from './card.js'

/** The key the Plugins page addresses this configuration by. */
export const SECTION_KEY = '@dr-co/dsh-voice#dsh-voice'

/** Order among the rows' configuration pages; no neighbour is close. */
export const SECTION_ORDER = 40

// Declared, not grabbed: without this the host refuses the property access itself
// ("cannot get property \"locale\" without inject") and the card never mounts.
export const inject = ['slots', 'locale']

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

  safeMount(ctx, 'plugins.row.config', () => {
    ctx.slots.inject('plugins.row.config', () =>
      ctx.slots.register(
        {
          name: 'plugins.row.config',
          key: SECTION_KEY,
          order: SECTION_ORDER,
          // Without `locale` the host does not inject `t` and the card draws keys.
          locale: NS,
          label: () => t('title'),
          // The bound translate function travels with the entry: the page passes
          // owner props only, and a card that renders keys is a card nobody read.
          inject: () => ({ t }),
        },
        VoiceSettingsView,
      ),
    )
  })
}
