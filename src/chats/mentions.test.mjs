import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelMentionNames, channelReply, channelTextParts, insertChannelMention, mentionableName } from './mentions.ts'

function contact(name, type = 1) {
  return { name, details: { type } }
}

function received(name, index = 1, textType = 0) {
  return {
    receipt: { kind: 'channel-text', channelIndex: index, textType, text: `${name}: hello` },
  }
}

test('offers unique saved contacts and observed senders from the selected channel', () => {
  const contacts = [contact('Alice'), contact('Alice'), contact('Charlie'), contact('Repeater', 2), contact('Bad]name')]
  const messages = [received('Bob'), received('Alice'), received('Other', 2), received('Other', 1, 1), received('Bad[name')]
  assert.deepEqual(channelMentionNames(contacts, messages, 1), ['Alice', 'Bad[name', 'Bob', 'Charlie'])
  assert.equal(mentionableName('A]B'), false)
  assert.equal(mentionableName('A[B'), true)
  assert.equal(mentionableName(''), false)
})

test('recognizes complete mentions without changing malformed text', () => {
  assert.deepEqual(channelTextParts('Hi @[Alice] and @[Bøb]!'), [
    { kind: 'text', text: 'Hi ' },
    { kind: 'mention', name: 'Alice' },
    { kind: 'text', text: ' and ' },
    { kind: 'mention', name: 'Bøb' },
    { kind: 'text', text: '!' },
  ])
  assert.deepEqual(channelTextParts('@[A[B]'), [{ kind: 'mention', name: 'A[B' }])
  for (const text of ['@[unfinished', '@[]', '@[line\nbreak]']) {
    assert.deepEqual(channelTextParts(text), [{ kind: 'text', text }])
  }
})

test('replies preserve the draft and quote the message without its leading mention', () => {
  assert.equal(channelReply('Bob', '@[Alice] hello from Bob', 'Existing draft'),
    '@[Bob]\n>hello from..\nExisting draft')
  assert.equal(channelReply('A[B', 'hello', ''), '@[A[B]\n>hello\n')
  const emoji = '👩🏽‍🚀'
  assert.equal(channelReply('Bøb', `${emoji.repeat(10)}x`, ''), `@[Bøb]\n>${emoji.repeat(10)}..\n`)
  assert.throws(() => channelReply('Bad]name', 'hello', ''), /cannot be represented/)
})

test('flattens multiline previews while preserving the draft and truncation', () => {
  for (const separator of ['\n', '\r\n', '\r', '\t', '\u000b', '\u000c', '\u0085', '\u00a0', '\u2028', '\u2029']) {
    assert.equal(channelReply('Bob', `No${separator}Yes`, 'My\nresponse'), '@[Bob]\n>No Yes\nMy\nresponse')
  }
  assert.equal(channelReply('Bob', '12345\n67890', 'draft'), '@[Bob]\n>12345 6789..\ndraft')
})

test('inserts a mention at the selection and replaces an unfinished query at the caret', () => {
  assert.deepEqual(insertChannelMention('Meet @Bo later', 'Bob', 8, 8),
    { text: 'Meet @[Bob] later', cursor: 12 })
  assert.deepEqual(insertChannelMention('Hi friend', 'Bob', 3, 9),
    { text: 'Hi @[Bob] ', cursor: 10 })
  assert.deepEqual(insertChannelMention('mail@host', 'Bob', 9, 9),
    { text: 'mail@host @[Bob] ', cursor: 17 })
  assert.deepEqual(insertChannelMention('@[partial', 'Bob', 9, 9),
    { text: '@[partial @[Bob] ', cursor: 17 })
  assert.throws(() => insertChannelMention('', 'Bad]name', 0, 0), /cannot be represented/)
})
