import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AIProvider, AppSession, AppUsageSummary, AppSettings, FocusSession, WebsiteSummary } from '@shared/types'
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
      action: <Link to="/timeline" style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none' }}>View timeline →</Link>,
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
    action: <Link to="/timeline" style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none' }}>Open Timeline →</Link>,
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
      action: <Link to="/timeline" style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none' }}>View timeline →</Link>,
    })
  }

  return insights
}

export default function Insights() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [summaries, setSummaries] = useState<AppUsageSummary[]>([])
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>([])
  const [websites, setWebsites] = useState<WebsiteSummary[]>([])
  const [todaySessions, setTodaySessions] = useState<AppSession[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [cliTools, setCliTools] = useState<{ claude: string | null; codex: string | null } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  loadingRef.current = loading

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      if (document.hidden) return
      try {
        const [history, hasKey, today, recentFocus, siteData, sessionData, currentSettings, , detectedCliTools] = await Promise.all([
          ipc.ai.getHistory().catch(() => []),
          ipc.settings.hasApiKey().catch(() => false),
          ipc.db.getToday().catch(() => []),
          ipc.focus.getRecent(30).catch(() => []),
          ipc.db.getWebsiteSummaries(1).catch(() => []),
          ipc.db.getHistory(todayString()).catch(() => []),
          ipc.settings.get(),
          ipc.db.getWeeklySummary(todayString()).catch(() => null),
          ipc.ai.detectCliTools().catch(() => ({ claude: null, codex: null })),
        ])
        if (cancelled) return
        // Don't overwrite messages while an AI request is in flight — the
        // pending user message and optimistic state would be lost.
        if (!loadingRef.current) {
          setMessages(history as Message[])
        }
        const current = currentSettings as AppSettings
        const resolvedCliTools = detectedCliTools as { claude: string | null; codex: string | null }
        const cliReady = current.aiProvider === 'claude-cli'
          ? !!resolvedCliTools.claude
          : current.aiProvider === 'codex-cli'
            ? !!resolvedCliTools.codex
            : !!hasKey
        setHasApiKey(cliReady)
        setSummaries(today as AppUsageSummary[])
        setFocusSessions(recentFocus as FocusSession[])
        setWebsites(siteData as WebsiteSummary[])
        setTodaySessions(sessionData as AppSession[])
        setSettings(current)
        setCliTools(resolvedCliTools)
      } catch {
        if (cancelled) return
        // Don't overwrite existing messages on a background refresh failure.
        // Only reset API key / CLI state so the send button stays disabled.
        setHasApiKey(false)
        setCliTools({ claude: null, codex: null })
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function handleSend(text?: string) {
    const message = (text ?? input).trim()
    if (!message || loading || !hasApiKey) return
    track('insight_generated', { message_length: message.length })
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: message }])
    setLoading(true)
    try {
      const reply = (await ipc.ai.sendMessage(message)) as string
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      setMessages((prev) => [...prev, { role: 'assistant', content: errMsg }])
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

  const algorithmicInsights = buildAlgorithmicInsights({ settings, summaries, focusSessions, websites, todaySessions })

  const switching = computeContextSwitching(filterVisibleSessions(todaySessions, 10, false), { windowMs: 2 * 60 * 60_000, shortSessionSeconds: 180 })

  const today = new Date()
  const todayLabel = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  // ── Render ────────────────────────────────────────────────────────────────
  const isCliProvider = settings.aiProvider === 'claude-cli' || settings.aiProvider === 'codex-cli'
  const selectedCliInstalled = settings.aiProvider === 'claude-cli'
    ? !!cliTools?.claude
    : settings.aiProvider === 'codex-cli'
      ? !!cliTools?.codex
      : false
  const isAIReady = isCliProvider ? selectedCliInstalled : hasApiKey === true

  const peakInsight = algorithmicInsights.find((i) => i.key === 'peak-hours')
  const providerMeta = AI_PROVIDER_META[settings.aiProvider]

  // Build a proactive summary paragraph from today's data
  const summaryParagraph = (() => {
    if (totalTracked === 0) return null
    const topCats = buildCategoryTotalsFromSummaries(summaries).slice(0, 2)
    const catDesc = topCats.map((c) => formatCategory(c.category).toLowerCase()).join(' and ')
    const peakNote = peakInsight ? ` ${peakInsight.headline}.` : ''
    return `You spent about ${formatDuration(totalTracked)} on ${catDesc} workflows today.${peakNote}${switching.count > 5 ? ` ${switching.count} short app sessions suggest some context switching.` : ''}`
  })()

  // Observation chips — always shown so the AI screen never feels dead.
  // When there's data, prefer data-aware prompts; fall back to universal starters.
  const observationChips = totalTracked > 0
    ? [
        'What did I actually get done today?',
        'Where did my time go today?',
        'What was I most focused on?',
        'What kept interrupting me?',
        'How does today compare to my usual week?',
      ]
    : [
        'What should I focus on today?',
        'How can I structure a deep work session?',
        'What does a productive day look like for me?',
        'How do I reduce context switching?',
        'What tools am I using most this week?',
      ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Scrollable body ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── Header with range selector ─────────────────────────────────────── */}
        <div style={{ padding: '32px 40px 0', maxWidth: 960, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 24 }}>
            <div>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--color-text-primary)', margin: '0 0 4px', letterSpacing: '-0.02em' }}>
                AI
              </h1>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
                {todayLabel}
              </p>
            </div>
            {messages.length > 0 && (
              <button
                onClick={() => void ipc.ai.clearHistory().then(() => setMessages([]))}
                style={{
                  fontSize: 11, fontWeight: 700, background: 'none', border: '1px solid var(--color-border-ghost)',
                  cursor: 'pointer', color: 'var(--color-text-secondary)',
                  padding: '5px 12px', borderRadius: 7,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-secondary)')}
              >
                New chat
              </button>
            )}
          </div>
        </div>

        <div style={{ padding: '0 40px', maxWidth: 960, margin: '0 auto', width: '100%' }}>

          {/* ── State 1: No AI key configured ─────────────────────────────────── */}
          {!isAIReady && (
            <div style={{
              padding: '48px 24px', textAlign: 'center',
              background: 'var(--color-surface-container)',
              borderRadius: 12, border: '1px solid var(--color-border-ghost)',
            }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', margin: '0 0 8px' }}>
                To enable AI summaries, add an API key in Settings.
              </p>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>
                {isCliProvider
                  ? `${providerMeta.label} needs to be installed and available.`
                  : `Add your ${providerMeta.label} API key to get started.`}
              </p>
              <Link
                to="/settings"
                style={{
                  padding: '9px 20px', borderRadius: 8,
                  background: 'var(--gradient-primary)',
                  color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 700, textDecoration: 'none',
                }}
              >
                {isCliProvider ? 'Open Settings' : 'Add API key'}
              </Link>
            </div>
          )}

          {/* ── State 2+3: AI ready — always show prompts, add summary when data exists ── */}
          {isAIReady && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* Proactive summary */}
              {summaryParagraph && messages.length === 0 && (
                <div style={{
                  padding: '20px 24px', borderRadius: 12,
                  background: 'var(--color-surface-container)', border: '1px solid var(--color-border-ghost)',
                }}>
                  <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text-primary)', margin: 0 }}>
                    {summaryParagraph}
                  </p>
                </div>
              )}

              {/* Starter prompts — shown when no conversation yet */}
              {messages.length === 0 && !loading && (
                <div>
                  <div style={{
                    fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
                    letterSpacing: '0.1em', color: 'var(--color-text-tertiary)',
                    marginBottom: 10,
                  }}>
                    {totalTracked > 0 ? 'Ask about today' : 'Get started'}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {observationChips.map((chip) => (
                      <button
                        key={chip}
                        onClick={() => void handleSend(chip)}
                        style={{
                          padding: '7px 14px', borderRadius: 999, fontSize: 12, fontWeight: 500,
                          border: '1px solid var(--color-border-ghost)',
                          background: 'transparent',
                          color: 'var(--color-text-secondary)',
                          cursor: 'pointer', fontFamily: 'inherit',
                          transition: 'border-color 120ms, color 120ms, background 120ms',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = 'var(--color-primary)'
                          e.currentTarget.style.color = 'var(--color-primary)'
                          e.currentTarget.style.background = 'var(--color-surface-low)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = 'var(--color-border-ghost)'
                          e.currentTarget.style.color = 'var(--color-text-secondary)'
                          e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Conversation thread */}
              {messages.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {messages.map((msg, i) =>
                    msg.role === 'user' ? (
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
                          flex: 1, fontSize: 13,
                          color: 'var(--color-text-primary)', lineHeight: 1.7,
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
              )}
            </div>
          )}

          <div style={{ height: 20 }} />
        </div>
      </div>

      {/* ── Pinned input bar — always visible when AI is ready ─────────────── */}
      {isAIReady && (
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
                placeholder="Type a question about your day or week..."
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
