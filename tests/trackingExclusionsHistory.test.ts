import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  clearTestDb,
  setTestDb,
} from './support/database-stub.mjs'
import {
  deleteHistoryForApp,
  deleteHistoryForSite,
  deleteTrackedActivity,
  purgeTimelineBlockSpanRows,
  purgeTrackedEvidenceRows,
} from '../src/main/services/trackingHistory.ts'
import { projectDay } from '../src/main/core/projections/chunk2.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'

function seed(db: Database.Database): void {
  const start = new Date(2026, 5, 18, 10, 0, 0, 0).getTime()
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('app.zen-browser.zen', 'Zen', ?, ?, 1200, 'browsing', 0, 'Private work', 'Zen', 'test', 2)
  `).run(start, start + 20 * 60_000)
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, 'tab_changed', 'app.zen-browser.zen', 'Zen', 42, 'Private work',
      'https://private.example.com/plan', 'Private plan', 'apple_events_tab', 'observed', 'darwin', 2)
  `).run(start, start)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES ('private.example.com', 'Private plan', 'https://private.example.com/plan',
      'https://private.example.com/plan', 'https://private.example.com/plan',
      ?, ?, 1200, 'app.zen-browser.zen:default', 'app.zen-browser.zen', 'default', 'test')
  `).run(start, BigInt(start) * 1_000n)
}

test('excluding an app removes its app, browser, and native-focus history', () => {
  const db = createProductionTestDatabase()
  seed(db)
  setTestDb(db)

  try {
    const result = deleteHistoryForApp({ bundleId: 'app.zen-browser.zen', appName: 'Zen' })
    assert.ok(result.deletedRows >= 3)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM app_sessions`).get() as { count: number }).count, 0)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM website_visits`).get() as { count: number }).count, 0)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM focus_events`).get() as { count: number }).count, 0)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('app deletion removes owned distraction events', () => {
  const db = createProductionTestDatabase()
  const triggeredAt = new Date(2026, 5, 18, 10, 10, 0, 0).getTime()
  db.prepare(`
    INSERT INTO distraction_events (session_id, app_name, bundle_id, triggered_at)
    VALUES (NULL, 'Zen', 'app.zen-browser.zen', ?)
  `).run(triggeredAt)
  setTestDb(db)

  try {
    deleteHistoryForApp({ bundleId: 'app.zen-browser.zen', appName: 'Zen' })
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM distraction_events`).get() as { count: number }).count, 0)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('bounded and block-span purges remove owned distraction events', () => {
  const db = createProductionTestDatabase()
  const fromMs = new Date(2026, 5, 18, 10, 0, 0, 0).getTime()
  const insert = db.prepare(`
    INSERT INTO distraction_events (session_id, app_name, bundle_id, triggered_at)
    VALUES (NULL, ?, ?, ?)
  `)
  insert.run('Zen', 'app.zen-browser.zen', fromMs + 1_000)
  insert.run('Other', 'app.other', fromMs + 2_000)

  purgeTrackedEvidenceRows(db, {
    kind: 'app',
    bundleId: 'app.zen-browser.zen',
    appName: 'Zen',
    fromMs,
    toMs: fromMs + 60_000,
  })
  assert.deepEqual(db.prepare(`SELECT app_name FROM distraction_events`).all(), [{ app_name: 'Other' }])

  purgeTimelineBlockSpanRows(db, { fromMs, toMs: fromMs + 60_000 })
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM distraction_events`).get() as { count: number }).count, 0)
  db.close()
})

test('app purge matches bounded escaped identities without deleting unrelated text', () => {
  const db = createProductionTestDatabase()
  db.exec('CREATE TABLE purge_probe (value TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO purge_probe (value) VALUES (?)')
  insert.run('app.test_editor')
  insert.run('app.testXeditor')
  insert.run('Frozen roadmap')
  setTestDb(db)

  try {
    deleteHistoryForApp({ bundleId: 'app.test_editor', appName: 'TestEditor' })
    deleteHistoryForApp({ appName: 'Zen' })
    const rows = db.prepare('SELECT value FROM purge_probe ORDER BY value').all() as Array<{ value: string }>
    assert.deepEqual(rows.map((row) => row.value), ['Frozen roadmap', 'app.testXeditor'])
  } finally {
    clearTestDb()
    db.close()
  }
})

