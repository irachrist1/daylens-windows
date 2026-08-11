import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory, WorkContextBlock } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { analyzeTimelineDay } from '../src/main/services/analyzeDay.ts'
import { mergeTimelineEpisodes, writeTimelineBlockReview } from '../src/main/services/workBlocks.ts'
import { getSessionsForRange, setBlockLabelOverride } from '../src/main/db/queries.ts'
import { absenceSpannedBy } from '../src/main/lib/absenceGuard.ts'
import { getCorrectedSessionsForRange } from '../src/main/services/activityFacts.ts'

// The absence guard end-to-end, under the DEV-233 decision: a merge the
// person asks for always succeeds — including across time away — and
// survives every rebuild. Only automatic merges (the day regroup, the
// fragment repair) are still vetoed at a real absence. These tests pin that
// split: the user path fuses and stays fused, the auto path refuses, the AI
// regroup partition holds, and the repair path splits an already-stored bad
// block only when no person asked for the fusion.

const TEST_DATE = '2026-04-22'

// The July 10 shape, scaled to a morning: work 9:00–10:00, a 97-minute real
// absence 10:00–11:37, work 11:37–12:30.
const GAP_START_H = 10
const GAP_END = { h: 11, m: 37 }

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function createDb(): Database.Database {
  return createProductionTestDatabase()
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

// One coherent block on each side of the absence: same app, same work,
// contiguous sessions — the heuristics keep each side as a single block.
function seedDayWithAbsence(db: Database.Database): void {
  insertSession(db, 'daylens — repairing the tracker - Ghostty', 9, 0, 30)
  insertSession(db, 'daylens — repairing the tracker - Ghostty', 9, 30, 30)
  // 97-minute absence 10:00–11:37 (asleep / away — nothing captured).
  insertSession(db, 'daylens — repairing the tracker - Ghostty', GAP_END.h, GAP_END.m, 28)
  insertSession(db, 'daylens — repairing the tracker - Ghostty', 12, 5, 25)
}

function validBlocks(db: Database.Database): Array<{ id: string; start_time: number; end_time: number }> {
  return db.prepare(`
    SELECT id, start_time, end_time FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
    ORDER BY start_time ASC
  `).all(TEST_DATE) as Array<{ id: string; start_time: number; end_time: number }>
}

function blockSpansGap(block: { startTime: number; endTime: number } | { start_time: number; end_time: number }): boolean {
  const start = 'startTime' in block ? block.startTime : block.start_time
  const end = 'endTime' in block ? block.endTime : block.end_time
  const gapMid = (localMs(GAP_START_H) + localMs(GAP_END.h, GAP_END.m)) / 2
  return start < gapMid && end > gapMid
}

test('a merge the person asks for succeeds across a real absence and stays fused', async () => {
  const db = createDb()
  seedDayWithAbsence(db)
  const payload = materializeTimelineDayProjection(db, TEST_DATE, null)
  const blocks = payload.blocks.filter((block) => !block.isLive)
  assert.ok(blocks.length >= 2, `the day must split at the absence; got ${blocks.length} block(s)`)
  assert.ok(blocks.every((block) => !blockSpansGap(block)), 'no fresh block may span the absence')

  mergeTimelineEpisodes(db, TEST_DATE, [blocks[0], blocks[blocks.length - 1]])
  const corrections = db.prepare(
    `SELECT COUNT(*) AS n FROM timeline_boundary_corrections WHERE kind = 'merge' AND date = ?`,
  ).get(TEST_DATE) as { n: number }
  assert.ok(corrections.n >= 1, 'the user merge must land as a durable correction')

  const fused = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  assert.equal(fused.length, 1, 'the user merge must fuse the day into one block')
  assert.ok(blockSpansGap(fused[0]), 'the fused block spans the gap the user chose to bridge')

  // Re-analyze must not undo the person's fusion: the repair pass skips a gap
  // covered by a stored user merge.
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async () => [],
    blockInsight: async () => ({ label: 'Repaired work', narrative: '' }),
  })
  const reanalyzed = result.payload.blocks.filter((block) => !block.isLive)
  assert.equal(reanalyzed.length, 1, 're-analyze must keep the user-fused block whole')
  assert.ok(blockSpansGap(reanalyzed[0]))
  db.close()
})

test('an automatic merge still refuses to join across a real absence', () => {
  const db = createDb()
  seedDayWithAbsence(db)
  const payload = materializeTimelineDayProjection(db, TEST_DATE, null)
  const blocks = payload.blocks.filter((block) => !block.isLive)
  assert.ok(blocks.length >= 2)

  assert.throws(
    () => mergeTimelineEpisodes(db, TEST_DATE, [blocks[0], blocks[blocks.length - 1]], { initiator: 'auto' }),
    /real absence/,
    'automatic merges may never invent continuity across time away',
  )
  const corrections = db.prepare(
    `SELECT COUNT(*) AS n FROM timeline_boundary_corrections WHERE kind = 'merge' AND date = ?`,
  ).get(TEST_DATE) as { n: number }
  assert.equal(corrections.n, 0)
  db.close()
})

