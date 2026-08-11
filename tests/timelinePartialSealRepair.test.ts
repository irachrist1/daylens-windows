import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AppCategory } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getTimelineDayProjection, materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'

// DEV-267: a finalize that sealed a day from partial data (or died mid-run) can
// leave a "processed" day whose stored blocks cover only a fraction of what was
// actually tracked, and the seal is otherwise permanent. The renderer read must
// notice the under-coverage and rebuild from sessions.
// DEV-268: a day that was never analyzed — or was rebuilt after such a repair —
// reads as coarse, neutral, sitting-level blocks, never fine app fragments. The
// analysis path (Analyze / rollover) still divides the day into settled blocks.

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

function validPersistedCount(db: Database.Database): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
  `).get(TEST_DATE) as { n: number }).n
}

function rendererRead(db: Database.Database) {
  // The exact options the GET_TIMELINE_DAY handler uses.
  return getTimelineDayProjection(db, TEST_DATE, null, { materialize: false, analysis: false })
}

test('DEV-268: an un-analyzed past day reads as one coarse neutral sitting, never per-app fragments', () => {
  const db = createProductionTestDatabase()
  // The exact fragmentation shape from the ticket: one continuous morning
  // across several apps (email, an AI tab, an editor) with no real absence.
  insertSession(db, 'Hub — Spark Desktop', 9, 0, 40, 'communication', { bundleId: 'com.readdle.smartemail-Mac', name: 'Spark Desktop' })
  insertSession(db, 'ChatGPT — Google Chrome', 9, 40, 30, 'aiTools', { bundleId: 'com.google.Chrome', name: 'Google Chrome' })
  insertSession(db, 'daylens — Ghostty', 10, 12, 48, 'development')

  const blocks = rendererRead(db).blocks.filter((block) => !block.isLive)
  assert.equal(blocks.length, 1, `one continuous sitting is one block, not per-app fragments; got ${blocks.map((b) => b.label.current).join(', ')}`)
  assert.ok(blocks[0].provisional, 'an un-analyzed day serves provisional blocks (so the view offers Analyze, not edits)')
  const appNames = new Set(['Spark Desktop', 'Hub', 'ChatGPT', 'Ghostty', 'Google Chrome', 'Browsing'])
  assert.ok(!appNames.has(blocks[0].label.current), `the block is not named after an app or raw category; got "${blocks[0].label.current}"`)
  // No fine blocks were persisted behind the user's back by a passive read.
  assert.equal(validPersistedCount(db), 0, 'a passive read of an un-analyzed day never seals it')

  // The analysis path still divides the day into settled (non-provisional) blocks.
  const analyzed = materializeTimelineDayProjection(db, TEST_DATE, null).blocks.filter((block) => !block.isLive)
  assert.ok(analyzed.length >= 1)
  assert.ok(analyzed.every((block) => !block.provisional), 'Analyze produces settled blocks, not provisional ones')
  db.close()
})

test('DEV-267: a processed day sealed under-covered heals to the whole day on the renderer read', () => {
  const db = createProductionTestDatabase()
  // A full ~8-hour continuous day (55-minute sessions, 5-minute gaps — one sitting).
  for (let hour = 8; hour < 16; hour++) {
    insertSession(db, 'daylens — Ghostty', hour, 0, 55, 'development')
  }
  // Give the day real blocks so a heuristic_version exists to copy.
  materializeTimelineDayProjection(db, TEST_DATE, null)
  const heuristicVersion = (db.prepare(
    `SELECT heuristic_version FROM timeline_blocks WHERE date = ? AND invalidated_at IS NULL LIMIT 1`,
  ).get(TEST_DATE) as { heuristic_version: string }).heuristic_version

  // Poison it into the DEV-267 shape: invalidate the real blocks, then seal the
  // day "processed" (an AI label) with two blocks that cover only 08:00–11:00 of
  // the 8-hour day — the interrupted-finalize signature.
  const now = Date.now()
  const insertBlock = db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, 'deep-work', 'development', '{"development": 5400}', 0, ?, 'ai', 0.9, NULL, '{}', 0, ?, ?, NULL)
  `)
  db.transaction(() => {
    db.prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE date = ?`).run(now, TEST_DATE)
    insertBlock.run('seal_a', TEST_DATE, localMs(8), localMs(9, 30), 'Morning coding', heuristicVersion, now)
    insertBlock.run('seal_b', TEST_DATE, localMs(9, 30), localMs(11), 'More coding', heuristicVersion, now)
    db.prepare(`
      INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at)
      VALUES ('lbl_seal_a', 'seal_a', 'Morning coding', NULL, 'ai', 0.9, ?)
    `).run(now)
  })()
  assert.equal(validPersistedCount(db), 2, 'the day is now sealed with just two blocks')

  const rendered = rendererRead(db)
  const blocks = rendered.blocks.filter((block) => !block.isLive)
  const lastEnd = Math.max(...blocks.map((block) => block.endTime))
  assert.ok(lastEnd >= localMs(15), `the healed day reaches its real end, not the 11:00 partial seal (ended ${new Date(lastEnd).getHours()}:00)`)
  assert.ok(rendered.totalSeconds > 4 * 3600, `the healed day covers the full ~8h, not a fraction; got ${(rendered.totalSeconds / 3600).toFixed(1)}h`)
  assert.equal(validPersistedCount(db), 0, 'the partial seal is invalidated by the repair, exactly like the manual fix')
  db.close()
})

test('DEV-267: a processed, well-covered day is left exactly as sealed', () => {
  const db = createProductionTestDatabase()
  for (let hour = 8; hour < 12; hour++) {
    insertSession(db, 'daylens — Ghostty', hour, 0, 55, 'development')
  }
  materializeTimelineDayProjection(db, TEST_DATE, null)
  const heuristicVersion = (db.prepare(
    `SELECT heuristic_version FROM timeline_blocks WHERE date = ? AND invalidated_at IS NULL LIMIT 1`,
  ).get(TEST_DATE) as { heuristic_version: string }).heuristic_version

  // Seal the whole day (08:00–11:55) in one AI-labeled block — full coverage.
  const now = Date.now()
  db.transaction(() => {
    db.prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE date = ?`).run(now, TEST_DATE)
    db.prepare(`
      INSERT INTO timeline_blocks (
        id, date, start_time, end_time, block_kind, dominant_category,
        category_distribution_json, switch_count, label_current, label_source,
        label_confidence, narrative_current, evidence_summary_json, is_live,
        heuristic_version, computed_at, invalidated_at
      ) VALUES ('full_seal', ?, ?, ?, 'deep-work', 'development', '{"development": 13200}', 0, 'Building all morning', 'ai', 0.9, NULL, '{}', 0, ?, ?, NULL)
    `).run(TEST_DATE, localMs(8), localMs(11, 55), heuristicVersion, now)
    db.prepare(`
      INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at)
      VALUES ('lbl_full', 'full_seal', 'Building all morning', NULL, 'ai', 0.9, ?)
    `).run(now)
  })()

  const blocks = rendererRead(db).blocks.filter((block) => !block.isLive)
  assert.equal(blocks.length, 1, 'a well-covered sealed day keeps its single analyzed block')
  assert.equal(blocks[0].label.current, 'Building all morning', 'its curated AI label is untouched')
  assert.ok(!blocks[0].provisional, 'a well-covered sealed day stays settled, never dropped back to provisional')
  db.close()
})
