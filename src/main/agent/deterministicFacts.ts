// Deterministic answer facts (WO-53 / AC-AIA-002.4, AI Agent blueprint
// "Deterministic activity totals, counts, dates, relationships, and time
// intervals shall come from eligible structured evidence rather than a model
// choice").
//
// The bug this closes (DEV-246): a chat answer's headline number could differ
// from the number Timeline and Apps show for the same day, because the model
// was free to restate, round, or re-derive a total it had been handed. The fix
// is not a better prompt. It is a computed value that wins.
//
// Every figure here is read from queryCorrectedActivityFactsForDay — the ONE
// canonical corrected-facts boundary that the Timeline projection and the Apps
// view also read. Nothing in this module re-implements activity, time, or
// attribution; if a total here ever disagreed with the UI, the boundary itself
// would be wrong and both would move together.
//
// Scope is deliberately one headline figure per dimension. A question asks for
// "the" total or "the" count; binding a single computed value to the answer's
// single stated value is unambiguous. Trying to police every incidental number
// in a paragraph would need claim-to-subject attribution the answer text does
// not reliably carry, and a mis-attributed repair is worse than none.
import type Database from 'better-sqlite3'
import type { AppSession, AppUsageSummary } from '@shared/types'
import type { ResolvedContextTimeRange } from '../services/contextPacket'
import { queryCorrectedActivityFactsForDay } from '../core/query/activityFactsQuery'
import { aggregateAppSummaries, getCorrectedWebsiteSummariesForRange } from '../services/activityFacts'
import { getStoredCanonicalAppLinks } from '../core/inference/appIdentityRegistry'
import { localDayBounds } from '../lib/localDate'
import { namedUsageSubject, siteMatchesLookup } from '../lib/usageLookup'
import { websiteDisplayLabel } from '../lib/appIdentity'
import { renderDuration, scanDurations } from './factClaims'

/** Widest span the enforcer will compute over. Matches the page-visit tool's
 *  own ceiling so a question too broad for evidence stays uncomputed rather
 *  than producing a number from a partial scan. */
const MAX_RANGE_DAYS = 62

/** A stated duration within this much of the computed one is the same fact
 *  said differently (minute rounding), not a contradiction. */
const DURATION_TOLERANCE_SECONDS = 60

export type DeterministicFactKind =
  | 'total_tracked_time'
  | 'focus_time'
  | 'app_total_time'
  | 'site_total_time'
  | 'app_count'
  | 'site_count'

export type DeterministicDimension = 'duration' | 'count'

export interface DeterministicFact {
  /** Stable within a turn: kind plus the scope it was computed over. */
  id: string
  kind: DeterministicFactKind
  dimension: DeterministicDimension
  /** Seconds for a duration, a whole number for a count. */
  value: number
  /** The value as the answer should state it. */
  rendered: string
  /** Plain-language name of what was measured. */
  subject: string
  /** Evidence identity, in the packet's identity style, so a bound claim
   *  points at a real recorded thing rather than at prose. */
  identity: string
  /** The disclosed statement a citation to this fact resolves to. */
  statement: string
}

export interface DeterministicFactRequest {
  kind: DeterministicFactKind
  dimension: DeterministicDimension
  /** Local dates in scope, from the packet's own resolved time range. */
  dates: string[]
  /** Set only for app_total_time. */
  appNeedle?: string
  /** Set only for site_total_time. */
  siteNeedle?: string
}

// ─── Detection ───────────────────────────────────────────────────────────────
// "Eligible" means the question asks for a single aggregate that the corrected
// boundary can compute. Everything else is left to the model.

// "How long" and "total time" are temporal on their own. "How much" is not:
// "how much did I spend" can be money, so it needs a time subject alongside.
const ASKS_DURATION_DIRECT = /\b(?:how long|how many (?:hours|minutes|mins)|total (?:time|hours|minutes))\b/i
const ASKS_DURATION_LOOSE = /\bhow much\b/i
const ASKS_COUNT = /\bhow many\b/i
const TIME_SUBJECT = /\b(?:time|hours?|minutes?|mins?|spend|spent|spending|work(?:ing|ed)?|active|tracked|on screen|screen time)\b/i

