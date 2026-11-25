import assert from 'node:assert/strict'
import test from 'node:test'
import {
  coveragePlan, coverageSamples, evaluateProfile, importCoverage, profilePlan, readElevationArray, validateCoverage,
} from '../src/map/terrain.ts'

const origin = { lat: 0, lon: 0 }
const antennas = { txHeight: 10, rxHeight: 10 }

test('profiles clear and blocked terrain and accounts for the curvature of Earth', () => {
  const short = profilePlan(origin, { lat: 0.05, lon: 0 })
  const flat = short.positions.map(() => 10)
  assert.equal(evaluateProfile(short, flat, antennas).clear, true)
  const ridge = [...flat]
  ridge[32] += 50
  const obstructed = evaluateProfile(short, ridge, antennas)
  assert.equal(obstructed.clear, false)
  assert.equal(obstructed.lowest.elevation, 60)

  const long = profilePlan(origin, { lat: 0.5, lon: 0 })
  assert.equal(evaluateProfile(long, flat, antennas).clear, false)
  assert.throws(() => profilePlan(origin, origin), /between 100 m and 300 km/)
})

test('samples the short path across the antimeridian', () => {
  const plan = profilePlan({ lat: 12, lon: 179.9 }, { lat: 12, lon: -179.9 })
  assert(plan.distanceM > 20_000 && plan.distanceM < 24_000)
  assert(plan.positions.every(({ lon }) => Math.abs(lon) > 179.8))
})

test('coverage flags terrain shadow behind a ridge without affecting other bearings', () => {
  const request = validateCoverage(origin, 8, antennas)
  const positions = coveragePlan(request)
  assert.equal(positions.length, 97)
  const heights = positions.map(() => 50)
  heights[2] = 270
  const samples = coverageSamples({ request, elevations: heights })
  assert.equal(samples[1].clear, true)
  assert.equal(samples[2].clear, false)
  assert.equal(samples[8].clear, true)
  assert.throws(() => validateCoverage({ lat: 85.05, lon: 0 }, 50, antennas), /latitude limit/)
})

test('checks provider and import data and round-trips layer parameters', () => {
  const request = validateCoverage(origin, 5, antennas)
  const layer = {
    name: 'Test site', visible: false, request, elevations: coveragePlan(request).map(() => 0),
  }
  const exported = JSON.stringify({ version: 1, layers: [{ ...layer, id: 'old-id' }] })
  assert.deepEqual(importCoverage(JSON.parse(exported)), [layer])
  assert.throws(() => importCoverage({ version: 1, layers: [{ ...layer, elevations: [1] }] }), /missing or invalid/)
  assert.throws(() => readElevationArray([40, null], 2), /missing or invalid/)
})
