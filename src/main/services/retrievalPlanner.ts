// The unified retrieval planner (WO-7, REQ-SM-001 + REQ-SM-003).
//
// Daylens had three retrieval paths and nothing above them: exact search
// (entity-resolved + FTS over canonical memory), semantic search (local k-NN),
// and a set of corrected aggregates in activityFacts.ts that no search caller
// ever reached. Each ordered its own output by recency and the palette stapled
// the lists together. This module is the missing layer — one query in, one
// ordered supported result set out.
//
// Four stages, and the order is the requirement (AC-SM-001.1 and .2 both say
// "before retrieval begins"):
//
//   resolve scope   — time range and entities, before any reader runs
//   select paths    — which of structured/exact/semantic are eligible
//   retrieve        — each path inside the resolved scope, failures isolated
//   reconcile+rank  — one result per activity, ordered by retrievalRanking
//
// It composes rather than replaces: searchExact, searchByMeaningWithStatus, and
// the activityFacts aggregates keep their existing callers and behavior.
import type Database from 'better-sqlite3'
import {
  OBSERVED_ONLY,
  readerIneligible,
  searchAll,
  searchEntityMoments,
  type SearchOptions,
  type SearchResult,
  type SearchSourceType,
} from '../db/queries'
import {
  resolveQueryEntityMatches,
  type EntityQueryMatch,
  type ExactSearchResult,
} from './exactSearch'
import { mergeGroupIds } from './entities/entityRepository'
import { searchByMeaningWithStatus } from './semanticIndex'
import {
  getCorrectedAppSummariesForRange,
  getCorrectedWebsiteSummariesForRange,
} from './activityFacts'
import { ensureDayMemoryIndexed } from './memoryIndex'
import { deterministicTerms, isLiteralQuery } from './searchTerms'
import { localDateString, localDayBounds, shiftLocalDateString } from '../lib/localDate'
import {
  compareRanked,
  emptySignals,
  isMatchedTier,
  scoreSignals,
  type RankingSignals,
} from './retrievalRanking'

export type RetrievalPath = 'structured' | 'exact' | 'semantic'

export interface ResolvedScopeEntity {
  id: string
  name: string
  entityType: string
  matchedAlias: string | null
  /** Every id in this entity's merge group — what the readers filter on. */
  groupIds: string[]
}

export interface RetrievalScope {
  startDate?: string
  endDate?: string
  /** Where the range came from. `query-text` means the person typed it. */
  timeRangeSource: 'filter' | 'query-text' | 'none'
  /**
   * The query text with any range phrase removed — what the lexical readers
   * should actually match on. A query naming a day resolves that day into
   * `startDate` and leaves the rest of the words here. Keeping the day in would
   * poison the readers: `toFtsQuery` ANDs every token, so the date string itself
   * would have to appear in the window title too.
   */
  lexicalText: string
  entities: ResolvedScopeEntity[]
  /**
   * The query named something that resolved to more than one entity at the same
   * strength. The planner keeps every candidate rather than picking one; the
   * renderer is required to show that (AC-SM-004.3).
   */
  ambiguousEntity: boolean
}

export interface UnavailablePath {
  path: RetrievalPath
  reason: string
}

export interface RetrievalPlan {
  query: string
  scope: RetrievalScope
  paths: RetrievalPath[]
  unavailable: UnavailablePath[]
}

export type RetrievalResultKind = 'entity' | 'moment' | 'structured'

export interface RetrievalResult {
  /** Reconciliation key: identity of the activity, not of the row. */
  id: string
  kind: RetrievalResultKind
  title: string
  startTime: number
  endTime: number
  date: string
  excerpt: string
  sourceType: SearchSourceType
  /** Every path that independently produced this result. */
  foundBy: RetrievalPath[]
  /** Why this matched, in one line, for the result card. */
  matchExplanation: string
  score: number
  signals: RankingSignals
  /** The raw rows this result reconciled, best representation first. */
  representations: ExactSearchResult[]
}

