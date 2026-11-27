import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

async function mount(page, seed = true) {
  await page.evaluate(async (seed) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js')
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { ChatPanel } = await import('/src/chats/ChatPanel.tsx')
    const { DirectMessages } = await import('/src/integration/direct-messages.ts')
    const { expectedDirectAck } = await import('/src/radio/direct-message.ts')
    const { buildReaction } = await import('/src/radio/reactions.ts')
    const { defaultPreferences } = await import('/src/preferences/appPreferences.ts')
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const radio = 'ab'.repeat(32)
    const peer = '01'.repeat(32)
    const key = radioKeyFromPublicKey(radio)
    const storage = await openRadioStorage()
    const stamp = 1704067200
    const receipt = (id, text, channel = true) => ({
      id, conversationId: channel ? 'channel:1' : `direct:${peer}`, sender: '', text, timestamp: stamp * 1000,
      receipt: { kind: channel ? 'channel-text' : 'direct-text', receiptId: id, textType: 0, senderTimestamp: stamp,
        text, pathLength: 255, snrDb: null,
        ...(channel ? { channelIndex: 1 } : { senderKeyPrefix: peer.slice(0, 12), signatureHex: null }) },
    })
    try {
      if (seed) await storage.update(key, {
        contacts: [{ publicKey: peer, name: 'Friend', details: { type: 1 } }],
        channels: [{ index: 1, name: 'Public' }], preferences: { selectedConversationId: 'channel:1' },
        draft: { conversationId: 'channel:1', text: 'My unfinished draft' },
        messages: [
          receipt('channel-target', 'Alice: ok'), receipt('dm-target', 'ok', false),
          receipt('incoming', `Bob: ${await buildReaction('👍', 'ok', stamp, 'Alice')}`),
          receipt('pending', `Bob: ${await buildReaction('🔥', 'later', stamp, 'Alice')}`),
        ],
      })
    } finally { storage.close() }
    const listeners = new Set()
    const pushes = new Set()
    let snapshot = {
      phase: 'ready', transport: 'usb', device: { publicKey: radio, name: 'Pigeon', capabilities: { firmwareProtocolVersion: 14 } },
      channels: [{ index: 1, name: 'Public' }],
    }
    window.reactionSends = []
    const source = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      subscribeToPushes: (listener) => { pushes.add(listener); return () => pushes.delete(listener) },
      async sendChannel(...args) { window.reactionSends.push(args) },
      async sendDirect(sender, target, timestamp, attempt, text) {
        const code = await expectedDirectAck(sender, timestamp, attempt, text)
        window.reactionSends.push([sender, target, timestamp, attempt, text])
        setTimeout(() => {
          const payload = new Uint8Array(8)
          payload.set(Uint8Array.from(code.match(/../g), (hex) => parseInt(hex, 16)))
          new DataView(payload.buffer).setUint32(4, 10, true)
          for (const listener of pushes) listener({ code: 0x82, payload })
        }, 10)
        return { route: 'direct', expectedAck: code, timeoutMs: 1000 }
      },
      async resetDirectPath() {},
    }
    const direct = new DirectMessages(source)
    await direct.load(key)
    document.getElementById('root').hidden = true
    const element = document.createElement('div')
    element.id = 'reaction-fixture'
    document.body.append(element)
    const root = createRoot(element)
    const render = () => root.render(React.createElement(Fixture))
    window.reactionFixture = {
      async addPendingTarget() {
        const storage = await openRadioStorage()
        try { await storage.update(key, { messages: [receipt('later', 'Alice: later')] }) }
        finally { storage.close() }
        await direct.load(key)
      },
      disconnect() {
        snapshot = { ...snapshot, phase: 'idle' }
        for (const listener of listeners) listener()
        render()
      },
    }
    function Fixture() {
      const status = React.useSyncExternalStore(direct.subscribe, direct.getSnapshot)
      return React.createElement(ChatPanel, {
        snapshot, direct, status, messageSync: {}, messageStatus: { syncing: false, pending: false },
        cacheSaving: false, active: true, preferences: defaultPreferences, locale: 'en',
      })
    }
    render()
  }, seed)
}