test('the real session read path preserves captured duration so an inflated end cannot erase the gap', () => {
  const db = createDb()
  const start = localMs(9)
  const inflatedEnd = start + 2_139_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('company.thebrowser.Browser', 'Dia', ?, ?, 236,
      'browsing', 0, 'Work', 'Dia', 'test', 1)
  `).run(start, inflatedEnd)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('company.thebrowser.Browser', 'Dia', ?, ?, 1500,
      'browsing', 0, 'Work', 'Dia', 'test', 1)
  `).run(inflatedEnd, inflatedEnd + 1_500_000)

  const sessions = getSessionsForRange(db, localMs(8), localMs(11), { minimumDurationSeconds: 0 })
  assert.equal(sessions[0]?.durationSeconds, 236, 'range hydration must not replace captured duration with the stale wall span')
  assert.deepEqual(absenceSpannedBy(sessions), { startMs: start + 236_000, endMs: inflatedEnd })

  const payload = materializeTimelineDayProjection(db, TEST_DATE, null)
  const hiddenGapMid = (start + 236_000 + inflatedEnd) / 2
  assert.ok(
    payload.blocks.every((block) => !(block.startTime < hiddenGapMid && block.endTime > hiddenGapMid)),
    'the hydrated sessions must reach the block guard unchanged',
  )
  db.close()
})

