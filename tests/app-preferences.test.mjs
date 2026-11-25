import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAppPreferences, resolveAppLanguage } from '../src/preferences/appPreferences.ts'

const defaults = { appearance: 'system', language: 'system' }

test('recovers defaults from missing, malformed, or invalid stored preferences', () => {
  for (const value of [null, 'null', '{', '{"appearance":true,"language":"es"}']) {
    assert.deepEqual(parseAppPreferences(value), defaults)
  }
  assert.deepEqual(parseAppPreferences('{"appearance":"dark"}'), {
    appearance: 'dark', language: 'system',
  })
})

test('restores explicitly selected preferences', () => {
  const preferences = { appearance: 'light', language: 'en' }
  assert.deepEqual(parseAppPreferences(JSON.stringify(preferences)), preferences)
})

test('uses a supported browser language or falls back to English', () => {
  assert.equal(resolveAppLanguage('system', ['fr-CA', 'en-gb']), 'en-GB')
  assert.equal(resolveAppLanguage('system', ['fr-CA']), 'en')
  assert.equal(resolveAppLanguage('system', []), 'en')
  assert.equal(resolveAppLanguage('en', ['en-GB']), 'en')
})
