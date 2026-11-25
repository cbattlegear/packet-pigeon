import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeContactPath, parseContactPath } from '../src/radio/contact-path.ts'

test('encodes contact hash widths with independent hop and byte limits', () => {
  for (const [width, count] of [[1, 63], [2, 32], [3, 21]]) {
    const text = Array(count).fill('aB'.repeat(width)).join(',')
    const parsed = parseContactPath(text, width)
    assert.equal(parsed.encoded & 63, count)
    assert.equal(parsed.hex.length / 2, width * count)
    assert.deepEqual(decodeContactPath(parsed.encoded, parsed.hex), {
      width, hops: Array(count).fill('ab'.repeat(width)),
    })
    assert.throws(() => parseContactPath(`${text},${'01'.repeat(width)}`, width), /at most/)
  }
  assert.throws(() => parseContactPath('1234 ab', 2), /complete 2-byte hex hashes/)
  assert.throws(() => parseContactPath('1234', 4), /1-, 2- or 3-byte/)
  assert.equal(parseContactPath('', 1).encoded, 0)
  assert.equal(decodeContactPath(255, ''), null)
  assert.equal(decodeContactPath(0xc0, ''), null)
})
