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
  trackingStatus: {
    moduleSource: 'package' | 'unpacked' | null
    loadError: string | null
    pollError: string | null
    lastRawWindow: {
      application: string
      path: string
      isUWPApp: boolean
      uwpPackage: string
    } | null
  }
  recentSessions: { appName: string; category: string; durationSec: number; startTime: number }[]
  browserStatus: {
    lastPoll: number | null
    visitsToday: number
    error: string | null
    browsersPollable: number
  }
}

interface SyncStatus {
  isLinked: boolean
  workspaceId: string | null
  lastSyncAt: number | null
}

interface LinkResult {
  workspaceId: string
  mnemonic: string
  linkCode: string
  linkToken: string
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
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [linking, setLinking] = useState(false)
  const [linkResult, setLinkResult] = useState<LinkResult | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [showMnemonic, setShowMnemonic] = useState(false)
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)

  useEffect(() => {
    ipc.settings.get().then((s) => setSettings(s))
    ipc.sync.getStatus().then((s: SyncStatus) => setSyncStatus(s))
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

  async function handleLink() {
    setLinking(true)
    setLinkError(null)
    try {
      const result = await ipc.sync.link() as LinkResult
      setLinkResult(result)
      setSyncStatus({ isLinked: true, workspaceId: result.workspaceId, lastSyncAt: null })
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setLinking(false)
    }
  }

  async function handleCreateBrowserLink() {
    setLinking(true)
    setLinkError(null)
    try {
      const result = await ipc.sync.createBrowserLink() as { displayCode: string; fullToken: string }
      if (linkResult) {
        setLinkResult({ ...linkResult, linkCode: result.displayCode, linkToken: result.fullToken })
      }
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to create link')
    } finally {
      setLinking(false)
    }
  }

  async function handleDisconnect() {
    await ipc.sync.disconnect()
    setSyncStatus({ isLinked: false, workspaceId: null, lastSyncAt: null })
    setLinkResult(null)
    setShowDisconnectConfirm(false)
    flashSaved('Disconnected from web')
  }

  async function handleShowMnemonic() {
    const m = await ipc.sync.getMnemonic() as string | null
    setMnemonic(m)
    setShowMnemonic(true)
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
    flashSaved('Copied to clipboard')
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

        {/* Web Companion */}
        <div className="card">
          <p className="section-label mb-4">Web Companion</p>

          {/* Priority 1: If we just generated a link code, ALWAYS show it */}
          {linkResult ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                  <p className="text-[13px] text-[var(--color-text-primary)] font-medium">Connected</p>
                </div>
                <button
                  onClick={() => setLinkResult(null)}
                  className="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  Done
                </button>
              </div>

              <div>
                <p className="text-[13px] text-[var(--color-text-primary)] font-semibold">
                  Now open Daylens Web in your browser
                </p>
                <p className="text-[12px] text-[var(--color-text-secondary)] mt-0.5">
                  Copy and paste the link code below into the web app.
                </p>
              </div>

              {/* LINK CODE — prominently displayed */}
              <div className="rounded-lg p-3 space-y-2" style={{ border: '1px solid var(--color-border)' }}>
                <p className="text-[10px] font-bold text-[var(--color-text-tertiary)] tracking-widest uppercase">
                  Link Code
                </p>
                <div className="flex items-center gap-2">
                  <code className="text-[13px] font-mono text-[var(--color-text-primary)] select-all flex-1 break-all">
                    {linkResult.linkToken}
                  </code>
                  <button
                    onClick={() => copyToClipboard(linkResult.linkToken)}
                    className="px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-surface)] text-[11px] font-medium hover:opacity-90 transition-opacity shrink-0"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-[10px] text-[var(--color-text-tertiary)]">
                  Paste this at <a href="https://daylens-web.vercel.app" className="text-[var(--color-accent)] hover:underline">daylens-web.vercel.app</a> · Expires in 5 minutes
                </p>
              </div>

              {/* RECOVERY PHRASE — separate section, clearly labeled differently */}
              <div className="rounded-lg bg-[var(--color-surface-high)] p-3 space-y-2">
                <p className="text-[10px] font-bold text-amber-400 tracking-widest uppercase">
                  Recovery Phrase
                </p>
                <p className="text-[11px] text-[var(--color-text-tertiary)]">
                  Save this separately. Use it to restore your workspace if you reinstall.
                </p>
                <p className="text-[12px] font-mono text-[var(--color-text-primary)] select-all leading-relaxed">
                  {linkResult.mnemonic}
                </p>
                <button
                  onClick={() => copyToClipboard(linkResult.mnemonic)}
                  className="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
                >
                  Copy Recovery Phrase
                </button>
              </div>
            </div>
          ) : syncStatus?.isLinked ? (
            /* Priority 2: Connected, no active link code */
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                  <p className="text-[13px] text-[var(--color-text-primary)] font-medium">Connected</p>
                </div>
                {syncStatus.lastSyncAt && (
                  <p className="text-[11px] text-[var(--color-text-tertiary)]">
                    Last synced {formatTime(syncStatus.lastSyncAt)}
                  </p>
                )}
              </div>

              <button
                onClick={() => void handleCreateBrowserLink()}
                disabled={linking}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-[12px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition-colors self-start"
              >
                {linking ? 'Creating...' : 'Connect a Browser'}
              </button>

              <button
                onClick={() => void handleShowMnemonic()}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-[12px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors self-start"
              >
                Show Recovery Phrase
              </button>

              {showMnemonic && mnemonic && (
                <div className="rounded-lg bg-[var(--color-surface-high)] p-3 space-y-2">
                  <p className="text-[10px] font-bold text-amber-400 tracking-widest uppercase">
                    Recovery Phrase
                  </p>
                  <p className="text-[11px] text-[var(--color-text-tertiary)]">
                    Use this to restore your workspace if you reinstall.
                  </p>
                  <p className="text-[12px] font-mono text-[var(--color-text-primary)] select-all leading-relaxed">
                    {mnemonic}
                  </p>
                  <button
                    onClick={() => copyToClipboard(mnemonic)}
                    className="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
                  >
                    Copy to Clipboard
                  </button>
                </div>
              )}

              {!showDisconnectConfirm ? (
                <button
                  onClick={() => setShowDisconnectConfirm(true)}
                  className="text-[12px] text-red-400 hover:text-red-300 transition-colors self-start mt-1"
                >
                  Disconnect
                </button>
              ) : (
                <div className="rounded-lg bg-red-500/10 p-3 space-y-2">
                  <p className="text-[12px] text-[var(--color-text-primary)]">
                    Disconnect from web? Your data remains online but no new syncs will occur.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleDisconnect()}
                      className="px-3 py-1.5 rounded-lg bg-red-500/20 text-[11px] font-medium text-red-400 hover:bg-red-500/30 transition-colors"
                    >
                      Disconnect
                    </button>
                    <button
                      onClick={() => setShowDisconnectConfirm(false)}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Priority 3: Not connected */
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-[13px] text-[var(--color-text-primary)] font-medium">Not Connected</p>
                <p className="text-[12px] text-[var(--color-text-secondary)] mt-0.5">
                  View your activity data from any browser
                </p>
              </div>

              <button
                onClick={() => void handleLink()}
                disabled={linking}
                className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-surface)] text-[13px] font-medium hover:opacity-90 transition-opacity self-start disabled:opacity-50"
              >
                {linking ? 'Setting up...' : 'Connect to Web'}
              </button>
            </div>
          )}

          {linkError && (
            <p className="text-[12px] text-red-400 mt-2">{linkError}</p>
          )}
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
            Tracking data stays local unless you connect Web Companion or send a question to Anthropic from Insights.
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
                  <DebugRow
                    label="Tracker module"
                    value={debug.trackingStatus.moduleSource ?? 'not loaded'}
                  />
                  {debug.trackingStatus.loadError && (
                    <DebugRow label="Tracker load error" value={debug.trackingStatus.loadError} error />
                  )}
                  {debug.trackingStatus.pollError && (
                    <DebugRow label="Tracker poll error" value={debug.trackingStatus.pollError} error />
                  )}
                  {debug.trackingStatus.lastRawWindow && (
                    <DebugRow
                      label="Last raw window"
                      value={[
                        debug.trackingStatus.lastRawWindow.application || 'app=""',
                        debug.trackingStatus.lastRawWindow.path || 'path=""',
                        debug.trackingStatus.lastRawWindow.isUWPApp
                          ? `uwp=${debug.trackingStatus.lastRawWindow.uwpPackage || 'unknown'}`
                          : 'uwp=false',
                      ].join(' | ')}
                      mono
                    />
                  )}

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
