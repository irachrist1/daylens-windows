// Day Wrapped — the deterministic facts layer (DEV-114).
//
// ONE reconciled facts object for the whole story. The headline number, the
// "what you did" list, the day ribbon, and the standout all derive from this,
// so no two scenes can ever disagree.
// The AI narrative only ever supplies prose on top of these numbers — it never
// invents or restates one.
//
// Pure (no React) so it can be unit-tested without the carousel.

import type { AppCategory, DayTimelinePayload, DayWrapEntity, TimelineGapSegment, WorkContextBlock } from '@shared/types'
import { blockActiveSeconds } from '@shared/blockDuration'
import { effectiveBlockKind, kindForDomain, type WorkKind } from '@shared/workKind'
import { inferWorkIntent, workSubjectCandidates } from '@shared/workIntent'
import { isTrustedTimelineBlock } from '@shared/timelineReview'
import { friendlyDomain, humanizeTitle, leisureActivityTitle } from '@shared/humanize'
import { categoryForDomain } from '@shared/domainCategories'
import { cleanWorkSubject } from '@shared/workNameGuards'
import { buildDayTitleContext, type AppTitleContext } from '@shared/windowTitleContext'
import { computeQuality, looksLikeRawArtifactLabel } from './wrappedFacts'

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface WrapActivity {
  /** Human name for the WORK — never a filename, folder, repo, or tab title. */
  name: string
  seconds: number
  category: AppCategory
  kind: WorkKind
}

export interface RibbonSegment {
  name: string
  seconds: number
  category: AppCategory
  kind: WorkKind
  startMs: number
  endMs: number
}

export interface WrapStandout {
  /** Active seconds in the day's longest honest work run: sessions chained
   *  while the quiet between them stays small, broken by real detours. */
  seconds: number
  startClock: string
  endClock: string
  /** What they were heads-down on. */
  name: string
}

/** One slice of the "where the time went" chart. Apps and sites are named as
 *  they brand themselves (Cursor, YouTube) because this is the one card where the
 *  tool IS the point. Slices + "Other" sum to activeSeconds, so the chart
 *  reconciles to the headline exactly (wrapped.md §5.1.3). */
export interface AppSiteSlice {
  name: string
  seconds: number
  kind: 'app' | 'site' | 'other'
  category: AppCategory
}

export type WrapHookKind =
  | 'longestStretch' | 'peakWindow' | 'topApp' | 'count' | 'earlyBird' | 'nightOwl' | 'rangeSpan'

/** A true, computed candidate for the wildcard / lead angle. The model only ever
 *  phrases one of these; it never derives its own (wrapped.md §6). */
export interface WrapHook {
  kind: WrapHookKind
  /** The load-bearing value, already formatted ("2h 14m", "8am", "14"). */
  value: string
  /** A plain-language description of what the value means. */
  caption: string
  /** Active seconds, when the hook is a duration (for the count-up). */
  seconds?: number
}

/** One part of the day, with the human work names touched in it. The model
 *  narrates "morning was X, then Y" from this; the names are already humanized
 *  so a raw filename can never reach the prose. */
export type DayStoryPart = 'lateNight' | 'morning' | 'midday' | 'evening'

export interface DayStorySegment {
  /** The chronological bucket this beat sits in. Pre-dawn work (before 5am) is its
   *  own `lateNight` beat so an overnight leftover never gets merged into, and
   *  mislabelled as, the morning ("Late night · 12am to 12:27pm"). */
  part: DayStoryPart
  /** The honest human word for when this stretch happened, from its real start
   *  clock ("Morning", "Afternoon", "Late night"). Display + prose use this, not
   *  the coarse `part` bucket, so a 1:56am start never reads as "Morning". */
  label: string
  clockStart: string
  clockEnd: string
  seconds: number
  /** What was worked on in this part of the day, phrased as actions
   *  ("building Daylens"), most time first. The model narrates from these. */
  items: string[]
  /** A friendly leisure surface that shared this window, if one was notable. */
  aside: string | null
  /** True for a short pre-dawn beat that is the TAIL OF LAST NIGHT, not this
   *  day's start. A 27-minute sliver just after midnight must never become
   *  "your day started at midnight" or "you stayed late into the night". */
  spillover?: boolean
}

/** The day's beats in chronological order (late night → evening). Only beats that
 *  cleared the threshold appear; thin data never pads. */
export type DayStory = DayStorySegment[]

export type WrapQuality = 'empty' | 'tooEarly' | 'partial' | 'full'

// ─── Gaps are facts (day-recap-and-analysis.md) ──────────────────────────────
// Untracked time of 45 minutes or more inside the day's span is an explicit
// fact with clock bounds, cross-referenced against the calendar when the
// payload carries the day's scheduled events. The narrative layer already has
// honesty directives about untracked time; giving it the gap as a FACT lets it
// say something true ("5:14pm to 9:24pm away from the computer") instead of
// avoiding the topic — or worse, implying a continuous grind.

export type DayWrapGapKind = 'asleep' | 'locked' | 'idle' | 'passive' | 'paused' | 'untracked' | 'away'

export interface DayWrapGap {
  fromMs: number
  toMs: number
  fromClock: string
  toClock: string
  minutes: number
  /** The strongest recorded cause (from the timeline's own gap segments):
   *  asleep / locked / idle / passive / paused / untracked / away. */
  kind: DayWrapGapKind
  /** The scheduled calendar event this gap lines up with, when there is one
   *  ("Run" for a 6pm–8pm event inside a 5:14pm–9:24pm hole). Title only. */
  matchesEvent: string | null
}

