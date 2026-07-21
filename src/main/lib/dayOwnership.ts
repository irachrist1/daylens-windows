import type Database from 'better-sqlite3'
import { localDayBounds, shiftLocalDateString } from './localDate'

// One sitting = one day: a break under 45 minutes stays inside the same
// continuous late-night sitting; 45+ minutes seals it. Note (timeline-v9,
// Jul 2026): blocks now split at 15-minute activity gaps, but ownership
// deliberately keeps the wider 45-minute sitting so a short midnight pause
// doesn't flip late-night work onto the next day. The invariant only needs
// this threshold to be >= the block-split threshold — any chain of sub-15-min
// gaps is also a chain of sub-45-min gaps, so a block can never straddle the
// ownership boundary between two days.
const SITTING_BREAK_MS = 45 * 60_000
const MAX_LATE_NIGHT_CARRY_MS = 12 * 60 * 60_000
const BREAK_EVENT_TYPES = ['away_start', 'lock_screen', 'suspend'] as const
const SYSTEM_NOISE_NAMES = new Set([
  'finder',
  'loginwindow',
  'notification center',
  'siri',
  'usernotificationcenter',
])

interface SessionSpan {
  app_name: string
  start_time: number
  end_time: number
}

export interface OwnedDayBoundsOptions {
  // Start of the tracker's in-memory (unflushed) session, when the caller has
  // it. Used to recognise that a sitting is still running even when the last
  // persisted flush is old (a long single-app session flushes only on switch).
  liveSessionStartMs?: number | null
  // Injectable clock for tests.
  nowMs?: number
}

function containsBreakEvent(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): boolean {
  if (toMs <= fromMs) return false
  try {
    const placeholders = BREAK_EVENT_TYPES.map(() => '?').join(', ')
    const row = db.prepare(`
      SELECT 1
      FROM activity_state_events
      WHERE event_type IN (${placeholders})
        AND event_ts >= ?
        AND event_ts < ?
      LIMIT 1
    `).get(...BREAK_EVENT_TYPES, fromMs, toMs)
    return Boolean(row)
  } catch {
    return false
  }
}

// The furthest point past `dateStr`'s midnight that its persisted timeline
// blocks actually claim. Once a day is materialized, this is the authoritative
// record of where it ends — the boundary between two days must never move
// again after one of them is written, or time silently re-attributes on every
// read. Null when the day has no persisted blocks (or the table doesn't exist
// yet, e.g. a fresh install).
function persistedClaimEnd(db: Database.Database, dateStr: string): number | null {
  try {
    const row = db.prepare(`
      SELECT MAX(end_time) AS maxEnd
      FROM timeline_blocks
      WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
    `).get(dateStr) as { maxEnd: number | null } | undefined
    return row?.maxEnd ?? null
  } catch {
    return null
  }
}

// Foreground spans reconstructed from canonical focus_events for the carry
// scan. Legacy app_sessions writes are retired (capture migration slice 10),
// so a cross-midnight sitting exists only as an unclosed canonical span; the
// sitting detector needs those spans or late-night ownership breaks for every
// canonically captured day. A simple open/close automaton is enough here —
// carry detection only needs "activity chained across the boundary", not the
// full projection's session semantics.
function canonicalSpans(db: Database.Database, scanFrom: number, scanTo: number, nowMs: number): SessionSpan[] {
  let rows: Array<{ ts_ms: number; event_type: string; app_name: string | null }>
  try {
    rows = db.prepare(`
      SELECT ts_ms, event_type, app_name
      FROM focus_events
      WHERE ts_ms >= ? AND ts_ms < ?
        AND event_type IN ('app_activated', 'app_deactivated', 'sleep', 'lock', 'idle_started')
      ORDER BY ts_ms ASC, id ASC
    `).all(scanFrom, scanTo) as Array<{ ts_ms: number; event_type: string; app_name: string | null }>
  } catch {
    return []
  }

  const spans: SessionSpan[] = []
  let open: { app_name: string; start_time: number } | null = null
  const close = (endMs: number) => {
    if (open && endMs > open.start_time) {
      spans.push({ app_name: open.app_name, start_time: open.start_time, end_time: endMs })
    }
    open = null
  }
  for (const row of rows) {
    if (row.event_type === 'app_activated') {
      close(row.ts_ms)
      if (row.app_name) open = { app_name: row.app_name, start_time: row.ts_ms }
    } else {
      close(row.ts_ms)
    }
  }
  // A span still open at the scan edge is a running sitting: credit it up to
  // now (never the future edge) so the seed/continuation checks can see it.
  close(Math.min(scanTo, Math.max(scanFrom, nowMs)))
  return spans
}

