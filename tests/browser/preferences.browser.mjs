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

test('notification permission and per-channel mode persist independently', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.addInitScript(() => {
    class MockNotification {
      static permission = 'default'
      static async requestPermission() { MockNotification.permission = 'granted'; return 'granted' }
    }
    window.Notification = MockNotification
  })
  const page = await context.newPage()
  const radio = 'ab'.repeat(32)
  await page.goto(`${url}#settings`)
  await page.getByRole('button', { name: 'Allow browser notifications' }).click()
  await page.getByText('Permission: granted.').waitFor()
  await page.getByLabel('Alert for synced messages').check()
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { await storage.update(radioKeyFromPublicKey(radio), { channels: [{ index: 0, name: 'Public' }] }) }
    finally { storage.close() }
  }, radio)
  await page.getByRole('link', { name: 'Channels' }).click()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByLabel('Browser alerts for Public').selectOption('mentions')
  await page.getByText('Notification mode saved for this browser and radio.').waitFor()
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  assert.equal(await page.getByLabel('Browser alerts for Public').inputValue(), 'mentions')
  await page.getByRole('link', { name: 'Settings' }).click()
  assert.equal(await page.getByLabel('Alert for synced messages').isChecked(), true)
})

test('a saved synced message alerts once and opens its conversation', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.addInitScript(() => {
    class MockNotification {
      static permission = 'granted'
      constructor(title, options) { this.title = title; this.options = options; window.alerts.push(this) }
      close() {}
    }
    window.alerts = []
    window.Notification = MockNotification
    const encoder = new TextEncoder()
    const settings = new Uint8Array(60)
    settings.set([5, 1]); settings.fill(0xab, 4, 36); settings.set(encoder.encode('Me'), 58)
    const capability = new Uint8Array(82)
    capability.set([13, 14, 20, 1])
    const slot = new Uint8Array(50)
    slot.set([18, 0]); slot.set(encoder.encode('Public'), 2)
    let controller
    let remaining = 2
    const port = new EventTarget()
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    Object.assign(port, {
      readable: new ReadableStream({ start(stream) { controller = stream } }),
      writable: new WritableStream({ write(frame) {
        const command = frame[3]
        if (command === 22) emit(capability)
        else if (command === 1) emit(settings)
        else if (command === 4) { emit([2, 0, 0, 0, 0]); emit([4, 0, 0, 0, 0]) }
        else if (command === 31) emit(slot)
        else if (command === 10) emit(remaining-- > 0
          ? [7, 1, 2, 3, 4, 5, 6, 0, 0, 42, 0, 0, 0, 104, 105] : [10])
        else throw Error(`Unexpected command ${command}`)
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  await page.goto(`${url}#settings`)
  await page.getByLabel('Alert for synced messages').check()
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByRole('link', { name: 'Chats' }).click()
  const sync = page.getByRole('button', { name: 'Sync messages' })
  await sync.waitFor()
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent === 'Sync messages')?.disabled)
  await sync.click()
  await page.waitForFunction(() => window.alerts.length === 1)
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button'))
    .some((button) => button.textContent === 'Sync messages'))
  assert.equal(await page.evaluate(() => window.alerts.length), 1)
  await page.evaluate(() => window.alerts[0].onclick())
  await page.getByRole('region', { name: /Conversation with Unknown contact 010203040506/ }).waitFor()
  await page.getByLabel('Browser alerts for Unknown contact 010203040506').selectOption('muted')
  await page.waitForFunction(async () => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey('ab'.repeat(32))))?.mutedDirectConversations?.includes('direct:010203040506') }
    finally { storage.close() }
  })
})

