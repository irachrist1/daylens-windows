// DEV-171: search, the agent's data tools, and the MCP path (which delegates
// to the same executors) read the shared corrected facts. The agent's
// day-overview total equals the Timeline payload's total for the same date,
// and a correction changes search and tool results immediately.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { executeTool, type DaySummaryResult } from '../src/main/services/aiTools.ts'
import { getTimelineDayPayload, writeTimelineBlockReview } from '../src/main/services/workBlocks.ts'
import { searchAll } from '../src/main/db/queries.ts'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'

interface SearchSessionsToolResult {
  hits: Array<{ windowTitle?: string | null }>
  matchKind: 'strict' | 'broadened' | 'empty'
}

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertFocusEvent(
  db: Database.Database,
  tsMs: number,
  eventType: string,
  bundleId: string,
  appName: string,
  windowTitle: string | null = null,
): void {
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, ?, ?, ?, 4242, ?, NULL, NULL, 'foreground_poll', 'observed', 'darwin', 2)
  `).run(tsMs, tsMs * 1_000_000, eventType, bundleId, appName, windowTitle)
}

// The canonical day also mirrors legacy sessions so FTS-backed search (which
// indexes app_sessions) sees the same activity — the dual-write state real
// capture produces during the migration.
function seedDay(db: Database.Database): void {
  const stretches: Array<[string, string, number, number, string]> = [
    ['com.mitchellh.ghostty', 'Ghostty', localMs(9), localMs(10, 30), 'daylens — evidence.ts'],
    ['com.apple.Safari', 'Safari', localMs(11), localMs(11, 45), 'Quarterly launchplan review'],
  ]
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 1)
  `)
  for (const [bundleId, appName, startMs, endMs, title] of stretches) {
    insertFocusEvent(db, startMs, 'app_activated', bundleId, appName, title)
    insertFocusEvent(db, endMs, 'app_deactivated', bundleId, appName, title)
    insertSession.run(
      bundleId, appName, startMs, endMs, Math.round((endMs - startMs) / 1000),
      appName === 'Safari' ? 'browsing' : 'development', title, appName, appName.toLowerCase(),
    )
  }
}

function ignoreSpan(db: Database.Database, startMs: number, endMs: number): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id, block_id, date, evidence_key, review_state, original_block_json,
      correction_json, created_at, updated_at
    ) VALUES ('review_shared_consumers', 'shared_consumers_block', ?, 'shared_consumers_block', 'ignored', ?, '{}', ?, ?)
  `).run(TEST_DATE, JSON.stringify({ startTime: startMs, endTime: endMs }), now, now)
}

test('the agent day-overview total equals the Timeline payload total exactly', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const summary = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
  assert.ok(payload.totalSeconds > 0)
  assert.equal(summary.totalTrackedSeconds, Math.round(payload.totalSeconds))
  assert.equal(summary.focusSeconds, Math.round(payload.focusSeconds))
  assert.ok(summary.focusSeconds <= summary.totalTrackedSeconds)
  db.close()
})

test('the agent day summary honors apps marked as real work during onboarding', () => {
  const db = createProductionTestDatabase()
  const start = localMs(9)
  const end = localMs(9, 30)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES ('com.example.Game', 'Game', ?, ?, 1800, 'entertainment', 0, 'Game', 'Game', 'game', 'test', 1)
  `).run(start, end)
  __setSettings({ focusApps: ['Game'] })

  try {
    const summary = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
    assert.equal(summary.deepWorkSessionCount, 1)
    assert.equal(summary.longestStreakSeconds, 1800)
  } finally {
    __resetSettings()
    db.close()
  }
})

test('a deleted block changes the agent day-overview and Timeline identically', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const before = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
  // Delete the way the product does: the review is written for the real
  // rendered block, so it survives the materialized-day path too.
  const beforePayload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const safariBlock = beforePayload.blocks.find((block) =>
    block.sessions.some((session) => session.appName === 'Safari'))
  assert.ok(safariBlock, 'the Safari stretch renders as a block')
  writeTimelineBlockReview(db, TEST_DATE, safariBlock, { state: 'ignored' })

  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const after = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
  assert.equal(after.totalTrackedSeconds, Math.round(payload.totalSeconds))
  assert.ok(after.totalTrackedSeconds < before.totalTrackedSeconds)
  db.close()
})

test('search reflects an ignored-span correction immediately', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const hitsBefore = searchAll(db, 'launchplan', { startDate: TEST_DATE, endDate: TEST_DATE })
  assert.ok(hitsBefore.length > 0, 'the Safari session is searchable before the correction')

  ignoreSpan(db, localMs(11), localMs(11, 45))
  const hitsAfter = searchAll(db, 'launchplan', { startDate: TEST_DATE, endDate: TEST_DATE })
  assert.equal(hitsAfter.length, 0, 'the deleted stretch is gone from search with no rebuild')
  db.close()
})

test('the agent searchSessions tool reflects an ignored-span correction immediately', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const before = executeTool(
    'searchSessions',
    { query: 'launchplan', startDate: TEST_DATE, endDate: TEST_DATE },
    db,
  ) as SearchSessionsToolResult
  assert.ok(
    before.hits.some((hit) => (hit.windowTitle ?? '').includes('launchplan')),
    `the session is findable before the correction (got ${JSON.stringify(before.hits)})`,
  )

  ignoreSpan(db, localMs(11), localMs(11, 45))
  const after = executeTool(
    'searchSessions',
    { query: 'launchplan', startDate: TEST_DATE, endDate: TEST_DATE },
    db,
  ) as SearchSessionsToolResult
  assert.equal(
    after.hits.filter((hit) => (hit.windowTitle ?? '').includes('launchplan')).length,
    0,
    'the deleted stretch is gone from the tool result',
  )
  db.close()
})
