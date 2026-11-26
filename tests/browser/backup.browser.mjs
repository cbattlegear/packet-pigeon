import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

async function identityFixture() {
  while (true) {
    const seed = randomBytes(32)
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der', type: 'pkcs8' })
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
    if (publicKey.startsWith('00') || publicKey.startsWith('ff')) continue
    const bytes = Buffer.from(await crypto.subtle.digest('SHA-512', seed))
    bytes[0] &= 248
    bytes[31] = (bytes[31] & 63) | 64
    return { publicKey, secret: bytes.toString('hex') }
  }
}

test('backs up selected settings, restores data and identity, and guards maintenance', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1200, height: 840 } })
  page.setDefaultTimeout(20_000)
  const current = await identityFixture()
  const target = await identityFixture()
  const channelKey = '42'.repeat(16)
  const regionKey = '73'.repeat(16)
  const contactKey = 'bc'.repeat(32)
  const existingKey = 'ad'.repeat(32)
  const overflowKey = 'de'.repeat(32)
  await page.addInitScript(({ current, target, existingKey }) => {
    // Read each downloaded blob in the page, before Chrome hands it to the host.
    const downloads = []
    window.backupDownloads = downloads
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) {
        downloads.push({ filename: this.download, content: fetch(this.href).then((response) => response.text()) })
        return
      }
      click.call(this)
    }
    const encoder = new TextEncoder()
    const decode = new TextDecoder()
    const bytes = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16))
    const commands = []
    let contacts = new Map()
    const existing = new Uint8Array(148)
    existing.set([3, ...bytes(existingKey), 2, 0, 255])
    existing.set(encoder.encode('Existing relay'), 100)
    contacts.set(existingKey, existing)
    let flashContacts = new Map(contacts)
    let signedMessageCursor = 0
    let flashSignedMessageCursor = 0
    let bootedAt = performance.now() - 60_000
    let rebootGate
    const slots = [{ name: 'Public', key: new Uint8Array(16).fill(0x15) }, null, null]
    let identity = current
    let storedName = 'Backup fixture'
    let region = null
    window.backupCommands = commands
    window.savedContactKeys = () => [...contacts.keys()]
    window.receiveSignedMessage = (cursor) => { signedMessageCursor = cursor }
    window.readSignedMessageCursor = () => signedMessageCursor
    window.readExistingContact = () => decode.decode(contacts.get(existingKey).subarray(100, 132)).split('\0')[0]
    window.updateExistingContact = (name) => {
      const updated = contacts.get(existingKey).slice()
      updated.fill(0, 100, 132)
      updated.set(encoder.encode(name), 100)
      contacts.set(existingKey, updated)
    }
    window.deferReboot = () => { rebootGate = new Promise((release) => { window.releaseReboot = release }) }
    function openPort() {
      let controller
      const send = (frame) => controller.enqueue(Uint8Array.of(0x3e, frame.length, 0, ...frame))
      return Object.assign(new EventTarget(), {
        readable: new ReadableStream({ start(incoming) { controller = incoming } }),
        writable: new WritableStream({ async write(packet) {
          const data = packet.slice(3)
          const [code, slot] = data
          commands.push(code)
          if (code === 22) send([13, 14, 1, slots.length, ...new Uint8Array(78)])
          else if (code === 56) {
            const stats = Uint8Array.of(24, 0, ...new Uint8Array(9))
            new DataView(stats.buffer).setUint32(4, Math.floor((performance.now() - bootedAt) / 1_000), true)
            send(stats)
          }
          else if (code === 1) {
            const self = Uint8Array.of(5, 1, 7, 20, ...bytes(identity.publicKey), ...new Uint8Array(22), ...encoder.encode(storedName))
            const view = new DataView(self.buffer)
            view.setUint32(48, 910525, true)
            view.setUint32(52, 62500, true)
            self.set([7, 5], 56)
            send(self)
          } else if (code === 4) {
            send([2, contacts.size, 0, 0, 0])
            contacts.forEach(send)
            send([4, 0, 0, 0, 0])
          } else if (code === 8) {
            storedName = decode.decode(data.subarray(1))
            send([0])
          } else if (code === 9) {
            const record = new Uint8Array(148)
            record.set(data)
            record[0] = 3
            const key = [...data.slice(1, 33)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
            if (!contacts.has(key) && contacts.size === 2) contacts.delete(contacts.keys().next().value)
            contacts.set(key, record)
            send([0])
          } else if (code === 23) send([14, ...bytes(identity.secret)])
          else if (code === 24 && data.slice(1).every((byte, index) => byte === bytes(target.secret)[index])) {
            identity = target
            // Identity replacement reloads contacts and drops recent edits that have not reached flash.
            contacts = new Map(flashContacts)
            signedMessageCursor = flashSignedMessageCursor
            send([0])
          } else if (code === 31) {
            const channel = slots[slot]
            if (!channel) send([1, 2])
            else {
              const frame = new Uint8Array(50)
              frame.set([18, slot])
              frame.set(encoder.encode(channel.name), 2)
              frame.set(channel.key, 34)
              send(frame)
            }
          } else if (code === 32) {
            slots[slot] = { name: decode.decode(data.slice(2, 34)).split('\0')[0], key: data.slice(34, 50) }
            send([0])
          } else if (code === 63) {
            region = data.length > 1 ? data.slice(1) : null
            send([0])
          } else if (code === 64) send(region ? [28, ...region] : [28])
          else if (code === 19) {
            if (window.ignoreReboot) return
            await rebootGate
            flashContacts = new Map(contacts)
            flashSignedMessageCursor = signedMessageCursor
            contacts = new Map(flashContacts)
            bootedAt = performance.now()
          } else if (code === 51) {
            // These requests may close the transport before a response.
          } else throw new Error(`Unexpected backup command ${code}`)
        } }),
        async open() {}, async close() {},
      })
    }
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return openPort() } } })
  }, { current, target, existingKey })

  async function downloadAt(index, filename) {
    await page.waitForFunction((index) => window.backupDownloads.length > index, index)
    const captured = await page.evaluate(async (index) => {
      const { filename, content } = window.backupDownloads[index]
      return { filename, content: await content }
    }, index)
    assert.equal(captured.filename, filename)
    return captured.content
  }

  await page.goto(server.resolvedUrls.local[0] + '#settings')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  const panel = page.getByRole('region', { name: 'Backup and recovery' })
  await panel.getByText(/Connected radio Backup fixture/).waitFor()
  await panel.getByText('Export configuration', { exact: true }).click()
  const exported = panel.getByRole('group', { name: 'Sections to export' })
  assert.equal(await exported.getByLabel('Private identity key', { exact: true }).isChecked(), false)
  await exported.getByRole('button', { name: 'Deselect all export sections' }).click()
  await exported.getByLabel('Radio name', { exact: true }).check()
  await exported.getByRole('button', { name: 'Download configuration' }).click()
  const currentBackupFilename = `meshcore-config-${current.publicKey.slice(0, 12)}.json`
  assert.deepEqual(JSON.parse(await downloadAt(0, currentBackupFilename)), {
    name: 'Backup fixture', public_key: current.publicKey, packet_pigeon: { version: 1 },
  })
  assert.equal(await page.evaluate(() => window.backupCommands.includes(23)), false)

  await exported.getByRole('button', { name: 'Deselect all export sections' }).click()
  await exported.getByLabel('Channels and keys', { exact: true }).check()
  page.once('dialog', (dialog) => dialog.accept())
  await exported.getByRole('button', { name: 'Download configuration' }).click()
  const defaults = Buffer.from(await downloadAt(1, currentBackupFilename))
  assert.deepEqual(JSON.parse(defaults.toString()).channels, [{ name: 'Public', secret: '15'.repeat(16),
    packet_pigeon_scope: 'default', message_retention_duration_seconds: null }])

  await page.evaluate(async (key) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try {
      await storage.update(radioKeyFromPublicKey(key), { channelScope: { index: 0, channelName: 'Public', scope: { mode: 'unscoped' } },
        channelRetention: { index: 0, channelName: 'Public', days: 1 } })
    } finally { storage.close() }
  }, current.publicKey)

  await panel.getByText('Restore configuration', { exact: true }).click()
  const input = panel.getByLabel('Configuration JSON file')
  const preview = panel.getByRole('group', { name: 'Restore preview' })
  const restore = preview.getByRole('button', { name: 'Restore selected sections' })
  await input.setInputFiles({ name: 'defaults.json', mimeType: 'application/json', buffer: defaults })
  await preview.getByLabel(/^Channels and keys/).check()
  page.once('dialog', (dialog) => dialog.accept())
  await restore.click()
  await panel.getByText(/Public retention · Saved/).waitFor()
  assert.equal(await page.evaluate(() => window.backupCommands.includes(32)), false)

  await input.setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    public_key: target.publicKey, private_key: target.secret, name: 'Restored node',
    channels: [{ name: 'Lab channel', secret: channelKey, region_scope_name: '#Lab',
      region_scope_key: regionKey, message_retention_duration_seconds: 604800 }],
    contacts: [{ public_key: contactKey, name: 'Lab relay', custom_name: 'Custom relay', type: 2, flags: 2, out_path_list: 'aabb' },
      { public_key: overflowKey, name: 'Overflow relay', type: 2 }],
    region_transport_keys: [{ name: '#Lab', key: regionKey }],
    packet_pigeon: { version: 1, default_region: { name: '#Lab', key: regionKey } },
  })) })
  await preview.getByText(target.publicKey, { exact: true }).waitFor()
  assert.equal(await restore.isDisabled(), true)
  assert.equal(await panel.getByText(target.secret, { exact: false }).count(), 0)
  assert.equal(await panel.getByText(channelKey, { exact: false }).count(), 0)
  await preview.getByRole('button', { name: 'Select all restore sections', exact: true }).click()
  await preview.getByLabel(/^Private identity key/).uncheck()
  page.once('dialog', (dialog) => dialog.accept())
  await restore.click()
  await panel.getByText(/Lab channel retention · Saved/).waitFor()
  await panel.getByText(/Default flood region · Saved/).waitFor()
  await panel.getByText(/Overflow relay · Skipped\. Radio contact storage is full/).waitFor()
  assert.deepEqual(await page.evaluate(() => window.savedContactKeys()), [existingKey, contactKey])
  const cache = await page.evaluate(async (key) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return await storage.read(radioKeyFromPublicKey(key)) }
    finally { storage.close() }
  }, current.publicKey)
  assert.deepEqual(cache.channelRetention, [{ index: 1, channelName: 'Lab channel', days: 7 }])
  assert.deepEqual(cache.channelScopes, [{ index: 1, channelName: 'Lab channel', scope: { mode: 'region', name: '#Lab', key: regionKey } }])
  assert.deepEqual(cache.regionTransportKeys, [{ name: '#Lab', key: regionKey }])
  assert.equal(cache.contactPreferences.find(({ publicKey }) => publicKey === contactKey).customName, 'Custom relay')
  assert.equal(await page.evaluate(() => window.backupCommands.includes(24)), false)

  await preview.getByRole('button', { name: 'Deselect all restore sections' }).click()
  await preview.getByLabel(/^Private identity key/).check()
  await preview.getByLabel(/^Contacts/).check()
  const prepare = preview.getByRole('button', { name: 'Prepare identity recovery' })
  await prepare.click()
  assert.equal(await page.evaluate(() => window.backupCommands.includes(19)), false)
  await page.evaluate(() => { window.ignoreReboot = true })
  page.once('dialog', (dialog) => dialog.accept(current.publicKey.slice(0, 12)))
  await prepare.click()
  await panel.getByText(/Radio reboot requested to save pending contacts/).waitFor()
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await panel.getByText(/Connected radio Restored node/).waitFor()
  page.once('dialog', (dialog) => dialog.accept(current.publicKey.slice(0, 12)))
  await restore.click()
  await panel.getByText(/The radio restart could not be verified/).waitFor()
  assert.equal(await page.evaluate(() => window.backupCommands.includes(24)), false)

  await page.evaluate(() => {
    window.ignoreReboot = false
    window.deferReboot()
  })
  page.once('dialog', (dialog) => dialog.accept(current.publicKey.slice(0, 12)))
  await prepare.click()
  await page.waitForFunction(() => window.backupCommands.filter((code) => code === 19).length === 2)
  await page.evaluate(() => {
    window.updateExistingContact('Edit while reboot is pending')
    window.receiveSignedMessage(123)
    window.releaseReboot()
  })
  await panel.getByText(/Radio reboot requested to save pending contacts/).waitFor()
  assert.equal(await page.evaluate(() => window.backupCommands.includes(24)), false)
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await panel.getByText(/Connected radio Restored node/).waitFor()
  assert.equal(await page.evaluate(() => window.readExistingContact()), 'Edit while reboot is pending')
  await page.evaluate(() => window.updateExistingContact('Edit after reconnect'))
  await restore.click()
  assert.equal(await page.evaluate(() => window.backupCommands.includes(24)), false)
  page.once('dialog', (dialog) => dialog.accept(current.publicKey.slice(0, 12)))
  await restore.click()
  await panel.getByText(/Reconnect and verify the public key/).waitFor()
  assert.ok(await page.evaluate(() => window.backupCommands.lastIndexOf(9) > window.backupCommands.lastIndexOf(24)))
  assert.ok(await page.evaluate(() => window.backupCommands.lastIndexOf(19) > window.backupCommands.lastIndexOf(9)))
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await panel.getByText(/Restored identity verified/).waitFor()
  assert.deepEqual(await page.evaluate(() => window.savedContactKeys()), [existingKey, contactKey])
  assert.equal(await page.evaluate(() => window.readExistingContact()), 'Edit after reconnect')
  assert.equal(await page.evaluate(() => window.readSignedMessageCursor()), 123)
  const restoredName = await page.evaluate(async ({ publicKey, contactKey }) => {
    const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return (await storage.read(radioKeyFromPublicKey(publicKey)))?.contactPreferences
      ?.find(({ publicKey }) => publicKey === contactKey)?.customName }
    finally { storage.close() }
  }, { publicKey: target.publicKey, contactKey })
  assert.equal(restoredName, 'Custom relay')
  await panel.getByText('Local archive and radio maintenance', { exact: true }).click()
  const reset = panel.getByRole('button', { name: 'Factory reset radio' })
  await reset.click()
  assert.equal(await page.evaluate(() => window.backupCommands.includes(51)), false)
  page.once('dialog', (dialog) => dialog.accept(target.publicKey.slice(0, 12)))
  await reset.click()
  await panel.getByText('Radio command sent. Reconnect to verify the result.', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.backupCommands.includes(51)), true)

  page.once('dialog', (dialog) => dialog.accept())
  await panel.getByRole('button', { name: 'Download local chat archive' }).click()
  const archiveJson = JSON.parse(await downloadAt(2, `packet-pigeon-chat-${target.publicKey.slice(0, 12)}.json`))
  assert.equal(archiveJson.format, 'packet-pigeon-chat-archive')
  assert.equal(archiveJson.public_key, target.publicKey)
  assert.equal(Object.hasOwn(archiveJson, 'private_key'), false)

  await page.evaluate(() => new Promise((acquired) => {
    window.otherRadioSession = navigator.locks.request('packet-pigeon-usb-session', () => new Promise((release) => {
      window.releaseOtherRadio = release
      acquired()
    }))
  }))
  const purge = panel.getByRole('button', { name: 'Purge local radio cache' })
  page.once('dialog', (dialog) => dialog.accept(target.publicKey.slice(0, 12)))
  await purge.click()
  await panel.getByText(/Disconnect the radio in the other Packet Pigeon tab/).waitFor()
  await page.evaluate(() => {
    window.releaseOtherRadio()
    return window.otherRadioSession
  })
  page.once('dialog', (dialog) => dialog.accept(target.publicKey.slice(0, 12)))
  await purge.click()
  await panel.getByText('Cleared the selected radio’s browser cache.', { exact: true }).waitFor()
  const remaining = await page.evaluate(async () => {
    const { openRadioStorage } = await import('/src/storage/index.ts')
    const storage = await openRadioStorage()
    try { return await storage.listRadioKeys() }
    finally { storage.close() }
  })
  assert.ok(remaining.includes(current.publicKey))
  assert.ok(!remaining.includes(target.publicKey))
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
})
