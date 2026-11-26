import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreContactsAfterIdentity } from './backup-commands.ts'
import { maintenanceCommand, readBootTime, verifyRebootTime } from './identity-backup.ts'

test('reads uptime from the firmware’s 11-byte core stats reply', async () => {
  const frame = Uint8Array.of(24, 0, 0x30, 0x10, 30, 0, 0, 0, 0, 0, 1)
  const link = (reply) => ({ async request(command, receive) {
    assert.deepEqual(command, Uint8Array.of(56, 0))
    return receive(reply).value
  } })
  const before = performance.now()
  const startedAt = await readBootTime(link(frame))
  assert.ok(startedAt >= before - 30_000 && startedAt <= performance.now() - 30_000)
  await assert.rejects(readBootTime(link(frame.subarray(0, 10))), /did not report its uptime/)
})

test('requires a new boot after requesting an identity recovery reboot', () => {
  const preparation = { bootTime: 5_000, requestedAt: 31_000 }
  assert.throws(() => verifyRebootTime(preparation, 5_300), /restart could not be verified/)
  assert.throws(() => verifyRebootTime(preparation, 15_000), /restart could not be verified/)
  assert.doesNotThrow(() => verifyRebootTime(preparation, 31_200))
})

test('preserves pending contact fields and keeps newer radio changes after identity replacement', async () => {
  const contact = (publicKey, name, lastModifiedAt) => ({ publicKey, name, lastModifiedAt,
    type: 2, flags: 0, pathLength: 255, pathHex: '', latitude: 0, longitude: 0, lastAdvertisedAt: 0 })
  const pending = contact('ab'.repeat(32), 'Pending name', 16)
  const old = contact('cd'.repeat(32), 'Old name', 16)
  const flash = [contact(pending.publicKey, 'Previous name', 10), contact(old.publicKey, 'Newest name', 20)]
  const writes = []
  const link = {
    async request(command, receive) {
      assert.equal(command[0], 9)
      writes.push(new TextDecoder().decode(command.subarray(100, 132)).split('\0')[0])
      return receive(Uint8Array.of(0)).value
    },
    async sendWithoutReply(command) { writes.push(command[0]) },
  }
  const signal = AbortSignal.abort()
  const target = { ownKey: 'ef'.repeat(32), firmware: 14, capacity: 2,
    connected: () => true, readContacts: async () => flash }
  const results = await restoreContactsAfterIdentity(link, [pending, old], [], signal, target,
    () => link.sendWithoutReply(maintenanceCommand('reboot')))
  assert.deepEqual(writes, ['Pending name', 19])
  assert.deepEqual(results.map(({ label, status }) => ({ label, status })), [{ label: 'Preserve Pending name', status: 'saved' }])
})
