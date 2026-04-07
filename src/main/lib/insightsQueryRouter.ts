import type Database from 'better-sqlite3'
import {
  getAppSummariesForRange,
  getSessionsForRange,
  getWebsiteSummariesForRange,
  getWebsiteVisitsForRange,
  type WebsiteVisit,
} from '../db/queries'
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
  suggestions?: string[]
}

const FOLLOW_UP_PATTERNS = [
  'that time',
  'at that point',
  'then',
  'doing what',
  'working on what',
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

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function sessionDescriptor(session: AppSession): string {
  const title = session.windowTitle?.trim()
  return title ? `${session.appName} (${title})` : session.appName
}

interface ResolvedRange {
  startMs: number
  endMs: number
  label: string
}

interface DirectEvidence {
  startMs: number
  endMs: number
  label: string
}

type ActivityBucket =
  | 'coding'
  | 'browserTesting'
  | 'terminal'
  | 'aiCollaboration'
  | 'docs'
  | 'related'

interface StrongestSession {
  startMs: number
  endMs: number
}

interface ActivityContribution {
  bucket: ActivityBucket
  durationSeconds: number
  appNames: string[]
  titles: string[]
  domains: string[]
  includesLocalhost: boolean
  activeDays: Date[]
  strongestSession: StrongestSession | null
}

interface ExplicitWeekdayReference {
  weekdayValue: number
  modifier: string | null
}

interface EntityEvidence {
  entity: string
  directSessions: AppSession[]
  directWebsiteVisits: WebsiteVisit[]
  contextualSessions: AppSession[]
  contextualWebsiteVisits: WebsiteVisit[]
  directEvidence: DirectEvidence[]
  appFilter: string | null
  range: ResolvedRange
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

function dedupeStrings(values: string[], limit = values.length): string[] {
  const unique = values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
  return unique.slice(0, limit)
}

function endOfDay(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setHours(23, 59, 59, 999)
  return result
}

function mondayFor(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = result.getDay()
  const delta = day === 0 ? -6 : 1 - day
  result.setDate(result.getDate() + delta)
  result.setHours(0, 0, 0, 0)
  return result
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function weekRangeContaining(date: Date): ResolvedRange {
  const start = mondayFor(date)
  const end = endOfDay(addDays(start, 6))
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    label: 'that week',
  }
}

function formatWeekday(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' })
}

function humanList(values: string[], maxItems = values.length): string {
  const items = dedupeStrings(values, maxItems)
  if (items.length === 0) return 'the relevant tools'
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

function humanQuotedList(values: string[], maxItems: number): string {
  return humanList(values.map((value) => `"${value}"`), maxItems)
}

function daysList(dates: Date[]): string {
  return humanList(dates.map(formatWeekday), dates.length)
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .join(' ')
}

function meaningfulQueryTokens(value: string): string[] {
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'for',
    'from',
    'have',
    'hours',
    'how',
    'i',
    'in',
    'last',
    'long',
    'many',
    'much',
    'on',
    'past',
    'spent',
    'spend',
    'spending',
    'that',
    'the',
    'this',
    'time',
    'today',
    'total',
    'week',
    'with',
    'work',
    'yesterday',
    'cumulative',
    'cumulatively',
    'things',
    'stuff',
    'activity',
  ])

  return normalizeSearchText(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !stopWords.has(token))
}

function isPriorWeekMention(normalized: string): boolean {
  return normalized.includes('last week') || normalized.includes('past week')
}

function stripTrailingQueryAddOns(candidate: string): string {
  let cleaned = candidate.trim()
  const patterns = [
    /[.!?]\s+(?:also|and|really|what|break|drill|show|tell|can|could|would)\b.*$/i,
    /\s+(?:also|and then|then)\s+(?:what|show|break|drill|tell)\b.*$/i,
    /\s+(?:break it down|drill down|go deeper|tell me more)\b.*$/i,
    /\s+(?:comprehensively|specifically)\s*$/i,
    /\s+in total\s*$/i,
    /\s+related\s+(?:things|work|stuff|activity)\s*$/i,
  ]

  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, '')
  }

  return cleaned.trim()
}

function stripKnownAppSuffixes(rawTitle: string): string {
  return rawTitle.replace(
    /\s(?:-|\||—)\s(?:Visual Studio Code|VS Code|Cursor|Windsurf|Visual Studio|Rider|IntelliJ IDEA|PyCharm|WebStorm|Microsoft Outlook|Outlook|Google Chrome|Chrome|Microsoft Edge|Edge|Firefox|Excel|Word|PowerPoint|Windows Terminal|PowerShell|Command Prompt|Teams)$/i,
    '',
  )
}

function looksLikeWorkArtifact(value: string): boolean {
  return value.includes('/')
    || value.includes('\\')
    || /\.[a-z0-9]{1,6}\b/i.test(value)
}

function windowLeadLabel(label: string): string {
  if (label === 'today' || label === 'yesterday' || label === 'this week' || label === 'that week' || label === 'last week') {
    return label
  }
  if (label === 'past week') return 'over the past week'
  if (label.startsWith('the last ')) return `over ${label}`
  return `on ${label}`
}

function windowReferenceLabel(label: string): string {
  if (label === 'past week') return 'over the past week'
  if (label.startsWith('the last ')) return `over ${label}`
  if (label === 'today' || label === 'yesterday' || label === 'this week' || label === 'that week' || label === 'last week') {
    return `for ${label}`
  }
  return `on ${label}`
}

function localhostLabel(domains: string[]): string {
  const match = domains
    .map((domain) => domain.match(/localhost(?::\d{2,5})?/i)?.[0] ?? null)
    .find(Boolean)
  return match ?? 'localhost'
}

function strongestSessionObservation(session: StrongestSession | null): string | null {
  if (!session) return null
  if (session.endMs - session.startMs < 20 * 60_000) return null
  return `Heaviest stretch was ${formatWeekday(new Date(session.startMs))} ${formatTime(session.startMs)} to ${formatTime(session.endMs)}.`
}

function appDisplayNames(names: string[]): string[] {
  return dedupeStrings(names.map((raw) => {
    const lower = raw.toLowerCase()
    if (lower === 'visual studio code') return 'VS Code'
    if (lower === 'google chrome') return 'Chrome'
    if (lower === 'microsoft edge') return 'Edge'
    if (lower === 'windows terminal') return 'Windows Terminal'
    return raw
  }))
}

function terminalDisplayNames(names: string[]): string[] {
  return dedupeStrings(names.map((raw) => {
    const lower = raw.toLowerCase()
    if (lower.includes('windows terminal')) return 'Windows Terminal'
    if (lower.includes('powershell') || lower === 'pwsh') return 'PowerShell'
    if (lower.includes('command prompt') || lower === 'cmd') return 'Command Prompt'
    if (lower.includes('wezterm')) return 'WezTerm'
    if (lower.includes('git bash')) return 'Git Bash'
    return raw
  }))
}

function isTerminalLikeApp(session: AppSession): boolean {
  const combined = `${session.appName} ${session.bundleId}`.toLowerCase()
  return combined.includes('terminal')
    || combined.includes('powershell')
    || combined.includes('pwsh')
    || combined.includes('command prompt')
    || combined.includes('cmd.exe')
    || combined.includes('wezterm')
    || combined.includes('git bash')
}

function isCodingLikeApp(session: AppSession): boolean {
  if (session.category === 'development') return true
  const combined = `${session.appName} ${session.bundleId}`.toLowerCase()
  return combined.includes('cursor')
    || combined.includes('visual studio code')
    || combined.includes('code.exe')
    || combined.includes('vscode')
    || combined.includes('visual studio')
    || combined.includes('devenv')
    || combined.includes('rider')
    || combined.includes('intellij')
    || combined.includes('webstorm')
    || combined.includes('pycharm')
    || combined.includes('windsurf')
}

function isAIApp(session: AppSession): boolean {
  const combined = `${session.appName} ${session.bundleId}`.toLowerCase()
  return combined.includes('claude')
    || combined.includes('chatgpt')
    || combined.includes('codex')
    || combined.includes('openai')
    || combined.includes('anthropic')
    || combined.includes('perplexity')
}

function isBrowserLikeSession(session: AppSession): boolean {
  if (session.category === 'browsing' || session.category === 'research') return true
  const combined = `${session.appName} ${session.bundleId}`.toLowerCase()
  return combined.includes('chrome')
    || combined.includes('edge')
    || combined.includes('firefox')
    || combined.includes('browser')
    || combined.includes('brave')
    || combined.includes('opera')
}

function featureContext(titles: string[], target: string): string[] {
  const targetLower = target.toLowerCase()
  const targetTokens = new Set(meaningfulQueryTokens(target))
  const blocked = new Set([
    'new tab',
    'home',
    'untitled',
    'login',
    'loading...',
    'start page',
    'inbox',
    'compose',
    'mail',
    'google',
    'localhost',
  ])
  const seen = new Set<string>()

  return titles
    .map((raw) => stripKnownAppSuffixes(raw).trim())
    .filter((cleaned) => cleaned.length > 3)
    .filter((cleaned) => {
      const lower = cleaned.toLowerCase()
      if (lower === targetLower || blocked.has(lower) || seen.has(lower)) return false
      const cleanedTokens = new Set(meaningfulQueryTokens(cleaned))
      const overlapsTarget = [...cleanedTokens].some((token) => targetTokens.has(token))
      const keep = looksLikeWorkArtifact(cleaned) || overlapsTarget
      if (keep) seen.add(lower)
      return keep
    })
}

function visitEnd(visit: WebsiteVisit): number {
  return visit.visitTime + visit.durationSeconds * 1000
}