test('reaction actions are keyboard-accessible, preserve drafts/context actions, and persist with targets', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } })
  page.setDefaultTimeout(8000)
  await page.goto(server.resolvedUrls.local[0] + '#chats')
  await mount(page)
  const fixture = page.locator('#reaction-fixture')
  const channel = fixture.getByRole('region', { name: 'Conversation with Public' })
  const target = channel.locator('[data-receipt-id="channel-target"]')
  await target.getByRole('group', { name: 'Message reactions' }).getByText('👍 1', { exact: true }).waitFor()
  const react = target.getByRole('button', { name: 'React to message: ok', exact: true })
  await react.focus()
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', { name: 'React to message' })
  await picker.waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await react.evaluate((button) => button === document.activeElement), true)
  await target.click({ button: 'right' })
  const menu = page.getByRole('group', { name: 'Channel message context actions' })
  await menu.getByRole('button', { name: 'Reply to Alice' }).waitFor()
  await menu.getByRole('button', { name: 'React to message: ok' }).click()
  await picker.getByLabel('Other emoji').fill('👍👍')
  await picker.getByText('Enter exactly one emoji.', { exact: true }).waitFor()
  assert.equal(await picker.getByRole('button', { name: 'Send reaction', exact: true }).isDisabled(), true)
  await picker.getByRole('button', { name: 'React with Heart', exact: true }).focus()
  await page.keyboard.press('Enter')
  await picker.waitFor({ state: 'detached' })
  await target.getByRole('group', { name: 'Message reactions' }).getByText('❤️ 1', { exact: true }).waitFor()
  assert.equal(await channel.getByLabel('Message', { exact: true }).inputValue(), 'My unfinished draft')
  assert.equal((await page.evaluate(() => window.reactionSends))[0][5], '@[Alice]❤️\nzgya0xt2')
  await page.evaluate(() => window.reactionFixture.addPendingTarget())
  await channel.locator('[data-receipt-id="later"]').getByText('🔥 1', { exact: true }).waitFor()
  await fixture.getByLabel('New chat').selectOption(`direct:${'01'.repeat(32)}`)
  const dm = fixture.getByRole('region', { name: 'Conversation with Friend' })
  await dm.getByLabel('Message', { exact: true }).fill('Private unfinished draft')
  await dm.locator('[data-receipt-id="dm-target"]').getByRole('button', { name: 'React to message: ok' }).click()
  await page.setViewportSize({ width: 480, height: 800 })
  await picker.getByLabel('Other emoji').fill('👍🏽')
  assert.ok(await picker.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth))
  await picker.getByRole('button', { name: 'Send reaction', exact: true }).click()
  await picker.waitFor({ state: 'detached' })
  await dm.getByText('Delivered', { exact: true }).waitFor()
  await dm.locator('[data-receipt-id="dm-target"]').getByText('👍🏽 1', { exact: true }).waitFor()
  assert.equal(await dm.getByLabel('Message', { exact: true }).inputValue(), 'Private unfinished draft')
  assert.equal((await page.evaluate(() => window.reactionSends))[1][4], '👍🏽\nzgya0xt2')
  await page.reload()
  await mount(page, false)
  await fixture.getByLabel('New chat').selectOption(`direct:${'01'.repeat(32)}`)
  await dm.locator('[data-receipt-id="dm-target"]').getByText('👍🏽 1', { exact: true }).waitFor()
  assert.equal(await dm.getByLabel('Message', { exact: true }).inputValue(), 'Private unfinished draft')
  await dm.locator('[data-receipt-id="dm-target"]').getByRole('button', { name: 'React to message: ok' }).click()
  await page.evaluate(() => window.reactionFixture.disconnect())
  await picker.getByText('Connect this radio and finish pending actions before reacting.').waitFor()
  assert.equal(await picker.getByRole('button', { name: 'React with Thumbs up' }).isDisabled(), true)
  assert.equal((await page.evaluate(() => window.reactionSends)).length, 0)
})