export interface RetrievalResponse {
  plan: RetrievalPlan
  results: RetrievalResult[]
  /** An eligible path could not run. The query still succeeded (AC-SM-001.6). */
  degraded: boolean
}

const DEFAULT_LIMIT = 25

// ─── Scope resolution ───────────────────────────────────────────────────────

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

interface TextRange {
  startDate: string
  endDate: string
  /** The phrase that produced the range, so callers can strip it from the text. */
  matched: string
}

/**
 * Resolve a time range the person expressed in the query text itself
 * (AC-SM-001.1). Explicit filters take priority over anything found here — this
 * only runs when no date filter was supplied.
 *
 * Deliberately conservative: an unrecognized phrase yields no range rather than
 * a guessed one, because a wrong range silently hides evidence.
 */
export function resolveTimeRangeFromText(query: string, today = localDateString()): TextRange | null {
  const text = query.toLowerCase()

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return { startDate: iso[1], endDate: iso[1], matched: iso[0] }

  const today_ = text.match(/\btoday\b/)
  if (today_) return { startDate: today, endDate: today, matched: today_[0] }
  const yesterday = text.match(/\byesterday\b/)
  if (yesterday) {
    const day = shiftLocalDateString(today, -1)
    return { startDate: day, endDate: day, matched: yesterday[0] }
  }

  const lastDays = text.match(/\blast\s+(\d{1,3})\s+days?\b/)
  if (lastDays) {
    const count = Math.min(365, Math.max(1, Number(lastDays[1])))
    return {
      startDate: shiftLocalDateString(today, -(count - 1)),
      endDate: today,
      matched: lastDays[0],
    }
  }

  const thisWeek = text.match(/\b(this|past)\s+week\b/)
  if (thisWeek) {
    return { startDate: shiftLocalDateString(today, -6), endDate: today, matched: thisWeek[0] }
  }
  const lastWeek = text.match(/\blast\s+week\b/)
  if (lastWeek) {
    return {
      startDate: shiftLocalDateString(today, -13),
      endDate: shiftLocalDateString(today, -7),
      matched: lastWeek[0],
    }
  }
  const thisMonth = text.match(/\b(this|past)\s+month\b/)
  if (thisMonth) {
    return { startDate: shiftLocalDateString(today, -29), endDate: today, matched: thisMonth[0] }
  }
  const lastMonth = text.match(/\blast\s+month\b/)
  if (lastMonth) {
    return {
      startDate: shiftLocalDateString(today, -59),
      endDate: shiftLocalDateString(today, -30),
      matched: lastMonth[0],
    }
  }

  // A bare month name resolves to that month in the most recent year it has
  // already happened — "in July" in August 2026 means July 2026, not 2027.
  for (const [index, month] of MONTHS.entries()) {
    if (!new RegExp(`\\b${month}\\b`).test(text)) continue
    const [todayYear, todayMonth] = today.split('-').map(Number)
    const year = index + 1 <= todayMonth ? todayYear : todayYear - 1
    const monthNumber = String(index + 1).padStart(2, '0')
    const lastDay = new Date(year, index + 1, 0).getDate()
    return {
      startDate: `${year}-${monthNumber}-01`,
      endDate: `${year}-${monthNumber}-${String(lastDay).padStart(2, '0')}`,
      matched: month,
    }
  }

  return null
}

