// The README is the only description of where a recording may live, and it was wrong once in a
// way that cost a live run. A promise like that is checked here, cheaply, instead of in production.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const doc = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('the README says who writes each directory and who removes it', () => {
  assert.match(doc, /<cacheDir>\/incoming\/<any layout>/, 'the tree dsh-nodes uploads into')
  assert.match(doc, /<cacheDir>\/work\/<run>\/<id>/, 'the copy the loop reads')
  assert.match(doc, /immediately after copying it/, 'the original is removed once the copy exists')
  assert.match(doc, /right after it has been read/, 'and the copy once it has been recognized')
  assert.match(doc, /nothing below `incoming\/` is swept/, 'the other plugin\'s tree is not ours to sweep')
  assert.doesNotMatch(doc, /`keepRecording`/, 'the retention setting is gone, not just renamed')
  assert.doesNotMatch(doc, /answered `already`/, 'and so is the deduplication')
})

test('the README measures the leftover of a run by files, not by directories', () => {
  assert.match(doc, /every file older than an hour goes/, 'the sweep is described by the age of the files')
  assert.match(doc, /directories it leaves empty/, 'and the directories it leaves empty are described too')
})
