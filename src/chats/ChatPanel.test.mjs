import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

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
    assert.doesNotMatch(button(render('ready', 'usb'), 'Sync messages'), /\bdisabled\b/)
    assert.doesNotMatch(button(render('ready', 'bluetooth', { pending: true }), 'Retry saving and sync'), /\bdisabled\b/)
    assert.match(button(render('ready', 'bluetooth', { syncing: true }), 'Syncing messages…'), /\bdisabled\b/)
    assert.match(button(render('idle', null), 'Sync messages'), /\bdisabled\b/)
    assert.doesNotMatch(button(render('idle', null, { pending: true }), 'Retry saving'), /\bdisabled\b/)
  } finally {
    await vite.close()
  }
})
