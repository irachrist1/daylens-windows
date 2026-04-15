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
import { getArtifactDetails, getAppDetailPayload, getHistoryDayPayload, getTimelineDayPayload, getWorkflowSummaries } from '../../services/workBlocks'
import { getWeeklySummary } from '../../db/queries'

export function getTimelineDayProjection(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
): DayTimelinePayload {
  return getTimelineDayPayload(db, dateStr, liveSession)
}

export function getHistoryDayProjection(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
): HistoryDayPayload {
  return getHistoryDayPayload(db, dateStr, liveSession)
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
  days = 7,
  liveSession?: LiveSession | null,
): AppDetailPayload {
  return getAppDetailPayload(db, canonicalAppId, days, liveSession)
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
