import { useEffect, useMemo, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { dateStringFromMs, formatDuration, formatRelativeDate, percentOf, rollingDayBounds, todayString } from '../lib/format'
import type { AppSession, AppUsageSummary, FocusSession, LiveSession, PeakHoursResult } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'
import AppIcon from '../components/AppIcon'
import { buildAppBundleLookup, formatDisplayAppName, resolveBundleIdForName } from '../lib/apps'

const TARGET_PRESETS = [25, 50, 90]

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

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getFocusStreak(sessions: FocusSession[]): number {
  if (sessions.length === 0) return 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const daySet = new Set<string>()
  for (const session of sessions) {
    const d = new Date(session.startTime)
    daySet.add([d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'))
  }
  let streak = 0
  const check = new Date(today)
  while (true) {
    const key = [check.getFullYear(), String(check.getMonth() + 1).padStart(2, '0'), String(check.getDate()).padStart(2, '0')].join('-')
    if (!daySet.has(key)) break
    streak++
    check.setDate(check.getDate() - 1)
  }
  return streak
}

function fmtHour(hour: number): string {
  if (hour === 0) return '12am'
  if (hour === 12) return '12pm'
  if (hour > 12) return `${hour - 12}pm`
  return `${hour}am`
}

function uniqueNames(names: string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) === index)
}

function sessionEndMs(session: Pick<AppSession, 'startTime' | 'endTime' | 'durationSeconds'>): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1000)
}

function overlaps(session: AppSession, fromMs: number, toMs: number): boolean {
  return sessionEndMs(session) > fromMs && session.startTime < toMs
}

function buildPlannedApps(summaries: AppUsageSummary[], live: LiveSession | null): string[] {
  const planned: string[] = []
  if (live && FOCUSED_CATEGORIES.includes(live.category)) planned.push(live.appName)

  const ranked = summaries
    .filter((summary) => FOCUSED_CATEGORIES.includes(summary.category))
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .map((summary) => summary.appName)

  if (ranked.length === 0) {
    ranked.push(...summaries.slice(0, 3).map((summary) => summary.appName))
  }

  planned.push(...ranked)
  return uniqueNames(planned).slice(0, 4)
}

function buildAppsSeen(active: FocusSession | null, sessions: AppSession[], live: LiveSession | null): string[] {
  if (!active) return []
  const sessionApps = sessions
    .filter((session) => overlaps(session, active.startTime, Date.now()))
    .map((session) => session.appName)
  if (live && Date.now() >= active.startTime) sessionApps.push(live.appName)
  return uniqueNames(sessionApps).slice(0, 6)
}

function GlassBadge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      padding: '4px 10px',
      borderRadius: 999,
      background: 'var(--color-pill-bg)',
      color: 'var(--color-text-secondary)',
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    }}>
      {children}
    </span>
  )
}

function FocusAppRow({
  appName,
  bundleId,
  subtle,
  live,
}: {
  appName: string
  bundleId?: string | null
  subtle?: boolean
  live?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: subtle ? '8px 10px' : '9px 12px',
        borderRadius: 10,
        border: '1px solid var(--color-border-ghost)',
        background: live ? 'linear-gradient(135deg, rgba(15,99,219,0.10), rgba(58,141,255,0.04))' : 'var(--color-surface)',
      }}
    >
      <AppIcon bundleId={bundleId} appName={appName} size={24} fontSize={10} />
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: subtle ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {formatDisplayAppName(appName)}
      </span>
    </div>
  )
}

