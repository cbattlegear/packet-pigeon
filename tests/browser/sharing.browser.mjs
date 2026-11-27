import { openWorkspaceMenu } from './workspace-menu.mjs'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const radio = 'ab'.repeat(32)
const contact = 'cd'.repeat(32)
let server
let browser
let url

before(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  await server.listen()
  url = server.resolvedUrls.local[0]
  browser = await chromium.launch({ channel: 'chrome' })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

async function seed(page) {
  await page.evaluate(async ({ radio, contact }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      await storage.update(radioKeyFromPublicKey(radio), {
        contacts: [{ publicKey: contact, name: 'Test contact', details: {
          type: 1, flags: 0, pathLength: 255, pathHex: '', lastAdvertisedAt: 0,
          latitude: 40, longitude: -89, lastModifiedAt: 0,
        } }],
      })
    } finally {
      storage.close()
    }
  }, { radio, contact })
}

test('round-trips a contact QR through the import preview without writing to a disconnected radio', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  await page.goto(`${url}#contacts`)
  await seed(page)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  await page.getByRole('button', { name: /Test contact/ }).click()
  await page.getByRole('button', { name: 'Share contact link or QR code' }).click()
  const share = page.getByRole('dialog', { name: 'Share MeshCore link' })
  const link = await share.getByLabel('Share link').inputValue()
  assert.match(link, /^meshcore:\/\/contact\/add\?name=Test\+contact/)
  const qr = await share.getByRole('img', { name: 'MeshCore share QR code' }).getAttribute('src')
  assert.ok(qr?.startsWith('data:image/png;base64,'))
  await page.keyboard.press('Escape')
  await share.waitFor({ state: 'detached' })
  await page.getByRole('link', { name: 'Channels' }).click()
  await page.getByRole('button', { name: 'Import link or QR code' }).click()
  const importer = page.getByRole('dialog', { name: 'Import MeshCore share' })
  await importer.getByLabel('Read QR image').setInputFiles({
    name: 'contact.png', mimeType: 'image/png', buffer: Buffer.from(qr.split(',')[1], 'base64'),
  })
  await importer.getByRole('heading', { name: 'Contact Test contact' }).waitFor()
  assert(await importer.getByRole('button', { name: 'Add contact' }).isDisabled())
  await importer.getByRole('button', { name: 'Discard preview' }).click()
  await importer.getByLabel('MeshCore link').fill('javascript:alert(1)')
  await importer.getByRole('button', { name: 'Review link' }).click()
  await importer.getByRole('alert').getByText('Enter a MeshCore contact or channel share link.').waitFor()
  await importer.getByLabel('MeshCore link')
    .fill('meshcore://channel/add?name=Local&secret=abcdef1234567890abcdef1234567890&region_scope=local')
  await importer.getByRole('button', { name: 'Review link' }).click()
  await importer.getByRole('checkbox', { name: /Join without the provided region scope/ }).waitFor()
  assert.equal(await importer.getByText('abcdef1234567890abcdef1234567890', { exact: false }).count(), 0)
})

test('releases a delayed camera stream when scanning is canceled', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.cameraStopped = false
    const fixture = { getTracks: () => [{ stop: () => { window.cameraStopped = true } }] }
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => {
      window.allowCamera = () => resolve(fixture)
    })
  })
  await page.goto(`${url}#contacts`)
  await page.getByRole('button', { name: 'Import link or QR code' }).click()
  await page.getByRole('button', { name: 'Scan with camera' }).click()
  await page.waitForFunction(() => Boolean(window.allowCamera))
  await page.getByRole('button', { name: 'Stop camera' }).click()
  await page.evaluate(() => window.allowCamera())
  await page.waitForFunction(() => window.cameraStopped)
  assert.equal(await page.getByLabel('QR camera preview').count(), 0)
})

test('edits quick messages and only inserts a location after explicit confirmation', async (t) => {
  const context = await browser.newContext({
    permissions: ['geolocation'], geolocation: { latitude: 40, longitude: -89 },
  })
  t.after(() => context.close())
  const page = await context.newPage()
  await page.goto(`${url}#chats`)
  await seed(page)
  await page.reload()
  await page.getByRole('combobox', { name: 'Cached radio' }).selectOption(radio)
  const draft = page.getByRole('textbox', { name: 'Message', exact: true })
  const tools = page.getByRole('button', { name: 'Share or use quick message' })
  const dialog = page.getByRole('dialog', { name: 'Add to message' })
  await draft.fill('Existing draft')
  await tools.click()
  await dialog.getByRole('textbox', { name: 'New quick message' }).fill('On the way')
  await dialog.getByRole('button', { name: 'Save quick message' }).click()
  await dialog.getByRole('button', { name: 'Edit quick message 1' }).click()
  await dialog.getByRole('textbox', { name: 'Edit quick message' }).fill('Almost there')
  await dialog.getByRole('button', { name: 'Save quick message' }).click()
  await dialog.getByRole('button', { name: 'Almost there', exact: true }).click()
  assert.equal(await draft.inputValue(), 'Existing draft\nAlmost there')
  await tools.click()
  await dialog.getByRole('button', { name: 'My current location' }).click()
  assert.equal(await draft.inputValue(), 'Existing draft\nAlmost there')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await draft.fill('x'.repeat(150))
  await tools.click()
  await dialog.getByRole('button', { name: 'Almost there', exact: true }).click()
  await dialog.getByRole('alert').getByText(/must fit in 158 UTF-8 bytes/).waitFor()
  assert.equal(await draft.inputValue(), 'x'.repeat(150))
  await dialog.getByRole('button', { name: 'Close' }).click()
  await draft.fill('')
  await tools.click()
  page.once('dialog', (prompt) => prompt.accept())
  await dialog.getByRole('button', { name: 'My current location' }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await draft.inputValue(), 'https://www.openstreetmap.org/?mlat=40.00000&mlon=-89.00000')
})