function lateNightCarryEnd(
  db: Database.Database,
  boundaryMs: number,
  nowMs: number,
  liveSessionStartMs: number | null,
): number {
  const scanFrom = boundaryMs - MAX_LATE_NIGHT_CARRY_MS
  const scanTo = boundaryMs + MAX_LATE_NIGHT_CARRY_MS
  const rows = db.prepare(`
    SELECT
      app_name,
      start_time,
      COALESCE(end_time, start_time + duration_sec * 1000) AS end_time
    FROM app_sessions
    WHERE start_time < ?
      AND COALESCE(end_time, start_time + duration_sec * 1000) > ?
    ORDER BY start_time ASC, id ASC
  `).all(scanTo, scanFrom) as SessionSpan[]
  const merged = [...rows, ...canonicalSpans(db, scanFrom, scanTo, nowMs)]
    .sort((left, right) => left.start_time - right.start_time || left.end_time - right.end_time)
  const sessions = merged.filter((row) => !SYSTEM_NOISE_NAMES.has(row.app_name.trim().toLowerCase()))

  const seed = [...sessions]
    .reverse()
    .find((session) =>
      session.start_time < boundaryMs
      && session.end_time > boundaryMs - SITTING_BREAK_MS)
  if (!seed) return boundaryMs

  let carryEnd = Math.max(boundaryMs, seed.end_time)
  let previousEnd = seed.end_time
  for (const session of sessions) {
    if (session.start_time < boundaryMs) continue
    const gap = session.start_time - previousEnd
    if (gap >= SITTING_BREAK_MS) break
    if (containsBreakEvent(db, previousEnd, session.start_time)) break
    carryEnd = Math.max(carryEnd, session.end_time)
    previousEnd = Math.max(previousEnd, session.end_time)
  }
  carryEnd = Math.min(carryEnd, scanTo)

  // An open sitting is never carried backward. Ownership of a cross-midnight
  // sitting is decided once the sitting has actually ended (a 45+ minute
  // break); while it is still running, the carry boundary would advance with
  // every session flush — "today" would never begin, its payload would hold
  // only the in-memory live session, and the tracked counter would reset to
  // seconds on every app switch.
  const sittingEndsAt = liveSessionStartMs != null && liveSessionStartMs - carryEnd < SITTING_BREAK_MS
    ? nowMs // the live session continues the chain — the sitting is still running
    : carryEnd
  if (nowMs - sittingEndsAt < SITTING_BREAK_MS) return boundaryMs

  return carryEnd
}

export function ownedDayBounds(
  db: Database.Database,
  dateStr: string,
  options: OwnedDayBoundsOptions = {},
): [number, number] {
  const nowMs = options.nowMs ?? Date.now()
  const liveStart = options.liveSessionStartMs ?? null
  const [calendarStart, calendarEnd] = localDayBounds(dateStr)

  // The previous day's persisted blocks pin the start boundary; this day's own
  // persisted blocks pin the end boundary. Only when no persisted claim exists
  // is the boundary derived from session continuity (the late-night carry).
  const previousClaim = persistedClaimEnd(db, shiftLocalDateString(dateStr, -1))
  const inheritedUntil = previousClaim != null
    ? Math.min(Math.max(calendarStart, previousClaim), calendarStart + MAX_LATE_NIGHT_CARRY_MS)
    : lateNightCarryEnd(db, calendarStart, nowMs, liveStart)

  const ownClaim = persistedClaimEnd(db, dateStr)
  const carriesUntil = ownClaim != null
    ? Math.min(Math.max(calendarEnd, ownClaim), calendarEnd + MAX_LATE_NIGHT_CARRY_MS)
    : lateNightCarryEnd(db, calendarEnd, nowMs, liveStart)

  return [
    Math.max(calendarStart, inheritedUntil),
    Math.max(calendarEnd, carriesUntil),
  ]
}
