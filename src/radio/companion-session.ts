import {
  Command, CompanionError, Response, contactCount, decodeCapabilities, decodeChannel, decodeContact,
  decodeSelf,
} from './protocol.ts'
import type { CompanionChannel, CompanionContact, CompanionDevice, CompanionMessage, RadioParameters } from './protocol.ts'
import { expectResponse, SerialLink } from './serial-link.ts'
import type { CompanionLinkPort } from './serial-link.ts'
import { browserSerialEnvironment, choosePort } from './web-serial.ts'
import type { CompanionSerialPort, WebSerialEnvironment } from './web-serial.ts'
import { addContactCommand, contactPathUpdate, contactPermissionsUpdate, contactPublicKey,
  readContactForEdit, readContactFrame, removeContactCommand, writeContactCommand } from './contact-commands.ts'
import type { ContactPermissions, NewContact } from './contact-commands.ts'
import type { ContactPathWidth } from './contact-path.ts'
import { contactPingWidth, parseTracePath, sendContactPing, sendPathTrace } from './contact-ping.ts'
import type { PingHashWidth, TraceHashWidth } from './contact-ping.ts'
import { decodeDirectSent, directMessageCommand, resetPathCommand } from './direct-message.ts'
import type { DirectSendReceipt } from './direct-message.ts'
import { browserBluetoothEnvironment, chooseBluetoothDevice, openBluetoothPort } from './web-bluetooth.ts'
import type { CompanionBluetoothDevice, WebBluetoothEnvironment } from './web-bluetooth.ts'
import { readAdvertPath, readAutoAddPolicy, writeAutoAddPolicy } from './discovery-commands.ts'
import type { AutoAddPolicy } from './discovery-commands.ts'
import { channelName, makeChannelSecret, readChannelSlot, secretHex, writeChannelSlot } from './channel-commands.ts'
import { channelMessageCommand } from './channel-message.ts'
import { writeSetupPathWidth, writeSetupRadioSettings } from './setup-commands.ts'
import { assertScopeSupported, channelScopeCommand, validateChannelScope, writeChannelScope } from './channel-scope.ts'
import type { ChannelScope } from './channel-scope.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'

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
  scopePending?: boolean
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

