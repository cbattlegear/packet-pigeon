import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('channel browsing is compact and radio actions require a ready radio', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { ChannelsPanel } = await vite.ssrLoadModule(fileURLToPath(new URL('ChannelsPanel.tsx', import.meta.url)))
    const render = (phase) => renderToStaticMarkup(createElement(ChannelsPanel, {
      snapshot: { phase, device: { publicKey: 'ab'.repeat(32), capabilities: { maxChannels: 8 } },
        channels: [{ index: 0, name: 'Public' }] },
      session: {}, cacheSaving: false, messageSyncing: false, onBlockedSendersChanged() {},
    }))
    const ready = render('ready')
    assert.match(ready, /aria-label="Actions for Public" aria-haspopup="menu"/)
    assert.match(ready, /0\/8 slots|1\/8 slots/)
    assert.doesNotMatch(ready, /<form|<dialog|Public and hashtag keys|sender&apos;s clock|Sending scopes are/)
    assert.match(ready, /class="channel-primary" type="button">Add channel<\/button>/)
    assert.match(render('idle'), /class="channel-primary" type="button" disabled="">Add channel<\/button>/)
    assert.match(render('idle'), /Select a saved radio or connect one/)
  } finally { await vite.close() }
})