test('excluding a site removes old URL evidence from history and projections', () => {
  const db = createProductionTestDatabase()
  seed(db)
  setTestDb(db)

  try {
    const result = deleteHistoryForSite({ domain: 'example.com' })
    assert.ok(result.deletedRows >= 2)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM website_visits`).get() as { count: number }).count, 0)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM focus_events`).get() as { count: number }).count, 0)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM app_sessions`).get() as { count: number }).count, 1)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('excluding a site removes its legacy browser title before projections rebuild', () => {
  const db = createProductionTestDatabase()
  const pageTitle = 'Legacy forum thread'
  const windowTitle = `${pageTitle} — Zen`
  const date = '2026-06-19'
  const start = new Date(2026, 5, 19, 10, 0, 0, 0).getTime()
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('app.zen-browser.zen', 'Zen', ?, ?, 1200, 'browsing', 0, ?, 'Zen', 'test', 2)
  `).run(start, start + 20 * 60_000, windowTitle)
  const insertFocusEvent = db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (
      @tsMs, @monoNs, @eventType, 'app.zen-browser.zen', 'Zen', 42,
      @windowTitle, @url, @pageTitle, @source, 'observed', 'darwin', 2
    )
  `)
  insertFocusEvent.run({
    tsMs: start,
    monoNs: start,
    eventType: 'app_activated',
    windowTitle: null,
    url: null,
    pageTitle: null,
    source: 'nsworkspace_event',
  })
  insertFocusEvent.run({
    tsMs: start + 10_000,
    monoNs: start + 10_000,
    eventType: 'tab_changed',
    windowTitle,
    url: 'https://old-forum.example/thread/1',
    pageTitle,
    source: 'apple_events_tab',
  })
  insertFocusEvent.run({
    tsMs: start + 20_000,
    monoNs: start + 20_000,
    eventType: 'window_changed',
    windowTitle,
    url: null,
    pageTitle: null,
    source: 'nsworkspace_event',
  })
  insertFocusEvent.run({
    tsMs: start + 20 * 60_000,
    monoNs: start + 20 * 60_000,
    eventType: 'app_deactivated',
    windowTitle: null,
    url: null,
    pageTitle: null,
    source: 'nsworkspace_event',
  })
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES (
      'old-forum.example', ?, 'https://old-forum.example/thread/1',
      'https://old-forum.example/thread/1', 'old-forum.example/thread/1',
      ?, ?, 1190, 'app.zen-browser.zen:default', 'zen', 'default', 'test'
    )
  `).run(pageTitle, start, BigInt(start) * 1_000n)
  setTestDb(db)

  try {
    projectDay(db, date, { finalize: true })
    materializeTimelineDayProjection(db, date, null)
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count FROM derived_blocks WHERE label = ?
    `).get(pageTitle) as { count: number }).count, 1)

    const result = deleteHistoryForSite({ domain: 'old-forum.example' })
    assert.ok(result.deletedRows >= 4)

    const evidenceAndDerivedTables = [
      'app_sessions',
      'focus_events',
      'website_visits',
      'activity_segments',
      'derived_sessions',
      'derived_blocks',
      'timeline_blocks',
    ]
    for (const residueTitle of [pageTitle, windowTitle]) {
      for (const table of evidenceAndDerivedTables) {
        const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>
        for (const column of columns.filter((entry) => !/INT|REAL|BLOB/i.test(entry.type ?? ''))) {
          const residue = db.prepare(`
            SELECT COUNT(*) AS count FROM "${table}"
            WHERE instr(lower(CAST("${column.name}" AS TEXT)), lower(?)) > 0
          `).get(residueTitle) as { count: number }
          assert.equal(residue.count, 0, `${residueTitle} remained in ${table}.${column.name}`)
        }
      }
    }

    projectDay(db, date, { finalize: true })
    const rebuilt = materializeTimelineDayProjection(db, date, null)
    assert.equal(JSON.stringify(rebuilt).includes(pageTitle), false)
    assert.equal(JSON.stringify(rebuilt).includes(windowTitle), false)
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count FROM derived_blocks WHERE label = ?
    `).get(pageTitle) as { count: number }).count, 0)
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count FROM timeline_blocks
      WHERE label_current = ? OR evidence_summary_json LIKE ?
    `).get(pageTitle, `%${pageTitle}%`) as { count: number }).count, 0)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('excluding a site redacts a decorated legacy title from raw history, search, and a cold rebuild', () => {
  const db = createProductionTestDatabase()
  const pageTitle = 'Shared dashboard'
  const windowTitle = `${pageTitle} — Google Chrome`
  const date = '2026-06-21'
  const visitTime = new Date(2026, 5, 21, 9, 0, 0, 0).getTime()
  const sessionStart = visitTime + 2
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('com.google.Chrome', 'Google Chrome', ?, ?, 600, 'browsing', 0, ?, 'Google Chrome', 'test', 1)
  `).run(sessionStart, sessionStart + 600_000, windowTitle)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES (
      'private.example', ?, 'https://private.example/dashboard',
      'https://private.example/dashboard', 'private.example/dashboard',
      ?, ?, 0, 'com.google.Chrome:Profile 1', 'chrome', 'Profile 1', 'test'
    )
  `).run(pageTitle, visitTime, BigInt(visitTime) * 1_000n)
  setTestDb(db)

  try {
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count FROM app_sessions_fts WHERE app_sessions_fts MATCH ?
    `).get(`"${pageTitle}"`) as { count: number }).count, 1)

    deleteHistoryForSite({ domain: 'private.example' })

    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count FROM app_sessions WHERE window_title = ?
    `).get(windowTitle) as { count: number }).count, 0)
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count FROM app_sessions_fts WHERE app_sessions_fts MATCH ?
    `).get(`"${pageTitle}"`) as { count: number }).count, 0)

    db.prepare(`DELETE FROM timeline_block_members WHERE block_id IN (
      SELECT id FROM timeline_blocks WHERE date = ?
    )`).run(date)
    db.prepare('DELETE FROM timeline_blocks WHERE date = ?').run(date)
    db.prepare(`DELETE FROM derived_block_sessions WHERE block_id IN (
      SELECT id FROM derived_blocks WHERE date = ?
    )`).run(date)
    db.prepare('DELETE FROM derived_blocks WHERE date = ?').run(date)
    db.prepare('DELETE FROM derived_sessions WHERE date = ?').run(date)

    projectDay(db, date, { finalize: true })
    const rebuilt = materializeTimelineDayProjection(db, date, null)
    assert.equal(JSON.stringify(rebuilt).includes(pageTitle), false)
    assert.equal(JSON.stringify(rebuilt).includes(windowTitle), false)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('excluding a site preserves an overlapping same-title session from another browser profile', () => {
  const db = createProductionTestDatabase()
  const title = 'Dashboard'
  const excludedStart = new Date(2026, 5, 22, 9, 0, 0, 0).getTime()
  const safeStart = excludedStart + 5 * 60_000
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version
    ) VALUES (
      'com.google.Chrome', 'Google Chrome', @start, @end, 600, 'browsing',
      0, @title, 'Google Chrome', 'chrome', @profile, 'test', 2
    )
  `)
  insertSession.run({ start: excludedStart, end: excludedStart + 600_000, title, profile: 'com.google.Chrome:Profile 1' })
  insertSession.run({ start: safeStart, end: safeStart + 600_000, title, profile: 'com.google.Chrome:Profile 2' })
  const insertVisit = db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES (
      @domain, @title, @url, @url, @url, @start, @startUs, 600,
      @browserBundleId, 'chrome', @profile, 'test'
    )
  `)
  insertVisit.run({
    domain: 'private.example',
    title,
    url: 'https://private.example/dashboard',
    start: excludedStart,
    startUs: BigInt(excludedStart) * 1_000n,
    browserBundleId: 'com.google.Chrome:Profile 1',
    profile: 'Profile 1',
  })
  insertVisit.run({
    domain: 'safe.example',
    title,
    url: 'https://safe.example/dashboard',
    start: safeStart,
    startUs: BigInt(safeStart) * 1_000n,
    browserBundleId: 'com.google.Chrome:Profile 2',
    profile: 'Profile 2',
  })
  setTestDb(db)

  try {
    deleteHistoryForSite({ domain: 'private.example' })

    const sessions = db.prepare(`
      SELECT start_time, window_title FROM app_sessions ORDER BY start_time
    `).all() as Array<{ start_time: number; window_title: string | null }>
    assert.deepEqual(sessions, [
      { start_time: excludedStart, window_title: null },
      { start_time: safeStart, window_title: title },
    ])
    assert.deepEqual(db.prepare(`
      SELECT domain, page_title FROM website_visits ORDER BY visit_time
    `).all(), [{ domain: 'safe.example', page_title: title }])
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count FROM app_sessions_fts WHERE app_sessions_fts MATCH ?
    `).get(title) as { count: number }).count, 1)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('excluding a site redacts same-page URL-less focus events until the next browser boundary', () => {
  const db = createProductionTestDatabase()
  const title = 'Travel plan'
  const start = new Date(2026, 5, 23, 11, 0, 0, 0).getTime()
  const insertFocusEvent = db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (
      @tsMs, @tsMs, @eventType, @bundleId, 'Safari', 7,
      @windowTitle, @url, @pageTitle, @source, 'observed', 'darwin', 2
    )
  `)
  insertFocusEvent.run({
    tsMs: start,
    eventType: 'tab_changed',
    bundleId: 'safari',
    windowTitle: title,
    url: 'https://private.example/travel',
    pageTitle: title,
    source: 'apple_events_tab',
  })
  insertFocusEvent.run({
    tsMs: start + 1_000,
    eventType: 'window_changed',
    bundleId: 'com.apple.Safari',
    windowTitle: title,
    url: null,
    pageTitle: null,
    source: 'nsworkspace_event',
  })
  insertFocusEvent.run({
    tsMs: start + 2_000,
    eventType: 'window_changed',
    bundleId: 'com.apple.Safari',
    windowTitle: title,
    url: null,
    pageTitle: null,
    source: 'nsworkspace_event',
  })
  insertFocusEvent.run({
    tsMs: start + 3_000,
    eventType: 'tab_changed',
    bundleId: 'safari',
    windowTitle: 'Safe dashboard',
    url: 'https://safe.example/dashboard',
    pageTitle: 'Safe dashboard',
    source: 'apple_events_tab',
  })
  insertFocusEvent.run({
    tsMs: start + 4_000,
    eventType: 'window_changed',
    bundleId: 'com.apple.Safari',
    windowTitle: title,
    url: null,
    pageTitle: null,
    source: 'nsworkspace_event',
  })
  setTestDb(db)

  try {
    deleteHistoryForSite({ domain: 'private.example' })

    assert.deepEqual(db.prepare(`
      SELECT ts_ms, window_title, url FROM focus_events ORDER BY ts_ms
    `).all(), [
      { ts_ms: start + 1_000, window_title: null, url: null },
      { ts_ms: start + 2_000, window_title: null, url: null },
      { ts_ms: start + 3_000, window_title: 'Safe dashboard', url: 'https://safe.example/dashboard' },
      { ts_ms: start + 4_000, window_title: title, url: null },
    ])
  } finally {
    clearTestDb()
    db.close()
  }
})

