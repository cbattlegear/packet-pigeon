import {
  Command, CompanionError, Response, contactCount, decodeCapabilities, decodeChannel, decodeContact,
  decodeQueuedMessage, decodeSelf, messageWaiting,
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
  readonly phase: 'idle' | 'choosing' | 'opening' | 'handshake' | 'syncing' | 'ready' | 'closing' | 'error'
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
  messagesWaiting: boolean
  draining: boolean
}

const initial: CompanionSnapshot = {
  phase: 'idle', error: null, device: null, contacts: [], channels: [], messages: [], progress: null,
}

export class CompanionSession {
  private readonly events = new EventTarget()
  private readonly environment?: WebSerialEnvironment
  private readonly timeoutMs: number
  private snapshot = initial
  private attempt?: Attempt
  private cleanup = Promise.resolve()

  constructor(options: { environment?: WebSerialEnvironment; timeoutMs?: number } = {}) {
    this.environment = options.environment
    this.timeoutMs = options.timeoutMs ?? 5000
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
    this.attempt = undefined
    if (attempt.link) {
      this.cleanup = attempt.link.close().catch((cause) => {
        console.error('Could not release the USB serial port after a session error.', cause)
      })
    }
    this.update({ phase: 'error', error, progress: null })
  }

  readonly connect = async () => {
    if (this.attempt || this.snapshot.phase === 'closing') return
    const attempt: Attempt = { messagesWaiting: false, draining: false }
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
      attempt.opening = this.openPort(attempt, port)
      const link = await attempt.opening
      if (!link || this.attempt !== attempt) return
      this.update({ ...initial, phase: 'handshake' })
      await this.initialize(attempt, link)
    } catch (error) {
      this.fail(attempt, error instanceof CompanionError ? error : new CompanionError(
        'open-failed', 'Could not open the USB serial port. Check that it is not in use.', { cause: error },
      ))
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
      await port.close()
      return null
    }
    try {
      attempt.link = new SerialLink(port, this.timeoutMs,
        (frame) => this.onPush(attempt, frame), (error) => this.fail(attempt, error))
      return attempt.link
    } catch (error) {
      try {
        await port.close()
      } catch (closeError) {
        console.error('Could not release the USB serial port after opening.', closeError)
      }
      throw error
    }
  }

  readonly disconnect = async () => {
    if (this.snapshot.phase === 'closing') return
    const attempt = this.attempt
    this.attempt = undefined
    this.update({ phase: 'closing', progress: null, error: null })
    try {
      await (attempt?.link?.close() ?? attempt?.opening ?? this.cleanup)
      this.update({ phase: 'idle' })
    } catch (error) {
      this.update({
        phase: 'error',
        error: new CompanionError('serial-io', 'Could not close the USB serial port.', { cause: error }),
      })
    }
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
    await this.drainMessages(attempt, link)
    if (this.attempt === attempt) {
      this.update({ phase: 'ready' })
      if (attempt.messagesWaiting) this.startMessageSync(attempt)
    }
  }

  private onPush(attempt: Attempt, frame: Uint8Array) {
    if (this.attempt !== attempt) return
    const code = frame[0]
    this.events.dispatchEvent(new CustomEvent<CompanionPush>('push', { detail: { code, payload: frame.slice(1) } }))
    if (code !== messageWaiting) return
    attempt.messagesWaiting = true
    if (this.snapshot.phase === 'ready') this.startMessageSync(attempt)
  }

  private startMessageSync(attempt: Attempt) {
    if (this.attempt !== attempt || !attempt.link || attempt.draining) return
    void this.drainMessages(attempt, attempt.link).catch((error) => {
      this.fail(attempt, error instanceof CompanionError ? error :
        new CompanionError('protocol', 'Could not sync queued companion messages.', { cause: error }))
    })
  }

  private async drainMessages(attempt: Attempt, link: SerialLink) {
    attempt.draining = true
    let completed = 0
    this.update({ progress: { stage: 'messages', completed, total: null } })
    try {
      do {
        attempt.messagesWaiting = false
        while (this.attempt === attempt) {
          const receiptId = crypto.randomUUID()
          const message = await link.request(Uint8Array.of(Command.nextMessage), (frame) => {
            expectResponse(frame, Response.noMoreMessages, Response.directText, Response.directTextV3,
              Response.channelText, Response.channelTextV3, Response.channelData)
            return { value: frame[0] === Response.noMoreMessages ? null : decodeQueuedMessage(frame) }
          })
          if (this.attempt !== attempt || !message) break
          this.update({
            messages: [...this.snapshot.messages, { ...message, receiptId }],
            progress: { stage: 'messages', completed: ++completed, total: null },
          })
        }
      } while (this.attempt === attempt && attempt.messagesWaiting)
    } finally {
      attempt.draining = false
      if (this.attempt === attempt) this.update({ progress: null })
    }
  }
}
