// AI service — runs in the main process only and routes to the selected provider.
// Renderer communicates via IPC (never direct SDK access)
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI, type Content as GoogleContent } from '@google/genai'
import {
  appendConversationMessage,
  clearConversation,
  getConversationMessages,
  getOrCreateConversation,
  getAppSummariesForRange,
  getPeakHours,
  getSessionsForRange,
  getWebsiteSummariesForRange,
  getRecentFocusSessions,
  getCategoryOverrides,
} from '../db/queries'
import { getDb } from './database'
import { getApiKey, getSettings } from './settings'
import { computeEnhancedFocusScore } from '../lib/focusScore'
import type { AIProvider } from '@shared/types'

const GOOGLE_CLIENT_HEADER = 'daylens-windows/1.0.0'

interface ResolvedProviderConfig {
  provider: AIProvider
  apiKey: string
  model: string
}

type ConversationMessage = { role: 'user' | 'assistant'; content: string }

async function resolveProviderConfig(): Promise<ResolvedProviderConfig> {
  const settings = getSettings()
  const orderedProviders = [
    settings.aiProvider ?? 'anthropic',
    'anthropic',
    'openai',
    'google',
  ].filter((provider, index, providers) => providers.indexOf(provider) === index) as AIProvider[]

  for (const provider of orderedProviders) {
    const apiKey = await getApiKey(provider)
    if (!apiKey) continue

    return {
      provider,
      apiKey,
      model: modelForProvider(provider),
    }
  }

  throw new Error('No API key configured for the selected AI provider')
}

function modelForProvider(provider: AIProvider): string {
  const settings = getSettings()
  switch (provider) {
    case 'openai':
      return settings.openaiModel || 'gpt-5.4'
    case 'google':
      return settings.googleModel || 'gemini-3.1-flash-lite-preview'
    case 'anthropic':
    default:
      return settings.anthropicModel || 'claude-opus-4-6'
  }
}

function providerLabel(provider: AIProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'google':
      return 'Google Gemini'
    case 'anthropic':
    default:
      return 'Anthropic Claude'
  }
}

function openAIInputFromHistory(messages: ConversationMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

function googleHistoryFromMessages(messages: ConversationMessage[]): GoogleContent[] {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }))
}

async function sendWithAnthropic(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey })
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      ...prior.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: userMessage },
    ],
  })

  return response.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('')
}

async function sendWithOpenAI(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  const client = new OpenAI({ apiKey: config.apiKey })
  const response = await client.responses.create({
    model: config.model,
    instructions: systemPrompt,
    input: openAIInputFromHistory([
      ...prior,
      { role: 'user', content: userMessage },
    ]),
    max_output_tokens: 1024,
    store: false,
  })

  return response.output_text || ''
}

async function sendWithGoogle(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      headers: {
        'x-goog-api-client': GOOGLE_CLIENT_HEADER,
      },
    },
  })
  const chat = ai.chats.create({
    model: config.model,
    config: {
      systemInstruction: systemPrompt,
    },
    history: googleHistoryFromMessages(prior),
  })

  const response = await chat.sendMessage({ message: userMessage })
  return response.text ?? ''
}

