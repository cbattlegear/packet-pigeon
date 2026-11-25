import {
  Command, CompanionError, Response, contactCount, decodeCapabilities, decodeChannel, decodeContact,
  decodeSelf,
} from './protocol.ts'
import type { CompanionChannel, CompanionContact, CompanionDevice, CompanionMessage } from './protocol.ts'
import { expectResponse, SerialLink } from './serial-link.ts'
import type { CompanionLinkPort } from './serial-link.ts'
import { browserSerialEnvironment, choosePort } from './web-serial.ts'
import type { CompanionSerialPort, WebSerialEnvironment } from './web-serial.ts'
import { addContactCommand, contactPublicKey, removeContactCommand, writeContactCommand } from './contact-commands.ts'
import type { NewContact } from './contact-commands.ts'
import { decodeDirectSent, directMessageCommand, resetPathCommand } from './direct-message.ts'
import type { DirectSendReceipt } from './direct-message.ts'
import { browserBluetoothEnvironment, chooseBluetoothDevice, openBluetoothPort } from './web-bluetooth.ts'
import type { CompanionBluetoothDevice, WebBluetoothEnvironment } from './web-bluetooth.ts'
import { readAdvertPath, readAutoAddPolicy, writeAutoAddPolicy } from './discovery-commands.ts'
import type { AutoAddPolicy } from './discovery-commands.ts'

export interface SyncProgress {
  readonly stage: 'contacts' | 'channels' | 'messages'
  readonly completed: number
  readonly total: number | null
}

export interface CompanionSnapshot {
  readonly phase: 'idle' | 'choosing' | 'opening' | 'handshake' | 'syncing' | 'ready' | 'reconnecting' | 'closing' | 'error'
  readonly transport: 'usb' | 'bluetooth' | null
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

export interface QueuedMessageLease {
  /** Keep the lease until any received frame has been durably saved. */
  request(receive: (frame: Uint8Array) => void): Promise<boolean>
  release(): void
}

interface Attempt {
  link?: SerialLink
  opening?: Promise<SerialLink | null>
  locking?: Promise<void>
  recovering?: boolean
}

type SelectedTransport =
  | { kind: 'usb'; device: CompanionSerialPort }
  | { kind: 'bluetooth'; device: CompanionBluetoothDevice }

interface LockProvider {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown | null) => Promise<void>): Promise<void>
}

const initial: CompanionSnapshot = {
  phase: 'idle', transport: null, error: null, device: null, contacts: [], channels: [], messages: [], progress: null,
}

function cleanupError(cause: unknown) {
  return new CompanionError('cleanup-failed', 'Could not release the radio connection. Reload this tab before reconnecting.', { cause })
}

export class CompanionSession {
  private readonly events = new EventTarget()
  private readonly environment?: WebSerialEnvironment
  private readonly bluetoothEnvironment?: WebBluetoothEnvironment
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
  private readonly receiptHolds = new Set<symbol>()
  private readonly receiptWaiters = new Set<() => void>()
  private generation = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private cancelDelay?: () => void
  private connection?: SelectedTransport
  private expectedKey?: string
  private contactWritePending = false
  private directCommandPending = false