// ─── Day threads (day-recap-and-analysis.md) ─────────────────────────────────
// The same subject recurring in three or more blocks across three or more
// hours is a DAY THREAD — a first-class fact ("Daylens ran through the whole
// day"), so prose can tell the day's real shape instead of twelve fragments.

export interface DayWrapThread {
  /** The human work name, from the same naming ladder the blocks use. */
  name: string
  /** How many separate blocks the subject appeared in — as the block's own
   *  name or as clean secondary evidence (a channel artifact, a workflow). */
  blockCount: number
  /** Active seconds ONLY across the blocks this subject headlined. A
   *  secondary appearance proves recurrence, never claims the block's time. */
  seconds: number
  firstMs: number
  lastMs: number
  fromClock: string
  toClock: string
  category: AppCategory
}

export interface DayWrapFacts {
  date: string
  weekday: string      // "TUESDAY"
  dateLabel: string    // "JUN 24"
  // The one split. work + leisure + personal = activeSeconds (idle excluded).
  workSeconds: number
  leisureSeconds: number
  personalSeconds: number
  /** Meetings-category work seconds — powers the calls/meetings slide. */
  meetingsSeconds: number
  /** The headline number. Equals the ribbon total and the split total. */
  activeSeconds: number
  /** Ranked human work activities (top tracks). May be empty on a rest day. */
  workActivities: WrapActivity[]
  /** Chronological merged ribbon of the whole day, morning to night. */
  ribbon: RibbonSegment[]
  ribbonStartClock: string | null
  ribbonEndClock: string | null
  /** A real, computed superlative. null when no stretch clears the bar. */
  standout: WrapStandout | null
  /** Friendly leisure surfaces, most time first ("YouTube", "Netflix"). */
  topLeisure: string[]
  isLeisureDay: boolean
  quality: WrapQuality
  /** Stable per-day seed (from the date). Drives palette / layout / which hook
   *  leads, so a day is identical on reopen but different from the day before. */
  seed: number
  /** Where the time went: app + site distribution, summing to activeSeconds. */
  appSites: AppSiteSlice[]
  /** 3 to 5 true candidate hooks; the model phrases one as the wildcard. */
  candidateHooks: WrapHook[]
  /** The single hook the seed picked to lead the wildcard card. */
  wildcardHook: WrapHook | null
  /** The day as a story: morning / midday / evening, each with real work names. */
  dayStory: DayStory
  /** When the day PROPER began: the first beat that isn't last night's
   *  spillover. Headline framing uses this, never the 12am sliver. */
  mainStartClock: string | null
  /** Per-app semantic context distilled from window titles — what the titles
   *  suggest was being done in each app ("SPCS Build Proposal CCI, 9 sessions"),
   *  never the raw strings. */
  titleContext: AppTitleContext[]
  /** The durable entities the day's evidence supports naming (projects,
   *  clients, people, meetings, repositories), biggest first. Drives the
   *  "what the day was about" scene. Empty or absent when the ledger has
   *  nothing to say — the scene simply doesn't exist then. */
  entities?: DayWrapEntity[]
  /** Untracked stretches of 45+ minutes inside the day's span, with clock
   *  bounds and (when known) the calendar event they line up with. Gaps are
   *  facts: the deck and the model say them plainly instead of going silent.
   *  Optional like `entities`: absent only on facts frozen before the field
   *  existed; the builder always sets it. */
  gaps?: DayWrapGap[]
  /** Subjects that recurred across 3+ blocks spanning 3+ hours, biggest
   *  first — the day's real through-lines ("Daylens ran through the whole
   *  day"), so interleaving can be told honestly. Optional like `entities`. */
  threads?: DayWrapThread[]
}

// ─── Tunables ────────────────────────────────────────────────────────────────
// Quality thresholds live in wrappedFacts.QUALITY_THRESHOLDS (one source).

const ACTIVITY_MIN_SECONDS = 5 * 60       // a named track has to be real
const MAX_ACTIVITIES = 4
const STANDOUT_MIN_SECONDS = 25 * 60      // a stretch worth bragging about
const SPILLOVER_MAX_SECONDS = 45 * 60     // a pre-dawn beat under this, with a real day after it, is last night's tail
const RIBBON_MIN_SEGMENT_SECONDS = 3 * 60 // fold slivers into their neighbour
const MAX_RIBBON_SEGMENTS = 7

// ─── Naming (human, never a raw artifact) ─────────────────────────────────────

function cap(s: string): string {
  const t = s.trim()
  return t ? t[0].toUpperCase() + t.slice(1) : t
}

function correctedOrCurrentLabel(block: WorkContextBlock): string {
  return (block.review?.correctedLabel?.trim() || block.label.current.trim())
}

// Tool brands, terminal commands, and joined tab titles are never work
// subjects — the shared guard is the one vocabulary (workNameGuards.ts),
// used identically by the frozen snapshots that feed period wraps.

/** The human name for a WORK block: a corrected intent subject wins over
 *  inference, then the inferred subject if it reads clean, else a humanized
 *  (corrected-or-current) label, else "" meaning "fold into a few smaller
 *  things". Every candidate goes through the shared sanitize-then-check gate
 *  (cleanWorkSubject), so capture decorations — "✳ Debug Daylens…" from a
 *  Claude Code window title — are stripped before the guard runs and a raw
 *  glyph can never lead a floor line. */
