import { useEffect, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, formatTime, formatFullDate, percentOf, todayString } from '../lib/format'
import { catColor, formatCategory } from '../lib/category'
import type { AppSession, AppCategory, HistoryDayPayload } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import { BarChart, Bar, Cell, ResponsiveContainer } from 'recharts'
import AppIcon from '../components/AppIcon'
import { formatDisplayAppName } from '../lib/apps'
import TimelineDayView from '../components/history/TimelineDayView'

function isPresentationNoise(session: AppSession): boolean {
  return (session.category === 'system' || session.category === 'uncategorized') &&
    session.durationSeconds < 120
}

function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-')
}

// ─── Session grouping ────────────────────────────────────────────────────────

const GAP_MS = 60_000

interface SessionGroup {
  bundleId: string
  appName: string
  category: AppCategory
  isFocused: boolean
  firstStart: number
  lastEnd: number
  totalSeconds: number
  count: number
}

function groupSessions(sessions: AppSession[]): SessionGroup[] {
  const groups: SessionGroup[] = []

  for (const s of sessions.filter((session) => !isPresentationNoise(session))) {
    const endMs = s.endTime ?? (s.startTime + s.durationSeconds * 1_000)
    const last  = groups[groups.length - 1]

    if (
      last &&
      last.bundleId === s.bundleId &&
      s.startTime - last.lastEnd <= GAP_MS
    ) {
      last.totalSeconds += s.durationSeconds
      last.lastEnd = Math.max(last.lastEnd, endMs)
      last.count++
    } else {
      groups.push({
        bundleId:     s.bundleId,
        appName:      s.appName,
        category:     s.category,
        isFocused:    s.isFocused,
        firstStart:   s.startTime,
        lastEnd:      endMs,
        totalSeconds: s.durationSeconds,
        count:        1,
      })
    }
  }

  return groups.filter((g) => g.totalSeconds >= 15)
}

function getWeekStart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const day = dt.getDay()
  const diff = day === 0 ? -6 : 1 - day
  dt.setDate(dt.getDate() + diff)
  return [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-')
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

// ─── Timeline constants ───────────────────────────────────────────────────────

const TL_START = 7
const TL_END   = 23
const TL_HOURS = TL_END - TL_START
const HOUR_LABELS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]

function fmtHour(h: number): string {
  if (h === 12) return '12p'
  if (h > 12) return `${h - 12}p`
  return `${h}a`
}

function IconChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m10 3.5-4.5 4.5 4.5 4.5" />
    </svg>
  )
}

function IconChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

// ─── Day Timeline ─────────────────────────────────────────────────────────────

