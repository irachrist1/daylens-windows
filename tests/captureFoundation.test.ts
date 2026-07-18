import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getAppSummariesForRange, getSessionsForRange } from '../src/main/db/queries.ts'
import { localDayBounds } from '../src/main/lib/localDate.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { isSystemNoiseApp } from '../src/shared/systemNoise.ts'

function localMs(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function insertAppSession(
  db: Database.Database,
  input: {
    bundleId: string
    appName: string
    start: number
    end: number
    category?: string
    windowTitle?: string | null
    canonicalAppId?: string | null
  },
): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 2)
  `).run(
    input.bundleId,
    input.appName,
    input.start,
    input.end,
    Math.round((input.end - input.start) / 1_000),
    input.category ?? 'development',
    input.windowTitle ?? null,
    input.appName,
    input.canonicalAppId ?? null,
  )
}

test('system surfaces stay out of captured sessions even when legacy rows exist', () => {
  const db = createProductionTestDatabase()
  const date = '2026-06-18'
  const [from, to] = localDayBounds(date)

  insertAppSession(db, {
    bundleId: 'com.apple.loginwindow',
    appName: 'Login Window',
    start: localMs(date, 8),
    end: localMs(date, 9),
  })
  insertAppSession(db, {
    bundleId: 'com.apple.finder',
    appName: 'Finder',
    start: localMs(date, 9),
    end: localMs(date, 9, 30),
  })
  insertAppSession(db, {
    bundleId: 'com.apple.UserNotificationCenter',
    appName: 'UserNotificationCenter',
    start: localMs(date, 9, 30),
    end: localMs(date, 10),
  })
  insertAppSession(db, {
    bundleId: 'com.microsoft.VSCode',
    appName: 'Cursor',
    start: localMs(date, 10),
    end: localMs(date, 11),
    windowTitle: 'daylens — Cursor',
  })

  const sessions = getSessionsForRange(db, from, to)
  assert.equal(sessions.length, 1)
  assert.ok(!sessions.some((session) =>
    ['finder', 'login window', 'usernotificationcenter'].includes(session.appName.toLowerCase())))
  db.close()
})

test('legacy executable paths collapse into the same canonical app rows as bundle ids', () => {
  const db = createProductionTestDatabase()
  const date = '2026-06-18'
  const [from, to] = localDayBounds(date)

  insertAppSession(db, {
    bundleId: '/Applications/Claude.app/Contents/MacOS/Claude',
    appName: 'Claude',
    start: localMs(date, 9),
    end: localMs(date, 9, 30),
  })
  insertAppSession(db, {
    bundleId: 'com.anthropic.claudefordesktop',
    appName: 'Claude',
    start: localMs(date, 10),
    end: localMs(date, 10, 30),
  })

  const summaries = getAppSummariesForRange(db, from, to)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].canonicalAppId, 'claude')
  assert.equal(summaries[0].appName, 'Claude')
  assert.equal(summaries[0].totalSeconds, 60 * 60)
  db.close()
})

test('legacy and current Zen identities collapse into one browsing row', () => {
  const db = createProductionTestDatabase()
  const date = '2026-06-18'
  const [from, to] = localDayBounds(date)

  insertAppSession(db, {
    bundleId: '/Applications/Zen.app/Contents/MacOS/zen',
    appName: 'Zen',
    start: localMs(date, 9),
    end: localMs(date, 9, 30),
    category: 'uncategorized',
    canonicalAppId: '/applications/zen.app/contents/macos/zen',
  })
  insertAppSession(db, {
    bundleId: 'app.zen-browser.zen',
    appName: 'Zen',
    start: localMs(date, 10),
    end: localMs(date, 10, 30),
    category: 'uncategorized',
    canonicalAppId: 'app.zen-browser.zen',
  })

  const summaries = getAppSummariesForRange(db, from, to)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].canonicalAppId, 'zen')
  assert.equal(summaries[0].appName, 'Zen')
  assert.equal(summaries[0].category, 'browsing')
  assert.equal(summaries[0].totalSeconds, 60 * 60)
  db.close()
})

test('browser app summaries stay browsing even when captured with stale focused categories', () => {
  const db = createProductionTestDatabase()
  const date = '2026-06-18'
  const [from, to] = localDayBounds(date)

  insertAppSession(db, {
    bundleId: 'app.zen-browser.zen',
    appName: 'Zen',
    start: localMs(date, 9),
    end: localMs(date, 9, 30),
    category: 'productivity',
    canonicalAppId: 'app.zen-browser.zen',
  })

  const summaries = getAppSummariesForRange(db, from, to)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].appName, 'Zen')
  assert.equal(summaries[0].category, 'browsing')
  assert.equal(summaries[0].isFocused, false)
  db.close()
})

test('shared system-noise policy covers bundle and display-name variants', () => {
  assert.equal(isSystemNoiseApp({ bundleId: 'com.apple.loginwindow', appName: 'LoginWindow' }), true)
  assert.equal(isSystemNoiseApp({ bundleId: 'com.apple.UserNotificationCenter', appName: 'Notifications' }), true)
  assert.equal(isSystemNoiseApp({ bundleId: 'com.apple.WindowManager', appName: 'WindowManager' }), true)
  assert.equal(isSystemNoiseApp({ bundleId: 'com.apple.finder', appName: 'Finder' }), true)
  assert.equal(isSystemNoiseApp({ bundleId: 'com.microsoft.VSCode', appName: 'Cursor' }), false)
})

test('overlapping capture rows are coalesced before engagement totals are counted', () => {
  const db = createProductionTestDatabase()
  const date = '2026-06-18'
  const start = localMs(date, 10)
  const end = localMs(date, 10, 30)

  insertAppSession(db, {
    bundleId: 'com.microsoft.VSCode',
    appName: 'Cursor',
    start,
    end,
    windowTitle: 'capture-foundation.ts — daylens',
  })
  insertAppSession(db, {
    bundleId: 'com.microsoft.VSCode',
    appName: 'Cursor',
    start: start + 5_000,
    end,
    windowTitle: 'capture-foundation.ts — daylens',
  })

  const [summary] = getAppSummariesForRange(db, start, end)
  assert.equal(summary.totalSeconds, 30 * 60)
  assert.equal(summary.sessionCount, 1)
  db.close()
})

test('a timeline block persists one rich evidence object with titles, sites, URLs, and files', () => {
  const db = createProductionTestDatabase()
  const date = '2026-06-18'
  const start = localMs(date, 10)
  const end = localMs(date, 11)

  // Cursor's own session leaves a genuine ~10-minute capture gap (well under
  // the 15-minute block-split floor) rather than covering the whole hour —
  // otherwise the github.com visit below would be sitting behind a focused
  // native app the entire time and correctly reconcile to zero (divergence
  // #4: page-level evidence must reconcile against real foreground/gap
  // overlap the same way domain-level summaries do; see queries.ts
  // reconcileWebsiteVisits). The visit spans the gap plus a few minutes back
  // inside Cursor's second session, so it still nets positive credited time
  // and survives as evidence, same as it did when captured for real.
  insertAppSession(db, {
    bundleId: 'com.microsoft.VSCode',
    appName: 'Cursor',
    start,
    end: start + 5 * 60_000,
    windowTitle: 'capture-foundation.ts — daylens',
  })
  insertAppSession(db, {
    bundleId: 'com.microsoft.VSCode',
    appName: 'Cursor',
    start: start + 15 * 60_000,
    end,
    windowTitle: 'capture-foundation.ts — daylens',
  })
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, 'window_changed', ?, 'Cursor', 42, ?, NULL, NULL, 'nsworkspace_event', 'observed', 'darwin', 2)
  `).run(start, start, 'com.microsoft.VSCode', 'capture-foundation.ts — daylens')
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'default', 'test')
  `).run(
    'github.com',
    'DEV-87 capture foundation',
    'https://github.com/irachrist1/daylens/issues/73',
    'https://github.com/irachrist1/daylens/issues/73',
    'https://github.com/irachrist1/daylens/issues/73',
    start + 5 * 60_000,
    BigInt(start + 5 * 60_000) * 1_000n,
    15 * 60,
    'app.zen-browser.zen',
    'app.zen-browser.zen',
  )

  const payload = getTimelineDayPayload(db, date, null, { materialize: false })
  assert.equal(payload.blocks.length, 1)
  const evidence = payload.blocks[0].evidenceSummary
  assert.equal(evidence.apps.length, 1)
  assert.equal(evidence.windowTitles?.[0]?.title, 'capture-foundation.ts — daylens')
  assert.equal(evidence.sites?.[0]?.pageTitle, 'DEV-87 capture foundation')
  assert.equal(evidence.sites?.[0]?.url, 'https://github.com/irachrist1/daylens/issues/73')
  assert.equal(evidence.files?.[0]?.filename, 'capture-foundation.ts')
  db.close()
})
