import type Database from 'better-sqlite3'
import crypto from 'node:crypto'
import {
  getActivityStateEventsForRange,
  getBlockLabelOverride,
  getFocusSessionsForDateRange,
  getReconciledWebsiteVisitsForRange,
  getTopPagesForDomains,
  getWebsiteVisitsForRange,
  getWebsiteSummariesForRange,
  getWorkContextInsightForRange,
  getDistractionByMonth,
  getDistractionByHour,
  getDistractionByDomain,
  getDaysTracked,
  deleteDaySnapshotRow,
  type WebsiteVisitRecord,
} from '../db/queries'
import { deleteWrappedNarrativesForDate } from '../db/wrappedNarrativeStore'
import { entitiesForDayWrap } from './entities/dayEntities'
import { isWorkIntentRole } from '@shared/types'
import type {
  AppDetailPayload,
  AppCategory,
  AppSession,
  ArtifactRef,
  BlockBoundary,
  BlockConfidence,
  BoundaryReason,
  DayTimelinePayload,
  DayWrapEntity,
  DistractionCostPayload,
  DocumentRef,
  HistoryDayPayload,
  LiveSession,
  PageRef,
  TimelineEvidenceSummary,
  TimelineGapSegment,
  TimelineSegment,
  TimelineBlockReview,
  TimelineBlockReviewState,
  TimelineBlockReviewUpdate,
  TimelineScheduledMeeting,
  CalendarSignal,
  WorkflowPattern,
  WorkflowRef,
  WorkContextAppSummary,
  WorkContextBlock,
  LabelSource,
  WorkIntentRole,
  WebsiteSummary,
} from '@shared/types'
import { DISTRACTION_DOMAINS, FOCUSED_CATEGORIES, isAppCategory } from '@shared/types'
import { isAppFocused } from '../lib/focusScore'
import { getSettings } from './settings'
import { isHostFilteredFromArtifacts, isHostBlockedForLabel, isHostBlockedForAppsRail, policyForHost } from '@shared/domainPolicy'
import { categoryForDomain } from '@shared/domainCategories'
import { blockActiveSeconds } from '@shared/blockDuration'
import { looksLikeRawArtifactLabel } from '@shared/blockLabel'
import { activityCategoryLabel } from '@shared/activityCategories'
import { DEFAULT_TIMELINE_BLOCK_REVIEW, isTimelineBlockReviewState, isTrustedTimelineBlock } from '@shared/timelineReview'
import { inferWorkIntent } from '@shared/workIntent'
import { isSystemNoiseTitle } from '@shared/systemNoise'
import { resolveKind, dominantKind, effectiveBlockKind, kindForCategory, kindForDomain, type WorkKind } from '@shared/workKind'
import { humanizeTitle, leisureActivityTitle } from '@shared/humanize'
import { daysFromTodayLocalDateString, localDayBounds, localDateString } from '../lib/localDate'
import { REAL_ABSENCE_MIN_MS, absenceSpannedBy, formatAbsenceRange, isRealAbsenceGap } from '../lib/absenceGuard'
import { ownedDayBounds } from '../lib/dayOwnership'
import { deriveWorkEvidenceSummary } from '../lib/workEvidence'
import { extractFilenames } from '../lib/windowTitleFilenames'
import {
  normalizeUrlForStorage,
  normalizeWebsiteTitleForDisplay,
  resolveCanonicalApp,
  titleLooksUseful,
  websiteDisplayLabel,
} from '../lib/appIdentity'
import {
  extractProjectHintFromEvidence,
  gatherConcurrentEvidence,
  matchPromotedPatterns,
  memoryEnabled,
} from './workMemory'
import { isBrowserApplication } from './browserRegistry'
import { getBackgroundProcessEvidence } from './backgroundProcessEvidence'
import { filterExcludedWebsiteSummaries, getCorrectedWebsiteSummariesForRange } from './activityFacts'
import { queryCorrectedActivityFactsForRange } from '../core/query/activityFactsQuery'
import { getSecondaryDisplayVisibleSpansForRange } from '../core/projections/displayVisibility'
import { getExternalSignal } from './externalSignals'
import {
  capturedMeetingSpansFromBlocks,
  getMeetingAttendanceMarks,
  matchDayMeetings,
  scheduledMeetingsFromSignal,
  scheduledParticipantsForDay,
} from './meetingResolution'

/**
 * Sanitize a label that might be a raw file path or bundle path.
 * e.g. "/System/Volumes/.../Safari.app/Contents/MacOS/Safari" → "Safari"
 * Returns null if the result is still not display-worthy.
 */
export function sanitizeBlockLabel(label: string | null | undefined): string | null {
  if (!label) return null
  // Path-like strings: contain slashes and likely contain an app path segment
  if ((label.includes('/') || label.includes('\\')) && label.length > 40) {
    // Try to extract the last meaningful path component (strip .app/.exe suffix)
    const parts = label.replace(/\\/g, '/').split('/')
    const appPart = parts.find((p) => p.endsWith('.app')) ?? parts.find((p) => p.endsWith('.exe'))
    if (appPart) {
      const name = appPart.replace(/\.(app|exe)$/i, '')
      if (name.length > 0) return name
    }
    // Try the last non-empty segment
    const lastName = parts.filter(Boolean).pop()
    if (lastName && lastName.length > 0 && !lastName.includes(':')) return lastName
    return null
  }
  return label
}

/**
 * Timeline policy: split at meetings, work-kind changes, sustained context shifts,
 * and real absences; merge only contiguous related work within the span ceiling.
 * Labels prefer user edits, then AI, memory, artifacts/pages, and app context.
 * Gaps state asleep, locked, idle, paused, or missing capture explicitly.
 * User renames and boundary corrections remain authoritative across rebuilds.
 */
// The single "session break" rule (supersedes the earlier 45-minute rule): a
// real gap in activity of roughly 15 minutes or
// more ENDS the current block. The gap is never absorbed into a block; it
// renders as blank space on the timeline, and a new block starts only once
// real activity resumes. A block's duration is the time the user was genuinely
// active, never the wall-clock span across an idle lull.
// Derived from the one shared absence guard (lib/absenceGuard.ts) so no local
// tweak can quietly diverge from the rule every merge path enforces.
const IDLE_GAP_THRESHOLD_MS = REAL_ABSENCE_MIN_MS
const MEETING_THRESHOLD_SEC = 20 * 60
const LONG_SINGLE_APP_THRESHOLD_SEC = 45 * 60
const BRIEF_INTERRUPTION_THRESHOLD_SEC = 3 * 60
const SUSTAINED_CATEGORY_THRESHOLD_SEC = 15 * 60
const COMMUNICATION_INTERRUPTION_THRESHOLD_SEC = 5 * 60
const FAST_SWITCH_THRESHOLD_SEC = 5 * 60
const SLOW_SWITCH_THRESHOLD_SEC = 15 * 60
// A *clear, sustained* switch to a different goal is a real boundary
// (timeline.md §3.1). Short detours below the §3.2 cutoff never reach here —
// they are absorbed by the brief-peek pass (BRIEF_PEEK_MAX_ACTIVE_MS) — so this
// floor stays at a genuine-topic-run length, not the detour cutoff.
const SUSTAINED_CONTEXT_SHIFT_THRESHOLD_SEC = 5 * 60
// Block-sizing: the target shape is a large, readable calendar block — 1, 2,
// 3, even 5 hours — never a string of 20-minute slices. The base ceiling sits
// at 180 min so a sustained stretch of the same work is not chopped at 2h, and
// the coalesce pass below re-joins adjacent fragments of the same work up to
// this same ceiling.
const TIMELINE_MAX_BLOCK_SPAN_MS = 180 * 60_000
// Blocks shorter than this are pure noise on the timeline (e.g. a 50-second
// "Terminal work" sliver). They are unconditionally merged into an adjacent
// block instead of being shown standalone.
const TIMELINE_MIN_BLOCK_SPAN_MS = 5 * 60_000
// A block under 30 minutes should generally not stand on its own as a calendar
// block — a focused stretch reads as continuous work, not a string of
// sub-half-hour slices. Blocks in the [5min, 30min) band are folded into a
// semantically related neighbour (same work, or the same continued app), but
// only when such a neighbour exists; an isolated 20-minute activity bounded by
// real gaps stays standalone rather than being forced into something unrelated.
const TIMELINE_MIN_STANDALONE_SPAN_MS = 30 * 60_000
// The hard calendar floor (timeline.md §3.4 / DEV-99): no block under fifteen
// minutes ever stands on its own. A briefer stretch isn't a block — it's a
// moment that belongs folded into the work around it. The passes above only
// fold a short block into a *related* / same-kind neighbour, so an off-kind
// sliver (a 35-second Spotify+Pasty blip between two work blocks) survives them.
// The final enforceMinimumBlockFloor pass closes that gap: it folds any sub-floor
// non-meeting block into its nearest sensible neighbour unconditionally. The only
// blocks that may stay under the floor are a meeting (a 10-minute standup is real)
// and a lone short block with no non-meeting neighbour to fold into.
const TIMELINE_MIN_BLOCK_FLOOR_MS = 15 * 60_000
// The widest gap a sub-floor sliver may fold ACROSS into a neighbour. A sliver
// absorbs into a nearby neighbour across a brief lull, but never across a real
// break: a 24-second 1:56am blip must not fold into the 9:41am block and make
// one 11-hour phantom starting at 2am. Aligned with the 15-minute session
// break: a gap of 15+ minutes is never absorbed into any block.
const TIMELINE_SLIVER_FOLD_MAX_GAP_MS = REAL_ABSENCE_MIN_MS
// The same work continued across a brief untracked lull is one block, not two.
// A short pause in the middle of a coding morning should not split one Ghostty
// session into "Terminal work" and a separate block. Two stretches of the same
// dominant app doing related work bridge a gap up to this size, even across a
// coarse-segment boundary. Aligned with the 15-minute session break: a real
// gap (15+ minutes away) always stays split — it is blank space, not work.
const TIMELINE_SAME_WORK_BRIDGE_GAP_MS = REAL_ABSENCE_MIN_MS
// Higher ceiling for candidates where every session shares the same
// (bundleId, compacted window title) pair with no internal gap >= 5 min.
// Quality bar: a 90-minute block titled "Daylens AI refactor — extract
// chat_answer from ai.ts" is the right answer, not three 30-minute slices
// labelled "Cursor" / "Cursor" / "Untitled block".
const TIMELINE_MAX_COHERENT_BLOCK_SPAN_MS = 300 * 60_000
const TIMELINE_MAX_ASSISTED_WORK_SPAN_MS = 360 * 60_000
const TIMELINE_SPLIT_GAP_THRESHOLD_MS = 5 * 60_000
const TIMELINE_MIN_CHILD_SPAN_MS = 15 * 60_000
// Bumped to v9 with: the 15-minute session break (a real activity gap of
// 15+ minutes ends the block, is never absorbed, and renders as blank
// space; a new block starts only when activity resumes),
// the same-work bridge and sliver-fold caps aligned to the same 15 minutes,
// the live provisional day split into one provisional block per continuous
// sitting instead of one whole-day card, and suspiciously long unbroken
// blocks flagged in the logs instead of trusted silently.
//
// Bumped to v8 with: the 45-minute session break (away under 45 min stays
// inside one continuous block; 45+ min starts a new one), larger block
// ceilings (3h base / 5h coherent / 6h assisted), the floor-pass fold guard
// fixed so fragmented days can't leave sub-15-minute slivers behind, and merge
// corrections keyed by time span so they survive the app_sessions ↔
// derived_sessions id-namespace flip.
//
// Bumped to v7 with: short-block absorption is based on active tracked time
// instead of wall-clock span, uncategorized AI/dev tools are treated as focused
// timeline evidence, GitHub repo/review pages badge as research, and
// deterministic artifact labels are now AI-reanalysis targets instead of being
// marked stable forever.
//
// Bumped to v6 with: focused-work category ownership over incidental browsing,
// hard activity-state boundaries for the coarse idle cut, drift categories
// never bridge across gaps, and AI relabeling as the primary path
// for deterministic floor labels.
// (NON_BRIDGEABLE_CATEGORIES), work-memory "<project> development" labels gated
// to focused-work-dominant blocks, and project hints grounded only in real code
// signals (file activity, code repos, localhost dev servers). Past days
// persisted under an older version are reconstructed on revisit (see
// buildTimelineBlocksForDay) so the stale "Canva development" / "Notifications
// development" labels get replaced — unless the day was already AI/user
// processed, in which case that curated result is kept and its IDs stay stable.
// v10: site-weighted category distribution (browser sessions split across the
// categories of the sites reconciled inside the block; Dia recataloged
// browsing) — the bump makes refreshStaleBlockCategoryFacts recompute the
// persisted category facts of every already-processed day in place, so old
// blocks pick up their real colors immediately (labels/boundaries untouched).
const TIMELINE_HEURISTIC_VERSION = 'timeline-v10'

// A single unbroken block this long is almost never real (~11 hours of
// continuous engagement is suspicious on its face) — it usually means
// idle/away detection failed somewhere in the span. Flag it in the logs
// rather than trusting it silently.
const SUSPICIOUS_UNBROKEN_BLOCK_SPAN_MS = 6 * 60 * 60_000

type FormationReason = 'coherent' | 'heuristic' | 'mixed' | 'meeting' | 'longSingleApp'

interface EffectiveSession {
  session: AppSession
  effectiveCategory: AppCategory
}

interface CoarseSegment {
  sessions: AppSession[]
  boundedBeforeGap: boolean
  boundedAfterGap: boolean
}

interface CandidateBlock {
  sessions: AppSession[]
  formation: FormationReason
  boundedBeforeGap: boolean
  boundedAfterGap: boolean
  // A brief detour may be absorbed into one neighboring intent without
  // joining two genuinely different intents around it.
  forcedBoundaryBefore?: boolean
  forcedLabel?: string
  // Set by the boundary-scoring reconciliation pass: why this candidate's
  // start and end edges were cut. Projected onto the block as `boundary`.
  startReasons?: BoundaryReason[]
  endReasons?: BoundaryReason[]
}

interface CategoryRun {
  category: AppCategory
  startIndex: number
  totalSeconds: number
}

interface AppStreak {
  range: [number, number]
  targetDurationSeconds: number
  label: string
}

interface ContextRun {
  context: string
  startIndex: number
  totalSeconds: number
}

interface ArtifactCandidate {
  artifact: ArtifactRef
  pageRef?: PageRef
  documentRef?: DocumentRef
  sourceType: 'website_visit' | 'app_session'
  sourceId: string
  startTime: number
  endTime: number
}

interface PersistedWorkflow {
  workflow: WorkflowRef
  artifactKeys: string[]
}

export interface AppDetailBlockSlice {
  id: string
  startTime: number
  endTime: number
  dominantCategory: AppCategory
  label: {
    current: string
  }
  topApps: WorkContextAppSummary[]
  topArtifacts: ArtifactRef[]
  pageRefs: PageRef[]
  workflowRefs: WorkflowRef[]
}

const GENERIC_LABELS = new Set([
  'AI Tools',
  'Browsing',
  'Communication',
  'Design',
  'Development',
  'Email',
  'Insufficient Data',
  'Insufficient Data For Label',
  'Meetings',
  'Mixed Work',
  'Productivity',
  'Research',
  'Research & AI Chat',
  'System',
  'Uncategorized',
  'Web Session',
  'Writing',
])

// Whether a session is a browser is fully determined by (category, bundleId,
// appName). The fallback to isBrowserApplication() shells out to plutil and the
// LaunchServices registry, and this predicate is called many times per session
// across the block-building pipeline. Re-resolving it per call made it the
// single hottest path when building today's timeline (~35% of a 2.8s build).
// Memoize so each distinct identity pays the filesystem cost at most once.
const isBrowserSessionCache = new Map<string, boolean>()
const IS_BROWSER_CACHE_LIMIT = 5000

export function isBrowserSession(session: Pick<AppSession, 'bundleId' | 'appName' | 'category'>): boolean {
  const cacheKey = `${session.category} ${session.bundleId} ${session.appName}`
  const cached = isBrowserSessionCache.get(cacheKey)
  if (cached !== undefined) return cached

  const result = computeIsBrowserSession(session)

  if (isBrowserSessionCache.size >= IS_BROWSER_CACHE_LIMIT) {
    isBrowserSessionCache.clear()
  }
  isBrowserSessionCache.set(cacheKey, result)
  return result
}

function computeIsBrowserSession(session: Pick<AppSession, 'bundleId' | 'appName' | 'category'>): boolean {
  if (session.category === 'browsing') return true
  const identity = resolveCanonicalApp(session.bundleId, session.appName)
  if (identity.isBrowser || identity.defaultCategory === 'browsing') return true
  return (process.platform === 'darwin' || process.platform === 'win32') && isBrowserApplication({
    bundleId: session.bundleId,
    appName: session.appName,
    executablePath: session.bundleId,
  })
}

