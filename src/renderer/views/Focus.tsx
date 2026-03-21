import { useEffect, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { dateStringFromMs, formatDuration, formatRelativeDate, formatTime, percentOf, rollingDayBounds } from '../lib/format'
import type { AppUsageSummary, FocusSession, LiveSession } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

// ─── Inline SVG icons ─────────────────────────────────────────────────────────

function IconZap() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="7,1 3.5,6 6,6 5,11 8.5,6 6,6 7,1" />
    </svg>
  )
}

function IconTarget() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="6" cy="6" r="4.5" />
      <circle cx="6" cy="6" r="2" />
    </svg>
  )
}

function IconGrid() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="1" width="3.5" height="3.5" rx="0.7" />
      <rect x="7.5" y="1" width="3.5" height="3.5" rx="0.7" />
      <rect x="1" y="7.5" width="3.5" height="3.5" rx="0.7" />
      <rect x="7.5" y="7.5" width="3.5" height="3.5" rx="0.7" />
    </svg>
  )
}

function IconTimerLarge() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="16" cy="18" r="11" />
      <line x1="16" y1="12" x2="16" y2="18" />
      <line x1="11" y1="4" x2="21" y2="4" />
      <line x1="16" y1="4" x2="16" y2="8" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,7 5.5,10.5 12,4" />
    </svg>
  )
}

function mergeLiveSummary(
  summaries: AppUsageSummary[],
  live: LiveSession | null,
): AppUsageSummary[] {
  if (!live) return summaries

  const [fromMs, toMs] = rollingDayBounds(1)
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
}

