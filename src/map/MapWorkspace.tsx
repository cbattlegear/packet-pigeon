import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { MapCanvas } from './MapCanvas.tsx'
import { TerrainTools } from './TerrainTools.tsx'
import type { CoordinateText } from './TerrainTools.tsx'
import {
  filterNodes, localNodesKey, mapPosition, publicMapUrl, publicSnapshotUrl, readCoordinates, readImportNodes, readPublicNodes, roles,
} from './nodes.ts'
import type { Coordinates, MapNode, MapNodeData, NodeRole, NodeSource } from './nodes.ts'
import { distanceBetween } from './terrain.ts'
import type { CoverageLayer, ProfileResult } from './terrain.ts'
import type { MapPath } from '../paths/model.ts'
import './map.css'

const emptyCoordinate: CoordinateText = { lat: '', lon: '' }
const emptyNodes: readonly MapNode[] = []
const favoritesKey = 'packet-pigeon:map:favorites'
const sourceTitles = { local: 'Local contacts', discovery: 'Discovered nodes', public: 'Public snapshot' }
type PointToPick = 'start' | 'end'

function savedFavorites(): Record<string, boolean> {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(favoritesKey) ?? '[]')
    if (!Array.isArray(entries)) return {}
    return Object.fromEntries(entries.filter((entry): entry is [string, boolean] => (
      Array.isArray(entry) && typeof entry[0] === 'string' && /^[a-f0-9]{64}$/.test(entry[0])
        && typeof entry[1] === 'boolean'
    )))
  } catch {
    return {}
  }
}

function formatPosition(position: Coordinates) {
  return `${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`
}

