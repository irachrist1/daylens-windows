import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProductionTestDatabase } from '../support/testDatabase.ts'
import {
  isKnownIssueDefect,
  isNormalizedEvidenceDayFixture,
  loadDayFixtures,
  type ExpectedDayEpisode,
  type NormalizedEvidenceDayFixture,
} from '../support/dayFixture.ts'
import {
  getTimelineDayPayload,
  invalidateTimelineDayBlocks,
  userVisibleLabelForBlock,
  writeTimelineBlockReview,
} from '../../src/main/services/workBlocks.ts'
import { getCorrectedAppSummariesForRange } from '../../src/main/services/activityFacts.ts'
import { getExternalSignal, putExternalSignal } from '../../src/main/services/externalSignals.ts'
import { searchAll } from '../../src/main/db/queries.ts'
import { resolveDayEnrichment } from '../../src/main/services/enrichmentResolve.ts'
import { chatMemoryPromptBlock } from '../../src/main/services/workMemoryProfile.ts'
import { buildDaylensTools } from '../../src/main/agent/daylensTools.ts'
import { executeTool } from '../../src/main/services/aiTools.ts'
import { findDatabaseTextMatches } from '../support/dayFixturePrivacy.ts'
import { buildFallbackNarrative, computeFactsHash } from '../../src/main/lib/wrappedNarrative.ts'
import {
  buildDayWrapFacts,
  categoryWord,
  type DayWrapFacts,
} from '../../src/renderer/lib/dayWrapScenes.ts'
import { planDayWrapSlides, resolveSlideLine } from '../../src/renderer/lib/wrapDeck.ts'
import { humanizeTitle } from '../../src/shared/humanize.ts'
import {
  evaluateLabelVoice,
  labelVoiceContextForBlock,
  rawLabelForm,
  summarizeLabelVoice,
  type LabelVoiceSummary,
} from '../../src/shared/labelVoice.ts'
import { inferWorkIntent } from '../../src/shared/workIntent.ts'
import { effectiveBlockKind, type WorkKind } from '../../src/shared/workKind.ts'
import { blockActiveSeconds } from '../../src/shared/blockDuration.ts'
import { isTrustedTimelineBlock } from '../../src/shared/timelineReview.ts'
import type {
  AppCategory,
  AppUsageSummary,
  CalendarSignal,
  DayTimelinePayload,
  WorkContextBlock,
  WorkIntentRole,
} from '../../src/shared/types.ts'

type TimelineFixture = NormalizedEvidenceDayFixture

interface ActualBlock {
  index: number
  block: WorkContextBlock
  label: string
  kind: WorkKind
  role: WorkIntentRole
  subject: string | null
  startTime: number
  endTime: number
  startReasons: string[]
  endReasons: string[]
}

interface EpisodeResult {
  expected: ExpectedDayEpisode
  startTime: number
  endTime: number
  overlaps: Array<{ actual: ActualBlock; overlapMs: number }>
  primary: ActualBlock | null
  boundaryOk: boolean
  labelOk: boolean
  categoryOk: boolean
  kindOk: boolean
  roleOk: boolean
  subjectOk: boolean
  notes: string[]
}

