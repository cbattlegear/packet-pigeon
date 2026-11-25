import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('channel actions require a ready radio and disclose unsupported controls', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { ChannelsPanel } = await vite.ssrLoadModule(fileURLToPath(new URL('ChannelsPanel.tsx', import.meta.url)))
    const render = (phase) => renderToStaticMarkup(createElement(ChannelsPanel, {
      snapshot: { phase, device: { publicKey: 'ab'.repeat(32), capabilities: { maxChannels: 8 } },
        channels: [{ index: 0, name: 'Public' }] },
      session: {}, cacheSaving: false, messageSyncing: false, onBlockedSendersChanged() {},
    }))
    const ready = render('ready')
    assert.match(ready, /Public and hashtag keys are discoverable/)
    assert.match(ready, /per-channel region scope are not available yet/)
    assert.match(ready, /Observed sender names/)
    assert.match(ready, /not a membership list/)
    assert.match(ready, /Names can be impersonated or changed/)
    assert.match(ready, /<button type="submit">Save channel<\/button>/)
    assert.match(render('idle'), /<button type="submit" disabled="">Save channel<\/button>/)
  } finally { await vite.close() }
})
