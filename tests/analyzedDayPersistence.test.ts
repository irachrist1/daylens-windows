import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { writeAIBlockLabel } from '../src/main/db/queries.ts'
import { getTimelineDayProjection, materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'

// DEV-277: a day analyzed mid-day kept accruing activity; the next open judged
// the seal under-covered, threw the whole analysis away, and served coarse
// "Morning / Afternoon / Night" sittings with the Analyze button reset. The
// repair must extend the day to its real end while re-attaching every AI label
// the person already earned.

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  startHour: number,
  startMinute: number,
  durationMinutes: number,
  category: AppCategory = 'development',
  app: { bundleId: string; name: string } = { bundleId: 'com.mitchellh.ghostty', name: 'Ghostty' },
): void {
  const startTime = localMs(startHour, startMinute)
  const endTime = startTime + durationMinutes * 60_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'test', 1)
  `).run(app.bundleId, app.name, startTime, endTime, durationMinutes * 60, category, title, app.name)
}

function rendererRead(db: Database.Database) {
  // The exact options the GET_TIMELINE_DAY handler uses.
  return getTimelineDayProjection(db, TEST_DATE, null, { materialize: false, analysis: false })
}

// Analyze the morning, then live through an afternoon: the sealed blocks now
// under-cover the day by hours.
function seedAnalyzedMorningThenAfternoon(db: Database.Database): string {
  for (let hour = 9; hour < 12; hour++) {
    insertSession(db, 'Week 1 — Coursera', hour, 0, 55, 'research', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  }
  materializeTimelineDayProjection(db, TEST_DATE, null)
  const analyzed = db.prepare(`
    SELECT id FROM timeline_blocks WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
  `).all(TEST_DATE) as Array<{ id: string }>
  assert.ok(analyzed.length >= 1, 'the analyze pass sealed the morning')
  const aiLabel = 'Studying machine learning'
  for (const block of analyzed) {
    writeAIBlockLabel(db, { blockId: block.id, label: aiLabel, narrative: 'Coursera week 1' })
  }
  for (let hour = 13; hour < 20; hour++) {
    insertSession(db, 'daylens — Ghostty', hour, 0, 55, 'development')
  }
  return aiLabel
}

test('DEV-277: an analyzed day that kept accruing activity keeps its AI labels on the next open', () => {
  const db = createProductionTestDatabase()
  const aiLabel = seedAnalyzedMorningThenAfternoon(db)

  const rendered = rendererRead(db)
  const blocks = rendered.blocks.filter((block) => !block.isLive)

  assert.ok(
    blocks.some((block) => block.label.current === aiLabel),
    `the analyzed morning keeps its AI name; got ${blocks.map((b) => `"${b.label.current}"`).join(', ')}`,
  )
  assert.ok(blocks.every((block) => !block.provisional),
    'the day stays settled — the Analyze button must not reset to a fresh coarse day')
  const lastEnd = Math.max(...blocks.map((block) => block.endTime))
  assert.ok(lastEnd >= localMs(19), 'the repaired day reaches its real end, covering the afternoon')
  const partNames = new Set(['Morning', 'Afternoon', 'Evening', 'Night', 'Late night'])
  assert.ok(blocks.every((block) => !partNames.has(block.label.current)),
    'no block reverts to a coarse part-of-day sitting name')

  // The repair is durable: a second read serves the same settled day.
  const again = rendererRead(db).blocks.filter((block) => !block.isLive)
  assert.ok(again.some((block) => block.label.current === aiLabel))
  assert.ok(again.every((block) => !block.provisional))
  db.close()
})

test('DEV-277: AI labels survive a rebuild that re-keys every session id', () => {
  const db = createProductionTestDatabase()
  const aiLabel = seedAnalyzedMorningThenAfternoon(db)

  // A past day's rebuild feeds derived sessions whose ids live in a different
  // namespace than the ids the day was analyzed with. Shift every session id
  // so the session-set carry key can never match — the span must carry instead.
  db.prepare(`UPDATE app_sessions SET id = id + 100000`).run()

  const blocks = rendererRead(db).blocks.filter((block) => !block.isLive)
  assert.ok(
    blocks.some((block) => block.label.current === aiLabel),
    `the AI name re-attaches by span when session ids changed; got ${blocks.map((b) => `"${b.label.current}"`).join(', ')}`,
  )
  assert.ok(blocks.every((block) => !block.provisional))
  db.close()
})
