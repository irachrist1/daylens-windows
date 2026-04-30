import type Database from 'better-sqlite3'
import { getAppSummariesForRange, getPeakHours, getSessionsForRange, getWebsiteSummariesForRange } from '../db/queries'
import type { AppCategory, AppSession, AppUsageSummary, WebsiteSummary } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import { computeFocusScore } from '../lib/focusScore'
import { deriveWorkEvidenceSummary, type WorkEvidenceSignal } from '../lib/workEvidence'
import {
  buildClientInvoiceNarrativeForRange,
  buildProjectInvoiceNarrativeForRange,
  compareClientsForRange,
  findClientByName,
  findProjectByName,
  getTrackedWorkRange,
  listClients,
  listClientsForRange,
  listProjects,
  resolveClientAmbiguitiesForRange,
  resolveClientAppBreakdownForRange,
  resolveClientEvidenceForRange,
  resolveEvidenceBackedAppBreakdownForRange,
  resolveEvidenceBackedQuery,
  resolveEvidenceBackedTimelineForRange,
  resolveClientQuery,
  resolveClientTimelineForRange,
  resolveProjectAppBreakdownForRange,
  resolveProjectEvidenceForRange,
  resolveProjectQuery,
  resolveProjectTimelineForRange,
  type AmbiguityEntry,
  type ClientEvidenceItem,
  type ClientPortfolioEntry,
  type ClientQueryPayload,
  type ProjectQueryPayload,
} from '../core/query/attributionResolvers'
import { getTimelineDayPayload, userVisibleLabelForBlock } from '../services/workBlocks'
import { resolveWeeklyBriefContext, type WeeklyBriefContext } from './weeklyBrief'

export type EntityIntent =
  | 'portfolio'
  | 'comparison'
  | 'evidence'
  | 'timeline'
  | 'appBreakdown'
  | 'ambiguity'
  | 'invoice'
  | 'time'

export interface EntityContext {
  entityId: string
  entityName: string
  entityType: 'client' | 'project' | 'evidence'
  rangeStartMs: number
  rangeEndMs: number
  rangeLabel: string
  intent: EntityIntent
}

export interface TemporalContext {
  date: Date
  timeWindow: { start: Date; end: Date } | null
  weeklyBrief: WeeklyBriefContext | null
  entity: EntityContext | null
}

export type RouterResult =
  | {
    kind: 'answer'
    answer: string
    resolvedContext: TemporalContext
  }
  | {
    kind: 'weeklyBrief'
    briefContext: WeeklyBriefContext
    resolvedContext: TemporalContext
  }

const FOLLOW_UP_PATTERNS = [
  'that time',
  'at that point',
  'then',
  'doing what',
  'what exactly',
  'that moment',
]

function dayBounds(date: Date): [number, number] {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.getTime(), end.getTime()]
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function startOfQuarter(date: Date): Date {
  const quarterMonth = Math.floor(date.getMonth() / 3) * 3
  return new Date(date.getFullYear(), quarterMonth, 1)
}

function startOfYear(date: Date): Date {
  return new Date(date.getFullYear(), 0, 1)
}

function nextDay(date: Date): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + 1)
  return next
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function sessionEnd(session: AppSession): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1000)
}

function isMeaningfulSession(session: AppSession): boolean {
  return session.durationSeconds >= 60 && session.category !== 'system' && session.category !== 'uncategorized'
}

function isFocusedSession(session: AppSession): boolean {
  return session.isFocused || FOCUSED_CATEGORIES.includes(session.category)
}

function isDistractingSignal(signal: WorkEvidenceSignal): boolean {
  return signal.category === 'entertainment' || signal.category === 'social'
}

function isNonFocusSignal(signal: WorkEvidenceSignal): boolean {
  return !FOCUSED_CATEGORIES.includes(signal.category) && signal.category !== 'system'
}

function formatSignal(signal: WorkEvidenceSignal): string {
  return `${signal.label} (${formatDuration(signal.seconds)})`
}

function formatSignalList(signals: WorkEvidenceSignal[], limit = 3): string {
  return signals.slice(0, limit).map(formatSignal).join(', ')
}

function sortedSessions(sessions: AppSession[]): AppSession[] {
  return [...sessions].sort((left, right) => left.startTime - right.startTime)
}

function latestMeaningfulSession(sessions: AppSession[]): AppSession | null {
  for (let index = sessions.length - 1; index >= 0; index--) {
    if (isMeaningfulSession(sessions[index])) return sessions[index]
  }
  return null
}

function latestFocusedSession(sessions: AppSession[]): AppSession | null {
  for (let index = sessions.length - 1; index >= 0; index--) {
    if (isFocusedSession(sessions[index])) return sessions[index]
  }
  return null
}

function longestFocusedStretch(sessions: AppSession[]): number {
  const ordered = sortedSessions(sessions).filter(isFocusedSession)
  if (ordered.length === 0) return 0

  let longest = ordered[0].durationSeconds
  let current = ordered[0].durationSeconds
  let lastEnd = sessionEnd(ordered[0])

  for (const session of ordered.slice(1)) {
    const gapSeconds = (session.startTime - lastEnd) / 1000
    if (gapSeconds <= 5 * 60) {
      current += session.durationSeconds
    } else {
      longest = Math.max(longest, current)
      current = session.durationSeconds
    }
    lastEnd = sessionEnd(session)
  }

  return Math.max(longest, current)
}

function buildEvidence(apps: AppUsageSummary[], sites: WebsiteSummary[], sessions: AppSession[]) {
  return deriveWorkEvidenceSummary({
    appSummaries: apps,
    websiteSummaries: sites,
    sessions,
  })
}

function buildWorkThreadAnswer(
  apps: AppUsageSummary[],
  sites: WebsiteSummary[],
  sessions: AppSession[],
  resolvedPrefix: string,
): string | null {
  if (apps.length === 0 && sites.length === 0 && sessions.length === 0) return null

  const evidence = buildEvidence(apps, sites, sessions)
  const latest = resolvedPrefix === 'Resume'
    ? latestFocusedSession(sessions) ?? latestMeaningfulSession(sessions)
    : latestMeaningfulSession(sessions)
  const signals = formatSignalList(evidence.signals, 3)
  const focusMinutes = Math.round(evidence.focusedSeconds / 60)
  const taskLabel = evidence.task.label.toLowerCase()

  if (!latest) {
    return `${resolvedPrefix} ${taskLabel}. The clearest signals were ${signals}.`
  }

  const end = formatTime(sessionEnd(latest))
  const start = formatTime(latest.startTime)
  const sessionLabel = latest.appName
  const focusText = focusMinutes > 0 ? `, with about ${formatDuration(evidence.focusedSeconds)} in focused apps` : ''

  return `${resolvedPrefix} ${taskLabel}. The latest meaningful thread was ${sessionLabel} from ${start} to ${end}${focusText}. Strongest signals: ${signals}.`
}

function buildDistractionAnswer(apps: AppUsageSummary[], sites: WebsiteSummary[], sessions: AppSession[]): string | null {
  if (apps.length === 0 && sites.length === 0) return null

  const evidence = buildEvidence(apps, sites, sessions)
  const distractingSignals = evidence.signals.filter(isDistractingSignal)
  const nonFocusSignals = evidence.signals.filter(isNonFocusSignal)
  const topSignals = distractingSignals.length > 0 ? distractingSignals : nonFocusSignals

  if (topSignals.length === 0) {
    return "I don't see one obvious distraction sink in the tracked data for that period."
  }

  const label = distractingSignals.length > 0 ? 'the clearest distraction pull' : 'the strongest non-focus pull'
  return `${topSignals[0].label} was ${label} at ${formatDuration(topSignals[0].seconds)}. Other signals: ${formatSignalList(topSignals, 3)}.`
}

function buildFocusScoreAnswer(apps: AppUsageSummary[], sessions: AppSession[], sites: WebsiteSummary[]): string | null {
  if (apps.length === 0 && sessions.length === 0 && sites.length === 0) return null

  const evidence = buildEvidence(apps, sites, sessions)
  const totalSeconds = Math.max(evidence.totalSeconds, apps.reduce((sum, app) => sum + app.totalSeconds, 0))
  const focusSeconds = evidence.focusedSeconds
  const switchesPerHour = totalSeconds > 0 ? Math.max(0, sessions.length - 1) / Math.max(totalSeconds / 3600, 0.25) : 0
  const score = computeFocusScore({
    focusedSeconds: focusSeconds,
    totalSeconds,
    switchesPerHour,
    sessions: sessions.map((session) => ({
      durationSeconds: session.durationSeconds,
      isFocused: isFocusedSession(session),
    })),
  })
  const longestStretch = longestFocusedStretch(sessions)

  return [
    `Focus score: ${score}/100.`,
    longestStretch > 0 ? `Longest focused stretch was ${formatDuration(longestStretch)}.` : null,
    sessions.length > 1 ? `Context switching ran at about ${Math.round(switchesPerHour)}/hour.` : null,
    `Strongest evidence: ${formatSignalList(evidence.signals, 3)}.`,
  ].filter(Boolean).join(' ')
}

function buildTimelineSummary(apps: AppUsageSummary[], sites: WebsiteSummary[], sessions: AppSession[]): string | null {
  if (sessions.length === 0 && apps.length === 0 && sites.length === 0) return null
  const evidence = buildEvidence(apps, sites, sessions)
  const recent = sortedSessions(sessions)
    .slice(-5)
    .map((session) => {
      const end = sessionEnd(session)
      return `${formatTime(session.startTime)}-${formatTime(end)}: ${session.appName}`
    })

  const parts = [
    `${evidence.task.label}.`,
    recent.length > 0 ? `Recent timeline: ${recent.join('; ')}.` : null,
    `Signals: ${formatSignalList(evidence.signals, 3)}.`,
  ].filter(Boolean)

  return parts.join(' ')
}

function resolveTargetDate(question: string, defaultDate: Date, previousContext: TemporalContext | null): Date {
  const normalized = question.toLowerCase()
  const reference = previousContext?.date ?? defaultDate
  const calendarDate = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate())

  if (normalized.includes('yesterday')) {
    calendarDate.setDate(calendarDate.getDate() - 1)
    return calendarDate
  }
  if (normalized.includes('today')) return new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate())

  const weekdayMatch = normalized.match(/\b(last|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/)
  if (weekdayMatch) {
    const weekdayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    }
    const modifier = weekdayMatch[1] ?? 'this'
    const targetWeekday = weekdayMap[weekdayMatch[2]]
    const result = new Date(calendarDate)
    const currentWeekday = result.getDay()
    let delta = targetWeekday - currentWeekday
    if (modifier === 'last') {
      if (delta >= 0) delta -= 7
    } else if (modifier === 'this' && delta > 0) {
      delta -= 7
    }
    result.setDate(result.getDate() + delta)
    return result
  }

  if (FOLLOW_UP_PATTERNS.some((pattern) => normalized.includes(pattern)) && previousContext) {
    return new Date(previousContext.date.getFullYear(), previousContext.date.getMonth(), previousContext.date.getDate())
  }

  return new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate())
}