interface FixtureResult {
  fixture: TimelineFixture
  payload: DayTimelinePayload
  facts: DayWrapFacts
  actualBlocks: ActualBlock[]
  episodes: EpisodeResult[]
  overSplits: EpisodeResult[]
  underSplits: Array<{ actual: ActualBlock; expectedIds: string[] }>
  extras: ActualBlock[]
  wrapIssues: string[]
  unsupportedWrapClaims: string[]
  wrapGroundingIssues: string[]
  boundaryIssues: string[]
  designIssues: string[]
  labelVoice: LabelVoiceSummary
  labelVoiceInvariantIssues: string[]
  labelVoiceTargetIssues: string[]
  factsIssues: string[]
  privacyIssues: string[]
  mutationIssues: string[]
  scores: {
    segmentationPassed: number
    segmentationTotal: number
    labelsPassed: number
    labelsTotal: number
    rolesPassed: number
    rolesTotal: number
    wrapsPassed: number
    wrapsTotal: number
    factsPassed: number
    factsTotal: number
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(HERE, 'fixtures')
const BASELINE_PATH = path.join(process.cwd(), '.timeline-eval', 'baseline.md')
const DEFAULT_BOUNDARY_TOLERANCE_MINUTES = 5

function msForClock(dateStr: string, clock: string): number {
  const [hourRaw, minuteRaw] = clock.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Invalid fixture clock "${clock}"`)
  }
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatRange(startTime: number, endTime: number): string {
  return `${formatClock(startTime)}-${formatClock(endTime)}`
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function containsAny(value: string | null | undefined, expected: string[]): boolean {
  const normalizedValue = normalizeText(value)
  return expected.some((candidate) => {
    const normalizedCandidate = normalizeText(candidate)
    return Boolean(normalizedCandidate) && normalizedValue.includes(normalizedCandidate)
  })
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

function createDb(): Database.Database {
  return createProductionTestDatabase()
}

function seedFixture(db: Database.Database, fixture: TimelineFixture): void {
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused,
      window_title,
      raw_app_name,
      canonical_app_id,
      app_instance_id,
      capture_source,
      ended_reason,
      capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'timeline_eval_fixture', NULL, 2)
  `)

  for (const session of fixture.input.sessions) {
    const startTime = msForClock(fixture.date, session.start)
    const endTime = msForClock(fixture.date, session.end)
    insertSession.run(
      session.bundleId,
      session.appName,
      startTime,
      endTime,
      Math.max(1, Math.round((endTime - startTime) / 1000)),
      session.category,
      session.title ?? null,
      session.appName,
      session.bundleId,
      session.bundleId,
    )
  }

  const insertVisit = db.prepare(`
    INSERT INTO website_visits (
      domain,
      page_title,
      url,
      visit_time,
      visit_time_us,
      duration_sec,
      browser_bundle_id,
      canonical_browser_id,
      normalized_url,
      page_key,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'timeline_eval_fixture')
  `)

  for (const [index, visit] of (fixture.input.browserEvidence ?? []).entries()) {
    const visitTime = msForClock(fixture.date, visit.at)
    const durationSeconds = visit.durationSeconds ?? Math.round((visit.durationMinutes ?? 1) * 60)
    insertVisit.run(
      visit.domain,
      visit.title ?? null,
      visit.url,
      visitTime,
      visitTime * 1000 + index,
      durationSeconds,
      visit.browserBundleId ?? null,
      visit.canonicalBrowserId ?? visit.browserBundleId ?? null,
      visit.url,
      visit.url,
    )
  }

  const insertEvent = db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, ?, 'timeline_eval_fixture', '{}')
  `)
  for (const event of fixture.input.activityEvents ?? []) {
    insertEvent.run(msForClock(fixture.date, event.at), event.type)
  }
}

function loadFixtures(): TimelineFixture[] {
  return loadDayFixtures(FIXTURE_DIR).filter(isNormalizedEvidenceDayFixture)
}

// The person's edits, replayed through the production review path. After the
// edits the day is invalidated and re-derived, so automated inference runs
// again — the review overlay must win over that fresh inference.
function applyTimelineMutations(
  db: Database.Database,
  fixture: TimelineFixture,
  payload: DayTimelinePayload,
): string[] {
  const issues: string[] = []
  for (const mutation of fixture.mutations ?? []) {
    if (mutation.kind !== 'correctBlock' && mutation.kind !== 'ignoreBlock') {
      issues.push(
        `mutation ${mutation.kind} needs source-boundary capture; use a capture-events fixture`,
      )
      continue
    }
    const block = payload.blocks.find((candidate) =>
      containsAny(userVisibleLabelForBlock(candidate), mutation.matchLabelIncludes),
    )
    if (!block) {
      issues.push(
        `mutation ${mutation.kind}: no block label matches [${mutation.matchLabelIncludes.join(', ')}]`,
      )
      continue
    }
    if (mutation.kind === 'ignoreBlock') {
      writeTimelineBlockReview(db, fixture.date, block, { state: 'ignored' })
    } else {
      writeTimelineBlockReview(db, fixture.date, block, {
        state: mutation.state ?? 'corrected',
        correctedLabel: mutation.correctedLabel,
        correctedIntentRole: mutation.correctedIntentRole,
        correctedIntentSubject: mutation.correctedIntentSubject,
        correctedCategory: mutation.correctedCategory,
      })
    }
  }
  return issues
}

function clockToMinutes(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number)
  return hour * 60 + minute
}

// Calendar signals carry human clocks ("10:00am"); expected meetings use HH:MM.
function calendarClockToMinutes(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec((value ?? '').trim())
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const meridiem = match[3]?.toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  return hour * 60 + minute
}

function minutesSinceMidnight(fixture: TimelineFixture, ms: number): number {
  return Math.round((ms - msForClock(fixture.date, '00:00')) / 60_000)
}

function formattedDurationMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const hours = /([0-9]+)h/.exec(value)?.[1]
  const minutes = /([0-9]+)m/.exec(value)?.[1]
  if (hours == null && minutes == null) return null
  return Number(hours ?? 0) * 60 + Number(minutes ?? 0)
}

interface FactsResult {
  issues: string[]
  passed: number
  total: number
}

// Data-driven checks for the richer expected-result model: Apps facts,
// meetings, search results, and deterministic totals. Each expected item
// counts once so a fixture failure names the exact fact that broke.
function evaluateDayFacts(
  fixture: TimelineFixture,
  db: Database.Database,
  payload: DayTimelinePayload,
  facts: DayWrapFacts,
  appSummaries: AppUsageSummary[],
): FactsResult {
  const issues: string[] = []
  let passed = 0
  let total = 0

  for (const expectedApp of fixture.expected.apps ?? []) {
    total += 1
    const summary = appSummaries.find(
      (candidate) => normalizeText(candidate.appName) === normalizeText(expectedApp.appName),
    )
    if (!summary) {
      issues.push(
        `apps: missing "${expectedApp.appName}" (got ${appSummaries.map((s) => s.appName).join(', ') || 'none'})`,
      )
      continue
    }
    if (expectedApp.durationMinutes != null) {
      const tolerance = expectedApp.durationToleranceMinutes ?? 5
      const actualMinutes = summary.totalSeconds / 60
      if (Math.abs(actualMinutes - expectedApp.durationMinutes) > tolerance) {
        issues.push(
          `apps: "${expectedApp.appName}" ${Math.round(actualMinutes)}m, expected ${expectedApp.durationMinutes}m ±${tolerance}m`,
        )
        continue
      }
    }
    passed += 1
  }

  const calendar = getExternalSignal<CalendarSignal>(db, fixture.date, 'calendar')?.payload
  const resolvedMeetings = resolveDayEnrichment(db, fixture.date)?.meetings?.items ?? []
  const actualMeetings = [
    ...(calendar?.events ?? []).map((event) => {
      const resolved = resolvedMeetings.find((item) =>
        item.title != null &&
        (containsAny(item.title, [event.title]) || containsAny(event.title, [item.title])),
      )
      return {
        source: 'calendar',
        title: resolved?.title ?? event.title,
        startMinutes: calendarClockToMinutes(event.startClock),
        minutes: formattedDurationMinutes(resolved?.scheduled) ?? event.durationMinutes,
      }
    }),
    ...payload.blocks
      .filter((block) => block.dominantCategory === 'meetings')
      .map((block) => ({
        source: 'timeline',
        title: userVisibleLabelForBlock(block),
        startMinutes: minutesSinceMidnight(fixture, block.startTime),
        minutes: Math.round(blockActiveSeconds(block) / 60),
      })),
  ]
  for (const expectedMeeting of fixture.expected.meetings ?? []) {
    total += 1
    const durationTolerance = expectedMeeting.durationToleranceMinutes ?? 5
    const startTolerance = expectedMeeting.startToleranceMinutes ?? 5
    const match = actualMeetings.find(
      (meeting) =>
        (expectedMeeting.source == null || meeting.source === expectedMeeting.source) &&
        containsAny(meeting.title, [expectedMeeting.title]) &&
        (expectedMeeting.start == null ||
          (meeting.startMinutes != null &&
            Math.abs(meeting.startMinutes - clockToMinutes(expectedMeeting.start)) <=
              startTolerance)) &&
        (expectedMeeting.durationMinutes == null ||
          (meeting.minutes != null &&
            Math.abs(meeting.minutes - expectedMeeting.durationMinutes) <= durationTolerance)),
    )
    if (match) passed += 1
    else {
      const got =
        actualMeetings.map((m) => `${m.source}:"${m.title}"`).join(', ') || 'none'
      issues.push(
        `meetings: nothing matches "${expectedMeeting.title}"${expectedMeeting.source ? ` from ${expectedMeeting.source}` : ''} (got ${got})`,
      )
    }
  }

  for (const expectedSearch of fixture.expected.search ?? []) {
    total += 1
    const rows = searchAll(db, expectedSearch.query, {
      startDate: fixture.date,
      endDate: fixture.date,
      limit: 50,
    })
    const haystack = normalizeText(JSON.stringify(rows))
    const missing = (expectedSearch.requiredFacts ?? []).filter(
      (fact) => !haystack.includes(normalizeText(fact)),
    )
    const leaked = (expectedSearch.prohibitedFacts ?? []).filter((fact) =>
      haystack.includes(normalizeText(fact)),
    )
    if (missing.length === 0 && leaked.length === 0) passed += 1
    if (missing.length > 0) {
      issues.push(`search "${expectedSearch.query}": missing ${missing.join(', ')}`)
    }
    if (leaked.length > 0) {
      issues.push(`search "${expectedSearch.query}": must not return ${leaked.join(', ')}`)
    }
  }

  const TOTALS_TOLERANCE_SECONDS = 90
  for (const [key, expectedSeconds] of Object.entries(fixture.expected.totals ?? {})) {
    total += 1
    const actual = (facts as unknown as Record<string, unknown>)[key]
    if (typeof actual !== 'number') {
      issues.push(`totals: "${key}" is not a numeric wrap fact`)
      continue
    }
    if (Math.abs(actual - expectedSeconds) > TOTALS_TOLERANCE_SECONDS) {
      issues.push(`totals: ${key} ${Math.round(actual)}s, expected ${expectedSeconds}s ±${TOTALS_TOLERANCE_SECONDS}s`)
      continue
    }
    passed += 1
  }

  return { issues, passed, total }
}

// Each fixture names the surfaces where a term is prohibited. Raw evidence is
// scanned only when named because an ignored block may intentionally keep its
// capture while disappearing from product surfaces.
async function evaluateFixturePrivacy(
  fixture: TimelineFixture,
  db: Database.Database,
  payload: DayTimelinePayload,
  texts: string[],
  appSummaries: AppUsageSummary[],
): Promise<string[]> {
  const terms = fixture.expected.privacy?.prohibitedTerms ?? []
  if (terms.length === 0) return []
  const issues: string[] = []
  const declared = new Set(fixture.expected.privacy?.prohibitedSurfaces ?? [
    'Timeline', 'Apps', 'search', 'wrap',
  ])
  const timelineHaystack = normalizeText(
    JSON.stringify(
      payload.blocks.map((block) => [
        userVisibleLabelForBlock(block),
        block.label.current,
        block.topApps.map((app) => app.appName),
        block.websites.map((site) => [site.domain, site.title]),
        block.pageRefs.map((page) => page.displayTitle),
      ]),
    ),
  )
  const surfaces: Array<[string, string]> = []
  if (declared.has('Timeline')) surfaces.push(['Timeline', timelineHaystack])
  if (declared.has('Apps')) {
    surfaces.push(['Apps', normalizeText(JSON.stringify(appSummaries))])
  }
  if (declared.has('wrap')) surfaces.push(['wrap', normalizeText(texts.join(' | '))])
  for (const term of terms) {
    const normalized = normalizeText(term)
    for (const [surface, haystack] of surfaces) {
      if (haystack.includes(normalized)) issues.push(`privacy: "${term}" leaked into ${surface}`)
    }
    if (declared.has('sessions')) {
      const matches = findDatabaseTextMatches(db, term, new Set(['app_sessions']))
      if (matches.length > 0) issues.push(`privacy: "${term}" remains in sessions (${matches.length} cells)`)
    }
    if (declared.has('pending evidence')) {
      const matches = findDatabaseTextMatches(db, term, new Set(['website_visits_pending']))
      if (matches.length > 0) issues.push(`privacy: "${term}" remains in pending evidence (${matches.length} cells)`)
    }
    if (declared.has('canonical evidence')) {
      const matches = findDatabaseTextMatches(db, term)
      if (matches.length > 0) {
        issues.push(
          `privacy: "${term}" remains in ${matches.map((match) => `${match.table}.${match.column}`).join(', ')}`,
        )
      }
    }
    if (declared.has('search')) {
      const rows = searchAll(db, term, {
        startDate: fixture.date,
        endDate: fixture.date,
        limit: 20,
      })
      if (rows.length > 0) issues.push(`privacy: search for "${term}" returns ${rows.length} rows`)
    }
    if (declared.has('memory')) {
      const memory = chatMemoryPromptBlock(db, term)
      if (normalizeText(memory).includes(normalized)) issues.push(`privacy: "${term}" leaked into memory`)
    }
    if (declared.has('AI context')) {
      const tools = buildDaylensTools(db)
      const overview = await (tools.get_day_overview as {
        execute: (input: unknown, options: unknown) => Promise<unknown>
      }).execute({ date: fixture.date }, {})
      if (normalizeText(JSON.stringify(overview)).includes(normalized)) {
        issues.push(`privacy: "${term}" leaked into AI context`)
      }
    }
    if (declared.has('MCP')) {
      const result = executeTool('getDaySummary', { date: fixture.date }, db)
      if (normalizeText(JSON.stringify(result)).includes(normalized)) {
        issues.push(`privacy: "${term}" leaked into MCP`)
      }
    }
    if (declared.has('sync')) {
      issues.push('privacy: sync must be exercised by a capture-events fixture')
    }
  }
  return issues
}

function actualBlocksFor(payload: DayTimelinePayload): ActualBlock[] {
  return payload.blocks.map((block, index) => {
    const intent = inferWorkIntent(block)
    return {
      index,
      block,
      label: userVisibleLabelForBlock(block),
      kind: effectiveBlockKind(block),
      role: block.review?.correctedIntentRole ?? intent.role,
      subject: block.review?.correctedIntentSubject ?? intent.subject,
      startTime: block.startTime,
      endTime: block.endTime,
      startReasons: block.boundary?.startReasons ?? [],
      endReasons: block.boundary?.endReasons ?? [],
    }
  })
}

function evaluateEpisodes(fixture: TimelineFixture, actualBlocks: ActualBlock[]): EpisodeResult[] {
  return fixture.expected.episodes.map((expected) => {
    const startTime = msForClock(fixture.date, expected.start)
    const endTime = msForClock(fixture.date, expected.end)
    const overlaps = actualBlocks
      .map((actual) => ({
        actual,
        overlapMs: overlapMs(startTime, endTime, actual.startTime, actual.endTime),
      }))
      .filter((entry) => entry.overlapMs > 0)
      .sort((left, right) => right.overlapMs - left.overlapMs)
    const primary = overlaps[0]?.actual ?? null
    const notes: string[] = []
    const startToleranceMs =
      (expected.startToleranceMinutes ?? DEFAULT_BOUNDARY_TOLERANCE_MINUTES) * 60_000
    const endToleranceMs =
      (expected.endToleranceMinutes ?? DEFAULT_BOUNDARY_TOLERANCE_MINUTES) * 60_000

    const boundaryOk = Boolean(
      primary &&
      Math.abs(primary.startTime - startTime) <= startToleranceMs &&
      Math.abs(primary.endTime - endTime) <= endToleranceMs,
    )
    if (!primary) {
      notes.push('missing actual block')
    } else if (!boundaryOk) {
      notes.push(`boundary ${formatRange(primary.startTime, primary.endTime)}`)
    }

    if (overlaps.length > 1) {
      notes.push(`over-split into ${overlaps.length} blocks`)
    }

    const labelTerms = expected.labelIncludes ?? [expected.label]
    const labelOk = primary ? containsAny(primary.label, labelTerms) : false
    if (primary && !labelOk) notes.push(`label "${primary.label}"`)

    const categoryOk =
      !expected.category || (primary ? primary.block.dominantCategory === expected.category : false)
    if (primary && expected.category && !categoryOk) {
      notes.push(`category ${primary.block.dominantCategory}`)
    }

    const kindOk = !expected.kind || (primary ? primary.kind === expected.kind : false)
    if (primary && expected.kind && !kindOk) {
      notes.push(`kind ${primary.kind}, expected ${expected.kind}`)
    }

    const roleOk = !expected.intentRole || (primary ? primary.role === expected.intentRole : false)
    if (primary && expected.intentRole && !roleOk) notes.push(`role ${primary.role}`)

    const subjectTerms = expected.intentSubjectIncludes ?? []
    const subjectOk =
      subjectTerms.length === 0 || (primary ? containsAny(primary.subject, subjectTerms) : false)
    if (primary && subjectTerms.length > 0 && !subjectOk) {
      notes.push(`subject ${primary.subject ?? 'null'}`)
    }

    return {
      expected,
      startTime,
      endTime,
      overlaps,
      primary,
      boundaryOk,
      labelOk,
      categoryOk,
      kindOk,
      roleOk,
      subjectOk,
      notes,
    }
  })
}

function findUnderSplits(
  fixture: TimelineFixture,
  actualBlocks: ActualBlock[],
): Array<{ actual: ActualBlock; expectedIds: string[] }> {
  return actualBlocks
    .map((actual) => {
      const expectedIds = fixture.expected.episodes
        .filter((expected) => {
          const startTime = msForClock(fixture.date, expected.start)
          const endTime = msForClock(fixture.date, expected.end)
          return overlapMs(actual.startTime, actual.endTime, startTime, endTime) > 0
        })
        .map((expected) => expected.id)
      return { actual, expectedIds }
    })
    .filter((entry) => entry.expectedIds.length > 1)
}

function findExtras(fixture: TimelineFixture, actualBlocks: ActualBlock[]): ActualBlock[] {
  return actualBlocks.filter((actual) => {
    return !fixture.expected.episodes.some((expected) => {
      const startTime = msForClock(fixture.date, expected.start)
      const endTime = msForClock(fixture.date, expected.end)
      return overlapMs(actual.startTime, actual.endTime, startTime, endTime) > 0
    })
  })
}

// The wrap is a deck: `planDayWrapSlides` computes the slides deterministically
// and the narrative supplies one line per slide id. The eval exercises the
// fallback path (no AI), so every slide resolves to its deterministic
// fallbackLine — those lines plus lead/question/reflection are the user-visible
// wrap prose the checks below run against.
function wrappedTexts(facts: DayWrapFacts): string[] {
  const narrative = buildFallbackNarrative(facts, computeFactsHash(facts))
  const slideLines =
    facts.quality === 'empty' || facts.quality === 'tooEarly'
      ? []
      : planDayWrapSlides(facts).map((spec) => resolveSlideLine(spec, narrative.lines))
  return [narrative.lead, ...slideLines, narrative.question, narrative.reflection].filter(
    (line): line is string => Boolean(line),
  )
}

function trackedDomains(payload: DayTimelinePayload): Set<string> {
  const domains = new Set<string>()
  for (const block of payload.blocks) {
    for (const site of block.websites) {
      domains.add(site.domain.toLowerCase().replace(/^www\./, ''))
    }
  }
  return domains
}

function unsupportedWrapClaims(
  facts: DayWrapFacts,
  texts: string[],
  payload: DayTimelinePayload,
): string[] {
  const allowedDomains = trackedDomains(payload)
  const issues: string[] = []

  // An hour figure is grounded if it matches the headline, a kind sub-total, or
  // any per-item figure the facts carry (activity, slice, ribbon segment,
  // standout, hook, story part). Only numbers matching none are invented.
  const storySegments = facts.dayStory
  const allowedHours = [
    facts.activeSeconds,
    facts.workSeconds,
    facts.leisureSeconds,
    facts.personalSeconds,
    facts.meetingsSeconds,
    facts.standout?.seconds ?? 0,
    ...facts.workActivities.map((a) => a.seconds),
    ...facts.appSites.map((s) => s.seconds),
    ...facts.ribbon.map((r) => r.seconds),
    ...facts.candidateHooks.map((h) => h.seconds ?? 0),
    ...storySegments.map((s) => s?.seconds ?? 0),
  ]
    .filter((s) => s > 0)
    .map((s) => s / 3600)

  for (const text of texts) {
    const domainMatches =
      text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|io|dev|app|net|ai|co))\b/gi) ?? []
    for (const match of domainMatches) {
      const normalized = match.toLowerCase().replace(/^www\./, '')
      if (allowedDomains.has(normalized)) continue
      issues.push(`untracked domain "${match}" in "${text}"`)
    }

    const hourMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b)/gi)]
    for (const match of hourMatches) {
      const claimed = Number(match[1])
      if (!Number.isFinite(claimed)) continue
      if (!allowedHours.some((hours) => Math.abs(claimed - hours) <= 1.05)) {
        issues.push(`unsupported hour claim "${match[0]}" in "${text}"`)
      }
    }
  }

  return issues
}

function evaluateWrap(fixture: TimelineFixture, facts: DayWrapFacts): string[] {
  const expected = fixture.expected.wrap
  if (!expected) return []
  const issues: string[] = []

  if (expected.quality && facts.quality !== expected.quality) {
    issues.push(`quality ${facts.quality}, expected ${expected.quality}`)
  }
  if (expected.isLeisureDay != null && facts.isLeisureDay !== expected.isLeisureDay) {
    issues.push(`isLeisureDay ${facts.isLeisureDay}, expected ${expected.isLeisureDay}`)
  }
  if (expected.workActivityIncludes) {
    const found = facts.workActivities.some((a) =>
      containsAny(a.name, [expected.workActivityIncludes!]),
    )
    if (!found) {
      const got = facts.workActivities.map((a) => a.name).join(' | ') || 'none'
      issues.push(`workActivities missing "${expected.workActivityIncludes}" (got ${got})`)
    }
  }
  if (expected.appSiteIncludes) {
    const found = facts.appSites.some((s) => containsAny(s.name, [expected.appSiteIncludes!]))
    if (!found) {
      const got = facts.appSites.map((s) => s.name).join(' | ') || 'none'
      issues.push(`appSites missing "${expected.appSiteIncludes}" (got ${got})`)
    }
  }
  if (expected.topLeisureIncludes) {
    const found = facts.topLeisure.some((name) => containsAny(name, [expected.topLeisureIncludes!]))
    if (!found) {
      issues.push(
        `topLeisure missing "${expected.topLeisureIncludes}" (got ${facts.topLeisure.join(' | ') || 'none'})`,
      )
    }
  }
  if (
    expected.standoutIncludes &&
    !containsAny(facts.standout?.name, [expected.standoutIncludes])
  ) {
    issues.push(
      `standout ${facts.standout?.name ?? 'none'}, expected "${expected.standoutIncludes}"`,
    )
  }

  return issues
}

// Structural groundedness: the ONE reconciled facts object must actually
// reconcile (wrapped.md §5 — headline = split total = slice total = ribbon
// total), and every named work item must trace back to a real trusted block.
// The split is recounted here independently of buildDayWrapFacts so the check
// guards against the derivation drifting from the timeline.
function wrapEligibleBlocks(payload: DayTimelinePayload): WorkContextBlock[] {
  return payload.blocks
    .filter(isTrustedTimelineBlock)
    .filter((b) => b.dominantCategory !== 'system' && b.dominantCategory !== 'uncategorized')
}

function workBlockNames(block: WorkContextBlock): string {
  const names: string[] = []
  const subject = block.review?.correctedIntentSubject ?? inferWorkIntent(block).subject
  if (subject) names.push(subject)
  const label = block.review?.correctedLabel?.trim() || block.label.current.trim()
  if (label) {
    names.push(label)
    const humanized = humanizeTitle(label)
    if (humanized) names.push(humanized)
  }
  return names.join(' | ')
}

function checkWrapGrounding(facts: DayWrapFacts, payload: DayTimelinePayload): string[] {
  const issues: string[] = []
  const blocks = wrapEligibleBlocks(payload)

  // 1. The kind split must equal an independent recount of the trusted blocks.
  let work = 0
  let leisure = 0
  let personal = 0
  for (const block of blocks) {
    const kind = effectiveBlockKind(block)
    const seconds = blockActiveSeconds(block)
    if (kind === 'work') work += seconds
    else if (kind === 'leisure') leisure += seconds
    else if (kind === 'personal') personal += seconds
  }
  const splits: Array<[string, number, number]> = [
    ['work', facts.workSeconds, work],
    ['leisure', facts.leisureSeconds, leisure],
    ['personal', facts.personalSeconds, personal],
  ]
  for (const [name, claimed, recounted] of splits) {
    if (Math.abs(claimed - recounted) > 1) {
      issues.push(`${name}Seconds ${claimed} != ${recounted} recounted from payload`)
    }
  }

  // 2. The headline number reconciles with the split exactly.
  if (facts.activeSeconds !== facts.workSeconds + facts.leisureSeconds + facts.personalSeconds) {
    issues.push(
      `activeSeconds ${facts.activeSeconds} != split total ${facts.workSeconds + facts.leisureSeconds + facts.personalSeconds}`,
    )
  }

  // 3. The "where the time went" slices sum to the headline (slices + Other).
  const sliceTotal = facts.appSites.reduce((sum, slice) => sum + slice.seconds, 0)
  if (facts.appSites.length > 0 && Math.abs(sliceTotal - facts.activeSeconds) > 1) {
    issues.push(`appSites total ${sliceTotal} != activeSeconds ${facts.activeSeconds}`)
  }

  // 4. The ribbon covers the same time as the headline.
  const ribbonTotal = facts.ribbon.reduce((sum, segment) => sum + segment.seconds, 0)
  if (facts.ribbon.length > 0 && Math.abs(ribbonTotal - facts.activeSeconds) > 1) {
    issues.push(`ribbon total ${ribbonTotal} != activeSeconds ${facts.activeSeconds}`)
  }

  // 5. Every named work activity traces to a real trusted work block, and no
  //    activity can claim more time than all work combined.
  const workBlocks = blocks.filter((b) => effectiveBlockKind(b) === 'work')
  for (const activity of facts.workActivities) {
    if (!workBlocks.some((b) => containsAny(workBlockNames(b), [activity.name]))) {
      issues.push(`work activity "${activity.name}" traces to no trusted work block`)
    }
    if (activity.seconds > facts.workSeconds + 1) {
      issues.push(
        `work activity "${activity.name}" claims ${activity.seconds}s > workSeconds ${facts.workSeconds}`,
      )
    }
  }

  // 6. The standout is a real work stretch: named from a work block (or the
  //    honest category word when the block is unnameable), no longer than all
  //    work combined.
  if (facts.standout) {
    const traced = workBlocks.some(
      (b) =>
        containsAny(workBlockNames(b), [facts.standout!.name]) ||
        normalizeText(categoryWord(b.dominantCategory)) === normalizeText(facts.standout!.name),
    )
    if (!traced) {
      issues.push(`standout "${facts.standout.name}" traces to no trusted work block`)
    }
    if (facts.standout.seconds > facts.workSeconds + 1) {
      issues.push(`standout claims ${facts.standout.seconds}s > workSeconds ${facts.workSeconds}`)
    }
  }

  return issues
}

// The Target Design encoded as hard invariants. A green eval run is meaningless
// unless it actually verifies the design held — gates have passed before while
// the product regressed. These checks make a green run mean the design is met:
// kind correctness, no dev apps inside a leisure episode, and humanized titles.
// Label-shaped invariants (raw machine forms, leisure activity shape, jargon,
// judgment) live in the shared label-voice rubric and are enforced below.
const NATIVE_WORK_CATEGORIES = new Set<AppCategory>(['development', 'aiTools', 'writing', 'design'])

// The wrap must never contradict itself, scold, invent, or assign homework.
// These guard known wrap defects directly so a green run means the cards
// are honest.
const WRAP_GUILT_PATTERNS = [
  /\b100%\b/i, // the "100% entertainment" contradiction
  /needs?\b[^.]{0,24}\breview\b/i, // the "needs review" homework closing
  /review in the timeline/i,
  // "distraction" is a live product noun (profile / alerts); do not treat the word as guilt.
  /books you (?:didn'?t|did not)/i,
  /\blost to\b/i,
  /courses? (?:left )?unstarted/i,
  /extrapolat/i,
]

function wrapDesignIssues(
  facts: DayWrapFacts,
  texts: string[],
  actualBlocks: ActualBlock[],
): string[] {
  const issues: string[] = []

  for (const text of texts) {
    for (const pattern of WRAP_GUILT_PATTERNS) {
      if (pattern.test(text)) issues.push(`wrap line trips "${pattern.source}": "${text}"`)
    }
  }

  // A leisure day is narrated, never graded — no focus scoring anywhere.
  if (facts.isLeisureDay) {
    for (const text of texts) {
      if (/\bfocus(?:ed)?\b/i.test(text)) {
        issues.push(`leisure-day wrap scores focus: "${text}"`)
      }
    }
  }

  // The work surfaces (activities, standout) must never name a leisure block —
  // watching is never the work that mattered.
  const leisureLabels = new Set(
    actualBlocks.filter((b) => b.kind === 'leisure').map((b) => normalizeText(b.label)),
  )
  for (const activity of facts.workActivities) {
    if (leisureLabels.has(normalizeText(activity.name))) {
      issues.push(`work activity names a leisure block: "${activity.name}"`)
    }
  }
  if (facts.standout && leisureLabels.has(normalizeText(facts.standout.name))) {
    issues.push(`standout names a leisure block: "${facts.standout.name}"`)
  }

  return issues
}

function designInvariantIssues(
  fixture: TimelineFixture,
  actualBlocks: ActualBlock[],
  episodes: EpisodeResult[],
): string[] {
  const issues: string[] = []

  // 1. Kind correctness: every expected episode's kind must match.
  for (const episode of episodes) {
    if (episode.expected.kind && episode.primary && !episode.kindOk) {
      issues.push(
        `kind: ${episode.expected.id} is ${episode.primary.kind}, expected ${episode.expected.kind}`,
      )
    }
  }

  for (const actual of actualBlocks) {
    // 2. No native work app may sit inside a leisure episode — a documentary
    //    block must never list Ghostty/Codex.
    if (actual.kind === 'leisure') {
      const workApps = actual.block.topApps
        .filter((app) => !app.isBrowser && NATIVE_WORK_CATEGORIES.has(app.category))
        .map((app) => app.appName)
      if (workApps.length > 0) {
        issues.push(
          `leisure ${formatRange(actual.startTime, actual.endTime)} contains work apps: ${workApps.join(', ')}`,
        )
      }
    }

    // 3. No raw machine form may reach a user-facing intent subject. The
    //    label-side counterpart is the label-voice rubric, enforced separately.
    const subjectRaw = actual.subject ? rawLabelForm(actual.subject) : null
    if (subjectRaw) issues.push(`unhumanized subject "${actual.subject}" (${subjectRaw})`)
  }

  return issues
}

async function evaluateFixture(fixture: TimelineFixture): Promise<FixtureResult> {
  const db = createDb()
  try {
    seedFixture(db, fixture)
    if (fixture.context?.calendar) {
      putExternalSignal(db, fixture.date, 'calendar', fixture.context.calendar)
    }
    let payload = getTimelineDayPayload(db, fixture.date, null, { materialize: false })
    let mutationIssues: string[] = []
    if ((fixture.mutations ?? []).length > 0) {
      mutationIssues = applyTimelineMutations(db, fixture, payload)
      invalidateTimelineDayBlocks(db, fixture.date)
      payload = getTimelineDayPayload(db, fixture.date, null, { materialize: false })
    }
    const actualBlocks = actualBlocksFor(payload)
    const episodes = evaluateEpisodes(fixture, actualBlocks)
    const underSplits = findUnderSplits(fixture, actualBlocks)
    const extras = findExtras(fixture, actualBlocks)
    const facts = buildDayWrapFacts(payload)
    const texts = wrappedTexts(facts)
    const wrapIssues = evaluateWrap(fixture, facts)
    const unsupported = unsupportedWrapClaims(facts, texts, payload)
    const wrapGrounding = checkWrapGrounding(facts, payload)
    const dayStartMs = msForClock(fixture.date, '00:00')
    const appSummaries = getCorrectedAppSummariesForRange(db, dayStartMs, dayStartMs + 86_400_000)
    const factsResult = evaluateDayFacts(fixture, db, payload, facts, appSummaries)
    const privacyIssues = await evaluateFixturePrivacy(fixture, db, payload, texts, appSummaries)

    // Every block must explain why it started and stopped — segmentation now
    // records a boundary reason on each edge, so an empty one is a hole in the
    // model, not a cosmetic gap.
    const boundaryIssues: string[] = []
    for (const actual of actualBlocks) {
      if (actual.startReasons.length === 0) {
        boundaryIssues.push(
          `block ${formatRange(actual.startTime, actual.endTime)} has no start boundary reason`,
        )
      }
      if (actual.endReasons.length === 0) {
        boundaryIssues.push(
          `block ${formatRange(actual.startTime, actual.endTime)} has no end boundary reason`,
        )
      }
    }

    const designIssues = [
      ...designInvariantIssues(fixture, actualBlocks, episodes),
      ...wrapDesignIssues(facts, texts, actualBlocks),
    ]

    // Every produced label is scored against the recorded label-voice rubric.
    // Invariant-tier failures are enforced like the other design invariants;
    // target-tier misses are reported so the gap between deterministic fallback
    // labels and the final voice stays visible per fixture.
    const labelEvaluations = actualBlocks.map((actual) => ({
      label: actual.label,
      findings: evaluateLabelVoice(
        actual.label,
        labelVoiceContextForBlock(actual.block, actual.kind),
      ),
    }))
    const labelVoice = summarizeLabelVoice(labelEvaluations)
    const labelVoiceInvariantIssues: string[] = []
    const labelVoiceTargetIssues: string[] = []
    actualBlocks.forEach((actual, index) => {
      for (const finding of labelEvaluations[index].findings) {
        if (finding.passed) continue
        const line = `${finding.rule}: ${formatRange(actual.startTime, actual.endTime)} "${actual.label}" — ${finding.detail}`
        if (finding.tier === 'invariant') labelVoiceInvariantIssues.push(line)
        else labelVoiceTargetIssues.push(line)
      }
    })

    const segmentationTotal = episodes.length
    const segmentationPassed = episodes.filter(
      (episode) =>
        episode.primary &&
        episode.overlaps.length === 1 &&
        episode.boundaryOk &&
        !underSplits.some((entry) => entry.actual === episode.primary),
    ).length
    const labelsTotal = episodes.length
    const labelsPassed = episodes.filter((episode) => episode.labelOk).length
    const roles = episodes.filter((episode) => episode.expected.intentRole)
    const rolesPassed = roles.filter((episode) => episode.roleOk && episode.subjectOk).length
    const wrapsTotal = fixture.expected.wrap ? 1 : 0
    const wrapsPassed =
      wrapsTotal > 0 &&
      wrapIssues.length === 0 &&
      unsupported.length === 0 &&
      wrapGrounding.length === 0
        ? 1
        : 0

    return {
      fixture,
      payload,
      facts,
      actualBlocks,
      episodes,
      overSplits: episodes.filter((episode) => episode.overlaps.length > 1),
      underSplits,
      extras,
      wrapIssues,
      unsupportedWrapClaims: unsupported,
      wrapGroundingIssues: wrapGrounding,
      boundaryIssues,
      designIssues,
      labelVoice,
      labelVoiceInvariantIssues,
      labelVoiceTargetIssues,
      factsIssues: factsResult.issues,
      privacyIssues,
      mutationIssues,
      scores: {
        segmentationPassed,
        segmentationTotal,
        labelsPassed,
        labelsTotal,
        rolesPassed,
        rolesTotal: roles.length,
        wrapsPassed,
        wrapsTotal,
        factsPassed: factsResult.passed,
        factsTotal: factsResult.total,
      },
    }
  } finally {
    db.close()
  }
}

function status(ok: boolean): string {
  return ok ? 'pass' : 'fail'
}

function formatActualBlock(actual: ActualBlock): string {
  const apps = actual.block.topApps
    .map((app) => app.appName)
    .slice(0, 3)
    .join(', ')
  const subject = actual.subject ? ` on ${actual.subject}` : ''
  const boundary = ` ⟦${actual.startReasons.join('+') || '?'} → ${actual.endReasons.join('+') || '?'}⟧`
  return `${formatRange(actual.startTime, actual.endTime)} ${actual.label} (${actual.block.dominantCategory}, ${actual.role}${subject}, apps: ${apps})${boundary}`
}

function formatFixture(result: FixtureResult): string {
  const lines: string[] = []
  const { fixture, scores } = result
  lines.push(`## ${fixture.name} (${fixture.id})`)
  if (fixture.description) lines.push(fixture.description)
  lines.push('')
  lines.push(
    `Score: segmentation ${scores.segmentationPassed}/${scores.segmentationTotal} | labels ${scores.labelsPassed}/${scores.labelsTotal} | intent ${scores.rolesPassed}/${scores.rolesTotal} | wraps ${scores.wrapsPassed}/${scores.wrapsTotal} | facts ${scores.factsPassed}/${scores.factsTotal}`,
  )
  lines.push('')
  lines.push('| Expected episode | Actual primary block | Strict result | Notes |')
  lines.push('| --- | --- | --- | --- |')
  for (const episode of result.episodes) {
    const strictChecksOk = Boolean(
      episode.primary &&
      episode.overlaps.length === 1 &&
      episode.boundaryOk &&
      episode.labelOk &&
      episode.roleOk &&
      episode.subjectOk,
    )
    const expected = `${episode.expected.id} ${formatRange(episode.startTime, episode.endTime)} "${episode.expected.label}"`
    const actual = episode.primary ? formatActualBlock(episode.primary) : 'missing'
    lines.push(
      `| ${expected} | ${actual} | ${status(strictChecksOk)} | ${episode.notes.join('; ') || 'ok'} |`,
    )
  }

