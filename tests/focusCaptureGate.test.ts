import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCaptureFocusEvent } from '../src/main/services/focusCapture.ts'
import type { TrackingControlsState } from '../src/shared/trackingControls.ts'

const off: TrackingControlsState = {
  consented: true, enabled: false, paused: false, excludedApps: [], excludedSites: [], skipIncognito: true,
}
const on: TrackingControlsState = {
  consented: true, enabled: true, paused: false,
  excludedApps: ['app.zen-browser.zen'], excludedSites: ['private.example.com'], skipIncognito: true,
}

test('focus capture records normal app and site events', () => {
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.microsoft.VSCode', app_name: 'Cursor', window_title: 'main.ts', url: null }, on), true)
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.google.Chrome', app_name: 'Chrome', window_title: null, url: 'https://github.com/x' }, on), true)
})

test('focus capture drops system-noise events even with controls off', () => {
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.apple.loginwindow', app_name: 'loginwindow', window_title: null, url: null }, off), false)
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.apple.finder', app_name: 'Finder', window_title: null, url: null }, off), false)
})

test('focus capture drops events for an excluded app (incl. profile variant)', () => {
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'app.zen-browser.zen:work', app_name: 'Zen (work)', window_title: null, url: null }, on), false)
  // Same event passes when the feature is off — proves it is the exclusion, not noise.
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'app.zen-browser.zen:work', app_name: 'Zen (work)', window_title: null, url: null }, off), true)
})

test('focus capture drops events for an excluded site and its subdomains', () => {
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.google.Chrome', app_name: 'Chrome', window_title: null, url: 'https://private.example.com/plan' }, on), false)
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.google.Chrome', app_name: 'Chrome', window_title: null, url: 'https://team.private.example.com/x' }, on), false)
})

test('focus capture drops an unparseable url defensively', () => {
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.google.Chrome', app_name: 'Chrome', window_title: null, url: 'not a url' }, on), false)
})

test('focus capture drops incognito windows when enabled', () => {
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.google.Chrome', app_name: 'Chrome', window_title: 'Secret (Incognito)', url: null }, on), false)
})

test('focus capture always drops incognito windows, even with controls off', () => {
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.google.Chrome', app_name: 'Chrome', window_title: 'Secret (Incognito)', url: null }, off), false)
  assert.equal(shouldCaptureFocusEvent({ app_bundle_id: 'com.google.Chrome', app_name: 'Chrome', window_title: 'Docs — InPrivate', url: 'https://example.com/x' }, off), false)
})
