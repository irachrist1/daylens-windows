import type { DayTimelinePayload, WorkContextBlock } from '@shared/types'
import { formatDuration, todayString } from './format'

export type RecapPeriod = 'day' | 'week' | 'month'

export type RecapChapterId = 'headline' | 'focus' | 'artifacts' | 'rhythm' | 'change'

export interface RecapMetric {
  label: string
  value: string
  detail: string
}

export interface RecapListItem {
  label: string
  value: string
  detail: string
}

export interface RecapTrendPoint {
  date: string
  shortLabel: string
  trackedSeconds: number
  focusSeconds: number
}

export interface RecapChapter {
  id: RecapChapterId
  eyebrow: string
  title: string
  body: string
}

export interface RecapCoverage {
  attributedPct: number
  untitledPct: number
  activeDayCount: number
  quietDayCount: number
  hasComparison: boolean
  coverageNote: string | null
}

export interface RecapSummary {
  period: RecapPeriod
  title: string
  subtitle: string
  headline: string
  summary: string
  changeSummary: string
  chapters: RecapChapter[]
  metrics: RecapMetric[]
  topWorkstreams: RecapListItem[]
  standoutArtifacts: RecapListItem[]
  trend: RecapTrendPoint[]
  promptChips: string[]
  coverage: RecapCoverage
  hasData: boolean
}

interface WorkstreamAccumulator {
  label: string
  seconds: number
  blockCount: number
  isUntitled: boolean
}

interface ArtifactAccumulator {
  label: string
  seconds: number
  mentionCount: number
}

interface DayAccumulator {
  date: string
  shortLabel: string
  weekdayLabel: string
  trackedSeconds: number
  focusSeconds: number
}

interface SwitchyBlock {
  label: string
  switchCount: number
  seconds: number
  date: string
}

interface LongestBlock {
  label: string
  seconds: number
  date: string
}

interface AggregatedRecapStats {
  hasData: boolean
  totalSeconds: number
  focusSeconds: number
  focusPct: number
  blockCount: number
  focusSessionCount: number
  activeDayCount: number
  quietDayCount: number
  switchCount: number
  untitledSeconds: number
  longestBlock: LongestBlock | null
  mostSwitchyBlock: SwitchyBlock | null
  peakDay: DayAccumulator | null
  perDay: DayAccumulator[]
  topWorkstreams: WorkstreamAccumulator[]
  standoutArtifacts: ArtifactAccumulator[]
}

interface RecapRangeDefinition {
  title: string
  subtitle: string
  currentDates: string[]
  comparisonDates: string[]
  comparisonLabel: string
}

const UNTITLED_LABEL = 'Untitled work block'

const DAY_PROMPT_TEMPLATES = [
  'What did I actually get done today?',
  'Which files, docs, or pages mattered most today?',
  'Where did my focus break down today?',
  'Summarize today as a short report I could share',
]

const WEEK_PROMPT_TEMPLATES = [
  'How did this week compare with last week?',
  'Where did my focus hold this week, and where did it break?',
  'Which projects dominated this week?',
  'Turn this week into a report I could share',
]

const MONTH_PROMPT_TEMPLATES = [
  'What changed this month compared with last month?',
  'Which projects or workstreams dominated this month?',
  'Which weeks were my strongest this month?',
  'Create a monthly recap I could share',
]

export function shiftDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const next = new Date(year, month - 1, day + days)
  return toDateKey(next)
}

export function getWeekStart(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const current = new Date(year, month - 1, day)
  const weekday = current.getDay()
  const diff = weekday === 0 ? -6 : 1 - weekday
  current.setDate(current.getDate() + diff)
  return toDateKey(current)
}

export function getMonthStart(dateStr: string): string {
  const [year, month] = dateStr.split('-').map(Number)
  return `${year}-${String(month).padStart(2, '0')}-01`
}

export function buildRecapSummaries(
  payloads: DayTimelinePayload[],
  currentDate = todayString(),
): Record<RecapPeriod, RecapSummary> {
  const payloadMap = new Map(payloads.map((payload) => [payload.date, payload]))

  return {
    day: buildRecapSummary('day', buildDayRange(currentDate), payloadMap),
    week: buildRecapSummary('week', buildWeekRange(currentDate), payloadMap),
    month: buildRecapSummary('month', buildMonthRange(currentDate), payloadMap),
  }
}

