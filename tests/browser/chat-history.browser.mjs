import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

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

test('cached chat navigation, search, unread markers, scrolling and keyboard drafts', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = 'ab'.repeat(32)
  const alpha = '01'.repeat(32)
  const bravo = '02'.repeat(32)
  await page.goto(`${url}#settings`)
  await page.getByLabel('Open conversations at the oldest unread message').check()
  await page.evaluate(async ({ radio, alpha, bravo }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const details = { type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
      latitude: 0, longitude: 0, lastModifiedAt: 0 }
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        contacts: [{ publicKey: alpha, name: 'Alpha', details }, { publicKey: bravo, name: 'Bravo', details }],
        preferences: { selectedConversationId: `direct:${alpha}` },
        draft: { conversationId: 'channel:7', text: 'Old channel draft' },
        messages: [{ id: 'alpha-message', conversationId: `direct:${alpha}`, sender: alpha,
          timestamp: Date.UTC(2024, 0, 1), text: 'Hello Alpha' }, ...Array.from({ length: 40 }, (_, index) => ({
          id: `message-${index}`, conversationId: `direct:${bravo}`, sender: bravo,
          timestamp: Date.UTC(2025, 0, index + 1), text: `Message number ${index}`,
        }))],
      })
    } finally { storage.close() }
  }, { radio, alpha, bravo })
  await page.reload()
  await page.getByRole('link', { name: 'Contacts' }).click()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByRole('button', { name: /Alpha.*1 unread/ }).waitFor()
  await page.getByRole('link', { name: 'Chats' }).click()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByRole('region', { name: 'Conversation with Alpha' }).waitFor()
  await page.waitForFunction(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).readMessages?.includes('alpha-message') }
    finally { storage.close() }
  }, radio)
  await page.getByRole('link', { name: 'Contacts' }).click()
  await page.getByRole('button', { name: /Alpha/ }).waitFor()
  assert.equal(await page.getByRole('button', { name: /Alpha.*unread/ }).count(), 0)
  await page.getByRole('link', { name: 'Chats' }).click()
  await page.getByLabel('Unread only').check()
  assert.equal(await page.getByRole('button', { name: /Bravo/ }).count(), 1)
  assert.equal(await page.getByRole('button', { name: /Alpha/ }).count(), 0)
  await page.getByLabel('New chat').selectOption(`direct:${bravo}`)
  assert.equal(await page.getByLabel('Unread only').isChecked(), false)
  const pane = page.getByRole('region', { name: 'Conversation with Bravo' })
  await pane.waitFor()
  await pane.getByText('New messages', { exact: true }).waitFor()
  await pane.getByText('Jan 1, 2025', { exact: true }).waitFor()
  await pane.getByRole('button', { name: 'Jump to bottom' }).click()
  await page.waitForFunction(() => {
    const list = document.querySelector('.chat-message-list')
    return list && list.scrollHeight - list.scrollTop - list.clientHeight < 2
  })
  await pane.getByLabel('Search messages').fill('number 17')
  assert.equal(await pane.getByText('Message number 17', { exact: true }).count(), 1)
  assert.equal(await pane.getByText('Message number 18', { exact: true }).count(), 0)
  await pane.getByLabel('Search messages').fill('not found')
  await pane.getByText('No matching messages.').waitFor()
  await pane.getByLabel('Search messages').clear()
  const draft = pane.getByLabel('Message', { exact: true })
  await draft.fill('First line')
  await draft.press('Shift+Enter')
  await draft.type('Second line')
  assert.equal(await draft.inputValue(), 'First line\nSecond line')
  await draft.press('Enter')
  await page.getByText(/Connect the selected radio before sending/).waitFor()
  assert.equal(await draft.inputValue(), 'First line\nSecond line')
  await page.getByLabel('New chat').selectOption(`direct:${alpha}`)
  await page.getByLabel('New chat').selectOption(`direct:${bravo}`)
  assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'First line\nSecond line')
  await page.getByRole('button', { name: /Channel 7/ }).click()
  const removed = page.getByRole('region', { name: 'Conversation with Channel 7' })
  assert.equal(await removed.getByLabel('Message', { exact: true }).inputValue(), 'Old channel draft')
  assert.equal(await removed.getByRole('button', { name: 'Send message' }).isDisabled(), true)
  await removed.getByLabel('Message', { exact: true }).fill('Edited old draft')
  await page.getByLabel('New chat').selectOption(`direct:${bravo}`)
  await page.getByRole('button', { name: /Channel 7/ }).click()
  assert.equal(await removed.getByLabel('Message', { exact: true }).inputValue(), 'Edited old draft')
  const read = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).readMessages ?? [] }
    finally { storage.close() }
  }, radio)
  assert.ok(read.length > 1 && read.length < 41, `Only visible receipts should be read, got ${read.length}`)
})