function asksDuration(question: string): boolean {
  return ASKS_DURATION_DIRECT.test(question)
    || (ASKS_DURATION_LOOSE.test(question) && TIME_SUBJECT.test(question))
}
const FOCUS_SUBJECT = /\b(?:focus(?:ed|ing)?|deep work|heads[- ]down)\b/i
const APP_COUNT_SUBJECT = /\b(?:apps?|applications?|programs?)\b/i
const SITE_COUNT_SUBJECT = /\b(?:sites?|websites?|domains?)\b/i
// "how many hours" is a duration question wearing a count's clothes.
const COUNT_OF_TIME = /\bhow many (?:hours|minutes|mins|seconds)\b/i

/**
 * Which single duration fact and which single count fact (if any) this
 * question asks for. `appNames` is the corrected app roster for the scope, so
 * "how long was I in Slack" only becomes an app fact when Slack is a real
 * captured app rather than a word in the sentence.
 */
export function detectDeterministicFactRequests(
  question: string,
  timeRange: Pick<ResolvedContextTimeRange, 'dates'>,
  appNames: readonly string[] = [],
  siteDomains: readonly string[] = [],
): DeterministicFactRequest[] {
  const dates = [...new Set(timeRange.dates ?? [])].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort()
  if (dates.length === 0 || dates.length > MAX_RANGE_DAYS) return []

  const requests: DeterministicFactRequest[] = []

  if (asksDuration(question)) {
    const named = namedUsageSubject(question, appNames, siteDomains)
    if (named?.kind === 'site') {
      requests.push({ kind: 'site_total_time', dimension: 'duration', dates, siteNeedle: named.domain })
    } else if (named?.kind === 'app') {
      requests.push({ kind: 'app_total_time', dimension: 'duration', dates, appNeedle: named.name })
    } else if (FOCUS_SUBJECT.test(question)) {
      requests.push({ kind: 'focus_time', dimension: 'duration', dates })
    } else {
      requests.push({ kind: 'total_tracked_time', dimension: 'duration', dates })
    }
  }

  if (ASKS_COUNT.test(question) && !COUNT_OF_TIME.test(question)) {
    if (APP_COUNT_SUBJECT.test(question)) requests.push({ kind: 'app_count', dimension: 'count', dates })
    else if (SITE_COUNT_SUBJECT.test(question)) requests.push({ kind: 'site_count', dimension: 'count', dates })
  }

  return requests
}

// ─── Computation ─────────────────────────────────────────────────────────────

interface ScopeFacts {
  sessions: AppSession[]
  totalSeconds: number
  focusSeconds: number
  appSummaries: AppUsageSummary[]
  siteSummaries: Array<{ domain: string; totalSeconds: number }>
  siteCount: number
}

/** Read the scope once through the canonical boundary, then derive every
 *  requested fact from that single read: two facts in one answer can never be
 *  computed from two different snapshots. */
function readScope(db: Database.Database, dates: readonly string[], nowMs: number): ScopeFacts {
  const sessions: AppSession[] = []
  let totalSeconds = 0
  let focusSeconds = 0
  for (const date of dates) {
    const facts = queryCorrectedActivityFactsForDay(db, date, { nowMs })
    sessions.push(...facts.sessions)
    totalSeconds += facts.totalSeconds
    focusSeconds += facts.focusSeconds
  }
  const appSummaries = aggregateAppSummaries(sessions, getStoredCanonicalAppLinks(db))

  const siteTotals = new Map<string, number>()
  for (const date of dates) {
    const [fromMs, toMs] = localDayBounds(date)
    for (const summary of getCorrectedWebsiteSummariesForRange(db, fromMs, toMs)) {
      if (summary.totalSeconds <= 0) continue
      const domain = summary.domain.toLowerCase()
      siteTotals.set(domain, (siteTotals.get(domain) ?? 0) + summary.totalSeconds)
    }
  }
  const siteSummaries = [...siteTotals.entries()].map(([domain, totalSeconds]) => ({ domain, totalSeconds }))

  return { sessions, totalSeconds, focusSeconds, appSummaries, siteSummaries, siteCount: siteSummaries.length }
}

function scopeLabel(dates: readonly string[]): string {
  if (dates.length === 1) return dates[0]
  return `${dates[0]} to ${dates[dates.length - 1]}`
}