function directEvidenceLabel(entity: string, session: AppSession | null, visit: WebsiteVisit | null): string | null {
  if (session) {
    const title = session.windowTitle?.trim()
    if (title && textContainsEntity(title, entity)) return title
    return session.appName.trim() || null
  }

  if (!visit) return null
  const candidates = [visit.pageTitle?.trim(), visit.url?.trim(), visit.domain.trim()]
  return candidates.find((value) => value && textContainsEntity(value, entity)) ?? candidates.find(Boolean) ?? null
}

function mergeTimeRanges(
  ranges: Array<{ startMs: number; endMs: number }>,
  maxGapMs = 0,
): Array<{ startMs: number; endMs: number }> {
  const sorted = [...ranges]
    .filter((range) => range.endMs > range.startMs)
    .sort((left, right) => left.startMs - right.startMs)

  const merged: Array<{ startMs: number; endMs: number }> = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (!last) {
      merged.push({ ...range })
      continue
    }
    if (range.startMs - last.endMs <= maxGapMs) {
      last.endMs = Math.max(last.endMs, range.endMs)
      continue
    }
    merged.push({ ...range })
  }

  return merged
}

function buildDirectEvidence(entity: string, sessions: AppSession[], visits: WebsiteVisit[]): DirectEvidence[] {
  const evidence: DirectEvidence[] = []

  for (const session of sessions) {
    const label = directEvidenceLabel(entity, session, null)
    if (!label) continue
    evidence.push({
      startMs: session.startTime,
      endMs: sessionEnd(session),
      label,
    })
  }

  for (const visit of visits) {
    const label = directEvidenceLabel(entity, null, visit)
    if (!label) continue
    evidence.push({
      startMs: visit.visitTime,
      endMs: visitEnd(visit),
      label,
    })
  }

  return evidence.sort((left, right) => {
    if (left.startMs === right.startMs) return left.endMs - right.endMs
    return left.startMs - right.startMs
  })
}

function buildContextWindows(evidence: DirectEvidence[], range: ResolvedRange): Array<{ startMs: number; endMs: number }> {
  const rangeEndExclusive = range.endMs + 1
  return mergeTimeRanges(
    evidence.map((item) => ({
      startMs: Math.max(range.startMs, item.startMs - 5 * 60_000),
      endMs: Math.min(rangeEndExclusive, item.endMs + 5 * 60_000),
    })),
    3 * 60_000,
  )
}

function clipSessionToWindows(
  session: AppSession,
  windows: Array<{ startMs: number; endMs: number }>,
): AppSession | null {
  const overlaps = windows
    .map((window) => ({
      startMs: Math.max(session.startTime, window.startMs),
      endMs: Math.min(sessionEnd(session), window.endMs),
    }))
    .filter((window) => window.endMs > window.startMs)

  if (overlaps.length === 0) return null

  const overlapMs = overlaps.reduce((sum, window) => sum + (window.endMs - window.startMs), 0)
  return {
    ...session,
    startTime: overlaps[0].startMs,
    endTime: overlaps.at(-1)?.endMs ?? overlaps[0].endMs,
    durationSeconds: Math.max(1, Math.round(overlapMs / 1000)),
  }
}

function clipVisitToWindows(
  visit: WebsiteVisit,
  windows: Array<{ startMs: number; endMs: number }>,
): WebsiteVisit | null {
  const overlaps = windows
    .map((window) => ({
      startMs: Math.max(visit.visitTime, window.startMs),
      endMs: Math.min(visitEnd(visit), window.endMs),
    }))
    .filter((window) => window.endMs > window.startMs)

  if (overlaps.length === 0) return null

  const overlapMs = overlaps.reduce((sum, window) => sum + (window.endMs - window.startMs), 0)
  return {
    ...visit,
    visitTime: overlaps[0].startMs,
    durationSeconds: Math.max(1, Math.round(overlapMs / 1000)),
  }
}

function explicitWeekdayReference(normalized: string): ExplicitWeekdayReference | null {
  const weekdayNames: Array<{ name: string; value: number }> = [
    { name: 'sunday', value: 0 },
    { name: 'monday', value: 1 },
    { name: 'tuesday', value: 2 },
    { name: 'wednesday', value: 3 },
    { name: 'thursday', value: 4 },
    { name: 'friday', value: 5 },
    { name: 'saturday', value: 6 },
  ]

  const tokens = normalized.split(/[^a-z0-9]+/i).filter(Boolean)
  const match = weekdayNames.find((weekday) => tokens.includes(weekday.name))
  if (!match) return null

  const index = tokens.indexOf(match.name)
  const modifier = index > 0 ? tokens[index - 1] : null
  return {
    weekdayValue: match.value,
    modifier,
  }
}

function resolveExplicitWeekday(normalized: string, referenceDate: Date): Date | null {
  const weekdayReference = explicitWeekdayReference(normalized)
  if (!weekdayReference) return null

  const modifier = weekdayReference.modifier
  const weekOffset = modifier === 'last' ? -1 : modifier === 'next' ? 1 : 0
  const anchor = addDays(referenceDate, weekOffset * 7)
  const weekStart = mondayFor(anchor)

  for (let offset = 0; offset < 7; offset++) {
    const candidate = addDays(weekStart, offset)
    if (candidate.getDay() === weekdayReference.weekdayValue) {
      candidate.setHours(0, 0, 0, 0)
      return candidate
    }
  }

  return null
}

function hasTemporalCue(normalized: string): boolean {
  return normalized.includes('today')
    || normalized.includes('yesterday')
    || normalized.includes('tomorrow')
    || normalized.includes('this week')
    || normalized.includes('that week')
    || normalized.includes('last week')
    || normalized.includes('past week')
    || /\b(?:last|past)\s+\d+\s+(?:days?|weeks?)\b/i.test(normalized)
    || explicitWeekdayReference(normalized) !== null
    || FOLLOW_UP_PATTERNS.some((pattern) => normalized.includes(pattern))
}

function resolveQuestionRange(question: string, anchorDate: Date, preferAllTrackedTime = false): ResolvedRange {
  const normalized = question.toLowerCase()
  const dayStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate())
  const dayEnd = endOfDay(anchorDate)

  const dayWindowMatch = normalized.match(/\b(?:last|past)\s+(\d+)\s+days?\b/)
  if (dayWindowMatch) {
    const days = Math.max(1, Number(dayWindowMatch[1]))
    const start = new Date(dayStart)
    start.setDate(start.getDate() - (days - 1))
    return {
      startMs: start.getTime(),
      endMs: dayEnd.getTime(),
      label: `the last ${days} days`,
    }
  }

  const weekWindowMatch = normalized.match(/\b(?:last|past)\s+(\d+)\s+weeks?\b/)
  if (weekWindowMatch) {
    const weeks = Math.max(1, Number(weekWindowMatch[1]))
    const start = new Date(dayStart)
    start.setDate(start.getDate() - (weeks * 7 - 1))
    return {
      startMs: start.getTime(),
      endMs: dayEnd.getTime(),
      label: `the last ${weeks} weeks`,
    }
  }

  if (isPriorWeekMention(normalized)) {
    const week = weekRangeContaining(anchorDate)
    return {
      ...week,
      label: normalized.includes('past week') ? 'past week' : 'last week',
    }
  }

  if (normalized.includes('this week') || normalized.includes('that week')) {
    const week = weekRangeContaining(anchorDate)
    return {
      ...week,
      label: normalized.includes('this week') ? 'this week' : 'that week',
    }
  }

  if (normalized.includes('yesterday')) {
    const date = new Date(dayStart)
    date.setDate(date.getDate() - 1)
    const [startMs, nextMs] = dayBounds(date)
    return {
      startMs,
      endMs: nextMs - 1,
      label: 'yesterday',
    }
  }

  if (normalized.includes('today')) {
    const [startMs, nextMs] = dayBounds(anchorDate)
    return {
      startMs,
      endMs: nextMs - 1,
      label: 'today',
    }
  }

  if (preferAllTrackedTime) {
    return {
      startMs: 0,
      endMs: Date.now(),
      label: 'all tracked time',
    }
  }

  const [startMs, nextMs] = dayBounds(anchorDate)
  return {
    startMs,
    endMs: nextMs - 1,
    label: anchorDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }
}