function DayTimeline({ sessions, sortedCats }: { sessions: AppSession[]; sortedCats: { category: string; totalSeconds: number }[] }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(0)

  useEffect(() => {
    if (!trackRef.current) return
    const obs = new ResizeObserver((entries) => {
      setTrackWidth(entries[0].contentRect.width)
    })
    obs.observe(trackRef.current)
    setTrackWidth(trackRef.current.clientWidth)
    return () => obs.disconnect()
  }, [])

  const finished = sessions.filter(
    (s): s is AppSession & { endTime: number } =>
      s.endTime !== null && !isPresentationNoise(s),
  )

  return (
    <div style={{
      background: 'var(--color-surface-low)',
      borderRadius: 12,
      padding: 20,
      marginBottom: 12,
      border: '1px solid var(--color-border-ghost)',
      boxShadow: 'var(--color-shadow-soft)',
    }}>
      <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--color-text-tertiary)', margin: '0 0 12px' }}>
        Timeline
      </p>

      {/* Hour axis */}
      <div style={{ display: 'flex', marginBottom: 6 }}>
        {HOUR_LABELS.map((h) => (
          <div
            key={h}
            style={{ flex: 1, fontSize: 10, color: 'var(--color-text-tertiary)', textAlign: 'center', flexShrink: 0 }}
          >
            {fmtHour(h)}
          </div>
        ))}
      </div>

      {/* Timeline track */}
      <div
        ref={trackRef}
        style={{
          position: 'relative',
          height: 56,
          background: 'var(--color-surface-high)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {finished.map((s) => {
          const sd = new Date(s.startTime)
          const ed = new Date(s.endTime)
          const startH = sd.getHours() + sd.getMinutes() / 60 + sd.getSeconds() / 3600
          const endH   = ed.getHours() + ed.getMinutes() / 60 + ed.getSeconds() / 3600

          const clampStart = Math.max(TL_START, Math.min(TL_END, startH))
          const clampEnd   = Math.max(TL_START, Math.min(TL_END, endH))
          if (clampEnd <= clampStart) return null

          const leftPct  = ((clampStart - TL_START) / TL_HOURS) * 100
          const widthPct = ((clampEnd - clampStart) / TL_HOURS) * 100
          const pxWidth  = trackWidth > 0 ? (widthPct / 100) * trackWidth : 0

          return (
            <div
              key={`${s.id}-${s.startTime}`}
              title={`${s.appName} · ${formatDuration(s.durationSeconds)}`}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                width: `max(4px, ${widthPct}%)`,
                top: 0,
                bottom: 0,
                background: usesPrimaryGradient(s.category) ? 'var(--gradient-primary)' : distColor(s.category),
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
                  {pxWidth > 60 && (
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.84)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 4px' }}>
                      {formatDisplayAppName(s.appName)}
                    </span>
                  )}
            </div>
          )
        })}
      </div>

      {/* Category legend chips */}
      {sortedCats.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          {sortedCats.map((c) => (
            <span
              key={c.category}
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                padding: '3px 10px',
                borderRadius: 999,
                background: usesPrimaryGradient(c.category as AppCategory) ? 'var(--gradient-primary)' : `${distColor(c.category as AppCategory)}1a`,
                color: usesPrimaryGradient(c.category as AppCategory) ? 'var(--color-primary-contrast)' : distColor(c.category as AppCategory),
              }}
            >
              {formatCategory(c.category)} · {formatDuration(c.totalSeconds)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Week view ────────────────────────────────────────────────────────────────

interface WeekDayData {
  label: string
  dateStr: string
  totalSeconds: number
  focusSeconds: number
  topCategory: AppCategory | null
  appCount: number
  color: string
}

function WeekView({ onSelectDay }: { onSelectDay: (date: string) => void }) {
  const [weekData, setWeekData] = useState<WeekDayData[]>([])
  const [loading, setLoading] = useState(true)
  const weekStartStr = getWeekStart(todayString())

  useEffect(() => {
    setLoading(true)
    const days: string[] = []
    const [y, m, d] = weekStartStr.split('-').map(Number)
    for (let i = 0; i < 7; i++) {
      const dt = new Date(y, m - 1, d + i)
      days.push([
        dt.getFullYear(),
        String(dt.getMonth() + 1).padStart(2, '0'),
        String(dt.getDate()).padStart(2, '0'),
      ].join('-'))
    }

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    void Promise.all(days.map((ds) => ipc.db.getHistory(ds))).then((sessionResults) => {
      const data: WeekDayData[] = days.map((ds, i) => {
        const rawSessions = sessionResults[i] as AppSession[]
        const filteredSessions = rawSessions.filter((s) => !isPresentationNoise(s))
        const catTotals = new Map<AppCategory, number>()
        let totalSec = 0
        let focusSec = 0
        const bundleIds = new Set<string>()
        for (const s of filteredSessions) {
          totalSec += s.durationSeconds
          if (FOCUSED_CATEGORIES.includes(s.category)) focusSec += s.durationSeconds
          catTotals.set(s.category, (catTotals.get(s.category) ?? 0) + s.durationSeconds)
          bundleIds.add(s.bundleId)
        }
        const topCategory = filteredSessions.length > 0
          ? ([...catTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
          : null
        return {
          label: dayLabels[i],
          dateStr: ds,
          totalSeconds: totalSec,
          focusSeconds: focusSec,
          topCategory,
          appCount: bundleIds.size,
          color: 'var(--color-primary)',
        }
      })
      setWeekData(data)
      setLoading(false)
    })
  }, [weekStartStr])

  if (loading) {
    return <div style={{ height: 160, borderRadius: 8, background: 'var(--color-surface-high)', opacity: 0.5 }} />
  }

  const activeDays = weekData.filter((d) => d.totalSeconds > 0)
  const mostActiveDay = activeDays.length > 0
    ? activeDays.reduce((a, b) => a.totalSeconds > b.totalSeconds ? a : b)
    : null
  const bestFocusDay = activeDays.length > 0
    ? activeDays.reduce((a, b) => {
        const aP = a.totalSeconds > 0 ? a.focusSeconds / a.totalSeconds : 0
        const bP = b.totalSeconds > 0 ? b.focusSeconds / b.totalSeconds : 0
        return aP > bP ? a : b
      })
    : null
  const quietestDay = activeDays.length > 1
    ? activeDays.reduce((a, b) => a.totalSeconds < b.totalSeconds ? a : b)
    : null

  const chartData = weekData.map((d) => ({
    name: d.label,
    dateStr: d.dateStr,
    hours: parseFloat((d.totalSeconds / 3600).toFixed(2)),
    focusPct: d.totalSeconds > 0 ? Math.round((d.focusSeconds / d.totalSeconds) * 100) : 0,
  }))

  const bestFocusDateStr = bestFocusDay?.dateStr

  return (
    <div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barSize={20}>
          <Bar
            dataKey="hours"
            radius={[4, 4, 0, 0]}
            onClick={(entry: { dateStr: string }) => onSelectDay(entry.dateStr)}
            style={{ cursor: 'pointer' }}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.dateStr}
                fill={entry.dateStr === bestFocusDateStr && entry.hours > 0
                  ? '#adc6ff'
                  : 'var(--color-surface-highest)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        {mostActiveDay && (
          <div style={{ flex: 1, background: 'var(--color-surface-container)', borderRadius: 10, padding: '12px 16px', border: '1px solid var(--color-border-ghost)' }}>
            <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--color-text-tertiary)', margin: 0 }}>Most Active</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-primary)', margin: '4px 0 0' }}>
              {mostActiveDay.label} · {formatDuration(mostActiveDay.totalSeconds)}
            </p>
          </div>
        )}
        {bestFocusDay && bestFocusDay.totalSeconds > 0 && (
          <div style={{ flex: 1, background: 'var(--color-surface-container)', borderRadius: 10, padding: '12px 16px', border: '1px solid var(--color-border-ghost)' }}>
            <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--color-text-tertiary)', margin: 0 }}>Best Focus</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-primary)', margin: '4px 0 0' }}>
              {bestFocusDay.label} · {percentOf(bestFocusDay.focusSeconds, bestFocusDay.totalSeconds)}%
            </p>
          </div>
        )}
        {quietestDay && quietestDay !== mostActiveDay && (
          <div style={{ flex: 1, background: 'var(--color-surface-container)', borderRadius: 10, padding: '12px 16px', border: '1px solid var(--color-border-ghost)' }}>
            <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--color-text-tertiary)', margin: 0 }}>Quietest</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-primary)', margin: '4px 0 0' }}>
              {quietestDay.label} · {formatDuration(quietestDay.totalSeconds)}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── App initials helper ──────────────────────────────────────────────────────

