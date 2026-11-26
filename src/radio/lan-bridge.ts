export const lanSocketPath = '/__packet_pigeon/companion'
export const lanSocketProtocol = 'packet-pigeon.companion.v1'
export const lanMarker = '<meta name="packet-pigeon-lan" content="v1">'

export function getLanCompanionUrl(location = globalThis.location, document = globalThis.document) {
  if (location?.protocol !== 'http:' || location.hostname !== '127.0.0.1' || typeof globalThis.WebSocket !== 'function' ||
    !document?.head.querySelector('meta[name="packet-pigeon-lan"][content="v1"]')) return null
  return `ws://${location.host}${lanSocketPath}`
}