function workActivityName(block: WorkContextBlock): string {
  const candidates = [
    block.review?.correctedIntentSubject,
    inferWorkIntent(block).subject,
    humanizeTitle(correctedOrCurrentLabel(block)),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const cleaned = cleanWorkSubject(candidate)
    if (cleaned && !looksLikeRawArtifactLabel(cleaned)) return cap(cleaned)
  }
  return ''
}

/** The human name for any block, for the ribbon. Leisure/personal read by the
 *  activity ("Watching YouTube"), never a work intent. */
function blockDisplayName(block: WorkContextBlock, kind: WorkKind): string {
  if (kind === 'work') {
    const name = workActivityName(block)
    return name || categoryWord(block.dominantCategory)
  }
  if (kind === 'leisure') {
    // Name the leisure by its leisure domains only — a work tab open inside a
    // leisure block (Slack, a CI dashboard) must never appear as "watching".
    const domains = block.websites
      .slice()
      .sort((a, b) => b.totalSeconds - a.totalSeconds)
      .filter((w) => kindForDomain(w.domain) === 'leisure')
      .map((w) => w.domain)
    return leisureActivityTitle(domains)
  }
  if (kind === 'personal') return 'Personal'
  return 'Idle'
}

/** Human category words — never the banned set (Browsing / Development / AI
 *  tools / Productivity), never a tool brand. */
export function categoryWord(category: AppCategory): string {
  switch (category) {
    case 'development': return 'Coding'
    case 'aiTools': return 'Coding'
    case 'writing': return 'Writing'
    case 'design': return 'Design'
    case 'research': return 'Research'
    case 'meetings': return 'Meetings'
    case 'communication': return 'Messages'
    case 'email': return 'Email'
    case 'productivity': return 'Admin'
    // Observational: browser foreground time proves the page was open, not read.
    case 'browsing': return 'On the web'
    case 'entertainment': return 'Watching'
    case 'social': return 'Social'
    default: return 'Work'
  }
}

/** The verb for a kind of work, so it reads as an action the user did, never as
 *  a place they were "on". "building Daylens", "writing the essay". */
export function categoryAction(category: AppCategory): string {
  switch (category) {
    case 'development': return 'building'
    case 'aiTools': return 'building'
    case 'writing': return 'writing'
    case 'design': return 'designing'
    case 'research': return 'digging into'
    // Foreground time on a page proves the page was open, not that it was
    // read — "looking into" claims attention, never comprehension.
    case 'browsing': return 'looking into'
    case 'meetings': return 'meeting on'
    case 'communication': return 'talking through'
    case 'email': return 'working through'
    case 'productivity': return 'sorting out'
    default: return 'working on'
  }
}

/** Imperative verbs a captured task title leads with ("Debug Daylens
 *  freezing…", "Fix the sync race"). The title already IS the action, so the
 *  lead verb becomes its gerund instead of getting a second verb stacked in
 *  front ("building Debug Daylens freezing…"). */
const IMPERATIVE_GERUNDS: Record<string, string> = {
  add: 'adding', build: 'building', clean: 'cleaning', create: 'creating',
  debug: 'debugging', design: 'designing', draft: 'drafting', edit: 'editing',
  explore: 'exploring', fix: 'fixing', implement: 'implementing',
  improve: 'improving', investigate: 'investigating', plan: 'planning',
  prepare: 'preparing', refactor: 'refactoring', remove: 'removing',
  review: 'reviewing', rewrite: 'rewriting', set: 'setting', ship: 'shipping',
  test: 'testing', update: 'updating', write: 'writing',
}

/** A subject that already names the work AS work ("OAuth development",
 *  "site maintenance") is a complete noun phrase; prepending the category
 *  verb produced "writing Oauth development". */
const WORK_NOUN_TAIL = /\b(development|design|research|planning|writing|review|reviews|testing|debugging|documentation|maintenance|cleanup|analysis|setup|prep|admin|work)$/i

/** A human work phrase: the action plus the subject ("building Daylens"). Used in
 *  prose and the facts handed to the model, never the bare project noun. A name
 *  that already leads with a gerund ("Redesigning the SPCS website") IS the
 *  action — prepending the category verb produced "building Reviewing work
 *  projects", so those pass through with only the case lowered. The same goes
 *  for names that lead with an imperative verb or end in a work noun: the
 *  category verb is only for bare subjects ("Daylens", "the essay"). */
export function workActionPhrase(name: string, category: AppCategory): string {
  const trimmed = name.trim()
  const firstWord = trimmed.split(/\s+/)[0] ?? ''
  const passThrough = (value: string) =>
    /^[A-Z]{2,}/.test(value) ? value : value.charAt(0).toLowerCase() + value.slice(1)
  if (/^[A-Za-z]+ing$/.test(firstWord) && firstWord.length > 4) {
    return passThrough(trimmed)
  }
  const gerund = IMPERATIVE_GERUNDS[firstWord.toLowerCase()]
  if (gerund) {
    const rest = trimmed.slice(firstWord.length).trim()
    return rest ? `${gerund} ${rest}` : gerund
  }
  if (WORK_NOUN_TAIL.test(trimmed)) {
    return passThrough(trimmed)
  }
  return `${categoryAction(category)} ${trimmed}`
}

// ─── Gap facts ────────────────────────────────────────────────────────────────

const GAP_FACT_MIN_MS = 45 * 60_000
// A calendar event explains a gap only when the gap really held it: at least
// half an hour of overlap, covering most of the event's scheduled length.
const GAP_EVENT_MIN_OVERLAP_MS = 30 * 60_000
const GAP_EVENT_MIN_COVERAGE = 0.6

