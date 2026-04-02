import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AIProvider, AppSession, AppUsageSummary, AppSettings, FocusSession, WebsiteSummary, WeeklySummary } from '@shared/types'
import {
  buildCategoryTotalsFromSummaries,
  calculateFocusTotals,
  computeContextSwitching,
  filterVisibleSessions,
  getFocusStreakDays,
} from '../lib/activity'
import { formatCategory } from '../lib/category'
import { formatDuration, percentOf, todayString } from '../lib/format'
import { ipc } from '../lib/ipc'
import { classifyWebsiteDomain, isDistractingWebsiteCategory } from '../lib/websites'
import { track } from '../lib/analytics'
import { AI_PROVIDER_META } from '../lib/aiProvider'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface AlgorithmicInsight {
  key: string
  tag: string
  headline: string
  body: ReactNode
  icon: ReactNode
  metric?: ReactNode
  action?: ReactNode
  accentColor?: string
}

function IconPeak() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 11.5 5.2 8.2l2.1 2.1L13.8 3.8" />
      <path d="M10.8 3.8h3v3" />
    </svg>
  )
}

function IconSwitch() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.8 3.5H4.5" />
      <path d="m8.8 1 3 2.5-3 2.5" />
      <path d="M4.2 12.5h7.3" />
      <path d="m7.2 15-3-2.5 3-2.5" />
    </svg>
  )
}

function IconFlame() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.1 1.8c1.8 2 3.6 3.6 3.6 6a3.7 3.7 0 0 1-7.4 0c0-1.7.8-3.2 2.3-4.7l1.5 2.4Z" />
    </svg>
  )
}

function IconPie() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v6h6" />
      <path d="M14 8a6 6 0 1 1-6-6" />
    </svg>
  )
}

function IconGlobe() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M2.8 6h10.4" />
      <path d="M2.8 10h10.4" />
      <path d="M8 2c1.7 1.5 2.6 3.5 2.6 6S9.7 12.5 8 14" />
      <path d="M8 2C6.3 3.5 5.4 5.5 5.4 8S6.3 12.5 8 14" />
    </svg>
  )
}

function IconTarget() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.5" />
      <circle cx="8" cy="8" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

function IconSparkle() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2v2.5M11 17.5V20M2 11h2.5M17.5 11H20" />
      <path d="M11 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
      <path d="M5.6 5.6l1.8 1.8M14.6 14.6l1.8 1.8M5.6 16.4l1.8-1.8M14.6 7.4l1.8-1.8" />
    </svg>
  )
}

function inlineNodes(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`([^`]+)`/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const full = match[0]
    if (full.startsWith('**')) {
      parts.push(<strong key={match.index} className="font-semibold">{match[1]}</strong>)
    } else if (full.startsWith('*') || full.startsWith('_')) {
      parts.push(<em key={match.index}>{match[2] ?? match[3]}</em>)
    } else {
      parts.push(<code key={match.index} className="bg-[var(--color-surface-high)] px-1 py-px rounded text-[12px]">{match[4]}</code>)
    }
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function MarkdownBlock({ text, blockKey }: { text: string; blockKey: number }): ReactNode {
  const lines = text.split('\n').map((l) => l.trimEnd())
  const nonEmpty = lines.filter((l) => l.trim())
  if (nonEmpty.length === 0) return null

  if (/^#{1,4}\s/.test(nonEmpty[0])) {
    const level = nonEmpty[0].match(/^(#{1,4})/)?.[1].length ?? 2
    const content = nonEmpty[0].replace(/^#{1,4}\s+/, '')
    const sizeClass = level === 1 ? 'text-[16px]' : level === 2 ? 'text-[14px]' : 'text-[13px]'
    return <p key={blockKey} className={`${sizeClass} font-semibold text-[var(--color-text-primary)] leading-snug`}>{inlineNodes(content)}</p>
  }

  if (nonEmpty.every((l) => /^[-*]\s/.test(l))) {
    return (
      <ul key={blockKey} className="flex flex-col gap-1 pl-1">
        {nonEmpty.map((l, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed">
            <span className="shrink-0 opacity-40 mt-0.5 select-none">-</span>
            <span>{inlineNodes(l.replace(/^[-*]\s+/, ''))}</span>
          </li>
        ))}
      </ul>
    )
  }

  if (nonEmpty.every((l) => /^\d+\.\s/.test(l))) {
    return (
      <ol key={blockKey} className="flex flex-col gap-1 pl-1">
        {nonEmpty.map((l, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed">
            <span className="shrink-0 text-[var(--color-text-tertiary)] tabular-nums min-w-[1.2em] text-right select-none">{l.match(/^(\d+)\./)?.[1] ?? i + 1}.</span>
            <span>{inlineNodes(l.replace(/^\d+\.\s+/, ''))}</span>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <p key={blockKey} className="text-[13px] leading-relaxed">
      {lines.flatMap((l, i) => {
        const nodes = inlineNodes(l)
        return i < lines.length - 1 ? [...nodes, <br key={`br${i}`} />] : nodes
      })}
    </p>
  )
}

function MarkdownMessage({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (blocks.length === 0) return <p className="text-[13px] leading-relaxed">{content}</p>
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((block, i) => <MarkdownBlock key={i} text={block} blockKey={i} />)}
    </div>
  )
}


function overlapSeconds(session: AppSession, startMs: number, endMs: number): number {
  const sessionEnd = session.endTime ?? (session.startTime + session.durationSeconds * 1_000)
  const start = Math.max(session.startTime, startMs)
  const end = Math.min(sessionEnd, endMs)
  if (end <= start) return 0
  return Math.round((end - start) / 1_000)
}

function formatHourRange(startMs: number, endMs: number): string {
  return `${new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric' })}-${new Date(endMs).toLocaleTimeString('en-US', { hour: 'numeric' })}`
}

