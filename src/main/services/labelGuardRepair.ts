// Startup self-heal for stored block labels the work-name guards now reject,
// and for stored category facts the clamped-credit rules now contradict.
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
// The pass also heals stale stored CATEGORY facts. A block's persisted
// dominant_category / category_distribution_json may predate the
// attention-clamped credit rules (a background Netflix tab's history-fill
// seconds once stamped a Slack/CI-review block dominant 'entertainment'), and
// the read path then manufactures a leisure headline from them no matter how
// good the stored label is. Each stored block's category facts are recomputed
// from its own members through the REAL builder computation
// (recomputeStoredBlockCategoryFacts — weightedCategoryDistributionFor +
// dominantCategoryForBlock); when the stored dominant category disagrees, the
// row is updated in place and the date's projections invalidated exactly like
// a label heal. Blocks with a user category correction (review_state
// 'corrected') are skipped; blocks whose raw sessions are gone keep their
// stored facts.
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
// end. One stamp gates both heals: bump the constant whenever the guard rules
// OR the category-fact rules this pass recomputes with change.
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
import {
  isAppCategory,
  type AppCategory,
  type ArtifactRef,
  type DocumentRef,
  type PageRef,
  type TimelineEvidenceSummary,
  type WorkContextAppSummary,
} from '@shared/types'
import { hasMaintenanceRun, markMaintenanceRun } from '../db/maintenance'
import {
  invalidateDayProjectionsForLabelChange,
  prettyCategory,
  recomputeStoredBlockCategoryFacts,
  rederivePersistedDayLabels,
  storedLabelViolatesWorkNameGuards,
} from './workBlocks'

// Blocks examined per scan chunk. Each scanned block now runs the category
// recomputation (a range facts query + visit reconciliation over its own
// span), so a chunk costs a few milliseconds per block; 100 keeps each slice
// comfortably under the frame budget before yielding.
export const LABEL_GUARD_SCAN_CHUNK = 100

export function labelGuardMaintenanceKey(version = WORK_NAME_GUARD_VERSION): string {
  return `work_name_guard_repair_v${version}`
}

export interface LabelGuardRepairResult {
  status: 'ran' | 'already-ran' | 'interrupted'
  scannedBlocks: number
  healedBlocks: number
  healedCategoryBlocks: number
  deletedLabelRows: number
  affectedDates: string[]
}

interface ScannedBlockRow {
  rowid: number
  id: string
  date: string
  start_time: number
  end_time: number
  label_current: string
  label_source: string
  dominant_category: string
  evidence_summary_json: string
  has_user_label: number
  has_corrected_review: number
}

interface LabelRow {
  id: string
  label: string
  source: string
}

interface CategoryUpdate {
  dominantCategory: AppCategory
  distributionJson: string
  blockKind: string
}

interface AffectedBlock {
  blockId: string
  dominantCategory: AppCategory
  /** Disqualified non-user label-row ids to delete. */
  disqualifiedLabelRowIds: string[]
  /** True when label_current itself (or a label row) failed the guards and
   *  the block's label must be re-derived through the finalize ladder. */
  healLabel: boolean
  /** Recomputed category facts to write, when the stored ones disagree. */
  categoryUpdate: CategoryUpdate | null
}

function evidenceContext(row: ScannedBlockRow): {
  dominantCategory: AppCategory
  pageRefs: PageRef[]
  topApps: WorkContextAppSummary[]
  topArtifacts: ArtifactRef[]
} {
  let evidence: Partial<TimelineEvidenceSummary> = {}
  try {
    evidence = JSON.parse(row.evidence_summary_json || '{}') as Partial<TimelineEvidenceSummary>
  } catch {
    evidence = {}
  }
  const pageRefs = Array.isArray(evidence.pages) ? evidence.pages as PageRef[] : []
  const documentRefs = Array.isArray(evidence.documents) ? evidence.documents as DocumentRef[] : []
  // Same artifact ranking the persisted read path feeds dominantCategoryForBlock.
  const topArtifacts = [...pageRefs, ...documentRefs]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 6)
  return {
    dominantCategory: isAppCategory(row.dominant_category) ? row.dominant_category : 'uncategorized',
    pageRefs,
    topApps: Array.isArray(evidence.apps) ? evidence.apps as WorkContextAppSummary[] : [],
    topArtifacts,
  }
}

/** One scan chunk: blocks with rowid > cursor, oldest schema-order first. */
function scanChunk(db: Database.Database, cursor: number, limit: number): ScannedBlockRow[] {
  return db.prepare(`
    SELECT
      b.rowid AS rowid,
      b.id,
      b.date,
      b.start_time,
      b.end_time,
      b.label_current,
      b.label_source,
      b.dominant_category,
      b.evidence_summary_json,
      EXISTS(
        SELECT 1 FROM timeline_block_labels ul
        WHERE ul.block_id = b.id AND ul.source = 'user'
      ) AS has_user_label,
      EXISTS(
        SELECT 1 FROM timeline_block_reviews r
        WHERE r.block_id = b.id AND r.review_state = 'corrected'
      ) AS has_corrected_review
    FROM timeline_blocks b
    WHERE b.rowid > ?
      AND b.invalidated_at IS NULL
      AND b.is_live = 0
    ORDER BY b.rowid
    LIMIT ?
  `).all(cursor, limit) as ScannedBlockRow[]
}

