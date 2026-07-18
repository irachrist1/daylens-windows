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
} from '../src/main/services/trackingHistory.ts'

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
