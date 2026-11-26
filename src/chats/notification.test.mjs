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

test('routes room posts and sensor alerts and leaves management replies quiet', () => {
  const room = 'ab'.repeat(32)
  const sensor = 'cd'.repeat(32)
  const contacts = [{ publicKey: room, name: 'Room', details: { type: 3 } },
    { publicKey: sensor, name: 'Sensor', details: { type: 4 } }]
  const entry = (publicKey, id, textType) => {
    const prefix = publicKey.slice(0, 12)
    return { id, conversationId: `direct:${prefix}`, sender: prefix, timestamp: 13_000, text: id,
      receipt: { kind: 'direct-text', receiptId: id, senderKeyPrefix: prefix, signatureHex: textType === 2 ? 'fedcba98' : null,
        textType, senderTimestamp: 13, text: id, pathLength: 0, snrDb: null } }
  }
  const post = entry(room, 'Room post', 2)
  const alert = entry(sensor, 'Sensor alert', 0)
  const reply = entry(room, 'Room management', 1)
  const cached = { ...data, contacts, messages: [post, alert, reply] }
  assert.deepEqual(messageAlert(cached, post, ''), { conversationId: `direct:${room}`, title: 'Room' })
  assert.deepEqual(messageAlert(cached, alert, ''), { conversationId: `direct:${sensor}`, title: 'Sensor' })
  assert.equal(messageAlert(cached, reply, ''), null)
  assert.equal(messageAlert({ ...cached, mutedDirectConversations: [`direct:${room.slice(0, 12)}`] }, post, ''), null)
})
