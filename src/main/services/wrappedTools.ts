// Wrapped tool layer — typed data functions the AI calls to pull
// exactly what it needs for a wrap, instead of hoping one big prompt covers it.
//
// Each tool is a plain TypeScript function against the SAME trusted data the
// Timeline reads (invariant 7: one truth), tested against the real database,
// and exposed both to the in-app AI and to the MCP server through
// `executeWrappedTool`. Every result passes the same two boundaries as the
// chat tools (exclusion filtering + string sanitization) before leaving.
//
// Tools return null, never throw, when their source isn't available: no git,
// no calendar, an unanalyzed day. The wrap degrades honestly.

import type Database from 'better-sqlite3'
import type {
  CalendarSignal,
  GitActivitySignal,
  WorkContextBlock,
} from '@shared/types'
import { blockActiveSeconds } from '@shared/blockDuration'
import { effectiveBlockKind, kindForCategory, kindForDomain } from '@shared/workKind'
import { isTrustedTimelineBlock } from '@shared/timelineReview'
import { friendlyDomain } from '@shared/humanize'
import { clusterWindowTitles, type WindowTitleCluster } from '@shared/windowTitleContext'
import { sanitizeToolResult } from '@shared/aiSanitize'
import { filterTrackingExcludedEvidence } from '@shared/evidencePrivacy'
import { trackingControlsStateFromSettings, type TrackingControlsState } from '@shared/trackingControls'
import { looksLikeRawArtifactLabel } from '../../renderer/lib/wrappedFacts'
import { inferWorkIntent } from '@shared/workIntent'
import { localDateString, localDayBounds, shiftLocalDateString } from '../lib/localDate'
import { getSettings } from './settings'
import { getTimelineDayPayload } from './workBlocks'
import { buildDaySnapshot, isCurrentSnapshot } from '../lib/daySnapshot'
import { getDaySnapshotRowsForRange, getSessionsForRange } from '../db/queries'
import { getCorrectedDomainIntervals, getCorrectedSessionsForRange } from './activityFacts'
import { collectExternalSignals, getExternalSignal } from './externalSignals'
import { resolveDayMeetingReport, type DayMeetingReport } from './meetingResolution'
import type { DaySnapshot } from '@shared/types'

// ─── Small shared helpers ─────────────────────────────────────────────────────

function formatClock(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(' ', '')
    .toLowerCase()
}

