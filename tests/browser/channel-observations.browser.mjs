import assert from 'node:assert/strict'
import { createCipheriv, createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('observes channel packets without merging ambiguous receipts or exposing keys', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.setDefaultTimeout(8000)
  await page.addInitScript(() => {
    const encoder = new TextEncoder()
    const settings = new Uint8Array(58 + 2)
    settings.set([5, 1], 0)
    settings.fill(0xab, 4, 36)
    settings.set(encoder.encode('Me'), 58)
    const capability = new Uint8Array(82)
    capability.set([13, 14, 20, 1])
    const slot = new Uint8Array(50)
    slot.set([18, 0])
    slot.set(encoder.encode('Public'), 2)
    slot.set(Uint8Array.from('8b3387e9c5cdea6ac9e5edbaa115cd72'.match(/../g), (part) => parseInt(part, 16)), 34)
    let controller
    const port = new EventTarget()
    function emit(bytes) { controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes)) }
    window.fixtureRx = emit
    window.radioCommands = []
    Object.assign(port, {
      readable: new ReadableStream({ start(stream) { controller = stream } }),
      writable: new WritableStream({ write(frame) {
        const command = frame[3]
        window.radioCommands.push(command)
        if (command === 22) emit(capability)
        else if (command === 1) emit(settings)
        else if (command === 4) { emit([2, 0, 0, 0, 0]); emit([4, 0, 0, 0, 0]) }
        else if (command === 31) emit(slot)
        else if (command === 10) emit([10])
        else throw Error('Unexpected radio command')
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#chats')
  const radio = 'ab'.repeat(32)
  await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    const messages = ['one', 'two'].map((id) => ({
      id, conversationId: 'channel:0', sender: '', timestamp: 1703123456000, text: 'Alice: Hello mesh!',
      receipt: { kind: 'channel-text', receiptId: id, channelIndex: 0, textType: 0,
        senderTimestamp: 1703123456, text: 'Alice: Hello mesh!', pathLength: 1, snrDb: 1 },
    }))
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        channels: [{ index: 0, name: 'Public' }], messages,
        channelScope: { index: 0, channelName: 'Public', scope: { mode: 'region', name: '#north' } },
      })
    } finally { storage.close() }
  }, radio)
  await page.reload()
  await page.getByRole('button', { name: 'Connect USB' }).click()
  const start = page.getByRole('button', { name: 'Observe channel packets' })
  await start.waitFor()
  await start.click()
  const stop = page.getByRole('button', { name: 'Stop channel observation' })
  await stop.waitFor()
  await page.getByText('Starting channel observation…', { exact: true }).waitFor({ state: 'hidden' })
  const payload = Buffer.from('11a0e6215565cf0555d9e4a5e4824dc70018a6021e8232bb0509500bdf22a90e97978f', 'hex')
  const secret = Buffer.from('8b3387e9c5cdea6ac9e5edbaa115cd72', 'hex')
  const text = Buffer.from('Alice: Hello mesh!')
  const plaintext = Buffer.alloc(Math.ceil((5 + text.length) / 16) * 16)
  plaintext.writeUInt32LE(1703123456)
  plaintext[4] = 2
  text.copy(plaintext, 5)
  const cipher = createCipheriv('aes-128-ecb', secret, null)
  cipher.setAutoPadding(false)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const retryMac = createHmac('sha256', secret).update(ciphertext).digest().subarray(0, 2)
  const retryPayload = Buffer.concat([payload.subarray(0, 1), retryMac, ciphertext])
  const key = createHash('sha256').update('#north').digest().subarray(0, 16)
  const mac = createHmac('sha256', key).update(Buffer.concat([Buffer.of(5), retryPayload])).digest()
  const raw = mac.readUInt16LE()
  const code = raw === 0 ? 1 : raw === 65535 ? 65534 : raw
  await page.evaluate(({ payload, retryPayload, code }) => {
    window.fixtureRx([0x88, 4, 200, 0x15, 1, 0xaa, ...payload])
    window.fixtureRx([0x88, 8, 201, 0x17, code & 255, code >> 8, 0, 0, 2, 0xbb, 0xcc, ...retryPayload])
  }, { payload: [...payload], retryPayload: [...retryPayload], code })
  const first = page.locator('[data-receipt-id="one"]')
  const menu = page.getByRole('group', { name: 'Channel message context actions' })
  const details = page.getByRole('dialog', { name: 'Message details' })
  const openDetails = async () => {
    await first.getByRole('button', { name: 'Message actions' }).click()
    await menu.getByRole('button', { name: 'Message details' }).click()
  }
  assert.equal(await first.getByText(/matching RX observations/).count(), 0)
  await openDetails()
  await details.getByText('2 matching RX observations (possible repeats)').click()
  await details.getByText(/match 2 saved messages and cannot be assigned uniquely/).waitFor()
  await details.getByText(/Possible regions: #north/).waitFor()
  await details.getByText(/Direct with transport codes · 2 remaining hops/).waitFor()
  await details.getByText(/Flood · 1 traversed hop/).waitFor()
  assert.equal(await details.getByRole('button', { name: 'Copy reverse path', exact: true }).count(), 2)
  assert.equal(await page.getByText('8b3387e9c5cdea6ac9e5edbaa115cd72').count(), 0)
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('[data-receipt-id="two"]').getByRole('button', { name: 'Message actions' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await menu.getByRole('button', { name: /Delete channel message/ }).click()
  await page.locator('[data-receipt-id="two"]').waitFor({ state: 'detached' })
  await openDetails()
  await details.getByText('2 matching RX observations (possible repeats)').click()
  await details.getByText(/1 additional match beyond the first/).waitFor()
  const saved = await page.evaluate(async (radio) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return JSON.stringify(await storage.read(radioKeyFromPublicKey(radio))) }
    finally { storage.close() }
  }, radio)
  assert.doesNotMatch(saved, /8b3387e9c5cdea6ac9e5edbaa115cd72/)
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  await stop.click()
  await openDetails()
  assert.equal(await details.getByText(/matching RX observations/).count(), 0)
  assert.deepEqual(await page.evaluate(() => window.radioCommands), [22, 1, 4, 31, 10, 31])
})
