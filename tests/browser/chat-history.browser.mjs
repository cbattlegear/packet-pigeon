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

test('session-only drafts remain accessible after their contact and channel are removed', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const radio = 'ab'.repeat(32)
  const otherRadio = 'cd'.repeat(32)
  const contact = '01'.repeat(32)
  await page.goto(`${url}#settings`)
  await page.getByLabel('Save draft edits between visits').uncheck()
  await page.evaluate(async ({ radio, otherRadio, contact }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const details = { type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
      latitude: 0, longitude: 0, lastModifiedAt: 0 }
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        contacts: [{ publicKey: contact, name: 'Friend', details }], channels: [{ index: 3, name: 'Field' }],
      })
      await storage.update(radioKeyFromPublicKey(otherRadio), { channels: [{ index: 3, name: 'Other radio' }] })
    } finally { storage.close() }
  }, { radio, otherRadio, contact })
  await page.reload()
  await page.getByRole('link', { name: 'Chats' }).click()
  const radios = page.getByRole('combobox', { name: 'Cached radio' })
  await radios.selectOption(radio)
  await page.getByLabel('New chat').selectOption(`direct:${contact}`)
  await page.getByRole('region', { name: 'Conversation with Friend' }).getByLabel('Message', { exact: true })
    .fill('Unsent private draft')
  await page.getByLabel('New chat').selectOption('channel:3')
  await page.getByRole('region', { name: 'Conversation with Field' }).getByLabel('Message', { exact: true })
    .fill('Unsent channel draft')
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { await storage.update(radioKeyFromPublicKey(radio), { contacts: [], channels: [] }) }
    finally { storage.close() }
  }, radio)
  await radios.selectOption(otherRadio)
  const other = page.getByRole('region', { name: 'Conversation with Other radio' })
  await other.waitFor()
  assert.equal(await other.getByLabel('Message', { exact: true }).inputValue(), '')
  await other.getByLabel('Message', { exact: true }).fill('Another radio draft')
  await radios.selectOption(radio)
  const removedChannel = page.getByRole('region', { name: 'Conversation with Channel 3' })
  await removedChannel.waitFor()
  assert.equal(await removedChannel.getByLabel('Message', { exact: true }).inputValue(), 'Unsent channel draft')
  assert.equal(await removedChannel.getByRole('button', { name: 'Send message' }).isDisabled(), true)
  await page.getByRole('button', { name: /Unknown contact 010101010101/ }).click()
  const removedContact = page.getByRole('region', { name: 'Conversation with Unknown contact 010101010101' })
  assert.equal(await removedContact.getByLabel('Message', { exact: true }).inputValue(), 'Unsent private draft')
  assert.equal(await removedContact.getByRole('button', { name: 'Send message' }).isDisabled(), true)
  await page.getByRole('button', { name: /Channel 3/ }).click()
  await removedChannel.getByLabel('Message', { exact: true }).clear()
  await page.getByRole('button', { name: /Channel 3/ }).waitFor({ state: 'detached' })
  await radios.selectOption(otherRadio)
  await other.waitFor()
  assert.equal(await other.getByLabel('Message', { exact: true }).inputValue(), 'Another radio draft')
  await radios.selectOption(radio)
  await removedContact.waitFor()
  assert.equal(await removedContact.getByLabel('Message', { exact: true }).inputValue(), 'Unsent private draft')
  const drafts = await page.evaluate(async ({ radio, otherRadio }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      return [
        (await storage.read(radioKeyFromPublicKey(radio))).drafts,
        (await storage.read(radioKeyFromPublicKey(otherRadio))).drafts,
      ]
    } finally { storage.close() }
  }, { radio, otherRadio })
  assert.deepEqual(drafts, [[], []])
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByRole('heading', { name: 'No conversations' }).waitFor()
})