function formatHm(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function trustedBlocks(db: Database.Database, date: string): WorkContextBlock[] {
  // The payload read path can attempt opportunistic writes (label finalizing,
  // identity backfills); on a read-only handle (tests, MCP) that throws. A day
  // that can't be read contributes nothing rather than failing the tool.
  try {
    const payload = getTimelineDayPayload(db, date, null)
    return payload.blocks
      .filter(isTrustedTimelineBlock)
      .filter((b) => b.dominantCategory !== 'system' && b.dominantCategory !== 'uncategorized')
      .slice()
      .sort((a, b) => a.startTime - b.startTime)
  } catch {
    return []
  }
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Day snapshots for a range against the PASSED db handle — read-only. Frozen
 *  rows are served as stored; days without a frozen row (today, never-frozen
 *  days) are computed live from the same trusted timeline blocks and never
 *  persisted here (the daySnapshots service owns freezing). */
function snapshotsForRange(db: Database.Database, startDate: string, endDate: string): DaySnapshot[] {
  const frozen = new Map(getDaySnapshotRowsForRange(db, startDate, endDate).map((s) => [s.date, s]))
  const out: DaySnapshot[] = []
  for (let date = startDate; date <= endDate; date = shiftLocalDateString(date, 1)) {
    const stored = frozen.get(date)
    // A frozen row from an older builder is stale by construction — recompute
    // live (read-only path: never persist here; the service owns refreezing).
    if (stored && isCurrentSnapshot(stored)) { out.push(stored); continue }
    const [fromMs, toMs] = localDayBounds(date)
    if (getSessionsForRange(db, fromMs, toMs).length === 0) continue
    try {
      out.push(buildDaySnapshot(getTimelineDayPayload(db, date, null)))
    } catch { /* a day that can't be read contributes nothing */ }
  }
  return out
}

// ─── getWindowTitleContext ────────────────────────────────────────────────────

export interface WindowTitleContextResult {
  date: string
  appName: string
  /** Semantic clusters, biggest first — grouped descriptions, never raw titles. */
  clusters: WindowTitleCluster[]
}

/** What the window titles say was being done in one app on one day, clustered
 *  into semantic groups ("billing service work, 6 sessions"), using the same
 *  humanization as timeline block naming. Null when the app had no sessions. */
export function getWindowTitleContext(
  params: { date: string; appName: string },
  db: Database.Database,
): WindowTitleContextResult | null {
  const [fromMs, toMs] = localDayBounds(params.date)
  const lookup = normalizeLookup(params.appName)
  if (!lookup) return null
  // The shared corrected session facts, not raw app_sessions: a deleted block's
  // titles or an excluded app's titles must never resurface in a wrap tool.
  const rows = getCorrectedSessionsForRange(db, fromMs, toMs)
    .filter((s) => s.windowTitle && s.windowTitle.trim() !== '')

  const matched = rows.filter((r) => {
    const rn = normalizeLookup(r.appName)
    return rn === lookup || rn.includes(lookup) || (rn.length >= 4 && lookup.includes(rn))
  })
  if (matched.length === 0) return null
  const appName = matched[0].appName
  const clusters = clusterWindowTitles(appName, matched.map((r) => ({
    windowTitle: r.windowTitle as string,
    durationSeconds: Math.max(0, r.durationSeconds),
  })))
  if (clusters.length === 0) return null
  return { date: params.date, appName, clusters }
}

// ─── getGitActivity / getCalendarEvents ───────────────────────────────────────

/** The day's git story (repos, commits, PRs) from the stored external signal,
 *  collecting fresh when nothing is stored yet. Null when git has nothing.
 *  `allowCollect: false` (the MCP subprocess, whose DB handle is read-only)
 *  reads stored signals only. */
export async function getGitActivity(
  params: { date: string },
  db: Database.Database,
  options: { allowCollect?: boolean } = {},
): Promise<GitActivitySignal | null> {
  let stored = getExternalSignal<GitActivitySignal>(db, params.date, 'git')
  if (!stored && (options.allowCollect ?? true)) {
    await collectExternalSignals(params.date)
    stored = getExternalSignal<GitActivitySignal>(db, params.date, 'git')
  }
  return stored?.payload ?? null
}

/** The day's meetings: the raw calendar events (names, durations, attendee
 *  counts — never attendee names) PLUS the DEV-189 day-level resolution
 *  (issue #3) — calendar-only / captured-only / matched buckets, so the agent
 *  never reports "no meeting signal" when captured meeting-app evidence
 *  supports one, and never presents a calendar entry as attended work.
 *  Null only when NEITHER source has anything. */
export async function getCalendarEvents(
  params: { date: string },
  db: Database.Database,
  options: { allowCollect?: boolean } = {},
): Promise<(CalendarSignal & { meetingReport: DayMeetingReport | null }) | null> {
  let stored = getExternalSignal<CalendarSignal>(db, params.date, 'calendar')
  if (!stored && (options.allowCollect ?? true)) {
    await collectExternalSignals(params.date)
    stored = getExternalSignal<CalendarSignal>(db, params.date, 'calendar')
  }
  const meetingReport = resolveDayMeetingReport(db, params.date)
  if (!stored?.payload && !meetingReport) return null
  return { events: stored?.payload.events ?? [], meetingReport }
}

// ─── getDayComparison ─────────────────────────────────────────────────────────

export interface DayComparisonResult {
  date: string
  trackedSeconds: number
  tracked: string
  /** Rolling average over the 7 days BEFORE this one (active days only). */
  sevenDayAverageSeconds: number | null
  sevenDayAverage: string | null
  /** Signed percent vs the average: +18 means 18% longer than usual. */
  vsAveragePct: number | null
  /** The same weekday one week earlier. */
  sameWeekdayLastWeekSeconds: number | null
  sameWeekdayLastWeek: string | null
  vsSameWeekdayPct: number | null
}

/** This day's tracked time against the 7-day rolling average and the same
 *  weekday last week — the evidence behind "this was a long one". */
export function getDayComparison(
  params: { date: string },
  db: Database.Database,
): DayComparisonResult | null {
  const weekAgo = shiftLocalDateString(params.date, -7)
  const dayBefore = shiftLocalDateString(params.date, -1)
  const snapshots = snapshotsForRange(db, weekAgo, params.date)
  const bySnapDate = new Map(snapshots.map((s) => [s.date, s]))

  const today = bySnapDate.get(params.date)
  if (!today || today.totalActiveSeconds <= 0) return null

  const priorActive = snapshots
    .filter((s) => s.date >= weekAgo && s.date <= dayBefore && s.totalActiveSeconds > 0)
  const avg = priorActive.length > 0
    ? Math.round(priorActive.reduce((s, snap) => s + snap.totalActiveSeconds, 0) / priorActive.length)
    : null
  const lastWeek = bySnapDate.get(weekAgo) ?? null
  const lastWeekSeconds = lastWeek && lastWeek.totalActiveSeconds > 0 ? lastWeek.totalActiveSeconds : null

  const pct = (current: number, base: number | null): number | null =>
    base && base > 0 ? Math.round(((current - base) / base) * 100) : null

  return {
    date: params.date,
    trackedSeconds: today.totalActiveSeconds,
    tracked: formatHm(today.totalActiveSeconds),
    sevenDayAverageSeconds: avg,
    sevenDayAverage: avg != null ? formatHm(avg) : null,
    vsAveragePct: pct(today.totalActiveSeconds, avg),
    sameWeekdayLastWeekSeconds: lastWeekSeconds,
    sameWeekdayLastWeek: lastWeekSeconds != null ? formatHm(lastWeekSeconds) : null,
    vsSameWeekdayPct: pct(today.totalActiveSeconds, lastWeekSeconds),
  }
}

// ─── getLongestFocusStretch ───────────────────────────────────────────────────

export interface LongestFocusStretchResult {
  date: string
  startClock: string
  endClock: string
  durationSeconds: number
  duration: string
  /** The app that carried the stretch. */
  primaryApp: string | null
  /** What the stretch was, named for the work when a clean name exists. */
  subject: string | null
  /** The label of the timeline block the stretch sits inside, when that block
   *  has a real name (never a live/part-of-day placeholder). */
  withinBlockLabel: string | null
}

const STRETCH_MIN_SECONDS = 20 * 60

// Labels the block builder assigns before Analyze has named anything. They
// locate a block in the day; they never name its work.
const PLACEHOLDER_LABELS = new Set([
  'active now', 'earlier today', 'late night', 'morning', 'afternoon', 'evening', 'night',
])

function isPlaceholderLabel(label: string): boolean {
  return PLACEHOLDER_LABELS.has(label.trim().toLowerCase())
}

// A focus run tolerates this much quiet between work sessions and this much
// non-work detour before it honestly stops being one stretch. Product
// decision: mirrors the wrapped standout's tolerances (dayWrapScenes.ts).
const FOCUS_MAX_IDLE_MS = 12 * 60_000
const FOCUS_DETOUR_BREAK_SECONDS = 5 * 60

/** The longest unbroken run of WORK-kind sessions in the day, with the run's
 *  REAL bounds — computed from session evidence beneath block granularity, so
 *  a live day that is still one open block gets an honest answer instead of
 *  the whole block's span. Only work-kind sessions count toward the duration;
 *  a personal-browsing or leisure session long enough to be a real detour
 *  breaks the run. */
export function getLongestFocusStretch(
  params: { date: string; minSeconds?: number },
  db: Database.Database,
): LongestFocusStretchResult | null {
  const minSeconds = params.minSeconds ?? STRETCH_MIN_SECONDS
  const blocks = trustedBlocks(db, params.date)
  const sessions = blocks
    .flatMap((block) => block.sessions)
    .filter((s) => s.durationSeconds > 0)
    .sort((a, b) => a.startTime - b.startTime)

  let best: { seconds: number; startMs: number; endMs: number } | null = null
  if (sessions.length > 0) {
    let run: { seconds: number; startMs: number; endMs: number } | null = null
    const close = (): void => {
      if (run && (!best || run.seconds > best.seconds)) best = run
      run = null
    }
    for (const session of sessions) {
      const sessionEnd = session.endTime ?? session.startTime + session.durationSeconds * 1000
      if (kindForCategory(session.category) !== 'work') {
        // Short non-work peeks neither break the run nor count toward it.
        if (session.durationSeconds >= FOCUS_DETOUR_BREAK_SECONDS) close()
        continue
      }
      if (run && session.startTime - run.endMs > FOCUS_MAX_IDLE_MS) close()
      if (!run) run = { seconds: 0, startMs: session.startTime, endMs: sessionEnd }
      run.seconds += session.durationSeconds
      run.endMs = Math.max(run.endMs, sessionEnd)
    }
    close()
  } else {
    // No session evidence anywhere (old stored days): fall back to the longest
    // work-kind block whose active time fills its span.
    for (const block of blocks) {
      if (effectiveBlockKind(block) !== 'work') continue
      const seconds = blockActiveSeconds(block)
      const spanSeconds = Math.max(1, Math.round((block.endTime - block.startTime) / 1000))
      if (seconds < spanSeconds * 0.8) continue
      if (!best || seconds > best.seconds) best = { seconds, startMs: block.startTime, endMs: block.endTime }
    }
  }
  if (!best || best.seconds < minSeconds) return null
  const runResult: { seconds: number; startMs: number; endMs: number } = best

  // The block covering the run, for naming. Overlap, not containment: a run
  // may straddle a block seam.
  const covering = blocks
    .filter((b) => b.startTime < runResult.endMs && b.endTime > runResult.startMs)
    .sort((a, b) =>
      (Math.min(b.endTime, runResult.endMs) - Math.max(b.startTime, runResult.startMs))
      - (Math.min(a.endTime, runResult.endMs) - Math.max(a.startTime, runResult.startMs)))[0] ?? null

  const appSeconds = new Map<string, number>()
  for (const s of sessions) {
    if (s.startTime >= runResult.endMs || (s.endTime ?? s.startTime + s.durationSeconds * 1000) <= runResult.startMs) continue
    if (kindForCategory(s.category) !== 'work') continue
    appSeconds.set(s.appName, (appSeconds.get(s.appName) ?? 0) + s.durationSeconds)
  }
  const primaryApp = [...appSeconds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? covering?.topApps.filter((a) => a.category !== 'system')[0]?.appName
    ?? null
  const intentSubject = covering ? inferWorkIntent(covering).subject?.trim() : null
  const label = intentSubject || covering?.review?.correctedLabel?.trim() || covering?.label.current.trim() || ''
  const cleanLabel = label && !looksLikeRawArtifactLabel(label) && !isPlaceholderLabel(label) ? label : null
  return {
    date: params.date,
    startClock: formatClock(runResult.startMs),
    endClock: formatClock(runResult.endMs),
    durationSeconds: runResult.seconds,
    duration: formatHm(runResult.seconds),
    primaryApp,
    subject: cleanLabel,
    withinBlockLabel: cleanLabel,
  }
}

// ─── getDistractionProfile ────────────────────────────────────────────────────

export interface DistractionProfileResult {
  date: string
  /** Time in leisure-kind blocks and leisure sites (entertainment, social). */
  highDistractionSeconds: number
  highDistraction: string
  /** Everything else that was tracked (work + personal). */
  lowDistractionSeconds: number
  lowDistraction: string
  /** The leisure surfaces that appeared, with reconciled time, biggest first. */
  sites: Array<{ name: string; seconds: number; time: string }>
}

/** The honest split between high-distraction and low-distraction time, plus
 *  which distraction surfaces appeared and for how long. Never a score. */
export function getDistractionProfile(
  params: { date: string },
  db: Database.Database,
): DistractionProfileResult | null {
  const blocks = trustedBlocks(db, params.date)
  if (blocks.length === 0) return null
  let leisure = 0
  let other = 0
  for (const block of blocks) {
    const kind = effectiveBlockKind(block)
    if (kind === 'idle') continue
    const seconds = blockActiveSeconds(block)
    if (kind === 'leisure') leisure += seconds
    else other += seconds
  }

  // Per-site time via the CORRECTED interval reader (never raw SUM): the same
  // deletion/exclusion ledger Timeline and Apps honor, restricted to
  // leisure-kind domains.
  const [fromMs, toMs] = localDayBounds(params.date)
  const siteSeconds = new Map<string, number>()
  for (const interval of getCorrectedDomainIntervals(db, fromMs, toMs, (domain) => kindForDomain(domain) === 'leisure')) {
    const name = friendlyDomain(interval.domain) || interval.domain
    siteSeconds.set(name, (siteSeconds.get(name) ?? 0) + (interval.end - interval.start) / 1000)
  }
  const sites = [...siteSeconds.entries()]
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds), time: formatHm(seconds) }))
    .filter((s) => s.seconds >= 60)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 8)

  return {
    date: params.date,
    highDistractionSeconds: Math.round(leisure),
    highDistraction: formatHm(leisure),
    lowDistractionSeconds: Math.round(other),
    lowDistraction: formatHm(other),
    sites,
  }
}

