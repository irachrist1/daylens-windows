import type Database from 'better-sqlite3'
import {
  getSessionsForRange,
  getTopPagesForDomains,
  getWebsiteSummariesForRange,
} from '../db/queries'
import type {
  AppCategory,
  AppSession,
  BlockConfidence,
  HistoryDayPayload,
  LiveSession,
  WorkContextAppSummary,
  WorkContextBlock,
} from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import { localDayBounds } from '../lib/localDate'
import { deriveWorkEvidenceSummary } from '../lib/workEvidence'

const IDLE_GAP_THRESHOLD_MS = 15 * 60_000
const MEETING_THRESHOLD_SEC = 20 * 60
const LONG_SINGLE_APP_THRESHOLD_SEC = 45 * 60
const BRIEF_INTERRUPTION_THRESHOLD_SEC = 3 * 60
const SUSTAINED_CATEGORY_THRESHOLD_SEC = 15 * 60
const COMMUNICATION_INTERRUPTION_THRESHOLD_SEC = 5 * 60
const FAST_SWITCH_THRESHOLD_SEC = 5 * 60
const SLOW_SWITCH_THRESHOLD_SEC = 15 * 60

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
  forcedLabel?: string
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

const BROWSER_KEYWORDS = [
  'chrome',
  'edge',
  'firefox',
  'brave',
  'arc',
  'browser',
  'safari',
]

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

function isBrowserSession(session: Pick<AppSession, 'bundleId' | 'appName' | 'category'>): boolean {
  if (session.category === 'browsing') return true
  const haystack = `${session.bundleId} ${session.appName}`.toLowerCase()
  return BROWSER_KEYWORDS.some((keyword) => haystack.includes(keyword))
}

