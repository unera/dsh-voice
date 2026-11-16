// Is the committed bundle the one these sources produce?
//
// The host loads `lib/client.js`; nothing rebuilds it on install. A stale bundle
// is a card that runs last week's code while every other test here reads today's
// sources, so the two are compared directly. The check skips itself where esbuild
// is not installed (a bare checkout), and CI installs it.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { bundleClient, root } from '../scripts/build-client.mjs'

const esbuild = await import('esbuild').then(() => true, () => false)

test('lib/client.js is what src/client/ builds into', { skip: !esbuild ? 'esbuild is not installed' : false }, async () => {
  const fresh = await bundleClient(root)
  const committed = await readFile(join(root, 'lib/client.js'), 'utf8')
  assert.equal(committed, fresh, 'run `npm run build` after changing src/client/')
})
