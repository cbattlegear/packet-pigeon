import { openWorkspaceMenu } from './workspace-menu.mjs'
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
    window.emitTraceFixture = emit
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
        } else if (data[0] === 10) emit([10])
        else if (data[0] === 36) {
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
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByText('Node data and public map', { exact: true }).click()
  await page.getByLabel('Import local or discovered nodes').setInputFiles({
    name: 'unselected-map-node.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify([{ publicKey: 'bc01ffff'.padEnd(64, '1'), name: 'Unselected collision',
      role: 2, position: { lat: 39, lon: -90 } }])),
  })
  await page.getByText('1 nodes loaded.', { exact: true }).waitFor()
  const nodes = page.locator('.map-node-list')
  for (const name of ['Relay A', 'Relay B']) {
    await nodes.getByRole('button', { name: new RegExp(name) }).click()
    await page.getByRole('button', { name: 'Add repeater to trace' }).click()
  }
  assert.deepEqual(await page.evaluate(() => window.traces), [])
  await page.getByRole('button', { name: 'Review map trace' }).click()
  await page.getByRole('button', { name: 'Start capture' }).click()
  await page.evaluate(() => window.emitTraceFixture([0x88, 4, 200, 0x15, 0x42, 0xbc, 1, 0xbc, 2, 0x12, 0x34, 0x56, 0x78]))
  await page.getByRole('button', { name: 'RX Channel text' }).click()
  const path = page.getByRole('list', { name: 'Captured packet path hops' })
  await path.getByText(/Ambiguous: Relay A, Unselected collision/).waitFor()
  await page.getByRole('button', { name: 'Show path on map' }).click()
  const mapped = page.getByRole('region', { name: 'Displayed route' })
  await mapped.getByText('bc01 · Position unavailable', { exact: true }).waitFor()
  await mapped.getByText('Relay B', { exact: true }).waitFor()
  assert.equal(await mapped.getByText('Relay A', { exact: true }).count(), 0)
  assert.equal(await page.locator('.leaflet-overlay-pane path[stroke="#6047a6"][stroke-width="4"]').count(), 0)
  await openWorkspaceMenu(page, 'More')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Diagnostics' }).click()
  const width = page.getByRole('combobox', { name: 'Trace hash width' })
  const send = page.getByRole('button', { name: 'Send trace' })
  const audible = page.getByRole('checkbox', { name: 'I can hear the final repeater directly' })
  await page.getByRole('list', { name: 'Map repeaters to trace' }).getByText(/Relay B/).waitFor()
  await width.selectOption('1')
  await page.getByText(/These hashes match multiple known nodes/).waitFor()
  await audible.check()
  assert(await send.isDisabled())
  await width.selectOption('2')
  await page.getByText(/These hashes match multiple known nodes or the connected radio: bc01/).waitFor()
  await audible.check()
  assert(await send.isDisabled())
  assert.deepEqual(await page.evaluate(() => window.traces), [])
  await width.selectOption('4')
  assert(await send.isDisabled())
  await audible.check()
  await send.click()
  const result = page.getByRole('region', { name: 'Trace result' })
  await result.getByText(/Return SNR 8 dB/).waitFor()
  await result.getByText(/Relay B.*-1 dB.*85.2 km/).waitFor()
  const mapTrace = [0xbc, 1, 0x11, 0x11, 0xbc, 2, 0x11, 0x11]
  assert.deepEqual(await page.evaluate(() => window.traces), [mapTrace])
  await result.getByRole('button', { name: 'Copy reverse path' }).click()
  assert.equal(await page.evaluate(() => window.copiedPath), 'bc021111,bc011111')
  await result.getByRole('button', { name: 'Show path on map' }).click()
  await page.getByRole('region', { name: 'Displayed route' }).getByText('Relay A', { exact: true }).waitFor()
  await openWorkspaceMenu(page, 'More')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Diagnostics' }).click()
  await page.getByRole('combobox', { name: 'Route source' }).selectOption('manual')
  await page.getByRole('textbox', { name: 'Repeater hashes in order' }).fill('bc021111')
  await audible.check()
  await send.click()
  await page.getByRole('alert').filter({ hasText: 'No trace reply was received before the deadline.' }).waitFor()
  await page.getByRole('button', { name: 'Reset trace' }).click()
  assert.equal(await page.getByRole('textbox', { name: 'Repeater hashes in order' }).inputValue(), '')
  assert.deepEqual(await page.evaluate(() => window.traces), [mapTrace, [0xbc, 2, 0x11, 0x11]])

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Map' }).click()
  await nodes.getByRole('button', { name: /Unselected collision/ }).click()
  const openContact = page.getByRole('button', { name: 'Open contact' })
  assert.equal(await openContact.count(), 0)
  await nodes.getByRole('button', { name: /Relay B/ }).click()
  await openContact.click()
  await page.getByRole('heading', { name: 'Relay B', exact: true }).waitFor()
})
