// Startup self-heal for stored block labels the work-name guards now reject.
//
// The guards in src/shared/workNameGuards.ts (and the checks built on them in
// workBlocks.ts) stop tool-surface titles ("Working on Cursor Agents"),
// command lines, joined tab titles, and leisure headlines on work blocks
// ("Watching Netflix & YouTube") from ever being CHOSEN as labels again. But
// labels persisted before the guards existed still sit in
// timeline_blocks.label_current and timeline_block_labels, and every
// SQL-direct consumer (activity facts, day snapshots, wraps, search) keeps
// serving them. "Click Re-analyze on every day" is not a fix — this pass heals
// the stored rows on startup, once per guard version.
//
// What one repaired block looks like:
//   - every non-user timeline_block_labels row whose label fails today's
//     guards is DELETED (derived data; the FTS delete-triggers scrub the text
//     from search). Losing a disqualified ai row drops the block to a
//     deterministic label source, which is exactly the "flagged for relabel"
//     state shouldReanalyzeBlockWithAI already reacts to — the next
//     analyzeDay/consolidation spends AI only on those blocks.
//   - label_current is re-derived through the REAL finalize ladder
//     (rederivePersistedDayLabels → finalizedLabelForBlock) over what
//     legitimately remains, and persisted with the ladder's own deterministic
//     source ('rule' / 'artifact' / 'memory' / 'workflow'). If even the
//     re-derived label somehow fails the guards, the honest category floor
//     wins.
//   - the block's date has its frozen day snapshot and stored wrap
//     narratives dropped, so period projections regenerate from healed labels.
//   - user overrides are never touched: blocks with label_source 'user' or
//     any user label row are skipped entirely.
//
// Versioning: WORK_NAME_GUARD_VERSION (declared next to the guards) keys a
// maintenance_runs stamp. The pass runs when the stamp for the CURRENT version
// is absent — i.e. on first launch after a guard change — and re-stamps at the
// end. Bump the constant whenever guard rules change.
//
// Interrupt safety: work is chunked (the aiUsageRetention.ts pattern) — the
// scan pages through timeline_blocks by rowid, each affected date heals in ONE
// transaction (label-row deletes + re-derived label_current + projection
// invalidation together), and the loop yields to the event loop between
// chunks. A crash mid-run loses nothing: healed dates no longer match the
// scan, unhealed dates are found again, and the stamp is only written after
// the final date.

import type Database from 'better-sqlite3'
import { WORK_NAME_GUARD_VERSION } from '@shared/workNameGuards'
import { isAppCategory, type AppCategory, type PageRef, type TimelineEvidenceSummary, type WorkContextAppSummary } from '@shared/types'
import { hasMaintenanceRun, markMaintenanceRun } from '../db/maintenance'
import {
  invalidateDayProjectionsForLabelChange,
  prettyCategory,
  rederivePersistedDayLabels,
  storedLabelViolatesWorkNameGuards,
} from './workBlocks'

// Blocks examined per scan chunk. A chunk is a read plus in-memory guard
// checks (evidence JSON parse per row); 500 keeps each slice in the low
// milliseconds even with large evidence payloads.
export const LABEL_GUARD_SCAN_CHUNK = 500

export function labelGuardMaintenanceKey(version = WORK_NAME_GUARD_VERSION): string {
  return `work_name_guard_repair_v${version}`
}

export interface LabelGuardRepairResult {
  status: 'ran' | 'already-ran' | 'interrupted'
  scannedBlocks: number
  healedBlocks: number
  deletedLabelRows: number
  affectedDates: string[]
}

interface ScannedBlockRow {
  rowid: number
  id: string
  date: string
  label_current: string
  label_source: string
  dominant_category: string
  evidence_summary_json: string
  has_user_label: number
}

interface LabelRow {
  id: string
  label: string
  source: string
}

interface AffectedBlock {
  blockId: string
  dominantCategory: AppCategory
  /** Disqualified non-user label-row ids to delete. */
  disqualifiedLabelRowIds: string[]
}

function evidenceContext(row: ScannedBlockRow): {
  dominantCategory: AppCategory
  pageRefs: PageRef[]
  topApps: WorkContextAppSummary[]
} {
  let evidence: Partial<TimelineEvidenceSummary> = {}
  try {
    evidence = JSON.parse(row.evidence_summary_json || '{}') as Partial<TimelineEvidenceSummary>
  } catch {
    evidence = {}
  }
  return {
    dominantCategory: isAppCategory(row.dominant_category) ? row.dominant_category : 'uncategorized',
    pageRefs: Array.isArray(evidence.pages) ? evidence.pages as PageRef[] : [],
    topApps: Array.isArray(evidence.apps) ? evidence.apps as WorkContextAppSummary[] : [],
  }
}

/** One scan chunk: blocks with rowid > cursor, oldest schema-order first. */
function scanChunk(db: Database.Database, cursor: number, limit: number): ScannedBlockRow[] {
  return db.prepare(`
    SELECT
      b.rowid AS rowid,
      b.id,
      b.date,
      b.label_current,
      b.label_source,
      b.dominant_category,
      b.evidence_summary_json,
      EXISTS(
        SELECT 1 FROM timeline_block_labels ul
        WHERE ul.block_id = b.id AND ul.source = 'user'
      ) AS has_user_label
    FROM timeline_blocks b
    WHERE b.rowid > ?
      AND b.invalidated_at IS NULL
      AND b.is_live = 0
    ORDER BY b.rowid
    LIMIT ?
  `).all(cursor, limit) as ScannedBlockRow[]
}

