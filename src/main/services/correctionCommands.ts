// Correction commands (timeline spec, Corrections; DEV-172).
//
// Every non-destructive correction — rename, category, trim, merge, split,
// exclude a block, exclude specific evidence, assign a client — flows through
// one typed command with three verbs:
//
//   previewCorrection  — applies the command inside a SQLite savepoint, reads
//                        the corrected day and Apps facts, rolls back, and
//                        returns the delta. The preview IS the apply, dry-run:
//                        it can never drift from what apply will do.
//   applyCorrection    — one transaction: snapshot the correction-ledger rows
//                        the command may touch, apply, record the undo entry.
//                        A conflicting correction throws before or inside the
//                        transaction and nothing lands (spec: "Conflicting
//                        corrections do not apply partially").
//   undoCorrection     — restores the snapshot in one transaction. Only the
//                        newest un-undone correction of a date can be undone,
//                        so interleaved restores can't corrupt the ledger.
//
// Permanent purges are NOT commands. They destroy raw rows, require their own
// confirmation, and have no undo — the spec keeps them clearly separated.
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  AppCategory,
  CorrectionAppDelta,
  CorrectionApplyResult,
  CorrectionBlockDelta,
  CorrectionCommand,
  CorrectionPreview,
  CorrectionUndoResult,
  DayTimelinePayload,
  LiveSession,
  WorkContextBlock,
} from '@shared/types'
import { activityCategoryLabel } from '@shared/activityCategories'
import { localDayBounds } from '../lib/localDate'
import { absenceSpannedBy, formatAbsenceRange } from '../lib/absenceGuard'
import { materializeTimelineDayProjection } from '../core/query/projections'
import { getCorrectedAppSummariesForRange } from './activityFacts'
import { applyTimelineBlockEdit } from './timelineBlockEdits'
import {
  invalidateTimelineDayBlocks,
  mergeTimelineEpisodes,
  writeSplitCorrection,
  writeTimelineBlockReview,
} from './workBlocks'
import {
  isEntityCorrectionSnapshot,
  restoreEntityCorrectionSnapshot,
} from './entities/entityCorrections'
import { refreshMemoryIndexForDay } from './memoryIndex'
import {
  deleteMeetingAttendanceMark,
  isMeetingAttendanceStatus,
  meetingEntityIdForScheduledEvent,
  scheduledEventKey,
  upsertMeetingAttendanceMark,
} from './meetingResolution'
import { addEntityEvidenceRef } from './entities/entityRepository'

const MIN_SPLIT_EDGE_MS = 60_000

interface ResolvedCommand {
  payload: DayTimelinePayload
  blocks: WorkContextBlock[]
}

interface LedgerSnapshot {
  affectedBlockIds: string[]
  reviews: Array<Record<string, unknown>>
  boundary: Array<Record<string, unknown>>
  labelOverrides: Array<Record<string, unknown>>
  exclusions: Array<Record<string, unknown>>
  workSessions: Array<{
    id: string
    client_id: string | null
    project_id: string | null
    attribution_status: string | null
    attribution_confidence: number | null
  }>
  segmentAttributions: Array<{
    segment_id: string
    client_id: string | null
    project_id: string | null
    decision_source: string | null
    confidence: number | null
  }>
  /** DEV-189 attendance marks for the date. Optional — snapshots written
   *  before mark-meeting existed restore without them. */
  meetingMarks?: Array<Record<string, unknown>>
  /** The user_confirmation occurrence refs the date's marks created. */
  meetingConfirmationRefs?: Array<Record<string, unknown>>
}

function blockIdsOf(command: CorrectionCommand): string[] {
  if (command.kind === 'merge') return command.blockIds
  // A scheduled meeting is addressed by its calendar identity, not a block —
  // a calendar-only event has no block to point at.
  if (command.kind === 'mark-meeting') return []
  return [command.blockId]
}

