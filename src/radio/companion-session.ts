import {
  Command, CompanionError, Response, contactCount, decodeCapabilities, decodeChannel, decodeContact,
  decodeSelf,
} from './protocol.ts'
import type { CompanionChannel, CompanionContact, CompanionDevice, CompanionMessage } from './protocol.ts'
import { expectResponse, SerialLink } from './serial-link.ts'
import { browserSerialEnvironment, choosePort } from './web-serial.ts'
import type { CompanionSerialPort, WebSerialEnvironment } from './web-serial.ts'

export interface SyncProgress {
  readonly stage: 'contacts' | 'channels' | 'messages'
  readonly completed: number
  readonly total: number | null
}

export interface CompanionSnapshot {
  readonly phase: 'idle' | 'choosing' | 'opening' | 'handshake' | 'syncing' | 'ready' | 'reconnecting' | 'closing' | 'error'
  readonly error: CompanionError | null
  readonly device: CompanionDevice | null
  readonly contacts: readonly CompanionContact[]
  readonly channels: readonly CompanionChannel[]
  readonly messages: readonly CompanionMessage[]
  readonly progress: SyncProgress | null
}

export interface CompanionPush {
  readonly code: number
  readonly payload: Uint8Array
}

interface Attempt {
  link?: SerialLink
  opening?: Promise<SerialLink | null>
  locking?: Promise<void>
  recovering?: boolean
}

interface LockProvider {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown | null) => Promise<void>): Promise<void>
}

const initial: CompanionSnapshot = {
  phase: 'idle', error: null, device: null, contacts: [], channels: [], messages: [], progress: null,
}

function cleanupError(cause: unknown) {
  return new CompanionError('cleanup-failed', 'Could not release the USB serial port. Reload this tab before reconnecting.', { cause })
}

export class CompanionSession {
  private readonly events = new EventTarget()
  private readonly environment?: WebSerialEnvironment
  private readonly timeoutMs: number
  private readonly locks?: LockProvider
  private readonly retryDelays: readonly number[]
  private snapshot = initial
  private attempt?: Attempt
  // Keep failed cleanup observable so a later disconnect cannot release ownership.
  private cleanup = Promise.resolve()
  private failure = Promise.resolve()
  private releaseOwnership?: () => void
  private ownership?: Promise<void>
  private generation = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private cancelDelay?: () => void
  private port?: CompanionSerialPort
  private expectedKey?: string

  constructor(options: { environment?: WebSerialEnvironment; timeoutMs?: number; locks?: LockProvider; retryDelays?: readonly number[] } = {}) {
    this.environment = options.environment
    this.timeoutMs = options.timeoutMs ?? 5000
    this.locks = options.locks ?? globalThis.navigator?.locks
    this.retryDelays = options.retryDelays ?? [1000, 2000, 4000, 8000, 16000]
  }

  readonly getSnapshot = (): CompanionSnapshot => this.snapshot

  readonly subscribe = (listener: () => void) => {
    this.events.addEventListener('change', listener)
    return () => this.events.removeEventListener('change', listener)
  }

  readonly subscribeToPushes = (listener: (push: CompanionPush) => void) => {
    const callback = (event: Event) => {
      if (event instanceof CustomEvent) listener(event.detail)
    }
    this.events.addEventListener('push', callback)
    return () => this.events.removeEventListener('push', callback)
  }