function shiftWindowToDate(window: { start: Date; end: Date }, date: Date): { start: Date; end: Date } | null {
  const shiftedStart = new Date(date)
  shiftedStart.setHours(window.start.getHours(), window.start.getMinutes(), window.start.getSeconds(), 0)
  const shiftedEnd = new Date(date)
  shiftedEnd.setHours(window.end.getHours(), window.end.getMinutes(), window.end.getSeconds(), 0)
  if (shiftedEnd <= shiftedStart) return null
  return { start: shiftedStart, end: shiftedEnd }
}

function parseHour(hour: number, meridiem?: string): number | null {
  if (hour < 0 || hour > 24) return null
  if (!meridiem) {
    if (hour >= 1 && hour <= 6) return hour + 12
    return hour
  }
  const lower = meridiem.toLowerCase()
  if (lower === 'am') return hour === 12 ? 0 : hour
  if (lower === 'pm') return hour === 12 ? 12 : hour + 12
  return null
}

function resolveTimeWindow(question: string, resolvedDate: Date, previousContext: TemporalContext | null): { start: Date; end: Date } | null {
  const normalized = question.toLowerCase()

  if (FOLLOW_UP_PATTERNS.some((pattern) => normalized.includes(pattern)) && previousContext?.timeWindow) {
    return shiftWindowToDate(previousContext.timeWindow, resolvedDate)
  }

  const twelveHourMatches = Array.from(question.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi))
  if (twelveHourMatches.length >= 1) {
    const parsed = twelveHourMatches
      .map((match) => {
        const hour = parseHour(Number(match[1]), match[3])
        const minute = Number(match[2] ?? '0')
        if (hour === null || minute < 0 || minute > 59) return null
        const date = new Date(resolvedDate)
        date.setHours(hour, minute, 0, 0)
        return date
      })
      .filter((value): value is Date => value !== null)
    if (parsed.length >= 2) {
      return { start: parsed[0], end: parsed[1] }
    }
    if (parsed.length === 1) {
      return {
        start: new Date(parsed[0].getTime() - 10 * 60_000),
        end: new Date(parsed[0].getTime() + 10 * 60_000),
      }
    }
  }

  const twentyFourHourMatches = Array.from(question.matchAll(/\b(\d{1,2}):(\d{2})\b/g))
  if (twentyFourHourMatches.length >= 1) {
    const parsed = twentyFourHourMatches
      .map((match) => {
        const hour = Number(match[1])
        const minute = Number(match[2])
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
        const date = new Date(resolvedDate)
        date.setHours(hour, minute, 0, 0)
        return date
      })
      .filter((value): value is Date => value !== null)
    if (parsed.length >= 2) return { start: parsed[0], end: parsed[1] }
    if (parsed.length === 1) {
      return {
        start: new Date(parsed[0].getTime() - 10 * 60_000),
        end: new Date(parsed[0].getTime() + 10 * 60_000),
      }
    }
  }

  const bareHour = normalized.match(/(?:at|around|before|after)\s+(\d{1,2})(?:\b|$)/)
  if (bareHour) {
    const hour = parseHour(Number(bareHour[1]))
    if (hour !== null) {
      const date = new Date(resolvedDate)
      date.setHours(hour, 0, 0, 0)
      return {
        start: new Date(date.getTime() - 10 * 60_000),
        end: new Date(date.getTime() + 10 * 60_000),
      }
    }
  }

  return null
}

function resolveTemporalContext(question: string, defaultDate: Date, previousContext: TemporalContext | null): TemporalContext {
  const date = resolveTargetDate(question, defaultDate, previousContext)
  return {
    date,
    timeWindow: resolveTimeWindow(question, date, previousContext),
    weeklyBrief: previousContext?.weeklyBrief ?? null,
    entity: previousContext?.entity ?? null,
  }
}

function isWeeklyQuestion(normalized: string): boolean {
  return normalized.includes('this week') || normalized.includes('last week')
}

function isYesterdayQuestion(normalized: string): boolean {
  return normalized.includes('yesterday')
}

function isAllTimeQuestion(normalized: string): boolean {
  const patterns = [
    'across all',
    'all time',
    'all-time',
    'all sessions',
    'all tracked',
    'total ever',
    'since i started',
    'since you started',
    'historically',
    'since tracking',
    'all my tracked',
    'all-time total',
    'total across',
  ]
  return patterns.some((pattern) => normalized.includes(pattern))
}

