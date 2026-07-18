// Compatibility reads for legacy capture tables during the migration.
// These rows are never rewritten into fake focus_events — they stay
// app_sessions / website_visits and are exposed as typed compatibility inputs.

import type Database from 'better-sqlite3'
import type { AppSession, WebsiteSummary } from '@shared/types'
import {
  getSessionsForRange,
  getWebsiteSummariesForRange,
  getWebsiteVisitsForRange,
  type WebsiteVisitRecord,
} from '../../db/queries'

export interface LegacyAppSessionInput {
  kind: 'legacy_app_session'
  session: AppSession
}

export interface LegacyWebsiteVisitInput {
  kind: 'legacy_website_visit'
  visit: WebsiteVisitRecord
}

export interface LegacyWebsiteSummaryInput {
  kind: 'legacy_website_summary'
  summary: WebsiteSummary
}

export type LegacyCompatibilityInput =
  | LegacyAppSessionInput
  | LegacyWebsiteVisitInput
  | LegacyWebsiteSummaryInput

/** Legacy app_sessions as compatibility inputs for the shared query boundary. */
export function listLegacyAppSessionInputs(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): LegacyAppSessionInput[] {
  return getSessionsForRange(db, fromMs, toMs, { minimumDurationSeconds: 10 }).map((session) => ({
    kind: 'legacy_app_session' as const,
    session: {
      ...session,
      captureSource: session.captureSource ?? 'app_sessions',
    },
  }))
}

export function listLegacyWebsiteVisitInputs(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): LegacyWebsiteVisitInput[] {
  return getWebsiteVisitsForRange(db, fromMs, toMs).map((visit) => ({
    kind: 'legacy_website_visit' as const,
    visit,
  }))
}

export function listLegacyWebsiteSummaryInputs(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): LegacyWebsiteSummaryInput[] {
  return getWebsiteSummariesForRange(db, fromMs, toMs).map((summary) => ({
    kind: 'legacy_website_summary' as const,
    summary,
  }))
}

export function legacyAppSessionsAsAppSessions(
  inputs: readonly LegacyAppSessionInput[],
): AppSession[] {
  return inputs.map((input) => input.session)
}