test('discovery and full-storage alerts retain their radio across a switch and offline navigation', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.addInitScript(() => {
    class MockNotification {
      static permission = 'granted'
      constructor(title, options) { this.title = title; this.options = options; window.alerts.push(this) }
      close() {}
    }
    window.alerts = []
    window.Notification = MockNotification
    const encoder = new TextEncoder()
    let selected = 0
    function makePort(byte) {
      const settings = new Uint8Array(60)
      settings.set([5, 1]); settings.fill(byte, 4, 36); settings.set(encoder.encode('Me'), 58)
      const capability = new Uint8Array(82)
      capability.set([13, 14, 1, 1])
      const slot = new Uint8Array(50)
      slot.set([18, 0]); slot.set(encoder.encode('Public'), 2)
      const contact = (value) => {
        const frame = new Uint8Array(148)
        frame[0] = 3; frame.fill(value, 1, 33); frame[33] = 1; frame[35] = 255
        frame.set(encoder.encode(`Contact ${value}`), 100)
        return frame
      }
      let controller
      const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
      const port = new EventTarget()
      window.emitDiscovery = () => emit(Uint8Array.of(0x80, ...new Uint8Array(32).fill(0xef)))
      Object.assign(port, {
        readable: new ReadableStream({ start(stream) { controller = stream } }),
        writable: new WritableStream({ write(frame) {
          if (frame[3] === 22) emit(capability)
          else if (frame[3] === 1) emit(settings)
          else if (frame[3] === 4) {
            emit([2, 2, 0, 0, 0]); emit(contact(1)); emit(contact(2)); emit([4, 0, 0, 0, 0])
          } else if (frame[3] === 31) emit(slot)
          else throw Error(`Unexpected command ${frame[3]}`)
        } }),
        async open() {}, async close() {},
      })
      return port
    }
    Object.defineProperty(navigator, 'serial', {
      value: { async requestPort() { return makePort(selected++ === 0 ? 0xab : 0xcd) } },
    })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  await page.goto(`${url}#settings`)
  await page.getByLabel('Alert for newly discovered contacts (USB)').check()
  await page.getByLabel('Alert when radio contact or channel storage is full').check()
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.waitForFunction(() => window.alerts.filter((entry) => entry.options.tag.includes('ab'.repeat(32))).length === 2)
  await page.evaluate(() => window.emitDiscovery())
  await page.waitForFunction(() => window.alerts.filter((entry) => entry.options.tag.includes('ab'.repeat(32))).length === 3)
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.waitForFunction(() => window.alerts.some((entry) => entry.options.tag.includes('cd'.repeat(32))))
  for (const kind of ['discovery', 'full:' + 'ab'.repeat(32) + ':contacts', 'full:' + 'ab'.repeat(32) + ':channels']) {
    await page.evaluate((kind) => window.alerts.find((entry) =>
      entry.options.tag.includes('ab'.repeat(32)) && entry.options.tag.includes(kind)).onclick(), kind)
    await page.getByRole('alert').filter({ hasText: 'The alert belongs to a different radio' }).first().waitFor()
    assert.equal(new URL(page.url()).hash, '#settings')
  }
  await page.getByRole('button', { name: 'Disconnect' }).click()
  for (const [kind, label] of [['discovery', 'Discovery cache radio'], ['contacts', 'Cached radio'], ['channels', 'Cached radio']]) {
    await page.evaluate((kind) => window.alerts.find((entry) => entry.options.tag.includes('ab'.repeat(32))
      && (kind === 'discovery' ? entry.options.tag.includes('discovery') : entry.options.tag.endsWith(`:${kind}`))).onclick(), kind)
    const radio = page.getByRole('combobox', { name: label })
    await radio.waitFor()
    await page.waitForFunction(({ label }) => Array.from(document.querySelectorAll('select'))
      .some((element) => (element.getAttribute('aria-label') === label || element.closest('label')?.textContent.includes(label))
        && element.value === 'ab'.repeat(32)), { label })
    assert.equal(await radio.inputValue(), 'ab'.repeat(32))
  }
})

test('matching channel receipts remain inspectable when possible repeats are hidden', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1260, height: 900 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = '12'.repeat(32)
  await page.goto(`${url}#chats`)
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const messages = [1, 0xff].map((pathLength, index) => {
      const id = `receipt-${index}`
      const text = 'Alice: hello'
      return {
        id, conversationId: 'channel:0', sender: '', timestamp: 123000, text,
        receipt: { kind: 'channel-text', receiptId: id, channelIndex: 0, textType: 0,
          senderTimestamp: 123, text, pathLength, snrDb: index === 0 ? 2 : null },
      }
    })
    try { await storage.update(radioKeyFromPublicKey(radio), { channels: [{ index: 0, name: 'Public' }], messages }) }
    finally { storage.close() }
  }, radio)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const conversation = page.getByRole('region', { name: 'Conversation with Public' })
  await conversation.getByLabel(/Hide 1 possible repeat/).check()
  assert.equal(await conversation.locator('[data-receipt-id]').count(), 1)
  await conversation.getByText('2 matching queued receipts (possible repeats)').click()
  await conversation.getByText('Direct receipt', { exact: true }).waitFor()
  await conversation.getByText(/may not queue every heard copy/).waitFor()
  const saved = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).messages.map(({ id }) => id) }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(saved, ['receipt-0', 'receipt-1'])
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