function cleanEntityCandidate(value: string): string {
  return value
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/\b(?:today|yesterday|this week|that week|last week|past week|last \d+ days?|past \d+ days?|last \d+ weeks?|past \d+ weeks?)\b/gi, '')
    .replace(/\b(?:cumulative|cumulatively|total|altogether)\b/gi, '')
    .replace(/\b(?:break it down|by app|which titles matched|what matched|in outlook|in excel)\b/gi, '')
    .replace(/[?.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanedEntityCandidate(value: string): string {
  return stripTrailingQueryAddOns(cleanEntityCandidate(value))
    .replace(/\s+/g, ' ')
    .trim()
}

function extractEntity(question: string): string | null {
  const quoted = question.match(/["“]([^"”]+)["”]/)
  if (quoted) {
    const cleaned = cleanedEntityCandidate(quoted[1])
    return meaningfulQueryTokens(cleaned).length > 0 ? cleaned : null
  }

  const patterns = [
    /\b(?:how\s+(?:many\s+hours|much\s+time|long)(?:\s+did\s+i)?(?:\s+(?:spend|spent|spending))?\s+(?:on|for|with|in)\s+)(.+)$/i,
    /\b(?:time\s+spent\s+(?:on|for|with|in)\s+)(.+)$/i,
    /\b(?:hours\s+(?:on|for|with|in)\s+)(.+)$/i,
    /\b(?:related to|about)\s+(.+)$/i,
    /\b(?:break\s+down)\s+(.+?)(?:\s+(?:this week|that week|last week|past week|today|yesterday|last \d+ days?|past \d+ days?))*\s*\??$/i,
    // Identity patterns — "who is X", "what is X", "tell me about X", "what do I do for X"
    /\b(?:who|what)\s+is\s+(.+?)(?:\s+(?:today|this week|yesterday))?\s*\??$/i,
    /\b(?:tell\s+me\s+about|describe)\s+(.+?)(?:\s+(?:today|this week|yesterday))?\s*\??$/i,
    /\b(?:what\s+do\s+i\s+(?:do|work)\s+(?:for|on))\s+(.+?)(?:\s+(?:today|this week|yesterday))?\s*\??$/i,
    /\b(?:what\s+project\s+(?:am\s+i\s+building|do\s+i\s+have)\s+(?:for|on))\s+(.+?)(?:\s+(?:today|this week|yesterday))?\s*\??$/i,
  ]

  for (const pattern of patterns) {
    const match = question.match(pattern)
    if (!match) continue
    const cleaned = cleanedEntityCandidate(match[1])
    if (meaningfulQueryTokens(cleaned).length > 0) return cleaned
  }

  const acronym = question.match(/\b[A-Z][A-Z0-9&._-]{1,}\b/)
  return acronym?.[0] ?? null
}

function isEntityQuestion(normalized: string, entity: string | null): boolean {
  if (!entity) return false
  return normalized.includes('how many hours')
    || normalized.includes('how much time')
    || (normalized.includes('how much') && normalized.includes(' time'))
    || normalized.includes('how long')
    || normalized.includes('break it down')
    || normalized.includes('by app')
    || isTitleMatchQuestion(normalized)
}

function extractAppFilter(question: string): string | null {
  const normalized = question.toLowerCase()
  for (const candidate of ['outlook', 'excel', 'word', 'teams', 'chrome', 'edge', 'firefox']) {
    if (normalized.includes(candidate)) return candidate
  }
  return null
}

function textContainsEntity(text: string | null | undefined, entity: string): boolean {
  const haystack = normalizedText(text)
  const needle = normalizedText(entity)
  if (!haystack || !needle) return false
  if (haystack.includes(needle)) return true

  const tokens = meaningfulQueryTokens(entity)
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token))
}

function matchesAppFilter(session: AppSession, appFilter: string | null): boolean {
  if (!appFilter) return true
  const haystack = normalizedText(`${session.appName} ${session.bundleId} ${session.windowTitle ?? ''}`)
  return haystack.includes(appFilter)
}

function matchesVisitAppFilter(visit: WebsiteVisit, appFilter: string | null): boolean {
  if (!appFilter) return true
  const haystack = normalizedText(`${visit.browserBundleId ?? ''} ${visit.pageTitle ?? ''} ${visit.domain}`)
  return haystack.includes(appFilter)
}

function bucketForSession(session: AppSession, visits: WebsiteVisit[]): ActivityBucket {
  if (isTerminalLikeApp(session)) return 'terminal'
  if (isBrowserLikeSession(session)) return 'browserTesting'
  if (isCodingLikeApp(session)) return 'coding'
  if (session.category === 'aiTools' || isAIApp(session)) return 'aiCollaboration'
  if (session.category === 'email' || session.category === 'productivity' || session.category === 'writing' || session.category === 'communication') return 'docs'
  if (visits.some((visit) => normalizedText(`${visit.domain} ${visit.url ?? ''}`).includes('localhost'))) return 'browserTesting'
  return 'related'
}

function buildContributions(sessions: AppSession[], websiteVisits: WebsiteVisit[]): ActivityContribution[] {
  interface ContributionAccumulator {
    durationSeconds: number
    appNames: string[]
    titles: string[]
    domains: string[]
    includesLocalhost: boolean
    activeDaySet: Set<number>
    strongestSession: StrongestSession | null
  }

  const grouped = new Map<ActivityBucket, ContributionAccumulator>()

  for (const session of sessions) {
    const relatedVisits = websiteVisits.filter((visit) => (
      Math.max(session.startTime, visit.visitTime) < Math.min(sessionEnd(session), visitEnd(visit))
    ))

    const bucket = bucketForSession(session, relatedVisits)
    const current = grouped.get(bucket) ?? {
      durationSeconds: 0,
      appNames: [],
      titles: [],
      domains: [],
      includesLocalhost: false,
      activeDaySet: new Set<number>(),
      strongestSession: null,
    }

    current.durationSeconds += session.durationSeconds
    current.activeDaySet.add(new Date(session.startTime).setHours(0, 0, 0, 0))
    if (!current.strongestSession || session.durationSeconds > ((current.strongestSession.endMs - current.strongestSession.startMs) / 1000)) {
      current.strongestSession = {
        startMs: session.startTime,
        endMs: sessionEnd(session),
      }
    }

    if (!current.appNames.includes(session.appName)) current.appNames.push(session.appName)
    if (session.windowTitle?.trim() && !current.titles.includes(session.windowTitle.trim())) {
      current.titles.push(session.windowTitle.trim())
    }

    for (const visit of relatedVisits) {
      if (!current.domains.includes(visit.domain)) current.domains.push(visit.domain)
      if (visit.pageTitle?.trim() && !current.titles.includes(visit.pageTitle.trim())) {
        current.titles.push(visit.pageTitle.trim())
      }
      if (normalizedText(`${visit.domain} ${visit.url ?? ''}`).includes('localhost')) {
        current.includesLocalhost = true
      }
    }

    grouped.set(bucket, current)
  }

  return [...grouped.entries()]
    .map(([bucket, accumulator]) => ({
      bucket,
      durationSeconds: accumulator.durationSeconds,
      appNames: accumulator.appNames,
      titles: accumulator.titles,
      domains: accumulator.domains,
      includesLocalhost: accumulator.includesLocalhost,
      activeDays: [...accumulator.activeDaySet].sort((left, right) => left - right).map((value) => new Date(value)),
      strongestSession: accumulator.strongestSession,
    }))
    .sort((left, right) => {
      if (left.durationSeconds === right.durationSeconds) {
        return left.bucket.localeCompare(right.bucket)
      }
      return right.durationSeconds - left.durationSeconds
    })
}

function entityLead(entity: string, range: ResolvedRange, durationSeconds: number): string {
  return `You put in ${formatDuration(durationSeconds)} on ${entity} ${windowLeadLabel(range.label)}.`
}

function narrativeBullet(contribution: ActivityContribution, entity: string): string {
  const duration = formatDuration(contribution.durationSeconds)
  const apps = humanList(appDisplayNames(contribution.appNames), 2)
  const days = contribution.activeDays.length > 0 ? daysList(contribution.activeDays) : null
  const daysPhrase = days ? ` on ${days}` : ''
  const features = featureContext(contribution.titles, entity)
  const featurePhrase = features.length > 0 ? humanQuotedList(features, 2) : null
  const strongestSessionPhrase = strongestSessionObservation(contribution.strongestSession)

  switch (contribution.bucket) {
    case 'coding': {
      let line = `${duration} coding in ${apps}${daysPhrase}`
      if (featurePhrase) {
        line += `, mainly ${featurePhrase}.`
      } else {
        line += ` on ${entity}-related implementation.`
      }
      if (strongestSessionPhrase) line += ` ${strongestSessionPhrase}`
      return line
    }

    case 'browserTesting': {
      let line: string
      if (contribution.includesLocalhost) {
        line = `${duration} testing on ${localhostLabel(contribution.domains)} in ${apps}${daysPhrase}`
        if (featurePhrase) {
          line += `, around ${featurePhrase}.`
        } else {
          line += '.'
        }
        line += ' The back-and-forth pattern suggests active iteration.'
      } else {
        const reviewTargets = contribution.domains.filter((domain) => !domain.toLowerCase().includes('localhost'))
        line = `${duration} in ${apps}${daysPhrase}`
        if (reviewTargets.length > 0) {
          line += ` reviewing ${humanList(reviewTargets, 2)}`
        } else {
          line += ' reviewing related pages'
        }
        if (featurePhrase) {
          line += `, especially ${featurePhrase}.`
        } else {
          line += '.'
        }
      }
      if (strongestSessionPhrase) line += ` ${strongestSessionPhrase}`
      return line
    }

    case 'terminal': {
      let line = `${duration} in ${humanList(terminalDisplayNames(contribution.appNames), 2)}${daysPhrase}, likely commands, logs, or build steps tied to ${entity}.`
      if (strongestSessionPhrase) line += ` ${strongestSessionPhrase}`
      return line
    }

    case 'aiCollaboration': {
      let line = `${duration} in ${apps}${daysPhrase}`
      if (featurePhrase) {
        line += ` using AI to iterate on ${featurePhrase}.`
      } else {
        line += ` using AI to push the ${entity} work forward.`
      }
      if (strongestSessionPhrase) line += ` ${strongestSessionPhrase}`
      return line
    }

    case 'docs': {
      const looksLikeCommunication = contribution.appNames.some((appName) => {
        const lower = appName.toLowerCase()
        return lower.includes('outlook') || lower.includes('mail') || lower.includes('teams')
      })
      let line = `${duration} in ${apps}${daysPhrase}`
      if (looksLikeCommunication) {
        if (featurePhrase) {
          line += `, around ${featurePhrase}. It looks like client comms or updates.`
        } else {
          line += `, which looks like client comms or updates for ${entity}.`
        }
      } else if (featurePhrase) {
        line += ` across docs or spreadsheets like ${featurePhrase}.`
      } else {
        line += ` across docs, spreadsheets, or notes for ${entity}.`
      }
      if (strongestSessionPhrase) line += ` ${strongestSessionPhrase}`
      return line
    }

    case 'related':
    default: {
      let line = `${duration} in ${apps}${daysPhrase} on adjacent ${entity} work.`
      if (strongestSessionPhrase) line += ` ${strongestSessionPhrase}`
      return line
    }
  }
}

function closingObservation(contributions: ActivityContribution[], activeDays: Date[], entity: string): string | null {
  if (contributions.length === 0) return null

  const hasCoding = contributions.some((contribution) => contribution.bucket === 'coding')
  const hasTesting = contributions.some((contribution) => contribution.bucket === 'browserTesting' && contribution.includesLocalhost)
  const hasTerminal = contributions.some((contribution) => contribution.bucket === 'terminal')
  const hasAI = contributions.some((contribution) => contribution.bucket === 'aiCollaboration')
  const hasReview = contributions.some((contribution) => contribution.bucket === 'browserTesting' && !contribution.includesLocalhost)
  const hasDocs = contributions.some((contribution) => contribution.bucket === 'docs')

  if (hasCoding && hasTesting && hasTerminal) {
    return 'The editor to localhost to terminal loop points to active implementation and verification. Want me to pull out the sessions with the most switching?'
  }
  if (hasCoding && hasAI) {
    return 'The coding and AI mix suggests you were iterating quickly rather than just reviewing. Want me to show which features drove the most back-and-forth?'
  }
  if (hasCoding && hasTesting) {
    return 'The build and test pattern looks like forward progress on a live feature. Want me to zoom into the testing sessions?'
  }
  if (hasCoding && hasDocs) {
    return 'This looks like implementation paired with docs or client comms rather than heads-down coding only. Want me to separate the build work from the coordination?'
  }
  if (hasTesting && hasTerminal && !hasCoding) {
    return 'Mostly testing plus terminal work, which usually means debugging or validation rather than new code. Want me to pinpoint the roughest sessions?'
  }
  if (hasReview && !hasCoding && !hasTesting) {
    return 'This reads more like review, research, or planning than active implementation. Want me to check what was open in those sessions?'
  }
  if (activeDays.length >= 3) {
    return `The work was spread out, with the center of gravity around ${formatWeekday(activeDays[Math.floor(activeDays.length / 2)])}. Want me to zoom into that day specifically?`
  }
  return `Want me to drill into the exact files, pages, or sessions behind the ${entity} work?`
}

function buildEntityEvidence(
  entity: string,
  range: ResolvedRange,
  question: string,
  sessions: AppSession[],
  visits: WebsiteVisit[],
): EntityEvidence {
  const appFilter = extractAppFilter(question)

  const directSessions = sessions.filter((session) => (
    matchesAppFilter(session, appFilter)
    && (
      textContainsEntity(session.windowTitle, entity)
      || textContainsEntity(session.appName, entity)
      || textContainsEntity(session.bundleId, entity)
    )
  ))

  const directWebsiteVisits = visits.filter((visit) => (
    matchesVisitAppFilter(visit, appFilter)
    && (
      textContainsEntity(visit.pageTitle, entity)
      || textContainsEntity(visit.url, entity)
      || textContainsEntity(visit.domain, entity)
    )
  ))

  const directEvidence = buildDirectEvidence(entity, directSessions, directWebsiteVisits)
  const contextWindows = buildContextWindows(directEvidence, range)
  const contextualSessions = sessions
    .filter((session) => matchesAppFilter(session, appFilter))
    .map((session) => clipSessionToWindows(session, contextWindows))
    .filter((session): session is AppSession => session !== null)
  const contextualWebsiteVisits = visits
    .filter((visit) => matchesVisitAppFilter(visit, appFilter))
    .map((visit) => clipVisitToWindows(visit, contextWindows))
    .filter((visit): visit is WebsiteVisit => visit !== null)

  return {
    entity,
    directSessions,
    directWebsiteVisits,
    contextualSessions,
    contextualWebsiteVisits,
    directEvidence,
    appFilter,
    range,
  }
}

function buildEntitySuggestions(entity: string): string[] {
  return dedupeStrings([
    `Break ${entity} down by app`,
    `Which ${entity} titles matched?`,
    `How much ${entity} time was in Outlook?`,
    `How much ${entity} time was in Excel?`,
  ], 4)
}

function isTitleMatchQuestion(normalized: string): boolean {
  return normalized.includes('which titles')
    || normalized.includes('what matched')
    || /\bwhich\b.*\btitles?\b.*\bmatched\b/.test(normalized)
    || /\bwhat\b.*\bmatched\b/.test(normalized)
}

function isAppBreakdownQuestion(normalized: string): boolean {
  return normalized.includes('by app')
    || /\bbreak\b.*\bdown\b.*\bapps?\b/.test(normalized)
    || /\bapps?\b.*\bbreak\b.*\bdown\b/.test(normalized)
    || /\bapp\s+breakdown\b/.test(normalized)
    || /\bbreakdown\b.*\bapp\b/.test(normalized)
}

function buildEntityAppBreakdown(
  entity: string,
  range: ResolvedRange,
  activitySessions: AppSession[],
  websiteVisits: WebsiteVisit[],
): string | null {
  if (activitySessions.length === 0 && websiteVisits.length === 0) return null

  interface AppBreakdown {
    appName: string
    bundleId: string | null
    totalSeconds: number
    titles: string[]
    domains: string[]
  }

  const grouped = new Map<string, AppBreakdown>()

  for (const session of activitySessions) {
    const key = `${session.bundleId}::${session.appName}`
    const current = grouped.get(key) ?? {
      appName: session.appName,
      bundleId: session.bundleId,
      totalSeconds: 0,
      titles: [],
      domains: [],
    }

    current.totalSeconds += session.durationSeconds
    if (session.windowTitle?.trim() && !current.titles.includes(session.windowTitle.trim())) {
      current.titles.push(session.windowTitle.trim())
    }
    grouped.set(key, current)
  }

  for (const visit of websiteVisits) {
    const match = [...grouped.values()].find((entry) => entry.bundleId === visit.browserBundleId)
    if (!match) continue
    if (!match.domains.includes(visit.domain)) {
      match.domains.push(visit.domain)
    }
    if (visit.pageTitle?.trim() && !match.titles.includes(visit.pageTitle.trim())) {
      match.titles.push(visit.pageTitle.trim())
    }
  }

  const lines = [...grouped.values()]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 6)
    .map((entry, index) => {
      const evidenceParts: string[] = []
      const features = featureContext(entry.titles, entity)
      if (features.length > 0) {
        evidenceParts.push(humanQuotedList(features, 2))
      }
      if (entry.domains.length > 0) {
        evidenceParts.push(humanList(entry.domains, 2))
      }
      return `${index + 1}. ${entry.appName}: ${formatDuration(entry.totalSeconds)}${evidenceParts.length > 0 ? ` — ${evidenceParts.join('; ')}` : ''}`
    })

  if (lines.length === 0) return null

  return [
    `${entity} by app ${windowReferenceLabel(range.label)}:`,
    ...lines,
  ].join('\n')
}

