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
