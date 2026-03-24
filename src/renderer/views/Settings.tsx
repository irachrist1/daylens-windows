import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { formatDuration, formatTime } from '../lib/format'
import type { AppSettings, AppTheme } from '@shared/types'
import FeedbackModal from '../components/FeedbackModal'

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
  updateAvailable: string | null
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

// ─── Section helpers ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: 10,
      fontWeight: 900,
      textTransform: 'uppercase',
      letterSpacing: '0.2em',
      color: 'var(--color-text-secondary)',
      margin: '28px 0 10px',
    }}>
      {children}
    </p>
  )
}

function SettingsRow({
  label,
  sublabel,
  control,
  danger,
  onClick,
}: {
  label: React.ReactNode
  sublabel?: React.ReactNode
  control?: React.ReactNode
  danger?: boolean
  onClick?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        minHeight: 48, padding: '0 16px', borderRadius: 10, gap: 12,
        background: hovered
          ? danger
            ? 'rgba(248,113,113,0.07)'
            : 'var(--color-surface-high)'
          : 'transparent',
        transition: 'background 120ms',
        cursor: onClick ? 'pointer' : 'default',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: 14, margin: 0, lineHeight: 1.4, fontWeight: 500,
          color: danger ? '#f87171' : 'var(--color-text-primary)',
          transition: 'color 120ms',
        }}>
          {label}
        </p>
        {sublabel && (
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 0' }}>
            {sublabel}
          </p>
        )}
      </div>
      {control && <div style={{ flexShrink: 0 }}>{control}</div>}
    </div>
  )
}

function PillToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 999, cursor: 'pointer',
        background: checked
          ? 'var(--gradient-primary)'
          : 'var(--color-surface-high)',
        position: 'relative', transition: 'background 180ms', flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: checked ? 23 : 3,
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        transition: 'left 180ms',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }} />
    </div>
  )
}

