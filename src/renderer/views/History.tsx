import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, formatFullDate, percentOf, todayString } from '../lib/format'
import type { AppSession, AppCategory, HistoryDayPayload } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import { BarChart, Bar, Cell, ResponsiveContainer } from 'recharts'
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

interface WeekDayData {
  label: string
  dateStr: string
  totalSeconds: number
  focusSeconds: number
  topCategory: AppCategory | null
  appCount: number
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

const FILTER_PILLS = [
  { key: 'all', label: 'All' },
  { key: 'development', label: 'Focus' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'communication', label: 'Communication' },
  { key: 'browsing', label: 'Browsing' },
] as const

type FilterKey = typeof FILTER_PILLS[number]['key']

export default function History() {
  const [viewMode, setViewMode] = useState<'timeline' | 'week'>('timeline')
  const [date, setDate] = useState(todayString())
  const [dayPayload, setDayPayload] = useState<HistoryDayPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all')

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
      const timer = window.setInterval(() => loadDay(false), 3_000)
      return () => {
        cancelled = true
        window.clearInterval(timer)
      }
    }

    return () => {
      cancelled = true
    }
  }, [date, viewMode])

  const isToday = date === todayString()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
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
            {(['timeline', 'week'] as const).map((mode) => (
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
                {mode === 'timeline' ? 'Timeline' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '32px 40px 0' }}>
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
                {loading && (
                  <div style={{ display: 'grid', gap: 14 }}>
                    <div style={{ height: 18, width: 240, borderRadius: 999, background: 'var(--color-surface-high)', opacity: 0.5 }} />
                    <div style={{ height: 26, width: 360, borderRadius: 999, background: 'var(--color-surface-high)', opacity: 0.5 }} />
                    <div style={{ height: 540, borderRadius: 18, background: 'var(--color-surface-low)', opacity: 0.55 }} />
                  </div>
                )}

                {dayPayload && !loading && (
                  <TimelineDayView
                    payload={dayPayload}
                    date={date}
                    activeFilter={activeFilter}
                    onFilterChange={setActiveFilter}
                  />
                )}

                {!loading && dayPayload && dayPayload.blocks.length === 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '96px 0', textAlign: 'center' }}>
                    <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 6px' }}>No timeline yet</p>
                    <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>No activity was recorded for this date.</p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
