import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('active discovery sends only chosen requests and stops listening on navigation', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  await page.addInitScript(() => {
    const encoder = new TextEncoder()
    const info = Uint8Array.of(13, 14, 40, 0, ...new Uint8Array(78))
    const device = Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(0xab),
      ...new Uint8Array(22), ...encoder.encode('Discovery Fixture'))
    const contact = new Uint8Array(148)
    contact[0] = 3
    contact.fill(0xbc, 1, 33)
    contact.set([2, 0, 0], 33)
    contact.set(encoder.encode('Saved relay'), 100)
    window.commands = []
    window.holdDetails = false
    let controller
    let scanTag
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    window.discoveryReply = (key) => emit([0x8e, 0xf8, 0x9c, 0, 0x92, 0xec, ...scanTag, ...new Uint8Array(32).fill(key)])
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(incoming) { controller = incoming } }),
      writable: new WritableStream({ write(packet) {
        const command = [...packet.slice(3)]
        window.commands.push(command)
        if (command[0] === 22) emit(info)
        else if (command[0] === 1) emit(device)
        else if (command[0] === 4) {
          emit([2, 1, 0, 0, 0])
          emit(contact)
          emit([4, 0, 0, 0, 0])
        } else if (command[0] === 55) {
          scanTag = command.slice(3, 7)
          window.discoveryReply(0xbc)
          emit([0])
        } else if (command[0] === 57) {
          const tag = [1, 2, 3, 4]
          const ack = () => emit([6, 0, ...tag, 0xe8, 3, 0, 0])
          if (window.holdDetails) window.releaseDetails = ack
          else {
            const body = command[33] === 1 ? '*,Local_É' : 'Relay\nFixture owner'
            emit([0x8c, 0, ...tag, 1, 0, 0, 0, ...encoder.encode(body)])
            ack()
          }
        } else throw Error(`Unexpected command ${command[0]}`)
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#discovery')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  const send = page.getByRole('button', { name: 'Send nearby discovery' })
  await send.waitFor({ state: 'visible' })
  assert.deepEqual((await page.evaluate(() => window.commands)).map(([code]) => code), [22, 1, 4])
  await send.click()
  const results = page.getByRole('list', { name: 'Nearby discovery results' })
  await results.getByRole('button', { name: /Saved relay/ }).waitFor()
  await page.getByText(/Listening for up to 20 seconds/).waitFor()
  await page.evaluate(() => window.discoveryReply(0xcd))
  await results.getByRole('button', { name: /Node cdcdcdcd/ }).click()
  await page.getByText(/Save this repeater in Contacts/).waitFor()
  assert(await page.getByRole('button', { name: 'Request regions' }).isDisabled())
  await results.getByRole('button', { name: /Saved relay/ }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Stop waiting' }).click()
  await page.getByText('Stopped waiting. A transmitted request cannot be recalled.').waitFor()
  await page.getByRole('button', { name: 'Request regions' }).click()
  await page.getByText('Local_É', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Request owner info' }).click()
  await page.getByText('Fixture owner', { exact: true }).waitFor()
  assert.deepEqual((await page.evaluate(() => window.commands)).filter(([code]) => code === 57)
    .map((command) => command.slice(33)), [[1, 0], [2, 0]])
  await page.setViewportSize({ width: 360, height: 800 })
  const widths = await page.locator('#nearby-heading').locator('..')
    .evaluate((section) => ({ content: section.scrollWidth, available: section.clientWidth }))
  assert(widths.content <= widths.available)
  await page.setViewportSize({ width: 1280, height: 720 })

  await send.click()
  await page.getByText(/Listening for up to 20 seconds/).waitFor()
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  await navigation.getByRole('link', { name: 'Contacts', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#nearby-heading')?.parentElement
    ?.querySelector('[role="status"]')?.textContent?.startsWith('Stopped waiting.'))
  await page.evaluate(() => window.discoveryReply(0xdd))
  await navigation.getByRole('link', { name: 'Discovery', exact: true }).click()
  assert.equal(await results.getByRole('button', { name: /Node dddddddd/ }).count(), 0)
  await results.getByRole('button', { name: /Saved relay/ }).click()
  await page.evaluate(() => { window.holdDetails = true })
  await page.getByRole('button', { name: 'Request regions' }).click()
  await page.getByText('Sending the requested radio command…').waitFor()
  await page.waitForFunction(() => typeof window.releaseDetails === 'function')
  await page.getByRole('button', { name: 'Stop waiting' }).click()
  await page.getByText(/Stopping; an in-flight radio command/).waitFor()
  assert(await send.isDisabled())
  await page.evaluate(() => window.releaseDetails())
  await page.getByText('Stopped waiting. A transmitted request cannot be recalled.').waitFor()
  assert(await send.isEnabled())
  assert.deepEqual((await page.evaluate(() => window.commands)).map(([code]) => code),
    [22, 1, 4, 55, 4, 57, 4, 57, 55, 4, 57])
})
