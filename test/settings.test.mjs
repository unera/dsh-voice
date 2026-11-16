// The knobs of the spoken reply, and the shape the Loader hands them over in.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_MAX_CHARS } from '../structure.mjs'
import { normalizeReplySettings, unwrapVolatile } from '../settings.mjs'

test('a volatile field arrives as a live accessor and is read through it', () => {
  // The Loader hands a `.volatile()` field over as `{ get(), [volatile.write]() }`,
  // not as the value. Comparing that object with `true` is always false, and that
  // is exactly how a switch saved as on read as off everywhere else.
  const mute = { get: () => true }
  const limit = { get: () => 321 }
  const settings = normalizeReplySettings({ mute, maxChars: limit })
  assert.equal(settings.mute, true)
  assert.equal(settings.maxChars, 321)
})

test('an accessor that cannot answer is an unset field, not a crash', () => {
  const broken = { get: () => { throw new Error('стор недоступен') } }
  const settings = normalizeReplySettings({ mute: broken, maxChars: broken })
  assert.equal(settings.mute, false)
  assert.equal(settings.maxChars, DEFAULT_MAX_CHARS)
})

test('a plain value is still a plain value', () => {
  assert.equal(unwrapVolatile(true), true)
  assert.equal(unwrapVolatile(42), 42)
  assert.equal(unwrapVolatile(null), null)
  // An object that is not an accessor is returned as it is: the caller decides.
  assert.deepEqual(unwrapVolatile({ value: 1 }), { value: 1 })
  const settings = normalizeReplySettings({ mute: true, maxChars: 600 })
  assert.equal(settings.mute, true)
  assert.equal(settings.maxChars, 600)
})
