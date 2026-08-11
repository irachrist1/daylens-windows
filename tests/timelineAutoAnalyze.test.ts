import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { analyzeTimelineDay } from '../src/main/services/analyzeDay.ts'

// "Same-intent neighbours merge into one block" used to be enforced ONLY
// behind the manual "Analyze" click: the automatic finalize path shipped the
// engine's over-split heuristic blocks (a day materialized to 14
// artifact-labeled fragments and only Re-analyze collapsed them to 6).
// analyzeTimelineDay is now the ONE shared pipeline both paths run, so the
// automatic entry point produces the same merged blocks as the manual one.
// The AI planner is mocked here — the suite never reaches a provider.

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function createDb(): Database.Database {
  return createProductionTestDatabase()
}

function insertSession(
  db: Database.Database,
  title: string,
  startMinute: number,
  durationMinutes: number,
  category: AppCategory = 'browsing',
): void {
  const startTime = localMs(9, startMinute)
  const endTime = startTime + durationMinutes * 60_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('com.google.Chrome', 'Google Chrome', ?, ?, ?, ?, 1, ?, 'Google Chrome', 'test', 1)
  `).run(startTime, endTime, durationMinutes * 60, category, title)
}

// Two sustained topics the engine splits into separate blocks — the same shape
// as "sustained browser topic changes split into separately named blocks".
function seedOverSplitDay(db: Database.Database): void {
  insertSession(db, 'Camera comparison research - Google Search - Google Chrome', 0, 12)
  insertSession(db, 'Camera comparison research - DPReview - Google Chrome', 12, 10)
  insertSession(db, 'City council election results - Local News - Google Chrome', 22, 12)
  insertSession(db, 'City council election results - Analysis - Google Chrome', 34, 10)
}

function currentBlockCount(db: Database.Database): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM timeline_blocks WHERE invalidated_at IS NULL AND is_live = 0`,
  ).get() as { n: number }).n
}

test('the automatic analyze pipeline merges same-intent neighbours without a manual click', async () => {
  const db = createDb()
  seedOverSplitDay(db)

  // Finalize the past day the way the automatic path does — this persists the
  // over-split heuristic blocks.
  const before = materializeTimelineDayProjection(db, TEST_DATE, null)
  assert.ok(before.blocks.length >= 2, `engine should over-split; got ${before.blocks.length} blocks`)

  // Run the SHARED pipeline (what both the manual IPC handler and the
  // day-rollover / startup finalize now call), with the AI planner mocked to
  // fuse every heuristic block into one intent — never touching a provider.
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    triggerSource: 'background',
    regroupPlan: async (blocks) => [blocks.map((_, index) => index)],
    blockInsight: async () => ({ label: 'Researching cameras and local news', narrative: 'Merged intent.' }),
  })

  assert.equal(result.merged, true, 'the regroup must have merged at least one group')
  assert.equal(currentBlockCount(db), 1, 'the over-split day must collapse to one merged block')
  // DEV-231: the run reports what it actually did so the UI can say
  // "merged N blocks" instead of a fixed success message.
  assert.equal(result.mergedCount, before.blocks.length - 1, 'mergedCount is the number of blocks absorbed by the merge')

  // The merge rode the durable boundary-correction path (invariant 8) — it is a
  // persisted correction, not a one-shot relabel, so it survives every rebuild.
  const corrections = db.prepare(
    `SELECT COUNT(*) AS n FROM timeline_boundary_corrections WHERE kind = 'merge' AND date = ?`,
  ).get(TEST_DATE) as { n: number }
  assert.ok(corrections.n >= 1, 'a merge correction must be written so the merge survives rebuilds')

  db.close()
})

test('the merge survives a plain rebuild with no AI in the loop', async () => {
  const db = createDb()
  seedOverSplitDay(db)
  materializeTimelineDayProjection(db, TEST_DATE, null)

  await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async (blocks) => [blocks.map((_, index) => index)],
    blockInsight: async () => ({ label: 'Merged work', narrative: '' }),
  })
  assert.equal(currentBlockCount(db), 1)

  // A later rebuild that never calls the AI must keep the fused block — the
  // boundary correction, not the AI label, is what holds it together.
  const rebuilt = materializeTimelineDayProjection(db, TEST_DATE, null)
  assert.equal(rebuilt.blocks.filter((b) => !b.isLive).length, 1, 'the fused block must persist through a no-AI rebuild')

  db.close()
})

test('with no AI provider available the day falls back cleanly to the heuristic blocks', async () => {
  const db = createDb()
  seedOverSplitDay(db)
  const before = materializeTimelineDayProjection(db, TEST_DATE, null)

  // Provider unavailable: the regroup planner throws (as the real one's caller
  // does under a rate-limit). analyzeTimelineDay must not throw, and must leave
  // the heuristic blocks intact rather than losing the day.
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    surfaceErrors: false, // the automatic finalize path never throws into the scheduler
    regroupPlan: async () => { throw new Error('provider unavailable') },
    blockInsight: async () => { throw new Error('provider unavailable') },
  })

  assert.equal(result.merged, false)
  assert.equal(currentBlockCount(db), before.blocks.filter((b) => !b.isLive).length, 'a provider outage must not drop or merge blocks')

  db.close()
})
