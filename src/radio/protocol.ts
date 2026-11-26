export const Command = {
  appStart: 1,
  sendDirect: 2,
  sendChannel: 3,
  contacts: 4,
  nextMessage: 10,
  resetPath: 13,
  deviceQuery: 22,
  channel: 31,
} as const

export const Response = {
  ok: 0,
  error: 1,
  contactsStart: 2,
  contact: 3,
  contactsEnd: 4,
  selfInfo: 5,
  sent: 6,
  directText: 7,
  channelText: 8,
  noMoreMessages: 10,
  deviceInfo: 13,
  disabled: 15,
  directTextV3: 16,
  channelTextV3: 17,
  channelInfo: 18,
  channelData: 27,
} as const

export const messageWaiting = 0x83
export const messageAcknowledged = 0x82

export type CompanionErrorCode =
  | 'insecure-context' | 'unsupported-browser' | 'chooser-failed' | 'open-failed'
  | 'disconnected' | 'serial-io' | 'timeout' | 'protocol' | 'device-error'
  | 'unsupported-firmware' | 'unsupported-transport'
  | 'ownership' | 'identity' | 'reconnect-failed' | 'cleanup-failed'
  | 'scope-recovery'

export class CompanionError extends Error {
  readonly code: CompanionErrorCode

  constructor(code: CompanionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CompanionError'
    this.code = code
  }
}

export interface DeviceCapabilities {
  readonly firmwareProtocolVersion: number
  readonly maxContacts: number
  readonly maxChannels: number
  readonly firmwareBuildDate: string
  readonly manufacturer: string
  readonly firmwareVersion: string | null
  readonly repeatEnabled: boolean | null
  readonly pathHashMode: number | null
}

export type RadioParameters = {
  frequencyMHz: number
  bandwidthKHz: number
  spreadingFactor: number
  codingRate: number
}

export type DevicePreferences = {
  readonly txPowerDbm: number
  readonly maxTxPowerDbm: number
  readonly latitude: number
  readonly longitude: number
  readonly advertLocation: boolean | null
  readonly telemetryPolicy: number | null
  readonly extraAcknowledgements: boolean | null
}

export interface CompanionDevice {
  readonly publicKey: string
  readonly name: string
  readonly type: number
  readonly contactMode: number
  readonly capabilities: DeviceCapabilities
  readonly preferences: DevicePreferences
  readonly radioParameters?: RadioParameters
}

export interface CompanionContact {
  readonly publicKey: string
  readonly name: string
  readonly type: number
  readonly flags: number
  readonly pathLength: number
  readonly pathHex: string
  readonly lastAdvertisedAt: number
  readonly latitude: number
  readonly longitude: number
  readonly lastModifiedAt: number
}

export interface CompanionChannel {
  readonly index: number
  readonly name: string
}

interface ReceivedMessage {
  readonly pathLength: number
  readonly snrDb: number | null
}

interface ReceivedText extends ReceivedMessage {
  readonly textType: number
  readonly senderTimestamp: number
  readonly text: string
}

type QueuedMessage =
  | (ReceivedText & {
      readonly kind: 'direct-text'
      readonly senderKeyPrefix: string
      readonly signatureHex: string | null
    })
  | (ReceivedText & {
      readonly kind: 'channel-text'
      readonly channelIndex: number
    })
  | (ReceivedMessage & {
      readonly kind: 'channel-data'
      readonly channelIndex: number
      readonly dataType: number
      readonly dataHex: string
    })

export type CompanionMessage = QueuedMessage & {
  /** Local to this receipt; the radio does not supply a message ID. */
  readonly receiptId: string
}