function buildEntityAnswer(
  evidence: EntityEvidence,
  question: string,
  sessionsInRange: AppSession[],
  resolvedContext: TemporalContext,
): RouterResult | null {
  const normalized = question.toLowerCase()
  const activitySessions = evidence.contextualSessions.filter(isMeaningfulSession)
  const activitySeconds = activitySessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  const websiteSeconds = evidence.contextualWebsiteVisits.reduce((sum, visit) => sum + visit.durationSeconds, 0)
  const totalSeconds = activitySeconds > 0 ? activitySeconds : websiteSeconds

  const titleCoverageIsPartial = sessionsInRange.some((session) => (
    (session.category === 'email' || session.category === 'productivity' || session.category === 'writing')
    && !session.windowTitle
  ))

  if (totalSeconds <= 0) {
    const answer = [
      `I couldn't find title-level evidence for ${evidence.entity} ${windowReferenceLabel(evidence.range.label)}.`,
      'Right now I can only attribute client work when the client name appears in a window title, email subject, workbook title, page title, or URL.',
      titleCoverageIsPartial ? 'Native app attribution is still partial for older sessions that were recorded before window-title capture was added.' : null,
    ].filter(Boolean).join(' ')
    return {
      answer,
      resolvedContext,
      suggestions: buildEntitySuggestions(evidence.entity),
    }
  }

  if (isTitleMatchQuestion(normalized)) {
    const examples = dedupeStrings(evidence.directEvidence.map((item) => item.label), 6)
    const answer = examples.length > 0
      ? `The strongest ${evidence.entity} matches ${windowReferenceLabel(evidence.range.label)} were ${humanQuotedList(examples, 6)}.`
      : `I found ${formatDuration(totalSeconds)} linked to ${evidence.entity} ${windowReferenceLabel(evidence.range.label)}, but there weren't enough distinct titles to list cleanly.`

    return {
      answer,
      resolvedContext,
      suggestions: buildEntitySuggestions(evidence.entity),
    }
  }

  if (isAppBreakdownQuestion(normalized)) {
    const answer = buildEntityAppBreakdown(
      evidence.entity,
      evidence.range,
      activitySessions,
      evidence.contextualWebsiteVisits,
    )
    if (answer) {
      return {
        answer,
        resolvedContext,
        suggestions: buildEntitySuggestions(evidence.entity),
      }
    }
  }

  if (activitySessions.length === 0) {
    const examples = dedupeStrings(
      evidence.contextualWebsiteVisits.map((visit) => visit.pageTitle?.trim() || visit.domain),
      4,
    )
    const answer = [
      `I found about ${formatDuration(websiteSeconds)} of browser evidence linked to ${evidence.entity} ${windowReferenceLabel(evidence.range.label)}.`,
      examples.length > 0 ? `Strongest page matches were ${humanQuotedList(examples, 4)}.` : null,
      titleCoverageIsPartial ? 'Native app attribution is still partial for older sessions recorded before title capture was enabled.' : null,
    ].filter(Boolean).join(' ')

    return {
      answer,
      resolvedContext,
      suggestions: buildEntitySuggestions(evidence.entity),
    }
  }

  const contributions = buildContributions(activitySessions, evidence.contextualWebsiteVisits)
  const activeDays = [...new Set(activitySessions.map((session) => new Date(session.startTime).setHours(0, 0, 0, 0)))]
    .sort((left, right) => left - right)
    .map((value) => new Date(value))

  let lead = entityLead(evidence.entity, evidence.range, totalSeconds)
  if (lead.endsWith('.')) lead = lead.slice(0, -1)
  if (activeDays.length > 1) {
    lead += `, spread across ${daysList(activeDays)}.`
  } else if (activeDays.length === 1) {
    lead += `, all on ${formatWeekday(activeDays[0])}.`
  } else {
    lead += '.'
  }

  const lines = [lead]
  for (const [index, contribution] of contributions.slice(0, 4).entries()) {
    lines.push(`${index + 1}. ${narrativeBullet(contribution, evidence.entity)}`)
  }

  if (contributions.length === 0 && evidence.directEvidence.length > 0) {
    lines.push(`The strongest saved signal was "${evidence.directEvidence[0].label}".`)
  }

  const closing = closingObservation(contributions, activeDays, evidence.entity)
  if (closing) lines.push(closing)
  if (titleCoverageIsPartial) {
    lines.push('Some older native app sessions still lack titles, so this should be treated as directional rather than exhaustive.')
  }

  return {
    answer: lines.join('\n'),
    resolvedContext,
    suggestions: buildEntitySuggestions(evidence.entity),
  }
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

  const meaningfulSessions = sessions.filter(isMeaningfulSession)
  const totalSeconds = apps.reduce((sum, app) => sum + app.totalSeconds, 0)
  if (totalSeconds === 0 && meaningfulSessions.length === 0) return null

  // Use apps only for evidence — sessions are already aggregated into apps, passing both doubles counts
  const evidence = buildEvidence(apps, sites, [])

  const latestActive = (resolvedPrefix === 'Resume'
    ? latestFocusedSession(sessions) ?? latestMeaningfulSession(sessions)
    : latestMeaningfulSession(sessions))
    ?? sortedSessions(sessions).at(-1) ?? null

  // Build per-app title map from individual sessions (not summaries — sessions carry window titles)
  const appTitleMap = new Map<string, string[]>()
  for (const session of [...sortedSessions(meaningfulSessions)].reverse()) {
    const title = session.windowTitle?.trim()
    if (!title) continue
    const cleaned = stripKnownAppSuffixes(title)
    if (!cleaned || cleaned.length < 3) continue
    const existing = appTitleMap.get(session.bundleId) ?? []
    if (!existing.includes(cleaned) && existing.length < 2) existing.push(cleaned)
    appTitleMap.set(session.bundleId, existing)
  }

  // Meaningful apps with at least 1 minute
  const visibleApps = apps.filter((app) => app.totalSeconds >= 60).slice(0, 5)

  const appLines = visibleApps.map((app) => {
    const titles = appTitleMap.get(app.bundleId) ?? []
    const titleSuffix = titles.length > 0 ? ` — ${humanQuotedList(titles, 2)}` : ''
    return `${app.appName} (${formatDuration(app.totalSeconds)})${titleSuffix}`
  })

  const latestLine = latestActive
    ? (() => {
        const t = latestActive.windowTitle?.trim()
        const tDisplay = t ? ` on "${stripKnownAppSuffixes(t)}"` : ''
        return `Last active: ${latestActive.appName}${tDisplay} at ${formatTime(latestActive.startTime)}.`
      })()
    : null

  if (resolvedPrefix === 'Resume' && latestActive) {
    const t = latestActive.windowTitle?.trim()
    const tDisplay = t ? ` — "${stripKnownAppSuffixes(t)}"` : ''
    const otherLines = appLines.filter((_, i) => visibleApps[i]?.bundleId !== latestActive.bundleId).slice(0, 3)
    return [
      `Resume with ${latestActive.appName}${tDisplay} (left off at ${formatTime(latestActive.startTime)}).`,
      otherLines.length > 0 ? `Before that: ${otherLines.join(', ')}.` : null,
    ].filter(Boolean).join(' ')
  }

  // Only use "light evidence" when genuinely insufficient — not just because the day is mixed
  const titledSessionCount = sessions.filter((session) => session.windowTitle?.trim()).length
  const genuinelyThinData = totalSeconds < 5 * 60 || (titledSessionCount === 0 && visibleApps.length <= 1)

  if (genuinelyThinData) {
    const latestTitled = [...sortedSessions(sessions)].reverse().find((s) => s.windowTitle?.trim())
    const latestTitle = latestTitled?.windowTitle?.trim()
    const concreteLead = latestTitle
      ? `The clearest signal is ${latestTitled!.appName} on "${stripKnownAppSuffixes(latestTitle)}" around ${formatTime(latestTitled!.startTime)}.`
      : latestActive ? `The clearest signal is ${latestActive.appName} from ${formatTime(latestActive.startTime)}.` : null
    return [
      'I only have light evidence for that period so far.',
      concreteLead,
      evidence.signals.length > 0 ? `Strongest signals: ${formatSignalList(evidence.signals, 3)}.` : null,
    ].filter(Boolean).join(' ')
  }

  const taskLabel = evidence.task.label
  const totalLine = `${taskLabel} (${formatDuration(totalSeconds)} tracked).`

  return [
    totalLine,
    appLines.length > 0 ? appLines.join(', ') + '.' : null,
    latestLine,
  ].filter(Boolean).join(' ')
}

