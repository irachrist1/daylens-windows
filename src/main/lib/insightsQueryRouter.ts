import type Database from 'better-sqlite3'
import { getAppSummariesForRange, getSessionsForRange, getWebsiteSummariesForRange } from '../db/queries'
import type { AppCategory, AppSession, AppUsageSummary, WebsiteSummary } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import { computeFocusScore } from '../lib/focusScore'
import { deriveWorkEvidenceSummary, type WorkEvidenceSignal } from '../lib/workEvidence'

export interface TemporalContext {
  date: Date
  timeWindow: { start: Date; end: Date } | null
}

export interface RouterResult {
  answer: string
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

function buildTimeAllocationAnswer(apps: AppUsageSummary[], sites: WebsiteSummary[], sessions: AppSession[]): string | null {
  if (apps.length === 0 && sites.length === 0) return null

  const evidence = buildEvidence(apps, sites, sessions)
  const strongestFocus = evidence.signals.filter((signal) => FOCUSED_CATEGORIES.includes(signal.category)).slice(0, 3)
  const strongestNonFocus = evidence.signals.filter(isNonFocusSignal).slice(0, 3)
  const focusSeconds = evidence.focusedSeconds
  const totalSeconds = Math.max(evidence.totalSeconds, apps.reduce((sum, app) => sum + app.totalSeconds, 0))
  const focusPct = totalSeconds > 0 ? Math.round((focusSeconds / totalSeconds) * 100) : 0

  const parts = [
    `Most of your time went to ${evidence.task.label.toLowerCase()}.`,
    strongestFocus.length > 0 ? `Strongest work signals: ${formatSignalList(strongestFocus, 3)}.` : null,
    strongestNonFocus.length > 0 ? `Other notable activity: ${formatSignalList(strongestNonFocus, 3)}.` : null,
    totalSeconds > 0 ? `Tracked focus time was about ${focusPct}% of app time.` : null,
  ].filter(Boolean)

  return parts.join(' ')
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
  }
}

function isWeeklyQuestion(normalized: string): boolean {
  return normalized.includes('this week') || normalized.includes('last week')
}

function isFocusedCategory(category: AppCategory): boolean {
  return FOCUSED_CATEGORIES.includes(category)
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
      return { answer, resolvedContext }
    }
    if (
      normalized.includes('what was i working on')
      || normalized.includes('what did i work on')
      || normalized.includes('where did my time go')
      || normalized.includes('what happened this week')
      || normalized.includes('summarize this week')
    ) {
      const answer = buildTimelineSummary(apps, sites, sessions) ?? dailyTopCategoryAnswer(apps, sites)
      return answer ? { answer, resolvedContext } : null
    }
  }

  if (resolvedContext.timeWindow) {
    const sessions = getSessionsForRange(db, resolvedContext.timeWindow.start.getTime(), resolvedContext.timeWindow.end.getTime())
    const sites = getWebsiteSummariesForRange(db, resolvedContext.timeWindow.start.getTime(), resolvedContext.timeWindow.end.getTime())
    const answer = timeRangeAnswer(resolvedContext.timeWindow, sessions, sites)
    return answer ? { answer, resolvedContext } : null
  }

  const [fromMs, toMs] = dayBounds(resolvedContext.date)
  const apps = getAppSummariesForRange(db, fromMs, toMs)
  const sites = getWebsiteSummariesForRange(db, fromMs, toMs)
  const sessions = getSessionsForRange(db, fromMs, toMs)

  if (normalized.includes('what distracted me') || normalized.includes('biggest distraction')) {
    const answer = buildDistractionAnswer(apps, sites, sessions)
    return answer ? { answer, resolvedContext } : null
  }

  if (
    normalized.includes('what was i working on')
    || normalized.includes('what did i work on')
    || normalized.includes('what should i resume')
  ) {
    const prefix = normalized.includes('what should i resume') ? 'Resume' : 'You were mostly working on'
    const answer = buildWorkThreadAnswer(apps, sites, sessions, prefix)
    return answer ? { answer, resolvedContext } : null
  }

  if (normalized.includes('focus score') || normalized === 'was i focused?' || normalized === 'was i focused today?') {
    const answer = buildFocusScoreAnswer(apps, sessions, sites)
    return answer ? { answer, resolvedContext } : null
  }

  if (
    normalized.includes('most used app')
    || normalized.includes('top app')
    || normalized.includes('used the most')
  ) {
    const topApp = apps[0]
    if (!topApp) return null
    return {
      answer: `${topApp.appName} was your top app at ${formatDuration(topApp.totalSeconds)}.`,
      resolvedContext,
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
      answer: `${topSite.domain} was your top site at ${formatDuration(topSite.totalSeconds)}.`,
      resolvedContext,
    }
  }

  if (normalized.includes('where did my time go') || normalized.includes('where did the time go')) {
    const answer = buildTimeAllocationAnswer(apps, sites, sessions)
    return answer ? { answer, resolvedContext } : null
  }

  if (normalized.includes('how much time') || normalized.includes('how long')) {
    const answer = durationMatchAnswer(normalized, apps, sites)
    return answer ? { answer, resolvedContext } : null
  }

  return null
}
