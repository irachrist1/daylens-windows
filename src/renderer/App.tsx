import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ANALYTICS_EVENT } from '@shared/analytics'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import UpdateBanner from './components/UpdateBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import DayWrapped from './components/DayWrapped'
import { ipc } from './lib/ipc'
import { track } from './lib/analytics'
import { dateStringFromMs, todayString } from './lib/format'
import { handleDailySummaryNavigation } from './lib/dailySummaryNavigation'
import Onboarding from './views/Onboarding'
import FeedbackModal from './components/FeedbackModal'
import type { AppSettings, AppTheme, DayTimelinePayload, OnboardingState } from '@shared/types'

// Lazy-load route views so the initial bundle is small (#6)
const Timeline = lazy(() => import('./views/Timeline'))
const Apps     = lazy(() => import('./views/Apps'))
const Insights = lazy(() => import('./views/Insights'))
const Settings = lazy(() => import('./views/Settings'))

function applyTheme(theme: AppTheme | undefined) {
  const root = document.documentElement
  if (theme === 'light' || theme === 'dark') {
    root.dataset.theme = theme
    return
  }
  delete root.dataset.theme
}

function LoadingFallback() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-[13px] text-[var(--color-text-tertiary)]">Loading…</p>
    </div>
  )
}

function devShortcutPlatform(settings: AppSettings | null): OnboardingState['platform'] {
  if (settings?.onboardingState.platform) return settings.onboardingState.platform
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac')) return 'macos'
  if (platform.includes('win')) return 'windows'
  return 'linux'
}

function isDevShortcut(e: KeyboardEvent, keyCode: string, platform: OnboardingState['platform']): boolean {
  const primaryPressed = platform === 'macos' ? e.metaKey : e.ctrlKey
  return e.code === keyCode && primaryPressed && e.shiftKey && e.altKey
}