/** The day-local ledger identity of the command's scheduled meeting. */
function meetingEventKeyOf(command: Extract<CorrectionCommand, { kind: 'mark-meeting' }>): string {
  const [dayStartMs] = localDayBounds(command.date)
  const minutes = Math.round((command.meeting.startMs - dayStartMs) / 60_000)
  return scheduledEventKey(minutes, command.meeting.title)
}

function resolveCommand(
  db: Database.Database,
  command: CorrectionCommand,
  live: LiveSession | null,
): ResolvedCommand {
  const payload = materializeTimelineDayProjection(db, command.date, live)
  const blocks = blockIdsOf(command).map((blockId) => {
    const block = payload.blocks.find((candidate) => candidate.id === blockId)
    if (!block) throw new Error('Block not found — the day may have just rebuilt. Reopen it and try again.')
    return block
  })
  if (command.kind === 'merge' && blocks.length < 2) {
    throw new Error('Pick at least two blocks to merge.')
  }
  if (command.kind === 'split') {
    const [block] = blocks
    if (command.cutMs < block.startTime + MIN_SPLIT_EDGE_MS || command.cutMs > block.endTime - MIN_SPLIT_EDGE_MS) {
      throw new Error('Pick a split point at least a minute inside the block.')
    }
  }
  if (command.kind === 'exclude-evidence') {
    const ref = command.evidence
    const identity = ref.kind === 'site' ? ref.domain?.trim() : (ref.bundleId ?? ref.appName)?.trim()
    if (!identity) throw new Error('Nothing to exclude.')
  }
  if (command.kind === 'mark-meeting') {
    if (!command.meeting.title.trim()) throw new Error('The meeting has no title to address.')
    if (command.status !== null && !isMeetingAttendanceStatus(command.status)) {
      throw new Error('A meeting can be marked attended, skipped, moved, or unrelated.')
    }
    const exists = (payload.scheduledMeetings ?? []).some((meeting) =>
      meeting.title === command.meeting.title && meeting.startMs === command.meeting.startMs)
    if (!exists) {
      throw new Error('That scheduled meeting is not on this day anymore — the calendar may have just re-synced. Reopen the day and try again.')
    }
  }
  return { payload, blocks }
}

function clientNameFor(db: Database.Database, clientId: string | null): string | null {
  if (!clientId) return null
  const row = db.prepare(`SELECT name FROM clients WHERE id = ?`).get(clientId) as { name: string } | undefined
  return row?.name ?? null
}

function projectNameFor(db: Database.Database, projectId: string | null | undefined): string | null {
  if (!projectId) return null
  const row = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(projectId) as { name: string } | undefined
  return row?.name ?? null
}

