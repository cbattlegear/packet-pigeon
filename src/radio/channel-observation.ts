import { validateChannelScope } from './channel-scope.ts'
import type { RxPacket } from './rx-packet.ts'

export type ChannelObservation = {
  timestamp: number
  textType: number
  text: string
  routeCode: number
  pathHashes: string[]
  hashWidth: number
  snrDb: number | null
  rssiDbm: number | null
  region: { kind: 'unknown' | 'unscoped' } | { kind: 'candidates'; names: string[] }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export async function createChannelObserver(secret: Uint8Array, regionNames: readonly string[]) {
  if (secret.length !== 16) {
    secret.fill(0)
    throw new Error('The radio returned an invalid channel key.')
  }
  const keyBytes = Uint8Array.from(secret)
  try {
    const [aes, mac, hash] = await Promise.all([
      crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']),
      crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      crypto.subtle.digest('SHA-256', keyBytes),
    ])
    const channelHash = new Uint8Array(hash)[0]
    const names = [...new Set(regionNames.map((name) => {
      const scope = validateChannelScope({ mode: 'region', name })
      if (scope.mode !== 'region') throw new Error('Invalid region name.')
      return scope.name
    }))].sort()
    const regions = await Promise.all(names.map(async (name) => {
      const key = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(name))).slice(0, 16)
      try {
        return { name, key: await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) }
      } finally { key.fill(0) }
    }))

    return async (packet: RxPacket): Promise<ChannelObservation | null> => {
      const { header, path, payload, transportCodes } = packet
      if (packet.status !== 'decoded' || header?.version !== 1 || header.typeCode !== 5
        || !path?.hashes || path.hashWidth === null || !payload || payload[0] !== channelHash
        || payload.length < 19 || (payload.length - 3) % 16 !== 0) return null

      const ciphertext = payload.slice(3)
      const signature = new Uint8Array(await crypto.subtle.sign('HMAC', mac, ciphertext))
      if (signature[0] !== payload[1] || signature[1] !== payload[2]) return null

      // Web Crypto only exposes padded CBC. Append a valid padding block, then undo CBC chaining.
      const last = ciphertext.slice(-16)
      const paddingInput = Uint8Array.from(last, (byte) => byte ^ 16)
      const paddingCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, aes, paddingInput))
      const padded = new Uint8Array(ciphertext.length + 16)
      padded.set(ciphertext)
      padded.set(paddingCipher.subarray(0, 16), ciphertext.length)
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, aes, padded))
      for (let index = 16; index < plain.length; index++) plain[index] ^= ciphertext[index - 16]
      if (plain.length < 5 || plain[4] >> 2 !== 0) return null
      const end = plain.indexOf(0, 5)
      let text: string
      try { text = decoder.decode(plain.subarray(5, end < 0 ? undefined : end)) }
      catch (error) {
        if (error instanceof TypeError) return null
        throw error
      }

      let region: ChannelObservation['region'] = { kind: 'unknown' }
      if (transportCodes?.[0] === 0) region = { kind: 'unscoped' }
      else if (transportCodes) {
        const input = new Uint8Array(payload.length + 1)
        input[0] = header.typeCode
        input.set(payload, 1)
        const matches = await Promise.all(regions.map(async ({ name, key }) => {
          const value = new Uint8Array(await crypto.subtle.sign('HMAC', key, input))
          const raw = value[0] | value[1] << 8
          const code = raw === 0 ? 1 : raw === 0xffff ? 0xfffe : raw
          return code === transportCodes[0] ? name : null
        }))
        const matchingNames = matches.filter((name): name is string => name !== null)
        if (matchingNames.length) region = { kind: 'candidates', names: matchingNames }
      }
      return {
        timestamp: new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, true),
        textType: plain[4], text, routeCode: header.routeCode,
        pathHashes: path.hashes, hashWidth: path.hashWidth, snrDb: packet.snrDb, rssiDbm: packet.rssiDbm, region,
      }
    }
  } finally { secret.fill(0); keyBytes.fill(0) }
}