function prettyCategory(category: AppCategory): string {
  if (category === 'aiTools') return 'AI Tools'
  return category
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function appCategoryIsFocused(category: AppCategory): boolean {
  return FOCUSED_CATEGORIES.includes(category)
}

function dominantCategoryFromDistribution(distribution: Partial<Record<AppCategory, number>>): AppCategory {
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

function effectiveSessionsFor(sessions: AppSession[]): EffectiveSession[] {
  if (sessions.length <= 2) {
    return sessions.map((session) => ({ session, effectiveCategory: session.category }))
  }

  const categories = sessions.map((session) => session.category)
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
    const previousEnd = previous.endTime ?? (previous.startTime + previous.durationSeconds * 1000)
    if (current.startTime - previousEnd > IDLE_GAP_THRESHOLD_MS) {
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
  const mapping: Record<string, string> = {
    'x.com': 'X.com',
    'twitter.com': 'X.com',
    'youtube.com': 'YouTube',
    'github.com': 'GitHub',
    'mail.google.com': 'Gmail',
    'gmail.com': 'Gmail',
    'docs.google.com': 'Google Docs',
    'meet.google.com': 'Google Meet',
    'calendar.google.com': 'Google Calendar',
    'drive.google.com': 'Google Drive',
    'reddit.com': 'Reddit',
    'stackoverflow.com': 'Stack Overflow',
    'linkedin.com': 'LinkedIn',
    'facebook.com': 'Facebook',
    'instagram.com': 'Instagram',
    'slack.com': 'Slack',
    'notion.so': 'Notion',
    'figma.com': 'Figma',
    'chatgpt.com': 'ChatGPT',
    'chat.openai.com': 'ChatGPT',
    'claude.ai': 'Claude',
    'discord.com': 'Discord',
  }

  if (mapping[domain]) return mapping[domain]
  const suffixMatch = Object.entries(mapping).find(([key]) => domain.endsWith(`.${key}`))
  if (suffixMatch) return suffixMatch[1]

  const stripped = domain.startsWith('www.') ? domain.slice(4) : domain
  const base = stripped.split('.')[0] ?? stripped
  return base ? `${base[0].toUpperCase()}${base.slice(1)}` : domain
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

function topAppsFromSessions(sessions: AppSession[]): WorkContextAppSummary[] {
  const grouped = new Map<string, WorkContextAppSummary>()

  for (const session of sessions) {
    const existing = grouped.get(session.bundleId)
    if (existing) {
      existing.totalSeconds += session.durationSeconds
      existing.sessionCount += 1
      continue
    }

    grouped.set(session.bundleId, {
      bundleId: session.bundleId,
      appName: session.appName,
      category: session.category,
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

function buildBlockFromCandidate(
  candidate: CandidateBlock,
  db: Database.Database,
): WorkContextBlock {
  const effectiveSessions = effectiveSessionsFor(candidate.sessions)
  const distribution = categoryDistributionFor(effectiveSessions)
  const dominantCategory = dominantCategoryFromDistribution(distribution)
  const coherence = coherenceScore(distribution)
  const switchCount = countAppSwitches(candidate.sessions)
  const websites = getWebsiteSummariesForRange(db, candidate.sessions[0].startTime, candidate.sessions[candidate.sessions.length - 1].endTime ?? (candidate.sessions[candidate.sessions.length - 1].startTime + candidate.sessions[candidate.sessions.length - 1].durationSeconds * 1000)).slice(0, 5)
  const keyPagesByDomain = getTopPagesForDomains(db, candidate.sessions[0].startTime, candidate.sessions[candidate.sessions.length - 1].endTime ?? (candidate.sessions[candidate.sessions.length - 1].startTime + candidate.sessions[candidate.sessions.length - 1].durationSeconds * 1000), websites.map((site) => site.domain), 2)
  const keyPages = websites.flatMap((site) => keyPagesByDomain[site.domain] ?? [])
    .map((page) => page.title?.trim())
    .filter((title): title is string => Boolean(title))
    .filter((title, index, titles) => titles.indexOf(title) === index)
    .slice(0, 4)

  const blockStart = candidate.sessions[0].startTime
  const lastSession = candidate.sessions[candidate.sessions.length - 1]
  const blockEnd = lastSession.endTime ?? (lastSession.startTime + lastSession.durationSeconds * 1000)
  const isLive = candidate.sessions.some((session) => session.id === -1)
  // For live blocks the end time changes every poll, which would continuously invalidate
  // the renderer's insight cache. Use only startTime in the ID so the cache key stays
  // stable for the duration of the live session.
  const blockId = isLive ? `live-${blockStart}` : `${blockStart}-${blockEnd}`

  const baseBlock: WorkContextBlock = {
    id: blockId,
    startTime: blockStart,
    endTime: blockEnd,
    dominantCategory,
    categoryDistribution: distribution,
    ruleBasedLabel: labelForCandidate(candidate, dominantCategory, distribution, coherence, switchCount),
    aiLabel: null,
    sessions: candidate.sessions,
    topApps: topAppsFromSessions(candidate.sessions),
    websites,
    keyPages,
    switchCount,
    confidence: confidenceForCandidate(candidate, coherence),
    isLive,
  }

  return {
    ...baseBlock,
    ruleBasedLabel: websiteAwareLabel(baseBlock),
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

function buildBlocksForSessions(db: Database.Database, sessions: AppSession[]): WorkContextBlock[] {
  return coarseSegmentsFromSessions(sessions)
    .flatMap((segment) => analyzeSessions(segment.sessions, segment.boundedBeforeGap, segment.boundedAfterGap))
    .map((candidate) => buildBlockFromCandidate(candidate, db))
}

function mergeLiveSession(sessions: AppSession[], liveSession?: LiveSession | null): AppSession[] {
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
    },
  ].sort((left, right) => left.startTime - right.startTime)
}

export function userVisibleLabelForBlock(block: WorkContextBlock, overrideLabel?: string | null): string {
  const preferred = overrideLabel ?? block.aiLabel
  if (preferred && preferred.trim() && !GENERIC_LABELS.has(preferred.trim())) {
    return preferred.trim()
  }

  if (block.ruleBasedLabel.trim() && !GENERIC_LABELS.has(block.ruleBasedLabel.trim())) {
    return block.ruleBasedLabel.trim()
  }

  const websiteLabels = block.websites
    .map((site) => shortDomainLabel(site.domain))
    .filter((label, index, labels) => labels.indexOf(label) === index)
  if (websiteLabels.length >= 2) return `${websiteLabels[0]} + ${websiteLabels[1]}`
  if (websiteLabels.length === 1) return websiteLabels[0]

  const appLabels = block.topApps.filter((app) => !app.isBrowser && app.category !== 'system' && app.category !== 'uncategorized')
  if (appLabels.length >= 2) return `${appLabels[0].appName} + ${appLabels[1].appName}`
  if (appLabels.length === 1) return appLabels[0].appName

  return prettyCategory(block.dominantCategory)
}

export function fallbackNarrativeForBlock(block: WorkContextBlock): string {
  const label = userVisibleLabelForBlock(block)
  const duration = formatDuration(Math.round((block.endTime - block.startTime) / 1000))
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

export function getHistoryDayPayload(
  db: Database.Database,
  dateStr: string,
  liveSession?: LiveSession | null,
): HistoryDayPayload {
  const [fromMs, toMs] = localDayBounds(dateStr)
  const sessions = mergeLiveSession(getSessionsForRange(db, fromMs, toMs), liveSession)
  const websites = getWebsiteSummariesForRange(db, fromMs, toMs)
  const blocks = buildBlocksForSessions(db, sessions)
  const totalSeconds = sessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  const focusSeconds = sessions
    .filter((session) => session.isFocused)
    .reduce((sum, session) => sum + session.durationSeconds, 0)

  return {
    date: dateStr,
    sessions,
    websites,
    blocks,
    totalSeconds,
    focusSeconds,
    focusPct: totalSeconds > 0 ? Math.round((focusSeconds / totalSeconds) * 100) : 0,
    appCount: new Set(sessions.map((session) => session.bundleId)).size,
    siteCount: websites.length,
  }
}
