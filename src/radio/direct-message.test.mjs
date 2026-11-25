import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  decodeDirectAck, decodeDirectSent, directMessageCommand, directTextBytes, expectedDirectAck, resetPathCommand,
} from './direct-message.ts'

const sender = 'ab'.repeat(32)
const recipient = 'bc'.repeat(32)

test('encodes direct packets and enforces the UTF-8 byte limit', () => {
  const command = directMessageCommand(recipient, 0x12345678, 4, 'Hi 🕊')
  assert.deepEqual([...command.slice(0, 13)], [2, 0, 4, 0x78, 0x56, 0x34, 0x12, ...Array(6).fill(0xbc)])
  assert.equal(new TextDecoder().decode(command.slice(13)), 'Hi 🕊')
  assert.equal(directTextBytes('é'.repeat(75)).length, 150)
  for (const invalid of ['', 'é'.repeat(76), 'x\0y', '\ud800']) {
    assert.throws(() => directTextBytes(invalid), /UTF-8/)
  }
  assert.throws(() => directMessageCommand(recipient, 1, 8, 'Hi'), /attempt/)
  assert.deepEqual([...resetPathCommand(recipient)], [13, ...Array(32).fill(0xbc)])
})

test('matches firmware ACK hashing and decodes send and acknowledgement frames', async () => {
  const timestamp = 0x12345678
  const hash = createHash('sha256')
    .update(Buffer.from([0x78, 0x56, 0x34, 0x12, 1]))
    .update('Hello')
    .update(Buffer.from(sender, 'hex'))
    .digest('hex').slice(0, 8)
  assert.equal(await expectedDirectAck(sender, timestamp, 1, 'Hello'), hash)
  assert.equal(await expectedDirectAck(sender, timestamp, 5, 'Hello'), hash)
  assert.deepEqual(decodeDirectSent(Uint8Array.of(6, 1, 1, 2, 3, 4, 0x10, 0x27, 0, 0)), {
    route: 'flood', expectedAck: '01020304', timeoutMs: 10000,
  })
  assert.deepEqual(decodeDirectAck(Uint8Array.of(1, 2, 3, 4, 20, 0, 0, 0)), {
    code: '01020304', roundTripMs: 20,
  })
  assert.throws(() => decodeDirectSent(Uint8Array.of(6, 2, 1, 2, 3, 4, 0, 0, 0, 0)), /Invalid/)
  assert.throws(() => decodeDirectAck(Uint8Array.of(1, 2)), /Truncated/)
})
