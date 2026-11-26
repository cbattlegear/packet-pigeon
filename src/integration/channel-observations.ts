import { createChannelObserver } from '../radio/channel-observation.ts'
import type { ChannelObservation } from '../radio/channel-observation.ts'
import type { CompanionSession } from '../radio/companion-session.ts'
import type { NamedRegion } from '../radio/channel-scope.ts'
import { decodeRxPacket, rxPacketPush } from '../radio/rx-packet.ts'

export type ChannelObservationSource = Pick<CompanionSession, 'getSnapshot' | 'subscribe' | 'subscribeToPushes' | 'readChannelObservationKey'>
export type CapturedChannelObservation = ChannelObservation & { id: number; receivedAt: number }
type Status = { phase: 'idle' | 'starting' | 'active' | 'error'; error: string | null; dropped: number; evicted: number; entries: CapturedChannelObservation[] }
const limit = 500

export class ChannelObservations {
  private readonly events = new EventTarget()
  private readonly source: ChannelObservationSource
  private status: Status = { phase: 'idle', error: null, dropped: 0, evicted: 0, entries: [] }
  private generation = 0
  private nextId = 0
  private pending = 0
  private tail: Promise<void> = Promise.resolve()
  private unsubscribePush?: () => void
  private unsubscribeSession?: () => void

  constructor(source: ChannelObservationSource) { this.source = source }

  readonly subscribe = (listener: () => void) => {
    this.events.addEventListener('change', listener)
    return () => this.events.removeEventListener('change', listener)
  }

  readonly getSnapshot = () => this.status

  private update(update: Partial<Status>) {
    this.status = { ...this.status, ...update }
    this.events.dispatchEvent(new Event('change'))
  }

  readonly stop = (error: string | null = null) => {
    ++this.generation
    this.unsubscribePush?.()
    this.unsubscribeSession?.()
    this.unsubscribePush = undefined
    this.unsubscribeSession = undefined
    this.update({ phase: error ? 'error' : 'idle', error, entries: [], dropped: 0, evicted: 0 })
  }

  readonly start = async (radioKey: string, channel: { index: number; name: string }, regions: readonly (string | NamedRegion)[]) => {
    this.stop()
    const generation = this.generation
    const matches = () => {
      const snapshot = this.source.getSnapshot()
      return snapshot.phase === 'ready' && snapshot.transport === 'usb' && snapshot.device?.publicKey === radioKey
        && snapshot.channels.some((entry) => entry.index === channel.index && entry.name === channel.name)
    }
    if (!matches()) {
      this.stop('Connect the selected radio by USB and refresh its channels before observing.')
      return
    }
    this.update({ phase: 'starting' })
    this.unsubscribeSession = this.source.subscribe(() => {
      if (!matches()) this.stop('Observation stopped because the radio or channel changed. Start it again after reconnecting.')
    })
    try {
      const secret = await this.source.readChannelObservationKey(radioKey, channel.index, channel.name)
      if (generation !== this.generation) { secret.fill(0); return }
      const observe = await createChannelObserver(secret, regions)
      if (generation !== this.generation) return
      if (!matches()) {
        this.stop('Observation stopped because the radio or channel changed. Start it again after reconnecting.')
        return
      }
      this.unsubscribePush = this.source.subscribeToPushes(({ code, payload }) => {
        if (code !== rxPacketPush || generation !== this.generation) return
        if (this.pending >= limit) {
          this.update({ dropped: this.status.dropped + 1 })
          return
        }
        const receivedAt = Date.now()
        this.pending++
        const work = this.tail.then(async () => {
          if (generation !== this.generation) return
          const entry = await observe(decodeRxPacket(payload))
          if (!entry || generation !== this.generation) return
          this.update({
            entries: [{ ...entry, id: ++this.nextId, receivedAt }, ...this.status.entries].slice(0, limit),
            evicted: this.status.evicted + (this.status.entries.length === limit ? 1 : 0),
          })
        })
        this.tail = work.catch((error: unknown) => {
          if (generation === this.generation) this.stop(error instanceof Error ? error.message : 'Packet observation failed.')
        }).finally(() => { this.pending-- })
      })
      this.update({ phase: 'active' })
    } catch (error) {
      if (generation === this.generation) this.stop(error instanceof Error ? error.message : 'Could not start packet observation.')
    }
  }
}
