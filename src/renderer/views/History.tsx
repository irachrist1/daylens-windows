import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, formatTime, formatFullDate, percentOf, todayString } from '../lib/format'
import { catColor, formatCategory } from '../lib/category'
import type { AppSession, AppCategory } from '@shared/types'

function isPresentationNoise(session: AppSession): boolean {
  return (session.category === 'system' || session.category === 'uncategorized') &&
    session.durationSeconds < 120
}

// Shift a YYYY-MM-DD string by ±N days using local date components (timezone-safe)
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
// Consecutive sessions from the same app with a gap ≤ GAP_MS are merged into
// one visual row. This collapses repeated rapid app-switches (e.g. alt-tab back
// and forth) into a single meaningful entry without destroying time information.

const GAP_MS = 60_000 // 1 minute — merge if gap between sessions is ≤ this

interface SessionGroup {
  bundleId: string
  appName: string
  category: AppCategory
  isFocused: boolean
  firstStart: number
  lastEnd: number
  totalSeconds: number
  count: number         // number of raw sessions merged into this group
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

  // Drop any group whose total is still negligible (edge case: sessions near the
  // MIN_DISPLAY_SEC boundary that slipped through before grouping).
  return groups.filter((g) => g.totalSeconds >= 15)
}

export default function History() {
  const [date, setDate] = useState(todayString())
  const [sessions, setSessions] = useState<AppSession[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    ipc.db.getHistory(date).then((data) => {
      setSessions(data as AppSession[])
      setLoading(false)
    })
  }, [date])

  const groups    = groupSessions(sessions)
  const totalSec  = groups.reduce((n, g) => n + g.totalSeconds, 0)
  const focusSec  = groups.filter((g) => g.isFocused).reduce((n, g) => n + g.totalSeconds, 0)
  const focusPct  = percentOf(focusSec, totalSec)
  const isToday   = date === todayString()
  const uniqueApps = new Set(groups.map((g) => g.bundleId)).size
  // Time range of the day: first session start → last session end
  const firstStart = groups[0]?.firstStart ?? null
  const lastEnd    = groups[groups.length - 1]?.lastEnd ?? null

  // Top category by time spent (across groups)
  const catTotals = new Map<string, number>()
  for (const g of groups) {
    catTotals.set(g.category, (catTotals.get(g.category) ?? 0) + g.totalSeconds)
  }
  const topCat = groups.length > 0
    ? ([...catTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
    : null

  // Category breakdown from groups (for proportion bar)
  const catMap = new Map<string, number>()
  for (const g of groups) {
    catMap.set(g.category, (catMap.get(g.category) ?? 0) + g.totalSeconds)
  }
  const sortedCats = [...catMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, totalSeconds]) => ({ category, totalSeconds }))

  return (
    <div className="p-7 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <p className="section-label mb-1">History</p>
          {groups.length > 0 ? (
            <>
              <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight">
                {formatFullDate(date)}
              </h1>
              <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                {firstStart && lastEnd
                  ? `${formatTime(firstStart)} – ${formatTime(lastEnd)} · `
                  : ''}
                {formatDuration(totalSec)} active · {groups.length} blocks · {uniqueApps} apps
              </p>
            </>
          ) : (
            <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight">
              Browse past days
            </h1>
          )}
        </div>

        {/* Date navigation: ‹ [date input] › [Today] */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDate(shiftDate(date, -1))}
            className="w-7 h-7 rounded-md flex items-center justify-center text-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-high)] transition-colors"
          >
            ‹
          </button>
          <input
            type="date"
            value={date}
            max={todayString()}
            onChange={(e) => setDate(e.target.value)}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-card)] text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] transition-colors"
          />
          <button
            onClick={() => setDate(shiftDate(date, 1))}
            disabled={isToday}
            className="w-7 h-7 rounded-md flex items-center justify-center text-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-high)] transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            ›
          </button>
          {!isToday && (
            <button
              onClick={() => setDate(todayString())}
              className="ml-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-high)] transition-colors"
            >
              Today
            </button>
          )}
        </div>
      </div>

      {/* Day summary section — shown when groups exist */}
      {!loading && groups.length > 0 && (
        <div className="card mb-5">
          {/* Stat pills */}
          <div className="flex flex-wrap gap-2 mb-4">
            {focusSec > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] bg-[var(--color-surface-high)]">
                <span style={{ color: 'var(--color-accent)' }}>⚡</span>
                <span className="text-[var(--color-text-secondary)]">
                  {formatDuration(focusSec)} focus · {focusPct}%
                </span>
              </div>
            )}
            {topCat && (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px]"
                style={{
                  background:  catColor(topCat) + '15',
                  color:       catColor(topCat),
                }}
              >
                <span>▸</span>
                <span>{formatCategory(topCat)}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] bg-[var(--color-surface-high)]">
              <span className="text-[var(--color-text-tertiary)]">⊞</span>
              <span className="text-[var(--color-text-secondary)]">
                {[...catMap.keys()].length} categories · {uniqueApps} apps
              </span>
            </div>
          </div>

          {/* Proportional bar */}
          <div className="flex h-[6px] rounded-full overflow-hidden gap-px mb-2.5">
            {sortedCats.slice(0, 8).map((c) => (
              <div
                key={c.category}
                title={`${c.category} · ${formatDuration(c.totalSeconds)}`}
                style={{
                  width:      `${percentOf(c.totalSeconds, totalSec)}%`,
                  background: catColor(c.category),
                  minWidth:   3,
                }}
              />
            ))}
          </div>

          {/* Compact legend */}
          <div className="flex flex-wrap gap-1.5">
            {sortedCats.slice(0, 6).map((c) => {
              const col = catColor(c.category)
              return (
                <div
                  key={c.category}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded"
                  style={{ background: col + '15' }}
                >
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: col }} />
                  <span className="text-[10px] font-medium" style={{ color: col }}>
                    {formatCategory(c.category)}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">
                    {formatDuration(c.totalSeconds)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-px overflow-hidden rounded-xl border border-[var(--color-border)]">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-12 bg-[var(--color-surface-card)] animate-pulse" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-12 text-center">
          <p className="text-[14px] font-medium text-[var(--color-text-primary)] mb-1">No sessions</p>
          <p className="text-[13px] text-[var(--color-text-secondary)]">No activity recorded for this date.</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          {groups.map((g, i) => {
            const color    = catColor(g.category)
            const initials = g.appName.slice(0, 2).toUpperCase()
            return (
              <div
                key={`${g.bundleId}-${g.firstStart}`}
                className={[
                  'flex items-center gap-3 px-4 py-3.5 hover:bg-[var(--color-surface-high)] transition-colors',
                  i < groups.length - 1 ? 'border-b border-[var(--color-border)]' : '',
                ].join(' ')}
              >
                {/* Timestamp */}
                <span className="text-[11px] text-[var(--color-text-tertiary)] w-[68px] shrink-0 tabular-nums">
                  {formatTime(g.firstStart)}
                </span>

                {/* Category-colored initials icon */}
                <div
                  className="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0"
                  style={{ background: color + '22', color }}
                >
                  {initials}
                </div>

                {/* App name + subtitle */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0 mb-1">
                    <p className="text-[13px] text-[var(--color-text-primary)] truncate leading-none">
                      {g.appName}
                    </p>
                    <span
                      className="text-[9px] font-semibold tracking-[0.4px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: color + '1a', color }}
                    >
                      {formatCategory(g.category)}
                    </span>
                    {g.count > 1 && (
                      <span className="text-[9px] text-[var(--color-text-tertiary)] px-1.5 py-0.5 rounded shrink-0 bg-[var(--color-surface-high)]">
                        ×{g.count}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--color-text-tertiary)] tabular-nums">
                    {formatTime(g.firstStart)} – {formatTime(g.lastEnd)}
                  </p>
                </div>

                {/* Duration */}
                <span className="text-[12px] text-[var(--color-text-secondary)] shrink-0 tabular-nums">
                  {formatDuration(g.totalSeconds)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
