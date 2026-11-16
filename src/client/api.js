// Talking to this plugin's own host route. No state, no cache: the card asks,
// the host answers, and a refusal surfaces as text instead of a silent panel.
//
// The route rides the Host's authenticated `/api` channel, which is why a plain
// same-origin fetch is enough: the owner's cookie travels on its own and no token
// is kept in the browser.

/** Where the plugin's route lives, under the authenticated prefix. */
export const BASE = '/api/voice'

/**
 * Ask the host whether it has a synthesizer.
 *
 * @returns `{textToSpeech}`; throws with the host's sentence when the route
 *   answers an error.
 */
export async function getState () {
  const response = await fetch(`${BASE}/state`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const error = new Error(parsed?.error ?? `${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  return parsed ?? {}
}