export default function Focus() {
  const [active,      setActive]      = useState<FocusSession | null>(null)
  const [elapsed,     setElapsed]     = useState(0)
  const [label,       setLabel]       = useState('')
  // Brief "session complete" feedback state — stores the completed session duration
  const [justFinished, setJustFinished] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Today's app tracking data — for the focus stats strip
  const [todaySummaries, setTodaySummaries] = useState<AppUsageSummary[]>([])
  const [live, setLive] = useState<LiveSession | null>(null)
  // Completed focus sessions from DB
  const [recentSessions, setRecentSessions] = useState<FocusSession[]>([])

  // Load active session + today's stats + recent focus sessions on mount
  useEffect(() => {
    let cancelled = false

    async function refresh() {
      const [activeSession, summaries, recent, liveSession] = await Promise.all([
        ipc.focus.getActive(),
        ipc.db.getToday(),
        ipc.focus.getRecent(10),
        ipc.tracking.getLiveSession(),
      ])
      if (cancelled) return
      setActive((activeSession as FocusSession | null) ?? null)
      setTodaySummaries(summaries as AppUsageSummary[])
      setRecentSessions(recent as FocusSession[])
      setLive((liveSession as LiveSession | null) ?? null)
    }

    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // Live elapsed counter for active session
  useEffect(() => {
    if (active) {
      setElapsed(Math.max(0, Math.round((Date.now() - active.startTime) / 1000)))
      timerRef.current = setInterval(() => {
        setElapsed(Math.round((Date.now() - active.startTime) / 1000))
      }, 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      setElapsed(0)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [active])

  async function handleStart() {
    if (active) return
    const id = (await ipc.focus.start(label || undefined)) as number
    track('focus_session_started', {})
    const session: FocusSession = {
      id,
      startTime:       Date.now(),
      endTime:         null,
      durationSeconds: 0,
      label:           label || null,
    }
    setActive(session)
    setElapsed(0)
    setLabel('')
    setJustFinished(null)
  }

  async function handleStop() {
    if (!active) return
    const completedDuration = elapsed
    track('focus_session_ended', { duration_seconds: completedDuration, completed: true })
    await ipc.focus.stop(active.id)
    const [updatedRecent, updatedSummaries, updatedLive] = await Promise.all([
      ipc.focus.getRecent(10),
      ipc.db.getToday(),
      ipc.tracking.getLiveSession(),
    ])
    setRecentSessions(updatedRecent as FocusSession[])
    setTodaySummaries(updatedSummaries as AppUsageSummary[])
    setLive(updatedLive as LiveSession | null)
    setActive(null)
    // Show brief completion feedback, then clear after 4 s
    setJustFinished(completedDuration)
    setTimeout(() => setJustFinished(null), 4000)
  }

  // Compute today's focus stats from app tracking data
  const mergedTodaySummaries = mergeLiveSummary(todaySummaries, live)
  const totalTracked = mergedTodaySummaries.reduce((n, a) => n + a.totalSeconds, 0)
  const focusTracked = mergedTodaySummaries.filter((a) => FOCUSED_CATEGORIES.includes(a.category))
    .reduce((n, a) => n + a.totalSeconds, 0)
  const focusPct     = percentOf(focusTracked, totalTracked)
  const appsTracked  = mergedTodaySummaries.length

  return (
    <div className="p-7 max-w-xl mx-auto">
      <p className="section-label mb-1">Focus</p>
      <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight mb-6">
        {active ? 'Session in progress' : 'Start a session'}
      </h1>

      {/* ── Timer card ────────────────────────────────────────────────── */}
      <div className="card flex flex-col items-center gap-6 py-10 mb-4">
        {/* Session complete feedback */}
        {justFinished !== null && !active && (
          <div
            className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium"
            style={{ background: 'rgba(110,231,183,0.12)', color: '#6ee7b7' }}
          >
            <IconCheck /> Session complete · {formatDuration(justFinished)}
          </div>
        )}

        {/* Timer display */}
        <div className="text-[60px] font-mono font-semibold text-[var(--color-text-primary)] tabular-nums leading-none tracking-tighter">
          {formatDuration(elapsed)}
        </div>

        {active && (
          <div className="flex flex-col items-center gap-1 -mt-2">
            <p className="text-[13px] text-[var(--color-text-secondary)]">
              {active.label ?? 'Focus session in progress'}
            </p>
            <p className="text-[11px] text-[var(--color-text-tertiary)]">
              Started {formatTime(active.startTime)} · tracked locally
            </p>
          </div>
        )}

        {!active && (
          <input
            type="text"
            placeholder="What are you working on? (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleStart()}
            className="w-full max-w-xs px-4 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-high)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] transition-colors"
          />
        )}

        <div className="relative flex items-center justify-center">
          {active && (
            <span
              className="absolute rounded-lg"
              style={{
                inset: -4,
                border: '2px solid var(--color-brand-light)',
                animation: 'focus-pulse 2s ease-in-out infinite',
              }}
            />
          )}
          <button
            onClick={active ? () => void handleStop() : () => void handleStart()}
            className={[
              'relative px-8 py-2.5 rounded-lg text-[13px] font-medium transition-colors',
              active
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20'
                : 'text-[var(--color-surface)] hover:opacity-90',
            ].join(' ')}
            style={active ? undefined : { background: 'var(--color-brand-gradient)' }}
          >
            {active ? 'End session' : 'Start focus session'}
          </button>
        </div>
        <style>{`
          @keyframes focus-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.04); }
          }
        `}</style>

        {!active && justFinished === null && (
          <p className="text-[12px] text-[var(--color-text-tertiary)] text-center max-w-sm">
            Use Focus when you want an intentional work block. The timer is exact. The stats below are separate and based on tracked app categories for today.
          </p>
        )}
      </div>

      {/* ── Today's tracking stats ────────────────────────────────────── */}
      <div className="card mb-4">
        <p className="section-label mb-3">Today</p>
        <div className="grid grid-cols-3 gap-3">
          <TodayStat
            icon={<IconZap />}
            label="Focus time"
            value={focusTracked > 0 ? formatDuration(focusTracked) : '—'}
            accent
          />
          <TodayStat
            icon={<IconTarget />}
            label="Focus share"
            value={totalTracked > 0 ? `${focusPct}%` : '—'}
          />
          <TodayStat
            icon={<IconGrid />}
            label="Apps tracked"
            value={appsTracked > 0 ? String(appsTracked) : '—'}
          />
        </div>
        {totalTracked > 0 && (
          <div className="mt-3">
            <div className="h-[4px] rounded-full overflow-hidden bg-[var(--color-surface-high)]">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width:      `${focusPct}%`,
                  background: 'var(--color-bar-gradient)',
                }}
              />
            </div>
            <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">
              {focusPct >= 70 ? 'Strong focus day' :
               focusPct >= 40 ? 'Mixed focus' :
               focusPct > 0  ? 'Light focus so far' :
               'No focused activity tracked yet today'}
            </p>
            <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">
              Based on tracked app categories, not on manual focus sessions.
            </p>
          </div>
        )}
      </div>

      {/* ── Recent focus sessions ─────────────────────────────────────── */}
      <div className="card">
        <p className="section-label mb-3">Recent Sessions</p>
        {recentSessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <span style={{ color: 'var(--color-text-tertiary)' }}><IconTimerLarge /></span>
            <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">No focus sessions yet</p>
            <p className="text-[12px] text-[var(--color-text-tertiary)] text-center max-w-xs">
              Start a session above to begin tracking your deep work time.
            </p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--color-border)]">
            {recentSessions.map((s) => {
              const dateLabel = s.startTime
                ? formatRelativeDate(dateStringFromMs(s.startTime))
                : ''
              return (
                <div key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  {/* Session dot */}
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: 'var(--color-accent)', opacity: 0.7 }}
                  />
                  {/* Label */}
                  <p className="flex-1 text-[13px] text-[var(--color-text-primary)] truncate">
                    {s.label ?? (
                      <span className="text-[var(--color-text-tertiary)] italic">Unlabeled</span>
                    )}
                  </p>
                  {/* Date */}
                  <span className="text-[11px] text-[var(--color-text-tertiary)] shrink-0">
                    {dateLabel}
                  </span>
                  {/* Duration */}
                  <span className="text-[12px] text-[var(--color-text-secondary)] tabular-nums shrink-0 w-14 text-right">
                    {formatDuration(s.durationSeconds)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Today stat cell ──────────────────────────────────────────────────────────

function TodayStat({
  icon, label, value, accent,
}: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1" style={{ color: 'var(--color-text-tertiary)' }}>
        <span>{icon}</span>
        <span className="text-[10px] text-[var(--color-text-tertiary)] uppercase tracking-[0.5px] font-semibold">
          {label}
        </span>
      </div>
      <p
        className="text-[20px] font-bold tabular-nums leading-tight"
        style={{ color: accent ? 'var(--color-accent)' : 'var(--color-text-primary)' }}
      >
        {value}
      </p>
    </div>
  )
}
