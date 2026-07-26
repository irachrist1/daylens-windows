import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { WORK_NAME_GUARD_VERSION } from '../src/shared/workNameGuards.ts'
import {
  labelGuardMaintenanceKey,
  runLabelGuardRepair,
  runLabelGuardRepairIfNeeded,
} from '../src/main/services/labelGuardRepair.ts'
import { storedLabelViolatesWorkNameGuards } from '../src/main/services/workBlocks.ts'
import { hasMaintenanceRun, markMaintenanceRun } from '../src/main/db/maintenance.ts'

// Stored labels persisted BEFORE today's work-name guards existed must heal on
// startup without the user clicking Re-analyze: tool-surface titles ("Working
// on Cursor Agents") and leisure headlines on work blocks ("Watching Netflix &
// YouTube") are re-derived through the real finalize ladder, user overrides
// stay untouched, projections for the affected dates are invalidated, and the
// pass stamps its guard version so the next launch is a no-op.

const TEST_DATE = '2026-07-20'
const OTHER_DATE = '2026-07-21'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 6, 20, hour, minute, 0, 0).getTime()
}

interface SeedBlockOptions {
  id: string
  date?: string
  startHour: number
  endHour: number
  label: string
  labelSource: string
  dominantCategory?: string
  evidence?: Record<string, unknown>
  labelRows?: Array<{ id: string; label: string; source: string }>
}