function buildGeneralAppBreakdown(
  rangeLabel: string,
  apps: AppUsageSummary[],
  sites: WebsiteSummary[],
): string | null {
  if (apps.length === 0) return null

  const browserDomains = dedupeStrings(sites.map((site) => site.domain), 3)
  const browserTitles = dedupeStrings(
    sites
      .map((site) => site.topTitle?.trim() ?? '')
      .filter(Boolean),
    2,
  )

  const lines = apps.slice(0, 6).map((app, index) => {
    const lower = app.appName.toLowerCase()
    const detailParts: string[] = []
    const isBrowserApp = lower.includes('safari')
      || lower.includes('chrome')
      || lower.includes('edge')
      || lower.includes('firefox')
      || lower.includes('arc')
      || lower.includes('brave')

    if (isBrowserApp && browserTitles.length > 0) {
      detailParts.push(humanQuotedList(browserTitles, 2))
    }
    if (isBrowserApp && browserDomains.length > 0) {
      detailParts.push(humanList(browserDomains, 2))
    }

    return `${index + 1}. ${app.appName}: ${formatDuration(app.totalSeconds)}${detailParts.length > 0 ? ` — ${detailParts.join('; ')}` : ''}`
  })

  return [
    `By app ${windowReferenceLabel(rangeLabel)}:`,
    ...lines,
  ].join('\n')
}

function buildGeneralTitleAnswer(
  rangeLabel: string,
  sessions: AppSession[],
  sites: WebsiteSummary[],
): string | null {
  const titles = dedupeStrings([
    ...sessions
      .map((session) => session.windowTitle?.trim() ?? '')
      .filter(Boolean),
    ...sites
      .map((site) => site.topTitle?.trim() ?? '')
      .filter(Boolean),
  ], 6)

  if (titles.length === 0) {
    return `I don't have enough title-level evidence ${windowReferenceLabel(rangeLabel)} yet.`
  }

  return `The clearest titles ${windowReferenceLabel(rangeLabel)} were ${humanQuotedList(titles, 6)}.`
}