function gapKindFor(kind: TimelineGapSegment['kind']): DayWrapGapKind {
  switch (kind) {
    case 'asleep': return 'asleep'
    case 'machine_off': return 'asleep'
    case 'locked': return 'locked'
    case 'idle': return 'idle'
    case 'idle_gap': return 'idle'
    case 'passive': return 'passive'
    case 'paused': return 'paused'
    case 'away': return 'away'
    default: return 'untracked'
  }
}

/** The plain-words read of a gap kind — what a person would say, never the
 *  internal state name. Exported so the deck and the model-facing facts speak
 *  the identical dialect. */
export function gapKindPhrase(kind: DayWrapGapKind): string {
  switch (kind) {
    case 'passive': return 'screen on, hands off the keyboard'
    case 'paused': return 'tracking was paused'
    default: return 'away from the computer'
  }
}

function buildGapFacts(payload: DayTimelinePayload): DayWrapGap[] {
  const events = payload.scheduledMeetings ?? []
  return (payload.segments ?? [])
    .filter((segment): segment is TimelineGapSegment => segment.kind !== 'work_block')
    .filter((segment) => segment.endTime - segment.startTime >= GAP_FACT_MIN_MS)
    .sort((left, right) => left.startTime - right.startTime)
    .map((segment) => {
      let matchesEvent: string | null = null
      let bestOverlap = 0
      for (const event of events) {
        const title = event.title?.trim()
        if (!title) continue
        const overlap = Math.min(segment.endTime, event.endMs) - Math.max(segment.startTime, event.startMs)
        const eventLen = Math.max(1, event.endMs - event.startMs)
        if (overlap >= GAP_EVENT_MIN_OVERLAP_MS && overlap >= eventLen * GAP_EVENT_MIN_COVERAGE && overlap > bestOverlap) {
          bestOverlap = overlap
          matchesEvent = title
        }
      }
      return {
        fromMs: segment.startTime,
        toMs: segment.endTime,
        fromClock: formatClock(segment.startTime),
        toClock: formatClock(segment.endTime),
        minutes: Math.round((segment.endTime - segment.startTime) / 60_000),
        kind: gapKindFor(segment.kind),
        matchesEvent,
      }
    })
}

// ─── Day threads ──────────────────────────────────────────────────────────────

const THREAD_MIN_BLOCKS = 3
const THREAD_MIN_SPAN_MS = 3 * 3_600_000
const MAX_THREADS = 3