function seedBlock(db: Database.Database, options: SeedBlockOptions): void {
  const date = options.date ?? TEST_DATE
  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, 'deep-work', ?, ?, 0, ?, ?, 0.9, NULL, ?, 0, 'test-v1', ?, NULL)
  `).run(
    options.id,
    date,
    localMs(options.startHour),
    localMs(options.endHour),
    options.dominantCategory ?? 'development',
    JSON.stringify({ [options.dominantCategory ?? 'development']: (options.endHour - options.startHour) * 3600 }),
    options.label,
    options.labelSource,
    JSON.stringify(options.evidence ?? {}),
    now,
  )
  for (const row of options.labelRows ?? []) {
    db.prepare(`
      INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at)
      VALUES (?, ?, ?, NULL, ?, 0.9, ?)
    `).run(row.id, options.id, row.label, row.source, now)
  }
}

const DEV_EVIDENCE = {
  apps: [
    { appName: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', category: 'development', totalSeconds: 4200, isBrowser: false },
    { appName: 'Ghostty', bundleId: 'com.mitchellh.ghostty', category: 'development', totalSeconds: 1800, isBrowser: false },
  ],
  windowTitles: [{ title: 'workBlocks.ts — daylens', appName: 'Cursor', totalSeconds: 4200 }],
}

function seedDaySnapshot(db: Database.Database, date: string): void {
  db.prepare(`
    INSERT INTO day_snapshots (date, total_active, work_sec, leisure_sec, personal_sec, facts_json, facts_hash, finalized_at)
    VALUES (?, 3600, 3600, 0, 0, '{}', 'hash', ?)
  `).run(date, Date.now())
}

function seedWrappedNarrative(db: Database.Database, date: string): void {
  db.prepare(`
    INSERT INTO wrapped_narratives (cadence, period_key, facts_hash, narrative_json, generated_at)
    VALUES ('day', ?, 'hash', '{}', ?)
  `).run(date, Date.now())
}

function blockRow(db: Database.Database, id: string): { label_current: string; label_source: string } {
  return db.prepare(`SELECT label_current, label_source FROM timeline_blocks WHERE id = ?`).get(id) as {
    label_current: string
    label_source: string
  }
}

function labelRowSources(db: Database.Database, blockId: string): string[] {
  return (db.prepare(`SELECT source FROM timeline_block_labels WHERE block_id = ? ORDER BY source`).all(blockId) as Array<{ source: string }>)
    .map((row) => row.source)
}

test('storedLabelViolatesWorkNameGuards names the shapes the repair scans for', () => {
  const dev = { dominantCategory: 'development' as const }
  assert.ok(storedLabelViolatesWorkNameGuards('Working on Cursor Agents', dev),
    'a tool-surface subject inside the "Working on" wrapper is disqualified')
  assert.ok(storedLabelViolatesWorkNameGuards('Cursor Agents', dev), 'a bare tool-surface title is disqualified')
  assert.ok(storedLabelViolatesWorkNameGuards('Watching Netflix & YouTube', dev),
    'a leisure-brand headline on a focused-work block is disqualified')
  assert.ok(!storedLabelViolatesWorkNameGuards('Watching Netflix & YouTube', { dominantCategory: 'entertainment' }),
    'the same headline on a genuine entertainment block is a legitimate leisure label')
  assert.ok(!storedLabelViolatesWorkNameGuards('Working on the timeline coalescer in daylens', dev),
    'a real work subject survives')
  assert.ok(!storedLabelViolatesWorkNameGuards('Building the YouTube downloader', dev),
    'work ABOUT a leisure service is not a leisure headline')
})

test('the repair heals ai-labeled blocks, never user overrides, and stamps the guard version', async () => {
  const db = createProductionTestDatabase()

  // Four blocks with the exact stored shape from the real DB: label_current
  // AND an ai label row both carrying the disqualified string.
  seedBlock(db, {
    id: 'blk_cursor_agents',
    startHour: 9,
    endHour: 10,
    label: 'Working on Cursor Agents',
    labelSource: 'ai',
    evidence: DEV_EVIDENCE,
    labelRows: [{ id: 'lbl_ca_ai', label: 'Working on Cursor Agents', source: 'ai' }],
  })
  seedBlock(db, {
    id: 'blk_netflix',
    startHour: 10,
    endHour: 11,
    label: 'Watching Netflix & YouTube',
    labelSource: 'ai',
    evidence: DEV_EVIDENCE,
    labelRows: [{ id: 'lbl_nf_ai', label: 'Watching Netflix & YouTube', source: 'ai' }],
  })
  // A user renamed this block to something the guards would reject — their
  // word is law and the repair must not touch it.
  seedBlock(db, {
    id: 'blk_user',
    startHour: 11,
    endHour: 12,
    label: 'Working on Cursor Agents',
    labelSource: 'user',
    evidence: DEV_EVIDENCE,
    labelRows: [{ id: 'lbl_user', label: 'Working on Cursor Agents', source: 'user' }],
  })
  // A clean ai-labeled block on another date: untouched, projections kept.
  seedBlock(db, {
    id: 'blk_clean',
    date: OTHER_DATE,
    startHour: 9,
    endHour: 10,
    label: 'Refactoring the timeline coalescer',
    labelSource: 'ai',
    evidence: DEV_EVIDENCE,
    labelRows: [{ id: 'lbl_clean_ai', label: 'Refactoring the timeline coalescer', source: 'ai' }],
  })

  seedDaySnapshot(db, TEST_DATE)
  seedWrappedNarrative(db, TEST_DATE)
  seedDaySnapshot(db, OTHER_DATE)
  seedWrappedNarrative(db, OTHER_DATE)

  const result = await runLabelGuardRepair(db)
  assert.equal(result.status, 'ran')
  assert.equal(result.healedBlocks, 2, 'exactly the two ai blocks with disqualified labels healed')
  assert.deepEqual(result.affectedDates, [TEST_DATE])

  for (const id of ['blk_cursor_agents', 'blk_netflix']) {
    const row = blockRow(db, id)
    assert.notEqual(row.label_current, 'Working on Cursor Agents', `${id} no longer carries the disqualified label`)
    assert.notEqual(row.label_current, 'Watching Netflix & YouTube', `${id} no longer carries the disqualified label`)
    assert.ok(
      !storedLabelViolatesWorkNameGuards(row.label_current, { dominantCategory: 'development' }),
      `${id} healed to a guard-passing label, got "${row.label_current}"`,
    )
    assert.notEqual(row.label_source, 'ai', `${id} dropped to a deterministic source (flagged for relabel)`)
    assert.notEqual(row.label_source, 'user', `${id} never masquerades as user-authored`)
    assert.deepEqual(labelRowSources(db, id), [], `${id}'s disqualified ai row is gone`)
  }

  const userBlock = blockRow(db, 'blk_user')
  assert.equal(userBlock.label_current, 'Working on Cursor Agents', 'the user override is untouched')
  assert.equal(userBlock.label_source, 'user')
  assert.deepEqual(labelRowSources(db, 'blk_user'), ['user'], 'the user label row survives')

  const cleanBlock = blockRow(db, 'blk_clean')
  assert.equal(cleanBlock.label_current, 'Refactoring the timeline coalescer', 'a clean ai label is untouched')
  assert.equal(cleanBlock.label_source, 'ai')

  // Projections for the affected date regenerate; the clean date keeps its.
  const snapshotDates = (db.prepare(`SELECT date FROM day_snapshots ORDER BY date`).all() as Array<{ date: string }>)
    .map((row) => row.date)
  assert.deepEqual(snapshotDates, [OTHER_DATE], 'the affected date lost its frozen snapshot; the clean date kept it')
  const narrativeDates = (db.prepare(`SELECT period_key FROM wrapped_narratives WHERE cadence = 'day' ORDER BY period_key`).all() as Array<{ period_key: string }>)
    .map((row) => row.period_key)
  assert.deepEqual(narrativeDates, [OTHER_DATE], 'the affected date lost its stored wrap narrative')

  // Version-stamped, and the second run is a no-op.
  assert.ok(hasMaintenanceRun(db, labelGuardMaintenanceKey()), 'the guard version is stamped after completion')
  assert.equal(labelGuardMaintenanceKey(), `work_name_guard_repair_v${WORK_NAME_GUARD_VERSION}`)

  const again = await runLabelGuardRepairIfNeeded(db)
  assert.equal(again.status, 'already-ran', 'a stamped database skips the repair entirely')

  const healedRow = blockRow(db, 'blk_cursor_agents')
  const forced = await runLabelGuardRepair(db)
  assert.equal(forced.healedBlocks, 0, 'a forced re-run finds nothing left to heal (idempotent)')
  assert.deepEqual(blockRow(db, 'blk_cursor_agents'), healedRow, 'a re-run changes nothing')

  db.close()
})