function buildTimeAllocationAnswer(apps: AppUsageSummary[], sites: WebsiteSummary[]): string | null {
  if (apps.length === 0 && sites.length === 0) return null

  const evidence = buildEvidence(apps, sites, [])
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

function buildDistractionAnswer(apps: AppUsageSummary[], sites: WebsiteSummary[]): string | null {
  if (apps.length === 0 && sites.length === 0) return null

  // Use apps only to avoid double-counting sessions that are already aggregated in apps
  const evidence = buildEvidence(apps, sites, [])
  const distractingSignals = evidence.signals.filter(isDistractingSignal)
  const nonFocusSignals = evidence.signals.filter(isNonFocusSignal)
  const topSignals = distractingSignals.length > 0 ? distractingSignals : nonFocusSignals

  if (topSignals.length === 0) {
    return "I don't see one obvious distraction sink in the tracked data for that period."
  }

  const label = distractingSignals.length > 0 ? 'the clearest distraction pull' : 'the strongest non-focus pull'
  const topSignal = topSignals[0]
  const leadSite = topSignal.source === 'website'
    ? sites.find((site) => site.topTitle?.trim() === topSignal.label || site.domain === topSignal.label)
    : null
  const leadApp = topSignal.source !== 'website'
    ? apps.find((app) => app.appName === topSignal.label)
    : null
  const leadLabel = leadSite
    ? `${leadSite.domain}${leadSite.topTitle?.trim() ? ` ("${leadSite.topTitle.trim()}")` : ''}`
    : leadApp
      ? leadApp.appName
      : topSignal.label
  // Slice off the first signal so "other signals" doesn't repeat the lead
  const rest = topSignals.slice(1)
  const otherPart = rest.length > 0 ? ` Other signals: ${formatSignalList(rest, 2)}.` : ''
  return `${leadLabel} was ${label} at ${formatDuration(topSignal.seconds)}.${otherPart}`
}

function buildFocusScoreAnswer(apps: AppUsageSummary[], sessions: AppSession[], sites: WebsiteSummary[]): string | null {
  if (apps.length === 0 && sessions.length === 0 && sites.length === 0) return null

  const evidence = buildEvidence(apps, sites, [])
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
  const evidence = buildEvidence(apps, sites, [])
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
  const explicitWeekday = explicitWeekdayReference(normalized)
  const explicitWeekdayReferenceDate = isPriorWeekMention(normalized) && explicitWeekday && explicitWeekday.modifier !== 'last' && explicitWeekday.modifier !== 'next'
    ? addDays(mondayFor(defaultDate), -7)
    : reference

  const resolvedExplicitWeekday = resolveExplicitWeekday(normalized, explicitWeekdayReferenceDate)
  if (resolvedExplicitWeekday) {
    if (!previousContext && !isPriorWeekMention(normalized) && explicitWeekday?.modifier == null) {
      const todayStart = new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate())
      if (resolvedExplicitWeekday.getTime() > todayStart.getTime()) {
        return addDays(resolvedExplicitWeekday, -7)
      }
    }
    return resolvedExplicitWeekday
  }

  if (normalized.includes('yesterday')) {
    return addDays(new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate()), -1)
  }
  if (normalized.includes('today')) return new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate())
  if (normalized.includes('tomorrow')) return addDays(new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate()), 1)

  if (FOLLOW_UP_PATTERNS.some((pattern) => normalized.includes(pattern)) && previousContext) {
    const priorDate = previousContext.timeWindow?.start ?? previousContext.date
    return new Date(priorDate.getFullYear(), priorDate.getMonth(), priorDate.getDate())
  }

  if (normalized.includes('that week') && previousContext) {
    return new Date(previousContext.date.getFullYear(), previousContext.date.getMonth(), previousContext.date.getDate())
  }

  if (isPriorWeekMention(normalized)) {
    return addDays(mondayFor(defaultDate), -7)
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
  return normalized.includes('this week')
    || normalized.includes('that week')
    || normalized.includes('last week')
    || normalized.includes('past week')
}

function resolveWeeklyRange(normalized: string, resolvedDate: Date): ResolvedRange {
  const week = weekRangeContaining(resolvedDate)
  if (normalized.includes('past week')) return { ...week, label: 'past week' }
  if (normalized.includes('last week')) return { ...week, label: 'last week' }
  if (normalized.includes('this week')) return { ...week, label: 'this week' }
  return { ...week, label: 'that week' }
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
  return `At ${formatTime(midpoint.getTime())}, you were in ${sessionDescriptor(topSession)}. Strongest signals: ${formatSignalList(evidence.signals, 3)}.`
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
    .map((session) => `${sessionDescriptor(session)} (${formatDuration(session.durationSeconds)})`)
  return `Between ${formatTime(window.start.getTime())} and ${formatTime(window.end.getTime())}, the main thread was ${evidence.task.label.toLowerCase()}. Top sessions: ${topSessions.join(', ')}. Strongest signals: ${formatSignalList(evidence.signals, 3)}.`
}

// ── Entity identity ("who is X", "what do I do for X") ────────────────────────

function isEntityIdentityQuestion(normalized: string): boolean {
  return /\bwho\s+is\b/.test(normalized)
    || /\bwhat\s+is\b/.test(normalized)
    || /\btell\s+me\s+about\b/.test(normalized)
    || /\bdescribe\b/.test(normalized)
    || /\bwhat\s+do\s+i\s+(?:do|work)\s+(?:for|on)\b/.test(normalized)
    || /\bwhat\s+(?:kind\s+of\s+work|work)\s+(?:do\s+i\s+do|am\s+i\s+doing)\s+(?:for|on)\b/.test(normalized)
    || /\bwhat\s+project\s+(?:am\s+i\s+building|is\s+this|do\s+i\s+have)\b/.test(normalized)
}

function buildEntityIdentityAnswer(
  evidence: EntityEvidence,
  resolvedContext: TemporalContext,
): RouterResult | null {
  const directSessions = evidence.directSessions.filter(isMeaningfulSession)
  const directVisits = evidence.directWebsiteVisits

  if (directSessions.length === 0 && directVisits.length === 0) {
    return {
      answer: `I don't have tracked activity for "${evidence.entity}" ${windowReferenceLabel(evidence.range.label)}. If this is a client or project, its name needs to appear in a window title, email subject, workbook name, or browser page title for me to attribute time to it.`,
      resolvedContext,
      suggestions: [
        `How much time did I spend on ${evidence.entity} today?`,
        'What was I working on today?',
        'List my clients today.',
      ],
    }
  }

  const devSessions = directSessions.filter(isCodingLikeApp)
  const terminalSess = directSessions.filter(isTerminalLikeApp)
  const emailSessions = directSessions.filter((s) => s.category === 'email')
  const docSessions = directSessions.filter((s) => s.category === 'productivity' || s.category === 'writing')
  const hasDevWork = devSessions.length > 0 || terminalSess.length > 0
  const hasClientComms = emailSessions.length > 0
  const hasDocWork = docSessions.length > 0
  const hasBrowserWork = directVisits.length > 0

  // Infer entity type from activity mix
  let entityType: string
  if (hasDevWork && hasClientComms) {
    entityType = `a client or project — there's both development work and email communication tied to it`
  } else if (hasDevWork && hasDocWork) {
    entityType = `a project — evidence spans coding and document/spreadsheet work`
  } else if (hasDevWork) {
    entityType = `a project or codebase you're actively developing`
  } else if (hasClientComms && hasDocWork) {
    entityType = `a client — the evidence is email and document work`
  } else if (hasDocWork) {
    entityType = `a client or project with document/spreadsheet work`
  } else if (hasBrowserWork) {
    entityType = `a project or account you're reviewing in a browser`
  } else {
    entityType = `a work entity that shows up in your tracked sessions`
  }

  const allTitles = dedupeStrings([
    ...directSessions.map((s) => s.windowTitle?.trim() ?? '').filter(Boolean),
    ...directVisits.map((v) => v.pageTitle?.trim() ?? '').filter(Boolean),
  ], 5).map(stripKnownAppSuffixes).filter(Boolean)

  const breakdown: string[] = []
  if (devSessions.length > 0) {
    breakdown.push(`${formatDuration(devSessions.reduce((sum, s) => sum + s.durationSeconds, 0))} coding`)
  }
  if (terminalSess.length > 0) {
    breakdown.push(`${formatDuration(terminalSess.reduce((sum, s) => sum + s.durationSeconds, 0))} in terminal`)
  }
  if (emailSessions.length > 0) {
    breakdown.push(`${formatDuration(emailSessions.reduce((sum, s) => sum + s.durationSeconds, 0))} in email`)
  }
  if (docSessions.length > 0) {
    breakdown.push(`${formatDuration(docSessions.reduce((sum, s) => sum + s.durationSeconds, 0))} in docs/spreadsheets`)
  }
  if (hasBrowserWork) {
    const browserSeconds = directVisits.reduce((sum, v) => sum + v.durationSeconds, 0)
    const domains = dedupeStrings(directVisits.map((v) => v.domain), 2)
    breakdown.push(`${formatDuration(browserSeconds)} in browser (${humanList(domains, 2)})`)
  }

  const totalSeconds = directSessions.reduce((sum, s) => sum + s.durationSeconds, 0)
    + directVisits.reduce((sum, v) => sum + v.durationSeconds, 0)

  const parts: string[] = [
    `Based on tracked activity, ${evidence.entity} looks like ${entityType}.`,
  ]
  if (allTitles.length > 0) {
    parts.push(`Evidence in titles: ${humanQuotedList(allTitles, 4)}.`)
  }
  if (breakdown.length > 0) {
    parts.push(`Work breakdown: ${humanList(breakdown, 4)}.`)
  }
  parts.push(`Total tracked ${windowReferenceLabel(evidence.range.label)}: ${formatDuration(totalSeconds)}.`)

  return {
    answer: parts.join(' '),
    resolvedContext,
    suggestions: [
      `How many hours have I spent on ${evidence.entity} today?`,
      `Break ${evidence.entity} down by app today.`,
      `Which ${evidence.entity} titles matched?`,
    ],
  }
}

// ── Client listing ────────────────────────────────────────────────────────────

const APP_DISPLAY_NOISE = new Set([
  'Visual Studio Code', 'VS Code', 'Microsoft Outlook', 'Outlook',
  'Microsoft Excel', 'Excel', 'Google Chrome', 'Chrome', 'Windows Terminal',
  'Microsoft Word', 'Word', 'Microsoft Edge', 'Edge', 'Firefox', 'Safari',
  'Microsoft Teams', 'Teams', 'Slack', 'Finder', 'Explorer', 'Settings',
  'New Tab', 'Start Page', 'Home', 'Inbox', 'Untitled',
])