// Inner component — inside HashRouter so useLocation() and useNavigate() work
function AppContent({ settings }: { settings: AppSettings | null }) {
  const location = useLocation()
  const navigate = useNavigate()
  const platform = devShortcutPlatform(settings)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [wrappedOpen, setWrappedOpen] = useState(false)
  const [wrappedDay, setWrappedDay] = useState<DayTimelinePayload | null>(null)
  const [wrappedThreadId, setWrappedThreadId] = useState<number | null>(null)
  const [wrappedArtifactId, setWrappedArtifactId] = useState<number | null>(null)

  const openDailySummaryRoute = useCallback((route: string) => {
    void handleDailySummaryNavigation(route, {
      getTimelineDay: ipc.db.getTimelineDay,
      navigate,
      todayString,
      openWrapped: ({ day, threadId, artifactId }) => {
        setWrappedDay(day)
        setWrappedThreadId(threadId)
        setWrappedArtifactId(artifactId)
        setWrappedOpen(true)
      },
    })
  }, [navigate])

  // Route to the correct view when a notification is tapped
  useEffect(() => {
    return ipc.navigation.onNavigate(openDailySummaryRoute)
  }, [openDailySummaryRoute])

  // Dev escape hatch: Cmd+Shift+Option+O / Ctrl+Shift+Alt+O resets onboarding without touching tracked data
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isDevShortcut(e, 'KeyO', platform)) return
      const freshState: OnboardingState = {
        flowVersion: settings?.onboardingState.flowVersion ?? 3,
        platform,
        stage: 'welcome',
        trackingPermissionState: platform === 'macos' ? 'missing' : 'granted',
        permissionRequestedAt: null,
        proofState: 'idle',
        personalizationState: 'pending',
        aiSetupState: 'pending',
        completedAt: null,
      }
      void ipc.settings.set({
        onboardingComplete: false,
        onboardingState: freshState,
        userName: '',
        userGoals: [],
      }).then(() => window.location.reload())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [platform, settings])

  // Dev shortcut: Cmd+Shift+Option+W / Ctrl+Shift+Alt+W opens DayWrapped for yesterday
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isDevShortcut(e, 'KeyW', platform)) return
      const yesterday = dateStringFromMs(Date.now() - 86_400_000)
      void ipc.db.getTimelineDay(yesterday).then((payload) => {
        setWrappedDay(payload)
        setWrappedThreadId(null)
        setWrappedArtifactId(null)
        setWrappedOpen(true)
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [platform])

  // Dev shortcut: Cmd+Shift+Option+B / Ctrl+Shift+Alt+B shows a test notification.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isDevShortcut(e, 'KeyB', platform)) return
      const route = `/ai?date=${todayString()}&source=daily-summary`

      const openRoute = () => {
        window.focus()
        openDailySummaryRoute(route)
      }

      if (!('Notification' in window)) {
        openRoute()
        return
      }

      const showNotification = () => {
        const notification = new Notification('Day Wrapped test', {
          body: 'Tap to open Day Wrapped for today.',
        })
        notification.onclick = () => {
          notification.close()
          openRoute()
        }
      }

      if (Notification.permission === 'granted') {
        showNotification()
      } else if (Notification.permission === 'denied') {
        openRoute()
      } else {
        void Notification.requestPermission().then((permission) => {
          if (permission === 'granted') showNotification()
          else openRoute()
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openDailySummaryRoute, platform])

  // Track route changes
  useEffect(() => {
    const view = location.pathname.replace('/', '') || 'timeline'
    track(ANALYTICS_EVENT.VIEW_OPENED, { view })
  }, [location.pathname])

  // Day-7 automatic feedback prompt
  useEffect(() => {
    if (!settings) return
    if (
      !settings.feedbackPromptShown &&
      settings.firstLaunchDate > 0 &&
      Date.now() - settings.firstLaunchDate >= 7 * 86_400_000
    ) {
      setFeedbackOpen(true)
      void ipc.settings.set({ feedbackPromptShown: true })
    }
  }, [settings])

  return (
    <>
      <UpdateBanner />
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
      {wrappedOpen && wrappedDay && (
        <DayWrapped
          data={wrappedDay}
          threadId={wrappedThreadId}
          artifactId={wrappedArtifactId}
          userName={settings?.userName ?? null}
          onClose={() => setWrappedOpen(false)}
          onOpenReport={() => {
            setWrappedOpen(false)
            if (wrappedThreadId != null) {
              navigate(`/ai?threadId=${wrappedThreadId}${wrappedArtifactId != null ? `&artifactId=${wrappedArtifactId}` : ''}`)
            } else {
              navigate('/ai')
            }
          }}
        />
      )}
      {/* Full-height shell: title bar on top, sidebar + content below */}
      <div className="flex flex-col h-full overflow-hidden" style={{ fontFamily: 'var(--font-sans)' }}>
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-[var(--color-bg)]">
            <Suspense fallback={<LoadingFallback />}>
              <Routes>
                <Route path="/" element={<Navigate to="/timeline" replace />} />
                <Route path="/today" element={<Navigate to="/timeline" replace />} />
                <Route path="/focus" element={<Navigate to="/timeline" replace />} />
                <Route path="/history" element={<Navigate to="/timeline" replace />} />
                <Route path="/clients" element={<Navigate to="/timeline" replace />} />
                <Route path="/insights" element={<Navigate to="/ai" replace />} />
                <Route path="/timeline" element={<ErrorBoundary name="Timeline"><Timeline /></ErrorBoundary>} />
                <Route path="/apps" element={<ErrorBoundary name="Apps"><Apps /></ErrorBoundary>} />
                <Route path="/ai" element={<ErrorBoundary name="AI"><Insights /></ErrorBoundary>} />
                <Route path="/settings" element={<ErrorBoundary name="Settings"><Settings /></ErrorBoundary>} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </>
  )
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    ipc.settings.get().then((s) => {
      if (!active) return
      applyTheme(s.theme)
      setSettings(s)
    }).catch((err) => {
      if (!active) return
      setLoadError(err instanceof Error ? err.message : String(err))
    })

    const onThemeChange = (event: Event) => {
      applyTheme((event as CustomEvent<AppTheme>).detail)
    }

    window.addEventListener('daylens:theme-changed', onThemeChange as EventListener)

    return () => {
      active = false
      window.removeEventListener('daylens:theme-changed', onThemeChange as EventListener)
    }
  }, [])

  if (loadError) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4 p-8">
        <p className="text-[14px] text-red-400">Failed to load settings: {loadError}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded-md bg-[var(--color-accent)] text-[var(--color-primary-contrast)] text-[13px] font-medium"
        >
          Retry
        </button>
      </div>
    )
  }

  // Loading — wait for settings before rendering anything
  if (!settings) return null

  if (!settings.onboardingComplete || settings.onboardingState.stage !== 'complete') {
    return (
      <Onboarding
        initialSettings={settings}
        onComplete={() => {
          void ipc.settings.get().then((next) => {
            applyTheme(next.theme)
            setSettings(next)
          })
        }}
      />
    )
  }

  return (
    <HashRouter>
      <AppContent settings={settings} />
    </HashRouter>
  )
}
