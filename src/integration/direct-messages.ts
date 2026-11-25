import type { CompanionPush, CompanionSession } from '../radio/companion-session.ts'
import { decodeDirectAck, directTextBytes, expectedDirectAck } from '../radio/direct-message.ts'
import { channelTextBytes } from '../radio/channel-message.ts'
import { messageAcknowledged } from '../radio/protocol.ts'
import {
  openRadioStorage, radioKeyFromPublicKey, RadioStorageError, validateDirectOptions,
} from '../storage/index.ts'
import type {
  ChannelMessageChange, DirectChange, DirectChangeResult, DirectSendOptions, RadioData, RadioKey, StoredMessage,
} from '../storage/index.ts'

type Source = Pick<CompanionSession, 'getSnapshot' | 'subscribe' | 'subscribeToPushes' | 'sendDirect' | 'resetDirectPath' | 'sendChannel'>
type PendingChange = { key: RadioKey } & (
  | { type: 'direct'; change: DirectChange }
  | { type: 'channel'; change: ChannelMessageChange }
)
type PendingDraft = { key: RadioKey; conversationId: string; text: string; version: number }
type ActiveSend = {
  key: RadioKey
  id: string
  cancelled: boolean
  delivered: boolean
  currentCode: string | null
  codes: Set<string>
  earlyAcks: Map<string, number>
  controller: AbortController
  wake?: () => void
}

export type DirectStatus = {
  key: RadioKey | null
  data: RadioData | null
  activeId: string | null
  cancelling: boolean
  pending: number
  error: string | null
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'The direct-message action failed.'
}

function storageFailure(error: unknown) {
  return !(error instanceof RadioStorageError) || (error.code !== 'identity' && error.code !== 'update')
}

export class DirectMessages {
  private readonly events = new EventTarget()
  private readonly source: Source
  private readonly openStorage: typeof openRadioStorage
  private readonly timeoutFor: (suggested: number) => number
  private readonly pendingChanges: PendingChange[] = []
  private readonly pendingDrafts = new Map<string, PendingDraft>()
  private readonly draftEditsThisVisit = new Map<string, string>()
  private tail: Promise<void> = Promise.resolve()
  private draftVersion = 0
  private loadVersion = 0
  private readyKey: string | null = null
  private active?: ActiveSend
  private status: DirectStatus = {
    key: null, data: null, activeId: null, cancelling: false, pending: 0, error: null,
  }

  constructor(
    source: Source,
    openStorage = openRadioStorage,
    timeoutFor = (suggested: number) => Math.max(1_000, Math.min(suggested, 120_000)),
  ) {
    this.source = source
    this.openStorage = openStorage
    this.timeoutFor = timeoutFor
    source.subscribe(() => this.connectionChanged())
    source.subscribeToPushes((push) => this.receivePush(push))
    this.connectionChanged()
  }

  readonly subscribe = (listener: () => void) => {
    this.events.addEventListener('change', listener)
    return () => this.events.removeEventListener('change', listener)
  }

  readonly getSnapshot = () => this.status

  private update(update: Partial<DirectStatus>) {
    this.status = { ...this.status, ...update }
    this.events.dispatchEvent(new Event('change'))
  }