export function recapDateWindow(currentDate = todayString()): string[] {
  const currentMonthStart = getMonthStart(currentDate)
  const [year, month] = currentMonthStart.split('-').map(Number)
  const previousMonthStart = toDateKey(new Date(year, month - 2, 1))
  const dayCount = dayDistanceInclusive(previousMonthStart, currentDate)
  return Array.from({ length: dayCount }, (_, index) => shiftDate(previousMonthStart, index))
}

function buildRecapSummary(
  period: RecapPeriod,
  range: RecapRangeDefinition,
  payloadMap: Map<string, DayTimelinePayload>,
): RecapSummary {
  const currentPayloads = range.currentDates.map((date) => payloadMap.get(date) ?? emptyDayPayload(date))
  const comparisonPayloads = range.comparisonDates.map((date) => payloadMap.get(date) ?? emptyDayPayload(date))
  const currentStats = aggregatePayloads(currentPayloads)
  const comparisonStats = aggregatePayloads(comparisonPayloads)

  if (!currentStats.hasData) {
    const trend = currentPayloads.map((payload) => toTrendPoint(payload))
    return {
      period,
      title: range.title,
      subtitle: range.subtitle,
      headline: emptyHeadline(period),
      summary: emptySummary(period),
      changeSummary: emptyChangeSummary(period),
      chapters: emptyChapters(period),
      metrics: emptyMetrics(period),
      topWorkstreams: [],
      standoutArtifacts: [],
      trend,
      promptChips: promptChipsForPeriod(period, null),
      coverage: buildCoverage(currentStats, false),
      hasData: false,
    }
  }

  const coverage = buildCoverage(currentStats, comparisonStats.hasData)
  const chapters = buildChapters(period, currentStats, comparisonStats, range.comparisonLabel, coverage)
  const headline = chapters.find((chapter) => chapter.id === 'headline')?.body ?? ''
  const focus = chapters.find((chapter) => chapter.id === 'focus')?.body ?? ''
  const artifactStory = chapters.find((chapter) => chapter.id === 'artifacts')?.body ?? ''
  const summary = [headline, focus, artifactStory].filter(Boolean).join(' ')

  return {
    period,
    title: range.title,
    subtitle: range.subtitle,
    headline,
    summary,
    changeSummary: buildChangeSummary(currentStats, comparisonStats, range.comparisonLabel, period),
    chapters,
    metrics: buildMetrics(period, currentStats),
    topWorkstreams: buildWorkstreamList(currentStats),
    standoutArtifacts: currentStats.standoutArtifacts.slice(0, 3).map((item) => ({
      label: item.label,
      value: formatDuration(item.seconds),
      detail: `${item.mentionCount} mention${item.mentionCount === 1 ? '' : 's'}`,
    })),
    trend: currentPayloads.map((payload) => toTrendPoint(payload)),
    promptChips: promptChipsForPeriod(period, currentStats),
    coverage,
    hasData: true,
  }
}

function buildDayRange(currentDate: string): RecapRangeDefinition {
  return {
    title: 'Daily recap',
    subtitle: 'Today',
    currentDates: [currentDate],
    comparisonDates: [shiftDate(currentDate, -1)],
    comparisonLabel: 'yesterday',
  }
}

function buildWeekRange(currentDate: string): RecapRangeDefinition {
  const weekStart = getWeekStart(currentDate)
  const dayCount = dayDistanceInclusive(weekStart, currentDate)
  const currentDates = Array.from({ length: dayCount }, (_, index) => shiftDate(weekStart, index))
  const comparisonStart = shiftDate(weekStart, -7)
  const comparisonDates = Array.from({ length: dayCount }, (_, index) => shiftDate(comparisonStart, index))

  return {
    title: 'Weekly recap',
    subtitle: 'This week so far',
    currentDates,
    comparisonDates,
    comparisonLabel: 'the same point last week',
  }
}

