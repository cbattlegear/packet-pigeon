import { mapPosition, objectRecord, readCoordinates } from './nodes.ts'
import type { Coordinates } from './nodes.ts'

const earthRadiusM = 6_371_000
const radians = Math.PI / 180
const bearings = 12
const stepsPerBearing = 8
const profileSamples = 65
const maxCoverageLayersInFile = 30
const elevationApi = 'https://api.open-meteo.com/v1/elevation'

export type Antennas = { txHeight: number; rxHeight: number }
export type CoverageRequest = Antennas & { origin: Coordinates; radiusKm: number }
export type CoverageLayer = {
  id: string
  name: string
  visible: boolean
  request: CoverageRequest
  elevations: number[]
}

export function distanceBetween(start: Coordinates, end: Coordinates): number {
  const latDifference = (end.lat - start.lat) * radians
  const lonDifference = (end.lon - start.lon) * radians
  const a = Math.sin(latDifference / 2) ** 2
    + Math.cos(start.lat * radians) * Math.cos(end.lat * radians) * Math.sin(lonDifference / 2) ** 2
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)))
}

function destination(origin: Coordinates, distanceM: number, heading: number): Coordinates {
  const angle = distanceM / earthRadiusM
  const latitude = origin.lat * radians
  const lat = Math.asin(Math.sin(latitude) * Math.cos(angle)
    + Math.cos(latitude) * Math.sin(angle) * Math.cos(heading))
  const lon = origin.lon * radians + Math.atan2(
    Math.sin(heading) * Math.sin(angle) * Math.cos(latitude),
    Math.cos(angle) - Math.sin(latitude) * Math.sin(lat),
  )
  return { lat: lat / radians, lon: ((lon / radians + 540) % 360) - 180 }
}

export function profilePlan(start: Coordinates, end: Coordinates) {
  const distanceM = distanceBetween(start, end)
  if (distanceM < 100 || distanceM > 300_000) {
    throw new Error('Choose endpoints between 100 m and 300 km apart.')
  }

  const startLat = start.lat * radians
  const endLat = end.lat * radians
  const lonDifference = (end.lon - start.lon) * radians
  const heading = Math.atan2(
    Math.sin(lonDifference) * Math.cos(endLat),
    Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(lonDifference),
  )
  const positions = Array.from({ length: profileSamples }, (_, index) => {
    if (index === 0) return start
    if (index === profileSamples - 1) return end
    return destination(start, distanceM * index / (profileSamples - 1), heading)
  })
  return { distanceM, positions }
}

export function evaluateProfile(
  plan: ReturnType<typeof profilePlan>,
  elevations: readonly number[],
  { txHeight, rxHeight }: Antennas,
) {
  const tx = elevations[0] + txHeight
  const rx = elevations[elevations.length - 1] + rxHeight
  const samples = elevations.map((elevation, index) => {
    const fraction = index / (elevations.length - 1)
    const distanceM = fraction * plan.distanceM
    const bulge = distanceM * (plan.distanceM - distanceM) / (2 * earthRadiusM)
    const terrain = elevation + bulge
    const sightline = tx + fraction * (rx - tx)
    return { distanceM, elevation, terrain, sightline, clearance: sightline - terrain }
  })
  const lowest = samples.slice(1, -1).reduce((current, point) => (
    point.clearance < current.clearance ? point : current
  ), samples[1])
  return { ...plan, samples, lowest, clear: lowest.clearance >= 0 }
}

export type ProfileResult = ReturnType<typeof evaluateProfile>

export function coveragePlan({ origin, radiusKm }: CoverageRequest) {
  const points = [{ position: origin, distanceM: 0 }]
  for (let direction = 0; direction < bearings; direction++) {
    const heading = 2 * Math.PI * direction / bearings
    for (let ring = 1; ring <= stepsPerBearing; ring++) {
      const distanceM = radiusKm * 1_000 * ring / stepsPerBearing
      points.push({ position: destination(origin, distanceM, heading), distanceM })
    }
  }
  return points
}

export function coverageSamples({ request, elevations }: CoverageLayer) {
  const points = coveragePlan(request)
  const transmitter = elevations[0] + request.txHeight
  const samples: { position: Coordinates; clear: boolean }[] = []
  let horizon = -Infinity
  for (let index = 1; index < points.length; index++) {
    if ((index - 1) % stepsPerBearing === 0) horizon = -Infinity
    const { position, distanceM } = points[index]
    const drop = distanceM ** 2 / (2 * earthRadiusM)
    const apparentSlope = (elevations[index] - transmitter - drop) / distanceM
    const receiverSlope = apparentSlope + request.rxHeight / distanceM
    samples.push({ position, clear: receiverSlope >= horizon })
    horizon = Math.max(horizon, apparentSlope)
  }
  return samples
}

export function readElevationArray(value: unknown, expected: number): number[] {
  if (!Array.isArray(value) || value.length !== expected || !value.every((elevation) => (
    typeof elevation === 'number' && Number.isFinite(elevation) && elevation >= -12_000 && elevation <= 10_000
  ))) {
    throw new Error('Elevation data is missing or invalid for one or more points.')
  }
  return value as number[]
}

export async function fetchElevations(points: readonly Coordinates[], signal: AbortSignal): Promise<number[]> {
  const url = new URL(elevationApi)
  url.searchParams.set('latitude', points.map(({ lat }) => lat.toFixed(5)).join(','))
  url.searchParams.set('longitude', points.map(({ lon }) => lon.toFixed(5)).join(','))
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}.`)
  return readElevationArray(objectRecord(await response.json())?.elevation, points.length)
}

function numberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

export function validateAntennas(txHeight: unknown, rxHeight: unknown): Antennas {
  if (!numberInRange(txHeight, 0, 500) || !numberInRange(rxHeight, 0, 500)) {
    throw new Error('Enter antenna heights from 0 to 500 m above ground.')
  }
  return { txHeight, rxHeight }
}

export function validateCoverage(origin: Coordinates, radiusKm: unknown, antennas: Antennas): CoverageRequest {
  if (!numberInRange(radiusKm, 0.5, 100)) throw new Error('Enter a radius from 0.5 to 100 km.')
  const request = { origin, radiusKm, ...antennas }
  if (!coveragePlan(request).every(({ position }) => mapPosition(position))) {
    throw new Error('The coverage radius extends beyond the map’s latitude limit.')
  }
  return request
}

export function importCoverage(data: unknown): Omit<CoverageLayer, 'id'>[] {
  const document = objectRecord(data)
  if (document?.version !== 1 || !Array.isArray(document.layers)
    || document.layers.length > maxCoverageLayersInFile) {
    throw new Error('Choose a Packet Pigeon coverage file with up to 30 layers.')
  }
  return (document.layers as unknown[]).map((raw) => {
    const entry = objectRecord(raw)
    const parameters = objectRecord(entry?.request)
    const coordinate = objectRecord(parameters?.origin)
    const origin = readCoordinates(coordinate?.lat, coordinate?.lon)
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (!entry || !mapPosition(origin) || !name || name.length > 80) {
      throw new Error('The file contains an invalid coverage layer.')
    }
    const request = validateCoverage(
      origin, parameters?.radiusKm, validateAntennas(parameters?.txHeight, parameters?.rxHeight),
    )
    return {
      name,
      visible: entry.visible !== false,
      request,
      elevations: readElevationArray(entry.elevations, 1 + bearings * stepsPerBearing),
    }
  })
}
