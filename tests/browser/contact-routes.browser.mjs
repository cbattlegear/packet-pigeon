import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('saves a selected repeater route, confirms CLI access and guards a zero-hop ping', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  await page.addInitScript(() => {
    const encode = new TextEncoder()
    const info = Uint8Array.of(13, 14, 40, 0, ...new Uint8Array(78))
    const device = Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(0xab),
      ...new Uint8Array(22), ...encode.encode('Routes Fixture'))
    const createContact = (name, type, prefix) => {
      const record = new Uint8Array(148)
      record[0] = 3
      record.fill(0x11, 1, 33)
      record.set(prefix, 1)
      record.set([type, 0x81, 255], 33)
      record.set(encode.encode(name), 100)
      return record
    }
    const table = [
      createContact('Target relay', 2, [0xbc, 0x33]),
      createContact('Repeater Two', 2, [0xbc, 0x44]),
    ]
    const changes = []
    window.radioChanges = changes
    let controller
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(incoming) { controller = incoming } }),
      writable: new WritableStream({ write(packet) {
        const data = packet.slice(3)
        const found = () => table.find((record) => record.slice(1, 33).every((byte, index) => data[index + 1] === byte))
        if (data[0] === 22) emit(info)
        else if (data[0] === 1) emit(device)
        else if (data[0] === 4) {
          emit([2, 2, 0, 0, 0])
          table.forEach(emit)
          emit([4, 0, 0, 0, 0])
        } else if (data[0] === 30) emit(found())
        else if (data[0] === 9) { changes.push([...data]); found().set(data.slice(1), 1); emit([0]) }
        else if (data[0] === 13) { changes.push([...data]); found()[35] = 255; emit([0]) }
        else if (data[0] === 36) {
          changes.push([...data])
          const tag = data.slice(1, 5)
          emit([6, 0, ...tag, 150, 0, 0, 0])
          emit([0x89, 0, 2, 1, ...tag, 0, 0, 0, 0, ...data.slice(10), 36, 248])
        } else throw Error('Unexpected command')
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#contacts')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByRole('button', { name: /^Target relay/ }).click()
  await page.getByText('Saved route and repeater hops', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Contact path hash width' }).selectOption('2')
  await page.getByRole('combobox', { name: 'Repeater to append' }).selectOption({ label: 'Repeater Two (bc44)' })
  await page.getByRole('button', { name: 'Append repeater' }).click()
  assert.equal(await page.getByRole('textbox', { name: 'Path hops in order' }).inputValue(), 'bc44')
  await page.getByRole('button', { name: 'Save route' }).click()
  await page.getByText('Saved the contact route.').waitFor()
  await page.getByRole('list', { name: 'Saved route hops' }).getByText('Repeater Two', { exact: false }).waitFor()
  await page.getByText('Contact permissions', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'Remote CLI access' }).check()
  const save = page.getByRole('button', { name: 'Save permissions' })
  await save.click()
  assert.equal(await page.evaluate(() => window.radioChanges.length), 1)
  page.once('dialog', (dialog) => dialog.accept())
  await save.click()
  await page.getByText('Saved contact permissions.').waitFor()
  assert.equal(await page.evaluate(() => window.radioChanges[1][34]), 0x91)
  await page.getByText('Zero-hop ping', { exact: true }).click()
  const width = page.getByRole('combobox', { name: 'Ping hash width' })
  await width.selectOption('1')
  const ping = page.getByRole('button', { name: 'Send ping' })
  assert(await ping.isDisabled())
  await page.getByText(/matches more than one known radio/).waitFor()
  await width.selectOption('2')
  await ping.click()
  assert.equal(await page.evaluate(() => window.radioChanges.length), 2)
  page.once('dialog', (dialog) => dialog.accept())
  await ping.click()
  await page.getByText(/Outbound SNR 9 dB. Return SNR -2 dB/).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Clear saved route' }).click()
  await page.getByText('Cleared the saved route.').waitFor()
  assert.deepEqual(await page.evaluate(() => window.radioChanges.map(([code]) => code)), [9, 9, 36, 13])
})