function buildMonthRange(currentDate: string): RecapRangeDefinition {
  const monthStart = getMonthStart(currentDate)
  const dayCount = dayDistanceInclusive(monthStart, currentDate)
  const [year, month] = monthStart.split('-').map(Number)
  const previousMonthDate = new Date(year, month - 2, 1)
  const previousMonthStart = toDateKey(previousMonthDate)
  const previousMonthDays = new Date(previousMonthDate.getFullYear(), previousMonthDate.getMonth() + 1, 0).getDate()
  const comparisonDays = Math.min(dayCount, previousMonthDays)
  const comparisonDates = Array.from({ length: comparisonDays }, (_, index) => shiftDate(previousMonthStart, index))

  return {
    title: 'Monthly recap',
    subtitle: 'This month so far',
    currentDates: Array.from({ length: dayCount }, (_, index) => shiftDate(monthStart, index)),
    comparisonDates,
    comparisonLabel: 'the same point last month',
  }
}

function aggregatePayloads(payloads: DayTimelinePayload[]): AggregatedRecapStats {
  const totalSeconds = payloads.reduce((sum, payload) => sum + payload.totalSeconds, 0)
  const focusSeconds = payloads.reduce((sum, payload) => sum + payload.focusSeconds, 0)
  const blockCount = payloads.reduce((sum, payload) => sum + payload.blocks.length, 0)
  const focusSessionCount = payloads.reduce((sum, payload) => sum + payload.focusSessions.length, 0)
  const activeDayCount = payloads.filter((payload) => payload.totalSeconds > 0).length
  const quietDayCount = payloads.length - activeDayCount
  const switchCount = payloads.reduce((sum, payload) => (
    sum + payload.blocks.reduce((blockSum, block) => blockSum + Math.max(0, block.switchCount), 0)
  ), 0)

  const workstreams = new Map<string, WorkstreamAccumulator>()
  const artifacts = new Map<string, ArtifactAccumulator>()
  let longestBlock: LongestBlock | null = null
  let mostSwitchyBlock: SwitchyBlock | null = null
  let untitledSeconds = 0

  const perDay: DayAccumulator[] = payloads.map((payload) => ({
    date: payload.date,
    shortLabel: toShortLabel(payload.date),
    weekdayLabel: toWeekdayLabel(payload.date),
    trackedSeconds: payload.totalSeconds,
    focusSeconds: payload.focusSeconds,
  }))

  for (const payload of payloads) {
    for (const block of payload.blocks) {
      const blockSeconds = blockDurationSeconds(block)
      const workstreamLabel = normalizeBlockLabel(block)
      const isUntitled = workstreamLabel === UNTITLED_LABEL
      if (isUntitled) untitledSeconds += blockSeconds

      const currentWorkstream = workstreams.get(workstreamLabel) ?? {
        label: workstreamLabel,
        seconds: 0,
        blockCount: 0,
        isUntitled,
      }
      currentWorkstream.seconds += blockSeconds
      currentWorkstream.blockCount += 1
      workstreams.set(workstreamLabel, currentWorkstream)

      if (!longestBlock || blockSeconds > longestBlock.seconds) {
        longestBlock = { label: workstreamLabel, seconds: blockSeconds, date: payload.date }
      }

      // Only treat switchy blocks as "focus breakers" when they are long enough
      // to be a meaningful work block (at least 10 minutes) and have real churn.
      if (block.switchCount >= 3 && blockSeconds >= 600) {
        if (!mostSwitchyBlock || block.switchCount > mostSwitchyBlock.switchCount) {
          mostSwitchyBlock = {
            label: workstreamLabel,
            switchCount: block.switchCount,
            seconds: blockSeconds,
            date: payload.date,
          }
        }
      }

      for (const artifact of block.topArtifacts) {
        const label = normalizeText(artifact.displayTitle)
        if (!label) continue
        const currentArtifact = artifacts.get(label) ?? { label, seconds: 0, mentionCount: 0 }
        currentArtifact.seconds += artifact.totalSeconds > 0 ? artifact.totalSeconds : blockSeconds
        currentArtifact.mentionCount += 1
        artifacts.set(label, currentArtifact)
      }
    }
  }

  const peakDay = perDay.length > 1
    ? [...perDay].sort((left, right) => right.trackedSeconds - left.trackedSeconds)[0] ?? null
    : null

  return {
    hasData: totalSeconds > 0,
    totalSeconds,
    focusSeconds,
    focusPct: totalSeconds > 0 ? Math.round((focusSeconds / totalSeconds) * 100) : 0,
    blockCount,
    focusSessionCount,
    activeDayCount,
    quietDayCount,
    switchCount,
    untitledSeconds,
    longestBlock,
    mostSwitchyBlock,
    peakDay,
    perDay,
    topWorkstreams: [...workstreams.values()].sort((left, right) => right.seconds - left.seconds),
    standoutArtifacts: [...artifacts.values()].sort((left, right) => right.seconds - left.seconds),
  }
}

