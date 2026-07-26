// One query boundary for corrected activity facts (capture migration slices 6–8).
// Live and historical reads share the same projection + correction path.
// Timeline day reads (renderer projection and direct payload) consume this
// boundary; remaining consumers move in their own slices.

import type Database from 'better-sqlite3'
import type { AppCategory, AppSession } from '@shared/types'
import { isSystemNoiseApp } from '@shared/systemNoise'
import { ownedDayBounds } from '../../lib/dayOwnership'
import { localDateString } from '../../lib/localDate'
import { isAppFocused } from '../../lib/focusScore'
import { resolveCanonicalApp } from '../../lib/appIdentity'
import { getSettings } from '../../services/settings'
import { applyTimelineCorrectionsToSessions } from '../../services/activityFacts'
import {
  countFocusEventsInRange,
  firstFocusEventTsMs,
  listFocusEventsInRange,
  type StoredFocusEvent,
} from '../../db/focusEventRepository'
import {
  PROJECTION_VERSION,
  projectSessionsFromFocusEvents,
  type DerivedSessionRow,
} from '../projections/chunk2'
import {
  legacyAppSessionsAsAppSessions,
  listLegacyAppSessionInputs,
} from '../evidence/legacyAdapter'
import {
  computeRangeEvidenceSignature,
  getCachedRangeFacts,
  rangeFactsCacheKeyForDb,
  storeCachedRangeFacts,
} from './rangeFactsCache'

export const ACTIVITY_FACTS_QUERY_VERSION = 3

// Synthetic ids for canonically projected sessions. They must stay negative
// (no app_sessions row backs them) but clear of the live-session sentinel
// (id -1) that marks the in-memory tracker session in block building.
export const CANONICAL_SESSION_ID_BASE = -1000
export const LIVE_SESSION_SENTINEL_ID = -1

const APP_CATEGORIES: ReadonlySet<string> = new Set([
  'development',
  'communication',
  'research',
  'writing',
  'aiTools',
  'design',
  'browsing',
  'meetings',
  'entertainment',
  'email',
  'productivity',
  'social',
  'system',
  'uncategorized',
])

export type ActivityGapKind =
  | 'idle'
  | 'locked'
  | 'asleep'
  | 'paused'
  | 'capture_unavailable'
  | 'unknown'

export interface ActivityGapFact {
  startMs: number
  endMs: number
  kind: ActivityGapKind
}

export interface CorrectedActivityDayFacts {
  date: string
  projectionVersion: number
  queryVersion: number
  evidenceSource: 'canonical' | 'legacy' | 'mixed'
  sessions: AppSession[]
  totalSeconds: number
  focusSeconds: number
  gaps: ActivityGapFact[]
  focusEventCount: number
  legacySessionCount: number
}

export interface QueryCorrectedActivityFactsOptions {
  /** Wall-clock override for “today” / live clipping. */
  nowMs?: number
  /**
   * Exclusive end of the evidence window inside the day.
   * Historical complete-day reads pass the day end; live reads pass “now”.
   * Same evidence + same asOfMs ⇒ identical facts.
   */
  asOfMs?: number
}

export interface CorrectedActivityRangeFacts {
  projectionVersion: number
  queryVersion: number
  evidenceSource: 'canonical' | 'legacy' | 'mixed'
  sessions: AppSession[]
  totalSeconds: number
  focusSeconds: number
  gaps: ActivityGapFact[]
  focusEventCount: number
  legacySessionCount: number
}

export interface QueryCorrectedActivityFactsForRangeOptions {
  /**
   * Wall-clock “now”. The canonical projection never extends an open session
   * past it — a live read’s trailing session ends at now, not at the range
   * end that midnight would otherwise supply.
   */
  nowMs?: number
  /**
   * Mark the trailing still-open canonical session with the live sentinel id
   * so block building recognizes the in-progress session. Only live-day
   * callers set this; historical reads leave every session non-live.
   */
  markTrailingOpenSessionLive?: boolean
}

function toAppCategory(category: string | null | undefined): AppCategory {
  return category && APP_CATEGORIES.has(category) ? (category as AppCategory) : 'uncategorized'
}

