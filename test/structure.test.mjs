// The protocol itself: three markers, two parts, and no guesses.
//
// Every case here is a shape of answer the model may write; the parser either
// reads it as a spoken document or says, in one word, why it does not. The
// refusal reasons are part of the contract — they are what the log shows when a
// reply arrives without sound.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT, charCount, parseVoiceDocument, replyContract } from '../structure.mjs'

const valid = '---\n\nГотово, всё поднялось.\n\n---\n\nСервис поднят, порт 8080.'

test('a well-formed document gives both parts, spoken first', () => {
  assert.deepEqual(parseVoiceDocument(valid), {
    ok: true,
    reason: 'ok',
    spoken: 'Готово, всё поднялось.',
    rest: 'Сервис поднят, порт 8080.',
  })
})

test('the first and the last non-empty line may sit below blank lines', () => {
  const padded = `\n\n  \n${valid}\n\n  \n`
  assert.deepEqual(parseVoiceDocument(padded), parseVoiceDocument(valid))
})

test('CRLF line endings are a line ending, not a format deviation', () => {
  const crlf = valid.replaceAll('\n', '\r\n')
  const parsed = parseVoiceDocument(crlf)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.spoken, 'Готово, всё поднялось.')
  // ...and nothing of the CR survives into what is spoken.
  assert.equal(parsed.spoken.includes('\r'), false)
})

test('the spoken part keeps its own line breaks and loses only outer space', () => {
  const parsed = parseVoiceDocument('---\n\n  Первая строка.\n\nВторая строка.  \n\n---\nхвост')
  assert.equal(parsed.spoken, 'Первая строка.\n\nВторая строка.')
})

test('without markers the answer is not a document', () => {
  assert.deepEqual(parseVoiceDocument('Готово, всё поднялось.\n\n---\n\nДетали.'), {
    ok: false, reason: 'not-a-document', spoken: '', rest: '',
  })
})

test('a word or a fence above the marker breaks the format', () => {
  // Strictness is the point: "похоже" is not the protocol.
  assert.equal(parseVoiceDocument('Ответ:\n---\nт\n---\nр').reason, 'not-a-document')
  assert.equal(parseVoiceDocument('```\n---\nт\n---\nр\n...\n```').reason, 'not-a-document')
})

test('the markers must be exactly the markers', () => {
  // Trailing space, extra dashes, a heading: all deviations, all AS IS.
  assert.equal(parseVoiceDocument('--- \nт\n---\nр').reason, 'not-a-document')
  assert.equal(parseVoiceDocument('----\nт\n---\nр').reason, 'not-a-document')
  assert.equal(parseVoiceDocument('--- # say\nт\n---\nр').reason, 'not-a-document')
  assert.equal(parseVoiceDocument('---\nт\n--- \nр').reason, 'one-marker')
  // No closing marker exists in the format, so trailing prose is just the rest.
  assert.equal(parseVoiceDocument('---\nт\n---\nр\n......').ok, true)
})

test('one separator instead of two is refused with its own reason', () => {
  assert.equal(parseVoiceDocument('---\nт\nр').reason, 'one-marker')
})

test('a third separator is refused, not read as a nested document', () => {
  assert.equal(parseVoiceDocument('---\nт\n---\nр\n---\nещё').reason, 'extra-marker')
})

test('a document needs no closing marker, and trailing dots are just text', () => {
  // YAML's `...` promised a following document that never comes; two markers say
  // exactly what is true. Anything after them belongs to the part without sound.
  const withoutEnd = parseVoiceDocument('---\nт\n---\nр')
  assert.equal(withoutEnd.ok, true)
  assert.equal(withoutEnd.spoken, 'т')
  assert.equal(withoutEnd.rest, 'р')
  assert.equal(parseVoiceDocument('---\nт\n---\nр\n..').rest, 'р\n..')
})

test('an empty or blank part makes the document invalid', () => {
  assert.equal(parseVoiceDocument('---\n\n  \n---\nр').reason, 'empty-spoken')
  assert.equal(parseVoiceDocument('---\nт\n---\n\n   ').reason, 'empty-rest')
  // Nothing may follow the separator: `...` used to close a document and is now
  // ordinary text, so it is a real (unwanted) second part, not an empty one.
  assert.equal(parseVoiceDocument('---\nт\n---\n...').rest, '...')
})

test('an empty answer is not a document either', () => {
  assert.equal(parseVoiceDocument('').reason, 'no-answer')
  assert.equal(parseVoiceDocument('   \n\n').reason, 'no-answer')
  assert.equal(parseVoiceDocument(null).reason, 'no-answer')
})

test('charCount counts characters: Cyrillic and emoji are one each', () => {
  assert.equal(charCount(''), 0)
  assert.equal(charCount('abc'), 3)
  assert.equal(charCount('привет'), 6)
  // Two UTF-16 units, one character — and six bytes in UTF-8.
  assert.equal(charCount('😀'), 1)
  assert.equal(charCount('а'.repeat(600)), 600)
  assert.equal(Buffer.byteLength('а'.repeat(600), 'utf8'), 1200, 'the same text is 1200 bytes')
})

test('the prompt section states the format and the configured limit', () => {
  const text = replyContract({ maxChars: 321 })
  assert.match(text, /^## Ответ голосом$/mu)
  assert.match(text, /^---$/mu)
  assert.doesNotMatch(text, /^\.\.\.$/mu, 'no closing marker in the format')
  assert.match(text, /321/u)
  assert.match(text, /как есть/u)
  assert.equal(replyContract().includes(String(DEFAULT_MAX_CHARS)), true)
  assert.equal(MAX_CHARS_LIMIT > DEFAULT_MAX_CHARS, true)
})