test('searches across the selected radio and focuses the exact cached message', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const radio = 'ab'.repeat(32)
  const otherRadio = 'cd'.repeat(32)
  await page.goto(`${url}#settings`)
  await page.getByLabel('Focus the composer when opening a conversation').check()
  await page.evaluate(async ({ radio, otherRadio }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const contact = '01'.repeat(32)
    const channel = (id, index, text) => ({
      id, conversationId: `channel:${index}`, sender: '', timestamp: Date.UTC(2025, 0, 1), text,
      receipt: { kind: 'channel-text', receiptId: id, channelIndex: index, textType: 0,
        senderTimestamp: Date.UTC(2025, 0, 1) / 1000, text, pathLength: 255, snrDb: null },
    })
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        contacts: [{ publicKey: contact, name: 'Pigeon', details: {
          type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
          latitude: 0, longitude: 0, lastModifiedAt: 0,
        } }],
        channels: [{ index: 0, name: 'Public' }],
        blockedChannelSender: { name: 'Blocked', blocked: true },
        messages: [
          channel('archived', 7, 'Alice: Orchard archive'), channel('repeat', 7, 'Alice: Orchard archive'),
          channel('blocked', 0, 'Blocked: Orchard hidden'),
          ...Array.from({ length: 36 }, (_, index) => ({
            id: `message-${index}`, conversationId: `direct:${contact}`, sender: contact,
            timestamp: Date.UTC(2025, 0, 2, 12, index), text: index === 3 ? 'Orchard marker' : `Message number ${index}`,
          })),
        ],
      })
      await storage.update(radioKeyFromPublicKey(otherRadio), {
        messages: [channel('other-radio', 7, 'Orchard on another radio')],
      })
    } finally {
      storage.close()
    }
  }, { radio, otherRadio })
  await page.reload()
  await page.getByRole('link', { name: 'Chats' }).click()
  const radios = page.getByRole('combobox', { name: 'Cached radio' })
  await radios.selectOption(radio)
  const pigeon = page.getByRole('region', { name: 'Conversation with Pigeon' })
  const draft = pigeon.getByLabel('Message', { exact: true })
  await draft.fill('Keep this draft')
  const localSearch = pigeon.getByLabel('Search messages')
  await localSearch.fill('number 17')
  assert.equal(await pigeon.locator('[data-receipt-id="message-3"]').count(), 0)

  await page.getByText('Search all chats', { exact: true }).click()
  const allChats = page.getByRole('searchbox', { name: 'Cached message text' })
  await allChats.fill(' ORCHARD ')
  await page.getByText('3 matching messages', { exact: true }).waitFor()
  const results = page.getByRole('list', { name: 'Matching messages' })
  await results.getByRole('button', { name: /Orchard marker/ }).click()
  const found = pigeon.locator('[data-receipt-id="message-3"]')
  assert.equal(await found.evaluate((element) => element === document.activeElement), true)
  assert.equal(await localSearch.inputValue(), '')
  await pigeon.getByRole('button', { name: 'Jump to bottom' }).waitFor()

  const archives = results.getByRole('button', { name: /Orchard archive/ })
  await archives.first().click()
  const archived = page.getByRole('region', { name: 'Conversation with Channel 7' })
  assert.equal(await archived.getByRole('button', { name: 'Send message' }).isDisabled(), true)
  const hide = archived.getByLabel(/Hide 1 possible repeat/)
  await hide.check()
  assert.equal(await archived.locator('[data-receipt-id="repeat"]').count(), 0)
  await archives.nth(1).click()
  assert.equal(await hide.isChecked(), false)
  assert.equal(await archived.locator('[data-receipt-id="repeat"]').evaluate((element) => element === document.activeElement), true)

  await page.setViewportSize({ width: 390, height: 844 })
  await results.getByRole('button', { name: /Orchard marker/ }).click()
  const narrow = await found.evaluate((element) => {
    const { top, bottom } = element.getBoundingClientRect()
    return { focused: element === document.activeElement, activeId: document.activeElement?.id, top, bottom, height: innerHeight }
  })
  assert.ok(narrow.focused && narrow.top >= -1 && narrow.bottom <= narrow.height, JSON.stringify(narrow))
  assert.equal(await draft.inputValue(), 'Keep this draft')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))

  await radios.selectOption(otherRadio)
  await page.getByText('Search all chats', { exact: true }).click()
  assert.equal(await allChats.inputValue(), '')
  await allChats.fill('orchard')
  await page.getByText('1 matching message', { exact: true }).waitFor()
  assert.equal(await results.getByRole('button', { name: /Orchard on another radio/ }).count(), 1)
})

