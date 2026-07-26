import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { writeAIBlockLabel } from '../src/main/db/queries.ts'
import { getTimelineDayProjection, materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'

// The TIMELINE_HEURISTIC_VERSION bump policy (workBlocks.ts): a processed day
// whose persisted blocks were shaped by an older heuristic version re-derives
// its deterministic segmentation once, on the read that opens it. Corrections
// are law and must survive; AI labels re-attach where their stretch of work
// survived; the heal never spends an AI call. A heal that would discard
// curated work keeps the sealed shape instead.

const TEST_DATE = '2026-04-22'
const STALE_VERSION = 'timeline-v11'

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

function validBlockRows(db: Database.Database): Array<{ id: string; start_time: number; end_time: number; heuristic_version: string }> {
  return db.prepare(`
    SELECT id, start_time, end_time, heuristic_version FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
    ORDER BY start_time ASC
  `).all(TEST_DATE) as Array<{ id: string; start_time: number; end_time: number; heuristic_version: string }>
}

function aiLabelTexts(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT l.label AS label
    FROM timeline_block_labels l
    WHERE l.source = 'ai'
  `).all() as Array<{ label: string }>
  return new Set(rows.map((row) => row.label))
}

// A morning with two contiguous sessions, a real 45-minute absence, then a
// third sitting. Yesterday's heuristics sealed all of it as ONE block bridging
// the absence — exactly the shape the current segmentation forbids.
function seedBridgedSealedDay(db: Database.Database, aiLabel: string | null): void {
  insertSession(db, 'daylens — Ghostty', 9, 0, 55)
  insertSession(db, 'daylens — Ghostty', 10, 0, 55)
  insertSession(db, 'daylens — Ghostty', 11, 50, 55)

  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES ('seal_bridge', ?, ?, ?, 'deep-work', 'development', '{"development": 9900}', 0, ?, ?, 0.9, NULL, '{}', 0, ?, ?, NULL)
  `).run(
    TEST_DATE, localMs(9), localMs(12, 45),
    aiLabel ?? 'Development', aiLabel ? 'ai' : 'rule',
    STALE_VERSION, now,
  )
  if (aiLabel) {
    db.prepare(`
      INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at)
      VALUES ('lbl_bridge', 'seal_bridge', ?, NULL, 'ai', 0.9, ?)
    `).run(aiLabel, now)
  }
}

test('a stale-stamped processed day re-derives current block shapes on open', () => {
  const db = createProductionTestDatabase()
  seedBridgedSealedDay(db, 'Deep work on Daylens')
  const aiTextsBefore = aiLabelTexts(db)

  const blocks = rendererRead(db).blocks.filter((block) => !block.isLive)

  assert.ok(blocks.length >= 2,
    `the 45-minute absence splits the old bridged block; got ${blocks.length} block(s)`)
  const absenceStart = localMs(9 + 1, 55) // 10:55, end of the second session
  const absenceEnd = localMs(11, 50)
  assert.ok(
    blocks.every((block) => !(block.startTime < absenceStart && block.endTime > absenceEnd)),
    'no healed block may span the 45-minute untracked absence',
  )
  assert.ok(
    blocks.some((block) => block.label.current === 'Deep work on Daylens'),
    `the AI label re-attaches to the stretch of work that survived; got ${blocks.map((b) => `"${b.label.current}" (${b.label.source})`).join(', ')}`,
  )
  assert.ok(blocks.every((block) => !block.provisional),
    'the healed day stays settled — never reverts to provisional sittings')

  // The heal is durable and one-shot: rows re-stamped current, ids stable on
  // the next read.
  const rows = validBlockRows(db)
  assert.ok(rows.length >= 2, 'the healed shape was persisted')
  assert.ok(rows.every((row) => row.heuristic_version !== STALE_VERSION),
    'every persisted block is re-stamped with the current heuristic version')
  const again = rendererRead(db).blocks.filter((block) => !block.isLive)
  assert.deepEqual(again.map((b) => b.id), blocks.map((b) => b.id), 'a second open serves the same healed day')

  // No AI was spent: every ai-sourced label after the heal already existed
  // before it. Stranded stretches carry deterministic labels only.
  const aiTextsAfter = aiLabelTexts(db)
  for (const label of aiTextsAfter) {
    assert.ok(aiTextsBefore.has(label), `the heal invented an AI label out of thin air: "${label}"`)
  }
  db.close()
})

