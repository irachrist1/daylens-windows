// DEV-227: the range-facts memo cache. A cached read must be
// indistinguishable from a recomputed one, and any change to the evidence —
// a new focus event, a new correction, a changed focusApps setting — must
// invalidate. Pinned here because a stale hit would silently desynchronize
// the Apps view, the AI's numbers, and the Timeline.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { insertFocusEvents } from '../src/main/db/focusEventRepository.ts'
import {
  FOCUS_EVENT_SCHEMA_VERSION,
  POLL_FOCUS_EVENT_SOURCE,
  type FocusEventInsert,
} from '../src/main/core/evidence/focusEvent.ts'
import { queryCorrectedActivityFactsForRange } from '../src/main/core/query/activityFactsQuery.ts'
import { bumpRangeFactsEvidenceEpoch, clearRangeFactsCache } from '../src/main/core/query/rangeFactsCache.ts'

// A window fully in the past, so the cache treats it as historical (no TTL).
const FROM = new Date(2026, 3, 22, 0, 0, 0, 0).getTime()
const TO = new Date(2026, 3, 23, 0, 0, 0, 0).getTime()

function ms(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function focusEvent(
  tsMs: number,
  eventType: FocusEventInsert['event_type'],
  overrides: Partial<FocusEventInsert> = {},
): FocusEventInsert {
  return {
    ts_ms: tsMs,
    mono_ns: tsMs * 1_000_000,
    event_type: eventType,
    app_bundle_id: overrides.app_bundle_id ?? 'com.mitchellh.ghostty',
    app_name: overrides.app_name ?? 'Ghostty',
    pid: overrides.pid ?? 1001,
    window_title: overrides.window_title ?? 'Editor',
    url: null,
    page_title: null,
    source: POLL_FOCUS_EVENT_SOURCE,
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
    ...overrides,
  }
}

function seedMorning(db: Database.Database): void {
  insertFocusEvents(db, [
    focusEvent(ms(9, 0), 'app_activated'),
    focusEvent(ms(9, 30), 'app_deactivated'),
    focusEvent(ms(9, 30), 'app_activated', {
      app_bundle_id: 'com.apple.Safari',
      app_name: 'Safari',
      window_title: 'Docs',
    }),
    focusEvent(ms(10, 0), 'app_deactivated', {
      app_bundle_id: 'com.apple.Safari',
      app_name: 'Safari',
    }),
  ])
}

test('a cached range read returns the same facts as the computed one', () => {
  clearRangeFactsCache()
  const db = createProductionTestDatabase()
  seedMorning(db)

  const first = queryCorrectedActivityFactsForRange(db, FROM, TO)
  const second = queryCorrectedActivityFactsForRange(db, FROM, TO)

  assert.deepEqual(second, first)
  assert.equal(second.sessions.length, 2)
  assert.equal(second.totalSeconds, first.totalSeconds)
  db.close()
  clearRangeFactsCache()
})

test('new evidence invalidates the cached window', () => {
  clearRangeFactsCache()
  const db = createProductionTestDatabase()
  seedMorning(db)

  const before = queryCorrectedActivityFactsForRange(db, FROM, TO)
  assert.equal(before.sessions.length, 2)

  insertFocusEvents(db, [
    focusEvent(ms(11, 0), 'app_activated', { app_bundle_id: 'com.figma.Desktop', app_name: 'Figma' }),
    focusEvent(ms(11, 45), 'app_deactivated', { app_bundle_id: 'com.figma.Desktop', app_name: 'Figma' }),
  ])

  const after = queryCorrectedActivityFactsForRange(db, FROM, TO)
  assert.equal(after.sessions.length, 3)
  assert.ok(after.totalSeconds > before.totalSeconds)
  db.close()
  clearRangeFactsCache()
})

test('a new correction invalidates the cached window', () => {
  clearRangeFactsCache()
  const db = createProductionTestDatabase()
  seedMorning(db)

  const before = queryCorrectedActivityFactsForRange(db, FROM, TO)
  assert.equal(before.sessions.length, 2)

  // Delete the Safari half hour via the review ledger — exactly what the
  // Timeline writes when the user removes a block.
  db.prepare(`
    INSERT INTO timeline_block_reviews
      (id, block_id, date, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ignored', ?, '{}', ?, ?)
  `).run(
    'rev-1', 'block-1', '2026-04-22', 'ek-1',
    JSON.stringify({ startTime: ms(9, 30), endTime: ms(10, 0) }),
    Date.now(), Date.now(),
  )

  const after = queryCorrectedActivityFactsForRange(db, FROM, TO)
  assert.ok(
    after.totalSeconds < before.totalSeconds,
    `deleted span must drop from totals (${after.totalSeconds} !< ${before.totalSeconds})`,
  )
  db.close()
  clearRangeFactsCache()
})

test('an in-place evidence UPDATE is invisible to the signature — the epoch bump catches it', () => {
  clearRangeFactsCache()
  const db = createProductionTestDatabase()
  seedMorning(db)

  const before = queryCorrectedActivityFactsForRange(db, FROM, TO)
  assert.equal(before.sessions.some((s) => s.windowTitle === 'Docs'), true)

  // A privacy purge nulls titles IN PLACE: count, max(ts), max(id) all
  // unchanged, so without the epoch the cache would keep serving 'Docs'.
  db.prepare(`UPDATE focus_events SET window_title = NULL WHERE window_title = 'Docs'`).run()
  bumpRangeFactsEvidenceEpoch(db)

  const after = queryCorrectedActivityFactsForRange(db, FROM, TO)
  assert.equal(
    after.sessions.some((s) => s.windowTitle === 'Docs'),
    false,
    'purged title must not be served from cache',
  )
  db.close()
  clearRangeFactsCache()
})

test('mutating a returned result never leaks into the next read', () => {
  clearRangeFactsCache()
  const db = createProductionTestDatabase()
  seedMorning(db)

  const first = queryCorrectedActivityFactsForRange(db, FROM, TO)
  first.sessions.sort((a, b) => b.durationSeconds - a.durationSeconds)
  first.sessions.pop()

  const second = queryCorrectedActivityFactsForRange(db, FROM, TO)
  assert.equal(second.sessions.length, 2)
  assert.ok(second.sessions[0].startTime <= second.sessions[1].startTime, 'chronological order preserved')
  db.close()
  clearRangeFactsCache()
})

test('explicit nowMs bypasses the cache (deterministic day reads)', () => {
  clearRangeFactsCache()
  const db = createProductionTestDatabase()
  seedMorning(db)

  // Warm the wall-clock cache for the window…
  queryCorrectedActivityFactsForRange(db, FROM, TO)
  // …then a pinned-clock read that clips at 09:45 must not see cached facts.
  const clipped = queryCorrectedActivityFactsForRange(db, FROM, TO, { nowMs: ms(9, 45) })
  const clippedTotal = clipped.sessions.reduce((sum, s) => sum + s.durationSeconds, 0)
  assert.equal(clippedTotal, 45 * 60)
  db.close()
  clearRangeFactsCache()
})