test('channel message context actions work offline alongside visible keyboard controls', async (t) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const radio = 'ab'.repeat(32)
  await page.goto(`${url}#chats`)
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        channels: [{ index: 0, name: 'Public' }],
        messages: ['one', 'two'].map((id) => ({
          id, conversationId: 'channel:0', sender: '', timestamp: 1703123456000, text: `Alice: ${id}`,
          receipt: { kind: 'channel-text', receiptId: id, channelIndex: 0, textType: 0,
            senderTimestamp: 1703123456, text: `Alice: ${id}`, pathLength: 255, snrDb: null },
        })),
      })
    } finally { storage.close() }
  }, radio)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const first = page.locator('[data-receipt-id="one"]')
  const second = page.locator('[data-receipt-id="two"]')
  await first.waitFor()
  const nativeMenus = await first.evaluate((row) => {
    const text = row.querySelector('p')
    const button = row.querySelector('button')
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(text)
    selection.removeAllRanges()
    selection.addRange(range)
    const selected = text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    selection.removeAllRanges()
    const control = button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return { selected, control }
  })
  assert.deepEqual(nativeMenus, { selected: true, control: true })
  const visibleReply = first.getByRole('button', { name: 'Reply to Alice' })
  await visibleReply.focus()
  await page.keyboard.press('Enter')
  const draft = page.getByLabel('Message', { exact: true })
  assert.match(await draft.inputValue(), /@\[Alice\]/)
  await draft.clear()

  await first.getByText('one', { exact: false }).click({ button: 'right' })
  const menu = page.getByRole('group', { name: 'Channel message context actions' })
  await menu.waitFor()
  assert.equal(await menu.getByRole('button', { name: /Copy message: Alice: one/ }).count(), 1)
  assert.equal(await menu.getByRole('button', { name: 'Reply to Alice' }).count(), 1)
  assert.equal(await menu.getByRole('button', { name: /Block sender name/ }).count(), 1)
  assert.equal(await menu.getByRole('button', { name: /Delete channel message/ }).count(), 1)
  const bounds = await menu.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844)
  await page.keyboard.press('Escape')
  assert.equal(await menu.count(), 0)
  assert.equal(await first.evaluate((element) => element === document.activeElement), true)

  await second.getByText('two', { exact: false }).click({ button: 'right' })
  await menu.getByRole('button', { name: 'Reply to Alice' }).click()
  assert.match(await draft.inputValue(), /two/)
  assert.equal(await draft.evaluate((element) => element === document.activeElement), true)
  assert.equal(await menu.count(), 0)

  await second.getByText('two', { exact: false }).click({ button: 'right' })
  page.once('dialog', (dialog) => void dialog.accept())
  await menu.getByRole('button', { name: /Delete channel message/ }).click()
  await second.waitFor({ state: 'detached' })
  assert.equal(await first.count(), 1)
  await first.getByText('one', { exact: false }).click({ button: 'right' })
  await menu.waitFor()
  await page.getByLabel('Search messages').click()
  assert.equal(await menu.count(), 0)
})

