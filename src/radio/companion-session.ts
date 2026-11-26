import {
  Command, CompanionError, Response, contactCount, decodeCapabilities, decodeChannel, decodeContact,
  decodeSelf,
} from './protocol.ts'
import type { CompanionChannel, CompanionContact, CompanionDevice, CompanionMessage, RadioParameters } from './protocol.ts'
import { expectResponse, SerialLink } from './serial-link.ts'
import type { CompanionLinkPort } from './serial-link.ts'
import { browserSerialEnvironment, choosePort } from './web-serial.ts'
import type { CompanionSerialPort, WebSerialEnvironment } from './web-serial.ts'
import { addContactCommand, contactPathUpdate, contactPermissionsUpdate, contactPublicKey, findContactFrame,
  readContactForEdit, readContactFrame, removeContactCommand, writeContactCommand } from './contact-commands.ts'
import type { ContactPermissions, NewContact } from './contact-commands.ts'
import { decodeContactPath, parseContactPath, pathUnknown } from './contact-path.ts'
import type { ContactPathWidth } from './contact-path.ts'
import { contactPingWidth, parseTracePath, sendContactPing, sendPathTrace } from './contact-ping.ts'
import type { PingHashWidth, TraceHashWidth } from './contact-ping.ts'
import { decodeDirectSent, directMessageCommand, resetPathCommand } from './direct-message.ts'
import type { DirectSendReceipt } from './direct-message.ts'
import { browserBluetoothEnvironment, chooseBluetoothDevice, openBluetoothPort } from './web-bluetooth.ts'
import type { CompanionBluetoothDevice, WebBluetoothEnvironment } from './web-bluetooth.ts'
import { getLanCompanionUrl } from './lan-bridge.ts'
import { framedTransport } from './transport.ts'
import type { CompanionTransport } from './transport.ts'
import {
  readAdvertPath, readAutoAddPolicy, readNoiseFloor, requestRepeaterDetails, scanNearby, sendNearbyRequest, writeAutoAddPolicy,
} from './discovery-commands.ts'
import type { AutoAddPolicy, NearbyNode, RepeaterDetails, RepeaterRequestOptions } from './discovery-commands.ts'
import { channelName, makeChannelSecret, readChannelSlot, secretHex, writeChannelSlot } from './channel-commands.ts'
import { channelMessageCommand } from './channel-message.ts'
import { writeSetupPathWidth, writeSetupRadioSettings } from './setup-commands.ts'
import type { AdvancedDeviceEdits, DeviceEdits, DeviceSaveResult } from './device-settings.ts'
import { assertScopeSupported, channelScopeCommand, validateChannelScope, writeChannelScope } from './channel-scope.ts'
import type { ChannelScope } from './channel-scope.ts'
import { requestOwnTelemetry, requestRemoteTelemetry, telemetryProtocolVersion } from './telemetry.ts'
import { canPostToRoom, maxRoomTextBytes } from './node-access.ts'
import type { RemoteNodeAccess } from './node-access.ts'
import type { RemoteNodeAdmin } from './remote-nodes.ts'
import { decodeSensorSummary } from './cayenne-lpp.ts'
import { parseRepeaterNeighborPage, repeaterNeighborRequest, repeaterRequest, UncertainRepeaterRequestError } from './repeater-management.ts'
import type { RepeaterLogin, RepeaterStatus } from './repeater-management.ts'
import { allocateRepeaterCliTag, isRepeaterRebootCommand, repeaterCliCommand, sendRepeaterCli, UncertainRepeaterCliError } from './repeater-cli.ts'
import { openRadioStorage, radioKeyFromPublicKey } from '../storage/index.ts'
import type { IdentityRecoveryPreparation } from './identity-backup.ts'

export interface SyncProgress {
  readonly stage: 'contacts' | 'channels' | 'messages'
  readonly completed: number
  readonly total: number | null
}

export interface CompanionSnapshot {
  readonly phase: 'idle' | 'choosing' | 'opening' | 'handshake' | 'syncing' | 'ready' | 'reconnecting' | 'closing' | 'error'
  readonly transport: CompanionTransport | null
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

export type SyncMaintenanceMessages = (publicKey: string, reserve: () => QueuedMessageLease, signal: AbortSignal) => Promise<void>

interface Attempt {
  link?: SerialLink
  opening?: Promise<SerialLink | null>
  locking?: Promise<void>
  recovering?: boolean
  scopePending?: boolean
  maintenance?: boolean
  remoteAccess?: Map<string, RemoteNodeAccess>
  unconfirmedNodeLogins?: Set<string>
}

type SelectedTransport =
  | { kind: 'usb'; device: CompanionSerialPort }
  | { kind: 'bluetooth'; device: CompanionBluetoothDevice }
  | { kind: 'lan'; url: string }

interface LockProvider {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown | null) => Promise<void>): Promise<void>
}

