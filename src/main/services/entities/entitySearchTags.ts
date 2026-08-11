// Consumer-visible entity search tags (WO-41 / AC-SM-EA-001.5).
//
// In this codebase the tags are `memory_record_entities` rows — the join
// Search & Memory uses when retrieving moments for an entity. Canonical names
// and aliases live on entities/entity_aliases; refreshing tags means rebuilding
// memory_record_entities for days that already carry this entity so the next
// consumer read sees the current graph identity.
import type Database from 'better-sqlite3'
import { refreshMemoryIndexForDay } from '../memoryIndex'
import { mergeGroupIds, resolveMergeChain, type EntityRow } from './entityRepository'

function localDateFromMs(ms: number): string {
  const d = new Date(ms)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Dates whose memory index already mentions this entity (or its merge group). */
export function listEntityTaggedDates(db: Database.Database, entityId: string): string[] {
  const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(entityId) as EntityRow | undefined
  if (!row) return []
  const survivor = resolveMergeChain(db, row)
  const groupIds = mergeGroupIds(db, survivor.id)
  const marks = groupIds.map(() => '?').join(', ')
  const dates = new Set<string>()

  try {
    const tagged = db.prepare(`
      SELECT DISTINCT m.date AS date
      FROM memory_record_entities t
      JOIN memory_records m ON m.id = t.record_id
      WHERE t.entity_id IN (${marks})
    `).all(...groupIds) as Array<{ date: string }>
    for (const entry of tagged) {
      if (entry.date) dates.add(entry.date)
    }
  } catch {
    // Pre-memory-index databases have no tag table yet.
  }

  // Also refresh days covered by evidence spans so a brand-new entity that
  // just gained support is tagged before a consumer reads that day.
  try {
    const spans = db.prepare(`
      SELECT span_start_ms, span_end_ms FROM entity_evidence_refs
      WHERE entity_id IN (${marks}) AND span_start_ms IS NOT NULL
    `).all(...groupIds) as Array<{ span_start_ms: number; span_end_ms: number | null }>
    for (const span of spans) {
      dates.add(localDateFromMs(span.span_start_ms))
      if (span.span_end_ms != null) dates.add(localDateFromMs(span.span_end_ms))
    }
  } catch { /* ignore */ }

  // Client/project activity days from work sessions (same ids when adopted).
  try {
    const sessions = db.prepare(`
      SELECT DISTINCT started_at FROM work_sessions
      WHERE client_id IN (${marks}) OR project_id IN (${marks})
    `).all(...groupIds, ...groupIds) as Array<{ started_at: number }>
    for (const session of sessions) dates.add(localDateFromMs(session.started_at))
  } catch { /* ignore */ }

  return [...dates].sort()
}

/**
 * Rebuild entity search tags for the given entity before consumers use a
 * graph change (AC-SM-EA-001.5). Refreshes each already-indexed (or evidenced)
 * day through Search & Memory's day index — this lane notifies; it does not
 * own vector invalidation internals.
 */
export function refreshEntitySearchTags(db: Database.Database, entityId: string): string[] {
  const dates = listEntityTaggedDates(db, entityId)
  for (const date of dates) {
    refreshMemoryIndexForDay(db, date)
  }
  // Always touch "today" so a newly created supplied entity is eligible for
  // the same-day index when capture lands later.
  const today = localDateFromMs(Date.now())
  if (!dates.includes(today)) {
    refreshMemoryIndexForDay(db, today)
    dates.push(today)
  }
  return dates
}

export function refreshEntitySearchTagsForMany(db: Database.Database, entityIds: string[]): string[] {
  const dates = new Set<string>()
  for (const entityId of entityIds) {
    for (const date of refreshEntitySearchTags(db, entityId)) dates.add(date)
  }
  return [...dates].sort()
}
