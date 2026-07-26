// The corrected-activity read model (invariant 7: one truth, three views).
//
// Raw capture (app_sessions, website_visits) is append-only ground truth and
// is NEVER mutated by a correction. But the Timeline is the user's curated
// story of the day: when a block is deleted (review state 'ignored'), that
// stretch is gone from the day — and every surface that totals activity must
// agree. Before this seam existed, the Apps view summed raw sessions directly,
// so an ignored June 30 block still owned ~16 minutes of Dia in the Apps
// totals while the Timeline honestly showed nothing.
//
// Every read that feeds a user-facing total — the Apps list, the app detail
// panel, the AI's app/session facts — goes through these functions instead of
// the raw queries. The membership rule is the same one the timeline rebuild
// uses (a session belongs to a deleted span when it STARTED inside it), so
// Timeline, Apps, and AI reconcile exactly.
//
// This module is deliberately a thin seam: when the V3 day model lands and
// block facts become the single store, only this file needs to change — the
// callers already speak "corrected activity".
import type Database from 'better-sqlite3'
import type { AppCategory, AppSession, AppUsageSummary, LiveSession, WebsiteSummary } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import {
  getReconciledDomainIntervals,
  getReconciledWebsiteVisitsForRange,
  getWebsiteSummariesForRange,
  getWebsiteVisitsForRange,
  type CorrectionSpan,
} from '../db/queries'
import { resolveCanonicalApp } from '../lib/appIdentity'
// activityFactsQuery imports the correction overlay back from this module;
// both sides bind hoisted functions at call time only, so the cycle is inert.
import {
  queryCorrectedActivityFactsForRange,
  type CorrectedActivityRangeFacts,
} from '../core/query/activityFactsQuery'

export type { CorrectionSpan }

interface CategoryCorrectionSpan extends CorrectionSpan {
  category: AppCategory
  updatedAt: number
}

const APP_CATEGORIES = new Set<AppCategory>([
  'development', 'communication', 'research', 'writing', 'aiTools', 'design',
  'browsing', 'meetings', 'entertainment', 'email', 'productivity', 'social',
  'system', 'uncategorized',
])

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
  ).get(name) as { name: string } | undefined
  return Boolean(row)
}

function reviewsTableExists(db: Database.Database): boolean {
  return tableExists(db, 'timeline_block_reviews')
}

// ─── Reversible evidence exclusions (timeline spec, Corrections) ─────────────
// "Exclude specific evidence" hides one app or site inside a span from every
// corrected read — Timeline, Apps, search, AI — without touching the raw rows,
// so the correction can be undone. Matching mirrors the permanent purge's
// identity rule (bundle id OR display name; domain for sites).

export interface EvidenceExclusionSpan {
  id: string
  kind: 'app' | 'site'
  bundleId: string | null
  appName: string | null
  domain: string | null
  startMs: number
  endMs: number
}

export function getEvidenceExclusionsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): EvidenceExclusionSpan[] {
  if (!tableExists(db, 'evidence_exclusions')) return []
  const rows = db.prepare(`
    SELECT id, kind, bundle_id, app_name, domain, span_start_ms, span_end_ms
    FROM evidence_exclusions
    WHERE span_start_ms < ? AND span_end_ms > ?
  `).all(toMs, fromMs) as Array<{
    id: string
    kind: 'app' | 'site'
    bundle_id: string | null
    app_name: string | null
    domain: string | null
    span_start_ms: number
    span_end_ms: number
  }>
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    bundleId: row.bundle_id,
    appName: row.app_name,
    domain: row.domain,
    startMs: row.span_start_ms,
    endMs: row.span_end_ms,
  }))
}

function sessionMatchesExclusion(session: AppSession, exclusion: EvidenceExclusionSpan): boolean {
  if (exclusion.kind !== 'app') return false
  return Boolean(
    (exclusion.bundleId && session.bundleId === exclusion.bundleId)
    || (exclusion.appName && session.appName === exclusion.appName),
  )
}

function excludedSpansForSession(
  session: AppSession,
  exclusions: readonly EvidenceExclusionSpan[],
): CorrectionSpan[] {
  return exclusions
    .filter((exclusion) => sessionMatchesExclusion(session, exclusion))
    .map((exclusion) => ({ startMs: exclusion.startMs, endMs: exclusion.endMs }))
}