function derivedRowToAppSession(
  row: DerivedSessionRow,
  id: number,
  focusApps: string[] | undefined,
): AppSession {
  const bundleId = row.app_bundle_id ?? row.app_name ?? 'unknown'
  const appName = row.app_name ?? row.app_bundle_id ?? 'Unknown app'
  const category = toAppCategory(row.category)
  const identity = resolveCanonicalApp(bundleId, appName)
  return {
    id,
    bundleId,
    appName: identity.displayName || appName,
    startTime: row.start_ts_ms,
    endTime: row.end_ts_ms,
    durationSeconds: row.active_seconds,
    category,
    isFocused: isAppFocused(category, bundleId, identity.displayName || appName, focusApps),
    windowTitle: row.window_title,
    rawAppName: appName,
    canonicalAppId: identity.canonicalAppId ?? bundleId,
    appInstanceId: bundleId,
    captureSource: 'focus_events',
    endedReason: null,
    captureVersion: PROJECTION_VERSION,
  }
}

function projectGapsFromFocusEvents(
  events: readonly StoredFocusEvent[],
  rangeEndMs: number,
): ActivityGapFact[] {
  const gaps: ActivityGapFact[] = []
  let open: { startMs: number; kind: ActivityGapKind } | null = null

  const close = (endMs: number) => {
    if (!open) return
    if (endMs > open.startMs) gaps.push({ startMs: open.startMs, endMs, kind: open.kind })
    open = null
  }

  for (const event of events) {
    switch (event.event_type) {
      case 'idle_started':
        close(event.ts_ms)
        open = { startMs: event.ts_ms, kind: 'idle' }
        break
      case 'idle_ended':
        if (open?.kind === 'idle') close(event.ts_ms)
        else open = null
        break
      case 'lock':
        close(event.ts_ms)
        open = { startMs: event.ts_ms, kind: 'locked' }
        break
      case 'unlock':
        if (open?.kind === 'locked') close(event.ts_ms)
        else open = null
        break
      case 'sleep':
        close(event.ts_ms)
        open = { startMs: event.ts_ms, kind: 'asleep' }
        break
      case 'wake':
        if (open?.kind === 'asleep') close(event.ts_ms)
        else open = null
        break
      case 'capture_paused':
        close(event.ts_ms)
        open = { startMs: event.ts_ms, kind: 'paused' }
        break
      case 'capture_resumed':
        if (open?.kind === 'paused') close(event.ts_ms)
        else open = null
        break
      case 'capture_failed':
        close(event.ts_ms)
        open = { startMs: event.ts_ms, kind: 'capture_unavailable' }
        break
      case 'capture_recovered':
        if (open?.kind === 'capture_unavailable') close(event.ts_ms)
        else open = null
        break
      case 'capture_stopped':
        // Nothing is observed between a clean stop and the next start; the
        // stretch is honestly "capture unavailable", not activity.
        close(event.ts_ms)
        open = { startMs: event.ts_ms, kind: 'capture_unavailable' }
        break
      case 'capture_started':
        // Close whatever observational state was open — after a crash there
        // is no capture_stopped, and a machine-state gap (idle, locked) may
        // still be dangling from the dead run. The first poll after start
        // re-opens an idle gap backdated by the true no-input time, so a
        // still-away user is covered without double counting.
        close(event.ts_ms)
        break
      default:
        break
    }
  }
  close(rangeEndMs)
  return gaps
}

/** Legacy sessions clipped to the stretch before the canonical capture era
 *  began (the first focus event ever recorded). A session that straddles the
 *  cutover keeps only its pre-cutover part — from the cutover on, canonical
 *  evidence owns the time and the legacy row is a dual-write duplicate. */
