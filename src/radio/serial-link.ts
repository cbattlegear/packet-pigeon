import { CompanionError, Response } from './protocol.ts'
import { encodeCommand, SerialFrameDecoder } from './web-serial.ts'
import type { CompanionTransport } from './transport.ts'

export interface CompanionLinkPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  close(): Promise<void>
}

interface PendingCommand {
  receive(frame: Uint8Array): void
  reject(error: CompanionError): void
  matchesPush?: (frame: Uint8Array) => boolean
}

export class SerialLink {
  private readonly port: CompanionLinkPort
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>
  private readonly onPush: (frame: Uint8Array) => void
  private readonly onError: (error: CompanionError) => void
  private readonly reading: Promise<void>
  private readonly timeoutMs: number
  private readonly transport: CompanionTransport
  private pending?: PendingCommand
  private stopped = false
  private closing?: Promise<void>

  constructor(
    port: CompanionLinkPort,
    timeoutMs: number,
    onPush: (frame: Uint8Array) => void,
    onError: (error: CompanionError) => void,
    transport: CompanionTransport = 'usb',
  ) {
    if (!port.readable || !port.writable) {
      throw new CompanionError('open-failed', 'The radio connection did not expose both streams.')
    }
    this.port = port
    this.onPush = onPush
    this.onError = onError
    this.timeoutMs = timeoutMs
    this.transport = transport
    this.writer = port.writable.getWriter()
    try {
      this.reader = port.readable.getReader()
    } catch (error) {
      this.writer.releaseLock()
      throw error
    }
    port.addEventListener('disconnect', this.onDisconnect)
    this.reading = this.read()
  }

  private readonly onDisconnect = () => {
    this.fail(new CompanionError('disconnected', 'The radio disconnected.'))
  }

  private fail(error: CompanionError) {
    if (this.stopped) return
    this.stopped = true
    this.pending?.reject(error)
    this.onError(error)
  }

  private async read() {
    const decoder = this.transport === 'bluetooth' ? null : new SerialFrameDecoder()
    try {
      while (!this.stopped) {
        const { done, value } = await this.reader.read()
        if (done) {
          this.onDisconnect()
          return
        }
        for (const frame of decoder ? decoder.read(value) : value.length ? [value] : []) {
          if (this.stopped) return
          if (frame[0] >= 0x80) {
            const pending = this.pending
            if (pending?.matchesPush?.(frame)) pending.receive(frame)
            this.onPush(frame)
          } else this.pending?.receive(frame)
        }
      }
    } catch (error) {
      this.fail(new CompanionError('serial-io', 'Could not read from the radio.', { cause: error }))
    } finally {
      this.reader.releaseLock()
    }
  }

  request<T>(
    command: Uint8Array,
    receive: (frame: Uint8Array) => { value: T } | undefined,
    matchesPush?: (frame: Uint8Array) => boolean,
  ): Promise<T> {
    if (this.stopped) return Promise.reject(new CompanionError('disconnected', 'The radio connection is closed.'))
    if (this.pending) return Promise.reject(new CompanionError('protocol', 'A companion command is already pending.'))
    const packet = this.transport === 'bluetooth' ? command : encodeCommand(command)

    return new Promise((resolve, reject) => {
      let written = false
      let result: { value: T } | undefined
      let timer: ReturnType<typeof setTimeout>
      const clear = () => {
        clearTimeout(timer)
        this.pending = undefined
      }
      const deadline = () => setTimeout(() => {
        // A late reply cannot be distinguished from the next command's reply.
        this.fail(new CompanionError('timeout', `Companion command ${command[0]} timed out. Reconnect before retrying.`))
      }, this.timeoutMs)
      const complete = () => {
        if (written && result && this.pending === pending) {
          clear()
          resolve(result.value)
        }
      }
      const pending: PendingCommand = {
        matchesPush,
        reject: (error) => {
          clear()
          reject(error)
        },
        receive: (frame) => {
          try {
            if (result) throw new CompanionError('protocol', 'Received an extra companion response.')
            result = receive(frame)
            if (this.pending !== pending) return
            if (!result) {
              clearTimeout(timer)
              timer = deadline()
            }
            complete()
          } catch (error) {
            this.fail(error instanceof CompanionError ? error :
              new CompanionError('protocol', 'Could not decode the companion response.', { cause: error }))
          }
        },
      }
      this.pending = pending
      timer = deadline()
      void this.writer.write(packet).then(() => {
        written = true
        complete()
      }, (error) => {
        this.fail(new CompanionError('serial-io', 'Could not write to the radio.', { cause: error }))
      })
    })
  }

  async sendWithoutReply(command: Uint8Array) {
    if (this.stopped) throw new CompanionError('disconnected', 'The radio connection is closed.')
    if (this.pending) throw new CompanionError('protocol', 'A companion command is already pending.')
    const packet = this.transport === 'bluetooth' ? command : encodeCommand(command)
    try {
      await this.writer.write(packet)
    } catch (cause) {
      throw new CompanionError('serial-io', 'Could not confirm delivery of the radio command.', { cause })
    }
  }

  close() {
    if (this.closing) return this.closing
    this.stopped = true
    const error = new CompanionError('disconnected', 'The radio connection was closed.')
    this.pending?.reject(error)
    this.port.removeEventListener('disconnect', this.onDisconnect)
    this.closing = this.closeStreams()
    return this.closing
  }

  private async closeStreams() {
    // Either stream may already be errored or released after physical removal.
    await Promise.allSettled([this.reader.cancel(), this.writer.abort(), this.reading])
    this.writer.releaseLock()
    await this.port.close()
  }
}

export function expectResponse(frame: Uint8Array, ...expected: number[]) {
  const code = frame[0]
  if (code === Response.error || code === Response.disabled) {
    const detail = frame.length > 1 ? ` (device error ${frame[1]})` : ''
    throw new CompanionError('device-error', `The companion rejected the command${detail}.`)
  }
  if (!expected.includes(code)) {
    throw new CompanionError('protocol', `Unexpected companion response 0x${code.toString(16)}.`)
  }
}
