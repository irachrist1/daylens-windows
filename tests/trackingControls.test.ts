import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideAppCapture,
  decideSiteCapture,
  detectIncognitoFromTitle,
  isAppExcluded,
  isSiteExcluded,
  trackingControlsStateFromSettings,
  type TrackingControlsState,
} from '../src/shared/trackingControls.ts'

const base: TrackingControlsState = {
  consented: true,
  enabled: false,
  paused: false,
  excludedApps: [],
  excludedSites: [],
  skipIncognito: true,
}

// ── Invariant: OFF + unpaused passes everything through except private windows ─

test('disabled and unpaused captures everything except private windows', () => {
  const s = { ...base, enabled: false, excludedApps: ['com.foo'], excludedSites: ['x.com'] }
  assert.deepEqual(decideAppCapture(s, { bundleId: 'com.foo', appName: 'Foo' }), { capture: true, reason: null })
  assert.deepEqual(decideSiteCapture(s, { domain: 'x.com' }), { capture: true, reason: null })
  // Private windows are the one unconditional exclusion.
  assert.equal(decideAppCapture(s, { windowTitle: 'Secret (Incognito)' }).reason, 'incognito')
})

// ── Pause works regardless of the master switch (acceptance #5) ────────────────

test('pause blocks capture even when the feature is disabled', () => {
  const s = { ...base, enabled: false, paused: true }
  assert.deepEqual(decideAppCapture(s, { bundleId: 'com.foo' }), { capture: false, reason: 'paused' })
  assert.deepEqual(decideSiteCapture(s, { domain: 'x.com' }), { capture: false, reason: 'paused' })
})

// ── App exclusion (acceptance #3) ──────────────────────────────────────────────

test('app exclusion matches bundle id or app name, case-insensitively, only when enabled', () => {
  const s = { ...base, enabled: true, excludedApps: ['com.tinyspeck.slackmacgap', 'Messages'] }
  assert.equal(isAppExcluded(s, { bundleId: 'com.tinyspeck.slackmacgap' }), true)
  assert.equal(isAppExcluded(s, { appName: 'messages' }), true)
  assert.equal(isAppExcluded(s, { bundleId: 'com.apple.Safari', appName: 'Safari' }), false)
  assert.equal(decideAppCapture(s, { bundleId: 'com.tinyspeck.slackmacgap' }).reason, 'excluded_app')
  // Same lists, feature disabled → not excluded.
  assert.equal(isAppExcluded({ ...s, enabled: false }, { bundleId: 'com.tinyspeck.slackmacgap' }), false)
})

test('app exclusion matches canonical identity and browser profile variants', () => {
  const s = {
    ...base,
    enabled: true,
    excludedApps: ['chrome', 'app.zen-browser.zen'],
  }
  // Excluding the canonical id "chrome" drops a profile-suffixed bundle.
  assert.equal(decideAppCapture(s, {
    bundleId: 'com.google.Chrome:Profile 1',
    canonicalAppId: 'chrome',
    appName: 'Google Chrome (Profile 1)',
  }).reason, 'excluded_app')
  // Excluding the base bundle id drops a profile variant even without canonical.
  assert.equal(decideAppCapture(s, {
    bundleId: 'app.zen-browser.zen:work',
    appName: 'Zen (work)',
  }).reason, 'excluded_app')
})

// ── Site exclusion incl. subdomains + www (acceptance #3) ──────────────────────

test('site exclusion matches the host and its subdomains, ignoring www', () => {
  const s = { ...base, enabled: true, excludedSites: ['youtube.com'] }
  assert.equal(isSiteExcluded(s, { domain: 'youtube.com' }), true)
  assert.equal(isSiteExcluded(s, { domain: 'www.youtube.com' }), true)
  assert.equal(isSiteExcluded(s, { domain: 'm.youtube.com' }), true)
  assert.equal(isSiteExcluded(s, { domain: 'notyoutube.com' }), false)
  assert.equal(isSiteExcluded(s, { domain: 'github.com' }), false)
  assert.equal(decideSiteCapture(s, { domain: 'm.youtube.com' }).reason, 'excluded_site')
})

// ── Incognito (acceptance #4) ──────────────────────────────────────────────────

test('detectIncognitoFromTitle catches common browser private markers', () => {
  assert.equal(detectIncognitoFromTitle('YouTube - Google Chrome (Incognito)'), true)
  assert.equal(detectIncognitoFromTitle('Bank - Microsoft Edge [InPrivate]'), true)
  assert.equal(detectIncognitoFromTitle('Search - Mozilla Firefox (Private Browsing)'), true)
  assert.equal(detectIncognitoFromTitle('Reddit - Google Chrome'), false)
  assert.equal(detectIncognitoFromTitle(null), false)
})

test('private windows are never captured, regardless of any setting', () => {
  const off = { ...base, enabled: false, skipIncognito: false }
  assert.equal(decideAppCapture(off, { windowTitle: 'x (Incognito)' }).reason, 'incognito')
  assert.equal(decideSiteCapture(off, { domain: 'example.com', windowTitle: 'x [InPrivate]' }).reason, 'incognito')
})

test('the structured private-window signal blocks capture even without a title marker', () => {
  // Chrome on macOS puts no marker in the window title; the browser reader
  // supplies isPrivate from the window mode instead.
  const off = { ...base, enabled: false, skipIncognito: false }
  assert.equal(decideSiteCapture(off, { domain: 'example.com', windowTitle: 'Some page', isPrivate: true }).reason, 'incognito')
  assert.equal(decideAppCapture(off, { appName: 'Chrome', windowTitle: 'Some page', isPrivate: true }).reason, 'incognito')
  assert.equal(decideSiteCapture(off, { domain: 'example.com', windowTitle: 'Some page', isPrivate: false }).capture, true)
})

// ── Settings adapter defaults ──────────────────────────────────────────────────

test('trackingControlsStateFromSettings defaults to opt-in-off with incognito-skip on', () => {
  const s = trackingControlsStateFromSettings({})
  // consented defaults FALSE — absent consent means capture refuses everything.
  assert.deepEqual(s, { consented: false, enabled: false, paused: false, excludedApps: [], excludedSites: [], skipIncognito: true })
})