  lines.push('')
  lines.push('Actual blocks:')
  for (const actual of result.actualBlocks) {
    const pages = actual.block.pageRefs.map((page) => page.displayTitle).slice(0, 2)
    const pageText = pages.length > 0 ? ` pages: ${pages.join(' | ')}` : ''
    lines.push(
      `- ${formatActualBlock(actual)}; active ${formatDuration(blockActiveSeconds(actual.block))}${pageText}`,
    )
  }

  const facts = result.facts
  lines.push('')
  lines.push(
    `Wrap check: quality ${facts.quality}; active ${formatDuration(facts.activeSeconds)} ` +
      `(work ${formatDuration(facts.workSeconds)} / leisure ${formatDuration(facts.leisureSeconds)} / personal ${formatDuration(facts.personalSeconds)}); ` +
      `leisure day ${facts.isLeisureDay}; ` +
      `unsupported claims ${result.unsupportedWrapClaims.length === 0 ? 'none' : result.unsupportedWrapClaims.length}`,
  )
  lines.push(
    `Label voice: ${result.labelVoice.labelsMeetingInvariants}/${result.labelVoice.labelsEvaluated} blocks meet the invariants, ` +
      `${result.labelVoice.labelsMeetingTarget}/${result.labelVoice.labelsEvaluated} the full voice (docs/specs/label-voice.md)`,
  )
  lines.push(
    `Wrap facts: activities [${facts.workActivities.map((a) => `${a.name} ${formatDuration(a.seconds)}`).join(' | ') || 'none'}]; ` +
      `standout ${facts.standout ? `${facts.standout.name} ${formatDuration(facts.standout.seconds)}` : 'none'}; ` +
      `slices [${
        facts.appSites
          .slice(0, 4)
          .map((s) => s.name)
          .join(' | ') || 'none'
      }]; ` +
      `leisure [${facts.topLeisure.join(' | ') || 'none'}]`,
  )