// ─── getMostSurprisingFact ────────────────────────────────────────────────────

export interface SurprisingFactResult {
  date: string
  kind: 'forgottenApp' | 'newApp' | 'unusualStart' | 'unusualEnd' | 'stretchRecord' | 'volumeOutlier'
  /** The load-bearing display value ("1h 24m", "6:12am"). */
  value: string
  /** Plain-language description of why this is surprising. */
  caption: string
  /** Normalized surprise score — how far this sits from the user's baseline. */
  score: number
}

const SURPRISE_FLOOR = 0.6
const BASELINE_DAYS = 28

interface SurpriseCandidate extends Omit<SurprisingFactResult, 'date'> { score: number }

/** The single most likely-to-surprise true fact of the day. Surprise is
 *  DEVIATION FROM THIS USER'S OWN BASELINE, not a
 *  generic expectation: the app they forgot, the unusually early start against
 *  their own weekday median, the stretch that beats their trailing record. A
 *  boring day returns null — a forced fact is worse than none. */
export function getMostSurprisingFact(
  params: { date: string },
  db: Database.Database,
): SurprisingFactResult | null {
  const baselineStart = shiftLocalDateString(params.date, -BASELINE_DAYS)
  const dayBefore = shiftLocalDateString(params.date, -1)
  const snapshots = snapshotsForRange(db, baselineStart, params.date)
  const today = snapshots.find((s) => s.date === params.date)
  if (!today || today.totalActiveSeconds <= 0) return null
  const prior = snapshots.filter((s) => s.date <= dayBefore && s.totalActiveSeconds > 0)

  const candidates: SurpriseCandidate[] = []

  // a. The forgotten app: real time outside the top 3, never a headline act.
  const rankedApps = today.apps.filter((a) => !looksLikeRawArtifactLabel(a.appName))
  const forgotten = rankedApps.slice(3).find((a) => a.seconds >= 20 * 60)
  if (forgotten) {
    candidates.push({
      kind: 'forgottenApp',
      value: formatHm(forgotten.seconds),
      caption: `${forgotten.appName} quietly took ${formatHm(forgotten.seconds)} without ever being the main thing`,
      score: forgotten.seconds / 3600,
    })
  }

  // b. A new app: real time today, absent the prior two weeks.
  const fortnight = new Set(
    prior.filter((s) => s.date >= shiftLocalDateString(params.date, -14))
      .flatMap((s) => s.apps.map((a) => a.appName.toLowerCase())),
  )
  if (prior.length >= 5) {
    const newcomer = rankedApps.find((a) => a.seconds >= 15 * 60 && !fortnight.has(a.appName.toLowerCase()))
    if (newcomer) {
      candidates.push({
        kind: 'newApp',
        value: formatHm(newcomer.seconds),
        caption: `${newcomer.appName} showed up for the first time in two weeks and took ${formatHm(newcomer.seconds)}`,
        score: newcomer.seconds / 1800,
      })
    }
  }

  // c/d. Unusually early start / late end vs this weekday's own median edges.
  const [yy, mm, dd] = params.date.split('-').map(Number)
  const weekday = new Date(yy, mm - 1, dd).getDay()
  const edges = dayEdges(db, params.date)
  if (edges) {
    const sameWeekdayDates = prior
      .filter((s) => {
        const [y, m, d] = s.date.split('-').map(Number)
        return new Date(y, m - 1, d).getDay() === weekday
      })
      .map((s) => s.date)
    const priorEdges = sameWeekdayDates.map((d) => dayEdges(db, d)).filter((e): e is DayEdges => e !== null)
    if (priorEdges.length >= 2) {
      const medianStart = median(priorEdges.map((e) => e.startMinutes))
      const medianEnd = median(priorEdges.map((e) => e.endMinutes))
      const startDelta = medianStart - edges.startMinutes // positive = earlier than usual
      if (Math.abs(startDelta) >= 45) {
        candidates.push({
          kind: 'unusualStart',
          value: edges.startClock,
          caption: startDelta > 0
            ? `the day started ${formatHm(Math.abs(startDelta) * 60)} earlier than your usual ${dayName(weekday)}`
            : `the day started ${formatHm(Math.abs(startDelta) * 60)} later than your usual ${dayName(weekday)}`,
          score: Math.abs(startDelta) / 90,
        })
      }
      const endDelta = edges.endMinutes - medianEnd // positive = later than usual
      if (Math.abs(endDelta) >= 45) {
        candidates.push({
          kind: 'unusualEnd',
          value: edges.endClock,
          caption: endDelta > 0
            ? `the last activity landed ${formatHm(Math.abs(endDelta) * 60)} later than your usual ${dayName(weekday)}`
            : `the day wrapped up ${formatHm(Math.abs(endDelta) * 60)} earlier than your usual ${dayName(weekday)}`,
          score: Math.abs(endDelta) / 90,
        })
      }
    }
  }

  // e. A stretch record: today's longest block beats the trailing record.
  const todayStretch = today.longestBlock?.seconds ?? 0
  const priorRecord = Math.max(0, ...prior.map((s) => s.longestBlock?.seconds ?? 0))
  if (todayStretch >= 45 * 60 && priorRecord > 0 && todayStretch > priorRecord) {
    candidates.push({
      kind: 'stretchRecord',
      value: formatHm(todayStretch),
      caption: `your longest unbroken stretch in the last ${BASELINE_DAYS} days`,
      score: todayStretch / priorRecord,
    })
  }

  // f. A volume outlier: the day total far from the trailing 7-day average.
  const recent = prior.filter((s) => s.date >= shiftLocalDateString(params.date, -7))
  if (recent.length >= 3) {
    const avg = recent.reduce((s, snap) => s + snap.totalActiveSeconds, 0) / recent.length
    if (avg > 0) {
      const ratio = today.totalActiveSeconds / avg
      if (ratio >= 1.5 || ratio <= 0.5) {
        candidates.push({
          kind: 'volumeOutlier',
          value: formatHm(today.totalActiveSeconds),
          caption: ratio >= 1.5
            ? `about ${Math.round((ratio - 1) * 100)}% more than a typical recent day`
            : `about ${Math.round((1 - ratio) * 100)}% less than a typical recent day`,
          score: Math.abs(ratio - 1),
        })
      }
    }
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0]
  if (!best || best.score < SURPRISE_FLOOR) return null
  return { date: params.date, ...best, score: Math.round(best.score * 100) / 100 }
}

