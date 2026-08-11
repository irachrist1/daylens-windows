// Capability bodies that are not an executor dispatch: they call the same shared
// reader the in-app chat tool calls, then apply the same two exit boundaries the
// executors apply (tracking-exclusion filter, then secret sanitizer).
//
// Nothing here computes a Daylens fact. `getMomentEvidence` and
// `getCorrectedPageFactsForRange` already own the corrected numbers, so both
// paths read one aggregate instead of each summing evidence its own way.
import type Database from 'better-sqlite3'
import { sanitizeToolResult } from '@shared/aiSanitize'
import { filterTrackingExcludedEvidence } from '@shared/evidencePrivacy'
import type { TrackingControlsState } from '@shared/trackingControls'
import { execSearchSessionsWithMeaning } from '../../../src/main/services/aiTools'
import {
  browserPageCoverageNotes,
  getCorrectedPageFactsForRange,
} from '../../../src/main/services/activityFacts'
import { getMomentEvidence } from '../../../src/main/lib/momentEvidence'

const DAY_MS = 24 * 60 * 60 * 1000
// The page ledger is read per range, so an unbounded range would scan the whole
// history for one tool call. Same cap the chat tool applies.
const MAX_VISIT_RANGE_DAYS = 62
const DEFAULT_VISIT_LIMIT = 500

export type ComposedCapabilityId = 'searchSessions' | 'getMoment' | 'listPageVisits'

export function isComposedCapabilityId(id: string): id is ComposedCapabilityId {
  return id === 'searchSessions' || id === 'getMoment' || id === 'listPageVisits'
}

function dayStartMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime()
}

interface PageVisitParams {
  startDate?: unknown
  endDate?: unknown
  domainContains?: unknown
  titleContains?: unknown
  limit?: unknown
}

function listPageVisits(db: Database.Database, params: PageVisitParams): unknown {
  const startDate = typeof params.startDate === 'string' ? params.startDate : ''
  const endDate = typeof params.endDate === 'string' ? params.endDate : ''
  const fromMs = dayStartMs(startDate)
  const toMs = dayStartMs(endDate) + DAY_MS - 1
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return { found: false, reason: 'Bad date range.' }
  }
  if ((toMs - fromMs) / DAY_MS > MAX_VISIT_RANGE_DAYS) {
    return { found: false, reason: `Range too wide — ask for at most ${MAX_VISIT_RANGE_DAYS} days at a time.` }
  }

  const facts = getCorrectedPageFactsForRange(db, fromMs, toMs)
  const coverageNotes = browserPageCoverageNotes(facts.coverage)
  const domainContains = typeof params.domainContains === 'string' ? params.domainContains : null
  const titleContains = typeof params.titleContains === 'string' ? params.titleContains : null
  const domainNeedle = domainContains?.toLowerCase() ?? null
  const titleNeedle = titleContains?.toLowerCase() ?? null
  const matching = facts.pages
    .filter((page) => !domainNeedle || page.domain.toLowerCase().includes(domainNeedle))
    .filter((page) => !titleNeedle || (page.pageTitle ?? '').toLowerCase().includes(titleNeedle))
    .map((page) => ({
      pageTitle: page.pageTitle,
      domain: page.domain,
      url: page.url,
      totalSeconds: page.totalSeconds,
      visitCount: page.visitCount,
      firstSeen: page.firstSeen,
      lastSeen: page.lastSeen,
    }))
  const limit = typeof params.limit === 'number' && Number.isInteger(params.limit) && params.limit > 0
    ? params.limit
    : DEFAULT_VISIT_LIMIT
  const pages = matching.slice(0, limit)
  if (pages.length === 0) {
    return {
      found: false,
      reason: `No captured visits match${domainNeedle ? ` domain~"${domainContains}"` : ''}`
        + `${titleNeedle ? ` title~"${titleContains}"` : ''} between ${startDate} and ${endDate}.`,
      ...(coverageNotes.length > 0 ? { coverageNotes } : {}),
    }
  }
  return {
    found: true,
    pageCount: matching.length,
    truncatedTo: pages.length,
    pages,
    ...(coverageNotes.length > 0 ? { coverageNotes } : {}),
  }
}

export async function executeComposedRead(
  id: ComposedCapabilityId,
  params: Record<string, unknown>,
  db: Database.Database,
  controls: TrackingControlsState,
): Promise<unknown> {
  const raw = await (async () => {
    switch (id) {
      case 'searchSessions':
        return execSearchSessionsWithMeaning(
          {
            query: String(params.query ?? ''),
            startDate: typeof params.startDate === 'string' ? params.startDate : undefined,
            endDate: typeof params.endDate === 'string' ? params.endDate : undefined,
            limit: typeof params.limit === 'number' ? params.limit : undefined,
          },
          db,
        )
      case 'getMoment':
        return getMomentEvidence(db, String(params.date ?? ''), String(params.time ?? ''))
      case 'listPageVisits':
        return listPageVisits(db, params)
    }
  })()
  return sanitizeToolResult(filterTrackingExcludedEvidence(raw, controls))
}
