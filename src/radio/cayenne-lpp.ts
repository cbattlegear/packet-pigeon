type Reading = { channel: number; type: number; label: string; values: number[]; unit: string }
type Issue = { kind: 'truncated' | 'unsupported'; offset: number; type?: number }
type Format = {
  label: string
  size: number
  unit: string
  scale?: number
  signed?: boolean
  components?: number
}

// Extended Cayenne LPP types used by the MeshCore firmware.
const formats: Partial<Record<number, Format>> = {
  0: { label: 'Digital input', size: 1, unit: '' },
  1: { label: 'Digital output', size: 1, unit: '' },
  2: { label: 'Analog input', size: 2, unit: '', scale: 100, signed: true },
  3: { label: 'Analog output', size: 2, unit: '', scale: 100, signed: true },
  100: { label: 'Generic sensor', size: 4, unit: '' },
  101: { label: 'Illuminance', size: 2, unit: 'lx' },
  102: { label: 'Presence', size: 1, unit: '' },
  103: { label: 'Temperature', size: 2, unit: '°C', scale: 10, signed: true },
  104: { label: 'Relative humidity', size: 1, unit: '%', scale: 2 },
  113: { label: 'Acceleration', size: 6, unit: 'g', scale: 1000, signed: true, components: 3 },
  115: { label: 'Pressure', size: 2, unit: 'hPa', scale: 10 },
  116: { label: 'Voltage', size: 2, unit: 'V', scale: 100 },
  117: { label: 'Current', size: 2, unit: 'A', scale: 1000 },
  118: { label: 'Frequency', size: 4, unit: 'Hz' },
  120: { label: 'Percentage', size: 1, unit: '%' },
  121: { label: 'Altitude', size: 2, unit: 'm', signed: true },
  125: { label: 'Concentration', size: 2, unit: 'ppm' },
  128: { label: 'Power', size: 2, unit: 'W' },
  130: { label: 'Distance', size: 4, unit: 'm', scale: 1000 },
  131: { label: 'Energy', size: 4, unit: 'kWh', scale: 1000 },
  132: { label: 'Direction', size: 2, unit: '°' },
  133: { label: 'Unix time', size: 4, unit: 's' },
  134: { label: 'Rotation rate', size: 6, unit: '°/s', scale: 100, signed: true, components: 3 },
  135: { label: 'Color (RGB)', size: 3, unit: '', components: 3 },
  136: { label: 'Location', size: 9, unit: '', signed: true, components: 3 },
  142: { label: 'Switch', size: 1, unit: '' },
}

function readInteger(input: Uint8Array, offset: number, size: number, signed = false) {
  let value = signed && input[offset] >= 0x80 ? -1 : 0
  for (let index = offset; index < offset + size; index++) value = value * 256 + input[index]
  return value
}

export function decodeTelemetry(input: Uint8Array): { readings: Reading[]; issue?: Issue } {
  const readings: Reading[] = []
  for (let offset = 0; offset < input.length;) {
    if (offset + 2 > input.length) return { readings, issue: { kind: 'truncated', offset } }
    const channel = input[offset]
    const type = input[offset + 1]
    const format = formats[type]
    if (!format) return { readings, issue: { kind: 'unsupported', type, offset } }
    if (offset + 2 + format.size > input.length) return { readings, issue: { kind: 'truncated', type, offset } }
    const count = format.components ?? 1
    const width = format.size / count
    const values = Array.from({ length: count }, (_, index) => {
      const scale = type === 136 ? (index < 2 ? 10000 : 100) : (format.scale ?? 1)
      return readInteger(input, offset + 2 + index * width, width, format.signed) / scale
    })
    const label = channel === 1 && type === 116 ? 'Battery voltage' : format.label
    readings.push({ channel, type, label, unit: format.unit, values })
    offset += 2 + format.size
  }
  return { readings }
}
