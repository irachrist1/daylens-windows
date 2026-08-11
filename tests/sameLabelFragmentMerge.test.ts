import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory, WorkContextBlock } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { analyzeTimelineDay, sameLabelFragmentRuns } from '../src/main/services/analyzeDay.ts'

// DEV-232: consecutive blocks carrying the same label with only seconds
// between them are one continued activity chopped by the old duration
// ceiling. Re-analyze must join them deterministically — never by an AI
// opinion — while a real absence, a user cut, a rename, or a different label
// still breaks the run.

const TEST_DATE = '2026-04-23'

function localMs(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 3, 23, hour, minute, second, 0).getTime()
}

function insertSession(
  db: Database.Database,
  startMs: number,
  durationMinutes: number,
  title: string,
  category: AppCategory = 'development',
): void {
  const endTime = startMs + durationMinutes * 60_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('com.todesktop.230313mzl4w4u92', 'Cursor', ?, ?, ?, ?, 1, ?, 'Cursor', 'test', 1)
  `).run(startMs, endTime, durationMinutes * 60, category, title)
}

// A continuous afternoon in one app, then poison the stored day into four
// back-to-back "Working on Cursor Agents" fragments the way the old ceiling
// did — AI-labeled, so the day reads as processed and frozen.
function seedFragmentedDay(db: Database.Database): void {
  // Distinct window titles per stretch, like a real afternoon — otherwise the
  // session read coalesces them into one derived session and the later stored
  // fragments hydrate empty.
  insertSession(db, localMs(15, 0), 55, 'Cursor Agents — daylens timeline')
  insertSession(db, localMs(15, 55, 5), 25, 'Cursor Agents — daylens merge fix')
  insertSession(db, localMs(16, 20, 10), 40, 'Cursor Agents — daylens zoom')
  insertSession(db, localMs(17, 0, 15), 30, 'Cursor Agents — daylens popover')

  materializeTimelineDayProjection(db, TEST_DATE, null)
  const heuristicVersion = (db.prepare(
    `SELECT heuristic_version FROM timeline_blocks WHERE invalidated_at IS NULL LIMIT 1`,
  ).get() as { heuristic_version: string }).heuristic_version
  // Spans match the seeded session envelopes exactly, the way real persisted
  // fragments do, so each stored block hydrates its own session.
  const spans = [
    [localMs(15, 0), localMs(15, 55)],
    [localMs(15, 55, 5), localMs(16, 20, 5)],
    [localMs(16, 20, 10), localMs(17, 0, 10)],
    [localMs(17, 0, 15), localMs(17, 30, 15)],
  ]
  const now = Date.now()
  db.transaction(() => {
    db.prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE date = ?`).run(now, TEST_DATE)
    spans.forEach(([start, end], index) => {
      const id = `frag_block_${index}`
      db.prepare(`
        INSERT INTO timeline_blocks (
          id, date, start_time, end_time, block_kind, dominant_category,
          category_distribution_json, switch_count, label_current, label_source,
          label_confidence, narrative_current, evidence_summary_json, is_live,
          heuristic_version, computed_at, invalidated_at
        ) VALUES (?, ?, ?, ?, 'deep-work', 'development', '{"development": 1800}', 0,
                  'Working on Cursor Agents', 'ai', 0.9, NULL, '{}', 0, ?, ?, NULL)
      `).run(id, TEST_DATE, start, end, heuristicVersion, now)
      db.prepare(`
        INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at)
        VALUES (?, ?, 'Working on Cursor Agents', NULL, 'ai', 0.9, ?)
      `).run(`lbl_frag_${index}`, id, now)
    })
  })()
}