  constructor(options: {
    environment?: WebSerialEnvironment
    bluetoothEnvironment?: WebBluetoothEnvironment
    timeoutMs?: number
    locks?: LockProvider
    retryDelays?: readonly number[]
  } = {}) {
    this.environment = options.environment
    this.bluetoothEnvironment = options.bluetoothEnvironment
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
    if (!this.locks) throw new CompanionError('ownership', 'This browser cannot safely coordinate radio access between tabs.')
    let resolveAcquired: (acquired: boolean) => void = () => {}
    const acquired = new Promise<boolean>((resolve) => { resolveAcquired = resolve })
    // Use the same ownership lock as existing USB-only tabs.
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
        throw new CompanionError('ownership', 'Could not coordinate radio access between tabs.', { cause })
      }
      this.ownership = undefined
      throw new CompanionError('ownership', 'Another tab owns the radio session, or radio ownership is unavailable.')
    }
  }

  private async releaseLock() {
    if (this.receiptHolds.size) {
      await new Promise<void>((resolve) => this.receiptWaiters.add(resolve))
    }
    this.releaseOwnership?.()
    this.releaseOwnership = undefined
    await this.ownership
    this.ownership = undefined
  }

  readonly connect = () => this.connectUsing(async () => {
    const device = await choosePort(this.environment ?? browserSerialEnvironment())
    return device ? { kind: 'usb', device } : null
  })

  readonly connectBluetooth = () => this.connectUsing(async () => {
    const device = await chooseBluetoothDevice(this.bluetoothEnvironment ?? browserBluetoothEnvironment())
    return device ? { kind: 'bluetooth', device } : null
  })

  private async connectUsing(choose: () => Promise<SelectedTransport | null>) {
    if (this.attempt || this.ownership || this.snapshot.phase === 'closing' || this.snapshot.phase === 'reconnecting') return
    const generation = ++this.generation
    const attempt: Attempt = {}
    this.attempt = attempt
    this.update({ phase: 'choosing', transport: null, error: null, progress: null })

    try {
      const connection = await choose()
      if (this.attempt !== attempt) return
      if (!connection) {
        this.attempt = undefined
        this.update({ phase: 'idle' })
        return
      }

      this.update({ phase: 'opening', transport: connection.kind })
      await this.cleanup
      if (this.attempt !== attempt) return
      attempt.locking = this.acquireLock()
      await attempt.locking
      if (this.attempt !== attempt) return
      this.connection = connection
      this.expectedKey = undefined
      attempt.opening = this.openConnection(attempt, connection)
      const link = await attempt.opening
      if (!link || this.attempt !== attempt) return
      this.update({ ...initial, phase: 'handshake', transport: connection.kind })
      await this.initialize(attempt, link)
      if (this.attempt !== attempt) await this.failure
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(attempt, error instanceof CompanionError ? error : new CompanionError(
        'open-failed', 'Could not open the radio connection. Check that it is not in use.', { cause: error },
      ))
      await this.failure
    }
  }

  private async openConnection(attempt: Attempt, connection: SelectedTransport) {
    let port: CompanionLinkPort
    try {
      if (connection.kind === 'usb') {
        await connection.device.open({ baudRate: 115200 })
        port = connection.device
      } else {
        port = await openBluetoothPort(connection.device)
      }
    } catch (error) {
      if (error instanceof CompanionError && error.code === 'cleanup-failed') {
        this.cleanup = Promise.reject(error)
        void this.cleanup.catch(() => {})
      }
      if (this.attempt !== attempt) return null
      throw error
    }
    if (this.attempt !== attempt) {
      await this.closePort(port)
      return null
    }
    try {
      attempt.link = new SerialLink(port, this.timeoutMs,
        (frame) => this.onPush(attempt, frame), (error) => this.fail(attempt, error), connection.kind)
      return attempt.link
    } catch (error) {
      await this.closePort(port)
      if (this.attempt !== attempt) return null
      throw error
    }
  }

  private closePort(port: CompanionLinkPort) {
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
    this.connection = undefined
    this.update({ phase: 'closing', progress: null, error: null })
    try {
      if (attempt?.locking) await attempt.locking.catch(() => {})
      if (attempt?.link) this.cleanup = attempt.link.close()
      else if (attempt?.opening) await attempt.opening
      await this.cleanup
      await this.releaseLock()
      this.update({ phase: 'idle', transport: null })
    } catch (error) {
      this.update({
        phase: 'error',
        error: cleanupError(error),
      })
    }
  }

  readonly reserveQueuedMessage = (publicKey: string): QueuedMessageLease => {
    const link = this.attempt?.link
    if (this.snapshot.phase !== 'ready' || !link || this.snapshot.device?.publicKey !== publicKey) {
      throw new CompanionError('disconnected', 'Connect the selected radio before syncing messages.')
    }
    if (this.receiptHolds.size) {
      throw new CompanionError('protocol', 'Save the previous received message before requesting another.')
    }
    if (this.contactWritePending) {
      throw new CompanionError('protocol', 'Wait for the contact change to finish before syncing messages.')
    }
    if (this.directCommandPending) {
      throw new CompanionError('protocol', 'Wait for the direct-message command to finish before syncing messages.')
    }
    const hold = Symbol()
    this.receiptHolds.add(hold)
    let used = false
    let released = false
    let requesting = false
    const finishRelease = () => {
      this.receiptHolds.delete(hold)
      if (this.receiptHolds.size === 0) {
        for (const resolve of this.receiptWaiters) resolve()
        this.receiptWaiters.clear()
      }
    }
    return {
      request: async (receive) => {
        if (used || released) throw new CompanionError('protocol', 'This message request is no longer available.')
        used = true
        if (this.attempt?.link !== link || this.snapshot.phase !== 'ready' || this.snapshot.device?.publicKey !== publicKey) {
          throw new CompanionError('disconnected', 'Connect the selected radio before syncing messages.')
        }
        requesting = true
        try {
          return await link.request(Uint8Array.of(Command.nextMessage), (frame) => {
            if (frame[0] === Response.noMoreMessages && frame.length === 1) return { value: false }
            receive(frame.slice())
            return { value: true }
          })
        } finally {
          requesting = false
          if (released) finishRelease()
        }
      },
      release: () => {
        if (released) return
        released = true
        if (!requesting) finishRelease()
      },
    }
  }

  private async runRadioCommand<T>(
    radioKey: string,
    run: (link: SerialLink) => Promise<T>,
  ) {
    const attempt = this.attempt
    if (
      !attempt?.link || this.snapshot.phase !== 'ready'
      || this.snapshot.device?.publicKey !== radioKey
    ) throw new Error('Connect the selected radio and wait for it to finish syncing.')
    if (this.contactWritePending) throw new Error('A radio action is already in progress.')
    if (this.directCommandPending) throw new Error('Wait for the direct-message command to finish before changing contacts or discovery.')
    if (this.receiptHolds.size) throw new Error('Finish message sync or save the pending receipt before changing contacts or discovery.')

    this.contactWritePending = true
    try {
      const result = await run(attempt.link)
      if (this.attempt !== attempt) {
        throw new Error('The radio disconnected. Reconnect and check its state before retrying.')
      }
      return result
    } finally {
      this.contactWritePending = false
    }
  }

  private async changeContacts(radioKey: string, write: (link: SerialLink) => Promise<readonly CompanionContact[]>) {
    await this.runRadioCommand(radioKey, async (link) => {
      const contacts = await write(link)
      if (this.attempt?.link === link) this.update({ contacts })
    })
  }

  readonly refreshContacts = (radioKey: string) => this.changeContacts(radioKey, (link) => this.readContacts(link))

  readonly advertPath = (radioKey: string, contactKey: string) => (
    this.runRadioCommand(radioKey, (link) => {
      if (this.connection?.kind !== 'usb') {
        throw new CompanionError('unsupported-transport', 'Connect over USB to read an advert path from the radio.')
      }
      return readAdvertPath(link, contactKey)
    })
  )

  readonly getAutoAdd = (radioKey: string) => (
    this.runRadioCommand(radioKey, (link) => readAutoAddPolicy(link, this.snapshot.device!.contactMode))
  )

  readonly setAutoAdd = (radioKey: string, policy: AutoAddPolicy) => (
    this.runRadioCommand(radioKey, async (link) => {
      const current = this.snapshot.device!
      const result = await writeAutoAddPolicy(link, policy, current.contactMode)
      if (this.attempt?.link === link) this.update({ device: { ...current, contactMode: result.mode } })
      return result.policy
    })
  )
  private async readContacts(link: SerialLink, progress?: (status: SyncProgress) => void) {
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
      progress?.({ stage: 'contacts', completed: contacts.length, total })
    })
    return contacts
  }

  readonly addContact = async (radioKey: string, input: NewContact) => {
    const { command, contact } = addContactCommand(input)
    await this.changeContacts(radioKey, async (link) => {
      if (contact.publicKey === radioKey) throw new Error('A radio cannot add itself as a contact.')
      if (this.snapshot.contacts.some(({ publicKey }) => publicKey === contact.publicKey)) {
        throw new Error('This contact already exists on the radio.')
      }
      // The firmware's add command can also overwrite a contact. Recheck the
      // current device table because it may have changed since initial sync.
      const contacts = await this.readContacts(link)
      if (this.attempt?.link !== link || this.snapshot.phase !== 'ready') {
        throw new Error('The radio disconnected before the contact could be added.')
      }
      if (contacts.some(({ publicKey }) => publicKey === contact.publicKey)) {
        this.update({ contacts })
        throw new Error('This contact already exists on the radio.')
      }
      const capacity = this.snapshot.device?.capabilities.maxContacts ?? 0
      if (capacity > 0 && contacts.length >= capacity) throw new Error('Radio contact storage is full.')
      await writeContactCommand(link, command)
      return [...contacts, contact]
    })
  }

  readonly removeContact = async (radioKey: string, publicKey: string) => {
    const key = contactPublicKey(publicKey)
    await this.changeContacts(radioKey, async (link) => {
      await writeContactCommand(link, removeContactCommand(key))
      return this.snapshot.contacts.filter((contact) => contact.publicKey !== key)
    })
  }

  private async withDirectContact<T>(
    radioKey: string,
    recipient: string,
    command: (link: SerialLink) => Promise<T>,
    signal?: AbortSignal,
  ) {
    const key = contactPublicKey(recipient)
    const attempt = this.attempt
    const link = attempt?.link
    if (!link || this.snapshot.phase !== 'ready' || this.snapshot.device?.publicKey !== radioKey) {
      throw new Error('Connect the selected radio before sending messages.')
    }
    if (this.receiptHolds.size) throw new Error('Finish message sync or save the pending receipt before sending.')
    if (this.contactWritePending || this.directCommandPending) throw new Error('Another radio command is in progress.')
    if (signal?.aborted) throw new Error('The direct-message command was cancelled before transmission.')
    this.directCommandPending = true
    try {
      const contacts = await this.readContacts(link)
      if (this.attempt !== attempt || this.snapshot.phase !== 'ready' || this.snapshot.device?.publicKey !== radioKey) {
        throw new Error('The radio disconnected before the message command could be sent.')
      }
      this.update({ contacts })
      const matches = contacts.filter((contact) => contact.publicKey.slice(0, 12) === key.slice(0, 12))
      if (matches.length !== 1 || matches[0].publicKey !== key) {
        throw new Error('The destination is missing or its six-byte key prefix is ambiguous on the radio.')
      }
      if (matches[0].type !== 1 && matches[0].type !== 3) {
        throw new Error('Direct messages require a companion or room contact.')
      }
      if (signal?.aborted) throw new Error('The direct-message command was cancelled before transmission.')
      return await command(link)
    } finally {
      this.directCommandPending = false
    }
  }

  readonly sendDirect = async (
    radioKey: string, recipient: string, timestamp: number, attempt: number, text: string, signal?: AbortSignal,
  ) => {
    const command = directMessageCommand(recipient, timestamp, attempt, text)
    return this.withDirectContact(radioKey, recipient, async (link) => {
      const result = await link.request<{ error: Uint8Array } | { receipt: DirectSendReceipt }>(command, (frame) => {
        if (frame[0] === Response.error || frame[0] === Response.disabled) return { value: { error: frame } }
        return { value: { receipt: decodeDirectSent(frame) } }
      })
      if ('error' in result) {
        const detail = result.error.length > 1 ? ` (device error ${result.error[1]})` : ''
        throw new CompanionError('device-error', `The radio rejected the message${detail}.`)
      }
      return result.receipt
    }, signal)
  }

  readonly resetDirectPath = async (radioKey: string, recipient: string, signal?: AbortSignal) => {
    const command = resetPathCommand(recipient)
    return this.withDirectContact(radioKey, recipient, async (link) => {
      const frame = await link.request(command, (response) => {
        if (response[0] !== Response.error && response[0] !== Response.disabled) expectResponse(response, Response.ok)
        return { value: response }
      })
      if (frame[0] !== Response.ok) {
        throw new CompanionError('device-error', 'The radio could not clear the contact route for flood retries.')
      }
      this.update({
        contacts: this.snapshot.contacts.map((contact) => contact.publicKey === recipient
          ? { ...contact, pathLength: 0xff } : contact),
      })
    }, signal)
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
      throw new CompanionError('identity', 'The reconnected device belongs to a different radio. Use a connection button to choose the correct device.')
    }
    this.expectedKey = device.publicKey
    this.update({ device, phase: 'syncing', progress: { stage: 'contacts', completed: 0, total: null } })

    const contacts = await this.readContacts(link, (progress) => this.update({ progress }))
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

  private async reconnectConnection(): Promise<SelectedTransport | undefined> {
    const current = this.connection
    if (current?.kind === 'bluetooth') return current
    const serial = (this.environment ?? browserSerialEnvironment()).serial
    if (!serial?.getPorts || !current?.device.getInfo) {
      throw new CompanionError('reconnect-failed', 'Automatic reconnection is unavailable. Use Connect USB to reconnect.')
    }
    let ports: CompanionSerialPort[]
    try {
      ports = await serial.getPorts()
    } catch (cause) {
      throw new CompanionError('reconnect-failed', 'Could not list authorized USB ports. Check browser permissions and use Connect USB.', { cause })
    }
    if (ports.includes(current.device)) return current
    const info = current.device.getInfo()
    const matches = ports.filter((candidate) => {
      const other = candidate.getInfo?.()
      return info.usbVendorId !== undefined && info.usbProductId !== undefined
        && other?.usbVendorId === info.usbVendorId && other.usbProductId === info.usbProductId
    })
    if (matches.length > 1) {
      throw new CompanionError('identity', 'Multiple matching USB ports are available. Use Connect USB to choose the correct radio.')
    }
    return matches[0] ? { kind: 'usb', device: matches[0] } : undefined
  }

  private async reconnect(generation: number) {
    let lastError = this.snapshot.error
    const action = this.connection?.kind === 'bluetooth' ? 'Connect Bluetooth' : 'Connect USB'
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
        const connection = await this.reconnectConnection()
        if (generation !== this.generation) return
        if (!connection) continue
        const attempt: Attempt = { recovering: true }
        this.attempt = attempt
        try {
          attempt.opening = this.openConnection(attempt, connection)
          const link = await attempt.opening
          if (!link || generation !== this.generation) return
          this.update({ ...initial, phase: 'handshake', transport: connection.kind })
          await this.initialize(attempt, link)
          if (generation !== this.generation) return
          if (this.attempt === attempt && this.snapshot.phase === 'ready') {
            attempt.recovering = false
            this.connection = connection
            return
          }
        } catch (error) {
          if (generation !== this.generation) return
          if (this.attempt !== attempt) return
          this.attempt = undefined
          if (attempt.link) this.cleanup = attempt.link.close()
          await this.cleanup
          if (error instanceof CompanionError && error.code === 'identity') throw error
          lastError = error instanceof CompanionError ? error : new CompanionError('open-failed', 'Could not reopen the radio connection.', { cause: error })
          this.update({ phase: 'reconnecting', error: lastError, progress: null })
        }
      }
      throw new CompanionError('reconnect-failed', `Automatic reconnection stopped after several attempts. Use ${action} to retry.`, { cause: lastError })
    } catch (error) {
      if (generation !== this.generation) return
      await this.finishFailure(error instanceof CompanionError ? error : new CompanionError(
        'serial-io', 'Could not release or reconnect the radio. Reload this tab before reconnecting.', { cause: error },
      ), generation)
    }
  }

  private onPush(attempt: Attempt, frame: Uint8Array) {
    if (this.attempt !== attempt) return
    const code = frame[0]
    this.events.dispatchEvent(new CustomEvent<CompanionPush>('push', { detail: { code, payload: frame.slice(1) } }))
  }
}
