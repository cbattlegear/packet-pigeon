import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { startLanBridge } from './lan-companion.mjs'
import { lanProtocolHeader, lanSocketPath, lanSocketProtocol, lanStatusPath } from '../src/radio/lan-bridge.ts'

test('serves the local app and bridges framed commands only for its own origin', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'packet-pigeon-bridge-'))
  const index = join(dist, 'index.html')
  const asset = join(dist, 'asset.js')
  t.after(async () => {
    await unlink(index)
    await unlink(asset)
    await rmdir(dist)
  })
  await writeFile(index, '<html><head></head><body>Fixture</body></html>')
  await writeFile(asset, 'export default 1')

  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let radioConnections = 0
  server.on('connection', () => { radioConnections++ })
  const bridge = await startLanBridge({ radioHost: '127.0.0.1', radioPort: server.address().port, browserPort: 0, distDir: dist })
  t.after(async () => {
    await bridge.close()
    await new Promise((done) => server.close(done))
  })

  const url = `${bridge.url.replace('http:', 'ws:')}${lanSocketPath}`
  const home = await fetch(bridge.url)
  assert.match(home.headers.get('content-type'), /^text\/html/)
  assert.equal(await home.text(), '<html><head></head><body>Fixture</body></html>')
  const status = await fetch(`${bridge.url}${lanStatusPath}`)
  assert.equal(status.status, 204)
  assert.equal(status.headers.get(lanProtocolHeader), lanSocketProtocol)
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.match((await fetch(`${bridge.url}/asset.js`)).headers.get('content-type'), /^text\/javascript/)
  assert.equal((await fetch(`${bridge.url}/missing`)).status, 404)
  assert.equal(radioConnections, 0)
  await assert.rejects(startLanBridge({ radioHost: '8.8.8.8', distDir: dist }), /IPv4 address/)
  await assert.rejects(once(new WebSocket(url, lanSocketProtocol, { origin: 'https://example.org' }), 'open'), /403/)
  await assert.rejects(once(new WebSocket(url, lanSocketProtocol, { origin: bridge.url,
    headers: { host: 'other.example' } }), 'open'), /403/)
  assert.equal(radioConnections, 0)

  const nextRadio = once(server, 'connection')
  const client = new WebSocket(url, lanSocketProtocol, { origin: bridge.url })
  await once(client, 'open')
  const [radio] = await nextRadio
  await assert.rejects(once(new WebSocket(url, lanSocketProtocol, { origin: bridge.url }), 'open'), /409/)
  const command = Buffer.from([0x3c, 2, 0, 0x16, 14])
  const received = once(radio, 'data')
  client.send(command)
  assert.deepEqual((await received)[0], command)
  const reply = Buffer.from([0x3e, 1, 0, 0])
  const delivered = once(client, 'message')
  radio.write(reply)
  assert.deepEqual(await delivered, [reply, true])

  const browserClosed = once(client, 'close')
  const radioClosed = once(radio, 'close')
  client.send('An invalid text command')
  assert.equal((await browserClosed)[0], 1003)
  await radioClosed

  const anotherRadio = once(server, 'connection')
  const closingClient = new WebSocket(url, lanSocketProtocol, { origin: bridge.url })
  await once(closingClient, 'open')
  const [lastRadio] = await anotherRadio
  const lastCommand = once(lastRadio, 'data')
  const ended = once(lastRadio, 'end')
  closingClient.send(command)
  closingClient.close(1000)
  assert.deepEqual((await lastCommand)[0], command)
  await ended
})