test('sender blocks preserve chat preferences and unread receipts until restored', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1260, height: 900 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = 'cd'.repeat(32)
  await page.goto(`${url}#channels`)
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const messages = ['Bob', 'Alice'].map((name, index) => {
      const text = `${name}: hello`
      return {
        id: name, conversationId: 'channel:0', sender: '', timestamp: (index + 1) * 1000, text,
        receipt: {
          kind: 'channel-text', receiptId: name, channelIndex: 0, textType: 0,
          senderTimestamp: index + 1, text, pathLength: 0, snrDb: null,
        },
      }
    })
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        channels: [{ index: 0, name: 'Public' }], messages, markRead: ['Bob'],
      })
    } finally {
      storage.close()
    }
  }, radio)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByText('Observed sender names').click()
  await page.getByRole('button', { name: 'Block sender name Alice' }).click()
  await page.getByText('Sender name blocked on this radio.').waitFor()

  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByLabel('Show conversation previews').uncheck()
  await page.getByRole('link', { name: 'Chats' }).click()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const conversation = page.getByRole('region', { name: 'Conversation with Public' })
  await conversation.locator('[data-receipt-id="Bob"]').getByText('Bob', { exact: true }).waitFor()
  assert.equal(await conversation.getByText('Alice', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('navigation', { name: 'Conversations' }).getByText('Bob: hello').count(), 0)
  const readWhileBlocked = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).readMessages }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(readWhileBlocked, ['Bob'])

  await page.getByRole('link', { name: 'Channels' }).click()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByRole('button', { name: 'Unblock sender name Alice' }).click()
  await page.getByText('Sender name unblocked on this radio.').waitFor()
  await page.getByRole('link', { name: 'Chats' }).click()
  await conversation.locator('[data-receipt-id="Alice"]').getByText('Alice', { exact: true }).waitFor()
  await page.waitForFunction(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).readMessages?.includes('Alice') }
    finally { storage.close() }
  }, radio)
  await page.getByRole('link', { name: 'Settings' }).click()
  assert.equal(await page.getByLabel('Show conversation previews').isChecked(), false)
})