function buildChapters(
  period: RecapPeriod,
  current: AggregatedRecapStats,
  comparison: AggregatedRecapStats,
  comparisonLabel: string,
  coverage: RecapCoverage,
): RecapChapter[] {
  const chapters: RecapChapter[] = [
    {
      id: 'headline',
      eyebrow: 'Headline',
      title: buildHeadlineTitle(period, current),
      body: buildHeadlineBody(period, current, coverage),
    },
    {
      id: 'focus',
      eyebrow: 'Focus',
      title: buildFocusTitle(current),
      body: buildFocusBody(current),
    },
  ]

  const artifactBody = buildArtifactBody(current)
  if (artifactBody) {
    chapters.push({
      id: 'artifacts',
      eyebrow: 'Artifacts',
      title: 'What showed up most',
      body: artifactBody,
    })
  }

  if (period !== 'day') {
    const rhythmBody = buildRhythmBody(current)
    if (rhythmBody) {
      chapters.push({
        id: 'rhythm',
        eyebrow: 'Rhythm',
        title: 'How the period played out',
        body: rhythmBody,
      })
    }
  }

  if (comparison.hasData) {
    chapters.push({
      id: 'change',
      eyebrow: 'What changed',
      title: buildChangeTitle(current, comparison),
      body: buildChangeSummary(current, comparison, comparisonLabel, period),
    })
  }

  return chapters
}

function buildHeadlineTitle(period: RecapPeriod, stats: AggregatedRecapStats): string {
  const primary = stats.topWorkstreams.find((workstream) => !workstream.isUntitled)
  if (!primary) {
    if (period === 'day') return 'Today was tracked, but unlabeled'
    if (period === 'week') return 'This week is tracked, but mostly unlabeled'
    return 'This month is tracked, but mostly unlabeled'
  }
  if (period === 'day') return `Today leaned on ${primary.label}`
  if (period === 'week') return `This week is anchored in ${primary.label}`
  return `This month is anchored in ${primary.label}`
}

function buildHeadlineBody(period: RecapPeriod, stats: AggregatedRecapStats, coverage: RecapCoverage): string {
  const primary = stats.topWorkstreams.find((workstream) => !workstream.isUntitled)
  const secondary = primary
    ? stats.topWorkstreams.find((workstream) => !workstream.isUntitled && workstream.label !== primary.label)
    : null

  if (!primary) {
    const lead = period === 'day'
      ? `Today captured ${formatDuration(stats.totalSeconds)} across ${stats.blockCount} block${stats.blockCount === 1 ? '' : 's'}, but none of them have a clear workstream label yet.`
      : `${period === 'week' ? 'This week' : 'This month'} captured ${formatDuration(stats.totalSeconds)} across ${stats.activeDayCount} active day${stats.activeDayCount === 1 ? '' : 's'}, but the blocks are mostly unlabeled so the story is thin.`
    return lead
  }

  const lead = period === 'day'
    ? `Today leaned on ${primary.label} for ${formatDuration(primary.seconds)}`
    : `${period === 'week' ? 'This week' : 'This month'} put ${formatDuration(primary.seconds)} into ${primary.label} across ${stats.activeDayCount} active day${stats.activeDayCount === 1 ? '' : 's'}`

  const tail = secondary
    ? `, with ${secondary.label} as the second thread.`
    : '.'

  const coverageSentence = coverage.coverageNote ? ` ${coverage.coverageNote}` : ''
  return `${lead}${tail}${coverageSentence}`
}