test('deleting a page removes every visit and clears generated recaps', () => {
  const db = createProductionTestDatabase()
  seed(db)
  const later = new Date(2026, 5, 20, 12, 0, 0, 0).getTime()
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES ('private.example.com', 'Private plan', 'https://private.example.com/plan',
      'https://private.example.com/plan', 'private.example.com/plan',
      ?, ?, 300, 'app.zen-browser.zen', 'app.zen-browser.zen', 'default', 'test')
  `).run(later, BigInt(later) * 1_000n)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES ('private.example.com', 'Private plan', 'https://private.example.com/plan?utm_source=email',
      'https://private.example.com/plan', 'private.example.com/plan',
      ?, ?, 120, 'app.zen-browser.zen', 'app.zen-browser.zen', 'default', 'test')
  `).run(later + 1_000, BigInt(later + 1_000) * 1_000n)
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, 1, 'tab_changed', 'app.zen-browser.zen', 'Zen', 1,
      'Private plan', 'https://private.example.com/plan?utm_source=email',
      'Private plan', 'apple_events_tab', 'observed', 'darwin', 2)
  `).run(later + 1_000)
  db.prepare(`
    INSERT INTO ai_surface_summaries (
      scope_type, scope_key, job_type, title, summary_text, input_signature,
      metadata_json, created_at, updated_at
    ) VALUES ('app_detail', 'app:zen:7d', 'app_narrative', 'Zen', 'Stale recap', 'sig', '{}', ?, ?)
  `).run(later, later)
  setTestDb(db)

  try {
    const result = deleteTrackedActivity({
      url: 'https://private.example.com/plan',
      normalizedUrl: 'https://private.example.com/plan',
      pageKey: 'private.example.com/plan',
    })
    assert.ok(result.deletedRows >= 5)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM website_visits`).get() as { count: number }).count, 0)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM focus_events`).get() as { count: number }).count, 0)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ai_surface_summaries`).get() as { count: number }).count, 0)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('focus-sourced purge keys honor Chrome profile suffixes', () => {
  const db = createProductionTestDatabase()
  const title = 'Dashboard'
  const excludedStart = new Date(2026, 5, 24, 9, 0, 0, 0).getTime()
  const safeStart = excludedStart + 5 * 60_000
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version
    ) VALUES (
      'com.google.Chrome', 'Google Chrome', @start, @end, 600, 'browsing',
      0, @title, 'Google Chrome', 'chrome', @profile, 'test', 2
    )
  `)
  insertSession.run({
    start: excludedStart,
    end: excludedStart + 600_000,
    title,
    profile: 'com.google.Chrome:Profile 1',
  })
  insertSession.run({
    start: safeStart,
    end: safeStart + 600_000,
    title,
    profile: 'com.google.Chrome:Profile 2',
  })
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, 'tab_changed', 'com.google.Chrome:Profile 1', 'Google Chrome', 11,
      ?, 'https://private.example/dashboard', ?, 'apple_events_tab', 'observed', 'darwin', 2)
  `).run(excludedStart, excludedStart, title, title)
  setTestDb(db)

  try {
    deleteHistoryForSite({ domain: 'private.example' })

    const sessions = db.prepare(`
      SELECT start_time, window_title FROM app_sessions ORDER BY start_time
    `).all() as Array<{ start_time: number; window_title: string | null }>
    assert.deepEqual(sessions, [
      { start_time: excludedStart, window_title: null },
      { start_time: safeStart, window_title: title },
    ])
  } finally {
    clearTestDb()
    db.close()
  }
})

