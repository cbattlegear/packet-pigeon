export type CompanionTransport = 'usb' | 'bluetooth' | 'lan'
export const maxCompanionFrameSize = 176

export function framedTransport(transport: CompanionTransport | null) {
  return transport === 'usb' || transport === 'lan'
}

export function transportName(transport: CompanionTransport) {
  if (transport === 'lan') return 'local network'
  return transport === 'bluetooth' ? 'Bluetooth' : 'USB'
}
