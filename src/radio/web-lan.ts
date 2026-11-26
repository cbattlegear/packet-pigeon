import { lanSocketProtocol } from './lan-bridge.ts'
import { CompanionError } from './protocol.ts'
import type { CompanionLinkPort } from './serial-link.ts'

export async function openLanPort(url: string): Promise<CompanionLinkPort> {
  const socket = new WebSocket(url, lanSocketProtocol)
  socket.binaryType = 'arraybuffer'
  const port = new EventTarget()
  let incoming: ReadableStreamDefaultController<Uint8Array> | undefined
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { incoming = controller },
    cancel() { incoming = undefined },
  }, { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength })
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      if (socket.readyState !== WebSocket.OPEN) throw new CompanionError('disconnected', 'The local bridge is disconnected.')
      socket.send(new Uint8Array(bytes))
    },
  })
  socket.addEventListener('message', (event) => {
    if (!incoming) return
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > (incoming.desiredSize ?? 0)) {
      socket.close(4000, 'Invalid or oversized frame stream')
      return
    }
    if (event.data.byteLength) incoming.enqueue(new Uint8Array(event.data))
  })
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener('close', () => {
      incoming?.close()
      incoming = undefined
      port.dispatchEvent(new Event('disconnect'))
      resolve()
    }, { once: true })
  })

  await new Promise<void>((resolve, reject) => {
    const failed = () => finish(new CompanionError('open-failed', 'Could not open the local companion bridge. Check that it is running.'))
    const ready = () => socket.protocol === lanSocketProtocol ? finish() : failed()
    const timer = setTimeout(failed, 5_000)
    function finish(error?: CompanionError) {
      clearTimeout(timer)
      socket.removeEventListener('open', ready)
      socket.removeEventListener('close', failed)
      socket.removeEventListener('error', failed)
      if (error) {
        socket.close()
        reject(error)
      } else resolve()
    }
    socket.addEventListener('close', failed)
    socket.addEventListener('error', failed)
    socket.addEventListener('open', ready)
  })
  return Object.assign(port, { readable, writable, async close() {
    if (socket.readyState === WebSocket.CLOSED) return
    socket.close(1000)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CompanionError('cleanup-failed', 'Could not close the local companion bridge.')), 5_000)
      void closed.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  } })
}