test('an unstamped database runs the repair from the startup entry; blocks with any user label row are skipped', async () => {
  const db = createProductionTestDatabase()
  // label_source drifted to 'ai' but a user row exists — conservative skip.
  seedBlock(db, {
    id: 'blk_drifted',
    startHour: 9,
    endHour: 10,
    label: 'Working on Cursor Agents',
    labelSource: 'ai',
    evidence: DEV_EVIDENCE,
    labelRows: [
      { id: 'lbl_drift_ai', label: 'Working on Cursor Agents', source: 'ai' },
      { id: 'lbl_drift_user', label: 'My real work', source: 'user' },
    ],
  })

  const result = await runLabelGuardRepairIfNeeded(db)
  assert.equal(result.status, 'ran')
  assert.equal(result.healedBlocks, 0, 'a block carrying a user label row is never touched')
  assert.equal(blockRow(db, 'blk_drifted').label_current, 'Working on Cursor Agents')
  assert.deepEqual(labelRowSources(db, 'blk_drifted'), ['ai', 'user'], 'no label rows deleted on a skipped block')
  assert.ok(hasMaintenanceRun(db, labelGuardMaintenanceKey()))
  db.close()
})

// ─── Category-consistency heal ───────────────────────────────────────────────
// A stored block's dominant_category / category_distribution_json can predate
// the attention-clamped credit rules: one 17s Netflix history flip, filled
// across an untitled browser's foreground time, once stamped a Slack/CI-review
// block dominant 'entertainment' — and the read-time leisure floor then
// rendered "Watching Netflix & YouTube" over a perfectly good stored label.
// The repair recomputes the facts from the block's own members and heals the
// row; genuine watching (title-corroborated) stays entertainment.

function insertSession(
  db: Database.Database,
  o: { bundleId: string; appName: string; startHour: number; startMin: number; endHour: number; endMin: number; category: string; title: string },
): void {
  const start = localMs(o.startHour, o.startMin)
  const end = localMs(o.endHour, o.endMin)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 2)
  `).run(
    o.bundleId, o.appName, start, end, Math.round((end - start) / 1000),
    o.category, o.title, o.appName, o.bundleId,
  )
}

function insertVisit(
  db: Database.Database,
  o: { domain: string; title: string; url: string; visitMs: number; durationSec: number; browserBundleId: string },
): void {
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, normalized_url, page_key, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'history')
  `).run(
    o.domain, o.title, o.url, o.visitMs, o.visitMs * 1000, o.durationSec,
    o.browserBundleId, o.browserBundleId, o.url, o.url,
  )
}

function categoryRow(db: Database.Database, id: string): {
  dominant_category: string
  block_kind: string
  distribution: Partial<Record<string, number>>
} {
  const row = db.prepare(`
    SELECT dominant_category, block_kind, category_distribution_json FROM timeline_blocks WHERE id = ?
  `).get(id) as { dominant_category: string; block_kind: string; category_distribution_json: string }
  return {
    dominant_category: row.dominant_category,
    block_kind: row.block_kind,
    distribution: JSON.parse(row.category_distribution_json),
  }
}

