import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelMessageCommand, channelTextBytes, channelTextLimit } from './channel-message.ts'

test('channel command uses the firmware frame and leaves room for the UTF-8 sender prefix', () => {
  const sender = 'Pi🕊'
  assert.equal(channelTextLimit(sender), 152)
  const text = 'é'.repeat(76)
  assert.equal(channelTextBytes(text, sender).length, 152)
  const command = channelMessageCommand(3, 0x12345678, text, sender)
  assert.deepEqual([...command.slice(0, 7)], [3, 0, 3, 0x78, 0x56, 0x34, 0x12])
  assert.equal(new TextDecoder().decode(command.slice(7)), text)
  assert.throws(() => channelTextBytes(`${text}a`, sender), /1 to 152 valid UTF-8 bytes/)
  assert.throws(() => channelTextBytes('a\0b', sender), /without NUL/)
  assert.throws(() => channelTextBytes('\ud800', sender), /valid UTF-8/)
  assert.throws(() => channelMessageCommand(256, 1, 'a', sender), /Invalid channel slot/)
  assert.throws(() => channelMessageCommand(0, 0x100000000, 'a', sender), /timestamp/)
})
