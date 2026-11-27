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

function automaticSource(frames = []) {
  const changes = new Set()
  const pushes = new Set()
  return {
    calls: 0, busy: false, held: false, frames,
    snapshot: { phase: 'idle', device: null },
    getSnapshot() { return this.snapshot },
    subscribe(listener) { changes.add(listener); return () => changes.delete(listener) },
    subscribeToPushes(listener) { pushes.add(listener); return () => pushes.delete(listener) },
    canSyncQueuedMessages() { return !this.busy && !this.held },
    change(phase = 'ready', identity = publicKey) {
      this.snapshot = { phase, device: { publicKey: identity } }
      this.notify()
    },
    notify() { for (const listener of changes) listener() },
    push(code = 0x83) { for (const listener of pushes) listener({ code, payload: new Uint8Array() }) },
    reserveQueuedMessage(expected) {
      assert.equal(expected, this.snapshot.device.publicKey)
      assert.equal(this.snapshot.phase, 'ready')
      assert.equal(this.busy, false, 'must wait for another radio command')
      assert.equal(this.held, false, 'must save and release the previous receipt')
      this.held = true
      return {
        request: async (receive) => {
          this.calls++
          if (this.requestOverride) return this.requestOverride(receive)
          const frame = this.frames.shift()
          if (!frame) return false
          receive(frame)
          return true
        },
        release: () => { this.held = false; this.notify() },
      }
    },
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.fail('Timed out waiting for automatic message sync')
}

test('automatically drains initial and later queued messages, ignoring unrelated pushes', async (t) => {
  const source = automaticSource([direct])
  const factory = new IDBFactory()
  const sync = new MessageSync(source, () => openRadioStorage(factory))
  t.after(sync.startAutomaticSync(() => () => {}))
  assert.equal(source.calls, 0)
  source.change()
  await waitFor(() => source.calls === 2 && !sync.getSnapshot().syncing && sync.getSnapshot().data?.messages.length === 1)
  assert.equal(sync.getSnapshot().data.messages.length, 1)
  source.push(0x82)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(source.calls, 2)
  source.frames.push(direct, direct)
  for (let i = 0; i < 20; i++) source.push()
  await waitFor(() => source.calls === 5 && !sync.getSnapshot().syncing && sync.getSnapshot().data?.messages.length === 3)
  assert.equal(sync.getSnapshot().data.messages.length, 3)
  assert.equal(new Set(sync.getSnapshot().data.messages.map(({ id }) => id)).size, 3)
})

test('defers automatic reads until cache and command readiness, including notifications during a save', async (t) => {
  const source = automaticSource([direct])
  const factory = new IDBFactory()
  let cacheReady = false
  let readiness
  const saving = Promise.withResolvers()
  const saveGate = Promise.withResolvers()
  let first = true
  const sync = new MessageSync(source, async () => {
    const storage = await openRadioStorage(factory)
    return { ...storage, update: async (key, update) => {
      if (first) {
        first = false
        saving.resolve()
        await saveGate.promise
      }
      await storage.update(key, update)
    } }
  }, () => cacheReady)
  t.after(sync.startAutomaticSync((listener) => { readiness = listener; return () => {} }))
  source.change()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(source.calls, 0)
  source.busy = true
  cacheReady = true
  readiness()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(source.calls, 0)
  source.busy = false
  source.notify()
  await saving.promise
  source.frames.push(direct, direct)
  for (let i = 0; i < 20; i++) source.push()
  assert.equal(source.calls, 1)
  cacheReady = false
  saveGate.resolve()
  await waitFor(() => !sync.getSnapshot().syncing)
  assert.equal(source.calls, 1)
  cacheReady = true
  readiness()
  await waitFor(() => source.calls >= 4 && !sync.getSnapshot().syncing && sync.getSnapshot().data?.messages.length === 3)
  assert.equal(sync.getSnapshot().data.messages.length, 3)
  assert.equal(sync.getSnapshot().error, null)
})

test('rechecks a notification racing the empty response without overlapping manual or automatic drains', async (t) => {
  const source = automaticSource()
  const factory = new IDBFactory()
  const emptyRequest = Promise.withResolvers()
  const finishEmpty = Promise.withResolvers()
  let first = true
  source.requestOverride = async (receive) => {
    if (first) {
      first = false
      emptyRequest.resolve()
      await finishEmpty.promise
      return false
    }
    const frame = source.frames.shift()
    if (!frame) return false
    receive(frame)
    return true
  }
  const sync = new MessageSync(source, () => openRadioStorage(factory))
  t.after(sync.startAutomaticSync(() => () => {}))
  source.change()
  await emptyRequest.promise
  await sync.sync()
  assert.equal(source.calls, 1)
  source.frames.push(direct)
  source.push()
  finishEmpty.resolve()
  await waitFor(() => source.calls === 3 && !sync.getSnapshot().syncing && sync.getSnapshot().data?.messages.length === 1)
  assert.equal(sync.getSnapshot().data.messages.length, 1)
})

test('failed automatic persistence pauses bursts and retries the same receipt before the next read', async (t) => {
  const source = automaticSource([direct, direct])
  const factory = new IDBFactory()
  const attempts = []
  let fail = true
  const sync = new MessageSync(source, async () => {
    const storage = await openRadioStorage(factory)
    return { ...storage, update: async (key, update) => {
      attempts.push(update.messages[0].id)
      if (fail) throw new Error('Disk unavailable')
      await storage.update(key, update)
    } }
  })
  t.after(sync.startAutomaticSync(() => () => {}))
  source.change()
  await waitFor(() => !sync.getSnapshot().syncing && sync.getSnapshot().pending)
  assert.match(sync.getSnapshot().error, /Disk unavailable/)
  for (let i = 0; i < 20; i++) source.push()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(source.calls, 1)
  assert.equal(attempts.length, 1)
  fail = false
  await sync.sync()
  await waitFor(() => !sync.getSnapshot().syncing)
  assert.equal(attempts[0], attempts[1])
  assert.equal(sync.getSnapshot().pending, false)
  assert.equal(sync.getSnapshot().error, null)
  assert.equal(sync.getSnapshot().data.messages.length, 2)
})

test('reconnection saves an old radio pending receipt under its own key before draining the new radio', async (t) => {
  const source = automaticSource([direct])
  const factory = new IDBFactory()
  const otherKey = 'cd'.repeat(32)
  let fail = true
  const writes = []
  const sync = new MessageSync(source, async () => {
    const storage = await openRadioStorage(factory)
    return { ...storage, update: async (key, update) => {
      writes.push({ key, id: update.messages[0].id })
      if (fail) throw new Error('Disk unavailable')
      await storage.update(key, update)
    } }
  })
  t.after(sync.startAutomaticSync(() => () => {}))
  source.change()
  await waitFor(() => sync.getSnapshot().pending && !sync.getSnapshot().syncing)
  source.change('idle')
  fail = false
  source.frames.push(direct)
  source.change('ready', otherKey)
  await waitFor(() => source.calls === 3 && !sync.getSnapshot().syncing && sync.getSnapshot().data?.messages.length === 1)
  assert.deepEqual(writes.map(({ key }) => key), [publicKey, publicKey, otherKey])
  assert.equal(writes[0].id, writes[1].id)
  const storage = await openRadioStorage(factory)
  try {
    assert.equal((await storage.read(key)).messages.length, 1)
    assert.equal((await storage.read(radioKeyFromPublicKey(otherKey))).messages.length, 1)
  } finally { storage.close() }
})

test('a transport failure surfaces and does not suppress automatic sync on reconnect', async (t) => {
  const source = automaticSource([direct])
  const factory = new IDBFactory()
  let fail = true
  source.requestOverride = async (receive) => {
    if (fail) throw new Error('Transport unavailable')
    const frame = source.frames.shift()
    if (!frame) return false
    receive(frame)
    return true
  }
  const sync = new MessageSync(source, () => openRadioStorage(factory))
  t.after(sync.startAutomaticSync(() => () => {}))
  source.change()
  await waitFor(() => !sync.getSnapshot().syncing && sync.getSnapshot().error)
  assert.match(sync.getSnapshot().error, /Transport unavailable/)
  source.push()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(source.calls, 1)
  source.change('reconnecting')
  fail = false
  source.change()
  await waitFor(() => source.calls === 3 && !sync.getSnapshot().syncing && sync.getSnapshot().data?.messages.length === 1)
  assert.equal(sync.getSnapshot().error, null)
  assert.equal(sync.getSnapshot().data.messages.length, 1)
})

test('an old drain finishes persistence but never continues across a reconnect or subscription cleanup', async (t) => {
  for (const action of ['reconnect', 'stop']) await t.test(action, async () => {
    const source = automaticSource([direct, direct])
    const factory = new IDBFactory()
    const saving = Promise.withResolvers()
    const gate = Promise.withResolvers()
    let first = true
    const sync = new MessageSync(source, async () => {
      const storage = await openRadioStorage(factory)
      return { ...storage, update: async (key, update) => {
        if (first) {
          first = false
          saving.resolve()
          await gate.promise
        }
        await storage.update(key, update)
      } }
    })
    const stop = sync.startAutomaticSync(() => () => {})
    t.after(stop)
    source.change()
    await saving.promise
    if (action === 'reconnect') {
      source.change('reconnecting')
      source.change()
    } else stop()
    gate.resolve()
    await waitFor(() => !sync.getSnapshot().syncing && (action === 'stop' || source.calls === 3)
      && sync.getSnapshot().data?.messages.length === (action === 'stop' ? 1 : 2))
    assert.equal(source.calls, action === 'stop' ? 1 : 3)
    assert.equal(sync.getSnapshot().data.messages.length, action === 'stop' ? 1 : 2)
    if (action === 'stop') {
      source.push()
      source.notify()
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(source.calls, 1)
    }
  })
})

test('a failing old transport cannot block the newly ready connection', async (t) => {
  const source = automaticSource([direct])
  const factory = new IDBFactory()
  const requesting = Promise.withResolvers()
  const rejectOld = Promise.withResolvers()
  let first = true
  source.requestOverride = async (receive) => {
    if (first) {
      first = false
      requesting.resolve()
      await rejectOld.promise
      throw new Error('Old connection failed')
    }
    const frame = source.frames.shift()
    if (!frame) return false
    receive(frame)
    return true
  }
  const sync = new MessageSync(source, () => openRadioStorage(factory))
  t.after(sync.startAutomaticSync(() => () => {}))
  source.change()
  await requesting.promise
  source.change('reconnecting')
  source.change()
  rejectOld.resolve()
  await waitFor(() => source.calls === 3 && !sync.getSnapshot().syncing && sync.getSnapshot().data?.messages.length === 1)
  assert.equal(sync.getSnapshot().error, null)
})

test('maintenance sync rejects failed receipt saves and retries under the supplied identity', async () => {
  const factory = new IDBFactory()
  const source = sourceFor([direct, direct])
  const destination = radioKeyFromPublicKey('cd'.repeat(32))
  const reserve = () => source.reserveQueuedMessage(publicKey)
  const { signal } = new AbortController()
  let canSave = false
  const sync = new MessageSync(source, async () => {
    const storage = await openRadioStorage(factory)
    return { ...storage, update: async (target, update) => {
      if (!canSave) throw new Error('Receipt storage is unavailable')
      await storage.update(target, update)
    } }
  })

  await assert.rejects(sync.syncForMaintenance(destination, reserve, signal), /Receipt storage is unavailable/)
  assert.equal(source.calls, 1)
  assert.equal(sync.getSnapshot().pending, true)

  canSave = true
  await sync.syncForMaintenance(destination, reserve, signal)
  assert.equal(source.calls, 3)
  assert.equal(sync.getSnapshot().pending, false)
  const storage = await openRadioStorage(factory)
  try {
    assert.equal((await storage.read(destination)).messages.length, 2)
    assert.equal(await storage.read(key), null)
  } finally { storage.close() }
})

test('reports only durably saved receipts during each manual sync', async () => {
  const factory = new IDBFactory()
  const source = sourceFor([direct, direct])
  let releaseSave
  let notifySave
  const saving = new Promise((resolve) => { notifySave = resolve })
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  let first = true
  const sync = new MessageSync(source, async () => {
    const storage = await openRadioStorage(factory)
    return {
      ...storage,
      update: async (target, update) => {
        if (first) {
          first = false
          notifySave()
          await saveGate
        }
        await storage.update(target, update)
      },
    }
  })
  const progress = []
  sync.subscribe(() => {
    const { syncing, receiptsSaved } = sync.getSnapshot()
    if (syncing) progress.push(receiptsSaved)
  })

  const running = sync.sync()
  await saving
  assert.equal(sync.getSnapshot().syncing, true)
  assert.equal(sync.getSnapshot().pending, true)
  assert.equal(sync.getSnapshot().receiptsSaved, 0)
  assert.equal(source.calls, 1)
  releaseSave()
  await running
  assert.equal(sync.getSnapshot().syncing, false)
  assert.equal(sync.getSnapshot().receiptsSaved, 2)
  assert.equal(source.calls, 3)
  assert.ok(progress.includes(0) && progress.includes(1) && progress.includes(2))

  await sync.sync()
  assert.equal(sync.getSnapshot().receiptsSaved, 0)
  assert.equal(source.calls, 4)
})

test('preserves identical receipts independently and keeps unsupported bytes readable', async () => {
  const factory = new IDBFactory()
  const source = sourceFor([direct, direct, Uint8Array.of(0x55, 1, 2), Uint8Array.of(16)])
  const sync = new MessageSync(source, () => openRadioStorage(factory))
  await sync.sync()
  assert.match(sync.getSnapshot().error, /unrecognized/)
  assert.equal(sync.getSnapshot().receiptsSaved, 3)
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
  const alerts = []
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
  sync.subscribeToSavedReceipts((radio, message, data) => {
    assert.equal(radio, key)
    assert.ok(data.messages.some((entry) => entry.id === message.id))
    alerts.push(message.id)
  })
  await sync.sync()
  assert.equal(source.calls, 1)
  assert.equal(sync.getSnapshot().pending, true)
  assert.equal(sync.getSnapshot().receiptsSaved, 0)
  assert.deepEqual(alerts, [])
  assert.match(sync.getSnapshot().error, /Disk unavailable/)
  source.snapshot.phase = 'idle'
  await sync.sync()
  assert.equal(source.calls, 1)
  assert.equal(sync.getSnapshot().pending, false)
  assert.equal(sync.getSnapshot().receiptsSaved, 1)
  assert.equal(attempts[0].id, attempts[1].id)
  assert.deepEqual(alerts, [attempts[0].id])
  const storage = await openRadioStorage(factory)
  assert.equal((await storage.read(key)).messages.length, 1)
  storage.close()
  source.snapshot.phase = 'ready'
  await sync.sync()
  assert.equal(sync.getSnapshot().receiptsSaved, 1)
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
      assert.equal(sync.getSnapshot().receiptsSaved, 1)
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