const decoder = new TextDecoder()

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function text(bytes: Uint8Array) {
  const end = bytes.indexOf(0)
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

function view(frame: Uint8Array, size: number) {
  if (frame.length < size) {
    throw new CompanionError('protocol', `Truncated companion response 0x${frame[0].toString(16)}.`)
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
}

export function decodeCapabilities(frame: Uint8Array): DeviceCapabilities {
  view(frame, 2)
  const version = frame[1]
  if (version < 3) {
    throw new CompanionError('unsupported-firmware', 'Companion firmware protocol v3 or newer is required.')
  }
  view(frame, 60)
  return {
    firmwareProtocolVersion: version,
    maxContacts: frame[2] * 2,
    maxChannels: frame[3],
    firmwareBuildDate: text(frame.subarray(8, 20)),
    manufacturer: text(frame.subarray(20, 60)),
    firmwareVersion: frame.length >= 80 ? text(frame.subarray(60, 80)) : null,
    repeatEnabled: frame.length >= 81 && version >= 9 ? frame[80] !== 0 : null,
    pathHashMode: frame.length >= 82 && version >= 10 ? frame[81] : null,
  }
}

export function decodeSelf(frame: Uint8Array, capabilities: DeviceCapabilities): CompanionDevice {
  const data = view(frame, 58)
  const frequency = data.getUint32(48, true)
  const bandwidth = data.getUint32(52, true)
  return {
    publicKey: hex(frame.subarray(4, 36)),
    name: text(frame.subarray(58)),
    type: frame[1],
    contactMode: frame[47],
    capabilities,
    preferences: {
      txPowerDbm: data.getInt8(2),
      maxTxPowerDbm: data.getInt8(3),
      latitude: data.getInt32(36, true) / 1e6,
      longitude: data.getInt32(40, true) / 1e6,
      advertLocation: frame[45] <= 1 ? frame[45] === 1 : null,
      telemetryPolicy: capabilities.firmwareProtocolVersion >= 5 ? frame[46] : null,
      extraAcknowledgements: capabilities.firmwareProtocolVersion >= 7 && frame[44] <= 1 ? frame[44] === 1 : null,
    },
    ...(frequency > 0 && bandwidth > 0 ? { radioParameters: {
      frequencyMHz: frequency / 1_000, bandwidthKHz: bandwidth / 1_000,
      spreadingFactor: frame[56], codingRate: frame[57],
    } } : {}),
  }
}

export function decodeContact(frame: Uint8Array): CompanionContact {
  const data = view(frame, 148)
  return {
    publicKey: hex(frame.subarray(1, 33)),
    type: frame[33],
    flags: frame[34],
    pathLength: frame[35],
    pathHex: hex(frame.subarray(36, 100)),
    name: text(frame.subarray(100, 132)),
    lastAdvertisedAt: data.getUint32(132, true),
    latitude: data.getInt32(136, true) / 1e6,
    longitude: data.getInt32(140, true) / 1e6,
    lastModifiedAt: data.getUint32(144, true),
  }
}

export function decodeChannel(frame: Uint8Array, expectedIndex: number): CompanionChannel {
  view(frame, 50)
  if (frame[1] !== expectedIndex) {
    throw new CompanionError('protocol', `Expected channel slot ${expectedIndex}, received ${frame[1]}.`)
  }
  // Channel secrets are not needed to display the channel or receive its messages.
  return { index: frame[1], name: text(frame.subarray(2, 34)) }
}

export function contactCount(frame: Uint8Array) {
  return view(frame, 5).getUint32(1, true)
}

export function decodeQueuedMessage(frame: Uint8Array): QueuedMessage {
  const code = frame[0]
  if (code === Response.channelData) {
    const data = view(frame, 9)
    if (frame.length !== 9 + frame[8]) {
      throw new CompanionError('protocol', 'Invalid queued channel data length.')
    }
    return {
      kind: 'channel-data',
      channelIndex: frame[4],
      pathLength: frame[5],
      snrDb: data.getInt8(1) / 4,
      dataType: data.getUint16(6, true),
      dataHex: hex(frame.subarray(9)),
    }
  }

  const direct = code === Response.directText || code === Response.directTextV3
  const v3 = code === Response.directTextV3 || code === Response.channelTextV3
  const start = v3 ? 4 : 1
  const header = start + (direct ? 6 : 1)
  const data = view(frame, header + 6)
  const pathLength = frame[header]
  const textType = frame[header + 1]
  const senderTimestamp = data.getUint32(header + 2, true)
  const snrDb = v3 ? data.getInt8(1) / 4 : null
  const body = header + 6
  if (direct) {
    const signatureEnd = body + (textType === 2 ? 4 : 0)
    view(frame, signatureEnd)
    return {
      kind: 'direct-text',
      senderKeyPrefix: hex(frame.subarray(start, header)),
      signatureHex: signatureEnd > body ? hex(frame.subarray(body, signatureEnd)) : null,
      pathLength, textType, senderTimestamp, snrDb,
      text: text(frame.subarray(signatureEnd)),
    }
  }
  return {
    kind: 'channel-text',
    channelIndex: frame[start],
    pathLength, textType, senderTimestamp, snrDb,
    text: text(frame.subarray(body)),
  }
}