function isFocusedCategory(category: AppCategory): boolean {
  return FOCUSED_CATEGORIES.includes(category)
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function relativeDayLabel(date: Date, reference: Date = new Date()): string {
  const sameDay =
    date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate()
  if (sameDay) return 'Today'

  const yesterday = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate())
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  if (isYesterday) return 'Yesterday'

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function formatCategoryName(category: AppCategory): string {
  if (category === 'aiTools') return 'AI Tools'
  return category
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function rankedCategoryBreakdown(apps: AppUsageSummary[]): Array<{ category: AppCategory; totalSeconds: number }> {
  const categoryTotals = new Map<AppCategory, number>()
  for (const app of apps) {
    categoryTotals.set(app.category, (categoryTotals.get(app.category) ?? 0) + app.totalSeconds)
  }
  return [...categoryTotals.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([category, totalSeconds]) => ({ category, totalSeconds }))
}

function largestChangeAnswer(date: Date, db: Database.Database): string | null {
  const [currentFrom, currentTo] = dayBounds(date)
  const currentApps = getAppSummariesForRange(db, currentFrom, currentTo)
  if (currentApps.length === 0) return null

  const previousDate = new Date(date)
  previousDate.setDate(previousDate.getDate() - 1)
  const [previousFrom, previousTo] = dayBounds(previousDate)
  const previousApps = getAppSummariesForRange(db, previousFrom, previousTo)

  const baselineLabel = previousApps.length > 0 ? 'yesterday' : 'your 7-day average'
  const currentCategoryTotals = new Map<AppCategory, number>()
  const baselineCategoryTotals = new Map<AppCategory, number>()
  const currentAppTotals = new Map<string, { label: string; totalSeconds: number }>()
  const baselineAppTotals = new Map<string, { label: string; totalSeconds: number }>()

  for (const app of currentApps) {
    currentCategoryTotals.set(app.category, (currentCategoryTotals.get(app.category) ?? 0) + app.totalSeconds)
    currentAppTotals.set(app.bundleId, { label: app.appName, totalSeconds: app.totalSeconds })
  }

  if (previousApps.length > 0) {
    for (const app of previousApps) {
      baselineCategoryTotals.set(app.category, (baselineCategoryTotals.get(app.category) ?? 0) + app.totalSeconds)
      baselineAppTotals.set(app.bundleId, { label: app.appName, totalSeconds: app.totalSeconds })
    }
  } else {
    for (let offset = 1; offset <= 7; offset++) {
      const sampleDate = new Date(date)
      sampleDate.setDate(sampleDate.getDate() - offset)
      const [sampleFrom, sampleTo] = dayBounds(sampleDate)
      const sampleApps = getAppSummariesForRange(db, sampleFrom, sampleTo)
      for (const app of sampleApps) {
        baselineCategoryTotals.set(app.category, (baselineCategoryTotals.get(app.category) ?? 0) + app.totalSeconds / 7)
        const existing = baselineAppTotals.get(app.bundleId)
        baselineAppTotals.set(app.bundleId, {
          label: app.appName,
          totalSeconds: (existing?.totalSeconds ?? 0) + (app.totalSeconds / 7),
        })
      }
    }
  }

  const candidates: Array<{ label: string; currentSeconds: number; baselineSeconds: number; deltaSeconds: number }> = []
  const collectCandidate = (label: string, currentSeconds: number, baselineSeconds: number) => {
    const deltaSeconds = currentSeconds - baselineSeconds
    if (deltaSeconds === 0) return
    candidates.push({ label, currentSeconds, baselineSeconds, deltaSeconds })
  }

  for (const category of new Set([...currentCategoryTotals.keys(), ...baselineCategoryTotals.keys()])) {
    collectCandidate(
      formatCategoryName(category),
      currentCategoryTotals.get(category) ?? 0,
      Math.round(baselineCategoryTotals.get(category) ?? 0),
    )
  }

  for (const bundleId of new Set([...currentAppTotals.keys(), ...baselineAppTotals.keys()])) {
    collectCandidate(
      currentAppTotals.get(bundleId)?.label ?? baselineAppTotals.get(bundleId)?.label ?? bundleId,
      currentAppTotals.get(bundleId)?.totalSeconds ?? 0,
      Math.round(baselineAppTotals.get(bundleId)?.totalSeconds ?? 0),
    )
  }

  const bestChange = candidates.sort((left, right) => Math.abs(right.deltaSeconds) - Math.abs(left.deltaSeconds))[0] ?? null
  if (!bestChange) return null

  const direction = bestChange.deltaSeconds > 0 ? 'up' : 'down'
  return `Biggest change: ${bestChange.label}, ${direction} ${formatDuration(Math.abs(bestChange.deltaSeconds))} vs ${baselineLabel} (current ${formatDuration(bestChange.currentSeconds)}, baseline ${formatDuration(bestChange.baselineSeconds)}).`
}

function peakFocusWindowAnswer(date: Date, db: Database.Database): string | null {
  const [, dayEnd] = dayBounds(date)
  const peakHours = getPeakHours(db, dayEnd - 14 * 86_400_000, dayEnd)
  if (!peakHours) return "I need at least a few days of tracked activity before I can estimate your peak focus window."
  return `Peak focus window: ${formatTime(new Date(date.getFullYear(), date.getMonth(), date.getDate(), peakHours.peakStart, 0, 0, 0).getTime())}-${formatTime(new Date(date.getFullYear(), date.getMonth(), date.getDate(), peakHours.peakEnd, 0, 0, 0).getTime())} (${peakHours.focusPct}% focus).`
}

function rankedTimeAllocationAnswer(apps: AppUsageSummary[]): string | null {
  const ranked = rankedCategoryBreakdown(apps)
  if (ranked.length === 0) return null
  return [
    'Category breakdown:',
    ...ranked.map((item, index) => `${index + 1}. ${formatCategoryName(item.category)} — ${formatDuration(item.totalSeconds)}`),
  ].join('\n')
}

function dailyTopCategoryAnswer(apps: AppUsageSummary[], sites: WebsiteSummary[]): string | null {
  if (apps.length === 0 && sites.length === 0) return null
  const evidence = buildEvidence(apps, sites, [])
  const topApp = apps[0] ? `Top app: ${apps[0].appName} (${formatDuration(apps[0].totalSeconds)}).` : null
  const topSite = sites[0] ? `Top site: ${sites[0].domain} (${formatDuration(sites[0].totalSeconds)}).` : null
  return [
    `Most of your time went to ${evidence.task.label.toLowerCase()}.`,
    topApp,
    topSite,
    `Strongest evidence: ${formatSignalList(evidence.signals, 3)}.`,
  ].filter(Boolean).join(' ')
}

function aggregateDayArtifacts(date: Date, db: Database.Database) {
  const payload = getTimelineDayPayload(db, localDateString(date), null)
  const blocks = payload.blocks.filter((block) => (block.endTime - block.startTime) >= 3 * 60_000)
  const artifactTotals = new Map<string, {
    title: string
    subtitle: string | null
    totalSeconds: number
  }>()

  for (const block of blocks) {
    for (const artifact of block.topArtifacts) {
      const title = artifact.displayTitle.trim()
      if (!title) continue
      const subtitle = artifact.subtitle?.trim() || artifact.host || artifact.path || null
      const key = artifact.id || `${artifact.artifactType}:${title}:${subtitle ?? ''}`
      const existing = artifactTotals.get(key)
      if (existing) {
        existing.totalSeconds += artifact.totalSeconds
      } else {
        artifactTotals.set(key, {
          title,
          subtitle,
          totalSeconds: artifact.totalSeconds,
        })
      }
    }
  }

  const artifacts = [...artifactTotals.values()]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)

  const pages = new Map<string, { title: string; domain: string | null; totalSeconds: number }>()
  const windowTitles = new Map<string, { title: string; appName: string; totalSeconds: number }>()
  const apps = new Map<string, { appName: string; totalSeconds: number }>()

  for (const block of blocks) {
    for (const page of block.pageRefs) {
      const title = (page.pageTitle ?? page.displayTitle).trim()
      if (!title) continue
      const key = `${page.domain}:${title}`.toLowerCase()
      const existing = pages.get(key)
      if (existing) {
        existing.totalSeconds += page.totalSeconds
      } else {
        pages.set(key, { title, domain: page.domain, totalSeconds: page.totalSeconds })
      }
    }

    for (const session of block.sessions) {
      const title = session.windowTitle?.trim()
      if (
        title
        && !/^(new tab|untitled|home|start page)$/i.test(title)
        && title.toLowerCase() !== session.appName.toLowerCase()
      ) {
        const key = `${session.bundleId}:${title}`.toLowerCase()
        const existing = windowTitles.get(key)
        if (existing) {
          existing.totalSeconds += session.durationSeconds
        } else {
          windowTitles.set(key, { title, appName: session.appName, totalSeconds: session.durationSeconds })
        }
      }
    }

    for (const app of block.topApps) {
      if (app.category === 'system') continue
      const key = app.appName.toLowerCase()
      const existing = apps.get(key)
      if (existing) {
        existing.totalSeconds += app.totalSeconds
      } else {
        apps.set(key, { appName: app.appName, totalSeconds: app.totalSeconds })
      }
    }
  }

  const bySeconds = <T extends { totalSeconds: number }>(items: Iterable<T>) =>
    [...items].sort((left, right) => right.totalSeconds - left.totalSeconds)

  return {
    payload,
    blocks,
    artifacts,
    pages: bySeconds(pages.values()),
    windowTitles: bySeconds(windowTitles.values()),
    apps: bySeconds(apps.values()),
  }
}

function describeBlockDetail(block: ReturnType<typeof getTimelineDayPayload>['blocks'][number]): string {
  const artifacts = block.topArtifacts
    .slice(0, 2)
    .map((artifact) => artifact.displayTitle.trim())
    .filter(Boolean)
  if (artifacts.length > 0) return artifacts.join(', ')

  const sites = block.websites
    .slice(0, 2)
    .map((site) => site.domain.replace(/^www\./, ''))
    .filter(Boolean)
  if (sites.length > 0) return sites.join(', ')

  const apps = block.topApps
    .filter((app) => app.category !== 'system')
    .slice(0, 2)
    .map((app) => app.appName)
  return apps.join(', ')
}

function buildDayBlocksAnswer(date: Date, db: Database.Database, header?: string): string | null {
  const { payload, blocks, artifacts } = aggregateDayArtifacts(date, db)
  if (payload.totalSeconds === 0 && blocks.length === 0) return null

  const label = header ?? relativeDayLabel(date)
  const lines: string[] = [
    `${label}: ${formatDuration(payload.totalSeconds)} tracked, focus ${payload.focusPct}%.`,
  ]

  if (blocks.length > 0) {
    lines.push('Main blocks:')
    for (const block of blocks.slice(0, 4)) {
      const detail = describeBlockDetail(block)
      lines.push(
        `- ${formatTime(block.startTime)}-${formatTime(block.endTime)}: ${userVisibleLabelForBlock(block)}${detail ? ` — ${detail}` : ''}`,
      )
    }
  }

  if (artifacts.length > 0) {
    lines.push(`Key artifacts: ${artifacts.slice(0, 5).map((artifact) => artifact.title).join(', ')}.`)
  }

  return lines.join('\n')
}

function buildArtifactAnswer(date: Date, db: Database.Database): string | null {
  const { payload, artifacts, pages, windowTitles, apps } = aggregateDayArtifacts(date, db)
  if (payload.totalSeconds === 0) return null
  if (artifacts.length === 0 && pages.length === 0 && windowTitles.length === 0) return null

  const label = relativeDayLabel(date)
  const lines = [
    artifacts.length > 0
      ? `[${label} — file and doc evidence]`
      : `[${label} — no clear file/doc names; page, window-title, and app evidence follows]`,
  ]

  if (artifacts.length > 0) {
    lines.push(...artifacts.slice(0, 8).map((artifact, index) =>
      `${index + 1}. ${artifact.title}${artifact.subtitle ? ` — ${artifact.subtitle}` : ''} (${formatDuration(Math.round(artifact.totalSeconds))})`,
    ))
  }

  if (pages.length > 0) {
    lines.push('Pages:')
    lines.push(...pages.slice(0, 6).map((page) =>
      `- ${page.title}${page.domain ? ` — ${page.domain}` : ''} (${formatDuration(Math.round(page.totalSeconds))})`,
    ))
  }

  if (windowTitles.length > 0) {
    lines.push('Window titles:')
    lines.push(...windowTitles.slice(0, 6).map((item) =>
      `- ${item.title} in ${item.appName} (${formatDuration(Math.round(item.totalSeconds))})`,
    ))
  }

  if (apps.length > 0) {
    lines.push(`Apps involved: ${apps.slice(0, 5).map((app) => `${app.appName} (${formatDuration(Math.round(app.totalSeconds))})`).join(', ')}.`)
  }

  return lines.join('\n')
}

function buildComparisonAnswer(date: Date, db: Database.Database): string | null {
  const previousDate = new Date(date)
  previousDate.setDate(previousDate.getDate() - 1)

  const today = aggregateDayArtifacts(date, db)
  const previous = aggregateDayArtifacts(previousDate, db)
  if (today.payload.totalSeconds === 0 && previous.payload.totalSeconds === 0) return null

  const todayLead = today.blocks[0] ? userVisibleLabelForBlock(today.blocks[0]) : null
  const previousLead = previous.blocks[0] ? userVisibleLabelForBlock(previous.blocks[0]) : null
  const todayArtifacts = today.artifacts.slice(0, 2).map((artifact) => artifact.title).join(', ')
  const previousArtifacts = previous.artifacts.slice(0, 2).map((artifact) => artifact.title).join(', ')

  return [
    `Today vs yesterday: ${formatDuration(today.payload.totalSeconds)} vs ${formatDuration(previous.payload.totalSeconds)} tracked.`,
    `Focus: ${today.payload.focusPct}% today vs ${previous.payload.focusPct}% yesterday.`,
    todayLead || previousLead
      ? `Main thread: ${todayLead ? `today was "${todayLead}"` : 'today had no clear dominant block'}; ${previousLead ? `yesterday was "${previousLead}"` : 'yesterday had no clear dominant block'}.`
      : null,
    todayArtifacts || previousArtifacts
      ? `Artifacts shifted from ${previousArtifacts || 'no clear artifacts yesterday'} to ${todayArtifacts || 'no clear artifacts today'}.`
      : null,
  ].filter(Boolean).join('\n')
}

function durationMatchAnswer(normalized: string, apps: AppUsageSummary[], sites: WebsiteSummary[]): string | null {
  for (const app of apps) {
    if (normalized.includes(app.appName.toLowerCase())) {
      return `You spent ${formatDuration(app.totalSeconds)} in ${app.appName}.`
    }
  }
  for (const site of sites) {
    if (normalized.includes(site.domain.toLowerCase())) {
      return `You spent ${formatDuration(site.totalSeconds)} on ${site.domain}.`
    }
  }
  const categories: AppCategory[] = [
    'development',
    'communication',
    'research',
    'writing',
    'aiTools',
    'design',
    'browsing',
    'meetings',
    'entertainment',
    'email',
    'productivity',
    'social',
    'system',
    'uncategorized',
  ]
  for (const category of categories) {
    if (!normalized.includes(category.toLowerCase())) continue
    const totalSeconds = apps
      .filter((app) => app.category === category)
      .reduce((sum, app) => sum + app.totalSeconds, 0)
    if (totalSeconds > 0) {
      return `You spent ${formatDuration(totalSeconds)} in ${category}.`
    }
  }
  return null
}

function exactMomentAnswer(window: { start: Date; end: Date }, sessions: AppSession[], sites: WebsiteSummary[]): string | null {
  if (sessions.length === 0) return 'No tracked activity in that time window.'
  const midpoint = new Date((window.start.getTime() + window.end.getTime()) / 2)
  const topSession = sessions
    .map((session) => {
      const end = session.endTime ?? (session.startTime + session.durationSeconds * 1000)
      const overlap = Math.max(0, Math.min(end, window.end.getTime()) - Math.max(session.startTime, window.start.getTime()))
      return { session, overlap }
    })
    .sort((left, right) => right.overlap - left.overlap)[0]?.session

  if (!topSession) return 'No tracked activity in that time window.'
  const isBrowser = topSession.category === 'browsing'
  const topSite = sites[0]
  const evidence = buildEvidence([], sites, sessions)
  if (isBrowser && topSite) {
    return `At ${formatTime(midpoint.getTime())}, you were on ${topSite.domain}${topSite.topTitle ? ` viewing "${topSite.topTitle}".` : '.'} Strongest signals: ${formatSignalList(evidence.signals, 3)}.`
  }
  return `At ${formatTime(midpoint.getTime())}, you were in ${topSession.appName}. Strongest signals: ${formatSignalList(evidence.signals, 3)}.`
}

function timeRangeAnswer(window: { start: Date; end: Date }, sessions: AppSession[], sites: WebsiteSummary[]): string | null {
  const durationMs = window.end.getTime() - window.start.getTime()
  if (durationMs <= 30 * 60_000) {
    return exactMomentAnswer(window, sessions, sites)
  }
  if (sessions.length === 0) return 'No tracked activity in that time window.'
  const evidence = buildEvidence([], sites, sessions)
  const topSessions = [...sessions]
    .sort((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, 3)
    .map((session) => `${session.appName} (${formatDuration(session.durationSeconds)})`)
  return `Between ${formatTime(window.start.getTime())} and ${formatTime(window.end.getTime())}, the main thread was ${evidence.task.label.toLowerCase()}. Top sessions: ${topSessions.join(', ')}. Strongest signals: ${formatSignalList(evidence.signals, 3)}.`
}

interface ResolvedRange {
  startMs: number
  endMs: number
  label: string
}

interface RoutedEntityAnswer {
  answer: string
  entityContext: EntityContext | null
}

type ResolvedEntity =
  | {
    entityType: 'client'
    id: string
    name: string
  }
  | {
    entityType: 'project'
    id: string
    name: string
    clientId: string
    clientName: string
  }
  | {
    entityType: 'evidence'
    id: string
    name: string
  }

const SINGLE_ENTITY_PATTERNS = [
  /(?:how (?:many|much) (?:hours?|time))\s+(?:did i|have i|i)\s+(?:spend|spent|log(?:ged)?|work(?:ed)?)\s+(?:on|for|with|at)\s+['"]?(.+?)['"]?(?:\s+(?:this|last|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\s*\?|$)/i,
  /(?:hours?|time)\s+(?:on|for|with)\s+['"]?([A-Za-z][\w\s&.-]{1,40})['"]?/i,
  /(?:what (?:did i|was i) (?:work(?:ing)?|do(?:ing)?) (?:on|for))\s+['"]?([A-Za-z][\w\s&.-]{1,40})['"]?/i,
  /\bwhich\s+(.+?)\s+(?:emails?|workbooks?|docs?|documents?|tabs?)\b/i,
  /\b(?:which|what)\s+(?:docs?|documents?|tabs?)\s+(?:matched|for|on)\s+(.+?)(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
  /\bbreak\s+(.+?)\s+down\s+by\s+app\b/i,
  /\bshow\s+(?:the\s+)?(.+?)\s+timeline\b/i,
  /\bif i had to invoice\s+(.+?)(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
]

const COMPARISON_PATTERNS = [
  /\bcompare\s+(.+?)\s+(?:vs|versus)\s+(.+?)(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
  /\b(.+?)\s+(?:vs|versus)\s+(.+?)(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
  /\bambiguous between\s+(.+?)\s+and\s+(.+?)(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
  /\bcompare\s+(.+?)\s+and\s+(.+?)(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
]

function formatDurationMs(durationMs: number): string {
  return formatDuration(Math.max(0, Math.round(durationMs / 1000)))
}

function humanList(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function lastTrackedRange(db: Database.Database): ResolvedRange | null {
  const tracked = getTrackedWorkRange(db)
  if (!tracked) return null
  return {
    startMs: tracked.startMs,
    endMs: tracked.endMs,
    label: 'all tracked history',
  }
}

function resolveQuestionRange(
  normalized: string,
  context: TemporalContext,
  db: Database.Database,
  preferAllTrackedTime = false,
): ResolvedRange {
  if (isAllTimeQuestion(normalized) || preferAllTrackedTime) {
    const tracked = lastTrackedRange(db)
    if (tracked) return tracked
  }

  if (normalized.includes('this week') || normalized.includes('last week')) {
    const end = new Date(context.date)
    end.setHours(23, 59, 59, 999)
    const start = new Date(end)
    start.setDate(start.getDate() - 6)
    start.setHours(0, 0, 0, 0)
    return {
      startMs: start.getTime(),
      endMs: end.getTime() + 1,
      label: normalized.includes('last week') ? 'last week' : 'this week',
    }
  }

  if (normalized.includes('last month')) {
    const currentMonthStart = startOfMonth(context.date)
    const previousMonthStart = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1)
    return {
      startMs: previousMonthStart.getTime(),
      endMs: currentMonthStart.getTime(),
      label: 'last month',
    }
  }

  if (normalized.includes('this month')) {
    const currentMonthStart = startOfMonth(context.date)
    return {
      startMs: currentMonthStart.getTime(),
      endMs: nextDay(startOfDay(context.date)).getTime(),
      label: 'this month',
    }
  }

  if (normalized.includes('last quarter')) {
    const currentQuarterStart = startOfQuarter(context.date)
    const previousQuarterStart = new Date(currentQuarterStart.getFullYear(), currentQuarterStart.getMonth() - 3, 1)
    return {
      startMs: previousQuarterStart.getTime(),
      endMs: currentQuarterStart.getTime(),
      label: 'last quarter',
    }
  }

  if (normalized.includes('this quarter')) {
    const currentQuarterStart = startOfQuarter(context.date)
    return {
      startMs: currentQuarterStart.getTime(),
      endMs: nextDay(startOfDay(context.date)).getTime(),
      label: 'this quarter',
    }
  }

  if (normalized.includes('last year')) {
    const currentYearStart = startOfYear(context.date)
    const previousYearStart = new Date(currentYearStart.getFullYear() - 1, 0, 1)
    return {
      startMs: previousYearStart.getTime(),
      endMs: currentYearStart.getTime(),
      label: 'last year',
    }
  }

  if (normalized.includes('this year')) {
    const currentYearStart = startOfYear(context.date)
    return {
      startMs: currentYearStart.getTime(),
      endMs: nextDay(startOfDay(context.date)).getTime(),
      label: 'this year',
    }
  }

  const [startMs, endMs] = dayBounds(context.date)
  return {
    startMs,
    endMs,
    label: relativeDayLabel(context.date),
  }
}

function timePhraseRegex(): RegExp {
  return /\b(this week|last week|this month|last month|this quarter|last quarter|this year|last year|today|yesterday|all time|all-time|across all|all tracked|since tracking|historically)\b/i
}

function cleanEntityName(raw: string): string {
  return raw
    .replace(/\b(this week|last week|this month|last month|this quarter|last quarter|this year|last year|today|yesterday|all time|all-time|across all|all tracked|since tracking|historically)\b/gi, '')
    .replace(/[?.!,:]+$/g, '')
    .trim()
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function detectClientMentions(question: string, db: Database.Database): Array<{ id: string; name: string }> {
  const normalized = question.toLowerCase()
  return listClients(db)
    .filter((client) => new RegExp(`\\b${escapeRegex(client.name.toLowerCase())}\\b`, 'i').test(normalized))
    .map((client) => ({ id: client.id, name: client.name }))
}

function detectProjectMentions(
  question: string,
  db: Database.Database,
): Array<{ id: string; name: string; clientId: string; clientName: string }> {
  const normalized = question.toLowerCase()
  return listProjects(db)
    .filter((project) => new RegExp(`\\b${escapeRegex(project.name.toLowerCase())}\\b`, 'i').test(normalized))
    .map((project) => ({
      id: project.id,
      name: project.name,
      clientId: project.client_id,
      clientName: project.client_name,
    }))
}

function extractSingleClient(question: string, previousContext: TemporalContext | null, db: Database.Database): { id: string; name: string } | null {
  for (const pattern of SINGLE_ENTITY_PATTERNS) {
    const match = question.match(pattern)
    if (!match?.[1]) continue
    const candidate = cleanEntityName(match[1])
    if (!candidate) continue
    const client = findClientByName(candidate, db)
    if (client) return client
  }

  const mentions = detectClientMentions(question, db)
  if (mentions.length >= 1) return mentions[0]

  if (previousContext?.entity?.entityType === 'client') {
    return {
      id: previousContext.entity.entityId,
      name: previousContext.entity.entityName,
    }
  }

  return null
}

function extractSingleProject(
  question: string,
  previousContext: TemporalContext | null,
  db: Database.Database,
): { id: string; name: string; clientId: string; clientName: string } | null {
  for (const pattern of SINGLE_ENTITY_PATTERNS) {
    const match = question.match(pattern)
    if (!match?.[1]) continue
    const candidate = cleanEntityName(match[1])
    if (!candidate) continue
    const project = findProjectByName(candidate, db)
    if (project) {
      const client = listProjects(db).find((item) => item.id === project.id)
      if (client) {
        return {
          id: client.id,
          name: client.name,
          clientId: client.client_id,
          clientName: client.client_name,
        }
      }
    }
  }

  const mentions = detectProjectMentions(question, db)
  if (mentions.length >= 1) return mentions[0]

  if (previousContext?.entity?.entityType === 'project') {
    const project = listProjects(db).find((item) => item.id === previousContext.entity?.entityId)
    if (project) {
      return {
        id: project.id,
        name: project.name,
        clientId: project.client_id,
        clientName: project.client_name,
      }
    }
    return {
      id: previousContext.entity.entityId,
      name: previousContext.entity.entityName,
      clientId: '',
      clientName: '',
    }
  }

  return null
}

function extractComparisonClients(question: string, db: Database.Database): Array<{ id: string; name: string }> | null {
  for (const pattern of COMPARISON_PATTERNS) {
    const match = question.match(pattern)
    if (!match?.[1] || !match?.[2]) continue
    const left = findClientByName(cleanEntityName(match[1]), db)
    const right = findClientByName(cleanEntityName(match[2]), db)
    if (left && right && left.id !== right.id) return [left, right]
  }

  const mentions = detectClientMentions(question, db)
  if (mentions.length >= 2) return mentions.slice(0, 2)

  return null
}

function isClientListQuestion(normalized: string): boolean {
  return normalized.includes('list all my clients')
    || normalized.includes('who are my clients')
    || normalized.includes('time per client')
    || normalized.includes('clientele')
}

function isComparisonQuestion(normalized: string): boolean {
  return normalized.includes(' vs ')
    || normalized.includes(' versus ')
    || normalized.startsWith('compare ')
}

function isEntityEvidenceQuestion(normalized: string): boolean {
  return normalized.includes('doc')
    || normalized.includes('tab')
    || normalized.includes('email')
    || normalized.includes('workbook')
}

function isEntityTimelineQuestion(normalized: string): boolean {
  return normalized.includes('timeline')
}

function isEntityAppBreakdownQuestion(normalized: string): boolean {
  return normalized.includes('break') && normalized.includes('down by app')
}

function isEntityAmbiguityQuestion(normalized: string): boolean {
  return normalized.includes('ambiguous')
}

function isEntityInvoiceQuestion(normalized: string): boolean {
  return normalized.includes('invoice')
    || normalized.includes('line items')
    || normalized.includes('bill')
}

function isEntityTimeQuestion(normalized: string): boolean {
  return normalized.includes('how much time')
    || normalized.includes('how many hours')
    || normalized.includes('how long')
    || normalized.includes('time spent')
    || normalized.includes('hours on')
    || normalized.includes('what have i been doing')
    || normalized.includes('what was i doing')
}

function workItemDayLabel(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function buildWorkItemLines<
  T extends {
    start: string
    active_ms: number
    title: string | null
    project_name: string | null
    apps: Array<{ app_name: string }>
    evidence: Array<{ value: string }>
  },
>(sessions: T[], fallbackLabel: string): string[] {
  const grouped = new Map<string, {
    label: string
    durationMs: number
    appNames: Set<string>
    evidenceLabels: Set<string>
    dayLabels: Set<string>
  }>()

  for (const session of sessions) {
    const label = session.title?.trim() || session.project_name || fallbackLabel
    const key = label.toLowerCase()
    const existing = grouped.get(key) ?? {
      label,
      durationMs: 0,
      appNames: new Set<string>(),
      evidenceLabels: new Set<string>(),
      dayLabels: new Set<string>(),
    }
    existing.durationMs += session.active_ms
    existing.dayLabels.add(workItemDayLabel(session.start))
    for (const app of session.apps.slice(0, 3)) {
      if (app.app_name.trim()) existing.appNames.add(app.app_name.trim())
    }
    for (const item of session.evidence.slice(0, 3)) {
      if (item.value.trim()) existing.evidenceLabels.add(item.value.trim())
    }
    grouped.set(key, existing)
  }

  return [...grouped.values()]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5)
    .map((item) => {
      const apps = [...item.appNames].slice(0, 3)
      const evidence = [...item.evidenceLabels].slice(0, 2)
      const days = [...item.dayLabels]
      const daySummary = days.length > 1 ? ` across ${days.length} days` : days[0] ? ` on ${days[0]}` : ''
      const appSummary = apps.length > 0 ? ` via ${humanList(apps)}` : ''
      const evidenceSummary = evidence.length > 0 ? `. Evidence: ${humanList(evidence)}` : ''
      return `- ${item.label} — ${formatDurationMs(item.durationMs)}${daySummary}${appSummary}${evidenceSummary}`
    })
}

function buildAppBreakdownFromSessions<
  T extends {
    apps: Array<{ app_name: string; duration_ms: number; role: string }>
  },
>(sessions: T[]): Array<{ app_name: string; duration_ms: number; session_count: number; roles: string[] }> {
  const apps = new Map<string, { app_name: string; duration_ms: number; session_count: number; roles: Set<string> }>()

  for (const session of sessions) {
    for (const app of session.apps) {
      const existing = apps.get(app.app_name) ?? {
        app_name: app.app_name,
        duration_ms: 0,
        session_count: 0,
        roles: new Set<string>(),
      }
      existing.duration_ms += app.duration_ms
      existing.session_count += 1
      existing.roles.add(app.role)
      apps.set(app.app_name, existing)
    }
  }

  return [...apps.values()]
    .sort((left, right) => right.duration_ms - left.duration_ms)
    .map((entry) => ({
      app_name: entry.app_name,
      duration_ms: entry.duration_ms,
      session_count: entry.session_count,
      roles: [...entry.roles],
    }))
}

function buildEntityContext(
  entity: ResolvedEntity,
  range: ResolvedRange,
  intent: EntityIntent,
): EntityContext {
  return {
    entityId: entity.id,
    entityName: entity.name,
    entityType: entity.entityType,
    rangeStartMs: range.startMs,
    rangeEndMs: range.endMs,
    rangeLabel: range.label,
    intent,
  }
}

function topEvidenceLabels(items: ClientEvidenceItem[], limit = 3): string[] {
  return items
    .map((item) => item.label.trim())
    .filter(Boolean)
    .slice(0, limit)
}

function buildClientTimeAnswer(payload: ClientQueryPayload, rangeLabel: string): string {
  const { totals } = payload
  if (totals.session_count === 0) {
    return `No tracked work sessions for ${payload.target.client_name} in ${rangeLabel}.`
  }

  const activeDayCount = new Set(payload.sessions.map((session) => workItemDayLabel(session.start))).size
  const workItems = buildWorkItemLines(payload.sessions, payload.target.client_name)

  return [
    `${payload.target.client_name} in ${rangeLabel}: ${formatDurationMs(totals.attributed_ms)} attributed${totals.ambiguous_ms > 0 ? `, plus ${formatDurationMs(totals.ambiguous_ms)} ambiguous` : ''}, across ${totals.session_count} session${totals.session_count === 1 ? '' : 's'} on ${activeDayCount} active day${activeDayCount === 1 ? '' : 's'}.`,
    workItems.length > 0 ? 'Main work:' : null,
    ...workItems,
  ].filter(Boolean).join('\n')
}

function buildProjectTimeAnswer(payload: ProjectQueryPayload, rangeLabel: string): string {
  const { totals } = payload
  if (totals.session_count === 0) {
    return `No tracked work sessions for ${payload.target.project_name} in ${rangeLabel}.`
  }

  const activeDayCount = new Set(payload.sessions.map((session) => workItemDayLabel(session.start))).size
  const workItems = buildWorkItemLines(payload.sessions, payload.target.project_name)

  return [
    `${payload.target.project_name} in ${rangeLabel}: ${formatDurationMs(totals.attributed_ms)} attributed${payload.target.client_name ? ` for ${payload.target.client_name}` : ''}${totals.ambiguous_ms > 0 ? `, plus ${formatDurationMs(totals.ambiguous_ms)} ambiguous` : ''}, across ${totals.session_count} session${totals.session_count === 1 ? '' : 's'} on ${activeDayCount} active day${activeDayCount === 1 ? '' : 's'}.`,
    workItems.length > 0 ? 'Main work:' : null,
    ...workItems,
  ].filter(Boolean).join('\n')
}

function buildClientListAnswer(entries: ClientPortfolioEntry[], rangeLabel: string): string | null {
  if (entries.length === 0) return null
  return [
    `Clients in ${rangeLabel}:`,
    ...entries.slice(0, 8).map((entry, index) =>
      `${index + 1}. ${entry.client_name} — ${formatDurationMs(entry.attributed_ms)} attributed${entry.ambiguous_ms > 0 ? `, ${formatDurationMs(entry.ambiguous_ms)} ambiguous` : ''}, ${entry.session_count} session${entry.session_count === 1 ? '' : 's'}${entry.project_names.length > 0 ? ` (${entry.project_names.slice(0, 2).join(', ')})` : ''}`,
    ),
  ].join('\n')
}

function buildClientComparisonAnswer(
  comparison: NonNullable<ReturnType<typeof compareClientsForRange>>,
  leftEvidence: ClientEvidenceItem[],
  rightEvidence: ClientEvidenceItem[],
  rangeLabel: string,
): string {
  const { left, right, winner_client_id } = comparison
  const leftDiff = left.totals.attributed_ms - right.totals.attributed_ms
  const verdict = winner_client_id === null
    ? `${left.target.client_name} and ${right.target.client_name} were effectively tied in ${rangeLabel}.`
    : `Comparing ${left.target.client_name} vs ${right.target.client_name} in ${rangeLabel}: ${winner_client_id === left.target.client_id ? left.target.client_name : right.target.client_name} took more attributed time by ${formatDurationMs(Math.abs(leftDiff))}.`

  return [
    verdict,
    `- ${left.target.client_name}: ${formatDurationMs(left.totals.attributed_ms)} attributed${left.totals.ambiguous_ms > 0 ? `, ${formatDurationMs(left.totals.ambiguous_ms)} ambiguous` : ''}. Main artifacts: ${humanList(topEvidenceLabels(leftEvidence, 3)) || 'none'}.`,
    `- ${right.target.client_name}: ${formatDurationMs(right.totals.attributed_ms)} attributed${right.totals.ambiguous_ms > 0 ? `, ${formatDurationMs(right.totals.ambiguous_ms)} ambiguous` : ''}. Main artifacts: ${humanList(topEvidenceLabels(rightEvidence, 3)) || 'none'}.`,
  ].join('\n')
}

function buildClientEvidenceAnswer(
  clientName: string,
  rangeLabel: string,
  items: ClientEvidenceItem[],
  normalized: string,
): string | null {
  const filtered = items.filter((item) => {
    if (normalized.includes('emails')) return item.kind === 'email'
    if (normalized.includes('workbooks')) return item.kind === 'workbook'
    if (normalized.includes('docs') || normalized.includes('documents')) return item.kind === 'document' || item.kind === 'workbook' || item.kind === 'file'
    if (normalized.includes('tabs')) return item.kind === 'tab'
    return item.kind !== 'unknown'
  })

  const ranked = (filtered.length > 0 ? filtered : items).slice(0, 8)
  if (ranked.length === 0) return null

  return [
    `${clientName} evidence in ${rangeLabel}:`,
    ...ranked.map((item, index) =>
      `${index + 1}. ${item.label} — ${item.kind}${item.app_names.length > 0 ? ` via ${humanList(item.app_names.slice(0, 2))}` : ''}`,
    ),
  ].join('\n')
}

function buildClientAppBreakdownAnswer(
  clientName: string,
  rangeLabel: string,
  apps: NonNullable<ReturnType<typeof resolveClientAppBreakdownForRange>>['apps'],
  ambiguousMs: number,
): string | null {
  if (apps.length === 0) return null
  return [
    `${clientName} by app in ${rangeLabel}:`,
    ...apps.slice(0, 8).map((app, index) =>
      `${index + 1}. ${app.app_name} — ${formatDurationMs(app.duration_ms)} across ${app.session_count} session${app.session_count === 1 ? '' : 's'}`,
    ),
    ambiguousMs > 0 ? `Ambiguous time kept separate: ${formatDurationMs(ambiguousMs)}.` : null,
  ].filter(Boolean).join('\n')
}

function buildClientTimelineAnswer(
  clientName: string,
  rangeLabel: string,
  sessions: NonNullable<ReturnType<typeof resolveClientTimelineForRange>>['sessions'],
): string | null {
  if (sessions.length === 0) return null
  return [
    `${clientName} timeline for ${rangeLabel}:`,
    ...sessions.slice(0, 8).map((session) => {
      const start = new Date(session.start)
      const end = new Date(session.end)
      const lead = session.title?.trim() || session.project_name || clientName
      const apps = session.apps.slice(0, 2).map((app) => app.app_name).join(', ')
      const confidence = session.confidence ? ` (${Math.round(session.confidence * 100)}%)` : ''
      return `- ${formatTime(start.getTime())}-${formatTime(end.getTime())}: ${lead}${apps ? ` — ${apps}` : ''}${confidence}`
    }),
  ].join('\n')
}

function buildClientAmbiguityAnswer(
  clientName: string,
  rangeLabel: string,
  ambiguities: AmbiguityEntry[],
  relatedClientName?: string,
): string | null {
  const filtered = relatedClientName
    ? ambiguities.filter((entry) => entry.candidates.some((candidate) => candidate.client_name === relatedClientName))
    : ambiguities
  if (filtered.length === 0) return null

  return [
    `Ambiguous ${clientName} sessions in ${rangeLabel}:`,
    ...filtered.slice(0, 6).map((entry) => {
      const start = new Date(entry.start)
      const end = new Date(entry.end)
      const candidates = entry.candidates
        .map((candidate) => `${candidate.client_name ?? 'Unattributed'} (${Math.round(candidate.confidence * 100)}%)`)
        .join(', ')
      return `- ${formatTime(start.getTime())}-${formatTime(end.getTime())}: ${candidates}. Reason: ${entry.reason ?? 'low confidence'}`
    }),
  ].join('\n')
}

function buildClientInvoiceAnswer(
  invoice: NonNullable<ReturnType<typeof buildClientInvoiceNarrativeForRange>>,
  rangeLabel: string,
): string {
  return [
    `Invoice narrative for ${invoice.target.client_name} in ${rangeLabel}:`,
    ...invoice.line_items.slice(0, 6).map((item) =>
      `- ${item.label} — ${formatDurationMs(item.duration_ms)}${item.app_names.length > 0 ? ` in ${humanList(item.app_names.slice(0, 2))}` : ''}${item.evidence.length > 0 ? `. Evidence: ${humanList(item.evidence.slice(0, 2))}` : ''}`,
    ),
    invoice.ambiguous_ms > 0
      ? `Exclude as uncertain: ${formatDurationMs(invoice.ambiguous_ms)} ambiguous time${invoice.ambiguous_sessions.length > 0 ? ` across ${invoice.ambiguous_sessions.length} session${invoice.ambiguous_sessions.length === 1 ? '' : 's'}` : ''}.`
      : null,
  ].filter(Boolean).join('\n')
}

function buildProjectInvoiceAnswer(
  invoice: NonNullable<ReturnType<typeof buildProjectInvoiceNarrativeForRange>>,
  rangeLabel: string,
): string {
  return [
    `Invoice narrative for ${invoice.target.project_name} in ${rangeLabel}:`,
    ...invoice.line_items.slice(0, 6).map((item) =>
      `- ${item.label} — ${formatDurationMs(item.duration_ms)}${item.app_names.length > 0 ? ` in ${humanList(item.app_names.slice(0, 2))}` : ''}${item.evidence.length > 0 ? `. Evidence: ${humanList(item.evidence.slice(0, 2))}` : ''}`,
    ),
    invoice.ambiguous_ms > 0
      ? `Exclude as uncertain: ${formatDurationMs(invoice.ambiguous_ms)} ambiguous time${invoice.ambiguous_sessions.length > 0 ? ` across ${invoice.ambiguous_sessions.length} session${invoice.ambiguous_sessions.length === 1 ? '' : 's'}` : ''}.`
      : null,
  ].filter(Boolean).join('\n')
}

function buildProjectAmbiguityAnswer(
  payload: ProjectQueryPayload,
  rangeLabel: string,
): string | null {
  const ambiguousSessions = payload.sessions.filter((session) => session.attribution_status === 'ambiguous')
  if (ambiguousSessions.length === 0) return null

  return [
    `Ambiguous ${payload.target.project_name} sessions in ${rangeLabel}:`,
    ...ambiguousSessions.slice(0, 6).map((session) => {
      const start = new Date(session.start)
      const end = new Date(session.end)
      const apps = session.apps.slice(0, 2).map((app) => app.app_name).join(', ')
      const confidence = session.confidence ? ` (${Math.round(session.confidence * 100)}%)` : ''
      const lead = session.title?.trim() || payload.target.project_name
      return `- ${formatTime(start.getTime())}-${formatTime(end.getTime())}: ${lead}${apps ? ` — ${apps}` : ''}${confidence}`
    }),
    'Project-level ambiguity means these sessions touched the project but still carried uncertain attribution.',
  ].join('\n')
}

const EVIDENCE_ENTITY_PATTERNS = [
  /\bwhat have i been doing\s+(?:for|on|with)\s+['"]?(.+?)['"]?(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
  /\bwhat was i (?:doing|working on)\s+(?:for|on|with)\s+['"]?(.+?)['"]?(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
  /\bhow much time.*?(?:for|on|with)\s+['"]?(.+?)['"]?(?:\s+(?:this|last|today|yesterday)|[?.!,]|$)/i,
  /\bbreak\s+(.+?)\s+down\s+by\s+app\b/i,
  /\bshow\s+(?:the\s+)?(.+?)\s+timeline\b/i,
]

const EVIDENCE_PLACEHOLDER_TERMS = new Set(['it', 'that', 'this', 'them', 'those', 'these'])

function extractEvidenceEntity(question: string, previousContext: TemporalContext | null): string | null {
  for (const pattern of EVIDENCE_ENTITY_PATTERNS) {
    const match = question.match(pattern)
    if (!match?.[1]) continue
    const candidate = cleanEntityName(match[1])
    if (candidate && !EVIDENCE_PLACEHOLDER_TERMS.has(candidate.toLowerCase())) return candidate
  }

  if (previousContext?.entity?.entityType === 'evidence') {
    return previousContext.entity.entityName
  }

  return null
}

function buildEvidenceBackedTimeAnswer(
  payload: NonNullable<ReturnType<typeof resolveEvidenceBackedQuery>>,
  rangeLabel: string,
): string {
  const workItems = buildWorkItemLines(payload.sessions, payload.target.label)
  const topApps = buildAppBreakdownFromSessions(payload.sessions)

  return [
    `${payload.target.label} in ${rangeLabel} (evidence-backed): ${formatDurationMs(payload.totals.matched_ms)} matched across ${payload.totals.session_count} session${payload.totals.session_count === 1 ? '' : 's'}.`,
    workItems.length > 0 ? 'Main work:' : null,
    ...workItems,
    topApps.length > 0 ? `Top apps: ${topApps.slice(0, 4).map((app) => `${app.app_name} (${formatDurationMs(app.duration_ms)})`).join(', ')}.` : null,
    payload.totals.ambiguous_ms > 0 ? `Ambiguous time inside the match: ${formatDurationMs(payload.totals.ambiguous_ms)}.` : null,
    payload.totals.structured_ms > 0
      ? `This answer mixes first-class attribution with evidence-matched sessions where Daylens only had titles, files, emails, or tabs for ${payload.target.label}.`
      : `Structured client/project attribution was missing here, so this answer is grounded in titles, files, emails, and tab evidence mentioning ${payload.target.label}.`,
  ].filter(Boolean).join('\n')
}

function buildEvidenceBackedTimelineAnswer(
  label: string,
  rangeLabel: string,
  sessions: NonNullable<ReturnType<typeof resolveEvidenceBackedTimelineForRange>>['sessions'],
): string | null {
  if (sessions.length === 0) return null
  return [
    `${label} timeline for ${rangeLabel} (evidence-backed):`,
    ...sessions.slice(0, 8).map((session) => {
      const start = new Date(session.start)
      const end = new Date(session.end)
      const lead = session.title?.trim() || session.project_name || label
      const apps = session.apps.slice(0, 2).map((app) => app.app_name).join(', ')
      return `- ${formatTime(start.getTime())}-${formatTime(end.getTime())}: ${lead}${apps ? ` — ${apps}` : ''}`
    }),
  ].join('\n')
}

function tryRouteEntityQuestion(
  normalized: string,
  question: string,
  context: TemporalContext,
  previousContext: TemporalContext | null,
  db: Database.Database,
): RoutedEntityAnswer | null {
  if (context.timeWindow) return null

  if (isClientListQuestion(normalized)) {
    const range = resolveQuestionRange(normalized, context, db, !timePhraseRegex().test(question))
    const clients = listClientsForRange(range.startMs, range.endMs, db)
    const answer = buildClientListAnswer(clients, range.label)
    return answer ? { answer, entityContext: null } : null
  }

  const comparisonClients = extractComparisonClients(question, db)
  if (comparisonClients && (isComparisonQuestion(normalized) || isEntityAmbiguityQuestion(normalized))) {
    const [leftClient, rightClient] = comparisonClients
    const range = resolveQuestionRange(normalized, context, db)
    if (isEntityAmbiguityQuestion(normalized)) {
      const ambiguities = resolveClientAmbiguitiesForRange(leftClient.id, range.startMs, range.endMs, question, db)
      const answer = buildClientAmbiguityAnswer(leftClient.name, range.label, ambiguities, rightClient.name)
      return answer
        ? { answer, entityContext: buildEntityContext({ ...leftClient, entityType: 'client' }, range, 'ambiguity') }
        : null
    }

    const comparison = compareClientsForRange(leftClient.id, rightClient.id, range.startMs, range.endMs, question, db)
    if (!comparison) return null
    const leftEvidence = resolveClientEvidenceForRange(leftClient.id, range.startMs, range.endMs, question, db)?.items ?? []
    const rightEvidence = resolveClientEvidenceForRange(rightClient.id, range.startMs, range.endMs, question, db)?.items ?? []
    return {
      answer: buildClientComparisonAnswer(comparison, leftEvidence, rightEvidence, range.label),
      entityContext: buildEntityContext({ ...leftClient, entityType: 'client' }, range, 'comparison'),
    }
  }

  const range = previousContext?.entity && !timePhraseRegex().test(question)
    ? {
      startMs: previousContext.entity.rangeStartMs,
      endMs: previousContext.entity.rangeEndMs,
      label: previousContext.entity.rangeLabel,
    }
    : resolveQuestionRange(normalized, context, db)

  const project = extractSingleProject(question, previousContext, db)
  if (project) {
    if (isEntityEvidenceQuestion(normalized)) {
      const evidence = resolveProjectEvidenceForRange(project.id, range.startMs, range.endMs, question, db)
      const answer = evidence ? buildClientEvidenceAnswer(project.name, range.label, evidence.items, normalized) : null
      if (answer) {
        return { answer, entityContext: buildEntityContext({ ...project, entityType: 'project' }, range, 'evidence') }
      }
    }

    if (isEntityTimelineQuestion(normalized)) {
      const timeline = resolveProjectTimelineForRange(project.id, range.startMs, range.endMs, question, db)
      const answer = timeline ? buildClientTimelineAnswer(project.name, range.label, timeline.sessions) : null
      if (answer) {
        return { answer, entityContext: buildEntityContext({ ...project, entityType: 'project' }, range, 'timeline') }
      }
    }

    if (isEntityAppBreakdownQuestion(normalized)) {
      const breakdown = resolveProjectAppBreakdownForRange(project.id, range.startMs, range.endMs, question, db)
      const payload = resolveProjectQuery(project.id, range.startMs, range.endMs, question, db)
      const answer = breakdown && payload
        ? buildClientAppBreakdownAnswer(project.name, range.label, breakdown.apps, payload.totals.ambiguous_ms)
        : null
      if (answer) {
        return { answer, entityContext: buildEntityContext({ ...project, entityType: 'project' }, range, 'appBreakdown') }
      }
    }

    if (isEntityInvoiceQuestion(normalized)) {
      const invoice = buildProjectInvoiceNarrativeForRange(project.id, range.startMs, range.endMs, question, db)
      const answer = invoice ? buildProjectInvoiceAnswer(invoice, range.label) : null
      return answer
        ? { answer, entityContext: buildEntityContext({ ...project, entityType: 'project' }, range, 'invoice') }
        : null
    }

    if (isEntityAmbiguityQuestion(normalized)) {
      const payload = resolveProjectQuery(project.id, range.startMs, range.endMs, question, db)
      const answer = payload ? buildProjectAmbiguityAnswer(payload, range.label) : null
      if (answer) {
        return { answer, entityContext: buildEntityContext({ ...project, entityType: 'project' }, range, 'ambiguity') }
      }
    }

    if (isEntityTimeQuestion(normalized)) {
      const payload = resolveProjectQuery(project.id, range.startMs, range.endMs, question, db)
      if (payload?.totals.session_count) {
        return {
          answer: buildProjectTimeAnswer(payload, range.label),
          entityContext: buildEntityContext({ ...project, entityType: 'project' }, range, 'time'),
        }
      }
    }
  }

  const client = extractSingleClient(question, previousContext, db)
  if (client && isEntityEvidenceQuestion(normalized)) {
    const evidence = resolveClientEvidenceForRange(client.id, range.startMs, range.endMs, question, db)
    const answer = evidence ? buildClientEvidenceAnswer(client.name, range.label, evidence.items, normalized) : null
    if (answer) {
      return { answer, entityContext: buildEntityContext({ ...client, entityType: 'client' }, range, 'evidence') }
    }
  }

  if (client && isEntityTimelineQuestion(normalized)) {
    const timeline = resolveClientTimelineForRange(client.id, range.startMs, range.endMs, question, db)
    const answer = timeline ? buildClientTimelineAnswer(client.name, range.label, timeline.sessions) : null
    if (answer) {
      return { answer, entityContext: buildEntityContext({ ...client, entityType: 'client' }, range, 'timeline') }
    }
  }

  if (client && isEntityAppBreakdownQuestion(normalized)) {
    const breakdown = resolveClientAppBreakdownForRange(client.id, range.startMs, range.endMs, question, db)
    const payload = resolveClientQuery(client.id, range.startMs, range.endMs, question, db)
    const answer = breakdown && payload
      ? buildClientAppBreakdownAnswer(client.name, range.label, breakdown.apps, payload.totals.ambiguous_ms)
      : null
    if (answer) {
      return { answer, entityContext: buildEntityContext({ ...client, entityType: 'client' }, range, 'appBreakdown') }
    }
  }

  if (client && isEntityInvoiceQuestion(normalized)) {
    const invoice = buildClientInvoiceNarrativeForRange(client.id, range.startMs, range.endMs, question, db)
    const answer = invoice ? buildClientInvoiceAnswer(invoice, range.label) : null
    return answer
      ? { answer, entityContext: buildEntityContext({ ...client, entityType: 'client' }, range, 'invoice') }
      : null
  }

  if (client && isEntityAmbiguityQuestion(normalized)) {
    const ambiguities = resolveClientAmbiguitiesForRange(client.id, range.startMs, range.endMs, question, db)
    const answer = buildClientAmbiguityAnswer(client.name, range.label, ambiguities)
    if (answer) {
      return { answer, entityContext: buildEntityContext({ ...client, entityType: 'client' }, range, 'ambiguity') }
    }
  }

  if (client && isEntityTimeQuestion(normalized)) {
    const payload = resolveClientQuery(client.id, range.startMs, range.endMs, question, db)
    if (payload?.totals.session_count) {
      return {
        answer: buildClientTimeAnswer(payload, range.label),
        entityContext: buildEntityContext({ ...client, entityType: 'client' }, range, 'time'),
      }
    }
  }

  const evidenceEntity = extractEvidenceEntity(question, previousContext)
  if (!evidenceEntity) return null

  if (isEntityTimelineQuestion(normalized)) {
    const timeline = resolveEvidenceBackedTimelineForRange(evidenceEntity, range.startMs, range.endMs, question, db)
    const answer = timeline ? buildEvidenceBackedTimelineAnswer(evidenceEntity, range.label, timeline.sessions) : null
    return answer
      ? { answer, entityContext: buildEntityContext({ entityType: 'evidence', id: evidenceEntity.toLowerCase(), name: evidenceEntity }, range, 'timeline') }
      : null
  }

  if (isEntityAppBreakdownQuestion(normalized)) {
    const breakdown = resolveEvidenceBackedAppBreakdownForRange(evidenceEntity, range.startMs, range.endMs, question, db)
    const answer = breakdown
      ? buildClientAppBreakdownAnswer(`${evidenceEntity} (evidence-backed)`, range.label, breakdown.apps, 0)
      : null
    return answer
      ? { answer, entityContext: buildEntityContext({ entityType: 'evidence', id: evidenceEntity.toLowerCase(), name: evidenceEntity }, range, 'appBreakdown') }
      : null
  }

  if (isEntityTimeQuestion(normalized)) {
    const payload = resolveEvidenceBackedQuery(evidenceEntity, range.startMs, range.endMs, question, db)
    if (!payload) return null
    return {
      answer: buildEvidenceBackedTimeAnswer(payload, range.label),
      entityContext: buildEntityContext({ entityType: 'evidence', id: evidenceEntity.toLowerCase(), name: evidenceEntity }, range, 'time'),
    }
  }

  return null
}

export async function routeInsightsQuestion(
  question: string,
  defaultDate: Date,
  previousContext: TemporalContext | null,
  db: Database.Database,
): Promise<RouterResult | null> {
  const trimmed = question.trim()
  if (!trimmed) return null

  const normalized = trimmed.toLowerCase()
  const resolvedContext = resolveTemporalContext(trimmed, defaultDate, previousContext)

  if (process.env.NODE_ENV === 'development') {
    console.log(`[router] q="${trimmed.slice(0, 80)}" allTime=${isAllTimeQuestion(normalized)} weekly=${isWeeklyQuestion(normalized)} yesterday=${isYesterdayQuestion(normalized)}`)
  }
  if (resolvedContext.timeWindow) {
    const sessions = getSessionsForRange(db, resolvedContext.timeWindow.start.getTime(), resolvedContext.timeWindow.end.getTime())
    const sites = getWebsiteSummariesForRange(db, resolvedContext.timeWindow.start.getTime(), resolvedContext.timeWindow.end.getTime())
    const answer = timeRangeAnswer(resolvedContext.timeWindow, sessions, sites)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  // ─── Client/entity attribution routing ───────────────────────────────────
  const entityAnswer = tryRouteEntityQuestion(normalized, trimmed, resolvedContext, previousContext, db)
  if (entityAnswer) {
    return {
      kind: 'answer',
      answer: entityAnswer.answer,
      resolvedContext: {
        ...resolvedContext,
        weeklyBrief: null,
        entity: entityAnswer.entityContext,
      },
    }
  }

  // ─── All-time / across-all-sessions routing ───────────────────────────────
  if (isAllTimeQuestion(normalized)) {
    const toMs = Date.now()
    const fromMs = toMs - 2 * 365 * 24 * 60 * 60 * 1000
    const allTimeSites = getWebsiteSummariesForRange(db, fromMs, toMs)
    const allTimeApps = getAppSummariesForRange(db, fromMs, toMs)

    if (process.env.NODE_ENV === 'development') {
      console.log(`[router] allTime branch: sites=${allTimeSites.length} apps=${allTimeApps.length}`)
    }
    if (allTimeSites.length === 0 && allTimeApps.length === 0) return null

    const allTimeContext: TemporalContext = { date: new Date(), timeWindow: null, weeklyBrief: null, entity: null }
    const firstSession = (db.prepare('SELECT MIN(start_time) as t FROM app_sessions').get() as { t: number | null } | undefined)?.t
    const trackingDays = firstSession
      ? Math.max(1, Math.round((toMs - firstSession) / (24 * 60 * 60 * 1000)))
      : Math.max(1, Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)))

    const DISTRACTION_DOMAINS = [
      'youtube.com', 'x.com', 'twitter.com', 'instagram.com',
      'reddit.com', 'tiktok.com', 'netflix.com', 'facebook.com',
    ]

    // If specific sites or apps are named in the question, surface only those
    const mentionedSites = allTimeSites.filter((site) => {
      const base = site.domain.toLowerCase().replace(/\.com$|\.org$|\.net$|\.io$/, '')
      return normalized.includes(site.domain.toLowerCase()) || normalized.includes(base)
    })
    const mentionedApps = allTimeApps.filter((app) => normalized.includes(app.appName.toLowerCase()))

    if (mentionedSites.length > 0 || mentionedApps.length > 0) {
      const lines: string[] = []
      let totalSeconds = 0
      for (const site of mentionedSites) {
        lines.push(`- ${site.domain}: ${formatDuration(site.totalSeconds)}`)
        totalSeconds += site.totalSeconds
      }
      for (const app of mentionedApps) {
        lines.push(`- ${app.appName}: ${formatDuration(app.totalSeconds)}`)
        totalSeconds += app.totalSeconds
      }
      const header = `Across all tracked sessions (~${trackingDays} days of data):`
      const total = lines.length > 1 ? `\nTotal: ${formatDuration(totalSeconds)}.` : ''
      return { kind: 'answer', answer: `${header}\n${lines.join('\n')}${total}`, resolvedContext: allTimeContext }
    }

    // General all-time: show distraction sites first, then top sites
    const distractionSites = allTimeSites.filter((s) =>
      DISTRACTION_DOMAINS.includes(s.domain.toLowerCase()),
    )
    if (distractionSites.length > 0) {
      const lines = distractionSites.slice(0, 8).map((s) => `- ${s.domain}: ${formatDuration(s.totalSeconds)}`)
      const totalDistraction = distractionSites.reduce((sum, s) => sum + s.totalSeconds, 0)
      return {
        kind: 'answer',
        answer: `Across all tracked sessions (~${trackingDays} days of data):\n${lines.join('\n')}\nTotal distraction time: ${formatDuration(totalDistraction)}.`,
        resolvedContext: allTimeContext,
      }
    }

    const topSites = allTimeSites.slice(0, 5).map((s) => `- ${s.domain}: ${formatDuration(s.totalSeconds)}`)
    return {
      kind: 'answer',
      answer: `Top sites across all tracked sessions (~${trackingDays} days):\n${topSites.join('\n')}`,
      resolvedContext: allTimeContext,
    }
  }

  const weeklyBrief = resolveWeeklyBriefContext(trimmed, defaultDate, previousContext?.weeklyBrief ?? null)
  if (weeklyBrief) {
    return {
      kind: 'weeklyBrief',
      briefContext: weeklyBrief,
      resolvedContext: {
        ...resolvedContext,
        weeklyBrief,
      },
    }
  }

  if (isWeeklyQuestion(normalized)) {
    const end = new Date(resolvedContext.date)
    end.setHours(23, 59, 59, 999)
    const start = new Date(end)
    start.setDate(end.getDate() - 6)
    start.setHours(0, 0, 0, 0)
    const apps = getAppSummariesForRange(db, start.getTime(), end.getTime())
    const sites = getWebsiteSummariesForRange(db, start.getTime(), end.getTime())
    const sessions = getSessionsForRange(db, start.getTime(), end.getTime())
    if (normalized.includes('what distracted me') || normalized.includes('biggest distraction')) {
      const topNonFocusApp = apps.find((app) => !isFocusedCategory(app.category))
      const topNonFocusSite = sites[0]
      const answer = topNonFocusSite && (!topNonFocusApp || topNonFocusSite.totalSeconds > topNonFocusApp.totalSeconds)
        ? `${topNonFocusSite.domain} was the clearest non-focus pull this week at ${formatDuration(topNonFocusSite.totalSeconds)}.`
        : topNonFocusApp
          ? `${topNonFocusApp.appName} was the biggest non-focus pull this week at ${formatDuration(topNonFocusApp.totalSeconds)}.`
          : "I don't see one dominant distraction sink this week."
      return { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } }
    }
    if (
      normalized.includes('what was i working on')
      || normalized.includes('what did i work on')
      || normalized.includes('where did my time go')
      || normalized.includes('what happened this week')
      || normalized.includes('summarize this week')
    ) {
      const answer = buildTimelineSummary(apps, sites, sessions) ?? dailyTopCategoryAnswer(apps, sites)
      return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
    }

    // Catch-all: generic "this week" / "last week" question with no specific sub-pattern
    {
      const totalSeconds = apps.reduce((sum, a) => sum + a.totalSeconds, 0)
      if (process.env.NODE_ENV === 'development') {
        console.log(`[router] weekly catch-all: apps=${apps.length} sites=${sites.length} totalSec=${totalSeconds}`)
      }
      if (totalSeconds === 0 && sites.length === 0) return null

      const weekLabel = normalized.includes('last week') ? 'Last week' : 'This week'
      const focusSeconds = apps.filter((a) => isFocusedCategory(a.category)).reduce((sum, a) => sum + a.totalSeconds, 0)
      const focusScore = totalSeconds > 0 ? Math.round((focusSeconds / totalSeconds) * 100) : 0
      const topApps = apps.slice(0, 5).map((a) => `${a.appName} (${formatDuration(a.totalSeconds)})`).join(', ')
      const topSites = sites.slice(0, 5).map((s) => `${s.domain} (${formatDuration(s.totalSeconds)})`).join(', ')
      const DISTRACTION_DOMAINS = ['youtube.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'tiktok.com', 'netflix.com', 'facebook.com']
      const distractionSites = sites.filter((s) => DISTRACTION_DOMAINS.includes(s.domain.toLowerCase()))
      const distractionSeconds = distractionSites.reduce((sum, s) => sum + s.totalSeconds, 0)

      const lines: string[] = [
        `${weekLabel}: ${formatDuration(totalSeconds)} tracked, focus score ${focusScore}/100.`,
        topApps ? `Top apps: ${topApps}.` : null,
        topSites ? `Top sites: ${topSites}.` : null,
        distractionSeconds > 0 ? `Distraction time (YouTube, X, etc.): ${formatDuration(distractionSeconds)}.` : null,
      ].filter((line): line is string => line !== null)

      return { kind: 'answer', answer: lines.join('\n'), resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } }
    }
  }

  const [fromMs, toMs] = dayBounds(resolvedContext.date)
  const apps = getAppSummariesForRange(db, fromMs, toMs)
  const sites = getWebsiteSummariesForRange(db, fromMs, toMs)
  const sessions = getSessionsForRange(db, fromMs, toMs)

  if (normalized.includes('what changed most') || normalized.includes('what time changed most')) {
    const answer = largestChangeAnswer(resolvedContext.date, db)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (
    normalized.includes('compare today with yesterday')
    || normalized.includes('compare today and yesterday')
  ) {
    const answer = buildComparisonAnswer(new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate()), db)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (
    normalized.includes('which files')
    || normalized.includes('what files')
    || normalized.includes('which docs')
    || normalized.includes('what docs')
    || normalized.includes('which pages')
    || normalized.includes('what pages')
    || normalized.includes('what did i touch')
    || normalized.includes('key artifacts')
  ) {
    const answer = buildArtifactAnswer(resolvedContext.date, db)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (
    normalized.includes('summarize today as a short report')
    || normalized.includes('short report i could share')
    || normalized.includes('report i could share')
    || normalized.includes('actually get done')
  ) {
    const answer = buildDayBlocksAnswer(resolvedContext.date, db)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (normalized.includes('when was i most focused')) {
    const answer = peakFocusWindowAnswer(resolvedContext.date, db)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (normalized.includes('where did my time go') || normalized.includes('where did the time go')) {
    const answer = rankedTimeAllocationAnswer(apps)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (normalized.includes('what distracted me') || normalized.includes('biggest distraction')) {
    const answer = buildDistractionAnswer(apps, sites, sessions)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (
    normalized.includes('what was i working on')
    || normalized.includes('what did i work on')
    || normalized.includes('what should i resume')
  ) {
    const prefix = normalized.includes('what should i resume') ? 'Resume' : 'You were mostly working on'
    const answer = buildDayBlocksAnswer(
      resolvedContext.date,
      db,
      prefix === 'Resume'
        ? 'Most recent work blocks'
        : relativeDayLabel(resolvedContext.date),
    ) ?? buildWorkThreadAnswer(apps, sites, sessions, prefix)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (normalized.includes('focus score') || normalized === 'was i focused?' || normalized === 'was i focused today?') {
    const answer = buildFocusScoreAnswer(apps, sessions, sites)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  if (
    normalized.includes('most used app')
    || normalized.includes('top app')
    || normalized.includes('used the most')
  ) {
    const topApp = apps[0]
    if (!topApp) return null
    return {
      kind: 'answer',
      answer: `${topApp.appName} was your top app at ${formatDuration(topApp.totalSeconds)}.`,
      resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null },
    }
  }

  if (
    normalized.includes('most used site')
    || normalized.includes('top website')
    || normalized.includes('top site')
  ) {
    const topSite = sites[0]
    if (!topSite) return null
    return {
      kind: 'answer',
      answer: `${topSite.domain} was your top site at ${formatDuration(topSite.totalSeconds)}.`,
      resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null },
    }
  }

  if (normalized.includes('how much time') || normalized.includes('how long')) {
    const answer = durationMatchAnswer(normalized, apps, sites)
    return answer ? { kind: 'answer', answer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } } : null
  }

  // ─── Yesterday catch-all ──────────────────────────────────────────────────
  // Generic "yesterday" queries that didn't match any specific pattern above.
  // Mirrors the weekly catch-all structure so the LLM gets historical context
  // instead of falling through to null.
  if (isYesterdayQuestion(normalized)) {
    const blockAnswer = buildDayBlocksAnswer(resolvedContext.date, db, 'Yesterday')
    if (blockAnswer) {
      return { kind: 'answer', answer: blockAnswer, resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } }
    }

    const totalSeconds = apps.reduce((sum, a) => sum + a.totalSeconds, 0)
    if (process.env.NODE_ENV === 'development') {
      console.log(`[router] yesterday catch-all: apps=${apps.length} sites=${sites.length} totalSec=${totalSeconds}`)
    }
    if (totalSeconds === 0 && sites.length === 0) return null

    const focusSeconds = apps.filter((a) => isFocusedCategory(a.category)).reduce((sum, a) => sum + a.totalSeconds, 0)
    const focusScore = totalSeconds > 0 ? Math.round((focusSeconds / totalSeconds) * 100) : 0
    const topApps = apps.slice(0, 5).map((a) => `${a.appName} (${formatDuration(a.totalSeconds)})`).join(', ')
    const topSites = sites.slice(0, 5).map((s) => `${s.domain} (${formatDuration(s.totalSeconds)})`).join(', ')
    const DISTRACTION_DOMAINS = ['youtube.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'tiktok.com', 'netflix.com', 'facebook.com']
    const distractionSites = sites.filter((s) => DISTRACTION_DOMAINS.includes(s.domain.toLowerCase()))
    const distractionSeconds = distractionSites.reduce((sum, s) => sum + s.totalSeconds, 0)

    const lines: string[] = [
      `Yesterday: ${formatDuration(totalSeconds)} tracked, focus score ${focusScore}/100.`,
      topApps ? `Top apps: ${topApps}.` : null,
      topSites ? `Top sites: ${topSites}.` : null,
      distractionSeconds > 0 ? `Distraction time (YouTube, X, etc.): ${formatDuration(distractionSeconds)}.` : null,
    ].filter((line): line is string => line !== null)

    return { kind: 'answer', answer: lines.join('\n'), resolvedContext: { ...resolvedContext, weeklyBrief: null, entity: null } }
  }

  return null
}

// Synthesis-question starters that should bypass the deterministic router.
// Temporal modifiers ("last week", "yesterday") are NOT sufficient to route —
// they are parameters, not routing signals.
const SYNTHESIS_BLOCK_PREFIXES = [
  'what did i do',
  'what was i doing',
  'what were i doing',
  'what have i been doing',
  'what happened',
  'which ',
  'find ',
  'show me ',
  'summarize',
  'recap',
  'compare ',
  'how did ',
  'walk me through',
  'tell me about',
  'what should i',
  'give me a summary',
  'give me an overview',
]

// Numeric-lookup patterns that always route deterministically.
const NUMERIC_ROUTE_PATTERNS: RegExp[] = [
  /\bhow (long|much time)\b/,
  /\bhow many (hours?|sessions?|times?)\b/,
  /\bfocus score\b/,
  /\bhow'?s? (my )?focus\b/,
]

/**
 * Returns true only for pure numeric lookups that the deterministic router
 * can answer without open-ended synthesis. Everything else goes to the
 * freeform/tool-use path.
 *
 * Temporal modifiers ("last week", "yesterday") are parameters, not routing
 * signals — they do not flip this to true by themselves.
 */
export function shouldUseRouter(message: string): boolean {
  const lower = message.trim().toLowerCase()

  if (
    lower.includes('which files')
    || lower.includes('what files')
    || lower.includes('which docs')
    || lower.includes('what docs')
    || lower.includes('which pages')
    || lower.includes('what pages')
    || lower.includes('what did i touch')
    || lower.includes('files, docs, or pages')
  ) {
    return true
  }

  for (const prefix of SYNTHESIS_BLOCK_PREFIXES) {
    if (lower.startsWith(prefix)) return false
  }

  for (const pattern of NUMERIC_ROUTE_PATTERNS) {
    if (pattern.test(lower)) return true
  }

  return false
}