/** The time spans of every Timeline block the user deleted, clipped to the
 *  ones overlapping [fromMs, toMs). Read from the review ledger — corrections
 *  win and survive every rebuild (invariant 8). */
export function getIgnoredBlockSpansForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): CorrectionSpan[] {
  if (!reviewsTableExists(db)) return []
  const rows = db.prepare(`
    SELECT original_block_json
    FROM timeline_block_reviews
    WHERE review_state = 'ignored'
  `).all() as Array<{ original_block_json: string }>
  const spans: CorrectionSpan[] = []
  for (const row of rows) {
    let original: Record<string, unknown> = {}
    try {
      original = JSON.parse(row.original_block_json || '{}') as Record<string, unknown>
    } catch {
      continue
    }
    const startMs = typeof original.startTime === 'number' ? original.startTime : null
    const endMs = typeof original.endTime === 'number' ? original.endTime : null
    if (startMs == null || endMs == null || endMs <= startMs) continue
    if (endMs <= fromMs || startMs >= toMs) continue
    spans.push({ startMs, endMs })
  }
  return mergeCorrectionSpans(spans)
}

function mergeCorrectionSpans(spans: readonly CorrectionSpan[]): CorrectionSpan[] {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged: CorrectionSpan[] = []
  for (const span of ordered) {
    const last = merged[merged.length - 1]
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs)
    else merged.push({ ...span })
  }
  return merged
}

function getCategoryCorrectionSpansForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): CategoryCorrectionSpan[] {
  if (!reviewsTableExists(db)) return []
  const rows = db.prepare(`
    SELECT original_block_json, correction_json, updated_at
    FROM timeline_block_reviews
    WHERE review_state = 'corrected'
    ORDER BY updated_at ASC
  `).all() as Array<{ original_block_json: string; correction_json: string; updated_at: number }>
  const spans: CategoryCorrectionSpan[] = []
  for (const row of rows) {
    try {
      const original = JSON.parse(row.original_block_json || '{}') as Record<string, unknown>
      const correction = JSON.parse(row.correction_json || '{}') as Record<string, unknown>
      const startMs = typeof original.startTime === 'number' ? original.startTime : null
      const endMs = typeof original.endTime === 'number' ? original.endTime : null
      const category = correction.category
      if (startMs == null || endMs == null || endMs <= startMs || endMs <= fromMs || startMs >= toMs) continue
      if (typeof category !== 'string' || !APP_CATEGORIES.has(category as AppCategory)) continue
      spans.push({ startMs, endMs, category: category as AppCategory, updatedAt: row.updated_at })
    } catch { /* malformed review evidence is ignored, never guessed */ }
  }
  return spans
}

function categoryAt(spans: readonly CategoryCorrectionSpan[], startMs: number, endMs: number): AppCategory | null {
  let winner: CategoryCorrectionSpan | null = null
  for (const span of spans) {
    if (span.startMs >= endMs || span.endMs <= startMs) continue
    if (!winner || span.updatedAt >= winner.updatedAt) winner = span
  }
  return winner?.category ?? null
}

function correctedPiecesForSession(
  session: AppSession,
  fromMs: number,
  toMs: number,
  ignored: readonly CorrectionSpan[],
  categories: readonly CategoryCorrectionSpan[],
): AppSession[] {
  // duration_sec is captured activity; a stale wall-clock end may enclose a
  // much larger inactive stretch. Correct only the interval Daylens actually
  // has credit for, then split at every correction boundary.
  const capturedEnd = session.startTime + Math.max(0, session.durationSeconds) * 1000
  const storedEnd = session.endTime != null && session.endTime > session.startTime ? session.endTime : capturedEnd
  const start = Math.max(fromMs, session.startTime)
  const end = Math.min(toMs, storedEnd, capturedEnd)
  if (end <= start) return []
  const boundaries = new Set<number>([start, end])
  for (const span of [...ignored, ...categories]) {
    if (span.startMs > start && span.startMs < end) boundaries.add(span.startMs)
    if (span.endMs > start && span.endMs < end) boundaries.add(span.endMs)
  }
  const points = [...boundaries].sort((a, b) => a - b)
  const pieces: AppSession[] = []
  for (let index = 0; index < points.length - 1; index++) {
    const pieceStart = points[index]
    const pieceEnd = points[index + 1]
    if (ignored.some((span) => span.startMs < pieceEnd && span.endMs > pieceStart)) continue
    const category = categoryAt(categories, pieceStart, pieceEnd) ?? session.category
    pieces.push({
      ...session,
      startTime: pieceStart,
      endTime: pieceEnd,
      durationSeconds: Math.round((pieceEnd - pieceStart) / 1000),
      category,
      isFocused: FOCUSED_CATEGORIES.includes(category),
    })
  }
  return pieces
}

