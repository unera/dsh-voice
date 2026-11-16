// The README is the only description of where a recording may live, and it was wrong in a way
// that cost a live run: it promised the per-run layout for both upload paths while `dsh-nodes`
// writes the flat one. A promise like that is checked here, cheaply, instead of in production.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const doc = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('the README names both upload layouts and who creates each', () => {
  assert.match(doc, /<cacheDir>\/incoming\/<run>\/<node>\//,
    'the per-run layout the loop writes on the pull path')
  assert.match(doc, /<cacheDir>\/incoming\/<node>\//,
    'the flat layout dsh-nodes writes on the push path')
  assert.match(doc, /`dsh-nodes`, on the push path/,
    'and it says which of the two the host writes: dsh-nodes knows nothing about the run id')
  assert.doesNotMatch(doc, /Both paths put the take under/,
    'both paths do not write to the same directory any more')
})

test('the README measures the leftover of a run by files, not by directories', () => {
  assert.match(doc, /removes every file older than an hour/,
    'the boot cleanup is described by the age of the files')
  assert.match(doc, /left empty/,
    'and the directories it leaves empty are described too')
})
