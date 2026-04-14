import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'
import { useKeyboardNav } from '../hooks/useKeyboardNav'
import { formatDuration, rollingDayBounds } from '../lib/format'
import { formatCategory } from '../lib/category'
import type { AppCategory, AppCategorySuggestion, AppCharacter, AppDetailPayload, AppUsageSummary, ArtifactRef, LiveSession } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import AppIcon from '../components/AppIcon'
import { formatDisplayAppName } from '../lib/apps'

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_CATEGORIES: AppCategory[] = [
  'development', 'communication', 'browsing', 'writing', 'design',
  'aiTools', 'email', 'research', 'productivity', 'meetings',
  'entertainment', 'social', 'system', 'uncategorized',
]

const DAYS_OPTIONS = [1, 7, 30] as const

// ─── Category color map ───────────────────────────────────────────────────────

const CAT_COLORS: Record<string, string> = {
  development:   '#6a91ff',
  aiTools:       '#d86cff',
  writing:       '#c084fc',
  design:        '#ff6bb0',
  research:      '#7e63ff',
  meetings:      '#14b8a6',
  communication: '#ff7a59',
  email:         '#38bdf8',
  productivity:  '#4f46e5',
  browsing:      '#f97316',
  entertainment: '#f59e0b',
  social:        '#fb7185',
  system:        '#94a3b8',
  uncategorized: '#6b7280',
}

function catColor(category: AppCategory): string {
  return CAT_COLORS[category] ?? '#94a3b8'
}

