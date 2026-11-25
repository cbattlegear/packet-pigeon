export type Coordinates = { lat: number; lon: number }
export type NodeSource = 'local' | 'discovery' | 'public'

export const roles = {
  1: 'Companion',
  2: 'Repeater',
  3: 'Room server',
  4: 'Sensor',
}

export type NodeRole = keyof typeof roles

export type MapNode = {
  publicKey: string
  name: string
  role: NodeRole
  position: Coordinates | null
  source: NodeSource
  favorite: boolean
}

export const publicMapUrl = 'https://map.meshcore.io/'
export const publicSnapshotUrl = new URL('api/v1/nodes', publicMapUrl).href
export const mercatorLatitude = 85.05112878
const publicKeyFormat = /^[a-f0-9]{64}$/i

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function readCoordinates(lat: unknown, lon: unknown): Coordinates | null {
  if (typeof lat !== 'number' || typeof lon !== 'number'
    || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null
  }
  return { lat, lon }
}

export function mapPosition(position: Coordinates | null): position is Coordinates {
  return position !== null && Math.abs(position.lat) <= mercatorLatitude && Math.abs(position.lon) <= 180
}

export function readImportNodes(data: unknown): MapNode[] {
  const records = Array.isArray(data) ? data as unknown[] : objectRecord(data)?.nodes
  if (!Array.isArray(records) || records.length > 20_000) {
    throw new Error('Choose a node JSON file containing an array of up to 20,000 nodes.')
  }
  const result = new Map<string, MapNode>()
  for (const raw of records) {
    const row = objectRecord(raw)
    if (!row) throw new Error('A node entry is invalid.')
    const location = objectRecord(row.position)
    const node = normalizeNode({
      publicKey: row.publicKey ?? row.public_key,
      name: row.name ?? row.adv_name,
      role: row.role ?? row.type,
      position: readCoordinates(location?.lat ?? row.lat ?? row.adv_lat, location?.lon ?? row.lon ?? row.adv_lon),
      source: row.source === 'discovery' ? 'discovery' : 'local',
      favorite: row.favorite,
    })
    if (!node) throw new Error('Each node needs a 64-character public key and a supported role (1–4).')
    result.set(`${node.source}:${node.publicKey}`, node)
  }
  return [...result.values()]
}

type UnvalidatedNode = {
  publicKey: unknown
  name: unknown
  role: unknown
  position: Coordinates | null
  source: NodeSource
  favorite?: unknown
}

function normalizeNode(raw: UnvalidatedNode): MapNode | null {
  if (typeof raw.publicKey !== 'string' || !publicKeyFormat.test(raw.publicKey)
    || (raw.role !== 1 && raw.role !== 2 && raw.role !== 3 && raw.role !== 4)) return null

  const publicKey = raw.publicKey.toLowerCase()
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : ''
  return {
    publicKey,
    name: name || `Node ${publicKey.slice(0, 8)}`,
    role: raw.role,
    position: raw.position,
    source: raw.source,
    favorite: raw.favorite === true,
  }
}

export function readPublicNodes(data: unknown): MapNode[] {
  if (!Array.isArray(data)) throw new Error('MeshCore Map returned an unexpected node list.')
  const result = new Map<string, MapNode>()
  for (const raw of data as unknown[]) {
    const row = objectRecord(raw)
    if (!row) continue
    const node = normalizeNode({
      publicKey: row.public_key,
      name: row.adv_name,
      role: row.type,
      position: readCoordinates(row.adv_lat ?? row.lat, row.adv_lon ?? row.lon),
      source: 'public',
    })
    if (node) result.set(node.publicKey, node)
  }
  if (data.length && !result.size) throw new Error('MeshCore Map returned no supported node records.')
  return [...result.values()]
}

export function filterNodes(
  nodes: readonly MapNode[],
  filter: { search: string; role: NodeRole | 'all'; favoritesOnly: boolean },
): MapNode[] {
  const query = filter.search.trim().toLowerCase()
  return nodes.filter((node) => (
    (filter.role === 'all' || node.role === filter.role)
      && (!filter.favoritesOnly || node.favorite)
      && (node.name.toLowerCase().includes(query) || node.publicKey.includes(query))
  ))
}