/**
 * Compute the requested facts from the corrected boundary. A scope that was
 * read successfully but holds no activity still yields facts, with the value
 * zero: nothing captured is a measured answer, so a model claiming hours on an
 * empty day is corrected rather than left alone. Only a subject the scope has
 * no reading for at all (an app it never captured) yields no fact, and a read
 * that failed yields none either.
 */
export function computeDeterministicFacts(
  db: Database.Database,
  requests: readonly DeterministicFactRequest[],
  options: { nowMs?: number } = {},
): DeterministicFact[] {
  if (requests.length === 0) return []
  const dates = requests[0].dates
  const scope = readScopeOrNull(db, dates, options.nowMs ?? Date.now())
  return scope ? factsFromScope(scope, requests, dates) : []
}

function readScopeOrNull(
  db: Database.Database,
  dates: readonly string[],
  nowMs: number,
): ScopeFacts | null {
  try {
    return readScope(db, dates, nowMs)
  } catch (error) {
    console.warn('[agent:deterministic] corrected facts unavailable; leaving the answer to the model', error)
    return null
  }
}

/**
 * Detect and compute in one pass, from ONE read of the corrected boundary.
 * This is the entry point the chat turn uses: app-name detection needs the
 * scope's real app roster, and every fact in the answer must come from the
 * same snapshot of that scope.
 */
export function deterministicFactsForQuestion(
  db: Database.Database,
  question: string,
  timeRange: Pick<ResolvedContextTimeRange, 'dates'>,
  options: { nowMs?: number } = {},
): DeterministicFact[] {
  // Cheap gate before touching the database: most turns ask for none of this.
  if (!asksDuration(question) && !ASKS_COUNT.test(question)) return []
  const dates = [...new Set(timeRange.dates ?? [])]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()
  if (dates.length === 0 || dates.length > MAX_RANGE_DAYS) return []

  const scope = readScopeOrNull(db, dates, options.nowMs ?? Date.now())
  if (!scope) return []
  const requests = detectDeterministicFactRequests(
    question,
    { dates },
    scope.appSummaries.map((entry) => entry.appName),
    scope.siteSummaries.map((entry) => entry.domain),
  )
  return factsFromScope(scope, requests, dates)
}

