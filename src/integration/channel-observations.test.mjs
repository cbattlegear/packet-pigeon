import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChannelObservations } from './channel-observations.ts'

const secretHex = '8b3387e9c5cdea6ac9e5edbaa115cd72'
const payload = Buffer.from('11a0e6215565cf0555d9e4a5e4824dc70018a6021e8232bb0509500bdf22a90e97978f', 'hex')

function fixture(readKey = async () => Uint8Array.from(Buffer.from(secretHex, 'hex'))) {
  let snapshot = { phase: 'ready', transport: 'usb', device: { publicKey: 'radio' }, channels: [{ index: 0, name: 'Public' }] }
  const changes = new Set()
  const pushes = new Set()
  const source = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { changes.add(listener); return () => changes.delete(listener) },
    subscribeToPushes: (listener) => { pushes.add(listener); return () => pushes.delete(listener) },
    readChannelObservationKey: readKey,
  }
  return {
    source,
    change: (update) => { snapshot = { ...snapshot, ...update }; for (const listener of changes) listener() },
    push: (packet = payload) => { for (const listener of pushes) listener({ code: 0x88, payload: Uint8Array.of(4, 200, 0x15, 1, 0xab, ...packet) }) },
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for packet processing')
}

test('captures USB observations and clears them when the radio changes', async () => {
  const source = fixture()
  const observer = new ChannelObservations(source.source)
  await observer.start('radio', { index: 0, name: 'Public' }, [])
  assert.equal(observer.getSnapshot().phase, 'active')
  source.push()
  await waitFor(() => observer.getSnapshot().entries.length === 1)
  assert.equal(observer.getSnapshot().entries[0].text, 'Alice: Hello mesh!')
  source.change({ phase: 'reconnecting' })
  assert.equal(observer.getSnapshot().phase, 'error')
  assert.deepEqual(observer.getSnapshot().entries, [])
  source.push()
  assert.deepEqual(observer.getSnapshot().entries, [])
})

test('stale key reads are cleared and cannot restart observation', async () => {
  let complete
  const source = fixture(() => new Promise((resolve) => { complete = resolve }))
  const observer = new ChannelObservations(source.source)
  const start = observer.start('radio', { index: 0, name: 'Public' }, [])
  observer.stop()
  const key = Uint8Array.from(Buffer.from(secretHex, 'hex'))
  complete(key)
  await start
  assert(key.every((byte) => byte === 0))
  assert.equal(observer.getSnapshot().phase, 'idle')
  source.push()
  assert.deepEqual(observer.getSnapshot().entries, [])
})

test('rejects Bluetooth and reports key-read failures without capturing', async () => {
  const source = fixture(async () => { throw new Error('Key read failed') })
  const observer = new ChannelObservations(source.source)
  source.change({ transport: 'bluetooth' })
  await observer.start('radio', { index: 0, name: 'Public' }, [])
  assert.match(observer.getSnapshot().error, /USB/)
  source.change({ transport: 'usb' })
  await observer.start('radio', { index: 0, name: 'Public' }, [])
  assert.match(observer.getSnapshot().error, /Key read failed/)
})

test('bounds pending packets and cancels queued work on stop', async () => {
  const source = fixture()
  const observer = new ChannelObservations(source.source)
  await observer.start('radio', { index: 0, name: 'Public' }, [])
  for (let index = 0; index < 501; index++) source.push()
  assert.equal(observer.getSnapshot().dropped, 1)
  observer.stop()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(observer.getSnapshot().phase, 'idle')
  assert.deepEqual(observer.getSnapshot().entries, [])
})

test('retains the newest 500 observations and reports discarded older entries', async () => {
  const source = fixture()
  const observer = new ChannelObservations(source.source)
  await observer.start('radio', { index: 0, name: 'Public' }, [])
  for (let index = 0; index < 500; index++) source.push()
  await waitFor(() => observer.getSnapshot().entries.length === 500)
  source.push()
  await waitFor(() => observer.getSnapshot().evicted === 1)
  assert.equal(observer.getSnapshot().entries.length, 500)
  assert.equal(observer.getSnapshot().entries[0].id, 501)
  assert.equal(observer.getSnapshot().entries.at(-1).id, 2)
  observer.stop()
})