  const issueLines: string[] = []
  for (const episode of result.overSplits) {
    issueLines.push(
      `over-split ${episode.expected.id}: ${episode.overlaps.map((entry) => formatRange(entry.actual.startTime, entry.actual.endTime)).join(', ')}`,
    )
  }
  for (const entry of result.underSplits) {
    issueLines.push(
      `under-split ${formatRange(entry.actual.startTime, entry.actual.endTime)} spans ${entry.expectedIds.join(', ')}`,
    )
  }
  for (const episode of result.episodes.filter((entry) => entry.primary && !entry.labelOk)) {
    issueLines.push(
      `wrong label ${episode.expected.id}: got "${episode.primary!.label}", expected "${episode.expected.label}"`,
    )
  }
  for (const episode of result.episodes.filter((entry) => entry.primary && !entry.roleOk)) {
    issueLines.push(
      `wrong intent role ${episode.expected.id}: got ${episode.primary!.role}, expected ${episode.expected.intentRole}`,
    )
  }
  for (const episode of result.episodes.filter((entry) => entry.primary && !entry.subjectOk)) {
    issueLines.push(
      `wrong intent subject ${episode.expected.id}: got ${episode.primary!.subject ?? 'null'}`,
    )
  }
  for (const issue of result.wrapIssues) {
    issueLines.push(`wrap fact mismatch: ${issue}`)
  }
  for (const issue of result.unsupportedWrapClaims) {
    issueLines.push(`unsupported wrap claim: ${issue}`)
  }
  for (const issue of result.wrapGroundingIssues) {
    issueLines.push(`wrap grounding: ${issue}`)
  }
  for (const issue of result.boundaryIssues) {
    issueLines.push(`boundary: ${issue}`)
  }
  for (const issue of result.designIssues) {
    issueLines.push(`design: ${issue}`)
  }
  for (const issue of result.labelVoiceInvariantIssues) {
    issueLines.push(`label voice invariant: ${issue}`)
  }
  for (const issue of result.labelVoiceTargetIssues) {
    issueLines.push(`label voice target: ${issue}`)
  }
  for (const issue of result.factsIssues) {
    issueLines.push(`facts: ${issue}`)
  }
  for (const issue of result.privacyIssues) {
    issueLines.push(issue)
  }
  for (const issue of result.mutationIssues) {
    issueLines.push(`mutation: ${issue}`)
  }
  for (const extra of result.extras) {
    issueLines.push(`extra actual block: ${formatActualBlock(extra)}`)
  }