export function prettyCategory(category: AppCategory): string {
  return activityCategoryLabel(category)
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

export function localDateKeyForTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function appCategoryIsFocused(category: AppCategory): boolean {
  return FOCUSED_CATEGORIES.includes(category)
}

export function dominantCategoryFromDistribution(distribution: Partial<Record<AppCategory, number>>): AppCategory {
  const entries = Object.entries(distribution) as Array<[AppCategory, number]>
  return entries
    .sort((left, right) => {
      if (left[1] === right[1]) {
        if (appCategoryIsFocused(left[0]) !== appCategoryIsFocused(right[0])) {
          return appCategoryIsFocused(left[0]) ? -1 : 1
        }
        return left[0].localeCompare(right[0])
      }
      return right[1] - left[1]
    })[0]?.[0] ?? 'uncategorized'
}

// Productivity SaaS whose page titles carry real work intent — a Notion doc,
// a Google Doc, a Linear issue. Recognizing these gives intentional web work a
// category signal (invariant 6): without it a Notion review inside a browser
// counts only as "browsing" and can never defend itself against an
// entertainment page artifact that happens to out-dwell it.
const PRODUCTIVITY_SAAS_HOSTS = new Set([
  'notion.so',
  'notion.com',
  'app.notion.com',
  'docs.google.com',
  'sheets.google.com',
  'slides.google.com',
  'linear.app',
  'coda.io',
  'quip.com',
])
const PRODUCTIVITY_SAAS_SUFFIXES = ['.notion.site', '.notion.so', '.notion.com']

function isProductivitySaasHost(host: string): boolean {
  if (!host) return false
  if (PRODUCTIVITY_SAAS_HOSTS.has(host)) return true
  return PRODUCTIVITY_SAAS_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

function categoryForTopPageArtifact(topArtifacts: ArtifactRef[]): AppCategory | null {
  const topArtifact = topArtifacts[0]
  if (!topArtifact || topArtifact.artifactType !== 'page') return null

  const page = topArtifact as PageRef
  const policy = policyForHost(page.domain ?? topArtifact.host ?? null)
  if (policy === 'social_feed') return 'social'
  if (policy === 'entertainment') return 'entertainment'
  const host = (page.domain ?? page.host ?? '').toLowerCase().replace(/^www\./, '')
  const url = page.normalizedUrl ?? page.url ?? ''
  if (host === 'github.com' && /^https?:\/\/github\.com\/[^/?#]+\/[^/?#]+(?:[/?#]|$)/i.test(url)) {
    return 'research'
  }
  if (isProductivitySaasHost(host)) return 'productivity'
  return null
}

function dominantFocusedCategoryFromDistribution(distribution: Partial<Record<AppCategory, number>>): AppCategory | null {
  const entries = Object.entries(distribution) as Array<[AppCategory, number]>
  const total = entries.reduce((sum, [, seconds]) => sum + seconds, 0)
  if (total <= 0) return null

  const focusedEntries = entries
    .filter(([category]) => FOCUSED_CATEGORIES.includes(category) && category !== 'browsing')
    .sort((left, right) => right[1] - left[1])
  if (focusedEntries.length === 0) return null

  // timeline.md §3.6: the category comes from the block's *overall* intent, not
  // a single app or tab. The largest focused sub-category names the block when
  // either (a) it alone clears the bar — the original rule — or (b) focused work
  // is the *majority* of the block, so a stretch split across coding + writing +
  // AI tools with a brief Netflix/X peek folded in still reads as work. The
  // majority test is what stops a genuinely leisure-dominant block (e.g. 65%
  // entertainment, 35% scattered work) from being mislabeled as work.
  const focusedTotal = focusedEntries.reduce((sum, [, seconds]) => sum + seconds, 0)
  const largestFocusedShare = focusedEntries[0][1] / total
  if (largestFocusedShare >= 0.3 || focusedTotal / total >= 0.5) return focusedEntries[0][0]
  return null
}

function isLocalhostArtifact(artifact: ArtifactRef): boolean {
  if (artifact.artifactType !== 'page' && artifact.artifactType !== 'domain') return false
  const host = artifact.host ?? (artifact as { domain?: string | null }).domain ?? null
  return typeof host === 'string' && /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i.test(host)
}

function hasLocalhostPageArtifact(topArtifacts: ArtifactRef[]): boolean {
  return topArtifacts.some(isLocalhostArtifact)
}

function localhostArtifactSeconds(topArtifacts: ArtifactRef[]): number {
  return topArtifacts
    .filter(isLocalhostArtifact)
    .reduce((sum, artifact) => sum + (artifact.totalSeconds ?? 0), 0)
}

function leisureSecondsOfDistribution(distribution: Partial<Record<AppCategory, number>>): number {
  return (distribution.entertainment ?? 0) + (distribution.social ?? 0)
}

function focusedShareOfDistribution(distribution: Partial<Record<AppCategory, number>>): number {
  const totalSeconds = Object.values(distribution).reduce((sum, sec) => sum + (sec ?? 0), 0)
  if (totalSeconds <= 0) return 0
  const focusedSeconds = (Object.entries(distribution) as Array<[AppCategory, number]>)
    .filter(([category]) => appCategoryIsFocused(category))
    .reduce((sum, [, seconds]) => sum + seconds, 0)
  return focusedSeconds / totalSeconds
}

// Foreground time that reads as real work intent — used only to defend against
// a single leisure page artifact. Browsing is the browser shell, not intent.
const WORK_INTENT_CATEGORIES = new Set<AppCategory>([
  ...FOCUSED_CATEGORIES,
  'communication',
  'email',
  'meetings',
])

function appCategoryIsWorkIntent(category: AppCategory): boolean {
  return WORK_INTENT_CATEGORIES.has(category)
}

function workIntentShareOfDistribution(distribution: Partial<Record<AppCategory, number>>): number {
  const totalSeconds = Object.values(distribution).reduce((sum, sec) => sum + (sec ?? 0), 0)
  if (totalSeconds <= 0) return 0
  const workSeconds = (Object.entries(distribution) as Array<[AppCategory, number]>)
    .filter(([category]) => WORK_INTENT_CATEGORIES.has(category))
    .reduce((sum, [, seconds]) => sum + seconds, 0)
  return workSeconds / totalSeconds
}

function isLeisureArtifactCategory(category: AppCategory): boolean {
  return category === 'social' || category === 'entertainment'
}

function categoryAfterLeisureArtifactChallenge(
  distribution: Partial<Record<AppCategory, number>>,
  baseCategory: AppCategory,
  focusedCategory: AppCategory | null,
  artifactCategory: AppCategory,
  artifactShare: number,
): AppCategory {
  const workShare = workIntentShareOfDistribution(distribution)
  const focusedShare = focusedShareOfDistribution(distribution)
  if (focusedShare < 0.5 && workShare < 0.5) {
    if (artifactShare > 0.5) return artifactCategory
    return baseCategory
  }
  if (artifactShare > workShare) return artifactCategory
  return focusedCategory ?? baseCategory
}

// App-level category for block detail / Apps rail — always "browsing" for a
// browser shell regardless of what dominantCategoryForBlock picks for the block.
export function appCategoryForSessionSummary(
  session: Pick<AppSession, 'bundleId' | 'appName' | 'category'>,
): AppCategory {
  if (isBrowserSession(session)) return 'browsing'
  return session.category
}

export function normalizeAppSummaryForBlockDisplay(summary: WorkContextAppSummary): WorkContextAppSummary {
  const isBrowser = isBrowserSession(summary)
  const category = isBrowser ? 'browsing' : summary.category
  // Blocks persisted before canonicalAppId was written into evidence.apps carry
  // none, which breaks site→browser nesting whenever the visit rows use the
  // browser's other identity form (exe path vs bundle id — both exist in
  // history). Backfill at read so old blocks nest like new ones.
  const canonicalAppId = summary.canonicalAppId
    ?? resolveCanonicalApp(summary.bundleId, summary.appName).canonicalAppId
  if (
    summary.category === category
    && summary.isBrowser === isBrowser
    && (summary.canonicalAppId ?? null) === canonicalAppId
  ) return summary
  return { ...summary, category, isBrowser, canonicalAppId }
}

function normalizeAppSummariesForBlockDisplay(summaries: WorkContextAppSummary[]): WorkContextAppSummary[] {
  return summaries.map(normalizeAppSummaryForBlockDisplay)
}

export function dominantCategoryForBlock(
  distribution: Partial<Record<AppCategory, number>>,
  topArtifacts: ArtifactRef[],
): AppCategory {
  const baseCategory = dominantCategoryFromDistribution(distribution)
  const focusedCategory = dominantFocusedCategoryFromDistribution(distribution)
  const artifactCategory = categoryForTopPageArtifact(topArtifacts)

  // Browsing on localhost is usually you testing your own dev server, so a
  // browser-shell block with a localhost page and some editor time reads as
  // development. But the dev evidence (localhost time + editor time) must not be
  // dwarfed by genuine leisure: a late-night block that is mostly YouTube and
  // Netflix, and merely happened to also load localhost, is NOT development.
  // (a 4h mostly-leisure block with a 262s dev sliver
  // was being stamped development → counted as work.)
  if (baseCategory === 'browsing' && hasLocalhostPageArtifact(topArtifacts) && (distribution.development ?? 0) > 0) {
    const devEvidenceSeconds = localhostArtifactSeconds(topArtifacts) + (distribution.development ?? 0)
    if (devEvidenceSeconds >= leisureSecondsOfDistribution(distribution)) {
      return 'development'
    }
  }
  if (focusedCategory && (baseCategory === 'browsing' || baseCategory === 'entertainment' || baseCategory === 'social')) {
    return focusedCategory
  }
  if (!artifactCategory) return baseCategory

  const totalSeconds = Object.values(distribution).reduce((sum, sec) => sum + (sec ?? 0), 0)
  const artifactSeconds = topArtifacts[0]?.totalSeconds ?? 0
  const artifactShare = totalSeconds > 0 ? artifactSeconds / totalSeconds : 0
  const baseShare = totalSeconds > 0 ? (distribution[baseCategory] ?? 0) / totalSeconds : 0

  if (isLeisureArtifactCategory(artifactCategory)) {
    const focusedShare = focusedShareOfDistribution(distribution)
    if (focusedShare >= 0.5) return focusedCategory ?? baseCategory
    if (appCategoryIsWorkIntent(baseCategory) && baseShare >= 0.5) return baseCategory
    if (!appCategoryIsFocused(baseCategory) && artifactShare <= 0.5) return baseCategory
    return categoryAfterLeisureArtifactChallenge(
      distribution,
      baseCategory,
      focusedCategory,
      artifactCategory,
      artifactShare,
    )
  }

  // Non-focused base: productivity/research artifacts refine browser-shell
  // intent. Leisure artifacts were handled above because they need work-share
  // protection before they can relabel a block.
  if (!appCategoryIsFocused(baseCategory)) {
    return artifactCategory
  }

  // Focused base: a page artifact must never flip the block to a different
  // focused category (GitHub "research" over a development-dominant block).
  if (appCategoryIsFocused(artifactCategory)) return baseCategory

  if (baseShare < 0.5 && artifactShare > 0.5) return artifactCategory
  return baseCategory
}

function coherenceScore(distribution: Partial<Record<AppCategory, number>>): number {
  const values = Object.values(distribution)
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return 0
  return Math.max(...values) / total
}

function countAppSwitches(sessions: AppSession[]): number {
  let switches = 0
  for (let index = 1; index < sessions.length; index++) {
    if (sessions[index].bundleId !== sessions[index - 1].bundleId) {
      switches++
    }
  }
  return switches
}

function averageDwellTime(sessions: AppSession[]): number {
  if (sessions.length === 0) return 0
  return sessions.reduce((sum, session) => sum + session.durationSeconds, 0) / sessions.length
}

export function sessionEndMs(session: Pick<AppSession, 'startTime' | 'endTime' | 'durationSeconds'>): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1000)
}

function inferredFocusedCategoryForSession(session: AppSession): AppCategory {
  if (session.category !== 'uncategorized') return session.category
  const haystack = `${session.bundleId} ${session.appName} ${session.rawAppName ?? ''}`.toLowerCase()
  // Dia and Comet are BROWSERS, not AI tools: their sessions go through the
  // site-weighted distribution, where claude.ai time (etc.) becomes aiTools on
  // its own merit. Forcing the app to aiTools here made every block of a
  // browser-centric day one category.
  if (/\b(codex|claude|chatgpt|copilot|perplexity)\b/.test(haystack)) return 'aiTools'
  if (/\b(antigravity|cursor|vscode|visual studio code|zed|xcode|sublime|warp|ghostty|iterm|terminal|cmux)\b/.test(haystack)) return 'development'
  return session.category
}

function effectiveSessionsFor(sessions: AppSession[]): EffectiveSession[] {
  if (sessions.length <= 2) {
    return sessions.map((session) => ({ session, effectiveCategory: inferredFocusedCategoryForSession(session) }))
  }

  const categories = sessions.map((session) => inferredFocusedCategoryForSession(session))
  for (let index = 1; index < sessions.length - 1; index++) {
    const session = sessions[index]
    const isPassiveInterruption =
      (session.category === 'communication'
        || session.category === 'email'
        || session.category === 'entertainment'
        || session.category === 'social')
      && session.durationSeconds < COMMUNICATION_INTERRUPTION_THRESHOLD_SEC

    if (!isPassiveInterruption) continue

    const previousCategory = categories[index - 1]
    const nextCategory = categories[index + 1]
    if (previousCategory === nextCategory && previousCategory !== session.category) {
      categories[index] = previousCategory
    }
  }

  return sessions.map((session, index) => ({
    session,
    effectiveCategory: categories[index],
  }))
}

function categoryDistributionFor(sessions: EffectiveSession[]): Partial<Record<AppCategory, number>> {
  const distribution: Partial<Record<AppCategory, number>> = {}
  for (const entry of sessions) {
    distribution[entry.effectiveCategory] = (distribution[entry.effectiveCategory] ?? 0) + entry.session.durationSeconds
  }
  return distribution
}

// ─── Site-weighted category distribution ─────────────────────────────────────
// A browser session's category used to be whatever the browser APP was
// cataloged as, so a user who lives in one browser had every block collapse
// into that single category — one color across the whole calendar, whatever
// they actually did inside it. The block facts now
// split each browser session's seconds across the categories of the sites
// reconciled inside the block (canva.com → design, youtube.com →
// entertainment, claude.ai → aiTools…); seconds no site accounts for stay
// plain 'browsing'.
//
// Two invariants hold by construction:
//   * Σ distribution = Σ session seconds — a visit's credited intervals are
//     clipped to the browser's own foreground sessions, so capture-gap credit
//     (valid as page EVIDENCE) can never add seconds a session never had, and
//     each browser's credited total is capped at its pool.
//   * Only foreground-reconciled site time re-weights — background-accrued
//     history rows contribute nothing (same ledger as page artifacts).
// Boundary heuristics (analyzeSessions and friends) intentionally keep the
// cheap app-only distribution: boundaries are about app coherence; these
// weighted facts are about what the finished block WAS.

interface BrowserCreditPool {
  intervals: { start: number; end: number }[]
  totalSeconds: number
  creditedSeconds: number
}

function overlapWithIntervalsMs(
  interval: { start: number; end: number },
  intervals: { start: number; end: number }[],
): number {
  let total = 0
  for (const candidate of intervals) {
    const start = Math.max(interval.start, candidate.start)
    const end = Math.min(interval.end, candidate.end)
    if (end > start) total += end - start
  }
  return total
}

export function weightedCategoryDistributionFor(
  db: Database.Database,
  sessions: AppSession[],
  blockStart: number,
  blockEnd: number,
): Partial<Record<AppCategory, number>> {
  const effective = effectiveSessionsFor(sessions)
  const distribution: Partial<Record<AppCategory, number>> = {}
  const add = (category: AppCategory, seconds: number) => {
    if (seconds > 0) distribution[category] = (distribution[category] ?? 0) + seconds
  }

  // Pool every browser session's time per browser; everything else keeps its
  // app-derived (effective) category unchanged.
  const pools = new Map<string, BrowserCreditPool>()
  const poolKeyByCanonicalId = new Map<string, string>()
  for (const entry of effective) {
    const session = entry.session
    if (!isBrowserSession(session)) {
      add(entry.effectiveCategory, session.durationSeconds)
      continue
    }
    let pool = pools.get(session.bundleId)
    if (!pool) {
      pool = { intervals: [], totalSeconds: 0, creditedSeconds: 0 }
      pools.set(session.bundleId, pool)
    }
    pool.intervals.push({
      start: session.startTime,
      end: session.endTime ?? (session.startTime + session.durationSeconds * 1000),
    })
    pool.totalSeconds += session.durationSeconds
    if (session.canonicalAppId) poolKeyByCanonicalId.set(session.canonicalAppId, session.bundleId)
  }

  if (pools.size > 0) {
    let credits: ReturnType<typeof getReconciledWebsiteVisitsForRange> = []
    try {
      credits = getReconciledWebsiteVisitsForRange(db, blockStart, blockEnd)
    } catch (err) {
      console.warn('[timeline] weighted category distribution: visit reconciliation failed', err)
    }
    for (const { visit, freeIntervals } of credits) {
      const category = categoryForDomain(visit.domain)
      if (!category || category === 'browsing') continue
      const poolKey = visit.browserBundleId && pools.has(visit.browserBundleId)
        ? visit.browserBundleId
        : (visit.canonicalBrowserId ? poolKeyByCanonicalId.get(visit.canonicalBrowserId) ?? null : null)
      if (!poolKey) continue
      const pool = pools.get(poolKey)
      if (!pool) continue
      let clippedMs = 0
      for (const interval of freeIntervals) {
        clippedMs += overlapWithIntervalsMs(interval, pool.intervals)
      }
      const credited = Math.min(Math.round(clippedMs / 1000), pool.totalSeconds - pool.creditedSeconds)
      if (credited <= 0) continue
      pool.creditedSeconds += credited
      add(category, credited)
    }
    for (const pool of pools.values()) {
      add('browsing', pool.totalSeconds - pool.creditedSeconds)
    }
  }

  return distribution
}

function categoryRunsFor(sessions: EffectiveSession[]): CategoryRun[] {
  if (sessions.length === 0) return []

  const runs: CategoryRun[] = []
  let currentCategory = sessions[0].effectiveCategory
  let startIndex = 0
  let totalSeconds = sessions[0].session.durationSeconds

  for (let index = 1; index < sessions.length; index++) {
    const session = sessions[index]
    if (session.effectiveCategory === currentCategory) {
      totalSeconds += session.session.durationSeconds
      continue
    }

    runs.push({ category: currentCategory, startIndex, totalSeconds })
    currentCategory = session.effectiveCategory
    startIndex = index
    totalSeconds = session.session.durationSeconds
  }

  runs.push({ category: currentCategory, startIndex, totalSeconds })
  return runs
}

function sustainedDifferentCategorySplitIndex(runs: CategoryRun[], dominantCategory: AppCategory): number | null {
  return runs.find((run) => run.startIndex > 0 && run.category !== dominantCategory && run.totalSeconds >= SUSTAINED_CATEGORY_THRESHOLD_SEC)?.startIndex ?? null
}

function slowSwitchBoundaryIndex(runs: CategoryRun[]): number | null {
  return runs.length > 1 ? runs[1].startIndex : null
}

function isDeveloperTestingFlow(categories: Set<AppCategory>, averageDwell: number): boolean {
  if (averageDwell >= FAST_SWITCH_THRESHOLD_SEC || !categories.has('development')) return false
  const devAndBrowsing = new Set<AppCategory>(['development', 'browsing'])
  const devAndResearch = new Set<AppCategory>(['development', 'research'])
  return Array.from(categories).every((category) => devAndBrowsing.has(category))
    || Array.from(categories).every((category) => devAndResearch.has(category))
}

function isStandaloneMeeting(session: AppSession): boolean {
  return session.category === 'meetings' && session.durationSeconds >= MEETING_THRESHOLD_SEC
}

function meetingLabel(session: AppSession): string {
  const appName = session.appName.toLowerCase()
  if (appName.includes('zoom')) return 'Zoom Call'
  if (appName.includes('teams')) return 'Teams Call'
  if (appName.includes('meet')) return 'Google Meet'
  return 'Meeting'
}

function isAllowedStreakInterruption(sessions: AppSession[], index: number, targetBundleId: string): boolean {
  const session = sessions[index]
  if (session.durationSeconds < BRIEF_INTERRUPTION_THRESHOLD_SEC) return true

  return index > 0
    && index < sessions.length - 1
    && (session.category === 'communication' || session.category === 'email')
    && session.durationSeconds < COMMUNICATION_INTERRUPTION_THRESHOLD_SEC
    && sessions[index - 1].bundleId === targetBundleId
    && sessions[index + 1].bundleId === targetBundleId
}

function longSingleAppStreak(sessions: AppSession[]): AppStreak | null {
  let best: AppStreak | null = null

  for (let startIndex = 0; startIndex < sessions.length; startIndex++) {
    const first = sessions[startIndex]
    const targetCategory = first.category
    if (!(appCategoryIsFocused(targetCategory) || targetCategory === 'communication' || targetCategory === 'email')) {
      continue
    }

    let totalTargetDuration = 0
    let bestEndIndex: number | null = null

    for (let endIndex = startIndex; endIndex < sessions.length; endIndex++) {
      const session = sessions[endIndex]
      if (session.bundleId === first.bundleId) {
        totalTargetDuration += session.durationSeconds
      } else if (!isAllowedStreakInterruption(sessions, endIndex, first.bundleId)) {
        break
      }

      if (totalTargetDuration > LONG_SINGLE_APP_THRESHOLD_SEC) {
        bestEndIndex = endIndex
      }
    }

    if (bestEndIndex === null) continue

    const streak: AppStreak = {
      range: [startIndex, bestEndIndex + 1],
      targetDurationSeconds: totalTargetDuration,
      label: first.appName,
    }

    if (!best || streak.targetDurationSeconds > best.targetDurationSeconds) {
      best = streak
    }
  }

  return best
}

function coarseSegmentsFromSessions(sessions: AppSession[]): CoarseSegment[] {
  if (sessions.length === 0) return []

  const segments: CoarseSegment[] = []
  let startIndex = 0

  for (let index = 1; index < sessions.length; index++) {
    const previous = sessions[index - 1]
    const current = sessions[index]
    const previousEnd = sessionEndMs(previous)
    const gap = current.startTime - previousEnd
    // timeline.md §3.1: a roughly 15-minute idle/lock gap is a strong boundary on its own.
    if (gap >= IDLE_GAP_THRESHOLD_MS) {
      segments.push({
        sessions: sessions.slice(startIndex, index),
        boundedBeforeGap: startIndex > 0,
        boundedAfterGap: true,
      })
      startIndex = index
    }
  }

  segments.push({
    sessions: sessions.slice(startIndex),
    boundedBeforeGap: startIndex > 0,
    boundedAfterGap: false,
  })

  return segments
}

function candidateSpanMs(candidate: CandidateBlock): number {
  if (candidate.sessions.length === 0) return 0
  return sessionEndMs(candidate.sessions[candidate.sessions.length - 1]) - candidate.sessions[0].startTime
}

function candidateActiveMs(candidate: CandidateBlock): number {
  return candidate.sessions.reduce((sum, session) => sum + Math.max(0, session.durationSeconds * 1000), 0)
}

function validTimelineSplit(index: number, sessions: AppSession[]): boolean {
  if (index <= 0 || index >= sessions.length) return false
  const leftSpan = sessionEndMs(sessions[index - 1]) - sessions[0].startTime
  const rightSpan = sessionEndMs(sessions[sessions.length - 1]) - sessions[index].startTime
  return leftSpan >= TIMELINE_MIN_CHILD_SPAN_MS && rightSpan >= TIMELINE_MIN_CHILD_SPAN_MS
}

function bestTimelineGapSplitIndex(sessions: AppSession[]): number | null {
  if (sessions.length < 2) return null
  const midpoint = sessions[0].startTime + ((sessionEndMs(sessions[sessions.length - 1]) - sessions[0].startTime) / 2)

  let bestIndex: number | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (let index = 1; index < sessions.length; index++) {
    const gapMs = sessions[index].startTime - sessionEndMs(sessions[index - 1])
    if (gapMs < TIMELINE_SPLIT_GAP_THRESHOLD_MS || !validTimelineSplit(index, sessions)) continue

    const midpointDistancePenalty = Math.abs(sessions[index].startTime - midpoint) / 4
    const score = gapMs - midpointDistancePenalty
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }

  return bestIndex
}

function fallbackTimelineSplitIndex(sessions: AppSession[]): number | null {
  if (sessions.length < 2) return null

  const targetTime = sessions[0].startTime + TIMELINE_MAX_BLOCK_SPAN_MS
  for (let index = 1; index < sessions.length; index++) {
    if (sessions[index].startTime >= targetTime && validTimelineSplit(index, sessions)) {
      return index
    }
  }

  for (let index = Math.floor(sessions.length / 2); index < sessions.length; index++) {
    if (validTimelineSplit(index, sessions)) return index
  }
  for (let index = Math.floor(sessions.length / 2) - 1; index > 0; index--) {
    if (validTimelineSplit(index, sessions)) return index
  }

  return null
}

function splitSessionAt(session: AppSession, splitTime: number): [AppSession, AppSession] {
  const endTime = sessionEndMs(session)
  return [
    {
      ...session,
      endTime: splitTime,
      durationSeconds: Math.max(1, Math.round((splitTime - session.startTime) / 1000)),
    },
    {
      ...session,
      startTime: splitTime,
      endTime,
      durationSeconds: Math.max(1, Math.round((endTime - splitTime) / 1000)),
    },
  ]
}

function splitSessionsAtTime(sessions: AppSession[], splitTime: number): [AppSession[], AppSession[]] {
  const left: AppSession[] = []
  const right: AppSession[] = []

  for (const session of sessions) {
    const endTime = sessionEndMs(session)
    if (endTime <= splitTime) {
      left.push(session)
      continue
    }
    if (session.startTime >= splitTime) {
      right.push(session)
      continue
    }

    const [leftSession, rightSession] = splitSessionAt(session, splitTime)
    left.push(leftSession)
    right.push(rightSession)
  }

  return [left, right]
}

function normalizeTimelineCandidates(candidates: CandidateBlock[]): CandidateBlock[] {
  return candidates.flatMap((candidate) => {
    const spanMs = candidateSpanMs(candidate)
    const highlyCoherent = isHighlyCoherentCandidate(candidate)
    const ceilingMs = highlyCoherent ? TIMELINE_MAX_COHERENT_BLOCK_SPAN_MS : TIMELINE_MAX_BLOCK_SPAN_MS

    if (spanMs <= ceilingMs) {
      return [candidate]
    }

    const maxSplitTime = candidate.sessions[0].startTime + ceilingMs
    const [leftSessions, rightSessions] = splitSessionsAtTime(candidate.sessions, maxSplitTime)
    if (leftSessions.length > 0 && rightSessions.length > 0) {
      return normalizeTimelineCandidates(
        analyzeSessions(leftSessions, candidate.boundedBeforeGap, false)
          .concat(analyzeSessions(rightSessions, false, candidate.boundedAfterGap)),
      )
    }

    const splitIndex =
      bestTimelineGapSplitIndex(candidate.sessions)
      ?? fallbackTimelineSplitIndex(candidate.sessions)

    if (splitIndex === null) return [candidate]

    return normalizeTimelineCandidates(
      analyzeSessions(candidate.sessions.slice(0, splitIndex), candidate.boundedBeforeGap, false)
        .concat(analyzeSessions(candidate.sessions.slice(splitIndex), false, candidate.boundedAfterGap)),
    )
  })
}

// Returns true when every session in the candidate shares the same
// (bundleId, compactedWindowTitle) pair and no internal gap exceeds the
// split-gap threshold. Single-session candidates are trivially coherent and
// always qualify.
//
// "Coherent" here is deliberately stricter than the coherence score used in
// `analyzeSessions`: that score is a category-mix heuristic, this one is a
// "same thing, uninterrupted" test. A candidate that passes this test is a
// single continuous stretch the user was on one specific thing — so slicing
// it at 60 minutes just to satisfy a legacy cap is a regression, not a fix.
function isHighlyCoherentCandidate(candidate: CandidateBlock): boolean {
  if (candidate.sessions.length === 0) return false
  if (candidate.sessions.length === 1) return true

  const first = candidate.sessions[0]
  const firstContext = contentContextForSession(first)
  const firstBundleId = first.bundleId

  let previousEnd = sessionEndMs(first)
  for (let index = 1; index < candidate.sessions.length; index++) {
    const session = candidate.sessions[index]
    if (session.bundleId !== firstBundleId) return false
    if (contentContextForSession(session) !== firstContext) return false
    const gapMs = session.startTime - previousEnd
    if (gapMs >= TIMELINE_SPLIT_GAP_THRESHOLD_MS) return false
    previousEnd = sessionEndMs(session)
  }
  return true
}

function splitAndAnalyze(
  sessions: AppSession[],
  splitIndex: number,
  boundedBeforeGap: boolean,
  boundedAfterGap: boolean,
): CandidateBlock[] {
  if (splitIndex <= 0 || splitIndex >= sessions.length) {
    return [{
      sessions,
      formation: 'heuristic',
      boundedBeforeGap,
      boundedAfterGap,
    }]
  }

  return analyzeSessions(sessions.slice(0, splitIndex), boundedBeforeGap, false)
    .concat(analyzeSessions(sessions.slice(splitIndex), false, boundedAfterGap))
}

function hasCodeEvidence(candidate: CandidateBlock): boolean {
  return candidate.sessions.some((session) => {
    if (session.category === 'development') return true
    const haystack = `${session.bundleId} ${session.appName}`.toLowerCase()
    return [
      'cursor',
      'code',
      'xcode',
      'terminal',
      'powershell',
      'cmd.exe',
      'intellij',
      'pycharm',
      'webstorm',
      'idea',
      'sublime',
      'vim',
      'nvim',
    ].some((token) => haystack.includes(token))
  })
}

function labelForCandidate(
  candidate: CandidateBlock,
  dominantCategory: AppCategory,
  distribution: Partial<Record<AppCategory, number>>,
  coherence: number,
  switchCount: number,
): string {
  if (candidate.forcedLabel) return candidate.forcedLabel

  const categories = new Set(candidate.sessions.map((session) => session.category))
  if (coherence < 0.4) return 'Mixed Work'

  const codeEvidence = hasCodeEvidence(candidate)

  if (
    switchCount > 0
    && categories.has('development')
    && (categories.has('browsing') || categories.has('research'))
  ) {
    const totalTime = Object.values(distribution).reduce((sum, value) => sum + value, 0)
    const devTime = distribution.development ?? 0
    const socialTime = (distribution.social ?? 0) + (distribution.entertainment ?? 0)
    const devShare = totalTime > 0 ? devTime / totalTime : 0
    const socialShare = totalTime > 0 ? socialTime / totalTime : 0

    if (devShare >= 0.2 && socialShare < 0.2 && codeEvidence) {
      return switchCount >= 3 ? 'Building & Testing' : 'Development'
    }
  }

  if (dominantCategory === 'communication' || dominantCategory === 'email') {
    return 'Communication'
  }

  if (dominantCategory === 'browsing') {
    const titleLabel = bestTitleLabelForSessions(candidate.sessions)
    if (titleLabel) return titleLabel
    return 'Web Session'
  }

  if (!codeEvidence && (dominantCategory === 'development' || dominantCategory === 'aiTools')) {
    const browserAndAIOnly = candidate.sessions.every((session) => {
      return isBrowserSession(session) || session.category === 'aiTools' || session.category === 'browsing'
    })
    if (browserAndAIOnly) return ''
  }

  const focusedCategories = Array.from(categories).filter((category) => appCategoryIsFocused(category))
  if (focusedCategories.length > 1) return prettyCategory(dominantCategory)
  return prettyCategory(dominantCategory)
}

function bestTitleLabelForSessions(sessions: AppSession[]): string | null {
  const counts = new Map<string, { label: string; seconds: number }>()
  for (const session of sessions) {
    const title = usefulWindowTitle(session)
    if (!title) continue
    const label = compactWindowTitle(title)
    const key = label.toLowerCase()
    const current = counts.get(key)
    if (current) {
      current.seconds += session.durationSeconds
    } else {
      counts.set(key, { label, seconds: session.durationSeconds })
    }
  }
  const best = [...counts.values()]
    .sort((left, right) => right.seconds - left.seconds || left.label.localeCompare(right.label))[0]
  return best?.label ?? null
}

function websiteAwareLabel(block: WorkContextBlock): string {
  const dominated = block.dominantCategory === 'browsing' || block.dominantCategory === 'aiTools'
  const genericLabel =
    !block.ruleBasedLabel
    || block.ruleBasedLabel === 'Web Session'
    || block.ruleBasedLabel === 'Browsing'
    || block.ruleBasedLabel === 'Research & AI Chat'

  if ((!dominated && !genericLabel) || block.websites.length === 0) {
    return block.ruleBasedLabel
  }

  const labels = block.websites.slice(0, 3).map((site) => shortDomainLabel(site.domain))
  if (labels.length === 1) return labels[0]
  if (labels.length >= 2) return `${labels[0]} + ${labels[1]}`
  return block.ruleBasedLabel
}

function shortDomainLabel(domain: string): string {
  return websiteDisplayLabel(domain)
}

// F6: roll up block appearances under their promoted memory pattern. A
// block participates in a rollup only when `pattern_occurrences` records a
// match for one of its block IDs. Blocks without a match fall through as
// single-row rollups so the Apps view can still render every appearance.
export function memoryRollupsForBlocks(
  db: Database.Database,
  appearances: Array<{ blockId: string; startTime: number; endTime: number; label: string }>,
): AppDetailPayload['blockMemoryRollups'] {
  if (appearances.length === 0) return []

  const blockIds = appearances.map((row) => row.blockId)
  const hasOccurrences = (() => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_occurrences' LIMIT 1`).get() as { name: string } | undefined
    return Boolean(row)
  })()
  if (!hasOccurrences) {
    return appearances.map((row) => ({
      patternId: null,
      patternLabel: row.label,
      sessionCount: 1,
      totalSeconds: Math.max(0, Math.round((row.endTime - row.startTime) / 1000)),
      earliestStart: row.startTime,
      latestEnd: row.endTime,
      sampleBlockIds: [row.blockId],
    }))
  }

  const placeholders = blockIds.map(() => '?').join(', ')
  const occurrences = db.prepare(`
    SELECT
      pattern_occurrences.block_id AS blockId,
      pattern_occurrences.pattern_id AS patternId,
      context_patterns.label_suggestion AS label,
      context_patterns.status AS status
    FROM pattern_occurrences
    JOIN context_patterns ON context_patterns.id = pattern_occurrences.pattern_id
    WHERE pattern_occurrences.block_id IN (${placeholders})
      AND context_patterns.status = 'promoted'
  `).all(...blockIds) as Array<{ blockId: string; patternId: string; label: string; status: string }>

  const patternByBlock = new Map<string, { patternId: string; label: string }>()
  for (const row of occurrences) {
    if (!patternByBlock.has(row.blockId)) {
      patternByBlock.set(row.blockId, { patternId: row.patternId, label: row.label })
    }
  }

  type Rollup = {
    patternId: string | null
    patternLabel: string
    sessionCount: number
    totalSeconds: number
    earliestStart: number
    latestEnd: number
    sampleBlockIds: string[]
  }
  const rollupsByKey = new Map<string, Rollup>()
  const orderKeys: string[] = []
  for (const row of appearances) {
    const match = patternByBlock.get(row.blockId)
    const key = match?.patternId ?? `solo:${row.blockId}`
    const seconds = Math.max(0, Math.round((row.endTime - row.startTime) / 1000))
    const existing = rollupsByKey.get(key)
    if (existing) {
      existing.sessionCount += 1
      existing.totalSeconds += seconds
      existing.earliestStart = Math.min(existing.earliestStart, row.startTime)
      existing.latestEnd = Math.max(existing.latestEnd, row.endTime)
      if (existing.sampleBlockIds.length < 5) existing.sampleBlockIds.push(row.blockId)
      continue
    }
    rollupsByKey.set(key, {
      patternId: match?.patternId ?? null,
      patternLabel: match?.label ?? row.label,
      sessionCount: 1,
      totalSeconds: seconds,
      earliestStart: row.startTime,
      latestEnd: row.endTime,
      sampleBlockIds: [row.blockId],
    })
    orderKeys.push(key)
  }

  return orderKeys.map((key) => rollupsByKey.get(key)!)
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
}

function workflowRefsByBlockId(
  db: Database.Database,
  blockIds: string[],
): Map<string, WorkflowRef[]> {
  const grouped = new Map<string, WorkflowRef[]>()
  if (blockIds.length === 0) return grouped

  const placeholders = blockIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT
      workflow_occurrences.block_id,
      workflow_occurrences.confidence,
      workflow_signatures.id,
      workflow_signatures.signature_key,
      workflow_signatures.label,
      workflow_signatures.dominant_category,
      workflow_signatures.canonical_apps_json,
      workflow_signatures.artifact_keys_json
    FROM workflow_occurrences
    JOIN workflow_signatures
      ON workflow_signatures.id = workflow_occurrences.workflow_id
    WHERE workflow_occurrences.block_id IN (${placeholders})
  `).all(...blockIds) as Array<{
    block_id: string
    confidence: number
    id: string
    signature_key: string
    label: string
    dominant_category: AppCategory
    canonical_apps_json: string
    artifact_keys_json: string
  }>

  for (const row of rows) {
    const current = grouped.get(row.block_id) ?? []
    current.push({
      id: row.id,
      signatureKey: row.signature_key,
      label: row.label,
      confidence: row.confidence,
      dominantCategory: row.dominant_category,
      canonicalApps: JSON.parse(row.canonical_apps_json) as string[],
      artifactKeys: JSON.parse(row.artifact_keys_json) as string[],
    })
    grouped.set(row.block_id, current)
  }

  return grouped
}

export function loadPersistedAppDetailBlocksForDates(
  db: Database.Database,
  dates: string[],
): Map<string, AppDetailBlockSlice[]> {
  const grouped = new Map<string, AppDetailBlockSlice[]>()
  if (dates.length === 0) return grouped

  // Corrected block facts (invariant 7 / apps.md invariant 13): a block the
  // user deleted (review state 'ignored') never reaches the Apps panel, and a
  // rename or recategorization the user made on the Timeline is what Apps
  // shows too — the same filter and corrections every timeline read applies.
  const placeholders = dates.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT
      id,
      date,
      start_time,
      end_time,
      dominant_category,
      label_current,
      evidence_summary_json
    FROM timeline_blocks b
    WHERE invalidated_at IS NULL
      AND date IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM timeline_block_reviews r
        WHERE r.block_id = b.id AND r.review_state = 'ignored'
      )
    ORDER BY start_time ASC
  `).all(...dates) as Array<{
    id: string
    date: string
    start_time: number
    end_time: number
    dominant_category: AppCategory
    label_current: string
    evidence_summary_json: string
  }>

  const workflowsByBlock = workflowRefsByBlockId(db, rows.map((row) => row.id))
  const correctionsByBlock = new Map<string, { label: string | null; category: AppCategory | null }>()
  if (rows.length > 0) {
    const reviewRows = db.prepare(`
      SELECT block_id, correction_json
      FROM timeline_block_reviews
      WHERE review_state = 'corrected' AND block_id IN (${sqlPlaceholders(rows.length)})
      ORDER BY updated_at ASC
    `).all(...rows.map((row) => row.id)) as Array<{ block_id: string; correction_json: string }>
    for (const reviewRow of reviewRows) {
      const correction = parseReviewJson(reviewRow.correction_json)
      const label = stringValue(correction.label)
      const category = isAppCategory(correction.category) ? correction.category : null
      if (label || category) {
        // updated_at ASC: the latest correction for a block wins.
        correctionsByBlock.set(reviewRow.block_id, { label, category })
      }
    }
  }

  for (const row of rows) {
    let evidence: Partial<TimelineEvidenceSummary> = {}
    try {
      evidence = JSON.parse(row.evidence_summary_json || '{}') as Partial<TimelineEvidenceSummary>
    } catch {
      evidence = {}
    }

    const pageRefs = Array.isArray(evidence.pages) ? evidence.pages as PageRef[] : []
    const documentRefs = Array.isArray(evidence.documents) ? evidence.documents as DocumentRef[] : []
    const topArtifacts = [...pageRefs, ...documentRefs]
      .sort((left, right) => right.totalSeconds - left.totalSeconds)
      .slice(0, 8)

    const correction = correctionsByBlock.get(row.id)
    const current = grouped.get(row.date) ?? []
    current.push({
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      dominantCategory: correction?.category ?? row.dominant_category,
      label: {
        current: correction?.label ?? row.label_current,
      },
      topApps: Array.isArray(evidence.apps)
        ? normalizeAppSummariesForBlockDisplay(evidence.apps as WorkContextAppSummary[])
        : [],
      topArtifacts,
      pageRefs,
      workflowRefs: workflowsByBlock.get(row.id) ?? [],
    })
    grouped.set(row.date, current)
  }

  return grouped
}

function confidenceForCandidate(candidate: CandidateBlock, coherence: number): BlockConfidence {
  if (candidate.formation === 'coherent' && candidate.boundedBeforeGap && candidate.boundedAfterGap && coherence > 0.75) {
    return 'high'
  }
  if (candidate.formation === 'mixed' && coherence < 0.4) {
    return 'low'
  }
  return 'medium'
}

export function topAppsFromSessions(sessions: AppSession[]): WorkContextAppSummary[] {
  const grouped = new Map<string, WorkContextAppSummary>()

  for (const session of sessions) {
    const existing = grouped.get(session.bundleId)
    if (existing) {
      existing.totalSeconds += session.durationSeconds
      existing.sessionCount += 1
      continue
    }

    const identity = resolveCanonicalApp(session.bundleId, session.appName)
    grouped.set(session.bundleId, {
      bundleId: session.bundleId,
      canonicalAppId: session.canonicalAppId ?? identity.canonicalAppId,
      appName: identity.displayName || sanitizeBlockLabel(session.appName) || session.appName,
      category: appCategoryForSessionSummary(session),
      totalSeconds: session.durationSeconds,
      sessionCount: 1,
      isBrowser: isBrowserSession(session),
    })
  }

  return Array.from(grouped.values())
    .sort((left, right) => {
      if (left.totalSeconds === right.totalSeconds) {
        return left.appName.localeCompare(right.appName)
      }
      return right.totalSeconds - left.totalSeconds
    })
    .slice(0, 5)
}

function sha1(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex')
}

export function artifactIdFor(canonicalKey: string): string {
  return `art_${sha1(canonicalKey).slice(0, 16)}`
}

function blockIdFor(blockStart: number, blockEnd: number, sessionIds: number[], isLive: boolean): string {
  // The live block is re-derived on every refresh tick: its end advances each
  // second and new sessions flush onto its tail. Hashing those volatile inputs
  // churns its id constantly, which drops the user's selection (the id leaves
  // blockMap, the inspector closes) and breaks merge lookups (the id the
  // renderer sent no longer exists by the time the handler re-materializes).
  // Anchor the live id on its start alone — there is only ever one live block
  // and its start is stable as it grows — so it keeps a single identity.
  const signature = isLive
    ? `live:${blockStart}`
    : `${blockStart}:${blockEnd}:${sessionIds.join(',')}:${TIMELINE_HEURISTIC_VERSION}`
  const prefix = isLive ? 'live' : 'blk'
  return `${prefix}_${sha1(signature).slice(0, 16)}`
}

export function reviewEvidenceKeyForBlock(block: WorkContextBlock): string {
  const sessionIds = block.sessions
    .map((session) => session.id)
    .filter((id) => id >= 0)
    .sort((left, right) => left - right)
  if (sessionIds.length > 0) {
    return `sessions:${sessionIds.join(',')}`
  }

  const artifactKeys = block.topArtifacts
    .map((artifact) => artifact.canonicalKey ?? artifact.id)
    .filter(Boolean)
    .sort()
    .slice(0, 8)
  const appKeys = block.topApps
    .map((app) => app.bundleId)
    .filter(Boolean)
    .sort()
    .slice(0, 8)
  return `span:${block.startTime}:${block.endTime}:apps:${appKeys.join(',')}:artifacts:${artifactKeys.join(',')}`
}

function defaultReviewStateForBlock(block: WorkContextBlock): TimelineBlockReviewState {
  if (block.isLive) return 'pending'
  if (block.label.source === 'user' || block.label.override?.trim()) return 'corrected'
  if (block.confidence === 'low' || block.label.confidence < 0.58) return 'pending'
  if (block.label.source === 'rule') return 'pending'
  return 'auto-approved'
}

export function originalReviewSnapshotForBlock(block: WorkContextBlock): Record<string, unknown> {
  const intent = inferWorkIntent(block)
  return {
    blockId: block.id,
    startTime: block.startTime,
    endTime: block.endTime,
    dominantCategory: block.dominantCategory,
    label: block.label.current,
    labelSource: block.label.source,
    labelConfidence: block.label.confidence,
    ruleBasedLabel: block.ruleBasedLabel,
    aiLabel: block.aiLabel,
    intentRole: intent.role,
    intentSubject: intent.subject,
    confidence: block.confidence,
    heuristicVersion: block.heuristicVersion,
    sessionIds: block.sessions.map((session) => session.id).filter((id) => id >= 0),
    appBundles: block.topApps.slice(0, 6).map((app) => app.bundleId),
    artifactIds: block.topArtifacts.slice(0, 8).map((artifact) => artifact.id),
  }
}

function parseReviewJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function intentRoleValue(value: unknown): WorkIntentRole | null {
  return isWorkIntentRole(value) ? value : null
}