// The reference shape (2026-07-20 21:24): Slack + Warp foreground work, an
// untitled browser whose last recorded navigation was a 20s Netflix flip —
// history fill inflated the stored entertainment seconds past everything else.
function seedCiReviewEvening(db: Database.Database): void {
  insertSession(db, {
    bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack', category: 'communication',
    startHour: 21, startMin: 0, endHour: 21, endMin: 5, title: 'daylens (Channel) - Slack',
  })
  insertSession(db, {
    bundleId: 'dev.warp.Warp-Stable', appName: 'Warp', category: 'development',
    startHour: 21, startMin: 5, endHour: 21, endMin: 25, title: '✳ Claude Code',
  })
  insertSession(db, {
    bundleId: 'company.thebrowser.dia', appName: 'Dia', category: 'browsing',
    startHour: 21, startMin: 25, endHour: 21, endMin: 50, title: 'Dia',
  })
  insertVisit(db, {
    domain: 'github.com', title: 'ci.yml · daylens/daylens',
    url: 'https://github.com/daylens/daylens/blob/main/.github/workflows/ci.yml',
    visitMs: localMs(21, 25) + 5_000, durationSec: 60,
    browserBundleId: 'company.thebrowser.dia',
  })
  // 20 seconds of recorded Netflix dwell; the history fill would hand this
  // visit the rest of the browser's foreground time (~23 minutes).
  insertVisit(db, {
    domain: 'netflix.com', title: 'Stranger Things — Netflix',
    url: 'https://www.netflix.com/watch/80100172',
    visitMs: localMs(21, 26) + 30_000, durationSec: 20,
    browserBundleId: 'company.thebrowser.dia',
  })
}

const CI_EVENING_BLOCK_ID = 'blk_ci_evening'

