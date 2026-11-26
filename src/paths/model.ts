import type { Coordinates, MapNode } from '../map/nodes.ts'

export type PathNode = Pick<MapNode, 'publicKey' | 'name' | 'position'>
export type PathPoint = { label: string; position: Coordinates | null }
export type MapPath = { title: string; points: PathPoint[]; connect?: boolean }

export function resolvePath(hashes: readonly string[], nodes: readonly PathNode[]) {
  const unique = new Map<string, PathNode>()
  for (const node of nodes) {
    const key = node.publicKey.toLowerCase()
    if (!unique.has(key) || (!unique.get(key)?.position && node.position)) unique.set(key, node)
  }
  return hashes.map((hash) => {
    const matches = [...unique].filter(([key]) => key.startsWith(hash.toLowerCase())).map(([, node]) => node)
    return { hash, matches, position: matches.length === 1 ? matches[0].position : null }
  })
}

export function mapPath(title: string, resolved: ReturnType<typeof resolvePath>): MapPath {
  return {
    title,
    points: resolved.map(({ hash, matches, position }) => ({
      label: matches.length === 1 ? matches[0].name : hash,
      position,
    })),
  }
}

export function pathSegments(points: readonly PathPoint[]) {
  const segments: Coordinates[][] = []
  let segment: Coordinates[] = []
  for (const { position } of points) {
    if (!position || (segment.length && Math.abs(position.lon - segment.at(-1)!.lon) > 180)) {
      if (segment.length > 1) segments.push(segment)
      segment = []
    }
    if (position) segment.push(position)
  }
  if (segment.length > 1) segments.push(segment)
  return segments
}

export function mapSegments(path: MapPath) {
  return path.connect === false ? [] : pathSegments(path.points)
}
