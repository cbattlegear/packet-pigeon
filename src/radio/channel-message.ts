import { Command } from './protocol.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const maxChannelPayloadBytes = 160

export function channelTextLimit(senderName: string) {
  const name = encoder.encode(senderName)
  if (senderName.includes('\0') || decoder.decode(name) !== senderName || name.length > 31) {
    throw new Error('The radio sender name is invalid. Reconnect and check the radio name.')
  }
  return maxChannelPayloadBytes - name.length - 2
}

export function channelTextBytes(text: string, senderName: string) {
  const limit = channelTextLimit(senderName)
  const bytes = encoder.encode(text)
  if (!bytes.length || bytes.length > limit || text.includes('\0') || decoder.decode(bytes) !== text) {
    throw new Error(`Enter a message of 1 to ${limit} valid UTF-8 bytes without NUL characters. The radio adds its sender name.`)
  }
  return bytes
}

export function channelMessageCommand(index: number, timestamp: number, text: string, senderName: string) {
  if (!Number.isInteger(index) || index < 0 || index > 255
    || !Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
    throw new Error('Invalid channel slot or message timestamp.')
  }
  const body = channelTextBytes(text, senderName)
  const command = new Uint8Array(7 + body.length)
  command.set([Command.sendChannel, 0, index])
  new DataView(command.buffer).setUint32(3, timestamp, true)
  command.set(body, 7)
  return command
}
