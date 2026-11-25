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

test('enabling oldest unread repositions the open conversation and preserves its draft', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1260, height: 900 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = 'ab'.repeat(32)
  await page.goto(`${url}#chats`)
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const contact = '23'.repeat(32)
    const conversationId = `direct:${contact}`
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `message-${index}`, conversationId, sender: contact, timestamp: index * 1000, text: `Message ${index}`,
    }))
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        contacts: [{ publicKey: contact, name: 'Pigeon', details: {
          type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
          latitude: 0, longitude: 0, lastModifiedAt: 0,
        } }],
        messages,
        markRead: messages.slice(0, 7).map(({ id }) => id),
      })
    } finally {
      storage.close()
    }
  }, radio)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const list = page.locator('.chat-message-list')
  await list.waitFor()
  await page.waitForFunction(() => {
    const list = document.querySelector('.chat-message-list')
    return list.scrollTop > 0 && list.scrollHeight - list.clientHeight - list.scrollTop < 5
  })
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Keep this draft')
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByLabel('Open conversations at the oldest unread message').check()
  await page.getByRole('link', { name: 'Chats' }).click()
  await page.waitForFunction(() => {
    const list = document.querySelector('.chat-message-list')
    const firstUnread = list.querySelector('[data-receipt-id="message-7"]')
    return list.scrollTop > 0 && Math.abs(firstUnread.getBoundingClientRect().top - list.getBoundingClientRect().top) < 5
  })
  assert.equal(await input.inputValue(), 'Keep this draft')
  await page.getByRole('region', { name: 'Conversation with Pigeon' }).waitFor()
})

test('restores an enabled wake lock after visibility changes during a pending request and release', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  await page.addInitScript(() => {
    let visibility = 'visible'
    const operations = []
    window.wakeFixture = {
      operations,
      setVisibility(next) {
        visibility = next
        document.dispatchEvent(new Event('visibilitychange'))
      },
    }
    Object.defineProperty(document, 'visibilityState', { get: () => visibility })
    Object.defineProperty(navigator, 'wakeLock', { value: {
      request: async () => {
        operations.push('request')
        if (window.wakeFixture.deny) throw Error('Denied')
        if (operations.length === 1) {
          await new Promise((resolve) => { window.wakeFixture.finishRequest = resolve })
        }
        const sentinel = new EventTarget()
        sentinel.released = false
        sentinel.release = async () => {
          operations.push('release')
          if (window.wakeFixture.delayRelease) {
            await new Promise((resolve) => { window.wakeFixture.finishRelease = resolve })
          }
          sentinel.released = true
          sentinel.dispatchEvent(new Event('release'))
        }
        return sentinel
      },
    } })
  })
  await page.goto(`${url}#settings`)
  const keepOn = page.getByRole('checkbox', { name: 'Keep screen on' })
  await keepOn.check()
  await page.waitForFunction(() => Boolean(window.wakeFixture.finishRequest))
  await page.evaluate(() => {
    const fixture = window.wakeFixture
    fixture.delayRelease = true
    fixture.setVisibility('hidden')
    fixture.setVisibility('visible')
    fixture.finishRequest()
  })
  await page.waitForFunction(() => Boolean(window.wakeFixture.finishRelease))
  assert.deepEqual(await page.evaluate(() => window.wakeFixture.operations), ['request', 'release'])
  await page.evaluate(() => {
    const fixture = window.wakeFixture
    fixture.delayRelease = false
    fixture.finishRelease()
  })
  await page.getByText('Keeping the screen on while this tab is visible.').waitFor()
  assert.deepEqual(await page.evaluate(() => window.wakeFixture.operations), ['request', 'release', 'request'])
  await keepOn.uncheck()
  await page.evaluate(() => { window.wakeFixture.deny = true })
  await keepOn.check()
  await page.getByText('The browser or device declined the screen wake lock.').waitFor()
  assert.deepEqual(await page.evaluate(() => window.wakeFixture.operations),
    ['request', 'release', 'request', 'release', 'request'])
})
