import assert from 'node:assert/strict'
import { createCipheriv, createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { createChannelObserver } from './channel-observation.ts'
import { decodeRxPacket } from './rx-packet.ts'

const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'))
const secretHex = '8b3387e9c5cdea6ac9e5edbaa115cd72'
const payload = bytes('11a0e6215565cf0555d9e4a5e4824dc70018a6021e8232bb0509500bdf22a90e97978f')

function packet(body = payload, route = 0x15, codes = []) {
  return decodeRxPacket(Uint8Array.of(4, 200, route, ...codes, 1, 0xab, ...body))
}

function encrypt(textBytes, type = 0) {
  const key = Buffer.from(secretHex, 'hex')
  const size = Math.ceil((5 + textBytes.length) / 16) * 16
  const plain = Buffer.alloc(size)
  plain.writeUInt32LE(42)
  plain[4] = type
  Buffer.from(textBytes).copy(plain, 5)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const mac = createHmac('sha256', key).update(encrypted).digest().subarray(0, 2)
  return Uint8Array.from(Buffer.concat([Buffer.of(createHash('sha256').update(key).digest()[0]), mac, encrypted]))
}

test('authenticates and decrypts an independent MeshCore group-text vector', async () => {
  const secret = bytes(secretHex)
  const observe = await createChannelObserver(secret, [])
  assert(secret.every((byte) => byte === 0))
  const result = await observe(packet())
  assert.equal(result.timestamp, 1703123456)
  assert.equal(result.textType, 0)
  assert.equal(result.text, 'Alice: Hello mesh!')
  assert.deepEqual(result.pathHashes, ['ab'])
  assert.deepEqual(result.region, { kind: 'unknown' })
  const badMac = payload.slice()
  badMac[1] ^= 1
  assert.equal(await observe(packet(badMac)), null)
  const badHash = payload.slice()
  badHash[0] ^= 1
  assert.equal(await observe(packet(badHash)), null)
  assert.equal(await observe(packet(payload.slice(0, -1))), null)
  const wrongKey = await createChannelObserver(new Uint8Array(16).fill(1), [])
  assert.equal(await wrongKey(packet()), null)
})

test('preserves exact UTF-8 text and rejects malformed or unsupported plaintext', async () => {
  const observe = await createChannelObserver(bytes(secretHex), [])
  const unicode = '  café 🕊  '
  const result = await observe(packet(encrypt(Buffer.from(unicode), 2)))
  assert.equal(result.timestamp, 42)
  assert.equal(result.textType, 2)
  assert.equal(result.text, unicode)
  assert.equal((await observe(packet(encrypt(Buffer.from('12345678901'))))).text, '12345678901')
  assert.equal(await observe(packet(encrypt(Buffer.from([0xc3, 0x28])))), null)
  assert.equal(await observe(packet(encrypt(Buffer.from('hello'), 4))), null)
  const key = bytes(secretHex)
  await assert.rejects(createChannelObserver(key, ['']), /Region names/)
  assert(key.every((byte) => byte === 0))
})

test('region codes retain all matching known names and distinguish unknown and unscoped', async () => {
  const input = Buffer.concat([Buffer.of(5), Buffer.from(payload)])
  const seen = new Map()
  let names
  let code
  for (let index = 0; index < 2000; index++) {
    const name = `#region${index}`
    const key = createHash('sha256').update(name).digest().subarray(0, 16)
    const mac = createHmac('sha256', key).update(input).digest()
    const value = mac.readUInt16LE()
    const normalized = value === 0 ? 1 : value === 65535 ? 65534 : value
    if (seen.has(normalized)) { names = [seen.get(normalized), name].sort(); code = normalized; break }
    seen.set(normalized, name)
  }
  assert.ok(names)
  const observe = await createChannelObserver(bytes(secretHex), names)
  const codes = [code & 255, code >> 8, 0, 0]
  assert.deepEqual((await observe(packet(payload, 0x14, codes))).region, { kind: 'candidates', names })
  assert.deepEqual((await observe(packet(payload, 0x14, [0, 0, 0, 0]))).region, { kind: 'unscoped' })
  assert.deepEqual((await observe(packet(payload, 0x14, [255, 255, 0, 0]))).region, { kind: 'unknown' })
})