  lines.push('')
  lines.push('Issues:')
  if (issueLines.length === 0) {
    lines.push('- none')
  } else {
    for (const issue of issueLines) lines.push(`- ${issue}`)
  }
  lines.push('')

  return lines.join('\n')
}

function formatReport(results: FixtureResult[]): string {
  const total = results.reduce(
    (sum, result) => ({
      segmentationPassed: sum.segmentationPassed + result.scores.segmentationPassed,
      segmentationTotal: sum.segmentationTotal + result.scores.segmentationTotal,
      labelsPassed: sum.labelsPassed + result.scores.labelsPassed,
      labelsTotal: sum.labelsTotal + result.scores.labelsTotal,
      rolesPassed: sum.rolesPassed + result.scores.rolesPassed,
      rolesTotal: sum.rolesTotal + result.scores.rolesTotal,
      wrapsPassed: sum.wrapsPassed + result.scores.wrapsPassed,
      wrapsTotal: sum.wrapsTotal + result.scores.wrapsTotal,
      factsPassed: sum.factsPassed + result.scores.factsPassed,
      factsTotal: sum.factsTotal + result.scores.factsTotal,
    }),
    {
      segmentationPassed: 0,
      segmentationTotal: 0,
      labelsPassed: 0,
      labelsTotal: 0,
      rolesPassed: 0,
      rolesTotal: 0,
      wrapsPassed: 0,
      wrapsTotal: 0,
      factsPassed: 0,
      factsTotal: 0,
    },
  )

  const lines = [
    '# Daylens Timeline Evaluation',
    '',
    'Command: `npm run timeline:eval`',
    '',
    `Fixtures: ${results.length}`,
    `Overall score: segmentation ${total.segmentationPassed}/${total.segmentationTotal} | labels ${total.labelsPassed}/${total.labelsTotal} | intent ${total.rolesPassed}/${total.rolesTotal} | wraps ${total.wrapsPassed}/${total.wrapsTotal} | facts ${total.factsPassed}/${total.factsTotal}`,
    `Label voice (docs/specs/label-voice.md): invariants ${results.reduce((sum, result) => sum + result.labelVoice.labelsMeetingInvariants, 0)}/${results.reduce((sum, result) => sum + result.labelVoice.labelsEvaluated, 0)} blocks | full voice ${results.reduce((sum, result) => sum + result.labelVoice.labelsMeetingTarget, 0)}/${results.reduce((sum, result) => sum + result.labelVoice.labelsEvaluated, 0)} blocks`,
    '',
    'This report compares editable offline fixtures against the current Daylens timeline, intent, and deterministic wrap logic.',
    '',
    ...results.map(formatFixture),
  ]

  return lines.join('\n')
}