function buildDayThreads(blocks: WorkContextBlock[]): DayWrapThread[] {
  interface Accumulator { name: string; blockCount: number; seconds: number; firstMs: number; lastMs: number; category: AppCategory; headlined: boolean }
  const byName = new Map<string, Accumulator>()
  for (const block of blocks) {
    if (effectiveBlockKind(block) !== 'work') continue
    // The block's own name comes from the same ladder every surface uses:
    // corrected subject → inferred intent subject → humanized label, through
    // the shared sanitize-then-guard gate. Membership additionally counts the
    // block's clean SECONDARY subjects (workSubjectCandidates: channel
    // artifacts, workflows) — the daylens Slack channel inside an ML-study
    // block proves daylens ran through the morning, without claiming its time.
    const primary = workActivityName(block)
    const names = new Map<string, string>()
    if (primary) names.set(primary.toLowerCase(), primary)
    for (const candidate of workSubjectCandidates(block)) {
      const cleaned = cleanWorkSubject(candidate)
      if (!cleaned || looksLikeRawArtifactLabel(cleaned)) continue
      const display = cap(cleaned)
      if (!names.has(display.toLowerCase())) names.set(display.toLowerCase(), display)
    }
    const seconds = blockActiveSeconds(block)
    for (const [key, display] of names) {
      const isPrimary = primary !== '' && key === primary.toLowerCase()
      const existing = byName.get(key)
      if (existing) {
        existing.blockCount += 1
        if (isPrimary) {
          existing.seconds += seconds
          existing.headlined = true
          existing.category = block.dominantCategory
        }
        existing.firstMs = Math.min(existing.firstMs, block.startTime)
        existing.lastMs = Math.max(existing.lastMs, block.endTime)
      } else {
        byName.set(key, {
          name: display,
          blockCount: 1,
          seconds: isPrimary ? seconds : 0,
          firstMs: block.startTime,
          lastMs: block.endTime,
          category: block.dominantCategory,
          headlined: isPrimary,
        })
      }
    }
  }
  return [...byName.values()]
    .filter((acc) => acc.blockCount >= THREAD_MIN_BLOCKS && acc.lastMs - acc.firstMs >= THREAD_MIN_SPAN_MS)
    .sort((left, right) => right.blockCount - left.blockCount || right.seconds - left.seconds)
    .slice(0, MAX_THREADS)
    .map((acc) => ({
      name: acc.name,
      blockCount: acc.blockCount,
      seconds: acc.seconds,
      firstMs: acc.firstMs,
      lastMs: acc.lastMs,
      fromClock: formatClock(acc.firstMs),
      toClock: formatClock(acc.lastMs),
      category: acc.category,
    }))
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export function buildDayWrapFacts(payload: DayTimelinePayload): DayWrapFacts {
  const [y, m, d] = payload.date.split('-').map(Number)
  const dateObj = new Date(y, m - 1, d)
  const weekday = dateObj.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()

  const blocks = payload.blocks
    .filter(isTrustedTimelineBlock)
    .filter((b) => b.dominantCategory !== 'system' && b.dominantCategory !== 'uncategorized')
    .slice()
    .sort((a, b) => a.startTime - b.startTime)

  // One reconciled kind split.
  let workSeconds = 0, leisureSeconds = 0, personalSeconds = 0
  let meetingsSeconds = 0
  const leisureByName = new Map<string, number>()
  for (const block of blocks) {
    const kind = effectiveBlockKind(block)
    const seconds = blockActiveSeconds(block)
    // Meeting truth is the block's SPAN, not its active seconds: sitting in a
    // 73-minute call with hands off the keyboard is 73 minutes of meeting.
    // Active seconds undercounted the Jul 7 11:15-12:28 class as 49m across
    // the deck while its own timeline card read 1h 13m.
    if (kind === 'work' && (block.dominantCategory === 'meetings')) {
      meetingsSeconds += Math.max(seconds, Math.round((block.endTime - block.startTime) / 1000))
    }
    if (kind === 'work') workSeconds += seconds
    else if (kind === 'leisure') {
      leisureSeconds += seconds
      for (const site of block.websites) {
        if (kindForDomain(site.domain) !== 'leisure') continue
        const name = friendlyDomain(site.domain)
        if (name) leisureByName.set(name, (leisureByName.get(name) ?? 0) + site.totalSeconds)
      }
    } else if (kind === 'personal') personalSeconds += seconds
  }
  const activeSeconds = workSeconds + leisureSeconds + personalSeconds

  // Ranked work activities — merge by name, drop the unnameable.
  const byName = new Map<string, WrapActivity>()
  for (const block of blocks) {
    if (effectiveBlockKind(block) !== 'work') continue
    const name = workActivityName(block)
    if (!name) continue
    const key = name.toLowerCase()
    const seconds = blockActiveSeconds(block)
    const existing = byName.get(key)
    if (existing) existing.seconds += seconds
    else byName.set(key, { name, seconds, category: block.dominantCategory, kind: 'work' })
  }
  const workActivities = [...byName.values()]
    .filter((a) => a.seconds >= ACTIVITY_MIN_SECONDS)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, MAX_ACTIVITIES)

  // The day ribbon — chronological, merged, slivers folded.
  const ribbon = buildRibbon(blocks)
  const ribbonStartClock = ribbon.length > 0 ? formatClock(ribbon[0].startMs) : null
  const ribbonEndClock = ribbon.length > 0 ? formatClock(ribbon[ribbon.length - 1].endMs) : null

  // The standout — the day's longest honest WORK run.
  const standout = selectStandout(blocks)

  const topLeisure = [...leisureByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name)

  const tracked = workSeconds + leisureSeconds + personalSeconds
  const isLeisureDay = tracked > 0 && leisureSeconds >= workSeconds && leisureSeconds / tracked >= 0.5

  const seed = seedFromDate(payload.date)
  const appSites = buildAppSiteDistribution(blocks, activeSeconds)
  const dayStartMs = dateObj.getTime()
  const dayStory = buildDayStory(blocks, dayStartMs)
  const mainStartClock = dayStory.find((s) => !s.spillover)?.clockStart ?? ribbonStartClock
  const candidateHooks = buildCandidateHooks(blocks, standout, workActivities, appSites, dayStartMs)
  const titleContext = buildDayTitleContext(blocks.flatMap((block) => block.sessions))
  const wildcardHook = candidateHooks.length > 0
    ? candidateHooks[seed % candidateHooks.length]
    : null

  return {
    date: payload.date,
    weekday,
    dateLabel,
    workSeconds,
    leisureSeconds,
    personalSeconds,
    meetingsSeconds,
    activeSeconds,
    workActivities,
    ribbon,
    ribbonStartClock,
    ribbonEndClock,
    standout,
    topLeisure,
    isLeisureDay,
    quality: computeQuality(activeSeconds),
    seed,
    appSites,
    candidateHooks,
    wildcardHook,
    dayStory,
    mainStartClock,
    titleContext,
    entities: payload.dayEntities ?? [],
    gaps: buildGapFacts(payload),
    threads: buildDayThreads(blocks),
  }
}

// ─── Seed (stable per day, different day to day) ──────────────────────────────

/** A small deterministic integer from the date string. Same day → same seed
 *  (the wrap is identical on reopen); adjacent days differ (the look changes). */