async function sendWithProvider(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
): Promise<string> {
  switch (config.provider) {
    case 'openai':
      return sendWithOpenAI(config, systemPrompt, prior, userMessage)
    case 'google':
      return sendWithGoogle(config, systemPrompt, prior, userMessage)
    case 'anthropic':
    default:
      return sendWithAnthropic(config, systemPrompt, prior, userMessage)
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${seconds}s`
}

function dayBounds(date: Date): [number, number] {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return [from, from + 86_400_000]
}

function countSwitches(sessions: { bundleId: string }[]): number {
  let switches = 0
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].bundleId !== sessions[i - 1].bundleId) {
      switches++
    }
  }
  return switches
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTimeLabel(ms: number): string {
  return `${formatShortDate(ms)} at ${formatClock(ms)}`
}

function uniqueAppNames(names: string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) === index)
}

function sessionEndMs(session: { startTime: number; endTime: number | null; durationSeconds: number }): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1000)
}

function buildRecentFocusContext(): string {
  try {
    const db = getDb()
    const sessions = getRecentFocusSessions(db, 5)
    if (sessions.length === 0) return 'Recent focus sessions: none recorded.'

    const lines = sessions.map((session) => {
      const apps = uniqueAppNames(
        getSessionsForRange(db, session.startTime, sessionEndMs(session))
          .map((item) => item.appName),
      ).slice(0, 5)

      const plan = session.plannedApps.length > 0
        ? session.plannedApps.join(', ')
        : 'not set'
      const observed = apps.length > 0 ? apps.join(', ') : 'none tracked'
      const target = session.targetMinutes ? `, target ${session.targetMinutes}m` : ''

      return `- ${formatDateTimeLabel(session.startTime)}: ${session.label || 'Focus session'} for ${formatDuration(session.durationSeconds)}${target}; planned apps ${plan}; observed apps ${observed}`
    })

    return ['Recent focus sessions:', ...lines].join('\n')
  } catch {
    return 'Recent focus sessions: unavailable.'
  }
}

function parseTimeParts(hourRaw: string, minuteRaw?: string, meridiemRaw?: string): { hour: number; minute: number } | null {
  let hour = Number(hourRaw)
  const minute = Number(minuteRaw ?? '0')
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null

  const meridiem = meridiemRaw?.toLowerCase()
  if (meridiem === 'am') {
    if (hour === 12) hour = 0
  } else if (meridiem === 'pm') {
    if (hour < 12) hour += 12
  }

  if (hour < 0 || hour > 23) return null
  return { hour, minute }
}

function parseTemporalLookup(userMessage: string): { label: string; targetMs: number; dayStart: number; dayEnd: number } | null {
  const lower = userMessage.toLowerCase()
  const now = new Date()

  const relativeFirst = lower.match(/\b(today|yesterday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  const timeFirst = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(today|yesterday)\b/)
  const isoDate = lower.match(/\b(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)

  let baseDate: Date | null = null
  let label = ''
  let timeParts: { hour: number; minute: number } | null = null

  if (relativeFirst) {
    baseDate = new Date(now)
    if (relativeFirst[1] === 'yesterday') baseDate.setDate(baseDate.getDate() - 1)
    label = relativeFirst[1]
    timeParts = parseTimeParts(relativeFirst[2], relativeFirst[3], relativeFirst[4])
  } else if (timeFirst) {
    baseDate = new Date(now)
    if (timeFirst[4] === 'yesterday') baseDate.setDate(baseDate.getDate() - 1)
    label = timeFirst[4]
    timeParts = parseTimeParts(timeFirst[1], timeFirst[2], timeFirst[3])
  } else if (isoDate) {
    const [year, month, day] = isoDate[1].split('-').map(Number)
    baseDate = new Date(year, month - 1, day)
    label = isoDate[1]
    timeParts = parseTimeParts(isoDate[2], isoDate[3], isoDate[4])
  }

  if (!baseDate || !timeParts) return null

  baseDate.setHours(timeParts.hour, timeParts.minute, 0, 0)
  const dayStart = new Date(baseDate)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  return {
    label,
    targetMs: baseDate.getTime(),
    dayStart: dayStart.getTime(),
    dayEnd: dayEnd.getTime(),
  }
}

function buildSpecificTimeContext(userMessage: string): string {
  try {
    const lookup = parseTemporalLookup(userMessage)
    if (!lookup) return ''

    const db = getDb()
    const daySessions = getSessionsForRange(db, lookup.dayStart, lookup.dayEnd)
    const containing = daySessions.find((session) => {
      const end = sessionEndMs(session)
      return lookup.targetMs >= session.startTime && lookup.targetMs < end
    })
    const windowStart = lookup.targetMs - 45 * 60 * 1000
    const windowEnd = lookup.targetMs + 45 * 60 * 1000
    const nearby = daySessions
      .filter((session) => sessionEndMs(session) > windowStart && session.startTime < windowEnd)
      .slice(0, 5)
    const nearbySites = getWebsiteSummariesForRange(db, windowStart, windowEnd).slice(0, 3)
    const focusSession = getRecentFocusSessions(db, 50).find((session) => {
      const end = sessionEndMs(session)
      return lookup.targetMs >= session.startTime && lookup.targetMs < end
    })

    const lines: string[] = [
      `Specific timeline lookup for ${lookup.label} (${formatDateTimeLabel(lookup.targetMs)}):`,
    ]

    if (containing) {
      lines.push(
        `- Foreground app at that time: ${containing.appName} (${containing.category}), ${formatClock(containing.startTime)}-${formatClock(sessionEndMs(containing))}.`,
      )
    } else {
      lines.push('- No foreground app session covers that exact time.')
    }

    if (nearby.length > 0) {
      lines.push(
        `- Nearby sessions: ${nearby.map((session) => `${session.appName} ${formatClock(session.startTime)}-${formatClock(sessionEndMs(session))}`).join(', ')}.`,
      )
    }

    if (focusSession) {
      const plan = focusSession.plannedApps.length > 0
        ? focusSession.plannedApps.join(', ')
        : 'not set'
      lines.push(
        `- Focus session overlap: ${focusSession.label || 'Focus session'} for ${formatDuration(focusSession.durationSeconds)}${focusSession.targetMinutes ? ` with ${focusSession.targetMinutes}m target` : ''}; planned apps ${plan}.`,
      )
    }

    if (nearbySites.length > 0) {
      lines.push(
        `- Browser evidence near that time: ${nearbySites.map((site) => `${site.domain} (${formatDuration(site.totalSeconds)})`).join(', ')}.`,
      )
    }

    return lines.join('\n')
  } catch {
    return ''
  }
}

function buildDayContext(): string {
  try {
    const db = getDb()
    const settings = getSettings()
    const now = new Date()
    const [todayFrom, todayTo] = dayBounds(now)
    const summaries = getAppSummariesForRange(db, todayFrom, todayTo)
    const todaySessions = getSessionsForRange(db, todayFrom, todayTo)
    const websites = getWebsiteSummariesForRange(db, todayFrom, todayTo)
    const peakHours = getPeakHours(db, todayTo - 14 * 86_400_000, todayTo) ?? undefined

    const totalSec = summaries.reduce((s, a) => s + a.totalSeconds, 0)
    const focusSec = summaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
    const switchesPerHour = totalSec > 0 ? countSwitches(todaySessions) / (totalSec / 3600) : 0
    const focusScore = computeEnhancedFocusScore({
      focusedSeconds: focusSec,
      totalSeconds: totalSec,
      switchesPerHour,
      sessions: todaySessions.map((session) => ({
        durationSeconds: session.durationSeconds,
        isFocused: session.isFocused,
      })),
      peakHours,
      currentHour: now.getHours(),
    })
    const goalHours = settings.dailyFocusGoalHours ?? 4
    const goalSec = goalHours * 3600

    // User identity & goals
    const userName = settings.userName || 'the user'
    const goalsStr = settings.userGoals?.length
      ? settings.userGoals.join(', ')
      : 'not specified'
    const goalPct = goalSec > 0 ? Math.round((focusSec / goalSec) * 100) : 0

    // Focus sessions
    const focusSessions = getRecentFocusSessions(db, 10).filter((s) => {
      return s.startTime >= todayFrom && s.startTime < todayTo
    })
    const todayFocusSessionCount = focusSessions.length
    const longestFocusSession = focusSessions.reduce((m, s) => Math.max(m, s.durationSeconds), 0)
    const totalFocusSessionSec = focusSessions.reduce((s, x) => s + x.durationSeconds, 0)

    // Category overrides
    const overrides = getCategoryOverrides(db)
    const overrideEntries = Object.entries(overrides)

    // Time context
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' })

    if (summaries.length === 0 && websites.length === 0) {
      return [
        `User: ${userName}`,
        `Goals: ${goalsStr}`,
        `Daily focus goal: ${goalHours}h target, currently at 0m (0%)`,
        `Current time: ${timeStr}, ${dayStr}`,
        '',
        'No activity recorded yet today.',
      ].join('\n')
    }

    const topCategories = new Map<string, number>()
    for (const summary of summaries) {
      topCategories.set(summary.category, (topCategories.get(summary.category) ?? 0) + summary.totalSeconds)
    }
    const topApps = summaries
      .slice(0, 5)
      .map((a) => `${a.appName} (${formatDuration(a.totalSeconds)}, ${a.category})`)
      .join(', ')
    const topSites = websites
      .slice(0, 5)
      .map((site) => `${site.domain} (${formatDuration(site.totalSeconds)})`)
      .join(', ')
    const topCategoryList = [...topCategories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([category, seconds]) => `${category} (${formatDuration(seconds)})`)
      .join(', ')

    const recentDays: string[] = []
    for (let offset = 1; offset <= 6; offset++) {
      const date = new Date(todayFrom - offset * 86_400_000)
      const [fromMs, toMs] = dayBounds(date)
      const daySummaries = getAppSummariesForRange(db, fromMs, toMs)
      const daySessions = getSessionsForRange(db, fromMs, toMs)
      if (daySummaries.length === 0) continue
      const dayTotal = daySummaries.reduce((sum, item) => sum + item.totalSeconds, 0)
      const dayFocus = daySummaries.filter((item) => item.isFocused).reduce((sum, item) => sum + item.totalSeconds, 0)
      const daySwitchesPerHour = dayTotal > 0 ? countSwitches(daySessions) / (dayTotal / 3600) : 0
      const dayFocusScore = computeEnhancedFocusScore({
        focusedSeconds: dayFocus,
        totalSeconds: dayTotal,
        switchesPerHour: daySwitchesPerHour,
        sessions: daySessions.map((session) => ({
          durationSeconds: session.durationSeconds,
          isFocused: session.isFocused,
        })),
      })
      const topApp = daySummaries[0]
      recentDays.push(
        `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ` +
        `${formatDuration(dayTotal)} total, focus score ${dayFocusScore}, top app ${topApp?.appName ?? 'n/a'}`,
      )
    }

    const recentFocusContext = buildRecentFocusContext()

    return [
      `User: ${userName}`,
      `Goals: ${goalsStr}`,
      `Daily focus goal: ${goalHours}h target, currently at ${formatDuration(focusSec)} (${goalPct}%)`,
      `Current time: ${timeStr}, ${dayStr}`,
      '',
      todayFocusSessionCount > 0
        ? `Focus sessions today: ${todayFocusSessionCount} session${todayFocusSessionCount > 1 ? 's' : ''}, longest ${formatDuration(longestFocusSession)}, total ${formatDuration(totalFocusSessionSec)}`
        : 'Focus sessions today: none',
      overrideEntries.length > 0
        ? `User has recategorized: ${overrideEntries.map(([id, cat]) => `${id} → ${cat}`).join(', ')}`
        : '',
      '',
      'Data notes:',
      '- App totals are grounded in tracked foreground-window sessions.',
      '- Focus score is derived from focused app categories and may not fully capture productive browser work.',
      '- Website timing comes from local browser evidence and may be approximate.',
      '',
      'Today:',
      `- Total tracked time: ${formatDuration(totalSec)}`,
      `- Focus score: ${focusScore} (${formatDuration(focusSec)} in focused apps)`,
      `- Top categories: ${topCategoryList || 'none yet'}`,
      `- Top apps: ${topApps || 'none yet'}`,
      `- Top websites: ${topSites || 'none yet'}`,
      '',
      recentDays.length > 0 ? 'Recent days:' : '',
      ...recentDays.map((line) => `- ${line}`),
      '',
      recentFocusContext,
    ]
      .filter((l) => l !== '')
      .join('\n')
  } catch {
    return ''
  }
}

export async function sendMessage(userMessage: string): Promise<string> {
  const providerConfig = await resolveProviderConfig()
  const db = getDb()
  const conversationId = getOrCreateConversation(db)

  appendConversationMessage(db, conversationId, 'user', userMessage)

  const history = getConversationMessages(db, conversationId)
  // Last message is the one we just inserted — send all but that as prior context
  const prior = history.slice(0, -1)

  const dayContext = buildDayContext()
  const specificTimeContext = buildSpecificTimeContext(userMessage)
  const { userName } = getSettings()
  const persona = userName
    ? `You are Daylens, a personal productivity coach helping ${userName} understand their time.`
    : `You are Daylens, a personal productivity coach embedded in a local screen-time tracker.`
  const systemPrompt =
    persona + ' You have access to tracked local activity data and should answer as a careful analyst, not a hype machine.\n\n' +
    'When answering:\n' +
    '- Always speak as Daylens, never as a generic model or raw provider persona\n' +
    `- If the user asks what model or provider is powering this chat, say that they are chatting with Daylens and that this conversation is currently powered by ${providerLabel(providerConfig.provider)} using the model ${providerConfig.model}\n` +
    '- Lead with specific tracked facts when available\n' +
    '- Separate tracked facts from interpretation or advice\n' +
    '- If the data is insufficient to answer accurately, say so directly\n' +
    '- Never imply certainty about the exact task the user was doing unless the data explicitly supports it\n' +
    '- For time-specific questions, prefer exact foreground-app evidence and say when no exact session exists\n' +
    '- Treat website timing as approximate browser evidence unless the question is only about websites\n' +
    '- If you include recommendations, clearly label them as suggestions\n' +
    '- Prefer short headings like "Tracked facts" and "Suggestions" when both are present\n' +
    '- Keep responses concise and grounded\n\n' +
    (dayContext
      ? `Tracked local data context:\n${dayContext}`
      : 'No activity has been recorded yet today. If the user asks about stats, say tracking needs more time to collect evidence.') +
    (specificTimeContext ? `\n\nSpecific historical context:\n${specificTimeContext}` : '')

  const assistantText = await sendWithProvider(providerConfig, systemPrompt, prior, userMessage)

  appendConversationMessage(db, conversationId, 'assistant', assistantText)
  return assistantText
}

export function getAIHistory(): { role: 'user' | 'assistant'; content: string }[] {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  return getConversationMessages(db, conversationId)
}

export function clearAIHistory(): void {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  clearConversation(db, conversationId)
}