const writeBaseline = process.argv.includes('--write-baseline')
const strict = process.argv.includes('--strict')
const fixtureFilter = process.argv.filter((arg) => !arg.startsWith('--')).slice(2)
const fixtures = loadFixtures().filter(
  (fixture) =>
    fixtureFilter.length === 0 || fixtureFilter.some((value) => fixture.id.includes(value)),
)

if (fixtures.length === 0) {
  throw new Error('No timeline eval fixtures matched.')
}

const results = await Promise.all(fixtures.map(evaluateFixture))
const report = formatReport(results)
console.log(report)

if (writeBaseline) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
  fs.writeFileSync(BASELINE_PATH, `${report}\n`)
  console.log(`\nWrote ${BASELINE_PATH}`)
}

// Hard invariant (always enforced, not just under --strict): every block must
// carry a non-empty boundary reason on both edges. A block that cannot explain
// why it started or stopped is a defect in the segmentation model.
const boundaryDefects = results.flatMap((result) => result.boundaryIssues)
if (boundaryDefects.length > 0) {
  console.error(`\nBoundary-reason invariant violated:\n- ${boundaryDefects.join('\n- ')}`)
  process.exitCode = 1
}

// Target-Design invariants (always enforced): a green run must mean the design
// held. kind correctness, no dev apps inside leisure, humanized titles.
const designDefects = results.flatMap((result) =>
  result.designIssues.map((issue) => `${result.fixture.id}: ${issue}`),
)
if (designDefects.length > 0) {
  console.error(`\nTarget-Design invariant violated:\n- ${designDefects.join('\n- ')}`)
  process.exitCode = 1
}