/**
 * Heal one date atomically: delete its disqualified label rows, re-derive
 * label_current for the affected blocks through the real finalize ladder, and
 * invalidate the date's projections. Returns rows deleted / blocks updated.
 */
function healDate(
  db: Database.Database,
  dateStr: string,
  blocks: AffectedBlock[],
): { deletedLabelRows: number; healedBlocks: number } {
  const deleteLabelRow = db.prepare(`DELETE FROM timeline_block_labels WHERE id = ?`)
  const updateBlock = db.prepare(`
    UPDATE timeline_blocks
    SET label_current = ?, label_source = ?, label_confidence = ?
    WHERE id = ? AND invalidated_at IS NULL
  `)

  return db.transaction(() => {
    let deletedLabelRows = 0
    for (const block of blocks) {
      for (const rowId of block.disqualifiedLabelRowIds) {
        deletedLabelRows += deleteLabelRow.run(rowId).changes
      }
    }

    // With the disqualified rows gone, the ladder re-chooses from what
    // remains — surviving ai/workflow rows, artifacts, editor projects,
    // deterministic floors — exactly as the renderer read derives labels.
    const rederived = rederivePersistedDayLabels(db, dateStr)
    let healedBlocks = 0
    for (const block of blocks) {
      const healed = rederived.get(block.blockId)
      const context = { dominantCategory: block.dominantCategory }
      const healedLabel = healed && healed.source !== 'user'
        && !storedLabelViolatesWorkNameGuards(healed.label, context)
        ? healed
        : null
      // Floor: the honest category name, never another guess.
      const label = healedLabel?.label ?? prettyCategory(block.dominantCategory)
      const source = healedLabel?.source ?? 'rule'
      const confidence = healedLabel?.confidence ?? 0.5
      if (healed?.source === 'user') continue
      healedBlocks += updateBlock.run(label, source, confidence, block.blockId).changes
    }

    invalidateDayProjectionsForLabelChange(db, dateStr)
    return { deletedLabelRows, healedBlocks }
  })()
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

let inFlight: Promise<LabelGuardRepairResult> | null = null

/**
 * Scan every valid persisted block for labels today's guards reject and heal
 * them in place. Idempotent and safe to interrupt; stamps
 * maintenance_runs['work_name_guard_repair_v<N>'] on completion.
 */
export async function runLabelGuardRepair(
  db: Database.Database,
  options: { chunkSize?: number } = {},
): Promise<LabelGuardRepairResult> {
  const chunkSize = options.chunkSize ?? LABEL_GUARD_SCAN_CHUNK
  const result: LabelGuardRepairResult = {
    status: 'ran',
    scannedBlocks: 0,
    healedBlocks: 0,
    deletedLabelRows: 0,
    affectedDates: [],
  }

  const labelRowsForBlock = db.prepare(`
    SELECT id, label, source
    FROM timeline_block_labels
    WHERE block_id = ?
      AND source IN ('rule', 'artifact', 'workflow', 'memory', 'ai')
  `)

  // Phase 1 — scan: find affected blocks, grouped by date.
  const affectedByDate = new Map<string, AffectedBlock[]>()
  let cursor = 0
  for (;;) {
    if (!db.open) return { ...result, status: 'interrupted' }
    const rows = scanChunk(db, cursor, chunkSize)
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].rowid
    result.scannedBlocks += rows.length

    for (const row of rows) {
      // Never touch a user-named block, whatever its stored label says.
      if (row.label_source === 'user' || row.has_user_label) continue

      const context = evidenceContext(row)
      const labelRows = labelRowsForBlock.all(row.id) as LabelRow[]
      const disqualifiedLabelRowIds = labelRows
        .filter((labelRow) => storedLabelViolatesWorkNameGuards(labelRow.label, context))
        .map((labelRow) => labelRow.id)
      const currentViolates = storedLabelViolatesWorkNameGuards(row.label_current, context)
      if (!currentViolates && disqualifiedLabelRowIds.length === 0) continue

      const affected: AffectedBlock = {
        blockId: row.id,
        dominantCategory: context.dominantCategory,
        disqualifiedLabelRowIds,
      }
      const existing = affectedByDate.get(row.date)
      if (existing) existing.push(affected)
      else affectedByDate.set(row.date, [affected])
    }
    await yieldToEventLoop()
  }

  // Phase 2 — heal, one date per transaction, yielding between dates.
  for (const [dateStr, blocks] of affectedByDate) {
    if (!db.open) return { ...result, status: 'interrupted' }
    const healed = healDate(db, dateStr, blocks)
    result.deletedLabelRows += healed.deletedLabelRows
    result.healedBlocks += healed.healedBlocks
    result.affectedDates.push(dateStr)
    await yieldToEventLoop()
  }

  if (!db.open) return { ...result, status: 'interrupted' }
  markMaintenanceRun(db, labelGuardMaintenanceKey())
  return result
}

/**
 * The startup entry: runs the repair only when the current guard version has
 * never completed on this database. Concurrent callers share one run.
 */
export function runLabelGuardRepairIfNeeded(
  db: Database.Database,
): Promise<LabelGuardRepairResult> {
  if (hasMaintenanceRun(db, labelGuardMaintenanceKey())) {
    return Promise.resolve({
      status: 'already-ran',
      scannedBlocks: 0,
      healedBlocks: 0,
      deletedLabelRows: 0,
      affectedDates: [],
    })
  }
  if (!inFlight) {
    inFlight = runLabelGuardRepair(db).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}
