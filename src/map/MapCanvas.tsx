import { useEffect, useRef } from 'react'
import {
  circleMarker, control, divIcon, geoJSON, latLngBounds, layerGroup, map as createMap, marker, polyline, tileLayer,
} from 'leaflet'
import type { LatLngExpression, LeafletMouseEvent, Map as LeafletMap } from 'leaflet'
import type { GeoJsonObject } from 'geojson'
import { mapPosition, mercatorLatitude } from './nodes.ts'
import type { Coordinates, MapNode } from './nodes.ts'
import { coverageSamples } from './terrain.ts'
import type { CoverageLayer, ProfileResult } from './terrain.ts'
import land from './world-land.json'
import 'leaflet/dist/leaflet.css'

type MapCanvasProps = {
  nodes: readonly MapNode[]
  self: Coordinates | null
  focus: Coordinates | readonly Coordinates[] | null
  useTiles: boolean
  picking: boolean
  profile: ProfileResult | null
  layers: readonly CoverageLayer[]
  onSelect: (node: MapNode) => void
  onPick: (point: Coordinates) => void
  onTileError: () => void
}

const point = ({ lat, lon }: Coordinates): [number, number] => [lat, lon]

export function MapCanvas({
  nodes, self, focus, useTiles, picking, profile, layers, onSelect, onPick, onTileError,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)

  useEffect(() => {
    if (!container.current) return
    const limits = latLngBounds([-mercatorLatitude, -180], [mercatorLatitude, 180])
    const map = createMap(container.current, {
      center: [28, 0], zoom: 2, minZoom: 2, maxZoom: 19,
      maxBounds: limits, maxBoundsViscosity: 1, scrollWheelZoom: false,
    })
    mapRef.current = map
    map.createPane('offline-land').style.zIndex = '180'
    geoJSON(land as GeoJsonObject, {
      pane: 'offline-land',
      interactive: false,
      attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a>',
      style: { color: '#a9bab0', fillColor: '#c8d4bc', fillOpacity: 0.72, weight: 1 },
    }).addTo(map)
    control.scale({ imperial: false }).addTo(map)
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    observer.observe(container.current)
    return () => {
      observer.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !useTiles) return
    const tiles = tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      noWrap: true, maxZoom: 19, minZoom: 2, referrerPolicy: 'strict-origin-when-cross-origin',
    }).on('tileerror', onTileError).addTo(map)
    return () => { tiles.remove() }
  }, [useTiles, onTileError])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus) return
    if ('lat' in focus) {
      if (mapPosition(focus)) map.setView(point(focus), Math.max(map.getZoom(), 11), { animate: false })
    } else {
      const positions = focus.filter(mapPosition)
      const first = positions[0]
      if (!first) return
      const bounds = latLngBounds(positions.map(point))
      if (bounds.getEast() - bounds.getWest() > 180) {
        map.setView(point(first), 8, { animate: false })
      } else {
        map.fitBounds(bounds, { animate: false, maxZoom: 16, padding: [24, 24] })
      }
    }
  }, [focus])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !picking) return
    function pick(event: LeafletMouseEvent) {
      const { lat, lng: lon } = event.latlng.wrap()
      onPick({ lat, lon })
    }
    map.on('click', pick)
    return () => { map.off('click', pick) }
  }, [picking, onPick])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const overlay = layerGroup().addTo(map)
    function draw() {
      if (!map) return
      const bounds = map.getBounds().pad(0.15)
      const zoom = map.getZoom()
      const cells = new Map<string, { node: MapNode; position: LatLngExpression }[]>()
      for (const node of nodes) {
        if (!mapPosition(node.position) || !bounds.contains(point(node.position))) continue
        const position = point(node.position)
        const pixel = map.project(position, zoom)
        const cell = zoom >= 17 ? node.publicKey : `${Math.floor(pixel.x / 44)}:${Math.floor(pixel.y / 44)}`
        const group = cells.get(cell) ?? []
        group.push({ node, position })
        cells.set(cell, group)
      }
      overlay.clearLayers()
      for (const group of cells.values()) {
        if (group.length === 1) {
          const [{ node, position }] = group
          marker(position, {
            title: node.name,
            icon: divIcon({ className: `node-pin node-role-${node.role}`, iconSize: [16, 16] }),
          }).on('click', () => {
            if (picking && mapPosition(node.position)) onPick(node.position)
            else onSelect(node)
          }).addTo(overlay)
        } else {
          const bounds = latLngBounds(group.map(({ position }) => position))
          marker(bounds.getCenter(), {
            title: `Zoom to ${group.length} nodes`,
            icon: divIcon({ className: 'node-cluster', html: String(group.length), iconSize: [38, 38] }),
          }).on('click', () => map.fitBounds(bounds, { maxZoom: 17, padding: [24, 24] })).addTo(overlay)
        }
      }
      if (mapPosition(self)) {
        marker(point(self), {
          title: 'My location',
          interactive: false,
          keyboard: false,
          icon: divIcon({ className: 'self-pin', iconSize: [18, 18] }),
        }).addTo(overlay)
      }
    }
    draw()
    map.on('moveend', draw)
    return () => {
      map.off('moveend', draw)
      overlay.remove()
    }
  }, [nodes, self, onSelect, picking, onPick])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const overlay = layerGroup().addTo(map)
    if (profile) {
      const segments: [number, number][][] = []
      let segment: [number, number][] = []
      for (const position of profile.positions) {
        if (segment.length && Math.abs(segment.at(-1)![1] - position.lon) > 180) {
          segments.push(segment)
          segment = []
        }
        segment.push(point(position))
      }
      segments.push(segment)
      polyline(segments, { color: profile.clear ? '#087962' : '#ad4d28', interactive: false }).addTo(overlay)
    }
    for (const layer of layers) {
      if (!layer.visible) continue
      circleMarker(point(layer.request.origin), {
        radius: 6, color: '#3351a2', fillOpacity: 0.8, interactive: false,
      }).addTo(overlay)
      for (const { position, clear } of coverageSamples(layer)) {
        const color = clear ? '#087962' : '#ad4d28'
        circleMarker(point(position), { radius: 4, color, fillOpacity: 0.82, weight: 1, interactive: false })
          .addTo(overlay)
      }
    }
    return () => { overlay.remove() }
  }, [profile, layers])

  return (
    <div
      ref={container}
      className={picking ? 'node-map node-map-picking' : 'node-map'}
      role="region"
      aria-label="Node and terrain map"
    />
  )
}
