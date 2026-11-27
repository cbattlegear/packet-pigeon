import { CompanionError } from './protocol.ts'
import type { CompanionLinkPort } from './serial-link.ts'

export const meshCoreBluetooth = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  receive: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  transmit: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
} as const

interface BluetoothCharacteristic extends EventTarget {
  readonly properties: { write?: boolean; writeWithoutResponse?: boolean; notify?: boolean; indicate?: boolean }
  readonly value?: DataView
  startNotifications(): Promise<BluetoothCharacteristic>
  writeValueWithResponse?(bytes: Uint8Array<ArrayBuffer>): Promise<void>
  writeValueWithoutResponse?(bytes: Uint8Array<ArrayBuffer>): Promise<void>
}

interface BluetoothGatt {
  readonly connected: boolean
  connect(): Promise<BluetoothGatt>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<{
    getCharacteristic(uuid: string): Promise<BluetoothCharacteristic>
  }>
}

export interface CompanionBluetoothDevice extends EventTarget {
  readonly gatt?: BluetoothGatt
  readonly id?: string
}

export interface WebBluetoothEnvironment {
  readonly secureContext: boolean
  readonly bluetooth?: {
    requestDevice(options: { filters: { services: string[] }[] }): Promise<CompanionBluetoothDevice>
    getDevices?(): Promise<CompanionBluetoothDevice[]>
  }
}

export function browserBluetoothEnvironment(): WebBluetoothEnvironment {
  const navigator = globalThis.navigator as (Navigator & { bluetooth?: WebBluetoothEnvironment['bluetooth'] }) | undefined
  return { secureContext: globalThis.isSecureContext === true, bluetooth: navigator?.bluetooth }
}

export function getWebBluetoothSupport(environment = browserBluetoothEnvironment()) {
  if (!environment.secureContext) {
    return { supported: false, error: new CompanionError('insecure-context', 'Bluetooth requires HTTPS or localhost.') } as const
  }
  if (!environment.bluetooth) {
    return { supported: false, error: new CompanionError('unsupported-browser', 'This browser does not support Web Bluetooth.') } as const
  }
  return { supported: true } as const
}

export async function chooseBluetoothDevice(environment: WebBluetoothEnvironment) {
  const support = getWebBluetoothSupport(environment)
  if (!support.supported) throw support.error
  try {
    return await environment.bluetooth!.requestDevice({ filters: [{ services: [meshCoreBluetooth.service] }] })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return null
    throw new CompanionError(
      'chooser-failed', 'Could not select a Bluetooth radio. Check browser and system Bluetooth permissions.', { cause },
    )
  }
}

class BluetoothPort extends EventTarget implements CompanionLinkPort {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  private incoming?: ReadableStreamDefaultController<Uint8Array>
  private readonly device: CompanionBluetoothDevice
  private readonly gatt: BluetoothGatt
  private readonly transmit: BluetoothCharacteristic
  disconnected = false

  constructor(
    device: CompanionBluetoothDevice,
    gatt: BluetoothGatt,
    transmit: BluetoothCharacteristic,
    write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
  ) {
    super()
    this.device = device
    this.gatt = gatt
    this.transmit = transmit
    this.readable = new ReadableStream({
      start: (controller) => { this.incoming = controller },
      cancel: () => { this.incoming = undefined },
    })
    this.writable = new WritableStream({ write: (bytes) => write(Uint8Array.from(bytes)) })
    transmit.addEventListener('characteristicvaluechanged', this.onNotification)
    device.addEventListener('gattserverdisconnected', this.onDisconnect)
  }

  private readonly onNotification = () => {
    const value = this.transmit.value
    if (value?.byteLength && this.incoming) {
      this.incoming.enqueue(Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)))
    }
  }

  private readonly onDisconnect = () => {
    if (this.gatt.connected) return
    this.disconnected = true
    this.detach()
    this.dispatchEvent(new Event('disconnect'))
  }

  private detach() {
    this.transmit.removeEventListener('characteristicvaluechanged', this.onNotification)
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnect)
    this.incoming?.close()
    this.incoming = undefined
  }

  async close() {
    this.detach()
    if (this.gatt.connected) this.gatt.disconnect()
  }
}

export async function openBluetoothPort(device: CompanionBluetoothDevice): Promise<CompanionLinkPort> {
  const gatt = device.gatt
  if (!gatt) throw new CompanionError('open-failed', 'The selected Bluetooth device has no GATT connection.')
  let port: BluetoothPort | undefined
  try {
    const connected = await gatt.connect()
    const service = await connected.getPrimaryService(meshCoreBluetooth.service)
    const receive = await service.getCharacteristic(meshCoreBluetooth.receive)
    const transmit = await service.getCharacteristic(meshCoreBluetooth.transmit)
    const withResponse = receive.properties.write && receive.writeValueWithResponse?.bind(receive)
    const withoutResponse = receive.properties.writeWithoutResponse && receive.writeValueWithoutResponse?.bind(receive)
    const write = withResponse || withoutResponse
    if (!write || (!transmit.properties.notify && !transmit.properties.indicate)) {
      throw new CompanionError('unsupported-firmware', 'The Bluetooth radio does not expose the required MeshCore write and notification capabilities.')
    }
    port = new BluetoothPort(device, connected, transmit, write)
    await transmit.startNotifications()
    if (port.disconnected || !connected.connected) {
      throw new CompanionError('disconnected', 'The Bluetooth radio disconnected during setup.')
    }
    return port
  } catch (cause) {
    try {
      if (port) await port.close()
      else if (gatt.connected) gatt.disconnect()
    } catch (error) {
      throw new CompanionError('cleanup-failed', 'Could not release the Bluetooth radio. Reload this tab before reconnecting.', { cause: error })
    }
    if (cause instanceof CompanionError) throw cause
    if (cause instanceof DOMException && cause.name === 'NotFoundError') {
      throw new CompanionError('unsupported-firmware', 'The selected Bluetooth radio does not expose the MeshCore companion service and characteristics.', { cause })
    }
    throw new CompanionError('open-failed', 'Could not open the Bluetooth radio. Check pairing and Bluetooth permissions.', { cause })
  }
}