/** Corrected session facts for a window — the shared activity-fact query
 *  with its evidence source, so callers that still merge the in-memory live
 *  session can do it only in legacy mode (canonical projections already
 *  contain the open live interval). */
export function getCorrectedSessionFactsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): Pick<CorrectedActivityRangeFacts, 'sessions' | 'evidenceSource'> {
  const facts = queryCorrectedActivityFactsForRange(db, fromMs, toMs)
  return { sessions: facts.sessions, evidenceSource: facts.evidenceSource }
}

/** Corrected sessions for a window — canonical focus_events preferred,
 *  legacy app_sessions fallback, corrections applied once. The session facts
 *  every totalling surface reads. */
export function getCorrectedSessionsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): AppSession[] {
  return getCorrectedSessionFactsForRange(db, fromMs, toMs).sessions
}

/** Apply the Timeline review ledger to any session source, including the
 * historical derived-session projection. */
export function applyTimelineCorrectionsToSessions(
  db: Database.Database,
  sessions: readonly AppSession[],
  fromMs: number,
  toMs: number,
): AppSession[] {
  const spans = getIgnoredBlockSpansForRange(db, fromMs, toMs)
  const categorySpans = getCategoryCorrectionSpansForRange(db, fromMs, toMs)
  const exclusions = getEvidenceExclusionsForRange(db, fromMs, toMs)
  if (spans.length === 0 && categorySpans.length === 0 && exclusions.length === 0) return [...sessions]
  return sessions.flatMap((session) => {
    const excluded = excludedSpansForSession(session, exclusions)
    const ignoredForSession = excluded.length > 0 ? mergeCorrectionSpans([...spans, ...excluded]) : spans
    return correctedPiecesForSession(session, fromMs, toMs, ignoredForSession, categorySpans)
  })
}

/** Aggregate corrected sessions into per-app usage summaries. Also feeds the
 *  Timeline-day aggregation, which rolls block-partitioned sessions through
 *  the same rollup. */
export function aggregateAppSummaries(sessions: readonly AppSession[]): AppUsageSummary[] {
  const totals = new Map<string, {
    bundleId: string
    appName: string
    canonicalAppId: string | null
    seconds: number
    categorySeconds: Map<AppCategory, number>
    sessionCount: number
    lastEnd: number | null
  }>()
  // The 2-minute-gap session-count rule is order-dependent; sort a copy so
  // an out-of-order source (live merge, legacy fallback) can't undercount.
  const ordered = [...sessions].sort((a, b) => a.startTime - b.startTime)
  for (const session of ordered) {
    const identity = resolveCanonicalApp(session.bundleId, session.appName)
    const key = session.canonicalAppId ?? identity.canonicalAppId ?? session.bundleId
    const entry = totals.get(key) ?? {
      bundleId: session.bundleId,
      appName: identity.displayName || session.appName,
      canonicalAppId: session.canonicalAppId ?? identity.canonicalAppId ?? null,
      seconds: 0,
      categorySeconds: new Map<AppCategory, number>(),
      sessionCount: 0,
      lastEnd: null,
    }
    entry.seconds += session.durationSeconds
    entry.categorySeconds.set(session.category, (entry.categorySeconds.get(session.category) ?? 0) + session.durationSeconds)
    if (entry.lastEnd == null || session.startTime - entry.lastEnd >= 2 * 60_000) entry.sessionCount += 1
    entry.lastEnd = Math.max(entry.lastEnd ?? session.startTime, session.endTime ?? session.startTime + session.durationSeconds * 1_000)
    totals.set(key, entry)
  }
  return [...totals.entries()].flatMap(([key, entry]) => {
    if (entry.seconds <= 0) return []
    const category: AppCategory = [...entry.categorySeconds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'uncategorized'
    return [{
      bundleId: entry.bundleId,
      canonicalAppId: entry.canonicalAppId ?? key,
      appName: entry.appName,
      category,
      totalSeconds: entry.seconds,
      sessionCount: entry.sessionCount,
      isFocused: FOCUSED_CATEGORIES.includes(category),
    }]
  }).sort((a, b) => b.totalSeconds - a.totalSeconds)
}

/** App usage summaries with deleted Timeline blocks subtracted — what the
 *  Apps list, the Today totals, and the AI's app facts all read. Pass the
 *  in-memory live session so a legacy-fallback range still counts the
 *  in-progress stretch; canonical facts already contain it. */
export function getCorrectedAppSummariesForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  liveSession?: LiveSession | null,
): AppUsageSummary[] {
  const facts = getCorrectedSessionFactsForRange(db, fromMs, toMs)
  const sessions = facts.evidenceSource === 'legacy' && liveSession
    ? withClippedLiveSession(facts.sessions, liveSession, fromMs, toMs)
    : facts.sessions
  return aggregateAppSummaries(sessions)
}

