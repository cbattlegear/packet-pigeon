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
    const routed = contact.slice()
    routed.fill(0xee, 1, 33)
    routed[35] = 0x42
    routed.set([0x11, 0x22, 0x33, 0x44], 36)
    routed.fill(0, 100, 132)
    routed.set(encoder.encode('Routed relay'), 100)
    const temporary = contact.slice()
    temporary.fill(0xcd, 1, 33)
    temporary[33] = 0
    let routedPresent = true
    window.changeRoutedPath = () => { routed[36] = 0xaa }
    window.removeRouted = () => { routedPresent = false }
    window.commands = []
    window.holdDetails = false
    let controller
    let scanTag
    let hasTemporary = false
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
          emit([2, routedPresent ? 2 : 1, 0, 0, 0])
          emit(contact)
          if (routedPresent) emit(routed)
          emit([4, 0, 0, 0, 0])
        } else if (command[0] === 10) emit([10])
        else if (command[0] === 30) {
          if (command[1] === 0xbc) emit(contact)
          else if (command[1] === 0xee && routedPresent) emit(routed)
          else if (command[1] === 0xcd && hasTemporary) emit(temporary)
          else emit([1, 2])
        } else if (command[0] === 55) {
          scanTag = command.slice(3, 7)
          window.discoveryReply(0xbc)
          emit([0])
        } else if (command[0] === 57) {
          if (command[1] === 0xcd) hasTemporary = true
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
  await page.waitForFunction(() => window.commands.some(([code]) => code === 10))
  assert.deepEqual((await page.evaluate(() => window.commands)).map(([code]) => code), [22, 1, 4, 10])
  await page.getByLabel('Saved repeater').selectOption('ee'.repeat(32))
  assert.equal(await page.getByLabel('Reply path', { exact: true }).inputValue(), '3344 1122')
  await page.evaluate(() => window.changeRoutedPath())
  await page.getByRole('button', { name: 'Refresh radio contacts' }).click()
  await page.getByText('Radio contact list refreshed.').waitFor()
  assert(await page.getByRole('button', { name: 'Request owner info' }).isDisabled())
  await page.getByRole('button', { name: 'Use updated route' }).click()
  assert.equal(await page.getByLabel('Reply path', { exact: true }).inputValue(), '3344 aa22')
  await page.getByLabel('Reply path', { exact: true }).fill('aabb ccdd')
  await page.getByRole('button', { name: 'Request owner info' }).click()
  await page.getByText('Fixture owner', { exact: true }).waitFor()
  assert.deepEqual((await page.evaluate(() => window.commands)).at(-1).slice(33), [2, 0x42, 0xaa, 0xbb, 0xcc, 0xdd])
  await page.setViewportSize({ width: 360, height: 800 })
  const widths = await page.locator('#nearby-heading').locator('..')
    .evaluate((section) => ({
      content: section.scrollWidth, available: section.clientWidth,
      page: document.documentElement.scrollWidth, viewport: window.innerWidth,
    }))
  assert(widths.content <= widths.available)
  assert(widths.page <= widths.viewport)
  await page.setViewportSize({ width: 1280, height: 720 })
  await send.click()
  const results = page.getByRole('list', { name: 'Nearby discovery results' })
  await results.getByRole('button', { name: /Saved relay/ }).waitFor()
  await page.getByText(/Listening for up to 20 seconds/).waitFor()
  await page.evaluate(() => window.discoveryReply(0xcd))
  await page.evaluate(() => window.discoveryReply(0xee))
  await results.getByRole('button', { name: /Node cdcdcdcd/ }).click()
  await page.getByText(/may create or replace a temporary contact/).waitFor()
  assert(await page.getByRole('button', { name: 'Request regions' }).isDisabled())
  await page.getByRole('button', { name: 'Stop waiting' }).click()
  await page.getByText('Stopped waiting. A transmitted request cannot be recalled.').waitFor()
  const regions = page.getByRole('button', { name: 'Request regions' })
  assert(await regions.isEnabled())
  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /may create or replace a temporary contact/)
    await dialog.dismiss()
  })
  await regions.click()
  assert.equal((await page.evaluate(() => window.commands)).filter(([code]) => code === 57).length, 1)
  page.once('dialog', (dialog) => dialog.accept())
  await regions.click()
  await page.getByText('Local_É', { exact: true }).waitFor()
  await results.getByRole('button', { name: /Routed relay/ }).click()
  assert.equal(await page.getByLabel('Reply path', { exact: true }).inputValue(), '3344 aa22')
  await page.evaluate(() => window.removeRouted())
  await page.getByRole('button', { name: 'Refresh radio contacts' }).click()
  await page.getByText(/may create or replace a temporary contact/).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Request owner info' }).click()
  await page.waitForFunction(() => window.commands.filter(([code]) => code === 57).length === 3)
  assert.deepEqual((await page.evaluate(() => window.commands)).at(-1).slice(33), [2, 0])
  await results.getByRole('button', { name: /Saved relay/ }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Request regions' }).click()
  await page.getByText('Local_É', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Request owner info' }).click()
  await page.getByText('Fixture owner', { exact: true }).waitFor()
  assert.deepEqual((await page.evaluate(() => window.commands)).filter(([code]) => code === 57)
    .map((command) => command.slice(33)), [[2, 0x42, 0xaa, 0xbb, 0xcc, 0xdd], [1, 0], [2, 0], [1, 0], [2, 0]])

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
    [22, 1, 4, 10, 4, 30, 57, 55, 30, 57, 4, 30, 57, 30, 57, 30, 57, 55, 30, 57])
})