  private pendingCount() {
    return this.pendingChanges.length + this.pendingDrafts.size
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private show(key: RadioKey, result: DirectChangeResult) {
    if (this.status.key === key) this.update({ data: result.data })
    if (result.ambiguous) {
      this.update({ error: 'An acknowledgement matches multiple messages and was not attributed.' })
    }
    const active = this.active
    if (active?.key === key && result.message?.id === active.id && result.message.outgoing?.status === 'delivered') {
      active.delivered = true
      active.controller.abort()
      active.wake?.()
    }
  }

  private async apply(key: RadioKey, change: DirectChange, retainOnFailure: boolean) {
    return this.serial(async () => {
      if (this.pendingChanges.length) {
        if (retainOnFailure) this.pendingChanges.push({ key, type: 'direct', change })
        this.update({ pending: this.pendingCount(), error: 'Unsaved message updates need attention. Keep this page open and retry saving.' })
        throw new Error('Retry saving the pending message updates first.')
      }
      let storage: Awaited<ReturnType<typeof openRadioStorage>> | undefined
      try {
        storage = await this.openStorage()
        const result = await storage.changeDirect(key, change)
        this.show(key, result)
        return result
      } catch (error) {
        if (retainOnFailure && storageFailure(error)) {
          this.pendingChanges.push({ key, type: 'direct', change })
          this.update({
            pending: this.pendingCount(),
            error: `Could not save a message update: ${messageOf(error)} Keep this page open and retry saving.`,
          })
          this.active?.controller.abort()
          this.active?.wake?.()
        }
        throw error
      } finally {
        storage?.close()
      }
    })
  }

  private async applyChannel(key: RadioKey, change: ChannelMessageChange, retainOnFailure: boolean) {
    return this.serial(async () => {
      if (this.pendingChanges.length) {
        if (retainOnFailure) this.pendingChanges.push({ key, type: 'channel', change })
        this.update({ pending: this.pendingCount(), error: 'Unsaved message updates need attention. Keep this page open and retry saving.' })
        throw new Error('Retry saving the pending message updates first.')
      }
      let storage: Awaited<ReturnType<typeof openRadioStorage>> | undefined
      try {
        storage = await this.openStorage()
        const result = await storage.changeChannelMessage(key, change)
        this.show(key, result)
        return result
      } catch (error) {
        if (retainOnFailure && storageFailure(error)) {
          this.pendingChanges.push({ key, type: 'channel', change })
          this.update({
            pending: this.pendingCount(),
            error: `Could not save a message update: ${messageOf(error)} Keep this page open and retry saving.`,
          })
        }
        throw error
      } finally {
        storage?.close()
      }
    })
  }

  readonly load = async (publicKey: string) => {
    const version = ++this.loadVersion
    try {
      const key = radioKeyFromPublicKey(publicKey)
      this.update({ key, data: this.status.key === key ? this.status.data : null })
      await this.serial(async () => {
        const storage = await this.openStorage()
        try {
          const data = await storage.read(key)
          if (version === this.loadVersion && this.status.key === key) this.update({ data })
        } finally {
          storage.close()
        }
      })
    } catch (error) {
      if (version === this.loadVersion) this.update({ error: messageOf(error) })
    }
  }

  readonly draft = (key: RadioKey, conversationId: string) => {
    const name = `${key}:${conversationId}`
    const pending = this.pendingDrafts.get(name)
    return this.draftEditsThisVisit.get(name) ?? pending?.text ?? (this.status.key === key
      ? this.status.data?.drafts.find((entry) => entry.conversationId === conversationId)?.text : undefined) ?? ''
  }

  readonly saveDraft = (key: RadioKey, conversationId: string, text: string, persist = true) => {
    const name = `${key}:${conversationId}`
    if (!persist) {
      this.draftEditsThisVisit.set(name, text)
      return Promise.resolve()
    }
    this.draftEditsThisVisit.delete(name)
    const draft: PendingDraft = { key, conversationId, text, version: ++this.draftVersion }
    this.pendingDrafts.set(name, draft)
    this.update({ pending: this.pendingCount() })
    return this.serial(async () => {
      let storage: Awaited<ReturnType<typeof openRadioStorage>> | undefined
      try {
        storage = await this.openStorage()
        await storage.update(key, { draft: { conversationId, text: text || null } })
        const data = await storage.read(key)
        if (this.pendingDrafts.get(name)?.version === draft.version) this.pendingDrafts.delete(name)
        const pending = this.pendingCount()
        this.update({
          ...(this.status.key === key ? { data } : {}),
          pending,
          ...(pending === 0 && this.status.error?.startsWith('Could not save the draft:') ? { error: null } : {}),
        })
      } catch (error) {
        this.update({
          pending: this.pendingCount(),
          error: `Could not save the draft: ${messageOf(error)} Keep this page open and retry saving.`,
        })
        throw error
      } finally {
        storage?.close()
      }
    })
  }

  readonly markRead = async (key: RadioKey, ids: readonly string[]) => {
    if (!ids.length) return
    await this.serial(async () => {
      const storage = await this.openStorage()
      try {
        await storage.update(key, { markRead: ids })
        const data = await storage.read(key)
        if (this.status.key === key) this.update({ data })
      } finally {
        storage.close()
      }
    })
  }

  readonly saveOptions = async (key: RadioKey, options: DirectSendOptions) => {
    const valid = validateDirectOptions(options)
    await this.serial(async () => {
      const storage = await this.openStorage()
      try {
        await storage.update(key, { directSendOptions: valid })
        const data = await storage.read(key)
        if (this.status.key === key) this.update({ data, error: null })
      } finally {
        storage.close()
      }
    })
  }

  readonly retrySaving = async () => {
    await this.serial(async () => {
      let storage: Awaited<ReturnType<typeof openRadioStorage>> | undefined
      try {
        storage = await this.openStorage()
        while (this.pendingChanges.length) {
          const pending = this.pendingChanges[0]
          const result = pending.type === 'direct'
            ? await storage.changeDirect(pending.key, pending.change)
            : await storage.changeChannelMessage(pending.key, pending.change)
          this.pendingChanges.shift()
          this.show(pending.key, result)
          this.update({ pending: this.pendingCount() })
        }
        for (const [name, draft] of this.pendingDrafts) {
          await storage.update(draft.key, { draft: { conversationId: draft.conversationId, text: draft.text || null } })
          if (this.pendingDrafts.get(name)?.version === draft.version) this.pendingDrafts.delete(name)
          const data = await storage.read(draft.key)
          this.update({
            ...(this.status.key === draft.key ? { data } : {}),
            pending: this.pendingCount(),
          })
        }
        this.update({ error: null, pending: this.pendingCount() })
      } catch (error) {
        this.update({ error: `Could not save message changes: ${messageOf(error)} Keep this page open and retry saving.` })
      } finally {
        storage?.close()
      }
    })
  }

  private isConnected(key: RadioKey) {
    const snapshot = this.source.getSnapshot()
    return snapshot.phase === 'ready' && snapshot.device?.publicKey === key
  }

  private connectionChanged() {
    const snapshot = this.source.getSnapshot()
    const ready = snapshot.phase === 'ready' ? snapshot.device?.publicKey ?? null : null
    if (ready && ready !== this.readyKey) {
      this.readyKey = ready
      const key = radioKeyFromPublicKey(ready)
      void this.apply(key, { kind: 'interrupt', exceptId: this.active?.id }, true).catch((error: unknown) => {
        this.update({ error: `Could not recover interrupted messages: ${messageOf(error)}` })
      })
      void this.applyChannel(key, { kind: 'interrupt', exceptId: this.active?.id }, true).catch((error: unknown) => {
        this.update({ error: `Could not recover interrupted channel messages: ${messageOf(error)}` })
      })
    } else if (!ready) {
      this.readyKey = null
      this.active?.controller.abort()
      this.active?.wake?.()
    }
  }

  private receivePush(push: CompanionPush) {
    if (push.code !== messageAcknowledged) return
    const publicKey = this.source.getSnapshot().device?.publicKey
    if (!publicKey) return
    try {
      const key = radioKeyFromPublicKey(publicKey)
      const ack = decodeDirectAck(push.payload)
      const active = this.active
      if (active?.key === key && active.codes.has(ack.code)) {
        if (active.currentCode === ack.code) active.earlyAcks.set(ack.code, ack.roundTripMs)
        active.controller.abort()
        active.wake?.()
      }
      void this.apply(key, { kind: 'ack', ...ack }, true).catch((error: unknown) => {
        this.update({ error: `Could not record an acknowledgement: ${messageOf(error)} Keep this page open and retry saving.` })
      })
    } catch (error) {
      this.update({ error: `Invalid acknowledgement: ${messageOf(error)}` })
    }
  }

  private start(key: RadioKey, id: string) {
    if (this.active) throw new Error('Finish or cancel the current message before sending another.')
    const active: ActiveSend = {
      key, id, cancelled: false, delivered: false, currentCode: null, codes: new Set(),
      earlyAcks: new Map(), controller: new AbortController(),
    }
    this.active = active
    this.update({ activeId: id, cancelling: false, error: null })
    return active
  }

  private finish(active: ActiveSend) {
    if (this.active !== active) return
    this.active = undefined
    this.update({ activeId: null, cancelling: false })
  }

  readonly send = async (key: RadioKey, recipient: string, text: string, options: DirectSendOptions, persistDraft = true) => {
    let active: ActiveSend | undefined
    try {
      directTextBytes(text)
      const target = radioKeyFromPublicKey(recipient)
      const valid = validateDirectOptions(options)
      const id = crypto.randomUUID()
      active = this.start(key, id)
      const conversationId = `direct:${target}`
      await this.saveDraft(key, conversationId, text, persistDraft)
      if (!this.isConnected(key)) throw new Error('Connect the selected radio before sending. Your draft was kept.')
      if (this.pendingCount()) throw new Error('Retry saving the pending message changes before sending.')
      if (active.cancelled) throw new Error('Sending was cancelled. Your draft was kept.')
      const result = await this.apply(key, {
        kind: 'begin', id, recipient: target, text, options: valid, now: Date.now(),
      }, false)
      if (!result.message?.outgoing) throw new Error('The outgoing message could not be saved.')
      const draftKey = `${key}:${conversationId}`
      if (this.draftEditsThisVisit.get(draftKey) === text) this.draftEditsThisVisit.set(draftKey, '')
      void this.run(active, result.message)
      return true
    } catch (error) {
      if (active) this.finish(active)
      this.update({ error: messageOf(error) })
      return false
    }
  }

  readonly sendChannel = async (
    key: RadioKey, index: number, channelName: string, text: string, persistDraft = true, resend = false,
  ) => {
    let active: ActiveSend | undefined
    try {
      active = this.start(key, crypto.randomUUID())
      const conversationId = `channel:${index}`
      if (!resend) await this.saveDraft(key, conversationId, text, persistDraft)
      const snapshot = this.source.getSnapshot()
      if (!this.isConnected(key) || !snapshot.device) throw new Error('Connect the selected radio before sending. Your draft was kept.')
      const senderName = snapshot.device.name
      channelTextBytes(text, senderName)
      if (this.pendingCount()) throw new Error('Retry saving the pending message changes before sending.')
      const result = await this.applyChannel(key, {
        kind: 'begin', id: active.id, index, channelName, senderName, text, now: Date.now(),
        clearDraft: !resend && persistDraft,
      }, false)
      if (!result.message?.channelOutgoing) throw new Error('The outgoing channel message could not be saved.')
      const draftKey = `${key}:${conversationId}`
      if (!resend && this.draftEditsThisVisit.get(draftKey) === text) this.draftEditsThisVisit.set(draftKey, '')
      void this.runChannel(active, index, result.message)
      return true
    } catch (error) {
      if (active) this.finish(active)
      this.update({ error: messageOf(error) })
      return false
    }
  }

  readonly deleteChannelMessage = async (key: RadioKey, id: string) => {
    if (this.active?.id === id && this.active.key === key) throw new Error('Wait for sending to finish before deleting this message.')
    await this.applyChannel(key, { kind: 'remove', id }, false)
  }

  readonly blockChannelSender = async (key: RadioKey, name: string) => {
    await this.serial(async () => {
      const storage = await this.openStorage()
      try {
        await storage.update(key, { blockedChannelSender: { name, blocked: true } })
        const data = await storage.read(key)
        if (this.status.key === key) this.update({ data })
      } finally {
        storage.close()
      }
    })
  }

  private async runChannel(active: ActiveSend, index: number, message: StoredMessage) {
    try {
      const outgoing = message.channelOutgoing
      if (!outgoing) return
      let change: ChannelMessageChange
      try {
        if (!this.isConnected(active.key)) throw new Error('The radio disconnected before sending.')
        await this.source.sendChannel(
          active.key, index, outgoing.channelName, outgoing.senderName, outgoing.wireTimestamp, message.text,
        )
        change = { kind: 'accepted', id: active.id, wireTimestamp: outgoing.wireTimestamp }
      } catch (error) {
        change = {
          kind: 'uncertain', id: active.id, wireTimestamp: outgoing.wireTimestamp,
          error: `${messageOf(error)} The packet may have been transmitted.`,
        }
      }
      try {
        await this.applyChannel(active.key, change, true)
      } catch (error) {
        this.update({ error: `Could not save the channel message state: ${messageOf(error)} Keep this page open and retry saving.` })
      }
    } finally {
      this.finish(active)
    }
  }

  readonly retry = async (key: RadioKey, id: string, options: DirectSendOptions) => {
    let active: ActiveSend | undefined
    try {
      const valid = validateDirectOptions(options)
      active = this.start(key, id)
      if (!this.isConnected(key)) throw new Error('Connect the selected radio before retrying.')
      if (this.pendingCount()) throw new Error('Retry saving the pending message changes before retrying.')
      if (active.cancelled) throw new Error('Retry was cancelled.')
      const result = await this.apply(key, { kind: 'retry', id, options: valid, now: Date.now() }, false)
      if (!result.message?.outgoing) throw new Error('The outgoing message could not be saved.')
      void this.run(active, result.message)
      return true
    } catch (error) {
      if (active) this.finish(active)
      this.update({ error: messageOf(error) })
      return false
    }
  }

  readonly cancel = () => {
    if (!this.active) return
    this.active.cancelled = true
    this.active.controller.abort()
    this.active.wake?.()
    this.update({ cancelling: true })
  }

  private wait(active: ActiveSend, milliseconds: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(finish, milliseconds)
      function finish() {
        clearTimeout(timer)
        active.wake = undefined
        resolve()
      }
      active.wake = finish
      if (active.cancelled || active.delivered || !this.isConnected(active.key) || this.pendingChanges.length) finish()
    })
  }

  private async run(active: ActiveSend, message: StoredMessage) {
    try {
      const outgoing = message.outgoing
      if (!outgoing) return
      const { wireTimestamp, recipient, options } = outgoing
      for (const ack of outgoing.acknowledgements) active.codes.add(ack.code)
      const total = options.directAttempts + options.floodAttempts
      let failure = `No acknowledgement after ${total} attempts. A late acknowledgement can still update this message.`
      try {
        for (let attempt = 0; attempt < total; attempt++) {
          await this.tail
          if (active.delivered) return
          if (active.cancelled) throw new Error('Cancelled. Already transmitted packets cannot be recalled.')
          if (!this.isConnected(active.key)) throw new Error('The radio disconnected. A packet may already have been transmitted.')
          if (this.pendingChanges.length) throw new Error('Sending stopped because a message update could not be saved.')
          if (active.controller.signal.aborted) throw new Error('Sending stopped because an acknowledgement could not be verified.')
          if (attempt === options.directAttempts && options.floodAttempts > 0) {
            await this.source.resetDirectPath(active.key, recipient, active.controller.signal)
            if (active.delivered) return
            if (active.cancelled) throw new Error('Cancelled. Already transmitted packets cannot be recalled.')
          }
          const code = await expectedDirectAck(active.key, wireTimestamp, attempt, message.text)
          const prepared = await this.apply(active.key, {
            kind: 'attempt', id: active.id, wireTimestamp, attempt: attempt + 1, code,
          }, false)
          if (prepared.message?.outgoing?.status === 'delivered' || active.delivered) return
          if (active.cancelled) throw new Error('Cancelled. Already transmitted packets cannot be recalled.')
          active.currentCode = code
          active.codes.add(code)
          const receipt = await this.source.sendDirect(active.key, recipient, wireTimestamp, attempt, message.text, active.controller.signal)
          if (receipt.expectedAck !== code) {
            throw new Error('The radio returned an unexpected acknowledgement code. Delivery cannot be verified.')
          }
          try {
            await this.apply(active.key, {
              kind: 'accepted', id: active.id, wireTimestamp, attempt: attempt + 1, code, route: receipt.route,
            }, true)
          } catch (error) {
            const early = active.earlyAcks.get(code)
            if (early !== undefined) {
              await this.apply(active.key, { kind: 'ack', code, roundTripMs: early }, true).catch(() => {})
            }
            throw error
          }
          const early = active.earlyAcks.get(code)
          if (early !== undefined) await this.apply(active.key, { kind: 'ack', code, roundTripMs: early }, true)
          if (active.delivered) return
          if (active.cancelled) throw new Error('Cancelled. Already transmitted packets cannot be recalled.')
          await this.wait(active, this.timeoutFor(receipt.timeoutMs))
        }
        if (active.delivered) return
        if (active.cancelled) failure = 'Cancelled. Already transmitted packets cannot be recalled.'
        else if (!this.isConnected(active.key)) failure = 'The radio disconnected. A packet may already have been transmitted.'
      } catch (error) {
        await this.tail
        if (active.delivered) return
        failure = active.cancelled ? 'Cancelled. Already transmitted packets cannot be recalled.' : messageOf(error)
      }
      try {
        await this.apply(active.key, { kind: 'failed', id: active.id, wireTimestamp, error: failure }, true)
      } catch (error) {
        this.update({ error: `Could not save the final message state: ${messageOf(error)} Keep this page open and retry saving.` })
      }
    } finally {
      this.finish(active)
    }
  }
}