test('re-analyze deterministically merges back-to-back same-label fragments without an AI opinion', async () => {
  const db = createProductionTestDatabase()
  seedFragmentedDay(db)

  const before = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((b) => !b.isLive)
  assert.equal(before.length, 4, 'the poisoned day must serve four stored fragments')

  const result = await analyzeTimelineDay(db, TEST_DATE, {
    regroupPlan: async () => [],
    blockInsight: async (block) => ({ label: block.label.current, narrative: '' }),
  })

  const after = result.payload.blocks.filter((b) => !b.isLive)
  assert.equal(after.length, 1, `four same-label fragments must become one block; got ${after.length}`)
  assert.equal(result.merged, true)
  assert.ok(result.mergedCount >= 3, `mergedCount must report the absorbed fragments; got ${result.mergedCount}`)
  db.close()
})

// ── sameLabelFragmentRuns unit coverage ──────────────────────────────────────

function fakeBlock(overrides: {
  id: string
  startH: number
  endH: number
  label: string
  override?: string | null
  provisional?: boolean
  isLive?: boolean
  gapAfterPrevious?: boolean
}): WorkContextBlock {
  const startTime = localMs(overrides.startH)
  const endTime = localMs(overrides.endH)
  return {
    id: overrides.id,
    startTime,
    endTime,
    isLive: overrides.isLive ?? false,
    provisional: overrides.provisional ?? false,
    label: { current: overrides.label, override: overrides.override ?? null },
    sessions: [{
      id: 1,
      startTime,
      endTime,
      durationSeconds: (endTime - startTime) / 1000,
    }],
  } as unknown as WorkContextBlock
}

test('runs break at different labels, renames, provisional blocks, and user cuts', () => {
  const same = (id: string, startH: number, endH: number) =>
    fakeBlock({ id, startH, endH, label: 'Working on Cursor Agents' })

  // Four identical labels form one run.
  assert.equal(sameLabelFragmentRuns([same('a', 9, 10), same('b', 10, 11), same('c', 11, 12), same('d', 12, 13)], []).length, 1)

  // A different label in the middle breaks adjacency — no run may skip over it.
  const runs = sameLabelFragmentRuns([
    same('a', 9, 10),
    fakeBlock({ id: 'x', startH: 10, endH: 11, label: 'Reading email' }),
    same('b', 11, 12),
  ], [])
  assert.equal(runs.length, 0)

  // A user rename opts the block out.
  assert.equal(sameLabelFragmentRuns([
    same('a', 9, 10),
    fakeBlock({ id: 'b', startH: 10, endH: 11, label: 'Working on Cursor Agents', override: 'My deep work' }),
  ], []).length, 0)

  // A user cut at the junction is never re-joined.
  assert.equal(sameLabelFragmentRuns([same('a', 9, 10), same('b', 10, 11)], [localMs(10)]).length, 0)

  // A provisional (live-day) block never participates.
  assert.equal(sameLabelFragmentRuns([
    same('a', 9, 10),
    fakeBlock({ id: 'b', startH: 10, endH: 11, label: 'Working on Cursor Agents', provisional: true }),
  ], []).length, 0)
})

test('DEV-281: adjacent blocks naming the same work join even when one label is longer', () => {
  const runs = sameLabelFragmentRuns([
    fakeBlock({ id: 'a', startH: 16, endH: 17, label: 'Preparing handoff documentation and reviewing tasks' }),
    fakeBlock({ id: 'b', startH: 17, endH: 18, label: 'Preparing handoff' }),
  ], [])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].length, 2)

  // A shared first word alone is NOT the same work.
  assert.equal(sameLabelFragmentRuns([
    fakeBlock({ id: 'a', startH: 9, endH: 10, label: 'Reviewing tasks' }),
    fakeBlock({ id: 'b', startH: 10, endH: 11, label: 'Reviewing email' }),
  ], []).length, 0)
})

test('a real absence between same-label blocks breaks the run', () => {
  const a = fakeBlock({ id: 'a', startH: 9, endH: 10, label: 'Working on Cursor Agents' })
  // Sessions end at 10:00; the next block's sessions start at 11:00 — a real
  // absence of an hour sits between them even though the labels match.
  const b = fakeBlock({ id: 'b', startH: 11, endH: 12, label: 'Working on Cursor Agents' })
  assert.equal(sameLabelFragmentRuns([a, b], []).length, 0)
})
