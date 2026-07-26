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
