import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, Dispatch, FormEvent, SetStateAction } from 'react'
import { mapPosition, readCoordinates } from './nodes.ts'
import type { Coordinates } from './nodes.ts'
import {
  coveragePlan, coverageSamples, evaluateProfile, fetchElevations, importCoverage, profilePlan,
  validateAntennas, validateCoverage,
} from './terrain.ts'
import type { CoverageLayer, ProfileResult } from './terrain.ts'

export type CoordinateText = { lat: string; lon: string }
type PointName = 'start' | 'end'

type TerrainToolsProps = {
  start: CoordinateText
  end: CoordinateText
  setStart: (position: CoordinateText) => void
  setEnd: (position: CoordinateText) => void
  pick: (point: PointName) => void
  profile: ProfileResult | null
  setProfile: (result: ProfileResult | null) => void
  coverage: CoverageLayer[]
  setCoverage: Dispatch<SetStateAction<CoverageLayer[]>>
  focus: (points: Coordinates | Coordinates[]) => void
  viewMap: () => void
}

function numeric(input: string): number {
  return input.trim() ? Number(input) : NaN
}

function coordinate(input: CoordinateText, label: string): Coordinates {
  const point = readCoordinates(numeric(input.lat), numeric(input.lon))
  if (!mapPosition(point)) {
    throw new Error(`Enter a valid ${label} latitude between −85.05 and 85.05 and longitude between −180 and 180.`)
  }
  return point
}

function layerId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(3)), (number) => number.toString(16)).join('-')
}

function CoordinateFields({
  name, value, update, pick,
}: { name: string; value: CoordinateText; update: (value: CoordinateText) => void; pick: () => void }) {
  return (
    <fieldset className="terrain-coordinates">
      <legend>{name}</legend>
      <label>{name} latitude
        <input type="number" step="any" value={value.lat}
          onChange={(event) => update({ ...value, lat: event.currentTarget.value })} />
      </label>
      <label>{name} longitude
        <input type="number" step="any" value={value.lon}
          onChange={(event) => update({ ...value, lon: event.currentTarget.value })} />
      </label>
      <button type="button" onClick={pick}>Pick {name.toLowerCase()} on map</button>
    </fieldset>
  )
}