export function seedFromDate(date: string): number {
  let h = 2166136261
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

// ─── Where the time went: app + site distribution ────────────────────────────

const MAX_APP_SITE_SLICES = 6

/** App and website distribution across the day, summed from block evidence and
 *  reconciled to activeSeconds by folding the remainder into "Other". */
function buildAppSiteDistribution(blocks: WorkContextBlock[], activeSeconds: number): AppSiteSlice[] {
  const byName = new Map<string, AppSiteSlice>()
  for (const block of blocks) {
    const kind = effectiveBlockKind(block)
    if (kind === 'idle') continue
    // Browsers contribute their sites, not the browser shell; everything else
    // contributes the app. This is what makes the chart read as real surfaces.
    const browserSeconds = block.topApps
      .filter((a) => a.isBrowser)
      .reduce((s, a) => s + Math.max(0, a.totalSeconds), 0)
    for (const app of block.topApps) {
      if (app.category === 'system' || app.isBrowser) continue
      const key = `app:${app.appName.toLowerCase()}`
      const existing = byName.get(key)
      const seconds = Math.max(0, app.totalSeconds)
      if (existing) existing.seconds += seconds
      else byName.set(key, { name: app.appName, seconds, kind: 'app', category: app.category })
    }
    if (browserSeconds > 0) {
      const sites = block.websites.slice().sort((a, b) => b.totalSeconds - a.totalSeconds)
      const siteTotal = sites.reduce((s, w) => s + Math.max(0, w.totalSeconds), 0) || 1
      for (const site of sites) {
        const name = friendlyDomain(site.domain)
        if (!name) continue
        // Scale site seconds into the browser's share of this block so sites and
        // apps live on one comparable axis.
        const seconds = Math.round((Math.max(0, site.totalSeconds) / siteTotal) * browserSeconds)
        if (seconds <= 0) continue
        const key = `site:${name.toLowerCase()}`
        const existing = byName.get(key)
        // A site's category is its OWN (youtube.com is entertainment), never
        // the block's dominant one — the block-inherited category told the
        // narrator YouTube was "browsing" and Canva "communication".
        const category = categoryForDomain(site.domain) ?? block.dominantCategory
        if (existing) existing.seconds += seconds
        else byName.set(key, { name, seconds, kind: 'site', category })
      }
    }
  }

  const ranked = [...byName.values()].filter((s) => s.seconds > 0).sort((a, b) => b.seconds - a.seconds)
  const top = ranked.slice(0, MAX_APP_SITE_SLICES)
  const accounted = top.reduce((s, slice) => s + slice.seconds, 0)
  const remainder = Math.max(0, activeSeconds - accounted)
  // Fold everything unaccounted (untracked gaps, tiny apps, rounding) into one
  // honest "Other" slice so the chart sums to the headline exactly.
  if (remainder >= 60) top.push({ name: 'Other', seconds: remainder, kind: 'other', category: 'uncategorized' })
  return top
}

// ─── The day as a story (morning / midday / evening) ─────────────────────────

/** The chronological bucket a stretch belongs to, from its real start hour.
 *  Pre-dawn (before 5am) is its own `lateNight` bucket, kept separate from the
 *  morning so an overnight leftover is never merged with, or mislabelled as, the
 *  late-morning work that follows it. */
function partOfDay(ms: number): DayStoryPart {
  const hour = new Date(ms).getHours()
  if (hour < 5) return 'lateNight'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'midday'
  return 'evening'
}

/** The honest human word for a beat, from its bucket. Aligned with `partOfDay`,
 *  so a 1:56am start reads "Late night" and never "Morning". */
function partLabel(part: DayStoryPart): string {
  switch (part) {
    case 'lateNight': return 'Late night'
    case 'morning': return 'Morning'
    case 'midday': return 'Afternoon'
    case 'evening': return 'Evening'
  }
}

const STORY_PARTS: readonly DayStoryPart[] = ['lateNight', 'morning', 'midday', 'evening']

/** Bucket bounds in hours from local midnight. Evening runs past 24 so the
 *  post-midnight tail of a block this day OWNS stays this day's evening. */
const PART_BOUNDS: Record<DayStoryPart, [number, number]> = {
  lateNight: [0, 5], morning: [5, 12], midday: [12, 17], evening: [17, 36],
}

interface PartAllocation {
  part: DayStoryPart
  startMs: number
  endMs: number
  seconds: number
}

/** Split one block's active seconds across the parts of the day its SPAN
 *  actually covers, proportional to span overlap. Before this, a block was
 *  assigned wholly to the bucket of its start time, so a real 11:25am-midnight
 *  work block became "Morning · 11:25am to 12am" — nine hours of afternoon and
 *  evening narrated as morning. */
function allocateBlockAcrossParts(block: WorkContextBlock, dayStartMs: number): PartAllocation[] {
  const active = blockActiveSeconds(block)
  const spanStart = Math.max(block.startTime, dayStartMs)
  const spanEnd = Math.max(block.endTime, spanStart)
  const spanMs = Math.max(1, spanEnd - spanStart)
  const out: PartAllocation[] = []
  for (const part of STORY_PARTS) {
    const [h0, h1] = PART_BOUNDS[part]
    const from = Math.max(spanStart, dayStartMs + h0 * 3_600_000)
    const to = Math.min(spanEnd, dayStartMs + h1 * 3_600_000)
    if (to - from < 60_000) continue
    out.push({ part, startMs: from, endMs: to, seconds: Math.round(active * ((to - from) / spanMs)) })
  }
  if (out.length === 0) {
    out.push({ part: partOfDay(block.startTime), startMs: block.startTime, endMs: block.endTime, seconds: active })
  }
  return out
}

function buildDayStory(blocks: WorkContextBlock[], dayStartMs: number): DayStory {
  interface Placed extends PartAllocation { block: WorkContextBlock }
  const byPart: Record<DayStoryPart, Placed[]> = { lateNight: [], morning: [], midday: [], evening: [] }
  const dominantPart = new Map<WorkContextBlock, DayStoryPart>()
  for (const block of blocks) {
    if (effectiveBlockKind(block) === 'idle') continue
    const allocations = allocateBlockAcrossParts(block, dayStartMs)
    let best = allocations[0]
    for (const alloc of allocations) {
      byPart[alloc.part].push({ block, ...alloc })
      if (alloc.seconds > best.seconds) best = alloc
    }
    dominantPart.set(block, best.part)
  }
  const seg = (part: DayStoryPart): DayStorySegment | null => {
    const list = byPart[part].slice().sort((a, b) => a.startMs - b.startMs)
    if (list.length === 0) return null
    const seconds = list.reduce((s, a) => s + a.seconds, 0)
    if (seconds < 5 * 60) return null
    // Keyed by the work name so the same activity merges, but we carry the action
    // phrase ("building Daylens") so the prose never frames the work as a place.
    const byName = new Map<string, { phrase: string; seconds: number }>()
    let asideName: string | null = null
    let asideSeconds = 0
    for (const placed of list) {
      const kind = effectiveBlockKind(placed.block)
      // A block names this part of the day when the part holds a real share of
      // it: its dominant part, or at least 15 minutes here. A sliver never names.
      const credits = dominantPart.get(placed.block) === part || placed.seconds >= 15 * 60
      if (kind === 'work' && credits) {
        const name = workActivityName(placed.block)
        if (name) {
          const key = name.toLowerCase()
          const existing = byName.get(key)
          if (existing) existing.seconds += placed.seconds
          else byName.set(key, { phrase: workActionPhrase(name, placed.block.dominantCategory), seconds: placed.seconds })
        }
      } else if (kind === 'leisure' && credits) {
        const domains = placed.block.websites.slice().sort((a, b) => b.totalSeconds - a.totalSeconds)
          .filter((w) => kindForDomain(w.domain) === 'leisure')
          .map((w) => w.domain)
        const friendly = leisureActivityTitle(domains)
        if (placed.seconds > asideSeconds) { asideSeconds = placed.seconds; asideName = friendly }
      }
    }
    const items = [...byName.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 3).map((v) => v.phrase)
    return {
      part,
      label: partLabel(part),
      clockStart: formatClock(list[0].startMs),
      clockEnd: formatClock(Math.max(...list.map((a) => a.endMs))),
      seconds,
      items,
      aside: asideName,
    }
  }
  const story = STORY_PARTS.map(seg).filter((s): s is DayStorySegment => s !== null)
  // A short late-night beat followed by a real day is last night's tail, not
  // this day's start. Mark it so no consumer frames the day as "began at 12am".
  const first = story[0]
  if (first && first.part === 'lateNight' && story.length > 1 && first.seconds < SPILLOVER_MAX_SECONDS) {
    first.spillover = true
    first.label = "Last night's tail"
  }
  return story
}

// ─── Candidate hooks (true, computed; the model phrases one) ──────────────────

function buildCandidateHooks(
  blocks: WorkContextBlock[],
  standout: WrapStandout | null,
  workActivities: WrapActivity[],
  appSites: AppSiteSlice[],
  dayStartMs: number,
): WrapHook[] {
  const hooks: WrapHook[] = []

  if (standout) {
    hooks.push({
      kind: 'longestStretch',
      value: formatHm(standout.seconds),
      caption: `your longest stretch, on ${lowerName(standout.name)}`,
      seconds: standout.seconds,
    })
  }

  // Peak window: which part of the day held the most work. Same proportional
  // allocation as the story, so a bucket-spanning block credits every part it
  // actually covered.
  const windows: Record<DayStoryPart, number> = { lateNight: 0, morning: 0, midday: 0, evening: 0 }
  for (const block of blocks) {
    if (effectiveBlockKind(block) !== 'work') continue
    for (const alloc of allocateBlockAcrossParts(block, dayStartMs)) {
      windows[alloc.part] += alloc.seconds
    }
  }
  const peak = (Object.entries(windows) as Array<[DayStoryPart, number]>)
    .sort((a, b) => b[1] - a[1])[0]
  if (peak && peak[1] >= 30 * 60) {
    const word = peak[0] === 'morning' ? 'the morning' : peak[0] === 'midday' ? 'the afternoon' : peak[0] === 'evening' ? 'the evening' : 'the late night'
    // "held the most work", never "best stretch": this value is the SUM of work
    // across a part of day, not one unbroken block, so it must not be phrased as
    // a continuous stretch (that word belongs to the longestStretch hook only).
    hooks.push({ kind: 'peakWindow', value: formatHm(peak[1]), caption: `${word} held the most of your work`, seconds: peak[1] })
    if (peak[0] === 'morning' && windows.morning >= windows.midday + windows.evening) {
      hooks.push({ kind: 'earlyBird', value: formatHm(windows.morning), caption: 'most of the work landed before noon' })
    }
    if (peak[0] === 'evening' && windows.evening >= 60 * 60) {
      hooks.push({ kind: 'nightOwl', value: formatHm(windows.evening), caption: 'the evening did the heavy lifting' })
    }
  }

  // A count: the most-returned-to surface across the day.
  const topApp = appSites.find((s) => s.kind !== 'other')
  if (topApp) {
    const blockCount = blocks.filter((b) => b.topApps.some((a) => a.appName.toLowerCase() === topApp.name.toLowerCase())).length
    if (blockCount >= 3) {
      hooks.push({ kind: 'count', value: String(blockCount), caption: `separate times you came back to ${topApp.name}` })
    }
  }

  // A juxtaposition: the top two activities, side by side.
  if (workActivities.length >= 2) {
    hooks.push({
      kind: 'topApp',
      value: formatHm(workActivities[0].seconds),
      caption: `on ${lowerName(workActivities[0].name)}, more than anything else`,
      seconds: workActivities[0].seconds,
    })
  }

  return hooks.slice(0, 5)
}

/** Lowercase a name for mid-sentence use, unless it starts with an acronym. */
export function lowerName(s: string): string {
  return /^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1)
}