function buildFocusTitle(stats: AggregatedRecapStats): string {
  if (stats.focusPct >= 70) return 'Focus held steady'
  if (stats.focusPct >= 40) return 'Focus was mixed'
  return 'Focus was fragmented'
}

function buildFocusBody(stats: AggregatedRecapStats): string {
  const focusLead = stats.totalSeconds > 0
    ? `Focus held for ${formatDuration(stats.focusSeconds)} of ${formatDuration(stats.totalSeconds)} tracked (${stats.focusPct}% deep work).`
    : 'No focused time captured yet.'

  const stretchLine = stats.longestBlock && stats.longestBlock.seconds > 0
    ? ` Deepest stretch: ${formatDuration(stats.longestBlock.seconds)} on ${stats.longestBlock.label}.`
    : ''

  const switchLine = stats.mostSwitchyBlock
    ? ` Focus broke most inside ${stats.mostSwitchyBlock.label} with ${stats.mostSwitchyBlock.switchCount} handoff${stats.mostSwitchyBlock.switchCount === 1 ? '' : 's'}.`
    : ''

  return `${focusLead}${stretchLine}${switchLine}`.trim()
}

function buildArtifactBody(stats: AggregatedRecapStats): string | null {
  if (stats.standoutArtifacts.length === 0) return null
  const items = stats.standoutArtifacts.slice(0, 3).map((item) => item.label)
  if (items.length === 1) return `The work showed up in ${items[0]}.`
  if (items.length === 2) return `The work showed up most in ${items[0]} and ${items[1]}.`
  return `The work showed up most in ${items[0]}, ${items[1]}, and ${items[2]}.`
}

function buildRhythmBody(stats: AggregatedRecapStats): string | null {
  if (stats.perDay.length <= 1) return null

  const parts: string[] = []
  if (stats.peakDay && stats.peakDay.trackedSeconds > 0) {
    parts.push(`Busiest day so far: ${stats.peakDay.weekdayLabel} with ${formatDuration(stats.peakDay.trackedSeconds)} tracked.`)
  }

  if (stats.quietDayCount > 0) {
    parts.push(`${stats.quietDayCount} day${stats.quietDayCount === 1 ? '' : 's'} had no captured activity yet.`)
  }

  if (stats.focusSessionCount > 0) {
    parts.push(`${stats.focusSessionCount} focus session${stats.focusSessionCount === 1 ? '' : 's'} were captured.`)
  }

  if (parts.length === 0) return null
  return parts.join(' ')
}

function buildChangeTitle(current: AggregatedRecapStats, comparison: AggregatedRecapStats): string {
  const trackedDiff = current.totalSeconds - comparison.totalSeconds
  if (trackedDiff > 60 * 10) return 'Heavier than before'
  if (trackedDiff < -60 * 10) return 'Lighter than before'
  return 'A similar shape'
}

function buildChangeSummary(
  current: AggregatedRecapStats,
  comparison: AggregatedRecapStats,
  comparisonLabel: string,
  period: RecapPeriod,
): string {
  if (!comparison.hasData) {
    return period === 'day'
      ? 'Yesterday is still blank or too thin to compare honestly.'
      : period === 'week'
        ? 'Last week does not have enough tracked evidence yet for a grounded comparison.'
        : 'Last month does not have enough tracked evidence yet for a grounded comparison.'
  }

  const trackedDiff = current.totalSeconds - comparison.totalSeconds
  const focusDiff = current.focusPct - comparison.focusPct
  const trackedPart = Math.abs(trackedDiff) < 60
    ? `Tracked time held steady versus ${comparisonLabel}`
    : `Tracked time ${trackedDiff > 0 ? 'rose' : 'fell'} by ${formatDuration(Math.abs(trackedDiff))} versus ${comparisonLabel}`
  const focusPart = Math.abs(focusDiff) < 2
    ? 'while focus share stayed flat'
    : `while focus share ${focusDiff > 0 ? 'improved' : 'slipped'} by ${Math.abs(focusDiff)} point${Math.abs(focusDiff) === 1 ? '' : 's'}`

  const currentTop = firstNamedWorkstream(current)
  const previousTop = firstNamedWorkstream(comparison)
  const workstreamPart = !currentTop || !previousTop
    ? ''
    : currentTop === previousTop
      ? ` ${currentTop} stayed the main thread.`
      : ` The center of gravity shifted from ${previousTop} to ${currentTop}.`

  return `${trackedPart}, ${focusPart}.${workstreamPart}`.trim()
}