interface PersistedReviewRow {
  id: string
  block_id: string
  date: string
  evidence_key: string
  review_state: string
  original_block_json: string
  correction_json: string
  updated_at: number
}

function reviewFromRow(
  row: PersistedReviewRow | null,
  source: TimelineBlockReview['source'],
  fallbackState: TimelineBlockReviewState,
): TimelineBlockReview {
  if (!row || !isTimelineBlockReviewState(row.review_state)) {
    return {
      ...DEFAULT_TIMELINE_BLOCK_REVIEW,
      state: fallbackState,
    }
  }

  const original = parseReviewJson(row.original_block_json)
  const correction = parseReviewJson(row.correction_json)
  return {
    state: row.review_state,
    source,
    originalBlockId: stringValue(original.blockId) ?? row.block_id,
    originalLabel: stringValue(original.label),
    originalIntentRole: intentRoleValue(original.intentRole),
    originalIntentSubject: stringValue(original.intentSubject),
    correctedLabel: stringValue(correction.label),
    correctedIntentRole: intentRoleValue(correction.intentRole),
    correctedIntentSubject: stringValue(correction.intentSubject),
    correctedCategory: isAppCategory(correction.category) ? correction.category : null,
    updatedAt: row.updated_at,
  }
}

function compareReviewRows(left: PersistedReviewRow, right: PersistedReviewRow): number {
  const stateRank = (state: string): number => {
    switch (state) {
      case 'corrected': return 5
      case 'ignored': return 4
      case 'approved': return 3
      case 'pending': return 2
      case 'auto-approved': return 1
      default: return 0
    }
  }
  const rankDiff = stateRank(right.review_state) - stateRank(left.review_state)
  if (rankDiff !== 0) return rankDiff
  return right.updated_at - left.updated_at
}

function findReviewRowForBlock(
  db: Database.Database,
  dateStr: string,
  block: WorkContextBlock,
): { row: PersistedReviewRow | null; source: TimelineBlockReview['source'] } {
  const evidenceKey = reviewEvidenceKeyForBlock(block)
  const rows = db.prepare(`
    SELECT
      id,
      block_id,
      date,
      evidence_key,
      review_state,
      original_block_json,
      correction_json,
      updated_at
    FROM timeline_block_reviews
    WHERE block_id = ?
       OR (date = ? AND evidence_key = ?)
    ORDER BY updated_at DESC
  `).all(block.id, dateStr, evidenceKey) as PersistedReviewRow[]

  const blockRow = rows
    .filter((row) => row.block_id === block.id)
    .sort(compareReviewRows)[0] ?? null
  if (blockRow) return { row: blockRow, source: 'stored_block' }

  const evidenceRow = rows
    .filter((row) => row.evidence_key === evidenceKey)
    .sort(compareReviewRows)[0] ?? null
  return { row: evidenceRow, source: evidenceRow ? 'stored_evidence' : 'default' }
}

function reviewForBlock(db: Database.Database, dateStr: string, block: WorkContextBlock): TimelineBlockReview {
  const fallbackState = defaultReviewStateForBlock(block)
  const { row, source } = findReviewRowForBlock(db, dateStr, block)
  const review = reviewFromRow(row, source, fallbackState)
  if (review.state === 'corrected' && !review.correctedLabel && block.label.override?.trim()) {
    return {
      ...review,
      correctedLabel: block.label.override.trim(),
    }
  }
  return review
}

function applyReviewToBlock(block: WorkContextBlock, review: TimelineBlockReview): WorkContextBlock {
  let next: WorkContextBlock = { ...block, review }
  if (review.state === 'corrected' && review.correctedLabel) {
    next = {
      ...next,
      label: {
        ...next.label,
        current: review.correctedLabel,
        source: 'user',
        confidence: 1,
        override: review.correctedLabel,
      },
    }
  }
  // A user recategorization wins over the computed dominant category, and the
  // work/leisure kind follows the corrected category — a block the user marked
  // "development" means "this was work", whatever the domain evidence said.
  if (review.state === 'corrected' && review.correctedCategory) {
    next = {
      ...next,
      dominantCategory: review.correctedCategory,
      kind: kindForCategory(review.correctedCategory),
    }
  }
  return next
}

function ensureDefaultReviewRowForBlock(db: Database.Database, dateStr: string, block: WorkContextBlock): void {
  const evidenceKey = reviewEvidenceKeyForBlock(block)
  const existing = findReviewRowForBlock(db, dateStr, block).row
  if (existing) return

  const now = Date.now()
  const state = defaultReviewStateForBlock(block)
  db.prepare(`
    INSERT OR IGNORE INTO timeline_block_reviews (
      id,
      block_id,
      date,
      evidence_key,
      review_state,
      original_block_json,
      correction_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `).run(
    `review_${sha1(`${block.id}:${evidenceKey}`).slice(0, 18)}`,
    block.id,
    dateStr,
    evidenceKey,
    state,
    JSON.stringify(originalReviewSnapshotForBlock(block)),
    now,
    now,
  )
}