function buildAlgorithmicInsights(params: {
  settings: AppSettings
  summaries: AppUsageSummary[]
  focusSessions: FocusSession[]
  websites: WebsiteSummary[]
  todaySessions: AppSession[]
}): AlgorithmicInsight[] {
  const { settings, summaries, focusSessions, websites, todaySessions } = params
  const insights: AlgorithmicInsight[] = []
  const { totalSeconds, focusSeconds, focusPct } = calculateFocusTotals(summaries)
  const categoryTotals = buildCategoryTotalsFromSummaries(summaries)
  const visibleSessions = filterVisibleSessions(todaySessions, 10, false)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const startMs = todayStart.getTime()

  if (visibleSessions.length > 0) {
    let bestWindow: { startMs: number; endMs: number; focusSeconds: number; trackedSeconds: number } | null = null
    for (let offset = 0; offset <= 22 * 60; offset += 30) {
      const ws = startMs + offset * 60_000
      const we = ws + 2 * 60 * 60_000
      const tracked = visibleSessions.reduce((s, sess) => s + overlapSeconds(sess, ws, we), 0)
      const focus = visibleSessions.filter((s) => s.isFocused).reduce((s, sess) => s + overlapSeconds(sess, ws, we), 0)
      if (focus === 0) continue
      if (!bestWindow || focus > bestWindow.focusSeconds) bestWindow = { startMs: ws, endMs: we, focusSeconds: focus, trackedSeconds: tracked }
    }
    if (bestWindow && bestWindow.focusSeconds > 0) {
      const restTracked = Math.max(0, totalSeconds - bestWindow.trackedSeconds)
      const restFocus = Math.max(0, focusSeconds - bestWindow.focusSeconds)
      insights.push({
        key: 'peak-hours', tag: 'Peak Hours',
        headline: `${formatHourRange(bestWindow.startMs, bestWindow.endMs)} is your peak window`,
        body: `You do your best focused work in this 2-hour window. Focus score here is ${percentOf(bestWindow.focusSeconds, bestWindow.trackedSeconds)}% vs ${percentOf(restFocus, restTracked)}% for the rest of the day.`,
        icon: <IconPeak />,
        metric: <span>{formatDuration(bestWindow.focusSeconds)}</span>,
        accentColor: 'var(--color-primary)',
      })
    }
  }

  const switching = computeContextSwitching(visibleSessions, { windowMs: 2 * 60 * 60_000, shortSessionSeconds: 180 })
  if (switching.count > 8) {
    insights.push({
      key: 'context-switching', tag: 'Activity',
      headline: `${switching.count} short app sessions in the last 2 hours`,
      body: `Average dwell time before each change was ${formatDuration(switching.averageSeconds)} in this window.`,
      icon: <IconSwitch />,
      metric: <span>{switching.count} short sessions</span>,
      action: <Link to="/focus" style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none' }}>View focus sessions →</Link>,
      accentColor: '#ffb95f',
    })
  }

  const streakDays = getFocusStreakDays(focusSessions)
  const hasFocusToday = focusSessions.some((s) => {
    const d = new Date(s.startTime)
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-') === todayString()
  })
  insights.push({
    key: 'focus-streak', tag: 'Streak',
    headline: streakDays > 0 ? `${streakDays}-day focus streak` : 'No streak yet today',
    body: streakDays > 0
      ? `You've logged intentional focus sessions ${streakDays} days in a row. Keep the momentum going.`
      : `You haven't logged a focus session ${hasFocusToday ? 'today' : 'yet today'}. A 25-minute session now would start your streak.`,
    icon: <IconFlame />,
    metric: <span>{streakDays > 0 ? `${streakDays} days` : '0 days'}</span>,
    action: <Link to="/focus" style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none' }}>Open Focus →</Link>,
    accentColor: '#4fdbc8',
  })

  if (categoryTotals.length > 0) {
    const first = categoryTotals[0]
    const distractionSeconds = categoryTotals.filter((c) => c.category === 'entertainment' || c.category === 'social').reduce((s, c) => s + c.totalSeconds, 0)
    const distractionPct = percentOf(distractionSeconds, totalSeconds)
    const note = settings.userGoals.includes('less-distraction') && distractionPct > 20 ? ' Above your distraction goal.' : ''
    insights.push({
      key: 'time-allocation', tag: 'Allocation',
      headline: `${formatCategory(first.category)} is leading at ${percentOf(first.totalSeconds, totalSeconds)}%`,
      body: `${formatDuration(first.totalSeconds)} in ${formatCategory(first.category)} today.${categoryTotals[1] ? ` ${formatCategory(categoryTotals[1].category)} is second at ${percentOf(categoryTotals[1].totalSeconds, totalSeconds)}%.` : ''}${note}`,
      icon: <IconPie />,
      metric: <span>{categoryTotals.length} categories</span>,
    })
  }

  const distractingSites = websites
    .map((site) => ({ site, cat: classifyWebsiteDomain(site.domain) }))
    .filter(({ site, cat }) => isDistractingWebsiteCategory(cat) && site.totalSeconds > 10 * 60)
    .sort((a, b) => b.site.totalSeconds - a.site.totalSeconds)
  if (distractingSites.length > 0) {
    const top = distractingSites[0]
    const totalWeb = websites.reduce((s, site) => s + site.totalSeconds, 0)
    insights.push({
      key: 'website-distraction', tag: 'Browser',
      headline: `${top.site.domain} took ${formatDuration(top.site.totalSeconds)}`,
      body: `That's ${percentOf(top.site.totalSeconds, totalWeb)}% of your tracked browser time in a distracting category.`,
      icon: <IconGlobe />,
      metric: <span>{top.cat}</span>,
      accentColor: '#f87171',
    })
  }

  const goalSeconds = settings.dailyFocusGoalHours * 3600
  if (goalSeconds > 0) {
    const remaining = Math.max(0, goalSeconds - focusSeconds)
    const status = focusSeconds >= goalSeconds ? 'Goal reached' : focusSeconds >= goalSeconds * 0.75 ? 'On track' : 'Behind'
    insights.push({
      key: 'goal-progress', tag: 'Daily Goal',
      headline: `${status} — ${formatDuration(focusSeconds)} of ${formatDuration(goalSeconds)}`,
      body: focusSeconds >= goalSeconds
        ? 'You cleared your focus target. Protect the quality of what remains in the day.'
        : remaining <= 30 * 60
          ? `Only ${formatDuration(remaining)} left to hit your goal.`
          : `${formatDuration(remaining)} of focused app time still needed.`,
      icon: <IconTarget />,
      metric: <span>{focusPct}%</span>,
      action: <Link to="/focus" style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none' }}>Plan the next block →</Link>,
    })
  }

  return insights
}

