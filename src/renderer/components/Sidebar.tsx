import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { AppUsageSummary, FocusSession, LiveSession } from '@shared/types'
import AppIcon from './AppIcon'
import { buildAppBundleLookup, formatDisplayAppName, resolveBundleIdForName } from '../lib/apps'

function IconToday() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

function IconFocus() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.5" />
      <circle cx="8" cy="8" r="3" />
    </svg>
  )
}

function IconHistory() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5a5.5 5.5 0 1 1-3.9 1.7" />
      <polyline points="3,5.5 7.5,5.5 7.5,9" />
    </svg>
  )
}

function IconApps() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.5" />
    </svg>
  )
}

function IconInsights() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2c-.8 2-3 3-3 5.5a3 3 0 0 0 6 0C11 5 8.8 4 8 2z" />
      <path d="M6.5 13.5h3" />
      <path d="M7 13v2" />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </svg>
  )
}

interface NavDef {
  to: string
  label: string
  icon: React.ReactNode
}

const MAIN_NAV: NavDef[] = [
  { to: '/today', label: 'Today', icon: <IconToday /> },
  { to: '/history', label: 'History', icon: <IconHistory /> },
  { to: '/focus', label: 'Focus', icon: <IconFocus /> },
  { to: '/apps', label: 'Apps', icon: <IconApps /> },
  { to: '/insights', label: 'Insights', icon: <IconInsights /> },
]

function formatTimer(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function NavItem({ to, label, icon }: NavDef) {
  const [hovered, setHovered] = useState(false)
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: isActive ? 600 : 500,
        letterSpacing: '-0.01em',
        textDecoration: 'none',
        transition: 'all 180ms',
        ...(isActive
            ? {
                color: 'var(--color-text-primary)',
                background: 'var(--color-surface-low)',
                border: '1px solid var(--color-border-ghost)',
                opacity: 1,
              }
          : hovered
            ? {
                color: 'var(--color-text-primary)',
                background: 'var(--color-pill-bg)',
                border: '1px solid transparent',
                opacity: 1,
              }
            : {
                color: 'var(--color-text-secondary)',
                border: '1px solid transparent',
                opacity: 0.78,
              }),
      })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      {label}
    </NavLink>
  )
}