function firstNamedWorkstream(stats: AggregatedRecapStats): string | null {
  const named = stats.topWorkstreams.find((workstream) => !workstream.isUntitled)
  return named?.label ?? stats.topWorkstreams[0]?.label ?? null
}

function buildCoverage(stats: AggregatedRecapStats, hasComparison: boolean): RecapCoverage {
  if (!stats.hasData) {
    return {
      attributedPct: 0,
      untitledPct: 0,
      activeDayCount: 0,
      quietDayCount: stats.quietDayCount ?? 0,
      hasComparison,
      coverageNote: null,
    }
  }

  const untitledPct = stats.totalSeconds > 0
    ? Math.round((stats.untitledSeconds / stats.totalSeconds) * 100)
    : 0
  const attributedPct = Math.max(0, 100 - untitledPct)

  const coverageNote = untitledPct >= 20
    ? `About ${untitledPct}% of that time is in unnamed blocks, so the shape is partial.`
    : null

  return {
    attributedPct,
    untitledPct,
    activeDayCount: stats.activeDayCount,
    quietDayCount: stats.quietDayCount,
    hasComparison,
    coverageNote,
  }
}

function buildMetrics(period: RecapPeriod, stats: AggregatedRecapStats): RecapMetric[] {
  const trackedMetric: RecapMetric = {
    label: 'Tracked',
    value: formatDuration(stats.totalSeconds),
    detail: period === 'day'
      ? `${stats.blockCount} work block${stats.blockCount === 1 ? '' : 's'}`
      : `${stats.activeDayCount} active day${stats.activeDayCount === 1 ? '' : 's'}`,
  }

  const focusMetric: RecapMetric = {
    label: 'Focus',
    value: formatDuration(stats.focusSeconds),
    detail: `${stats.focusPct}% of tracked time`,
  }

  const stretchMetric: RecapMetric = {
    label: 'Deepest stretch',
    value: formatDuration(stats.longestBlock?.seconds ?? 0),
    detail: stats.longestBlock?.label ?? 'No clear block yet',
  }

  const switchMetric: RecapMetric = {
    label: 'Context switching',
    value: String(stats.switchCount),
    detail: stats.switchCount === 1 ? '1 handoff across blocks' : `${stats.switchCount} handoffs across blocks`,
  }

  const sessionMetric: RecapMetric = {
    label: 'Focus sessions',
    value: String(stats.focusSessionCount),
    detail: stats.focusSessionCount === 1 ? '1 captured session' : `${stats.focusSessionCount} captured sessions`,
  }

  return period === 'day'
    ? [trackedMetric, focusMetric, stretchMetric, switchMetric]
    : [trackedMetric, focusMetric, stretchMetric, sessionMetric]
}

function buildWorkstreamList(stats: AggregatedRecapStats): RecapListItem[] {
  // Prefer named workstreams in the top three, but still surface untitled time
  // cleanly when it dominates so the UI does not pretend attribution is full.
  const named = stats.topWorkstreams.filter((workstream) => !workstream.isUntitled).slice(0, 3)
  const untitled = stats.topWorkstreams.find((workstream) => workstream.isUntitled)
  const shouldSurfaceUntitled = untitled && (named.length < 3 || untitled.seconds > (named[0]?.seconds ?? 0) / 2)
  const entries = shouldSurfaceUntitled && named.length < 3
    ? [...named, untitled]
    : named

  return entries.slice(0, 3).map((item) => ({
    label: item.isUntitled ? 'Unnamed work blocks' : item.label,
    value: formatDuration(item.seconds),
    detail: `${item.blockCount} block${item.blockCount === 1 ? '' : 's'}`,
  }))
}

function emptySummary(period: RecapPeriod): string {
  switch (period) {
    case 'day':
      return 'No tracked activity yet today. Once Daylens has real work history, this daily recap will reflect actual blocks, artifacts, and focus instead of app vanity metrics.'
    case 'week':
      return 'No tracked activity yet this week. As local history builds up, this weekly recap will show where your time really went and what changed.'
    case 'month':
    default:
      return 'No tracked activity yet this month. When more history is available, this monthly recap will surface real work patterns, standout artifacts, and focus trends.'
  }
}