function seedCiEveningBlock(db: Database.Database, options: { withCorrectedReview?: boolean } = {}): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, 'work', 'entertainment', ?, 0, ?, 'ai', 0.9, NULL, ?, 0, 'test-v1', ?, NULL)
  `).run(
    CI_EVENING_BLOCK_ID,
    TEST_DATE,
    localMs(21, 0),
    localMs(21, 50),
    // The stale stored facts: fill-inflated entertainment dominating the
    // real communication + development attention.
    JSON.stringify({ entertainment: 1400, communication: 300, development: 1200, browsing: 100 }),
    'Slack and Blacksmith workflow review',
    JSON.stringify(DEV_EVIDENCE),
    now,
  )
  db.prepare(`
    INSERT INTO timeline_block_labels (id, block_id, label, narrative, source, confidence, created_at)
    VALUES ('lbl_ci_ai', ?, 'Slack and Blacksmith workflow review', NULL, 'ai', 0.9, ?)
  `).run(CI_EVENING_BLOCK_ID, now)
  if (options.withCorrectedReview) {
    db.prepare(`
      INSERT INTO timeline_block_reviews (id, block_id, date, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at)
      VALUES ('rev_ci', ?, ?, 'ek', 'corrected', '{}', '{"category":"entertainment"}', ?, ?)
    `).run(CI_EVENING_BLOCK_ID, TEST_DATE, now, now)
  }
}

test('stale entertainment category facts heal to the focused truth; label and projections follow', async () => {
  const db = createProductionTestDatabase()
  try {
    seedCiReviewEvening(db)
    seedCiEveningBlock(db)
    seedDaySnapshot(db, TEST_DATE)
    seedWrappedNarrative(db, TEST_DATE)

    const result = await runLabelGuardRepair(db)
    assert.equal(result.status, 'ran')
    assert.equal(result.healedCategoryBlocks, 1, 'the stale category facts healed')
    assert.deepEqual(result.affectedDates, [TEST_DATE])

    const healed = categoryRow(db, CI_EVENING_BLOCK_ID)
    assert.equal(healed.dominant_category, 'development',
      'the recomputation names the focused work the members actually show')
    assert.equal(healed.block_kind, 'work')
    assert.ok((healed.distribution.entertainment ?? 0) <= 60,
      `entertainment credit is clamped to the recorded 20s dwell, got ${healed.distribution.entertainment}`)
    assert.ok((healed.distribution.development ?? 0) >= 1200,
      'the foreground development attention survives the recomputation')

    // The stored label was always right — a category heal never rewrites it.
    const labelRow = blockRow(db, CI_EVENING_BLOCK_ID)
    assert.equal(labelRow.label_current, 'Slack and Blacksmith workflow review')
    assert.equal(labelRow.label_source, 'ai')
    assert.deepEqual(labelRowSources(db, CI_EVENING_BLOCK_ID), ['ai'], 'the clean ai label row survives')

    // Projections over the stale facts regenerate.
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM day_snapshots WHERE date = ?`).get(TEST_DATE)!['n' as never], 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM wrapped_narratives WHERE cadence = 'day' AND period_key = ?`).get(TEST_DATE)!['n' as never], 0)

    // Idempotent: a forced re-run finds the stored facts already true.
    const again = await runLabelGuardRepair(db)
    assert.equal(again.healedCategoryBlocks, 0, 'a re-run is a no-op')
    assert.equal(again.healedBlocks, 0)
    assert.deepEqual(categoryRow(db, CI_EVENING_BLOCK_ID), healed, 'a re-run changes nothing')
  } finally {
    db.close()
  }
})

test('a genuinely-leisure stored block keeps its entertainment facts and label', async () => {
  const db = createProductionTestDatabase()
  try {
    // Safari foregrounded ON Netflix: the window title corroborates the page,
    // so the visit keeps its full credit and the block stays entertainment.
    insertSession(db, {
      bundleId: 'com.apple.Safari', appName: 'Safari', category: 'browsing',
      startHour: 20, startMin: 0, endHour: 21, endMin: 30, title: 'Stranger Things - Netflix',
    })
    insertVisit(db, {
      domain: 'netflix.com', title: 'Stranger Things',
      url: 'https://www.netflix.com/watch/80100172',
      visitMs: localMs(20, 5), durationSec: 85 * 60,
      browserBundleId: 'com.apple.Safari',
    })
    const now = Date.now()
    db.prepare(`
      INSERT INTO timeline_blocks (
        id, date, start_time, end_time, block_kind, dominant_category,
        category_distribution_json, switch_count, label_current, label_source,
        label_confidence, narrative_current, evidence_summary_json, is_live,
        heuristic_version, computed_at, invalidated_at
      ) VALUES ('blk_watching', ?, ?, ?, 'work', 'entertainment', ?, 0, 'Watching Netflix', 'ai', 0.9, NULL, '{}', 0, 'test-v1', ?, NULL)
    `).run(TEST_DATE, localMs(20, 0), localMs(21, 30), JSON.stringify({ entertainment: 5100, browsing: 300 }), now)
    seedDaySnapshot(db, TEST_DATE)

    const result = await runLabelGuardRepair(db)
    assert.equal(result.healedCategoryBlocks, 0, 'real watching is not "healed"')
    assert.equal(result.healedBlocks, 0, 'a leisure label on a leisure block passes the guards')
    assert.deepEqual(result.affectedDates, [])
    assert.equal(categoryRow(db, 'blk_watching').dominant_category, 'entertainment')
    assert.equal(blockRow(db, 'blk_watching').label_current, 'Watching Netflix')
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM day_snapshots WHERE date = ?`).get(TEST_DATE)!['n' as never], 1,
      'an untouched date keeps its frozen snapshot')
  } finally {
    db.close()
  }
})

test('a user category correction blocks the category heal (invariant 8)', async () => {
  const db = createProductionTestDatabase()
  try {
    seedCiReviewEvening(db)
    seedCiEveningBlock(db, { withCorrectedReview: true })

    const result = await runLabelGuardRepair(db)
    assert.equal(result.healedCategoryBlocks, 0, 'a corrected block is never recomputed')
    assert.equal(categoryRow(db, CI_EVENING_BLOCK_ID).dominant_category, 'entertainment',
      'the corrected category stands')
  } finally {
    db.close()
  }
})

test('a pre-stamped database never rescans (guard-version keying)', async () => {
  const db = createProductionTestDatabase()
  markMaintenanceRun(db, labelGuardMaintenanceKey())
  seedBlock(db, {
    id: 'blk_stale',
    startHour: 9,
    endHour: 10,
    label: 'Working on Cursor Agents',
    labelSource: 'ai',
    evidence: DEV_EVIDENCE,
    labelRows: [{ id: 'lbl_stale_ai', label: 'Working on Cursor Agents', source: 'ai' }],
  })
  const result = await runLabelGuardRepairIfNeeded(db)
  assert.equal(result.status, 'already-ran')
  assert.equal(blockRow(db, 'blk_stale').label_current, 'Working on Cursor Agents',
    'nothing runs until the guard version bumps past the stamp')
  db.close()
})
