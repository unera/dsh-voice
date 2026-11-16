// The settings card's one HTTP channel.
//
// The card needs a single fact the browser cannot see for itself: whether this
// Host has a synthesizer at all. Without one the "speak replies" switch must be
// inactive and say why — a switch that saves a setting nothing can honour is
// worse than a switch that explains itself.
//
// Values are not carried here. The two editable fields are volatile
// configuration, so the Plugins page hands the card its own form and writes
// through the settings service; a second writer with its own copy of the rules
// is exactly how a settings page starts disagreeing with the code.
//
// The route rides the Host's authenticated `/api` channel (`ctx.connection.fetch`),
// the same way `@dr-co/dsh-text-to-speech` mounts its card's routes: a bare path on
// the web server would answer the whole internet.

/** Where the card's channel lives, under the authenticated `/api` prefix. */
export const BASE_PATH = '/api/voice'

/**
 * The facts the card reads before it draws anything.
 *
 * @param options.textToSpeech - the service, or null when the Host has none.
 * @returns `{textToSpeech}`: whether a reply could actually be spoken here.
 */
export function voiceState ({ textToSpeech = null } = {}) {
  const usable = typeof textToSpeech?.synthesize === 'function' && typeof textToSpeech?.resolve === 'function'
  return { textToSpeech: usable }
}

/** A JSON reply with the headers a settings panel wants. */
function json (status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Mount the route.
 *
 * @param connection - `ctx.connection`, whose `fetch.register` the host provides
 *   for plugins that answer their own paths.
 * @param read - returns the state, read at request time so a service that mounts
 *   later is seen without a restart.
 * @returns the disposers of every registered route (empty when the Host has no
 *   such seam, which is a Host old enough to have no settings pages either).
 */
export function registerVoiceRoutes (connection, read = () => voiceState()) {
  if (typeof connection?.fetch?.register !== 'function') return []
  return [connection.fetch.register({
    path: `${BASE_PATH}/state`,
    methods: ['GET'],
    fetch: async () => {
      try {
        return json(200, read())
      } catch (error) {
        return json(500, { error: String(error?.message ?? error), code: 'VOICE_STATE_FAILED' })
      }
    },
  })]
}
