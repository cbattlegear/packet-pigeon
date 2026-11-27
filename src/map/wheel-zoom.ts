export const mapMinZoom = 0
export const mapMaxZoom = 19
export const wheelPixelsPerZoom = 100

export type PixelPoint = { x: number; y: number }

export function normalizedWheelDelta(delta: number, deltaMode: number, viewportHeight: number) {
  if (deltaMode === 1) return delta * 16
  if (deltaMode === 2) return delta * viewportHeight
  return delta
}

export function consumeWheelZoom(
  currentZoom: number,
  accumulatedDelta: number,
  minimumZoom = mapMinZoom,
  maximumZoom = mapMaxZoom,
) {
  const direction = Math.sign(accumulatedDelta)
  const steps = Math.trunc(Math.abs(accumulatedDelta) / wheelPixelsPerZoom)
  return {
    zoom: Math.min(maximumZoom, Math.max(minimumZoom, currentZoom - direction * steps)),
    remainingDelta: accumulatedDelta - direction * steps * wheelPixelsPerZoom,
  }
}

export function pointerAnchoredCenter(
  center: PixelPoint,
  pointer: PixelPoint,
  viewport: PixelPoint,
  oldZoom: number,
  newZoom: number,
): PixelPoint {
  const scale = 2 ** (newZoom - oldZoom)
  const offset = {
    x: pointer.x - viewport.x / 2,
    y: pointer.y - viewport.y / 2,
  }
  return {
    x: (center.x + offset.x) * scale - offset.x,
    y: (center.y + offset.y) * scale - offset.y,
  }
}

export function shouldHandleMapWheel(target: EventTarget | null, container: HTMLElement) {
  if (!(target instanceof Element) || !container.contains(target)) return false
  return !target.closest([
    'button',
    'dialog',
    'form',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="dialog"]',
    '[data-map-wheel-scroll]',
    '.leaflet-control',
    '.leaflet-popup',
  ].join(','))
}
