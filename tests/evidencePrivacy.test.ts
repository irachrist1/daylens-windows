import test from 'node:test'
import assert from 'node:assert/strict'
import { filterTrackingExcludedEvidence } from '../src/shared/evidencePrivacy.ts'
import type { TrackingControlsState } from '../src/shared/trackingControls.ts'

const controls: TrackingControlsState = {
  consented: true,
  enabled: true,
  paused: false,
  excludedApps: ['app.zen-browser.zen'],
  excludedSites: ['private.example.com'],
  skipIncognito: true,
}

test('AI evidence boundary removes excluded apps, sites, and system surfaces', () => {
  const filtered = filterTrackingExcludedEvidence({
    topApps: [
      { bundleId: 'app.zen-browser.zen:work', appName: 'Zen', totalSeconds: 600 },
      { bundleId: 'com.apple.loginwindow', appName: 'loginwindow', totalSeconds: 300 },
      { bundleId: 'com.microsoft.VSCode', appName: 'Cursor', totalSeconds: 900 },
    ],
    pages: [
      { domain: 'private.example.com', url: 'https://private.example.com/plan', pageTitle: 'Private plan' },
      { domain: 'github.com', url: 'https://github.com/openai', pageTitle: 'OpenAI' },
    ],
  }, controls) as {
    topApps: Array<{ appName: string }>
    pages: Array<{ domain: string }>
  }

  assert.deepEqual(filtered.topApps.map((app) => app.appName), ['Cursor'])
  assert.deepEqual(filtered.pages.map((page) => page.domain), ['github.com'])
})

test('AI evidence boundary redacts excluded values embedded in derived labels', () => {
  const filtered = filterTrackingExcludedEvidence({
    label: 'Planning on private.example.com',
    narrative: 'Zen was open beside Cursor',
  }, controls) as { label: string; narrative: string }

  assert.equal(filtered.label, '[excluded]')
  assert.equal(filtered.narrative, 'Zen was open beside Cursor')
})

test('short app exclusions do not corrupt unrelated words', () => {
  const filtered = filterTrackingExcludedEvidence({
    architecture: 'Architecture review',
    diagram: 'Diagramming the resolver boundary',
    exactArc: 'Arc was open',
    exactDia: 'Dia was open',
  }, {
    ...controls,
    excludedApps: ['Arc', 'Dia'],
    excludedSites: [],
  }) as Record<string, string>

  assert.equal(filtered.architecture, 'Architecture review')
  assert.equal(filtered.diagram, 'Diagramming the resolver boundary')
  assert.equal(filtered.exactArc, '[excluded]')
  assert.equal(filtered.exactDia, '[excluded]')
})

test('excluding a site redacts its brand in derived labels and page titles', () => {
  // Found by driving real captured data: excluding "youtube.com" dropped the
  // structured domain row but left "Watching YouTube" block labels and
  // "… - YouTube" page titles naming the site to the AI/MCP. A site exclusion
  // must redact the brand token, not only the literal host.
  const filtered = filterTrackingExcludedEvidence({
    blocks: [
      { label: 'Watching YouTube', pageTitles: ['Some talk - YouTube', 'Keep me'] },
      { label: 'On SomeSite & YouTube', pageTitles: [] },
    ],
    topWebsiteDomains: [
      { domain: 'youtube.com', totalSeconds: 600 },
      { domain: 'github.com', totalSeconds: 300 },
    ],
  }, {
    ...controls,
    excludedApps: [],
    excludedSites: ['youtube.com'],
  }) as {
    blocks: Array<{ label: string; pageTitles: string[] }>
    topWebsiteDomains: Array<{ domain: string }>
  }

  assert.equal(filtered.blocks[0].label, '[excluded]')
  assert.equal(filtered.blocks[0].pageTitles[0], '[excluded]')
  assert.equal(filtered.blocks[0].pageTitles[1], 'Keep me')
  // A string mentioning the excluded brand is redacted whole — the
  // surrounding context goes with it, never leaving a hint.
  assert.equal(filtered.blocks[1].label, '[excluded]')
  assert.deepEqual(filtered.topWebsiteDomains.map((w) => w.domain), ['github.com'])
})

test('brand redaction stays word-bounded (no substring corruption)', () => {
  const filtered = filterTrackingExcludedEvidence({
    a: 'A YouTuber reviewed it',   // "youtuber" must NOT be redacted
    b: 'media diagram review',      // unrelated to excluded "dia.com" brand "dia"
    c: 'Watching YouTube now',      // exact brand → redacted
  }, {
    ...controls,
    excludedApps: [],
    excludedSites: ['youtube.com', 'dia.com'],
  }) as Record<string, string>

  assert.equal(filtered.a, 'A YouTuber reviewed it')
  assert.equal(filtered.b, 'media diagram review')
  assert.equal(filtered.c, '[excluded]')
})