// ─── Filter pill categories ───────────────────────────────────────────────────

const FILTER_PILLS = [
  { key: 'all', label: 'All' },
  { key: 'development', label: 'Focus' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'communication', label: 'Communication' },
  { key: 'browsing', label: 'Browsing' },
] as const

type FilterKey = typeof FILTER_PILLS[number]['key']

export default function History() {
  const [viewMode, setViewMode] = useState<'timeline' | 'stats' | 'week'>('timeline')
  const [date, setDate] = useState(todayString())
  const [dayPayload, setDayPayload] = useState<HistoryDayPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all')
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null)

  useEffect(() => {
    if (viewMode === 'week') return
    let cancelled = false

    const loadDay = (showSpinner: boolean) => {
      if (showSpinner) setLoading(true)
      setError(null)
      void ipc.db.getHistoryDay(date).then((data) => {
        if (cancelled) return
        setDayPayload(data)
      }).catch((err) => {
        if (cancelled) return
        setDayPayload(null)
        setError(err instanceof Error ? err.message : String(err))
      }).finally(() => {
        if (!cancelled && showSpinner) setLoading(false)
      })
    }

    loadDay(true)

    if (date === todayString()) {
      const timer = window.setInterval(() => loadDay(false), 10_000)
      return () => {
        cancelled = true
        window.clearInterval(timer)
      }
    }

    return () => {
      cancelled = true
    }
  }, [date, viewMode])

  const sessions = dayPayload?.sessions ?? []

  const groups    = groupSessions(sessions)
  const totalSec  = groups.reduce((n, g) => n + g.totalSeconds, 0)
  const focusSec  = groups.filter((g) => g.isFocused).reduce((n, g) => n + g.totalSeconds, 0)
  const focusPct  = percentOf(focusSec, totalSec)
  const isToday   = date === todayString()
  const uniqueApps = new Set(groups.map((g) => g.bundleId)).size

  const catMap = new Map<string, number>()
  for (const g of groups) catMap.set(g.category, (catMap.get(g.category) ?? 0) + g.totalSeconds)
  const sortedCats = [...catMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, totalSeconds]) => ({ category, totalSeconds }))

  // Filter groups based on active filter pill
  const filteredGroups = activeFilter === 'all'
    ? groups
    : activeFilter === 'development'
      ? groups.filter((g) => g.isFocused)
      : groups.filter((g) => g.category === activeFilter)

  // Determine if last session is active (no endTime on original sessions)
  const lastRawSession = sessions.length > 0 ? sessions[sessions.length - 1] : null
  const lastGroupKey = filteredGroups.length > 0
    ? `${filteredGroups[filteredGroups.length - 1].bundleId}-${filteredGroups[filteredGroups.length - 1].firstStart}`
    : null

  const isLastGroupActive = isToday && lastRawSession !== null && lastRawSession.endTime === null

  const goalSeconds = 4 * 3600 // 4h focus goal
  const goalPct = Math.min(100, Math.round((focusSec / goalSeconds) * 100))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Sticky header ──────────────────────────────────────────────── */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'var(--color-bg)',
        padding: '24px 40px 18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid rgba(66,71,84,0.20)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => setDate(shiftDate(date, -1))}
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--color-text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            <IconChevronLeft />
          </button>
          <div
            style={{
              minWidth: 146,
              padding: '9px 18px',
              borderRadius: 999,
              background: 'var(--color-surface-container)',
              border: '1px solid var(--color-border-ghost)',
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              textAlign: 'center',
              boxShadow: 'var(--color-shadow-soft)',
            }}
          >
            {viewMode === 'week' ? 'This Week' : formatFullDate(date)}
          </div>
          <button
            onClick={() => setDate(shiftDate(date, 1))}
            disabled={isToday && viewMode !== 'week'}
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              border: 'none',
              background: 'transparent',
              cursor: isToday && viewMode !== 'week' ? 'default' : 'pointer',
              color: 'var(--color-text-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
              opacity: isToday && viewMode !== 'week' ? 0.35 : 1,
            }}
          >
            <IconChevronRight />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isToday && viewMode !== 'week' && (
            <button
              onClick={() => setDate(todayString())}
              style={{
                padding: '7px 12px',
                borderRadius: 10,
                fontSize: 12,
                fontWeight: 700,
                border: '1px solid var(--color-border-ghost)',
                cursor: 'pointer',
                background: 'var(--color-surface-container)',
                color: 'var(--color-text-secondary)',
              }}
            >
              Today
            </button>
          )}

          <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 10, background: 'var(--color-surface-high)', border: '1px solid var(--color-border-ghost)' }}>
            {(['timeline', 'stats', 'week'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  padding: '5px 14px',
                  borderRadius: 7,
                  fontSize: 12,
                  fontWeight: 700,
                  border: '1px solid transparent',
                  cursor: 'pointer',
                  background: viewMode === mode ? 'var(--gradient-primary)' : 'transparent',
                  color: viewMode === mode ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                  transition: 'all 120ms',
                }}
              >
                {mode === 'timeline' ? 'Timeline' : mode === 'stats' ? 'Stats' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Scrollable body ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '32px 40px 0' }}>

        {/* ── Week view ───────────────────────────────────────────────── */}
        {viewMode === 'week' && (
          <div style={{ background: 'var(--color-surface-low)', borderRadius: 12, padding: 24, marginBottom: 32, border: '1px solid var(--color-border-ghost)' }}>
            <WeekView
              onSelectDay={(d) => {
                setDate(d)
                setViewMode('timeline')
              }}
            />
          </div>
        )}

        {/* ── Day view content ─────────────────────────────────────────── */}
        {viewMode !== 'week' && (
          <>
            {error && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 0', gap: 12 }}>
                <p style={{ fontSize: 13, color: '#f87171', margin: 0 }}>Failed to load history: {error}</p>
                <button
                  onClick={() => { setError(null); setLoading(true) }}
                  style={{ padding: '6px 16px', borderRadius: 999, border: 'none', cursor: 'pointer', background: 'var(--color-primary)', color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 700 }}
                >
                  Retry
                </button>
              </div>
            )}

            {!error && (
              <>
                {viewMode === 'timeline' && loading && (
                  <div style={{ display: 'grid', gap: 14 }}>
                    <div style={{ height: 18, width: 240, borderRadius: 999, background: 'var(--color-surface-high)', opacity: 0.5 }} />
                    <div style={{ height: 26, width: 360, borderRadius: 999, background: 'var(--color-surface-high)', opacity: 0.5 }} />
                    <div style={{ height: 540, borderRadius: 18, background: 'var(--color-surface-low)', opacity: 0.55 }} />
                  </div>
                )}

                {viewMode === 'timeline' && dayPayload && !loading && (
                  <TimelineDayView
                    payload={dayPayload}
                    date={date}
                    activeFilter={activeFilter}
                    onFilterChange={setActiveFilter}
                  />
                )}

                {viewMode === 'timeline' && !loading && dayPayload && dayPayload.blocks.length === 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '96px 0', textAlign: 'center' }}>
                    <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 6px' }}>No timeline yet</p>
                    <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>No activity was recorded for this date.</p>
                  </div>
                )}

                {viewMode === 'stats' && !loading && sessions.length > 0 && (
                  <DayTimeline sessions={sessions} sortedCats={sortedCats} />
                )}

                {viewMode === 'stats' && loading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
                    {[...Array(6)].map((_, i) => (
                      <div key={i} style={{ height: 80, background: 'var(--color-surface-low)', borderRadius: 12, opacity: 0.4 }} />
                    ))}
                  </div>
                ) : viewMode === 'stats' && filteredGroups.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 0', textAlign: 'center' }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', margin: '0 0 6px' }}>No sessions</p>
                    <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>No activity recorded for this date.</p>
                  </div>
                ) : viewMode === 'stats' ? (
                  /* Vertical timeline */
                  <div style={{ position: 'relative', paddingLeft: 64 }}>
                    {/* Vertical line */}
                    <div style={{
                      position: 'absolute',
                      left: 24,
                      top: 0,
                      bottom: 0,
                      width: 2,
                      background: 'linear-gradient(to bottom, transparent, rgba(66,71,84,0.5), rgba(66,71,84,0.5), transparent)',
                      pointerEvents: 'none',
                    }} />

                    {filteredGroups.map((g) => {
                      const groupKey = `${g.bundleId}-${g.firstStart}`
                      const isActive = isLastGroupActive && groupKey === lastGroupKey
                      const isHovered = hoveredGroup === groupKey
                      const color = distColor(g.category)

                      return (
                        <div
                          key={groupKey}
                          style={{ position: 'relative', marginBottom: 12 }}
                        >
                          {/* Icon circle — positioned in the left padding zone */}
                          <div style={{
                            position: 'absolute',
                            left: -40,
                            top: 16,
                            width: 48,
                            height: 48,
                            borderRadius: 14,
                            background: 'var(--color-surface-highest)',
                            border: '4px solid var(--color-bg)',
                            zIndex: 1,
                            display: 'grid',
                            placeItems: 'center',
                          }}>
                            {isActive ? (
                              /* Pulsing dot for active session */
                              <div style={{
                                width: 10,
                                height: 10,
                                borderRadius: '50%',
                                background: 'var(--color-primary)',
                                boxShadow: '0 0 0 4px rgba(173,198,255,0.20)',
                                animation: 'pulse 2s ease-in-out infinite',
                              }} />
                            ) : (
                              <AppIcon bundleId={g.bundleId} appName={g.appName} color={color} size={32} fontSize={11} cornerRadius={10} />
                            )}
                          </div>

                          {/* Session card */}
                          <div
                            onMouseEnter={() => setHoveredGroup(groupKey)}
                            onMouseLeave={() => setHoveredGroup(null)}
                            style={{
                              background: isActive
                                ? 'rgba(173,198,255,0.05)'
                                : isHovered
                                  ? 'var(--color-surface-container)'
                                  : 'var(--color-surface-low)',
                              border: isActive
                                ? '1px solid rgba(173,198,255,0.20)'
                                : '1px solid var(--color-border-ghost)',
                              borderRadius: 12,
                              padding: 20,
                              boxShadow: 'var(--color-shadow-soft)',
                              transition: 'background 150ms, border-color 150ms',
                              cursor: 'default',
                            }}
                          >
                            {/* Top row: app name + category chip + time range */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {formatDisplayAppName(g.appName)}
                              </span>

                              {isActive && (
                                <span style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.1em',
                                  padding: '3px 10px',
                                  borderRadius: 999,
                                  background: 'var(--gradient-primary)',
                                  color: 'var(--color-primary-contrast)',
                                }}>
                                  Active Now
                                </span>
                              )}

                              <span style={{
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.1em',
                                padding: '3px 10px',
                                borderRadius: 999,
                                background: usesPrimaryGradient(g.category) ? 'var(--gradient-primary)' : `${color}1a`,
                                color: usesPrimaryGradient(g.category) ? 'var(--color-primary-contrast)' : color,
                                flexShrink: 0,
                              }}>
                                {formatCategory(g.category)}
                              </span>

                              <span style={{
                                fontSize: 12,
                                color: 'var(--color-text-tertiary)',
                                flexShrink: 0,
                                fontVariantNumeric: 'tabular-nums',
                              }}>
                                {formatTime(g.firstStart)} – {isActive ? 'now' : formatTime(g.lastEnd)}
                              </span>
                            </div>

                            {/* Bottom row: duration + quality note */}
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderTop: '1px solid var(--color-border-ghost)', paddingTop: 10 }}>
                              <span style={{
                                fontSize: 22,
                                fontWeight: 900,
                                color: isActive ? 'var(--color-primary)' : 'var(--color-text-primary)',
                                letterSpacing: '-0.03em',
                                fontVariantNumeric: 'tabular-nums',
                              }}>
                                {formatDuration(g.totalSeconds)}
                              </span>
                              {g.isFocused && (
                                <span style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--color-text-tertiary)' }}>
                                  deep work
                                </span>
                              )}
                              {g.count > 1 && (
                                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                                  {g.count} sessions
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}

                {/* Spacer so footer doesn't clip last card */}
                {viewMode === 'stats' && <div style={{ height: 100 }} />}
              </>
            )}
          </>
        )}
      </div>

      {/* ── Sticky footer (day view only) ──────────────────────────────── */}
      {viewMode === 'stats' && !error && !loading && groups.length > 0 && (
        <div style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--color-glass-bg)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderTop: '1px solid var(--color-glass-border)',
          padding: '16px 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 24,
          zIndex: 10,
        }}>
          {/* Stats row */}
          <div style={{ display: 'flex', gap: 32 }}>
            <div>
              <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--color-text-tertiary)', margin: '0 0 2px' }}>
                Total Deep Work
              </p>
              <p style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-text-primary)', margin: 0, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {formatDuration(focusSec)}
              </p>
            </div>
            <div>
              <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--color-text-tertiary)', margin: '0 0 2px' }}>
                Focus %
              </p>
              <p style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-text-primary)', margin: 0, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {focusPct}%
              </p>
            </div>
            <div>
              <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--color-text-tertiary)', margin: '0 0 2px' }}>
                Apps
              </p>
              <p style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-text-primary)', margin: 0, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {uniqueApps}
              </p>
            </div>
          </div>

          {/* Goal progress bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
              Focus goal {goalPct}%
            </span>
            <div style={{ width: 120, height: 6, background: 'rgba(66,71,84,0.5)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${goalPct}%`,
                background: goalPct >= 100 ? '#34d399' : 'var(--color-primary)',
                borderRadius: 999,
                transition: 'width 400ms ease',
              }} />
            </div>
          </div>
        </div>
      )}

      {/* Keyframe animation for active session pulse */}
      <style>{`
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(173,198,255,0.30); }
          50% { box-shadow: 0 0 0 8px rgba(173,198,255,0.00); }
        }
      `}</style>
    </div>
  )
}
