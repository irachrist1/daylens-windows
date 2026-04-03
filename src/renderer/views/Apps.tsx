import { useEffect, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDateShort, formatDuration, formatTime, rollingDayBounds } from '../lib/format'
import { catColor, formatCategory } from '../lib/category'
import { filterVisibleSessions, groupConsecutiveSessions } from '../lib/activity'
import type { AppCategory, AppCategorySuggestion, AppSession, AppUsageSummary, LiveSession } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import AppIcon from '../components/AppIcon'
import { formatDisplayAppName } from '../lib/apps'

const ALL_CATEGORIES: AppCategory[] = [
  'development', 'communication', 'browsing', 'writing', 'design',
  'aiTools', 'email', 'research', 'productivity', 'meetings',
  'entertainment', 'social', 'system', 'uncategorized',
]

const DAYS_OPTIONS = [1, 7, 30] as const

function isPresentationNoise(category: AppCategory, durationSeconds: number): boolean {
  return (category === 'system' || category === 'uncategorized') && durationSeconds < 120
}

function mergeLiveSummary(
  summaries: AppUsageSummary[],
  live: LiveSession | null,
  days: number,
): AppUsageSummary[] {
  if (!live) return summaries

  const [fromMs, toMs] = rollingDayBounds(days)
  const liveStart = Math.max(live.startTime, fromMs)
  const liveEnd = Math.min(Date.now(), toMs)
  const liveDur = Math.max(0, Math.round((liveEnd - liveStart) / 1_000))
  if (liveDur < 3) return summaries

  const existingIdx = summaries.findIndex((summary) => summary.bundleId === live.bundleId)
  if (existingIdx >= 0) {
    return summaries.map((summary, index) =>
      index === existingIdx
        ? { ...summary, totalSeconds: summary.totalSeconds + liveDur }
        : summary,
    ).sort((a, b) => b.totalSeconds - a.totalSeconds)
  }

  return [
    ...summaries,
    {
      bundleId: live.bundleId,
      appName: live.appName,
      category: live.category,
      totalSeconds: liveDur,
      isFocused: FOCUSED_CATEGORIES.includes(live.category),
      sessionCount: 1,
    },
  ].sort((a, b) => b.totalSeconds - a.totalSeconds)
}

function buildUsageInsight(
  appName: string,
  sessionCount: number,
  avgSessionSeconds: number,
  totalSeconds: number,
): string {
  const displayName = formatDisplayAppName(appName)
  if (sessionCount > 8 && avgSessionSeconds < 300) {
    return `You opened ${displayName} ${sessionCount} times with an average of ${formatDuration(avgSessionSeconds)} - that is a short, repeated-use pattern.`
  }
  if (avgSessionSeconds > 1800) {
    return `You use ${displayName} in long sustained blocks (avg ${formatDuration(avgSessionSeconds)}) - steady usage.`
  }
  if (sessionCount <= 3 && totalSeconds > 3600) {
    return `You had ${sessionCount} long sustained ${sessionCount === 1 ? 'session' : 'sessions'} today - steady usage.`
  }
  return `Regular usage across ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'} today.`
}

function buildCharacterLine(
  category: AppCategory,
  avgSessionSeconds: number,
  sessionCount: number,
): string {
  if (FOCUSED_CATEGORIES.includes(category) && avgSessionSeconds > 20 * 60) return 'Sustained use'
  if ((category === 'browsing' || category === 'entertainment') && avgSessionSeconds < 300) return 'Short sessions'
  if (category === 'meetings') return 'Communication & calls'
  if (sessionCount > 10 && avgSessionSeconds < 5 * 60) return 'Short repeated sessions'
  return formatCategory(category)
}

// Canonical category color map
const CAT_COLORS: Record<string, string> = {
  development:   '#adc6ff',
  aiTools:       '#34d399',
  writing:       '#c084fc',
  design:        '#e879f9',
  research:      '#67e8f9',
  meetings:      '#ffb95f',
  communication: '#4fdbc8',
  email:         '#fbbf24',
  productivity:  '#a3e635',
  browsing:      '#94a3b8',
  entertainment: '#f87171',
  social:        '#fb923c',
  system:        '#6b7280',
  uncategorized: '#6b7280',
}

function distColor(category: AppCategory): string {
  return CAT_COLORS[category] ?? catColor(category) ?? '#52525b'
}