/**
 * Heal one date atomically: write recomputed category facts, delete its
 * disqualified label rows, re-derive label_current for the label-affected
 * blocks through the real finalize ladder, and invalidate the date's
 * projections. Category facts go first so the ladder re-derives over the
 * healed truth. Returns rows deleted / blocks updated.
 */
function healDate(
  db: Database.Database,
  dateStr: string,
  blocks: AffectedBlock[],
): { deletedLabelRows: number; healedBlocks: number; healedCategoryBlocks: number } {
  const deleteLabelRow = db.prepare(`DELETE FROM timeline_block_labels WHERE id = ?`)
  const updateBlock = db.prepare(`
    UPDATE timeline_blocks
    SET label_current = ?, label_source = ?, label_confidence = ?
    WHERE id = ? AND invalidated_at IS NULL
  `)
  const updateCategoryFacts = db.prepare(`
    UPDATE timeline_blocks
    SET dominant_category = ?, category_distribution_json = ?, block_kind = ?
    WHERE id = ? AND invalidated_at IS NULL
  `)

  return db.transaction(() => {
    let healedCategoryBlocks = 0
    for (const block of blocks) {
      if (!block.categoryUpdate) continue
      healedCategoryBlocks += updateCategoryFacts.run(
        block.categoryUpdate.dominantCategory,
        block.categoryUpdate.distributionJson,
        block.categoryUpdate.blockKind,
        block.blockId,
      ).changes
    }

    let deletedLabelRows = 0
    for (const block of blocks) {
      for (const rowId of block.disqualifiedLabelRowIds) {
        deletedLabelRows += deleteLabelRow.run(rowId).changes
      }
    }

    // With the disqualified rows gone (and category facts already healed),
    // the ladder re-chooses from what remains — surviving ai/workflow rows,
    // artifacts, editor projects, deterministic floors — exactly as the
    // renderer read derives labels. Blocks flagged only for a category heal
    // keep their stored label verbatim.
    const labelBlocks = blocks.filter((block) => block.healLabel)
    const rederived = labelBlocks.length > 0 ? rederivePersistedDayLabels(db, dateStr) : new Map()
    let healedBlocks = 0
    for (const block of labelBlocks) {
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
    return { deletedLabelRows, healedBlocks, healedCategoryBlocks }
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
    healedCategoryBlocks: 0,
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

      // Category consistency: recompute the block's dominant category and
      // distribution from its own members with the builder's current
      // (attention-gated) rules. A material disagreement — the recomputed
      // dominant differs from the stored one, which covers the
      // entertainment/social-dominant-on-a-work-block flip — heals the row.
      // A user category correction is law (invariant 8): skip recomputation.
      let categoryUpdate: CategoryUpdate | null = null
      if (!row.has_corrected_review) {
        const recomputed = recomputeStoredBlockCategoryFacts(
          db, row.start_time, row.end_time, context.topArtifacts,
        )
        if (recomputed && recomputed.dominantCategory !== context.dominantCategory) {
          categoryUpdate = {
            dominantCategory: recomputed.dominantCategory,
            distributionJson: JSON.stringify(recomputed.distribution),
            blockKind: recomputed.blockKind,
          }
        }
      }

      // Guard checks run against the healed category: a leisure headline that
      // looked legitimate on a stored 'entertainment' block is disqualified
      // once the recomputation says the block was really focused work.
      const guardContext = {
        ...context,
        dominantCategory: categoryUpdate?.dominantCategory ?? context.dominantCategory,
      }
      const labelRows = labelRowsForBlock.all(row.id) as LabelRow[]
      const disqualifiedLabelRowIds = labelRows
        .filter((labelRow) => storedLabelViolatesWorkNameGuards(labelRow.label, guardContext))
        .map((labelRow) => labelRow.id)
      const currentViolates = storedLabelViolatesWorkNameGuards(row.label_current, guardContext)
      if (!currentViolates && disqualifiedLabelRowIds.length === 0 && !categoryUpdate) continue

      const affected: AffectedBlock = {
        blockId: row.id,
        dominantCategory: guardContext.dominantCategory,
        disqualifiedLabelRowIds,
        healLabel: currentViolates || disqualifiedLabelRowIds.length > 0,
        categoryUpdate,
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
    result.healedCategoryBlocks += healed.healedCategoryBlocks
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
      healedCategoryBlocks: 0,
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
