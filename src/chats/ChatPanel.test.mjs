import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { defaultPreferences } from '../preferences/appPreferences.ts'
import { correlateChannelObservations, matchingChannelReceipts, messageVisibility } from './model.ts'

function channelReceipt(id, changes = {}) {
  const receipt = {
    kind: 'channel-text', receiptId: id, channelIndex: 1, senderTimestamp: 123,
    textType: 0, text: 'Alice: hello', pathLength: 1, snrDb: 2, ...changes,
  }
  return { id, receipt, conversationId: `channel:${receipt.channelIndex}`, sender: '', timestamp: 123000, text: receipt.text }
}

test('matches channel receipts without losing them or conflating distinct content', () => {
  const first = channelReceipt('first')
  const second = channelReceipt('second', { pathLength: 0xff, snrDb: null })
  const third = channelReceipt('third', { pathLength: 0x42 })
  const others = [
    channelReceipt('channel', { channelIndex: 2 }),
    channelReceipt('time', { senderTimestamp: 124 }),
    channelReceipt('type', { textType: 1 }),
    channelReceipt('text', { text: 'Alice: other' }),
  ]
  const messages = [first, second, third, ...others]
  const matches = matchingChannelReceipts(messages)
  assert.deepEqual(matches.get('first').map(({ id }) => id), ['first', 'second', 'third'])
  assert.deepEqual(matches.get('third').map(({ id }) => id), ['first', 'second', 'third'])
  for (const other of others) assert.equal(matches.has(other.id), false)
  assert.deepEqual(messageVisibility(messages, true).visible.map(({ id }) => id),
    ['first', 'channel', 'time', 'type', 'text'])
  assert.equal(messages.length, 7)
})

test('correlates live observations by exact fields and flags ambiguous saved messages', () => {
  const first = channelReceipt('first')
  const duplicate = channelReceipt('duplicate')
  const different = channelReceipt('different', { senderTimestamp: 124 })
  const outgoing = {
    id: 'outgoing', conversationId: 'channel:1', text: 'hello',
    channelOutgoing: { senderName: 'Alice', wireTimestamp: 123 },
  }
  const observed = [{ id: 1, timestamp: 123, textType: 0, text: 'Alice: hello' }]
  const matches = correlateChannelObservations(1, [first, duplicate, different, outgoing], observed)
  assert.equal(matches.get('first').matchingMessages, 3)
  assert.equal(matches.get('duplicate').matchingMessages, 3)
  assert.equal(matches.get('outgoing').matchingMessages, 3)
  assert.equal(matches.has('different'), false)
  assert.equal(correlateChannelObservations(2, [first, outgoing], observed).size, 0)
  assert.equal(correlateChannelObservations(1, [first], [{ ...observed[0], text: 'Alice: other' }]).size, 0)
  assert.equal(correlateChannelObservations(1, [first], [{ ...observed[0], textType: 1 }]).size, 0)
})

test('renders matching receipt details without claiming delivery', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { ChatPanel } = await vite.ssrLoadModule(fileURLToPath(new URL('ChatPanel.tsx', import.meta.url)))
    const key = 'ab'.repeat(32)
    const messages = [
      channelReceipt('first'), channelReceipt('second', { pathLength: 0xff, snrDb: null }),
      channelReceipt('brackets', { text: 'Bad]name: hello' }),
    ]
    const render = (pathMetadata) => renderToStaticMarkup(createElement(ChatPanel, {
      snapshot: { phase: 'ready', transport: 'usb', device: { publicKey: key, name: 'Me', type: 1 }, channels: [] },
      messageSync: {}, messageStatus: {}, direct: { draft: () => '' },
      status: { key, data: { contacts: [], channels: [{ index: 1, name: 'Test' }], messages, drafts: [], preferences: null } },
      cacheSaving: false, active: true, preferences: { ...defaultPreferences, pathMetadata }, locale: 'en',
    }))
    const html = render(true)
    assert.match(html, /2 matching queued receipts \(possible repeats\)/)
    assert.match(html, /may not queue every heard copy/)
    assert.match(html, /1 path hop · 1-byte path hashes/)
    assert.match(html, /Direct receipt/)
    assert.match(html, /Reply unavailable: the sender name contains a closing bracket/)
    assert.doesNotMatch(html, /aria-label="Reply to Bad\]name"/)
    assert.doesNotMatch(html, />Delivered</)
    assert.doesNotMatch(render(false), /1 path hop · 1-byte path hashes/)
  } finally {
    await vite.close()
  }
})

test('enables manual Bluetooth sync and preserves offline receipt retry', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { ChatPanel } = await vite.ssrLoadModule(fileURLToPath(new URL('ChatPanel.tsx', import.meta.url)))
    const render = (phase, transport, { pending = false, syncing = false } = {}) => (
      renderToStaticMarkup(createElement(ChatPanel, {
        snapshot: { phase, transport, device: { publicKey: 'ab'.repeat(32) } },
        messageSync: {},
        messageStatus: { pending, syncing },
        direct: {},
        status: { key: null },
        cacheSaving: false,
        active: true,
        preferences: defaultPreferences,
        locale: 'en',
      }))
    )
    const button = (html, label) => {
      const match = html.match(new RegExp(`<button\\b([^>]*)>${label}</button>`))
      assert.ok(match, `Missing ${label} button`)
      return match[1]
    }

    const bluetooth = render('ready', 'bluetooth')
    assert.doesNotMatch(button(bluetooth, 'Sync messages'), /\bdisabled\b/)
    assert.match(bluetooth, /Bluetooth may truncate or drop messages/)
    assert.match(bluetooth, /The radio removes each message from its queue before replying, so missing content cannot be recovered from the radio\./)
    assert.doesNotMatch(button(render('ready', 'usb'), 'Sync messages'), /\bdisabled\b/)
    assert.doesNotMatch(button(render('ready', 'bluetooth', { pending: true }), 'Retry saving and sync'), /\bdisabled\b/)
    assert.match(button(render('ready', 'bluetooth', { syncing: true }), 'Syncing messages…'), /\bdisabled\b/)
    assert.match(button(render('idle', null), 'Sync messages'), /\bdisabled\b/)
    assert.doesNotMatch(button(render('idle', null, { pending: true }), 'Retry saving'), /\bdisabled\b/)
  } finally {
    await vite.close()
  }
})
