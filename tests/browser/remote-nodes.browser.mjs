import { openWorkspaceMenu } from './workspace-menu.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('joins rooms with explicit roles, posts, shows sensor alerts, and gates node administration', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.setDefaultTimeout(15_000)
  await page.addInitScript(() => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const roomKey = new Uint8Array(32).fill(0xbc)
    const sensorKey = new Uint8Array(32).fill(0xcd)
    const memberKey = new Uint8Array(32).fill(0xde)
    function contact(key, role, name) {
      const row = new Uint8Array(148)
      row.set([3, ...key, role, 0, 0])
      row.set(encoder.encode(name), 100)
      return row
    }
    const room = contact(roomKey, 3, 'Study room')
    const sensor = contact(sensorKey, 4, 'Creek sensor')
    const member = contact(memberKey, 1, 'North member')
    function received(key, type, text) {
      return [16, 16, 0, 0, ...key.subarray(0, 6), 0, type, 1, 0, 0, 0,
        ...(type === 2 ? memberKey.subarray(0, 4) : []), ...encoder.encode(text)]
    }
    const messages = []
    window.queueInitialRoomMessages = () => messages.push(
      received(roomKey, 2, 'A saved room post'), received(sensorKey, 0, 'High water at the creek'),
    )
    const roomAcl = new Map([[0xab, 0], [0xef, 0]])
    window.fixtureRadioByte = 0xab
    window.roomReadOnlyEnabled = false
    window.queueRoomPost = (text) => messages.push(received(roomKey, 2, text))
    window.nodeAlerts = []
    window.Notification = class {
      static permission = 'granted'
      constructor(title, { body }) {
        this.title = title
        this.body = body
        window.nodeAlerts.push(this)
      }
      close() {}
    }
    const commands = []
    window.nodeCommands = commands
    function openPort() {
      const localKey = new Uint8Array(32).fill(window.fixtureRadioByte)
      let controller
      const reply = (payload) => controller.enqueue(Uint8Array.of(0x3e, payload.length, 0, ...payload))
      const accepted = (tag) => reply([6, 0, ...tag, 0xb8, 0x0b, 0, 0])
      return Object.assign(new EventTarget(), {
        readable: new ReadableStream({ start(value) { controller = value } }),
        writable: new WritableStream({ async write(packet) {
          const data = packet.subarray(3)
          const [code, type] = data
          const command = { code, type, target: code === 2 ? data[7] : data[1],
            prefix: code === 2 ? [...data.subarray(7, 13)] : [], text: code === 2 ? decoder.decode(data.subarray(13)) : '' }
          commands.push(command)
          if (code === 22) return reply([13, 14, 20, 0, ...new Uint8Array(78)])
          if (code === 1) return reply([5, 1, 7, 20, ...localKey, ...new Uint8Array(22), ...encoder.encode('Local fixture')])
          if (code === 4) {
            reply([2, 3, 0, 0, 0])
            for (const row of [room, sensor, member]) reply(row)
            return reply([4, 0, 0, 0, 0])
          }
          if (code === 10) return reply(messages.shift() ?? [10])
          if (code === 26) {
            const key = data[1] === 0xbc ? roomKey : sensorKey
            const password = decoder.decode(data.subarray(33))
            let permissions = password === 'test-admin' ? (data[1] === 0xbc ? 3 : 0xc3) : 0
            if (data[1] === 0xbc) {
              const existing = password === '' ? roomAcl.get(localKey[0]) : undefined
              if (existing !== undefined) permissions = existing
              else if (password === 'test-admin') permissions = 3
              else if (password === 'test-room') permissions = 2
              else if (window.roomReadOnlyEnabled) permissions = 0
              else {
                accepted(key.subarray(0, 4))
                return
              }
              roomAcl.set(localKey[0], permissions)
            }
            const confirmation = data[1] === 0xbc ? window.roomLoginConfirmation : undefined
            if (confirmation) reply(confirmation)
            else accepted(key.subarray(0, 4))
            const access = [0x85, permissions & 3, ...key.subarray(0, 6), commands.length, 0, 0, 0, permissions, 1]
            if (data[1] === 0xbc && window.holdRoomLogin) {
              window.holdRoomLogin = false
              window.releaseLateRoomLogin = () => reply(access)
            } else reply(access)
            return
          }
          if (code === 50) {
            const tag = [1, 2, 3, commands.length]
            accepted(tag)
            if (data[33] === 5) {
              return reply([0x8c, 0, ...tag, ...memberKey.subarray(0, 6), data[1] === 0xbc ? 3 : 0x81])
            }
            if (data[33] === 4) {
              const windowSeconds = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(34, true)
              assertFixture(data[1] === 0xcd && windowSeconds === 3600)
              return reply([0x8c, 0, ...tag, 1, 0, 0, 0, 1, 116, 0x01, 0x22, 0x01, 0xa4, 0x01, 0x68])
            }
            assertFixture(data[33] === 1)
            const status = new Uint8Array(52)
            const view = new DataView(status.buffer)
            view.setUint16(0, 3800, true)
            view.setUint32(20, 123, true)
            return reply([0x8c, 0, ...tag, ...status])
          }
          if (code === 2) {
            if (type === 1) {
              accepted([0, 0, 0, 0])
              if (data[7] === 0xbc && command.text === 'get allow.read.only') {
                messages.push(received(roomKey, 1, `> ${window.roomReadOnlyEnabled ? 'on' : 'off'}`))
              } else if (data[7] === 0xbc && /^set allow\.read\.only (on|off)$/.test(command.text)) {
                window.roomReadOnlyEnabled = command.text.endsWith(' on')
                messages.push(received(roomKey, 1, 'OK'))
              } else messages.push(received(data[7] === 0xbc ? roomKey : sensorKey, 1, 'Settings updated'))
              return
            }
            const input = Uint8Array.of(...data.subarray(3, 7), data[2] & 3, ...data.subarray(13), ...localKey)
            const ack = new Uint8Array(await crypto.subtle.digest('SHA-256', input), 0, 4)
            accepted(ack)
            return reply([0x82, ...ack, 1, 0, 0, 0])
          }
          throw new Error(`Unexpected command ${code}`)
        } }),
        async open() {}, async close() {},
      })
    }
    function assertFixture(condition) {
      if (!condition) throw new Error('Unexpected room status request')
    }
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return openPort() } } })
  })

  await page.goto(`${server.resolvedUrls.local[0]}#settings`)
  await page.getByLabel('Alert for synced messages').check()
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByRole('banner').getByText('Connected', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Chats', exact: true }).click()
  const conversations = page.getByRole('navigation', { name: 'Conversations', exact: true })
  await conversations.getByRole('button', { name: /Study room/ }).click()
  const roomChat = page.getByRole('region', { name: 'Conversation with Study room' })
  const access = roomChat.getByRole('region', { name: 'Room access' })
  await roomChat.getByLabel('Message', { exact: true }).fill('A new post')
  const post = roomChat.getByRole('button', { name: 'Post message' })
  assert.equal(await post.isDisabled(), true)
  await access.getByRole('button', { name: 'Sign in' }).click()
  await access.getByText(/Read-only access/).waitFor()
  assert.equal(await post.isDisabled(), true)
  assert.equal(await page.evaluate(() => window.nodeCommands.some(({ code }) => code === 2)), false)

  // Establish the selected room before receipt arrival so alert suppression cannot race startup sync.
  await page.evaluate(() => window.queueInitialRoomMessages())
  await page.getByRole('button', { name: 'Sync messages' }).click()
  await roomChat.getByText('A saved room post', { exact: true }).waitFor()
  await roomChat.getByText('North member', { exact: true }).waitFor()
  await page.waitForFunction(() => window.nodeAlerts.some(({ title, body }) =>
    title === 'Packet Pigeon: Creek sensor' && body === 'High water at the creek'))
  await conversations.getByRole('button', { name: /Creek sensor/ }).click()
  const sensorChat = page.getByRole('region', { name: 'Conversation with Creek sensor' })
  await sensorChat.getByText('High water at the creek', { exact: true }).waitFor()
  assert.equal(await sensorChat.getByLabel('Message', { exact: true }).count(), 0)

  await page.evaluate(() => window.queueRoomPost('A second room post'))
  await page.getByRole('button', { name: 'Sync messages' }).click()
  await page.waitForFunction(() => window.nodeAlerts.some(({ title, body }) =>
    title === 'Packet Pigeon: Study room' && body === 'A second room post'))
  await page.evaluate(() => window.nodeAlerts.find(({ body }) => body === 'A second room post').onclick())
  await roomChat.getByText('A second room post', { exact: true }).waitFor()

  for (const confirmation of [null, [0], [1]]) {
    await page.evaluate((confirmation) => {
      window.holdRoomLogin = true
      window.roomLoginConfirmation = confirmation
      window.releaseLateRoomLogin = undefined
    }, confirmation)
    await access.getByLabel('Password').fill('test-admin')
    await access.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForFunction(() => typeof window.releaseLateRoomLogin === 'function')
    if (confirmation) await access.getByText(/The login reply is unconfirmed/).waitFor()
    else await access.getByRole('button', { name: 'Stop waiting for login' }).click()
    const logins = await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 26).length)
    await access.getByRole('button', { name: 'Sign in' }).click()
    await access.getByText(/The previous login may still reply/).waitFor()
    assert.equal(await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 26).length), logins)
    await page.evaluate(() => window.releaseLateRoomLogin())
    assert.equal(await access.getByText(/Administrator access/).count(), 0)
    assert.equal(await post.isDisabled(), true)

    await openWorkspaceMenu(page, 'Radio connection')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await openWorkspaceMenu(page, 'Radio connection')
    await page.getByRole('button', { name: 'Connect USB' }).click()
    await page.getByRole('banner').getByText('Connected', { exact: true }).waitFor()
  }
  await page.evaluate(() => { window.roomLoginConfirmation = undefined })
  await access.getByLabel('Password').fill('test-admin')
  await access.getByRole('button', { name: 'Sign in' }).click()
  await access.getByText(/Administrator access/).waitFor()
  assert.equal(await access.getByLabel('Password').inputValue(), '')
  await post.click()
  await roomChat.getByText('Delivered', { exact: true }).waitFor()

  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  const contacts = page.getByRole('list', { name: 'Matching contacts' })
  await contacts.getByRole('button', { name: /Study room/ }).click()
  const roomDetails = page.getByRole('region', { name: 'Study room', exact: true })
  await roomDetails.getByRole('button', { name: 'Request room status' }).click()
  await roomDetails.getByText('3.8 V', { exact: true }).waitFor()
  const beforeRoomControls = await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 2).length)
  await roomDetails.getByText('Room administration', { exact: true }).click()
  assert.equal(await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 2).length), beforeRoomControls)
  await roomDetails.getByText(/Disabling it does not revoke existing access-list entries/).waitFor()
  await roomDetails.getByText(/A blank room password may still grant posting access/).waitFor()
  await roomDetails.getByText(/not matched to commands and may arrive late/).waitFor()
  await roomDetails.getByText(/v1.11 and earlier may cause these commands to be ignored/).waitFor()
  await roomDetails.getByRole('button', { name: 'Read access list' }).click()
  await roomDetails.getByText('dededededede', { exact: true }).waitFor()
  const syncsBeforePolicy = await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 10).length)
  await roomDetails.getByRole('button', { name: 'Read read-only setting' }).click()
  await roomDetails.getByText(/Command queued over direct routing/).waitFor()
  assert.equal(await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 10).length), syncsBeforePolicy)
  const enable = roomDetails.getByRole('button', { name: 'Enable automatic read-only entry' })
  const disable = roomDetails.getByRole('button', { name: 'Disable automatic read-only entry' })
  page.once('dialog', (dialog) => {
    assert.match(dialog.message(), /Study room \(bcbcbcbcbcbc\)/)
    assert.match(dialog.message(), /Unrecognized passwords can grant read-only access/)
    void dialog.dismiss()
  })
  await enable.click()
  assert.equal(await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 2).length), beforeRoomControls + 1)
  page.once('dialog', (dialog) => dialog.accept())
  await enable.click()
  await page.waitForFunction(() => window.roomReadOnlyEnabled)
  assert.equal(await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 10).length), syncsBeforePolicy)

  await page.getByRole('link', { name: 'Chats', exact: true }).click()
  await conversations.getByRole('button', { name: /Study room/ }).click()
  await page.getByRole('button', { name: 'Sync messages' }).click()
  await roomChat.getByText('> off', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.roomReadOnlyEnabled), true)
  await page.getByRole('link', { name: 'Contacts', exact: true }).click()
  await contacts.getByRole('button', { name: /Study room/ }).click()
  const roomAdministration = roomDetails.getByText('Room administration', { exact: true })
  if (!await roomAdministration.evaluate((element) => element.parentElement.hasAttribute('open'))) await roomAdministration.click()
  const syncsBeforeDisable = await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 10).length)
  page.once('dialog', (dialog) => {
    assert.match(dialog.message(), /Study room \(bcbcbcbcbcbc\)/)
    assert.match(dialog.message(), /Existing access-list entries are not revoked/)
    assert.match(dialog.message(), /known clients may still sign in with a blank password/)
    void dialog.dismiss()
  })
  await disable.click()
  assert.equal(await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 2).length), beforeRoomControls + 2)
  page.once('dialog', (dialog) => dialog.accept())
  await disable.click()
  await page.waitForFunction(() => !window.roomReadOnlyEnabled)
  assert.equal(await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 10).length), syncsBeforeDisable)

  await contacts.getByRole('button', { name: /Creek sensor/ }).click()
  const sensorDetails = page.getByRole('region', { name: 'Creek sensor', exact: true })
  assert.equal(await sensorDetails.getByText('Sensor administration', { exact: true }).count(), 0)
  const history = sensorDetails.getByRole('button', { name: 'Request sensor history' })
  assert.equal(await history.isDisabled(), true)
  await sensorDetails.getByLabel('Password').fill('test-admin')
  await sensorDetails.getByRole('button', { name: 'Sign in' }).click()
  await sensorDetails.getByText(/High priority enabled/).waitFor()
  await history.click()
  await sensorDetails.getByText('Channel 1 Battery voltage · Min 2.9 · Max 4.2 · Avg 3.6 V', { exact: true }).waitFor()
  await sensorDetails.getByText('Sensor administration', { exact: true }).click()
  assert.equal(await sensorDetails.getByRole('button', { name: 'Read read-only setting' }).count(), 0)
  await sensorDetails.getByRole('button', { name: 'Read access list' }).click()
  await sensorDetails.getByText(/read-only · alerts high/).waitFor()
  await sensorDetails.getByLabel('Client public key').fill('de'.repeat(32))
  await sensorDetails.getByLabel('High-priority alerts').check()
  page.once('dialog', (dialog) => dialog.accept())
  await sensorDetails.getByRole('button', { name: 'Set client permissions' }).click()
  await sensorDetails.getByText(/Command queued over direct routing/).waitFor()
  const sent = await page.evaluate(() => window.nodeCommands.filter(({ code }) => code === 2))
  assert.deepEqual(sent.map(({ type, target, text }) => ({ type, target, text })), [
    { type: 0, target: 0xbc, text: 'A new post' },
    { type: 1, target: 0xbc, text: 'get allow.read.only' },
    { type: 1, target: 0xbc, text: 'set allow.read.only on' },
    { type: 1, target: 0xbc, text: 'set allow.read.only off' },
    { type: 1, target: 0xcd, text: `setperm ${'de'.repeat(32)} 129` },
  ])
  for (const command of sent.slice(1, 4)) assert.deepEqual(command.prefix, new Array(6).fill(0xbc))

  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.evaluate(() => { window.fixtureRadioByte = 0xef })
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByRole('banner').getByText('Connected', { exact: true }).waitFor()
  await contacts.getByRole('button', { name: /Study room/ }).click()
  assert.equal(await page.evaluate(() => window.roomReadOnlyEnabled), false)
  await roomDetails.getByRole('button', { name: 'Sign in' }).click()
  await roomDetails.getByText(/Read-only access/).waitFor()
  assert.equal(await roomDetails.getByText('Room administration', { exact: true }).count(), 0)
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.evaluate(() => { window.fixtureRadioByte = 0xee })
  await openWorkspaceMenu(page, 'Radio connection')
  await page.getByRole('button', { name: 'Connect USB' }).click()
  await page.getByRole('banner').getByText('Connected', { exact: true }).waitFor()
  await contacts.getByRole('button', { name: /Study room/ }).click()
  await roomDetails.getByRole('button', { name: 'Sign in' }).click()
  await roomDetails.getByText(/The login reply is unconfirmed/).waitFor()
  assert.equal(await roomDetails.getByText(/Read-only access/).count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
})