function buildRibbon(blocks: WorkContextBlock[]): RibbonSegment[] {
  const raw: RibbonSegment[] = []
  for (const block of blocks) {
    const kind = effectiveBlockKind(block)
    if (kind === 'idle') continue
    const seconds = blockActiveSeconds(block)
    if (seconds <= 0) continue
    raw.push({
      name: blockDisplayName(block, kind),
      seconds,
      category: block.dominantCategory,
      kind,
      startMs: block.startTime,
      endMs: block.endTime,
    })
  }
  if (raw.length === 0) return []

  // Merge consecutive segments that read as the same activity.
  const merged: RibbonSegment[] = []
  for (const seg of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.name === seg.name && prev.kind === seg.kind) {
      prev.seconds += seg.seconds
      prev.endMs = seg.endMs
    } else {
      merged.push({ ...seg })
    }
  }

  // Fold slivers into the larger neighbour so the ribbon stays legible.
  let folded = merged
  while (folded.length > MAX_RIBBON_SEGMENTS || folded.some((s) => s.seconds < RIBBON_MIN_SEGMENT_SECONDS && folded.length > 1)) {
    const idx = smallestSegmentIndex(folded)
    if (folded.length <= 1) break
    const seg = folded[idx]
    const left = folded[idx - 1]
    const right = folded[idx + 1]
    const into = !left ? right : !right ? left : (left.seconds >= right.seconds ? left : right)
    into.seconds += seg.seconds
    into.startMs = Math.min(into.startMs, seg.startMs)
    into.endMs = Math.max(into.endMs, seg.endMs)
    folded = folded.filter((_, i) => i !== idx)
    if (folded.length <= MAX_RIBBON_SEGMENTS && folded.every((s) => s.seconds >= RIBBON_MIN_SEGMENT_SECONDS)) break
  }
  return folded
}