const ENTITY_STOP_WORDS = new Set([
  'VS', 'RE', 'FW', 'FWD', 'HTTP', 'HTTPS', 'URL', 'ID', 'API', 'SQL',
  'PDF', 'UI', 'UX', 'PR', 'WIP', 'TBD', 'EOD', 'THE', 'AND', 'OR',
  'FOR', 'NOT', 'BUT', 'NEW', 'OLD', 'ALL', 'ANY', 'MY', 'README',
])

function extractEntitiesFromActivity(
  sessions: AppSession[],
  visits: WebsiteVisit[],
): Map<string, number> {
  const entitySeconds = new Map<string, number>()

  function addEntity(entity: string, seconds: number): void {
    if (ENTITY_STOP_WORDS.has(entity.toUpperCase())) return
    if (entity.length < 2 || entity.length > 30) return
    if (APP_DISPLAY_NOISE.has(entity)) return
    entitySeconds.set(entity, (entitySeconds.get(entity) ?? 0) + seconds)
  }

  for (const session of sessions) {
    const title = session.windowTitle ?? ''
    // All-caps acronyms (ASYV, IBM, KPMG — 2 to 8 chars)
    for (const match of title.matchAll(/\b([A-Z][A-Z0-9]{1,7})\b/g)) {
      addEntity(match[1], session.durationSeconds)
    }
    // Capitalized multi-word proper nouns (Acme Corp, Project Alpha)
    for (const match of title.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)) {
      if (!APP_DISPLAY_NOISE.has(match[1])) addEntity(match[1], session.durationSeconds)
    }
  }

  for (const visit of visits) {
    const title = visit.pageTitle ?? ''
    for (const match of title.matchAll(/\b([A-Z][A-Z0-9]{1,7})\b/g)) {
      addEntity(match[1], visit.durationSeconds)
    }
    for (const match of title.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)) {
      if (!APP_DISPLAY_NOISE.has(match[1])) addEntity(match[1], visit.durationSeconds)
    }
  }

  return entitySeconds
}

function isClientListQuestion(normalized: string): boolean {
  return /\blist\b.*\b(?:clients?|projects?|accounts?|entities)\b/.test(normalized)
    || /\bwho\s+are\s+my\s+(?:clients?|projects?)\b/.test(normalized)
    || /\ball\s+(?:my\s+)?(?:clients?|projects?)\b/.test(normalized)
    || /\b(?:clients?|projects?)\s+(?:list|today|this\s+week)\b/.test(normalized)
    || /\bhow\s+much\s+time\s+(?:per|for\s+each)\s+client\b/.test(normalized)
    || /\btime\s+(?:per|for\s+each)\s+client\b/.test(normalized)
    || /\b(?:export|analyze)\b.*\bclientele\b/.test(normalized)
    || /\bclientele\b/.test(normalized)
    || /\btime\s+(?:per|by)\s+(?:client|project)\b/.test(normalized)
}

function buildClientListAnswer(
  rangeLabel: string,
  sessions: AppSession[],
  visits: WebsiteVisit[],
  resolvedContext: TemporalContext,
): RouterResult | null {
  const meaningfulSessions = sessions.filter(isMeaningfulSession)
  const entitySeconds = extractEntitiesFromActivity(meaningfulSessions, visits)

  const ranked = [...entitySeconds.entries()]
    .filter(([, seconds]) => seconds >= 60)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)

  if (ranked.length === 0) {
    return {
      answer: `I couldn't identify named clients or projects from titles ${windowReferenceLabel(rangeLabel)}. Attribution requires the client or project name to appear in window titles, email subjects, workbook names, or page titles.`,
      resolvedContext,
      suggestions: [
        'What was I working on today?',
        'Break my work down by app today.',
        'What was I doing this week?',
      ],
    }
  }

  const lines = ranked.map(([entity, seconds], index) =>
    `${index + 1}. ${entity}: ${formatDuration(seconds)}`,
  )

  const totalTracked = ranked.reduce((sum, [, s]) => sum + s, 0)
  const footnote = 'Time per entity is inferred from window titles and may overlap when multiple entities appeared in the same session.'

  return {
    answer: [
      `Named entities by tracked time ${windowReferenceLabel(rangeLabel)} (${formatDuration(totalTracked)} total):`,
      ...lines,
      '',
      footnote,
    ].join('\n'),
    resolvedContext,
    suggestions: ranked.slice(0, 3).map(([entity]) => `How many hours have I spent on ${entity} today?`),
  }
}

// ── Comparison ("ASYV vs Acme Corp today") ────────────────────────────────────

function isComparisonQuestion(normalized: string): boolean {
  return /\bvs\.?\s|\bversus\b|\bcompare\b|\bcompared\s+to\b/.test(normalized)
}

function extractTwoEntities(question: string): [string, string] | null {
  const vsMatch = question.match(
    /(.+?)\s+(?:vs\.?|versus|compared?\s+to)\s+(.+?)(?:\s+(?:today|yesterday|this week|that week|last week|past week|last \d+ days?))*\s*\??$/i,
  )
  if (!vsMatch) return null

  const rawA = vsMatch[1].replace(/^(?:compare\s+|how\s+much\s+time\s+(?:on|for)\s+|time\s+on\s+)/i, '').trim()
  const rawB = vsMatch[2]
    .replace(/\s*[—–-]+\s+(?:which|who|what)\b.*$/i, '')  // strip "— which took more time"
    .replace(/\s*\b(?:which|who)\s+(?:took|had|has|is|was)\b.*$/i, '')
    .trim()

  const a = cleanedEntityCandidate(rawA)
  const b = cleanedEntityCandidate(rawB)

  if (!a || !b || meaningfulQueryTokens(a).length === 0 || meaningfulQueryTokens(b).length === 0) return null
  return [a, b]
}

function buildComparisonAnswer(
  entityA: string,
  entityB: string,
  range: ResolvedRange,
  sessions: AppSession[],
  visits: WebsiteVisit[],
  resolvedContext: TemporalContext,
): RouterResult | null {
  const evidenceA = buildEntityEvidence(entityA, range, '', sessions, visits)
  const evidenceB = buildEntityEvidence(entityB, range, '', sessions, visits)

  const secondsA = evidenceA.contextualSessions.filter(isMeaningfulSession).reduce((sum, s) => sum + s.durationSeconds, 0)
    + evidenceA.contextualWebsiteVisits.reduce((sum, v) => sum + v.durationSeconds, 0)
  const secondsB = evidenceB.contextualSessions.filter(isMeaningfulSession).reduce((sum, s) => sum + s.durationSeconds, 0)
    + evidenceB.contextualWebsiteVisits.reduce((sum, v) => sum + v.durationSeconds, 0)

  if (secondsA === 0 && secondsB === 0) {
    return {
      answer: `I couldn't find tracked evidence for either ${entityA} or ${entityB} ${windowReferenceLabel(range.label)}.`,
      resolvedContext,
      suggestions: ['What was I working on today?', 'List my clients today.'],
    }
  }

  const lineA = secondsA > 0
    ? `${entityA}: ${formatDuration(secondsA)}`
    : `${entityA}: no tracked evidence ${windowReferenceLabel(range.label)}`
  const lineB = secondsB > 0
    ? `${entityB}: ${formatDuration(secondsB)}`
    : `${entityB}: no tracked evidence ${windowReferenceLabel(range.label)}`

  const winner = secondsA > secondsB ? entityA : secondsB > secondsA ? entityB : null
  const closingLine = winner
    ? `${winner} had more tracked time ${windowReferenceLabel(range.label)}.`
    : `Both had the same tracked time ${windowReferenceLabel(range.label)}.`

  return {
    answer: [
      `Comparison ${windowReferenceLabel(range.label)}: ${entityA} vs ${entityB}.`,
      lineA,
      lineB,
      '',
      closingLine,
    ].join('\n'),
    resolvedContext,
    suggestions: [
      `Break ${entityA} down by app today.`,
      `Break ${entityB} down by app today.`,
      'List my clients today.',
    ],
  }
}

// ── Day summary ("summarize my day", "how was my day") ────────────────────────

function isDaySummaryQuestion(normalized: string): boolean {
  return normalized.includes('summarize my day')
    || normalized.includes('summarize today')
    || normalized.includes('daily summary')
    || normalized.includes('how was my day')
    || normalized.includes('give me a summary')
    || normalized.includes('overview of today')
    || normalized.includes('overview of my day')
    || normalized.includes('what happened today')
    || normalized.includes('recap my day')
    || normalized.includes('day recap')
    || normalized.includes('summary of today')
    || normalized.includes('summary of my day')
    || (normalized.includes('analyze') && (normalized.includes('clientele') || normalized.includes('client')))
}

