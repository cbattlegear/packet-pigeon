import type { CompanionMessage, CompanionPush, CompanionSnapshot } from '../radio/index.ts'
import { decodeAdvert } from '../radio/discovery-commands.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { RadioKey, RadioUpdate, StoredDiscovery, StoredMessage } from '../storage/index.ts'
import { storedContact } from './contact-record.ts'

type SessionSource = {
  getSnapshot(): CompanionSnapshot
  subscribe(listener: () => void): () => void
  subscribeToPushes?(listener: (push: CompanionPush) => void): () => void
}

type CacheStatus = {
  readonly pending: number
  readonly saving: boolean
  readonly error: string | null
}

type PendingUpdate = {
  key: RadioKey
  update: RadioUpdate
  completion?: { resolve: () => void; reject: (error: unknown) => void }
}

function storedMessage(message: CompanionMessage): StoredMessage {
  return {
    id: message.receiptId,
    conversationId: message.kind === 'direct-text'
      ? `direct:${message.senderKeyPrefix}`
      : `channel:${message.channelIndex}`,
    sender: message.kind === 'direct-text' ? message.senderKeyPrefix : '',
    timestamp: message.kind === 'channel-data' ? null : message.senderTimestamp * 1000,
    text: message.kind === 'channel-data' ? '' : message.text,
    receipt: { ...message },
  }
}

export class SessionCache {
  private readonly events = new EventTarget()
  private readonly queue: PendingUpdate[] = []
  private readonly discoveryListeners = new Set<(key: RadioKey, discovery: StoredDiscovery) => void>()
  private readonly seenReceipts = new Set<string>()
  private readonly openStorage: typeof openRadioStorage
  private storage?: Awaited<ReturnType<typeof openRadioStorage>>
  private status: CacheStatus = { pending: 0, saving: false, error: null }
  private savedContacts?: CompanionSnapshot['contacts']
  private savedChannels?: CompanionSnapshot['channels']
  private phase: CompanionSnapshot['phase'] = 'idle'

  constructor(session: SessionSource, openStorage = openRadioStorage) {
    this.openStorage = openStorage
    session.subscribe(() => this.capture(session.getSnapshot()))
    session.subscribeToPushes?.((push) => {
      const { device, phase, contacts, transport } = session.getSnapshot()
      // BLE notifications do not provide reliable advert frame boundaries.
      if (transport !== 'usb' || !device || (phase !== 'ready' && phase !== 'syncing')) return
      const advert = decodeAdvert(push.code, push.payload)
      if (!advert) return
      const { publicKey, added } = advert
      const contact = advert.contact ?? contacts.find((record) => record.publicKey === publicKey)
      this.enqueue(radioKeyFromPublicKey(device.publicKey), { discovery: { upsert: [{
        publicKey, heardAt: Date.now(), addedWhenHeard: added,
        ...(contact ? {
          name: contact.name, type: contact.type, latitude: contact.latitude, longitude: contact.longitude,
        } : {}),
      }] } })
    })
    this.capture(session.getSnapshot())
  }

  readonly subscribe = (listener: () => void) => {
    this.events.addEventListener('change', listener)
    return () => this.events.removeEventListener('change', listener)
  }

  readonly getSnapshot = () => this.status

  readonly subscribeToDiscoveries = (listener: (key: RadioKey, discovery: StoredDiscovery) => void) => {
    this.discoveryListeners.add(listener)
    return () => { this.discoveryListeners.delete(listener) }
  }

  private setStatus(update: Partial<CacheStatus>) {
    this.status = { ...this.status, ...update }
    this.events.dispatchEvent(new Event('change'))
  }

  private capture(snapshot: CompanionSnapshot) {
    if (snapshot.phase === 'handshake' && this.phase !== 'handshake') {
      this.savedContacts = undefined
      this.savedChannels = undefined
      this.seenReceipts.clear()
    }
    this.phase = snapshot.phase
    if (!snapshot.device || (snapshot.phase !== 'syncing' && snapshot.phase !== 'ready')) return

    let key: RadioKey
    try {
      key = radioKeyFromPublicKey(snapshot.device.publicKey)
    } catch (error) {
      this.setStatus({ error: error instanceof Error ? error.message : 'Invalid radio identity.' })
      return
    }

    const stage = snapshot.progress?.stage
    if (this.savedContacts !== snapshot.contacts
      && (stage === 'channels' || stage === 'messages' || snapshot.phase === 'ready')) {
      this.savedContacts = snapshot.contacts
      this.enqueue(key, { contacts: snapshot.contacts.map(storedContact), contactsCapturedAt: Date.now() })
    }
    if (this.savedChannels !== snapshot.channels && (stage === 'messages' || snapshot.phase === 'ready')) {
      this.savedChannels = snapshot.channels
      this.enqueue(key, { channels: snapshot.channels.map(({ index, name }) => ({ index, name })) })
    }
    for (const message of snapshot.messages) {
      if (this.seenReceipts.has(message.receiptId)) continue
      this.seenReceipts.add(message.receiptId)
      this.enqueue(key, { messages: [storedMessage(message)] })
    }
  }

  private enqueue(key: RadioKey, update: RadioUpdate, completion?: PendingUpdate['completion']) {
    this.queue.push({ key, update, completion })
    this.setStatus({ pending: this.queue.length })
    if (!this.status.error) void this.flush()
  }

  readonly renameChannelRetention = (
    key: RadioKey, rename: NonNullable<RadioUpdate['channelRetentionRename']>,
  ) => {
    if (this.status.error) return Promise.reject(new Error('Retry saving the radio cache before updating retention.'))
    return new Promise<void>((resolve, reject) => {
      this.enqueue(key, { channelRetentionRename: rename }, { resolve, reject })
    })
  }

  readonly retry = () => {
    if (this.status.saving || this.queue.length === 0) return
    this.setStatus({ error: null })
    void this.flush()
  }

  private async flush() {
    if (this.status.saving || this.status.error || this.queue.length === 0) return
    this.setStatus({ saving: true })
    try {
      this.storage ??= await this.openStorage()
      while (this.queue.length) {
        const { key, update, completion } = this.queue[0]
        const discovery = update.discovery?.upsert?.[0]
        const previous = discovery ? await this.storage.read(key) : null
        await this.storage.update(key, update)
        this.queue.shift()
        this.setStatus({ pending: this.queue.length })
        if (discovery && !previous?.contacts.some((contact) => contact.publicKey === discovery.publicKey)
          && !previous?.discoveries?.some((entry) => entry.publicKey === discovery.publicKey)) {
          for (const listener of this.discoveryListeners) listener(key, discovery)
        }
        completion?.resolve()
      }
      this.setStatus({ saving: false })
    } catch (error) {
      this.storage?.close()
      this.storage = undefined
      const failed = this.queue[0]
      if (failed?.completion) {
        this.queue.shift()
        failed.completion.reject(error)
        this.setStatus({ pending: this.queue.length, saving: false })
        if (this.queue.length) void this.flush()
        return
      }
      for (let index = this.queue.length - 1; index >= 0; index--) {
        const completion = this.queue[index].completion
        if (completion) {
          this.queue.splice(index, 1)
          completion.reject(error)
        }
      }
      this.setStatus({
        pending: this.queue.length,
        saving: false,
        error: error instanceof Error ? error.message : 'Could not save radio data.',
      })
    }
  }
}