interface DayEdges { startMinutes: number; endMinutes: number; startClock: string; endClock: string }

const SPILLOVER_MAX_SECONDS = 45 * 60

function dayEdges(db: Database.Database, date: string): DayEdges | null {
  let blocks = trustedBlocks(db, date).filter((b) => effectiveBlockKind(b) !== 'idle')
  if (blocks.length === 0) return null
  // A short pre-dawn sliver followed by a real day is LAST night's tail, not
  // this day's start (same rule as the facts builder) — without this, the
  // 12:00-12:24am spillover reads as "the day started at midnight" and every
  // baseline comparison against it is nonsense.
  while (blocks.length > 1) {
    const head = blocks[0]
    const startsPreDawn = new Date(head.startTime).getHours() < 5
    const isSliver = blockActiveSeconds(head) < SPILLOVER_MAX_SECONDS
    const realDayFollows = new Date(blocks[1].startTime).getHours() >= 5
    if (startsPreDawn && isSliver && realDayFollows) blocks = blocks.slice(1)
    else break
  }
  const first = blocks[0].startTime
  const last = blocks[blocks.length - 1].endTime
  const minutes = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes() }
  return {
    startMinutes: minutes(first),
    endMinutes: minutes(last),
    startClock: formatClock(first),
    endClock: formatClock(last),
  }
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function dayName(weekday: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday] ?? 'day'
}

