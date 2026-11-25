import type { RadioParameters } from './protocol.ts'
import { CompanionError, Response } from './protocol.ts'
import { expectResponse } from './serial-link.ts'
import type { SerialLink } from './serial-link.ts'

export function setupRadioCommand(settings: RadioParameters, repeatEnabled: boolean | null) {
  const { frequencyMHz, bandwidthKHz, spreadingFactor, codingRate } = settings
  const frequency = Math.round(frequencyMHz * 1_000)
  const bandwidth = Math.round(bandwidthKHz * 1_000)
  if (!Number.isFinite(frequencyMHz) || frequencyMHz < 150 || frequencyMHz > 2_500 ||
    !Number.isFinite(bandwidthKHz) || bandwidthKHz < 7 || bandwidthKHz > 500 ||
    Math.abs(frequencyMHz * 1_000 - frequency) > 1e-6 ||
    Math.abs(bandwidthKHz * 1_000 - bandwidth) > 1e-6 ||
    !Number.isInteger(spreadingFactor) || spreadingFactor < 5 || spreadingFactor > 12 ||
    !Number.isInteger(codingRate) || codingRate < 5 || codingRate > 8) {
    throw new Error('The setup link contains radio settings outside the companion firmware limits.')
  }
  const command = new Uint8Array(repeatEnabled === null ? 11 : 12)
  command[0] = 11
  const data = new DataView(command.buffer)
  data.setUint32(1, frequency, true)
  data.setUint32(5, bandwidth, true)
  command[9] = spreadingFactor
  command[10] = codingRate
  if (repeatEnabled !== null) command[11] = Number(repeatEnabled)
  return command
}

async function writeSetupCommand(link: SerialLink, command: Uint8Array) {
  const result = await link.request(command, (frame) => {
    if (frame[0] !== Response.error && frame[0] !== Response.disabled) expectResponse(frame, Response.ok)
    return { value: frame }
  })
  expectResponse(result, Response.ok)
}

export async function writeSetupRadioSettings(link: SerialLink, settings: RadioParameters, repeatEnabled: boolean | null) {
  await writeSetupCommand(link, setupRadioCommand(settings, repeatEnabled))
}

export async function writeSetupPathWidth(link: SerialLink, width: number) {
  if (!Number.isInteger(width) || width < 1 || width > 3) {
    throw new CompanionError('protocol', 'Choose a 1-, 2- or 3-byte path hash.')
  }
  await writeSetupCommand(link, Uint8Array.of(61, 0, width - 1))
}
