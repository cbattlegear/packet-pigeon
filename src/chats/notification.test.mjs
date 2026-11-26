import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageAlert } from './notification.ts'

const receipt = {
  kind: 'channel-text', receiptId: 'one', channelIndex: 0, textType: 0,
  senderTimestamp: 12, text: 'Alice: hello @[Pigeon]', pathLength: 0, snrDb: null,
}
const message = { id: 'one', conversationId: 'channel:0', sender: '', timestamp: 12000, text: receipt.text, receipt }
const data = { contacts: [], channels: [{ index: 0, name: 'Public' }], messages: [message], drafts: [], preferences: null }

test('channel modes match mentions without regard to case and suppress blocked senders', () => {
  const withMode = (mode) => ({ ...data, channelNotifications: [{ index: 0, channelName: 'Public', mode }] })
  assert.equal(messageAlert(withMode('all'), message, 'Pigeon').conversationId, 'channel:0')
  assert.equal(messageAlert(withMode('muted'), message, 'Pigeon'), null)
  assert.equal(messageAlert(withMode('mentions'), message, 'Pigeon').title, 'Public')
  assert.equal(messageAlert(withMode('mentions'), message, 'pigeon').title, 'Public')
  assert.equal(messageAlert(withMode('mentions'), message, 'Pígeon'), null)
  assert.equal(messageAlert({ ...data, blockedChannelSenders: ['Alice'] }, message, 'Pigeon'), null)
  assert.equal(messageAlert({ ...data, channelNotifications: [{ index: 0, channelName: 'Old', mode: 'all' }] }, message, 'Pigeon'), null)
})

test('a mention in the sender prefix is not a mention in the body', () => {
  const text = '@[Pigeon]: hello'
  const entry = { ...message, text, receipt: { ...receipt, text } }
  const cached = { ...data, messages: [entry], channelNotifications: [{ index: 0, channelName: 'Public', mode: 'mentions' }] }
  assert.equal(messageAlert(cached, entry, 'Pigeon'), null)
  const bodyText = '@[Pigeon]: hello @[pigeon]'
  const mentioned = { ...entry, text: bodyText, receipt: { ...receipt, text: bodyText } }
  assert.equal(messageAlert({ ...cached, messages: [mentioned] }, mentioned, 'Pigeon').title, 'Public')
})

test('read and possible-repeat receipts do not alert, but a distinct receipt does', () => {
  assert.equal(messageAlert({ ...data, readMessages: ['one'] }, message, 'Pigeon'), null)
  const repeat = { ...message, id: 'two', receipt: { ...receipt, receiptId: 'two' } }
  assert.equal(messageAlert({ ...data, messages: [message, repeat] }, repeat, 'Pigeon'), null)
  const distinct = { ...repeat, receipt: { ...repeat.receipt, senderTimestamp: 13 } }
  assert.equal(messageAlert({ ...data, messages: [message, distinct] }, distinct, 'Pigeon').title, 'Public')
})

test('direct mute follows the sender prefix when contact attribution changes', () => {
  const key = '010203040506' + 'ab'.repeat(26)
  const directReceipt = {
    kind: 'direct-text', receiptId: 'dm', senderKeyPrefix: '010203040506', signatureHex: null,
    textType: 0, senderTimestamp: 12, text: 'hello', pathLength: 0, snrDb: null,
  }
  const direct = { id: 'dm', conversationId: 'direct:010203040506', sender: '010203040506',
    timestamp: 12000, text: 'hello', receipt: directReceipt }
  const withDirect = { ...data, messages: [direct], contacts: [{ publicKey: key, name: 'Friend' }],
    mutedDirectConversations: ['direct:010203040506'] }
  assert.equal(messageAlert(withDirect, direct, ''), null)
  assert.equal(messageAlert({ ...withDirect, mutedDirectConversations: [] }, direct, '').conversationId, `direct:${key}`)
})

test('CLI replies do not create message notifications', () => {
  const key = 'bc'.repeat(32)
  const directReceipt = {
    kind: 'direct-text', receiptId: 'cli', senderKeyPrefix: key.slice(0, 12), signatureHex: null,
    textType: 1, senderTimestamp: 12, text: 'AB|> Relay', pathLength: 0, snrDb: null,
  }
  const entry = { id: 'cli', conversationId: `direct:${key.slice(0, 12)}`, sender: key.slice(0, 12),
    timestamp: 12000, text: directReceipt.text, receipt: directReceipt }
  assert.equal(messageAlert({ ...data, contacts: [{ publicKey: key, name: 'Relay' }], messages: [entry] }, entry, ''), null)
})