export function writeIgnoredBlockReviewBackstop(
  db: Database.Database,
  input: {
    date: string
    blockId: string
    evidenceKey: string
    originalBlockJson: string
  },
): void {
  const { date, blockId, evidenceKey, originalBlockJson } = input
  const now = Date.now()
  // A deletion the Timeline honors must reach the period wraps too — drop the
  // day's frozen snapshot so week/month/year facts rebuild from what remains,
  // and the stored wrap prose written over the deleted block with it.
  deleteDaySnapshotRow(db, date)
  deleteWrappedNarrativesForDate(db, date, 'deletion')
  const rows = db.prepare(`
    SELECT
      id,
      block_id,
      evidence_key,
      original_block_json,
      review_state,
      updated_at
    FROM timeline_block_reviews
    WHERE block_id = ?
       OR (date = ? AND evidence_key = ?)
    ORDER BY updated_at DESC
  `).all(blockId, date, evidenceKey) as PersistedReviewRow[]

  const blockRow = rows
    .filter((row) => row.block_id === blockId)
    .sort(compareReviewRows)[0] ?? null
  const existing = blockRow ?? rows
    .filter((row) => row.evidence_key === evidenceKey)
    .sort(compareReviewRows)[0] ?? null

  const originalJson = existing?.original_block_json && existing.original_block_json !== '{}'
    ? existing.original_block_json
    : originalBlockJson

  if (existing) {
    db.prepare(`
      UPDATE timeline_block_reviews
      SET block_id = ?,
          date = ?,
          evidence_key = ?,
          review_state = 'ignored',
          original_block_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(blockId, date, evidenceKey, originalJson, now, existing.id)
    return
  }

  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id,
      block_id,
      date,
      evidence_key,
      review_state,
      original_block_json,
      correction_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, 'ignored', ?, '{}', ?, ?)
  `).run(
    `review_${sha1(`${blockId}:${evidenceKey}`).slice(0, 18)}`,
    blockId,
    date,
    evidenceKey,
    originalJson,
    now,
    now,
  )
}

export function writeTimelineBlockReview(
  db: Database.Database,
  dateStr: string,
  block: WorkContextBlock,
  update: Omit<TimelineBlockReviewUpdate, 'blockId' | 'date'>,
): void {
  const state = update.state
  const evidenceKey = reviewEvidenceKeyForBlock(block)
  const existing = findReviewRowForBlock(db, dateStr, block).row
  const now = Date.now()
  // Corrections change every totalling surface, period wraps included: the
  // day's frozen snapshot is a cache of the pre-correction facts, so drop it
  // and let the next wrap read refreeze from the corrected timeline. The
  // stored wrap narrative was written over the pre-correction facts too, so
  // it goes with the snapshot rather than contradicting the corrected day.
  deleteDaySnapshotRow(db, dateStr)
  deleteWrappedNarrativesForDate(db, dateStr, 'correction')
  const existingCorrection = existing ? parseReviewJson(existing.correction_json) : {}
  const nextCorrection: Record<string, unknown> = { ...existingCorrection }

  if (update.correctedLabel !== undefined) {
    const label = update.correctedLabel?.trim() ?? ''
    if (label) nextCorrection.label = label
    else delete nextCorrection.label
  }
  if (update.correctedIntentRole !== undefined) {
    if (update.correctedIntentRole) nextCorrection.intentRole = update.correctedIntentRole
    else delete nextCorrection.intentRole
  }
  if (update.correctedIntentSubject !== undefined) {
    const subject = update.correctedIntentSubject?.trim() ?? ''
    if (subject) nextCorrection.intentSubject = subject
    else delete nextCorrection.intentSubject
  }
  if (update.correctedCategory !== undefined) {
    if (isAppCategory(update.correctedCategory)) nextCorrection.category = update.correctedCategory
    else delete nextCorrection.category
  }

  const originalJson = existing?.original_block_json && existing.original_block_json !== '{}'
    ? existing.original_block_json
    : JSON.stringify(originalReviewSnapshotForBlock(block))

  if (existing) {
    db.prepare(`
      UPDATE timeline_block_reviews
      SET block_id = ?,
          date = ?,
          evidence_key = ?,
          review_state = ?,
          original_block_json = ?,
          correction_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      block.id,
      dateStr,
      evidenceKey,
      state,
      originalJson,
      JSON.stringify(nextCorrection),
      now,
      existing.id,
    )
    return
  }

  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id,
      block_id,
      date,
      evidence_key,
      review_state,
      original_block_json,
      correction_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `review_${sha1(`${block.id}:${evidenceKey}`).slice(0, 18)}`,
    block.id,
    dateStr,
    evidenceKey,
    state,
    originalJson,
    JSON.stringify(nextCorrection),
    now,
    now,
  )
}

// Persist a user merge correction so it survives every rebuild and feeds back
// into the boundary scorer as the highest-weight "user correction memory"
// signal. Anchored two ways: the exact session-id pair straddling the boundary,
// AND the merged pair's wall-clock span. The span is the anchor that actually
// survives — session ids live in two namespaces (app_sessions for today,
// derived_sessions for past days) and derived ids churn on reprojection, which
// is why id-only merges used to silently unravel ("merge works half the time").
function writeBoundaryCorrection(
  db: Database.Database,
  dateStr: string,
  leftSessionId: number,
  rightSessionId: number,
  spanStartMs: number,
  spanEndMs: number,
): void {
  if (leftSessionId < 0 || rightSessionId < 0) {
    throw new Error('Cannot record a boundary correction without persisted session evidence.')
  }
  const now = Date.now()
  const id = `bnd_${sha1(`${leftSessionId}:${rightSessionId}`).slice(0, 18)}`
  db.prepare(`
    INSERT INTO timeline_boundary_corrections (id, date, left_session_id, right_session_id, kind, created_at, updated_at, span_start_ms, span_end_ms)
    VALUES (?, ?, ?, ?, 'merge', ?, ?, ?, ?)
    ON CONFLICT(left_session_id, right_session_id)
    DO UPDATE SET kind = excluded.kind, date = excluded.date, updated_at = excluded.updated_at,
                  span_start_ms = excluded.span_start_ms, span_end_ms = excluded.span_end_ms
  `).run(id, dateStr, leftSessionId, rightSessionId, now, now, spanStartMs, spanEndMs)
}

// Merge a contiguous span of episodes into one. A timeline block is continuous
// time, so merging non-adjacent blocks (A and C with B between them) has only
// one coherent meaning: fuse the whole A→B→C span. We record a forced join at
// every internal boundary — the last session of each block to the first session
// of the next — not just the outer pair, so the in-between blocks are absorbed
// too. The scorer keys each merge on those two straddling sessions, so a span
// merge survives Analyze / rebuild exactly like an adjacent one.
// Persist a user "cut here" so it survives every rebuild. Anchored purely by
// wall-clock timestamp (span_start_ms): session ids churn across the
// app_sessions ↔ derived_sessions namespaces, but the moment the user pointed
// at does not. Enforced by enforceUserCuts as the last pipeline pass.
export function writeSplitCorrection(db: Database.Database, dateStr: string, cutMs: number): void {
  const now = Date.now()
  const id = `cut_${sha1(`${dateStr}:${cutMs}`).slice(0, 18)}`
  // The (left, right) session-id pair has a unique index; a cut is anchored to
  // a timestamp, not sessions, so use the negated cut time as a synthetic pair
  // that can never collide with real session ids (always positive) or with a
  // cut at a different moment. INSERT OR REPLACE covers a re-cut of the same
  // moment via either uniqueness (id or pair).
  db.prepare(`
    INSERT OR REPLACE INTO timeline_boundary_corrections (id, date, left_session_id, right_session_id, kind, created_at, updated_at, span_start_ms, span_end_ms)
    VALUES (?, ?, ?, ?, 'split', ?, ?, ?, ?)
  `).run(id, dateStr, -cutMs, -cutMs, now, now, cutMs, cutMs)
}

// Trim a block's time range (block editor → time row). Trim-only by design:
// a block is tracked activity, so its edges can move inward but never outward
// — extending would count idle time as work, which Daylens never does
// (invariant: block duration = genuine engagement). Each moved edge becomes a
// persisted user cut; the trimmed-off stretch re-forms into its own block(s)
// on the rebuild, keeping every tracked minute accounted for.
export function trimTimelineBlockSpan(
  db: Database.Database,
  dateStr: string,
  block: WorkContextBlock,
  startMs: number,
  endMs: number,
): { changed: boolean } {
  const MIN_EDGE_MOVE_MS = 60_000
  const newStart = Math.max(block.startTime, Math.min(startMs, block.endTime))
  const newEnd = Math.min(block.endTime, Math.max(endMs, block.startTime))
  if (newEnd - newStart < MIN_EDGE_MOVE_MS) {
    throw new Error('The block needs at least a minute left after trimming.')
  }
  const startMoved = newStart - block.startTime >= MIN_EDGE_MOVE_MS
  const endMoved = block.endTime - newEnd >= MIN_EDGE_MOVE_MS
  if (!startMoved && !endMoved) return { changed: false }
  if (startMoved) writeSplitCorrection(db, dateStr, newStart)
  if (endMoved) writeSplitCorrection(db, dateStr, newEnd)
  invalidateTimelineDay(db, dateStr)
  return { changed: true }
}

export function mergeTimelineEpisodes(
  db: Database.Database,
  dateStr: string,
  blocks: WorkContextBlock[],
): void {
  const ordered = [...blocks].sort((a, b) => a.startTime - b.startTime)
  if (ordered.length < 2) {
    throw new Error('Pick at least two blocks to merge.')
  }
  // The absence guard (lib/absenceGuard.ts): a merge may never join work
  // across a real absence of 15+ minutes — a block is genuine engagement, and
  // the fused span would silently count time away as work. This is the single
  // write path every merge uses (manual Merge, AI merge actions, the day
  // regroup), so the veto here covers them all.
  const spannedAbsence = absenceSpannedBy(ordered.flatMap((block) => block.sessions))
  if (spannedAbsence) {
    throw new Error(
      `These blocks are separated by a real absence (${formatAbsenceRange(spannedAbsence)}). `
      + 'Daylens never joins work across time away.',
    )
  }
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const earlier = ordered[i]
    const later = ordered[i + 1]
    const leftLast = [...earlier.sessions].filter((s) => s.id >= 0).sort((a, b) => a.startTime - b.startTime).pop()
    const rightFirst = [...later.sessions].filter((s) => s.id >= 0).sort((a, b) => a.startTime - b.startTime)[0]
    if (!leftLast || !rightFirst) {
      // A boundary correction is keyed by two persisted sessions. The live block
      // holds only its in-flight session until the tracker flushes it, so a merge
      // touching a just-started episode has nothing to anchor on yet.
      throw new Error('This episode is still live — give it a moment to settle, then merge.')
    }
    // The span anchor covers the whole fused pair: any boundary a future
    // rebuild proposes strictly inside (earlier.start, later.end) is erased.
    writeBoundaryCorrection(db, dateStr, leftLast.id, rightFirst.id, earlier.startTime, later.endTime)
  }
  invalidateTimelineDay(db, dateStr)
}

function workflowIdFor(signatureKey: string): string {
  return `wf_${sha1(signatureKey).slice(0, 16)}`
}

function labelConfidenceValue(confidence: BlockConfidence): number {
  if (confidence === 'high') return 0.9
  if (confidence === 'medium') return 0.7
  return 0.45
}

function artifactKindForSession(session: AppSession): DocumentRef['artifactType'] {
  const title = session.windowTitle?.toLowerCase() ?? ''
  if (session.category === 'development') {
    if (title.includes('github') || title.includes('.git')) return 'repo'
    return 'project'
  }
  if (session.category === 'writing' || session.category === 'productivity' || session.category === 'design') {
    return 'document'
  }
  return 'window'
}

// B9: terminal apps (Warp, Ghostty, iTerm, Kiro terminal) frequently set
// their window title to whatever the shell prompt emits — the OS username,
// the current working-directory name, or a single bare token. Surfacing
// "tonny" or "Obsidian Vault" as a session label in the Apps "What you did
// there" list is a window-title leak masquerading as activity. Reject
// titles that match the running user's name or that are a single short
// bare token with no path/punctuation evidence. A path-shaped title like
// "~/Dev-Personal/daylens" or a multi-word title still passes through —
// only username-shaped noise is filtered.
const SHELL_PROMPT_TOKENS = new Set(['root', 'bash', 'zsh', 'sh', 'fish', 'admin', 'user'])
const HOME_USERNAME = (process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '').toLowerCase()

function looksLikeShellPromptTitle(title: string): boolean {
  const lower = title.toLowerCase().trim()
  if (HOME_USERNAME && lower === HOME_USERNAME) return true
  if (SHELL_PROMPT_TOKENS.has(lower)) return true
  // Single short bare token with no whitespace, slash, dot, or dash. Genuine
  // page titles ("Inbox", "Daylens") would still match this shape — but
  // those are filtered earlier by titleLooksUseful + appName/rawAppName
  // checks below; terminal-prompt noise is what slips through.
  if (lower.length <= 14 && !/[\s/\\.\-:]/.test(lower)) {
    // Allow it through only if it looks like camelCase or contains digits —
    // a clue that it's a real entity rather than a shell username.
    if (!/[A-Z0-9]/.test(title)) return true
  }
  return false
}

export function usefulWindowTitle(session: AppSession): string | null {
  if (!titleLooksUseful(session.windowTitle)) return null
  const title = session.windowTitle.trim()
  const lowerTitle = title.toLowerCase()
  if (lowerTitle === session.appName.toLowerCase()) return null
  if (lowerTitle === (session.rawAppName ?? '').toLowerCase()) return null
  if (looksLikeShellPromptTitle(title)) return null
  // Never let an OS surface title (lock screen, notification toast) name a
  // block — invariant 5/11 (defense in depth; capture also drops these).
  if (isSystemNoiseTitle(title)) return null
  return title
}

export function compactWindowTitle(title: string): string {
  return title
    .split(/\s[—-]\s/)
    .map((part) => part.trim())
    .find((part) => part.length > 2) ?? title.trim()
}

function contentContextForSession(session: AppSession): string {
  const title = usefulWindowTitle(session)
  if (title) return compactWindowTitle(title).toLowerCase()
  return `${session.category}:${session.bundleId}`.toLowerCase()
}

function contextRunsFor(sessions: AppSession[]): ContextRun[] {
  if (sessions.length === 0) return []

  const runs: ContextRun[] = []
  let currentContext = contentContextForSession(sessions[0])
  let startIndex = 0
  let totalSeconds = sessions[0].durationSeconds

  for (let index = 1; index < sessions.length; index++) {
    const session = sessions[index]
    const context = contentContextForSession(session)
    if (context === currentContext) {
      totalSeconds += session.durationSeconds
      continue
    }

    runs.push({ context: currentContext, startIndex, totalSeconds })
    currentContext = context
    startIndex = index
    totalSeconds = session.durationSeconds
  }

  runs.push({ context: currentContext, startIndex, totalSeconds })
  return runs
}

interface TimelineBuildContext {
  websiteVisits: WebsiteVisitRecord[]
  // Per-session work/leisure/personal kind, keyed by session identity. Resolved
  // once from category + (for browser sessions) the dominant domain in the
  // session's window. This is what makes a `kind` change a hard segmentation
  // boundary — coding can never be absorbed into a video block.
  sessionKind: Map<AppSession, WorkKind>
}

function browserBundleMatchesSession(visit: WebsiteVisitRecord, session: AppSession): boolean {
  if (!visit.browserBundleId && !visit.canonicalBrowserId) return true
  return visit.browserBundleId === session.bundleId
    || visit.canonicalBrowserId === session.bundleId
    || (session.canonicalAppId != null && visit.canonicalBrowserId === session.canonicalAppId)
}

// Resolve one session's kind, or null when it is neutral (bare browsing with no
// domain signal) and should inherit a neighbour's kind. Browser sessions take
// the kind of the domains they actually sat on (youtube → leisure, github →
// work); native app sessions trust their category.
function resolveSessionKindRaw(session: AppSession, visits: WebsiteVisitRecord[]): WorkKind | null {
  if (!isBrowserSession(session)) {
    const native = resolveKind({ category: session.category, isBrowser: false })
    return native.neutral ? null : native.kind
  }
  const start = session.startTime
  const end = sessionEndMs(session)
  const byDomain = new Map<string, number>()
  for (const visit of visits) {
    if (visit.visitTime < start || visit.visitTime >= end) continue
    if (!browserBundleMatchesSession(visit, session)) continue
    byDomain.set(visit.domain, (byDomain.get(visit.domain) ?? 0) + Math.max(1, visit.durationSec))
  }
  const domains = [...byDomain.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([domain]) => domain)
  const resolution = resolveKind({ category: session.category, isBrowser: true, domains })
  return resolution.neutral ? null : resolution.kind
}

function buildTimelineContext(db: Database.Database, sessions: AppSession[]): TimelineBuildContext {
  if (sessions.length === 0) return { websiteVisits: [], sessionKind: new Map() }
  const startTime = Math.min(...sessions.map((session) => session.startTime))
  const endTime = Math.max(...sessions.map((session) => sessionEndMs(session)))
  const websiteVisits = getWebsiteVisitsForRange(db, startTime, endTime)

  // Resolve raw kinds, then let neutral (bare-browsing) sessions inherit the
  // nearest concrete neighbour so a contentless tab-flip never forces a kind
  // boundary inside an otherwise-continuous episode.
  const raw = sessions.map((session) => resolveSessionKindRaw(session, websiteVisits))
  const sessionKind = new Map<AppSession, WorkKind>()
  sessions.forEach((session, index) => {
    if (raw[index]) {
      sessionKind.set(session, raw[index]!)
      return
    }
    let inherited: WorkKind | null = null
    for (let j = index - 1; j >= 0 && !inherited; j--) inherited = raw[j]
    for (let j = index + 1; j < raw.length && !inherited; j++) inherited = raw[j]
    sessionKind.set(session, inherited ?? 'personal')
  })

  return { websiteVisits, sessionKind }
}

// The kind of a session as seen by the build context; falls back to a
// category-only resolution when the session predates the context map (live
// sessions spliced in after the fact).
function sessionKindFor(session: AppSession, context?: TimelineBuildContext): WorkKind {
  const cached = context?.sessionKind.get(session)
  if (cached) return cached
  return resolveKind({ category: session.category, isBrowser: isBrowserSession(session) }).kind
}

// The dominant kind across a candidate's sessions, weighted by active time.
function candidateKind(candidate: CandidateBlock, context?: TimelineBuildContext): WorkKind {
  const weighted = candidate.sessions.map((session) => ({
    kind: sessionKindFor(session, context),
    seconds: session.durationSeconds,
  }))
  return dominantKind(weighted)
}

// Two candidates may only be merged when they belong to the same kind. A
// work↔leisure (or any kind) change is a hard boundary, never erased.
function candidatesShareKind(left: CandidateBlock, right: CandidateBlock, context?: TimelineBuildContext): boolean {
  return candidateKind(left, context) === candidateKind(right, context)
}

// Split a run of sessions into maximal same-kind runs so no candidate is ever
// built across a kind boundary.
function splitSessionsByKind(sessions: AppSession[], context?: TimelineBuildContext): AppSession[][] {
  if (sessions.length === 0) return []
  const runs: AppSession[][] = []
  let current: AppSession[] = [sessions[0]]
  let currentKind = sessionKindFor(sessions[0], context)
  for (let index = 1; index < sessions.length; index++) {
    const kind = sessionKindFor(sessions[index], context)
    if (kind === currentKind) {
      current.push(sessions[index])
      continue
    }
    runs.push(current)
    current = [sessions[index]]
    currentKind = kind
  }
  runs.push(current)
  return runs
}

function sustainedContextShiftSplitIndex(sessions: AppSession[]): number | null {
  const runs = contextRunsFor(sessions)
  if (runs.length < 2) return null

  let previousSustainedContext: string | null = null
  let previousSustainedSeconds = 0
  for (const run of runs) {
    if (run.totalSeconds < SUSTAINED_CONTEXT_SHIFT_THRESHOLD_SEC) continue
    const leftSpan = run.startIndex > 0 ? sessionEndMs(sessions[run.startIndex - 1]) - sessions[0].startTime : 0
    const rightSpan = sessionEndMs(sessions[sessions.length - 1]) - sessions[run.startIndex].startTime
    if (
      previousSustainedContext
      && previousSustainedContext !== run.context
      && previousSustainedSeconds >= SUSTAINED_CONTEXT_SHIFT_THRESHOLD_SEC
      && leftSpan >= SUSTAINED_CONTEXT_SHIFT_THRESHOLD_SEC * 1000
      && rightSpan >= SUSTAINED_CONTEXT_SHIFT_THRESHOLD_SEC * 1000
    ) {
      return run.startIndex
    }
    previousSustainedContext = run.context
    previousSustainedSeconds = run.totalSeconds
  }

  return null
}

function buildPageCandidates(
  db: Database.Database,
  startTime: number,
  endTime: number,
  // Reconciliation (below) always needs a fresh DB read of sessions/absences
  // for this exact span, so the context.websiteVisits fast path this used to
  // take no longer applies — the parameter stays for call-site compatibility
  // with the many context-threading callers elsewhere in this file.
  _context?: TimelineBuildContext,
): ArtifactCandidate[] {
  const grouped = new Map<string, {
    canonicalKey: string
    domain: string
    browserBundleId: string | null
    canonicalBrowserId: string | null
    displayTitle: string
    pageTitle: string | null
    normalizedUrl: string | null
    pageKey: string | null
    url: string | null
    totalSeconds: number
    visitCount: number
  }>()

  // A page's credited time is bounded the same way a domain's is (spec:
  // timeline.md §3.0 "evidence object", invariant 6): clipped to the
  // moments its own browser was actually frontmost in this span, or to an
  // honest capture gap. History rows accrue in the background and while the
  // browser was never foreground at all, so a visit with zero reconciled
  // overlap contributes nothing and must not enter the block's evidence —
  // it never shows up as a page the user "was in".
  for (const { visit, freeIntervals } of getReconciledWebsiteVisitsForRange(db, startTime, endTime)) {
    // Domain policy gate: adult-host pages are filtered at source so they
    // never become artifact candidates, never get promoted to block labels,
    // and never appear in any app's topArtifacts list. The raw visit row
    // stays in website_visits.url so the user can still see their own
    // browsing history if they look — we just don't surface it as a
    // headline anywhere in the product.
    if (isHostFilteredFromArtifacts(visit.domain)) continue

    const creditedSeconds = Math.round(
      freeIntervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1000,
    )
    if (creditedSeconds <= 0) continue

    const canonicalKey = visit.normalizedUrl ?? normalizeUrlForStorage(visit.url) ?? `domain:${visit.domain}`
    const existing = grouped.get(canonicalKey)
    const pageTitle = normalizeWebsiteTitleForDisplay(visit.domain, visit.pageTitle)
    const displayTitle = pageTitle || websiteDisplayLabel(visit.domain)

    if (existing) {
      existing.totalSeconds += creditedSeconds
      existing.visitCount += 1
      if (!existing.pageTitle && pageTitle) {
        existing.pageTitle = pageTitle
        existing.displayTitle = displayTitle
      }
      continue
    }

    grouped.set(canonicalKey, {
      canonicalKey,
      domain: visit.domain,
      browserBundleId: visit.browserBundleId,
      canonicalBrowserId: visit.canonicalBrowserId,
      displayTitle,
      pageTitle,
      normalizedUrl: visit.normalizedUrl ?? null,
      pageKey: visit.pageKey ?? null,
      url: visit.url ?? null,
      totalSeconds: creditedSeconds,
      visitCount: 1,
    })
  }

  return Array.from(grouped.values())
    .sort((left, right) => {
      const kindDelta = Number(kindForDomain(left.domain) === 'leisure')
        - Number(kindForDomain(right.domain) === 'leisure')
      return kindDelta || right.totalSeconds - left.totalSeconds
    })
    .slice(0, 8)
    .map((page) => {
      const pageRef: PageRef = {
        id: artifactIdFor(`page:${page.canonicalKey}`),
        artifactType: 'page',
        canonicalKey: `page:${page.canonicalKey}`,
        displayTitle: page.displayTitle,
        subtitle: page.domain,
        totalSeconds: page.totalSeconds,
        confidence: 0.9,
        canonicalAppId: page.canonicalBrowserId
          ?? (page.browserBundleId
            ? resolveCanonicalApp(page.browserBundleId, page.browserBundleId).canonicalAppId
            : null),
        url: page.url,
        host: page.domain,
        openTarget: {
          kind: page.url ? 'external_url' : 'unsupported',
          value: page.url,
        },
        metadata: {
          normalizedUrl: page.normalizedUrl,
        },
        domain: page.domain,
        browserBundleId: page.browserBundleId,
        canonicalBrowserId: page.canonicalBrowserId,
        normalizedUrl: page.normalizedUrl,
        pageKey: page.pageKey,
        pageTitle: page.pageTitle,
        visitCount: page.visitCount,
      }

      return {
        artifact: pageRef,
        pageRef,
        sourceType: 'website_visit',
        sourceId: page.canonicalKey,
        startTime,
        endTime,
      }
    })
}

function buildWindowArtifactCandidates(sessions: AppSession[]): ArtifactCandidate[] {
  const grouped = new Map<string, {
    sessionIds: number[]
    title: string
    artifactType: DocumentRef['artifactType']
    totalSeconds: number
    canonicalAppId: string | null
    ownerBundleId: string | null
    ownerAppName: string | null
    ownerAppInstanceId: string | null
  }>()

  for (const session of sessions) {
    // Browser sessions' window titles ARE their page titles — those should
    // be sourced from website_visits via buildPageCandidates (which is
    // policy-aware), not from window-title heuristics. Creating a
    // window-type document artifact from a browser window title duplicates
    // the page and bypasses the adult-host filter at buildPageCandidates.
    if (isBrowserSession(session)) continue

    const title = usefulWindowTitle(session)
    if (!title) continue

    const artifactType = artifactKindForSession(session)
    const displayTitle = compactWindowTitle(title)
    const canonicalAppId = session.canonicalAppId ?? resolveCanonicalApp(session.bundleId, session.appName).canonicalAppId
    const canonicalKey = `${artifactType}:${canonicalAppId ?? session.bundleId}:${displayTitle.toLowerCase()}`
    const existing = grouped.get(canonicalKey)

    if (existing) {
      existing.totalSeconds += session.durationSeconds
      existing.sessionIds.push(session.id)
      existing.ownerBundleId = existing.ownerBundleId ?? session.bundleId
      existing.ownerAppName = existing.ownerAppName ?? session.appName
      existing.ownerAppInstanceId = existing.ownerAppInstanceId ?? session.appInstanceId ?? null
      continue
    }

    grouped.set(canonicalKey, {
      sessionIds: [session.id],
      title: displayTitle,
      artifactType,
      totalSeconds: session.durationSeconds,
      canonicalAppId,
      ownerBundleId: session.bundleId,
      ownerAppName: session.appName,
      ownerAppInstanceId: session.appInstanceId ?? null,
    })
  }

  return Array.from(grouped.entries())
    .sort((left, right) => right[1].totalSeconds - left[1].totalSeconds)
    .slice(0, 5)
    .map(([canonicalKey, value]) => {
      const documentRef: DocumentRef = {
        id: artifactIdFor(canonicalKey),
        artifactType: value.artifactType,
        canonicalKey,
        displayTitle: value.title,
        subtitle: value.canonicalAppId ?? null,
        totalSeconds: value.totalSeconds,
        confidence: 0.7,
        canonicalAppId: value.canonicalAppId,
        ownerBundleId: value.ownerBundleId,
        ownerAppName: value.ownerAppName,
        ownerAppInstanceId: value.ownerAppInstanceId,
        openTarget: {
          kind: 'unsupported',
          value: null,
        },
        metadata: {
          ownerBundleId: value.ownerBundleId,
          ownerAppName: value.ownerAppName,
          ownerAppInstanceId: value.ownerAppInstanceId,
        },
        sourceSessionIds: value.sessionIds,
      }

      return {
        artifact: documentRef,
        documentRef,
        sourceType: 'app_session',
        sourceId: value.sessionIds.join(','),
        startTime: sessions[0]?.startTime ?? 0,
        endTime: sessions[sessions.length - 1]?.endTime ?? sessions[sessions.length - 1]?.startTime ?? 0,
      }
    })
}

// Reads real-time tab events (tab_changed / tab_sampled) from focus_events for
// the block's time range. This is the live source of URL + page-title data —
// it's populated immediately by the capture helper, unlike website_visits which
// is populated by a background browser-history poll that can lag by minutes.
// A 10-second floor is applied so sub-10s tab flickers don't inflate the list.
// Exported so tests can build real live-day PageRefs from focus_events
// through the actual producer, rather than hand-rolling a shape that could
// drift from what this function really returns.
export function buildTabEvidenceFromFocusEvents(
  db: Database.Database,
  startTime: number,
  endTime: number,
): PageRef[] {
  type TabRow = {
    ts_ms: number
    url: string
    page_title: string | null
    app_bundle_id: string | null
  }
  let rows: TabRow[] = []
  try {
    rows = db.prepare(`
      SELECT ts_ms, url, page_title, app_bundle_id
      FROM focus_events
      WHERE event_type IN ('tab_changed', 'tab_sampled')
        AND url IS NOT NULL
        AND trim(url) <> ''
        AND ts_ms >= ?
        AND ts_ms < ?
      ORDER BY ts_ms ASC, id ASC
    `).all(startTime, endTime) as TabRow[]
  } catch {
    return []
  }

  const MIN_TAB_DWELL_MS = 10_000 // match the session dwell floor
  const grouped = new Map<string, {
    url: string
    normalizedUrl: string | null
    domain: string
    pageTitle: string | null
    browserBundleId: string | null
    totalMs: number
    visitCount: number
  }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const nextTs = rows[i + 1]?.ts_ms ?? endTime
    const dwellMs = Math.max(0, Math.min(nextTs - row.ts_ms, endTime - row.ts_ms))
    if (dwellMs < MIN_TAB_DWELL_MS) continue

    let domain: string
    try {
      domain = new URL(row.url).hostname.replace(/^www\./, '')
    } catch {
      continue
    }
    if (!domain) continue

    const normalizedUrl = normalizeUrlForStorage(row.url) ?? null
    const key = normalizedUrl ?? row.url
    const existing = grouped.get(key)
    if (existing) {
      existing.totalMs += dwellMs
      existing.visitCount += 1
      if (!existing.pageTitle && row.page_title) existing.pageTitle = row.page_title
      continue
    }
    grouped.set(key, {
      url: row.url,
      normalizedUrl,
      domain,
      pageTitle: row.page_title ?? null,
      browserBundleId: row.app_bundle_id ?? null,
      totalMs: dwellMs,
      visitCount: 1,
    })
  }

  return Array.from(grouped.values())
    .sort((a, b) => {
      // Work before leisure
      const aLeisure = Number(kindForDomain(a.domain) === 'leisure')
      const bLeisure = Number(kindForDomain(b.domain) === 'leisure')
      return (aLeisure - bLeisure) || (b.totalMs - a.totalMs)
    })
    .slice(0, 10)
    .map((entry): PageRef => {
      const canonicalKey = `page:${entry.normalizedUrl ?? entry.url}`
      const displayTitle = entry.pageTitle ?? websiteDisplayLabel(entry.domain)
      // Owner linkage, mirroring buildPageCandidates (above): a page is owned
      // by the browser it happened in, so the block-detail panel's
      // ownerKeyFor can nest it under that browser's app row. Without this,
      // tab-evidence pages — the dominant page source for today's live block,
      // since website_visits lags behind real-time tab tracking — carry only
      // browserBundleId/canonicalBrowserId (PageRef-specific fields) and
      // never match the app-owner fields the renderer checked first, so they
      // fell through to the flat/orphan list instead of nesting under Dia.
      const canonicalAppId = entry.browserBundleId
        ? resolveCanonicalApp(entry.browserBundleId, entry.browserBundleId).canonicalAppId
        : null
      return {
        id: artifactIdFor(canonicalKey),
        artifactType: 'page',
        canonicalKey,
        displayTitle,
        subtitle: entry.domain,
        totalSeconds: Math.round(entry.totalMs / 1_000),
        confidence: 0.85,
        canonicalAppId,
        ownerBundleId: entry.browserBundleId,
        url: entry.url,
        host: entry.domain,
        openTarget: { kind: 'external_url', value: entry.url },
        domain: entry.domain,
        normalizedUrl: entry.normalizedUrl,
        pageKey: null,
        pageTitle: entry.pageTitle ?? null,
        browserBundleId: entry.browserBundleId,
        canonicalBrowserId: null,
        visitCount: entry.visitCount,
      }
    })
}


function buildWindowTitleEvidence(

  db: Database.Database,
  startTime: number,
  endTime: number,
  sessions: AppSession[],
): NonNullable<TimelineEvidenceSummary['windowTitles']> {
  const grouped = new Map<string, NonNullable<TimelineEvidenceSummary['windowTitles']>[number]>()
  let capturedRows: Array<{
    ts_ms: number
    app_bundle_id: string | null
    app_name: string | null
    window_title: string
  }> = []
  try {
    capturedRows = db.prepare(`
      SELECT ts_ms, app_bundle_id, app_name, window_title
      FROM focus_events
      WHERE source IN ('nsworkspace_event', 'uia_foreground')
        AND event_type IN ('app_activated', 'window_changed', 'space_changed')
        AND window_title IS NOT NULL
        AND trim(window_title) <> ''
        AND ts_ms >= ?
        AND ts_ms < ?
      ORDER BY ts_ms ASC, id ASC
    `).all(startTime, endTime) as typeof capturedRows
  } catch {
    capturedRows = []
  }

  const titleIntervals = capturedRows.length > 0
    ? capturedRows.map((row, index) => ({
        title: row.window_title.trim(),
        bundleId: row.app_bundle_id?.trim() || row.app_name?.trim() || 'unknown',
        appName: row.app_name?.trim() || row.app_bundle_id?.trim() || 'Unknown app',
        startTime: Math.max(startTime, row.ts_ms),
        endTime: Math.min(endTime, capturedRows[index + 1]?.ts_ms ?? endTime),
      }))
    : sessions.map((session) => ({
        title: session.windowTitle?.trim() ?? '',
        bundleId: session.bundleId,
        appName: session.appName,
        startTime: session.startTime,
        endTime: session.endTime ?? session.startTime + session.durationSeconds * 1_000,
      }))

  for (const interval of titleIntervals) {
    const title = interval.title
    if (!title || !titleLooksUseful(title)) continue
    if (title.toLowerCase() === interval.appName.trim().toLowerCase()) continue
    const totalSeconds = Math.max(1, Math.round((interval.endTime - interval.startTime) / 1_000))
    const key = `${interval.bundleId}\u0000${title.toLowerCase()}`
    const existing = grouped.get(key)
    if (existing) {
      existing.startTime = Math.min(existing.startTime, interval.startTime)
      existing.endTime = Math.max(existing.endTime, interval.endTime)
      existing.totalSeconds += totalSeconds
      continue
    }
    grouped.set(key, {
      title,
      bundleId: interval.bundleId,
      appName: interval.appName,
      startTime: interval.startTime,
      endTime: interval.endTime,
      totalSeconds,
    })
  }

  return [...grouped.values()]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 12)
}

function buildFileEvidence(
  windowTitles: NonNullable<TimelineEvidenceSummary['windowTitles']>,
): NonNullable<TimelineEvidenceSummary['files']> {
  const grouped = new Map<string, NonNullable<TimelineEvidenceSummary['files']>[number]>()

  for (const evidence of windowTitles) {
    for (const filename of extractFilenames(evidence.title)) {
      const key = filename.toLowerCase()
      const existing = grouped.get(key)
      if (existing) {
        existing.firstSeenAt = Math.min(existing.firstSeenAt, evidence.startTime)
        existing.totalSeconds += evidence.totalSeconds
        continue
      }
      grouped.set(key, {
        filename,
        path: /[/\\]/.test(filename) ? filename : null,
        appName: evidence.appName,
        windowTitle: evidence.title,
        firstSeenAt: evidence.startTime,
        totalSeconds: evidence.totalSeconds,
        inferred: true,
      })
    }
  }

  return [...grouped.values()]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 12)
}

function workflowLabelForBlock(apps: string[], block: WorkContextBlock): string {
  if (apps.length === 0) return userVisibleLabelForBlock(block)
  // Map canonical IDs → display names using the block's own topApps list
  const idToName = new Map(
    block.topApps.map((a) => {
      const identity = resolveCanonicalApp(a.bundleId, a.appName)
      return [identity.canonicalAppId ?? a.bundleId, a.appName]
    })
  )
  const names = apps.map((id) => {
    const found = idToName.get(id)
    if (found) return found
    // Fallback: title-case the canonical ID (better than leaking raw id)
    return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  })
  if (names.length === 1) return `${names[0]} loop`
  return `${names.slice(0, 2).join(' + ')}`
}

function focusOverlapForRange(
  db: Database.Database,
  startTime: number,
  endTime: number,
): { totalSeconds: number; pct: number; sessionIds: number[] } {
  const overlaps = getFocusSessionsForDateRange(db, startTime, endTime)
    .map((session) => {
      const overlapStart = Math.max(session.startTime, startTime)
      const overlapEnd = Math.min(session.endTime ?? endTime, endTime)
      return {
        sessionId: session.id,
        seconds: Math.max(0, Math.round((overlapEnd - overlapStart) / 1000)),
      }
    })
    .filter((entry) => entry.seconds > 0)

  const totalSeconds = overlaps.reduce((sum, entry) => sum + entry.seconds, 0)
  const spanSeconds = Math.max(1, Math.round((endTime - startTime) / 1000))
  return {
    totalSeconds,
    pct: Math.min(100, Math.round((totalSeconds / spanSeconds) * 100)),
    sessionIds: overlaps.map((entry) => entry.sessionId),
  }
}

function buildBlockFromCandidate(
  candidate: CandidateBlock,
  db: Database.Database,
  context?: TimelineBuildContext,
): WorkContextBlock {
  const blockStart = candidate.sessions[0].startTime
  const lastSession = candidate.sessions[candidate.sessions.length - 1]
  const blockEnd = lastSession.endTime ?? (lastSession.startTime + lastSession.durationSeconds * 1000)
  // The persisted block facts use the site-weighted distribution so a
  // browser-heavy block's category reflects what happened INSIDE the browser,
  // not which browser it was.
  const distribution = weightedCategoryDistributionFor(db, candidate.sessions, blockStart, blockEnd)
  const coherence = coherenceScore(distribution)
  const switchCount = countAppSwitches(candidate.sessions)
  const computedAt = Date.now()
  const websites = filterExcludedWebsiteSummaries(
    db, getWebsiteSummariesForRange(db, blockStart, blockEnd), blockStart, blockEnd,
  ).slice(0, 5)
  const keyPagesByDomain = getTopPagesForDomains(db, blockStart, blockEnd, websites.map((site) => site.domain), 2)
  const keyPages = websites.flatMap((site) => keyPagesByDomain[site.domain] ?? [])
    .map((page) => page.title?.trim())
    .filter((title): title is string => Boolean(title))
    .filter((title, index, titles) => titles.indexOf(title) === index)
    .slice(0, 4)
  const isLive = candidate.sessions.some((session) => session.id === -1)
  const storedInsight = isLive ? null : getWorkContextInsightForRange(db, blockStart, blockEnd)
  const confidence = confidenceForCandidate(candidate, coherence)
  const topApps = topAppsFromSessions(candidate.sessions)
  const backgroundApps = getBackgroundProcessEvidence(blockStart, blockEnd).map((process) => ({
    bundleId: `${process.name}.exe`,
    appName: process.name,
    category: 'development' as AppCategory,
    totalSeconds: process.totalSeconds,
    sessionCount: 1,
    isBrowser: false,
  }))
  const mergedTopApps = [...topApps]
  for (const backgroundApp of backgroundApps) {
    const existing = mergedTopApps.find((app) => app.appName.toLowerCase() === backgroundApp.appName.toLowerCase())
    if (existing) {
      existing.totalSeconds = Math.max(existing.totalSeconds, backgroundApp.totalSeconds)
      continue
    }
    mergedTopApps.push(backgroundApp)
  }
  const pageCandidates = buildPageCandidates(db, blockStart, blockEnd, context)
  const windowCandidates = buildWindowArtifactCandidates(candidate.sessions)
  const visitPageRefs = pageCandidates.flatMap((candidate) => candidate.pageRef ? [candidate.pageRef] : [])
  // Supplement website_visits pages with real-time tab evidence from focus_events.
  // Tab evidence is populated immediately by the capture helper; website_visits
  // lags by the browser-history poll interval and can be empty for today's blocks.
  const tabPageRefs = buildTabEvidenceFromFocusEvents(db, blockStart, blockEnd)
  // Merge: tab evidence first (richer, more timely), then add any visit-based
  // pages whose URL isn't already covered by the tab evidence.
  const seenUrls = new Set(tabPageRefs.map((p) => p.normalizedUrl ?? p.url ?? '').filter(Boolean))
  const mergedPageRefs = [
    ...tabPageRefs,
    ...visitPageRefs.filter((p) => {
      const key = p.normalizedUrl ?? p.url ?? ''
      return key && !seenUrls.has(key)
    }),
  ].slice(0, 12)
  const documentRefs = windowCandidates.flatMap((candidate) => candidate.documentRef ? [candidate.documentRef] : [])
  const topArtifacts = [...mergedPageRefs, ...documentRefs]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 6)
  const dominantCategory = dominantCategoryForBlock(distribution, topArtifacts)
  const windowTitles = buildWindowTitleEvidence(db, blockStart, blockEnd, candidate.sessions)
  // Derive domains from both sources so blocks with only focus_events tab data
  // still have a meaningful domain summary.
  const websiteDomains = websites.map((site) => site.domain)
  const tabDomains = [...new Set(tabPageRefs.map((p) => p.domain).filter(Boolean))]
  const allDomains = [...new Set([...websiteDomains, ...tabDomains])].slice(0, 5)
  const evidenceSummary = {
    apps: mergedTopApps,
    pages: mergedPageRefs,
    documents: documentRefs,
    domains: allDomains,
    windowTitles,
    sites: mergedPageRefs,
    files: buildFileEvidence(windowTitles),
  }

  const blockId = blockIdFor(
    blockStart,
    blockEnd,
    candidate.sessions.map((session) => session.id),
    isLive,
  )
  const rawRuleLabel = labelForCandidate(candidate, dominantCategory, distribution, coherence, switchCount)

  const baseBlock: WorkContextBlock = {
    id: blockId,
    startTime: blockStart,
    endTime: blockEnd,
    dominantCategory,
    categoryDistribution: distribution,
    ruleBasedLabel: rawRuleLabel,
    aiLabel: storedInsight?.label ?? null,
    sessions: candidate.sessions,
    topApps: mergedTopApps,
    websites,
    keyPages,
    pageRefs: mergedPageRefs,
    documentRefs,
    topArtifacts,
    workflowRefs: [],
    label: {
      current: rawRuleLabel,
      source: 'rule',
      confidence: labelConfidenceValue(confidence),
      narrative: storedInsight?.narrative ?? null,
      ruleBased: rawRuleLabel,
      aiSuggested: storedInsight?.label ?? null,
      override: null,
    },
    focusOverlap: focusOverlapForRange(db, blockStart, blockEnd),
    evidenceSummary,
    heuristicVersion: TIMELINE_HEURISTIC_VERSION,
    computedAt,
    switchCount,
    confidence,
    review: {
      ...DEFAULT_TIMELINE_BLOCK_REVIEW,
      state: confidence === 'low' ? 'pending' : 'auto-approved',
    },
    isLive,
    // timeline.md §3.2/§3.6: the block's kind follows its *overall intent*. A
    // brief folded peek (Netflix/X) must not flip a work block to leisure just
    // because it out-weighs the work by raw seconds — when the intent-weighted
    // dominant category is focused work, the block is work. Genuine leisure
    // blocks (dominant category entertainment/social) keep their leisure kind.
    kind: FOCUSED_CATEGORIES.includes(dominantCategory)
      ? 'work'
      : candidateKind(candidate, context),
  }

  const normalizedBlock = {
    ...baseBlock,
    ruleBasedLabel: websiteAwareLabel(baseBlock),
  }

  const workflowApps = normalizedBlock.topApps
    .map((app) => app.bundleId)
    .map((bundleId, index) => {
      const identity = resolveCanonicalApp(bundleId, normalizedBlock.topApps[index].appName)
      return identity.canonicalAppId ?? bundleId
    })
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 3)
  const workflowArtifactKeys = normalizedBlock.topArtifacts
    .map((artifact) => artifact.canonicalKey ?? artifact.id)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 3)
  const signatureKey = JSON.stringify({
    apps: workflowApps,
    artifacts: workflowArtifactKeys,
    label: normalizedBlock.ruleBasedLabel.toLowerCase(),
    category: dominantCategory,
  })

  const workflowRef: WorkflowRef = {
    id: workflowIdFor(signatureKey),
    signatureKey,
    label: workflowLabelForBlock(workflowApps, normalizedBlock),
    confidence: Math.min(0.9, labelConfidenceValue(confidence)),
    dominantCategory,
    canonicalApps: workflowApps,
    artifactKeys: workflowArtifactKeys,
  }

  const boundary: BlockBoundary = {
    startReasons: candidate.startReasons && candidate.startReasons.length > 0 ? candidate.startReasons : ['day-start'],
    endReasons: candidate.endReasons && candidate.endReasons.length > 0 ? candidate.endReasons : ['day-end'],
  }

  return {
    ...normalizedBlock,
    label: {
      ...normalizedBlock.label,
      current: normalizedBlock.ruleBasedLabel,
      ruleBased: normalizedBlock.ruleBasedLabel,
    },
    workflowRefs: workflowApps.length > 0 ? [workflowRef] : [],
    boundary,
  }
}

function analyzeSessions(
  sessions: AppSession[],
  boundedBeforeGap: boolean,
  boundedAfterGap: boolean,
): CandidateBlock[] {
  if (sessions.length === 0) return []

  const firstMeetingIndex = sessions.findIndex(isStandaloneMeeting)
  if (firstMeetingIndex >= 0) {
    const blocks: CandidateBlock[] = []
    const before = sessions.slice(0, firstMeetingIndex)
    if (before.length > 0) {
      blocks.push(...analyzeSessions(before, boundedBeforeGap, false))
    }

    const meeting = sessions[firstMeetingIndex]
    blocks.push({
      sessions: [meeting],
      formation: 'meeting',
      boundedBeforeGap: firstMeetingIndex === 0 ? boundedBeforeGap : false,
      boundedAfterGap: firstMeetingIndex === sessions.length - 1 ? boundedAfterGap : false,
      forcedLabel: meetingLabel(meeting),
    })

    const after = sessions.slice(firstMeetingIndex + 1)
    if (after.length > 0) {
      blocks.push(...analyzeSessions(after, false, boundedAfterGap))
    }
    return blocks
  }

  const contextSplitIndex = sustainedContextShiftSplitIndex(sessions)
  if (contextSplitIndex !== null) {
    return splitAndAnalyze(sessions, contextSplitIndex, boundedBeforeGap, boundedAfterGap)
  }

  const streak = longSingleAppStreak(sessions)
  if (streak) {
    const [startIndex, endIndex] = streak.range
    const blocks: CandidateBlock[] = []
    if (startIndex > 0) {
      blocks.push(...analyzeSessions(sessions.slice(0, startIndex), boundedBeforeGap, false))
    }
    blocks.push({
      sessions: sessions.slice(startIndex, endIndex),
      formation: 'longSingleApp',
      boundedBeforeGap: startIndex === 0 ? boundedBeforeGap : false,
      boundedAfterGap: endIndex === sessions.length ? boundedAfterGap : false,
      forcedLabel: streak.label,
    })
    if (endIndex < sessions.length) {
      blocks.push(...analyzeSessions(sessions.slice(endIndex), false, boundedAfterGap))
    }
    return blocks
  }

  const effectiveSessions = effectiveSessionsFor(sessions)
  const distribution = categoryDistributionFor(effectiveSessions)
  const dominant = dominantCategoryFromDistribution(distribution)
  const coherence = coherenceScore(distribution)
  const averageDwell = averageDwellTime(sessions)
  const runs = categoryRunsFor(effectiveSessions)

  if (coherence < 0.4) {
    const splitIndex = sustainedDifferentCategorySplitIndex(runs, dominant)
    if (splitIndex !== null) {
      return splitAndAnalyze(sessions, splitIndex, boundedBeforeGap, boundedAfterGap)
    }
  }

  if (coherence >= 0.4 && coherence <= 0.75) {
    if (isDeveloperTestingFlow(new Set(Object.keys(distribution) as AppCategory[]), averageDwell)) {
      return [{ sessions, formation: 'heuristic', boundedBeforeGap, boundedAfterGap }]
    }

    if (averageDwell > SLOW_SWITCH_THRESHOLD_SEC) {
      const splitIndex = slowSwitchBoundaryIndex(runs)
      if (splitIndex !== null) {
        return splitAndAnalyze(sessions, splitIndex, boundedBeforeGap, boundedAfterGap)
      }
    }
  }

  const formation: FormationReason =
    coherence > 0.75 ? 'coherent' : coherence < 0.4 ? 'mixed' : 'heuristic'

  return [{ sessions, formation, boundedBeforeGap, boundedAfterGap }]
}

// Categories where the page/topic IS the activity, so a topic change is a real
// boundary even when the app and category stay the same. A camera-research tab
// and a city-council tab are both "browsing" in the same browser, but they are
// two different things and must stay two blocks. Work categories are the
// opposite: switching from a source file to a terminal command is the same
// coding session and should read as one block.
const TOPIC_SENSITIVE_CATEGORIES = new Set<AppCategory>([
  'browsing',
  'aiTools',
  'research',
  'entertainment',
  'social',
])

// Drift / consumption categories that must never be bridged across a gap. Each
// stretch stands on its own; only same-segment near-contiguous slivers coalesce
// (see shouldSoftMerge / absorbShortCandidates). Focused work (development,
// writing, design, research, aiTools, etc.) can still bridge a moderate gap.
const NON_BRIDGEABLE_CATEGORIES = new Set<AppCategory>([
  'browsing',
  'entertainment',
  'social',
])

function candidateDominantCategory(candidate: CandidateBlock, db?: Database.Database, context?: TimelineBuildContext): AppCategory {
  const distribution = categoryDistributionFor(effectiveSessionsFor(candidate.sessions))
  if (!db) return dominantCategoryFromDistribution(distribution)
  return dominantCategoryForBlock(distribution, candidatePageArtifacts(candidate, db, context))
}

function candidatePageArtifacts(candidate: CandidateBlock, db: Database.Database, context?: TimelineBuildContext): ArtifactRef[] {
  return buildPageCandidates(
    db,
    candidate.sessions[0]?.startTime ?? 0,
    candidate.sessions.length > 0 ? sessionEndMs(candidate.sessions[candidate.sessions.length - 1]) : 0,
    context,
  )
    .flatMap((candidate) => candidate.pageRef ? [candidate.pageRef] : [])
    .slice(0, 6)
}

function candidateHasFocusedPageArtifact(candidate: CandidateBlock, db?: Database.Database, context?: TimelineBuildContext): boolean {
  if (!db) return false
  return Boolean(categoryForTopPageArtifact(candidatePageArtifacts(candidate, db, context)))
}

function candidateHasNoContentSignal(candidate: CandidateBlock, db?: Database.Database, context?: TimelineBuildContext): boolean {
  if (candidate.sessions.some((session) => usefulWindowTitle(session) !== null)) return false
  if (db && candidatePageArtifacts(candidate, db, context).length > 0) return false
  return true
}

// Narrow special case for the real "Safari browsing, no specific window
// titles" fragment: a browser-only browsing candidate, between two non-meeting
// neighbours, with no title or page artifact of its own. Other titleless short
// activities may still be meaningful, and edge blocks are not slivers.
function candidateIsContentlessBrowserSliver(
  candidate: CandidateBlock,
  left: CandidateBlock | null,
  right: CandidateBlock | null,
  db?: Database.Database,
  context?: TimelineBuildContext,
): boolean {
  if (!left || !right) return false
  if (left.formation === 'meeting' || right.formation === 'meeting') return false
  if (!candidate.sessions.every(isBrowserSession)) return false
  if (candidateDominantCategory(candidate, db, context) !== 'browsing') return false
  return candidateHasNoContentSignal(candidate, db, context)
}

function candidateTopAppIds(candidate: CandidateBlock): Set<string> {
  return new Set(topAppsFromSessions(candidate.sessions).map((app) => app.bundleId))
}

function dominantContentContext(sessions: AppSession[]): string {
  const runs = contextRunsFor(sessions)
  if (runs.length === 0) return ''
  return runs.reduce((best, run) => (run.totalSeconds > best.totalSeconds ? run : best), runs[0]).context
}

function gapBetweenCandidates(left: CandidateBlock, right: CandidateBlock): number {
  return right.sessions[0].startTime - sessionEndMs(left.sessions[left.sessions.length - 1])
}

function combinedSpanMs(left: CandidateBlock, right: CandidateBlock): number {
  return sessionEndMs(right.sessions[right.sessions.length - 1]) - left.sessions[0].startTime
}

function candidateHasAssistedWorkCategory(candidate: CandidateBlock, db?: Database.Database, context?: TimelineBuildContext): boolean {
  const category = candidateDominantCategory(candidate, db, context)
  return category === 'aiTools' || category === 'development' || category === 'research' || category === 'productivity'
}

function candidatesAreAssistedWorkPair(left: CandidateBlock, right: CandidateBlock, db?: Database.Database, context?: TimelineBuildContext): boolean {
  if (!candidateHasAssistedWorkCategory(left, db, context) || !candidateHasAssistedWorkCategory(right, db, context)) return false
  const categories = new Set([candidateDominantCategory(left, db, context), candidateDominantCategory(right, db, context)])
  return categories.has('aiTools') && (
    categories.has('development')
    || categories.has('research')
    || categories.has('productivity')
    || candidateHasFocusedPageArtifact(left, db, context)
    || candidateHasFocusedPageArtifact(right, db, context)
  )
}

function mergeCandidatePair(left: CandidateBlock, right: CandidateBlock): CandidateBlock {
  return {
    sessions: [...left.sessions, ...right.sessions],
    // The merged stretch is no longer a single forced-label unit, so let
    // buildBlockFromCandidate re-derive the label from the combined evidence.
    formation: 'heuristic',
    boundedBeforeGap: left.boundedBeforeGap,
    boundedAfterGap: right.boundedAfterGap,
    forcedBoundaryBefore: left.forcedBoundaryBefore,
  }
}

// Soft-merge rule (R2): two adjacent candidates within 5 minutes of each other
// and under the 120-minute ceiling are the same work when they share a dominant
// category. For a work category that is enough — interleaving an editor and a
// terminal on one project splits into single-app fragments at every context
// shift, and those are one coding session, not four blocks. For a
// topic-sensitive category the dominant content context must also match (and we
// require a shared top app), so two distinct browsing topics stay separate.
function shouldSoftMerge(left: CandidateBlock, right: CandidateBlock, db?: Database.Database, context?: TimelineBuildContext): boolean {
  if (left.formation === 'meeting' || right.formation === 'meeting') return false
  if (!candidatesShareKind(left, right, context)) return false
  if (gapBetweenCandidates(left, right) >= TIMELINE_SPLIT_GAP_THRESHOLD_MS) return false

  const category = candidateDominantCategory(left, db, context)
  if (category !== candidateDominantCategory(right, db, context)) {
    return candidatesAreAssistedWorkPair(left, right, db, context)
      && combinedSpanMs(left, right) <= TIMELINE_MAX_ASSISTED_WORK_SPAN_MS
  }

  if (
    combinedSpanMs(left, right) > TIMELINE_MAX_BLOCK_SPAN_MS
    && !(candidatesAreAssistedWorkPair(left, right, db, context) && combinedSpanMs(left, right) <= TIMELINE_MAX_ASSISTED_WORK_SPAN_MS)
  ) return false

  if (candidatesAreAssistedWorkPair(left, right, db, context) && combinedSpanMs(left, right) <= TIMELINE_MAX_ASSISTED_WORK_SPAN_MS) {
    return true
  }

  if (!TOPIC_SENSITIVE_CATEGORIES.has(category)) return true

  const leftApps = candidateTopAppIds(left)
  const sharesTopApp = [...candidateTopAppIds(right)].some((id) => leftApps.has(id))
  if (!sharesTopApp) return false
  return dominantContentContext(left.sessions) === dominantContentContext(right.sessions)
}

// Two candidates are "semantically related" — i.e. plausibly the same activity
// continued — when they share a dominant category. For a topic-sensitive
// category (browsing, AI tools, research, entertainment, social) that is not
// enough: two distinct browsing topics are the same category but different
// work, so we additionally require a shared top app and the same dominant
// content context. This mirrors shouldSoftMerge's relatedness test minus the
// gap/span constraints, and is the signal used to decide which neighbour a
// short block attaches to.
function candidatesRelated(a: CandidateBlock, b: CandidateBlock, db?: Database.Database, context?: TimelineBuildContext): boolean {
  if (!candidatesShareKind(a, b, context)) return false
  const category = candidateDominantCategory(a, db, context)
  if (category !== candidateDominantCategory(b, db, context)) return candidatesAreAssistedWorkPair(a, b, db, context)
  if (!TOPIC_SENSITIVE_CATEGORIES.has(category)) return true
  const aApps = candidateTopAppIds(a)
  const sharesTopApp = [...candidateTopAppIds(b)].some((id) => aApps.has(id))
  if (!sharesTopApp) return false
  return dominantContentContext(a.sessions) === dominantContentContext(b.sessions)
}

// Fold short blocks into the adjacent block they most belong with — preferring
// a same-category neighbour, otherwise the one separated by the smaller gap —
// without ever swallowing a meeting.
//
// Two bands, controlled by the caller:
//   • Sub-5-minute slivers are pure noise: fold them into whichever non-meeting
//     neighbour exists (requireRelated = false), ignoring any span ceiling.
//   • Sub-30-minute blocks should generally not stand alone, but only collapse
//     when there is a *related* neighbour (requireRelated = true) and the merge
//     stays under the coherent ceiling. An isolated 20-minute activity with no
//     related neighbour keeps its own block.
function absorbShortCandidates(
  candidates: CandidateBlock[],
  maxSpanMs: number,
  options: { requireRelated: boolean; maxCombinedMs: number },
  db?: Database.Database,
  context?: TimelineBuildContext,
): CandidateBlock[] {
  if (candidates.length <= 1) return candidates

  const result = [...candidates]
  for (let index = 0; index < result.length; index++) {
    const candidate = result[index]
    if (candidate.formation === 'meeting') continue
    if (candidateActiveMs(candidate) >= maxSpanMs) continue

    const left = index > 0 ? result[index - 1] : null
    const right = index < result.length - 1 ? result[index + 1] : null
    const category = candidateDominantCategory(candidate, db, context)
    // A contentless browser sliver has no topic of its own, so the relatedness
    // gate is dropped only for that narrow case. The gap-boundary guard and span
    // ceiling below still apply, so it never bridges a real >15-min idle gap and
    // never builds a runaway block.
    const contentlessSliver = options.requireRelated && candidateIsContentlessBrowserSliver(candidate, left, right, db, context)
    const relatednessRequired = options.requireRelated && !contentlessSliver
    const leftOk = Boolean(
      left
      && left.formation !== 'meeting'
      && candidatesShareKind(candidate, left, context)
      && !(left.boundedAfterGap && candidate.boundedBeforeGap)
      && (!relatednessRequired || candidatesRelated(candidate, left, db, context))
      && combinedSpanMs(left, candidate) <= options.maxCombinedMs,
    )
    const rightOk = Boolean(
      right
      && right.formation !== 'meeting'
      && candidatesShareKind(candidate, right, context)
      && !(candidate.boundedAfterGap && right.boundedBeforeGap)
      && (!relatednessRequired || candidatesRelated(candidate, right, db, context))
      && combinedSpanMs(candidate, right) <= options.maxCombinedMs,
    )

    let mergeLeft: boolean
    if (leftOk && !rightOk) mergeLeft = true
    else if (!leftOk && rightOk) mergeLeft = false
    else if (!leftOk && !rightOk) continue
    else if (contentlessSliver) mergeLeft = gapBetweenCandidates(left!, candidate) <= gapBetweenCandidates(candidate, right!)
    else if (candidateDominantCategory(left!, db, context) === category && candidateDominantCategory(right!, db, context) !== category) mergeLeft = true
    else if (candidateDominantCategory(right!, db, context) === category && candidateDominantCategory(left!, db, context) !== category) mergeLeft = false
    else mergeLeft = gapBetweenCandidates(left!, candidate) <= gapBetweenCandidates(candidate, right!)

    if (mergeLeft) {
      result[index - 1] = mergeCandidatePair(left!, candidate)
      result.splice(index, 1)
      index -= 2
    } else {
      result[index] = mergeCandidatePair(candidate, right!)
      result.splice(index + 1, 1)
      index -= 1
    }
  }
  return result
}

// Coalesce a single coarse segment's candidates: re-join fragments of the same
// work, fold away sub-5-minute slivers, then fold sub-30-minute blocks into a
// related neighbour so the timeline reads as continuous focused stretches.
// Runs per coarse segment so it never merges across sleep / >15-minute idle
// boundaries.
function coalesceTimelineCandidates(candidates: CandidateBlock[], db: Database.Database, context: TimelineBuildContext): CandidateBlock[] {
  if (candidates.length <= 1) return candidates

  const merged: CandidateBlock[] = [candidates[0]]
  for (let index = 1; index < candidates.length; index++) {
    const previous = merged[merged.length - 1]
    const current = candidates[index]
    if (shouldSoftMerge(previous, current, db, context)) {
      merged[merged.length - 1] = mergeCandidatePair(previous, current)
    } else {
      merged.push(current)
    }
  }

  const tinyAbsorbed = absorbShortCandidates(merged, TIMELINE_MIN_BLOCK_SPAN_MS, {
    requireRelated: false,
    maxCombinedMs: Number.POSITIVE_INFINITY,
  }, db, context)
  return absorbShortCandidates(tinyAbsorbed, TIMELINE_MIN_STANDALONE_SPAN_MS, {
    requireRelated: true,
    maxCombinedMs: TIMELINE_MAX_COHERENT_BLOCK_SPAN_MS,
  }, db, context)
}

// The single app a candidate is dominated by (most foreground time). This is
// the spine of "same work" — two stretches led by the same app are the same
// activity resuming, even if the gap between them broke them into separate
// coarse segments.
function dominantAppId(candidate: CandidateBlock): string | null {
  return topAppsFromSessions(candidate.sessions)[0]?.bundleId ?? null
}

// Bridge two stretches of the same continued work across a moderate gap. Unlike
// shouldSoftMerge (which only joins zero/near-zero gaps within one coarse
// segment), this deliberately reaches across coarse-segment boundaries — the
// gap is exactly what split them — but only when the same dominant app is doing
// related work and the gap stays under the bridge ceiling. Meetings never
// bridge, and the result is capped at the coherent maximum so bridging cannot
// build a runaway block.
function shouldBridgeSameWork(left: CandidateBlock, right: CandidateBlock, db: Database.Database, context: TimelineBuildContext): boolean {
  if (left.formation === 'meeting' || right.formation === 'meeting') return false
  if (!candidatesShareKind(left, right, context)) return false
  if (left.boundedAfterGap && right.boundedBeforeGap) return false
  // Drift categories never bridge across a gap. Two YouTube videos or two
  // X sessions separated by a 17-minute lull are not "the same work resuming" —
  // they are two separate detours, and the browser's content context is often
  // just `entertainment:<browser>` (window titles aren't reliably captured),
  // so without this guard every video in one browser collapses into a single
  // runaway "watching" block whose span (and old duration) dwarfed the actual
  // tracked time (R4). Bridging is for focused work continuing past an
  // interruption, not for stitching drift together.
  if (NON_BRIDGEABLE_CATEGORIES.has(candidateDominantCategory(left, db, context))) return false
  const gap = gapBetweenCandidates(left, right)
  if (gap >= TIMELINE_SAME_WORK_BRIDGE_GAP_MS) return false
  const assistedPair = candidatesAreAssistedWorkPair(left, right, db, context)
  const maxSpanMs = assistedPair ? TIMELINE_MAX_ASSISTED_WORK_SPAN_MS : TIMELINE_MAX_COHERENT_BLOCK_SPAN_MS
  if (combinedSpanMs(left, right) > maxSpanMs) return false
  if (assistedPair && gap < TIMELINE_SPLIT_GAP_THRESHOLD_MS) return true
  const leftApp = dominantAppId(left)
  if (!leftApp || leftApp !== dominantAppId(right)) return false
  return candidatesRelated(left, right, db, context)
}

// Day-level pass over the full block list (all coarse segments concatenated):
// fuse same-app continued work across moderate gaps, then fold any short block
// that now has a related neighbour. This is what turns a 50-second "Terminal
// work" sliver plus a 17-minute gap plus an hour of Ghostty into one continuous
// coding block.
function bridgeSameWorkCandidates(candidates: CandidateBlock[], db: Database.Database, context: TimelineBuildContext): CandidateBlock[] {
  if (candidates.length <= 1) return candidates

  const merged: CandidateBlock[] = [candidates[0]]
  for (let index = 1; index < candidates.length; index++) {
    const previous = merged[merged.length - 1]
    const current = candidates[index]
    if (shouldBridgeSameWork(previous, current, db, context)) {
      merged[merged.length - 1] = mergeCandidatePair(previous, current)
    } else {
      merged.push(current)
    }
  }

  return absorbShortCandidates(merged, TIMELINE_MIN_STANDALONE_SPAN_MS, {
    requireRelated: true,
    maxCombinedMs: TIMELINE_MAX_COHERENT_BLOCK_SPAN_MS,
  }, db, context)
}

// ── Boundary-scoring reconciliation ─────────────────────────────────────────
//
// The passes above (analyze → normalize → coalesce → bridge) PROPOSE
// boundaries from a cascade of single-signal hard splits. They reliably
// over-split: a brief same-subject research peek inside an implementation
// stretch, one research thread spread across several sources, or a string of
// short admin tasks each become their own block. This pass is the final
// arbiter: it scores every proposed boundary from the full signal set and
// keeps the boundary only when the score clears the cut threshold. A boundary
// that does not clear it is erased and the two runs become one episode. The
// upstream heuristics are inputs to the score, not the decision.
//
// The score is intentionally coarse-grained and additive so its behaviour is
// predictable: hard signals (a meeting edge, a real idle gap) force a cut;
// soft cut signals (category shift, topic change, a research→execution
// handoff, a detour) push the score up; continuity signals (the same app
// carrying across, one research thread, a brief peek, a short-admin run) pull
// it down. A user split forces a cut; a user merge forces a join — that is the
// "user correction memory" signal feeding back into the model.

const BOUNDARY_CUT_THRESHOLD = 1
const BOUNDARY_HARD_SCORE = 100
// Under 10 minutes = absorbed into the
// surrounding block; 10 minutes or more = its own block. A peek at X/Netflix in
// the middle of a work stretch folds in; it never splits or renames the block.
const BRIEF_PEEK_MAX_ACTIVE_MS = 10 * 60_000

// ── User correction memory for boundaries ───────────────────────────────────
//
// When the user splits an episode at a chosen point they assert "there IS a
// boundary here"; a merge asserts "there is NOT". Both are persisted in the
// review ledger (timeline_boundary_corrections) keyed by the two sessions that
// straddle the boundary, so they survive rebuilds and feed back into the
// scorer as the highest-weight signal. The key is evidence-based (session ids),
// matching Agent B's correction lineage, so a re-cut day re-attaches them.
function boundaryKeyForSessionIds(leftLastId: number, rightFirstId: number): string {
  return `${leftLastId}:${rightFirstId}`
}

function boundaryKeyForCandidates(left: CandidateBlock, right: CandidateBlock): string | null {
  const leftLast = left.sessions[left.sessions.length - 1]
  const rightFirst = right.sessions[0]
  if (!leftLast || !rightFirst || leftLast.id < 0 || rightFirst.id < 0) return null
  return boundaryKeyForSessionIds(leftLast.id, rightFirst.id)
}

interface MergedSpan {
  startMs: number
  endMs: number
}

interface BoundaryCorrections {
  merges: Set<string>
  mergedSpans: MergedSpan[]
  // User "cut here" timestamps (from a time-range trim in the block editor).
  // A cut is enforced LAST in the pipeline, after every merge/fold pass, so no
  // heuristic can re-join what the user explicitly separated.
  cuts: number[]
  lookup(left: CandidateBlock, right: CandidateBlock): 'merge' | null
}

const EMPTY_BOUNDARY_CORRECTIONS: BoundaryCorrections = {
  merges: new Set(),
  mergedSpans: [],
  cuts: [],
  lookup: () => null,
}

function makeBoundaryCorrections(merges: Set<string>, mergedSpans: MergedSpan[] = [], cuts: number[] = []): BoundaryCorrections {
  return {
    merges,
    mergedSpans,
    cuts,
    lookup(left, right) {
      // Exact session-pair match first (cheap, precise) — but session ids only
      // hold within one id namespace. The span anchor is the durable signal: a
      // proposed boundary whose junction falls strictly inside a span the user
      // fused is erased, whatever ids the sessions carry today.
      const key = boundaryKeyForCandidates(left, right)
      if (key && merges.has(key)) return 'merge'
      if (mergedSpans.length > 0) {
        const leftLast = left.sessions[left.sessions.length - 1]
        const rightFirst = right.sessions[0]
        if (leftLast && rightFirst) {
          const junction = (sessionEndMs(leftLast) + rightFirst.startTime) / 2
          for (const span of mergedSpans) {
            if (junction > span.startMs && junction < span.endMs) return 'merge'
          }
        }
      }
      return null
    },
  }
}

function boundaryCorrectionsTableExists(db: Database.Database): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='timeline_boundary_corrections' LIMIT 1`,
  ).get() as { name: string } | undefined
  return Boolean(row)
}

function loadBoundaryCorrections(db: Database.Database, dateStr?: string): BoundaryCorrections {
  if (!dateStr || !boundaryCorrectionsTableExists(db)) return EMPTY_BOUNDARY_CORRECTIONS
  const rows = db.prepare(`
    SELECT left_session_id AS leftId, right_session_id AS rightId, kind,
           span_start_ms AS spanStartMs, span_end_ms AS spanEndMs
    FROM timeline_boundary_corrections
    WHERE date = ?
  `).all(dateStr) as Array<{ leftId: number; rightId: number; kind: string; spanStartMs: number | null; spanEndMs: number | null }>
  const merges = new Set<string>()
  const mergedSpans: MergedSpan[] = []
  const cuts: number[] = []
  for (const row of rows) {
    if (row.kind === 'split') {
      // A user cut stores its timestamp in span_start_ms — the wall-clock
      // anchor survives every session-id namespace flip, like merge spans.
      if (row.spanStartMs != null) cuts.push(row.spanStartMs)
      continue
    }
    if (row.kind !== 'merge') continue
    merges.add(boundaryKeyForSessionIds(row.leftId, row.rightId))
    if (row.spanStartMs != null && row.spanEndMs != null && row.spanEndMs > row.spanStartMs) {
      mergedSpans.push({ startMs: row.spanStartMs, endMs: row.spanEndMs })
    }
  }
  return makeBoundaryCorrections(merges, mergedSpans, cuts)
}

type RunMode = 'execution' | 'research' | 'browse' | 'admin' | 'drift' | 'meeting'

const EXECUTION_RUN_CATEGORIES = new Set<AppCategory>(['development', 'writing', 'design'])
// Research is genuine investigation (research-categorised sources + AI tools).
// Plain `browsing` is its OWN topic-sensitive mode: two unrelated browsing
// topics are two different things, so browsing must not coalesce as one
// "research thread" the way research/AI sources do.
const RESEARCH_RUN_CATEGORIES = new Set<AppCategory>(['research', 'aiTools'])
const ADMIN_RUN_CATEGORIES = new Set<AppCategory>(['email', 'communication', 'productivity'])
const DRIFT_RUN_CATEGORIES = new Set<AppCategory>(['social', 'entertainment'])

// "Session-run-level intent": the coarse role/subject/app signals derived for a
// run of sessions BEFORE it is a finished block, so a shift in any of them can
// be weighed as a boundary signal rather than discovered post-hoc as a label.
interface RunSignals {
  mode: RunMode
  dominantCategory: AppCategory
  dominantApp: string | null
  contentContext: string
  activeMs: number
  isAdmin: boolean
}

function runModeFor(dominantCategory: AppCategory, isMeeting: boolean): RunMode {
  if (isMeeting || dominantCategory === 'meetings') return 'meeting'
  if (EXECUTION_RUN_CATEGORIES.has(dominantCategory)) return 'execution'
  if (DRIFT_RUN_CATEGORIES.has(dominantCategory)) return 'drift'
  if (RESEARCH_RUN_CATEGORIES.has(dominantCategory)) return 'research'
  if (dominantCategory === 'browsing') return 'browse'
  if (ADMIN_RUN_CATEGORIES.has(dominantCategory)) return 'admin'
  return 'admin'
}

function runSignalsFor(candidate: CandidateBlock, db: Database.Database, context: TimelineBuildContext): RunSignals {
  const dominantCategory = candidateDominantCategory(candidate, db, context)
  const isMeeting = candidate.formation === 'meeting'
  const mode = runModeFor(dominantCategory, isMeeting)
  return {
    mode,
    dominantCategory,
    dominantApp: dominantAppId(candidate),
    contentContext: dominantContentContext(candidate.sessions),
    activeMs: candidateActiveMs(candidate),
    isAdmin: mode === 'admin' && candidateActiveMs(candidate) < TIMELINE_MIN_STANDALONE_SPAN_MS,
  }
}

// A short administrative slice — an email check, a calendar glance, a Slack
// reply, a checklist tick. A run of these belongs to one "triage" episode, not
// six separate blocks.
function isShortAdminRun(left: RunSignals, right: RunSignals): boolean {
  return left.isAdmin && right.isAdmin
}

// Two runs are one research thread when both sit in the research family and are
// effectively contiguous — the user is gathering context across sources (Rize,
// then Toggl, then ChatGPT) on one investigation, even though each source has
// its own page title.
function isOneResearchThread(left: RunSignals, right: RunSignals, gapMs: number): boolean {
  return left.mode === 'research' && right.mode === 'research' && gapMs < TIMELINE_SAME_WORK_BRIDGE_GAP_MS
}

// Score a single proposed boundary. Positive ⇒ lean cut, negative ⇒ lean merge.
// Reasons accumulate the signals that argued for a cut; they survive only if
// the boundary is ultimately kept.
function scoreBoundary(
  left: CandidateBlock,
  right: CandidateBlock,
  leftSig: RunSignals,
  rightSig: RunSignals,
  db: Database.Database,
  context: TimelineBuildContext,
  corrections: BoundaryCorrections,
): { score: number; reasons: BoundaryReason[] } {
  const reasons: BoundaryReason[] = []
  // The absence guard outranks EVERY stored correction (lib/absenceGuard.ts):
  // a real absence of 15+ minutes is a hard boundary no merge may erase — not
  // an AI regroup's, not a cleanup's, not even a user's. This is what lets a
  // re-analyze REPAIR a day whose stored corrections were written before the
  // guard existed (the July 10 block that fused 3:49 PM work to 10:05 PM work
  // across a 8:01–9:39 PM absence): the poisoned merge span simply loses at
  // the gap and the day splits there on rebuild.
  const gapMs = gapBetweenCandidates(left, right)
  if ((left.boundedAfterGap && right.boundedBeforeGap) || isRealAbsenceGap(gapMs)) {
    return { score: BOUNDARY_HARD_SCORE, reasons: ['idle-gap'] }
  }
  // A user merge erases this boundary and overrides every heuristic below it,
  // including a kind change — the user's intent always wins over segmentation.
  if (corrections.lookup(left, right) === 'merge') return { score: -BOUNDARY_HARD_SCORE, reasons: [] }
  if (right.forcedBoundaryBefore) {
    return { score: BOUNDARY_HARD_SCORE, reasons: ['subject-change'] }
  }

  // Hard cuts — never erased.
  // A kind change (work↔leisure↔personal) is the hardest boundary of all: it is
  // the fix for coding being absorbed into a video block. Watching and shipping
  // are never one episode no matter how small the gap between them.
  if (candidateKind(left, context) !== candidateKind(right, context)) {
    return { score: BOUNDARY_HARD_SCORE, reasons: ['kind-shift'] }
  }
  if (leftSig.mode === 'meeting') return { score: BOUNDARY_HARD_SCORE, reasons: ['meeting-end'] }
  if (rightSig.mode === 'meeting') return { score: BOUNDARY_HARD_SCORE, reasons: ['meeting-start'] }

  // A merge can never build a runaway block; respect the same span ceiling the
  // upstream passes use. If joining would exceed it, the boundary stays.
  const assistedPair = candidatesAreAssistedWorkPair(left, right, db, context)
  const ceilingMs = assistedPair ? TIMELINE_MAX_ASSISTED_WORK_SPAN_MS : TIMELINE_MAX_COHERENT_BLOCK_SPAN_MS
  if (combinedSpanMs(left, right) > ceilingMs) {
    return { score: BOUNDARY_HARD_SCORE, reasons: ['idle-gap'] }
  }

  let score = 0

  // A detour (a short social/entertainment dip between work) is its own thing.
  if (leftSig.mode !== 'drift' && rightSig.mode === 'drift') {
    score += 6
    reasons.push('detour-start')
  } else if (leftSig.mode === 'drift' && rightSig.mode !== 'drift') {
    score += 6
    reasons.push('detour-end')
  }

  // Topic change inside plain browsing — two unrelated browsing subjects are
  // two different things even in the same browser. (A research thread, by
  // contrast, legitimately spans topics across sources and is held together by
  // the continuity pulls below.)
  if (leftSig.mode === 'browse' && rightSig.mode === 'browse' && leftSig.contentContext !== rightSig.contentContext) {
    score += 6
    reasons.push('subject-change')
  }

  // A work-mode shift (e.g. coding → writing, research → admin).
  if (leftSig.mode !== rightSig.mode && leftSig.mode !== 'drift' && rightSig.mode !== 'drift') {
    score += 2
    reasons.push('category-shift')
    if (leftSig.mode === 'research' && rightSig.mode === 'execution') {
      score += 1
      reasons.push('research-to-execution')
    }
  }

  // A repo/project change is a stronger artifact change than a page swap.
  if (leftSig.dominantApp && leftSig.dominantApp === rightSig.dominantApp
    && leftSig.contentContext !== rightSig.contentContext
    && leftSig.mode === 'execution' && rightSig.mode === 'execution') {
    score += 1
    reasons.push('artifact-change')
  }

  // A visible (sub-idle) gap is a mild boundary signal.
  if (gapMs >= TIMELINE_SPLIT_GAP_THRESHOLD_MS) {
    score += 1
    if (!reasons.includes('idle-gap')) reasons.push('idle-gap')
  }

  // ── Continuity pulls (merge) ──
  // Drift (entertainment/social) never gets a continuity pull: two videos in
  // the same browser across a lull are two separate detours, not one runaway
  // "watching" block (R4). Only the gap/detour signals decide drift edges.
  const eitherDrift = leftSig.mode === 'drift' || rightSig.mode === 'drift'
  if (!eitherDrift) {
    // The same app carrying straight across is the single strongest "same
    // session" signal — it overrides a category shift (a research tab followed
    // by a notes tab in the same browser is one synthesis session).
    if (leftSig.dominantApp && leftSig.dominantApp === rightSig.dominantApp) {
      score -= 4
    }
    if (isOneResearchThread(leftSig, rightSig, gapMs)) score -= 4
    if (isShortAdminRun(leftSig, rightSig)) score -= 5
  }

  return { score, reasons }
}

// Brief same-subject research peek inside execution: a < ~12-minute
// research/browse that sits between two execution runs on the same app (look
// up a PR, then back to the editor). It is part of the implementation episode,
// not a boundary of its own. Fold it into the preceding run first so the two
// execution runs can then merge on app continuity.
function foldBriefPeeks(candidates: CandidateBlock[], db: Database.Database, context: TimelineBuildContext): CandidateBlock[] {
  if (candidates.length < 3) return candidates
  const signals = candidates.map((c) => runSignalsFor(c, db, context))
  const result: CandidateBlock[] = []
  const sig: RunSignals[] = []
  for (let index = 0; index < candidates.length; index++) {
    const current = candidates[index]
    const left = result[result.length - 1]
    const leftSig = sig[sig.length - 1]
    const right = candidates[index + 1]
    const rightSig = signals[index + 1]

    // Focused work continuing on both sides of the middle slice, with no real
    // idle gap on either edge. "Focused work" is execution *or* research — AI
    // tools (Codex, Claude) read as research mode, so a Cursor/Codex coding
    // stretch with a peek in the middle must still count as a work sandwich.
    // `left` is read from the running result so a chain (work / peek / work /
    // peek / work) collapses in one forward pass.
    const isWorkAnchor = (mode: RunMode | undefined): boolean =>
      mode === 'execution' || mode === 'research' || mode === 'admin'
    const noIdleGapAround = Boolean(
      left && right
      && current.formation !== 'meeting'
      && isWorkAnchor(leftSig?.mode)
      && isWorkAnchor(rightSig?.mode)
      && !(left.boundedAfterGap && current.boundedBeforeGap)
      && !(current.boundedAfterGap && right.boundedBeforeGap)
      && gapBetweenCandidates(left, current) < TIMELINE_SAME_WORK_BRIDGE_GAP_MS
      && gapBetweenCandidates(current, right) < TIMELINE_SAME_WORK_BRIDGE_GAP_MS,
    )
    const sameIntentAround = Boolean(left && right && (
      candidatesAreAssistedWorkPair(left, right, db, context)
      || (
        candidateDominantCategory(left, db, context) === candidateDominantCategory(right, db, context)
        && dominantContentContext(left.sessions) === dominantContentContext(right.sessions)
      )
    ))
    // The research-peek fold (a) is conservative: it requires the SAME app on
    // both sides (look up a PR in the editor's browser, back to the editor).
    const sandwichedBySameWork = noIdleGapAround
      && leftSig.dominantApp != null
      && leftSig.dominantApp === rightSig.dominantApp
    const briefMiddle = signals[index].activeMs < BRIEF_PEEK_MAX_ACTIVE_MS

    // (a) A brief same-subject research look-up inside execution (check a PR,
    // back to the editor). Fold it into the left run; the two execution runs
    // then merge on app continuity in scoring.
    const researchPeek =
      sandwichedBySameWork
      && sameIntentAround
      && briefMiddle
      && candidatesShareKind(left, current, context)
      && signals[index].mode === 'research'
    if (researchPeek) {
      result[result.length - 1] = mergeCandidatePair(left, current)
      sig[sig.length - 1] = runSignalsFor(result[result.length - 1], db, context)
      continue
    }

    // (b) timeline.md §3.2: a brief off-task peek — X, Netflix, a YouTube clip,
    // a song on Spotify, a quick Google — in the middle of a work stretch folds
    // into that block; it never becomes its own SOCIAL/entertainment block. It
    // crosses the work↔leisure kind line, which scoring treats as a hard cut, so
    // we fuse left+peek+right in one step here, before scoring. The work-on-both-
    // sides requirement is what keeps the R4 guard intact: a peek only folds
    // *between* work, so two videos across a gap (drift on both sides) never
    // stitch into a runaway "watching" block. Same-app is NOT required here — a
    // brief Netflix peek pollutes the merged block's dominant app, so insisting
    // on it would strand the next sliver. Bounded to under the §3.2 cutoff and
    // the coherent span ceiling so a *sustained* detour still stands alone.
    const briefDetour =
      noIdleGapAround
      && briefMiddle
      && (signals[index].mode === 'drift' || signals[index].mode === 'browse')
      && combinedSpanMs(left, right) <= TIMELINE_MAX_COHERENT_BLOCK_SPAN_MS
    if (briefDetour && right) {
      if (sameIntentAround) {
        const fused = mergeCandidatePair(mergeCandidatePair(left, current), right)
        result[result.length - 1] = fused
        sig[sig.length - 1] = runSignalsFor(fused, db, context)
        index += 1 // `right` is already fused in — consume it
        continue
      }

      // The activity on either side is genuinely different. The detour still
      // must not become its own block, but absorbing it must preserve the real
      // intent boundary. Attach it to the stronger adjacent anchor only.
      if (candidateActiveMs(left) >= candidateActiveMs(right)) {
        const absorbedLeft = mergeCandidatePair(left, current)
        result[result.length - 1] = absorbedLeft
        sig[sig.length - 1] = runSignalsFor(absorbedLeft, db, context)
        candidates[index + 1] = { ...right, forcedBoundaryBefore: true }
      } else {
        const absorbedRight = {
          ...mergeCandidatePair(current, right),
          forcedBoundaryBefore: true,
        }
        result.push(absorbedRight)
        sig.push(runSignalsFor(absorbedRight, db, context))
        index += 1
      }
      continue
    }

    result.push(current)
    sig.push(signals[index])
  }
  return result
}

// The reconciliation pass: fold brief peeks, then walk the proposed boundaries
// and keep only those that clear the cut threshold. Records the surviving
// reasons on each resulting candidate's edges so every block can explain why it
// started and stopped.
function reconcileBoundaries(
  candidates: CandidateBlock[],
  db: Database.Database,
  context: TimelineBuildContext,
  corrections: BoundaryCorrections,
): CandidateBlock[] {
  if (candidates.length === 0) return candidates
  const folded = foldBriefPeeks(candidates, db, context)

  const result: CandidateBlock[] = [{ ...folded[0], startReasons: ['day-start'], endReasons: ['day-end'] }]
  let prevSig = runSignalsFor(folded[0], db, context)
  if (folded[0].boundedBeforeGap) result[0].startReasons = ['day-start', 'idle-gap']

  for (let index = 1; index < folded.length; index++) {
    const previous = result[result.length - 1]
    const current = folded[index]
    const currentSig = runSignalsFor(current, db, context)
    const { score, reasons } = scoreBoundary(previous, current, prevSig, currentSig, db, context, corrections)

    if (score < BOUNDARY_CUT_THRESHOLD) {
      // Erase the boundary: the two runs are one episode.
      const mergedReasons = previous.startReasons ?? ['day-start']
      const joined = mergeCandidatePair(previous, current)
      result[result.length - 1] = { ...joined, startReasons: mergedReasons, endReasons: ['day-end'] }
      prevSig = runSignalsFor(result[result.length - 1], db, context)
      continue
    }

    const cutReasons: BoundaryReason[] = reasons.length > 0 ? reasons : ['category-shift']
    previous.endReasons = cutReasons
    result.push({ ...current, startReasons: cutReasons, endReasons: ['day-end'] })
    prevSig = currentSig
  }

  if (folded[folded.length - 1]?.boundedAfterGap) {
    const last = result[result.length - 1]
    last.endReasons = last.endReasons && !last.endReasons.includes('idle-gap')
      ? [...last.endReasons.filter((r) => r !== 'day-end'), 'idle-gap']
      : last.endReasons
  }
  return result
}

// Merge two adjacent candidates while preserving the boundary reasons set by
// reconcileBoundaries: the survivor spans left.start → right.end, so it keeps
// the left edge's start reasons and the right edge's end reasons. (Plain
// mergeCandidatePair drops both, which is correct earlier in the pipeline but
// not after reconciliation has annotated the edges.)
function mergeCandidatePairPreservingReasons(left: CandidateBlock, right: CandidateBlock): CandidateBlock {
  return {
    ...mergeCandidatePair(left, right),
    startReasons: left.startReasons,
    endReasons: right.endReasons,
  }
}

// Final calendar-floor pass (timeline.md §3.4 / DEV-99): no block under fifteen
// minutes stands alone. Runs last, after every boundary decision, so it operates
// on the day's settled blocks. For each sub-floor non-meeting block it folds into
// the best neighbour — a *related* one first (the same work resuming), then one in
// the same category, then simply the nearer by gap — and never swallows or folds
// into a meeting. It repeats until nothing under the floor remains that can be
// folded; a lone short block with only meeting neighbours (or none) is the only
// thing allowed to stay under the floor.
function enforceMinimumBlockFloor(
  candidates: CandidateBlock[],
  db: Database.Database,
  context: TimelineBuildContext,
): CandidateBlock[] {
  if (candidates.length <= 1) return candidates
  const result = [...candidates]

  // The guard must be the ORIGINAL count: each fold removes one candidate, so
  // at most N-1 folds are ever possible. Bounding by the shrinking
  // result.length exited after ~N/2 folds on a fragmented day and let 12-second
  // slivers survive the floor.
  const maxFolds = result.length
  for (let guard = 0; guard < maxFolds; guard++) {
    let foldedAny = false
    for (let index = 0; index < result.length; index++) {
      const candidate = result[index]
      if (candidate.formation === 'meeting') continue
      // A real sliver is short on BOTH axes — the time it took (active) and the
      // stretch of day it covers (span). A sparsely-tracked but genuinely long
      // activity (e.g. a 41-minute agent run that only registered 27s of
      // foreground polling) spans ≥ the floor and is a real block, not a sliver,
      // so it is never folded away.
      if (candidateActiveMs(candidate) >= TIMELINE_MIN_BLOCK_FLOOR_MS) continue
      if (candidateSpanMs(candidate) >= TIMELINE_MIN_BLOCK_FLOOR_MS) continue

      const left = index > 0 ? result[index - 1] : null
      const right = index < result.length - 1 ? result[index + 1] : null
      // A sliver may only fold into a neighbour it is genuinely contiguous with.
      // Folding ACROSS an idle/sleep gap is what produces phantom blocks: a 24s
      // 1:56am blip folded right into the 9:41am block makes one 11-hour block
      // starting at 2am. A neighbour separated by >= the idle gap is not a valid
      // fold target; an isolated sliver is left as its own small block (which the
      // wrap and ribbon already drop as sub-floor).
      const leftOk = Boolean(left && left.formation !== 'meeting'
        && gapBetweenCandidates(left, candidate) < TIMELINE_SLIVER_FOLD_MAX_GAP_MS)
      const rightOk = Boolean(right && right.formation !== 'meeting'
        && gapBetweenCandidates(candidate, right) < TIMELINE_SLIVER_FOLD_MAX_GAP_MS)
      if (!leftOk && !rightOk) {
        // No neighbour close enough to fold into. If the day has a real block
        // elsewhere, this isolated sub-floor stretch is noise (a 24s 1:56am blip
        // while asleep), not a block — drop it rather than show it. Keep it only
        // when it is all there is (a lone short day); meetings are skipped above.
        const hasRealBlock = result.some((other, otherIndex) =>
          otherIndex !== index
          && (other.formation === 'meeting'
            || candidateActiveMs(other) >= TIMELINE_MIN_BLOCK_FLOOR_MS
            || candidateSpanMs(other) >= TIMELINE_MIN_BLOCK_FLOOR_MS))
        if (hasRealBlock) {
          result.splice(index, 1)
          foldedAny = true
          break
        }
        continue
      }

      let mergeLeft: boolean
      if (leftOk && !rightOk) mergeLeft = true
      else if (!leftOk && rightOk) mergeLeft = false
      else {
        const relLeft = candidatesRelated(candidate, left!, db, context)
        const relRight = candidatesRelated(candidate, right!, db, context)
        const category = candidateDominantCategory(candidate, db, context)
        const catLeft = candidateDominantCategory(left!, db, context) === category
        const catRight = candidateDominantCategory(right!, db, context) === category
        if (relLeft !== relRight) mergeLeft = relLeft
        else if (catLeft !== catRight) mergeLeft = catLeft
        else mergeLeft = gapBetweenCandidates(left!, candidate) <= gapBetweenCandidates(candidate, right!)
      }

      if (mergeLeft) {
        result[index - 1] = mergeCandidatePairPreservingReasons(left!, candidate)
        result.splice(index, 1)
      } else {
        result[index] = mergeCandidatePairPreservingReasons(candidate, right!)
        result.splice(index + 1, 1)
      }
      foldedAny = true
      break
    }
    if (!foldedAny) break
  }

  return result
}

// A user "cut here" (from a time-range trim in the block editor) is enforced
// LAST — after every merge, bridge, and floor pass — so no heuristic can
// re-join what the user explicitly separated. Any candidate spanning a cut is
// split at that timestamp; the resulting pieces stay even if they fall under
// the 15-minute floor (an explicit user correction outranks the size rule,
// invariant 8). Cuts sitting on an existing boundary are no-ops.
function enforceUserCuts(candidates: CandidateBlock[], cuts: number[]): CandidateBlock[] {
  if (cuts.length === 0 || candidates.length === 0) return candidates
  let result = candidates
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    result = result.flatMap((candidate) => {
      if (candidate.sessions.length === 0) return [candidate]
      const start = candidate.sessions[0].startTime
      const end = sessionEndMs(candidate.sessions[candidate.sessions.length - 1])
      if (cut <= start || cut >= end) return [candidate]
      const [leftSessions, rightSessions] = splitSessionsAtTime(candidate.sessions, cut)
      if (leftSessions.length === 0 || rightSessions.length === 0) return [candidate]
      return [
        {
          ...candidate,
          sessions: leftSessions,
          boundedAfterGap: false,
          endReasons: ['user-cut' as BoundaryReason],
        },
        {
          ...candidate,
          sessions: rightSessions,
          boundedBeforeGap: false,
          forcedBoundaryBefore: true,
          startReasons: ['user-cut' as BoundaryReason],
        },
      ]
    })
  }
  return result
}

function buildBlocksForSessions(db: Database.Database, sessions: AppSession[], dateStr?: string): WorkContextBlock[] {
  const context = buildTimelineContext(db, sessions)
  const corrections = loadBoundaryCorrections(db, dateStr)
  const candidates = coarseSegmentsFromSessions(sessions)
    .flatMap((segment) => {
      // A kind change (work↔leisure↔personal) is a hard boundary: split the
      // segment into same-kind runs before analysis so coding is never built
      // into the same candidate as a video block.
      const kindRuns = splitSessionsByKind(segment.sessions, context)
      const segmentCandidates = kindRuns.flatMap((run, index) => {
        const boundedBeforeGap = index === 0 ? segment.boundedBeforeGap : false
        const boundedAfterGap = index === kindRuns.length - 1 ? segment.boundedAfterGap : false
        return analyzeSessions(run, boundedBeforeGap, boundedAfterGap)
          .flatMap((candidate) => normalizeTimelineCandidates([candidate]))
      })
      return coalesceTimelineCandidates(segmentCandidates, db, context)
    })
  const bridged = bridgeSameWorkCandidates(candidates, db, context)
  const reconciled = reconcileBoundaries(bridged, db, context, corrections)
  return enforceUserCuts(enforceMinimumBlockFloor(reconciled, db, context), corrections.cuts)
    .map((candidate) => buildBlockFromCandidate(candidate, db, context))
}

// Build the timeline blocks for a set of sessions through the one canonical
// coalescing pipeline, with labels finalized. Used by the live/today path and
// by the derived (past-day) projection so both render the same block shapes —
// there is no second, un-coalesced block builder.
export function buildTimelineBlocksFromSessions(
  db: Database.Database,
  sessions: AppSession[],
): WorkContextBlock[] {
  return buildBlocksForSessions(db, sessions).map((block) => finalizedLabelForBlock(db, block))
}

function blockKindFor(block: WorkContextBlock): string {
  if (block.dominantCategory === 'meetings') return 'meeting'
  if (block.dominantCategory === 'communication' || block.dominantCategory === 'email') return 'communication'
  if (block.dominantCategory === 'uncategorized') return 'mixed'
  return 'work'
}

// B10: tab-title soup like "Course | Perusall" or "W2_Reading | Intro to ML
// | Perusall" should not surface as a block label with a literal pipe. The
// pipe is join-logic leaking into prose; a colleague would say "Intro to ML
// on Perusall," not "Intro to ML | Perusall". Collapse pipe-joined values to
// their longest content-bearing segment so every label-selection path
// (artifact, workflow, rule-based, AI) emits clean prose.
function naturalizeLabel(value: string): string {
  if (!/ \| /.test(value)) return value
  const segments = value
    .split(/\s*\|\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !GENERIC_LABELS.has(segment))
  if (segments.length === 0) return value
  return segments.reduce((best, segment) => segment.length > best.length ? segment : best, segments[0])
}

function usefulDerivedLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const natural = naturalizeLabel(trimmed)
  if (!natural) return null
  if (GENERIC_LABELS.has(natural)) return null
  // §3.5 / invariant 3: never surface a raw file / machine identifier as a name.
  if (looksLikeRawArtifactLabel(natural)) return null
  return natural
}

function normalizedLabelValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function labelLooksToolOnly(label: string, block: WorkContextBlock): boolean {
  const normalizedLabel = normalizedLabelValue(label)
  if (!normalizedLabel) return true
  const appNames = block.topApps
    .map((app) => normalizedLabelValue(app.appName))
    .filter(Boolean)
  if (appNames.includes(normalizedLabel)) return true
  if (appNames.some((appName) => normalizedLabel === `${appName}loop`)) return true
  if (appNames.length >= 2) {
    const pair = `${appNames[0]}${appNames[1]}`
    if (normalizedLabel === pair || normalizedLabel === `${pair}loop`) return true
  }
  return false
}

function usefulBlockLabel(block: WorkContextBlock, value: string | null | undefined): string | null {
  const label = usefulDerivedLabel(value)
  if (!label) return null
  return labelLooksToolOnly(label, block) ? null : label
}

// Browser tab titles typically join segments with " | " (pipe + spaces),
// e.g. "W2_Reading | Introduction to Machine Learning | Perusall". Real
// document or page titles use em-dashes, hyphens, middle-dots, or colons.
// Treat any " | "-joined string as raw tab-title evidence, not a label.
function looksLikeBrowserTabTitle(value: string): boolean {
  return / \| /.test(value)
}

// timeline.md §3.5: a search-engine results page is a raw page title, never a
// block name — "the song … - Google Search" is what you typed, not what you
// did. Reject it from the deterministic label so the block falls to an
// evidence-based name (or the AI's intent name) instead.
function looksLikeSearchResultTitle(value: string): boolean {
  const trimmed = value.trim()
  // The engine suffix ("… - Google Search") and the "Search results …" page
  // prefix are the real results-page shapes. Kept narrow so a genuine title
  // that merely mentions search ("Improving Google Search ranking") is not lost.
  return /[-–—|·:]\s*(google|bing|duckduckgo|duck ?duck ?go|yahoo|brave|ecosia)\s+search\s*$/i.test(trimmed)
    || /^search results\b/i.test(trimmed)
}