test('inline images preserve links, failures and message actions without rerender reloads', async (t) => {
  for (const width of [1200, 390]) await t.test(`${width}px chat layout`, async (t) => {
    const context = await browser.newContext({ viewport: { width, height: 844 } })
    t.after(() => context.close())
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const radio = 'ab'.repeat(32)
    const contact = '01'.repeat(32)
    const gif = 'https://images.example/animated.GIF?token=fixture'
    const wide = 'https://images.example/wide.svg'
    const broken = 'https://images.example/broken.png'
    const article = 'https://images.example/article'
    const requests = new Map()
    await page.route('https://images.example/**', async (route) => {
      const requested = route.request().url()
      requests.set(requested, (requests.get(requested) ?? 0) + 1)
      if (requested === gif) {
        // Two-frame looping GIF; keep browser animation rather than converting to a bitmap.
        await route.fulfill({ contentType: 'image/gif', body: Buffer.from(
          '47494638396101000100800000000000ffffff21ff0b4e45545343415045322e300301000000'
          + '21f904000a0000002c0000000001000100000202440100'
          + '21f904000a0000002c00000000010001000002024c01003b', 'hex') })
      } else if (requested === wide) {
        await route.fulfill({ contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><rect width="2000" height="1000" fill="red"/></svg>' })
      } else if (requested === broken) {
        await route.fulfill({ contentType: 'text/html', body: '<p>Not an image</p>' })
      } else {
        await route.abort()
      }
    })
    await page.goto(`${url}#chats`)
    await page.evaluate(async ({ radio, contact, gif, wide, broken, article }) => {
      const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
      const storage = await openRadioStorage()
      const text = `Alice: @[Friend] photo ${wide} missing ${broken} ordinary ${article}`
      try {
        await storage.update(radioKeyFromPublicKey(radio), {
          contacts: [{ publicKey: contact, name: 'Friend', details: {
            type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
            latitude: 0, longitude: 0, lastModifiedAt: 0,
          } }],
          channels: [{ index: 0, name: 'Public' }],
          preferences: { selectedConversationId: `direct:${contact}` },
          messages: [
            { id: 'gif', conversationId: `direct:${contact}`, sender: contact,
              timestamp: 1703123456000, text: `Look ${gif} again ${gif}` },
            { id: 'photo', conversationId: 'channel:0', sender: '', timestamp: 1703123456000, text,
              receipt: { kind: 'channel-text', receiptId: 'photo', channelIndex: 0, textType: 0,
                senderTimestamp: 1703123456, text, pathLength: 255, snrDb: null } },
          ],
        })
      } finally { storage.close() }
    }, { radio, contact, gif, wide, broken, article })
    await page.reload()
    await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
    const dm = page.locator('[data-receipt-id="gif"]')
    await dm.getByRole('img').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('[data-receipt-id="gif"] img')?.naturalWidth === 1)
    assert.equal(await dm.getByRole('img').count(), 1)
    assert.equal(await dm.getByRole('img').getAttribute('src'), gif)
    assert.equal(await dm.getByRole('img').getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(await dm.getByRole('link', { name: gif, exact: true }).count(), 2)
    await page.getByLabel('Message', { exact: true }).fill('Draft rerender')
    assert.equal(requests.get(gif), 1)

    await page.getByLabel('New chat').selectOption('channel:0')
    const row = page.locator('[data-receipt-id="photo"]')
    await row.getByRole('img').first().scrollIntoViewIfNeeded()
    await row.getByRole('status').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-receipt-id="photo"] img')?.naturalWidth === 2000)
    assert.match(await row.getByRole('status').textContent(), /Image could not be loaded/)
    assert.equal(await row.getByRole('link', { name: broken, exact: true }).getAttribute('href'), broken)
    assert.equal(await row.getByRole('link', { name: wide, exact: true }).getAttribute('href'), wide)
    assert.equal(await row.getByRole('link', { name: article, exact: true }).getAttribute('href'), article)
    assert.equal(await row.locator('.chat-mention').textContent(), '@[Friend]')
    const dimensions = await row.getByRole('img').evaluate((image) => ({
      image: image.getBoundingClientRect().width, row: image.closest('li').clientWidth,
      page: document.documentElement.scrollWidth, viewport: window.innerWidth,
    }))
    assert.ok(dimensions.image <= dimensions.row && dimensions.image <= 512, JSON.stringify(dimensions))
    assert.ok(dimensions.page <= dimensions.viewport, JSON.stringify(dimensions))
    await page.evaluate(() => {
      window.copiedMessage = null
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async (text) => { window.copiedMessage = text } } })
    })
    const original = `Alice: @[Friend] photo ${wide} missing ${broken} ordinary ${article}`
    await row.getByRole('button', { name: /^Copy message:/ }).click()
    assert.equal(await page.evaluate(() => window.copiedMessage), original)
    await row.getByRole('button', { name: 'Reply to Alice' }).focus()
    await page.keyboard.press('Enter')
    assert.match(await page.getByLabel('Message', { exact: true }).inputValue(), /^@\[Alice\]\n>/)
    await row.getByRole('img').scrollIntoViewIfNeeded()
    await page.evaluate(async () => {
      window.getSelection()?.removeAllRanges()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const imageContextMenu = await row.getByRole('img').evaluate((image) =>
      image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })))
    assert.equal(imageContextMenu, false)
    const menu = page.getByRole('group', { name: 'Channel message context actions' })
    await menu.waitFor()
    await menu.getByRole('button', { name: /^Copy message:/ }).click()
    assert.equal(await page.evaluate(() => window.copiedMessage), original)
    const nativeLinkMenu = await row.getByRole('link', { name: wide, exact: true }).evaluate((link) =>
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    assert.equal(nativeLinkMenu, true)
    assert.equal(await menu.count(), 0)
    await page.getByLabel('Message', { exact: true }).fill('Another rerender')
    assert.equal(requests.get(wide), 1)
    assert.equal(requests.get(broken), 1)
    assert.equal(requests.has(article), false)
  })
})