function scopeRecoveryError(cause: unknown) {
  return new CompanionError('scope-recovery',
    'Scope recovery could not finish. The radio may retain a temporary override. Check browser storage and reconnect to retry before using the radio.', { cause })
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
  private readonly openScopeStorage: typeof openRadioStorage
  private scopeTail: Promise<void> = Promise.resolve()

  constructor(options: {
    environment?: WebSerialEnvironment
    bluetoothEnvironment?: WebBluetoothEnvironment
    timeoutMs?: number
    locks?: LockProvider
    retryDelays?: readonly number[]
    openScopeStorage?: typeof openRadioStorage
  } = {}) {
    this.environment = options.environment
    this.bluetoothEnvironment = options.bluetoothEnvironment
    this.timeoutMs = options.timeoutMs ?? 5000
    this.locks = options.locks ?? globalThis.navigator?.locks
    this.retryDelays = options.retryDelays ?? [1000, 2000, 4000, 8000, 16000]
    this.openScopeStorage = options.openScopeStorage ?? openRadioStorage
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
    const scopePending = attempt.scopePending
    if (scopePending) error = scopeRecoveryError(error)
    this.attempt = undefined
    if (attempt.link) {
      this.cleanup = attempt.link.close()
    }
    if (this.expectedKey && (error.code === 'disconnected' || error.code === 'serial-io')) {
      const generation = this.generation
      this.update({ phase: 'reconnecting', error, progress: null })
      void this.reconnect(generation)
    } else {
      if (scopePending) this.update({ phase: 'closing', error, progress: null })
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
    // A delayed marker write must finish before another tab can own the radio.
    await this.scopeTail
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
    if (this.directCommandPending) throw new Error('Wait for the direct-message command to finish before another radio action.')
    if (this.receiptHolds.size) throw new Error('Finish message sync or save the pending receipt before another radio action.')

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

  private async editContact(radioKey: string, contactKey: string, edit: (frame: Uint8Array) => Uint8Array) {
    const key = contactPublicKey(contactKey)
    let clockAdvanced = false
    await this.changeContacts(radioKey, async (link) => {
      if (this.snapshot.transport !== 'usb') throw new Error('Connect over USB to edit radio paths or permissions.')
      const { frame, since } = await readContactForEdit(link, key)
      if (this.attempt?.link !== link || this.snapshot.phase !== 'ready') throw new Error('The radio disconnected before the edit.')
      await writeContactCommand(link, edit(frame))
      const changed = decodeContact(await readContactFrame(link, key))
      clockAdvanced = changed.lastModifiedAt > since
      return this.snapshot.contacts.some(({ publicKey }) => publicKey === key)
        ? this.snapshot.contacts.map((contact) => contact.publicKey === key ? changed : contact)
        : [...this.snapshot.contacts, changed]
    })
    if (!clockAdvanced) throw new Error('The radio saved the contact, but its clock changed during the edit. Check the radio clock before retrying.')
  }

  readonly saveContactPath = (radioKey: string, contactKey: string, width: ContactPathWidth, text: string) =>
    this.editContact(radioKey, contactKey, (frame) => {
      if (width > 1 && (this.snapshot.device?.capabilities.firmwareProtocolVersion ?? 0) < 10) {
        throw new Error('This firmware supports only one-byte contact path hashes.')
      }
      return contactPathUpdate(frame, { width, text })
    })

  readonly resetContactPath = (radioKey: string, contactKey: string) =>
    this.editContact(radioKey, contactKey, (frame) => contactPathUpdate(frame, null))

  readonly saveContactPermissions = (radioKey: string, contactKey: string, permissions: ContactPermissions) =>
    this.editContact(radioKey, contactKey, (frame) => {
      const version = this.snapshot.device?.capabilities.firmwareProtocolVersion ?? 0
      if (version < 5 || (permissions.remoteCli !== undefined && version < 14)) {
        throw new Error('This firmware does not support these contact permissions.')
      }
      return contactPermissionsUpdate(frame, permissions)
    })

  readonly pingContact = async (radioKey: string, contactKey: string, width: PingHashWidth, signal: AbortSignal) => {
    const key = contactPublicKey(contactKey)
    signal.throwIfAborted()
    return this.runRadioCommand(radioKey, async (link) => {
      const version = this.snapshot.device?.capabilities.firmwareProtocolVersion ?? 0
      if (!contactPingWidth(version, width)) throw new Error('This firmware does not support that ping hash width.')
      const abort = new AbortController()
      const stopWatching = this.subscribe(() => {
        if (this.attempt?.link !== link || this.snapshot.phase !== 'ready') {
          abort.abort(new Error('The radio disconnected while waiting for the ping.'))
        }
      })
      const request = AbortSignal.any([signal, abort.signal])
      try {
        const contacts = await this.readContacts(link)
        request.throwIfAborted()
        const matches = contacts.filter(({ publicKey }) => publicKey.startsWith(key.slice(0, width * 2)))
        const target = matches.find(({ publicKey }) => publicKey === key)
        if (!target || (target.type !== 2 && target.type !== 3)) {
          throw new Error('Ping requires a saved repeater or room server contact.')
        }
        if (matches.length > 1 || radioKey.startsWith(key.slice(0, width * 2))) {
          throw new Error('This prefix matches more than one known radio. Choose a wider ping hash.')
        }
        return await sendContactPing(link, key, width, this.subscribeToPushes, request)
      } finally {
        stopWatching()
      }
    })
  }

  readonly tracePath = async (radioKey: string, text: string, width: TraceHashWidth, signal: AbortSignal) => {
    const hashes = parseTracePath(text, width)
    signal.throwIfAborted()
    return this.runRadioCommand(radioKey, async (link) => {
      if (this.snapshot.transport !== 'usb') throw new Error('Connect over USB to trace a multi-hop path.')
      const version = this.snapshot.device?.capabilities.firmwareProtocolVersion ?? 0
      if (!contactPingWidth(version, width)) throw new Error('This firmware does not support that trace hash width.')
      const abort = new AbortController()
      const stopWatching = this.subscribe(() => {
        if (this.attempt?.link !== link || this.snapshot.phase !== 'ready') {
          abort.abort(new Error('The radio disconnected while waiting for the trace.'))
        }
      })
      const request = AbortSignal.any([signal, abort.signal])
      try {
        const contacts = await this.readContacts(link)
        request.throwIfAborted()
        for (const hash of hashes) {
          if (contacts.filter(({ publicKey }) => publicKey.startsWith(hash)).length > 1) {
            throw new Error(`Trace hash ${hash} matches more than one saved radio.`)
          }
          if (radioKey.startsWith(hash)) throw new Error(`Trace hash ${hash} matches the connected radio.`)
        }
        return await sendPathTrace(link, hashes, width, this.subscribeToPushes, request)
      } finally {
        stopWatching()
      }
    })
  }

  readonly createChannel = async (radioKey: string, input: {
    kind: 'private' | 'join' | 'public' | 'hashtag'; name: string; secret: string
  }) => {
    const name = channelName(input.name)
    if (input.kind !== 'hashtag' && name.startsWith('#')) {
      throw new Error('Names starting with # are reserved for hashtag channels.')
    }
    const secret = await makeChannelSecret(input.kind, name, input.secret)
    return this.runRadioCommand(radioKey, async (link) => {
      const count = this.snapshot.device!.capabilities.maxChannels
      let free = -1
      let duplicateSecret = false
      const channels: CompanionChannel[] = []
      for (let index = 0; index < count; index++) {
        const slot = await readChannelSlot(link, index)
        if (slot?.channel.name) {
          channels.push(slot.channel)
          if (slot.secret.every((byte, position) => byte === secret[position])) duplicateSecret = true
        }
        else if (slot && slot.secret.every((byte) => byte === 0) && free < 0) free = index
      }
      this.update({ channels })
      if (channels.some((channel) => channel.name === name)) throw new Error('A channel with this name already exists.')
      if (duplicateSecret) throw new Error('A channel with this key already exists on the radio. Use its existing slot.')
      if (free < 0) throw new Error('No empty channel slot is available on this radio.')
      await writeChannelSlot(link, free, name, secret)
      this.update({ channels: [...channels, { index: free, name }] })
      return input.kind === 'private' ? secretHex(secret) : null
    })
  }

  readonly changeChannel = async (
    radioKey: string, index: number, expectedName: string, name: string | null, afterRename?: () => Promise<void>,
  ) => {
    const nextName = name === null ? '' : channelName(name)
    if (name !== null && (expectedName.startsWith('#') || nextName.startsWith('#'))) {
      throw new Error('Hashtag channels cannot be renamed: their key is derived from their name.')
    }
    await this.runRadioCommand(radioKey, async (link) => {
      if (!Number.isInteger(index) || index < 0 || index >= this.snapshot.device!.capabilities.maxChannels) {
        throw new Error('Invalid channel slot.')
      }
      const slot = await readChannelSlot(link, index)
      if (!slot || slot.channel.name !== expectedName || !expectedName) {
        throw new Error('The channel changed on the radio. Reconnect and check before retrying.')
      }
      await writeChannelSlot(link, index, nextName, name === null ? new Uint8Array(16) : slot.secret)
      try {
        if (name !== null && nextName !== expectedName) await afterRename?.()
      } finally {
        if (this.attempt?.link === link) {
          this.update({ channels: name === null
            ? this.snapshot.channels.filter((channel) => channel.index !== index)
            : this.snapshot.channels.map((channel) => channel.index === index ? { index, name: nextName } : channel) })
        }
      }
    })
  }

  readonly sendChannel = async (
    radioKey: string, index: number, expectedChannel: string, senderName: string, timestamp: number, text: string,
    scope: ChannelScope = { mode: 'default' },
  ) => {
    const command = channelMessageCommand(index, timestamp, text, senderName)
    const validScope = validateChannelScope(scope)
    const scopeCommand = await channelScopeCommand(validScope)
    await this.runRadioCommand(radioKey, async (link) => {
      const attempt = this.attempt!
      const version = this.snapshot.device!.capabilities.firmwareProtocolVersion
      assertScopeSupported(validScope, version)
      if (index >= this.snapshot.device!.capabilities.maxChannels) throw new Error('Invalid channel slot.')
      const slot = await readChannelSlot(link, index)
      if (this.attempt?.link !== link || this.snapshot.phase !== 'ready'
        || this.snapshot.device?.publicKey !== radioKey || this.snapshot.device.name !== senderName) {
        throw new Error('The radio disconnected or its sender name changed before sending.')
      }
      if (!slot || slot.channel.name !== expectedChannel || !expectedChannel) {
        throw new Error('The channel changed on the radio. Reconnect and check before sending.')
      }
      const send = async () => {
        const frame = await link.request(command, (response) => {
          if (response[0] !== Response.error && response[0] !== Response.disabled) expectResponse(response, Response.ok)
          return { value: response }
        })
        if (frame[0] !== Response.ok) {
          const detail = frame.length > 1 ? ` (device error ${frame[1]})` : ''
          throw new CompanionError('device-error', `The radio rejected the channel message${detail}.`)
        }
      }
      if (version < 8) return send()
      await this.serialScope(async () => {
        if (this.attempt !== attempt) throw new CompanionError('disconnected', 'The radio disconnected before applying the sending scope.')
        let recovered = false
        try {
          attempt.scopePending = true
          await this.saveScopeMarker(radioKey, true)
          if (this.attempt !== attempt) throw new CompanionError('disconnected', 'The radio disconnected before applying the sending scope.')
          let sendError: { cause: unknown } | undefined
          try {
            await writeChannelScope(link, scopeCommand)
            if (this.attempt !== attempt) throw new CompanionError('disconnected', 'The radio disconnected before sending.')
            await send()
          } catch (cause) { sendError = { cause } }
          await writeChannelScope(link, Uint8Array.of(54, 0))
          if (this.attempt !== attempt) throw new CompanionError('disconnected', 'The radio disconnected before scope recovery completed.')
          await this.saveScopeMarker(radioKey, false)
          attempt.scopePending = false
          recovered = true
          if (sendError) throw sendError.cause
        } catch (cause) {
          if (!recovered) {
            const error = scopeRecoveryError(cause)
            if (this.attempt === attempt) this.fail(attempt, error)
            throw error
          }
          throw cause
        }
      })
    })
  }

  private serialScope<T>(work: () => Promise<T>): Promise<T> {
    // Recovery must wait for delayed marker writes from older connections too.
    const result = this.scopeTail.then(work)
    this.scopeTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async saveScopeMarker(publicKey: string, pending: boolean) {
    const storage = await this.openScopeStorage()
    try { await storage.update(radioKeyFromPublicKey(publicKey), { scopeRecovery: pending }) }
    finally { storage.close() }
  }

  private async recoverScope(attempt: Attempt, link: SerialLink, device: CompanionDevice) {
    await this.serialScope(async () => {
      if (this.attempt !== attempt) return
      try {
        const storage = await this.openScopeStorage()
        let pending: boolean | undefined
        try { pending = (await storage.read(radioKeyFromPublicKey(device.publicKey)))?.scopeRecovery }
        finally { storage.close() }
        if (pending !== undefined && typeof pending !== 'boolean') throw new Error('Invalid saved scope recovery marker.')
        if (this.attempt !== attempt || !pending) return
        attempt.scopePending = true
        if (device.capabilities.firmwareProtocolVersion < 8) throw new Error('This firmware cannot reset the pending scope override.')
        await writeChannelScope(link, Uint8Array.of(54, 0))
        if (this.attempt !== attempt) throw new Error('The radio disconnected during scope recovery.')
        await this.saveScopeMarker(device.publicKey, false)
        attempt.scopePending = false
      } catch (cause) { throw scopeRecoveryError(cause) }
    })
  }
  readonly readChannelShareKey = (radioKey: string, index: number, expectedName: string) =>
    this.runRadioCommand(radioKey, async (link) => {
      if (!Number.isInteger(index) || index < 0 || index >= this.snapshot.device!.capabilities.maxChannels) {
        throw new Error('Invalid channel slot.')
      }
      const slot = await readChannelSlot(link, index)
      if (!slot || !expectedName || slot.channel.name !== expectedName || slot.secret.every((byte) => byte === 0)) {
        throw new Error('The channel changed on the radio. Reconnect and check before sharing.')
      }
      return secretHex(slot.secret)
    })

  readonly setSetupRadioSettings = (radioKey: string, settings: RadioParameters) =>
    this.runRadioCommand(radioKey, async (link) => {
      const device = this.snapshot.device!
      if (device.capabilities.firmwareProtocolVersion >= 9 && device.capabilities.repeatEnabled === null) {
        throw new Error('The radio did not report its current repeat setting, so the radio preset cannot be changed safely.')
      }
      await writeSetupRadioSettings(link, settings, device.capabilities.repeatEnabled)
      if (this.snapshot.device === device && this.snapshot.phase === 'ready') {
        this.update({ device: { ...device, radioParameters: settings } })
      }
    })

  readonly setSetupPathWidth = (radioKey: string, width: 1 | 2 | 3) =>
    this.runRadioCommand(radioKey, async (link) => {
      const device = this.snapshot.device!
      if (device.capabilities.pathHashMode === null) {
        throw new Error('This firmware does not report support for changing the path hash width.')
      }
      await writeSetupPathWidth(link, width)
      if (this.snapshot.device === device && this.snapshot.phase === 'ready') {
        this.update({ device: { ...device, capabilities: { ...device.capabilities, pathHashMode: width - 1 } } })
      }
    })

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
    this.update({ device })
    if (this.attempt !== attempt) return
    await this.recoverScope(attempt, link, device)
    if (this.attempt !== attempt) return
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
          if (error instanceof CompanionError && (error.code === 'identity' || error.code === 'scope-recovery')) throw error
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