function smallestSegmentIndex(segments: RibbonSegment[]): number {
  let idx = 0
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].seconds < segments[idx].seconds) idx = i
  }
  return idx
}

// A run tolerates this much quiet between sessions (a stretch, a refill) and
// this much of a leisure detour before it honestly stops being one stretch.
const STANDOUT_MAX_IDLE_MS = 12 * 60_000
const STANDOUT_DETOUR_BREAK_SECONDS = 5 * 60

/** The longest honest run of sessions inside one block: chained while the
 *  quiet between sessions stays under STANDOUT_MAX_IDLE_MS, broken by any
 *  leisure session long enough to be a real detour. Regrouping deliberately
 *  merges one activity across peeks and even lunch-sized holes, so the BLOCK's
 *  own span routinely overstates continuity — a 6h block with 1h of active
 *  time must never be narrated as a 6h stretch. Leisure peeks shorter than the
 *  detour threshold neither break the run nor count toward its seconds. */
function longestSessionRun(block: WorkContextBlock): { seconds: number; startMs: number; endMs: number } | null {
  const sessions = [...block.sessions]
    .filter((s) => s.durationSeconds > 0)
    .sort((a, b) => a.startTime - b.startTime)
  if (sessions.length === 0) {
    // No session evidence: the block's own bounds may claim the run ONLY when
    // its active time actually fills that span. A 6.4h-span block with 1.1h of
    // active time is not a stretch, and with no sessions to chain the honest
    // move is silence.
    const spanSeconds = Math.max(1, Math.round((block.endTime - block.startTime) / 1000))
    const activeSeconds = blockActiveSeconds(block)
    if (activeSeconds < spanSeconds * 0.8) return null
    return { seconds: activeSeconds, startMs: block.startTime, endMs: block.endTime }
  }
  let best: { seconds: number; startMs: number; endMs: number } | null = null
  let run: { seconds: number; startMs: number; endMs: number } | null = null
  const close = () => {
    if (run && (!best || run.seconds > best.seconds)) best = run
    run = null
  }
  for (const session of sessions) {
    const sessionEnd = session.endTime ?? session.startTime + session.durationSeconds * 1000
    const leisure = session.category === 'entertainment' || session.category === 'social'
    if (leisure && session.durationSeconds >= STANDOUT_DETOUR_BREAK_SECONDS) {
      close()
      continue
    }
    if (run && session.startTime - run.endMs > STANDOUT_MAX_IDLE_MS) close()
    if (!run) {
      if (leisure) continue
      run = { seconds: session.durationSeconds, startMs: session.startTime, endMs: sessionEnd }
      continue
    }
    run.endMs = Math.max(run.endMs, sessionEnd)
    if (!leisure) run.seconds += session.durationSeconds
  }
  close()
  return best
}

function selectStandout(blocks: WorkContextBlock[]): WrapStandout | null {
  let best: { seconds: number; startMs: number; endMs: number; name: string } | null = null
  for (const block of blocks) {
    if (effectiveBlockKind(block) !== 'work') continue
    // Stored blocks that carry no sessions get no standout claim at all: with
    // no session evidence the run's true shape is unknowable, and the honest
    // move is silence, not the block's wall-clock span.
    const run = longestSessionRun(block)
    if (!run || run.seconds < STANDOUT_MIN_SECONDS) continue
    const name = workActivityName(block) || categoryWord(block.dominantCategory)
    if (!best || run.seconds > best.seconds) best = { ...run, name }
  }
  if (!best) return null
  return {
    seconds: best.seconds,
    startClock: formatClock(best.startMs),
    endClock: formatClock(best.endMs),
    name: best.name,
  }
}

/** "11:15am" / "8pm" — THE clock format for every wrap surface. Exported so
 *  preflight and the coverage card speak the identical dialect. */
export function formatClock(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(' ', '')
    .toLowerCase()
}

// ─── Duration phrasing ─────────────────────────────────────────────────────────

/** "3h 51m", "52m". Exact so the cards always agree with the totals. */
export function formatHm(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  if (total < 60) return `${Math.max(0, total)}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}