test('exports a radio preset and confirms setup writes while reporting a partial failure', async (t) => {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.addInitScript(() => {
    const name = new TextEncoder().encode('Setup Fixture')
    const settings = new Uint8Array(58 + name.length)
    settings.set([5, 1], 0)
    settings.fill(0xab, 4, 36)
    settings.set(name, 58)
    const initial = new DataView(settings.buffer)
    initial.setUint32(48, 915000, true)
    initial.setUint32(52, 125000, true)
    settings.set([8, 5], 56)
    const capability = new Uint8Array(82)
    capability.set([13, 14, 50, 1])
    capability.set([1, 2], 80)
    const commands = []
    window.setupWrites = commands
    let incoming
    const readable = new ReadableStream({ start(controller) { incoming = controller } })
    function emit(data) { incoming.enqueue(Uint8Array.of(0x3e, data.length, 0, ...data)) }
    const port = Object.assign(new EventTarget(), {
      readable,
      writable: new WritableStream({ write(frame) {
        const data = frame.slice(3)
        switch (data[0]) {
          case 22: emit(capability); break
          case 1: emit(settings); break
          case 4: emit([2, 0, 0, 0, 0]); emit([4, 0, 0, 0, 0]); break
          case 10: emit([10]); break
          case 31: emit([18, 0, ...new Uint8Array(48)]); break
          case 61: commands.push([...data]); emit([1, 5]); break
          case 9: case 11: case 32: commands.push([...data]); emit([0]); break
          default: throw Error('Unexpected fixture command')
        }
      } }),
      async open() {},
      async close() {},
    })
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port } } })
  })
  const page = await context.newPage()
  await page.goto(`${url}#settings`)
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  const exportPreset = page.getByRole('button', { name: 'Share current radio preset' })
  await exportPreset.click()
  const exported = page.getByRole('dialog', { name: 'Share MeshCore link' })
  const link = new URL(await exported.getByLabel('Share link').inputValue())
  assert.equal(link.hostname, 'companion-setup')
  const payload = JSON.parse(link.searchParams.get('json'))
  assert.equal(payload.radio_settings.frequency, '915')
  assert.equal(payload.radio_settings.network_settings.path_hash_size, 3)
  assert.equal(payload.channels, undefined)
  await exported.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Import link or QR code' }).click()
  const imported = page.getByRole('dialog', { name: 'Import MeshCore share' })
  link.searchParams.set('json', JSON.stringify({
    ...payload, title: 'Apply test setup',
    radio_settings: { ...payload.radio_settings, frequency: '910.525', network_settings: { path_hash_size: 2 } },
    contacts: [{ name: 'New peer', public_key: contact, type: 1 }],
    channels: [{ name: 'Scoped channel', secret: '12'.repeat(16), region_scope: 'local' }],
  }))
  await imported.getByLabel('MeshCore link').fill(link.href)
  await imported.getByRole('button', { name: 'Review link' }).click()
  await imported.getByRole('checkbox', { name: /Set radio preset to 910.525/ }).check()
  await imported.getByRole('checkbox', { name: 'Use 2-byte path hashes' }).check()
  await imported.getByRole('list', { name: 'Channel region scopes' }).getByText('Scoped channel: local').waitFor()
  const apply = imported.getByRole('button', { name: 'Apply selected setup' })
  await apply.click()
  assert.deepEqual(await page.evaluate(() => window.setupWrites), [])
  page.once('dialog', (prompt) => prompt.accept())
  await apply.click()
  const results = imported.getByRole('list', { name: 'Setup results' })
  await results.getByText(/Contact New peer:/).waitFor({ timeout: 5000 })
  assert.match(await results.innerText(), /Contact New peer: applied/)
  assert.match(await results.innerText(), /Radio preset: applied/)
  assert.match(await results.innerText(), /Path hash width: The companion rejected the command/)
  const writes = await page.evaluate(() => window.setupWrites)
  assert.deepEqual(writes.map(([code]) => code), [11, 61, 9])
  assert.equal(writes[0].at(-1), 1)
})
