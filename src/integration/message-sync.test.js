import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { MessageSync } from './message-sync.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'

const publicKey = 'ab'.repeat(32)
const key = radioKeyFromPublicKey(publicKey)
const direct = Uint8Array.of(7, 1, 2, 3, 4, 5, 6, 0, 0, 42, 0, 0, 0, 104, 105)

function sourceFor(frames) {
  return {
    calls: 0,
    snapshot: { phase: 'ready', device: { publicKey } },
    getSnapshot() { return this.snapshot },
    reserveQueuedMessage(expected) {
      assert.equal(expected, publicKey)
      return {
        request: async (receive) => {
          this.calls++
          const frame = frames.shift()
          if (!frame) return false
          receive(frame)
          return true
        },
        release() {},
      }
    },
  }
}

test('preserves identical receipts independently and keeps unsupported bytes readable', async () => {
  const factory = new IDBFactory()
  const source = sourceFor([direct, direct, Uint8Array.of(0x55, 1, 2), Uint8Array.of(16)])
  const sync = new MessageSync(source, () => openRadioStorage(factory))
  await sync.sync()
  assert.match(sync.getSnapshot().error, /unrecognized/)
  assert.equal(source.calls, 3)
  await sync.sync()
  assert.match(sync.getSnapshot().error, /unrecognized/)
  assert.equal(source.calls, 4)
  await sync.sync()
  assert.equal(sync.getSnapshot().error, null)
  const messages = sync.getSnapshot().data.messages
  assert.equal(messages.length, 4)
  assert.notEqual(messages[0].id, messages[1].id)
  assert.equal(messages[0].text, 'hi')
  assert.equal(messages[1].text, 'hi')
  assert.equal(messages[2].rawHex, '550102')
  assert.equal(messages[2].conversationId, 'unsupported')
  assert.equal(messages[3].rawHex, '10')
})

test('stops after a failed save and retries the same receipt before fetching another', async () => {
  const factory = new IDBFactory()
  const source = sourceFor([direct, direct])
  const attempts = []
  let fail = true
  const sync = new MessageSync(source, async () => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      update: async (target, update) => {
        attempts.push(update.messages[0])
        if (fail) { fail = false; throw new Error('Disk unavailable') }
        await storage.update(target, update)
      },
    }
  })
  await sync.sync()
  assert.equal(source.calls, 1)
  assert.equal(sync.getSnapshot().pending, true)
  assert.match(sync.getSnapshot().error, /Disk unavailable/)
  source.snapshot.phase = 'idle'
  await sync.sync()
  assert.equal(source.calls, 1)
  assert.equal(sync.getSnapshot().pending, false)
  assert.equal(attempts[0].id, attempts[1].id)
  const storage = await openRadioStorage(factory)
  assert.equal((await storage.read(key)).messages.length, 1)
  storage.close()
  source.snapshot.phase = 'ready'
  await sync.sync()
  assert.equal(sync.getSnapshot().data.messages.length, 2)
})

test('stops for inspection after retrying a failed unsupported receipt save', async (t) => {
  for (const frame of [Uint8Array.of(0x55, 1, 2), Uint8Array.of(16)]) {
    await t.test(`response ${frame[0]}`, async () => {
      const factory = new IDBFactory()
      const source = sourceFor([frame, direct])
      const attempts = []
      let fail = true
      const sync = new MessageSync(source, async () => {
        const storage = await openRadioStorage(factory)
        return {
          ...storage,
          update: async (target, update) => {
            attempts.push(update.messages[0])
            if (fail) { fail = false; throw new Error('Disk unavailable') }
            await storage.update(target, update)
          },
        }
      })

      await sync.sync()
      assert.equal(source.calls, 1)
      assert.equal(sync.getSnapshot().pending, true)
      await sync.sync()
      assert.equal(source.calls, 1, 'no additional queue request after saving unsupported bytes')
      assert.equal(sync.getSnapshot().pending, false)
      assert.match(sync.getSnapshot().error, /unrecognized/)
      assert.equal(attempts[0].id, attempts[1].id)
      assert.equal(sync.getSnapshot().data.messages[0].rawHex, Buffer.from(frame).toString('hex'))
    })
  }
})

test('does not request queued receipts while other cache writes need attention', async () => {
  const source = sourceFor([direct])
  const sync = new MessageSync(source, () => openRadioStorage(new IDBFactory()), () => false)
  await sync.sync()
  assert.equal(source.calls, 0)
  assert.match(sync.getSnapshot().error, /cache writes/)
})

test('received messages and concurrent contact edits are retained together', async () => {
  const factory = new IDBFactory()
  const storage = await openRadioStorage(factory)
  const contact = { publicKey: '010203040506' + 'ab'.repeat(26), name: 'Contact' }
  await storage.update(key, { contacts: [contact] })
  const sync = new MessageSync(sourceFor([direct]), () => openRadioStorage(factory))
  await Promise.all([
    sync.sync(),
    storage.update(key, { contactPreference: { publicKey: contact.publicKey, favorite: true } }),
  ])
  const data = await storage.read(key)
  assert.deepEqual(data.contacts, [contact])
  assert.equal(data.contactPreferences[0].favorite, true)
  assert.equal(data.messages[0].text, 'hi')
  storage.close()
})