function withClippedLiveSession(
  sessions: readonly AppSession[],
  live: LiveSession,
  fromMs: number,
  toMs: number,
): AppSession[] {
  const start = Math.max(live.startTime, fromMs)
  const end = Math.min(Date.now(), toMs)
  if (end <= start) return [...sessions]
  return [...sessions, {
    id: -1,
    bundleId: live.bundleId,
    appName: live.appName,
    startTime: start,
    endTime: end,
    durationSeconds: Math.max(1, Math.round((end - start) / 1000)),
    category: live.category,
    isFocused: FOCUSED_CATEGORIES.includes(live.category),
    windowTitle: live.windowTitle ?? null,
    rawAppName: live.rawAppName ?? live.appName,
    canonicalAppId: live.canonicalAppId ?? null,
    appInstanceId: live.appInstanceId ?? live.bundleId,
    captureSource: live.captureSource ?? 'foreground_poll',
    endedReason: null,
    captureVersion: 2,
  }]
}

export interface CorrectedDomainInterval {
  domain: string
  start: number
  end: number
  visitId: number
}

function subtractSpansFromInterval(start: number, end: number, spans: readonly CorrectionSpan[]): Array<{ start: number; end: number }> {
  let pieces = end > start ? [{ start, end }] : []
  for (const span of spans) {
    pieces = pieces.flatMap((piece) => {
      if (span.endMs <= piece.start || span.startMs >= piece.end) return [piece]
      const next: Array<{ start: number; end: number }> = []
      if (span.startMs > piece.start) next.push({ start: piece.start, end: Math.min(span.startMs, piece.end) })
      if (span.endMs < piece.end) next.push({ start: Math.max(span.endMs, piece.start), end: piece.end })
      return next
    })
  }
  return pieces
}

export function getCorrectedDomainIntervals(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  domainFilter?: (domain: string) => boolean,
): CorrectedDomainInterval[] {
  const ignored = getIgnoredBlockSpansForRange(db, fromMs, toMs)
  const siteExclusions = getEvidenceExclusionsForRange(db, fromMs, toMs)
    .filter((exclusion) => exclusion.kind === 'site' && exclusion.domain)
  // Page credit clips against the same corrected foreground ownership the app
  // totals are built from, so a domain's time can never exceed its browser's.
  const reconciled = getReconciledDomainIntervals(
    db, fromMs, toMs, domainFilter,
    (chunkFromMs, chunkToMs) => getCorrectedSessionsForRange(db, chunkFromMs, chunkToMs),
  )
  return reconciled.flatMap((interval) => {
    const excludedForDomain = siteExclusions
      .filter((exclusion) => exclusion.domain === interval.domain)
      .map((exclusion) => ({ startMs: exclusion.startMs, endMs: exclusion.endMs }))
    const subtracted = excludedForDomain.length > 0
      ? mergeCorrectionSpans([...ignored, ...excludedForDomain])
      : ignored
    return subtractSpansFromInterval(interval.start, interval.end, subtracted).map((piece) => ({
      domain: interval.domain,
      visitId: interval.visitId,
      ...piece,
    }))
  })
}