test('an AI regroup plan spanning the absence is partitioned: sides merge, the gap never does', async () => {
  const db = createDb()
  // Two over-split topics per side so the regroup has real work to do.
  insertSession(db, 'Camera comparison research - Google Search - Google Chrome', 9, 0, 12, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  insertSession(db, 'Camera comparison research - DPReview - Google Chrome', 9, 12, 10, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  insertSession(db, 'City council election results - Local News - Google Chrome', 9, 22, 12, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  insertSession(db, 'City council election results - Analysis - Google Chrome', 9, 34, 10, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  // 113-minute absence 9:44–11:37, then the same shape again.
  insertSession(db, 'Camera comparison research - Google Search - Google Chrome', GAP_END.h, GAP_END.m, 12, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  insertSession(db, 'Camera comparison research - DPReview - Google Chrome', GAP_END.h, GAP_END.m + 12, 10, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  insertSession(db, 'City council election results - Local News - Google Chrome', GAP_END.h, GAP_END.m + 22, 12, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  insertSession(db, 'City council election results - Analysis - Google Chrome', GAP_END.h, GAP_END.m + 34, 10, 'browsing', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })

  const before = materializeTimelineDayProjection(db, TEST_DATE, null)
  assert.ok(before.blocks.filter((b) => !b.isLive).length >= 4, 'each side should over-split into two topic blocks')

  // The AI proposes ONE group across the whole day — absence included.
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async (blocks) => [blocks.map((_, index) => index)],
    blockInsight: async () => ({ label: 'Researching cameras and local news', narrative: '' }),
  })

  assert.equal(result.merged, true, 'the contiguous runs on each side must still merge')
  const after = validBlocks(db)
  assert.equal(after.length, 2, `expected one merged block per side, got ${after.length}`)
  assert.ok(after.every((block) => !blockSpansGap(block)), 'no merged block may span the absence')

  // No stored merge correction reaches across the gap either.
  const gapMid = (localMs(GAP_START_H) + localMs(GAP_END.h, GAP_END.m)) / 2
  const spanning = db.prepare(`
    SELECT COUNT(*) AS n FROM timeline_boundary_corrections
    WHERE kind = 'merge' AND date = ? AND span_start_ms < ? AND span_end_ms > ?
  `).get(TEST_DATE, gapMid, gapMid) as { n: number }
  assert.equal(spanning.n, 0)
  db.close()
})

test('re-analyze REPAIRS a stored day and carries the fused block correction to the larger split half', async () => {
  const db = createDb()
  seedDayWithAbsence(db)
  const fresh = materializeTimelineDayProjection(db, TEST_DATE, null)
  const freshBlocks = fresh.blocks.filter((block) => !block.isLive)
  assert.equal(freshBlocks.length, 2)

  // Poison the day the way the pre-guard bug did: one stored block fused
  // across the absence with an AI label row that marks the day "processed"
  // (frozen) — and NO merge correction, because no person asked for the
  // fusion. Only this un-asked-for shape is repairable; a stored user merge
  // now outranks the absence cut and is skipped by the repair.
  const dayStart = localMs(9)
  const dayEnd = localMs(12, 30)
  const heuristicVersion = (db.prepare(
    `SELECT heuristic_version FROM timeline_blocks WHERE invalidated_at IS NULL LIMIT 1`,
  ).get() as { heuristic_version: string }).heuristic_version
  const now = Date.now()
  db.transaction(() => {
    db.prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE date = ?`).run(now, TEST_DATE)
    db.prepare(`
      INSERT INTO timeline_blocks (
        id, date, start_time, end_time, block_kind, dominant_category,
        category_distribution_json, switch_count, label_current, label_source,
        label_confidence, narrative_current, evidence_summary_json, is_live,
        heuristic_version, computed_at, invalidated_at
      ) VALUES ('bad_fused_block', ?, ?, ?, 'deep-work', 'development', '{"development": 6180}', 0,
                'Repairing the tracker', 'ai', 0.9, NULL, '{}', 0, ?, ?, NULL)
    `).run(TEST_DATE, dayStart, dayEnd, heuristicVersion, now)
    db.prepare(`
      INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at)
      VALUES ('lbl_bad_fused', 'bad_fused_block', 'Repairing the tracker', NULL, 'ai', 0.9, ?)
    `).run(now)
  })()

  // Sanity: the stored day now serves the fused bad block (it is "processed").
  const poisoned = materializeTimelineDayProjection(db, TEST_DATE, null)
  const poisonedBlocks = poisoned.blocks.filter((block) => !block.isLive)
  assert.equal(poisonedBlocks.length, 1)
  assert.ok(blockSpansGap(poisonedBlocks[0]), 'the poisoned block must span the absence')
  // This is the missed review scenario: the correction belongs to the exact
  // fused block being split, not a neighbouring pre-repair block whose
  // evidence key happens to survive.
  writeTimelineBlockReview(db, TEST_DATE, poisonedBlocks[0] as WorkContextBlock, {
    state: 'corrected',
    correctedLabel: 'Fixing the tracker',
    correctedCategory: 'research',
  })
  setBlockLabelOverride(db, poisonedBlocks[0].id, 'Fixing the tracker', null)

  // One click: re-analyze. No AI needed to repair the shape.
  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async () => [],
    blockInsight: async () => ({ label: 'Repaired work', narrative: '' }),
  })

  const repaired = result.payload.blocks.filter((block) => !block.isLive)
  assert.ok(repaired.length >= 2, `the repair must split the day at the gap; got ${repaired.length} block(s)`)
  assert.ok(repaired.every((block) => !blockSpansGap(block)), 'no repaired block may span the absence')
  const corrected = repaired.filter((block) => block.label.current === 'Fixing the tracker')
  assert.equal(corrected.length, 1, 'the fused rename belongs to exactly the split half with the most overlap')
  const largest = [...repaired].sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))[0]
  assert.equal(corrected[0].id, largest.id)
  assert.equal(corrected[0].dominantCategory, 'research', 'the fused category correction must survive too')
  const correctedSessions = getCorrectedSessionsForRange(db, localMs(9), localMs(12, 30))
  assert.ok(correctedSessions.some((session) => session.startTime < localMs(GAP_START_H) && session.category === 'research'))
  assert.ok(
    correctedSessions.some((session) => session.startTime >= localMs(GAP_END.h, GAP_END.m) && session.category === 'development'),
    'the obsolete fused review must not recategorize the non-selected half',
  )
  db.close()
})

test('a stored user merge across an absence survives an invalidating rebuild', async () => {
  const db = createDb()
  seedDayWithAbsence(db)
  materializeTimelineDayProjection(db, TEST_DATE, null)

  // The user's fusion is only its stored correction: rebuild-time honoring
  // alone must keep the day fused across the gap (DEV-233 — a merge survives
  // leaving the day and returning).
  const sessions = db.prepare(`SELECT id, start_time FROM app_sessions ORDER BY start_time ASC`)
    .all() as Array<{ id: number; start_time: number }>
  const lastBefore = [...sessions].reverse().find((s) => s.start_time < localMs(GAP_START_H))!
  const firstAfter = sessions.find((s) => s.start_time >= localMs(GAP_END.h, GAP_END.m))!
  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_boundary_corrections (
      id, date, left_session_id, right_session_id, kind, created_at, updated_at, span_start_ms, span_end_ms
    ) VALUES ('bnd_user_fused', ?, ?, ?, 'merge', ?, ?, ?, ?)
  `).run(TEST_DATE, lastBefore.id, firstAfter.id, now, now, localMs(9), localMs(12, 30))
  db.prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE date = ?`).run(now, TEST_DATE)

  const rebuilt = materializeTimelineDayProjection(db, TEST_DATE, null)
  const blocks = rebuilt.blocks.filter((block) => !block.isLive)
  assert.equal(blocks.length, 1, 'the rebuild must honor the stored user merge')
  assert.ok(blockSpansGap(blocks[0]), 'the fused block spans the gap the user chose to bridge')
  db.close()
})
