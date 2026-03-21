import { useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import UpdateBanner from './components/UpdateBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ipc } from './lib/ipc'
import { track } from './lib/analytics'
import Today from './views/Today'
import Focus from './views/Focus'
import History from './views/History'
import Apps from './views/Apps'
import Insights from './views/Insights'
import Settings from './views/Settings'
import Onboarding from './views/Onboarding'
import FeedbackModal from './components/FeedbackModal'
import type { AppSettings, AppTheme } from '@shared/types'

function applyTheme(theme: AppTheme | undefined) {
  const root = document.documentElement
  if (theme === 'light' || theme === 'dark') {
    root.dataset.theme = theme
    return
  }
  delete root.dataset.theme
}

// Inner component — inside HashRouter so useLocation() works
function AppContent({ settings }: { settings: AppSettings | null }) {
  const location = useLocation()
  const [feedbackOpen, setFeedbackOpen] = useState(false)

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
      <div className="flex flex-col h-full overflow-hidden">
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-[var(--color-surface)]">
            <Routes>
              <Route path="/" element={<Navigate to="/today" replace />} />
              <Route path="/today" element={<ErrorBoundary name="Today"><Today /></ErrorBoundary>} />
              <Route path="/focus" element={<ErrorBoundary name="Focus"><Focus /></ErrorBoundary>} />
              <Route path="/history" element={<ErrorBoundary name="History"><History /></ErrorBoundary>} />
              <Route path="/apps" element={<ErrorBoundary name="Apps"><Apps /></ErrorBoundary>} />
              <Route path="/insights" element={<ErrorBoundary name="Insights"><Insights /></ErrorBoundary>} />
              <Route path="/settings" element={<ErrorBoundary name="Settings"><Settings /></ErrorBoundary>} />
            </Routes>
          </main>
        </div>
      </div>
    </>
  )
}

export default function App() {
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    let active = true

    void ipc.settings.get().then((s) => {
      if (!active) return
      applyTheme(s.theme)
      setOnboardingComplete(s.onboardingComplete)
      setSettings(s)
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