test('channel retention confirms deletion and pauses when a slot changes names', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1260, height: 900 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = 'ab'.repeat(32)
  const otherRadio = 'ef'.repeat(32)
  await page.goto(`${url}#channels`)
  await page.evaluate(async ({ radio, otherRadio }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const now = Date.now()
    const messages = [
      { id: 'old', timestamp: now - 2 * 86_400_000 },
      { id: 'recent', timestamp: now - 60_000 },
    ].map((entry) => ({
      ...entry, conversationId: 'channel:0', sender: '', text: 'Cached message',
    }))
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        channels: [{ index: 0, name: 'Public' }], messages, markRead: ['old', 'recent'],
      })
      await storage.update(radioKeyFromPublicKey(otherRadio), {
        channels: [{ index: 0, name: 'Public' }], messages: [messages[0]],
      })
    } finally { storage.close() }
  }, { radio, otherRadio })
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const retention = page.getByRole('combobox', { name: 'Message retention for Public' })
  assert.equal(await retention.inputValue(), 'forever')

  let prompt = page.waitForEvent('dialog')
  let selection = retention.selectOption('1')
  let dialog = await prompt
  assert.match(dialog.message(), /permanently deleted using sender-provided timestamps/)
  await dialog.dismiss()
  await selection
  assert.equal(await retention.inputValue(), 'forever')

  prompt = page.waitForEvent('dialog')
  selection = retention.selectOption('1')
  dialog = await prompt
  await dialog.accept()
  await selection
  await page.getByText('Retention saved. Cleanup runs when the app starts.').waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 1, `Channel settings overflow by ${overflow}px`)
  const before = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).messages.map(({ id }) => id) }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(before, ['old', 'recent'])

  await page.reload()
  await page.getByText('Channel retention removed 1 cached message.').waitFor()
  const after = await page.evaluate(async ({ radio, otherRadio }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      return {
        current: await storage.read(radioKeyFromPublicKey(radio)),
        other: await storage.read(radioKeyFromPublicKey(otherRadio)),
      }
    } finally { storage.close() }
  }, { radio, otherRadio })
  assert.deepEqual(after.current.messages.map(({ id }) => id), ['recent'])
  assert.deepEqual(after.current.readMessages, ['recent'])
  assert.deepEqual(after.other.messages.map(({ id }) => id), ['old'])
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  assert.equal(await retention.inputValue(), '1')

  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        channels: [{ index: 0, name: 'Replacement' }],
        messages: [{ id: 'replacement', conversationId: 'channel:0', sender: '',
          timestamp: Date.now() - 2 * 86_400_000, text: 'Keep this' }],
      })
    } finally { storage.close() }
  }, radio)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const replacement = page.getByRole('combobox', { name: 'Message retention for Replacement' })
  assert.equal(await replacement.inputValue(), 'paused')
  await page.getByText('Retention is paused because this slot changed names. Choose a setting for this channel.').waitFor()
  const saved = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).messages.map(({ id }) => id) }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(saved, ['recent', 'replacement'])
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { await storage.update(radioKeyFromPublicKey(radio), { channels: [{ index: 0, name: 'Public' }] }) }
    finally { storage.close() }
  }, radio)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  assert.equal(await retention.inputValue(), 'paused')
  const afterReturn = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).messages.map(({ id }) => id) }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(afterReturn, ['recent', 'replacement'])
  await retention.selectOption('forever')
  await page.getByText('Retention saved. Cleanup runs when the app starts.').waitFor()
  const cleared = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).channelRetention }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(cleared, [])

  await page.evaluate(async (radio) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('packet-pigeon', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('radios', 'readwrite')
        const store = transaction.objectStore('radios')
        const request = store.get(radio)
        request.onsuccess = () => {
          request.result.channelRetention = 'invalid'
          store.put(request.result, radio)
        }
        transaction.oncomplete = resolve
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { database.close() }
  }, radio)
  await page.reload()
  await page.getByText(/Channel retention could not finish: Invalid saved channel retention settings/).waitFor()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  prompt = page.waitForEvent('dialog')
  const reset = page.getByRole('button', { name: 'Reset invalid retention settings' }).click()
  dialog = await prompt
  await dialog.accept()
  await reset
  await page.getByText('Retention settings reset. Reload to retry cleanup.').waitFor()
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).waitFor()
  assert.equal(await page.getByText(/Channel retention could not finish/).count(), 0)
  const recovered = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(radio))).messages.map(({ id }) => id) }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(recovered, ['recent', 'replacement'])
})

