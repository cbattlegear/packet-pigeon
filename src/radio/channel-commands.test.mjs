import assert from 'node:assert/strict'
import test from 'node:test'
import { channelName, makeChannelSecret, parseChannelSecret, readChannelSlot, secretHex, writeChannelSlot } from './channel-commands.ts'

test('channel keys follow MeshCore public and hashtag formats and validate private secrets', async () => {
  assert.equal(secretHex(await makeChannelSecret('public', 'Public', '')), '8b3387e9c5cdea6ac9e5edbaa115cd72')
  assert.equal(secretHex(await makeChannelSecret('hashtag', '#test', '')), '9cd8fcf22a47333b591d96a2b848b73f')
  assert.equal(parseChannelSecret('ab'.repeat(16)).length, 16)
  assert.throws(() => parseChannelSecret('0'.repeat(32)), /all zero/)
  assert.throws(() => parseChannelSecret('invalid'), /32 hexadecimal/)
  assert.throws(() => channelName('📡'.repeat(8)), /31 UTF-8/)
  await assert.rejects(makeChannelSecret('hashtag', 'test', ''), /start with #/)
  const generated = await makeChannelSecret('private', 'Test', '')
  assert.equal(generated.length, 16)
  assert.ok(generated.some((byte) => byte !== 0))
})

test('channel slot commands read and write exact wire frames without exposing secrets in errors', async () => {
  const frame = new Uint8Array(50)
  frame.set([18, 2])
  frame.set(new TextEncoder().encode('Test'), 2)
  frame.fill(0xab, 34)
  const sent = []
  const link = { async request(command, receive) {
    sent.push(command)
    return receive(command[0] === 31 ? frame : Uint8Array.of(0)).value
  } }
  const slot = await readChannelSlot(link, 2)
  assert.deepEqual(slot.channel, { index: 2, name: 'Test' })
  await writeChannelSlot(link, 2, 'Renamed', slot.secret)
  assert.equal(sent[1].length, 50)
  assert.deepEqual([...sent[1].slice(0, 2)], [32, 2])
  assert.deepEqual([...sent[1].slice(34)], [...slot.secret])
  const rejected = { request: async (_command, receive) => receive(Uint8Array.of(1, 5)).value }
  await assert.rejects(writeChannelSlot(rejected, 2, 'Test', slot.secret), /device error 5/)
  frame[1] = 3
  await assert.rejects(readChannelSlot(link, 2), /Expected channel slot 2/)
})
