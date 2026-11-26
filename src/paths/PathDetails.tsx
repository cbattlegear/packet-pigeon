import { useState } from 'react'
import { mapPosition } from '../map/nodes.ts'
import { distanceBetween } from '../map/terrain.ts'
import { mapPath, resolvePath } from './model.ts'
import type { MapPath, PathNode } from './model.ts'
import './paths.css'

type Props = {
  title: string
  width: number
  hashes: readonly string[]
  nodes: readonly PathNode[]
  snr?: readonly number[]
  onMap?: (path: MapPath) => void
}

export function PathDetails({ title, width, hashes, nodes, snr, onMap }: Props) {
  const [status, setStatus] = useState('')
  const [copyError, setCopyError] = useState(false)
  const resolved = resolvePath(hashes, nodes)
  const path = mapPath(title, resolved)

  async function copy(reverse: boolean) {
    setCopyError(false)
    const text = [...hashes]
    if (reverse) text.reverse()
    try {
      await navigator.clipboard.writeText(text.join(','))
      setStatus(reverse ? 'Reverse path copied.' : 'Path copied.')
    } catch {
      setCopyError(true)
      setStatus('Clipboard access failed. Select and copy the ordered hashes from this view.')
    }
  }

  return <div className="path-details">
    <p>{hashes.length} {hashes.length === 1 ? 'hop' : 'hops'} · {width}-byte hashes</p>
    {hashes.length > 0 && <>
      <ol aria-label={`${title} hops`}>
        {resolved.map(({ hash, matches, position }, index) => {
          const previous = resolved[index - 1]?.position
          return <li key={index}>
            <code>{hash}</code> · {matches.length === 0 ? 'Unknown node' :
              matches.length > 1 ? `Ambiguous: ${matches.map(({ name }) => name).join(', ')}` : matches[0].name}
            {snr && <> · {snr[index]} dB</>}
            {index > 0 && <> · {previous && position
              ? `${(distanceBetween(previous, position) / 1000).toFixed(1)} km from previous hop`
              : 'Distance unavailable'}</>}
          </li>
        })}
      </ol>
      <div className="path-actions">
        <button type="button" onClick={() => void copy(false)}>Copy path</button>
        <button type="button" onClick={() => void copy(true)}>Copy reverse path</button>
        {onMap && <button type="button" disabled={!path.points.some(({ position }) => mapPosition(position))}
          onClick={() => onMap(path)}>Show path on map</button>}
      </div>
    </>}
    {status && <p role={copyError ? 'alert' : 'status'}>{status}</p>}
  </div>
}