test('a locally renamed channel keeps its retention setting', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = '12'.repeat(32)
  await page.goto(`${url}#channels`)
  await page.getByRole('heading', { name: 'Channels' }).waitFor()
  await page.evaluate(async (radio) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js')
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { ChannelsPanel } = await import('/src/channels/ChannelsPanel.tsx')
    const { SessionCache } = await import('/src/integration/session-cache.ts')
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const key = radioKeyFromPublicKey(radio)
    const storage = await openRadioStorage()
    try {
      await storage.update(key, {
        channels: [{ index: 0, name: 'Public' }],
        channelRetention: { index: 0, channelName: 'Public', days: 30 },
      })
    } finally { storage.close() }
    document.getElementById('root').hidden = true
    const element = document.createElement('div')
    element.id = 'channel-rename-fixture'
    document.body.append(element)
    const root = createRoot(element)
    let snapshot = {
      phase: 'ready', device: { publicKey: radio, capabilities: { maxChannels: 8 } },
      channels: [{ index: 0, name: 'Public' }], contacts: [], messages: [], progress: null,
    }
    const session = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      async changeChannel(key, index, _oldName, name, afterRename) {
        await afterRename?.()
        const storage = await openRadioStorage()
        try { await storage.update(key, { channels: [{ index, name }] }) }
        finally { storage.close() }
        snapshot = { ...snapshot, channels: [{ index, name }] }
        render()
      },
    }
    const cache = new SessionCache(session)
    function render() {
      root.render(React.createElement(ChannelsPanel, {
        snapshot, session, cache, cacheSaving: false, messageSyncing: false, onBlockedSendersChanged() {},
      }))
    }
    render()
  }, radio)
  const fixture = page.locator('#channel-rename-fixture')
  const retention = fixture.getByRole('combobox', { name: 'Message retention for Public' })
  await retention.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const select = document.querySelector('#channel-rename-fixture select[aria-label="Message retention for Public"]')
    return select && !select.disabled && select.value === '30'
  })
  const scope = fixture.getByRole('combobox', { name: 'Sending scope for Public' })
  await scope.selectOption('region')
  await fixture.getByRole('textbox', { name: 'Region name for Public' }).fill('North')
  await fixture.getByRole('button', { name: 'Save sending scope' }).click()
  await fixture.getByText('Sending scope saved for this browser and radio. No radio settings were changed.').waitFor()
  assert.equal(await fixture.getByRole('textbox', { name: 'Region name for Public' }).inputValue(), '#North')
  await fixture.getByRole('textbox', { name: 'Rename' }).fill('Renamed')
  await fixture.getByRole('button', { name: 'Save name' }).click()
  await fixture.getByText('Channel renamed on the radio.').waitFor()
  assert.equal(await fixture.getByRole('combobox', { name: 'Message retention for Renamed' }).inputValue(), '30')
  const saved = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      const data = await storage.read(radioKeyFromPublicKey(radio))
      return { retention: data.channelRetention, scopes: data.channelScopes }
    }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(saved.retention, [{ index: 0, channelName: 'Renamed', days: 30 }])
  assert.deepEqual(saved.scopes, [{ index: 0, channelName: 'Public', scope: { mode: 'region', name: '#North' }, paused: true }])
  await fixture.getByText('Sending scope is paused because this slot changed names. Save a scope before sending.').waitFor()
  await fixture.getByRole('combobox', { name: 'Sending scope for Renamed' }).selectOption('default')
  await fixture.getByRole('button', { name: 'Save sending scope' }).click()
  await fixture.getByText('Sending scope is paused because this slot changed names. Save a scope before sending.').waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1)
})

test('channel mentions remain usable in a narrow offline conversation', async (t) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = '78'.repeat(32)
  await page.goto(`${url}#chats`)
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const text = 'Alice: hello'
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        channels: [{ index: 0, name: 'Public' }],
        messages: [{ id: 'alice', conversationId: 'channel:0', sender: '', timestamp: 1000, text,
          receipt: { kind: 'channel-text', receiptId: 'alice', channelIndex: 0, textType: 0,
            senderTimestamp: 1, text, pathLength: 0, snrDb: null } }],
      })
    } finally { storage.close() }
  }, radio)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const conversation = page.getByRole('region', { name: 'Conversation with Public' })
  const input = conversation.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Hello @Al')
  await conversation.getByText('Mention a name', { exact: true }).click()
  await conversation.getByLabel('Name to mention').selectOption('Alice')
  await conversation.getByRole('button', { name: 'Insert mention' }).click()
  assert.equal(await input.inputValue(), 'Hello @[Alice] ')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
})