function factsFromScope(
  scope: ScopeFacts,
  requests: readonly DeterministicFactRequest[],
  dates: readonly string[],
): DeterministicFact[] {
  const label = scopeLabel(dates)
  const scopeId = dates.length === 1 ? dates[0] : `${dates[0]}..${dates[dates.length - 1]}`
  const facts: DeterministicFact[] = []

  for (const request of requests) {
    switch (request.kind) {
      case 'total_tracked_time': {
        facts.push({
          id: `total_tracked_time:${scopeId}`,
          kind: request.kind,
          dimension: 'duration',
          value: scope.totalSeconds,
          rendered: renderDuration(scope.totalSeconds),
          subject: `tracked activity on ${label}`,
          identity: `facts:day:${scopeId}:total`,
          statement: scope.totalSeconds > 0
            ? `Tracked activity for ${label} totals ${renderDuration(scope.totalSeconds)} (${scope.totalSeconds} seconds), from the corrected activity facts the Timeline and Apps views read.`
            : `No tracked activity was captured for ${label} (0 seconds), from the corrected activity facts the Timeline and Apps views read.`,
        })
        break
      }
      case 'focus_time': {
        facts.push({
          id: `focus_time:${scopeId}`,
          kind: request.kind,
          dimension: 'duration',
          value: scope.focusSeconds,
          rendered: renderDuration(scope.focusSeconds),
          subject: `focused time on ${label}`,
          identity: `facts:day:${scopeId}:focus`,
          statement: scope.focusSeconds > 0
            ? `Focused time for ${label} totals ${renderDuration(scope.focusSeconds)} (${scope.focusSeconds} seconds), from the corrected activity facts the Timeline and Apps views read.`
            : `No focused time was captured for ${label} (0 seconds), from the corrected activity facts the Timeline and Apps views read.`,
        })
        break
      }
      case 'app_total_time': {
        const needle = request.appNeedle?.toLowerCase() ?? ''
        const summary = scope.appSummaries.find((entry) => entry.appName.toLowerCase() === needle)
        // An app the scope never captured has no reading, which is not a zero.
        if (!summary) break
        facts.push({
          id: `app_total_time:${scopeId}:${summary.appName.toLowerCase()}`,
          kind: request.kind,
          dimension: 'duration',
          value: summary.totalSeconds,
          rendered: renderDuration(summary.totalSeconds),
          subject: `${summary.appName} on ${label}`,
          identity: `facts:app:${scopeId}:${summary.canonicalAppId ?? summary.bundleId}`,
          statement: summary.totalSeconds > 0
            ? `${summary.appName} totals ${renderDuration(summary.totalSeconds)} (${summary.totalSeconds} seconds) for ${label}, from the corrected activity facts the Apps view reads.`
            : `No ${summary.appName} time was captured for ${label} (0 seconds), from the corrected activity facts the Apps view reads.`,
        })
        break
      }
      case 'site_total_time': {
        const needle = request.siteNeedle ?? ''
        const matching = scope.siteSummaries.filter((entry) => siteMatchesLookup(entry.domain, needle))
        const totalSeconds = matching.reduce((sum, entry) => sum + entry.totalSeconds, 0)
        const shortest = matching.reduce<typeof matching[number] | null>(
          (best, entry) => !best || entry.domain.length < best.domain.length ? entry : best,
          null,
        )
        if (!shortest) break
        const subjectDomain = shortest.domain
        const siteLabel = websiteDisplayLabel(subjectDomain)
        facts.push({
          id: `site_total_time:${scopeId}:${subjectDomain}`,
          kind: request.kind,
          dimension: 'duration',
          value: totalSeconds,
          rendered: renderDuration(totalSeconds),
          subject: `${siteLabel} on ${label}`,
          identity: `facts:site:${scopeId}:${subjectDomain}`,
          statement: totalSeconds > 0
            ? `${siteLabel} totals ${renderDuration(totalSeconds)} (${totalSeconds} seconds) for ${label}, from the corrected website facts the Apps view reads.`
            : `No ${siteLabel} time was captured for ${label} (0 seconds), from the corrected website facts the Apps view reads.`,
        })
        break
      }
      case 'app_count': {
        const count = scope.appSummaries.filter((entry) => entry.totalSeconds > 0).length
        facts.push({
          id: `app_count:${scopeId}`,
          kind: request.kind,
          dimension: 'count',
          value: count,
          rendered: String(count),
          subject: `apps used on ${label}`,
          identity: `facts:day:${scopeId}:app_count`,
          statement: count > 0
            ? `${count} apps were used on ${label}, from the corrected activity facts the Apps view reads.`
            : `No apps were used on ${label}, from the corrected activity facts the Apps view reads.`,
        })
        break
      }
      case 'site_count': {
        facts.push({
          id: `site_count:${scopeId}`,
          kind: request.kind,
          dimension: 'count',
          value: scope.siteCount,
          rendered: String(scope.siteCount),
          subject: `sites visited on ${label}`,
          identity: `facts:day:${scopeId}:site_count`,
          statement: scope.siteCount > 0
            ? `${scope.siteCount} sites were visited on ${label}, from the corrected website facts the Apps view reads.`
            : `No sites were visited on ${label}, from the corrected website facts the Apps view reads.`,
        })
        break
      }
      default:
        break
    }
  }

  return facts
}

// ─── Enforcement ─────────────────────────────────────────────────────────────

export interface DeterministicRepair {
  factId: string
  kind: DeterministicFactKind
  /** What the model wrote. */
  claimed: string
  /** What the corrected boundary computed, which replaced it. */
  corrected: string
}

export interface DeterministicEnforcement {
  text: string
  repairs: DeterministicRepair[]
  /** Facts the answer stated correctly, so inspection can show the figure was
   *  checked rather than merely unchallenged. */
  confirmed: DeterministicFact[]
}

/**
 * Make the computed value win.
 *
 * For each eligible fact, find what the answer stated in that dimension. If
 * any stated figure equals the computed one the answer already agrees with the
 * evidence and is left exactly as written. Otherwise the first stated figure is
 * replaced with the computed rendering, so a model that restated, rounded, or
 * invented a total cannot deliver that number to the person.
 *
 * An answer that states no figure at all is not repaired: there is no claim to
 * override, and splicing a number into prose that was answering something else
 * would corrupt a correct answer.
 */
