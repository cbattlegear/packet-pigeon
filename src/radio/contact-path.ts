export type ContactPathWidth = 1 | 2 | 3

export const contactPathBytes = 64
export const pathUnknown = 0xff

export function parseContactPath(text: string, width: ContactPathWidth) {
  if (width !== 1 && width !== 2 && width !== 3) throw new Error('Choose a 1-, 2- or 3-byte path hash.')
  const normalized = text.trim().toLowerCase()
  const length = width * 2
  const sections = normalized ? normalized.split(/[,\s]+/) : []
  if (sections.some((section) => !/^[0-9a-f]+$/.test(section) || section.length % length !== 0)) {
    throw new Error(`Enter complete ${width}-byte hex hashes, separated by spaces or commas.`)
  }
  const hex = sections.join('')
  const count = hex.length / length
  const limit = Math.min(63, Math.floor(contactPathBytes / width))
  if (count > limit) throw new Error(`A ${width}-byte path can contain at most ${limit} hops.`)
  return { width, count, encoded: ((width - 1) << 6) | count, hex }
}

export function decodeContactPath(pathLength: number, pathHex: string) {
  if (!Number.isInteger(pathLength) || pathLength < 0 || pathLength >= pathUnknown) return null
  const width = ((pathLength >> 6) + 1) as ContactPathWidth
  const count = pathLength & 63
  if (width > 3 || width * count > contactPathBytes) return null
  const length = count * width * 2
  const hex = pathHex.slice(0, length).toLowerCase()
  if (hex.length !== length || !/^[0-9a-f]*$/.test(hex)) return null
  const hops = Array.from({ length: count }, (_, index) => hex.slice(index * width * 2, (index + 1) * width * 2))
  return { width, hops }
}