/** Remove a resolved range phrase from the query, leaving the lexical remainder. */
function stripPhrase(query: string, phrase: string): string {
  if (!phrase) return query
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return query
    .replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ')
    // The prepositions that only existed to carry the date go with it.
    .replace(/\b(on|in|during|from|between|for)\s+(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function resolveRetrievalScope(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): RetrievalScope {
  const trimmed = query.trim()

  let startDate = opts.startDate
  let endDate = opts.endDate
  let timeRangeSource: RetrievalScope['timeRangeSource'] = startDate || endDate ? 'filter' : 'none'
  let lexicalText = trimmed
  if (timeRangeSource === 'none') {
    const fromText = resolveTimeRangeFromText(trimmed)
    if (fromText) {
      startDate = fromText.startDate
      endDate = fromText.endDate
      timeRangeSource = 'query-text'
      lexicalText = stripPhrase(trimmed, fromText.matched)
    }
  }

  let matches: EntityQueryMatch[] = []
  try {
    matches = trimmed ? resolveQueryEntityMatches(db, trimmed) : []
  } catch (error) {
    console.error('[retrievalPlanner] entity resolution failed', error)
  }

  const entities: ResolvedScopeEntity[] = matches.map((match) => ({
    id: match.entity.id,
    name: match.entity.canonical_name,
    entityType: match.entity.entity_type,
    matchedAlias: match.matchedAlias,
    groupIds: safeMergeGroupIds(db, match.entity.id),
  }))

  // Ambiguous means two candidates the resolver could not separate — same rank.
  // A strong match plus a weaker substring hit is not ambiguity.
  const bestRank = matches.length > 0 ? matches[0].rank : null
  const ambiguousEntity = bestRank !== null
    && matches.filter((match) => match.rank === bestRank).length > 1

  return { startDate, endDate, timeRangeSource, lexicalText, entities, ambiguousEntity }
}

function safeMergeGroupIds(db: Database.Database, entityId: string): string[] {
  try {
    return [...mergeGroupIds(db, entityId)]
  } catch {
    return [entityId]
  }
}

// ─── Path selection ─────────────────────────────────────────────────────────

const STRUCTURED_INTENT = /\b(how (much|many|long)|total|totals|count|counts|hours?|minutes?|time spent|spent on|breakdown|summary|average)\b/i

/** AC-SM-001.3: the query asks for a count, a duration, or a relationship. */
export function needsStructuredRetrieval(query: string, scope: RetrievalScope): boolean {
  if (STRUCTURED_INTENT.test(query)) return true
  // A query that resolved a range and has nothing left to match on is asking
  // about a period, not for a phrase — the aggregates are the only answer.
  return scope.timeRangeSource !== 'none' && deterministicTerms(scope.lexicalText).length === 0
}

/** AC-SM-001.5: meaning-based matching helps when the wording is not the point. */
export function benefitsFromSemanticRetrieval(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length < 3) return false
  // A quoted phrase is a demand for those exact words.
  if (/"[^"]+"/.test(trimmed)) return false
  // Short literal lookups ("figma", "acme corp") are already served exactly.
  return !isLiteralQuery(trimmed)
}

export function hasExactContent(query: string): boolean {
  return query.trim().length > 0
}

// ─── Retrieval ──────────────────────────────────────────────────────────────

interface PathRows {
  path: RetrievalPath
  rows: ExactSearchResult[]
}

function scopedOptions(scope: RetrievalScope, opts: SearchOptions, limit: number): SearchOptions {
  return {
    ...opts,
    startDate: scope.startDate,
    endDate: scope.endDate,
    limit,
  }
}

function runExactRetrieval(
  db: Database.Database,
  scope: RetrievalScope,
  opts: SearchOptions,
  limit: number,
): ExactSearchResult[] {
  const scoped = scopedOptions(scope, opts, limit)

  // The entity-tagged moments come from the scope's already-resolved entities
  // rather than re-resolving them here, which is what makes AC-SM-001.2 a
  // pre-retrieval step instead of a side effect of searchExact.
  const groupIds = [...new Set(scope.entities.flatMap((entity) => entity.groupIds))]
  const tagged = groupIds.length > 0 ? searchEntityMoments(db, groupIds, scoped) : []

  return [...tagged, ...runLexicalRetrieval(db, scope, scoped)]
}

/**
 * `toFtsQuery` ANDs every token, so handing it a whole sentence asks for a
 * window title containing "what", "was", and "I". A quoted or short literal
 * query is meant to be taken whole; anything longer is searched per keyword and
 * unioned, the same shape `naturalSearch` uses for its provider terms.
 */
function runLexicalRetrieval(
  db: Database.Database,
  scope: RetrievalScope,
  scoped: SearchOptions,
): ExactSearchResult[] {
  const text = scope.lexicalText.trim()
  if (!text) return []
  if (isLiteralQuery(text) || /"[^"]+"/.test(text)) return searchAll(db, text, scoped)

  const terms = deterministicTerms(text)
  if (terms.length === 0) return searchAll(db, text, scoped)
  return terms.flatMap((term) => searchAll(db, term, scoped))
}

function runStructuredRetrieval(
  db: Database.Database,
  scope: RetrievalScope,
  opts: SearchOptions,
  limit: number,
): ExactSearchResult[] {
  const [fromMs, toMs] = structuredBounds(scope)
  const terms = deterministicTerms(scope.lexicalText)
  const matchesTerms = (label: string): boolean => {
    if (terms.length === 0) return true
    const lowered = label.toLowerCase()
    return terms.some((term) => lowered.includes(term))
  }

  // The aggregates are recorded totals over directly observed capture, and they
  // carry no entity tags: an app total knows its bundle id, a domain total knows
  // its domain and the browser it was seen in. A filter neither can express
  // makes that reader ineligible, by the same rule the SQL readers follow —
  // returning its rows unfiltered would let a search narrowed to Figma answer
  // with every app's total.
  const appTotalsEligible = !readerIneligible(opts, {
    applications: true, sourceTypes: OBSERVED_ONLY,
  })
  const domainTotalsEligible = !readerIneligible(opts, {
    applications: true, websites: true, sourceTypes: OBSERVED_ONLY,
  })
  const requestedApplications = opts.applications ?? []
  const requestedWebsites = (opts.websites ?? []).map((domain) => domain.toLowerCase())
  // Mirrors appSessionFilterSql / websiteVisitFilterSql: a bundle id matches
  // exactly, an application name case-insensitively.
  const matchesApplication = (bundleId: string | null, appName?: string | null): boolean => {
    if (requestedApplications.length === 0) return true
    return requestedApplications.some((requested) =>
      requested === bundleId
      || (appName != null && requested.toLowerCase() === appName.toLowerCase()))
  }

  const rows: ExactSearchResult[] = []

  for (const app of appTotalsEligible ? getCorrectedAppSummariesForRange(db, fromMs, toMs) : []) {
    if (!matchesTerms(app.appName)) continue
    if (!matchesApplication(app.bundleId, app.appName)) continue
    rows.push({
      type: 'session',
      id: -Math.abs(hashString(`app:${app.bundleId}`)),
      appName: app.appName,
      windowTitle: null,
      startTime: fromMs,
      endTime: toMs,
      date: scope.startDate ?? localDateString(new Date(fromMs)),
      excerpt: `${formatDuration(app.totalSeconds)} in ${app.appName}`
        + (app.sessionCount ? ` across ${app.sessionCount} sessions` : ''),
      sourceType: 'observed',
    })
  }

  for (const site of domainTotalsEligible ? getCorrectedWebsiteSummariesForRange(db, fromMs, toMs) : []) {
    if (!matchesTerms(site.domain) && !matchesTerms(site.topTitle ?? '')) continue
    if (requestedWebsites.length > 0 && !requestedWebsites.includes(site.domain.toLowerCase())) continue
    if (!matchesApplication(site.browserBundleId)) continue
    rows.push({
      type: 'browser',
      id: -Math.abs(hashString(`site:${site.domain}`)),
      domain: site.domain,
      pageTitle: site.topTitle,
      url: null,
      startTime: fromMs,
      endTime: toMs,
      date: scope.startDate ?? localDateString(new Date(fromMs)),
      excerpt: `${formatDuration(site.totalSeconds)} on ${site.domain}`
        + ` across ${site.visitCount} visits`,
    })
  }

  return rows
    .sort((left, right) => structuredSeconds(right) - structuredSeconds(left))
    .slice(0, limit)
}

function structuredBounds(scope: RetrievalScope): [number, number] {
  const today = localDateString()
  const [fromMs] = localDayBounds(scope.startDate ?? shiftLocalDateString(today, -29))
  const [, toMs] = localDayBounds(scope.endDate ?? today)
  return [fromMs, toMs]
}

function structuredSeconds(row: ExactSearchResult): number {
  const match = row.excerpt.match(/^(\d+)h|^(\d+)m|^(\d+)s/)
  if (!match) return 0
  if (match[1]) return Number(match[1]) * 3600
  if (match[2]) return Number(match[2]) * 60
  return Number(match[3] ?? 0)
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.round((totalSeconds % 3600) / 60)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}m`
  return `${Math.max(0, Math.round(totalSeconds))}s`
}

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

function normalizeSubject(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\[\[\/?mark\]\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * The identity of the *activity*, not of the row (AC-SM-003.1).
 *
 * This is the whole point of reconciliation. The same session reaches the
 * planner as a `memory_records` projection and, on a day the indexer has not
 * reached, as a legacy `app_sessions` row — different `type` and different `id`,
 * so the old `type:id:startTime` dedupe kept both. Keying on start time plus the
 * app/domain/title subject collapses them.
 */
export function reconciliationKey(row: ExactSearchResult): string {
  if (row.type === 'entity') return `entity:${row.id}`
  const subject = row.type === 'session'
    ? normalizeSubject(row.appName)
    : row.type === 'browser'
      ? normalizeSubject(row.domain)
      : row.type === 'block'
        ? normalizeSubject(row.label)
        : normalizeSubject(row.title)
  return `moment:${row.startTime}:${subject}`
}

/** Canonical corrected memory beats a legacy raw-capture row. */
function representationQuality(row: ExactSearchResult): number {
  if (row.type === 'entity') return 3
  const sourceType = 'sourceType' in row ? row.sourceType : undefined
  if (sourceType === 'supplied') return 3
  if (sourceType === 'connected') return 2
  if (sourceType === 'observed') return 2
  // No sourceType at all means the legacy reader produced it.
  return 1
}

interface ReconciledGroup {
  key: string
  representations: ExactSearchResult[]
  foundBy: Set<RetrievalPath>
}

export function reconcileResults(batches: readonly PathRows[]): ReconciledGroup[] {
  const groups = new Map<string, ReconciledGroup>()
  for (const batch of batches) {
    for (const row of batch.rows) {
      const key = reconciliationKey(row)
      const existing = groups.get(key)
      if (existing) {
        existing.representations.push(row)
        existing.foundBy.add(batch.path)
        continue
      }
      groups.set(key, { key, representations: [row], foundBy: new Set([batch.path]) })
    }
  }
  for (const group of groups.values()) {
    group.representations.sort((left, right) => representationQuality(right) - representationQuality(left))
  }
  return [...groups.values()]
}

// ─── Ranking signals ────────────────────────────────────────────────────────

function rowText(row: ExactSearchResult): string {
  const parts: string[] = [row.excerpt]
  if (row.type === 'entity') parts.push(row.name, row.matchedAlias ?? '')
  else if (row.type === 'session') parts.push(row.appName, row.windowTitle ?? '')
  else if (row.type === 'browser') parts.push(row.domain, row.pageTitle ?? '', row.url ?? '')
  else if (row.type === 'block') parts.push(row.label)
  else parts.push(row.title, row.filePath ?? '')
  return normalizeSubject(parts.join(' '))
}

function rowTitle(row: ExactSearchResult): string {
  if (row.type === 'entity') return row.name
  if (row.type === 'session') return row.windowTitle?.trim() || row.appName
  if (row.type === 'browser') return row.pageTitle?.trim() || row.domain
  if (row.type === 'block') return row.label
  return row.title
}

function rowSourceType(row: ExactSearchResult): SearchSourceType {
  if (row.type === 'entity') return row.sourceType
  if ('sourceType' in row && row.sourceType) return row.sourceType
  return 'observed'
}

const RECENCY_INTENT = /\b(latest|recent|recently|last|newest|current|now|today)\b/i
/** Recency saturates over this window; older results get proportionally less. */
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export function signalsFor(
  group: ReconciledGroup,
  scope: RetrievalScope,
  query: string,
  now: number,
): RankingSignals {
  const signals = emptySignals()
  const best = group.representations[0]
  const text = rowText(best)
  const terms = deterministicTerms(scope.lexicalText)

  // Exact lexical: fraction of the query's terms present in the result text,
  // with a quoted phrase counting as a whole-phrase requirement.
  if (terms.length > 0) {
    const hits = terms.filter((term) => text.includes(term)).length
    signals.exactLexical = hits / terms.length
  }
  const quoted = query.match(/"([^"]+)"/)
  if (quoted && text.includes(normalizeSubject(quoted[1]))) signals.exactLexical = 1

  // Semantic similarity travels on the row from searchSemanticMoments.
  const semantic = group.representations.find(
    (row) => 'similarity' in row && typeof row.similarity === 'number',
  )
  if (semantic && 'similarity' in semantic && typeof semantic.similarity === 'number') {
    signals.semanticSimilarity = semantic.similarity
  }

  // Entity match: the result is one of the resolved entities, or is tagged with
  // one. An entity row that IS a resolved survivor is the strongest form.
  if (scope.entities.length > 0) {
    if (best.type === 'entity' && scope.entities.some((entity) => entity.id === best.id)) {
      signals.entityMatch = 1
    } else if (scope.entities.some((entity) => text.includes(normalizeSubject(entity.name)))) {
      signals.entityMatch = 1
    }
  }

  // Time-range fit: 1 only when the result falls inside a range the person
  // actually requested. An unrequested range is not a match to reward.
  if (scope.startDate || scope.endDate) {
    const withinStart = !scope.startDate || best.date >= scope.startDate
    const withinEnd = !scope.endDate || best.date <= scope.endDate
    signals.timeRangeFit = withinStart && withinEnd ? 1 : 0
  }

  signals.sourceQuality = Math.max(
    ...group.representations.map((row) => representationQuality(row) / 3),
  )

  // A corrected or supplied record is one the person shaped by hand.
  const sourceType = rowSourceType(best)
  signals.explicitCorrection = sourceType === 'supplied' ? 1 : 0
  signals.confirmedRelationship = best.type === 'entity' && best.sourceType !== 'inferred' ? 1 : 0

  // Query-implied recency: only when the query asks for it, or when nothing
  // scoped the search at all. A query naming a date gets no recency term —
  // that is half of what keeps AC-SM-003.3 honest.
  const impliesRecency = RECENCY_INTENT.test(query) || scope.timeRangeSource === 'none'
  if (impliesRecency && best.startTime > 0) {
    const age = Math.max(0, now - best.startTime)
    signals.queryImpliedRecency = Math.max(0, 1 - age / RECENCY_WINDOW_MS)
  }

  signals.corroboration = group.foundBy.size > 1 ? 1 : 0

  return signals
}

function explainMatch(
  group: ReconciledGroup,
  signals: RankingSignals,
  scope: RetrievalScope,
): string {
  const reasons: string[] = []
  if (signals.exactLexical >= 1) reasons.push('exact match')
  else if (signals.exactLexical > 0) reasons.push('partial word match')
  if (signals.entityMatch >= 1) {
    const entity = scope.entities[0]
    reasons.push(entity?.matchedAlias ? `known as “${entity.matchedAlias}”` : 'matched entity')
  }
  if (signals.semanticSimilarity > 0) reasons.push('similar meaning')
  if (group.foundBy.has('structured')) reasons.push('from recorded totals')
  if (signals.corroboration >= 1) reasons.push(`corroborated by ${group.foundBy.size} paths`)
  return reasons.length > 0 ? reasons.join(' · ') : 'matched your query'
}

// ─── The planner ─────────────────────────────────────────────────────────────

export interface PlanRetrievalOptions extends SearchOptions {
  /** Overrides "now" for recency scoring. Tests only. */
  now?: number
}

export async function planRetrieval(
  db: Database.Database,
  query: string,
  opts: PlanRetrievalOptions = {},
): Promise<RetrievalResponse> {
  const trimmed = query.trim()
  const limit = opts.limit ?? DEFAULT_LIMIT
  const now = opts.now ?? Date.now()

  // Scope first: both criteria say "before retrieval begins".
  const scope = resolveRetrievalScope(db, trimmed, opts)
  const plan: RetrievalPlan = { query: trimmed, scope, paths: [], unavailable: [] }
  if (!trimmed) return { plan, results: [], degraded: false }

  // Today is the only day whose evidence grows between corrections; keep its
  // projection current so a moment from five minutes ago is findable.
  try {
    ensureDayMemoryIndexed(db, localDateString())
  } catch (error) {
    console.error('[retrievalPlanner] live-day index refresh failed', error)
  }

  // Which paths this query is eligible for.
  const wantsExact = hasExactContent(scope.lexicalText) || scope.entities.length > 0
  const wantsStructured = needsStructuredRetrieval(trimmed, scope)
  const wantsSemantic = benefitsFromSemanticRetrieval(trimmed)

  // Retrieve. Each path is isolated: one failing must not fail the query.
  const batches: PathRows[] = []

  if (wantsStructured) {
    try {
      batches.push({ path: 'structured', rows: runStructuredRetrieval(db, scope, opts, limit) })
      plan.paths.push('structured')
    } catch (error) {
      console.error('[retrievalPlanner] structured retrieval failed', error)
      plan.unavailable.push({ path: 'structured', reason: 'Recorded totals could not be read.' })
    }
  }

  if (wantsExact) {
    try {
      batches.push({ path: 'exact', rows: runExactRetrieval(db, scope, opts, limit) })
      plan.paths.push('exact')
    } catch (error) {
      console.error('[retrievalPlanner] exact retrieval failed', error)
      plan.unavailable.push({ path: 'exact', reason: 'Exact retrieval could not be read.' })
    }
  }

  if (wantsSemantic) {
    const semantic = await searchByMeaningWithStatus(db, trimmed, scopedOptions(scope, opts, limit))
    if (semantic.available) {
      batches.push({ path: 'semantic', rows: semantic.results })
      plan.paths.push('semantic')
    } else {
      // AC-SM-001.6: eligible but unavailable is a degraded plan, not a failure.
      plan.unavailable.push({ path: 'semantic', reason: semantic.reason })
    }
  }

  // Reconcile, score, order.
  const groups = reconcileResults(batches)
  const results: RetrievalResult[] = groups.map((group) => {
    const best = group.representations[0]
    const signals = signalsFor(group, scope, trimmed, now)
    return {
      id: group.key,
      kind: best.type === 'entity'
        ? 'entity'
        : group.foundBy.has('structured') && group.foundBy.size === 1
          ? 'structured'
          : 'moment',
      title: rowTitle(best),
      startTime: best.startTime,
      endTime: best.endTime,
      date: best.date,
      excerpt: best.excerpt,
      sourceType: rowSourceType(best),
      foundBy: [...group.foundBy],
      matchExplanation: explainMatch(group, signals, scope),
      score: scoreSignals(signals),
      signals,
      representations: group.representations,
    }
  })

  results.sort(compareRanked)

  return {
    plan,
    results: results.slice(0, limit),
    degraded: plan.unavailable.length > 0,
  }
}

export { isMatchedTier }
export type { SearchResult }
