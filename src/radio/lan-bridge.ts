export const lanSocketPath = '/__packet_pigeon/companion'
export const lanStatusPath = '/__packet_pigeon/companion-status'
export const lanSocketProtocol = 'packet-pigeon.companion.v1'
export const lanProtocolHeader = 'X-Packet-Pigeon-Companion'

export function getLanCompanionUrl(location = globalThis.location) {
  if (location?.protocol !== 'http:' || location.hostname !== '127.0.0.1' || typeof globalThis.WebSocket !== 'function') return null
  return `ws://${location.host}${lanSocketPath}`
}

export async function detectLanBridge(signal: AbortSignal) {
  if (!getLanCompanionUrl()) return false
  try {
    // The app shell may be cached, but bridge availability must come from the running server.
    const status = await fetch(lanStatusPath, { cache: 'no-store', redirect: 'error', signal })
    return status.status === 204 && status.headers.get(lanProtocolHeader) === lanSocketProtocol
  } catch { return false }
}
