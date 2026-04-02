import { Suspense, lazy, useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import UpdateBanner from './components/UpdateBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ipc } from './lib/ipc'
import { track } from './lib/analytics'
import Onboarding from './views/Onboarding'
import FeedbackModal from './components/FeedbackModal'
import type { AppSettings, AppTheme } from '@shared/types'

// Lazy-load route views so the initial bundle is small (#6)
const Today    = lazy(() => import('./views/Today'))
const Focus    = lazy(() => import('./views/Focus'))
const History  = lazy(() => import('./views/History'))
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

// Inner component — inside HashRouter so useLocation() and useNavigate() work
function AppContent({ settings }: { settings: AppSettings | null }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  // Route to the correct view when a notification is tapped
  useEffect(() => {
    return ipc.navigation.onNavigate((route) => {
      navigate(route)
    })
  }, [navigate])

  // Track route changes
  useEffect(() => {
    const view = location.pathname.replace('/', '') || 'today'
    track('view_opened', { view })
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
      {/* Full-height shell: title bar on top, sidebar + content below */}
      <div className="flex flex-col h-full overflow-hidden" style={{ fontFamily: 'var(--font-sans)' }}>
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-[var(--color-bg)]">
            <Suspense fallback={<LoadingFallback />}>
              <Routes>
                <Route path="/" element={<Navigate to="/today" replace />} />
                <Route path="/today" element={<ErrorBoundary name="Today"><Today /></ErrorBoundary>} />
                <Route path="/focus" element={<ErrorBoundary name="Focus"><Focus /></ErrorBoundary>} />
                <Route path="/history" element={<ErrorBoundary name="History"><History /></ErrorBoundary>} />
                <Route path="/apps" element={<ErrorBoundary name="Apps"><Apps /></ErrorBoundary>} />
                <Route path="/insights" element={<ErrorBoundary name="Insights"><Insights /></ErrorBoundary>} />
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
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    ipc.settings.get().then((s) => {
      if (!active) return
      applyTheme(s.theme)
      setOnboardingComplete(s.onboardingComplete)
      setSettings(s)
    }).catch((err) => {
      if (!active) return
      setLoadError(err instanceof Error ? err.message : String(err))
      setOnboardingComplete(false)
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
  if (onboardingComplete === null) return null

  if (!onboardingComplete) {
    return <Onboarding onComplete={() => setOnboardingComplete(true)} />
  }

  return (
    <HashRouter>
      <AppContent settings={settings} />
    </HashRouter>
  )
}
