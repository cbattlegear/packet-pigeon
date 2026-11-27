import type { CompanionPush, QueuedMessageLease, SyncMaintenanceMessages } from '../radio/companion-session.ts'
import { CompanionError, Response, decodeQueuedMessage, messageWaiting } from '../radio/protocol.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { RadioData, RadioKey, StoredMessage } from '../storage/index.ts'

type MessageSource = {
  getSnapshot(): { phase: string; device: { publicKey: string } | null }
  reserveQueuedMessage(publicKey: string): QueuedMessageLease
  subscribe?(listener: () => void): () => void
  subscribeToPushes?(listener: (push: CompanionPush) => void): () => void
  canSyncQueuedMessages?(): boolean
}

type PendingReceipt = { key: RadioKey; message: StoredMessage; release: () => void }
type MaintenanceSync = { publicKey: string; reserve: () => QueuedMessageLease; signal: AbortSignal }
type Status = {
  syncing: boolean
  receiptsSaved: number
  error: string | null
  pending: boolean
  key: RadioKey | null
  data: RadioData | null
}

const knownResponses: readonly number[] = [
  Response.directText, Response.directTextV3, Response.channelText,
  Response.channelTextV3, Response.channelData,
]
const unsupportedError = 'An unrecognized response was saved as raw bytes. Sync stopped; inspect it before trying again.'

