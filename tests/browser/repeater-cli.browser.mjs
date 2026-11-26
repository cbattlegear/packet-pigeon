import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('administrator CLI uses explicit sends and safely correlates synced replies', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  await page.clock.install()
  await page.addInitScript(() => {
    const encoder = new TextEncoder()
    const info = Uint8Array.of(13, 14, 40, 0, ...new Uint8Array(78))
    const device = Uint8Array.of(5, 1, 0, 0, ...new Uint8Array(32).fill(0xab),
      ...new Uint8Array(22), ...encoder.encode('CLI Fixture'))
    const target = new Uint8Array(148)
    target[0] = 3
    target.fill(0xbc, 1, 33)
    target.set([2, 0, 0], 33)
    target.set(encoder.encode('Fixture repeater'), 100)
    const commands = []
    const queue = []
    let controller
    let lastTag = ''
    window.fixtureRole = 0
    window.fixtureCommands = commands
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    const textFrame = (prefix, type, text) => Uint8Array.of(16, 0, 0, 0, ...new Uint8Array(6).fill(prefix),
      0, type, 1, 0, 0, 0, ...encoder.encode(text))
    window.queueRepeaterReply = (text) => queue.push(textFrame(0xbc, 1, `${lastTag}|${text}`))
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(incoming) { controller = incoming } }),
      writable: new WritableStream({ write(packet) {
        const command = packet.slice(3)
        commands.push([...command])
        if (command[0] === 22) emit(info)
        else if (command[0] === 1) emit(device)
        else if (command[0] === 4) {
          emit([2, 1, 0, 0, 0])
          emit(target)
          emit([4, 0, 0, 0, 0])
        } else if (command[0] === 26) {
          emit([6, 0, ...new Uint8Array(8)])
          emit([0x85, window.fixtureRole, ...target.slice(1, 7), 1, 0, 0, 0, 1, 2])
        } else if (command[0] === 2) {
          const text = new TextDecoder().decode(command.slice(13))
          lastTag = text.slice(0, 2)
          emit(window.fixtureUnconfirmed ? [6, 0] : [6, 0, 0, 0, 0, 0, 0xe8, 3, 0, 0])
          if (text.endsWith('|get name')) {
            queue.push(textFrame(0xcd, 1, `${lastTag}|wrong sender`))
            queue.push(textFrame(0xbc, 0, 'unrelated message'))
          }
        } else if (command[0] === 10) emit(queue.shift() ?? [10])
        else throw Error(`Unexpected command ${command[0]}`)
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  await page.goto(server.resolvedUrls.local[0] + '#contacts')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByRole('button', { name: /^Fixture repeater/ }).click()
  await page.getByText('Repeater login and status', { exact: true }).click()
  const password = page.getByLabel('Repeater password')
  await password.fill('fixture-secret')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByText(/Login reported guest access/).waitFor()
  assert.equal(await page.getByText('Administrator CLI', { exact: true }).count(), 0)
  await page.evaluate(() => { window.fixtureRole = 1 })
  await password.fill('fixture-secret')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByText(/Login reported admin access/).waitFor()
  assert.equal(await password.inputValue(), '')
  await page.getByText('Administrator CLI', { exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const search = page.getByLabel('Search CLI commands and history')
  await search.focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: /ver.*Read the firmware version/ }).evaluate((element) => element === document.activeElement), true)
  await page.setViewportSize({ width: 1280, height: 720 })
  await search.fill('name')
  await page.getByRole('button', { name: /get name.*Read the advertised name/ }).click()
  await page.getByRole('button', { name: 'Send get name' }).click()
  await page.getByText(/Accepted by radio \(direct\)/).waitFor()
  assert.equal(await page.evaluate(() => window.fixtureCommands.filter(([code]) => code === 10).length), 0)
  const sync = page.getByRole('button', { name: 'Sync messages for replies' })
  await sync.click()
  await page.waitForFunction(() => window.fixtureCommands.filter(([code]) => code === 10).length === 3)
  await page.getByText('Waiting for a reply. Sync messages to check.').waitFor()
  assert.equal(await page.getByText('wrong sender', { exact: true }).count(), 0)
  await page.evaluate(() => window.queueRepeaterReply('> Relay working'))
  await sync.click()
  await page.getByText('> Relay working', { exact: true }).waitFor()
  await search.fill('Relay working')
  assert.equal(await page.getByText('> Relay working', { exact: true }).count(), 1)
  await page.getByText('No commands match.').waitFor()
  const saved = await page.evaluate(async () => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return await storage.read(radioKeyFromPublicKey('ab'.repeat(32))) } finally { storage.close() }
  })
  assert(saved.messages.some((message) => message.text === 'unrelated message'))
  assert(saved.messages.some((message) => message.text.endsWith('|> Relay working')))
  assert.equal(JSON.stringify(saved).includes('fixture-secret'), false)

  await search.fill('zero-hop')
  await page.getByRole('button', { name: /advert.zerohop.*Send a zero-hop advertisement/ }).click()
  const advert = page.getByRole('button', { name: 'Send advert.zerohop' })
  page.once('dialog', (dialog) => dialog.dismiss())
  await advert.click()
  assert.equal(await page.evaluate(() => window.fixtureCommands.filter(([code]) => code === 2).length), 1)
  page.once('dialog', (dialog) => dialog.accept())
  await advert.click()
  await page.getByText('Waiting for a reply. Sync messages to check.').waitFor()
  assert.equal(await page.evaluate(() => window.fixtureCommands.filter(([code]) => code === 2).length), 2)
  await page.clock.fastForward(11_000)
  await page.getByText('No reply synced before the deadline. It may still arrive.').waitFor()
  await page.evaluate(() => window.queueRepeaterReply('OK - zerohop advert sent'))
  await sync.click()
  await page.getByText('OK - zerohop advert sent', { exact: true }).waitFor()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByText('Change advertisement interval', { exact: true }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const value = page.getByLabel('Interval value')
  const setInterval = page.getByRole('button', { name: 'Set interval', exact: true })
  await value.fill('61')
  await setInterval.click()
  await page.getByText(/even local interval/).waitFor()
  assert.equal(await page.evaluate(() => window.fixtureCommands.filter(([code]) => code === 2).length), 2)
  await value.fill('60')
  await search.fill('local')
  page.once('dialog', (dialog) => dialog.dismiss())
  await setInterval.click()
  assert.equal(await page.evaluate(() => window.fixtureCommands.filter(([code]) => code === 2).length), 2)
  page.once('dialog', (dialog) => dialog.accept())
  await setInterval.click()
  assert.equal(await search.inputValue(), 'local')
  const localHistory = page.locator('.repeater-cli-history li').filter({ hasText: 'set advert.interval 60' })
  await localHistory.getByText(/Accepted by radio/).waitFor()
  await localHistory.getByText('Waiting for a reply. Sync messages to check.').waitFor()
  assert.equal(await page.evaluate(() => new TextDecoder().decode(Uint8Array.from(
    window.fixtureCommands.filter(([code]) => code === 2).at(-1).slice(13))).slice(3)), 'set advert.interval 60')
  await page.evaluate(() => window.queueRepeaterReply('OK'))
  await sync.click()
  await localHistory.getByText('OK', { exact: true }).waitFor()
  await page.getByLabel('Advertisement interval type').selectOption('flood.advert.interval')
  await value.fill('0')
  await search.fill('disable')
  await page.evaluate(() => { window.fixtureUnconfirmed = true })
  page.once('dialog', (dialog) => {
    assert.match(dialog.message(), /Disable flood advertisements/)
    void dialog.accept()
  })
  await setInterval.click()
  assert.equal(await search.inputValue(), 'disable')
  const floodHistory = page.locator('.repeater-cli-history li').filter({ hasText: 'set flood.advert.interval 0' })
  await floodHistory.getByText(/Send unconfirmed/).waitFor()
  assert.equal(await page.evaluate(() => new TextDecoder().decode(Uint8Array.from(
    window.fixtureCommands.filter(([code]) => code === 2).at(-1).slice(13))).slice(3)), 'set flood.advert.interval 0')
  await page.evaluate(() => window.queueRepeaterReply('Flood disabled'))
  await sync.click()
  await floodHistory.getByText('Flood disabled', { exact: true }).waitFor()
})