export default function Apps() {
  const [days, setDays] = useState<(typeof DAYS_OPTIONS)[number]>(7)
  const [summaries, setSummaries] = useState<AppUsageSummary[]>([])
  const [live, setLive] = useState<LiveSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedCat, setSelectedCat] = useState<AppCategory | null>(null)
  const [selectedApp, setSelectedApp] = useState<AppUsageSummary | null>(null)
  const [, setOverrides] = useState<Record<string, AppCategory>>({})
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)
  const [categorySuggestions, setCategorySuggestions] = useState<Record<string, AppCategorySuggestion>>({})
  const dropdownRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null)
      }
    }
    if (openDropdown) {
      document.addEventListener('mousedown', handleOutsideClick)
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [openDropdown])

  useEffect(() => {
    setLoading(true)
    setError(null)
    setSelectedCat(null)
    setSelectedApp(null)

    let cancelled = false

    async function refresh() {
      if (document.hidden) return
      try {
        const [summaryData, liveData, overrideData] = await Promise.all([
          ipc.db.getAppSummaries(days),
          ipc.tracking.getLiveSession(),
          ipc.db.getCategoryOverrides(),
        ])
        if (cancelled) return
        setSummaries(summaryData as AppUsageSummary[])
        setLive(liveData as LiveSession | null)
        setOverrides(overrideData as Record<string, AppCategory>)
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
  }, [days])

  async function handleSetOverride(bundleId: string, category: AppCategory) {
    setOpenDropdown(null)
    await ipc.db.setCategoryOverride(bundleId, category)
    const [summaryData, overrideData] = await Promise.all([
      ipc.db.getAppSummaries(days),
      ipc.db.getCategoryOverrides(),
    ])
    setSummaries(summaryData as AppUsageSummary[])
    setOverrides(overrideData as Record<string, AppCategory>)
  }

  async function handleClearOverride(bundleId: string) {
    setOpenDropdown(null)
    await ipc.db.clearCategoryOverride(bundleId)
    const [summaryData, overrideData] = await Promise.all([
      ipc.db.getAppSummaries(days),
      ipc.db.getCategoryOverrides(),
    ])
    setSummaries(summaryData as AppUsageSummary[])
    setOverrides(overrideData as Record<string, AppCategory>)
  }

  // These must be computed BEFORE any early return — they are deps of the useEffect below.
  const mergedSummaries = mergeLiveSummary(summaries, live, days)
  const visibleSummaries = mergedSummaries.filter(
    (summary) => !isPresentationNoise(summary.category, summary.totalSeconds),
  )

  // Auto-suggest categories for uncategorized apps. Must be declared before the early
  // return below, or React will throw "rendered fewer hooks than expected".
  useEffect(() => {
    const uncategorized = visibleSummaries
      .filter((summary) => summary.category === 'uncategorized' && !categorySuggestions[summary.bundleId])
      .slice(0, 6)

    if (uncategorized.length === 0) return

    let cancelled = false
    void Promise.all(
      uncategorized.map(async (summary) => {
        const suggestion = await ipc.ai.suggestAppCategory(summary.bundleId, summary.appName)
        return [summary.bundleId, suggestion] as const
      }),
    ).then((results) => {
      if (cancelled) return
      setCategorySuggestions((current) => {
        const next = { ...current }
        for (const [bundleId, suggestion] of results) {
          next[bundleId] = suggestion
        }
        return next
      })
    }).catch(() => {
      // Suggestion failure should never break the Apps view.
    })

    return () => {
      cancelled = true
    }
  }, [categorySuggestions, visibleSummaries])

  if (selectedApp) {
    const selectedSummary =
      live && live.bundleId === selectedApp.bundleId
        ? (mergeLiveSummary([selectedApp], live, days).find(
            (summary) => summary.bundleId === selectedApp.bundleId,
          ) ?? selectedApp)
        : selectedApp

    return (
      <AppDetailPanel
        app={selectedSummary}
        days={days}
        onBack={() => setSelectedApp(null)}
        onDaysChange={setDays}
      />
    )
  }

  function renderCategoryDropdown(bundleId: string, currentCategory: AppCategory) {
    const suggestion = categorySuggestions[bundleId]
    return (
      <div
        ref={dropdownRef}
        style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          zIndex: 50, borderRadius: 8, padding: '4px 0', minWidth: 160,
          background: 'var(--color-surface-card)',
          border: '1px solid var(--color-border-ghost)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {currentCategory === 'uncategorized' && suggestion?.suggestedCategory && (
          <div style={{ padding: '6px 12px 8px' }}>
            <button
              onClick={(event) => {
                event.stopPropagation()
                void handleSetOverride(bundleId, suggestion.suggestedCategory!)
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-high)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                AI suggests {formatCategory(suggestion.suggestedCategory)}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>Use</span>
            </button>
            {suggestion.reason && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: 'var(--color-text-tertiary)', lineHeight: 1.35 }}>
                {suggestion.reason}
              </div>
            )}
          </div>
        )}
        {ALL_CATEGORIES.map((category) => {
          const color = distColor(category)
          const active = category === currentCategory
          return (
            <button
              key={category}
              onClick={(event) => {
                event.stopPropagation()
                void handleSetOverride(bundleId, category)
              }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 12px', background: 'transparent', border: 'none',
                cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-high)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: active ? color : 'var(--color-text-primary)', fontWeight: active ? 600 : 400 }}>
                {formatCategory(category)}
              </span>
            </button>
          )
        })}
        <div style={{ borderTop: '1px solid var(--color-border-ghost)', marginTop: 4, paddingTop: 4 }}>
          <button
            onClick={(event) => {
              event.stopPropagation()
              void handleClearOverride(bundleId)
            }}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-high)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Reset to auto</span>
          </button>
        </div>
      </div>
    )
  }

  const totalSeconds = mergedSummaries.reduce((sum, summary) => sum + summary.totalSeconds, 0)
  const filtered = selectedCat
    ? visibleSummaries.filter((summary) => summary.category === selectedCat)
    : visibleSummaries

  const catMap = new Map<AppCategory, number>()
  for (const s of visibleSummaries) catMap.set(s.category, (catMap.get(s.category) ?? 0) + s.totalSeconds)
  const catBreakdown = [...catMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, seconds]) => ({ category, seconds }))

  return (
    <div style={{ padding: '32px 40px', overflowY: 'auto', height: '100%' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 900, color: 'var(--color-text-primary)', margin: '0 0 4px', letterSpacing: '-0.02em', lineHeight: 1 }}>
            App Usage
          </h1>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
            {days === 1 ? "Today's" : `Last ${days} days'`} app activity
          </p>
        </div>
        {/* Range tabs */}
        <div style={{ display: 'flex', gap: 2, background: 'var(--color-surface-low)', borderRadius: 12, padding: 4 }}>
          {DAYS_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => setDays(option)}
              style={{
                padding: '6px 14px', borderRadius: 8, fontSize: 12,
                fontWeight: days === option ? 700 : 500,
                border: 'none', cursor: 'pointer',
                background: days === option ? 'var(--gradient-primary)' : 'transparent',
                color: days === option ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                transition: 'all 120ms',
              }}
            >
              {option === 1 ? 'Today' : `${option}d`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : error ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 0', gap: 12, textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: '#f87171', margin: 0 }}>Failed to load apps: {error}</p>
          <button
            onClick={() => { setError(null); setLoading(true) }}
            style={{ padding: '8px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', background: 'var(--color-primary)', color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 700 }}
          >
            Retry
          </button>
        </div>
      ) : summaries.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 0', textAlign: 'center' }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 6px' }}>No data</p>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>No app usage recorded for this period.</p>
        </div>
      ) : (
        <>
          {/* Category filter chips */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20, overflowX: 'auto', paddingBottom: 4 }}>
            <button
              onClick={() => setSelectedCat(null)}
              style={{
                padding: '4px 14px', borderRadius: 999, border: !selectedCat ? '1px solid rgba(173,198,255,0.22)' : '1px solid var(--color-border-ghost)', cursor: 'pointer',
                fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em',
                background: !selectedCat ? 'var(--gradient-primary)' : 'var(--color-surface-low)',
                color: !selectedCat ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                transition: 'all 120ms', flexShrink: 0,
              }}
            >
              All
            </button>
            {catBreakdown.slice(0, 8).map((c) => {
              const active = selectedCat === c.category
              const color = distColor(c.category)
              return (
                <button
                  key={c.category}
                  onClick={() => setSelectedCat(active ? null : c.category)}
                  style={{
                    padding: '4px 14px', borderRadius: 999, border: active ? `1px solid ${color}33` : '1px solid var(--color-border-ghost)', cursor: 'pointer',
                    fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em',
                    background: active && c.category === 'development' ? 'var(--gradient-primary)' : active ? `${color}1a` : 'var(--color-surface-low)',
                    color: active && c.category === 'development' ? 'var(--color-primary-contrast)' : active ? color : 'var(--color-text-secondary)',
                    transition: 'all 120ms', flexShrink: 0,
                  }}
                >
                  {formatCategory(c.category)}
                </button>
              )
            })}
          </div>

          {/* App list */}
          {filtered.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '40px 0', margin: 0 }}>
              No apps in this category for the selected period.
            </p>
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--color-surface-container)',
              border: '1px solid var(--color-border-ghost)',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: 'var(--color-shadow-soft)',
            }}>
              {filtered.map((app, index) => {
                const pct = totalSeconds > 0 ? Math.round((app.totalSeconds / totalSeconds) * 100) : 0
                const color = distColor(app.category)
                const displayName = formatDisplayAppName(app.appName)
                const sc = app.sessionCount ?? 1
                const avgSec = sc > 0 ? Math.round(app.totalSeconds / sc) : 0
                const suggestion = categorySuggestions[app.bundleId]
                const characterLine = app.category === 'uncategorized' && suggestion?.suggestedCategory
                  ? `AI suggests ${formatCategory(suggestion.suggestedCategory)}`
                  : buildCharacterLine(app.category, avgSec, sc)
                const isLive = live?.bundleId === app.bundleId

                return (
                  <div
                    key={app.bundleId}
                    onClick={() => setSelectedApp(app)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      minHeight: 64, padding: '0 18px', cursor: 'pointer',
                      borderBottom: index < filtered.length - 1 ? '1px solid var(--color-border-ghost)' : 'none',
                      boxShadow: isLive ? 'inset 4px 0 0 var(--color-primary)' : 'none',
                      background: isLive ? 'linear-gradient(90deg, rgba(15,99,219,0.08), transparent 18%)' : 'transparent',
                      transition: 'background 120ms',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-low)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* Rank */}
                    <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', width: 20, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {index + 1}
                    </span>

                    {/* Icon */}
                    <div style={{
                      width: 40, height: 40, borderRadius: 12,
                      background: 'var(--color-surface-highest)',
                      border: '1px solid var(--color-border-ghost)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <AppIcon bundleId={app.bundleId} appName={app.appName} color={color} size={28} fontSize={11} />
                    </div>

                    {/* Name + character line + dropdown */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {displayName}
                        </span>
                        <div className="relative" style={{ display: 'inline-block' }}>
                          <button
                            onClick={(event) => {
                              event.stopPropagation()
                              setOpenDropdown(openDropdown === app.bundleId ? null : app.bundleId)
                            }}
                            title="Change category"
                            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 0 }}
                          >
                            {characterLine}
                            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ opacity: 0.5 }}>
                              <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          {openDropdown === app.bundleId && renderCategoryDropdown(app.bundleId, app.category)}
                        </div>
                      </div>
                    </div>

                    {/* Category chip */}
                    <div style={{
                      padding: '3px 10px', borderRadius: 999, flexShrink: 0,
                      background: `${color}14`, color, fontWeight: 700, fontSize: 10,
                      textTransform: 'uppercase', letterSpacing: '0.1em',
                    }}>
                      {formatCategory(app.category)}
                    </div>

                    {/* Mini progress bar + duration */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                      <div style={{ width: 60, height: 4, borderRadius: 99, background: 'var(--color-surface-highest)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--gradient-primary)', borderRadius: 99 }} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--color-primary)', fontVariantNumeric: 'tabular-nums', minWidth: 52, textAlign: 'right' }}>
                        {formatDuration(app.totalSeconds)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function AppDetailPanel({
  app,
  days,
  onBack,
  onDaysChange,
}: {
  app: AppUsageSummary
  days: number
  onBack: () => void
  onDaysChange: (d: (typeof DAYS_OPTIONS)[number]) => void
}) {
  const [sessions, setSessions] = useState<AppSession[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState<LiveSession | null>(null)
  const [backHovered, setBackHovered] = useState(false)
  const [hoveredSparkIndex, setHoveredSparkIndex] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      const [sessionData, liveData] = await Promise.all([
        ipc.db.getAppSessions(app.bundleId, days),
        ipc.tracking.getLiveSession(),
      ])
      if (cancelled) return
      setSessions(sessionData as AppSession[])
      setLive(liveData as LiveSession | null)
      setLoading(false)
    }

    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [app.bundleId, days])

  const color = distColor(app.category)
  const [fromMs, toMs] = rollingDayBounds(days)
  const liveSession = live && live.bundleId === app.bundleId
    ? (() => {
        const startTime = Math.max(live.startTime, fromMs)
        const endTime = Math.min(Date.now(), toMs)
        const durationSeconds = Math.max(0, Math.round((endTime - startTime) / 1_000))
        if (durationSeconds < 3) return null
        return {
          id: -1,
          bundleId: live.bundleId,
          appName: live.appName,
          startTime,
          endTime,
          durationSeconds,
          category: live.category,
          isFocused: FOCUSED_CATEGORIES.includes(live.category),
        } satisfies AppSession
      })()
    : null
  const detailSessions = liveSession ? [liveSession, ...sessions] : sessions
  const visibleSessions = filterVisibleSessions(detailSessions, 10, false)
  const groupedSessions = groupConsecutiveSessions(visibleSessions, { gapMs: 5 * 60_000, minSeconds: 10 }).slice().reverse()
  const displayName = formatDisplayAppName(app.appName)
  const sessionTotalSeconds = visibleSessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  const avgSessionSeconds = visibleSessions.length > 0 ? Math.round(sessionTotalSeconds / visibleSessions.length) : 0
  const longestSession = visibleSessions.length > 0 ? Math.max(...visibleSessions.map((s) => s.durationSeconds)) : 0

  const usageInsight = buildUsageInsight(app.appName, visibleSessions.length, avgSessionSeconds, sessionTotalSeconds)

  // Intentionality breakdown
  const catMap = new Map<AppCategory, number>()
  for (const s of visibleSessions) catMap.set(s.category, (catMap.get(s.category) ?? 0) + s.durationSeconds)
  const catBreakdown = [...catMap.entries()].sort((a, b) => b[1] - a[1])

  // Sparkline bars (7 days placeholder distribution based on sessions)
  const sparkBars = Array.from({ length: 7 }, (_, i) => {
    const dayBucket = visibleSessions.filter((s) => {
      const d = new Date(s.startTime)
      const today = new Date()
      const diff = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
      return diff === (6 - i)
    }).reduce((sum, s) => sum + s.durationSeconds, 0)
    return dayBucket
  })
  const maxSpark = Math.max(...sparkBars, 1)
  const primaryCategoryPct = catBreakdown[0] ? Math.round((catBreakdown[0][1] / Math.max(sessionTotalSeconds, 1)) * 100) : 0
  const sparkLabels = Array.from({ length: 7 }, (_, i) => {
    const date = new Date()
    date.setDate(date.getDate() - (6 - i))
    return date.toLocaleDateString('en-US', { weekday: 'short' })
  })
  const hoveredSparkText = hoveredSparkIndex !== null
    ? `${sparkLabels[hoveredSparkIndex]} · ${sparkBars[hoveredSparkIndex] > 0 ? formatDuration(sparkBars[hoveredSparkIndex]) : 'No usage'}`
    : null

  return (
    <div style={{ overflowY: 'auto', height: '100%' }}>
      {/* Hero section */}
      <div style={{ padding: '32px 40px 0' }}>
        {/* Breadcrumb */}
        <button
          onClick={onBack}
          style={{
            fontSize: 12, fontWeight: 700, color: backHovered ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
            background: backHovered ? 'var(--gradient-primary)' : 'none', border: 'none', cursor: 'pointer',
            marginBottom: 24, padding: backHovered ? '6px 12px' : '0',
            display: 'flex', alignItems: 'center', gap: 6,
            letterSpacing: '0.02em', borderRadius: 999, transition: 'all 120ms ease',
          }}
          onMouseEnter={() => setBackHovered(true)}
          onMouseLeave={() => setBackHovered(false)}
        >
          Back to Apps
        </button>

        {/* App hero row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 32 }}>
          {/* App icon */}
          <div style={{
            width: 96, height: 96, borderRadius: 12,
            background: 'var(--color-surface-highest)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            boxShadow: `0 8px 32px ${color}18`,
          }}>
            <AppIcon bundleId={app.bundleId} appName={app.appName} color={color} size={64} fontSize={22} />
          </div>

          {/* Title + category */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{
              fontSize: 36, fontWeight: 900, color: 'var(--color-text-primary)',
              margin: '0 0 6px', letterSpacing: '-0.03em', lineHeight: 1,
            }}>
              {displayName}
            </h1>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 12px', borderRadius: 999,
              background: `${color}1a`, color, fontWeight: 700,
              fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em',
            }}>
              {formatCategory(app.category)}
            </div>
          </div>

          {/* Range tabs */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--color-surface-low)', borderRadius: 12, padding: 4, flexShrink: 0 }}>
            {DAYS_OPTIONS.map((option) => (
              <button
                key={option}
                onClick={() => onDaysChange(option)}
                style={{
                  padding: '6px 14px', borderRadius: 8, fontSize: 12,
                  fontWeight: days === option ? 700 : 500,
                  border: 'none', cursor: 'pointer',
                  background: days === option ? 'var(--gradient-primary)' : 'transparent',
                  color: days === option ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                  transition: 'all 120ms',
                }}
              >
                {option === 1 ? 'Today' : `${option}d`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: '0 40px', display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16, alignItems: 'start' }}>
        {/* Col A: Total Usage card */}
        <div style={{
          background: 'var(--color-surface-container)', borderRadius: 12, padding: 32,
          border: '1px solid var(--color-border-ghost)',
          display: 'flex', flexDirection: 'column',
        }}>
          <p style={{
            fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
            letterSpacing: '0.2em', color: 'var(--color-text-secondary)',
            margin: '0 0 12px',
          }}>
            Total Usage
          </p>
          <p style={{
            fontSize: 52, fontWeight: 900, color: 'var(--color-text-primary)',
            margin: '0 0 4px', letterSpacing: '-0.03em', lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {formatDuration(app.totalSeconds)}
          </p>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 auto' }}>
            {visibleSessions.length} {visibleSessions.length === 1 ? 'session' : 'sessions'}
          </p>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '14px 0 0', lineHeight: 1.6, maxWidth: 300 }}>
            {usageInsight}
          </p>

          {/* Sparkline bars */}
          {hoveredSparkText && (
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary)', margin: '18px 0 0' }}>
              {hoveredSparkText}
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 96, marginTop: hoveredSparkText ? 10 : 24 }}>
            {sparkBars.map((val, i) => {
              const isToday = i === sparkBars.length - 1
              const h = Math.max(4, Math.round((val / maxSpark) * 96))
              return (
                <div
                  key={i}
                  style={{ flex: 1, height: 96, display: 'flex', alignItems: 'flex-end' }}
                  onMouseEnter={() => setHoveredSparkIndex(i)}
                  onMouseLeave={() => setHoveredSparkIndex(null)}
                  title={`${sparkLabels[i]}: ${val > 0 ? formatDuration(val) : 'No usage'}`}
                >
                  <div style={{
                    width: '100%', height: h,
                    borderRadius: 4,
                    background: isToday ? 'var(--gradient-primary)' : 'var(--color-surface-highest)',
                    opacity: hoveredSparkIndex === null || hoveredSparkIndex === i ? 1 : 0.42,
                    transition: 'height 300ms, opacity 140ms ease',
                  }} />
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Bento row 2: Intentionality Breakdown (7/12) + Session History (5/12) */}
      <div style={{ padding: '0 40px', display: 'grid', gridTemplateColumns: '7fr 5fr', gap: 16, marginBottom: 16, alignItems: 'start' }}>
        {/* Col A: Glass Intentionality Breakdown */}
        <div style={{
          background: 'var(--color-glass-bg)',
          backdropFilter: 'blur(20px)',
          border: '1px solid var(--color-glass-border)',
          borderRadius: 12, padding: 32,
        }}>
          <p style={{
            fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
            letterSpacing: '0.2em', color: 'var(--color-text-secondary)',
            margin: '0 0 12px',
          }}>
            Usage Profile
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Avg Session', value: avgSessionSeconds > 0 ? formatDuration(avgSessionSeconds) : '--' },
              { label: 'Longest', value: longestSession > 0 ? formatDuration(longestSession) : '--' },
              { label: 'Sessions', value: String(visibleSessions.length) },
            ].map((stat) => (
              <div
                key={stat.label}
                style={{
                  borderRadius: 10,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface-container)',
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <span style={{
                  fontSize: 10,
                  fontWeight: 900,
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  color: 'var(--color-text-secondary)',
                }}>
                  {stat.label}
                </span>
                <span style={{
                  fontSize: 22,
                  fontWeight: 900,
                  color: 'var(--color-text-primary)',
                  letterSpacing: '-0.03em',
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {stat.value}
                </span>
              </div>
            ))}
          </div>
          {catBreakdown.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: 0 }}>No data available.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '14px 16px',
                borderRadius: 10,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-container)',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{
                    fontSize: 10,
                    fontWeight: 900,
                    textTransform: 'uppercase',
                    letterSpacing: '0.14em',
                    color: 'var(--color-text-secondary)',
                  }}>
                    Primary Mode
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-text-primary)' }}>
                    {formatCategory(catBreakdown[0][0])}
                  </span>
                </div>
                <span style={{
                  fontSize: 22,
                  fontWeight: 900,
                  color: 'var(--color-primary)',
                  letterSpacing: '-0.03em',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {primaryCategoryPct}%
                </span>
              </div>
              {catBreakdown.map(([cat, sec]) => {
                const pct = Math.round((sec / (sessionTotalSeconds || 1)) * 100)
                const cColor = distColor(cat as AppCategory)
                return (
                  <div key={cat}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: cColor, flexShrink: 0 }} />
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                          {formatCategory(cat)}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)' }}>{pct}%</span>
                    </div>
                    <div style={{ height: 10, borderRadius: 999, background: 'var(--color-bg)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', width: `${pct}%`,
                        background: cColor, borderRadius: 999,
                        transition: 'width 300ms',
                      }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Col B: Session History card */}
        <div style={{
          background: 'var(--color-surface-container)',
          border: '1px solid var(--color-border-ghost)',
          borderRadius: 12,
          padding: 32,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--color-shadow-soft)',
        }}>
          <p style={{
            fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
            letterSpacing: '0.2em', color: 'var(--color-text-secondary)',
            margin: '0 0 16px',
          }}>
            Session History
          </p>

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...Array(4)].map((_, i) => (
                <div key={i} style={{ height: 36, borderRadius: 8, background: 'var(--color-surface-high)', opacity: 0.5 }} />
              ))}
            </div>
          ) : groupedSessions.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: 0 }}>No sessions recorded.</p>
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              border: '1px solid var(--color-border-ghost)',
              borderRadius: 12,
              overflow: 'hidden',
              background: 'var(--color-surface-low)',
            }}>
              {groupedSessions.slice(0, 6).map((group, index) => (
                <div
                  key={group.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 12px',
                    borderBottom: index < Math.min(groupedSessions.length, 6) - 1 ? '1px solid var(--color-border-ghost)' : 'none',
                    transition: 'background 120ms',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-high)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {days > 1 && (
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                      {formatDateShort(group.startTime)}
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {formatTime(group.startTime)} - {formatTime(group.endTime)}
                  </span>
                  {group.sessionCount > 1 && (
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>x{group.sessionCount}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, fontWeight: 900, color: 'var(--color-primary)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {formatDuration(group.totalSeconds)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Stats footer */}
          {!loading && visibleSessions.length > 0 && (
            <div style={{
              display: 'flex', gap: 0, marginTop: 16,
              borderTop: '1px solid var(--color-border-ghost)', paddingTop: 16,
            }}>
              {[
                { label: 'Avg session', value: avgSessionSeconds > 0 ? formatDuration(avgSessionSeconds) : '--' },
                { label: 'Longest', value: longestSession > 0 ? formatDuration(longestSession) : '--' },
              ].map((stat, i) => (
                <div key={stat.label} style={{
                  flex: 1,
                  paddingLeft: i > 0 ? 16 : 0,
                  borderLeft: i > 0 ? '1px solid var(--color-border-ghost)' : 'none',
                }}>
                  <p style={{
                    fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
                    letterSpacing: '0.15em', color: 'var(--color-text-secondary)',
                    margin: '0 0 4px',
                  }}>
                    {stat.label}
                  </p>
                  <p style={{
                    fontSize: 15, fontWeight: 900, color: 'var(--color-text-primary)',
                    margin: 0, fontVariantNumeric: 'tabular-nums',
                  }}>
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {[0,1,2,3].map((i) => (
          <div key={i} style={{ height: 30, width: 80, borderRadius: 999, background: 'var(--color-surface-container)', opacity: 0.5 }} />
        ))}
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ height: 56, borderRadius: 12, background: 'var(--color-surface-container)', opacity: 0.4 }} />
      ))}
    </div>
  )
}