export default function Sidebar() {
  const [activeSession, setActiveSession] = useState<FocusSession | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [todayApps, setTodayApps] = useState<AppUsageSummary[]>([])
  const [live, setLive] = useState<LiveSession | null>(null)
  const [defaultFocusMinutes, setDefaultFocusMinutes] = useState(50)

  useEffect(() => {
    let cancelled = false

    const loadDefaultFocusMinutes = async () => {
      try {
        const settings = await window.daylens.settings.get()
        if (cancelled) return
        const mins = (settings as { defaultFocusMinutes?: number }).defaultFocusMinutes
        if (mins != null) setDefaultFocusMinutes(mins)
      } catch {
        // Keep the last known value if settings cannot be read.
      }
    }

    const refreshActive = async () => {
      try {
        const [session, summaries, liveSession] = await Promise.all([
          window.daylens.focus.getActive(),
          window.daylens.db.getToday(),
          window.daylens.tracking.getLiveSession(),
        ])
        if (!cancelled) {
          setActiveSession((session as FocusSession | null) ?? null)
          setTodayApps(summaries as AppUsageSummary[])
          setLive((liveSession as LiveSession | null) ?? null)
        }
      } catch {
        if (!cancelled) {
          setActiveSession(null)
          setTodayApps([])
          setLive(null)
        }
      }
    }

    const handleSettingsChanged = () => {
      void loadDefaultFocusMinutes()
    }

    void loadDefaultFocusMinutes()
    void refreshActive()
    window.addEventListener('daylens:settings-changed', handleSettingsChanged)
    const poll = setInterval(() => void refreshActive(), 10_000)
    return () => {
      cancelled = true
      window.removeEventListener('daylens:settings-changed', handleSettingsChanged)
      clearInterval(poll)
    }
  }, [])

  useEffect(() => {
    if (!activeSession) {
      setElapsed(0)
      return
    }

    const update = () => setElapsed(Math.max(0, Math.round((Date.now() - activeSession.startTime) / 1000)))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [activeSession])

  const quickStartSession = async () => {
    await window.daylens.focus.start({ targetMinutes: defaultFocusMinutes, label: null, plannedApps: [] })
    const session = await window.daylens.focus.getActive()
    setActiveSession((session as FocusSession | null) ?? null)
  }

  const stopSession = async () => {
    if (!activeSession) return
    await window.daylens.focus.stop(activeSession.id)
    setActiveSession(null)
    setElapsed(0)
  }

  const targetSeconds = (activeSession?.targetMinutes ?? 0) * 60
  const remainingSeconds = targetSeconds > 0 ? Math.max(0, targetSeconds - elapsed) : 0
  const progressText = activeSession
    ? targetSeconds > 0
      ? remainingSeconds > 0
        ? `${formatTimer(remainingSeconds)} left`
        : `${formatTimer(elapsed - targetSeconds)} overtime`
      : `${formatTimer(elapsed)} elapsed`
    : `${defaultFocusMinutes}-minute sprint`

  const metaChips = useMemo(() => {
    if (!activeSession) return []
    const chips: string[] = []
    if (activeSession.targetMinutes) chips.push(`${activeSession.targetMinutes}m target`)
    chips.push(`${formatTimer(elapsed)} elapsed`)
    return chips
  }, [activeSession, elapsed])
  const appBundleLookup = useMemo(
    () => buildAppBundleLookup([
      todayApps.map((app) => ({ bundleId: app.bundleId, appName: app.appName })),
      live ? [{ bundleId: live.bundleId, appName: live.appName }] : [],
    ]),
    [todayApps, live],
  )

  return (
    <aside
      style={{
        width: 256,
        flexShrink: 0,
        background: 'var(--color-sidebar-bg)',
        borderRight: '1px solid var(--color-sidebar-border)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '24px 16px',
        boxSizing: 'border-box',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div>
        <div style={{ fontSize: 21, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>
          Daylens
        </div>
      </div>

      <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 28 }}>
        {MAIN_NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <NavItem to="/settings" label="Settings" icon={<IconSettings />} />
        <div style={{
          borderRadius: 10,
          padding: 16,
          background: 'var(--color-surface-container)',
          border: '1px solid var(--color-border-ghost)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div>
              <div style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--color-text-secondary)',
                marginBottom: 4,
              }}>
                Focus
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>
                {activeSession ? progressText : 'Start a timer'}
              </div>
            </div>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: activeSession ? 'var(--color-accent-dim)' : 'var(--color-surface-low)',
              color: 'var(--color-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <IconFocus />
            </div>
          </div>

          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.6 }}>
            {activeSession
              ? activeSession.label || 'Session running. Open Focus for apps and timer.'
              : `Start a ${defaultFocusMinutes}-minute block. Adjust details in Focus.`}
          </p>

          {activeSession && metaChips.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {metaChips.map((chip) => (
                <span
                  key={chip}
                  style={{
                    padding: '3px 9px',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--color-pill-bg)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  {chip}
                </span>
              ))}
            </div>
          )}

          {activeSession?.plannedApps && activeSession.plannedApps.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeSession.plannedApps.slice(0, 3).map((app) => (
                <div
                  key={app}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 9px',
                    borderRadius: 10,
                    background: 'var(--color-surface-low)',
                    border: '1px solid var(--color-border-ghost)',
                  }}
                >
                  <AppIcon
                    bundleId={resolveBundleIdForName(appBundleLookup, app)}
                    appName={app}
                    size={18}
                    fontSize={9}
                    cornerRadius={5}
                  />
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                    {formatDisplayAppName(app)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            {activeSession ? (
              <button
                onClick={() => void stopSession()}
                style={{
                  flex: 1,
                  minHeight: 40,
                  borderRadius: 8,
                  border: '1px solid rgba(248,113,113,0.26)',
                  background: 'rgba(248,113,113,0.10)',
                  color: '#f87171',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => void quickStartSession()}
                style={{
                  flex: 1,
                  minHeight: 40,
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--gradient-primary)',
                  color: 'var(--color-primary-contrast)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  letterSpacing: '-0.01em',
                }}
              >
                Start Focus
              </button>
            )}
            <NavLink
              to="/focus"
              style={{
                minWidth: 92,
                minHeight: 40,
                borderRadius: 8,
                border: '1px solid var(--color-border-ghost)',
                background: 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 12,
                fontWeight: 600,
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              Open
            </NavLink>
          </div>
        </div>
      </div>
    </aside>
  )
}
