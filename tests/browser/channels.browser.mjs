import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const radio = 'ab'.repeat(32)
let server
let browser
let url

before(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  await server.listen()
  url = server.resolvedUrls.local[0]
  browser = await chromium.launch({ channel: 'chrome' })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

async function seed(page) {
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        channels: [{ index: 0, name: 'Public' }, { index: 1, name: '#mesh' }, { index: 2, name: 'Field team' }],
        channelRetention: { index: 0, channelName: 'Public', days: null },
        channelScope: { index: 0, channelName: 'Public', scope: { mode: 'region', name: '#north', key: 'cd'.repeat(16) } },
        messages: [{ id: 'alice', conversationId: 'channel:0', sender: '', timestamp: 0, text: 'Alice: Hello',
          receipt: { kind: 'channel-text', receiptId: 'alice', channelIndex: 0, textType: 0,
            senderTimestamp: 0, text: 'Alice: Hello', pathLength: 0, snrDb: 0 } }],
      })
    } finally { storage.close() }
  }, radio)
}

async function read(page) {
  return page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return await storage.read(radioKeyFromPublicKey(radio)) }
    finally { storage.close() }
  }, radio)
}

async function offline(page) {
  await page.goto(`${url}#channels`)
  await seed(page)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByRole('button', { name: 'Actions for Public', exact: true }).waitFor()
}

test('compact browsing, accessible menus and local settings preserve saved values', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  await offline(page)
  assert.equal(await page.locator('.channel-row').count(), 3)
  assert.equal(await page.locator('.channel-row form').count(), 0)
  const actions = page.getByRole('button', { name: 'Actions for Public', exact: true })
  await actions.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu')
  assert(await menu.getByRole('menuitem', { name: 'Rename', exact: true }).isDisabled())
  assert(await menu.getByRole('menuitem', { name: 'Delete channel', exact: true }).isDisabled())
  assert(await menu.getByRole('menuitem', { name: 'Share link or QR code' }).isDisabled())
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Settings')
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Sender names')
  await page.keyboard.press('Escape')
  assert(await actions.evaluate((node) => document.activeElement === node))
  await page.locator('.channel-row').first().click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Public · Settings' })
  const retention = settings.getByRole('combobox', { name: 'Message retention for Public' })
  assert.equal(await retention.inputValue(), 'forever')
  assert.equal(await settings.getByRole('textbox', { name: 'Region name for Public' }).inputValue(), '#north')
  page.once('dialog', (dialog) => void dialog.dismiss())
  await retention.selectOption('7')
  assert.equal(await retention.inputValue(), 'forever')
  assert.equal((await read(page)).channelRetention[0]?.days ?? null, null)
  page.once('dialog', (dialog) => void dialog.accept())
  await retention.selectOption('7')
  await settings.getByRole('status').filter({ hasText: 'Retention saved' }).waitFor()
  await settings.getByRole('combobox', { name: 'Browser alerts for Public' }).selectOption('muted')
  await settings.getByRole('status').getByText('Alerts saved.', { exact: true }).waitFor()
  await settings.getByRole('button', { name: 'Save sending scope' }).click()
  await settings.getByRole('status').getByText('Sending scope saved locally.', { exact: true }).waitFor()
  const saved = await read(page)
  assert.equal(saved.channelRetention[0].days, 7)
  assert.equal(saved.channelNotifications[0].mode, 'muted')
  assert.equal(saved.channelScopes[0].scope.key, 'cd'.repeat(16))
  assert.equal(saved.messages.length, 1)
  await page.keyboard.press('Escape')
  assert(await actions.evaluate((node) => document.activeElement === node))
  await actions.click()
  await menu.getByRole('menuitem', { name: 'Sender names' }).click()
  const senders = page.getByRole('dialog', { name: 'Public · Sender names' })
  await senders.getByRole('button', { name: 'Block sender name Alice' }).click()
  await senders.getByRole('button', { name: 'Unblock sender name Alice' }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Blocked names (1)' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Unblock sender name Alice' }).click()
  await page.getByRole('dialog').getByText('No blocked names.', { exact: true }).waitFor()
  assert.deepEqual((await read(page)).blockedChannelSenders, [])
  await page.keyboard.press('Escape')
  await page.getByRole('searchbox', { name: 'Search channels' }).fill('nothing')
  await page.getByText('No matching channels.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Clear search' }).click()
  assert.equal(await page.locator('.channel-row').count(), 3)
  await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('name')
  assert.deepEqual(await page.locator('.channel-identity strong').allTextContents(), ['#mesh', 'Field team', 'Public'])
})

test('touch-sized menu alternative and dialogs fit a narrow window', async (t) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  t.after(() => context.close())
  const page = await context.newPage()
  await offline(page)
  await page.getByRole('button', { name: 'Actions for Public', exact: true }).tap()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).tap()
  const dialog = page.getByRole('dialog')
  assert(await dialog.isVisible())
  const bounds = await dialog.boundingBox()
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await dialog.getByRole('combobox', { name: 'Browser alerts for Public' }).click({ button: 'right' })
  assert.equal(await page.getByRole('menu').count(), 0)
  await dialog.getByRole('button', { name: 'Close', exact: true }).tap()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.setViewportSize({ width: 390, height: 560 })
  await page.getByRole('button', { name: 'Actions for Field team' }).tap()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const menuBounds = await page.getByRole('menu').boundingBox()
  assert(menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 560)
})

