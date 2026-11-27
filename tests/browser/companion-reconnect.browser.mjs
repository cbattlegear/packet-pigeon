import { openWorkspaceMenu } from './workspace-menu.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('USB companion restores after refresh and deliberate disconnect remains deliberate', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const fixture = { choices: 0, scans: 0, commands: [] }
    window.connectionFixture = fixture
    let incoming
    const encoder = new TextEncoder()
    const emit = (bytes) => incoming.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(controller) { incoming = controller } }),
      writable: new WritableStream({ write(packet) {
        const command = [...packet.slice(3)]
        fixture.commands.push(command)
        if (command[0] === 22) {
          emit(Uint8Array.of(13, 14, 100, 0, ...new Uint8Array(78)))
        } else if (command[0] === 1) {
          emit(Uint8Array.of(
            5, 1, 0, 0, ...new Uint8Array(32).fill(0xab),
            ...new Uint8Array(22), ...encoder.encode('Browser Refresh Fixture'),
          ))
        } else if (command[0] === 4) {
          emit([2, 0, 0, 0, 0])
          emit([4, 0, 0, 0, 0])
        } else if (command[0] === 10) {
          emit([10])
        } else {
          throw Error(`Unexpected command ${command[0]}`)
        }
      } }),
      async open() {},
      async close() {},
      getInfo() { return { usbVendorId: 1, usbProductId: 2 } },
    })
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: {
        async requestPort() { fixture.choices++; return port },
        async getPorts() {
          fixture.scans++
          return sessionStorage.getItem('packet-pigeon:hide-port') ? [] : [port]
        },
      },
    })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  await page.goto(server.resolvedUrls.local[0])
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByText('Browser Refresh Fixture · USB', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.connectionFixture.choices), 1)
  assert(await page.evaluate(() => localStorage.getItem('packet-pigeon:companion-connection')))

  await page.evaluate(() => sessionStorage.setItem('packet-pigeon:hide-port', '1'))
  await page.reload()
  await page.getByText(/The saved USB radio is unavailable/).waitFor()
  assert.equal(await page.evaluate(() => window.connectionFixture.choices), 0)
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.commands), [])
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).waitFor()

  await page.evaluate(() => sessionStorage.removeItem('packet-pigeon:hide-port'))
  await page.reload()
  await page.getByText('Browser Refresh Fixture · USB', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.connectionFixture.choices), 0)
  assert.equal(await page.evaluate(() => window.connectionFixture.scans), 1)
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.commands.slice(0, 3).map(([code]) => code)), [22, 1, 4])

  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.getByText('Connect radio', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('packet-pigeon:companion-connection')), null)
  await page.reload()
  await page.getByText('Connect radio', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.connectionFixture.scans), 0)
  assert.deepEqual(await page.evaluate(() => window.connectionFixture.commands), [])
})