  private update(update: Partial<CompanionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update }
    this.events.dispatchEvent(new Event('change'))
  }

  private fail(attempt: Attempt, error: CompanionError) {
    if (this.attempt !== attempt) return
    if (attempt.recovering) return
    this.attempt = undefined
    if (attempt.link) {
      this.cleanup = attempt.link.close()
    }
    if (this.expectedKey && (error.code === 'disconnected' || error.code === 'serial-io')) {
      const generation = this.generation
      this.update({ phase: 'reconnecting', error, progress: null })
      void this.reconnect(generation)
    } else {
      this.failure = this.finishFailure(error, this.generation)
    }
  }

  private async finishFailure(error: CompanionError, generation: number) {
    try {
      await this.cleanup
      if (generation !== this.generation) return
      await this.releaseLock()
      if (generation === this.generation) this.update({ phase: 'error', error, progress: null })
    } catch (cause) {
      if (generation === this.generation) this.update({
        phase: 'error', progress: null,
        error: cleanupError(cause),
      })
    }
  }

  private async acquireLock() {
    if (!this.locks) throw new CompanionError('ownership', 'This browser cannot safely coordinate USB access between tabs.')
    let resolveAcquired: (acquired: boolean) => void = () => {}
    const acquired = new Promise<boolean>((resolve) => { resolveAcquired = resolve })
    this.ownership = this.locks.request('packet-pigeon-usb-session', { ifAvailable: true }, async (lock) => {
      resolveAcquired(lock !== null)
      if (lock !== null) await new Promise<void>((resolve) => { this.releaseOwnership = resolve })
    })
    void this.ownership.catch(() => resolveAcquired(false))
    if (!await acquired) {
      try {
        await this.ownership
      } catch (cause) {
        this.ownership = undefined
        throw new CompanionError('ownership', 'Could not coordinate USB access between tabs.', { cause })
      }
      this.ownership = undefined
      throw new CompanionError('ownership', 'Another tab owns the USB session, or USB ownership is unavailable.')
    }
  }

  private async releaseLock() {
    this.releaseOwnership?.()
    this.releaseOwnership = undefined
    await this.ownership
    this.ownership = undefined
  }

  readonly connect = async () => {
    if (this.attempt || this.ownership || this.snapshot.phase === 'closing' || this.snapshot.phase === 'reconnecting') return
    const generation = ++this.generation
    const attempt: Attempt = {}
    this.attempt = attempt
    this.update({ phase: 'choosing', error: null, progress: null })

    try {
      const port = await choosePort(this.environment ?? browserSerialEnvironment())
      if (this.attempt !== attempt) return
      if (!port) {
        this.attempt = undefined
        this.update({ phase: 'idle' })
        return
      }

      this.update({ phase: 'opening' })
      await this.cleanup
      if (this.attempt !== attempt) return
      attempt.locking = this.acquireLock()
      await attempt.locking
      if (this.attempt !== attempt) return
      this.port = port
      this.expectedKey = undefined
      attempt.opening = this.openPort(attempt, port)
      const link = await attempt.opening
      if (!link || this.attempt !== attempt) return
      this.update({ ...initial, phase: 'handshake' })
      await this.initialize(attempt, link)
      if (this.attempt !== attempt) await this.failure
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(attempt, error instanceof CompanionError ? error : new CompanionError(
        'open-failed', 'Could not open the USB serial port. Check that it is not in use.', { cause: error },
      ))
      await this.failure
    }
  }

  private async openPort(attempt: Attempt, port: CompanionSerialPort) {
    try {
      await port.open({ baudRate: 115200 })
    } catch (error) {
      if (this.attempt !== attempt) return null
      throw error
    }
    if (this.attempt !== attempt) {
      await this.closePort(port)
      return null
    }
    try {
      attempt.link = new SerialLink(port, this.timeoutMs,
        (frame) => this.onPush(attempt, frame), (error) => this.fail(attempt, error))
      return attempt.link
    } catch (error) {
      await this.closePort(port)
      if (this.attempt !== attempt) return null
      throw error
    }
  }

  private closePort(port: CompanionSerialPort) {
    this.cleanup = Promise.resolve().then(() => port.close())
    return this.cleanup
  }

  readonly disconnect = async () => {
    if (this.snapshot.phase === 'closing') return
    ++this.generation
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.cancelDelay?.()
    this.cancelDelay = undefined
    const attempt = this.attempt
    this.attempt = undefined
    this.expectedKey = undefined
    this.port = undefined
    this.update({ phase: 'closing', progress: null, error: null })
    try {
      if (attempt?.locking) await attempt.locking.catch(() => {})
      if (attempt?.link) this.cleanup = attempt.link.close()
      else if (attempt?.opening) await attempt.opening
      await this.cleanup
      await this.releaseLock()
      this.update({ phase: 'idle' })
    } catch (error) {
      this.update({
        phase: 'error',
        error: cleanupError(error),
      })
    }
  }

  readonly nextQueuedMessage = async (publicKey: string): Promise<Uint8Array | null> => {
    const link = this.attempt?.link
    if (this.snapshot.phase !== 'ready' || !link || this.snapshot.device?.publicKey !== publicKey) {
      throw new CompanionError('disconnected', 'Connect the selected radio before syncing messages.')
    }
    return link.request(Uint8Array.of(Command.nextMessage), (frame) => {
      return { value: frame[0] === Response.noMoreMessages && frame.length === 1 ? null : frame.slice() }
    })
  }

  private async initialize(attempt: Attempt, link: SerialLink) {
    const capabilities = await link.request(Uint8Array.of(Command.deviceQuery, 3), (frame) => {
      expectResponse(frame, Response.deviceInfo)
      return { value: decodeCapabilities(frame) }
    })
    const appName = new TextEncoder().encode('Packet Pigeon')
    const start = new Uint8Array(8 + appName.length)
    start[0] = Command.appStart
    start.set(appName, 8)
    const device = await link.request(start, (frame) => {
      expectResponse(frame, Response.selfInfo)
      return { value: decodeSelf(frame, capabilities) }
    })
    if (this.attempt !== attempt) return
    if (this.expectedKey && device.publicKey !== this.expectedKey) {
      throw new CompanionError('identity', 'The reconnected port belongs to a different radio. Use Connect USB to choose the correct device.')
    }
    this.expectedKey = device.publicKey
    this.update({ device, phase: 'syncing', progress: { stage: 'contacts', completed: 0, total: null } })

    const contacts: CompanionContact[] = []
    let total: number | null = null
    await link.request(Uint8Array.of(Command.contacts), (frame) => {
      if (total === null) {
        expectResponse(frame, Response.contactsStart)
        total = contactCount(frame)
      } else {
        expectResponse(frame, Response.contact, Response.contactsEnd)
        if (frame[0] === Response.contactsEnd) return { value: undefined }
        contacts.push(decodeContact(frame))
      }
      this.update({ progress: { stage: 'contacts', completed: contacts.length, total } })
    })
    if (this.attempt !== attempt) return
    const slots = capabilities.maxChannels
    this.update({ contacts, progress: { stage: 'channels', completed: 0, total: slots } })
    const channels: CompanionChannel[] = []
    for (let index = 0; index < slots; index++) {
      const channel = await link.request(Uint8Array.of(Command.channel, index), (frame) => {
        if (frame[0] === Response.error && frame[1] === 2) return { value: null }
        expectResponse(frame, Response.channelInfo)
        return { value: decodeChannel(frame, index) }
      })
      if (this.attempt !== attempt) return
      if (channel?.name) channels.push(channel)
      this.update({ progress: { stage: 'channels', completed: index + 1, total: slots } })
    }
    if (this.attempt !== attempt) return
    this.update({ channels })
    this.update({ phase: 'ready', progress: null })
  }

  private async reconnect(generation: number) {
    let lastError = this.snapshot.error
    try {
      await this.cleanup
      for (const delay of this.retryDelays) {
        if (generation !== this.generation) return
        await new Promise<void>((resolve) => {
          this.cancelDelay = resolve
          this.retryTimer = setTimeout(resolve, delay)
        })
        this.cancelDelay = undefined
        this.retryTimer = undefined
        if (generation !== this.generation) return
        const serial = (this.environment ?? browserSerialEnvironment()).serial
        if (!serial?.getPorts || !this.port?.getInfo) {
          throw new CompanionError('reconnect-failed', 'Automatic reconnection is unavailable. Use Connect USB to reconnect.')
        }
        let ports: CompanionSerialPort[]
        try {
          ports = await serial.getPorts()
        } catch (cause) {
          throw new CompanionError('reconnect-failed', 'Could not list authorized USB ports. Check browser permissions and use Connect USB.', { cause })
        }
        if (generation !== this.generation) return
        const info = this.port.getInfo()
        const matches = ports.filter((candidate) => {
          const other = candidate.getInfo?.()
          return info.usbVendorId !== undefined && info.usbProductId !== undefined &&
            other?.usbVendorId === info.usbVendorId && other.usbProductId === info.usbProductId
        })
        const port = ports.includes(this.port) ? this.port : matches.length === 1 ? matches[0] : undefined
        if (!port) {
          if (matches.length > 1) throw new CompanionError('identity', 'Multiple matching USB ports are available. Use Connect USB to choose the correct radio.')
          continue
        }
        const attempt: Attempt = { recovering: true }
        this.attempt = attempt
        try {
          attempt.opening = this.openPort(attempt, port)
          const link = await attempt.opening
          if (!link || generation !== this.generation) return
          this.update({ ...initial, phase: 'handshake' })
          await this.initialize(attempt, link)
          if (generation !== this.generation) return
          if (this.attempt === attempt && this.snapshot.phase === 'ready') {
            attempt.recovering = false
            this.port = port
            return
          }
        } catch (error) {
          if (generation !== this.generation) return
          if (this.attempt !== attempt) return
          this.attempt = undefined
          if (attempt.link) this.cleanup = attempt.link.close()
          await this.cleanup
          if (error instanceof CompanionError && error.code === 'identity') throw error
          lastError = error instanceof CompanionError ? error : new CompanionError('open-failed', 'Could not reopen the USB serial port.', { cause: error })
          this.update({ phase: 'reconnecting', error: lastError, progress: null })
        }
      }
      throw new CompanionError('reconnect-failed', 'Automatic reconnection stopped after several attempts. Use Connect USB to retry.', { cause: lastError })
    } catch (error) {
      if (generation !== this.generation) return
      await this.finishFailure(error instanceof CompanionError ? error : new CompanionError(
        'serial-io', 'Could not release or reconnect the USB serial port. Reload this tab before reconnecting.', { cause: error },
      ), generation)
    }
  }

  private onPush(attempt: Attempt, frame: Uint8Array) {
    if (this.attempt !== attempt) return
    const code = frame[0]
    this.events.dispatchEvent(new CustomEvent<CompanionPush>('push', { detail: { code, payload: frame.slice(1) } }))
  }
}