// Categories where a browser page / website is the natural label source.
// For anything else (development, communication, design, etc.), a stray
// browser page should NOT be picked as the block label.
const PAGE_LABEL_COMPATIBLE_CATEGORIES = new Set<AppCategory>([
  'browsing',
  'aiTools',
  'research',
  'entertainment',
  'social',
])

function isPageLabelCompatible(block: WorkContextBlock): boolean {
  return PAGE_LABEL_COMPATIBLE_CATEGORIES.has(block.dominantCategory)
}

// Share of the block's time spent in non-browser focused-work apps
// (development, writing, design, productivity, research — excluding
// browsing and aiTools since those legitimately host page artifacts).
// Used to detect "the user was actually working, the foreground tab is
// background noise" — the core F1 case.
const WORK_APP_DOMINANT_SHARE = 0.3

function workAppDominantShare(block: WorkContextBlock): number {
  const workAppSeconds = block.topApps
    .filter((app) =>
      FOCUSED_CATEGORIES.includes(app.category)
      && app.category !== 'browsing'
      && app.category !== 'aiTools'
      && !app.isBrowser,
    )
    .reduce((sum, app) => sum + app.totalSeconds, 0)
  const totalSeconds = block.topApps.reduce((sum, app) => sum + app.totalSeconds, 0)
  if (totalSeconds <= 0) return 0
  return workAppSeconds / totalSeconds
}

// F1 ownership rule: a development-dominant block (IDE/terminal top apps)
// must not adopt a co-occurring browser page artifact as its label. A
// 5-minute YouTube tab open while the user spent 90 minutes in Kiro and
// Ghostty is background noise, not the block headline. Applies to the
// post-F2(a) "artifact-driven" entertainment override too: even when the
// top page artifact rewrote the dominantCategory to 'entertainment', if
// the actual time spent was mostly in work apps, the entertainment page
// title still can't be the block label.
function blockHasWorkAppDominance(block: WorkContextBlock): boolean {
  return workAppDominantShare(block) >= WORK_APP_DOMINANT_SHARE
}

