import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import {
  ActiveBrowserContextTracker,
  __setActiveBrowserContextTrackerForTest,
} from '../src/main/services/browserContext.ts'
import { __pollForTest, __setTrackingFsmTestHarness } from '../src/main/services/tracking.ts'
import { shouldCaptureFocusEvent } from '../src/main/services/focusCapture.ts'
import { insertFocusEvents } from '../src/main/db/focusEventRepository.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { getCorrectedAppSummariesForRange } from '../src/main/services/activityFacts.ts'
import { searchAll } from '../src/main/db/queries.ts'
import {
  chatMemoryPromptBlock,
  getScopedMemoryProfile,
} from '../src/main/services/workMemoryProfile.ts'
import { executeTool } from '../src/main/services/aiTools.ts'
import { localDayBounds } from '../src/main/lib/localDate.ts'
import type { TrackingControlsState } from '../src/shared/trackingControls.ts'
import type { FocusEvent } from '../src/main/core/evidence/focusEvent.ts'

const DATE = '2026-07-03'
const BASE = new Date(2026, 6, 3, 10, 0, 0, 0).getTime()
const controls: TrackingControlsState = {
  enabled: true,
  paused: false,
  excludedApps: ['app.zen-browser.zen', 'Zen'],
  excludedSites: ['private.example.com'],
  skipIncognito: true,
}