export function enforceDeterministicFacts(
  text: string,
  facts: readonly DeterministicFact[],
  options: {
    /** Does this exchange's evidence back a figure of this value, for the fact
     *  being enforced? Durations arrive in seconds, counts as whole numbers.
     *  Without it every stated figure counts as unbacked and the first one is
     *  repaired. */
    isBacked?: (
      value: number,
      dimension: DeterministicDimension,
      kind: DeterministicFactKind,
    ) => boolean
  } = {},
): DeterministicEnforcement {
  const repairs: DeterministicRepair[] = []
  const confirmed: DeterministicFact[] = []
  if (!text || facts.length === 0) return { text, repairs, confirmed }
  const isBacked = options.isBacked ?? (() => false)

  let current = text
  for (const fact of facts) {
    const stated: StatedClaim[] = fact.dimension === 'duration'
      ? scanDurations(current).map((match) => ({
          start: match.start,
          end: match.end,
          text: match.text,
          value: match.seconds,
        }))
      : scanCountClaims(current, fact.kind)
    if (stated.length === 0) continue

    const tolerance = fact.dimension === 'duration' ? DURATION_TOLERANCE_SECONDS : 0
    if (stated.some((claim) => Math.abs(claim.value - fact.value) <= tolerance)) {
      confirmed.push(fact)
      continue
    }

    // Replace the first figure the exchange cannot back: that is the one the
    // model produced itself. Components quoted from evidence are left alone,
    // and when every stated figure is backed the answer never stated the
    // requested aggregate at all, so nothing is touched.
    const target = stated.find((claim) => !isBacked(claim.value, fact.dimension, fact.kind))
    if (!target) continue

    current = `${current.slice(0, target.start)}${fact.rendered}${current.slice(target.end)}`
    repairs.push({ factId: fact.id, kind: fact.kind, claimed: target.text, corrected: fact.rendered })
  }

  return { text: current, repairs, confirmed }
}

interface StatedClaim {
  start: number
  end: number
  text: string
  value: number
}

/** Count nouns per fact kind. A count claim is only ever a number attached to
 *  the thing being counted, never a bare integer: the digits inside a date, a
 *  clock time, or a duration must never be read as "how many apps". */
const COUNT_NOUNS: Partial<Record<DeterministicFactKind, string>> = {
  app_count: String.raw`(?:apps|app|applications|application|programs|program)`,
  site_count: String.raw`(?:sites|site|websites|website|domains|domain)`,
}

/** What a count fact counts, as a pattern to test a subject against. Shared
 *  with the evidence index so "6 apps" in an answer and "appCount: 6" in a tool
 *  result are recognised as claims about the same thing. */
export function countSubjectPattern(kind: DeterministicFactKind): RegExp | null {
  const noun = COUNT_NOUNS[kind]
  return noun ? new RegExp(String.raw`\b${noun}\b`, 'i') : null
}

const COUNT_QUALIFIERS = String.raw`(?:different\s+|distinct\s+|separate\s+|unique\s+|other\s+)?`

function scanCountClaims(text: string, kind: DeterministicFactKind): StatedClaim[] {
  const noun = COUNT_NOUNS[kind]
  if (!noun) return []
  const pattern = new RegExp(
    String.raw`\b(\d{1,6}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+${COUNT_QUALIFIERS}${noun}\b`,
    'gi',
  )
  const claims: StatedClaim[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const value = countValue(match[1])
    if (value == null) continue
    // Only the number is replaceable, so "12 different apps" keeps its wording.
    claims.push({ start: match.index, end: match.index + match[1].length, text: match[1], value })
  }
  return claims
}

const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}

function countValue(token: string): number | null {
  const word = COUNT_WORDS[token.toLowerCase()]
  if (word != null) return word
  const value = Number(token)
  return Number.isInteger(value) ? value : null
}

/**
 * The computed facts as a prompt section. The model is handed the figure it
 * must use before it writes, so enforcement is normally a no-op rather than a
 * rewrite; enforcement remains the guarantee, this is the courtesy.
 */
export function renderDeterministicFactsForAgent(facts: readonly DeterministicFact[]): string | null {
  if (facts.length === 0) return null
  return [
    'COMPUTED FACTS (authoritative).',
    'These are calculated from the same corrected activity facts the Timeline and Apps screens display.',
    'State each of these figures exactly as written here. Do not recalculate, re-round, or restate them from tool output.',
    '',
    ...facts.map((fact) => `- ${fact.subject}: ${fact.rendered}`),
  ].join('\n')
}