test('unprofiled focus purge keys do not wildcard into profiled sessions', () => {
  const db = createProductionTestDatabase()
  const title = 'Dashboard'
  const excludedStart = new Date(2026, 5, 25, 10, 0, 0, 0).getTime()
  const profiledStart = excludedStart + 2_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version
    ) VALUES (
      'com.google.Chrome', 'Google Chrome', ?, ?, 600, 'browsing',
      0, ?, 'Google Chrome', 'chrome', 'com.google.Chrome:Profile 2', 'test', 2
    )
  `).run(profiledStart, profiledStart + 600_000, title)
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, 'tab_changed', 'com.google.Chrome', 'Google Chrome', 12,
      ?, 'https://private.example/dashboard', ?, 'apple_events_tab', 'observed', 'darwin', 2)
  `).run(excludedStart, excludedStart, title, title)
  setTestDb(db)

  try {
    deleteHistoryForSite({ domain: 'private.example' })

    assert.equal((db.prepare(`
      SELECT window_title FROM app_sessions
    `).get() as { window_title: string | null }).window_title, title)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('start-side poll lag does not redact a later same-title session past the page end', () => {
  const db = createProductionTestDatabase()
  const title = 'Dashboard'
  const pageStart = new Date(2026, 5, 26, 14, 0, 0, 0).getTime()
  const laterSessionStart = pageStart + 8_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version
    ) VALUES (
      'com.google.Chrome', 'Google Chrome', ?, ?, 600, 'browsing',
      0, ?, 'Google Chrome', 'chrome', 'com.google.Chrome:Profile 1', 'test', 2
    )
  `).run(laterSessionStart, laterSessionStart + 600_000, title)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES (
      'private.example', ?, 'https://private.example/dashboard',
      'https://private.example/dashboard', 'https://private.example/dashboard',
      ?, ?, 0, 'com.google.Chrome:Profile 1', 'chrome', 'Profile 1', 'test'
    )
  `).run(title, pageStart, BigInt(pageStart) * 1_000n)
  setTestDb(db)

  try {
    deleteHistoryForSite({ domain: 'private.example' })

    assert.equal((db.prepare(`
      SELECT window_title FROM app_sessions
    `).get() as { window_title: string | null }).window_title, title)
  } finally {
    clearTestDb()
    db.close()
  }
})
