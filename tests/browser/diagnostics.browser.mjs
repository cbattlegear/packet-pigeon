import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('captures received packets, filters the log and redacts clipboard and file output', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.setDefaultTimeout(8_000)
  await page.addInitScript(() => {
    const encode = new TextEncoder()
    const capability = Uint8Array.of(13, 14, 20, 0, ...new Uint8Array(78))
    const self = Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(0xab),
      ...new Uint8Array(22), ...encode.encode('RX Fixture'))
    const port = new EventTarget()
    let controller
    function emit(bytes) { controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes)) }
    window.fixtureRx = emit
    window.radioCommands = []
    Object.assign(port, {
      readable: new ReadableStream({ start(stream) { controller = stream } }),
      writable: new WritableStream({ write(data) {
        const command = data[3]
        window.radioCommands.push(command)
        if (command === 22) emit(capability)
        else if (command === 1) emit(self)
        else if (command === 4) { emit([2, 0, 0, 0, 0]); emit([4, 0, 0, 0, 0]) }
        else throw Error('Unexpected radio command')
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text) { window.fixtureClipboard = text } } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#diagnostics')
  const start = page.getByRole('button', { name: 'Start capture' })
  assert(await start.isDisabled())
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'Start capture')?.disabled)
  await page.evaluate(() => window.fixtureRx([0x88, 4, 200, 0x16, 0, 0x73, 0x45, 0x67, 0xef]))
  await start.click()
  await page.getByRole('link', { name: 'Chats' }).click()
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Received packets' }).count(), 0)
  await page.evaluate(() => {
    window.fixtureRx([0x88, 245, 170, 0x15, 0x41, 0xa3, 0xe7, 0x73, 0x45, 0x67, 0xef])
    window.fixtureRx([0x88, 4])
    window.fixtureRx([0x88, 15, 210, 0x0e, 0, 1, 2, 3, 4])
  })
  await page.getByRole('link', { name: 'Diagnostics' }).click()
  await page.getByText('3 of 3 packets').waitFor()
  await page.getByLabel('Decode status').selectOption('malformed')
  await page.getByRole('button', { name: 'RX Unknown packet' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'RX Channel text' }).count(), 0)
  await page.getByLabel('Decode status').selectOption('all')
  await page.getByRole('combobox', { name: 'Route', exact: true }).selectOption('1')
  await page.getByRole('button', { name: 'RX Channel text' }).click()
  await page.getByText('1 of 3 packets').waitFor()
  await page.getByText('a3e7', { exact: true }).waitFor()
  await page.getByText('Show raw packet hex').click()
  await page.getByText('1541a3e7734567ef', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Copy redacted diagnostics' }).click()
  await page.getByText('Redacted diagnostics copied.').waitFor()
  const clipboard = await page.evaluate(() => window.fixtureClipboard)
  const { packets } = JSON.parse(clipboard)
  assert.equal(packets.length, 1)
  assert.equal(packets[0].snrDb, -2.75)
  assert.equal(packets[0].type, 'Channel text')
  assert.doesNotMatch(clipboard, /a3e7|4567ef|ab{5,}/)
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export redacted diagnostics' }).click()
  const file = await downloadEvent
  assert.equal(await readFile(await file.path(), 'utf8'), clipboard)
  await page.evaluate(() => {
    const body = [0x12, 0x34, 0x56, ...new Uint8Array(16).fill(0xa5)]
    window.fixtureRx([0x88, 4, 200, 0x15, 1, 0xaa, ...body])
    window.fixtureRx([0x88, 4, 200, 0x14, 0x34, 0x12, 0x78, 0x56, 2, 0xbb, 0xcc, ...body])
  })
  await page.getByText('2 of 5 packets').waitFor()
  await page.getByRole('button', { name: 'RX Channel text' }).first().click()
  await page.getByRole('heading', { name: 'Matching encrypted channel-packet observations: 2' }).waitFor()
  await page.getByText('bb, cc', { exact: true }).waitFor()
  await page.getByText('1234, 5678', { exact: true }).waitFor()
  await page.getByText(/not delivery confirmations/).waitFor()
  await page.getByRole('button', { name: 'Stop capture' }).click()
  await page.getByRole('button', { name: 'Clear log' }).click()
  await page.evaluate(() => window.fixtureRx([0x88, 4]))
  await page.getByText('No packets captured.').waitFor()
  assert.deepEqual(await page.evaluate(() => window.radioCommands), [22, 1, 4])
})