// Normalize for label-vs-page-title equivalence checks. Strip punctuation,
// collapse whitespace, lowercase.
function normalizeForLeakCheck(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// The brand token of a host: netflix.com → "netflix", studio.youtube.com →
// "youtube", bbc.co.uk → "bbc". Reuses the curated website-label map so it
// handles compound TLDs and short brands a bare domain split gets wrong (which
// otherwise let "x"/"hbo" slip past the leak guard). Used to catch entertainment
// labels that name the service without quoting a page title verbatim.
function brandTokenForHost(host: string | null | undefined): string | null {
  if (!host) return null
  const token = normalizeForLeakCheck(shortDomainLabel(host))
  return token.length >= 2 ? token : null
}

// True when `label` looks like it was lifted from — or names — an
// entertainment/social/adult service the user only peeked at inside this block.
// Catches the AI-labeler case where the model saw a Netflix/YouTube tab in the
// evidence and emitted "Watching Netflix" as the headline. timeline.md §3.5: a
// work block (work-app dominant OR overall intent is a focused category — a
// folded §3.2 peek leaves the block focused work) is never named after
// streaming; the open tab is evidence, not the headline.
function labelIsBrowserContentLeak(label: string, block: WorkContextBlock): boolean {
  if (!blockHasWorkAppDominance(block) && !FOCUSED_CATEGORIES.includes(block.dominantCategory)) return false
  const normLabel = normalizeForLeakCheck(label)
  if (!normLabel) return false
  for (const page of block.pageRefs) {
    const host = page.domain ?? page.host ?? null
    if (!isHostBlockedForAppsRail(host)) continue
    const brand = brandTokenForHost(host)
    if (brand && new RegExp(`(^| )${brand}( |$)`).test(normLabel)) return true
    const candidates = [page.pageTitle, page.displayTitle].filter((value): value is string => Boolean(value))
    for (const candidate of candidates) {
      const norm = normalizeForLeakCheck(candidate)
      if (!norm) continue
      if (norm === normLabel) return true
      if (norm.length >= 12 && normLabel.includes(norm)) return true
      if (normLabel.length >= 12 && norm.includes(normLabel)) return true
    }
  }
  return false
}

function preferredArtifactLabel(block: WorkContextBlock): string | null {
  // Document artifacts (files, repos, projects, window-derived) are
  // produced by the foreground app itself, so they're category-compatible
  // by construction — a VS Code window artifact reflects VS Code work.
  // Keep them unconditional.
  const documentLabel = usefulDerivedLabel(block.documentRefs[0]?.displayTitle)
  if (documentLabel && !looksLikeBrowserTabTitle(documentLabel)) return documentLabel

  // Page and website labels only apply when the block is browsing-dominant.
  // For a development block, a stray entertainment or news page is noise,
  // not a label.
  if (!isPageLabelCompatible(block)) return null

  // timeline.md §3.5: a block with real non-browser work in it (an editor, a
  // terminal, Word) is named after that work, never after a co-occurring web
  // page. The page is a peek; the work is the headline. Genuine document
  // artifacts already returned above; everything else defers to the AI/evidence
  // name. Page/domain labels survive only for browsing/research/AI blocks whose
  // page genuinely *is* the activity.
  if (blockHasWorkAppDominance(block)) return null

  // F1 + timeline.md §3.5: reject entertainment/social/adult pages as the label
  // on any work block — whether the user spent most of the block in non-browser
  // work apps, OR the block's overall intent is focused work (its dominant
  // category is a focused category). A folded Netflix/X peek (§3.2) is evidence
  // inside the block, never its headline. The IDE/terminal/AI-tool time is what
  // they were doing; the open tab is incidental.
  const workAppDominant = blockHasWorkAppDominance(block)
    || FOCUSED_CATEGORIES.includes(block.dominantCategory)
  const firstAllowedPage = block.pageRefs.find((page) => {
    const host = page.domain ?? page.host ?? null
    if (isHostBlockedForLabel(host)) return false
    if (workAppDominant && isHostBlockedForAppsRail(host)) return false
    return true
  })
  const rawPageLabel = firstAllowedPage?.displayTitle ?? firstAllowedPage?.pageTitle
  const pageLabel = usefulDerivedLabel(rawPageLabel)
  if (pageLabel && !looksLikeBrowserTabTitle(pageLabel) && !looksLikeSearchResultTitle(pageLabel)) return pageLabel

  const firstAllowedSite = block.websites.find((site) => {
    if (isHostBlockedForLabel(site.domain)) return false
    if (workAppDominant && isHostBlockedForAppsRail(site.domain)) return false
    return true
  })
  const domainLabel = firstAllowedSite ? shortDomainLabel(firstAllowedSite.domain) : null
  return usefulDerivedLabel(domainLabel)
}

function hasLegacyWeakAiLabel(block: WorkContextBlock): boolean {
  const aiLabel = block.aiLabel?.trim()
  return Boolean(aiLabel) && !usefulBlockLabel(block, aiLabel)
}

function labelIsCategoryFloor(block: WorkContextBlock, label: string): boolean {
  return label.trim().toLowerCase() === prettyCategory(block.dominantCategory).toLowerCase()
}

function labelLooksProjectHintFloor(label: string): boolean {
  return /\b(development|research|design|writing|productivity)$/i.test(label.trim())
}

export function shouldReanalyzeBlockWithAI(block: WorkContextBlock): boolean {
  if (block.isLive) return false
  if (block.label.override?.trim() || block.label.source === 'user') return false

  const currentLabel = block.label.current?.trim() ?? ''
  const aiLabel = block.aiLabel?.trim()
  if (hasLegacyWeakAiLabel(block)) return true
  if (block.label.source === 'ai' && aiLabel && usefulBlockLabel(block, aiLabel)) return false

  if (block.confidence === 'low' || block.label.confidence < 0.58) return true
  if (block.label.source === 'rule') return true
  if (block.label.source === 'artifact' || block.label.source === 'workflow') return true
  if (block.label.source === 'memory' && currentLabel && labelLooksProjectHintFloor(currentLabel)) return true
  if (currentLabel && labelIsCategoryFloor(block, currentLabel)) return true

  return false
}

function finalizedLabelForBlock(
  db: Database.Database,
  block: WorkContextBlock,
  dateStr: string = localDateKeyForTimestamp(block.startTime),
): WorkContextBlock {
  const override = getBlockLabelOverride(db, block.id)
  // Work-memory labels ("<project> development", learned work patterns) only
  // make sense on a block whose dominant activity is focused work. On a
  // browsing / social / entertainment / email block they produce the exact P1
  // contradiction the quality bar calls out — "Canva development" (BROWSING),
  // "Notifications development" (SOCIAL), "Obsidian Vault development"
  // (ENTERTAINMENT) — because a dev/terminal app merely *co-occurred*. For
  // those blocks, skip memory entirely and let the artifact/page/site label
  // (which agrees with the category) win.
  const allowWorkMemoryLabel = FOCUSED_CATEGORIES.includes(block.dominantCategory)
  const concurrentEvidence = memoryEnabled() && allowWorkMemoryLabel && !override?.label?.trim()
    ? gatherConcurrentEvidence(db, block)
    : null
  const memoryPattern = concurrentEvidence
    ? matchPromotedPatterns(db, block, concurrentEvidence)
    : null
  const projectHint = concurrentEvidence
    ? extractProjectHintFromEvidence(block, concurrentEvidence)
    : null
  const artifactLabel = preferredArtifactLabel(block)
  const workflowLabel = usefulBlockLabel(block, block.workflowRefs[0]?.label)
  const ruleLabel = usefulBlockLabel(block, block.ruleBasedLabel)
  const rawAiLabel = usefulBlockLabel(block, block.aiLabel)
  // F1: the AI labeler can also lift a YouTube tab title verbatim into the
  // block headline when it sees that page in the evidence. Reject any
  // suggested label that matches an entertainment/social/adult page title
  // in the block when the user's actual time was spent on work apps.
  const aiLabel = rawAiLabel && labelIsBrowserContentLeak(rawAiLabel, block) ? null : rawAiLabel

  // Label priority. A user override always wins; a user-promoted memory pattern
  // next. Then the names that read like a human wrote them — the AI label and
  // the concrete artifact (page/document) title — before the deterministic
  // floors. The project hint ("<project> development") is a FLOOR, not an
  // override: it must never beat a real AI label like "Refactoring the timeline
  // coalescer" (the §6 quality bar). It sits just above the bare rule label.
  const chosen = override?.label?.trim()
    || memoryPattern?.label
    || aiLabel
    || artifactLabel
    || workflowLabel
    || projectHint?.label
    || ruleLabel
    || userVisibleLabelForBlock(block)

  const source = override?.label?.trim()
    ? 'user'
    : memoryPattern?.label && chosen === memoryPattern.label
      ? 'memory'
      : aiLabel && chosen === aiLabel
        ? 'ai'
        : artifactLabel && chosen === artifactLabel
          ? 'artifact'
          : workflowLabel && chosen === workflowLabel
            ? 'workflow'
            : projectHint?.label && chosen === projectHint.label
              ? 'memory'
              : ruleLabel && chosen === ruleLabel
                ? 'rule'
                : 'rule'

  const finalized: WorkContextBlock = {
    ...block,
    label: {
      current: chosen,
      source,
      confidence: source === 'user'
        ? 1
        : source === 'memory'
          ? memoryPattern?.confidence ?? projectHint?.confidence ?? 0.72
        : source === 'artifact'
          ? 0.88
          : source === 'workflow'
            ? 0.8
            : source === 'ai'
              ? 0.65
              : block.label.confidence,
      narrative: override?.narrative ?? block.label.narrative,
      ruleBased: block.ruleBasedLabel,
      aiSuggested: block.aiLabel,
      override: override?.label ?? null,
    },
  }

  return applyReviewToBlock(finalized, reviewForBlock(db, dateStr, finalized))
}

function upsertArtifact(db: Database.Database, artifact: ArtifactRef, block: WorkContextBlock): void {
  db.prepare(`
    INSERT INTO artifacts (
      id,
      artifact_type,
      canonical_key,
      display_title,
      url,
      path,
      host,
      canonical_app_id,
      metadata_json,
      first_seen_at,
      last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_key) DO UPDATE SET
      display_title = excluded.display_title,
      url = COALESCE(excluded.url, artifacts.url),
      path = COALESCE(excluded.path, artifacts.path),
      host = COALESCE(excluded.host, artifacts.host),
      canonical_app_id = COALESCE(excluded.canonical_app_id, artifacts.canonical_app_id),
      metadata_json = excluded.metadata_json,
      last_seen_at = excluded.last_seen_at
  `).run(
    artifact.id,
    artifact.artifactType,
    artifact.canonicalKey ?? artifact.id,
    artifact.displayTitle,
    artifact.url ?? null,
    artifact.path ?? null,
    artifact.host ?? null,
    artifact.canonicalAppId ?? null,
    JSON.stringify(artifact.metadata ?? {}),
    block.startTime,
    block.endTime,
  )
}

function persistWorkflow(db: Database.Database, block: WorkContextBlock, dateStr: string): PersistedWorkflow[] {
  return block.workflowRefs.map((workflow) => {
    db.prepare(`
      INSERT INTO workflow_signatures (
        id,
        signature_key,
        label,
        dominant_category,
        canonical_apps_json,
        artifact_keys_json,
        rule_version,
        computed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature_key) DO UPDATE SET
        label = excluded.label,
        dominant_category = excluded.dominant_category,
        canonical_apps_json = excluded.canonical_apps_json,
        artifact_keys_json = excluded.artifact_keys_json,
        rule_version = excluded.rule_version,
        computed_at = excluded.computed_at
    `).run(
      workflow.id,
      workflow.signatureKey,
      workflow.label,
      workflow.dominantCategory,
      JSON.stringify(workflow.canonicalApps),
      JSON.stringify(workflow.artifactKeys),
      TIMELINE_HEURISTIC_VERSION,
      block.computedAt,
    )

    db.prepare(`
      INSERT INTO workflow_occurrences (workflow_id, block_id, date, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workflow_id, block_id) DO UPDATE SET
        date = excluded.date,
        confidence = excluded.confidence
    `).run(workflow.id, block.id, dateStr, workflow.confidence)

    return {
      workflow,
      artifactKeys: workflow.artifactKeys,
    }
  })
}

// Invalidate every persisted block for a date so the next reconstruction starts
// clean. Exported so the rebuild path can clear stale blocks before recomputing.
function invalidateTimelineDay(db: Database.Database, dateStr: string): void {
  db.prepare(`
    UPDATE timeline_blocks
    SET invalidated_at = ?
    WHERE date = ? AND invalidated_at IS NULL
  `).run(Date.now(), dateStr)
}

// Public invalidation for edits that change the day's underlying data
// (evidence purge): the persisted blocks are stale and must rebuild from
// what remains on the next read.
export function invalidateTimelineDayBlocks(db: Database.Database, dateStr: string): void {
  invalidateTimelineDay(db, dateStr)
  // The day's underlying evidence changed (purge, split, exclusion, journal
  // replay) — the frozen snapshot that feeds period wraps is stale with it,
  // and so is any stored wrap narrative written over the purged evidence.
  deleteDaySnapshotRow(db, dateStr)
  deleteWrappedNarrativesForDate(db, dateStr, 'evidence-change')
}

type CarriedAiLabel = { label: string; narrative: string | null; confidence: number }

// Re-attach AI block names across a re-segmentation. A block's id is derived from
// its exact session set + boundaries (`blockIdFor`), so a day that grows or
// re-segments on the next open mints brand-new ids and strands the AI labels
// keyed to the old ones — the rebuilt block silently drops back to a raw artifact
// title ("Jamie Duffy", "Labrinth"). That is the "timeline didn't save after a
// restart" bug. Snapshot the day's current AI labels by the same stable,
// session-set evidence key the review layer uses (`reviewEvidenceKeyForBlock`)
// so a freshly rebuilt block whose evidence is unchanged inherits the name it
// already earned, and re-persists it under its new id (stopping the orphan churn).
export function snapshotCarryForwardAiLabels(
  db: Database.Database,
  dateStr: string,
): Map<string, CarriedAiLabel> {
  const out = new Map<string, CarriedAiLabel>()
  const rows = db.prepare(`
    SELECT l.block_id AS blockId, l.label AS label, l.narrative AS narrative, l.confidence AS confidence
    FROM timeline_block_labels l
    JOIN timeline_blocks tb ON tb.id = l.block_id
    WHERE tb.date = ? AND tb.invalidated_at IS NULL AND tb.is_live = 0 AND l.source = 'ai'
    ORDER BY l.created_at DESC
  `).all(dateStr) as Array<{ blockId: string; label: string; narrative: string | null; confidence: number }>
  if (rows.length === 0) return out

  const memberStmt = db.prepare(`
    SELECT member_id AS memberId
    FROM timeline_block_members
    WHERE block_id = ? AND member_type = 'app_session'
  `)
  for (const row of rows) {
    const label = row.label?.trim()
    if (!label) continue
    const ids = (memberStmt.all(row.blockId) as Array<{ memberId: string }>)
      .map((m) => Number(m.memberId))
      .filter((id) => Number.isFinite(id) && id >= 0)
      .sort((a, b) => a - b)
    if (ids.length === 0) continue
    const key = `sessions:${ids.join(',')}`
    // created_at DESC — the first row seen for a key is the freshest; keep it.
    if (!out.has(key)) out.set(key, { label, narrative: row.narrative ?? null, confidence: row.confidence })
  }
  return out
}

// A freshly rebuilt block with no AI label and no user override inherits a
// carried-forward AI name when its evidence (the exact session set) is identical
// to a block that already had one. Strict equality means we only re-attach to the
// same stretch of work — a merge/split that changes the evidence gets re-named by
// AI on the next pass instead, never mislabeled.
function inheritCarriedAiLabel(
  db: Database.Database,
  block: WorkContextBlock,
  carried: Map<string, CarriedAiLabel> | null,
): WorkContextBlock {
  if (!carried || carried.size === 0) return block
  if (block.aiLabel?.trim() || block.label.override?.trim()) return block
  const match = carried.get(reviewEvidenceKeyForBlock(block))
  if (!match) return block
  if (getBlockLabelOverride(db, block.id)?.label?.trim()) return block
  const nextLabel = block.label.narrative?.trim()
    ? block.label
    : { ...block.label, narrative: match.narrative }
  return { ...block, aiLabel: match.label, label: nextLabel }
}

function persistTimelineDay(
  db: Database.Database,
  dateStr: string,
  blocks: WorkContextBlock[],
  options: { finalized?: boolean } = {},
): void {
  const validIds = blocks.filter((block) => !block.isLive).map((block) => block.id)
  // Carry forward AI names from the day's current blocks before the invalidation
  // below strands them. Skipped when finalized — those labels are already final.
  const carriedAiLabels = options.finalized ? null : snapshotCarryForwardAiLabels(db, dateStr)
  const persist = db.transaction(() => {
    if (validIds.length > 0) {
      const placeholders = validIds.map(() => '?').join(', ')
      db.prepare(`
        UPDATE timeline_blocks
        SET invalidated_at = ?
        WHERE date = ? AND invalidated_at IS NULL AND id NOT IN (${placeholders})
      `).run(Date.now(), dateStr, ...validIds)
    } else {
      db.prepare(`
        UPDATE timeline_blocks
        SET invalidated_at = ?
        WHERE date = ? AND invalidated_at IS NULL
      `).run(Date.now(), dateStr)
    }

    // Mentions are a projection of the day's current blocks. A superseded or
    // deleted block must not leave mentions behind: an orphaned mention still
    // carries the dead block's label in evidence_json, which resurrects
    // purged text. Scoped by the day's bounds and pruned against the blocks
    // that remain valid after this persist.
    const [dayFromMs, dayToMs] = localDayBounds(dateStr)
    if (validIds.length > 0) {
      const mentionPlaceholders = validIds.map(() => '?').join(', ')
      db.prepare(`
        DELETE FROM artifact_mentions
        WHERE source_type = 'timeline_block'
          AND start_time >= ? AND start_time < ?
          AND source_id NOT IN (${mentionPlaceholders})
      `).run(dayFromMs, dayToMs, ...validIds)
    } else {
      db.prepare(`
        DELETE FROM artifact_mentions
        WHERE source_type = 'timeline_block'
          AND start_time >= ? AND start_time < ?
      `).run(dayFromMs, dayToMs)
    }

    for (const rawBlock of blocks) {
      if (rawBlock.isLive) continue
      const block = options.finalized
        ? rawBlock
        : finalizedLabelForBlock(db, inheritCarriedAiLabel(db, rawBlock, carriedAiLabels), dateStr)
      db.prepare(`
        INSERT INTO timeline_blocks (
          id,
          date,
          start_time,
          end_time,
          block_kind,
          dominant_category,
          category_distribution_json,
          switch_count,
          label_current,
          label_source,
          label_confidence,
          narrative_current,
          evidence_summary_json,
          is_live,
          heuristic_version,
          computed_at,
          invalidated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          date = excluded.date,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          block_kind = excluded.block_kind,
          dominant_category = excluded.dominant_category,
          category_distribution_json = excluded.category_distribution_json,
          switch_count = excluded.switch_count,
          label_current = excluded.label_current,
          label_source = excluded.label_source,
          label_confidence = excluded.label_confidence,
          narrative_current = excluded.narrative_current,
          evidence_summary_json = excluded.evidence_summary_json,
          is_live = excluded.is_live,
          heuristic_version = excluded.heuristic_version,
          computed_at = excluded.computed_at,
          invalidated_at = NULL
      `).run(
        block.id,
        dateStr,
        block.startTime,
        block.endTime,
        blockKindFor(block),
        block.dominantCategory,
        JSON.stringify(block.categoryDistribution),
        block.switchCount,
        block.label.current,
        block.label.source,
        block.label.confidence,
        block.label.narrative,
        JSON.stringify(block.evidenceSummary),
        0,
        block.heuristicVersion,
        block.computedAt,
      )

      db.prepare(`DELETE FROM timeline_block_members WHERE block_id = ?`).run(block.id)
      db.prepare(`DELETE FROM artifact_mentions WHERE source_type = 'timeline_block' AND source_id = ?`).run(block.id)
      db.prepare(`DELETE FROM workflow_occurrences WHERE block_id = ?`).run(block.id)

      const insertMember = db.prepare(`
        INSERT OR REPLACE INTO timeline_block_members (
          block_id,
          member_type,
          member_id,
          start_time,
          end_time,
          weight_seconds
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)

      for (const session of block.sessions) {
        insertMember.run(
          block.id,
          'app_session',
          String(session.id),
          session.startTime,
          session.endTime ?? (session.startTime + session.durationSeconds * 1000),
          session.durationSeconds,
        )
      }

      for (const focusId of block.focusOverlap.sessionIds) {
        insertMember.run(block.id, 'focus_session', String(focusId), block.startTime, block.endTime, block.focusOverlap.totalSeconds)
      }

      for (const page of block.pageRefs) {
        insertMember.run(block.id, 'website_visit', page.id, block.startTime, block.endTime, page.totalSeconds)
      }

      db.prepare(`
        INSERT OR REPLACE INTO timeline_block_labels (
          id,
          block_id,
          label,
          narrative,
          source,
          confidence,
          created_at,
          model_info_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${block.id}:${block.label.source}:${sha1(block.label.current).slice(0, 8)}`,
        block.id,
        block.label.current,
        block.label.narrative,
        block.label.source,
        block.label.confidence,
        block.computedAt,
        null,
      )

      ensureDefaultReviewRowForBlock(db, dateStr, block)

      for (const artifact of block.topArtifacts) {
        upsertArtifact(db, artifact, block)
        db.prepare(`
          INSERT OR REPLACE INTO artifact_mentions (
            id,
            artifact_id,
            source_type,
            source_id,
            start_time,
            end_time,
            confidence,
            evidence_json
          )
          VALUES (?, ?, 'timeline_block', ?, ?, ?, ?, ?)
        `).run(
          `${artifact.id}:timeline_block:${block.id}`,
          artifact.id,
          block.id,
          block.startTime,
          block.endTime,
          artifact.confidence,
          JSON.stringify({
            blockId: block.id,
            label: block.label.current,
          }),
        )
      }

      persistWorkflow(db, block, dateStr)
    }
  })

  persist()
}

const timelineMaterializationFingerprints = new Map<string, string>()

type PersistedBlockLabelRow = { block_id: string; label: string; source: string }
type PersistedBlockMemberRow = { block_id: string; member_id: string; weight_seconds: number }

function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function persistedBlockLabelsByBlockId(
  db: Database.Database,
  blockIds: string[],
): Map<string, PersistedBlockLabelRow[]> {
  const labelsByBlock = new Map<string, PersistedBlockLabelRow[]>()
  if (blockIds.length === 0) return labelsByBlock

  const rows = db.prepare(`
    SELECT block_id, label, source
    FROM timeline_block_labels
    WHERE block_id IN (${sqlPlaceholders(blockIds.length)})
    ORDER BY block_id ASC, created_at ASC, id ASC
  `).all(...blockIds) as PersistedBlockLabelRow[]

  for (const row of rows) {
    const labels = labelsByBlock.get(row.block_id)
    if (labels) labels.push(row)
    else labelsByBlock.set(row.block_id, [row])
  }
  return labelsByBlock
}

function persistedBlockMembersByBlockId(
  db: Database.Database,
  blockIds: string[],
  memberType: 'app_session' | 'focus_session',
): Map<string, PersistedBlockMemberRow[]> {
  const membersByBlock = new Map<string, PersistedBlockMemberRow[]>()
  if (blockIds.length === 0) return membersByBlock

  const rows = db.prepare(`
    SELECT block_id, member_id, weight_seconds
    FROM timeline_block_members
    WHERE member_type = ? AND block_id IN (${sqlPlaceholders(blockIds.length)})
    ORDER BY block_id ASC, start_time ASC, member_id ASC
  `).all(memberType, ...blockIds) as PersistedBlockMemberRow[]

  for (const row of rows) {
    const members = membersByBlock.get(row.block_id)
    if (members) members.push(row)
    else membersByBlock.set(row.block_id, [row])
  }
  return membersByBlock
}

function validPersistedTimelineBlockCount(db: Database.Database, dateStr: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
  `).get(dateStr) as { count: number } | undefined
  return row?.count ?? 0
}

function timelineMaterializationFingerprint(
  dateStr: string,
  sessions: AppSession[],
  blocks: WorkContextBlock[],
): string {
  const hash = crypto.createHash('sha1')
  hash.update(dateStr)
  hash.update(TIMELINE_HEURISTIC_VERSION)
  for (const session of sessions) {
    hash.update(`s:${session.id}:${session.startTime}:${session.endTime ?? ''}:${session.durationSeconds}:${session.bundleId}:${session.category};`)
  }
  for (const block of blocks) {
    hash.update(`b:${block.id}:${block.startTime}:${block.endTime}:${block.label.current}:${block.label.source}:${block.heuristicVersion};`)
  }
  return hash.digest('hex')
}

function persistTimelineDayIfChanged(
  db: Database.Database,
  dateStr: string,
  sessions: AppSession[],
  blocks: WorkContextBlock[],
  force = false,
): void {
  const fingerprint = timelineMaterializationFingerprint(dateStr, sessions, blocks)
  const cacheKey = dateStr
  const hasPersistedBlocks = validPersistedTimelineBlockCount(db, dateStr) > 0
  if (!force && hasPersistedBlocks && timelineMaterializationFingerprints.get(cacheKey) === fingerprint) {
    return
  }

  persistTimelineDay(db, dateStr, blocks, { finalized: true })
  timelineMaterializationFingerprints.set(cacheKey, fingerprint)
}

function loadPersistedTimelineBlocksForDay(
  db: Database.Database,
  dateStr: string,
  sessions: AppSession[],
): WorkContextBlock[] | null {
  const rows = db.prepare(`
    SELECT
      id,
      start_time,
      end_time,
      dominant_category,
      category_distribution_json,
      switch_count,
      label_current,
      label_source,
      label_confidence,
      narrative_current,
      evidence_summary_json,
      heuristic_version,
      computed_at
    FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
    ORDER BY start_time ASC
  `).all(dateStr) as Array<{
    id: string
    start_time: number
    end_time: number
    dominant_category: AppCategory
    category_distribution_json: string
    switch_count: number
    label_current: string
    label_source: string
    label_confidence: number
    narrative_current: string | null
    evidence_summary_json: string
    heuristic_version: string
    computed_at: number
  }>

  if (rows.length === 0) {
    return null
  }

  const blockIds = rows.map((row) => row.id)
  const workflowsByBlock = workflowRefsByBlockId(db, blockIds)
  const labelsByBlock = persistedBlockLabelsByBlockId(db, blockIds)
  const appSessionMembersByBlock = persistedBlockMembersByBlockId(db, blockIds, 'app_session')
  const focusSessionMembersByBlock = persistedBlockMembersByBlockId(db, blockIds, 'focus_session')

  const blocks: WorkContextBlock[] = []

  for (const row of rows) {
    let evidence: Partial<TimelineEvidenceSummary> = {}
    try {
      evidence = JSON.parse(row.evidence_summary_json || '{}') as Partial<TimelineEvidenceSummary>
    } catch {
      evidence = {}
    }

    const pageRefs = Array.isArray(evidence.pages) ? evidence.pages as PageRef[] : []
    const documentRefs = Array.isArray(evidence.documents) ? evidence.documents as DocumentRef[] : []
    const topArtifacts = [...pageRefs, ...documentRefs]
      .sort((left, right) => right.totalSeconds - left.totalSeconds)
      .slice(0, 6)

    const labelRows = labelsByBlock.get(row.id) ?? []

    let categoryDistribution: Partial<Record<AppCategory, number>> = {}
    try {
      categoryDistribution = JSON.parse(row.category_distribution_json)
    } catch {
      categoryDistribution = {}
    }

    const dominantCategory = dominantCategoryForBlock(categoryDistribution, topArtifacts)
    const ruleLabel = labelRows.find(r => r.source === 'rule')?.label || prettyCategory(dominantCategory)
    const aiLabel = labelRows.find(r => r.source === 'ai' || r.source === 'workflow')?.label || null
    const overrideRow = labelRows.find(r => r.source === 'user')

    const memberRows = appSessionMembersByBlock.get(row.id) ?? []

    const sessionIds = new Set(memberRows.map((r) => Number(r.member_id)))
    let blockSessions = sessions.filter((s) => sessionIds.has(s.id))
    if (blockSessions.length === 0) {
      // Derived read path: the persisted members are app_session ids, but the
      // sessions handed in for a past day are *derived* sessions in a different
      // id namespace, so the id match above finds nothing and the block comes
      // back with no sessions. That silently broke every merge on a settled day
      // — manual shift-click and AI Analyze alike — because a merge correction is
      // anchored on the two sessions straddling a boundary and there were none to
      // anchor on. Assign each session to the block its START falls in (the same
      // way the rebuild assigns a session to exactly one candidate): the sets are
      // disjoint, so a block's last session and its neighbour's first session are
      // the real adjacent pair, and a merge recorded on them round-trips on the
      // next rebuild keyed on those same derived ids.
      blockSessions = sessions.filter((s) => s.startTime >= row.start_time && s.startTime < row.end_time)
    }

    const websites = filterExcludedWebsiteSummaries(
      db, getWebsiteSummariesForRange(db, row.start_time, row.end_time), row.start_time, row.end_time,
    ).slice(0, 5)

    const keyPagesByDomain = getTopPagesForDomains(db, row.start_time, row.end_time, websites.map((site) => site.domain), 2)
    const keyPages = websites.flatMap((site) => keyPagesByDomain[site.domain] ?? [])
      .map((page) => page.title?.trim())
      .filter((title): title is string => Boolean(title))
      .filter((title, index, titles) => titles.indexOf(title) === index)
      .slice(0, 4)

    const focusRows = focusSessionMembersByBlock.get(row.id) ?? []

    const focusSessionIds = focusRows.map((r) => Number(r.member_id))
    const focusTotalSeconds = focusRows[0]?.weight_seconds ?? 0
    const durationSec = Math.max(1, (row.end_time - row.start_time) / 1000)
    const focusOverlap = {
      totalSeconds: focusTotalSeconds,
      pct: Math.min(100, Math.round((focusTotalSeconds / durationSec) * 100)),
      sessionIds: focusSessionIds,
    }

    blocks.push({
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      dominantCategory,
      categoryDistribution,
      ruleBasedLabel: ruleLabel,
      aiLabel: aiLabel,
      sessions: blockSessions,
      topApps: Array.isArray(evidence.apps)
        ? normalizeAppSummariesForBlockDisplay(evidence.apps as WorkContextAppSummary[])
        : [],
      websites,
      keyPages,
      pageRefs,
      documentRefs,
      topArtifacts,
      workflowRefs: workflowsByBlock.get(row.id) ?? [],
      label: {
        current: row.label_current,
        source: row.label_source as LabelSource,
        confidence: row.label_confidence,
        narrative: row.narrative_current,
        ruleBased: ruleLabel,
        aiSuggested: aiLabel,
        override: overrideRow?.label ?? null,
      },
      focusOverlap,
      evidenceSummary: {
        apps: Array.isArray(evidence.apps)
          ? normalizeAppSummariesForBlockDisplay(evidence.apps as WorkContextAppSummary[])
          : [],
        pages: pageRefs,
        documents: documentRefs,
        domains: Array.isArray(evidence.domains) ? evidence.domains as string[] : [],
        windowTitles: Array.isArray(evidence.windowTitles) ? evidence.windowTitles : [],
        sites: Array.isArray(evidence.sites) ? evidence.sites : pageRefs,
        files: Array.isArray(evidence.files) ? evidence.files : [],
      },
      heuristicVersion: row.heuristic_version,
      computedAt: row.computed_at,
      switchCount: row.switch_count,
      confidence: confidenceForCandidate({
        sessions: blockSessions,
        formation: 'mixed',
        boundedBeforeGap: false,
        boundedAfterGap: false,
      }, coherenceScore(categoryDistribution)),
      review: {
        ...DEFAULT_TIMELINE_BLOCK_REVIEW,
        state: 'pending',
      },
      isLive: false,
    })
  }

  // Grouping is cached, but labeling is always derived fresh. Re-run the label
  // finalizer over every loaded block so the current logic (category-gated
  // memory, project hints grounded in real code signals, the AI-over-floor
  // priority) applies even to days frozen as "processed". This is what replaces
  // the stale "Canva development" / "Notifications development" strings that one
  // AI-labeled block used to freeze in place for a whole day. Stored user
  // overrides and AI suggestions are read back inside the finalizer, so curated
  // labels still win.
  return blocks.map((block) => finalizedLabelForBlock(db, block, dateStr))
}

// A day is "processed" once any of its persisted blocks carries an AI,
// workflow, or user-authored label — i.e. the nightly consolidation job (or the
// user) has already named it. Such a day is kept exactly as it was summarized.
export function persistedDayWasProcessed(db: Database.Database, dateStr: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM timeline_block_labels labels
    JOIN timeline_blocks blocks ON blocks.id = labels.block_id
    WHERE blocks.date = ?
      AND blocks.invalidated_at IS NULL
      AND blocks.is_live = 0
      AND labels.source IN ('ai', 'workflow', 'user')
    LIMIT 1
  `).get(dateStr)
  return Boolean(row)
}

// True when the persisted blocks for a day were built by a superseded timeline
// heuristic, so a fresh reconstruction would group them more accurately.
function persistedDayHeuristicIsStale(db: Database.Database, dateStr: string): boolean {
  const row = db.prepare(`
    SELECT heuristic_version
    FROM timeline_blocks
    WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
    ORDER BY computed_at ASC
    LIMIT 1
  `).get(dateStr) as { heuristic_version: string } | undefined
  if (!row) return false
  return row.heuristic_version !== TIMELINE_HEURISTIC_VERSION
}

// The live day, before it is analyzed, is provisional — never
// split into speculative intent-named blocks (naming live is how a
// transcription session got stamped "Software Development Block"). But the raw
// unit is still honest: each continuous
// sitting is its own provisional block, ended by any real activity gap of 15+
// minutes. The gap between sittings is blank space, never absorbed — one card
// spanning 12:00 AM to 10:54 AM across a night of sleep is a lie. The stretch
// being lived in right now is "Active now"; finished stretches wait neutrally
// as "Earlier today" until Analyze Day names them. Each block still carries
// full evidence so the detail panel works.
function buildProvisionalLiveBlocks(
  db: Database.Database,
  sessions: AppSession[],
): WorkContextBlock[] {
  if (sessions.length === 0) return []
  const context = buildTimelineContext(db, sessions)
  // A new provisional block starts when activity resumes — so
  // the day's MOST RECENT sitting always shows, no matter how short yet. The
  // old floor filter here made a sitting that just resumed after an idle/away
  // gap — including the one being lived in right now, "Active now" —
  // invisible for up to 15 minutes. Earlier, finished
  // sittings still need to clear the block floor on span or active time: a
  // 24s 1:56am blip separated from the real day by an 8h sleep gap must not
  // become its own phantom block.
  const segments = coarseSegmentsFromSessions(sessions).filter((seg) => seg.sessions.length > 0)
  const kept = segments.filter((seg, index) => {
    if (index === segments.length - 1) return true
    const span = sessionEndMs(seg.sessions[seg.sessions.length - 1]) - seg.sessions[0].startTime
    const active = seg.sessions.reduce((sum, s) => sum + Math.max(0, s.durationSeconds * 1000), 0)
    return span >= TIMELINE_MIN_BLOCK_FLOOR_MS || active >= TIMELINE_MIN_BLOCK_FLOOR_MS
  })
  return kept.map((seg) => {
    const candidate: CandidateBlock = {
      sessions: seg.sessions,
      formation: 'heuristic',
      boundedBeforeGap: seg.boundedBeforeGap,
      boundedAfterGap: seg.boundedAfterGap,
    }
    const block = buildBlockFromCandidate(candidate, db, context)
    const containsLiveSession = seg.sessions.some((session) => session.id === -1)
    return {
      ...block,
      provisional: true,
      isLive: containsLiveSession,
      label: {
        ...block.label,
        current: containsLiveSession ? 'Active now' : 'Earlier today',
        source: 'rule' as const,
        confidence: 0,
        override: null,
        aiSuggested: null,
      },
    }
  })
}

// The time spans of blocks the user deleted (review state 'ignored') on a
// date. A deleted block's sessions are excluded from every rebuild, so the
// block can neither re-form nor be silently absorbed into a neighbour — the
// deletion is a correction and corrections survive rebuilds (invariant 8).
function loadIgnoredBlockSpans(db: Database.Database, dateStr: string): MergedSpan[] {
  const rows = db.prepare(`
    SELECT original_block_json
    FROM timeline_block_reviews
    WHERE date = ? AND review_state = 'ignored'
  `).all(dateStr) as Array<{ original_block_json: string }>
  const spans: MergedSpan[] = []
  for (const row of rows) {
    const original = parseReviewJson(row.original_block_json)
    const startMs = typeof original.startTime === 'number' ? original.startTime : null
    const endMs = typeof original.endTime === 'number' ? original.endTime : null
    if (startMs != null && endMs != null && endMs > startMs) {
      spans.push({ startMs, endMs })
    }
  }
  return spans
}

// Deterministic category refresh for settled days.
// A processed day is never rebuilt — boundaries, labels, and corrections are
// frozen — but the category facts under its colors were computed by an old
// heuristic and stayed wrong forever ("no color until I click Analyze").
// Recompute distribution + dominant category from the block's own sessions with
// the CURRENT rules and write them back, stamping the block's heuristic_version
// so the refresh runs once per heuristic bump. Labels are never touched, no AI
// is involved, and the write-back means row-level readers (the month grid's
// getTimelineRangeBlocks) converge too.
function refreshStaleBlockCategoryFacts(db: Database.Database, blocks: WorkContextBlock[]): void {
  const stale = blocks.filter((block) => block.heuristicVersion !== TIMELINE_HEURISTIC_VERSION)
  if (stale.length === 0) return

  const update = db.prepare(`
    UPDATE timeline_blocks
    SET dominant_category = ?, category_distribution_json = ?, block_kind = ?, heuristic_version = ?
    WHERE id = ?
  `)

  for (const block of stale) {
    // A user recategorization is a correction and corrections survive every
    // rebuild (invariant 8): refresh the distribution facts underneath, but
    // never overwrite the corrected dominant category (in memory it was
    // already applied by applyReviewToBlock; the persisted row must not
    // regress it either).
    const userCorrectedCategory = block.review?.state === 'corrected' && block.review.correctedCategory
      ? block.review.correctedCategory
      : null
    // No resolvable sessions (e.g. their raw rows were pruned): keep the
    // persisted facts rather than replace them with an empty guess.
    if (block.sessions.length > 0) {
      const distribution = weightedCategoryDistributionFor(db, block.sessions, block.startTime, block.endTime)
      block.categoryDistribution = distribution
      block.dominantCategory = userCorrectedCategory
        ?? dominantCategoryForBlock(distribution, block.topArtifacts)
    }
    block.heuristicVersion = TIMELINE_HEURISTIC_VERSION
    // block_kind feeds the month/range readers directly
    // (timelineCalendarRange.ts); refreshing category without it would leave
    // the two persisted facts disagreeing about the same block.
    update.run(
      block.dominantCategory,
      JSON.stringify(block.categoryDistribution),
      blockKindFor(block),
      TIMELINE_HEURISTIC_VERSION,
      block.id,
    )
  }
}

function withoutIgnoredSpans(sessions: AppSession[], spans: MergedSpan[]): AppSession[] {
  if (spans.length === 0) return sessions
  return sessions.filter((session) =>
    !spans.some((span) => session.startTime >= span.startMs && session.startTime < span.endMs))
}

// Sanity check: a single block claiming many hours
// of unbroken engagement is almost never real — it usually means idle/away
// detection failed inside the span. We don't silently trust it; we flag it in
// the main-process log so the failure is visible and diagnosable. Deduped per
// (date, span) so periodic payload refreshes don't spam the log.
const flaggedSuspiciousBlocks = new Set<string>()
function flagSuspiciousUnbrokenBlocks(dateStr: string, blocks: WorkContextBlock[]): void {
  for (const block of blocks) {
    const spanMs = block.endTime - block.startTime
    if (spanMs < SUSPICIOUS_UNBROKEN_BLOCK_SPAN_MS) continue
    const key = `${dateStr}:${block.startTime}:${block.endTime}`
    if (flaggedSuspiciousBlocks.has(key)) continue
    flaggedSuspiciousBlocks.add(key)
    const hours = (spanMs / 3_600_000).toFixed(1)
    const activeHours = (blockActiveSeconds(block) / 3_600).toFixed(1)
    console.warn(
      `[timeline] suspicious unbroken block on ${dateStr}: "${block.label.current}" spans ${hours}h `
      + `(${activeHours}h active) with no detected gap — idle/away detection likely failed in this span`,
    )
  }
}

export function buildTimelineBlocksForDay(
  db: Database.Database,
  dateStr: string,
  sessions: AppSession[],
  options: { materialize?: boolean; forceRebuild?: boolean } = {},
): WorkContextBlock[] {
  const shouldMaterialize = options.materialize ?? true
  // forceRebuild (the absence-repair path in analyzeDay.ts): reconstruct the
  // day from its sessions through the full pipeline even when it is
  // "processed". The rebuild rides persistTimelineDay, which snapshots and
  // carries forward AI labels by evidence key BEFORE invalidating the old
  // rows, so curated names re-attach to every block whose session set is
  // unchanged, and user corrections replay from their durable stores
  // (invariant 8) — except a merge across a real absence, which the guard in
  // scoreBoundary now refuses to honor.
  const forceRebuild = (options.forceRebuild ?? false) && shouldMaterialize
  const todayStr = localDateString()
  let forceMaterialize = forceRebuild
  sessions = withoutIgnoredSpans(sessions, loadIgnoredBlockSpans(db, dateStr))

  if (dateStr < todayStr && !forceRebuild) {
    const persisted = loadPersistedTimelineBlocksForDay(db, dateStr, sessions)
    if (persisted && persisted.length > 0) {
      // Keep nightly/user-processed days exactly as they were summarized, and
      // keep any day already on the current heuristic (no churn). Only an older
      // day the nightly job never reached AND built under a superseded
      // heuristic is reconstructed more accurately on revisit, then
      // re-persisted so the improvement sticks.
      if (persistedDayWasProcessed(db, dateStr) || !persistedDayHeuristicIsStale(db, dateStr)) {
        // A processed day keeps its boundaries and labels forever, but its
        // CATEGORY facts were computed by whatever heuristic was current at the
        // time — and category is what colors every surface (timeline.md §3.4:
        // color coding is universal). Refresh just those deterministic facts in
        // place so old days converge on today's categorization without an AI
        // call and without touching a single label (invariant 8).
        refreshStaleBlockCategoryFacts(db, persisted)
        flagSuspiciousUnbrokenBlocks(dateStr, persisted)
        return persisted
      }
      forceMaterialize = true
    } else {
      forceMaterialize = true
    }
  } else if (validPersistedTimelineBlockCount(db, dateStr) === 0) {
    forceMaterialize = true
  }

  const computed = buildBlocksForSessions(db, sessions, dateStr).map((block) => finalizedLabelForBlock(db, block, dateStr))
  flagSuspiciousUnbrokenBlocks(dateStr, computed)
  if (shouldMaterialize) {
    persistTimelineDayIfChanged(db, dateStr, sessions, computed, forceMaterialize)
  }
  return computed
}

// A gap becomes visible blank space on the grid at the same threshold that
// ends a block: 15 minutes. Below that a lull is absorbed; at or above it the
// timeline must show the absence honestly.
const MIN_VISIBLE_GAP_MS = 15 * 60 * 1000

// One cause interval derived from a start/end pair of activity-state events.
interface GapCauseInterval {
  kind: TimelineGapSegment['kind']
  startTime: number
  endTime: number
}

const GAP_KIND_LABELS: Record<string, string> = {
  asleep: 'Asleep',
  locked: 'Locked',
  idle: 'Idle',
  passive: 'Passive',
  paused: 'Tracking paused',
  untracked: 'No data captured',
}

// When multiple causes covered parts of one gap, the strongest signal names
// it: a real absence (machine asleep / screen locked) outranks a pause,
// which outranks presence-without-input.
const GAP_KIND_PRIORITY: Array<TimelineGapSegment['kind']> = ['asleep', 'locked', 'paused', 'passive', 'idle']

// Turn the day's raw activity-state events into cause intervals. Each
// start-type event opens a cause; the next end-type event closes it. An
// idle_start recorded with heldForMediaPlayback means something was actively
// playing — the user was present, just not typing — which is passive
// presence, not idleness.
function gapCauseIntervals(events: ReturnType<typeof getActivityStateEventsForRange>, toMs: number): GapCauseInterval[] {
  const intervals: GapCauseInterval[] = []
  let open: { kind: TimelineGapSegment['kind']; startTime: number } | null = null

  const closeAt = (ts: number) => {
    if (open && ts > open.startTime) {
      intervals.push({ kind: open.kind, startTime: open.startTime, endTime: ts })
    }
    open = null
  }

  for (const event of events) {
    switch (event.eventType) {
      case 'suspend':
        closeAt(event.eventTs)
        open = { kind: 'asleep', startTime: event.eventTs }
        break
      case 'lock_screen':
        closeAt(event.eventTs)
        open = { kind: 'locked', startTime: event.eventTs }
        break
      case 'away_start':
        // The no-input flush while unlocked: idle, not locked-away.
        if (!open || open.kind === 'idle' || open.kind === 'passive') {
          closeAt(event.eventTs)
          open = { kind: 'idle', startTime: event.eventTs }
        }
        break
      case 'idle_start': {
        let heldForMedia = false
        try {
          heldForMedia = Boolean(JSON.parse(event.metadataJson || '{}').heldForMediaPlayback)
        } catch { /* malformed metadata reads as plain idle */ }
        if (!open || open.kind === 'idle' || open.kind === 'passive') {
          closeAt(event.eventTs)
          open = { kind: heldForMedia ? 'passive' : 'idle', startTime: event.eventTs }
        }
        break
      }
      case 'tracking_paused':
        closeAt(event.eventTs)
        open = { kind: 'paused', startTime: event.eventTs }
        break
      case 'resume':
      case 'unlock_screen':
      case 'away_end':
      case 'idle_end':
      case 'tracking_resumed':
        closeAt(event.eventTs)
        break
      default:
        break
    }
  }
  closeAt(toMs)
  return intervals
}

// Name one gap range from the cause intervals that overlap it: a gap that no
// signal covers at least half of is honestly "Untracked" — Daylens wasn't
// running to know. Otherwise, when several causes covered
// parts of the gap, the strongest real-absence signal names it by priority
// order (asleep > locked > paused > passive > idle) — NOT whichever kind
// happened to cover the most of the gap (coverage share used to outrank
// priority, so a gap that was 60% idle and 40% asleep read as "Idle"
// instead of the stronger "Asleep" signal).
function classifyGapRange(
  range: { startTime: number; endTime: number },
  causes: GapCauseInterval[],
): TimelineGapSegment {
  const gapMs = range.endTime - range.startTime
  const covered = new Map<TimelineGapSegment['kind'], number>()
  for (const cause of causes) {
    const overlap = Math.min(cause.endTime, range.endTime) - Math.max(cause.startTime, range.startTime)
    if (overlap > 0) covered.set(cause.kind, (covered.get(cause.kind) ?? 0) + overlap)
  }
  const totalCovered = [...covered.values()].reduce((sum, ms) => sum + ms, 0)
  const best = totalCovered < gapMs * 0.5
    ? null
    : GAP_KIND_PRIORITY.find((kind) => (covered.get(kind) ?? 0) > 0) ?? null
  if (!best) {
    return {
      kind: 'untracked',
      startTime: range.startTime,
      endTime: range.endTime,
      label: GAP_KIND_LABELS.untracked,
      source: 'derived_gap',
    }
  }
  return {
    kind: best,
    startTime: range.startTime,
    endTime: range.endTime,
    label: GAP_KIND_LABELS[best] ?? 'Away',
    source: 'activity_event',
  }
}

export function buildSegmentsForDay(
  db: Database.Database,
  dateStr: string,
  blocks: WorkContextBlock[],
  // The day bounds the payload was built with — segments must cover the same
  // range the blocks were read from, or gaps and blocks drift apart.
  bounds?: [number, number],
): TimelineSegment[] {
  const [fromMs, toMs] = bounds ?? ownedDayBounds(db, dateStr)
  const events = getActivityStateEventsForRange(db, fromMs, toMs)
  const causes = gapCauseIntervals(events, toMs)
  const workSegments: TimelineSegment[] = blocks.map((block) => ({
    kind: 'work_block',
    startTime: block.startTime,
    endTime: block.endTime,
    blockId: block.id,
  }))

  const gapRanges: Array<{ startTime: number; endTime: number }> = []
  const byStart = [...workSegments].sort((left, right) => left.startTime - right.startTime)
  // The day starts at the first real block, not midnight: overnight sleep/idle
  // before you began is not a gap in your day, so never render a gap reason
  // before the first block. Gaps BETWEEN and after blocks still show — but
  // never past "now": the live day's bounds run to midnight, and the hours
  // that haven't happened yet are not a gap of any kind.
  const gapCeiling = Math.min(toMs, Date.now())
  let cursor = byStart.length > 0 ? byStart[0].startTime : fromMs
  for (const segment of byStart) {
    if (segment.startTime > cursor) {
      gapRanges.push({ startTime: cursor, endTime: Math.min(segment.startTime, gapCeiling) })
    }
    cursor = Math.max(cursor, segment.endTime)
  }
  if (cursor < gapCeiling) {
    gapRanges.push({ startTime: cursor, endTime: gapCeiling })
  }

  // One classified segment per visible gap:
  // the blank space stays blank, but it always knows why it's blank.
  const gapSegments: TimelineSegment[] = gapRanges
    .filter((range) => range.endTime - range.startTime >= MIN_VISIBLE_GAP_MS)
    .map((range) => classifyGapRange(range, causes))

  return [...workSegments, ...gapSegments]
    .filter((segment) => segment.endTime > segment.startTime)
    .sort((left, right) => left.startTime - right.startTime)
}

// DEV-113: honor the apps the user marked as their real work in onboarding.
// `isFocused` is otherwise purely category-based, so an app the user lives in
// that we classify as "other" (a niche tool, a browser they work in) would not
// count toward focus / real-work totals. We re-derive `isFocused` at read time
// so a focus-app change takes effect the same day without recapturing anything.
function withFocusApps(sessions: AppSession[]): AppSession[] {
  const focusApps = getSettings().focusApps
  if (!focusApps || focusApps.length === 0) return sessions
  return sessions.map((session) => {
    const focused = isAppFocused(session.category, session.bundleId, session.appName, focusApps)
    return focused === session.isFocused ? session : { ...session, isFocused: focused }
  })
}

export function mergeLiveSession(sessions: AppSession[], liveSession?: LiveSession | null): AppSession[] {
  if (!liveSession) return sessions

  const liveEnd = Date.now()
  if (liveEnd <= liveSession.startTime) return sessions

  return [
    ...sessions,
    {
      id: -1,
      bundleId: liveSession.bundleId,
      appName: liveSession.appName,
      startTime: liveSession.startTime,
      endTime: liveEnd,
      durationSeconds: Math.max(1, Math.round((liveEnd - liveSession.startTime) / 1000)),
      category: liveSession.category,
      isFocused: FOCUSED_CATEGORIES.includes(liveSession.category),
      windowTitle: liveSession.windowTitle ?? null,
      rawAppName: liveSession.rawAppName ?? liveSession.appName,
      canonicalAppId: liveSession.canonicalAppId ?? null,
      appInstanceId: liveSession.appInstanceId ?? liveSession.bundleId,
      captureSource: liveSession.captureSource ?? 'foreground_poll',
      endedReason: null,
      captureVersion: 2,
    },
  ].sort((left, right) => left.startTime - right.startTime)
}

// Leisure/personal blocks are named by their activity, derived from the
// domains they sat on — "Watching YouTube & Netflix", "On X" — never the raw
// video/page title and never an inferred work label.
function leisureLabelForBlock(block: WorkContextBlock): string {
  const leisureDomains = block.websites
    .filter((site) => kindForDomain(site.domain) === 'leisure')
    .map((site) => site.domain)
  if (leisureDomains.length > 0) return leisureActivityTitle(leisureDomains)
  // No leisure domain captured (titleless browsing): fall back to the top
  // domains, still activity-shaped.
  return leisureActivityTitle(block.websites.map((site) => site.domain))
}

export function userVisibleLabelForBlock(block: WorkContextBlock, overrideLabel?: string | null): string {
  // A user rename always wins, verbatim.
  if (overrideLabel && overrideLabel.trim() && !GENERIC_LABELS.has(overrideLabel.trim())) {
    return overrideLabel.trim()
  }
  if (block.review?.correctedLabel?.trim()) {
    return block.review.correctedLabel.trim()
  }

  if (effectiveBlockKind(block) !== 'work') {
    return leisureLabelForBlock(block)
  }

  return humanizeTitle(rawWorkLabelForBlock(block)) ?? rawWorkLabelForBlock(block)
}

function rawWorkLabelForBlock(block: WorkContextBlock): string {
  const preferred = block.aiLabel
  if (preferred && preferred.trim() && !GENERIC_LABELS.has(preferred.trim())) {
    return preferred.trim()
  }

  // The finalized label (artifact / workflow / memory / corrected) is the name
  // the work earned — "timeline-eval/run.ts", "Design critique", "Budget
  // tracker" — and is strictly better than the rule-based floor it supersedes.
  // Prefer it whenever it is a real, specific label rather than a generic
  // category floor. This is what lets earlier intent name the block instead of
  // the block reading "Development" / "Writing" / "Productivity".
  const current = block.label.current?.trim()
  if (current && !GENERIC_LABELS.has(current) && current !== 'Untitled block') {
    return current
  }

  if (block.ruleBasedLabel.trim() && !GENERIC_LABELS.has(block.ruleBasedLabel.trim())) {
    return block.ruleBasedLabel.trim()
  }

  // Subject-driven fallback: when the deterministic label is only a category
  // floor, the inferred intent subject (the document/page/issue the user was
  // actually on) names the work far better than the bare category. This is the
  // "subject should drive the label" rule — a browser-hosted productivity block
  // reads "Roadmap board", not "Productivity".
  const intentSubject = inferWorkIntent(block).subject?.trim()
  if (intentSubject && !GENERIC_LABELS.has(intentSubject)) {
    return intentSubject
  }

  // Browser site names are only an honest label when a page could own the
  // block. On a development/writing/etc. block, the open tabs are background
  // noise (the same ownership gate as the artifact path) — labeling a coding
  // block "Alueducation + Google" is the F1 leak. Only fall back to sites when
  // the block's category is page-label-compatible.
  if (isPageLabelCompatible(block)) {
    const websiteLabels = block.websites
      .map((site) => shortDomainLabel(site.domain))
      .filter((label, index, labels) => labels.indexOf(label) === index)
    if (websiteLabels.length >= 2) return `${websiteLabels[0]} + ${websiteLabels[1]}`
    if (websiteLabels.length === 1) return websiteLabels[0]
  }

  // Last resort: name the category. "Development" reads far better than
  // "Untitled block" as a floor, and it agrees with the badge.
  if (block.dominantCategory !== 'uncategorized' && block.dominantCategory !== 'system') {
    return prettyCategory(block.dominantCategory)
  }

  // timeline.md §3.5 + invariant 8: even when intent can't be derived, name from
  // the evidence we DO have — never "Computer activity", "Uncategorized", or
  // "Untitled". Build an honest title from the real apps the user was in, e.g.
  // "Cursor, Warp, and Terminal — focused work".
  return evidenceBasedFallbackLabel(block)
}

// Honest, evidence-based name for a block whose intent we can't read: the real
// apps the user was in, never a giving-up word. timeline.md §3.5 / invariant 8.
function evidenceBasedFallbackLabel(block: WorkContextBlock): string {
  const appNames = block.topApps
    .filter((app) => app.category !== 'system' && app.category !== 'uncategorized')
    .map((app) => app.appName.trim())
    .filter((name, index, names) => name.length > 0 && names.indexOf(name) === index)
    .slice(0, 3)
  if (appNames.length === 0) return 'Computer time'
  const list = appNames.length === 1
    ? appNames[0]
    : `${appNames.slice(0, -1).join(', ')} and ${appNames[appNames.length - 1]}`
  return appCategoryIsFocused(block.dominantCategory) || appNames.length >= 2
    ? `${list} — focused work`
    : list
}

export function fallbackNarrativeForBlock(block: WorkContextBlock): string {
  const label = userVisibleLabelForBlock(block)
  const duration = formatDuration(blockActiveSeconds(block))
  const evidenceSummary = deriveWorkEvidenceSummary({
    appSummaries: block.topApps.map((app) => ({
      bundleId: app.bundleId,
      appName: app.appName,
      category: app.category,
      totalSeconds: app.totalSeconds,
      isFocused: appCategoryIsFocused(app.category),
      sessionCount: app.sessionCount,
    })),
    sessions: block.sessions,
    websiteSummaries: block.websites,
  })
  const topSites = block.websites
    .slice(0, 2)
    .map((site) => shortDomainLabel(site.domain))
    .filter(Boolean)
  const topApps = block.topApps
    .filter((app) => !app.isBrowser && app.category !== 'system' && app.category !== 'uncategorized')
    .slice(0, 3)
    .map((app) => app.appName)
  const keyPage = block.keyPages.find((title) => title.trim().length > 0)
  const evidenceParts: string[] = []
  const synthesizedEvidence = evidenceSummary.evidenceText.trim()

  if (topApps.length > 0) {
    evidenceParts.push(`supporting apps included ${topApps.join(', ')}`)
  }
  if (topSites.length > 0) {
    evidenceParts.push(`top web activity was on ${topSites.join(' and ')}`)
  }
  if (keyPage) {
    evidenceParts.push(`key window: ${keyPage}`)
  }
  if (synthesizedEvidence) {
    evidenceParts.push(synthesizedEvidence)
  }

  const switchSummary = `${block.switchCount} app transition${block.switchCount === 1 ? '' : 's'}`
  if (evidenceParts.length === 0) {
    return `This block looks like ${label.toLowerCase()} for ${duration}, with ${switchSummary}.`
  }

  return `This block looks like ${label.toLowerCase()} for ${duration}. ${evidenceParts.join('. ')}. The block had ${switchSummary}.`
}

export function getTimelineDayPayload(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
  options: { materialize?: boolean; forceRebuild?: boolean } = {},
): DayTimelinePayload {
  // Today stays provisional — one neutral block
  // per continuous sitting, split only at real 15+ minute activity gaps —
  // until the USER explicitly analyzes it (a materialize request from Analyze
  // Day). We can't know the shape of the day until it is done, so Daylens
  // never splits today into named blocks on its own. A day is provisional while it
  // has no user-materialized blocks and was not processed by the nightly job;
  // crucially, NOTHING but an explicit user Analyze may materialize the live day
  // (see the guard in persistTimelineDayIfChanged), so a passive read never
  // persists today and never ends provisional mode behind the user's back.
  const isLiveProvisionalDay = dateStr === localDateString()
    && !(options.materialize ?? false)
    && validPersistedTimelineBlockCount(db, dateStr) === 0
    && !persistedDayWasProcessed(db, dateStr)
  // The live provisional day always reads the full calendar day: at 3 AM
  // mid-sitting the Today view shows everything tracked
  // since local midnight, matching the Apps view (which reads calendar bounds
  // for today). Which day finally owns a cross-midnight sitting is decided by
  // ownedDayBounds when the day is materialized, never while it is live — the
  // live boundary used to advance with every session flush, which emptied
  // today's payload down to the in-memory session and reset the tracked
  // counter on every app switch.
  const [fromMs, toMs] = isLiveProvisionalDay
    ? localDayBounds(dateStr)
    : ownedDayBounds(db, dateStr, { liveSessionStartMs: liveSession?.startTime ?? null })
  // One corrected activity-fact query feeds live and historical Timeline day
  // reads (capture migration slice 8). Canonical focus_events win when they
  // exist; legacy app_sessions remain the fallback. In canonical mode the
  // projection already contains the in-progress session (its trailing open
  // interval is clipped to now and carries the live sentinel id), so the
  // in-memory tracker session is merged only in legacy mode — merging both
  // would double-count the live stretch.
  const facts = queryCorrectedActivityFactsForRange(db, fromMs, toMs, {
    markTrailingOpenSessionLive: dateStr === localDateString(),
  })
  const sessions = withFocusApps(
    facts.evidenceSource === 'legacy'
      ? mergeLiveSession(facts.sessions, liveSession)
      : facts.sessions,
  )
  const websites = getCorrectedWebsiteSummariesForRange(db, fromMs, toMs)
  const builtBlocks = isLiveProvisionalDay
    ? buildProvisionalLiveBlocks(db, sessions)
    : buildTimelineBlocksForDay(db, dateStr, sessions, options)
  if (isLiveProvisionalDay) flagSuspiciousUnbrokenBlocks(dateStr, builtBlocks)
  // A deleted block (review state 'ignored') is gone from every surface that
  // reads this payload — timeline, recap, AI, wraps. Its span renders as the
  // empty space it now is.
  const blocks = builtBlocks.filter(isTrustedTimelineBlock)
  const focusSessions = getFocusSessionsForDateRange(db, fromMs, toMs)
  const segments = buildSegmentsForDay(db, dateStr, blocks, [fromMs, toMs])
  // What secondary displays showed while focus was elsewhere (full-screen
  // course on monitor 2 during Notion on monitor 1). Presence evidence with
  // its own honest label — deliberately NOT added to totalSeconds/blocks,
  // which stay input-focused foreground truth.
  const secondaryDisplay = getSecondaryDisplayVisibleSpansForRange(db, fromMs, toMs, sessions)
  // DEV-189: scheduled calendar events resolved against the day's own meeting
  // blocks. Matched events annotate their block as an attended meeting;
  // calendar-only events are scheduled context — an outline the renderer
  // draws, never a block, never a second of totalSeconds (the #3/#21 rule:
  // no calendar event becomes claimed work without supporting evidence).
  const scheduledMeetings = resolveScheduledMeetingsForDay(db, dateStr, blocks)
  // The durable entities this day's evidence supports naming, intersected
  // with the surviving blocks above so deleted evidence lends no entity time.
  // The wrap's "what the day was about" scene reads these; a database without
  // the entity ledger simply yields none.
  let dayEntities: DayWrapEntity[] = []
  try {
    dayEntities = entitiesForDayWrap(db, dateStr, blocks)
  } catch {
    dayEntities = []
  }
  // Invariant 7: the blocks are the canonical day facts. Every downstream
  // total (Timeline, Apps, AI, recap) reads this same partition instead of
  // independently summing raw sessions.
  const totalSeconds = blocks.reduce((sum, block) => sum + blockActiveSeconds(block), 0)
  // Focused duration can never exceed tracked duration for the same scope.
  const focusSeconds = Math.min(
    totalSeconds,
    sessions
      .filter((session) => session.isFocused)
      .reduce((sum, session) => sum + session.durationSeconds, 0),
  )

  return {
    date: dateStr,
    sessions,
    websites,
    blocks,
    segments,
    focusSessions,
    computedAt: Date.now(),
    version: TIMELINE_HEURISTIC_VERSION,
    totalSeconds,
    focusSeconds,
    focusPct: totalSeconds > 0 ? Math.round((focusSeconds / totalSeconds) * 100) : 0,
    appCount: new Set(sessions.map((session) => session.bundleId)).size,
    siteCount: websites.length,
    secondaryDisplay,
    scheduledMeetings,
    dayEntities,
  }
}

/** The day's scheduled calendar events resolved against its meeting blocks
 *  (DEV-189). Pure read of the stored calendar day signal — never collects;
 *  undefined when the day has no stored calendar signal, so payloads without
 *  a calendar source stay byte-identical to before. Captured-only meetings
 *  are not listed here: they already ARE blocks. */
function resolveScheduledMeetingsForDay(
  db: Database.Database,
  dateStr: string,
  blocks: WorkContextBlock[],
): TimelineScheduledMeeting[] | undefined {
  try {
    const calendar = getExternalSignal<CalendarSignal>(db, dateStr, 'calendar')?.payload ?? null
    const scheduled = scheduledMeetingsFromSignal(dateStr, calendar)
    if (scheduled.length === 0) return undefined
    const report = matchDayMeetings(scheduled, capturedMeetingSpansFromBlocks(blocks), {
      marks: getMeetingAttendanceMarks(db, dateStr),
      participants: scheduledParticipantsForDay(db, dateStr),
    })
    return report.meetings
      .filter((meeting) => meeting.attendance !== 'captured_only')
      .map((meeting) => ({
        title: meeting.title ?? 'Untitled event',
        startMs: meeting.scheduledStartMs!,
        endMs: meeting.scheduledEndMs!,
        attendeeCount: meeting.attendeeCount,
        participants: meeting.participants,
        attendance: meeting.attendance === 'matched' ? 'matched' as const : 'calendar_only' as const,
        marked: meeting.marked,
        matchedBlockId: meeting.matchedBlockId,
      }))
  } catch {
    // A malformed stored calendar row must never break the day read.
    return undefined
  }
}

// Day-level "Re-analyze with AI" is implemented in the IPC handler. It does
// not invalidate blocks; it refreshes only deterministic-floor / low-confidence
// labels and preserves good AI labels plus user overrides.

export function getHistoryDayPayload(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
  options: { materialize?: boolean; forceRebuild?: boolean } = {},
): HistoryDayPayload {
  return getTimelineDayPayload(db, dateStr, liveSession, options)
}

function emptyLightweightDayPayload(dateStr: string): DayTimelinePayload {
  return {
    date: dateStr,
    sessions: [],
    websites: [],
    blocks: [],
    segments: [],
    focusSessions: [],
    computedAt: Date.now(),
    version: 'empty',
    totalSeconds: 0,
    focusSeconds: 0,
    focusPct: 0,
    appCount: 0,
    siteCount: 0,
  }
}

function getLightweightDayPayload(
  db: Database.Database,
  dateStr: string,
): DayTimelinePayload | null {
  const [fromMs, toMs] = ownedDayBounds(db, dateStr)
  // Recap reads the same corrected facts as the full Timeline payload so a
  // canonical day cannot total differently in the recap strip.
  const sessions = queryCorrectedActivityFactsForRange(db, fromMs, toMs).sessions
  const websitesForDay = getCorrectedWebsiteSummariesForRange(db, fromMs, toMs)

  const rows = db.prepare(`
    SELECT
      id,
      start_time,
      end_time,
      dominant_category,
      category_distribution_json,
      switch_count,
      label_current,
      label_source,
      label_confidence,
      narrative_current,
      evidence_summary_json,
      heuristic_version,
      computed_at
    FROM timeline_blocks b
    WHERE date = ? AND invalidated_at IS NULL AND is_live = 0
      AND NOT EXISTS (
        SELECT 1 FROM timeline_block_reviews r
        WHERE r.block_id = b.id AND r.review_state = 'ignored'
      )
    ORDER BY start_time ASC
  `).all(dateStr) as Array<{
    id: string
    start_time: number
    end_time: number
    dominant_category: AppCategory
    category_distribution_json: string
    switch_count: number
    label_current: string
    label_source: string
    label_confidence: number
    narrative_current: string | null
    evidence_summary_json: string
    heuristic_version: string
    computed_at: number
  }>

  if (rows.length === 0) {
    if (sessions.length === 0) {
      return emptyLightweightDayPayload(dateStr)
    }
    return null
  }

  const blockIds = rows.map((row) => row.id)
  const workflowsByBlock = workflowRefsByBlockId(db, blockIds)
  const labelsByBlock = persistedBlockLabelsByBlockId(db, blockIds)
  const appSessionMembersByBlock = persistedBlockMembersByBlockId(db, blockIds, 'app_session')
  const focusSessionMembersByBlock = persistedBlockMembersByBlockId(db, blockIds, 'focus_session')

  const blocks: WorkContextBlock[] = []

  let totalSeconds = 0
  let focusSeconds = 0

  for (const row of rows) {
    let evidence: Partial<TimelineEvidenceSummary> = {}
    try {
      evidence = JSON.parse(row.evidence_summary_json || '{}') as Partial<TimelineEvidenceSummary>
    } catch {
      evidence = {}
    }

    const pageRefs = Array.isArray(evidence.pages) ? evidence.pages as PageRef[] : []
    const documentRefs = Array.isArray(evidence.documents) ? evidence.documents as DocumentRef[] : []
    const topArtifacts = [...pageRefs, ...documentRefs]
      .sort((left, right) => right.totalSeconds - left.totalSeconds)
      .slice(0, 6)

    const labelRows = labelsByBlock.get(row.id) ?? []

    let categoryDistribution: Partial<Record<AppCategory, number>> = {}
    try {
      categoryDistribution = JSON.parse(row.category_distribution_json)
    } catch {
      categoryDistribution = {}
    }
    const dominantCategory = dominantCategoryForBlock(categoryDistribution, topArtifacts)
    const ruleLabel = labelRows.find(r => r.source === 'rule')?.label || prettyCategory(dominantCategory)
    const aiLabel = labelRows.find(r => r.source === 'ai' || r.source === 'workflow')?.label || null
    const overrideRow = labelRows.find(r => r.source === 'user')

    const memberRows = appSessionMembersByBlock.get(row.id) ?? []

    const sessionIds = new Set(memberRows.map((r) => Number(r.member_id)))
    const blockSessions = sessions.filter((session) => sessionIds.has(session.id))

    const blockWebsites = getWebsiteSummariesForRange(db, row.start_time, row.end_time).slice(0, 5)
    const websites = blockWebsites.length > 0
      ? blockWebsites
      : (evidence.domains ?? []).map((domain) => ({
          domain,
          totalSeconds: 0,
          visitCount: 0,
          topTitle: null,
          browserBundleId: null,
        })) as WebsiteSummary[]

    const keyPagesByDomain = getTopPagesForDomains(db, row.start_time, row.end_time, websites.map((site) => site.domain), 2)
    const keyPages = websites.flatMap((site) => keyPagesByDomain[site.domain] ?? [])
      .map((page) => page.title?.trim())
      .filter((title): title is string => Boolean(title))
      .filter((title, index, titles) => titles.indexOf(title) === index)
      .slice(0, 4)

    const focusRows = focusSessionMembersByBlock.get(row.id) ?? []

    const focusSessionIds = focusRows.map((r) => Number(r.member_id))
    const focusTotalSeconds = focusRows.reduce((sum, r) => sum + r.weight_seconds, 0)
    const durationSec = Math.max(1, (row.end_time - row.start_time) / 1000)
    const focusOverlap = {
      totalSeconds: focusTotalSeconds,
      pct: Math.min(100, Math.round((focusTotalSeconds / durationSec) * 100)),
      sessionIds: focusSessionIds,
    }

    const blockActiveSec = blockSessions.length > 0
      ? blockSessions.reduce((sum, session) => sum + session.durationSeconds, 0)
      : memberRows.reduce((sum, r) => sum + r.weight_seconds, 0)
    totalSeconds += blockActiveSec
    if (FOCUSED_CATEGORIES.includes(dominantCategory)) {
      focusSeconds += blockActiveSec
    }
    const evidenceApps = Array.isArray(evidence.apps)
      ? normalizeAppSummariesForBlockDisplay(evidence.apps as WorkContextAppSummary[])
      : []
    const topApps = evidenceApps.length > 0 ? evidenceApps : topAppsFromSessions(blockSessions)

    blocks.push({
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      dominantCategory,
      categoryDistribution,
      ruleBasedLabel: ruleLabel,
      aiLabel: aiLabel,
      sessions: blockSessions,
      topApps,
      websites,
      keyPages,
      pageRefs,
      documentRefs,
      topArtifacts,
      workflowRefs: workflowsByBlock.get(row.id) ?? [],
      label: {
        current: row.label_current,
        source: row.label_source as LabelSource,
        confidence: row.label_confidence,
        narrative: row.narrative_current,
        ruleBased: ruleLabel,
        aiSuggested: aiLabel,
        override: overrideRow?.label ?? null,
      },
      focusOverlap,
      evidenceSummary: {
        apps: topApps,
        pages: pageRefs,
        documents: documentRefs,
        domains: Array.isArray(evidence.domains) ? evidence.domains as string[] : [],
        windowTitles: Array.isArray(evidence.windowTitles) ? evidence.windowTitles : [],
        sites: Array.isArray(evidence.sites) ? evidence.sites : pageRefs,
        files: Array.isArray(evidence.files) ? evidence.files : [],
      },
      heuristicVersion: row.heuristic_version,
      computedAt: row.computed_at,
      switchCount: row.switch_count,
      confidence: confidenceForCandidate({
        sessions: blockSessions,
        formation: 'mixed',
        boundedBeforeGap: false,
        boundedAfterGap: false,
      }, coherenceScore(categoryDistribution)),
      review: {
        ...DEFAULT_TIMELINE_BLOCK_REVIEW,
        state: 'pending',
      },
      isLive: false,
    })
  }

  // Derive labels through the same finalizer as the timeline so recap surfaces
  // never show the stale "<x> development" strings either (see the persisted
  // loader). Grouping stays as persisted; only the label is recomputed.
  const finalizedBlocks = blocks.map((block) => finalizedLabelForBlock(db, block, dateStr))
  blocks.length = 0
  blocks.push(...finalizedBlocks)

  const focusSessions = getFocusSessionsForDateRange(db, fromMs, toMs)
  const segments = buildSegmentsForDay(db, dateStr, blocks)
  const activeSeconds = sessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  const focusedSeconds = sessions
    .filter((session) => session.isFocused)
    .reduce((sum, session) => sum + session.durationSeconds, 0)
  const payloadTotalSeconds = activeSeconds > 0 ? activeSeconds : totalSeconds
  const payloadFocusSeconds = activeSeconds > 0 ? focusedSeconds : focusSeconds

  return {
    date: dateStr,
    sessions,
    websites: websitesForDay,
    blocks,
    segments,
    focusSessions,
    computedAt: Date.now(),
    version: TIMELINE_HEURISTIC_VERSION,
    totalSeconds: payloadTotalSeconds,
    focusSeconds: payloadFocusSeconds,
    focusPct: payloadTotalSeconds > 0 ? Math.round((payloadFocusSeconds / payloadTotalSeconds) * 100) : 0,
    appCount: new Set(sessions.map((session) => session.bundleId)).size,
    siteCount: websitesForDay.length,
  }
}

export function getRecapRange(
  db: Database.Database,
  dateStrs: string[],
): DayTimelinePayload[] {
  const todayStr = localDateString()
  return dateStrs.map((dateStr) => {
    if (dateStr >= todayStr) {
      return getTimelineDayPayload(db, dateStr)
    }
    const lightweight = getLightweightDayPayload(db, dateStr)
    if (lightweight) {
      return lightweight
    }
    return getTimelineDayPayload(db, dateStr)
  })
}

export function localDateStringForOffset(offsetDays: number): string {
  return daysFromTodayLocalDateString(offsetDays)
}

function lookupPersistedTimelineBlockDate(db: Database.Database, blockId: string): string | null {
  const row = db.prepare(`
    SELECT date
    FROM timeline_blocks
    WHERE id = ?
      AND invalidated_at IS NULL
    LIMIT 1
  `).get(blockId) as { date: string } | undefined

  return row?.date ?? null
}

export function getBlockDetailPayload(
  db: Database.Database,
  blockId: string,
  liveSession?: LiveSession | null,
): WorkContextBlock | null {
  const persistedDate = lookupPersistedTimelineBlockDate(db, blockId)
  if (persistedDate) {
    const payload = getTimelineDayPayload(db, persistedDate, liveSession, { materialize: false })
    const match = payload.blocks.find((block) => block.id === blockId)
    if (match) return match
  }

  for (let offset = 0; offset >= -30; offset--) {
    const dateStr = localDateStringForOffset(offset)
    if (dateStr === persistedDate) continue
    const payload = getTimelineDayPayload(db, dateStr, liveSession, { materialize: false })
    const match = payload.blocks.find((block) => block.id === blockId)
    if (match) return match
  }
  return null
}

export function getWorkflowSummaries(
  db: Database.Database,
  days = 14,
): WorkflowPattern[] {
  const today = localDateStringForOffset(0)
  const [todayStart] = localDayBounds(today)
  const fromMs = todayStart - Math.max(0, days - 1) * 86_400_000
  const fromDate = new Date(fromMs)
  const fromDateStr = `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, '0')}-${String(fromDate.getDate()).padStart(2, '0')}`

  const rows = db.prepare(`
    SELECT
      workflow_signatures.id,
      workflow_signatures.signature_key,
      workflow_signatures.label,
      workflow_signatures.dominant_category,
      workflow_signatures.canonical_apps_json,
      workflow_signatures.artifact_keys_json,
      COUNT(workflow_occurrences.block_id) AS occurrence_count,
      MAX(timeline_blocks.end_time) AS last_seen_at
    FROM workflow_signatures
    JOIN workflow_occurrences
      ON workflow_occurrences.workflow_id = workflow_signatures.id
    JOIN timeline_blocks
      ON timeline_blocks.id = workflow_occurrences.block_id
    WHERE workflow_occurrences.date >= ?
      AND timeline_blocks.invalidated_at IS NULL
    GROUP BY workflow_signatures.id
    ORDER BY occurrence_count DESC, last_seen_at DESC
    LIMIT 20
  `).all(fromDateStr) as Array<{
    id: string
    signature_key: string
    label: string
    dominant_category: AppCategory
    canonical_apps_json: string
    artifact_keys_json: string
    occurrence_count: number
    last_seen_at: number
  }>

  return rows.map((row) => ({
    id: row.id,
    signatureKey: row.signature_key,
    label: row.label,
    dominantCategory: row.dominant_category,
    canonicalApps: JSON.parse(row.canonical_apps_json) as string[],
    artifactKeys: JSON.parse(row.artifact_keys_json) as string[],
    occurrenceCount: row.occurrence_count,
    lastSeenAt: row.last_seen_at,
  }))
}

export function getArtifactDetails(
  db: Database.Database,
  artifactId: string,
): ArtifactRef | null {
  const row = db.prepare(`
    SELECT
      id,
      artifact_type,
      canonical_key,
      display_title,
      url,
      path,
      host,
      canonical_app_id,
      metadata_json
    FROM artifacts
    WHERE id = ?
    LIMIT 1
  `).get(artifactId) as {
    id: string
    artifact_type: ArtifactRef['artifactType']
    canonical_key: string
    display_title: string
    url: string | null
    path: string | null
    host: string | null
    canonical_app_id: string | null
    metadata_json: string
  } | undefined

  if (!row) return null
  const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>
  return {
    id: row.id,
    artifactType: row.artifact_type,
    canonicalKey: row.canonical_key,
    displayTitle: row.display_title,
    totalSeconds: 0,
    confidence: 0.5,
    canonicalAppId: row.canonical_app_id,
    ownerBundleId: typeof metadata.ownerBundleId === 'string' ? metadata.ownerBundleId : null,
    ownerAppName: typeof metadata.ownerAppName === 'string' ? metadata.ownerAppName : null,
    ownerAppInstanceId: typeof metadata.ownerAppInstanceId === 'string' ? metadata.ownerAppInstanceId : null,
    url: row.url,
    path: row.path,
    host: row.host,
    openTarget: row.url
      ? { kind: 'external_url', value: row.url }
      : row.path
        ? { kind: 'local_path', value: row.path }
        : { kind: 'unsupported', value: null },
    metadata,
  }
}

export function getDistractionCostPayload(
  db: Database.Database,
  domains: string[] = DISTRACTION_DOMAINS,
): DistractionCostPayload {
  const now = Date.now()
  const ms30d = 30 * 24 * 60 * 60 * 1000
  const ms60d = 60 * 24 * 60 * 60 * 1000
  const ms6mo = 182 * 24 * 60 * 60 * 1000

  const from30d = now - ms30d
  const from60d = now - ms60d
  const from6mo = now - ms6mo

  const daysTracked = getDaysTracked(db, from30d)
  const byDomain = getDistractionByDomain(db, domains, from30d)
  const byHour = getDistractionByHour(db, domains, from30d)
  const byMonth = getDistractionByMonth(db, domains, from6mo)

  const totalDistractionSeconds = byDomain.reduce((s, d) => s + d.totalSeconds, 0)

  const annualExtrapolatedSeconds = daysTracked > 0
    ? Math.round((totalDistractionSeconds / daysTracked) * 365)
    : 0

  const peakHour = byHour.length > 0
    ? byHour.reduce((best, h) => h.totalSeconds > best.totalSeconds ? h : best).hour
    : null

  // Trend: compare last 30 days vs previous 30 days
  const prevDomain = getDistractionByDomain(db, domains, from60d)
  const prevTotal = prevDomain.reduce((s, d) => s + d.totalSeconds, 0) - totalDistractionSeconds
  const previousPeriodSeconds = Math.max(0, prevTotal)

  let trendDirection: DistractionCostPayload['trendDirection'] = 'flat'
  if (previousPeriodSeconds > 0) {
    const changePct = (totalDistractionSeconds - previousPeriodSeconds) / previousPeriodSeconds
    if (changePct < -0.1) trendDirection = 'improving'
    else if (changePct > 0.1) trendDirection = 'worsening'
  }

  return {
    daysTracked,
    totalDistractionSeconds,
    annualExtrapolatedSeconds,
    byMonth,
    byHour,
    byDomain,
    peakHour,
    trendDirection,
    previousPeriodSeconds,
  }
}
