import { useEffect, useState, type CSSProperties } from 'react'
import { ipc } from '../lib/ipc'
import { dayBounds, formatDuration, formatTime, percentOf, todayString } from '../lib/format'
import { catColor, formatCategory } from '../lib/category'
import type { AppSession, AppUsageSummary, AppCategory, LiveSession, WebsiteSummary, WeeklySummary } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import AppIcon from '../components/AppIcon'
import { formatDisplayAppName } from '../lib/apps'

// ─── Derived types ────────────────────────────────────────────────────────────

interface CategorySummary {
  category: AppCategory
  totalSeconds: number
  apps: string[]
}

function buildCategorySummaries(summaries: AppUsageSummary[]): CategorySummary[] {
  const map = new Map<AppCategory, CategorySummary>()
  for (const app of summaries) {
    const existing = map.get(app.category)
    if (existing) {
      existing.totalSeconds += app.totalSeconds
      existing.apps.push(app.appName)
    } else {
      map.set(app.category, { category: app.category, totalSeconds: app.totalSeconds, apps: [app.appName] })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds)
}

// ─── Greeting ─────────────────────────────────────────────────────────────────

function greeting(name?: string): string {
  const h = new Date().getHours()
  const base = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return name ? `${base}, ${name}.` : `${base}.`
}

function smartSummary(focusPct: number, totalSec: number, appCount: number): string {
  if (totalSec === 0) return 'No activity tracked yet today.'
  if (focusPct >= 80) return `Strong focus day so far — ${formatDuration(totalSec)} tracked across ${appCount} apps.`
  if (focusPct >= 50) return `Balanced day — ${formatDuration(totalSec)} tracked, ${focusPct}% focused.`
  if (focusPct >= 20) return `Mixed focus — ${formatDuration(totalSec)} tracked across ${appCount} apps.`
  return `Light focus so far — ${formatDuration(totalSec)} tracked.`
}

function heroStatement(focusPct: number, totalSeconds: number, focusSeconds: number): string {
  if (totalSeconds === 0) return 'Nothing tracked yet today.'
  if (focusPct >= 70) return `Strong day. ${formatDuration(focusSeconds)} of deep work so far.`
  if (focusPct >= 40) return `Balanced day. ${formatDuration(totalSeconds)} tracked, ${focusPct}% focused.`
  return `Slow start. ${formatDuration(totalSeconds)} tracked with light focus.`
}

// ─── Live session merge ───────────────────────────────────────────────────────

function mergeLive(
  dbSummaries: AppUsageSummary[],
  dbSessions: AppSession[],
  live: LiveSession | null,
  fromMs: number,
  toMs: number,
): { summaries: AppUsageSummary[]; sessions: AppSession[] } {
  if (!live) return { summaries: dbSummaries, sessions: dbSessions }

  const liveNow = Date.now()
  const liveStart = Math.max(live.startTime, fromMs)
  const liveEnd = Math.min(liveNow, toMs)
  const liveDur = Math.max(0, Math.round((liveEnd - liveStart) / 1_000))
  if (liveDur < 3) return { summaries: dbSummaries, sessions: dbSessions }

  const existingIdx = dbSummaries.findIndex((s) => s.bundleId === live.bundleId)
  const summaries: AppUsageSummary[] =
    existingIdx >= 0
      ? dbSummaries.map((s, i) =>
          i === existingIdx ? { ...s, totalSeconds: s.totalSeconds + liveDur } : s,
        )
      : [
          ...dbSummaries,
          {
            bundleId: live.bundleId,
            appName:  live.appName,
            category: live.category,
            totalSeconds: liveDur,
            isFocused: FOCUSED_CATEGORIES.includes(live.category),
          },
        ]

  const liveSession: AppSession = {
    id:              -1,
    bundleId:        live.bundleId,
    appName:         live.appName,
    startTime:       liveStart,
    endTime:         liveEnd,
    durationSeconds: liveDur,
    category:        live.category,
    isFocused:       FOCUSED_CATEGORIES.includes(live.category),
  }

  return {
    summaries: summaries.sort((a, b) => b.totalSeconds - a.totalSeconds),
    sessions: [...dbSessions, liveSession].sort((a, b) => a.startTime - b.startTime),
  }
}

const PRESENTATION_NOISE_SEC = 120

function isPresentationNoise(category: AppCategory, durationSeconds: number): boolean {
  return (category === 'system' || category === 'uncategorized') &&
    durationSeconds < PRESENTATION_NOISE_SEC
}

// ─── Session grouping (5-min gap) ────────────────────────────────────────────

const GROUP_GAP_MS = 5 * 60_000

interface GroupedFeedEntry {
  key: string
  bundleId: string
  appName: string
  category: AppCategory
  startTime: number
  endTime: number
  totalSeconds: number
  count: number
}

function groupFeedSessions(sessions: AppSession[]): GroupedFeedEntry[] {
  const finished = sessions
    .filter((s): s is AppSession & { endTime: number } => s.endTime !== null && s.durationSeconds >= 10)
    .slice()
    .reverse()

  const groups: GroupedFeedEntry[] = []
  for (const s of finished) {
    const last = groups[groups.length - 1]
    if (
      last &&
      last.appName === s.appName &&
      last.startTime - (s.endTime ?? s.startTime) <= GROUP_GAP_MS
    ) {
      last.startTime = s.startTime
      last.totalSeconds += s.durationSeconds
      last.count++
    } else {
      groups.push({
        key: `${s.bundleId}-${s.startTime}`,
        bundleId: s.bundleId,
        appName: s.appName,
        category: s.category,
        startTime: s.startTime,
        endTime: s.endTime ?? (s.startTime + s.durationSeconds * 1000),
        totalSeconds: s.durationSeconds,
        count: 1,
      })
    }
  }
  return groups.slice(0, 8)
}

// ─── Category color map ───────────────────────────────────────────────────────

const CAT_COLORS: Record<string, string> = {
  development:   '#adc6ff',
  meetings:      '#ffb95f',
  communication: '#4fdbc8',
  browsing:      '#94a3b8',
  entertainment: '#f87171',
  writing:       '#c084fc',
  aiTools:       '#34d399',
  design:        '#e879f9',
  research:      '#67e8f9',
  email:         '#fbbf24',
  productivity:  '#a3e635',
  social:        '#fb923c',
  system:        '#6b7280',
  uncategorized: '#6b7280',
}

function distColor(category: AppCategory): string {
  return CAT_COLORS[category] ?? catColor(category) ?? '#52525b'
}

function usesPrimaryGradient(category: AppCategory): boolean {
  return category === 'development'
}

const gradientTextStyle: CSSProperties = {
  backgroundImage: 'var(--gradient-primary)',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
}

// ─── Trend data (7-day, backend-backed) ───────────────────────────────────────

interface TrendPoint {
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

function buildTrendData(
  weeklySummary: WeeklySummary | null,
  todayDateStr: string,
  todayFocusSeconds: number,
  todayTotalSeconds: number,
  todayFocusScore: number,
): TrendPoint[] {
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

// ─── Main view ────────────────────────────────────────────────────────────────

export default function Today() {
  const [dbSummaries,    setDbSummaries]    = useState<AppUsageSummary[]>([])
  const [dbSessions,     setDbSessions]     = useState<AppSession[]>([])
  const [, setDbSites]        = useState<WebsiteSummary[]>([])
  const [live,           setLive]           = useState<LiveSession | null>(null)
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [userName,       setUserName]       = useState('')
  const [goalHours,      setGoalHours]      = useState(4)
  const [trackingActive, setTrackingActive] = useState<boolean | null>(null)
  const [weeklySummary,  setWeeklySummary]  = useState<WeeklySummary | null>(null)
  const [hoveredTrendDate, setHoveredTrendDate] = useState<string | null>(null)

  useEffect(() => {
    ipc.settings.get().then((s) => {
      setUserName(s.userName ?? '')
      setGoalHours(s.dailyFocusGoalHours ?? 4)
    }).catch(() => { /* non-fatal */ })
  }, [])

  useEffect(() => {
    function checkTracking() {
      ipc.debug.getInfo().then((info: unknown) => {
        const d = info as { trackingStatus?: { moduleSource: string | null } }
        setTrackingActive(d.trackingStatus?.moduleSource != null)
      }).catch(() => setTrackingActive(false))
    }
    checkTracking()
    const t = setInterval(checkTracking, 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      if (document.hidden) return
      try {
        const [s, sess, lv, sites, weekly] = await Promise.all([
          ipc.db.getToday(),
          ipc.db.getHistory(todayString()),
          ipc.tracking.getLiveSession(),
          ipc.db.getWebsiteSummaries(1),
          ipc.db.getWeeklySummary(todayString()),
        ])
        if (cancelled) return
        setDbSummaries(s as AppUsageSummary[])
        setDbSessions(sess as AppSession[])
        setLive(lv as LiveSession | null)
        setDbSites(sites as WebsiteSummary[])
        setWeeklySummary(weekly as WeeklySummary)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (loading) return <LoadingSkeleton />

  if (error) {
    return (
      <div className="p-5 flex flex-col items-center justify-center gap-3 h-full">
        <p className="text-[13px] text-red-400">Failed to load today's data: {error}</p>
        <button
          onClick={() => { setError(null); setLoading(true) }}
          className="px-4 py-2 rounded-md text-[13px] font-medium"
          style={{ background: 'var(--color-primary)', color: 'var(--color-primary-contrast)' }}
        >
          Retry
        </button>
      </div>
    )
  }

  const [fromMs, toMs] = dayBounds(todayString())
  const { summaries, sessions } = mergeLive(dbSummaries, dbSessions, live, fromMs, toMs)

  const meaningfulSummaries = summaries.filter(
    (app) => !isPresentationNoise(app.category, app.totalSeconds),
  )
  const meaningfulSessions = sessions.filter(
    (session) => !isPresentationNoise(session.category, session.durationSeconds),
  )

  const totalSeconds = summaries.reduce((n, a) => n + a.totalSeconds, 0)
  const focusSeconds = meaningfulSummaries
    .filter((a) => a.isFocused)
    .reduce((n, a) => n + a.totalSeconds, 0)
  const focusPct    = percentOf(focusSeconds, totalSeconds)
  const appCount    = meaningfulSummaries.length
  const cats        = buildCategorySummaries(meaningfulSummaries)
  const feedGroups  = groupFeedSessions(meaningfulSessions)

  const focusQuality = Math.round((focusSeconds / Math.max(totalSeconds, 1)) * 100)
  const qualityLabel =
    focusQuality > 80 ? 'Excellent' :
    focusQuality > 50 ? 'On Track' :
    focusQuality > 20 ? 'Building' : 'Starting Out'

  const summary = smartSummary(focusPct, totalSeconds, appCount)
  const hero = heroStatement(focusPct, totalSeconds, focusSeconds)

  // SVG ring (192px)
  const ringSize = 192
  const r = 76
  const cx = ringSize / 2
  const cy = ringSize / 2
  const circumference = 2 * Math.PI * r
  const ringOffset = circumference * (1 - focusQuality / 100)

  // Goal progress
  const goalSeconds = goalHours * 3600
  const goalPct = Math.min(100, Math.round((focusSeconds / Math.max(goalSeconds, 1)) * 100))

  const trendData = buildTrendData(
    weeklySummary,
    todayString(),
    focusSeconds,
    totalSeconds,
    focusQuality,
  )
  const sparkMax = Math.max(...trendData.map((day) => day.focusSeconds), 1)
  const yesterdayFocusScore = trendData.find((day) => day.date === shiftDateString(todayString(), -1))?.focusScore ?? 0
  const hoveredTrend = trendData.find((day) => day.date === hoveredTrendDate) ?? null

  return (
    <div style={{ background: 'var(--color-bg)', minHeight: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>

        {/* ── Header row ─────────────────────────────────────────────────── */}
        <div style={{
          padding: '32px 40px 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              fontSize: 10,
              fontWeight: 900,
              textTransform: 'uppercase',
              letterSpacing: '0.2em',
              color: 'var(--color-text-secondary)',
            }}>
              {greeting(userName || undefined)}
            </span>
            {trackingActive === false && (
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: '#f87171',
                background: 'rgba(248,113,113,0.10)',
                borderRadius: 999,
                padding: '2px 8px',
              }}>
                Tracking unavailable
              </span>
            )}
          </div>

          {live && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              background: 'rgba(15,99,219,0.08)',
              border: '1px solid rgba(15,99,219,0.16)',
              borderRadius: 999,
              padding: '5px 10px',
            }}>
              <AppIcon bundleId={live.bundleId} appName={live.appName} size={16} fontSize={8} cornerRadius={4} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary)', letterSpacing: '0.02em' }}>
                {formatDisplayAppName(live.appName)}
              </span>
            </div>
          )}
        </div>

        {/* ── Hero heading ────────────────────────────────────────────────── */}
        <div style={{ padding: '16px 40px 0' }}>
          <h1 style={{
            fontSize: 36,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            color: 'var(--color-text-primary)',
            margin: 0,
            lineHeight: 1.15,
          }}>
            {hero}
          </h1>
        </div>

        {/* ── Grid row 1: Focus Score (4) + Focus Trend (8) ───────────────── */}
        <div style={{
          padding: '32px 40px 0',
          display: 'grid',
          gridTemplateColumns: '4fr 8fr',
          gap: 24,
        }}>

          {/* Col A — Daily Focus Score */}
          <div style={{
            background: 'var(--color-surface-low)',
            borderRadius: 12,
            padding: 32,
            border: '1px solid var(--color-border-ghost)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}>
            <span style={{
              fontSize: 10,
              fontWeight: 900,
              textTransform: 'uppercase',
              letterSpacing: '0.2em',
              color: 'var(--color-text-secondary)',
              marginBottom: 24,
              textAlign: 'center',
            }}>
              Daily Focus Score
            </span>

            {/* SVG Ring */}
            <div style={{ position: 'relative', width: ringSize, height: ringSize }}>
              <svg width={ringSize} height={ringSize} viewBox={`0 0 ${ringSize} ${ringSize}`}>
                <defs>
                  <linearGradient id="focusRingGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="var(--gradient-primary-from)" />
                    <stop offset="100%" stopColor="var(--gradient-primary-to)" />
                  </linearGradient>
                  <filter id="ringGlow">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                {/* Track */}
                <circle
                  cx={cx} cy={cy} r={r}
                  fill="none"
                  stroke="var(--color-surface-highest)"
                  strokeWidth={8}
                />
                {/* Progress */}
                <circle
                  cx={cx} cy={cy} r={r}
                  fill="none"
                  stroke="url(#focusRingGradient)"
                  strokeWidth={8}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={ringOffset}
                  transform={`rotate(-90 ${cx} ${cy})`}
                  filter="url(#ringGlow)"
                />
              </svg>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{
                  fontSize: 48,
                  fontWeight: 900,
                  color: 'var(--color-text-primary)',
                  letterSpacing: '-0.04em',
                  lineHeight: 1,
                }}>
                  {focusQuality}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#4fdbc8', marginTop: 4, letterSpacing: '0.05em' }}>
                  <span style={gradientTextStyle}>{qualityLabel}</span>
                </span>
              </div>
            </div>

            {/* Bottom stats */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginTop: 24,
              width: '100%',
              borderTop: '1px solid var(--color-border-ghost)',
              paddingTop: 16,
            }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'left' }}>
                <p style={{
                  fontSize: 10,
                  fontWeight: 900,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  color: 'var(--color-text-secondary)',
                  margin: 0,
                }}>
                  Goal
                </p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 26,
                    fontWeight: 900,
                    color: 'var(--color-text-primary)',
                    letterSpacing: '-0.03em',
                    lineHeight: 1,
                  }}>
                    {goalHours}h
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                    {goalPct}%
                  </span>
                </div>
              </div>
              <div style={{ width: 1, background: 'var(--color-border-ghost)' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                <p style={{
                  fontSize: 10,
                  fontWeight: 900,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  color: 'var(--color-text-secondary)',
                  margin: 0,
                }}>
                  Yesterday
                </p>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 72,
                  padding: '6px 12px',
                  borderRadius: 999,
                  background: yesterdayFocusScore > 0 ? 'var(--gradient-primary)' : 'var(--color-surface-highest)',
                  color: yesterdayFocusScore > 0 ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                  fontSize: 18,
                  fontWeight: 900,
                  letterSpacing: '-0.02em',
                }}>
                  {yesterdayFocusScore > 0 ? `${yesterdayFocusScore}%` : 'No data'}
                </span>
              </div>
            </div>
          </div>

          {/* Col B — Focus Trend */}
          <div style={{
            background: 'var(--color-surface-low)',
            borderRadius: 12,
            padding: 24,
            border: '1px solid var(--color-border-ghost)',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <h3 style={{
              fontSize: 14,
              fontWeight: 900,
              color: 'var(--color-text-primary)',
              margin: '0 0 4px',
              letterSpacing: '-0.01em',
            }}>
              Focus Trend
            </h3>
            <p style={{
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              margin: '0 0 6px',
            }}>
              Performance over the last 7 days
            </p>
            {hoveredTrend && (
              <p style={{
                fontSize: 11,
                color: hoveredTrend.focusSeconds
                  ? 'var(--color-primary)'
                  : 'var(--color-text-tertiary)',
                margin: '0 0 18px',
                fontWeight: 700,
                minHeight: 16,
              }}>
                {`${hoveredTrend.label} · ${hoveredTrend.focusSeconds > 0 ? formatDuration(hoveredTrend.focusSeconds) : 'No focused time'}`}
              </p>
            )}

            {/* Bar chart */}
            <div style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 8,
              height: 96,
              flex: 1,
            }}>
              {trendData.map((day) => {
                const isToday = day.date === todayString()
                const barH = day.focusSeconds > 0 ? Math.max(6, Math.round((day.focusSeconds / sparkMax) * 80)) : 0
                const isEmpty = day.focusSeconds === 0
                return (
                  <div
                    key={day.date}
                    title={`${day.label}: ${day.focusSeconds > 0 ? formatDuration(day.focusSeconds) : 'No focused time'}`}
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 6,
                      height: '100%',
                      justifyContent: 'flex-end',
                      cursor: 'default',
                    }}
                    onMouseEnter={() => setHoveredTrendDate(day.date)}
                    onMouseLeave={() => setHoveredTrendDate(null)}
                  >
                    {isToday && isEmpty && (
                      <span style={{
                        fontSize: 8,
                        fontWeight: 900,
                        textTransform: 'uppercase',
                        letterSpacing: '0.15em',
                        color: '#adc6ff',
                        marginBottom: 2,
                      }}>
                        TODAY
                      </span>
                    )}
                    <div style={{
                      width: '100%',
                      height: isEmpty ? 4 : barH,
                      background: isEmpty ? 'var(--color-surface-highest)' : 'var(--gradient-primary)',
                      opacity: isEmpty ? 1 : hoveredTrendDate === day.date || isToday ? 1 : 0.4,
                      borderRadius: '4px 4px 2px 2px',
                      transition: 'height 0.3s ease, opacity 120ms ease',
                      minHeight: 4,
                      boxShadow: (isToday || hoveredTrendDate === day.date) && !isEmpty ? '0 8px 18px rgba(15,99,219,0.16)' : 'none',
                    }} />
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                      color: hoveredTrendDate === day.date || isToday ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    }}>
                      {day.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ── Full-width Time Distribution ─────────────────────────────────── */}
        <div style={{ padding: '24px 40px 0' }}>
          <div style={{
            background: 'var(--color-surface-container)',
            borderRadius: 12,
            padding: 32,
            border: '1px solid var(--color-border-ghost)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
              <h3 style={{
                fontSize: 14,
                fontWeight: 900,
                color: 'var(--color-text-primary)',
                margin: 0,
                letterSpacing: '-0.01em',
              }}>
                Time Distribution
              </h3>
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                Today's total: {formatDuration(totalSeconds)}
              </span>
            </div>

            {/* Stacked horizontal bar */}
            <div style={{
              height: 24,
              borderRadius: 999,
              overflow: 'hidden',
              display: 'flex',
              background: 'var(--color-surface-highest)',
            }}>
              {cats.filter((c) => c.totalSeconds > 0).map((cat) => (
                <div
                  key={cat.category}
                  title={`${formatCategory(cat.category)}: ${formatDuration(cat.totalSeconds)}`}
                  style={{
                    flexGrow: cat.totalSeconds,
                    background: usesPrimaryGradient(cat.category) ? 'var(--gradient-primary)' : distColor(cat.category),
                    minWidth: 3,
                  }}
                />
              ))}
            </div>

            {/* Category stat chips */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 10,
              marginTop: 16,
            }}>
              {cats.filter((c) => c.totalSeconds > 0).slice(0, 5).map((cat) => (
                <div
                  key={cat.category}
                  style={{
                    background: 'var(--color-surface-low)',
                    borderRadius: 8,
                    padding: '12px 16px',
                    border: '1px solid var(--color-border-ghost)',
                  }}
                >
                  <p style={{
                    fontSize: 10,
                    fontWeight: 900,
                    textTransform: 'uppercase',
                    letterSpacing: '0.15em',
                    color: 'var(--color-text-secondary)',
                    margin: '0 0 6px',
                  }}>
                    {formatCategory(cat.category)}
                  </p>
                  <p style={{
                    fontSize: 18,
                    fontWeight: 900,
                    color: usesPrimaryGradient(cat.category) ? 'transparent' : distColor(cat.category),
                    margin: 0,
                    letterSpacing: '-0.02em',
                    ...(usesPrimaryGradient(cat.category) ? gradientTextStyle : {}),
                  }}>
                    {formatDuration(cat.totalSeconds)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Grid row 3: Recent Sessions (7) + AI Insight (5) ─────────────── */}
        <div style={{
          padding: '24px 40px 32px',
          display: 'grid',
          gridTemplateColumns: '7fr 5fr',
          gap: 24,
        }}>

          {/* Col A — Recent Sessions */}
          <div>
            <p className="section-label" style={{ color: 'var(--color-text-secondary)', margin: '0 0 14px' }}>
              Recent Sessions
            </p>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--color-surface-container)',
              border: '1px solid var(--color-border-ghost)',
              borderRadius: 12,
              overflow: 'hidden',
            }}>
              {feedGroups.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '16px 18px', margin: 0 }}>
                  No sessions yet today.
                </p>
              ) : (
                feedGroups.map((g, index) => {
                  const color = distColor(g.category)
                  return (
                    <div
                      key={g.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 14px',
                        borderBottom: index < feedGroups.length - 1 ? '1px solid var(--color-border-ghost)' : 'none',
                        transition: 'background 150ms',
                        cursor: 'default',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-low)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Icon circle */}
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <AppIcon bundleId={g.bundleId} appName={g.appName} color={color} size={40} fontSize={11} cornerRadius={12} />
                        <span style={{
                          position: 'absolute',
                          bottom: 1,
                          right: 1,
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: usesPrimaryGradient(g.category) ? 'var(--color-primary)' : color,
                          border: '1.5px solid var(--color-bg)',
                        }} />
                      </div>

                      {/* App name + time range */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--color-text-primary)',
                          margin: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {formatDisplayAppName(g.appName)}
                        </p>
                        <p style={{
                          fontSize: 11,
                          color: 'var(--color-text-secondary)',
                          margin: '2px 0 0',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {formatTime(g.startTime)} – {formatTime(g.endTime)}
                        </p>
                      </div>

                      {/* Duration + quality chip */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                        <span style={{
                          fontSize: 13,
                          fontWeight: 900,
                          color: 'var(--color-primary)',
                          letterSpacing: '-0.01em',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {formatDuration(g.totalSeconds)}
                        </span>
                        <span style={{
                          background: usesPrimaryGradient(g.category) ? 'var(--gradient-primary)' : `${color}1a`,
                          color: usesPrimaryGradient(g.category) ? 'var(--color-primary-contrast)' : color,
                          fontWeight: 700,
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.1em',
                          padding: '2px 8px',
                          borderRadius: 999,
                        }}>
                          {g.category === 'development' || FOCUSED_CATEGORIES.includes(g.category)
                            ? 'Deep Focus'
                            : formatCategory(g.category)}
                        </span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Col B — AI Insight */}
          <div style={{
            background: 'linear-gradient(145deg, rgba(15,99,219,0.12) 0%, rgba(58,141,255,0.05) 42%, var(--color-surface-container) 100%)',
            borderRadius: 12,
            padding: 32,
            border: '1px solid var(--color-border-ghost)',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            overflow: 'hidden',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              inset: 'auto -40px -60px auto',
              width: 180,
              height: 180,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(58,141,255,0.24), rgba(58,141,255,0))',
              pointerEvents: 'none',
            }} />
            {/* Sparkle icon */}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z"
                fill="var(--gradient-primary-to)"
                fillOpacity="0.85"
              />
              <path
                d="M19 2L19.75 4.75L22.5 5.5L19.75 6.25L19 9L18.25 6.25L15.5 5.5L18.25 4.75L19 2Z"
                fill="var(--gradient-primary-from)"
                fillOpacity="0.5"
              />
            </svg>

            <h4 style={{
              fontSize: 15,
              fontWeight: 900,
              color: 'var(--color-text-primary)',
              margin: 0,
              letterSpacing: '-0.02em',
              lineHeight: 1.3,
            }}>
              Your Peak Focus window is your competitive edge.
            </h4>

            <p style={{
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              margin: 0,
              lineHeight: 1.7,
            }}>
              {summary}
            </p>

            {/* Goal progress bar */}
            <div style={{ marginTop: 'auto' }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 8,
              }}>
                <span style={{
                  fontSize: 10,
                  fontWeight: 900,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  color: 'var(--color-text-secondary)',
                }}>
                  Daily Goal
                </span>
                <span style={{
                  fontSize: 12,
                  fontWeight: 900,
                  ...gradientTextStyle,
                }}>
                  {goalPct}%
                </span>
              </div>
              <div style={{
                height: 4,
                borderRadius: 999,
                background: 'var(--color-surface-highest)',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${goalPct}%`,
                  height: '100%',
                  background: 'var(--gradient-primary)',
                  borderRadius: 999,
                  transition: 'width 0.4s ease',
                }} />
              </div>
            </div>

            <a
              href="#/insights"
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--color-primary)',
                textDecoration: 'none',
                letterSpacing: '0.02em',
                alignSelf: 'flex-start',
              }}
            >
              See all insights →
            </a>
          </div>
        </div>

      </div>
    </div>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div style={{ padding: '32px 40px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ height: 20, borderRadius: 8, marginBottom: 20, background: 'var(--color-surface-high)', opacity: 0.5, width: '30%' }} />
      <div style={{ height: 44, borderRadius: 8, marginBottom: 28, background: 'var(--color-surface-high)', opacity: 0.5, width: '70%' }} />
      <div style={{ display: 'grid', gridTemplateColumns: '4fr 8fr', gap: 24, marginBottom: 24 }}>
        <div style={{ height: 320, borderRadius: 12, background: 'var(--color-surface-high)', opacity: 0.5 }} />
        <div style={{ height: 320, borderRadius: 12, background: 'var(--color-surface-high)', opacity: 0.5 }} />
      </div>
      <div style={{ height: 160, borderRadius: 12, background: 'var(--color-surface-high)', opacity: 0.5, marginBottom: 24 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '7fr 5fr', gap: 24 }}>
        <div style={{ height: 280, borderRadius: 12, background: 'var(--color-surface-high)', opacity: 0.5 }} />
        <div style={{ height: 280, borderRadius: 12, background: 'var(--color-surface-high)', opacity: 0.5 }} />
      </div>
    </div>
  )
}