export default function Focus() {
  const [active, setActive] = useState<FocusSession | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [label, setLabel] = useState('')
  const [targetMinutes, setTargetMinutes] = useState(50)
  const [justFinished, setJustFinished] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const intentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [todaySummaries, setTodaySummaries] = useState<AppUsageSummary[]>([])
  const [todaySessions, setTodaySessions] = useState<AppSession[]>([])
  const [live, setLive] = useState<LiveSession | null>(null)
  const [recentSessions, setRecentSessions] = useState<FocusSession[]>([])
  const [peakHours, setPeakHours] = useState<PeakHoursResult | null>(null)
  const [distractionThreshold, setDistractionThreshold] = useState(10)

  // Post-session reflection
  const [reflectionData, setReflectionData] = useState<{
    sessionId: number
    duration: number
    distractionCount: number
  } | null>(null)
  const [reflectionNote, setReflectionNote] = useState('')
  const [savingReflection, setSavingReflection] = useState(false)

  // Break suggestion banner — track dismissed per session id
  const [breakBannerDismissed, setBreakBannerDismissed] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      if (document.hidden) return
      try {
        const [activeSession, summaries, recent, liveSession, peak, daySessions] = await Promise.all([
          ipc.focus.getActive(),
          ipc.db.getToday(),
          ipc.focus.getRecent(10),
          ipc.tracking.getLiveSession(),
          ipc.db.getPeakHours().catch(() => null),
          ipc.db.getHistory(todayString()),
        ])
        if (cancelled) return
        setActive((activeSession as FocusSession | null) ?? null)
        setTodaySummaries(summaries as AppUsageSummary[])
        setRecentSessions(recent as FocusSession[])
        setLive((liveSession as LiveSession | null) ?? null)
        setPeakHours((peak as PeakHoursResult | null) ?? null)
        setTodaySessions(daySessions as AppSession[])
      } catch {
        // Non-fatal. The view will recover on the next poll.
      }
    }

    // Load persisted intent + distraction threshold once on mount
    ipc.settings.get().then((s) => {
      if (cancelled) return
      const settings = s as { focusIntent?: string; distractionAlertThresholdMinutes?: number }
      if (settings.focusIntent) setLabel(settings.focusIntent)
      if (settings.distractionAlertThresholdMinutes != null) setDistractionThreshold(settings.distractionAlertThresholdMinutes)
    }).catch(() => {})

    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)

    return () => {
      cancelled = true
      clearInterval(timer)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!active) {
      if (timerRef.current) clearInterval(timerRef.current)
      setElapsed(0)
      return
    }

    const update = () => setElapsed(Math.max(0, Math.round((Date.now() - active.startTime) / 1000)))
    update()
    timerRef.current = setInterval(update, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [active])

  async function handleStart() {
    if (active) return
    const plannedApps = buildPlannedApps(mergeLiveSummary(todaySummaries, live), live)
    await ipc.focus.start({
      label: label || null,
      targetMinutes,
      plannedApps,
    })
    track('focus_session_started', { target_minutes: targetMinutes, planned_apps: plannedApps.length })
    const session = await ipc.focus.getActive()
    setActive((session as FocusSession | null) ?? null)
    setElapsed(0)
    setLabel('')
    setJustFinished(null)
  }

  async function handleStop() {
    if (!active) return
    const completedDuration = elapsed
    const sessionId = active.id
    track('focus_session_ended', {
      duration_seconds: completedDuration,
      target_minutes: active.targetMinutes ?? null,
      completed: true,
    })
    await ipc.focus.stop(active.id)
    const [updatedRecent, updatedSummaries, updatedLive, updatedSessions, distractionCount] = await Promise.all([
      ipc.focus.getRecent(10),
      ipc.db.getToday(),
      ipc.tracking.getLiveSession(),
      ipc.db.getHistory(todayString()),
      ipc.focus.getDistractionCount({ sessionId }).catch(() => 0),
    ])
    setRecentSessions(updatedRecent as FocusSession[])
    setTodaySummaries(updatedSummaries as AppUsageSummary[])
    setLive(updatedLive as LiveSession | null)
    setTodaySessions(updatedSessions as AppSession[])
    setActive(null)
    setReflectionData({ sessionId, duration: completedDuration, distractionCount: distractionCount as number })
  }

  async function handleSaveReflection() {
    if (!reflectionData) return
    setSavingReflection(true)
    try {
      await ipc.focus.saveReflection({ sessionId: reflectionData.sessionId, note: reflectionNote })
    } catch { /* non-fatal */ } finally {
      setSavingReflection(false)
    }
    dismissReflection()
  }

  function dismissReflection() {
    const dur = reflectionData?.duration ?? 0
    setReflectionData(null)
    setReflectionNote('')
    setJustFinished(dur)
    setTimeout(() => setJustFinished(null), 5000)
  }

  const mergedTodaySummaries = mergeLiveSummary(todaySummaries, live)
  const totalTracked = mergedTodaySummaries.reduce((n, app) => n + app.totalSeconds, 0)
  const focusTracked = mergedTodaySummaries
    .filter((app) => FOCUSED_CATEGORIES.includes(app.category))
    .reduce((n, app) => n + app.totalSeconds, 0)
  const focusPct = percentOf(focusTracked, totalTracked)
  const appsTracked = mergedTodaySummaries.length
  const streak = getFocusStreak(recentSessions)
  const recommendedApps = useMemo(() => buildPlannedApps(mergedTodaySummaries, live), [mergedTodaySummaries, live])
  const activePlannedApps = active?.plannedApps.length ? active.plannedApps : recommendedApps
  const appsSeen = buildAppsSeen(active, todaySessions, live)
  const appBundleLookup = useMemo(
    () => buildAppBundleLookup([
      mergedTodaySummaries.map((summary) => ({ bundleId: summary.bundleId, appName: summary.appName })),
      todaySessions.map((session) => ({ bundleId: session.bundleId, appName: session.appName })),
      live ? [{ bundleId: live.bundleId, appName: live.appName }] : [],
    ]),
    [mergedTodaySummaries, todaySessions, live],
  )

  const now = new Date()
  const nowHour = now.getHours() + now.getMinutes() / 60
  let contextStrip: { text: string; color: string } | null = null
  if (peakHours) {
    const inPeak = nowHour >= peakHours.peakStart && nowHour < peakHours.peakEnd
    contextStrip = inPeak
      ? { text: "You're inside your peak focus window.", color: 'var(--color-tertiary)' }
      : { text: `Peak focus window: ${fmtHour(peakHours.peakStart)}-${fmtHour(peakHours.peakEnd)}.`, color: 'var(--color-text-secondary)' }
  }

  // Distraction banner
  const isDistraction = active !== null && live !== null && !FOCUSED_CATEGORIES.includes(live.category)
  const distractionElapsedMs = isDistraction ? Math.max(0, Date.now() - live!.startTime) : 0
  const distractionElapsedMin = Math.floor(distractionElapsedMs / 60_000)
  const distractionElapsedSec = Math.floor((distractionElapsedMs % 60_000) / 1000)
  const distractionOverThreshold = distractionElapsedMin >= distractionThreshold
  const distractionTimeLabel = distractionElapsedMin >= 1
    ? `${distractionElapsedMin}m ${distractionElapsedSec}s`
    : `${distractionElapsedSec}s`

  // Break suggestion banner — show once per session after 50 continuous minutes
  const showBreakBanner = active !== null && elapsed >= 50 * 60 && breakBannerDismissed !== active.id

  const targetSeconds = (active?.targetMinutes ?? targetMinutes) * 60
  const hasCountdown = (active?.targetMinutes ?? targetMinutes) > 0
  const remainingSeconds = hasCountdown ? Math.max(0, targetSeconds - elapsed) : 0
  const overtimeSeconds = hasCountdown ? Math.max(0, elapsed - targetSeconds) : 0
  const progressRatio = hasCountdown ? Math.min(1, elapsed / Math.max(targetSeconds, 1)) : 0
  const focusQuality = focusPct >= 70 ? 'Locked In' : focusPct >= 40 ? 'Building Flow' : 'Needs Structure'

  const stats = [
    { label: 'Focused Today', value: focusTracked > 0 ? formatDuration(focusTracked) : '0m' },
    { label: 'Focus %', value: `${focusPct}%` },
    { label: 'Apps Tracked', value: String(appsTracked) },
    { label: 'Streak', value: streak > 0 ? `${streak}d` : '0d' },
  ]
  const liveDisplayName = live?.appName ? formatDisplayAppName(live.appName) : null

  return (
    <div style={{ padding: '32px 40px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', position: 'relative' }}>

      {/* ── Distraction banner ─────────────────────────────────────────────── */}
      {isDistraction && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 10, marginBottom: 12, marginLeft: -40, marginRight: -40,
          padding: '8px 40px',
          background: distractionOverThreshold
            ? 'rgba(255,185,95,0.12)'
            : 'var(--color-surface-low)',
          borderBottom: `1px solid ${distractionOverThreshold ? 'rgba(255,185,95,0.20)' : 'var(--color-border-ghost)'}`,
          display: 'flex', alignItems: 'center', gap: 10,
          transition: 'background 300ms, border-color 300ms',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: distractionOverThreshold ? '#ffb95f' : 'var(--color-text-tertiary)',
            display: 'inline-block',
          }} />
          <span style={{ fontSize: 12, color: distractionOverThreshold ? '#ffb95f' : 'var(--color-text-secondary)', flex: 1 }}>
            On {formatDisplayAppName(live!.appName)} · {distractionTimeLabel}
            {distractionOverThreshold && '  —  Back to focus?'}
          </span>
        </div>
      )}

      {/* ── Break suggestion banner ────────────────────────────────────────── */}
      {showBreakBanner && (
        <div style={{
          marginBottom: 12, padding: '9px 16px',
          background: 'var(--color-surface-low)',
          borderRadius: 10, border: '1px solid var(--color-border-ghost)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: 1 }}>
            You've been focused for 50 min — consider a short break.
          </span>
          <button
            onClick={() => setBreakBannerDismissed(active!.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
              fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1, flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-text-secondary)',
            }}>
              Focus
            </div>
            <h1 style={{
              fontSize: 38,
              fontWeight: 900,
              letterSpacing: '-0.04em',
              color: 'var(--color-text-primary)',
              margin: 0,
              lineHeight: 1,
            }}>
              {active ? 'Focus session running.' : 'Set your next focus block.'}
            </h1>
            <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', margin: 0, maxWidth: 620, lineHeight: 1.7 }}>
              {active
                ? 'Timer, planned apps, and opened apps stay in one place.'
                : 'Choose a timer and add a label if you want.'}
            </p>
          </div>

          {contextStrip && (
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 14px',
              borderRadius: 999,
              background: 'var(--color-surface-container)',
              border: '1px solid var(--color-border-ghost)',
              color: contextStrip.color,
              boxShadow: 'var(--color-shadow-soft)',
            }}>
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: contextStrip.color,
                display: 'inline-block',
              }} />
              <span style={{ fontSize: 12, fontWeight: 700 }}>{contextStrip.text}</span>
            </div>
          )}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.8fr)',
          gap: 18,
          alignItems: 'stretch',
        }}>
          <div style={{
            background: 'var(--color-surface-container)',
            borderRadius: 12,
            padding: 28,
            border: '1px solid var(--color-border-ghost)',
            boxShadow: 'var(--color-shadow-soft)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 24,
          }}>
            <div style={{
              borderRadius: 12,
              background: 'linear-gradient(180deg, var(--color-surface-low), var(--color-surface))',
              padding: '20px 16px',
              border: '1px solid var(--color-border-ghost)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              minHeight: 260,
              flex: '1 1 208px',
            }}>
              <div style={{
                width: 176,
                height: 176,
                borderRadius: '50%',
                background: `conic-gradient(from -90deg, var(--gradient-primary-from) 0deg, var(--gradient-primary-to) ${Math.max(progressRatio * 360, 6)}deg, var(--color-surface-highest) ${Math.max(progressRatio * 360, 6)}deg 360deg)`,
                display: 'grid',
                placeItems: 'center',
                boxShadow: '0 16px 40px rgba(15,99,219,0.10)',
              }}>
                <div style={{
                  width: 136,
                  height: 136,
                  borderRadius: '50%',
                  background: 'var(--color-surface-container)',
                  border: '1px solid var(--color-border-ghost)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}>
                  {justFinished !== null && !active ? (
                    <>
                      <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-tertiary)' }}>
                        Session Complete
                      </span>
                      <span style={{ fontSize: 32, fontWeight: 900, color: 'var(--color-text-primary)', letterSpacing: '-0.04em' }}>
                        {formatDuration(justFinished)}
                      </span>
                    </>
                  ) : active ? (
                    <>
                      <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                        {remainingSeconds > 0 ? 'Time Left' : 'Elapsed'}
                      </span>
                      <span style={{ fontSize: 32, fontWeight: 900, color: 'var(--color-text-primary)', letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums' }}>
                        {formatClock(remainingSeconds > 0 ? remainingSeconds : elapsed)}
                      </span>
                      <span style={{ fontSize: 12, color: overtimeSeconds > 0 ? '#f87171' : 'var(--color-text-secondary)' }}>
                        {overtimeSeconds > 0 ? `${formatClock(overtimeSeconds)} overtime` : `${formatClock(elapsed)} elapsed`}
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                        Target
                      </span>
                      <span style={{ fontSize: 30, fontWeight: 900, color: 'var(--color-text-primary)', letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums' }}>
                        {targetMinutes}m
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {focusQuality}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {active && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
                  {active.targetMinutes && <GlassBadge>{active.targetMinutes}m target</GlassBadge>}
                  <GlassBadge>{focusQuality}</GlassBadge>
                  {liveDisplayName && <GlassBadge>Live: {liveDisplayName}</GlassBadge>}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, flex: '1 1 200px', minWidth: 0 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}>
                <div style={{
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--color-text-secondary)',
                }}>
                  {active ? 'Active Session' : 'Setup'}
                </div>
                {active && (
                  <GlassBadge>{active.label || 'Focus session'}</GlassBadge>
                )}
              </div>

              {!active && justFinished === null && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                      Label
                    </label>
                    <input
                      type="text"
                      placeholder="What are you working on?"
                      value={label}
                      onChange={(event) => {
                        const v = event.target.value
                        setLabel(v)
                        if (intentDebounceRef.current) clearTimeout(intentDebounceRef.current)
                        intentDebounceRef.current = setTimeout(() => void ipc.settings.set({ focusIntent: v }), 500)
                      }}
                      onKeyDown={(event) => event.key === 'Enter' && void handleStart()}
                      style={{
                        width: '100%',
                        height: 50,
                        borderRadius: 10,
                        border: '1px solid var(--color-border-ghost)',
                        background: 'var(--color-surface-low)',
                        padding: '0 16px',
                        fontSize: 14,
                        color: 'var(--color-text-primary)',
                        outline: 'none',
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                      Timer
                    </label>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {TARGET_PRESETS.map((preset) => {
                        const activePreset = targetMinutes === preset
                        return (
                          <button
                            key={preset}
                            onClick={() => setTargetMinutes(preset)}
                            style={{
                              minWidth: 88,
                              height: 42,
                              borderRadius: 10,
                              border: activePreset ? 'none' : '1px solid var(--color-border-ghost)',
                              background: activePreset ? 'var(--gradient-primary)' : 'var(--color-surface-low)',
                              color: activePreset ? 'var(--color-primary-contrast)' : 'var(--color-text-primary)',
                              fontSize: 13,
                              fontWeight: 800,
                              cursor: 'pointer',
                            }}
                          >
                            {preset} min
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <button
                    onClick={() => void handleStart()}
                    style={{
                      width: '100%',
                      minHeight: 52,
                      borderRadius: 10,
                      border: 'none',
                      background: 'var(--gradient-primary)',
                      color: 'var(--color-primary-contrast)',
                      fontSize: 15,
                      fontWeight: 900,
                      cursor: 'pointer',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    Start Focus
                  </button>
                </>
              )}

              {active && (
                <button
                  onClick={() => void handleStop()}
                  style={{
                    width: '100%',
                    minHeight: 50,
                    borderRadius: 10,
                    border: '1px solid rgba(248,113,113,0.26)',
                    background: 'rgba(248,113,113,0.10)',
                    color: '#f87171',
                    fontSize: 15,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  Stop
                </button>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{
                  borderRadius: 12,
                  background: 'var(--color-surface-low)',
                  border: '1px solid var(--color-border-ghost)',
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                      Planned Apps
                    </div>
                    <GlassBadge>{activePlannedApps.length > 0 ? `${activePlannedApps.length} apps` : 'Plan'}</GlassBadge>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                    {activePlannedApps.length > 0 ? activePlannedApps.map((app) => (
                      <FocusAppRow
                        key={app}
                        appName={app}
                        bundleId={resolveBundleIdForName(appBundleLookup, app)}
                      />
                    )) : (
                      <span style={{ gridColumn: '1 / -1', fontSize: 13, color: 'var(--color-text-tertiary)' }}>No strong recommendation yet.</span>
                    )}
                  </div>
                </div>

                <div style={{
                  borderRadius: 12,
                  background: 'var(--color-surface-low)',
                  border: '1px solid var(--color-border-ghost)',
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                      Apps Opened
                    </div>
                    <GlassBadge>{active && appsSeen.length > 0 ? `${appsSeen.length} seen` : 'Waiting'}</GlassBadge>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {active && appsSeen.length > 0 ? appsSeen.map((app) => (
                      <FocusAppRow
                        key={app}
                        appName={app}
                        bundleId={resolveBundleIdForName(appBundleLookup, app)}
                        subtle={live?.appName !== app}
                        live={live?.appName === app}
                      />
                    )) : (
                      <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                        {active ? 'No tracked apps inside this block yet.' : 'Starts populating once the timer begins.'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  style={{
                    background: 'var(--color-surface-container)',
                    borderRadius: 10,
                    border: '1px solid var(--color-border-ghost)',
                    padding: 18,
                    boxShadow: 'var(--color-shadow-soft)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>
                    {stat.label}
                  </span>
                  <span style={{ fontSize: 24, fontWeight: 900, color: 'var(--color-text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                    {stat.value}
                  </span>
                </div>
              ))}
            </div>

            <div style={{
              background: 'var(--color-surface-container)',
              borderRadius: 12,
              padding: 22,
              border: '1px solid var(--color-border-ghost)',
              boxShadow: 'var(--color-shadow-soft)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                <span className="section-label" style={{ color: 'var(--color-text-secondary)' }}>
                  Recent Sessions
                </span>
                {streak > 0 && <GlassBadge>{streak} day streak</GlassBadge>}
              </div>

              {recentSessions.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: 0 }}>
                  No focus sessions yet. Start one above.
                </p>
              ) : (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  border: '1px solid var(--color-border-ghost)',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: 'var(--color-surface-low)',
                }}>
                  {recentSessions.map((session) => {
                    const dateLabel = session.startTime ? formatRelativeDate(dateStringFromMs(session.startTime)) : ''
                    const tooShort = session.durationSeconds < 120
                    const isLast = recentSessions[recentSessions.length - 1]?.id === session.id
                    return (
                      <div
                        key={session.id}
                        style={{
                          padding: 14,
                          borderBottom: isLast ? 'none' : '1px solid var(--color-border-ghost)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: tooShort ? '#ffb95f' : 'var(--color-tertiary)',
                            flexShrink: 0,
                          }} />
                          <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                            {session.label || 'Focus session'}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                            {dateLabel}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <GlassBadge>{formatDuration(session.durationSeconds)}</GlassBadge>
                          {session.targetMinutes && <GlassBadge>{session.targetMinutes}m target</GlassBadge>}
                          {session.plannedApps.length > 0 && <GlassBadge>{session.plannedApps.slice(0, 2).join(' + ')}</GlassBadge>}
                          {tooShort && <GlassBadge>Too short</GlassBadge>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Post-session reflection card (bottom sheet) ───────────────────── */}
      {reflectionData && (
        <>
          {/* Scrim */}
          <div
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(4px)', zIndex: 20,
            }}
            onClick={dismissReflection}
          />
          {/* Sheet */}
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 21,
            background: 'var(--color-surface-container)',
            borderTop: '1px solid var(--color-border-ghost)',
            borderRadius: '16px 16px 0 0',
            padding: '28px 40px 32px',
            boxShadow: '0 -24px 60px rgba(0,0,0,0.35)',
            transform: 'translateY(0)',
            animation: 'slideUp 220ms ease-out',
          }}>
            <style>{`@keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }`}</style>
            <div style={{ maxWidth: 560, margin: '0 auto' }}>
              <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 10px', letterSpacing: '-0.02em' }}>
                Session complete
              </p>
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 999,
                  background: 'var(--color-accent-dim)', color: 'var(--color-primary)',
                }}>
                  {formatDuration(reflectionData.duration)} focused
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 999,
                  background: 'var(--color-surface-high)', color: 'var(--color-text-secondary)',
                }}>
                  {reflectionData.distractionCount === 1
                    ? '1 distraction'
                    : `${reflectionData.distractionCount} distractions`}
                </span>
              </div>
              <textarea
                value={reflectionNote}
                onChange={(e) => setReflectionNote(e.target.value)}
                placeholder="How did it go? Any notes for next time?"
                rows={3}
                style={{
                  width: '100%', borderRadius: 10, padding: '12px 14px',
                  background: 'var(--color-surface-low)',
                  border: '1px solid var(--color-border-ghost)',
                  fontSize: 13, color: 'var(--color-text-primary)',
                  resize: 'none', outline: 'none', boxSizing: 'border-box',
                  fontFamily: 'inherit', lineHeight: 1.6,
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(173,198,255,0.30)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--color-border-ghost)')}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
                <button
                  onClick={() => void handleSaveReflection()}
                  disabled={savingReflection || !reflectionNote.trim()}
                  style={{
                    padding: '9px 22px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: 'var(--gradient-primary)',
                    color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 700,
                    opacity: savingReflection || !reflectionNote.trim() ? 0.5 : 1,
                    fontFamily: 'inherit',
                  }}
                >
                  {savingReflection ? 'Saving…' : 'Save note'}
                </button>
                <button
                  onClick={dismissReflection}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '9px 4px',
                    fontSize: 13, color: 'var(--color-text-secondary)', fontFamily: 'inherit',
                  }}
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