// Label-voice invariants (always enforced): the recorded rubric's invariant
// tier holds for every produced label, deterministic fallbacks included.
// Target-tier misses are reported per fixture but do not fail the hermetic run
// — reaching the full voice on thin evidence is the AI labeling path's job,
// reviewed against the same rubric in the real-day review.
const labelVoiceDefects = results.flatMap((result) =>
  result.labelVoiceInvariantIssues.map((issue) => `${result.fixture.id}: ${issue}`),
)
if (labelVoiceDefects.length > 0) {
  console.error(`\nLabel-voice invariant violated:\n- ${labelVoiceDefects.join('\n- ')}`)
  process.exitCode = 1
}

// Wrap groundedness is an invariant of the one reconciled facts object, not an
// opt-in expectation: unsupported claims and grounding failures fail the run
// even when a fixture declares no wrap expectations. A fixture may defer a
// tracked defect by naming it in expected.knownIssues; the defect is then
// reported without failing the run.
const wrapDefects = results.flatMap((result) => {
  const defects = [...result.unsupportedWrapClaims, ...result.wrapGroundingIssues]
  const deferrals = result.fixture.expected.knownIssues ?? []
  const unexpected: string[] = []
  for (const defect of defects) {
    if (!isKnownIssueDefect(deferrals, defect)) {
      unexpected.push(`${result.fixture.id}: ${defect}`)
      continue
    }
    const deferral = deferrals.find((candidate) => candidate.defectSignatures.includes(defect))!
    console.error(`\n${result.fixture.id}: exact defect deferred to ${deferral.issue}:\n- ${defect}`)
  }
  return unexpected
})
if (wrapDefects.length > 0) {
  console.error(`\nWrap-groundedness invariant violated:\n- ${wrapDefects.join('\n- ')}`)
  process.exitCode = 1
}

// Privacy rules and fixture mutations are always enforced: a prohibited term
// reaching a product surface, or a person's edit that could not be applied,
// invalidates the run regardless of --strict.
const privacyDefects = results.flatMap((result) =>
  [...result.privacyIssues, ...result.mutationIssues].map(
    (issue) => `${result.fixture.id}: ${issue}`,
  ),
)
if (privacyDefects.length > 0) {
  console.error(`\nPrivacy/mutation invariant violated:\n- ${privacyDefects.join('\n- ')}`)
  process.exitCode = 1
}

if (strict) {
  const failed = results.some(
    (result) =>
      result.scores.segmentationPassed !== result.scores.segmentationTotal ||
      result.scores.labelsPassed !== result.scores.labelsTotal ||
      result.scores.rolesPassed !== result.scores.rolesTotal ||
      result.scores.wrapsPassed !== result.scores.wrapsTotal ||
      result.scores.factsPassed !== result.scores.factsTotal,
  )
  if (failed) process.exitCode = 1
}