function emptyHeadline(period: RecapPeriod): string {
  return period === 'day'
    ? 'No tracked activity yet today.'
    : period === 'week'
      ? 'No tracked activity yet this week.'
      : 'No tracked activity yet this month.'
}

function emptyChangeSummary(period: RecapPeriod): string {
  return period === 'day'
    ? 'Yesterday is still blank or too thin to compare honestly.'
    : period === 'week'
      ? 'Last week does not have enough tracked evidence yet for a grounded comparison.'
      : 'Last month does not have enough tracked evidence yet for a grounded comparison.'
}

function emptyChapters(period: RecapPeriod): RecapChapter[] {
  return [{
    id: 'headline',
    eyebrow: 'Headline',
    title: period === 'day' ? 'Today is still a blank page' : period === 'week' ? 'The week is still a blank page' : 'The month is still a blank page',
    body: emptySummary(period),
  }]
}

function emptyMetrics(period: RecapPeriod): RecapMetric[] {
  const dayCountLabel = period === 'day' ? 'Blocks' : 'Active days'
  return [
    { label: 'Tracked', value: '0m', detail: 'No captured time yet' },
    { label: 'Focus', value: '0m', detail: '0% of tracked time' },
    { label: 'Deepest stretch', value: '0m', detail: 'No clear block yet' },
    { label: dayCountLabel, value: '0', detail: period === 'day' ? 'No work blocks yet' : 'No active days yet' },
  ]
}

function promptChipsForPeriod(period: RecapPeriod, stats: AggregatedRecapStats | null): string[] {
  const templates = period === 'day'
    ? DAY_PROMPT_TEMPLATES
    : period === 'week'
      ? WEEK_PROMPT_TEMPLATES
      : MONTH_PROMPT_TEMPLATES

  if (!stats || !stats.hasData) return [...templates]

  const topNamed = stats.topWorkstreams.find((workstream) => !workstream.isUntitled)
  const dynamic: string[] = []
  if (topNamed) {
    dynamic.push(
      period === 'day'
        ? `Tell me more about my time on ${topNamed.label} today`
        : period === 'week'
          ? `Tell me more about ${topNamed.label} this week`
          : `Tell me more about ${topNamed.label} this month`,
    )
  }

  const topArtifact = stats.standoutArtifacts[0]
  if (topArtifact && !/^[A-Z0-9_]{2,}$/i.test(topArtifact.label)) {
    dynamic.push(`What was I doing around ${topArtifact.label}?`)
  }

  return dedupePrompts([...dynamic, ...templates]).slice(0, 4)
}

function dedupePrompts(prompts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const prompt of prompts) {
    const key = prompt.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(prompt)
  }
  return out
}

function toTrendPoint(payload: DayTimelinePayload): RecapTrendPoint {
  return {
    date: payload.date,
    shortLabel: toShortLabel(payload.date),
    trackedSeconds: payload.totalSeconds,
    focusSeconds: payload.focusSeconds,
  }
}

function toShortLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

function toWeekdayLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(year, month - 1, day))
}

function emptyDayPayload(date: string): DayTimelinePayload {
  return {
    date,
    sessions: [],
    websites: [],
    blocks: [],
    segments: [],
    focusSessions: [],
    computedAt: 0,
    version: 'empty',
    totalSeconds: 0,
    focusSeconds: 0,
    focusPct: 0,
    appCount: 0,
    siteCount: 0,
  }
}

function normalizeBlockLabel(block: WorkContextBlock): string {
  return normalizeText(block.label.current) || normalizeText(block.label.override) || UNTITLED_LABEL
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function blockDurationSeconds(block: WorkContextBlock): number {
  return Math.max(1, Math.round((block.endTime - block.startTime) / 1000))
}

function dayDistanceInclusive(startDate: string, endDate: string): number {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number)
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number)
  const start = new Date(startYear, startMonth - 1, startDay).getTime()
  const end = new Date(endYear, endMonth - 1, endDay).getTime()
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1)
}

function toDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}