// Keep the same ownership lock as existing USB-only tabs.
const companionOwnershipLock = 'packet-pigeon-usb-session'

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
  private nearbyDiscoveryPending = false
  private repeaterLogin?: { attempt: Attempt; key: string; pathLength: number; pathHex: string; role: RepeaterLogin['role'] }
  private readonly uncertainRepeaterRequests = new WeakMap<Attempt, Set<string>>()
  private readonly repeaterCliTags = new Map<string, Set<string>>()
  readonly #repeaterPasswords = new Map<string, Uint8Array>()
  readonly #repeaterPasswordRevisions = new Map<string, number>()
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
    if (!attempt.maintenance && this.expectedKey && (error.code === 'disconnected' || error.code === 'serial-io')) {
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
    this.ownership = this.locks.request(companionOwnershipLock, { ifAvailable: true }, async (lock) => {
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

  readonly connectLan = () => this.connectUsing(async () => {
    const url = getLanCompanionUrl()
    if (!url) throw new CompanionError('unsupported-transport', 'Open Packet Pigeon from the local companion bridge.')
    return { kind: 'lan', url }
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
      } else if (connection.kind === 'bluetooth') {
        port = await openBluetoothPort(connection.device)
      } else {
        const { openLanPort } = await import('./web-lan.ts')
        port = await openLanPort(connection.url)
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

  readonly whileRadioDisconnected = async (work: () => Promise<void>) => {
    if (this.snapshot.phase !== 'idle' && this.snapshot.phase !== 'error') {
      throw new Error('Disconnect the radio before clearing its cache.')
    }
    if (!this.locks) return work()
    await this.locks.request(companionOwnershipLock, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('Disconnect the radio in the other Packet Pigeon tab before clearing the cache.')
      await work()
    })
  }

  readonly reserveQueuedMessage = (publicKey: string): QueuedMessageLease => {
    const link = this.attempt?.link
    if (this.snapshot.phase !== 'ready' || !link || this.snapshot.device?.publicKey !== publicKey) {
      throw new CompanionError('disconnected', 'Connect the selected radio before syncing messages.')
    }
    if (this.contactWritePending) {
      throw new CompanionError('protocol', 'Wait for the contact change to finish before syncing messages.')
    }
    if (this.directCommandPending) {
      throw new CompanionError('protocol', 'Wait for the direct-message command to finish before syncing messages.')
    }
    return this.reserveReceipt(link, publicKey)
  }

  private reserveReceipt(link: SerialLink, publicKey: string): QueuedMessageLease {
    if (this.receiptHolds.size) {
      throw new CompanionError('protocol', 'Save the previous received message before requesting another.')
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

  private async verifiedRepeater(
    link: SerialLink, radioKey: string, key: string, expectedRoute: { pathLength: number; pathHex: string },
    signal: AbortSignal,
  ) {
    const contacts = await this.readContacts(link)
    signal.throwIfAborted()
    const target = contacts.find((contact) => contact.publicKey === key)
    if (!target || target.type !== 2 || target.pathLength !== expectedRoute.pathLength || target.pathHex !== expectedRoute.pathHex) {
      throw new Error('The saved repeater or its route changed. Refresh Contacts before retrying.')
    }
    if (target.pathLength !== pathUnknown && !decodeContactPath(target.pathLength, target.pathHex)) {
      throw new Error('The saved repeater route is invalid. Refresh Contacts before retrying.')
    }
    if (radioKey.startsWith(key.slice(0, 8)) || contacts.some((contact) =>
      contact.publicKey !== key && contact.publicKey.startsWith(key.slice(0, 8)))) {
      throw new Error('This repeater shares a response prefix with another known radio.')
    }
    return target
  }

  readonly getRemoteNodeAccess = (radioKey: string, nodeKey: string) =>
    this.snapshot.phase === 'ready' && this.snapshot.device?.publicKey === radioKey
      ? this.attempt?.remoteAccess?.get(nodeKey) : undefined

  private withRemoteNode<T>(radioKey: string, nodeKey: string, signal: AbortSignal,
    action: (link: SerialLink, contact: CompanionContact & { type: 3 | 4 }, attempt: Attempt, active: AbortSignal) => Promise<T>) {
    const key = contactPublicKey(nodeKey)
    return this.runRadioCommand(radioKey, async (link) => {
      const attempt = this.attempt!
      const disconnected = new AbortController()
      const stop = this.subscribe(() => {
        if (this.attempt !== attempt || this.snapshot.phase !== 'ready') {
          disconnected.abort(new Error('The radio disconnected before the node command completed.'))
        }
      })
      const active = AbortSignal.any([signal, disconnected.signal])
      try {
        active.throwIfAborted()
        const contacts = await this.readContacts(link)
        active.throwIfAborted()
        this.update({ contacts })
        // The companion's in-flight login match uses four key bytes.
        const matches = contacts.filter((contact) => contact.publicKey.slice(0, 8) === key.slice(0, 8))
        const contact = matches.length === 1 && matches[0].publicKey === key ? matches[0] : undefined
        if (!contact || (contact.type !== 3 && contact.type !== 4)) {
          throw new Error('Select a saved room server or sensor with a unique key prefix.')
        }
        return await action(link, { ...contact, type: contact.type }, attempt, active)
      } finally { stop() }
    })
  }

  readonly loginNode = (radioKey: string, nodeKey: string, password: string, signal: AbortSignal) =>
    this.withRemoteNode(radioKey, nodeKey, signal, async (link, { publicKey }, attempt, active) => {
      if (attempt.unconfirmedNodeLogins?.has(publicKey)) {
        throw new Error('The previous login may still reply. Reconnect before trying this node again. A late reply is still possible after reconnecting.')
      }
      const access = attempt.remoteAccess ??= new Map()
      if (access.delete(publicKey)) this.update({})
      const { loginRemoteNode, RemoteLoginUnconfirmed } = await import('./remote-nodes.ts')
      try {
        const login = await loginRemoteNode(link, publicKey, password, this.subscribeToPushes, active)
        access.set(publicKey, login)
        this.update({})
        return login
      } catch (error) {
        if (error instanceof RemoteLoginUnconfirmed) (attempt.unconfirmedNodeLogins ??= new Set()).add(publicKey)
        throw error
      }
    })

  readonly readRoomStatus = (radioKey: string, nodeKey: string, signal: AbortSignal) =>
    this.withRemoteNode(radioKey, nodeKey, signal, async (link, { publicKey, type }, attempt, active) => {
      if (type !== 3 || !attempt.remoteAccess?.has(publicKey)) throw new Error('Sign in to the room server before requesting its status.')
      const { parseRoomStatus, requestRemoteNodeData } = await import('./remote-nodes.ts')
      return parseRoomStatus(await requestRemoteNodeData(link, publicKey, Uint8Array.of(1), this.subscribeToPushes, active))
    })

  readonly readNodeClients = (radioKey: string, nodeKey: string, signal: AbortSignal) =>
    this.withRemoteNode(radioKey, nodeKey, signal, async (link, { publicKey }, attempt, active) => {
      if (attempt.remoteAccess?.get(publicKey)?.role !== 'admin') throw new Error('Administrator access is required to read permissions.')
      const { parseRemoteNodeClients, requestRemoteNodeData } = await import('./remote-nodes.ts')
      return parseRemoteNodeClients(await requestRemoteNodeData(link, publicKey, Uint8Array.of(5, 0, 0), this.subscribeToPushes, active))
    })

  readonly readSensorHistory = (radioKey: string, nodeKey: string, seconds: number, signal: AbortSignal) =>
    this.withRemoteNode(radioKey, nodeKey, signal, async (link, { publicKey, type }, attempt, active) => {
      const role = attempt.remoteAccess?.get(publicKey)?.role
      if (type !== 4 || !role || role === 'guest') throw new Error('Sign in with sensor history access before requesting readings.')
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 0xffffffff) throw new Error('Select a valid history window.')
      const request = new Uint8Array(11)
      request[0] = 4
      new DataView(request.buffer).setUint32(1, seconds, true)
      const { requestRemoteNodeData } = await import('./remote-nodes.ts')
      return decodeSensorSummary(await requestRemoteNodeData(link, publicKey, request, this.subscribeToPushes, active))
    })

  readonly administerNode = (radioKey: string, nodeKey: string, action: RemoteNodeAdmin, signal: AbortSignal) =>
    this.withRemoteNode(radioKey, nodeKey, signal, async (link, { publicKey, type }, attempt, active) => {
      if (attempt.remoteAccess?.get(publicKey)?.role !== 'admin') throw new Error('Sign in as an administrator before managing this node.')
      const { remoteNodeAdminText, sendRemoteNodeAdmin } = await import('./remote-nodes.ts')
      const text = remoteNodeAdminText(action, type)
      active.throwIfAborted()
      const route = await sendRemoteNodeAdmin(link, publicKey, text)
      if (action.kind === 'client-permissions' && contactPublicKey(action.publicKey) === radioKey) {
        attempt.remoteAccess?.delete(publicKey)
        this.update({})
      }
      return route
    })

  readonly hasRememberedRepeaterPassword = (radioKey: string, contactKey: string) =>
    this.#repeaterPasswords.has(`${contactPublicKey(radioKey)}:${contactPublicKey(contactKey)}`)

  readonly forgetRepeaterPassword = (radioKey: string, contactKey: string) => {
    const key = `${contactPublicKey(radioKey)}:${contactPublicKey(contactKey)}`
    this.#repeaterPasswords.get(key)?.fill(0)
    this.#repeaterPasswords.delete(key)
    this.#repeaterPasswordRevisions.set(key, (this.#repeaterPasswordRevisions.get(key) ?? 0) + 1)
  }

  readonly resumeRepeater = (
    radioKey: string, contactKey: string, expectedRoute: { pathLength: number; pathHex: string }, signal: AbortSignal,
  ) => {
    const key = `${contactPublicKey(radioKey)}:${contactPublicKey(contactKey)}`
    const password = this.#repeaterPasswords.get(key)
    if (!password) throw new Error('No repeater password is remembered in this tab.')
    return this.manageRepeater(radioKey, contactKey, expectedRoute, 'login', new TextDecoder().decode(password), signal)
  }

  readonly manageRepeater = async (
    radioKey: string, contactKey: string, expectedRoute: { pathLength: number; pathHex: string },
    operation: 'login' | 'status', password: string, signal: AbortSignal, rememberPassword = false,
  ): Promise<RepeaterLogin | RepeaterStatus> => {
    const key = contactPublicKey(contactKey)
    if (key === radioKey) throw new Error('Choose a different repeater from the connected radio.')
    if (rememberPassword && (operation !== 'login' || !password)) {
      throw new Error('Enter a nonempty password to remember it.')
    }
    const passwordKey = `${contactPublicKey(radioKey)}:${key}`
    const passwordRevision = this.#repeaterPasswordRevisions.get(passwordKey) ?? 0
    signal.throwIfAborted()
    return this.runRadioCommand(radioKey, async (link) => {
      const attempt = this.attempt!
      const uncertain = this.uncertainRepeaterRequests.get(attempt) ?? new Set<string>()
      this.uncertainRepeaterRequests.set(attempt, uncertain)
      if (uncertain.has(key)) {
        throw new Error('A previous reply may arrive late. Reconnect before requesting this operation again.')
      }
      const disconnected = new AbortController()
      const stop = this.subscribe(() => {
        if (this.attempt !== attempt || this.snapshot.phase !== 'ready') {
          disconnected.abort(new Error('The radio disconnected while waiting for the repeater.'))
        }
      })
      const request = AbortSignal.any([signal, disconnected.signal])
      try {
        const target = await this.verifiedRepeater(link, radioKey, key, expectedRoute, request)
        if (operation === 'status' && (!this.repeaterLogin || this.repeaterLogin.attempt !== attempt ||
          this.repeaterLogin.key !== key || this.repeaterLogin.pathLength !== target.pathLength ||
          this.repeaterLogin.pathHex !== target.pathHex)) {
          throw new Error('Log in to this repeater on its current route before requesting status.')
        }
        if (operation === 'login') this.repeaterLogin = undefined
        try {
          const result = await repeaterRequest(link, key, operation, password, this.subscribeToPushes, request)
          if (operation === 'login' && 'role' in result) {
            this.repeaterLogin = { attempt, key, pathLength: target.pathLength, pathHex: target.pathHex, role: result.role }
            if (rememberPassword && (this.#repeaterPasswordRevisions.get(passwordKey) ?? 0) === passwordRevision) {
              this.#repeaterPasswords.get(passwordKey)?.fill(0)
              this.#repeaterPasswords.set(passwordKey, new TextEncoder().encode(password))
            }
          }
          return result
        } catch (error) {
          if (error instanceof UncertainRepeaterRequestError) {
            uncertain.add(key)
          }
          throw error
        }
      } finally {
        stop()
      }
    })
  }

  private async withRepeaterBinaryRequest<T>(
    radioKey: string, contactKey: string, expectedRoute: { pathLength: number; pathHex: string },
    signal: AbortSignal, kind: 'access list' | 'neighbors',
    action: (link: SerialLink, key: string, signal: AbortSignal) => Promise<T>,
  ) {
    const key = contactPublicKey(contactKey)
    if (key === radioKey) throw new Error('Choose a different repeater from the connected radio.')
    signal.throwIfAborted()
    return this.runRadioCommand(radioKey, async (link) => {
      const attempt = this.attempt!
      if (this.uncertainRepeaterRequests.get(attempt)?.has(key)) {
        throw new Error('A previous reply may arrive late. Reconnect before requesting this operation again.')
      }
      const login = this.repeaterLogin
      if (!login || login.attempt !== attempt || login.key !== key || (kind === 'access list' && login.role !== 'admin')) {
        throw new Error(kind === 'access list'
          ? 'Log in to this repeater as an administrator before reading its access list.'
          : 'Log in to this repeater before reading its neighbors.')
      }
      const disconnected = new AbortController()
      const stop = this.subscribe(() => {
        if (this.attempt !== attempt || this.snapshot.phase !== 'ready') {
          disconnected.abort(new Error('The radio disconnected before the repeater request completed.'))
        }
      })
      const request = AbortSignal.any([signal, disconnected.signal])
      try {
        const target = await this.verifiedRepeater(link, radioKey, key, expectedRoute, request)
        if (login.pathLength !== target.pathLength || login.pathHex !== target.pathHex) {
          throw new Error(`The repeater route changed after login. Log in again before reading its ${kind}.`)
        }
        return await action(link, key, request)
      } finally {
        stop()
      }
    })
  }

  readonly readRepeaterAccessList = (
    radioKey: string, contactKey: string, expectedRoute: { pathLength: number; pathHex: string }, signal: AbortSignal,
  ) => this.withRepeaterBinaryRequest(radioKey, contactKey, expectedRoute, signal, 'access list',
    async (link, key, request) => {
      const { parseRemoteNodeClients, requestRemoteNodeData } = await import('./remote-nodes.ts')
      return parseRemoteNodeClients(await requestRemoteNodeData(link, key, Uint8Array.of(5, 0, 0),
        this.subscribeToPushes, request, { minimumMs: 10_000, marginMs: 5_000 }))
    })

  readonly readRepeaterNeighbors = (
    radioKey: string, contactKey: string, expectedRoute: { pathLength: number; pathHex: string },
    offset: number, signal: AbortSignal,
  ) => this.withRepeaterBinaryRequest(radioKey, contactKey, expectedRoute, signal, 'neighbors',
    async (link, key, request) => {
      const { requestRemoteNodeData } = await import('./remote-nodes.ts')
      return parseRepeaterNeighborPage(await requestRemoteNodeData(link, key, repeaterNeighborRequest(offset),
        this.subscribeToPushes, request, { minimumMs: 10_000, marginMs: 5_000 }), offset)
    })

  readonly sendRepeaterCommand = async (
    radioKey: string, contactKey: string, expectedRoute: { pathLength: number; pathHex: string },
    command: string, confirmed: boolean, signal: AbortSignal,
  ) => {
    const key = contactPublicKey(contactKey)
    if (key === radioKey) throw new Error('Choose a different repeater from the connected radio.')
    const action = repeaterCliCommand(command)
    if ('confirm' in action && action.confirm && !confirmed) {
      throw new Error('Confirm this repeater action before sending it.')
    }
    signal.throwIfAborted()
    return this.runRadioCommand(radioKey, async (link) => {
      const attempt = this.attempt!
      if (this.uncertainRepeaterRequests.get(attempt)?.has(key)) {
        throw new Error('A previous reply may arrive late. Reconnect before requesting this operation again.')
      }
      const login = this.repeaterLogin
      if (!login || login.attempt !== attempt || login.key !== key || login.role !== 'admin') {
        throw new Error('Log in to this repeater as an administrator before using its CLI.')
      }
      if ('accessTarget' in action && (action.accessTarget === contactPublicKey(radioKey) || action.accessTarget === key)) {
        throw new Error(action.command.endsWith(' 0')
          ? 'Cannot remove the connected radio or repeater from its access list.'
          : action.command.endsWith(' 3')
            ? 'Cannot grant administrator access to the connected radio or repeater.'
            : 'Cannot change the connected radio or repeater access-list role.')
      }
      const disconnected = new AbortController()
      const stop = this.subscribe(() => {
        if (this.attempt !== attempt || this.snapshot.phase !== 'ready') {
          disconnected.abort(new Error('The radio disconnected before the repeater command completed.'))
        }
      })
      const request = AbortSignal.any([signal, disconnected.signal])
      try {
        const target = await this.verifiedRepeater(link, radioKey, key, expectedRoute, request)
        if (login.pathLength !== target.pathLength || login.pathHex !== target.pathHex) {
          throw new Error('The repeater route changed after login. Log in again before using its CLI.')
        }
        request.throwIfAborted()
        const tagKey = `${radioKey}:${key}`
        const tags = this.repeaterCliTags.get(tagKey) ?? new Set<string>()
        this.repeaterCliTags.set(tagKey, tags)
        const tag = allocateRepeaterCliTag(tags)
        try {
          const receipt = await sendRepeaterCli(link, key, action.command, tag)
          if (isRepeaterRebootCommand(action.command) && this.repeaterLogin === login) this.repeaterLogin = undefined
          return receipt
        } catch (error) {
          if (isRepeaterRebootCommand(action.command) && error instanceof UncertainRepeaterCliError && this.repeaterLogin === login) {
            this.repeaterLogin = undefined
          }
          throw error
        }
      } finally {
        stop()
      }
    })
  }

  readonly advertPath = (radioKey: string, contactKey: string) => (
    this.runRadioCommand(radioKey, (link) => {
      if (!framedTransport(this.snapshot.transport)) {
        throw new CompanionError('unsupported-transport', 'Connect over USB or the local network to read an advert path from the radio.')
      }
      return readAdvertPath(link, contactKey)
    })
  )

  readonly getAutoAdd = (radioKey: string) => (
    this.runRadioCommand(radioKey, (link) => readAutoAddPolicy(link, this.snapshot.device!.contactMode))
  )

  readonly noiseFloor = (radioKey: string) => (
    this.runRadioCommand(radioKey, (link) => {
      if (this.snapshot.device!.capabilities.firmwareProtocolVersion < 8) {
        throw new CompanionError('unsupported-firmware', 'Radio statistics require companion protocol v8 or newer.')
      }
      return readNoiseFloor(link)
    })
  )

  private async watchDiscovery<T>(
    radioKey: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted()
    const attempt = this.attempt
    if (!attempt?.link || this.snapshot.phase !== 'ready' || this.snapshot.device?.publicKey !== radioKey) {
      throw new CompanionError('disconnected', 'Connect the selected radio and wait for it to finish syncing.')
    }
    if (this.snapshot.device.capabilities.firmwareProtocolVersion < 8) {
      throw new CompanionError('unsupported-firmware', 'Active discovery requires companion protocol v8 or newer.')
    }
    const disconnected = new AbortController()
    const stopWatching = this.subscribe(() => {
      if (this.attempt !== attempt || this.snapshot.phase !== 'ready') {
        disconnected.abort(new Error('The radio disconnected during discovery.'))
      }
    })
    try {
      return await run(AbortSignal.any([signal, disconnected.signal]))
    } finally {
      stopWatching()
    }
  }

  readonly discoverNearby = async (
    radioKey: string, signal: AbortSignal, onNode: (node: NearbyNode) => void, onListening: () => void,
  ) => {
    if (this.nearbyDiscoveryPending) throw new Error('A nearby discovery scan is already running.')
    this.nearbyDiscoveryPending = true
    try {
      await this.watchDiscovery(radioKey, signal, (request) => scanNearby(
        (tag) => this.runRadioCommand(radioKey, (link) => sendNearbyRequest(link, tag, request)),
        this.subscribeToPushes, request,
        (node) => { if (node.publicKey !== radioKey) onNode(node) }, onListening,
      ))
    } finally {
      this.nearbyDiscoveryPending = false
    }
  }

  readonly discoverRepeaterDetails = async (
    radioKey: string, contactKey: string, kind: RepeaterDetails['kind'], signal: AbortSignal, onWaiting: () => void,
    options?: RepeaterRequestOptions,
  ) => {
    const key = contactPublicKey(contactKey)
    if (key === radioKey) throw new Error('Choose a different repeater from the connected radio.')
    if (kind !== 'regions' && kind !== 'owner') throw new Error('Choose a supported discovery request.')
    return this.watchDiscovery(radioKey, signal, (request) => this.runRadioCommand(radioKey, async (link) => {
      const version = this.snapshot.device!.capabilities.firmwareProtocolVersion
      const expected = options === undefined ? { pathLength: 0, pathHex: '' } : options.expectedRoute
      const replyPath = parseContactPath(options?.replyPath.text ?? '', options?.replyPath.width ?? 1)
      if (replyPath.width > 1 && version < 10) throw new Error('This firmware does not support that reply path hash width.')
      if (expected === null && version < 13) {
        throw new CompanionError('unsupported-firmware', 'Unsaved repeater requests require companion protocol v13 or newer.')
      }
      const frame = await findContactFrame(link, key)
      request.throwIfAborted()
      const contact = frame && decodeContact(frame)
      const path = contact && decodeContactPath(contact.pathLength, contact.pathHex)
      const expectedPath = expected && decodeContactPath(expected.pathLength, expected.pathHex)
      if (expected === null) {
        if (contact && (contact.type !== 0 || !path || path.hops.length !== 0)) {
          throw new Error('The repeater changed on the radio. Refresh contacts before retrying.')
        }
      } else {
        if (contact?.type === 0) {
          throw new Error('The radio is using a temporary contact instead of the saved repeater. Restart the radio or clear that entry, then refresh Contacts.')
        }
        if (!expectedPath || !contact || contact.type !== 2 || !path
          || expectedPath.width !== path.width || expectedPath.hops.join('') !== path.hops.join('')) {
          throw new Error('The saved repeater or its route changed. Refresh Contacts and select it again before retrying.')
        }
        if (path.width > 1 && version < 10) throw new Error('This firmware does not support that saved path hash width.')
      }
      return requestRepeaterDetails(link, key, kind, this.subscribeToPushes, request, onWaiting, replyPath,
        Boolean(path?.hops.length || replyPath.count))
    }))
  }

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
      if (!framedTransport(this.snapshot.transport)) throw new Error('Connect over USB or the local network to edit radio paths or permissions.')
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

  readonly readTelemetry = async (radioKey: string, contactKey: string | null, signal: AbortSignal) => {
    const key = contactKey === null ? radioKey : contactPublicKey(contactKey)
    signal.throwIfAborted()
    return this.runRadioCommand(radioKey, async (link) => {
      if ((this.snapshot.device?.capabilities.firmwareProtocolVersion ?? 0) < telemetryProtocolVersion) {
        throw new Error('This companion firmware does not support telemetry.')
      }
      if (contactKey === null) return requestOwnTelemetry(link, key, signal)
      if (key === radioKey) throw new Error('Use radio telemetry for the connected device.')
      const abort = new AbortController()
      const stopWatching = this.subscribe(() => {
        if (this.attempt?.link !== link || this.snapshot.phase !== 'ready') {
          abort.abort(new Error('The radio disconnected while waiting for telemetry.'))
        }
      })
      const request = AbortSignal.any([signal, abort.signal])
      try {
        const contacts = await this.readContacts(link)
        request.throwIfAborted()
        if (!contacts.some(({ publicKey }) => publicKey === key)) throw new Error('The radio no longer has this contact.')
        const prefix = key.slice(0, 12)
        if (radioKey.startsWith(prefix) || contacts.some(({ publicKey }) => publicKey !== key && publicKey.startsWith(prefix))) {
          throw new Error('This contact shares a telemetry reply prefix with another known radio.')
        }
        return await requestRemoteTelemetry(link, key, this.subscribeToPushes, request)
      } finally {
        stopWatching()
      }
    })
  }

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

  readonly tracePath = async (
    radioKey: string, text: string, width: TraceHashWidth, signal: AbortSignal, knownPublicKeys: readonly string[] = [],
  ) => {
    const hashes = parseTracePath(text, width)
    signal.throwIfAborted()
    return this.runRadioCommand(radioKey, async (link) => {
      if (!framedTransport(this.snapshot.transport)) throw new Error('Connect over USB or the local network to trace a multi-hop path.')
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
        const keys = [...new Set([...contacts.map(({ publicKey }) => publicKey), ...knownPublicKeys]
          .map((key) => key.toLowerCase()))]
        for (const hash of hashes) {
          if (keys.filter((key) => key.startsWith(hash)).length > 1) {
            throw new Error(`Trace hash ${hash} matches more than one known radio.`)
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

  readonly readChannelObservationKey = async (radioKey: string, index: number, expectedName: string) => {
    let extracted: Uint8Array | undefined
    try {
      return await this.runRadioCommand(radioKey, async (link) => {
        const capacity = this.snapshot.device!.capabilities.maxChannels
        if (!Number.isInteger(index) || index < 0 || index >= capacity) {
          throw new Error('Invalid channel slot.')
        }
        const slot = await readChannelSlot(link, index)
        if (!slot || !expectedName || slot.channel.name !== expectedName || slot.secret.every((byte) => byte === 0)) {
          slot?.secret.fill(0)
          throw new Error('The channel changed on the radio. Reconnect and check before observing.')
        }
        try {
          for (let other = 0; other < capacity; other++) {
            if (other === index) continue
            const candidate = await readChannelSlot(link, other)
            if (!candidate) continue
            try {
              if (candidate.secret.every((byte, position) => byte === slot.secret[position])) {
                throw new Error('More than one radio channel has the same key. Resolve duplicate keys before observing.')
              }
            } finally { candidate.secret.fill(0) }
          }
          extracted = slot.secret
          return extracted
        } catch (error) {
          slot.secret.fill(0)
          throw error
        }
      })
    } catch (error) {
      extracted?.fill(0)
      throw error
    }
  }

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

  readonly getDeviceDetails = async (radioKey: string) => {
    const { readDeviceDetails } = await import('./device-settings.ts')
    return this.runRadioCommand(radioKey, (link) => readDeviceDetails(link, this.snapshot.device!.capabilities.firmwareProtocolVersion))
  }

  readonly exportDeviceIdentity = async (radioKey: string) => {
    const { readBackupIdentity } = await import('./identity-backup.ts')
    return this.runRadioCommand(radioKey, (link) => readBackupIdentity(link, radioKey))
  }

  readonly exportBackupChannels = async (radioKey: string, signal: AbortSignal) => {
    const { readBackupChannels } = await import('./backup-commands.ts')
    return this.runRadioCommand(radioKey, (link) => readBackupChannels(link, this.snapshot.device!.capabilities.maxChannels, signal))
  }

  readonly exportBackupContacts = (radioKey: string) =>
    this.runRadioCommand(radioKey, (link) => this.readContacts(link))

  readonly exportBackupDefaultRegion = async (radioKey: string) => {
    const { readBackupDefaultRegion } = await import('./device-settings.ts')
    return this.runRadioCommand(radioKey, (link) => this.snapshot.device!.capabilities.firmwareProtocolVersion >= 12
      ? readBackupDefaultRegion(link) : Promise.resolve(undefined))
  }

  readonly importBackupDefaultRegion = async (radioKey: string, region: { name: string; key: string } | null) => {
    const { writeBackupDefaultRegion } = await import('./device-settings.ts')
    return this.runRadioCommand(radioKey, async (link) => {
      if (this.snapshot.device!.capabilities.firmwareProtocolVersion < 12) {
        throw new Error('This firmware does not support setting the default region.')
      }
      await writeBackupDefaultRegion(link, region)
    })
  }

  readonly importBackupChannels = async (radioKey: string, entries: readonly { name: string; secret: string }[], signal: AbortSignal) => {
    const { restoreBackupChannels } = await import('./backup-commands.ts')
    let result: Awaited<ReturnType<typeof restoreBackupChannels>> | undefined
    try {
      await this.runRadioCommand(radioKey, async (link) => {
        const connected = () => this.attempt?.link === link && this.snapshot.phase === 'ready'
        result = await restoreBackupChannels(link, this.snapshot.device!.capabilities.maxChannels, entries, signal, connected)
        if (connected()) this.update({ channels: result.channels })
      })
    } catch (error) {
      if (!result) throw error
    }
    return result!
  }

  readonly importBackupContacts = async (radioKey: string, entries: readonly Omit<CompanionContact, 'lastModifiedAt'>[], signal: AbortSignal) => {
    const { restoreBackupContacts } = await import('./backup-commands.ts')
    let results: Awaited<ReturnType<typeof restoreBackupContacts>> | undefined
    try {
      await this.runRadioCommand(radioKey, async (link) => {
        const connected = () => this.attempt?.link === link && this.snapshot.phase === 'ready'
        const { firmwareProtocolVersion: firmware, maxContacts: capacity } = this.snapshot.device!.capabilities
        results = await restoreBackupContacts(link, entries, signal, { ownKey: radioKey, firmware, capacity, connected,
          readContacts: () => this.readContacts(link) })
        if (connected() && results.some(({ status }) => status === 'saved')) {
          this.update({ contacts: await this.readContacts(link) })
        }
      })
    } catch (error) {
      if (!results) throw error
      results.push({ publicKey: '', label: 'Refresh contacts', status: 'failed', reason: 'Reconnect to refresh the saved contacts.' })
    }
    return results!
  }

  private async runMaintenance(radioKey: string, write: (link: SerialLink) => Promise<void>,
    prepare?: (link: SerialLink) => Promise<void>) {
    const generation = this.generation
    let disconnect = false
    try {
      await this.runRadioCommand(radioKey, async (link) => {
        const attempt = this.attempt!
        if (prepare) await prepare(link)
        if (this.attempt !== attempt) throw new Error('The radio disconnected before maintenance started.')
        attempt.maintenance = true
        disconnect = true
        try {
          await write(link)
        } catch (error) {
          if (error instanceof CompanionError && error.code === 'device-error') {
            attempt.maintenance = false
            disconnect = false
          }
          throw error
        }
      })
    } finally {
      if (disconnect && generation === this.generation) {
        const closing = this.disconnect()
        // The UI must be able to report a failed restart while ownership waits for a receipt retry.
        if (!this.receiptHolds.size) await closing
      }
    }
  }

  readonly prepareIdentityRecovery = async (radioKey: string, syncMessages: SyncMaintenanceMessages, signal: AbortSignal) => {
    const { maintenanceCommand, readBootTime } = await import('./identity-backup.ts')
    if ((this.snapshot.device?.capabilities.firmwareProtocolVersion ?? 0) < 8) {
      throw new Error('Identity recovery requires firmware that can verify a reboot before replacing the key.')
    }
    let bootTime = 0
    let preparation: IdentityRecoveryPreparation | undefined
    try {
      await this.runMaintenance(radioKey, async (link) => {
        const requestedAt = performance.now()
        await link.sendWithoutReply(maintenanceCommand('reboot'))
        preparation = { radioKey, bootTime, requestedAt }
      }, async (link) => {
        bootTime = await readBootTime(link)
        await syncMessages(radioKey, () => this.reserveReceipt(link, radioKey), signal)
        signal.throwIfAborted()
      })
    } catch (error) {
      if (!preparation) throw error
    }
    return preparation!
  }

  readonly verifyIdentityRecovery = async (radioKey: string, preparation: IdentityRecoveryPreparation, signal: AbortSignal) => {
    const { readBootTime, verifyRebootTime } = await import('./identity-backup.ts')
    if (preparation.radioKey !== radioKey) throw new Error('Reconnect the radio prepared for identity recovery.')
    const bootTime = await this.runRadioCommand(radioKey, readBootTime)
    signal.throwIfAborted()
    verifyRebootTime(preparation, bootTime)
  }

  readonly restoreDeviceIdentity = async (radioKey: string, key: Uint8Array, expectedPublicKey: string,
    contacts: readonly Omit<CompanionContact, 'lastModifiedAt'>[], syncMessages: SyncMaintenanceMessages, signal: AbortSignal) => {
    const { maintenanceCommand, writeBackupIdentity } = await import('./identity-backup.ts')
    const { restoreContactsAfterIdentity } = await import('./backup-commands.ts')
    if (radioKey === expectedPublicKey) return []
    let identitySaved = false
    let before: readonly CompanionContact[] = []
    let results: Awaited<ReturnType<typeof restoreContactsAfterIdentity>> = []
    const unverifiedContacts = { publicKey: '', label: 'Verify contacts', status: 'uncertain' as const,
      reason: 'Reconnect and verify the radio’s contacts after the identity change.' }
    try {
      await this.runMaintenance(radioKey, async (link) => {
        const { firmwareProtocolVersion: firmware, maxContacts: capacity } = this.snapshot.device!.capabilities
        await writeBackupIdentity(link, key, expectedPublicKey)
        identitySaved = true
        const connected = () => this.attempt?.link === link && this.snapshot.phase === 'ready'
        try {
          results = await restoreContactsAfterIdentity(link, before, contacts, signal,
            { ownKey: expectedPublicKey, firmware, capacity, connected, readContacts: () => this.readContacts(link) },
            async () => {
              await syncMessages(expectedPublicKey, () => this.reserveReceipt(link, radioKey), signal)
              signal.throwIfAborted()
              await link.sendWithoutReply(maintenanceCommand('reboot'))
            })
        } catch {
          results.push(unverifiedContacts)
        }
      }, async (link) => {
        await syncMessages(radioKey, () => this.reserveReceipt(link, radioKey), signal)
        before = await this.readContacts(link)
        signal.throwIfAborted()
      })
    } catch (error) {
      if (!identitySaved) throw error
      if (!results.length) results.push(unverifiedContacts)
    }
    return results
  }

  readonly sendMaintenance = async (radioKey: string, action: 'reboot' | 'reset') => {
    const { maintenanceCommand } = await import('./identity-backup.ts')
    if (action === 'reset' && (this.snapshot.device?.capabilities.firmwareProtocolVersion ?? 0) < 7) {
      throw new Error('This firmware does not expose the factory reset command.')
    }
    let submitted = false
    try {
      await this.runMaintenance(radioKey, async (link) => {
        await link.sendWithoutReply(maintenanceCommand(action))
        submitted = true
      })
    } catch (error) {
      // A reboot or reset can close the connection before the session observes the write result.
      if (!submitted) throw error
    }
  }

  readonly saveDevicePreferences = async (radioKey: string, edits: DeviceEdits, advanced: AdvancedDeviceEdits = {}) => {
    const { advancedDeviceOperations, deviceOperations } = await import('./device-settings.ts')
    const results: DeviceSaveResult[] = []
    try {
      await this.runRadioCommand(radioKey, async (link) => {
        const device = this.snapshot.device!
        const operations = [...deviceOperations(device, edits),
          ...await advancedDeviceOperations(device.capabilities.firmwareProtocolVersion, advanced)]
        const connected = () => this.attempt?.link === link && this.snapshot.phase === 'ready'
        for (const operation of operations) {
          if (!connected()) {
            results.push({ label: operation.label, status: 'skipped', reason: 'The radio disconnected.' })
            continue
          }
          try {
            await operation.write(link)
            if (operation.update && connected()) this.update({ device: operation.update(this.snapshot.device!) })
            results.push({ label: operation.label, status: 'saved' })
          } catch (error) {
            const uncertain = error instanceof CompanionError && ['timeout', 'disconnected', 'serial-io', 'protocol'].includes(error.code)
            results.push({
              label: operation.label, status: uncertain ? 'uncertain' : 'failed',
              reason: error instanceof Error ? error.message : 'The radio setting could not be saved.',
            })
          }
        }
      })
    } catch (error) {
      if (!results.length) throw error
    }
    return results
  }

  private async withDirectContact<T>(
    radioKey: string,
    recipient: string,
    command: (link: SerialLink, contact: CompanionContact) => Promise<T>,
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
      return await command(link, matches[0])
    } finally {
      this.directCommandPending = false
    }
  }

  readonly sendDirect = async (
    radioKey: string, recipient: string, timestamp: number, attempt: number, text: string, signal?: AbortSignal,
  ) => {
    const command = directMessageCommand(recipient, timestamp, attempt, text)
    return this.withDirectContact(radioKey, recipient, async (link, contact) => {
      if (contact.type === 3 && !canPostToRoom(this.getRemoteNodeAccess(radioKey, contact.publicKey))) {
        throw new Error('Sign in to the room with posting access before sending a message.')
      }
      if (contact.type === 3 && command.length - 13 > maxRoomTextBytes) {
        throw new Error(`Keep room posts within ${maxRoomTextBytes} UTF-8 bytes.`)
      }
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
    if (current && current.kind !== 'usb') return current
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
    const kind = this.connection?.kind
    const action = kind === 'lan' ? 'Connect local network' : kind === 'bluetooth' ? 'Connect Bluetooth' : 'Connect USB'
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