export default function MapWorkspace({
  radioNodes = emptyNodes, radioPosition = null, showTerrain = false, contactFocus = null, discoveryRequest = 0, onSharePosition,
  displayPath = null, clearPath, traceSelection = emptyNodes, changeTraceSelection, reviewTrace,
  mapData, setMapData,
}: {
  radioNodes?: readonly MapNode[]; radioPosition?: Coordinates | null; showTerrain?: boolean
  contactFocus?: { position: Coordinates; terrain: boolean } | null
  discoveryRequest?: number
  onSharePosition?: (position: Coordinates) => void
  displayPath?: MapPath | null
  clearPath?: () => void
  traceSelection?: readonly MapNode[]
  changeTraceSelection?: (nodes: MapNode[]) => void
  reviewTrace?: () => void
  mapData: MapNodeData
  setMapData: (update: (previous: MapNodeData) => MapNodeData) => void
}) {
  const { local: localNodes, public: publicNodes } = mapData
  const [favorites, setFavorites] = useState(savedFavorites)
  const [source, setSource] = useState<NodeSource>('local')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [role, setRole] = useState<NodeRole | 'all'>('all')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [resultPage, setResultPage] = useState(0)
  const [selection, setSelection] = useState<string | null>(null)
  const [myLocation, setMyLocation] = useState<Coordinates | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationMessage, setLocationMessage] = useState('')
  const [fileMessage, setFileMessage] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [useTiles, setUseTiles] = useState(false)
  const [tileError, setTileError] = useState(false)
  const [focus, setFocus] = useState<Coordinates | readonly Coordinates[] | null>(null)
  const [picking, setPicking] = useState<PointToPick | 'share' | null>(null)
  const [start, setStart] = useState(emptyCoordinate)
  const [end, setEnd] = useState(emptyCoordinate)
  const [profile, setProfile] = useState<ProfileResult | null>(null)
  const [coverage, setCoverage] = useState<CoverageLayer[]>([])
  const [appliedContactFocus, setAppliedContactFocus] = useState<typeof contactFocus>(null)
  const [appliedDiscoveryRequest, setAppliedDiscoveryRequest] = useState(0)
  const [shownPath, setShownPath] = useState<typeof displayPath>(null)
  const mapPanel = useRef<HTMLDivElement>(null)
  const self = myLocation ?? (mapPosition(radioPosition) ? radioPosition : null)
  const routeLayer = useMemo(() => displayPath ?? (traceSelection.length ? {
    title: 'Selected trace repeaters',
    points: traceSelection.map(({ name, position }) => ({ label: name, position })),
  } : null), [displayPath, traceSelection])

  useEffect(() => {
    if (showTerrain) document.getElementById('tools')?.scrollIntoView()
  }, [showTerrain])

  const nodes = useMemo(() => {
    const records = source === 'public' ? publicNodes : [...localNodes, ...radioNodes]
    const matching = new Map<string, MapNode>()
    for (const node of records) {
      if (node.source === source) {
        matching.set(node.publicKey, { ...node, favorite: favorites[node.publicKey] ?? node.favorite })
      }
    }
    return matching
  }, [source, publicNodes, radioNodes, localNodes, favorites])
  const filtered = useMemo(() => filterNodes([...nodes.values()], {
    search: deferredSearch, role, favoritesOnly,
  }), [nodes, deferredSearch, role, favoritesOnly])
  const selected = selection ? nodes.get(selection) : undefined
  const pageSize = 30
  const page = Math.min(resultPage, Math.max(0, Math.ceil(filtered.length / pageSize) - 1))
  const reportTileError = useCallback(() => setTileError(true), [])

  const chooseNode = useCallback((node: MapNode) => {
    setSelection(node.publicKey)
    if (mapPosition(node.position)) setFocus({ ...node.position })
  }, [])

  const putCoordinate = useCallback((target: PointToPick, position: Coordinates) => {
    const fields = { lat: position.lat.toFixed(6), lon: position.lon.toFixed(6) }
    if (target === 'start') setStart(fields)
    else setEnd(fields)
    setPicking(null)
  }, [])
  if (contactFocus !== appliedContactFocus) {
    setAppliedContactFocus(contactFocus)
    if (contactFocus) {
      setFocus(contactFocus.position)
      if (contactFocus.terrain) putCoordinate('start', contactFocus.position)
    }
  }
  if (appliedDiscoveryRequest !== discoveryRequest) {
    setAppliedDiscoveryRequest(discoveryRequest)
    setSource('discovery')
    setSelection(null)
    setSearch('')
    setRole('all')
    setFavoritesOnly(false)
    setResultPage(0)
  }
  if (displayPath !== shownPath) {
    setShownPath(displayPath)
    if (displayPath) setFocus(displayPath.points.flatMap(({ position }) => mapPosition(position) ? [position] : []))
  }
  const pickFromMap = useCallback((position: Coordinates) => {
    if (picking === 'share') {
      setPicking(null)
      onSharePosition?.(position)
    } else if (picking) putCoordinate(picking, position)
  }, [picking, putCoordinate, onSharePosition])

  function locate() {
    setLocationMessage('')
    if (!navigator.geolocation) {
      setLocationMessage('Browser location is unavailable.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setLocating(false)
      const location = readCoordinates(coords.latitude, coords.longitude)
      if (!mapPosition(location)) {
        setLocationMessage('Your position is outside the latitude range of this map.')
        return
      }
      setMyLocation(location)
      setFocus(location)
      setLocationMessage(`My location: ${formatPosition(location)}`)
    }, ({ code }) => {
      setLocating(false)
      setLocationMessage(code === 1 ? 'Location permission was denied.' : 'Your browser could not determine your location.')
    }, { timeout: 12_000 })
  }

  async function loadFile(event: ChangeEvent<HTMLInputElement>, publicSnapshot: boolean) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setLoadingFile(true)
    setFileMessage('')
    try {
      const limit = publicSnapshot ? 50_000_000 : 2_000_000
      if (file.size > limit) throw new Error(`Choose a JSON file under ${limit / 1_000_000} MB.`)
      const data: unknown = JSON.parse(await file.text())
      const imported = publicSnapshot ? readPublicNodes(data) : readImportNodes(data)
      setSelection(null)
      setResultPage(0)
      if (publicSnapshot) {
        setMapData((previous) => ({ ...previous, public: imported }))
        setSource('public')
      } else {
        setMapData((previous) => ({ ...previous, local: imported }))
        setSource(imported.length && imported.every((node) => node.source === 'discovery') ? 'discovery' : 'local')
        try {
          localStorage.setItem(localNodesKey, JSON.stringify(imported))
        } catch {
          setFileMessage('Nodes imported for this visit. The browser could not save them.')
          return
        }
      }
      setFileMessage(`${imported.length.toLocaleString()} nodes loaded.`)
    } catch (error) {
      setFileMessage(error instanceof SyntaxError ? 'The file is not valid JSON.'
        : error instanceof Error ? error.message : 'The map file could not be opened.')
    } finally {
      setLoadingFile(false)
    }
  }

  function toggleFavorite(node: MapNode) {
    const next = { ...favorites, [node.publicKey]: !node.favorite }
    setFavorites(next)
    try {
      localStorage.setItem(favoritesKey, JSON.stringify(Object.entries(next)))
    } catch {
      setFileMessage('Favorite changed for this visit. The browser could not save it.')
    }
  }

  return (
    <section className="map-workspace" id="map" aria-labelledby="map-heading">
      <h2 id="map-heading">Map and terrain</h2>
      <div className="map-toolbar">
        <label><span id="map-source-label">Node source</span>
          <select value={source} aria-labelledby="map-source-label" onChange={(event) => {
            setSource(event.currentTarget.value as NodeSource)
            setSelection(null)
            setResultPage(0)
          }}>
            {Object.entries(sourceTitles).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
          </select>
        </label>
        <label><span id="map-basemap-label">Base map</span>
          <select value={useTiles ? 'osm' : 'grid'} aria-labelledby="map-basemap-label"
            aria-describedby="tile-privacy" onChange={(event) => {
            setTileError(false)
            setUseTiles(event.currentTarget.value === 'osm')
          }}>
            <option value="grid">Offline world map</option>
            <option value="osm">OpenStreetMap</option>
          </select>
        </label>
        <button type="button" onClick={locate} disabled={locating}>
          {locating ? 'Finding location…' : 'Show my location'}
        </button>
        {onSharePosition && <button type="button" onClick={() => setPicking('share')}>Pick a location for Chats</button>}
        {myLocation && <button type="button" onClick={() => {
          setMyLocation(null)
          setLocationMessage('')
        }}>Clear my location</button>}
      </div>
      <p className="map-help" id="tile-privacy">Selecting OpenStreetMap sends the viewed area to its tile service.</p>
      {source === 'discovery' && <p className="map-help"><a href="#discovery">Browse discovery history and radio paths</a></p>}
      {tileError && <p role="status" className="map-notice">Map tiles could not load. Node and terrain layers are still available.</p>}
      {locationMessage && <p role="status" className="map-help">{locationMessage}</p>}
      <div className="map-layout">
        <div ref={mapPanel}>
          {picking && <div className="map-notice" role="status">
            {picking === 'share' ? 'Select a point to make it available in Chats.' : `Select the ${picking} point on the map.`}
            <button type="button" onClick={() => setPicking(null)}>Cancel selection</button>
          </div>}
          <MapCanvas
            nodes={filtered}
            self={self}
            focus={focus}
            useTiles={useTiles}
            profile={profile}
            picking={picking !== null}
            layers={coverage}
            displayPath={routeLayer}
            onSelect={chooseNode}
            onPick={pickFromMap}
            onTileError={reportTileError}
          />
        </div>
        <div className="map-panel">
          <h3>Nodes</h3>
          {displayPath && <section className="map-node-detail"
            aria-label={displayPath.connect === false ? 'Displayed map points' : 'Displayed route'}>
            <h4>{displayPath.title}</h4>
            {displayPath.description && <p>{displayPath.description}</p>}
            <ol>{displayPath.points.map(({ label, position }, index) => <li key={index}>
              {label}{!mapPosition(position) && ' · Position unavailable'}
            </li>)}</ol>
            {clearPath && <button type="button" onClick={clearPath}>
              {displayPath.connect === false ? 'Clear displayed points' : 'Clear displayed path'}
            </button>}
          </section>}
          {traceSelection.length > 0 && changeTraceSelection && <section className="map-node-detail" aria-label="Selected trace repeaters">
            <h4>Selected trace repeaters</h4>
            <ol>{traceSelection.map((node, index) => <li key={index}>{node.name}</li>)}</ol>
            <div className="map-actions">
              {reviewTrace && <button type="button" onClick={reviewTrace}>Review map trace</button>}
              <button type="button" onClick={() => changeTraceSelection(traceSelection.slice(0, -1))}>Remove last repeater</button>
              <button type="button" onClick={() => changeTraceSelection([])}>Clear trace selection</button>
            </div>
          </section>}
          <div className="map-filters">
            <label>Search name or key
              <input type="search" value={search} onChange={(event) => {
                setSearch(event.currentTarget.value)
                setResultPage(0)
              }} />
            </label>
            <label><span id="map-role-label">Role</span>
              <select value={role} aria-labelledby="map-role-label" onChange={(event) => {
                const value = event.currentTarget.value
                setRole(value === 'all' ? value : Number(value) as NodeRole)
                setResultPage(0)
              }}>
                <option value="all">All roles</option>
                {Object.entries(roles).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
              </select>
            </label>
            <label className="map-check"><input type="checkbox" checked={favoritesOnly} onChange={(event) => {
              setFavoritesOnly(event.currentTarget.checked)
              setResultPage(0)
            }} /> Favorites only</label>
          </div>
          {selected && <div className="map-node-detail">
            <h4>{selected.name}</h4>
            <p>{roles[selected.role]} · {sourceTitles[selected.source]}</p>
            <code>{selected.publicKey}</code>
            <p>{mapPosition(selected.position) ? formatPosition(selected.position)
              : selected.position ? 'Outside supported map latitude' : 'No coordinates available'}</p>
            {mapPosition(selected.position) && self && (
              <p>{(distanceBetween(self, selected.position) / 1_000).toFixed(1)} km from my location</p>
            )}
            <div className="map-actions">
              <button type="button" onClick={() => toggleFavorite(selected)}>
                {selected.favorite ? 'Remove favorite' : 'Add favorite'}
              </button>
              {onSharePosition && mapPosition(selected.position) && <button type="button"
                onClick={() => onSharePosition(selected.position!)}>Use location in Chats</button>}
              {selected.role === 2 && mapPosition(selected.position) && <>
                {changeTraceSelection && <button type="button" disabled={traceSelection.length >= 63}
                  onClick={() => changeTraceSelection([...traceSelection, selected])}>Add repeater to trace</button>}
                <button type="button" onClick={() => putCoordinate('start', selected.position!)}>Use as start</button>
                <button type="button" onClick={() => putCoordinate('end', selected.position!)}>Use as end</button>
              </>}
              {selected.source === 'public' && <a target="_blank" rel="noreferrer"
                href={`${publicMapUrl}?public_key=${selected.publicKey}&delete=1`}>Open official removal request</a>}
            </div>
          </div>}
          <p className="map-help">{filtered.length.toLocaleString()} matching nodes</p>
          {filtered.length > 0 && <>
            <ul className="map-node-list">
              {filtered.slice(page * pageSize, (page + 1) * pageSize).map((node) => (
                <li key={node.publicKey}>
                  <button type="button" aria-pressed={selection === node.publicKey} onClick={() => chooseNode(node)}>
                    <span>{node.name}</span>
                    <small>{roles[node.role]}{node.favorite ? ' · Favorite' : ''}{mapPosition(node.position) ? '' : ' · Unmapped'}</small>
                  </button>
                </li>
              ))}
            </ul>
            {filtered.length > pageSize && <div className="map-actions">
              <button type="button" disabled={page === 0} onClick={() => setResultPage(page - 1)}>Previous</button>
              <span>{page + 1} of {Math.ceil(filtered.length / pageSize)}</span>
              <button type="button" disabled={(page + 1) * pageSize >= filtered.length}
                onClick={() => setResultPage(page + 1)}>Next</button>
            </div>}
          </>}
        </div>
      </div>
      <details className="map-data">
        <summary>Node data and public map</summary>
        <div className="map-toolbar">
          <label>Import local or discovered nodes
            <input type="file" accept=".json,application/json" disabled={loadingFile}
              onChange={(event) => void loadFile(event, false)} />
          </label>
          <label>Import public snapshot
            <input type="file" accept=".json,application/json" disabled={loadingFile}
              onChange={(event) => void loadFile(event, true)} />
          </label>
        </div>
        {fileMessage && <p className="map-help" role="status">{fileMessage}</p>}
        <p className="map-help">A local import replaces the previously imported list. Save the official snapshot as a JSON file to browse it here.</p>
        <div className="map-actions">
          <a href={publicMapUrl} target="_blank" rel="noreferrer">Browse official live map</a>
          <a href={publicSnapshotUrl} target="_blank" rel="noreferrer">Open official JSON snapshot</a>
          <a href="https://github.com/meshcore-dev/MeshCore/blob/main/docs/faq.md#512-q-how-do-i-add-a-node-to-the-meshcore-map"
            target="_blank" rel="noreferrer">Official publishing and update instructions</a>
        </div>
      </details>
      <TerrainTools
        start={start}
        end={end}
        setStart={setStart}
        setEnd={setEnd}
        pick={(point) => {
          setPicking(point)
          mapPanel.current?.scrollIntoView({ block: 'start' })
        }}
        profile={profile}
        setProfile={setProfile}
        coverage={coverage}
        setCoverage={setCoverage}
        focus={setFocus}
        viewMap={() => mapPanel.current?.scrollIntoView({ block: 'start' })}
      />
    </section>
  )
}