// ─── Dispatch (in-app AI + MCP) ───────────────────────────────────────────────

export type WrappedToolName =
  | 'getWindowTitleContext'
  | 'getGitActivity'
  | 'getCalendarEvents'
  | 'getDayComparison'
  | 'getLongestFocusStretch'
  | 'getDistractionProfile'
  | 'getMostSurprisingFact'

export const WRAPPED_TOOL_NAMES: readonly WrappedToolName[] = [
  'getWindowTitleContext', 'getGitActivity', 'getCalendarEvents', 'getDayComparison',
  'getLongestFocusStretch', 'getDistractionProfile', 'getMostSurprisingFact',
]

export function isWrappedToolName(name: string): name is WrappedToolName {
  return (WRAPPED_TOOL_NAMES as readonly string[]).includes(name)
}

/** Name→function dispatch with the same two exit boundaries as executeTool
 *  (exclusion filtering, then string sanitization). Async because the git and
 *  calendar tools may collect their signal on first call. */
export async function executeWrappedTool(
  name: WrappedToolName,
  params: Record<string, unknown>,
  db: Database.Database,
  controls: TrackingControlsState = trackingControlsStateFromSettings(getSettings()),
  options: { allowCollect?: boolean } = {},
): Promise<unknown> {
  const date = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : localDateString()
  const raw = await (async () => {
    switch (name) {
      case 'getWindowTitleContext':
        return getWindowTitleContext({ date, appName: String(params.appName ?? '') }, db)
      case 'getGitActivity':
        return getGitActivity({ date }, db, options)
      case 'getCalendarEvents':
        return getCalendarEvents({ date }, db, options)
      case 'getDayComparison':
        return getDayComparison({ date }, db)
      case 'getLongestFocusStretch':
        return getLongestFocusStretch({ date }, db)
      case 'getDistractionProfile':
        return getDistractionProfile({ date }, db)
      case 'getMostSurprisingFact':
        return getMostSurprisingFact({ date }, db)
    }
  })()
  return sanitizeToolResult(filterTrackingExcludedEvidence(raw, controls))
}