function withAlpha(hex: string, alpha: number): string {
  const n = hex.replace('#', '')
  const expanded = n.length === 3 ? n.split('').map((p) => `${p}${p}`).join('') : n
  const v = Number.parseInt(expanded, 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}

// ─── Character helpers ────────────────────────────────────────────────────────

function buildCharacterSummary(
  appName: string,
  category: AppCategory,
  character: AppCharacter | null,
  sessionCount: number,
  avgSessionSeconds: number,
): string {
  const display = formatDisplayAppName(appName)
  if (!character || character.confidence < 0.25) {
    if (sessionCount <= 2) {
      // Lean on category for something useful rather than "not enough data"
      const catHint: Partial<Record<AppCategory, string>> = {
        development: `${display} — a development tool. Only ${sessionCount} session${sessionCount !== 1 ? 's' : ''} recorded so far.`,
        communication: `${display} — communication. Brief usage so far.`,
        email: `${display} — email. Brief usage so far.`,
        aiTools: `${display} — AI assistant. Brief usage so far.`,
        browsing: `${display} — browser. Brief usage so far.`,
        writing: `${display} — writing tool. Brief usage so far.`,
        productivity: `${display} — productivity tool. Brief usage so far.`,
        design: `${display} — design tool. Brief usage so far.`,
        entertainment: `${display} — entertainment. Brief usage so far.`,
      }
      return catHint[category] ?? `${display} — ${sessionCount} session${sessionCount !== 1 ? 's' : ''} recorded so far.`
    }
    if (avgSessionSeconds > 3600) return `${display} is used for long stretches — averaging ${formatDuration(avgSessionSeconds)} per session, likely a core part of your workflow.`
    if (avgSessionSeconds > 1800) return `${display} is used in sustained sessions, averaging ${formatDuration(avgSessionSeconds)} each. ${sessionCount} sessions in this period.`
    if (avgSessionSeconds > 300) return `${display} — ${sessionCount} sessions averaging ${formatDuration(avgSessionSeconds)} each.`
    return `${display} — ${sessionCount} brief sessions, typically ${formatDuration(avgSessionSeconds)} each.`
  }
  const avg = formatDuration(Math.round(character.avgSessionMinutes * 60))
  switch (character.character) {
    case 'deep_focus':
      return `${display} is a deep-focus tool for you — ${avg} average sessions, long uninterrupted blocks of work.`
    case 'flow_compatible':
      return `${display} fits your flow — ${avg} sessions on average with few interruptions.`
    case 'context_switching':
      return `You visit ${display} frequently and briefly — quick checks rather than sustained work. Typical: ${avg}.`
    case 'distraction':
      return `${display} appears as short breaks between other tasks, averaging ${avg} per visit.`
    case 'communication':
      return `${display} is a communication hub — frequent visits averaging ${avg}, managing messages throughout the day.`
    default:
      if (avgSessionSeconds > 3600) return `${display} is a core part of your day — sustained use averaging ${avg} per session.`
      if (category === 'browsing') return `Research and browsing in ${display}, averaging ${avg} per session.`
      return `Regular use of ${display}, averaging ${avg} per session.`
  }
}

// ─── Merge live session into summaries ────────────────────────────────────────

function mergeLiveSummary(summaries: AppUsageSummary[], live: LiveSession | null, days: number): AppUsageSummary[] {
  if (!live) return summaries
  const [fromMs, toMs] = rollingDayBounds(days)
  const liveStart = Math.max(live.startTime, fromMs)
  const liveEnd = Math.min(Date.now(), toMs)
  const liveDur = Math.max(0, Math.round((liveEnd - liveStart) / 1_000))
  if (liveDur < 3) return summaries
  const idx = summaries.findIndex((s) => s.bundleId === live.bundleId)
  if (idx >= 0) {
    return summaries.map((s, i) =>
      i === idx ? { ...s, totalSeconds: s.totalSeconds + liveDur } : s,
    ).sort((a, b) => b.totalSeconds - a.totalSeconds)
  }
  return [
    ...summaries,
    {
      canonicalAppId: live.canonicalAppId ?? live.bundleId,
      bundleId: live.bundleId, appName: live.appName, category: live.category,
      totalSeconds: liveDur, isFocused: FOCUSED_CATEGORIES.includes(live.category), sessionCount: 1,
    },
  ].sort((a, b) => b.totalSeconds - a.totalSeconds)
}

function isPresentationNoise(category: AppCategory, durationSeconds: number): boolean {
  return (category === 'system' || category === 'uncategorized') && durationSeconds < 120
}

// ─── Apps list ────────────────────────────────────────────────────────────────

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
  const [characters, setCharacters] = useState<Record<string, AppCharacter | null>>({})
  const dropdownRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null)
      }
    }
    if (openDropdown) document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [openDropdown])

  useEffect(() => {
    setLoading(true); setError(null); setSelectedCat(null)
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
    return () => { cancelled = true; clearInterval(timer) }
  }, [days])

  async function handleSetOverride(bundleId: string, category: AppCategory) {
    setOpenDropdown(null)
    await ipc.db.setCategoryOverride(bundleId, category)
    const [summaryData, overrideData] = await Promise.all([ipc.db.getAppSummaries(days), ipc.db.getCategoryOverrides()])
    setSummaries(summaryData as AppUsageSummary[])
    setOverrides(overrideData as Record<string, AppCategory>)
  }

  async function handleClearOverride(bundleId: string) {
    setOpenDropdown(null)
    await ipc.db.clearCategoryOverride(bundleId)
    const [summaryData, overrideData] = await Promise.all([ipc.db.getAppSummaries(days), ipc.db.getCategoryOverrides()])
    setSummaries(summaryData as AppUsageSummary[])
    setOverrides(overrideData as Record<string, AppCategory>)
  }

  const mergedSummaries = mergeLiveSummary(summaries, live, days)
  const visibleSummaries = mergedSummaries.filter((s) => !isPresentationNoise(s.category, s.totalSeconds))

  // Auto-suggest categories for uncategorized apps.
  // Track which bundleIds we've already requested to prevent re-firing.
  const requestedSuggestionsRef = useRef(new Set<string>())
  useEffect(() => {
    const uncategorized = visibleSummaries
      .filter((s) => s.category === 'uncategorized' && !categorySuggestions[s.bundleId] && !requestedSuggestionsRef.current.has(s.bundleId))
      .slice(0, 6)
    if (uncategorized.length === 0) return
    // Mark these as requested immediately to avoid duplicate calls
    for (const s of uncategorized) requestedSuggestionsRef.current.add(s.bundleId)
    let cancelled = false
    void Promise.all(
      uncategorized.map(async (s) => {
        const suggestion = await ipc.ai.suggestAppCategory(s.bundleId, s.appName)
        return [s.bundleId, suggestion] as const
      }),
    ).then((results) => {
      if (cancelled) return
      setCategorySuggestions((cur) => {
        const next = { ...cur }
        for (const [bundleId, suggestion] of results) next[bundleId] = suggestion
        return next
      })
    }).catch(() => { /* fail silently */ })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSummaries.map((s) => s.bundleId).join(',')])

  // Background-load character data for visible apps
  useEffect(() => {
    const toFetch = visibleSummaries.filter((s) => !(s.bundleId in characters)).slice(0, 10)
    if (toFetch.length === 0) return
    let cancelled = false
    void Promise.all(
      toFetch.map(async (s) => {
        const ch = await ipc.db.getAppCharacter(s.bundleId, days).catch(() => null)
        return [s.bundleId, ch] as const
      }),
    ).then((results) => {
      if (cancelled) return
      setCharacters((cur) => {
        const next = { ...cur }
        for (const [bundleId, ch] of results) next[bundleId] = ch
        return next
      })
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSummaries.map((s) => s.bundleId).join(','), days])

  function renderCategoryDropdown(bundleId: string, currentCategory: AppCategory) {
    const suggestion = categorySuggestions[bundleId]
    return (
      <div
        ref={dropdownRef}
        style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          zIndex: 50, borderRadius: 8, padding: '4px 0', minWidth: 160,
          background: 'var(--color-surface-card)', border: '1px solid var(--color-border-ghost)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {currentCategory === 'uncategorized' && suggestion?.suggestedCategory && (
          <div style={{ padding: '6px 12px 8px' }}>
            <button
              onClick={(e) => { e.stopPropagation(); void handleSetOverride(bundleId, suggestion.suggestedCategory!) }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '8px 10px', borderRadius: 8, border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-high)', cursor: 'pointer', textAlign: 'left',
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
          const color = catColor(category)
          const active = category === currentCategory
          return (
            <button
              key={category}
              onClick={(e) => { e.stopPropagation(); void handleSetOverride(bundleId, category) }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
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
            onClick={(e) => { e.stopPropagation(); void handleClearOverride(bundleId) }}
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

  const filtered = selectedCat ? visibleSummaries.filter((s) => s.category === selectedCat) : visibleSummaries

  // Keyboard navigation for apps list
  const [highlightedAppIdx, setHighlightedAppIdx] = useState<number | null>(null)

  const selectHighlightedApp = useCallback(() => {
    if (highlightedAppIdx !== null && filtered[highlightedAppIdx]) {
      setSelectedApp(filtered[highlightedAppIdx])
    }
  }, [highlightedAppIdx, filtered])

  useKeyboardNav([
    { key: 'Escape', action: () => { setHighlightedAppIdx(null) }, global: true },
    { key: 'ArrowUp', action: () => {
      if (filtered.length === 0) return
      setHighlightedAppIdx((cur) => cur === null || cur <= 0 ? filtered.length - 1 : cur - 1)
    }},
    { key: 'ArrowDown', action: () => {
      if (filtered.length === 0) return
      setHighlightedAppIdx((cur) => cur === null ? 0 : cur >= filtered.length - 1 ? 0 : cur + 1)
    }},
    { key: 'Enter', action: selectHighlightedApp },
  ], [filtered, highlightedAppIdx, selectHighlightedApp])

  // Category breakdown for filter chips
  const catMap = new Map<AppCategory, number>()
  for (const s of visibleSummaries) catMap.set(s.category, (catMap.get(s.category) ?? 0) + s.totalSeconds)
  const catBreakdown = [...catMap.entries()].sort((a, b) => b[1] - a[1]).map(([cat, secs]) => ({ cat, secs }))

  // Group apps by category when count > 8 and no category filter active
  const shouldGroup = !selectedCat && filtered.length > 8
  const groupedApps = shouldGroup
    ? (() => {
        const groups = new Map<AppCategory, AppUsageSummary[]>()
        for (const app of filtered) {
          const list = groups.get(app.category) ?? []
          list.push(app)
          groups.set(app.category, list)
        }
        // Sort groups by total time descending
        return [...groups.entries()]
          .map(([cat, apps]) => ({ cat, apps, totalSeconds: apps.reduce((s, a) => s + a.totalSeconds, 0) }))
          .sort((a, b) => b.totalSeconds - a.totalSeconds)
      })()
    : null

  if (selectedApp) {
    const selectedSummary =
      live && live.bundleId === selectedApp.bundleId
        ? (mergeLiveSummary([selectedApp], live, days).find((s) => s.bundleId === selectedApp.bundleId) ?? selectedApp)
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

  function renderAppRow(app: AppUsageSummary, flatIndex: number, showBorder: boolean) {
    const color = catColor(app.category)
    const displayName = formatDisplayAppName(app.appName)
    const sc = app.sessionCount ?? 1
    const avgSec = sc > 0 ? Math.round(app.totalSeconds / sc) : 0
    const suggestion = categorySuggestions[app.bundleId]
    const ch = characters[app.bundleId]
    const isLive = live?.bundleId === app.bundleId
    const effectiveCat = (app.category === 'uncategorized' && suggestion?.suggestedCategory)
      ? suggestion.suggestedCategory : app.category
    const charSummary = buildCharacterSummary(app.appName, effectiveCat, ch ?? null, sc, avgSec)
    const isHighlighted = highlightedAppIdx === flatIndex

    return (
      <div
        key={app.bundleId}
        onClick={() => setSelectedApp(app)}
        data-app-idx={flatIndex}
        style={{
          display: 'flex', alignItems: 'center', gap: 13,
          padding: '11px 18px',
          cursor: 'pointer',
          borderBottom: showBorder ? '1px solid var(--color-border-ghost)' : 'none',
          borderLeft: isLive ? '3px solid #4ade80' : '3px solid transparent',
          background: isHighlighted ? 'var(--color-surface-low)' : undefined,
          outline: isHighlighted ? '1px solid var(--color-border-ghost)' : 'none',
          outlineOffset: -1,
          transition: 'background 120ms',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-low)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = isHighlighted ? 'var(--color-surface-low)' : 'transparent')}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'var(--color-surface-highest)',
          border: '1px solid var(--color-border-ghost)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <AppIcon bundleId={app.bundleId} appName={app.appName} color={color} size={26} fontSize={10} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </span>
            {isLive && (
              <span style={{ fontSize: 8.5, fontWeight: 700, color: '#4ade80', letterSpacing: '0.05em', flexShrink: 0 }}>
                live
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 1 }}>
            {charSummary}
          </div>
          {!shouldGroup && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 4, height: 4, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); setOpenDropdown(openDropdown === app.bundleId ? null : app.bundleId) }}
                  title="Change category"
                  style={{
                    fontSize: 10.5, background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--color-text-tertiary)',
                    padding: 0, display: 'flex', alignItems: 'center', gap: 3,
                  }}
                >
                  {formatCategory(effectiveCat)}
                  <svg width="7" height="7" viewBox="0 0 8 8" fill="none" style={{ opacity: 0.3 }}>
                    <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {openDropdown === app.bundleId && renderCategoryDropdown(app.bundleId, app.category)}
              </div>
            </div>
          )}
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {formatDuration(app.totalSeconds)}
        </span>
      </div>
    )
  }

  return (
    <div style={{ padding: '28px 36px', overflowY: 'auto', height: '100%' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--color-text-primary)', margin: '0 0 2px', letterSpacing: '-0.02em', lineHeight: 1 }}>
            Apps
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', margin: 0 }}>
            How you use each tool{days === 1 ? ' today' : `, last ${days} days`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--color-surface-low)', borderRadius: 10, padding: 3 }}>
          {DAYS_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setDays(opt)}
              style={{
                padding: '5px 13px', borderRadius: 7, fontSize: 12,
                fontWeight: days === opt ? 700 : 500, border: 'none', cursor: 'pointer',
                background: days === opt ? 'var(--gradient-primary)' : 'transparent',
                color: days === opt ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                transition: 'all 120ms',
              }}
            >
              {opt === 1 ? 'Today' : `${opt}d`}
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
          <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 6px' }}>No app activity yet</p>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>Open some apps and come back.</p>
        </div>
      ) : (
        <>
          {/* Category filter chips */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto', paddingBottom: 2 }}>
            <FilterChip label="All" active={!selectedCat} color="var(--color-text-secondary)" onClick={() => setSelectedCat(null)} />
            {catBreakdown.slice(0, 8).map(({ cat }) => (
              <FilterChip
                key={cat}
                label={formatCategory(cat)}
                active={selectedCat === cat}
                color={catColor(cat)}
                onClick={() => setSelectedCat(selectedCat === cat ? null : cat)}
              />
            ))}
          </div>

          {/* App list */}
          {filtered.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '40px 0', margin: 0 }}>
              No apps in this category for the selected period.
            </p>
          ) : shouldGroup && groupedApps ? (
            /* Grouped view: category headers + app rows */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {groupedApps.map(({ cat, apps: groupApps }) => (
                <div key={cat}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px', marginBottom: 6,
                  }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: catColor(cat) }} />
                    <span style={{
                      fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em',
                      color: 'var(--color-text-tertiary)',
                    }}>
                      {formatCategory(cat)}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', opacity: 0.5 }}>
                      {formatDuration(groupApps.reduce((s, a) => s + a.totalSeconds, 0))}
                    </span>
                  </div>
                  <div style={{
                    display: 'flex', flexDirection: 'column',
                    background: 'var(--color-surface-container)',
                    border: '1px solid var(--color-border-ghost)',
                    borderRadius: 12, overflow: 'hidden',
                  }}>
                    {groupApps.map((app, idx) => renderAppRow(app, filtered.indexOf(app), idx < groupApps.length - 1))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Flat list */
            <div style={{
              display: 'flex', flexDirection: 'column',
              background: 'var(--color-surface-container)',
              border: '1px solid var(--color-border-ghost)',
              borderRadius: 12, overflow: 'hidden',
            }}>
              {filtered.map((app, index) => renderAppRow(app, index, index < filtered.length - 1))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 12px', borderRadius: 999, fontSize: 11, fontWeight: active ? 700 : 500,
        border: active ? `1px solid ${withAlpha(color, 0.3)}` : '1px solid var(--color-border-ghost)',
        background: active ? withAlpha(color, 0.12) : 'var(--color-surface-low)',
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        cursor: 'pointer', flexShrink: 0, transition: 'all 120ms',
      }}
    >
      {label}
    </button>
  )
}

// ─── App Detail Panel ─────────────────────────────────────────────────────────

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
  const [detail, setDetail] = useState<AppDetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  // Escape to go back
  useKeyboardNav([
    { key: 'Escape', action: onBack, global: true },
  ], [onBack])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    async function refresh() {
      try {
        const payload = await ipc.db.getAppDetail(app.canonicalAppId ?? app.bundleId, days)
        if (cancelled) return
        setDetail(payload)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setDetail(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [app.bundleId, app.canonicalAppId, days, refreshNonce])

  const color = catColor(app.category)
  const displayName = detail?.displayName ?? formatDisplayAppName(app.appName)
  const detailCharacter = detail?.appCharacter ?? null
  const pairedApps = detail?.pairedApps ?? []
  const timeOfDayDistribution = detail?.timeOfDayDistribution ?? []
  const topTimeOfDay = [...timeOfDayDistribution]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .filter((entry) => entry.totalSeconds > 0)
    .slice(0, 2)
  const artifactItems = (() => {
    const seen = new Set<string>()
    const items: ArtifactRef[] = []
    for (const item of [...(detail?.topPages ?? []), ...(detail?.topArtifacts ?? [])]) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
    return items.slice(0, 10)
  })()

  function artifactSubtitle(artifact: ArtifactRef): string {
    if (artifact.artifactType === 'page' || artifact.artifactType === 'domain') {
      const parts = [artifact.host, artifact.subtitle].filter(Boolean)
      return parts.join(' · ')
    }
    return artifact.subtitle ?? artifact.path ?? artifact.host ?? artifact.artifactType
  }

  function openArtifact(artifact: ArtifactRef) {
    if (artifact.openTarget.kind === 'external_url' && artifact.openTarget.value) {
      window.daylens.shell.openExternal(artifact.openTarget.value)
    } else if (artifact.url) {
      window.daylens.shell.openExternal(artifact.url)
    }
  }

  const sectionHeading = (label: string) => (
    <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
      {label}
    </div>
  )

  return (
    <div style={{ overflowY: 'auto', height: '100%', padding: '28px 36px 64px' }}>

      {/* Back */}
      <button
        onClick={onBack}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)',
          background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 20px', marginBottom: 4,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-secondary)')}
      >
        ← Apps
      </button>

      {/* App header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, flexShrink: 0,
          background: 'var(--color-surface-highest)', border: '1px solid var(--color-border-ghost)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <AppIcon bundleId={app.bundleId} appName={app.appName} color={color} size={40} fontSize={14} />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)', margin: '0 0 6px', letterSpacing: '-0.02em' }}>
            {displayName}
          </h1>
          <span style={{
            display: 'inline-block', padding: '2px 9px', borderRadius: 999,
            background: withAlpha(color, 0.14), color, fontWeight: 700,
            fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em',
          }}>
            {formatCategory(app.category)}
          </span>
        </div>
        {/* Range tabs */}
        <div style={{ display: 'flex', gap: 2, background: 'var(--color-surface-low)', borderRadius: 10, padding: 3, flexShrink: 0 }}>
          {DAYS_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => onDaysChange(opt)}
              style={{
                padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: days === opt ? 700 : 500,
                border: 'none', cursor: 'pointer',
                background: days === opt ? 'var(--gradient-primary)' : 'transparent',
                color: days === opt ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
                transition: 'all 120ms',
              }}
            >
              {opt === 1 ? 'Today' : `${opt}d`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[80, 120, 160].map((h, i) => (
            <div key={i} style={{ height: h, borderRadius: 12, background: 'var(--color-surface-container)', opacity: 0.4 }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '56px 0', gap: 12, textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: '#f87171', margin: 0 }}>Failed to load app detail: {error}</p>
          <button
            onClick={() => { setLoading(true); setError(null); setRefreshNonce((value) => value + 1) }}
            style={{ padding: '8px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', background: 'var(--color-primary)', color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 700 }}
          >
            Retry
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Character summary */}
          <div style={{
            padding: '18px 20px', borderRadius: 12,
            background: 'var(--color-surface-container)', border: '1px solid var(--color-border-ghost)',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {formatDuration(detail?.totalSeconds ?? app.totalSeconds)}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                {days === 1 ? 'today' : `last ${days} days`}
                {detailCharacter?.label ? ` · ${detailCharacter.label.toLowerCase()}` : ''}
                {pairedApps[0] ? ` · usually paired with ${pairedApps[0].displayName}` : ''}
              </span>
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--color-text-secondary)', margin: 0 }}>
              {buildCharacterSummary(
                detail?.displayName ?? app.appName,
                app.category,
                detailCharacter,
                detail?.sessionCount ?? (app.sessionCount ?? 0),
                detail && detail.sessionCount > 0 ? Math.round(detail.totalSeconds / detail.sessionCount) : Math.round(app.totalSeconds / Math.max(1, app.sessionCount ?? 1)),
              )}
            </p>
          </div>

          {/* Key artifacts */}
          {artifactItems.length > 0 && (
            <div style={{
              padding: '18px 20px', borderRadius: 12,
              background: 'var(--color-surface-container)', border: '1px solid var(--color-border-ghost)',
            }}>
              {sectionHeading('Key Artifacts')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {artifactItems.map((artifact) => {
                  const isLinkable = artifact.openTarget.kind === 'external_url' || !!artifact.url
                  return (
                    <div
                      key={artifact.id}
                      onClick={isLinkable ? () => openArtifact(artifact) : undefined}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '7px 8px', borderRadius: 7,
                        cursor: isLinkable ? 'pointer' : 'default',
                        transition: 'background 100ms',
                      }}
                      onMouseEnter={(e) => { if (isLinkable) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-surface-low)' }}
                      onMouseLeave={(e) => { if (isLinkable) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13, fontWeight: 600,
                          color: isLinkable ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {artifact.displayTitle}
                        </div>
                        {artifactSubtitle(artifact) && (
                          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '90%' }}>
                            {artifactSubtitle(artifact)}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>{formatDuration(artifact.totalSeconds)}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{formatCategory(app.category)}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Appears in work blocks */}
          {detail && detail.blockAppearances.length > 0 && (
            <div style={{
              padding: '18px 20px', borderRadius: 12,
              background: 'var(--color-surface-container)', border: '1px solid var(--color-border-ghost)',
            }}>
              {sectionHeading('Appears In')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {detail.blockAppearances.map((wb) => {
                  const dateStr = new Date(wb.startTime)
                  const y = dateStr.getFullYear()
                  const m = String(dateStr.getMonth() + 1).padStart(2, '0')
                  const d = String(dateStr.getDate()).padStart(2, '0')
                  const timelineDate = `${y}-${m}-${d}`
                  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(wb.startTime))
                  const timeLabel = `${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(wb.startTime)}–${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(wb.endTime)}`
                  return (
                    <div
                      key={wb.blockId}
                      onClick={() => { window.location.hash = `#/timeline?view=day&date=${timelineDate}&block=${wb.blockId}` }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '7px 8px', borderRadius: 7,
                        cursor: 'pointer', transition: 'background 100ms',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-low)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {wb.label}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
                          {dateLabel} · {timeLabel}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
                        {formatDuration(Math.round((wb.endTime - wb.startTime) / 1000))}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Patterns */}
          {detail && (
            <div style={{
              padding: '18px 20px', borderRadius: 12,
              background: 'var(--color-surface-container)', border: '1px solid var(--color-border-ghost)',
            }}>
              {sectionHeading('Patterns')}
              <div style={{ display: 'grid', gap: 10 }}>
                {/* Time of day with hour specificity */}
                {topTimeOfDay.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                      Most active hours
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {topTimeOfDay.map((entry) => {
                        const hourLabel = entry.hour === 0 ? '12am' : entry.hour < 12 ? `${entry.hour}am` : entry.hour === 12 ? '12pm' : `${entry.hour - 12}pm`
                        const nextHour = (entry.hour + 1) % 24
                        const nextLabel = nextHour === 0 ? '12am' : nextHour < 12 ? `${nextHour}am` : nextHour === 12 ? '12pm' : `${nextHour - 12}pm`
                        return (
                          <span key={entry.hour} style={{
                            fontSize: 12, color: 'var(--color-text-secondary)',
                            padding: '3px 10px', borderRadius: 6,
                            background: 'var(--color-surface-low)',
                          }}>
                            {hourLabel}–{nextLabel}: {formatDuration(entry.totalSeconds)}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Paired apps — shows which other tools are used alongside */}
                {pairedApps.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                      Often used alongside
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {pairedApps.slice(0, 4).map((entry) => (
                        <span key={entry.canonicalAppId} style={{
                          fontSize: 12, color: 'var(--color-text-secondary)',
                          padding: '3px 10px', borderRadius: 6,
                          background: 'var(--color-surface-low)',
                        }}>
                          {entry.displayName}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Workflow appearance */}
                {detail.workflowAppearances.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                      Part of workflow
                    </div>
                    <p style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', margin: 0 }}>
                      {detail.workflowAppearances[0].label}
                    </p>
                  </div>
                )}

                {/* Session stats */}
                {detail.sessionCount > 0 && (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 2 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>{detail.sessionCount}</span> sessions
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                      avg <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                        {formatDuration(Math.round(detail.totalSeconds / detail.sessionCount))}
                      </span> each
                    </div>
                    {detailCharacter?.label && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                        character: <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                          {detailCharacter.label.toLowerCase()}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ height: 28, width: 72, borderRadius: 999, background: 'var(--color-surface-container)', opacity: 0.5 }} />
        ))}
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ height: 52, borderRadius: 12, background: 'var(--color-surface-container)', opacity: 0.4 }} />
      ))}
    </div>
  )
}
