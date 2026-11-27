import { openWorkspaceMenu } from './workspace-menu.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('refreshes and caches telemetry, polls only on request, and cancels when leaving', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  page.setDefaultTimeout(8000)
  await page.clock.install()
  await page.addInitScript(() => {
    const encode = new TextEncoder()
    const radio = new Uint8Array(32).fill(0xab)
    const contact = new Uint8Array(32).fill(0xbc)
    const node = new Uint8Array(148)
    node[0] = 3
    node.set(contact, 1)
    node.set([2, 0, 255], 33)
    node.set(encode.encode('Relay fixture'), 100)
    const fixture = { local: 0, remote: 0, hold: false }
    window.telemetryFixture = fixture
    let controller
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    const telemetry = (key, data) => emit([0x8b, 0, ...key.slice(0, 6), ...data])
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(incoming) { controller = incoming } }),
      writable: new WritableStream({ write(packet) {
        const command = packet.slice(3)
        if (command[0] === 22) emit([13, 14, 40, 0, ...new Uint8Array(78)])
        else if (command[0] === 1) emit([5, 1, 0, 0, ...radio, ...new Uint8Array(22), ...encode.encode('Telemetry fixture')])
        else if (command[0] === 4) {
          emit([2, 1, 0, 0, 0])
          emit(node)
          emit([4, 0, 0, 0, 0])
        } else if (command[0] === 10) emit([10])
        else if (command[0] === 39 && command.length === 4) {
          fixture.local++
          telemetry(radio, [1, 116, 1, 132, 2, 103, 0, 192])
        } else if (command[0] === 39 && command.length === 36 && command.slice(4).every((byte) => byte === 0xbc)) {
          fixture.remote++
          emit([6, 0, fixture.remote, 0, 0, 0, 0xe0, 0x93, 4, 0])
          if (!fixture.hold) telemetry(contact, [1, 116, 1, 120 + fixture.remote, 2, 104, 80])
        } else throw new Error(`Unexpected command ${command[0]}`)
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  const requests = () => page.evaluate(() => ({
    local: window.telemetryFixture.local, remote: window.telemetryFixture.remote,
  }))
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  const diagnostics = navigation.getByRole('link', { name: 'Diagnostics', exact: true })
  const contacts = navigation.getByRole('link', { name: 'Contacts', exact: true })
  const refresh = page.getByRole('button', { name: 'Refresh telemetry', exact: true })
  const poll = page.getByLabel('Poll every minute while this view is open')
  await page.goto(server.resolvedUrls.local[0] + '#diagnostics')
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByText('Radio telemetry', { exact: true }).click()
  await page.getByText('No telemetry has been saved for this device.').waitFor()
  assert.deepEqual(await requests(), { local: 0, remote: 0 })
  await refresh.click()
  await page.getByText('3.88 V', { exact: true }).waitFor()
  await page.getByText('19.2 °C', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Stop waiting' }).waitFor({ state: 'hidden' })
  assert.deepEqual(await requests(), { local: 1, remote: 0 })

  await contacts.click()
  await page.getByRole('button', { name: /^Relay fixture/ }).click()
  await page.getByText('Contact telemetry', { exact: true }).click()
  await page.getByText('No telemetry has been saved for this device.').waitFor()
  assert.deepEqual(await requests(), { local: 1, remote: 0 })
  await poll.check()
  await page.getByText('3.77 V', { exact: true }).waitFor()
  await page.getByText('40 %', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Stop waiting' }).waitFor({ state: 'hidden' })
  await page.clock.fastForward(61_000)
  await page.getByText('3.78 V', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Stop waiting' }).waitFor({ state: 'hidden' })
  await page.evaluate(() => { window.telemetryFixture.hold = true })
  await page.clock.fastForward(61_000)
  await page.getByText('Waiting for telemetry…', { exact: true }).waitFor()
  assert.deepEqual(await requests(), { local: 1, remote: 3 })
  await openWorkspaceMenu(page, 'More')
  await diagnostics.click()
  await page.getByText('Cached reading from', { exact: false }).waitFor()
  await refresh.click()
  await page.getByText('19.2 °C', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Stop waiting' }).waitFor({ state: 'hidden' })
  await page.clock.fastForward(130_000)
  assert.deepEqual(await requests(), { local: 2, remote: 3 })

  await contacts.click()
  await page.getByText('3.78 V', { exact: true }).waitFor()
  assert.equal(await poll.isChecked(), false)
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page.getByText('Cached reading from', { exact: false }).waitFor()
  assert.equal(await refresh.isDisabled(), true)
  await page.reload()
  await openWorkspaceMenu(page, 'More')
  await diagnostics.click()
  await page.getByText('Radio telemetry', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Telemetry cache radio' }).selectOption('ab'.repeat(32))
  await page.getByText('3.88 V', { exact: true }).waitFor()
  assert.equal(await refresh.isDisabled(), true)
  await page.setViewportSize({ width: 390, height: 844 })
  const sizes = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth, viewport: innerWidth,
    overflow: [...document.querySelectorAll('main *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
      .map((element) => element.className || element.tagName).slice(0, 20),
  }))
  assert.ok(sizes.page <= sizes.viewport, JSON.stringify(sizes))
})
