import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, formatTime, formatDateShort, percentOf, rollingDayBounds } from '../lib/format'
import { catColor, formatCategory } from '../lib/category'
import type { AppUsageSummary, AppSession, AppCategory, LiveSession } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

const DAYS_OPTIONS = [1, 7, 30] as const

// ─── Category breakdown helpers ───────────────────────────────────────────────

interface CatSummary { category: AppCategory; totalSeconds: number }

function buildCatBreakdown(summaries: AppUsageSummary[]): CatSummary[] {
  const map = new Map<AppCategory, number>()
  for (const a of summaries) {
    map.set(a.category, (map.get(a.category) ?? 0) + a.totalSeconds)
  }
  return [...map.entries()]
    .map(([category, totalSeconds]) => ({ category, totalSeconds }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
}

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
    )
      .sort((a, b) => b.totalSeconds - a.totalSeconds)
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
  ]
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function Apps() {
  const [days, setDays]               = useState<(typeof DAYS_OPTIONS)[number]>(7)
  const [summaries, setSummaries]     = useState<AppUsageSummary[]>([])
  const [live, setLive]               = useState<LiveSession | null>(null)
  const [loading, setLoading]         = useState(true)
  const [selectedCat, setSelectedCat] = useState<AppCategory | null>(null)
  const [selectedApp, setSelectedApp] = useState<AppUsageSummary | null>(null)

  useEffect(() => {
    setLoading(true)
    setSelectedCat(null)
    setSelectedApp(null)

    let cancelled = false

    async function refresh() {
      const [summaryData, liveData] = await Promise.all([
        ipc.db.getAppSummaries(days),
        ipc.tracking.getLiveSession(),
      ])
      if (cancelled) return
      setSummaries(summaryData as AppUsageSummary[])
      setLive(liveData as LiveSession | null)
      setLoading(false)
    }

    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [days])

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
      />
    )
  }

  const mergedSummaries = mergeLiveSummary(summaries, live, days)
  const visibleSummaries = mergedSummaries.filter(
    (summary) => !isPresentationNoise(summary.category, summary.totalSeconds),
  )

  const totalSec     = mergedSummaries.reduce((s, a) => s + a.totalSeconds, 0)
  const focusSec     = visibleSummaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
  const focusPct     = percentOf(focusSec, totalSec)
  const catBreakdown = buildCatBreakdown(visibleSummaries)

  const filtered = selectedCat
    ? visibleSummaries.filter((a) => a.category === selectedCat)
    : visibleSummaries
  const maxSec   = filtered[0]?.totalSeconds ?? 1

  return (
    <div className="p-7 max-w-3xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <p className="section-label mb-1">Apps</p>
          <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight">
            Usage breakdown
          </h1>
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-card)] border border-[var(--color-border)]">
          {DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={[
                'px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors',
                days === d
                  ? 'bg-[var(--color-surface-high)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              ].join(' ')}
            >
              {d === 1 ? 'Today' : `${d}d`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : summaries.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-12 text-center">
          <p className="text-[14px] font-medium text-[var(--color-text-primary)] mb-1">No data</p>
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            No app usage recorded for this period.
          </p>
        </div>
      ) : (
        <>
          {/* ── Summary stat chips ─────────────────────────────────────── */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <StatChip label="Screen time" value={formatDuration(totalSec)} />
            <StatChip label="Focus time"  value={formatDuration(focusSec)} accent />
            <StatChip label="Focus share" value={`${focusPct}%`} />
            <StatChip label="Apps" value={`${visibleSummaries.length}`} />
          </div>

          {/* ── Category breakdown bar ─────────────────────────────────── */}
          <div className="card mb-4">
            <p className="section-label mb-3">Category Breakdown</p>

            {/* Proportional bar */}
            <div className="flex h-[8px] rounded-full overflow-hidden gap-px mb-3">
              {catBreakdown.slice(0, 8).map((c) => (
                <div
                  key={c.category}
                  title={`${c.category} · ${formatDuration(c.totalSeconds)}`}
                  onClick={() => setSelectedCat(selectedCat === c.category ? null : c.category)}
                  style={{
                    width:      `${percentOf(c.totalSeconds, totalSec)}%`,
                    background: catColor(c.category),
                    minWidth:   3,
                    cursor:     'pointer',
                    opacity:    selectedCat && selectedCat !== c.category ? 0.35 : 1,
                    transition: 'opacity 0.15s',
                  }}
                />
              ))}
            </div>

            {/* Legend chips — also act as filter pills */}
            <div className="flex flex-wrap gap-1.5">
              {catBreakdown.slice(0, 8).map((c) => {
                const col    = catColor(c.category)
                const active = selectedCat === c.category
                return (
                  <button
                    key={c.category}
                    onClick={() => setSelectedCat(active ? null : c.category)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-full transition-opacity"
                    style={{
                      background: col + (active ? '2a' : '1a'),
                      border:     `1px solid ${col}${active ? '60' : '00'}`,
                      opacity:    selectedCat && !active ? 0.5 : 1,
                    }}
                  >
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: col }} />
                    <span className="text-[11px] font-medium" style={{ color: col }}>
                      {formatCategory(c.category)}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-tertiary)]">
                      {formatDuration(c.totalSeconds)}
                    </span>
                  </button>
                )
              })}
              {selectedCat && (
                <button
                  onClick={() => setSelectedCat(null)}
                  className="text-[11px] text-[var(--color-text-tertiary)] px-2 py-1 hover:text-[var(--color-text-secondary)] transition-colors"
                >
                  clear ×
                </button>
              )}
            </div>
          </div>

          {/* ── App list ───────────────────────────────────────────────── */}
          <div className="card p-0 overflow-hidden">
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
                No apps in this category for the selected period.
              </p>
            ) : (
              filtered.map((app, i) => {
                const pct    = totalSec > 0 ? Math.round((app.totalSeconds / totalSec) * 100) : 0
                const barW   = maxSec > 0 ? (app.totalSeconds / maxSec) * 100 : 0
                const color  = catColor(app.category)
                const isFocused = FOCUSED_CATEGORIES.includes(app.category)
                return (
                  <button
                    key={app.bundleId}
                    onClick={() => setSelectedApp(app)}
                    className={[
                      'w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-[var(--color-surface-high)] transition-colors',
                      i < filtered.length - 1 ? 'border-b border-[var(--color-border)]' : '',
                    ].join(' ')}
                  >
                    {/* Rank + icon */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-[var(--color-text-tertiary)] w-4 text-right tabular-nums">
                        {i + 1}
                      </span>
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold"
                        style={{ background: color + '22', color }}
                      >
                        {app.appName.slice(0, 2).toUpperCase()}
                      </div>
                    </div>

                    {/* Name, category, session count, bar */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <p className="text-[13px] text-[var(--color-text-primary)] truncate leading-none">
                          {app.appName}
                        </p>
                        <span
                          className="text-[9px] font-semibold tracking-[0.4px] px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: color + '1a', color }}
                        >
                          {formatCategory(app.category)}
                        </span>
                        {isFocused && (
                          <span
                            className="text-[9px] font-semibold px-1 py-0.5 rounded shrink-0"
                            style={{ background: 'rgba(180,197,255,0.12)', color: 'var(--color-accent)' }}
                          >
                            ⚡
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-[3px] rounded-full overflow-hidden bg-[var(--color-surface-high)]">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${barW}%`, background: color }}
                          />
                        </div>
                        {app.sessionCount != null && (
                          <span className="text-[10px] text-[var(--color-text-tertiary)] shrink-0 tabular-nums">
                            {app.sessionCount} {app.sessionCount === 1 ? 'session' : 'sessions'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Duration */}
                    <span className="text-[12px] text-[var(--color-text-secondary)] shrink-0 tabular-nums">
                      {formatDuration(app.totalSeconds)}
                    </span>

                    {/* Percentage */}
                    <span className="text-[11px] text-[var(--color-text-tertiary)] w-9 text-right shrink-0 tabular-nums">
                      {pct}%
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─── App detail panel ─────────────────────────────────────────────────────────

function AppDetailPanel({
  app, days, onBack,
}: {
  app: AppUsageSummary
  days: number
  onBack: () => void
}) {
  const [sessions, setSessions] = useState<AppSession[]>([])
  const [loading, setLoading]   = useState(true)
  const [live, setLive]         = useState<LiveSession | null>(null)

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

  const color = catColor(app.category)
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

  // avgSec: computed from the clipped session rows returned for the selected range.
  const sessionTotalSec = detailSessions.reduce((s, x) => s + x.durationSeconds, 0)
  const avgSec          = detailSessions.length > 0 ? Math.round(sessionTotalSec / detailSessions.length) : 0
  // longestSec: exact — max single session duration from returned rows
  const longestSec      = detailSessions.reduce((m, s) => Math.max(m, s.durationSeconds), 0)
  const latestSession = detailSessions[0] ?? null

  return (
    <div className="p-7 max-w-3xl mx-auto">

      {/* ── Back + header ──────────────────────────────────────────────── */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors mb-5"
      >
        ← All Apps
      </button>

      <div className="flex items-center gap-3 mb-5">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center text-[13px] font-bold shrink-0"
          style={{ background: color + '22', color }}
        >
          {app.appName.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)] tracking-tight leading-none mb-0.5">
            {app.appName}
          </h1>
          <span
            className="text-[10px] font-semibold tracking-[0.4px] px-2 py-0.5 rounded"
            style={{ background: color + '1a', color }}
          >
            {formatCategory(app.category)}
          </span>
        </div>
      </div>

      {/* ── Stats row ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-2 mb-5">
        <MiniStat label="Total time"  value={formatDuration(app.totalSeconds)} />
        <MiniStat label="Sessions"    value={`${detailSessions.length}`} />
        <MiniStat label="Avg session" value={avgSec > 0 ? formatDuration(avgSec) : '—'} />
        <MiniStat label="Longest"     value={longestSec > 0 ? formatDuration(longestSec) : '—'} />
      </div>

      <div className="card mb-5">
        <p className="section-label mb-2">Detail</p>
        <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed">
          {days === 1 ? 'Today' : `Within the last ${days} days`}, this panel is showing{' '}
          <span className="text-[var(--color-text-primary)] font-medium">
            {formatDuration(sessionTotalSec)}
          </span>{' '}
          of clipped {app.appName} activity across {detailSessions.length}{' '}
          {detailSessions.length === 1 ? 'session' : 'sessions'}.
          {latestSession && (
            <>
              {' '}Latest activity was at{' '}
              <span className="text-[var(--color-text-primary)] font-medium">
                {formatTime(latestSession.startTime)}
              </span>.
            </>
          )}
        </p>
      </div>

      {/* ── Recent sessions ────────────────────────────────────────────── */}
      <div className="card p-0 overflow-hidden">
        <p className="section-label px-4 pt-4 pb-3">Recent Sessions</p>
        {loading ? (
          <div className="px-4 pb-4 flex flex-col gap-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-12 rounded-lg animate-pulse bg-[var(--color-surface-high)]" />
            ))}
          </div>
        ) : detailSessions.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-[var(--color-text-tertiary)]">No sessions recorded.</p>
        ) : (
          detailSessions.map((s, i) => (
            <div
              key={s.id}
              className={[
                'flex items-center gap-3 px-4 py-3',
                i < detailSessions.length - 1 ? 'border-b border-[var(--color-border)]' : '',
              ].join(' ')}
            >
              <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                {/* Date badge — only shown in multi-day view (7d / 30d) */}
                {days > 1 && (
                  <span className="text-[10px] text-[var(--color-text-tertiary)] shrink-0 tabular-nums px-2 py-0.5 rounded-full bg-[var(--color-surface-high)]">
                    {formatDateShort(s.startTime)}
                  </span>
                )}
                <span className="text-[12px] text-[var(--color-text-primary)] tabular-nums">
                  {formatTime(s.startTime)}
                  {s.endTime ? ` – ${formatTime(s.endTime)}` : ''}
                </span>
                {s.id === -1 && (
                  <span
                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={{ background: 'var(--color-icon-tint)', color: 'var(--color-accent)' }}
                  >
                    live
                  </span>
                )}
              </div>
              <span className="text-[12px] text-[var(--color-text-secondary)] tabular-nums shrink-0">
                {formatDuration(s.durationSeconds)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Mini stat ────────────────────────────────────────────────────────────────

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex flex-col gap-1 p-3 rounded-xl"
      style={{ background: 'var(--color-surface-card)', border: '1px solid var(--color-border)' }}
    >
      <span className="text-[16px] font-semibold text-[var(--color-text-primary)] tabular-nums leading-none">
        {value}
      </span>
      <span className="text-[10px] text-[var(--color-text-tertiary)] uppercase tracking-[0.4px]">
        {label}
      </span>
    </div>
  )
}

// ─── Stat chip ────────────────────────────────────────────────────────────────

function StatChip({
  label, value, accent,
}: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg"
      style={{ background: 'var(--color-surface-card)', border: '1px solid var(--color-border)' }}
    >
      <span
        className="text-[13px] font-semibold tabular-nums"
        style={{ color: accent ? 'var(--color-accent)' : 'var(--color-text-primary)' }}
      >
        {value}
      </span>
      <span className="text-[11px] text-[var(--color-text-tertiary)]">{label}</span>
    </div>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 w-28 rounded-lg animate-pulse bg-[var(--color-surface-card)]" />
        ))}
      </div>
      <div className="h-20 rounded-xl animate-pulse bg-[var(--color-surface-card)]" />
      <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-[var(--color-border)]">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-14 bg-[var(--color-surface-card)] animate-pulse" />
        ))}
      </div>
    </div>
  )
}
