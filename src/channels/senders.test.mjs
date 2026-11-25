import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelSender, isBlockedChannelMessage, observedChannelSenders, validSenderName } from './senders.ts'

function message(id, index, text, overrides = {}) {
  return {
    id, conversationId: `channel:${index}`, sender: '', timestamp: 1000, text,
    receipt: {
      kind: 'channel-text', receiptId: id, channelIndex: index, textType: 0,
      senderTimestamp: 1, pathLength: 0, snrDb: null, text, ...overrides,
    },
  }
}

test('extracts only recognizable channel sender prefixes and matches names exactly', () => {
  const alice = message('a', 1, 'Alice: hello: world')
  assert.equal(channelSender(alice), 'Alice')
  assert.equal(channelSender(message('b', 1, 'No sender prefix')), null)
  assert.equal(channelSender(message('c', 1, ': empty')), null)
  assert.equal(channelSender(message('d', 1, 'Alice\nBob: hello')), null)
  assert.equal(channelSender(message('e', 1, `${'📡'.repeat(8)}: hello`)), null)
  assert.equal(channelSender(message('f', 1, 'Alice: hello', { textType: 1 })), null)
  assert.equal(channelSender(message('g', 1, 'Alice: hello', { kind: 'channel-data' })), null)
  assert.equal(isBlockedChannelMessage(alice, new Set(['alice'])), false)
  assert.equal(isBlockedChannelMessage(alice, new Set(['Alice'])), true)
  assert.equal(validSenderName('Alice: Bob'), false)
  assert.equal(validSenderName('  '), false)
})

test('observed names count receipts only within the selected channel', () => {
  const records = [
    message('1', 0, 'Alice: first'),
    message('2', 0, 'Alice: second'),
    message('3', 0, 'Bob: hi'),
    message('4', 1, 'Alice: another channel'),
    message('5', 0, 'unrecognized'),
    message('6', 0, 'Bob: data', { kind: 'channel-data' }),
  ]
  assert.deepEqual(observedChannelSenders(records, 0), [
    { name: 'Alice', count: 2 }, { name: 'Bob', count: 1 },
  ])
  assert.deepEqual(observedChannelSenders(records, 1), [{ name: 'Alice', count: 1 }])
})