test('extensionless images load on request without probing ordinary links', async (t) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const radio = 'ab'.repeat(32)
  const contact = '01'.repeat(32)
  const image = 'https://images.example/file?id=123'
  const gif = 'https://images.example/animated?id=456'
  const article = 'https://images.example/article'
  const requests = new Map()
  await page.route('https://images.example/**', async (route) => {
    const requested = route.request().url()
    requests.set(requested, (requests.get(requested) ?? 0) + 1)
    if (requested === image) {
      await route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>' })
    } else if (requested === gif) {
      await route.fulfill({ contentType: 'image/gif', body: Buffer.from(
        '47494638396101000100800000000000ffffff21ff0b4e45545343415045322e300301000000'
        + '21f904000a0000002c0000000001000100000202440100'
        + '21f904000a0000002c00000000010001000002024c01003b', 'hex') })
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<p>Article</p>' })
    }
  })
  await page.goto(`${url}#chats`)
  await page.evaluate(async ({ radio, contact, image, gif, article }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const text = `Alice: ${gif} ${article}`
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        contacts: [{ publicKey: contact, name: 'Friend', details: {
          type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
          latitude: 0, longitude: 0, lastModifiedAt: 0,
        } }],
        channels: [{ index: 0, name: 'Public' }],
        preferences: { selectedConversationId: `direct:${contact}` },
        messages: [
          { id: 'direct-image', conversationId: `direct:${contact}`, sender: contact,
            timestamp: 1703123456000, text: `${image} ${image}` },
          { id: 'channel-gif', conversationId: 'channel:0', sender: '', timestamp: 1703123456000, text,
            receipt: { kind: 'channel-text', receiptId: 'channel-gif', channelIndex: 0, textType: 0,
              senderTimestamp: 1703123456, text, pathLength: 255, snrDb: null } },
        ],
      })
    } finally { storage.close() }
  }, { radio, contact, image, gif, article })
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const dm = page.locator('[data-receipt-id="direct-image"]')
  const loadImage = dm.getByRole('button', { name: `Load image from ${image}` })
  await loadImage.waitFor()
  assert.equal(await loadImage.count(), 1)
  assert.equal(requests.size, 0)
  await loadImage.focus()
  await page.keyboard.press('Enter')
  await dm.getByRole('img').scrollIntoViewIfNeeded()
  await page.waitForFunction(() => document.querySelector('[data-receipt-id="direct-image"] img')?.naturalWidth === 100)
  assert.equal(await dm.getByRole('link', { name: image, exact: true }).count(), 2)
  await page.getByLabel('Message', { exact: true }).fill('Rerender')
  assert.equal(requests.get(image), 1)

  await page.getByLabel('New chat').selectOption('channel:0')
  const channel = page.locator('[data-receipt-id="channel-gif"]')
  const loadGif = channel.getByRole('button', { name: `Load image from ${gif}` })
  await loadGif.waitFor()
  assert.equal(requests.has(gif), false)
  assert.equal(requests.has(article), false)
  await loadGif.click()
  await channel.getByRole('img').scrollIntoViewIfNeeded()
  await page.waitForFunction(() => document.querySelector('[data-receipt-id="channel-gif"] img')?.naturalWidth === 1)
  assert.equal(await channel.getByRole('img').getAttribute('src'), gif)
  assert.equal(requests.get(gif), 1)
  assert.equal(requests.has(article), false)
  await channel.getByRole('button', { name: `Load image from ${article}` }).click()
  await channel.getByRole('status').waitFor()
  assert.match(await channel.getByRole('status').textContent(), /Image could not be loaded/)
  assert.equal(await channel.getByRole('link', { name: article, exact: true }).getAttribute('href'), article)
  assert.equal(requests.get(article), 1)
  await page.getByLabel('Message', { exact: true }).fill('Rerender again')
  assert.equal(requests.get(gif), 1)
  assert.equal(requests.get(article), 1)
  assert.equal(await channel.getByRole('button', { name: 'Reply to Alice' }).count(), 1)
})

test('a failed cached chat load offers retry instead of an indefinite loading state', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const radio = 'ab'.repeat(32)
  await page.goto(`${url}#chats`)
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { await storage.update(radioKeyFromPublicKey(radio), { channels: [{ index: 0, name: 'Public' }] }) }
    finally { storage.close() }
  }, radio)
  await page.reload()
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.get
    window.failChatRead = true
    IDBObjectStore.prototype.get = function (...args) {
      if (window.failChatRead) throw new Error('Simulated read failure')
      return original.apply(this, args)
    }
  })
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByRole('heading', { name: 'Could not load cached chats' }).waitFor()
  assert.equal(await page.getByText('Loading cached chats').count(), 0)
  await page.getByRole('region', { name: 'Conversation' }).getByText('Could not read the cached radio data.').waitFor()
  await page.getByText('Chats cache: Could not read the cached radio data.').waitFor()
  await page.evaluate(() => { window.failChatRead = false })
  await page.getByRole('button', { name: 'Retry loading chats' }).click()
  await page.getByRole('region', { name: 'Conversation with Public' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Could not load cached chats' }).count(), 0)
  assert.equal(await page.getByText('Chats cache: Could not read the cached radio data.').count(), 0)
})