function legacySessionsBeforeCanonicalEra(
  db: Database.Database,
  legacySessions: readonly AppSession[],
): AppSession[] {
  const eraStartMs = firstFocusEventTsMs(db)
  if (eraStartMs == null) return []
  return legacySessions.flatMap((session) => {
    if (session.startTime >= eraStartMs) return []
    const capturedEndMs = session.startTime + Math.max(0, session.durationSeconds) * 1000
    const storedEndMs = session.endTime != null && session.endTime > session.startTime
      ? session.endTime
      : capturedEndMs
    if (storedEndMs <= eraStartMs && capturedEndMs <= eraStartMs) return [session]
    const clippedEndMs = Math.min(storedEndMs, eraStartMs)
    return [{
      ...session,
      endTime: clippedEndMs,
      durationSeconds: Math.min(
        Math.max(0, session.durationSeconds),
        Math.round((eraStartMs - session.startTime) / 1000),
      ),
    }]
  })
}

function totalsFromSessions(sessions: readonly AppSession[]): {
  totalSeconds: number
  focusSeconds: number
} {
  const totalSeconds = sessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  const rawFocus = sessions
    .filter((session) => session.isFocused)
    .reduce((sum, session) => sum + session.durationSeconds, 0)
  // Focused duration never exceeds tracked duration for the same scope.
  return { totalSeconds, focusSeconds: Math.min(rawFocus, totalSeconds) }
}

/**
 * Shared corrected activity-fact query for an arbitrary window. The Timeline
 * payload calls this with its own day-ownership bounds; the day query wraps
 * it with owned-day bounds and asOf clipping. Deterministic: same evidence +
 * same corrections + same versions + same window ⇒ same facts.
 */
export function queryCorrectedActivityFactsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  options: QueryCorrectedActivityFactsForRangeOptions = {},
): CorrectedActivityRangeFacts {
  const nowMs = options.nowMs ?? Date.now()

  // DEV-227: wall-clock range reads (no explicit nowMs) are memoized behind a
  // cheap evidence signature — at 30 days the full scan costs ~1s of blocking
  // main-thread work and the Apps view runs it several times in a row.
  // Callers that pin nowMs (day queries, tests) want deterministic clipping
  // and bypass the cache entirely.
  const cacheable = options.nowMs === undefined
  let cacheKey: string | null = null
  let signature: string | null = null
  if (cacheable) {
    cacheKey = rangeFactsCacheKeyForDb(db, `${fromMs}:${toMs}:${options.markTrailingOpenSessionLive ? 1 : 0}`)
    signature = computeRangeEvidenceSignature(
      db,
      fromMs,
      toMs,
      `${PROJECTION_VERSION}.${ACTIVITY_FACTS_QUERY_VERSION}`,
      getSettings().focusApps ?? [],
    )
    const cached = getCachedRangeFacts<CorrectedActivityRangeFacts>(cacheKey, signature, nowMs)
    if (cached) {
      // Shallow-copy the arrays so a caller sorting or splicing its result
      // cannot reorder the cached facts for the next caller.
      return { ...cached, sessions: [...cached.sessions], gaps: [...cached.gaps] }
    }
  }
  // Evidence is read across the whole window, but an open canonical session
  // is never closed past “now”: the live day’s window runs to midnight and
  // the hours that have not happened yet are not activity.
  const projectionEndMs = Math.max(fromMs, Math.min(toMs, nowMs))
  const focusApps = getSettings().focusApps

  const focusEventCount = countFocusEventsInRange(db, fromMs, toMs)
  const events = listFocusEventsInRange(db, fromMs, toMs)
  const projected = projectSessionsFromFocusEvents(events, projectionEndMs)
  const visibleRows = projected
    .filter((row) => !isSystemNoiseApp({ bundleId: row.app_bundle_id, appName: row.app_name }))
  const canonicalSessions = visibleRows
    .map((row, index) => derivedRowToAppSession(row, CANONICAL_SESSION_ID_BASE - index, focusApps))

  const legacyInputs = listLegacyAppSessionInputs(db, fromMs, toMs)
  const legacySessions = legacyAppSessionsAsAppSessions(legacyInputs)
    .map((session) => {
      const focused = isAppFocused(session.category, session.bundleId, session.appName, focusApps)
      return focused === session.isFocused ? session : { ...session, isFocused: focused }
    })
  const legacySessionCount = legacySessions.length

  let evidenceSource: CorrectedActivityRangeFacts['evidenceSource']
  let rawSessions: AppSession[]
  if (canonicalSessions.length > 0 && legacySessionCount > 0) {
    // Mixed evidence: the window straddles the canonical capture cutover (or
    // the dual-write era). Canonical focus_events own everything from the
    // cutover moment on; legacy rows in that region are dual-write duplicates
    // and are dropped. But legacy sessions from BEFORE the cutover are the
    // ONLY record of that time — discarding them erased whole working days on
    // the cutover boundary (a full 08:42–21:16 day of app_sessions vanished
    // because canonical capture began at 21:16 that evening).
    evidenceSource = 'mixed'
    rawSessions = [
      ...legacySessionsBeforeCanonicalEra(db, legacySessions),
      ...canonicalSessions,
    ]
  } else if (canonicalSessions.length > 0) {
    evidenceSource = 'canonical'
    rawSessions = canonicalSessions
  } else {
    evidenceSource = 'legacy'
    rawSessions = legacySessions
  }

  const sessions = applyTimelineCorrectionsToSessions(db, rawSessions, fromMs, toMs)
  // The live sentinel is stamped after the correction overlay: a correction
  // that splits the trailing open session would otherwise leave the sentinel
  // on every cloned piece and surface several “live” blocks. Only the final
  // piece — the one still reaching the projection edge — is the in-progress
  // session. The 1s tolerance absorbs the overlay's second-rounding of piece
  // ends; a correction that deletes the live tail pulls the last end well
  // before the edge, so a deleted stretch never resurrects as live.
  if (options.markTrailingOpenSessionLive && evidenceSource !== 'legacy' && sessions.length > 0) {
    const last = sessions[sessions.length - 1]
    if (last.endTime !== null && last.endTime >= projectionEndMs - 1_000) {
      sessions[sessions.length - 1] = { ...last, id: LIVE_SESSION_SENTINEL_ID }
    }
  }
  const { totalSeconds, focusSeconds } = totalsFromSessions(sessions)
  const gaps = projectGapsFromFocusEvents(events, projectionEndMs)

  const facts: CorrectedActivityRangeFacts = {
    projectionVersion: PROJECTION_VERSION,
    queryVersion: ACTIVITY_FACTS_QUERY_VERSION,
    evidenceSource,
    sessions,
    totalSeconds,
    focusSeconds,
    gaps,
    focusEventCount,
    legacySessionCount,
  }

  if (cacheable && cacheKey && signature) {
    storeCachedRangeFacts(cacheKey, signature, nowMs, toMs > nowMs, facts)
    return { ...facts, sessions: [...facts.sessions], gaps: [...facts.gaps] }
  }
  return facts
}

/**
 * Shared corrected activity-fact query for one local day.
 * Deterministic: same evidence + same corrections + same projection/query
 * versions + same asOfMs ⇒ same facts, whether the caller is live or rebuilt.
 */
export function queryCorrectedActivityFactsForDay(
  db: Database.Database,
  date: string,
  options: QueryCorrectedActivityFactsOptions = {},
): CorrectedActivityDayFacts {
  const nowMs = options.nowMs ?? Date.now()
  const [fromMs, dayEndMs] = ownedDayBounds(db, date)
  const asOfMs = Math.min(dayEndMs, Math.max(fromMs, options.asOfMs ?? nowMs))
  const facts = queryCorrectedActivityFactsForRange(db, fromMs, asOfMs, { nowMs: asOfMs })
  return { date, ...facts }
}

/** Convenience: facts for “today” clipped to now, using the shared query. */
export function queryCorrectedActivityFactsForToday(
  db: Database.Database,
  options: Omit<QueryCorrectedActivityFactsOptions, 'asOfMs'> = {},
): CorrectedActivityDayFacts {
  const nowMs = options.nowMs ?? Date.now()
  return queryCorrectedActivityFactsForDay(db, localDateString(new Date(nowMs)), {
    ...options,
    nowMs,
    asOfMs: nowMs,
  })
}