test('ready-radio actions require confirmation, preserve rename hooks, and report failures', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  await page.route(`${url}channel-fixture`, async (route) => route.fulfill({
    contentType: 'text/html', body: await server.transformIndexHtml('/channel-fixture', '<html><head></head><body><div id="fixture"></div></body></html>'),
  }))
  await page.goto(`${url}channel-fixture`)
  await seed(page)
  await page.evaluate(async (radio) => {
    const { createElement, useState } = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { ChannelsPanel } = await import('/src/channels/ChannelsPanel.tsx')
    await import('/src/index.css')
    window.calls = []
    function Fixture() {
      const [snapshot, setSnapshot] = useState({ phase: 'ready',
        device: { name: 'Test radio', publicKey: radio, capabilities: { maxChannels: 8, firmwareProtocolVersion: 12 } },
        channels: [{ index: 0, name: 'Public' }, { index: 1, name: '#mesh' }] })
      window.switchRadio = () => setSnapshot({ ...snapshot, device: { ...snapshot.device, publicKey: 'ef'.repeat(32) } })
      return createElement(ChannelsPanel, { snapshot, cacheSaving: false, messageSyncing: false,
        onBlockedSendersChanged() {}, cache: { async renameChannelRetention(...args) { window.calls.push(['retention', ...args]) } },
        session: {
          async changeChannel(key, index, name, next, rename) {
            window.calls.push(['change', key, index, name, next])
            if (rename) await rename()
            setSnapshot((current) => ({ ...current, channels: next === null
              ? current.channels.filter((channel) => channel.index !== index)
              : current.channels.map((channel) => channel.index === index ? { index, name: next } : channel) }))
          },
          async readChannelShareKey(...args) {
            window.calls.push(['share', ...args])
            if (!window.shareAvailable) throw Error('Share key unavailable. Retry.')
            return 'cd'.repeat(16)
          },
          async createChannel(...args) { window.calls.push(['create', ...args]) },
        },
      })
    }
    createRoot(document.getElementById('fixture')).render(createElement(Fixture))
  }, radio)
  const actions = () => page.getByRole('button', { name: 'Actions for Public', exact: true })
  await actions().click()
  page.once('dialog', (dialog) => void dialog.dismiss())
  await page.getByRole('menuitem', { name: 'Delete channel' }).click()
  assert.deepEqual(await page.evaluate(() => window.calls), [])
  await actions().click()
  page.once('dialog', (dialog) => void dialog.dismiss())
  await page.getByRole('menuitem', { name: 'Share link or QR code' }).click()
  assert.deepEqual(await page.evaluate(() => window.calls), [])
  await actions().click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('menuitem', { name: 'Share link or QR code' }).click()
  await page.getByRole('alert').getByText('Share key unavailable. Retry.').waitFor()
  await page.evaluate(() => { window.shareAvailable = true })
  await actions().click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('menuitem', { name: 'Share link or QR code' }).click()
  const share = page.getByRole('dialog', { name: 'Share MeshCore link' })
  await share.waitFor()
  assert.match(await share.getByLabel('Share link').inputValue(), /secret=cdcdcdcd/)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Add channel', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'Add channel' })
  await create.getByRole('textbox', { name: 'Channel name' }).fill('Private team')
  await create.getByRole('button', { name: 'Save channel' }).click()
  await create.getByRole('status').getByText('Channel saved to the radio.').waitFor()
  const generated = await create.getByLabel('New private channel secret').textContent()
  assert.match(generated, /^[a-f0-9]{32}$/)
  const created = await page.evaluate(() => window.calls.find((call) => call[0] === 'create'))
  assert.deepEqual(created, ['create', radio, { kind: 'join', name: 'Private team', secret: generated }])
  assert.doesNotMatch(JSON.stringify(await read(page)), new RegExp(generated))
  await page.keyboard.press('Escape')
  assert.equal(await page.getByLabel('New private channel secret').count(), 1)
  await page.getByRole('button', { name: 'Dismiss secret' }).click()
  await actions().click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await page.getByRole('textbox', { name: 'Rename' }).fill('Local team')
  await page.getByRole('button', { name: 'Save name' }).click()
  await page.getByRole('button', { name: 'Actions for Local team' }).waitFor()
  const calls = await page.evaluate(() => window.calls)
  assert.deepEqual(calls.find((call) => call[0] === 'change'), ['change', radio, 0, 'Public', 'Local team'])
  assert.deepEqual(calls.find((call) => call[0] === 'retention'),
    ['retention', radio, { index: 0, from: 'Public', to: 'Local team' }])
  await page.getByRole('button', { name: 'Actions for #mesh' }).click()
  assert(await page.getByRole('menuitem', { name: 'Rename', exact: true }).isDisabled())
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Actions for Local team' }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.evaluate(() => window.switchRadio())
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Actions for Local team' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('menuitem', { name: 'Delete channel' }).click()
  await page.getByRole('button', { name: 'Actions for Local team' }).waitFor({ state: 'detached' })
  assert.equal((await page.evaluate(() => window.calls)).filter((call) => call[0] === 'change').length, 2)
})