function buildDaySummaryAnswer(
  apps: AppUsageSummary[],
  sites: WebsiteSummary[],
  sessions: AppSession[],
  visits: WebsiteVisit[],
  rangeLabel: string,
): string | null {
  if (apps.length === 0 && sessions.length === 0) return null

  const totalSeconds = apps.reduce((sum, app) => sum + app.totalSeconds, 0)
  const focusedSeconds = apps.filter((app) => isFocusedCategory(app.category)).reduce((sum, app) => sum + app.totalSeconds, 0)
  const focusPct = totalSeconds > 0 ? Math.round((focusedSeconds / totalSeconds) * 100) : 0

  // Extract named entities from session/visit titles
  const entitySeconds = extractEntitiesFromActivity(sessions.filter(isMeaningfulSession), visits)
  const topEntities = [...entitySeconds.entries()]
    .filter(([, s]) => s >= 60)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)

  const topAppsLine = apps
    .slice(0, 4)
    .map((app) => `${app.appName} (${formatDuration(app.totalSeconds)})`)
    .join(', ')

  const entityLine = topEntities.length > 0
    ? topEntities.map(([e, s]) => `${e} (${formatDuration(s)})`).join(', ')
    : null

  const topSite = sites[0]
  const latestSession = [...sortedSessions(sessions)].at(-1)

  const parts: string[] = [
    `${windowLeadLabel(rangeLabel).charAt(0).toUpperCase() + windowLeadLabel(rangeLabel).slice(1)}: ${formatDuration(totalSeconds)} tracked, ${focusPct}% in focused apps.`,
  ]

  if (topAppsLine) parts.push(`Top apps: ${topAppsLine}.`)
  if (entityLine) parts.push(`Clients/projects in titles: ${entityLine}.`)
  if (topSite) parts.push(`Most visited site: ${topSite.domain} (${formatDuration(topSite.totalSeconds)}).`)
  if (latestSession) {
    const t = latestSession.windowTitle?.trim()
    parts.push(`Last active: ${latestSession.appName}${t ? ` on "${stripKnownAppSuffixes(t)}"` : ''} at ${formatTime(latestSession.startTime)}.`)
  }

  return parts.join(' ')
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

  // Resolve the date-scoped range used by most routes
  const dayRange = resolveQuestionRange(trimmed, resolvedContext.date, !hasTemporalCue(normalized))

  // ── Client list / clientele export ─────────────────────────────────────────
  if (isClientListQuestion(normalized)) {
    const sessions = getSessionsForRange(db, dayRange.startMs, dayRange.endMs + 1)
    const visits = getWebsiteVisitsForRange(db, dayRange.startMs, dayRange.endMs + 1)
    const result = buildClientListAnswer(dayRange.label, sessions, visits, resolvedContext)
    if (result) return result
  }

  // ── Comparison ("ASYV vs Acme") ─────────────────────────────────────────────
  if (isComparisonQuestion(normalized)) {
    const entities = extractTwoEntities(trimmed)
    if (entities) {
      const [entityA, entityB] = entities
      const sessions = getSessionsForRange(db, dayRange.startMs, dayRange.endMs + 1)
      const visits = getWebsiteVisitsForRange(db, dayRange.startMs, dayRange.endMs + 1)
      const result = buildComparisonAnswer(entityA, entityB, dayRange, sessions, visits, resolvedContext)
      if (result) return result
    }
  }

  // ── Known metric / scoring questions — route before entity extraction hijacks them ─
  if (normalized.includes('focus score') || /\bwas\s+i\s+focused\b/.test(normalized)) {
    const [fromMsMetric, toMsMetric] = dayBounds(resolvedContext.date)
    const appsMetric = getAppSummariesForRange(db, fromMsMetric, toMsMetric)
    const sessionsMetric = getSessionsForRange(db, fromMsMetric, toMsMetric)
    const sitesMetric = getWebsiteSummariesForRange(db, fromMsMetric, toMsMetric)
    const answer = buildFocusScoreAnswer(appsMetric, sessionsMetric, sitesMetric)
    if (answer) return { answer, resolvedContext }
  }

  // ── Entity quantity + title questions ("how many hours on X", "break X down") ─
  const entity = extractEntity(trimmed)
  if (isEntityQuestion(normalized, entity)) {
    const sessions = getSessionsForRange(db, dayRange.startMs, dayRange.endMs + 1)
    const visits = getWebsiteVisitsForRange(db, dayRange.startMs, dayRange.endMs + 1)
    const evidence = buildEntityEvidence(entity!, dayRange, trimmed, sessions, visits)
    const result = buildEntityAnswer(evidence, trimmed, sessions, resolvedContext)
    if (result) return result
  }

  // ── Entity identity ("who is X", "what do I do for X") ─────────────────────
  if (isEntityIdentityQuestion(normalized) && entity) {
    const sessions = getSessionsForRange(db, dayRange.startMs, dayRange.endMs + 1)
    const visits = getWebsiteVisitsForRange(db, dayRange.startMs, dayRange.endMs + 1)
    const evidence = buildEntityEvidence(entity, dayRange, trimmed, sessions, visits)
    const result = buildEntityIdentityAnswer(evidence, resolvedContext)
    if (result) return result
  }

  // ── Weekly questions ────────────────────────────────────────────────────────
  if (isWeeklyQuestion(normalized)) {
    const weeklyRange = resolveWeeklyRange(normalized, resolvedContext.date)
    const apps = getAppSummariesForRange(db, weeklyRange.startMs, weeklyRange.endMs + 1)
    const sites = getWebsiteSummariesForRange(db, weeklyRange.startMs, weeklyRange.endMs + 1)
    const sessions = getSessionsForRange(db, weeklyRange.startMs, weeklyRange.endMs + 1)
    const visits = getWebsiteVisitsForRange(db, weeklyRange.startMs, weeklyRange.endMs + 1)

    if (isClientListQuestion(normalized)) {
      const result = buildClientListAnswer(weeklyRange.label, sessions, visits, resolvedContext)
      if (result) return result
    }
    if (isDaySummaryQuestion(normalized) || normalized.includes('summarize this week') || normalized.includes('what happened this week')) {
      const answer = buildDaySummaryAnswer(apps, sites, sessions, visits, weeklyRange.label)
      return answer ? { answer, resolvedContext } : null
    }
    if (isAppBreakdownQuestion(normalized)) {
      const answer = buildGeneralAppBreakdown(weeklyRange.label, apps, sites)
      return answer ? { answer, resolvedContext } : null
    }
    if (isTitleMatchQuestion(normalized)) {
      const answer = buildGeneralTitleAnswer(weeklyRange.label, sessions, sites)
      return answer ? { answer, resolvedContext } : null
    }
    if (normalized.includes('what distracted me') || normalized.includes('biggest distraction')) {
      const topNonFocusApp = apps.find((app) => !isFocusedCategory(app.category))
      const topNonFocusSite = sites[0]
      const weekLabel = windowLeadLabel(weeklyRange.label)
      const answer = topNonFocusSite && (!topNonFocusApp || topNonFocusSite.totalSeconds > topNonFocusApp.totalSeconds)
        ? `${topNonFocusSite.domain} was the clearest non-focus pull ${weekLabel} at ${formatDuration(topNonFocusSite.totalSeconds)}.`
        : topNonFocusApp
          ? `${topNonFocusApp.appName} was the biggest non-focus pull ${weekLabel} at ${formatDuration(topNonFocusApp.totalSeconds)}.`
          : `I don't see one dominant distraction sink ${weekLabel}.`
      return { answer, resolvedContext }
    }
    if (
      normalized.includes('what was i working on')
      || normalized.includes('what was i doing')
      || normalized.includes('what did i work on')
      || normalized.includes('what did i do')
      || normalized.includes('where did my time go')
    ) {
      const answer = buildWorkThreadAnswer(apps, sites, sessions, 'You were mostly working on')
        ?? buildTimelineSummary(apps, sites, sessions)
        ?? dailyTopCategoryAnswer(apps, sites)
      return answer ? { answer, resolvedContext } : null
    }
  }

  // ── Time-window exact lookups ───────────────────────────────────────────────
  if (resolvedContext.timeWindow) {
    const sessions = getSessionsForRange(db, resolvedContext.timeWindow.start.getTime(), resolvedContext.timeWindow.end.getTime())
    const sites = getWebsiteSummariesForRange(db, resolvedContext.timeWindow.start.getTime(), resolvedContext.timeWindow.end.getTime())
    const answer = timeRangeAnswer(resolvedContext.timeWindow, sessions, sites)
    return answer ? { answer, resolvedContext } : null
  }

  // ── Day-scoped routes ───────────────────────────────────────────────────────
  const [fromMs, toMs] = dayBounds(resolvedContext.date)
  const apps = getAppSummariesForRange(db, fromMs, toMs)
  const sites = getWebsiteSummariesForRange(db, fromMs, toMs)
  const sessions = getSessionsForRange(db, fromMs, toMs)
  const visits = getWebsiteVisitsForRange(db, fromMs, toMs)

  // Day summary / "summarize my day" / "how was my day" / "give me a summary"
  if (isDaySummaryQuestion(normalized)) {
    const answer = buildDaySummaryAnswer(apps, sites, sessions, visits, 'today')
    return answer ? { answer, resolvedContext } : null
  }

  if (isAppBreakdownQuestion(normalized)) {
    const answer = buildGeneralAppBreakdown('today', apps, sites)
    return answer ? { answer, resolvedContext } : null
  }

  if (isTitleMatchQuestion(normalized)) {
    const answer = buildGeneralTitleAnswer('today', sessions, sites)
    return answer ? { answer, resolvedContext } : null
  }

  if (normalized.includes('what distracted me') || normalized.includes('biggest distraction')) {
    const answer = buildDistractionAnswer(apps, sites)
    return answer ? { answer, resolvedContext } : null
  }

  if (
    normalized.includes('what was i working on')
    || normalized.includes('what was i doing')
    || normalized.includes('what did i work on')
    || normalized.includes('what did i do')
    || normalized.includes('what should i resume')
  ) {
    const prefix = normalized.includes('what should i resume') ? 'Resume' : 'You were mostly working on'
    const answer = buildWorkThreadAnswer(apps, sites, sessions, prefix)
    return answer ? { answer, resolvedContext } : null
  }

  if (normalized.includes('where did my time go') || normalized.includes('where did the time go') || normalized.includes('time allocation')) {
    const answer = buildTimeAllocationAnswer(apps, sites)
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

  if (normalized.includes('how much time') || normalized.includes('how long')) {
    const answer = durationMatchAnswer(normalized, apps, sites)
    return answer ? { answer, resolvedContext } : null
  }

  return null
}