test('private and excluded observations cannot reach storage or downstream product facts', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  __setSettings({
    trackingControlsEnabled: true,
    trackingExcludedApps: controls.excludedApps,
    trackingExcludedSites: controls.excludedSites,
    trackingSkipIncognito: true,
  })

  let scenario: 'allowed-app' | 'excluded-app' | 'private' | 'excluded-site' | 'allowed-site' =
    'allowed-app'
  const clock = { now: BASE }
  __setActiveBrowserContextTrackerForTest(
    new ActiveBrowserContextTracker(
      () => {
        if (scenario === 'private')
          return { url: '', title: null, isPrivate: true, modeKnown: true }
        if (scenario === 'excluded-site') {
          return {
            url: 'https://private.example.com/private-quarterly-plan',
            title: 'Private quarterly plan',
            modeKnown: false,
          }
        }
        if (scenario === 'allowed-site') {
          return { url: 'https://github.com/daylens/daylens', title: 'Daylens', modeKnown: true }
        }
        return null
      },
      (snapshot) => snapshot.appName === 'Dia' || snapshot.appName === 'Google Chrome',
    ),
  )
  __setTrackingFsmTestHarness({
    platform: 'darwin',
    now: () => clock.now,
    idleSeconds: () => 0,
    activeWindow: () => {
      switch (scenario) {
        case 'allowed-app':
          return {
            title: 'daylens — main.ts',
            application: 'Cursor',
            path: '/Applications/Cursor.app',
            pid: 1,
            icon: '',
          }
        case 'excluded-app':
          return {
            title: 'Private client plan',
            application: 'Zen',
            path: '/Applications/Zen.app',
            bundleId: 'app.zen-browser.zen',
            pid: 2,
            icon: '',
          }
        case 'private':
          return {
            title: 'Unmarked browser window',
            application: 'Dia',
            path: '/Applications/Dia.app',
            pid: 3,
            icon: '',
          }
        case 'excluded-site':
          return {
            title: 'Private quarterly plan',
            application: 'Google Chrome',
            path: '/Applications/Google Chrome.app',
            pid: 4,
            icon: '',
          }
        case 'allowed-site':
          return {
            title: 'Daylens',
            application: 'Google Chrome',
            path: '/Applications/Google Chrome.app',
            pid: 4,
            icon: '',
          }
      }
    },
  })

  const poll = async (at: number, next: typeof scenario) => {
    clock.now = at
    scenario = next
    await __pollForTest()
  }

  try {
    await poll(BASE, 'allowed-app')
    await poll(BASE + 30_000, 'excluded-app')
    await poll(BASE + 60_000, 'private')
    await poll(BASE + 90_000, 'excluded-site')
    await poll(BASE + 120_000, 'allowed-site')
    await poll(BASE + 150_000, 'allowed-site')
    await poll(BASE + 180_000, 'excluded-app')

    const blockedFocusEvents: FocusEvent[] = [
      {
        ts_ms: BASE + 30_000,
        mono_ns: 1,
        event_type: 'app_activated',
        app_bundle_id: 'app.zen-browser.zen',
        app_name: 'Zen',
        pid: 2,
        window_title: 'Private client plan',
        url: null,
        page_title: null,
        source: 'macos_ax_observer',
        confidence: 'observed',
        platform: 'darwin',
        schema_ver: 1,
      },
      {
        ts_ms: BASE + 60_000,
        mono_ns: 2,
        event_type: 'window_changed',
        app_bundle_id: 'company.thebrowser.dia',
        app_name: 'Dia',
        pid: 3,
        window_title: 'Private Browsing',
        url: null,
        page_title: null,
        source: 'macos_ax_observer',
        confidence: 'observed',
        platform: 'darwin',
        schema_ver: 1,
      },
      {
        ts_ms: BASE + 90_000,
        mono_ns: 3,
        event_type: 'tab_changed',
        app_bundle_id: 'com.google.Chrome',
        app_name: 'Google Chrome',
        pid: 4,
        window_title: 'Private quarterly plan',
        url: 'https://private.example.com/private-quarterly-plan',
        page_title: 'Private quarterly plan',
        source: 'apple_events_tab',
        confidence: 'observed',
        platform: 'darwin',
        schema_ver: 1,
      },
    ]
    const accepted = blockedFocusEvents.filter((event) => shouldCaptureFocusEvent(event, controls))
    insertFocusEvents(db, accepted)
    assert.equal(
      accepted.length,
      0,
      'capture privacy gate must reject every blocked canonical event',
    )

    const storedSessions = db
      .prepare(
        `
      SELECT app_name, window_title FROM app_sessions ORDER BY start_time
    `,
      )
      .all() as Array<{ app_name: string; window_title: string | null }>
    assert.deepEqual(
      storedSessions.map((row) => row.app_name),
      ['Cursor', 'Google Chrome'],
    )
    assert.doesNotMatch(JSON.stringify(storedSessions), /Zen|Private|Dia/i)

    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'website_visits_pending'",
          )
          .get() as { count: number }
      ).count,
      0,
      'website_visits_pending must not exist after privacy-verified browser evidence',
    )
    // The canonical store mirrors allowed foreground observations — nothing
    // blocked may reach it.
    const focusRows = db.prepare('SELECT event_type, app_name, window_title, url, page_title FROM focus_events').all()
    assert.doesNotMatch(JSON.stringify(focusRows), /Zen|private\.example|Private quarterly|Dia/i)
    const visits = db.prepare('SELECT domain, page_title, url FROM website_visits').all()
    assert.deepEqual(visits, [
      { domain: 'github.com', page_title: 'Daylens', url: 'https://github.com/daylens/daylens' },
    ])

    const [fromMs, toMs] = localDayBounds(DATE)
    const timeline = getTimelineDayPayload(db, DATE, null)
    const apps = getCorrectedAppSummariesForRange(db, fromMs, toMs)
    assert.doesNotMatch(JSON.stringify(timeline), /Zen|private\.example|Private quarterly|Dia/i)
    assert.doesNotMatch(JSON.stringify(apps), /Zen|private\.example|Private quarterly|Dia/i)

    for (const query of ['Zen', 'private.example.com', 'quarterly', 'Dia']) {
      assert.deepEqual(searchAll(db, query), [], `search leaked blocked query: ${query}`)
    }
    assert.doesNotMatch(
      chatMemoryPromptBlock(db, 'What did I do?'),
      /Zen|private\.example|quarterly|Dia/i,
    )
    assert.doesNotMatch(
      JSON.stringify(getScopedMemoryProfile(db)),
      /Zen|private\.example|quarterly|Dia/i,
    )

    const aiSearch = executeTool('searchSessions', { query: 'quarterly' }, db, controls)
    const aiDay = executeTool('getDaySummary', { date: DATE }, db, controls)
    assert.deepEqual((aiSearch as { hits: unknown[] }).hits, [])
    assert.doesNotMatch(JSON.stringify(aiDay), /Zen|private\.example|quarterly|Dia/i)

    const mcpSearch = executeTool('searchSessions', { query: 'private' }, db, controls)
    assert.deepEqual((mcpSearch as { hits: unknown[] }).hits, [])
  } finally {
    __setTrackingFsmTestHarness(null)
    __setActiveBrowserContextTrackerForTest(null)
    __resetSettings()
    clearTestDb()
    db.close()
  }
})

test('an excluded site with unknown browser mode never enters page evidence', () => {
  const db = createProductionTestDatabase()
  __setSettings({
    trackingControlsEnabled: true,
    trackingExcludedSites: ['private.example.com'],
  })
  try {
    const tracker = new ActiveBrowserContextTracker(
      () => ({
        url: 'https://private.example.com/secret',
        title: 'Secret',
        modeKnown: false,
      }),
      () => true,
    )
    const result = tracker.sample(db, {
      bundleId: 'com.google.Chrome',
      appName: 'Google Chrome',
      windowTitle: 'Secret',
      capturedAt: BASE,
    })
    assert.equal(result.captureBlockReason, 'excluded_site')
    tracker.flush(db, BASE + 60_000)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM website_visits').get() as { count: number }).count,
      0,
    )
  } finally {
    __resetSettings()
    db.close()
  }
})
