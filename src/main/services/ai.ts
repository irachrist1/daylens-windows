// AI service — wraps @anthropic-ai/sdk, runs in main process only
// Renderer communicates via IPC (never direct SDK access)
import Anthropic from '@anthropic-ai/sdk'
import {
  appendConversationMessage,
  clearConversation,
  getConversationMessages,
  getOrCreateConversation,
  getAppSummariesForRange,
  getWebsiteSummariesForRange,
} from '../db/queries'
import { getDb } from './database'
import { getSettings } from './settings'

function buildClient(): Anthropic {
  const { anthropicApiKey } = getSettings()
  if (!anthropicApiKey) throw new Error('No API key configured')
  return new Anthropic({ apiKey: anthropicApiKey })
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

function buildDayContext(): string {
  try {
    const db = getDb()
    const now = new Date()
    const [todayFrom, todayTo] = dayBounds(now)
    const summaries = getAppSummariesForRange(db, todayFrom, todayTo)
    const websites = getWebsiteSummariesForRange(db, todayFrom, todayTo)
    if (summaries.length === 0 && websites.length === 0) {
      return 'No activity recorded yet today.'
    }

    const totalSec = summaries.reduce((s, a) => s + a.totalSeconds, 0)
    const focusSec = summaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
    const focusPct = totalSec > 0 ? Math.round((focusSec / totalSec) * 100) : 0
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
      if (daySummaries.length === 0) continue
      const dayTotal = daySummaries.reduce((sum, item) => sum + item.totalSeconds, 0)
      const dayFocus = daySummaries.filter((item) => item.isFocused).reduce((sum, item) => sum + item.totalSeconds, 0)
      const dayFocusPct = dayTotal > 0 ? Math.round((dayFocus / dayTotal) * 100) : 0
      const topApp = daySummaries[0]
      recentDays.push(
        `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ` +
        `${formatDuration(dayTotal)} total, ${dayFocusPct}% focus share, top app ${topApp?.appName ?? 'n/a'}`,
      )
    }

    return [
      'Data notes:',
      '- App totals are grounded in tracked foreground-window sessions.',
      '- Focus share is derived from focused app categories and may not fully capture productive browser work.',
      '- Website timing comes from local browser evidence and may be approximate.',
      '',
      'Today:',
      `- Total tracked time: ${formatDuration(totalSec)}`,
      `- Focus share: ${focusPct}% (${formatDuration(focusSec)})`,
      `- Top categories: ${topCategoryList || 'none yet'}`,
      `- Top apps: ${topApps || 'none yet'}`,
      `- Top websites: ${topSites || 'none yet'}`,
      '',
      recentDays.length > 0 ? 'Recent days:' : '',
      ...recentDays.map((line) => `- ${line}`),
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

export async function sendMessage(userMessage: string): Promise<string> {
  const client = buildClient()
  const db = getDb()
  const conversationId = getOrCreateConversation(db)

  appendConversationMessage(db, conversationId, 'user', userMessage)

  const history = getConversationMessages(db, conversationId)
  // Last message is the one we just inserted — send all but that as prior context
  const prior = history.slice(0, -1)

  const dayContext = buildDayContext()
  const systemPrompt =
    'You are Daylens, a personal productivity coach embedded in a local screen-time tracker. ' +
    'You have access to tracked local activity data and should answer as a careful analyst, not a hype machine.\n\n' +
    'When answering:\n' +
    '- Lead with specific tracked facts when available\n' +
    '- Separate tracked facts from interpretation or advice\n' +
    '- If the data is insufficient to answer accurately, say so directly\n' +
    '- Never imply certainty about the exact task the user was doing unless the data explicitly supports it\n' +
    '- Treat website timing as approximate browser evidence unless the question is only about websites\n' +
    '- If you include recommendations, clearly label them as suggestions\n' +
    '- Prefer short headings like "Tracked facts" and "Suggestions" when both are present\n' +
    '- Keep responses concise and grounded\n\n' +
    (dayContext
      ? `Tracked local data context:\n${dayContext}`
      : 'No activity has been recorded yet today. If the user asks about stats, say tracking needs more time to collect evidence.')

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      ...prior.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ],
  })

  const assistantText =
    response.content[0].type === 'text' ? response.content[0].text : ''

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
