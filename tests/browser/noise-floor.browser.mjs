import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('noise-floor polling is opt-in and stops on cancel or navigation', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() => {
    const info = Uint8Array.of(13, 14, 40, 0, ...new Uint8Array(78))
    const device = Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(0xab), ...new Uint8Array(22), ...new TextEncoder().encode('Fixture'))
    window.commands = []
    window.holdNoise = false
    let controller
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    window.replyNoise = () => emit([24, 1, 0x85, 0xff, ...new Uint8Array(10)])
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(incoming) { controller = incoming } }),
      writable: new WritableStream({ write(packet) {
        const command = [...packet.slice(3)]
        window.commands.push(command)
        if (command[0] === 22) emit(info)
        else if (command[0] === 1) emit(device)
        else if (command[0] === 4) { emit([2, 0, 0, 0, 0]); emit([4, 0, 0, 0, 0]) }
        else if (command[0] === 56) { if (!window.holdNoise) window.replyNoise() }
        else throw Error('Unexpected command')
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#discovery')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  const start = page.getByRole('button', { name: 'Start noise-floor polling' })
  await start.waitFor({ state: 'visible' })
  assert.equal((await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length, 0)
  await start.click()
  await page.getByText(/Last reading: -123 dBm/).waitFor()
  await page.getByRole('button', { name: 'Stop noise-floor polling' }).click()
  const count = (await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length
  await page.waitForTimeout(2200)
  assert.equal((await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length, count)
  await start.click()
  await page.getByText('Polling noise floor.', { exact: true }).waitFor()
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Contacts' }).click()
  const afterNavigation = (await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length
  await page.waitForTimeout(2200)
  assert.equal((await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length, afterNavigation)
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Discovery' }).click()
  await page.evaluate(() => { window.holdNoise = true })
  await start.click()
  await page.getByText('Reading noise floor…').waitFor()
  await page.getByRole('button', { name: 'Stop noise-floor polling' }).click()
  await page.getByText('Finishing the current read…').waitFor()
  assert(await start.isDisabled())
  await page.evaluate(() => window.replyNoise())
  await page.getByText('Noise-floor polling stopped.').waitFor()
  assert(await start.isEnabled())
  const afterReply = (await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length
  await page.waitForTimeout(2200)
  assert.equal((await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length, afterReply)
})

test('Bluetooth noise-floor polling is opt-in, local, and stops on errors or navigation', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.commands = []
    window.noiseReply = [24, 1, 0x85, 0xff, ...new Uint8Array(10)]
    window.holdNoise = false
    const tx = Object.assign(new EventTarget(), {
      properties: { notify: true },
      async startNotifications() { return this },
    })
    const emit = (bytes) => {
      const frame = Uint8Array.from(bytes)
      tx.value = new DataView(frame.buffer)
      tx.dispatchEvent(new Event('characteristicvaluechanged'))
    }
    window.replyNoise = () => emit(window.noiseReply)
    const rx = {
      properties: { write: true },
      async writeValueWithResponse(bytes) {
        window.commands.push([...bytes])
        if (bytes[0] === 22) emit([13, 14, 40, 0, ...new Uint8Array(78)])
        else if (bytes[0] === 1) emit([5, 1, 0, 0, ...new Uint8Array(32).fill(0xab), ...new Uint8Array(22), ...new TextEncoder().encode('Fixture')])
        else if (bytes[0] === 4) { emit([2, 0, 0, 0, 0]); emit([4, 0, 0, 0, 0]) }
        else if (bytes[0] === 56) { if (!window.holdNoise) window.replyNoise() }
        else throw Error(`Unexpected command ${bytes[0]}`)
      },
    }
    const device = new EventTarget()
    const gatt = {
      connected: false,
      async connect() { this.connected = true; return this },
      disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')) },
      async getPrimaryService() {
        return { async getCharacteristic(uuid) { return uuid.startsWith('6e400002') ? rx : tx } }
      },
    }
    device.gatt = gatt
    Object.defineProperty(navigator, 'bluetooth', { value: { async requestDevice() { return device } } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#discovery')
  await page.getByRole('button', { name: 'Connect Bluetooth' }).click()
  const monitor = page.getByRole('region', { name: 'Live noise floor' })
  const start = monitor.getByRole('button', { name: 'Start noise-floor polling' })
  await monitor.getByText(/Bluetooth notifications can be split or dropped/).waitFor()
  assert(await start.isEnabled())
  assert.deepEqual((await page.evaluate(() => window.commands)).map(([code]) => code), [22, 1, 4])
  await start.click()
  await monitor.getByText(/Last reading: -123 dBm/).waitFor()
  assert.deepEqual((await page.evaluate(() => window.commands)).at(-1), [56, 1])
  await page.evaluate(() => { window.noiseReply[2] = 0x84 })
  await monitor.getByText(/Last reading: -124 dBm/).waitFor()
  assert((await page.evaluate(() => window.commands)).filter(([code]) => code === 56).length >= 2)
  await monitor.getByRole('button', { name: 'Stop noise-floor polling' }).click()
  const afterStop = (await page.evaluate(() => window.commands)).length
  await page.waitForTimeout(2200)
  assert.equal((await page.evaluate(() => window.commands)).length, afterStop)

  await page.evaluate(() => { window.holdNoise = true })
  await start.click()
  await monitor.getByText('Reading noise floor…').waitFor()
  await monitor.getByRole('button', { name: 'Stop noise-floor polling' }).click()
  await monitor.getByText('Finishing the current read…').waitFor()
  assert(await start.isDisabled())
  await page.evaluate(() => { window.holdNoise = false; window.replyNoise() })
  await monitor.getByText('Noise-floor polling stopped.').waitFor()
  assert(await start.isEnabled())

  await page.evaluate(() => { window.noiseReply = [24, 1, 0x85] })
  await start.click()
  await monitor.getByRole('alert').getByText(/invalid radio statistics/).waitFor()
  assert(await monitor.getByRole('button', { name: 'Stop noise-floor polling' }).isDisabled())
  await page.evaluate(() => { window.noiseReply = [24, 1, 0x85, 0xff, ...new Uint8Array(10)] })
  await start.click()
  await monitor.getByText(/Last reading: -123 dBm/).waitFor()
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Contacts' }).click()
  const afterNavigation = (await page.evaluate(() => window.commands)).length
  await page.waitForTimeout(2200)
  assert.equal((await page.evaluate(() => window.commands)).length, afterNavigation)
  assert.equal((await page.evaluate(() => window.commands)).some(([code]) => code === 55 || code === 57), false)
})