export default function Settings() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<AppSettings>({
    analyticsOptIn: false,
    launchOnLogin: true,
    theme: 'system',
    onboardingComplete: true,
    userName: '',
    userGoals: [],
    dailyFocusGoalHours: 4,
    firstLaunchDate: 0,
    feedbackPromptShown: false,
  })
  const [hasApiKey, setHasApiKey]         = useState(false)
  const [apiKeyInput, setApiKeyInput]     = useState('')
  const [saved, setSaved]                 = useState<string | null>(null)
  const [feedbackOpen, setFeedbackOpen]   = useState(false)
  const [debugOpen, setDebugOpen]         = useState(false)
  const [debug, setDebug]                 = useState<DebugInfo | null>(null)
  const [syncStatus, setSyncStatus]       = useState<SyncStatus | null>(null)
  const [linking, setLinking]             = useState(false)
  const [linkResult, setLinkResult]       = useState<LinkResult | null>(null)
  const [linkError, setLinkError]         = useState<string | null>(null)
  const [showMnemonic, setShowMnemonic]   = useState(false)
  const [mnemonic, setMnemonic]           = useState<string | null>(null)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)

  const linkAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    ipc.settings.get().then((s) => setSettings(s))
    ipc.settings.hasApiKey().then((has) => setHasApiKey(has as boolean))
    ipc.sync.getStatus().then((s: SyncStatus) => setSyncStatus(s))
    ipc.debug.getInfo().then((info) => setDebug(info as DebugInfo))
  }, [])

  useEffect(() => {
    if (!debugOpen || debug) return
    ipc.debug.getInfo().then((info) => setDebug(info as DebugInfo))
  }, [debugOpen])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && linking) handleCancelLink()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [linking])

  function flashSaved(message: string) {
    setSaved(message)
    setTimeout(() => setSaved(null), 2000)
  }

  async function handleApiKeySave() {
    try {
      if (apiKeyInput.trim()) {
        await ipc.settings.setApiKey(apiKeyInput.trim())
        setHasApiKey(true)
        setApiKeyInput('')
        track('api_key_saved', {})
        flashSaved('API key saved')
      } else {
        await ipc.settings.clearApiKey()
        setHasApiKey(false)
        flashSaved('API key cleared')
      }
    } catch (err) {
      flashSaved('Failed to save API key: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function handleThemeChange(theme: AppTheme) {
    setSettings((s) => ({ ...s, theme }))
    window.dispatchEvent(new CustomEvent('daylens:theme-changed', { detail: theme }))
    await ipc.settings.set({ theme })
    flashSaved(theme === 'system' ? 'Following system theme' : `Theme set to ${theme}`)
  }

  async function handleLink() {
    setLinking(true)
    setLinkError(null)
    const controller = new AbortController()
    linkAbortRef.current = controller
    try {
      const result = await ipc.sync.link() as LinkResult
      if (controller.signal.aborted) return
      setLinkResult(result)
      setSyncStatus({ isLinked: true, workspaceId: result.workspaceId, lastSyncAt: null })
    } catch (err) {
      if (!controller.signal.aborted) {
        setLinkError(err instanceof Error ? err.message : 'Failed to connect')
      }
    } finally {
      setLinking(false)
      linkAbortRef.current = null
    }
  }

  async function handleCreateBrowserLink() {
    setLinking(true)
    setLinkError(null)
    const controller = new AbortController()
    linkAbortRef.current = controller
    try {
      const result = await ipc.sync.createBrowserLink() as { displayCode: string; fullToken: string }
      if (controller.signal.aborted) return
      if (linkResult) {
        setLinkResult({ ...linkResult, linkCode: result.displayCode, linkToken: result.fullToken })
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setLinkError(err instanceof Error ? err.message : 'Failed to create link')
      }
    } finally {
      setLinking(false)
      linkAbortRef.current = null
    }
  }

  function handleCancelLink() {
    linkAbortRef.current?.abort()
    linkAbortRef.current = null
    setLinking(false)
    setLinkError(null)
  }

  async function handleDisconnect() {
    await ipc.sync.disconnect()
    setSyncStatus({ isLinked: false, workspaceId: null, lastSyncAt: null })
    setLinkResult(null)
    setShowMnemonic(false)
    setMnemonic(null)
    setLinkError(null)
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

  function openAppMapping() {
    flashSaved('Open an app entry to create or edit a category mapping')
    navigate('/apps')
  }

  const version = debug?.appVersion

  // ─── Shared card style ────────────────────────────────────────────────────
  const cardStyle: React.CSSProperties = {
    background: 'var(--color-surface-container)',
    borderRadius: 14,
    border: '1px solid var(--color-border-ghost)',
    padding: '4px 0',
    marginBottom: 4,
  }

  return (
    <div style={{ padding: '32px 40px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-sans)' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>

        {/* ── PAGE HEADER ─────────────────────────────────────────────── */}
        <div style={{ marginBottom: 32 }}>
          <h1 style={{
            fontSize: 32, fontWeight: 900, color: 'var(--color-text-primary)',
            margin: 0, letterSpacing: '-0.02em', lineHeight: 1,
          }}>
            System Preferences
          </h1>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '6px 0 0' }}>
            Configure how Daylens works for you.
          </p>
        </div>

        {/* Update banner */}
        {debug?.updateAvailable && (
          <div style={{
            borderRadius: 12, padding: '12px 18px', marginBottom: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'rgba(173,198,255,0.08)', border: '1px solid rgba(173,198,255,0.15)',
          }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 500 }}>
              Daylens {debug.updateAvailable} is available
            </span>
            <button
              onClick={() => ipc.shell.openExternal('https://daylens.app')}
              style={{
                fontSize: 12, fontWeight: 700, color: 'var(--color-primary-contrast)', background: 'var(--gradient-primary)',
                border: 'none', cursor: 'pointer', borderRadius: 8, padding: '5px 14px',
              }}
            >
              Download
            </button>
          </div>
        )}

        {/* ── 12-COL GRID ─────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '7fr 5fr', gap: 32, alignItems: 'start' }}>

          {/* ════════════════════════════════════════════════════════════
              LEFT COLUMN  (7 / 12)
          ════════════════════════════════════════════════════════════ */}
          <div>

            {/* ── PROFILE ─────────────────────────────────────────── */}
            <SectionLabel>Profile</SectionLabel>
            <div style={cardStyle}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 16, padding: '20px 20px',
              }}>
                {/* Avatar */}
                <div style={{
                  width: 80, height: 80, borderRadius: 16,
                  background: 'var(--color-surface-highest)',
                  color: 'var(--color-primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 28, fontWeight: 900, flexShrink: 0,
                }}>
                  {settings.userName ? settings.userName[0].toUpperCase() : 'Y'}
                </div>

                {/* Name + chips */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 8px' }}>
                    {settings.userName || 'You'}
                  </p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {/* Elite Member chip */}
                    <span style={{
                      fontSize: 10, fontWeight: 900, padding: '3px 10px', borderRadius: 999,
                      background: 'rgba(173,198,255,0.12)', color: 'var(--color-primary)',
                      textTransform: 'uppercase', letterSpacing: '0.1em',
                    }}>
                      Elite Member
                    </span>
                    {/* Cloud Sync chip — shown when linked */}
                    {syncStatus?.isLinked && (
                      <span style={{
                        fontSize: 10, fontWeight: 900, padding: '3px 10px', borderRadius: 999,
                        background: 'rgba(79,219,200,0.12)', color: 'var(--color-tertiary)',
                        textTransform: 'uppercase', letterSpacing: '0.1em',
                      }}>
                        Cloud Sync
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ── TIME ACQUISITION ────────────────────────────────── */}
            <SectionLabel>Time Acquisition</SectionLabel>
            <div style={cardStyle}>
              {/* Icon box row helper */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                minHeight: 52, padding: '0 16px', borderRadius: 10,
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                  background: 'rgba(79,219,200,0.10)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--color-tertiary)" strokeWidth="1.6">
                    <circle cx="9" cy="9" r="7.5" />
                    <path d="M9 5v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>
                    Automatic App Tracking
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 0' }}>
                    Always active — tracks foreground app in real-time
                  </p>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 900, padding: '3px 10px', borderRadius: 999,
                  background: 'rgba(79,219,200,0.12)', color: 'var(--color-tertiary)',
                  textTransform: 'uppercase', letterSpacing: '0.1em',
                }}>
                  Active
                </span>
              </div>

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                minHeight: 52, padding: '0 16px', borderRadius: 10,
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                  background: 'var(--color-surface-high)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.6">
                    <rect x="2" y="3" width="14" height="12" rx="2" />
                    <path d="M2 7h14" />
                    <path d="M6 1v2M12 1v2" strokeLinecap="round" />
                  </svg>
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>
                    Work Hours
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 0' }}>
                    Define active hours
                  </p>
                </div>
                <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Not set</span>
              </div>
            </div>

            {/* ── APP TAXONOMY ────────────────────────────────────── */}
            <SectionLabel>App Taxonomy</SectionLabel>
            <div style={cardStyle}>
              {/* Cosmetic placeholder — no logic to preserve here */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 16px 6px',
              }}>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>
                    No overrides yet
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '3px 0 0' }}>
                    Manual category mappings will show up here after you add one.
                  </p>
                </div>
                <button
                  onClick={openAppMapping}
                  style={{
                  fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 8,
                  border: '1px solid var(--color-border-ghost)', background: 'transparent',
                  cursor: 'pointer', color: 'var(--color-text-secondary)', fontFamily: 'inherit',
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                }}>
                  Bulk Edit
                </button>
              </div>

              <p style={{
                fontSize: 12, color: 'var(--color-text-secondary)', margin: 0,
                padding: '4px 16px 12px',
              }}>
                Reclassify an app once and Daylens will keep using that decision.
              </p>

              {/* Map New Application — cosmetic dashed button */}
              <div style={{ padding: '0 16px 16px' }}>
                <div style={{
                  width: '100%',
                  padding: 18,
                  borderRadius: 12,
                  border: '1.5px dashed var(--color-border-ghost)',
                  background: 'var(--color-surface-low)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                }}>
                  <div style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: 'rgba(15,99,219,0.08)',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}>
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2.5" y="2.5" width="5" height="5" rx="1.4" />
                      <rect x="10.5" y="2.5" width="5" height="5" rx="1.4" />
                      <rect x="2.5" y="10.5" width="5" height="5" rx="1.4" />
                      <path d="M11 13h4" />
                      <path d="M13 11v4" />
                    </svg>
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>
                      Add your first override
                    </p>
                    <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '3px 0 0' }}>
                      Manual category mappings will show up here once you create one.
                    </p>
                  </div>
                  <button
                    onClick={openAppMapping}
                    style={{
                    padding: '9px 14px',
                    borderRadius: 10,
                    border: 'none',
                    background: 'var(--gradient-primary)',
                    color: 'var(--color-primary-contrast)',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    flexShrink: 0,
                    fontFamily: 'inherit',
                  }}>
                    Map App
                  </button>
                </div>
              </div>
            </div>

          </div>{/* end left column */}

          {/* ════════════════════════════════════════════════════════════
              RIGHT COLUMN  (5 / 12)
          ════════════════════════════════════════════════════════════ */}
          <div>

            {/* ── ATMOSPHERE ──────────────────────────────────────── */}
            <SectionLabel>Atmosphere</SectionLabel>
            <div style={cardStyle}>
              {/* Dark mode — uses PillToggle, wired to theme dark/system */}
              <SettingsRow
                label="Dark Mode"
                sublabel="Follow system or force dark"
                control={
                  <PillToggle
                    checked={settings.theme === 'dark'}
                    onChange={(v) => void handleThemeChange(v ? 'dark' : 'system')}
                  />
                }
              />

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Theme switcher tabs */}
              <div style={{ padding: '12px 16px' }}>
                <div style={{
                  display: 'flex', gap: 2, padding: 3, borderRadius: 10,
                  background: 'var(--color-surface-low)',
                }}>
                  {([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => void handleThemeChange(value)}
                      style={{
                        flex: 1, padding: '6px 0', borderRadius: 8, fontSize: 12,
                        border: 'none', cursor: 'pointer',
                        fontWeight: settings.theme === value ? 700 : 400,
                        background: settings.theme === value ? 'var(--color-surface-container)' : 'transparent',
                        color: settings.theme === value ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                        transition: 'all 120ms',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── COGNITIVE AUGMENTATION ──────────────────────────── */}
            <SectionLabel>Cognitive Augmentation</SectionLabel>
            <div style={cardStyle}>

              {/* API Key row */}
              {hasApiKey && !apiKeyInput ? (
                <SettingsRow
                  label="Anthropic API Key"
                  control={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                        background: 'rgba(79,219,200,0.12)', color: 'var(--color-tertiary)',
                        textTransform: 'uppercase', letterSpacing: '0.08em',
                      }}>
                        Secured ✓
                      </span>
                      <button
                        onClick={() => setApiKeyInput(' ')}
                        style={{
                          fontSize: 12, fontWeight: 500, padding: '5px 12px', borderRadius: 8,
                          border: '1px solid var(--color-border-ghost)', background: 'transparent',
                          cursor: 'pointer', color: 'var(--color-text-secondary)', fontFamily: 'inherit',
                          transition: 'color 120ms',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-secondary)')}
                      >
                        Update
                      </button>
                    </div>
                  }
                />
              ) : (
                <div style={{ padding: '16px 16px 12px' }}>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 8, marginTop: 0 }}>
                    Anthropic API Key
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="sk-ant-…"
                      style={{
                        flex: 1, padding: '0 12px', borderRadius: 10, height: 38,
                        background: 'var(--color-surface-highest)', border: '1px solid transparent',
                        fontSize: 13, color: 'var(--color-text-primary)', outline: 'none',
                        transition: 'box-shadow 150ms',
                        fontFamily: 'inherit',
                      }}
                      onFocus={(e) => (e.currentTarget.style.boxShadow = '0 0 0 2px rgba(173,198,255,0.25)')}
                      onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
                    />
                    <button
                      onClick={() => void handleApiKeySave()}
                      style={{
                        padding: '0 16px', height: 38, borderRadius: 10, border: 'none', cursor: 'pointer',
                        background: 'var(--gradient-primary)',
                        color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 900, fontFamily: 'inherit',
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Focus goal */}
              <SettingsRow
                label="Focus Goal"
                sublabel="Shown as a progress bar on the Dashboard"
                control={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      step={0.5}
                      value={settings.dailyFocusGoalHours ?? 4}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v) && v >= 1 && v <= 12) {
                          setSettings((s) => ({ ...s, dailyFocusGoalHours: v }))
                          void ipc.settings.set({ dailyFocusGoalHours: v }).then(() => flashSaved('Goal updated'))
                        }
                      }}
                      style={{
                        width: 60, textAlign: 'center',
                        background: 'var(--color-surface-highest)',
                        border: 'none', borderRadius: 8,
                        color: 'var(--color-text-primary)',
                        fontSize: 14, fontWeight: 700,
                        padding: '5px 8px', outline: 'none', fontFamily: 'inherit',
                      }}
                    />
                    <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>hours / day</span>
                  </div>
                }
              />

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Launch on login */}
              <SettingsRow
                label="Launch on Login"
                sublabel="Start Daylens automatically when you sign in"
                control={
                  <PillToggle
                    checked={settings.launchOnLogin}
                    onChange={async (v) => {
                      setSettings((s) => ({ ...s, launchOnLogin: v }))
                      await ipc.settings.set({ launchOnLogin: v })
                      flashSaved(v ? 'Will launch on login' : "Won't launch on login")
                    }}
                  />
                }
              />
            </div>

            {/* ── SECURITY & SOVEREIGNTY ──────────────────────────── */}
            <SectionLabel>Security &amp; Sovereignty</SectionLabel>
            <div style={cardStyle}>

              {/* Data stored locally */}
              <SettingsRow
                label="Data stored locally"
                sublabel="All activity data is kept on your device"
                control={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.4">
                      <rect x="3" y="7" width="10" height="7" rx="1.5" />
                      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                    </svg>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.4">
                      <path d="M5 7l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                }
              />

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Web Companion */}
              <div style={{ padding: '12px 16px' }}>
                <p style={{
                  fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
                  letterSpacing: '0.2em', color: 'var(--color-text-secondary)',
                  margin: '0 0 10px',
                }}>
                  Web Companion
                </p>

                {linkResult ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ade80', display: 'inline-block' }} />
                        <p style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600, margin: 0 }}>Connected</p>
                      </div>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <button onClick={() => setShowDisconnectConfirm(true)} style={{ fontSize: 11, fontWeight: 600, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }}>Disconnect</button>
                        <button onClick={() => setLinkResult(null)} style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>Done</button>
                      </div>
                    </div>

                    <div style={{ borderRadius: 10, padding: 12, background: 'var(--color-surface-highest)', border: '1px solid var(--color-border-ghost)' }}>
                      <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.15em', color: 'var(--color-text-secondary)', margin: '0 0 8px' }}>Link Code</p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ fontSize: 12, color: 'var(--color-text-primary)', flex: 1, wordBreak: 'break-all' }}>{linkResult.linkToken}</code>
                        <button
                          onClick={() => copyToClipboard(linkResult.linkToken)}
                          style={{
                            padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                            background: 'var(--gradient-primary)',
                            color: 'var(--color-primary-contrast)', fontSize: 11, fontWeight: 900, flexShrink: 0,
                          }}
                        >
                          Copy
                        </button>
                      </div>
                      <p style={{ fontSize: 10, color: 'var(--color-text-tertiary)', margin: '8px 0 0' }}>
                        Paste at{' '}
                        <button onClick={() => ipc.shell.openExternal('https://daylens-web.vercel.app/link')} style={{ color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, textDecoration: 'underline' }}>
                          daylens-web.vercel.app/link
                        </button>
                        {' '}· Expires in 5 minutes
                      </p>
                    </div>

                    <div style={{ borderRadius: 10, padding: 12, background: 'var(--color-surface-high)' }}>
                      <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#fbbf24', margin: '0 0 4px' }}>Recovery Phrase</p>
                      <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: '0 0 8px' }}>Save this separately. Use it to restore your workspace if you reinstall.</p>
                <p style={{ fontSize: 12, color: 'var(--color-text-primary)', lineHeight: 1.6, margin: '0 0 8px' }}>{linkResult.mnemonic}</p>
                      <button onClick={() => copyToClipboard(linkResult.mnemonic)} style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>Copy Recovery Phrase</button>
                    </div>
                  </div>
                ) : syncStatus?.isLinked ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ade80', display: 'inline-block' }} />
                        <p style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600, margin: 0 }}>Connected</p>
                      </div>
                      {syncStatus.lastSyncAt && (
                        <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: 0 }}>Last synced {formatTime(syncStatus.lastSyncAt)}</p>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => void handleCreateBrowserLink()}
                        disabled={linking}
                        style={{
                          padding: '6px 14px', borderRadius: 8,
                          border: '1px solid var(--color-border-ghost)', background: 'transparent',
                          cursor: 'pointer', fontSize: 12, fontWeight: 500,
                          color: 'var(--color-text-secondary)', opacity: linking ? 0.5 : 1,
                        }}
                      >
                        {linking ? 'Creating…' : 'Connect a Browser'}
                      </button>
                      {linking && (
                        <button onClick={handleCancelLink} style={{ fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>Cancel</button>
                      )}
                      <button
                        onClick={() => void handleShowMnemonic()}
                        style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--color-border-ghost)', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)' }}
                      >
                        Show Recovery Phrase
                      </button>
                      <button
                        onClick={() => setShowDisconnectConfirm(true)}
                        style={{ fontSize: 12, fontWeight: 600, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0' }}
                      >
                        Disconnect
                      </button>
                    </div>

                    {showMnemonic && mnemonic && (
                      <div style={{ borderRadius: 10, padding: 12, background: 'var(--color-surface-high)' }}>
                        <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#fbbf24', margin: '0 0 4px' }}>Recovery Phrase</p>
                        <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: '0 0 8px' }}>Use this to restore your workspace if you reinstall.</p>
                <p style={{ fontSize: 12, color: 'var(--color-text-primary)', lineHeight: 1.6, margin: '0 0 8px' }}>{mnemonic}</p>
                        <button onClick={() => copyToClipboard(mnemonic)} style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>Copy to Clipboard</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>Not Connected</p>
                      <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '3px 0 0' }}>View your activity data from any browser</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <button
                        onClick={() => void handleLink()}
                        disabled={linking}
                        style={{
                          padding: '9px 22px', borderRadius: 10, border: 'none', cursor: 'pointer',
                          background: 'var(--gradient-primary)',
                          color: 'var(--color-primary-contrast)', fontSize: 13, fontWeight: 900,
                          opacity: linking ? 0.5 : 1,
                        }}
                      >
                        {linking ? 'Setting up…' : 'Connect to Web'}
                      </button>
                      {linking && (
                        <button onClick={handleCancelLink} style={{ fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>Cancel</button>
                      )}
                    </div>
                  </div>
                )}

                {linkError && (
                  <p style={{ fontSize: 12, color: '#f87171', marginTop: 8, fontWeight: 500 }}>{linkError}</p>
                )}
              </div>

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Export Data */}
              <SettingsRow
                label="Export Data"
                control={
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.4">
                    <path d="M7 1v8M4 6l3 3 3-3M2 10v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
                  </svg>
                }
                onClick={() => {/* export logic placeholder */}}
              />

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Delete All Data */}
              <SettingsRow
                label="Delete All Data"
                danger
                control={
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="rgba(248,113,113,0.8)" strokeWidth="1.4">
                    <path d="M2 3.5h10M5 3.5V2h4v1.5M3 3.5l.7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L11 3.5" />
                  </svg>
                }
              />
            </div>

            {/* ── SYSTEM ──────────────────────────────────────────── */}
            <SectionLabel>System</SectionLabel>
            <div style={cardStyle}>

              {/* Version */}
              {version && (
                <SettingsRow
                  label="Version"
                  control={
                    <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                      v{version}
                    </span>
                  }
                />
              )}

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Feedback */}
              <SettingsRow
                label="Send Feedback"
                control={
                  <button
                    onClick={() => setFeedbackOpen(true)}
                    style={{
                      padding: '5px 14px', borderRadius: 8,
                      border: '1px solid var(--color-border-ghost)', background: 'transparent',
                      cursor: 'pointer', fontSize: 12, fontWeight: 500,
                      color: 'var(--color-text-secondary)', transition: 'color 120ms',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-secondary)')}
                  >
                    Open
                  </button>
                }
              />

              <div style={{ height: 1, background: 'var(--color-border-ghost)', margin: '0 16px' }} />

              {/* Developer Info collapsible */}
              <div style={{ borderRadius: 10, overflow: 'hidden' }}>
                <button
                  onClick={() => setDebugOpen((o) => !o)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
                    transition: 'background 120ms',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-high)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', margin: 0 }}>Developer Info</p>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{debugOpen ? '▲' : '▼'}</span>
                </button>

                {debugOpen && (
                  <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--color-border-ghost)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Last refreshed just now</span>
                      <button onClick={refreshDebug} style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>Refresh</button>
                    </div>

                    {!debug ? (
                      <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</p>
                    ) : (
                      <>
                        <DebugRow label="Tracker module" value={debug.trackingStatus.moduleSource ?? 'not loaded — tracking unavailable'} error={!debug.trackingStatus.moduleSource} />
                        {debug.trackingStatus.loadError && <DebugRow label="Tracker load error" value={debug.trackingStatus.loadError} error />}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          <DebugRow label="Version" value={debug.appVersion ?? '—'} />
                          <DebugRow label="Platform" value={debug.platform} />
                          <DebugRow label="Theme" value={settings.theme} />
                        </div>
                        <DebugRow label="DB path" value={debug.dbPath} />
                        <DebugRow label="Live session" value={debug.liveSession ? `${debug.liveSession.appName} (${debug.liveSession.category})` : 'none'} />
                        <DebugRow label="Last classify" value={`"${debug.lastClassify.target}" → ${debug.lastClassify.category}`} />
                        {debug.trackingStatus.pollError && <DebugRow label="Tracker poll error" value={debug.trackingStatus.pollError} error />}
                        {debug.trackingStatus.lastRawWindow && (
                          <DebugRow label="Last raw window" value={[
                            debug.trackingStatus.lastRawWindow.application || 'app=""',
                            debug.trackingStatus.lastRawWindow.path || 'path=""',
                            debug.trackingStatus.lastRawWindow.isUWPApp ? `uwp=${debug.trackingStatus.lastRawWindow.uwpPackage || 'unknown'}` : 'uwp=false',
                          ].join(' | ')} />
                        )}

                        <div>
                          <p className="section-label" style={{ color: 'var(--color-text-secondary)', margin: '0 0 6px' }}>Recent sessions</p>
                          {debug.recentSessions.length === 0 ? (
                            <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>None</p>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {debug.recentSessions.map((s, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatTime(s.startTime)}</span>
                                  <span style={{ fontSize: 12, color: 'var(--color-text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.appName}</span>
                                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{s.category}</span>
                                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatDuration(s.durationSec)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div>
                          <p style={{ fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.15em', color: 'var(--color-text-secondary)', margin: '0 0 6px' }}>Browser tracking</p>
                          <DebugRow label="Pollable browsers" value={`${debug.browserStatus.browsersPollable}`} />
                          <DebugRow label="Visits today" value={`${debug.browserStatus.visitsToday}`} />
                          <DebugRow label="Last poll" value={debug.browserStatus.lastPoll ? new Date(debug.browserStatus.lastPoll).toLocaleTimeString() : 'never'} />
                          {debug.browserStatus.error && <DebugRow label="Error" value={debug.browserStatus.error} error />}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

            </div>

          </div>{/* end right column */}

        </div>{/* end grid */}

      </div>

      {/* ── SAVED FLASH ──────────────────────────────────────────────────── */}
      {saved && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--color-surface-highest)', border: '1px solid var(--color-border-ghost)',
          borderRadius: 10, padding: '9px 18px', fontSize: 13, fontWeight: 500,
          color: 'var(--color-text-primary)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          {saved}
        </div>
      )}

      {/* ── FEEDBACK MODAL ───────────────────────────────────────────────── */}
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}

      {/* ── DISCONNECT CONFIRM MODAL ─────────────────────────────────────── */}
      {showDisconnectConfirm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
          backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{
            background: 'var(--color-surface-container)', borderRadius: 16,
            padding: 28, maxWidth: 400, width: '90%',
            boxShadow: '0 32px 80px rgba(0,0,0,0.45)',
            border: '1px solid var(--color-border-ghost)',
          }}>
            <p style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', margin: '0 0 8px' }}>
              Disconnect from web?
            </p>
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 24px', lineHeight: 1.6 }}>
              Your data remains online but no new syncs will occur.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => void handleDisconnect()}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'rgba(248,113,113,0.15)', color: '#f87171',
                  fontSize: 13, fontWeight: 700,
                }}
              >
                Disconnect
              </button>
              <button
                onClick={() => setShowDisconnectConfirm(false)}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'var(--color-surface-high)', color: 'var(--color-text-secondary)',
                  fontSize: 13, fontWeight: 500,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DebugRow({ label, value, error }: { label: string; value: string; error?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{
        fontSize: 10, fontWeight: 900, textTransform: 'uppercase',
        letterSpacing: '0.15em', color: 'var(--color-text-secondary)',
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 12, wordBreak: 'break-all',
        fontFamily: 'inherit',
        color: error ? '#f87171' : 'var(--color-text-secondary)',
      }}>
        {value}
      </span>
    </div>
  )
}
