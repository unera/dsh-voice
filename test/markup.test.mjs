import assert from 'node:assert/strict'
import test from 'node:test'

import { parseMarkerOptions, readVoiceMarkup, splitReply, splitVoiceMarkers } from '../markup.mjs'

test('a message with no marker is all plain text', () => {
  const split = splitVoiceMarkers('включи свет в коридоре')
  assert.deepEqual(split.blocks, [])
  assert.equal(split.plain, 'включи свет в коридоре')
})

test('one voice block leaves the rest as plain text', () => {
  const split = splitVoiceMarkers('--- # voice\nвключи свет\n')
  assert.equal(split.blocks.length, 1)
  assert.equal(split.blocks[0].kind, 'voice')
  assert.equal(split.blocks[0].text, 'включи свет')
  assert.equal(split.plain, '')
})

test('several blocks keep their order and their bodies', () => {
  const split = splitVoiceMarkers('шум\n--- # voice\nпервое\n\n--- # screen\nвторое\n')
  assert.equal(split.plain, 'шум')
  assert.deepEqual(split.blocks.map((block) => block.kind), ['voice', 'screen'])
  assert.deepEqual(split.blocks.map((block) => block.text), ['первое', 'второе'])
})

test('the marker tail carries options, case-insensitively', () => {
  const options = parseMarkerOptions(' device=pixel SPEED=1.2 note="две трети"')
  assert.deepEqual(options, { device: 'pixel', speed: '1.2', note: 'две трети' })
})

test('a bare --- is not a marker', () => {
  const text = 'первый абзац\n\n---\n\nвторой абзац'
  const split = splitVoiceMarkers(text)
  assert.deepEqual(split.blocks, [])
  assert.equal(split.plain, text)
})

test('a table separator is not a marker either', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  assert.deepEqual(splitVoiceMarkers(text).blocks, [])
})

test('markers inside a closed code fence are ignored', () => {
  const text = ['```md', '--- # say', 'не маркер', '```', '--- # say', 'это маркер'].join('\n')
  const split = splitVoiceMarkers(text)
  assert.equal(split.blocks.length, 1)
  assert.equal(split.blocks[0].text, 'это маркер')
})

test('an unfinished fence swallows the rest instead of arming the parser', () => {
  const text = ['```md', '--- # say', 'текст без закрытия'].join('\n')
  assert.deepEqual(splitVoiceMarkers(text).blocks, [])
})

test('empty blocks are dropped', () => {
  const split = splitVoiceMarkers('--- # say\n\n--- # screen\nтекст')
  assert.equal(split.blocks.length, 1)
  assert.equal(split.blocks[0].kind, 'screen')
})

test('splitReply: no marker means the whole reply is spoken and shown', () => {
  const reply = splitReply('Свет включил, в коридоре горит.')
  assert.equal(reply.speak, 'Свет включил, в коридоре горит.')
  assert.equal(reply.screen, 'Свет включил, в коридоре горит.')
})

test('splitReply: say and screen are separated', () => {
  const reply = splitReply('--- # say\nСвет включил.\n--- # screen\nЛампа горела 40 минут.')
  assert.equal(reply.speak, 'Свет включил.')
  assert.equal(reply.screen, 'Лампа горела 40 минут.')
  assert.deepEqual(reply.parts.map((part) => part.role), ['speak', 'screen'])
})

test('splitReply: voice is an alias of say, text of screen', () => {
  const reply = splitReply('--- # voice\nКоротко.\n--- # text\nПодробно.')
  assert.equal(reply.speak, 'Коротко.')
  assert.equal(reply.screen, 'Подробно.')
})

test('splitReply: an unlabeled first document is spoken and shown, later ones shown only', () => {
  const reply = splitReply('Привет.\n--- # screen\nДетали.\n--- # screen\nЕщё детали.')
  assert.equal(reply.speak, 'Привет.')
  assert.equal(reply.screen, 'Привет.\n\nДетали.\n\nЕщё детали.')
})

test('splitReply: a reply that names only its spoken part is still shown', () => {
  const reply = splitReply('--- # say\nСвет включил.')
  assert.equal(reply.speak, 'Свет включил.')
  assert.equal(reply.screen, 'Свет включил.')
})

test('readVoiceMarkup returns the user words and the marker options', () => {
  const read = readVoiceMarkup('--- # voice device=pixel speed=1.2\nвключи свет\n')
  assert.equal(read.text, 'включи свет')
  assert.deepEqual(read.voice.options, { device: 'pixel', speed: '1.2' })
})

test('readVoiceMarkup leaves a typed message alone', () => {
  const read = readVoiceMarkup('включи свет')
  assert.equal(read.voice, null)
  assert.equal(read.text, 'включи свет')
})

test('readVoiceMarkup keeps text that follows the transcript', () => {
  const read = readVoiceMarkup('--- # voice\nвключи свет\n--- # screen\nв кухне\n')
  assert.equal(read.text, 'включи свет\n\nв кухне')
})
