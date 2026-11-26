import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('edits radio settings, reports partial saves, and writes credentials without displaying them', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1200, height: 840 } })
  page.setDefaultTimeout(10000)
  await page.addInitScript(() => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const info = Uint8Array.of(13, 14, 40, 0, ...new Uint8Array(78))
    const self = Uint8Array.of(5, 1, 7, 20, ...new Uint8Array(32).fill(0xab),
      ...new Uint8Array(22), ...encoder.encode('Settings Fixture'))
    const selfData = new DataView(self.buffer)
    selfData.setUint32(48, 918000, true)
    selfData.setUint32(52, 62500, true)
    self.set([7, 5], 56)
    self[47] = 0x81
    const changes = []
    const cliCommands = []
    window.settingsFixture = { changes, cliCommands }
    let region = null
    let gps = false
    let interval = 10
    let ssid = 'Previous network'
    let wifi = false
    let clock = 1000
    let controller
    const emit = (bytes) => controller.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
    const cli = (result) => emit([29, ...encoder.encode(result)])
    const range = Uint8Array.of(26, ...new Uint8Array(8))
    const rangeData = new DataView(range.buffer)
    rangeData.setUint32(1, 918000, true)
    rangeData.setUint32(5, 918000, true)
    const port = Object.assign(new EventTarget(), {
      readable: new ReadableStream({ start(incoming) { controller = incoming } }),
      writable: new WritableStream({ write(packet) {
        const command = packet.slice(3)
        const code = command[0]
        if (code === 22) emit(info)
        else if (code === 1) emit(self)
        else if (code === 4) {
          emit([2, 0, 0, 0, 0])
          emit([4, 0, 0, 0, 0])
        } else if (code === 5) {
          const body = new Uint8Array(5)
          body[0] = 9
          new DataView(body.buffer).setUint32(1, clock, true)
          emit(body)
        } else if (code === 20) {
          emit([12, 0, 0, 50, 0, 0, 0, 100, 0, 0, 0])
        } else if (code === 40) {
          emit([21, ...encoder.encode(`gps:${Number(gps)},gps_interval:${interval}`)])
        } else if (code === 60) {
          emit(range)
        } else if (code === 64) {
          emit(region ? [28, ...region] : [28])
        } else if (code === 66) {
          const text = decoder.decode(command.slice(1))
          cliCommands.push(text)
          if (text === 'get wifi.enabled') cli(`> ${Number(wifi)}`)
          else if (text === 'get wifi.ssid') cli(`> ${ssid}`)
          else if (text.startsWith('set wifi.ssid ')) {
            ssid = text.slice(14)
            cli(`> wifi.ssid is now ${ssid} (set wifi.pwd too, then reboot)`)
          } else if (text.startsWith('set wifi.pwd ')) cli('> wifi.pwd updated (reboot to apply)')
          else if (text.startsWith('set wifi.enabled ')) {
            wifi = text.endsWith('1')
            cli(`> wifi.enabled is now ${Number(wifi)} (reboot to apply)`)
          } else throw new Error('Unexpected local CLI command')
        } else {
          changes.push([...command])
          if (code === 6) clock = new DataView(command.buffer, command.byteOffset).getUint32(1, true)
          else if (code === 41) {
            const text = decoder.decode(command.slice(1))
            if (text.startsWith('gps_interval:')) interval = Number(text.split(':')[1])
            else gps = text === 'gps:1'
          } else if (code === 63) region = command.slice(1)
          emit(code === 12 ? [1, 6] : [0])
        }
      } }),
      async open() {}, async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })

  await page.goto(server.resolvedUrls.local[0] + '#settings')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  const settings = page.getByRole('region', { name: 'Radio device settings' })
  const results = settings.getByRole('list', { name: 'Radio settings results' })
  const confirm = async (name) => {
    page.once('dialog', (dialog) => dialog.accept())
    await settings.getByRole('button', { name, exact: true }).click()
  }
  await settings.getByText(/protocol v14/).waitFor()
  await settings.getByLabel('Radio name', { exact: true }).fill('New Pigeon')
  await settings.getByLabel('Load a preset').selectOption({ label: 'USA / Canada' })
  assert.equal(await settings.getByLabel('Frequency (MHz)').inputValue(), '910.525')
  await settings.getByLabel('Transmit power (dBm)').fill('15')
  await settings.getByLabel('Default path hash width').selectOption('3')
  await settings.getByLabel('Location telemetry').selectOption('1')
  await settings.getByRole('button', { name: 'Save radio settings', exact: true }).click()
  assert.equal(await page.evaluate(() => window.settingsFixture.changes.length), 0)
  await confirm('Save radio settings')
  await results.getByText(/Transmit power · Failed/).waitFor()
  await results.getByText(/Default path hash width · Saved/).waitFor()
  await results.getByText(/Advert and message policies · Saved/).waitFor()
  assert.deepEqual(await page.evaluate(() => window.settingsFixture.changes.at(-1)), [38, 0x81, 4])

  await settings.getByText('Advanced radio settings', { exact: true }).click()
  await settings.getByRole('button', { name: 'Read advanced settings' }).click()
  await settings.getByText('50 / 100 KB', { exact: true }).waitFor()
  await settings.getByLabel('Region name').fill('North')
  await confirm('Save default region')
  await results.getByText(/Default region · Saved/).waitFor()
  assert.equal(await settings.getByLabel('Region name').inputValue(), '#North')
  await settings.getByLabel('Enable GPS', { exact: true }).check()
  await settings.getByLabel('GPS interval (seconds)').fill('25')
  await confirm('Save GPS settings')
  await results.getByText(/GPS update interval · Saved/).waitFor()
  await confirm('Sync radio clock')
  await results.getByText(/Radio clock · Saved/).waitFor()

  const pin = settings.getByLabel('New BLE PIN')
  await pin.fill('246810')
  assert.equal(await pin.getAttribute('type'), 'password')
  await confirm('Set BLE PIN')
  await results.getByText(/BLE pairing PIN · Saved/).waitFor()
  assert.equal(await pin.inputValue(), '')
  await settings.getByLabel('Wi-Fi network name').fill('Radio lab fixture')
  const password = settings.getByLabel('New Wi-Fi password')
  await password.fill('fixture-credential')
  await settings.getByLabel('Enable device Wi-Fi').check()
  await confirm('Save Wi-Fi settings')
  await results.getByText(/Wi-Fi mode · Saved/).waitFor()
  assert.equal(await password.inputValue(), '')
  assert.equal(await settings.getByText('fixture-credential', { exact: false }).count(), 0)
  const commands = await page.evaluate(() => window.settingsFixture.cliCommands)
  assert.ok(commands.includes('set wifi.pwd fixture-credential'))
  assert.ok(!commands.includes('get wifi.pwd'))
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
})