function ProfileChart({ profile }: { profile: ProfileResult }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const samples = profile.samples
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const { width, height } = element
    const min = Math.min(...samples.flatMap(({ terrain, sightline }) => [terrain, sightline]))
    const max = Math.max(...samples.flatMap(({ terrain, sightline }) => [terrain, sightline]))
    const padding = 14
    const y = (elevation: number) => height - padding - (elevation - min) / Math.max(1, max - min) * (height - 2 * padding)
    const x = (index: number) => padding + index / (samples.length - 1) * (width - 2 * padding)

    context.clearRect(0, 0, width, height)
    context.beginPath()
    for (const [index, sample] of samples.entries()) context.lineTo(x(index), y(sample.terrain))
    context.lineTo(width - padding, height)
    context.lineTo(padding, height)
    context.closePath()
    context.fillStyle = '#87b6a6'
    context.fill()
    context.beginPath()
    context.moveTo(x(0), y(samples[0].sightline))
    context.lineTo(x(samples.length - 1), y(samples[samples.length - 1].sightline))
    context.strokeStyle = '#88330c'
    context.lineWidth = 3
    context.stroke()
  }, [samples])

  return (
    <div className="terrain-result">
      <p><strong>{profile.clear ? 'Clear at sampled points' : 'Terrain obstructs the path'}</strong>
        {' · '}{(profile.distanceM / 1_000).toFixed(2)} km</p>
      <p className="map-help">Lowest clearance: {profile.lowest.clearance.toFixed(1)} m at
        {' '}{(profile.lowest.distanceM / 1_000).toFixed(2)} km from the start.</p>
      <canvas ref={canvas} width={768} height={188} role="img"
        aria-label="Terrain profile with an overlaid line between the two antennas" />
      <p className="map-help">Green area: curvature-adjusted terrain. Brown line: antenna sightline.</p>
      <details>
        <summary>Elevation samples</summary>
        <div className="profile-table">
          <table>
            <thead><tr><th scope="col">Distance (km)</th><th scope="col">Ground (m)</th>
              <th scope="col">Clearance (m)</th></tr></thead>
            <tbody>
              {samples.map((sample) => <tr key={sample.distanceM}>
                <td>{(sample.distanceM / 1_000).toFixed(2)}</td>
                <td>{sample.elevation.toFixed(1)}</td>
                <td>{sample.clearance.toFixed(1)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

const maximumLayers = 30

export function TerrainTools({
  start, end, setStart, setEnd, pick, profile, setProfile, coverage, setCoverage, focus, viewMap,
}: TerrainToolsProps) {
  const [mode, setMode] = useState<'profile' | 'coverage'>('profile')
  const [txHeight, setTxHeight] = useState('8')
  const [rxHeight, setRxHeight] = useState('2')
  const [radius, setRadius] = useState('10')
  const [layerName, setLayerName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingLayers, setLoadingLayers] = useState(false)
  const [message, setMessage] = useState('')
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])

  async function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (request.current || loadingLayers) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setMessage('')
    try {
      const origin = coordinate(start, 'start')
      const antennas = validateAntennas(numeric(txHeight), numeric(rxHeight))
      if (mode === 'profile') {
        const target = coordinate(end, 'end')
        const plan = profilePlan(origin, target)
        if (!plan.positions.every(mapPosition)) throw new Error('This path extends beyond the map’s latitude limit.')
        const elevations = await fetchElevations(plan.positions, controller.signal)
        controller.signal.throwIfAborted()
        setProfile(evaluateProfile(plan, elevations, antennas))
        focus([origin, target])
        setMessage('Elevation profile updated.')
      } else {
        if (!editId && coverage.length >= maximumLayers) throw new Error('Remove a coverage layer before adding another.')
        const parameters = validateCoverage(origin, numeric(radius), antennas)
        const positions = coveragePlan(parameters).map(({ position }) => position)
        const elevations = await fetchElevations(positions, controller.signal)
        controller.signal.throwIfAborted()
        const next = {
          id: editId ?? layerId(),
          name: layerName.trim() || `Coverage at ${origin.lat.toFixed(3)}, ${origin.lon.toFixed(3)}`,
          visible: true,
          request: parameters,
          elevations,
        }
        setCoverage((layers) => editId
          ? layers.map((layer) => layer.id === editId ? { ...next, visible: layer.visible } : layer)
          : [...layers, next])
        setEditId(null)
        setLayerName('')
        focus(positions)
        setMessage(editId ? 'Coverage layer updated.' : 'Coverage layer added.')
      }
    } catch (error) {
      if (controller.signal.aborted) setMessage('Calculation canceled.')
      else if (error instanceof DOMException && error.name === 'TimeoutError') {
        setMessage('The elevation request timed out. Try again.')
      } else if (error instanceof TypeError || error instanceof SyntaxError) {
        setMessage('Could not read elevation data. Check your connection and try again.')
      } else {
        setMessage(error instanceof Error ? error.message : 'Calculation failed.')
      }
    } finally {
      request.current = null
      setBusy(false)
    }
  }

  function edit(layer: CoverageLayer) {
    setEditId(layer.id)
    setMode('coverage')
    setLayerName(layer.name)
    setStart({ lat: String(layer.request.origin.lat), lon: String(layer.request.origin.lon) })
    setRadius(String(layer.request.radiusKm))
    setTxHeight(String(layer.request.txHeight))
    setRxHeight(String(layer.request.rxHeight))
    setMessage(`Editing ${layer.name}.`)
  }

  async function loadLayers(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || loadingLayers) return
    setLoadingLayers(true)
    try {
      if (file.size > 1_000_000) throw new Error('Choose a coverage file under 1 MB.')
      const parsed = importCoverage(JSON.parse(await file.text()))
      if (coverage.length + parsed.length > maximumLayers) throw new Error('A total of 30 coverage layers is supported.')
      const added = parsed.map((layer) => ({ ...layer, id: layerId() }))
      setCoverage((layers) => [...layers, ...added])
      if (added[0]) focus(coveragePlan(added[0].request).map(({ position }) => position))
      setMessage(`Imported ${added.length} coverage layers.`)
    } catch (error) {
      setMessage(error instanceof SyntaxError ? 'The coverage file is not valid JSON.'
        : error instanceof Error ? error.message : 'The coverage file could not be opened.')
    } finally {
      setLoadingLayers(false)
    }
  }

  function exportLayers() {
    const file = new Blob([JSON.stringify({ version: 1, layers: coverage }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = 'packet-pigeon-coverage.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  return (
    <section className="terrain-tools" id="tools" aria-labelledby="terrain-heading">
      <h3 id="terrain-heading">Line of sight and coverage</h3>
      <form className="terrain-form" onSubmit={(event) => void calculate(event)} noValidate>
        <label><span id="map-calculation-label">Calculation</span>
          <select value={mode} disabled={busy} aria-labelledby="map-calculation-label" onChange={(event) => setMode(
            event.currentTarget.value === 'coverage' ? 'coverage' : 'profile',
          )}>
            <option value="profile">Line of sight</option>
            <option value="coverage">Antenna coverage</option>
          </select>
        </label>
        <CoordinateFields name="Start" value={start} update={setStart} pick={() => pick('start')} />
        {mode === 'profile' && <CoordinateFields name="End" value={end} update={setEnd} pick={() => pick('end')} />}
        <div className="terrain-settings">
          <label>Transmit height (m)
            <input type="number" step="any" value={txHeight}
              onChange={(event) => setTxHeight(event.currentTarget.value)} />
          </label>
          <label>Receive height (m)
            <input type="number" step="any" value={rxHeight}
              onChange={(event) => setRxHeight(event.currentTarget.value)} />
          </label>
          {mode === 'coverage' && <>
            <label>Radius (km)
              <input type="number" step="any" value={radius}
                onChange={(event) => setRadius(event.currentTarget.value)} />
            </label>
            <label>Layer name
              <input value={layerName} maxLength={80} onChange={(event) => setLayerName(event.currentTarget.value)} />
            </label>
          </>}
        </div>
        <p className="map-help">Calculate sends sample coordinates to
          {' '}<a href="https://open-meteo.com/en/docs/elevation-api" target="_blank" rel="noreferrer">Open-Meteo</a>.
          Terrain data: <a href="https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM"
            target="_blank" rel="noreferrer">Copernicus DEM</a> (90 m).</p>
        <div className="map-actions">
          <button className="map-primary" type="submit" disabled={busy || loadingLayers}>
            {busy ? 'Fetching elevations…' : mode === 'profile' ? 'Calculate line of sight'
              : editId ? 'Recalculate layer' : 'Calculate coverage'}
          </button>
          {busy && <button type="button" onClick={() => request.current?.abort()}>Cancel calculation</button>}
          {editId && !busy && <button type="button" onClick={() => {
            setEditId(null)
            setLayerName('')
          }}>Cancel editing</button>}
        </div>
      </form>
      <p className="map-help" role="status">{message}</p>
      <p className="map-help">Estimates use sampled terrain and Earth curvature. Buildings, vegetation, interference,
        and Fresnel clearance are outside the model.</p>
      {profile && <>
        <ProfileChart profile={profile} />
        <div className="map-actions">
          <button type="button" onClick={() => {
            focus(profile.positions)
            viewMap()
          }}>View path on map</button>
          <button type="button" onClick={() => setProfile(null)}>Clear profile</button>
        </div>
      </>}
      <div className="coverage-control">
        <h4>Coverage layers</h4>
        <p className="map-help">Green points have sampled line of sight. Brown points are obstructed.
          Exported files include site coordinates.</p>
        {coverage.length > 0 && <ul className="coverage-list">
          {coverage.map((layer) => {
            const samples = coverageSamples(layer)
            return (
              <li key={layer.id}>
                <label className="map-check"><input type="checkbox" checked={layer.visible}
                  onChange={(event) => {
                    const visible = event.currentTarget.checked
                    setCoverage((layers) => layers.map((item) => item.id === layer.id ? { ...item, visible } : item))
                  }} /> Show {layer.name}</label>
                <p className="map-help">{layer.request.radiusKm} km radius · {samples.filter(({ clear }) => clear).length}
                  {' of '}{samples.length} clear samples</p>
                <div className="map-actions">
                  <button type="button" disabled={busy} onClick={() => edit(layer)}>Edit {layer.name}</button>
                  <button type="button" onClick={() => {
                    focus(coveragePlan(layer.request).map(({ position }) => position))
                    viewMap()
                  }}>View {layer.name} on map</button>
                  <button type="button" disabled={busy} onClick={() => {
                    setCoverage((layers) => layers.filter((item) => item.id !== layer.id))
                    if (editId === layer.id) setEditId(null)
                  }}>Remove {layer.name}</button>
                </div>
              </li>
            )
          })}
        </ul>}
        <div className="map-toolbar">
          <label>Import coverage layers
            <input type="file" accept=".json,application/json" disabled={busy || loadingLayers}
              onChange={(event) => void loadLayers(event)} />
          </label>
          <button type="button" disabled={!coverage.length} onClick={exportLayers}>Export coverage layers</button>
        </div>
      </div>
    </section>
  )
}
