import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('traces map-selected repeaters, verifies the final hop, and handles manual timeout', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(12000)
  await page.addInitScript(() => {
    const encode = new TextEncoder()
    const info = Uint8Array.of(13, 14, 40, 0, ...new Uint8Array(78))
    const device = Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(0xab),
      ...new Uint8Array(22), ...encode.encode('Trace Fixture'))
    const contact = (name, prefix, lat, lon) => {
      const frame = new Uint8Array(148)
      frame[0] = 3
      frame.fill(0x11, 1, 33)
      frame.set(prefix, 1)
      frame.set([2, 0, 255], 33)
      frame.set(encode.encode(name), 100)
      const fields = new DataView(frame.buffer)
      fields.setInt32(136, lat * 1e6, true)
      fields.setInt32(140, lon * 1e6, true)
      return frame
    }
    const contacts = [contact('Relay A', [0xbc, 0x01], 40, -90), contact('Relay B', [0xbc, 0x02], 40, -89)]
    window.traces = []
    let controller
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(incoming) { controller = incoming } }),
      writable: new WritableStream({ write(packet) {
        const data = packet.slice(3)
        if (data[0] === 22) emit(info)
        else if (data[0] === 1) emit(device)
        else if (data[0] === 4) {
          emit([2, 2, 0, 0, 0])
          contacts.forEach(emit)
          emit([4, 0, 0, 0, 0])
        } else if (data[0] === 36) {
          const tag = data.slice(1, 5)
          const hashes = data.slice(10)
          window.traces.push([...hashes])
          emit([6, 0, ...tag, 80, 0, 0, 0])
          if (window.traces.length === 1) {
            emit([0x89, 0, hashes.length, data[9], ...tag, 0, 0, 0, 0, ...hashes, 12, 252, 32])
          }
        } else throw Error('Unexpected command')
      } }),
      async open() {},
      async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text) { window.copiedPath = text } } })
  })

  await page.goto(server.resolvedUrls.local[0] + '#map')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  const nodes = page.locator('.map-node-list')
  for (const name of ['Relay A', 'Relay B']) {
    await nodes.getByRole('button', { name: new RegExp(name) }).click()
    await page.getByRole('button', { name: 'Add repeater to trace' }).click()
  }
  assert.deepEqual(await page.evaluate(() => window.traces), [])
  await page.getByRole('button', { name: 'Review map trace' }).click()
  const width = page.getByRole('combobox', { name: 'Trace hash width' })
  const send = page.getByRole('button', { name: 'Send trace' })
  const audible = page.getByRole('checkbox', { name: 'I can hear the final repeater directly' })
  await page.getByRole('list', { name: 'Map repeaters to trace' }).getByText(/Relay B/).waitFor()
  await width.selectOption('1')
  await page.getByText(/These hashes match multiple known nodes/).waitFor()
  await audible.check()
  assert(await send.isDisabled())
  await width.selectOption('2')
  assert(await send.isDisabled())
  await audible.check()
  await send.click()
  const result = page.getByRole('region', { name: 'Trace result' })
  await result.getByText(/Return SNR 8 dB/).waitFor()
  await result.getByText(/Relay B.*-1 dB.*85.2 km/).waitFor()
  assert.deepEqual(await page.evaluate(() => window.traces), [[0xbc, 1, 0xbc, 2]])
  await result.getByRole('button', { name: 'Copy reverse path' }).click()
  assert.equal(await page.evaluate(() => window.copiedPath), 'bc02,bc01')
  await result.getByRole('button', { name: 'Show path on map' }).click()
  await page.getByRole('region', { name: 'Displayed route' }).getByText('Relay A', { exact: true }).waitFor()
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Diagnostics' }).click()
  await page.getByRole('combobox', { name: 'Route source' }).selectOption('manual')
  await page.getByRole('textbox', { name: 'Repeater hashes in order' }).fill('bc02')
  await audible.check()
  await send.click()
  await page.getByRole('alert').filter({ hasText: 'No trace reply was received before the deadline.' }).waitFor()
  await page.getByRole('button', { name: 'Reset trace' }).click()
  assert.equal(await page.getByRole('textbox', { name: 'Repeater hashes in order' }).inputValue(), '')
  assert.deepEqual(await page.evaluate(() => window.traces), [[0xbc, 1, 0xbc, 2], [0xbc, 2]])
})
