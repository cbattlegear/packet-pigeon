import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { build } from 'vite'
import { startLanBridge } from '../../scripts/lan-companion.mjs'
import { lanStatusPath } from '../../src/radio/lan-bridge.ts'
import { buildReaction } from '../../src/radio/reactions.ts'

function frame(payload) {
  return Buffer.from([0x3e, payload.length, 0, ...payload])
}

test('uses the local bridge for a TCP companion session, durable message sync and reconnection', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'packet-pigeon-browser-'))
  const connected = new Set()
  const commands = []
  let connections = 0
  let bridge
  let browser
  const receipt = [17, 16, 0, 0, 0, 0, 0, 1, 0, 0, 0, ...Buffer.from('North: Hello over the network')]
  const queued = [receipt]
  const radio = createServer((socket) => {
    connections++
    connected.add(socket)
    socket.once('close', () => connected.delete(socket))
    let buffered = Buffer.alloc(0)
    socket.on('data', (bytes) => {
      buffered = Buffer.concat([buffered, bytes])
      while (buffered.length >= 3 && buffered.length >= 3 + buffered.readUInt16LE(1)) {
        assert.equal(buffered[0], 0x3c)
        const length = buffered.readUInt16LE(1)
        const [code, index] = buffered.subarray(3, 3 + length)
        buffered = buffered.subarray(3 + length)
        commands.push(code)
        if (code === 22) {
          const capability = frame([13, 14, 10, 1, ...new Uint8Array(78)])
          socket.write(capability.subarray(0, 2))
          setTimeout(() => { if (!socket.destroyed) socket.write(capability.subarray(2)) }, 15)
        } else if (code === 1) {
          const self = Uint8Array.of(5, 1, 7, 20, ...new Uint8Array(32).fill(0xab), ...new Uint8Array(22),
            ...Buffer.from('LAN fixture'))
          socket.write(frame(self))
        } else if (code === 4) {
          socket.write(Buffer.concat([frame([2, 0, 0, 0, 0]), frame([4, 0, 0, 0, 0])]))
        } else if (code === 31) {
          const channel = new Uint8Array(50)
          channel.set([18, index])
          channel.set(Buffer.from('Public'), 2)
          channel.set(new Uint8Array(16).fill(0x11), 34)
          socket.write(frame(channel))
        } else if (code === 10) socket.write(frame(queued.shift() ?? [10]))
        else assert.fail(`Unexpected companion command ${code}`)
      }
    })
  })
  t.after(async () => {
    await browser?.close()
    await bridge?.close()
    for (const socket of connected) socket.destroy()
    if (radio.listening) await new Promise((done) => radio.close(done))
    await rm(dist, { recursive: true })
  })
  radio.listen(0, '127.0.0.1')
  await once(radio, 'listening')
  await build({ logLevel: 'silent', build: { outDir: dist } })
  bridge = await startLanBridge({ radioHost: '127.0.0.1', radioPort: radio.address().port, browserPort: 0, distDir: dist })
  browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1200, height: 840 } })
  page.setDefaultTimeout(15_000)
  const probe = `${bridge.url}${lanStatusPath}`
  await page.route(probe, (route) => route.fulfill({ status: 404 }))
  const unavailable = page.waitForResponse((response) => response.url() === probe && response.status() === 404)
  await page.goto(`${bridge.url}/#chats`)
  await unavailable
  const connect = page.getByRole('button', { name: 'Connect local network' })
  assert.equal(await connect.count(), 0)
  await page.unroute(probe)
  await page.reload()
  assert.equal(connections, 0)
  await connect.click()
  const ready = page.getByRole('banner').getByText('Connected over local network', { exact: true })
  await ready.waitFor()
  await page.getByText('Hello over the network', { exact: true }).waitFor()
  const saved = await page.evaluate(async (key) => {
    const opened = indexedDB.open('packet-pigeon')
    const db = await new Promise((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result)
      opened.onerror = () => reject(opened.error)
    })
    try {
      const row = db.transaction('radios').objectStore('radios').get(key)
      return await new Promise((resolve, reject) => {
        row.onsuccess = () => resolve(row.result?.messages.map(({ text }) => text))
        row.onerror = () => reject(row.error)
      })
    } finally { db.close() }
  }, 'ab'.repeat(32))
  assert.deepEqual(saved, ['North: Hello over the network'])
  const reaction = await buildReaction('👍', 'Hello over the network', 1, 'North')
  queued.push([...receipt.slice(0, 11), ...Buffer.from(`Bob: ${reaction}`)])
  for (const socket of connected) socket.write(frame([0x83]))
  const target = page.locator('.chat-message').filter({ hasText: 'Hello over the network' })
  await target.getByRole('group', { name: 'Message reactions' }).getByText('👍 1', { exact: true }).waitFor()
  await target.getByRole('group', { name: 'Message reactions' }).getByText('👍 1', { exact: true }).click()
  await target.getByText('Bob', { exact: true }).waitFor()
  queued.push([...receipt.slice(0, 11), ...Buffer.from('North: Prompt reply')])
  for (const socket of connected) socket.write(Buffer.concat(Array.from({ length: 10 }, () => frame([0x83]))))
  await page.getByText('Prompt reply', { exact: true }).waitFor()
  queued.push([...receipt.slice(0, 11), ...Buffer.from('North: Queued during reconnect')])
  const reconnected = once(radio, 'connection')
  for (const socket of connected) socket.destroy()
  await reconnected
  await ready.waitFor()
  await page.getByText('Queued during reconnect', { exact: true }).waitFor()
  assert.equal(connections, 2)
  assert.ok(commands.filter((code) => code === 22).length === 2)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await connect.waitFor()
  await page.setViewportSize({ width: 390, height: 820 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
})
