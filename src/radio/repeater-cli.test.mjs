import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allocateRepeaterCliTag, repeaterCliCommand, sendRepeaterCli, UncertainRepeaterCliError,
} from './repeater-cli.ts'

const key = 'bc'.repeat(32)
const encoder = new TextEncoder()

test('CLI queries use the repeater text type and a tagged command', async () => {
  let command
  const link = { async request(bytes, receive) {
    command = bytes.slice()
    return receive(Uint8Array.of(6, 1, 0, 0, 0, 0, 0xe8, 3, 0, 0)).value
  } }
  assert.deepEqual(await sendRepeaterCli(link, key, 'get name', 'A7'), {
    tag: 'A7', route: 'flood', timeoutMs: 10_000,
  })
  assert.deepEqual([...command], [2, 1, 0, 0, 0, 0, 0, ...new Uint8Array(6).fill(0xbc), ...encoder.encode('A7|get name')])
})

test('CLI rejects unsafe and unsupported text before dispatch', async () => {
  let writes = 0
  const link = { async request() { writes++; throw new Error('unexpected write') } }
  for (const command of ['get guest.password', 'set guest.password secret', 'get prv.key', 'reboot', 'ver\nadvert']) {
    await assert.rejects(sendRepeaterCli(link, key, command, 'AA'), /supported repeater CLI command/)
  }
  assert.equal(writes, 0)
  assert.equal(repeaterCliCommand('advert').confirm, true)
})

test('CLI confirmation failures distinguish rejection from uncertain dispatch', async () => {
  const link = (reply) => ({ async request(_bytes, receive) { return receive(Uint8Array.of(...reply)).value } })
  await assert.rejects(sendRepeaterCli(link([1, 2]), key, 'ver', 'AA'), { code: 'device-error' })
  for (const response of [[6, 0], [6, 2, ...new Uint8Array(8)], [1], [0]]) {
    await assert.rejects(sendRepeaterCli(link(response), key, 'ver', 'BC'), (error) =>
      error instanceof UncertainRepeaterCliError && error.tag === 'BC')
  }
})

test('reply tags never repeat in the tab and exhaustion is explicit', () => {
  const used = new Set()
  const first = allocateRepeaterCliTag(used)
  const second = allocateRepeaterCliTag(used)
  assert.notEqual(first, second)
  assert.match(first, /^[0-9A-Z]{2}$/)
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const firstChar of alphabet) for (const secondChar of alphabet) used.add(firstChar + secondChar)
  assert.throws(() => allocateRepeaterCliTag(used), /No unused CLI reply tags/)
})