/** Drop website summaries whose domain the user excluded anywhere inside the
 *  queried range — the per-block site lists read raw summaries, and an
 *  excluded site must vanish from the block's evidence, not just its totals. */
export function filterExcludedWebsiteSummaries(
  db: Database.Database,
  summaries: readonly WebsiteSummary[],
  fromMs: number,
  toMs: number,
): WebsiteSummary[] {
  const excludedDomains = new Set(
    getEvidenceExclusionsForRange(db, fromMs, toMs)
      .filter((exclusion) => exclusion.kind === 'site' && exclusion.domain)
      .map((exclusion) => exclusion.domain as string),
  )
  if (excludedDomains.size === 0) return [...summaries]
  return summaries.filter((summary) => !excludedDomains.has(summary.domain))
}

/** Website facts corrected by the same interval ledger as app facts. */
export function getCorrectedWebsiteSummariesForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): WebsiteSummary[] {
  const browserKey = (browserBundleId: string | null, canonicalBrowserId: string | null | undefined): string =>
    canonicalBrowserId ?? browserBundleId ?? ''
  const rawByDomainAndBrowser = new Map(getWebsiteSummariesForRange(db, fromMs, toMs).map((row) => [
    `${row.domain}\u0000${browserKey(row.browserBundleId, row.canonicalBrowserId)}`,
    row,
  ]))
  const visitsById = new Map(getWebsiteVisitsForRange(db, fromMs, toMs).map((visit) => [visit.id, visit]))
  const grouped = new Map<string, {
    domain: string
    browserBundleId: string | null
    canonicalBrowserId: string | null
    intervals: Array<{ start: number; end: number }>
    visitIds: Set<number>
    titleMs: Map<string, number>
  }>()
  for (const interval of getCorrectedDomainIntervals(db, fromMs, toMs)) {
    const visit = visitsById.get(interval.visitId)
    const key = `${interval.domain}\u0000${browserKey(visit?.browserBundleId ?? null, visit?.canonicalBrowserId)}`
    const entry = grouped.get(key) ?? {
      domain: interval.domain,
      browserBundleId: visit?.browserBundleId ?? null,
      canonicalBrowserId: visit?.canonicalBrowserId ?? null,
      intervals: [],
      visitIds: new Set<number>(),
      titleMs: new Map<string, number>(),
    }
    const milliseconds = interval.end - interval.start
    entry.intervals.push({ start: interval.start, end: interval.end })
    entry.visitIds.add(interval.visitId)
    const title = visitsById.get(interval.visitId)?.pageTitle?.trim()
    if (title) entry.titleMs.set(title, (entry.titleMs.get(title) ?? 0) + milliseconds)
    grouped.set(key, entry)
  }
  // Id-less visits bypass the shared per-browser claim pool upstream, so two
  // orphan history rows can hold overlapping credited intervals — union per
  // group before summing so a duplicate row can never double a domain's time.
  const unionMs = (intervals: Array<{ start: number; end: number }>): number => {
    const sorted = intervals.slice().sort((a, b) => a.start - b.start)
    let total = 0
    let cursor = Number.NEGATIVE_INFINITY
    for (const piece of sorted) {
      const start = Math.max(piece.start, cursor)
      if (piece.end > start) total += piece.end - start
      cursor = Math.max(cursor, piece.end)
    }
    return total
  }
  return [...grouped.entries()].map(([key, entry]) => {
    const raw = rawByDomainAndBrowser.get(key)
    const topTitle = [...entry.titleMs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    return {
      domain: entry.domain,
      totalSeconds: Math.round(unionMs(entry.intervals) / 1000),
      visitCount: entry.visitIds.size,
      topTitle,
      browserBundleId: raw?.browserBundleId ?? entry.browserBundleId,
      canonicalBrowserId: raw?.canonicalBrowserId ?? entry.canonicalBrowserId,
    }
  }).filter((summary) => summary.totalSeconds > 0)
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
}

// ─── Corrected page-level facts and browser coverage ─────────────────────────
// Page-level answers must come from the same reconciled, corrected ledger as
// domain and app totals — never from raw website_visits sums, whose stored
// durations are navigation-gap guesses that double-count the two capture
// paths. Alongside the pages, this reports how much of each browser's own
// corrected foreground time the page detail actually explains, so consumers
// can say "Dia was foreground 3h42m; page detail covers 0h10m" instead of
// presenting a thin page list as the whole truth.

export interface CorrectedPageAggregate {
  domain: string
  pageTitle: string | null
  url: string | null
  canonicalBrowserId: string | null
  totalSeconds: number
  visitCount: number
  firstSeen: number
  lastSeen: number
}

export interface BrowserPageCoverage {
  canonicalBrowserId: string
  appName: string
  foregroundSeconds: number
  pageCoveredSeconds: number
}

export interface CorrectedPageFacts {
  pages: CorrectedPageAggregate[]
  coverage: BrowserPageCoverage[]
}

const PAGE_FACTS_CHUNK_MS = 24 * 60 * 60 * 1000

export function getCorrectedPageFactsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): CorrectedPageFacts {
  const ignored = getIgnoredBlockSpansForRange(db, fromMs, toMs)
  const siteExclusions = getEvidenceExclusionsForRange(db, fromMs, toMs)
    .filter((exclusion) => exclusion.kind === 'site' && exclusion.domain)

  interface PageAccumulator extends CorrectedPageAggregate {
    topTitleMs: number
  }
  const byPage = new Map<string, PageAccumulator>()
  const coveredMsByBrowser = new Map<string, number>()

  for (let chunkStart = fromMs; chunkStart < toMs; chunkStart += PAGE_FACTS_CHUNK_MS) {
    const chunkEnd = Math.min(chunkStart + PAGE_FACTS_CHUNK_MS, toMs)
    const sessions = getCorrectedSessionsForRange(db, chunkStart, chunkEnd)
    for (const { visit, freeIntervals } of getReconciledWebsiteVisitsForRange(db, chunkStart, chunkEnd, sessions)) {
      if (freeIntervals.length === 0) continue
      const excludedForDomain = siteExclusions
        .filter((exclusion) => exclusion.domain === visit.domain)
        .map((exclusion) => ({ startMs: exclusion.startMs, endMs: exclusion.endMs }))
      const spans = excludedForDomain.length > 0
        ? mergeCorrectionSpans([...ignored, ...excludedForDomain])
        : ignored
      let creditedMs = 0
      for (const interval of freeIntervals) {
        for (const piece of subtractSpansFromInterval(interval.start, interval.end, spans)) {
          creditedMs += piece.end - piece.start
        }
      }
      if (creditedMs <= 0) continue

      const browserKey = visit.canonicalBrowserId ?? visit.browserBundleId
      if (browserKey) {
        coveredMsByBrowser.set(browserKey, (coveredMsByBrowser.get(browserKey) ?? 0) + creditedMs)
      }

      const pageIdentity = visit.normalizedUrl ?? visit.pageKey ?? visit.url ?? visit.pageTitle ?? ''
      const key = `${visit.domain} ${pageIdentity}`
      let entry = byPage.get(key)
      if (!entry) {
        entry = {
          domain: visit.domain,
          pageTitle: null,
          url: null,
          canonicalBrowserId: visit.canonicalBrowserId,
          totalSeconds: 0,
          visitCount: 0,
          firstSeen: visit.visitTime,
          lastSeen: visit.visitTime,
          topTitleMs: 0,
        }
        byPage.set(key, entry)
      }
      entry.url ??= visit.url
      entry.totalSeconds += Math.round(creditedMs / 1000)
      entry.visitCount += 1
      entry.firstSeen = Math.min(entry.firstSeen, visit.visitTime)
      entry.lastSeen = Math.max(entry.lastSeen, visit.visitTime)
      if (visit.pageTitle && creditedMs > entry.topTitleMs) {
        entry.pageTitle = visit.pageTitle
        entry.topTitleMs = creditedMs
      }
    }
  }

  const pages = [...byPage.values()]
    .filter((entry) => entry.totalSeconds > 0)
    .map(({ topTitleMs: _topTitleMs, ...page }) => page)
    .sort((a, b) => b.totalSeconds - a.totalSeconds)

  // Every browser with corrected foreground time appears in the coverage
  // report, page rows or not — a browser without tab access (zero page rows)
  // is exactly the case the coverage note exists for.
  const coverage: BrowserPageCoverage[] = []
  for (const summary of getCorrectedAppSummariesForRange(db, fromMs, toMs)) {
    const key = summary.canonicalAppId ?? summary.bundleId
    const isBrowser = summary.category === 'browsing' || coveredMsByBrowser.has(key)
    if (!isBrowser || summary.totalSeconds <= 0) continue
    coverage.push({
      canonicalBrowserId: key,
      appName: summary.appName,
      foregroundSeconds: summary.totalSeconds,
      pageCoveredSeconds: Math.round((coveredMsByBrowser.get(key) ?? 0) / 1000),
    })
  }
  coverage.sort((a, b) => b.foregroundSeconds - a.foregroundSeconds)

  return { pages, coverage }
}

function formatHoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
}

// Coverage thresholds: only a material shortfall earns a note — page detail
// under half the browser's foreground time AND at least 15 missing minutes.
const COVERAGE_NOTE_MIN_FOREGROUND_SEC = 30 * 60
const COVERAGE_NOTE_MIN_GAP_SEC = 15 * 60

/** True when a browser's page detail explains materially less time than the
 *  browser itself verifiably had in the foreground (limited tab access). */
export function hasMaterialPageCoverageShortfall(entry: BrowserPageCoverage): boolean {
  if (entry.foregroundSeconds < COVERAGE_NOTE_MIN_FOREGROUND_SEC) return false
  if (entry.foregroundSeconds - entry.pageCoveredSeconds < COVERAGE_NOTE_MIN_GAP_SEC) return false
  return entry.pageCoveredSeconds * 2 < entry.foregroundSeconds
}

// Worded the way the answer should read, not the way the plumbing works: the
// model copies this note's vocabulary and punctuation straight into prose, so
// it carries no em dash and none of the terms the voice contract bans
// ("foreground", "page-level detail").
export function browserPageCoverageNoteText(entry: BrowserPageCoverage): string {
  return `${entry.appName} was in front for ${formatHoursMinutes(entry.foregroundSeconds)}, `
    + `and specific pages are recorded for ${formatHoursMinutes(entry.pageCoveredSeconds)} of that, `
    + `because Daylens can only read some of this browser's tabs. `
    + `Treat ${formatHoursMinutes(entry.foregroundSeconds)} as the real total and the page list as partial.`
}

