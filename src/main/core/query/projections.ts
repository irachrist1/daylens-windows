import type Database from 'better-sqlite3'
import type {
  AppDetailPayload,
  ArtifactRef,
  DayTimelinePayload,
  HistoryDayPayload,
  LiveSession,
  WeeklySummary,
  WorkflowPattern,
} from '@shared/types'
import { getArtifactDetails, getHistoryDayPayload, getTimelineDayPayload, getWorkflowSummaries } from '../../services/workBlocks'
import { getAppDetailPayload } from '../../services/appDetail'
import { getWeeklySummary } from '../../db/queries'

// The renderer projection and the direct Timeline payload are the same read:
// getTimelineDayPayload sources its sessions from the shared corrected
// activity-fact query, so live and historical days — canonical or legacy —
// cannot diverge between the two consumers.

export function getTimelineDayProjection(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
  options: { materialize?: boolean; forceRebuild?: boolean; analysis?: boolean } = {},
): DayTimelinePayload {
  return getTimelineDayPayload(db, dateStr, liveSession, options)
}

export function getHistoryDayProjection(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
  options: { materialize?: boolean; forceRebuild?: boolean; analysis?: boolean } = {},
): HistoryDayPayload {
  return getHistoryDayPayload(db, dateStr, liveSession, options)
}

// The one entry every Analyze / re-analyze / correction / day-rollover read
// comes through. Materializing a day IS analyzing it: the day is divided into
// fine, labeled blocks and sealed. A passive renderer read never comes here (it
// calls getTimelineDayProjection with materialize:false), so an un-analyzed day
// stays coarse and neutral there (DEV-268).
export function materializeTimelineDayProjection(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
  options: { forceRebuild?: boolean } = {},
): DayTimelinePayload {
  return getTimelineDayProjection(db, dateStr, liveSession, { materialize: true, forceRebuild: options.forceRebuild, analysis: true })
}

export function getWeeklySummaryProjection(
  db: Database.Database,
  endDateStr: string,
): WeeklySummary {
  return getWeeklySummary(db, endDateStr)
}

export function getAppDetailProjection(
  db: Database.Database,
  canonicalAppId: string,
  days: number | string = 7,
  liveSession?: LiveSession | null,
): AppDetailPayload {
  return getAppDetailPayload(db, canonicalAppId, days as any, liveSession)
}

export function getWorkflowPatternsProjection(
  db: Database.Database,
  days = 14,
): WorkflowPattern[] {
  return getWorkflowSummaries(db, days)
}

export function getArtifactDetailProjection(
  db: Database.Database,
  artifactId: string,
): ArtifactRef | null {
  return getArtifactDetails(db, artifactId)
}