function getWeekRange(): string {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const mon = new Date(now)
  mon.setDate(now.getDate() + diff)
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(mon)} – ${fmt(sun)}, ${now.getFullYear()}`
}

interface WeeklyTrendPoint {
  date: string
  label: string
  focusSeconds: number
  totalSeconds: number
  focusScore: number
}

function shiftDateString(dateStr: string, offsetDays: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const next = new Date(year, month - 1, day + offsetDays)
  return [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-')
}

function weekdayLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day)
    .toLocaleDateString('en-US', { weekday: 'short' })
    .slice(0, 3)
}

function buildWeeklyTrend(
  weeklySummary: WeeklySummary | null,
  todayDateStr: string,
  todayFocusSeconds: number,
  todayTotalSeconds: number,
  todayFocusScore: number,
): WeeklyTrendPoint[] {
  const byDate = new Map(
    (weeklySummary?.dailyBreakdown ?? []).map((day) => [day.date, day] as const),
  )

  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftDateString(todayDateStr, index - 6)
    const isToday = date === todayDateStr
    const day = byDate.get(date)
    return {
      date,
      label: weekdayLabel(date),
      focusSeconds: isToday ? todayFocusSeconds : (day?.focusSeconds ?? 0),
      totalSeconds: isToday ? todayTotalSeconds : (day?.totalSeconds ?? 0),
      focusScore: isToday ? todayFocusScore : (day?.focusScore ?? 0),
    }
  })
}

export default function Insights() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'overview' | 'chat'>('overview')
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [summaries, setSummaries] = useState<AppUsageSummary[]>([])
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>([])
  const [websites, setWebsites] = useState<WebsiteSummary[]>([])
  const [todaySessions, setTodaySessions] = useState<AppSession[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [weeklySummary, setWeeklySummary] = useState<WeeklySummary | null>(null)
  const [hoveredTrendDate, setHoveredTrendDate] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      if (document.hidden) return
      try {
        const [history, hasKey, today, recentFocus, siteData, sessionData, currentSettings, weekly] = await Promise.all([
          ipc.ai.getHistory().catch(() => []),
          ipc.settings.hasApiKey().catch(() => false),
          ipc.db.getToday().catch(() => []),
          ipc.focus.getRecent(30).catch(() => []),
          ipc.db.getWebsiteSummaries(1).catch(() => []),
          ipc.db.getHistory(todayString()).catch(() => []),
          ipc.settings.get(),
          ipc.db.getWeeklySummary(todayString()).catch(() => null),
        ])
        if (cancelled) return
        setMessages(history as Message[])
        setHasApiKey(!!hasKey)
        setSummaries(today as AppUsageSummary[])
        setFocusSessions(recentFocus as FocusSession[])
        setWebsites(siteData as WebsiteSummary[])
        setTodaySessions(sessionData as AppSession[])
        setSettings(currentSettings as AppSettings)
        setWeeklySummary((weekly as WeeklySummary | null) ?? null)
      } catch (err) {
        if (cancelled) return
        setMessages([{ role: 'assistant', content: 'Error loading insights: ' + String(err) }])
        setHasApiKey(false)
      }
    }

    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (activeTab !== 'chat') return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeTab, loading])

  async function handleSend(text?: string) {
    const message = (text ?? input).trim()
    if (!message || loading || !hasApiKey) return
    track('insight_generated', { message_length: message.length })
    setInput('')
    setActiveTab('chat')
    setMessages((prev) => [...prev, { role: 'user', content: message }])
    setLoading(true)
    try {
      const reply = (await ipc.ai.sendMessage(message)) as string
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Error: ' + String(err) }])
    } finally {
      setLoading(false)
    }
  }

  if (hasApiKey === null || settings === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Loading...</p>
      </div>
    )
  }

  const totalTracked = summaries.reduce((n, s) => n + s.totalSeconds, 0)
  const focusTracked = summaries.filter((s) => s.isFocused).reduce((n, s) => n + s.totalSeconds, 0)
  const focusPct = percentOf(focusTracked, totalTracked)
  const streakDays = getFocusStreakDays(focusSessions)

  const algorithmicInsights = buildAlgorithmicInsights({ settings, summaries, focusSessions, websites, todaySessions })

  const switching = computeContextSwitching(filterVisibleSessions(todaySessions, 10, false), { windowMs: 2 * 60 * 60_000, shortSessionSeconds: 180 })

  const hasWeekData = (weeklySummary?.dailyBreakdown.some((day) => day.totalSeconds > 0) ?? false) || focusSessions.length > 0
  const weekRange = getWeekRange()

  const today = new Date()
  const todayLabel = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  // ── Render ────────────────────────────────────────────────────────────────
  const isCliProvider = settings.aiProvider === 'claude-cli' || settings.aiProvider === 'codex-cli'
  const showChatInput = hasApiKey === true || isCliProvider

  const peakInsight = algorithmicInsights.find((i) => i.key === 'peak-hours')
  const peakHourText = peakInsight ? peakInsight.headline : null

  const weeklyTrend = buildWeeklyTrend(
    weeklySummary,
    todayString(),
    focusTracked,
    totalTracked,
    focusPct,
  )
  const hoveredTrend = weeklyTrend.find((day) => day.date === hoveredTrendDate) ?? null
  const maxSparkVal = Math.max(...weeklyTrend.map((day) => day.focusSeconds), 1)

  const focusQuality = focusPct >= 70 ? 'Peak Velocity' : focusPct >= 40 ? 'Building Momentum' : 'Getting Started'
  const providerMeta = AI_PROVIDER_META[settings.aiProvider]

  const firstInsight = algorithmicInsights[0]
  const lastAssistantMessage = [...messages].reverse().find((msg) => msg.role === 'assistant')

  function handleApplyRule(insight: AlgorithmicInsight) {
    if (insight.key === 'peak-hours' || insight.key === 'goal-progress' || insight.key === 'focus-streak' || insight.key === 'context-switching') {
      track('insight_rule_applied', { insight_key: insight.key, target: 'focus' })
      navigate('/focus')
      return
    }
    if (insight.key === 'time-allocation' || insight.key === 'website-distraction') {
      track('insight_rule_applied', { insight_key: insight.key, target: 'history' })
      navigate('/history')
      return
    }
    track('insight_rule_applied', { insight_key: insight.key, target: 'chat' })
    setActiveTab('chat')
    setInput(`Turn this insight into a concrete next step: ${insight.headline}`)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Scrollable body ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div style={{ padding: '32px 40px 0', maxWidth: 960, margin: '0 auto', width: '100%' }}>
          <h1 style={{
            fontSize: 36, fontWeight: 900, color: 'var(--color-text-primary)',
            letterSpacing: '-0.03em', margin: '0 0 4px',
          }}>
            {activeTab === 'overview' ? 'Your Week in Review' : 'Ask Daylens'}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontWeight: 500, margin: 0 }}>
            {activeTab === 'overview'
              ? `${todayLabel}${hasWeekData ? ` · ${weekRange}` : ''}`
              : 'The AI thread now lives in its own workspace so the overview stays usable even after a long conversation.'}
          </p>

          <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
            {([
              { key: 'overview', label: 'Overview', description: 'Cards and patterns' },
              { key: 'chat', label: 'AI Workspace', description: 'Dedicated conversation' },
            ] as const).map((tab) => {
              const active = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    minWidth: 188,
                    borderRadius: 10,
                    border: active ? 'none' : '1px solid var(--color-border-ghost)',
                    background: active ? 'linear-gradient(135deg, var(--color-primary), var(--color-primary-glow))' : 'var(--color-surface-container)',
                    color: active ? 'var(--color-primary-contrast)' : 'var(--color-text-primary)',
                    padding: '12px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    cursor: 'pointer',
                    boxShadow: active ? 'var(--color-shadow-soft)' : 'none',
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 900 }}>{tab.label}</span>
                  <span style={{ fontSize: 12, color: active ? 'rgba(246,249,255,0.82)' : 'var(--color-text-secondary)' }}>
                    {tab.description}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Bento grid ─────────────────────────────────────────────────────── */}
        <div style={{ padding: '24px 40px 0', maxWidth: 960, margin: '0 auto', width: '100%' }}>

          {activeTab === 'overview' && (
            <>
          {/* Row 1: AI Summary (60%) + Focus Intensity (40%) */}
          <div style={{ display: 'grid', gridTemplateColumns: '60fr 40fr', gap: 16, marginBottom: 16 }}>

            {/* AI Summary card */}
            <div style={{
              background: 'var(--color-surface-container)', borderRadius: 12,
              padding: 32, position: 'relative', overflow: 'hidden',
              border: '1px solid var(--color-border-ghost)',
              boxShadow: 'var(--color-shadow-soft)',
            }}>
              {/* Decorative blur */}
              <div style={{
                position: 'absolute', top: -80, right: -80,
                width: 200, height: 200,
                background: 'rgba(173,198,255,0.05)',
                borderRadius: '50%', filter: 'blur(40px)',
                pointerEvents: 'none',
              }} />

              {/* Label row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20 }}>
                <span style={{ color: 'var(--color-primary)', display: 'flex' }}>
                  <IconSparkle />
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 900, letterSpacing: '0.15em',
                  textTransform: 'uppercase', color: 'var(--color-primary)',
                }}>
                  Intelligence Summary
                </span>
              </div>

              {/* Summary text */}
              <p style={{
                fontSize: 20, fontWeight: 400, color: 'var(--color-text-primary)',
                lineHeight: 1.6, marginBottom: 24, margin: '0 0 24px',
              }}>
                You&apos;ve focused for{' '}
                <span style={{ fontWeight: 900, color: 'var(--color-primary)', fontStyle: 'italic', letterSpacing: '-0.02em' }}>
                  {formatDuration(focusTracked)}
                </span>
                {' '}today.
                {peakHourText && (
                  <>{' '}Your{' '}
                    <span style={{ fontWeight: 900, color: 'var(--color-primary)', fontStyle: 'italic', letterSpacing: '-0.02em' }}>
                      peak window
                    </span>
                    {' '}is driving your best work.
                  </>
                )}
                {switching.count > 0 && (
                  <>{' '}{switching.count} short app sessions recorded.</>
                )}
              </p>

              {/* Stat chips */}
              <div style={{ display: 'flex', gap: 12 }}>
                {/* Focus % chip */}
                <div style={{
                  padding: '8px 16px', background: 'var(--color-surface-highest)',
                  borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-primary)' }}>
                    {focusPct}%
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.1em', color: 'var(--color-text-secondary)',
                  }}>
                    Focus
                  </span>
                </div>

                {/* Streak chip */}
                {streakDays > 0 && (
                  <div style={{
                    padding: '8px 16px', background: 'var(--color-surface-highest)',
                    borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-tertiary)' }}>
                      {streakDays}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.1em', color: 'var(--color-text-secondary)',
                    }}>
                      Streak
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Focus Intensity card */}
            <div style={{
              background: 'var(--color-surface-low)', borderRadius: 12, padding: 28,
              border: '1px solid var(--color-border-ghost)',
              boxShadow: 'var(--color-shadow-soft)',
              display: 'flex', flexDirection: 'column',
            }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{
                  fontSize: 10, fontWeight: 900, letterSpacing: '0.15em',
                  textTransform: 'uppercase', color: 'var(--color-text-secondary)',
                }}>
                  Focus Intensity
                </span>
                <span style={{ color: 'var(--color-primary)', display: 'flex' }}>
                  <IconPeak />
                </span>
              </div>

              {/* Qualitative label */}
              <p style={{
                fontSize: 24, fontWeight: 900, fontStyle: 'italic',
                color: 'var(--color-text-primary)', letterSpacing: '-0.02em',
                margin: '0 0 8px',
              }}>
                {focusQuality}
              </p>
              {hoveredTrend && (
                <p style={{
                  fontSize: 11,
                  color: hoveredTrend.focusSeconds
                    ? 'var(--color-primary)'
                    : 'var(--color-text-tertiary)',
                  margin: '0 0 14px',
                  minHeight: 16,
                  fontWeight: 700,
                }}>
                  {`${hoveredTrend.label} · ${hoveredTrend.focusSeconds > 0 ? formatDuration(hoveredTrend.focusSeconds) : 'No focused time'}`}
                </p>
              )}

              {/* Bar chart */}
              <div style={{
                display: 'flex', alignItems: 'flex-end', gap: 3,
                height: 80, marginTop: 'auto',
              }}>
                {weeklyTrend.map((entry) => {
                  const isHighest = entry.focusSeconds === maxSparkVal && entry.focusSeconds > 0
                  const isHovered = hoveredTrendDate === entry.date
                  const heightPct = maxSparkVal > 0 ? Math.max((entry.focusSeconds / maxSparkVal) * 100, 10) : 10
                  return (
                    <div
                      key={entry.date}
                      title={`${entry.label}: ${entry.focusSeconds > 0 ? formatDuration(entry.focusSeconds) : 'No focused time'}`}
                      style={{
                        flex: 1,
                        borderRadius: '3px 3px 0 0',
                        background: entry.focusSeconds > 0 ? 'var(--gradient-primary)' : 'var(--color-surface-high)',
                        height: `${heightPct}%`,
                        minHeight: 8,
                        opacity: entry.focusSeconds > 0 ? (isHovered || isHighest ? 1 : 0.42) : 1,
                        boxShadow: isHovered || isHighest ? '0 10px 20px rgba(15,99,219,0.14)' : 'none',
                        transition: 'background 150ms, opacity 120ms ease',
                        cursor: 'default',
                      }}
                      onMouseEnter={() => setHoveredTrendDate(entry.date)}
                      onMouseLeave={() => setHoveredTrendDate(null)}
                    />
                  )
                })}
              </div>
            </div>
          </div>

          {/* Row 2: Pattern cards — 3 columns */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {[0, 1, 2].map((idx) => {
              const insight = algorithmicInsights[idx]
              if (!insight) {
                return <div key={idx} />
              }
              const accent = insight.accentColor ?? 'var(--color-primary)'
              const accentBg = insight.accentColor
                ? `${insight.accentColor}1a`
                : 'var(--color-accent-dim)'
              return (
                <PatternCard
                  key={insight.key}
                  insight={insight}
                  accent={accent}
                  accentBg={accentBg}
                />
              )
            })}
          </div>

          {/* Actionable Intelligence section */}
          {algorithmicInsights.length > 0 && firstInsight && (
            <div style={{ marginBottom: 32 }}>
              {/* Section label */}
              <div style={{
                fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
                letterSpacing: '0.2em', color: 'var(--color-text-secondary)',
                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20,
              }}>
                <span>Actionable Intelligence</span>
                <div style={{ flex: 1, height: 1, background: 'rgba(66,71,84,0.20)' }} />
              </div>

              {/* Glass panel */}
              <div style={{
                background: 'var(--color-glass-bg)',
                backdropFilter: 'blur(20px)',
                borderRadius: 12,
                border: '1px solid var(--color-glass-border)',
                padding: 32,
                display: 'flex', alignItems: 'center', gap: 32,
                position: 'relative', overflow: 'hidden',
              }}>
                {/* Decorative glow */}
                <div style={{
                  position: 'absolute', right: -80, bottom: -80,
                  width: 320, height: 320,
                  background: 'rgba(173,198,255,0.08)',
                  borderRadius: '50%', filter: 'blur(60px)',
                  pointerEvents: 'none',
                }} />

                {/* Icon box */}
                <div style={{
                  width: 80, height: 80, borderRadius: 12,
                  background: 'var(--gradient-primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, boxShadow: '0 8px 32px rgba(173,198,255,0.20)',
                }}>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary-contrast)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4l3 3" />
                  </svg>
                </div>

                {/* Text section */}
                <div style={{ flex: 1, position: 'relative', zIndex: 1 }}>
                  <p style={{
                    fontSize: 18, fontWeight: 900, fontStyle: 'italic',
                    letterSpacing: '-0.02em', color: 'var(--color-text-primary)',
                    margin: '0 0 8px',
                  }}>
                    Optimization Protocol
                  </p>
                  <p style={{
                    fontSize: 15, color: 'var(--color-text-secondary)',
                    lineHeight: 1.7, margin: 0,
                  }}>
                    {firstInsight.body}
                  </p>
                </div>

                {/* Action button */}
                {firstInsight.action ? (
                  <div style={{ flexShrink: 0 }}>
                    {firstInsight.action}
                  </div>
                ) : (
                  <button
                    onClick={() => handleApplyRule(firstInsight)}
                    style={{
                      padding: '12px 24px',
                      background: 'var(--gradient-primary)',
                      color: 'var(--color-primary-contrast)',
                      fontWeight: 900, fontSize: 12,
                      letterSpacing: '-0.01em', textTransform: 'uppercase',
                      borderRadius: 10, border: 'none', cursor: 'pointer',
                      flexShrink: 0, transition: 'transform 150ms',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(0.97)')}
                    onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                  >
                    Apply Rule
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── AI Chat section ───────────────────────────────────────────────── */}
            </>
          )}

          {activeTab === 'chat' && (
          <div style={{
            marginBottom: 0,
            background: 'var(--color-surface-container)',
            borderRadius: 12,
            padding: 24,
            border: '1px solid var(--color-border-ghost)',
            boxShadow: 'var(--color-shadow-soft)',
          }}>
            {/* Section header */}
            <div style={{
              fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
              letterSpacing: '0.2em', color: 'var(--color-text-secondary)',
              display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20,
            }}>
              <span>Ask Daylens</span>
              <div style={{ flex: 1, height: 1, background: 'rgba(66,71,84,0.20)' }} />
              {lastAssistantMessage && (
                <span style={{
                  maxWidth: 240,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 'normal',
                  textTransform: 'none',
                  color: 'var(--color-text-tertiary)',
                }}>
                  {lastAssistantMessage.content}
                </span>
              )}
              {messages.length > 0 && (
                <button
                  onClick={() => void ipc.ai.clearHistory().then(() => setMessages([]))}
                  style={{
                    fontSize: 11, fontWeight: 700, background: 'none', border: 'none',
                    cursor: 'pointer', color: 'var(--color-text-secondary)',
                    padding: '2px 6px', borderRadius: 5, letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-secondary)')}
                >
                  New chat
                </button>
              )}
            </div>

            {/* No API key state */}
            {!showChatInput && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 14, padding: '40px 0', textAlign: 'center',
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: 'var(--color-accent-dim)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--color-primary)',
                }}>
                  <IconSparkle />
                </div>
                <div>
                  <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)', margin: '0 0 6px' }}>
                    Ask about your day
                  </p>
                  <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 260, margin: '0 auto' }}>
                    Add your {providerMeta.label} API key to ask questions about your productivity.
                  </p>
                </div>
                <Link
                  to="/settings"
                  style={{
                    padding: '9px 20px', borderRadius: 8,
                    background: 'var(--gradient-primary)',
                    color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 700, textDecoration: 'none',
                  }}
                >
                  Add API key →
                </Link>
              </div>
            )}

            {/* Chat with API key or CLI */}
            {showChatInput && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {/* Empty state */}
                {messages.length === 0 && !loading && (
                  <div style={{ marginBottom: 20 }}>
                    <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 6px', letterSpacing: '-0.02em' }}>
                      Ask about your day
                    </p>
                    <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px', lineHeight: 1.6 }}>
                      What were you working on? When did you settle in best? What changed your activity most?
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8 }}>
                      {[
                        'What was I working on today?',
                        'What changed most in my day?',
                        'When was I most focused?',
                        'Where did my time go?',
                      ].map((prompt) => (
                        <StarterPromptButton key={prompt} prompt={prompt} onSend={() => void handleSend(prompt)} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Messages */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {messages.map((msg, i) =>
                    msg.role === 'user' ? (
                      /* User bubble */
                      <div key={i} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <div style={{
                          background: 'var(--color-accent-dim)',
                          color: 'var(--color-primary)',
                          padding: '10px 14px',
                          borderRadius: '12px 12px 3px 12px',
                          fontSize: 13, fontWeight: 500,
                          maxWidth: '72%',
                        }}>
                          {msg.content}
                        </div>
                      </div>
                    ) : (
                      /* AI response */
                      <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <div style={{
                          width: 24, height: 24, borderRadius: 6,
                          background: 'var(--color-accent-dim)',
                          color: 'var(--color-primary)',
                          fontSize: 11, fontWeight: 900,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, marginTop: 1,
                        }}>
                          D
                        </div>
                        <div style={{
                          flex: 1,
                          fontSize: 13,
                          color: 'var(--color-text-primary)',
                          lineHeight: 1.7,
                          paddingBottom: i < messages.length - 1 ? 14 : 8,
                          borderBottom: i < messages.length - 1 ? '1px solid var(--color-border-ghost)' : 'none',
                        }}>
                          <MarkdownMessage content={msg.content} />
                          {/* Follow-up chips after last assistant message */}
                          {i === messages.length - 1 && !loading && (
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                              {[
                                'What changed most?',
                                'Where did my time go?',
                                ...(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b(morning|afternoon|evening)\b/i.test(msg.content)
                                  ? ['What was I doing then?'] : []),
                              ].map((chip) => (
                                <button
                                  key={chip}
                                  onClick={() => void handleSend(chip)}
                                  style={{
                                    padding: '5px 12px', borderRadius: 999, fontSize: 12,
                                    border: '1px solid var(--color-border-ghost)',
                                    background: 'transparent',
                                    color: 'var(--color-text-secondary)',
                                    cursor: 'pointer', fontFamily: 'inherit',
                                    transition: 'border-color 120ms, color 120ms',
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.borderColor = 'var(--color-primary)'
                                    e.currentTarget.style.color = 'var(--color-primary)'
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.borderColor = 'var(--color-border-ghost)'
                                    e.currentTarget.style.color = 'var(--color-text-secondary)'
                                  }}
                                >
                                  {chip}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  )}

                  {/* Loading indicator */}
                  {loading && (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <div style={{
                        width: 24, height: 24, borderRadius: 6,
                        background: 'var(--color-accent-dim)', color: 'var(--color-primary)',
                        fontSize: 11, fontWeight: 900,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        D
                      </div>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center', height: 24 }}>
                        {[0, 150, 300].map((delay) => (
                          <div
                            key={delay}
                            className="rounded-full animate-pulse"
                            style={{ width: 6, height: 6, background: 'var(--color-text-tertiary)', animationDelay: `${delay}ms` }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              </div>
            )}
          </div>
          )}

          <div style={{ height: 20 }} />
        </div>
      </div>

      {/* ── Pinned input bar ─────────────────────────────────────────────────── */}
      {showChatInput && activeTab === 'chat' && (
        <div style={{
          borderTop: '1px solid rgba(66,71,84,0.15)',
          padding: '12px 40px 14px',
          background: 'var(--color-bg)',
        }}>
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--color-surface-container)',
              borderRadius: 10,
              padding: '0 6px 0 16px',
              border: '1px solid rgba(66,71,84,0.15)',
            }}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleSend()}
                placeholder="Ask about your productivity..."
                disabled={loading}
                style={{
                  flex: 1, height: 40, background: 'none', border: 'none', outline: 'none',
                  fontSize: 13, color: 'var(--color-text-primary)',
                  opacity: loading ? 0.5 : 1,
                }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={loading || !input.trim()}
                style={{
                  height: 30, padding: '0 14px', borderRadius: 7, border: 'none',
                  cursor: loading || !input.trim() ? 'default' : 'pointer',
                  background: input.trim() && !loading ? 'var(--gradient-primary)' : 'var(--color-surface-high)',
                  color: input.trim() && !loading ? 'var(--color-primary-contrast)' : 'var(--color-text-tertiary)',
                  fontSize: 12, fontWeight: 700,
                  transition: 'background 150ms, color 150ms',
                  flexShrink: 0,
                }}
              >
                Send
              </button>
            </div>
            {/* Mode label */}
            <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: '6px 0 0', lineHeight: 1.4 }}>
              {settings.aiProvider === 'claude-cli'
                ? 'Exact answers use local data. Analysis uses your Claude subscription.'
                : settings.aiProvider === 'codex-cli'
                  ? 'Exact answers use local data. Analysis uses your OpenAI subscription.'
                  : hasApiKey
                    ? `Exact answers use local data. Analysis uses your ${AI_PROVIDER_META[settings.aiProvider as AIProvider].label} key.`
                    : 'Exact answers use local data. Connect AI in Settings for deeper analysis.'}
            </p>
          </div>
        </div>
      )}

    </div>
  )
}

function PatternCard({
  insight,
  accent,
  accentBg,
}: {
  insight: AlgorithmicInsight
  accent: string
  accentBg: string
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{
        background: hovered ? 'var(--color-surface-high)' : 'var(--color-surface-container)',
        padding: 24, borderRadius: 12,
        border: '1px solid var(--color-border-ghost)',
        boxShadow: 'var(--color-shadow-soft)',
        transition: 'background 200ms',
        cursor: 'default',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Icon box */}
      <div style={{
        width: 40, height: 40, borderRadius: 12,
        background: accentBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 16, color: accent,
      }}>
        {insight.icon}
      </div>
      {/* Tag */}
      <p style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.12em', color: 'var(--color-text-secondary)',
        marginBottom: 4, margin: '0 0 4px',
      }}>
        {insight.tag}
      </p>
      {/* Headline */}
      <p style={{
        fontSize: 18, fontWeight: 900, color: 'var(--color-text-primary)',
        marginBottom: 6, margin: '4px 0 6px', letterSpacing: '-0.01em',
      }}>
        {insight.headline}
      </p>
      {/* Body */}
      <p style={{
        fontSize: 12, color: 'var(--color-text-secondary)',
        lineHeight: 1.6, margin: 0,
      }}>
        {insight.body}
      </p>
    </div>
  )
}

function StarterPromptButton({ prompt, onSend }: { prompt: string; onSend: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onSend}
      style={{
        background: hovered ? 'var(--color-surface-high)' : 'var(--color-surface-container)',
        borderRadius: 10, padding: '14px 16px', fontSize: 13,
        color: hovered ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        cursor: 'pointer', border: '1px solid var(--color-border-ghost)', textAlign: 'left',
        transition: 'background 150ms, color 150ms',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {prompt}
    </button>
  )
}