test('a user-corrected label survives the heal when its stretch of work survives', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'daylens — Ghostty', 9, 0, 55)
  insertSession(db, 'daylens — Ghostty', 10, 0, 55)
  insertSession(db, 'Q2 report — Numbers', 11, 50, 55, 'productivity', { bundleId: 'com.apple.iWork.Numbers', name: 'Numbers' })

  // Analyze with the CURRENT builder so boundaries match what the heal will
  // re-derive, then stale-stamp the rows to simulate a bump that changed only
  // labeling/kind rules.
  materializeTimelineDayProjection(db, TEST_DATE, null)
  const sealed = validBlockRows(db)
  assert.ok(sealed.length >= 2, 'the analyzed day has at least two blocks')
  writeAIBlockLabel(db, { blockId: sealed[0].id, label: 'Building the wrap deck', narrative: null })
  // Correct the LAST block through its persisted review row (the same row the
  // review layer re-attaches by session-set evidence key on a rebuild).
  const lastId = sealed[sealed.length - 1].id
  const corrected = db.prepare(`
    UPDATE timeline_block_reviews
    SET review_state = 'corrected', correction_json = '{"label":"Client X audit"}', updated_at = ?
    WHERE block_id = ?
  `).run(Date.now(), lastId)
  assert.equal(corrected.changes, 1, 'the sealed block has exactly one review row to correct')
  db.prepare(`UPDATE timeline_blocks SET heuristic_version = ? WHERE date = ?`).run(STALE_VERSION, TEST_DATE)

  const blocks = rendererRead(db).blocks.filter((block) => !block.isLive)

  const correctedBlock = blocks.find((block) => block.label.current === 'Client X audit')
  assert.ok(correctedBlock, `the corrected label survives the heal; got ${blocks.map((b) => `"${b.label.current}"`).join(', ')}`)
  assert.equal(correctedBlock.label.source, 'user', 'a correction stays user-owned, never demoted')
  assert.ok(
    blocks.some((block) => block.label.current === 'Building the wrap deck'),
    'the AI label on the boundary-stable block is not discarded',
  )
  assert.ok(validBlockRows(db).every((row) => row.heuristic_version !== STALE_VERSION),
    'the day is re-stamped current so the heal runs once')
  db.close()
})

test('one surviving correction cannot vouch for another with the same label text', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'daylens — Ghostty', 9, 0, 55)
  insertSession(db, 'daylens — Ghostty', 10, 0, 55)
  insertSession(db, 'daylens — Ghostty', 11, 50, 55)

  // Materialize once so real blocks (and their session-set evidence keys)
  // exist to build the seal from.
  materializeTimelineDayProjection(db, TEST_DATE, null)
  const built = validBlockRows(db)
  assert.equal(built.length, 2, 'the morning + post-absence sitting analyze into two blocks')

  // Re-seal the same shapes under DIFFERENT (seal-era) block ids, stamped
  // stale. Both blocks were corrected to the SAME label. The first
  // correction keeps its real evidence key, so it re-attaches to the rebuilt
  // block; the second is keyed only to its seal-era block id, so
  // re-segmentation strands it — the trap: its TEXT still appears on the
  // day, on the other block.
  const now = Date.now()
  const insertSeal = db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, 'deep-work', 'development', '{"development": 3300}', 0, 'Development', 'rule', 0.8, NULL, '{}', 0, ?, ?, NULL)
  `)
  db.transaction(() => {
    db.prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE date = ?`).run(now, TEST_DATE)
    insertSeal.run('seal_a', TEST_DATE, built[0].start_time, built[0].end_time, STALE_VERSION, now)
    insertSeal.run('seal_b', TEST_DATE, built[1].start_time, built[1].end_time, STALE_VERSION, now)
    const retargetA = db.prepare(`
      UPDATE timeline_block_reviews
      SET block_id = 'seal_a', review_state = 'corrected', correction_json = '{"label":"Client X audit"}', updated_at = ?
      WHERE block_id = ?
    `).run(now, built[0].id)
    assert.equal(retargetA.changes, 1)
    const retargetB = db.prepare(`
      UPDATE timeline_block_reviews
      SET block_id = 'seal_b', evidence_key = 'seal-era-key-b', review_state = 'corrected', correction_json = '{"label":"Client X audit"}', updated_at = ?
      WHERE block_id = ?
    `).run(now, built[1].id)
    assert.equal(retargetB.changes, 1)
  })()

  const blocks = rendererRead(db).blocks.filter((block) => !block.isLive)

  assert.equal(blocks.length, 2, 'the sealed shape is kept — the stranded correction vetoes the heal')
  assert.ok(blocks.every((block) => block.label.current === 'Client X audit'),
    `BOTH corrections stay in force; got ${blocks.map((b) => `"${b.label.current}"`).join(', ')}`)
  assert.deepEqual(validBlockRows(db).map((row) => row.id), ['seal_a', 'seal_b'],
    'the seal-era blocks are still the persisted day')
  assert.ok(validBlockRows(db).every((row) => row.heuristic_version !== STALE_VERSION),
    'the declined day is stamped current so the attempt is one-shot')
  db.close()
})

test('a heal that would strand a corrected label keeps the sealed shape', () => {
  const db = createProductionTestDatabase()
  seedBridgedSealedDay(db, null)
  // The user corrected the bridged block itself. Re-segmentation splits it and
  // neither half can claim the correction, so the heal must decline.
  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id, block_id, date, evidence_key, review_state, original_block_json,
      correction_json, created_at, updated_at
    ) VALUES ('review_bridge', 'seal_bridge', ?, 'seal-era-evidence-key', 'corrected', '{}', '{"label":"Client X audit"}', ?, ?)
  `).run(TEST_DATE, now, now)

  const blocks = rendererRead(db).blocks.filter((block) => !block.isLive)

  assert.equal(blocks.length, 1, 'the sealed shape is kept — a shape improvement never outranks a correction')
  assert.equal(blocks[0].label.current, 'Client X audit', 'the corrected label is still in force')
  assert.equal(blocks[0].startTime, localMs(9))
  assert.equal(blocks[0].endTime, localMs(12, 45))
  const rows = validBlockRows(db)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].heuristic_version !== STALE_VERSION,
    'the declined day is still stamped current (by the category-facts refresh) so the attempt is one-shot')
  db.close()
})
