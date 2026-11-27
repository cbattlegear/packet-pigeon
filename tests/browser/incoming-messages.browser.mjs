import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { openWorkspaceMenu } from './workspace-menu.mjs'

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

for (const transport of ['usb', 'bluetooth']) {
  for (const notificationOrder of ['before-send-response', 'after-ack']) {
    test(`${transport}: publishes each pong before another send or the end of the queue (${notificationOrder})`, async (t) => {
      const context = await browser.newContext({ viewport: { width: 1200, height: 840 } })
      t.after(() => context.close())
      await context.addInitScript(({ transport, notificationOrder }) => {
        const encoder = new TextEncoder()
        const key = 'ab'.repeat(32)
        const contact = new Uint8Array(148)
        contact.set([3, ...new Uint8Array(32).fill(0xbc), 1, 0, 255])
        contact.set(encoder.encode('D3skt Pong'), 100)
        const tx = Object.assign(new EventTarget(), {
          properties: { notify: true },
          async startNotifications() { return this },
        })
        const port = new EventTarget()
        const device = new EventTarget()
        let incoming
        let connected = false
        let heldEmpty
        let heldReceipt
        let holdFirstReceipt = true
        let holdEmpty = false
        const queue = []
        const fixture = window.receiveFixture = { sends: 0, connects: 0, events: [], emptyHeld: false, receiptHeld: false }
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (value, ...args) {
          if (fixture.failSave && this.name === 'radios'
            && value.messages?.some((message) => message.text === 'deferred pong')) {
            throw new DOMException('Receipt storage is full', 'QuotaExceededError')
          }
          return put.call(this, value, ...args)
        }
        const emit = (bytes) => {
          if (transport === 'usb') incoming.enqueue(Uint8Array.of(0x3e, bytes.length, 0, ...bytes))
          else {
            const data = Uint8Array.from(bytes)
            tx.value = new DataView(data.buffer)
            tx.dispatchEvent(new Event('characteristicvaluechanged'))
          }
        }
        const receipt = (text, timestamp) => [7, ...new Uint8Array(6).fill(0xbc), 255, 0,
          timestamp & 255, timestamp >> 8 & 255, timestamp >> 16 & 255, timestamp >>> 24, ...encoder.encode(text)]
        fixture.finishQueue = () => {
          if (!heldEmpty) throw new Error('No empty response is held')
          heldEmpty()
          heldEmpty = undefined
          fixture.emptyHeld = false
        }
        fixture.deliver = () => {
          if (!heldReceipt) throw new Error('No receipt response is held')
          heldReceipt()
          heldReceipt = undefined
          fixture.receiptHeld = false
        }
        fixture.burst = () => {
          holdFirstReceipt = true
          holdEmpty = true
          queue.push(receipt('burst one', 100), receipt('burst two', 101), receipt('burst three', 102))
          for (let i = 0; i < 20; i++) emit([0x83])
        }
        fixture.failReceipt = () => {
          fixture.failSave = true
          holdFirstReceipt = true
          holdEmpty = true
          queue.push(receipt('deferred pong', 104))
          emit([0x83])
        }
        fixture.disconnect = () => {
          holdFirstReceipt = true
          holdEmpty = true
          queue.push(receipt('reconnected pong', 103))
          connected = false
          if (transport === 'usb') port.dispatchEvent(new Event('disconnect'))
          else device.dispatchEvent(new Event('gattserverdisconnected'))
        }
        const write = async (command) => {
          const code = command[0]
          fixture.events.push(`write:${code}`)
          if (code === 22) emit([13, 14, 40, 0, ...new Uint8Array(78)])
          else if (code === 1) emit([5, 1, 0, 0, ...new Uint8Array(32).fill(0xab),
            ...new Uint8Array(22), ...encoder.encode('Pigeon')])
          else if (code === 4) {
            emit([2, 1, 0, 0, 0])
            emit(contact)
            emit([4, 0, 0, 0, 0])
          } else if (code === 2) {
            fixture.sends++
            const { expectedDirectAck } = await import('/src/radio/direct-message.ts')
            const timestamp = new DataView(command.buffer, command.byteOffset, command.byteLength).getUint32(3, true)
            const text = new TextDecoder().decode(command.slice(13))
            const ack = await expectedDirectAck(key, timestamp, command[2] & 3, text)
            const bytes = Uint8Array.from(ack.match(/../g), (part) => parseInt(part, 16))
            const waiting = () => {
              holdEmpty = true
              queue.push(receipt(`pong ${fixture.sends}`, timestamp + 1))
              fixture.events.push('push:waiting')
              emit([0x83])
            }
            if (notificationOrder === 'before-send-response') waiting()
            fixture.events.push('send:accepted')
            emit([6, 0, ...bytes, 0xe8, 3, 0, 0])
            fixture.events.push('push:ack')
            emit([0x82, ...bytes, 42, 0, 0, 0])
            if (notificationOrder === 'after-ack') setTimeout(waiting, 0)
          } else if (code === 10) {
            const next = queue.shift()
            if (next) {
              const deliver = () => {
                fixture.events.push(`receipt:${new TextDecoder().decode(Uint8Array.from(next).slice(13))}`)
                emit(next)
              }
              if (holdFirstReceipt) {
                holdFirstReceipt = false
                fixture.receiptHeld = true
                heldReceipt = deliver
              } else deliver()
            } else if (holdEmpty) {
              holdEmpty = false
              fixture.emptyHeld = true
              heldEmpty = () => emit([10])
            } else emit([10])
          } else throw new Error(`Unexpected companion command ${code}`)
        }
        Object.assign(port, {
          getInfo() { return { usbVendorId: 1, usbProductId: 2 } },
          async open() {
            fixture.connects++
            connected = true
            port.readable = new ReadableStream({ start(controller) { incoming = controller } })
            port.writable = new WritableStream({ write: (packet) => write(packet.slice(3)) })
          },
          async close() { connected = false },
        })
        const gatt = {
          get connected() { return connected },
          async connect() { fixture.connects++; connected = true; return this },
          disconnect() { connected = false; device.dispatchEvent(new Event('gattserverdisconnected')) },
          async getPrimaryService() {
            return { async getCharacteristic(uuid) {
              return uuid.startsWith('6e400002')
                ? { properties: { write: true }, writeValueWithResponse: write } : tx
            } }
          },
        }
        device.gatt = gatt
        Object.defineProperty(navigator, 'serial', {
          value: { async requestPort() { return port }, async getPorts() { return [port] } },
        })
        Object.defineProperty(navigator, 'bluetooth', {
          value: { async requestDevice() { return device } },
        })
      }, { transport, notificationOrder })

      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      await page.goto(`${url}#chats`)
      await openWorkspaceMenu(page, 'Radio connection')
      await page.getByRole('button', { name: transport === 'usb' ? 'Connect USB' : 'Connect Bluetooth' }).click()
      const disconnect = async () => {
        await openWorkspaceMenu(page, 'Radio connection')
        await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
      }
      const pane = page.getByRole('region', { name: 'Conversation with D3skt Pong' })
      await pane.waitFor()
      await page.getByRole('button', { name: 'Sync messages', exact: true }).waitFor()
      const draft = pane.getByLabel('Message', { exact: true })
      await draft.fill('ping')
      await pane.getByRole('button', { name: 'Send message', exact: true }).click()
      await pane.getByText('Delivered', { exact: true }).waitFor()
      const deliver = async () => {
        await page.waitForFunction(() => window.receiveFixture.receiptHeld)
        // The reply arrives after send/ACK and sync-start cache reads have completed.
        await page.waitForTimeout(100)
        await page.evaluate(() => window.receiveFixture.deliver())
      }
      await deliver()
      await page.waitForFunction(() => window.receiveFixture.emptyHeld)
      assert.equal(await page.evaluate(async () => {
        const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
        const storage = await openRadioStorage()
        try {
          const data = await storage.read(radioKeyFromPublicKey('ab'.repeat(32)))
          return data.messages.filter((message) => message.text === 'pong 1').length
        } finally { storage.close() }
      }), 1)
      await pane.getByText('pong 1', { exact: true }).waitFor({ timeout: 1500 })
      const events = await page.evaluate(() => window.receiveFixture.events)
      const send = events.indexOf('write:2')
      const next = events.indexOf('write:10', send)
      assert.ok(events.indexOf('push:waiting') < next)
      assert.ok(events.indexOf('push:ack') < next)
      assert.equal(events.indexOf('push:waiting') < events.indexOf('send:accepted'),
        notificationOrder === 'before-send-response')
      assert.equal(await page.evaluate(() => window.receiveFixture.sends), 1)
      assert.equal(await draft.inputValue(), '')
      await page.evaluate(() => window.receiveFixture.finishQueue())
      await page.getByRole('button', { name: 'Sync messages', exact: true }).waitFor()

      await page.evaluate(() => window.receiveFixture.burst())
      await deliver()
      await page.waitForFunction(() => window.receiveFixture.emptyHeld)
      await pane.getByText('burst three', { exact: true }).waitFor({ timeout: 1500 })
      assert.equal(await pane.getByText('burst one', { exact: true }).count(), 1)
      assert.equal(await pane.getByText('burst two', { exact: true }).count(), 1)
      assert.equal(await page.evaluate(() => window.receiveFixture.sends), 1)
      await page.evaluate(() => window.receiveFixture.finishQueue())
      await page.getByRole('button', { name: 'Sync messages', exact: true }).waitFor()

      await page.evaluate(() => window.receiveFixture.disconnect())
      await page.waitForFunction(() => window.receiveFixture.connects === 2)
      await deliver()
      await page.waitForFunction(() => window.receiveFixture.emptyHeld)
      await pane.getByText('reconnected pong', { exact: true }).waitFor({ timeout: 1500 })
      assert.equal(await page.evaluate(() => window.receiveFixture.sends), 1)
      await page.evaluate(() => window.receiveFixture.finishQueue())
      await page.getByRole('button', { name: 'Sync messages', exact: true }).waitFor()
      if (transport === 'usb' && notificationOrder === 'after-ack') {
        const otherKey = 'cd'.repeat(32)
        await page.evaluate(async (otherKey) => {
          const { openRadioStorage, radioKeyFromPublicKey } = await import('/src/storage/index.ts')
          const storage = await openRadioStorage()
          try {
            const peer = 'de'.repeat(32)
            await storage.update(radioKeyFromPublicKey(otherKey), {
              contacts: [{ publicKey: peer, name: 'Other companion', details: { type: 1 } }],
              messages: [{ id: 'other', conversationId: `direct:${peer}`, sender: peer, timestamp: 1000,
                text: 'Other radio message', rawHex: '' }],
            })
          } finally { storage.close() }
          window.receiveFixture.failReceipt()
        }, otherKey)
        await deliver()
        await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor()
        assert.equal(await pane.getByText('deferred pong', { exact: true }).count(), 0)
        await page.getByText(/Could not save radio data/).waitFor()
        await disconnect()
        const selectedRadio = page.getByRole('combobox', { name: /Cached radio/ })
        await selectedRadio.selectOption(otherKey)
        await page.getByText('Other radio message', { exact: true }).last().waitFor()
        await page.evaluate(() => { window.receiveFixture.failSave = false })
        await page.getByRole('region', { name: 'Conversation with Other companion' })
          .getByRole('button', { name: 'Retry saving', exact: true }).click()
        await page.getByRole('button', { name: 'Sync messages', exact: true }).waitFor()
        assert.equal(await selectedRadio.inputValue(), otherKey)
        assert.equal(await page.getByText('deferred pong', { exact: true }).count(), 0)
        await selectedRadio.selectOption('ab'.repeat(32))
        await pane.getByText('deferred pong', { exact: true }).waitFor()
        assert.equal(await pane.getByText('deferred pong', { exact: true }).count(), 1)
      } else await disconnect()
    })
  }
}