test('channel chat sends, replies by name, and keeps local message actions scoped to the radio', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1260, height: 900 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const radio = '34'.repeat(32)
  await page.goto(`${url}#chats`)
  await page.evaluate(async (radio) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js')
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { ChatPanel } = await import('/src/chats/ChatPanel.tsx')
    const { DirectMessages } = await import('/src/integration/direct-messages.ts')
    const { defaultPreferences } = await import('/src/preferences/appPreferences.ts')
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const key = radioKeyFromPublicKey(radio)
    const storage = await openRadioStorage()
    const messages = ['Bob', 'Alice', 'Eve'].map((name, index) => {
      const text = name === 'Eve' ? 'Eve: No\nYes' : `${name}: ${name === 'Alice' ? '@[Pigeon] ' : ''}hello from ${name}`
      return {
        id: name, conversationId: 'channel:0', sender: '', timestamp: Date.now() - 1000, text,
        receipt: {
          kind: 'channel-text', receiptId: name, channelIndex: 0, textType: 0, senderTimestamp: index + 1,
          text, pathLength: 0x42, snrDb: -3.5,
        },
      }
    })
    try {
      await storage.update(key, {
        contacts: [{ publicKey: '56'.repeat(32), name: 'Charlie', details: {
          type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
          latitude: 0, longitude: 0, lastModifiedAt: 0,
        } }],
        channels: [{ index: 0, name: 'Public' }, { index: 1, name: 'Quiet' }],
        messages, markRead: ['Bob'], channelRetention: { index: 0, channelName: 'Public', days: 30 },
        channelScope: { index: 0, channelName: 'Public', scope: { mode: 'region', name: '#North' } },
      })
    } finally { storage.close() }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (text) => { window.copiedChannelText = text } },
    })
    const snapshot = {
      phase: 'ready', transport: 'usb', device: { publicKey: radio, name: 'Pigeon', capabilities: { firmwareProtocolVersion: 14 } },
      channels: [{ index: 0, name: 'Public' }, { index: 1, name: 'Quiet' }],
    }
    window.channelSends = []
    const session = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      subscribeToPushes: () => () => {},
      sendChannel: async (...args) => { window.channelSends.push(args) },
    }
    const direct = new DirectMessages(session)
    await direct.load(key)
    document.getElementById('root').hidden = true
    const element = document.createElement('div')
    element.id = 'channel-chat-fixture'
    document.body.append(element)
    function Fixture() {
      const status = React.useSyncExternalStore(direct.subscribe, direct.getSnapshot)
      return React.createElement(ChatPanel, {
        snapshot, direct, status, messageSync: {}, messageStatus: { syncing: false, pending: false },
        cacheSaving: false, active: true, preferences: defaultPreferences, locale: 'en',
      })
    }
    createRoot(element).render(React.createElement(Fixture))
  }, radio)
  const fixture = page.locator('#channel-chat-fixture')
  const nav = fixture.getByRole('navigation', { name: 'Conversations' })
  await nav.getByRole('button', { name: /Quiet/ }).waitFor()
  await nav.getByRole('button', { name: /Public/ }).click()
  const conversation = fixture.getByRole('region', { name: 'Conversation with Public' })
  await conversation.locator('[data-receipt-id="Bob"]').getByText('Bob', { exact: true }).waitFor()
  await conversation.getByText('2 path hops · 2-byte path hashes · SNR -3.5 dB').first().waitFor()
  await conversation.getByRole('button', { name: 'Copy message: Bob: hello from Bob' }).click()
  assert.equal(await page.evaluate(() => window.copiedChannelText), 'Bob: hello from Bob')
  const input = conversation.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Existing draft')
  await conversation.getByRole('button', { name: 'Reply to Bob' }).click()
  assert.equal(await input.inputValue(), '@[Bob]\n>hello from..\nExisting draft')
  await input.fill('x'.repeat(140))
  await conversation.getByRole('button', { name: 'Reply to Eve' }).click()
  assert.equal(await input.inputValue(), `@[Eve]\n>No Yes\n${'x'.repeat(140)}`)
  assert.equal(await conversation.getByRole('button', { name: 'Send message' }).isDisabled(), true)
  const selfMention = conversation.locator('[data-receipt-id="Alice"] .chat-mention--self')
  assert.equal(await selfMention.count(), 1)
  assert.equal(await selfMention.textContent(), '@[Pigeon]')
  await input.fill('Meet @Bo later')
  await input.evaluate((element) => element.setSelectionRange(8, 8))
  const picker = conversation.getByText('Mention a name', { exact: true })
  await picker.focus()
  await page.keyboard.press('Enter')
  const mentionNames = conversation.getByLabel('Name to mention')
  assert.equal(await mentionNames.getByRole('option', { name: 'Charlie' }).count(), 1)
  await mentionNames.selectOption('Bob')
  await conversation.getByRole('button', { name: 'Insert mention' }).focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.id === 'chat-draft')
  assert.equal(await input.inputValue(), 'Meet @[Bob] later')
  assert.equal(await input.evaluate((element) => element.selectionStart), 12)
  await input.fill('a'.repeat(153))
  assert.equal(await conversation.getByRole('button', { name: 'Send message' }).isDisabled(), true)
  await input.fill('a'.repeat(145))
  await conversation.getByRole('button', { name: 'Share or use quick message' }).click()
  const sharing = page.getByRole('dialog', { name: 'Add to message' })
  await sharing.getByRole('textbox', { name: 'New quick message' }).fill('1234567')
  await sharing.getByRole('button', { name: 'Save quick message' }).click()
  await sharing.getByRole('button', { name: '1234567', exact: true }).click()
  await sharing.getByRole('alert').getByText(/must fit in 152 UTF-8 bytes/).waitFor()
  assert.equal(await input.inputValue(), 'a'.repeat(145))
  await sharing.getByRole('button', { name: 'Close' }).click()
  await input.fill('a'.repeat(144))
  await conversation.getByRole('button', { name: 'Share or use quick message' }).click()
  await sharing.getByRole('button', { name: '1234567', exact: true }).click()
  assert.equal(await input.inputValue(), `${'a'.repeat(144)}\n1234567`)
  await conversation.getByText('152/152 UTF-8 bytes').waitFor()
  await input.fill('@[Bob] Hello')
  await conversation.getByText('12/152 UTF-8 bytes').waitFor()
  await conversation.getByRole('button', { name: 'Send message' }).click()
  await conversation.getByText('Accepted by radio').waitFor()
  assert.equal(await page.evaluate(() => window.channelSends[0][5]), '@[Bob] Hello')
  assert.deepEqual(await page.evaluate(() => window.channelSends[0][6]), { mode: 'region', name: '#North' })
  await conversation.getByRole('button', { name: 'Copy message: @[Bob] Hello' }).click()
  assert.equal(await page.evaluate(() => window.copiedChannelText), '@[Bob] Hello')
  await input.fill('Keep this draft')
  let prompt = page.waitForEvent('dialog')
  const resending = conversation.getByRole('button', { name: 'Resend channel message: @[Bob] Hello' }).click()
  let dialog = await prompt
  assert.match(dialog.message(), /may already have reached others/)
  assert.match(dialog.message(), /best effort and do not confirm delivery/)
  await dialog.accept()
  await resending
  await page.waitForFunction(() => window.channelSends.length === 2)
  assert.equal(await input.inputValue(), 'Keep this draft')
  prompt = page.waitForEvent('dialog')
  const blocking = conversation.getByRole('button', { name: 'Block sender name Alice' }).click()
  dialog = await prompt
  await dialog.accept()
  await blocking
  await conversation.locator('[data-receipt-id="Alice"]').waitFor({ state: 'hidden' })
  prompt = page.waitForEvent('dialog')
  const deleting = conversation.getByRole('button', { name: 'Delete channel message: Bob: hello from Bob' }).click()
  dialog = await prompt
  await dialog.accept()
  await deleting
  await page.waitForFunction(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return !(await storage.read(radioKeyFromPublicKey(radio))).messages.some(({ id }) => id === 'Bob') }
    finally { storage.close() }
  }, radio)
  const data = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return await storage.read(radioKeyFromPublicKey(radio)) }
    finally { storage.close() }
  }, radio)
  assert.deepEqual(data.blockedChannelSenders, ['Alice'])
  assert.deepEqual(data.channelRetention, [{ index: 0, channelName: 'Public', days: 30 }])
  assert.ok(!data.readMessages.includes('Bob'))
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1)
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