test('Bluetooth discovery is opt-in and explains incomplete replies', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.commands = []
    const tx = Object.assign(new EventTarget(), {
      properties: { notify: true },
      async startNotifications() { return this },
    })
    const emit = (bytes) => {
      const frame = Uint8Array.from(bytes)
      tx.value = new DataView(frame.buffer)
      tx.dispatchEvent(new Event('characteristicvaluechanged'))
    }
    const rx = {
      properties: { write: true },
      async writeValueWithResponse(bytes) {
        window.commands.push([...bytes])
        if (bytes[0] === 22) emit([13, 14, 40, 0, ...new Uint8Array(78)])
        else if (bytes[0] === 1) emit([5, 1, 0, 0, ...new Uint8Array(32).fill(0xab), ...new Uint8Array(22), ...new TextEncoder().encode('Fixture')])
        else if (bytes[0] === 4) { emit([2, 0, 0, 0, 0]); emit([4, 0, 0, 0, 0]) }
        else if (bytes[0] === 10) emit([10])
        else if (bytes[0] === 55) {
          emit([0x8e, 0xf8, 0x9c, 0, 0x92, 0xec, ...bytes.slice(3, 7), ...new Uint8Array(32).fill(0xcd)])
          emit([0])
        } else if (bytes[0] === 30) emit([1, 2])
        else if (bytes[0] === 57) {
          emit([0x8c, 0, 1, 2, 3, 4, 1, 0, 0, 0, ...new TextEncoder().encode('*,local')])
          emit([6, 0, 1, 2, 3, 4, 0xe8, 3, 0, 0])
        }
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
  const send = page.getByRole('button', { name: 'Send nearby discovery' })
  await send.waitFor({ state: 'visible' })
  await page.getByText(/Bluetooth may split or drop replies/).waitFor()
  assert(await send.isEnabled())
  await page.waitForFunction(() => window.commands.some(([code]) => code === 10))
  assert.deepEqual((await page.evaluate(() => window.commands)).map(([code]) => code), [22, 1, 4, 10])
  await send.click()
  await page.getByText(/Listening for up to 20 seconds/).waitFor()
  await page.getByRole('button', { name: /Node cdcdcdcd/ }).click()
  await page.getByRole('button', { name: 'Stop waiting' }).click()
  await page.getByText('Stopped waiting. A transmitted request cannot be recalled.').waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Request regions' }).click()
  await page.getByText('local', { exact: true }).waitFor()
  assert.deepEqual((await page.evaluate(() => window.commands)).map(([code]) => code), [22, 1, 4, 10, 55, 30, 57])
})
