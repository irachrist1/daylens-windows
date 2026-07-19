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
import { queryCorrectedActivityFactsForDay } from '../src/main/core/query/activityFactsQuery.ts'
import {
  compareCanonicalAndLegacyDay,
  formatCanonicalLegacyParitySideBySide,
  writeLocalCanonicalLegacyParityReport,
} from '../src/main/core/query/canonicalLegacyParity.ts'
import { projectDay } from '../src/main/core/projections/chunk2.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATE = '2026-04-22'
const DAY_END = new Date(2026, 3, 23, 0, 0, 0, 0).getTime()

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

function seedCanonicalMorning(db: Database.Database): void {
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
    focusEvent(ms(10, 0), 'idle_started', {
      app_bundle_id: null,
      app_name: null,
      pid: null,
      window_title: null,
      source: 'capture_supervisor',
    }),
    focusEvent(ms(10, 20), 'idle_ended', {
      app_bundle_id: null,
      app_name: null,
      pid: null,
      window_title: null,
      source: 'capture_supervisor',
    }),
  ])
}

function seedLegacyMirror(db: Database.Database): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES
      ('com.mitchellh.ghostty', 'Ghostty', ?, ?, 1800, 'development', 1, 'Editor', 'Ghostty', 'ghostty', 'test', 1),
      ('com.apple.Safari', 'Safari', ?, ?, 1800, 'browsing', 0, 'Docs', 'Safari', 'safari', 'test', 1)
  `).run(ms(9, 0), ms(9, 30), ms(9, 30), ms(10, 0))
}

test('live and historical reads of the same day return identical sessions, totals, and gaps', () => {
  const db = createProductionTestDatabase()
  seedCanonicalMorning(db)
  const asOfMs = DAY_END
  const liveShaped = queryCorrectedActivityFactsForDay(db, DATE, { nowMs: asOfMs, asOfMs })
  const historicalShaped = queryCorrectedActivityFactsForDay(db, DATE, {
    nowMs: asOfMs + 86_400_000,
    asOfMs,
  })
  assert.equal(liveShaped.evidenceSource, 'canonical')
  assert.deepEqual(
    liveShaped.sessions.map((s) => ({
      bundleId: s.bundleId,
      startTime: s.startTime,
      endTime: s.endTime,
      durationSeconds: s.durationSeconds,
    })),
    historicalShaped.sessions.map((s) => ({
      bundleId: s.bundleId,
      startTime: s.startTime,
      endTime: s.endTime,
      durationSeconds: s.durationSeconds,
    })),
  )
  assert.equal(liveShaped.totalSeconds, historicalShaped.totalSeconds)
  assert.equal(liveShaped.focusSeconds, historicalShaped.focusSeconds)
  assert.deepEqual(liveShaped.gaps, historicalShaped.gaps)
  assert.ok(liveShaped.gaps.some((gap) => gap.kind === 'idle'))
})

test('corrections survive rebuild through the shared query', () => {
  const db = createProductionTestDatabase()
  seedCanonicalMorning(db)
  const before = queryCorrectedActivityFactsForDay(db, DATE, { asOfMs: DAY_END, nowMs: DAY_END })
  assert.ok(before.totalSeconds > 0)

  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id, date, block_id, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'ignored', ?, '{}', ?, ?)
  `).run(
    'review-test-block',
    DATE,
    'test-block',
    'test-block',
    JSON.stringify({ startTime: ms(9, 0), endTime: ms(9, 30) }),
    now,
    now,
  )

  const afterCorrection = queryCorrectedActivityFactsForDay(db, DATE, {
    asOfMs: DAY_END,
    nowMs: DAY_END,
  })
  assert.ok(afterCorrection.totalSeconds < before.totalSeconds)

  projectDay(db, DATE, { finalize: true, now: new Date(DAY_END + 3_600_000) })
  const afterRebuild = queryCorrectedActivityFactsForDay(db, DATE, {
    asOfMs: DAY_END,
    nowMs: DAY_END + 3_600_000,
  })
  assert.equal(afterRebuild.totalSeconds, afterCorrection.totalSeconds)
  assert.deepEqual(
    afterRebuild.sessions.map((s) => [s.startTime, s.endTime, s.durationSeconds]),
    afterCorrection.sessions.map((s) => [s.startTime, s.endTime, s.durationSeconds]),
  )
})

test('focused duration never exceeds tracked duration for the same scope', () => {
  const db = createProductionTestDatabase()
  seedCanonicalMorning(db)
  const facts = queryCorrectedActivityFactsForDay(db, DATE, { asOfMs: DAY_END, nowMs: DAY_END })
  assert.ok(facts.focusSeconds <= facts.totalSeconds)
})

test('canonical-vs-legacy differences are recorded locally and never invent focus events from legacy rows', () => {
  const db = createProductionTestDatabase()
  seedCanonicalMorning(db)
  seedLegacyMirror(db)
  const report = compareCanonicalAndLegacyDay(db, DATE, { asOfMs: DAY_END, nowMs: DAY_END })
  assert.equal(report.canonical.focusEventCount > 0, true)
  assert.equal(report.legacy.sessionCount, 2)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-parity-'))
  const filePath = writeLocalCanonicalLegacyParityReport(report, dir)
  assert.equal(fs.existsSync(filePath), true)
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof report
  assert.equal(written.date, DATE)
  const sideBySide = formatCanonicalLegacyParitySideBySide(report)
  assert.match(sideBySide, /canonical:/)
  assert.match(sideBySide, /legacy:/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('shared query falls back to legacy compatibility inputs when focus_events are absent', () => {
  const db = createProductionTestDatabase()
  seedLegacyMirror(db)
  const facts = queryCorrectedActivityFactsForDay(db, DATE, { asOfMs: DAY_END, nowMs: DAY_END })
  assert.equal(facts.evidenceSource, 'legacy')
  assert.equal(facts.sessions.length, 2)
  assert.equal(facts.totalSeconds, 3600)
  assert.ok(facts.focusSeconds <= facts.totalSeconds)
})

test('same evidence + corrections + projection version is byte-stable across repeated queries', () => {
  const db = createProductionTestDatabase()
  seedCanonicalMorning(db)
  const a = queryCorrectedActivityFactsForDay(db, DATE, { asOfMs: DAY_END, nowMs: DAY_END })
  const b = queryCorrectedActivityFactsForDay(db, DATE, { asOfMs: DAY_END, nowMs: DAY_END })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.equal(a.projectionVersion, b.projectionVersion)
  assert.equal(a.queryVersion, b.queryVersion)
})