test('multi-label excluded host does not nuke the parent brand', () => {
  // Excluding a specific subdomain redacts the full host but must not redact
  // every mention of the parent ("docs.google.com" ≠ hide all "Google").
  const filtered = filterTrackingExcludedEvidence({
    a: 'Opened docs.google.com',
    b: 'Google Search and Google Docs',
  }, {
    ...controls,
    excludedApps: [],
    excludedSites: ['docs.google.com'],
  }) as Record<string, string>

  assert.equal(filtered.a, '[excluded]')
  assert.equal(filtered.b, 'Google Search and Google Docs')
})

test('a page hit that carries the domain as appName (null url) is dropped by site exclusion', () => {
  // recall/search "page" hits set appName = the visited domain and url can be
  // null. Site exclusion must still catch it even though the host is not under
  // a domain/url key.
  const filtered = filterTrackingExcludedEvidence({
    hits: [
      { kind: 'page', appName: 'youtube.com', windowTitle: 'Some talk', url: null },
      { kind: 'page', appName: 'github.com', windowTitle: 'a repo', url: null },
      { kind: 'session', appName: 'Cursor', windowTitle: 'main.ts', url: null },
    ],
  }, {
    ...controls,
    excludedApps: [],
    excludedSites: ['youtube.com'],
  }) as { hits: Array<{ appName: string }> }

  assert.deepEqual(filtered.hits.map((h) => h.appName), ['github.com', 'Cursor'])
})

test('a compound-TLD site exclusion redacts its brand (bbc.co.uk → "BBC")', () => {
  const filtered = filterTrackingExcludedEvidence({
    label: 'Watching BBC',
    keep: 'Reading the news',
  }, {
    ...controls,
    excludedApps: [],
    excludedSites: ['bbc.co.uk'],
  }) as Record<string, string>

  assert.equal(filtered.label, '[excluded]')
  assert.equal(filtered.keep, 'Reading the news')
})

test('an app excluded by bundle id is dropped even when the record also carries its name', () => {
  const filtered = filterTrackingExcludedEvidence({
    topApps: [
      { appName: 'Zen', bundleId: 'app.zen-browser.zen', totalSeconds: 600 },
      { appName: 'Cursor', bundleId: 'com.microsoft.VSCode', totalSeconds: 900 },
    ],
  }, {
    ...controls,
    excludedApps: ['app.zen-browser.zen'],
    excludedSites: [],
  }) as { topApps: Array<{ appName: string }> }

  assert.deepEqual(filtered.topApps.map((a) => a.appName), ['Cursor'])
})

test('system noise is stripped even when tracking controls are disabled', () => {
  const filtered = filterTrackingExcludedEvidence({
    topApps: [
      { bundleId: 'com.apple.finder', appName: 'Finder', totalSeconds: 120 },
      { bundleId: 'com.microsoft.VSCode', appName: 'Cursor', totalSeconds: 900 },
    ],
  }, {
    enabled: false,
    paused: false,
    excludedApps: ['app.zen-browser.zen'],
    excludedSites: ['private.example.com'],
    skipIncognito: true,
  }) as { topApps: Array<{ appName: string }> }

  // Controls off → user exclusions do not apply, but invisible OS surfaces
  // still never leave the machine.
  assert.deepEqual(filtered.topApps.map((app) => app.appName), ['Cursor'])
})

test('canonical-id exclusion drops every browser profile variant', () => {
  const filtered = filterTrackingExcludedEvidence({
    topApps: [
      { bundleId: 'com.google.Chrome:Profile 1', canonicalAppId: 'chrome', appName: 'Google Chrome (Profile 1)', totalSeconds: 600 },
      { bundleId: 'com.google.Chrome:Profile 2', canonicalAppId: 'chrome', appName: 'Google Chrome (Profile 2)', totalSeconds: 300 },
      { bundleId: 'com.microsoft.VSCode', appName: 'Cursor', totalSeconds: 900 },
    ],
  }, {
    ...controls,
    excludedApps: ['chrome'],
    excludedSites: [],
  }) as { topApps: Array<{ appName: string }> }

  assert.deepEqual(filtered.topApps.map((app) => app.appName), ['Cursor'])
})
