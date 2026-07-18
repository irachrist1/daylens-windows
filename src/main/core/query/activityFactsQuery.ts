// One query boundary for corrected activity facts (capture migration slices 6–7).
// Live and historical reads share the same projection + correction path.
// Consumers are not moved onto this boundary here — that is separate work.

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

export const ACTIVITY_FACTS_QUERY_VERSION = 1

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

function toAppCategory(category: string | null | undefined): AppCategory {
  return category && APP_CATEGORIES.has(category) ? (category as AppCategory) : 'uncategorized'
}

function derivedRowToAppSession(
  row: DerivedSessionRow,
  index: number,
  focusApps: string[] | undefined,
): AppSession {
  const bundleId = row.app_bundle_id ?? row.app_name ?? 'unknown'
  const appName = row.app_name ?? row.app_bundle_id ?? 'Unknown app'
  const category = toAppCategory(row.category)
  const identity = resolveCanonicalApp(bundleId, appName)
  return {
    id: -(index + 1),
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
      default:
        break
    }
  }
  close(rangeEndMs)
  return gaps
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
  const focusApps = getSettings().focusApps

  const focusEventCount = countFocusEventsInRange(db, fromMs, asOfMs)
  const events = listFocusEventsInRange(db, fromMs, asOfMs)
  const projected = projectSessionsFromFocusEvents(events, asOfMs)
  const canonicalSessions = projected
    .filter((row) => !isSystemNoiseApp({ bundleId: row.app_bundle_id, appName: row.app_name }))
    .map((row, index) => derivedRowToAppSession(row, index, focusApps))

  const legacyInputs = listLegacyAppSessionInputs(db, fromMs, asOfMs)
  const legacySessions = legacyAppSessionsAsAppSessions(legacyInputs)
  const legacySessionCount = legacySessions.length

  let evidenceSource: CorrectedActivityDayFacts['evidenceSource']
  let rawSessions: AppSession[]
  if (canonicalSessions.length > 0 && legacySessionCount > 0) {
    evidenceSource = 'mixed'
    rawSessions = canonicalSessions
  } else if (canonicalSessions.length > 0) {
    evidenceSource = 'canonical'
    rawSessions = canonicalSessions
  } else {
    evidenceSource = 'legacy'
    rawSessions = legacySessions
  }

  const sessions = applyTimelineCorrectionsToSessions(db, rawSessions, fromMs, asOfMs)
  const { totalSeconds, focusSeconds } = totalsFromSessions(sessions)
  const gaps = projectGapsFromFocusEvents(events, asOfMs)

  return {
    date,
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