/** Honest reconciliation notes for browsers with a material page-coverage
 *  shortfall (e.g. Dia). One sentence per browser, ready for a tool result or
 *  the context packet. */
export function browserPageCoverageNotes(coverage: readonly BrowserPageCoverage[]): string[] {
  return coverage.filter(hasMaterialPageCoverageShortfall).map(browserPageCoverageNoteText)
}

export interface CorrectedPeakHoursResult {
  peakStart: number
  peakEnd: number
  focusPct: number
}

export function getCorrectedPeakHours(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): CorrectedPeakHoursResult | null {
  const sessions = getCorrectedSessionsForRange(db, fromMs, toMs)
  const distinctDays = new Set<string>()
  const hours = Array.from({ length: 24 }, () => ({ total: 0, focused: 0 }))
  for (const session of sessions) {
    let cursor = session.startTime
    const end = session.endTime ?? session.startTime + session.durationSeconds * 1000
    if (end <= cursor) continue
    distinctDays.add(new Date(cursor).toLocaleDateString('en-CA'))
    while (cursor < end) {
      const date = new Date(cursor)
      const nextHour = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1).getTime()
      const pieceEnd = Math.min(end, nextHour)
      const seconds = (pieceEnd - cursor) / 1000
      hours[date.getHours()].total += seconds
      if (session.isFocused) hours[date.getHours()].focused += seconds
      cursor = pieceEnd
    }
  }
  if (distinctDays.size < 3) return null
  let best: CorrectedPeakHoursResult | null = null
  let bestFocused = -1
  for (let start = 0; start < 24; start++) {
    const next = (start + 1) % 24
    const total = hours[start].total + hours[next].total
    if (total <= 0) continue
    const focused = hours[start].focused + hours[next].focused
    const focusPct = Math.round((focused / total) * 100)
    if (!best || focusPct > best.focusPct || (focusPct === best.focusPct && focused > bestFocused)) {
      best = { peakStart: start, peakEnd: (start + 2) % 24, focusPct }
      bestFocused = focused
    }
  }
  return best
}