function describeCommand(
  db: Database.Database,
  command: CorrectionCommand,
  blocks: readonly WorkContextBlock[],
): string {
  const label = (block: WorkContextBlock): string => block.label.current
  switch (command.kind) {
    case 'edit': {
      const parts: string[] = []
      if (command.label && command.label.trim() !== blocks[0].label.current) {
        parts.push(`Rename "${label(blocks[0])}" to "${command.label.trim()}"`)
      }
      if (command.category && command.category !== blocks[0].dominantCategory) {
        // Human vocabulary, never the raw enum: "AI Tools", not "aiTools".
        const categoryName = activityCategoryLabel(command.category)
        parts.push(parts.length > 0 ? `change its category to ${categoryName}` : `Change the category of "${label(blocks[0])}" to ${categoryName}`)
      }
      if (command.startMs !== undefined || command.endMs !== undefined) {
        parts.push(parts.length > 0 ? 'adjust its time range' : `Adjust the time range of "${label(blocks[0])}"`)
      }
      return parts.length > 0 ? parts.join(', ') : `Edit "${label(blocks[0])}"`
    }
    case 'merge': {
      // A merge across time away is allowed (DEV-233, decided) but never
      // silent: the preview names the gap so the person merges knowingly.
      const gap = absenceSpannedBy(blocks.flatMap((block) => block.sessions))
      return gap
        ? `Merge ${blocks.length} blocks into one. They're separated by time away (${formatAbsenceRange(gap)}) — that time stays untracked`
        : `Merge ${blocks.length} blocks into one`
    }
    case 'split': {
      const at = new Date(command.cutMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      return `Split "${label(blocks[0])}" at ${at}`
    }
    case 'exclude-block':
      return `Remove "${label(blocks[0])}" from the day`
    case 'exclude-evidence': {
      const subject = command.evidence.kind === 'site'
        ? command.evidence.domain
        : (command.evidence.appName ?? command.evidence.bundleId)
      return `Exclude ${subject} from "${label(blocks[0])}"`
    }
    case 'assign-client': {
      const name = clientNameFor(db, command.clientId)
      if (!name) return `Remove the client assignment from "${label(blocks[0])}"`
      const project = projectNameFor(db, command.projectId)
      return project
        ? `Assign "${label(blocks[0])}" to ${name} · ${project}`
        : `Assign "${label(blocks[0])}" to ${name}`
    }
    case 'mark-meeting': {
      if (command.status === null) return `Clear the attendance mark on "${command.meeting.title}"`
      const verb = command.status === 'attended'
        ? 'attended'
        : command.status === 'skipped'
          ? 'skipped'
          : command.status === 'moved' ? 'moved' : 'unrelated to your day'
      return `Mark "${command.meeting.title}" as ${verb}`
    }
  }
}

// The single write path preview and apply share. Resolution already validated
// the command; everything here writes only correction-ledger rows (reviews,
// boundary corrections, label overrides, evidence exclusions, work-session
// attribution) — never raw evidence.
function applyCommandToLedger(
  db: Database.Database,
  command: CorrectionCommand,
  resolved: ResolvedCommand,
): void {
  switch (command.kind) {
    case 'edit': {
      applyTimelineBlockEdit(db, resolved.blocks[0], {
        blockId: command.blockId,
        date: command.date,
        label: command.label,
        category: command.category,
        startMs: command.startMs,
        endMs: command.endMs,
      })
      return
    }
    case 'merge': {
      mergeTimelineEpisodes(db, command.date, [...resolved.blocks])
      return
    }
    case 'split': {
      writeSplitCorrection(db, command.date, command.cutMs)
      invalidateTimelineDayBlocks(db, command.date)
      return
    }
    case 'exclude-block': {
      writeTimelineBlockReview(db, command.date, resolved.blocks[0], { state: 'ignored' })
      return
    }
    case 'exclude-evidence': {
      const block = resolved.blocks[0]
      const ref = command.evidence
      db.prepare(`
        INSERT INTO evidence_exclusions (id, date, kind, bundle_id, app_name, domain, span_start_ms, span_end_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `excl_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
        command.date,
        ref.kind,
        ref.bundleId ?? null,
        ref.appName ?? null,
        ref.domain ?? null,
        block.startTime,
        block.endTime,
        Date.now(),
      )
      invalidateTimelineDayBlocks(db, command.date)
      return
    }
    case 'assign-client': {
      const block = resolved.blocks[0]
      const now = Date.now()
      const sessions = db.prepare(`
        SELECT id FROM work_sessions WHERE started_at < ? AND ended_at > ?
      `).all(block.endTime, block.startTime) as Array<{ id: string }>
      if (sessions.length === 0 && (command.clientId != null || command.projectId != null)) {
        throw new Error(
          'Nothing to attribute in this block yet — attribution needs a work session overlapping the block.',
        )
      }
      for (const { id } of sessions) {
        db.prepare(`
          UPDATE work_sessions
          SET client_id = ?, project_id = ?,
              attribution_status = CASE WHEN ? IS NOT NULL THEN 'attributed' ELSE 'unattributed' END,
              attribution_confidence = CASE WHEN ? IS NOT NULL THEN 1.0 ELSE NULL END,
              updated_at = ?
          WHERE id = ?
        `).run(command.clientId, command.projectId ?? null, command.clientId, command.clientId, now, id)
        db.prepare(`
          UPDATE segment_attributions
          SET client_id = ?, project_id = ?, decision_source = 'user', confidence = 1.0
          WHERE rank = 1 AND segment_id IN (
            SELECT segment_id FROM work_session_segments WHERE work_session_id = ?
          )
        `).run(command.clientId, command.projectId ?? null, id)
      }
      return
    }
    case 'mark-meeting': {
      const eventKey = meetingEventKeyOf(command)
      if (command.status === null) {
        deleteMeetingAttendanceMark(db, { date: command.date, eventKey })
      } else {
        upsertMeetingAttendanceMark(db, { date: command.date, eventKey, status: command.status })
      }
      // Search/agent propagation: an 'attended' mark is explicit confirmation
      // (connectors.md §Google Calendar), recorded as a user_confirmation
      // occurrence ref on the meeting entity — the memory index upgrades the
      // record from "Scheduled: …" to "Meeting: …" on the refresh applyCorrection
      // already runs. Any other status (or clearing) removes that support.
      const refSourceId = `meeting-mark:${command.date}:${eventKey}`
      db.prepare(`DELETE FROM entity_evidence_refs WHERE source_type = 'user_confirmation' AND source_id = ?`)
        .run(refSourceId)
      if (command.status === 'attended') {
        const entityId = meetingEntityIdForScheduledEvent(db, command.date, eventKey)
        if (entityId) {
          addEntityEvidenceRef(db, entityId, {
            sourceType: 'user_confirmation',
            sourceId: refSourceId,
            spanStartMs: command.meeting.startMs,
          })
        }
      }
      return
    }
  }
}

function captureSnapshot(
  db: Database.Database,
  command: CorrectionCommand,
  resolved: ResolvedCommand,
): LedgerSnapshot {
  const affectedBlockIds = resolved.blocks.map((block) => block.id)
  const blockIdMarks = affectedBlockIds.map(() => '?').join(', ') || `''`
  const reviews = db.prepare(`
    SELECT * FROM timeline_block_reviews WHERE date = ? OR block_id IN (${blockIdMarks})
  `).all(command.date, ...affectedBlockIds) as Array<Record<string, unknown>>
  const boundary = db.prepare(`
    SELECT * FROM timeline_boundary_corrections WHERE date = ?
  `).all(command.date) as Array<Record<string, unknown>>
  const labelOverrides = affectedBlockIds.length === 0 ? [] : db.prepare(`
    SELECT * FROM block_label_overrides WHERE block_id IN (${blockIdMarks})
  `).all(...affectedBlockIds) as Array<Record<string, unknown>>
  const exclusions = db.prepare(`
    SELECT * FROM evidence_exclusions WHERE date = ?
  `).all(command.date) as Array<Record<string, unknown>>

  let workSessions: LedgerSnapshot['workSessions'] = []
  let segmentAttributions: LedgerSnapshot['segmentAttributions'] = []
  if (command.kind === 'assign-client') {
    const block = resolved.blocks[0]
    workSessions = db.prepare(`
      SELECT id, client_id, project_id, attribution_status, attribution_confidence
      FROM work_sessions WHERE started_at < ? AND ended_at > ?
    `).all(block.endTime, block.startTime) as LedgerSnapshot['workSessions']
    const sessionMarks = workSessions.map(() => '?').join(', ')
    segmentAttributions = workSessions.length === 0 ? [] : db.prepare(`
      SELECT segment_id, client_id, project_id, decision_source, confidence
      FROM segment_attributions
      WHERE rank = 1 AND segment_id IN (
        SELECT segment_id FROM work_session_segments WHERE work_session_id IN (${sessionMarks})
      )
    `).all(...workSessions.map((session) => session.id)) as LedgerSnapshot['segmentAttributions']
  }

  // DEV-189 attendance marks + the occurrence refs they created. Snapshot by
  // date so undo restores exactly the day's mark state (best-effort SELECTs:
  // a pre-migration database simply has no table yet).
  let meetingMarks: Array<Record<string, unknown>> = []
  let meetingConfirmationRefs: Array<Record<string, unknown>> = []
  try {
    meetingMarks = db.prepare(`SELECT * FROM meeting_attendance_marks WHERE date = ?`)
      .all(command.date) as Array<Record<string, unknown>>
    meetingConfirmationRefs = db.prepare(
      `SELECT * FROM entity_evidence_refs WHERE source_type = 'user_confirmation' AND source_id LIKE ?`,
    ).all(`meeting-mark:${command.date}:%`) as Array<Record<string, unknown>>
  } catch { /* pre-migration database */ }

  return { affectedBlockIds, reviews, boundary, labelOverrides, exclusions, workSessions, segmentAttributions, meetingMarks, meetingConfirmationRefs }
}

function restoreRows(
  db: Database.Database,
  table: string,
  rows: readonly Record<string, unknown>[],
): void {
  for (const row of rows) {
    const columns = Object.keys(row)
    db.prepare(`
      INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    `).run(...columns.map((column) => row[column]))
  }
}

function restoreSnapshot(db: Database.Database, dateStr: string, snapshot: LedgerSnapshot): void {
  const blockIdMarks = snapshot.affectedBlockIds.map(() => '?').join(', ') || `''`
  db.prepare(`DELETE FROM timeline_block_reviews WHERE date = ? OR block_id IN (${blockIdMarks})`)
    .run(dateStr, ...snapshot.affectedBlockIds)
  db.prepare(`DELETE FROM timeline_boundary_corrections WHERE date = ?`).run(dateStr)
  if (snapshot.affectedBlockIds.length > 0) {
    db.prepare(`DELETE FROM block_label_overrides WHERE block_id IN (${blockIdMarks})`)
      .run(...snapshot.affectedBlockIds)
  }
  db.prepare(`DELETE FROM evidence_exclusions WHERE date = ?`).run(dateStr)
  restoreRows(db, 'timeline_block_reviews', snapshot.reviews)
  restoreRows(db, 'timeline_boundary_corrections', snapshot.boundary)
  restoreRows(db, 'block_label_overrides', snapshot.labelOverrides)
  restoreRows(db, 'evidence_exclusions', snapshot.exclusions)
  // Attendance marks: older snapshots (before mark-meeting) carry no fields
  // and must not wipe the ledger they never captured.
  if (snapshot.meetingMarks || snapshot.meetingConfirmationRefs) {
    try {
      db.prepare(`DELETE FROM meeting_attendance_marks WHERE date = ?`).run(dateStr)
      db.prepare(`DELETE FROM entity_evidence_refs WHERE source_type = 'user_confirmation' AND source_id LIKE ?`)
        .run(`meeting-mark:${dateStr}:%`)
      restoreRows(db, 'meeting_attendance_marks', snapshot.meetingMarks ?? [])
      restoreRows(db, 'entity_evidence_refs', snapshot.meetingConfirmationRefs ?? [])
    } catch { /* pre-migration database */ }
  }
  for (const session of snapshot.workSessions) {
    // Attribution ids churn on reprojection; a vanished session simply has
    // nothing to restore.
    db.prepare(`
      UPDATE work_sessions
      SET client_id = ?, project_id = ?, attribution_status = ?, attribution_confidence = ?, updated_at = ?
      WHERE id = ?
    `).run(
      session.client_id, session.project_id, session.attribution_status,
      session.attribution_confidence, Date.now(), session.id,
    )
  }
  for (const attribution of snapshot.segmentAttributions) {
    db.prepare(`
      UPDATE segment_attributions
      SET client_id = ?, project_id = ?, decision_source = ?, confidence = ?
      WHERE rank = 1 AND segment_id = ?
    `).run(
      attribution.client_id, attribution.project_id, attribution.decision_source,
      attribution.confidence, attribution.segment_id,
    )
  }
}

function blockDeltas(
  targets: readonly WorkContextBlock[],
  after: DayTimelinePayload,
): CorrectionBlockDelta[] {
  return targets.map((target) => {
    const midpoint = target.startTime + (target.endTime - target.startTime) / 2
    const successor = after.blocks.find((candidate) =>
      candidate.startTime <= midpoint && candidate.endTime > midpoint
      && candidate.review?.state !== 'ignored')
      ?? null
    return {
      blockId: target.id,
      labelBefore: target.label.current,
      labelAfter: successor ? successor.label.current : null,
      startMsBefore: target.startTime,
      endMsBefore: target.endTime,
      startMsAfter: successor?.startTime ?? null,
      endMsAfter: successor?.endTime ?? null,
      categoryBefore: target.dominantCategory,
      categoryAfter: successor?.dominantCategory ?? null,
    }
  })
}

function appDeltas(
  before: ReturnType<typeof getCorrectedAppSummariesForRange>,
  after: ReturnType<typeof getCorrectedAppSummariesForRange>,
): CorrectionAppDelta[] {
  const names = new Set([...before.map((app) => app.appName), ...after.map((app) => app.appName)])
  const deltas: CorrectionAppDelta[] = []
  for (const appName of names) {
    const secondsBefore = before.find((app) => app.appName === appName)?.totalSeconds ?? 0
    const secondsAfter = after.find((app) => app.appName === appName)?.totalSeconds ?? 0
    if (Math.abs(secondsBefore - secondsAfter) >= 30) deltas.push({ appName, secondsBefore, secondsAfter })
  }
  return deltas.sort((a, b) => Math.abs(b.secondsAfter - b.secondsBefore) - Math.abs(a.secondsAfter - a.secondsBefore))
}

function surfaceNotes(
  db: Database.Database,
  command: CorrectionCommand,
  blocks: readonly WorkContextBlock[],
  category: AppCategory | undefined,
): string[] {
  const notes: string[] = []
  switch (command.kind) {
    case 'edit':
      if (command.label?.trim()) {
        notes.push(`Search and the AI will know this block as "${command.label.trim()}".`)
      }
      if (category) notes.push(`Apps and Timeline recolor this stretch as ${activityCategoryLabel(category)}.`)
      if (command.startMs !== undefined) {
        notes.push('Trimmed-off minutes re-form into their own block; nothing is lost.')
      }
      break
    case 'merge':
      notes.push('You get one block, and it stays one block when you leave and come back. Search finds one block instead of several.')
      break
    case 'split':
      notes.push('The cut survives every re-analysis; each side keeps its own evidence.')
      break
    case 'exclude-block':
      notes.push(`This stretch disappears from Timeline, Apps totals, search, and AI answers for ${command.date}. Raw capture is kept; undo brings it back.`)
      break
    case 'exclude-evidence': {
      const subject = command.evidence.kind === 'site'
        ? command.evidence.domain
        : (command.evidence.appName ?? command.evidence.bundleId)
      notes.push(`${subject} disappears from this block's evidence, the Apps totals, search, and AI answers. Raw capture is kept; undo brings it back.`)
      break
    }
    case 'assign-client': {
      const name = clientNameFor(db, command.clientId)
      const project = projectNameFor(db, command.projectId)
      if (!name) {
        notes.push(`Time in "${blocks[0].label.current}" no longer counts toward any client.`)
      } else if (project) {
        notes.push(`Time in "${blocks[0].label.current}" counts toward ${name} · ${project} in client rollups and reports.`)
      } else {
        notes.push(`Time in "${blocks[0].label.current}" counts toward ${name} in client rollups and reports.`)
      }
      break
    }
    case 'mark-meeting': {
      if (command.status === 'attended') {
        notes.push(`"${command.meeting.title}" counts as attended on the Timeline, in the day's wrap, in search, and in AI answers. No minutes are invented — observed time still comes only from real activity.`)
      } else if (command.status === null) {
        notes.push(`"${command.meeting.title}" goes back to what the evidence alone supports, everywhere.`)
      } else {
        notes.push(`"${command.meeting.title}" stays scheduled context only — never attended work. Any meeting-app time near it stands on its own. Timeline, wrap, search, and AI answers follow.`)
      }
      break
    }
  }
  return notes
}

export function previewCorrection(
  db: Database.Database,
  command: CorrectionCommand,
  live: LiveSession | null,
): CorrectionPreview {
  const [dayFromMs, dayToMs] = localDayBounds(command.date)
  const resolved = resolveCommand(db, command, live)
  const appsBefore = getCorrectedAppSummariesForRange(db, dayFromMs, dayToMs, live)
  const description = describeCommand(db, command, resolved.blocks)

  db.exec('SAVEPOINT correction_preview')
  try {
    applyCommandToLedger(db, command, resolved)
    const after = materializeTimelineDayProjection(db, command.date, live)
    const appsAfter = getCorrectedAppSummariesForRange(db, dayFromMs, dayToMs, live)
    const category = command.kind === 'edit' ? command.category : undefined
    return {
      description,
      totalSecondsBefore: Math.round(resolved.payload.totalSeconds),
      totalSecondsAfter: Math.round(after.totalSeconds),
      blockCountBefore: resolved.payload.blocks.length,
      blockCountAfter: after.blocks.length,
      blocks: blockDeltas(resolved.blocks, after),
      apps: appDeltas(appsBefore, appsAfter),
      surfaces: surfaceNotes(db, command, resolved.blocks, category),
    }
  } finally {
    db.exec('ROLLBACK TO correction_preview')
    db.exec('RELEASE correction_preview')
  }
}

export function applyCorrection(
  db: Database.Database,
  command: CorrectionCommand,
  live: LiveSession | null,
): CorrectionApplyResult {
  const resolved = resolveCommand(db, command, live)
  const description = describeCommand(db, command, resolved.blocks)
  const snapshot = captureSnapshot(db, command, resolved)
  const correctionId = `corr_${randomUUID().replace(/-/g, '').slice(0, 18)}`
  const commit = db.transaction(() => {
    applyCommandToLedger(db, command, resolved)
    db.prepare(`
      INSERT INTO correction_undo_log (id, date, kind, description, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(correctionId, command.date, command.kind, description, JSON.stringify(snapshot), Date.now())
  })
  commit()
  // Corrections must reach exact search immediately (DEV-178): re-project the
  // day's memory records from the corrected facts the command just changed.
  refreshMemoryIndexForDay(db, command.date)
  return { correctionId, description }
}

interface UndoRow {
  id: string
  date: string
  kind: string
  description: string
  snapshot_json: string
  created_at: number
  undone_at: number | null
}

export function undoCorrection(db: Database.Database, correctionId: string): CorrectionUndoResult {
  const row = db.prepare(`SELECT * FROM correction_undo_log WHERE id = ?`).get(correctionId) as UndoRow | undefined
  if (!row) throw new Error('Nothing to undo.')
  if (row.undone_at != null) return { undone: false, description: row.description }
  const newer = db.prepare(`
    SELECT id FROM correction_undo_log
    WHERE date = ? AND undone_at IS NULL AND created_at > ? AND id != ?
    LIMIT 1
  `).get(row.date, row.created_at, row.id) as { id: string } | undefined
  if (newer) throw new Error('A newer correction exists for this day — undo that one first.')

  const snapshot = JSON.parse(row.snapshot_json) as unknown
  // Entity corrections (DEV-177) live in the same ledger; their snapshots
  // restore entity tables instead of the timeline correction overlay.
  if (isEntityCorrectionSnapshot(snapshot)) {
    const commit = db.transaction(() => {
      restoreEntityCorrectionSnapshot(db, snapshot)
      db.prepare(`UPDATE correction_undo_log SET undone_at = ? WHERE id = ?`).run(Date.now(), row.id)
    })
    commit()
    return { undone: true, description: row.description }
  }
  const commit = db.transaction(() => {
    restoreSnapshot(db, row.date, snapshot as LedgerSnapshot)
    db.prepare(`UPDATE correction_undo_log SET undone_at = ? WHERE id = ?`).run(Date.now(), row.id)
    invalidateTimelineDayBlocks(db, row.date)
  })
  commit()
  // Undo restores what the correction removed — including in exact search.
  refreshMemoryIndexForDay(db, row.date)
  return { undone: true, description: row.description }
}
