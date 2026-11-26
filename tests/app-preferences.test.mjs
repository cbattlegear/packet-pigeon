import assert from 'node:assert/strict'
import test from 'node:test'
import { clockFormatter, defaultPreferences, parseAppPreferences, resolveAppLanguage } from '../src/preferences/appPreferences.ts'

test('recovers defaults from missing, malformed, or invalid stored preferences', () => {
  for (const value of [null, 'null', '{', '{"appearance":true,"language":"es","clock":"utc","chatPreviews":"false"}']) {
    assert.deepEqual(parseAppPreferences(value), defaultPreferences)
  }
  assert.deepEqual(parseAppPreferences('{"appearance":"dark"}'), {
    ...defaultPreferences, appearance: 'dark',
  })
})

test('restores explicitly selected preferences', () => {
  const preferences = {
    appearance: 'light', language: 'en', clock: '24-hour',
    saveDrafts: false, oldestUnread: true, keepScreenOn: true, composerAutofocus: true,
    chatPreviews: false, pathMetadata: false, regionMetadata: false,
  }
  assert.deepEqual(parseAppPreferences(JSON.stringify(preferences)), {
    ...preferences,
    syncedMessageAlerts: false, discoveredContactAlerts: false, fullStorageAlerts: false,
  })
})

test('uses a supported browser language or falls back to English', () => {
  assert.equal(resolveAppLanguage('system', ['fr-CA', 'en-gb']), 'en-GB')
  assert.equal(resolveAppLanguage('system', ['en_US', 'en-AU']), 'en-AU')
  assert.equal(resolveAppLanguage('system', ['fr-CA']), 'en')
  assert.equal(resolveAppLanguage('system', []), 'en')
  assert.equal(resolveAppLanguage('en', ['en-GB']), 'en')
})

test('chat timestamps follow the chosen clock format or the selected locale', () => {
  assert.equal(clockFormatter('en-GB', '12-hour').resolvedOptions().hour12, true)
  assert.equal(clockFormatter('en-US', '24-hour').resolvedOptions().hour12, false)
  assert.equal(clockFormatter('en-GB', 'system').resolvedOptions().hour12, false)
  assert.equal(clockFormatter('en-US', 'system').resolvedOptions().hour12, true)
})
