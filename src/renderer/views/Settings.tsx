import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration, formatTime } from '../lib/format'
import type { AppSettings, AppTheme } from '@shared/types'

interface DebugInfo {
  dbPath: string
  platform: string
  appVersion: string
  liveSession: { bundleId: string; appName: string; startTime: number; category: string } | null
  lastClassify: { target: string; category: string }
  recentSessions: { appName: string; category: string; durationSec: number; startTime: number }[]
  browserStatus: {
    lastPoll: number | null
    visitsToday: number
    error: string | null
    browsersPollable: number
  }
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>({
    anthropicApiKey: '',
    launchOnLogin: false,
    trackingEnabled: true,
    theme: 'system',
  })
  const [saved, setSaved]         = useState<string | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debug, setDebug]         = useState<DebugInfo | null>(null)

  useEffect(() => {
    ipc.settings.get().then((s) => setSettings(s))
  }, [])

  useEffect(() => {
    if (!debugOpen || debug) return
    ipc.debug.getInfo().then((info) => setDebug(info as DebugInfo))
  }, [debugOpen])

  function flashSaved(message: string) {
    setSaved(message)
    setTimeout(() => setSaved(null), 2000)
  }

  async function handleApiKeySave() {
    await ipc.settings.set({ anthropicApiKey: settings.anthropicApiKey })
    flashSaved(settings.anthropicApiKey.trim() ? 'API key saved' : 'API key cleared')
  }

  async function handleTrackingToggle() {
    const next = !settings.trackingEnabled
    setSettings((s) => ({ ...s, trackingEnabled: next }))
    await ipc.settings.set({ trackingEnabled: next })
    flashSaved(next ? 'Tracking enabled' : 'Tracking paused')
  }

  async function handleThemeChange(theme: AppTheme) {
    setSettings((s) => ({ ...s, theme }))
    window.dispatchEvent(new CustomEvent('daylens:theme-changed', { detail: theme }))
    await ipc.settings.set({ theme })
    flashSaved(
      theme === 'system'
        ? 'Following system theme'
        : `Theme set to ${theme}`,
    )
  }

  function refreshDebug() {
    ipc.debug.getInfo().then((info) => setDebug(info as DebugInfo))
  }

  return (
    <div className="p-7 max-w-lg mx-auto">
      <p className="section-label mb-1">Settings</p>
      <h1 className="text-2xl font-semibold text-[var(--color-text-primary)] tracking-tight mb-8">Preferences</h1>

      <div className="flex flex-col gap-4">
        {/* AI section */}
        <div className="card">
          <p className="section-label mb-4">AI</p>
          <div>
            <label className="block text-[12px] font-medium text-[var(--color-text-secondary)] mb-1.5">
              Anthropic API key
            </label>
            <input
              type="password"
              value={settings.anthropicApiKey}
              onChange={(e) => setSettings((s) => ({ ...s, anthropicApiKey: e.target.value }))}
              placeholder="sk-ant-…"
              className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-high)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] font-mono transition-colors"
            />
            <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1.5">
              Stored locally. Only used for Anthropic requests you send from Insights.
            </p>
          </div>
        </div>

        {/* General section */}
        <div className="card">
          <p className="section-label mb-4">Tracking</p>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[13px] text-[var(--color-text-primary)] font-medium">Enable tracking</p>
              <p className="text-[12px] text-[var(--color-text-secondary)] mt-0.5">
                Record active app usage in the background
              </p>
            </div>
            <button
              onClick={() => void handleTrackingToggle()}
              className={[
                'w-10 h-6 rounded-full transition-colors relative shrink-0',
                settings.trackingEnabled
                  ? 'bg-[var(--color-accent)]'
                  : 'bg-[var(--color-surface-high)]',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-1 w-4 h-4 rounded-full transition-transform',
                  settings.trackingEnabled
                    ? 'translate-x-5 bg-[var(--color-surface)]'
                    : 'translate-x-1 bg-[var(--color-text-secondary)]',
                ].join(' ')}
              />
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-text-tertiary)] mt-3">
            This applies immediately. Turning tracking off ends the current in-flight session and stops new writes until you turn it back on.
          </p>
        </div>

        <div className="card">
          <p className="section-label mb-4">Appearance</p>
          <div className="flex gap-1 p-1 rounded-xl bg-[var(--color-surface-high)]">
            {([
              ['system', 'System'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => void handleThemeChange(value)}
                className={[
                  'flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors',
                  settings.theme === value
                    ? 'bg-[var(--color-surface-card)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--color-text-tertiary)] mt-3">
            System follows the Windows appearance automatically. Light and dark override it immediately.
          </p>
        </div>

        {/* Permissions note — shown when no data has been recorded */}
        <div className="card">
          <p className="section-label mb-3">Permissions</p>
          <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed">
            Daylens only needs enough OS access to detect the foreground window.
            On Windows that should work automatically. On macOS, grant{' '}
            <strong className="font-semibold text-[var(--color-text-primary)]">Accessibility</strong>{' '}
            in System Settings if tracking appears blank.
          </p>
          <p className="text-[12px] text-[var(--color-text-tertiary)] mt-2">
            Tracking data stays local unless you intentionally send a question to Anthropic from Insights.
          </p>
        </div>

        {/* Save */}
        <button
          onClick={() => void handleApiKeySave()}
          className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-surface)] text-[13px] font-medium hover:opacity-90 transition-opacity self-start"
        >
          Save API key
        </button>
        {saved && (
          <p className="text-[12px] text-[var(--color-text-tertiary)] -mt-2">
            {saved}
          </p>
        )}

        {/* ── Developer Info ──────────────────────────────────────────── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: '1px solid var(--color-border)' }}
        >
          <button
            onClick={() => setDebugOpen((o) => !o)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--color-surface-high)] transition-colors"
          >
            <p className="text-[12px] font-medium text-[var(--color-text-secondary)]">Developer Info</p>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {debugOpen ? '▲' : '▼'}
            </span>
          </button>

          {debugOpen && (
            <div
              className="px-4 pb-4 flex flex-col gap-3 border-t"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <div className="flex items-center justify-between pt-3">
                <span className="text-[11px] text-[var(--color-text-tertiary)]">Last refreshed just now</span>
                <button
                  onClick={refreshDebug}
                  className="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  Refresh
                </button>
              </div>

              {!debug ? (
                <p className="text-[12px] text-[var(--color-text-tertiary)]">Loading…</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <DebugRow label="Version"  value={debug.appVersion ?? '—'} />
                    <DebugRow label="Platform" value={debug.platform} />
                    <DebugRow label="Theme" value={settings.theme} />
                    <DebugRow label="Tracking" value={settings.trackingEnabled ? 'enabled' : 'paused'} />
                  </div>
                  <DebugRow label="DB path" value={debug.dbPath} mono />
                  <DebugRow
                    label="Live session"
                    value={debug.liveSession
                      ? `${debug.liveSession.appName} (${debug.liveSession.category})`
                      : 'none'}
                  />
                  <DebugRow
                    label="Last classify"
                    value={`"${debug.lastClassify.target}" → ${debug.lastClassify.category}`}
                    mono
                  />

                  <div>
                    <p className="text-[10px] text-[var(--color-text-tertiary)] uppercase tracking-[0.4px] mb-1.5">
                      Recent sessions
                    </p>
                    {debug.recentSessions.length === 0 ? (
                      <p className="text-[12px] text-[var(--color-text-tertiary)]">None</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {debug.recentSessions.map((s, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="text-[11px] text-[var(--color-text-tertiary)] tabular-nums shrink-0">
                              {formatTime(s.startTime)}
                            </span>
                            <span className="text-[12px] text-[var(--color-text-primary)] flex-1 truncate">
                              {s.appName}
                            </span>
                            <span className="text-[11px] text-[var(--color-text-tertiary)]">
                              {s.category}
                            </span>
                            <span className="text-[11px] text-[var(--color-text-tertiary)] tabular-nums shrink-0">
                              {formatDuration(s.durationSec)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-[10px] text-[var(--color-text-tertiary)] uppercase tracking-[0.4px] mb-1.5">
                      Browser tracking
                    </p>
                    <DebugRow
                      label="Pollable browsers"
                      value={`${debug.browserStatus.browsersPollable}`}
                    />
                    <DebugRow
                      label="Visits today"
                      value={`${debug.browserStatus.visitsToday}`}
                    />
                    <DebugRow
                      label="Last poll"
                      value={debug.browserStatus.lastPoll
                        ? new Date(debug.browserStatus.lastPoll).toLocaleTimeString()
                        : 'never'}
                    />
                    {debug.browserStatus.error && (
                      <DebugRow label="Error" value={debug.browserStatus.error} error />
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DebugRow({
  label, value, mono, error,
}: { label: string; value: string; mono?: boolean; error?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-[var(--color-text-tertiary)] uppercase tracking-[0.4px]">
        {label}
      </span>
      <span
        className={[
          'text-[12px] break-all',
          mono ? 'font-mono' : '',
          error ? 'text-red-400' : 'text-[var(--color-text-secondary)]',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}