function makeReceipt(frame: Uint8Array, id: string): StoredMessage {
  const rawHex = Array.from(frame, (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (knownResponses.includes(frame[0])) {
    try {
      const receipt = { ...decodeQueuedMessage(frame), receiptId: id }
      return {
        id, rawHex, receipt, receivedAt: Date.now(),
        conversationId: receipt.kind === 'direct-text'
          ? `direct:${receipt.senderKeyPrefix}` : `channel:${receipt.channelIndex}`,
        sender: receipt.kind === 'direct-text' ? receipt.senderKeyPrefix : '',
        timestamp: receipt.kind === 'channel-data' ? null : receipt.senderTimestamp * 1000,
        text: receipt.kind === 'channel-data' ? '' : receipt.text,
      }
    } catch (error) {
      if (!(error instanceof CompanionError) || error.code !== 'protocol') throw error
    }
  }
  return { id, rawHex, conversationId: 'unsupported', sender: '', timestamp: null, text: '' }
}

export class MessageSync {
  private readonly events = new EventTarget()
  private readonly receiptListeners = new Set<(key: RadioKey, message: StoredMessage, data: RadioData) => void>()
  private readonly source: MessageSource
  private readonly openStorage: typeof openRadioStorage
  private readonly cacheReady: () => boolean
  private pendingReceipt?: PendingReceipt
  private loadVersion = 0
  private stopAutomaticSync?: () => void
  private status: Status = { syncing: false, receiptsSaved: 0, error: null, pending: false, key: null, data: null }

  constructor(source: MessageSource, openStorage = openRadioStorage, cacheReady = () => true) {
    this.source = source
    this.openStorage = openStorage
    this.cacheReady = cacheReady
  }

  readonly subscribe = (listener: () => void) => {
    this.events.addEventListener('change', listener)
    return () => this.events.removeEventListener('change', listener)
  }

  readonly getSnapshot = () => this.status

  readonly startAutomaticSync = (subscribeToReadiness: (listener: () => void) => () => void) => {
    const source = this.source
    if (!source.subscribe || !source.subscribeToPushes || !source.canSyncQueuedMessages) {
      throw new Error('Automatic message sync requires session notifications and command readiness.')
    }
    this.stopAutomaticSync?.()
    let active = true
    let requested = false
    let scheduled = false
    let running = false
    let blocked = false
    let generation = 0
    let readyKey: string | undefined
    let wasSyncing = this.status.syncing
    const canDrain = () => this.cacheReady() && source.canSyncQueuedMessages?.() === true
    const eligible = () => active && readyKey && requested && !blocked && !running
      && !this.status.syncing && (this.pendingReceipt || canDrain())

    const wake = () => {
      if (scheduled || !eligible()) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (!eligible()) return
        requested = false
        running = true
        const current = generation
        const continueDraining = () => {
          if (!active || generation !== current) return false
          if (canDrain()) return true
          requested = true
          return false
        }
        void this.syncMessages(undefined, continueDraining).catch((error: unknown) => {
          this.update({ error: error instanceof Error ? error.message : 'Could not sync messages.' })
        }).finally(() => {
          running = false
          if (generation === current) blocked = this.status.error !== null
          wake()
        })
      })
    }
    const sessionChanged = () => {
      const snapshot = source.getSnapshot()
      const key = snapshot.phase === 'ready' ? snapshot.device?.publicKey : undefined
      if (key !== readyKey) {
        readyKey = key
        ++generation
        requested = key !== undefined
        blocked = false
      }
      wake()
    }
    const stopSession = source.subscribe(sessionChanged)
    const stopPushes = source.subscribeToPushes((push) => {
      if (push.code !== messageWaiting || !readyKey) return
      requested = true
      wake()
    })
    const stopReadiness = subscribeToReadiness(wake)
    const stopStatus = this.subscribe(() => {
      if (wasSyncing && !this.status.syncing && !running) {
        blocked = this.status.error !== null
      }
      wasSyncing = this.status.syncing
      wake()
    })
    sessionChanged()
    const stop = () => {
      active = false
      stopSession()
      stopPushes()
      stopReadiness()
      stopStatus()
      if (this.stopAutomaticSync === stop) this.stopAutomaticSync = undefined
    }
    this.stopAutomaticSync = stop
    return stop
  }

  readonly subscribeToSavedReceipts = (listener: (key: RadioKey, message: StoredMessage, data: RadioData) => void) => {
    this.receiptListeners.add(listener)
    return () => { this.receiptListeners.delete(listener) }
  }

  private update(update: Partial<Status>) {
    this.status = { ...this.status, ...update }
    this.events.dispatchEvent(new Event('change'))
  }

  readonly load = async (publicKey: string) => {
    const version = ++this.loadVersion
    try {
      const key = radioKeyFromPublicKey(publicKey)
      this.update({ key, data: null })
      const storage = await this.openStorage()
      try {
        const data = await storage.read(key)
        if (version === this.loadVersion && !this.status.syncing) this.update({ data })
      } finally {
        storage.close()
      }
    } catch (error) {
      if (version === this.loadVersion) {
        this.update({ error: error instanceof Error ? error.message : 'Could not load messages.' })
      }
    }
  }

  private async savePending(storage: Awaited<ReturnType<typeof openRadioStorage>>) {
    const pending = this.pendingReceipt
    if (!pending) throw new Error('No received message is waiting to be saved.')
    await storage.update(pending.key, { messages: [pending.message] })
    this.pendingReceipt = undefined
    pending.release()
    this.update({ pending: false, receiptsSaved: this.status.receiptsSaved + 1 })
    const data = await storage.read(pending.key)
    if (data) for (const listener of this.receiptListeners) listener(pending.key, pending.message, data)
    return pending.message.receipt !== undefined
  }

  readonly sync = () => this.syncMessages()

  readonly syncForMaintenance: SyncMaintenanceMessages = async (publicKey, reserve, signal) => {
    if (this.status.syncing) throw new Error('Wait for the current message sync before restarting the radio.')
    signal.throwIfAborted()
    await this.syncMessages({ publicKey, reserve, signal })
    if (this.status.error || this.status.pending) {
      throw new Error(this.status.error ?? 'Save the pending message before restarting the radio.')
    }
  }

  private async syncMessages(maintenance?: MaintenanceSync, continueDraining?: () => boolean) {
    if (this.status.syncing) return
    ++this.loadVersion
    this.update({ syncing: true, receiptsSaved: 0, error: null })
    let storage: Awaited<ReturnType<typeof openRadioStorage>> | undefined
    try {
      storage = await this.openStorage()
      if (this.pendingReceipt) {
        if (!await this.savePending(storage)) throw new Error(unsupportedError)
      }
      if (continueDraining && !continueDraining()) return
      const snapshot = this.source.getSnapshot()
      const publicKey = maintenance?.publicKey ?? (snapshot.phase === 'ready' ? snapshot.device?.publicKey : undefined)
      if (!publicKey) throw new Error('Connect a radio before syncing messages.')
      const key = radioKeyFromPublicKey(publicKey)
      this.update({ key, data: null })
      const cached = await storage.read(key)
      if (this.status.key === key) this.update({ data: cached })
      while (true) {
        maintenance?.signal.throwIfAborted()
        if (continueDraining && !continueDraining()) break
        if (!this.cacheReady()) throw new Error('Resolve pending cache writes before syncing messages.')
        const id = crypto.randomUUID()
        const lease = maintenance ? maintenance.reserve() : this.source.reserveQueuedMessage(key)
        let failed = false
        let requestError: unknown
        let received = false
        try {
          received = await lease.request((frame) => {
            const rawHex = Array.from(frame, (byte) => byte.toString(16).padStart(2, '0')).join('')
            this.pendingReceipt = {
              key, release: lease.release,
              message: { id, rawHex, conversationId: 'unsupported', sender: '', timestamp: null, text: '' },
            }
            this.update({ pending: true })
            this.pendingReceipt.message = makeReceipt(frame, id)
          })
        } catch (error) {
          failed = true
          requestError = error
        }
        if (!this.pendingReceipt) {
          lease.release()
          if (failed) throw requestError
          if (received) throw new Error('The received message could not be captured.')
          break
        }
        const supported = await this.savePending(storage)
        const data = await storage.read(key)
        if (this.status.key === key) this.update({ data })
        if (!supported) throw new Error(unsupportedError)
        if (failed) throw requestError
      }
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : 'Could not sync messages.' })
    } finally {
      storage?.close()
      this.update({ syncing: false })
      if (!maintenance && this.status.key) await this.load(this.status.key)
    }
  }
}
