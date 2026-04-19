import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ANALYTICS_EVENT } from '@shared/analytics'
import {
  getInstallUpdateExpectation,
  getLaunchOnLoginDescription,
  getQuickAccessExpectation,
} from '@shared/platformExpectations'
import type {
  AIProvider,
  AIProviderMode,
  AIModelStrategy,
  AppCategory,
  AppSettings,
  AppTheme,
  AppUsageSummary,
  BrowserLinkResult,
  TrackingDiagnosticsPayload,
  SyncStatus,
} from '@shared/types'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import type { UpdaterStatusInfo } from '../../preload/index'
import ConnectAI from '../components/ConnectAI'

const PROVIDERS: Array<{ id: AIProviderMode; label: string }> = [
  { id: 'anthropic', label: 'Claude API' },
  { id: 'openai', label: 'OpenAI API' },
  { id: 'google', label: 'Gemini API' },
  { id: 'claude-cli', label: 'Claude CLI' },
  { id: 'codex-cli', label: 'Codex CLI' },
]

const API_PROVIDERS: Array<{ id: AIProvider; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Gemini' },
]

// Kept in sync with canonical model ids referenced in src/main/services/aiOrchestration.ts.
// Only exposed when strategy === 'custom'; other strategies route by tier.
const ANTHROPIC_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'claude-opus-4-7', label: 'claude-opus-4-7' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
]

const OPENAI_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gpt-5.4', label: 'gpt-5.4' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
]

const CATEGORY_OPTIONS: Array<{ value: AppCategory; label: string }> = [
  { value: 'development', label: 'Development' },
  { value: 'communication', label: 'Communication' },
  { value: 'research', label: 'Research' },
  { value: 'writing', label: 'Writing' },
  { value: 'aiTools', label: 'AI Tools' },
  { value: 'design', label: 'Design' },
  { value: 'browsing', label: 'Browsing' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'email', label: 'Email' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'social', label: 'Social' },
  { value: 'system', label: 'System' },
  { value: 'uncategorized', label: 'Uncategorized' },
]

function sectionTitle(label: string) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 800,
      letterSpacing: '0.10em',
      textTransform: 'uppercase',
      color: 'var(--color-text-tertiary)',
      marginBottom: 8,
    }}>
      {label}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      style={{
        width: 42,
        height: 24,
        borderRadius: 999,
        border: 'none',
        background: checked ? 'var(--gradient-primary)' : 'var(--color-surface-high)',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 3,
        left: checked ? 22 : 3,
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 120ms',
      }} />
    </button>
  )
}

function SettingsRow({
  title,
  description,
  control,
  first = false,
  align = 'center',
}: {
  title: string
  description?: string
  control?: ReactNode
  first?: boolean
  align?: 'center' | 'start'
}) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: align === 'start' ? 'flex-start' : 'center',
      justifyContent: 'space-between',
      gap: 14,
      padding: first ? '0 0 14px' : '14px 0',
      borderTop: first ? 'none' : '1px solid var(--color-border-ghost)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>{title}</div>
        {description && (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3, lineHeight: 1.55 }}>
            {description}
          </div>
        )}
      </div>
      {control && <div style={{ flexShrink: 0, maxWidth: '100%' }}>{control}</div>}
    </div>
  )
}

function StatusPill({
  label,
  tone = 'neutral',
}: {
  label: string
  tone?: 'neutral' | 'success' | 'warning' | 'error'
}) {
  const success = tone === 'success'
  const warning = tone === 'warning'
  const error = tone === 'error'
  const border = success
    ? '1px solid rgba(79, 219, 200, 0.24)'
    : warning
      ? '1px solid rgba(251, 191, 36, 0.24)'
      : error
        ? '1px solid rgba(248, 113, 113, 0.24)'
        : '1px solid var(--color-border-ghost)'
  const background = success
    ? 'rgba(79, 219, 200, 0.10)'
    : warning
      ? 'rgba(251, 191, 36, 0.10)'
      : error
        ? 'rgba(248, 113, 113, 0.10)'
        : 'var(--color-surface-low)'
  const color = success
    ? 'var(--color-focus-green)'
    : warning
      ? '#fbbf24'
      : error
        ? '#f87171'
        : 'var(--color-text-secondary)'

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '6px 10px',
        borderRadius: 999,
        border,
        background,
        color,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div style={{
      display: 'inline-flex',
      gap: 3,
      padding: 3,
      borderRadius: 10,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-surface-high)',
    }}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          onClick={() => onChange(option.value)}
          style={{
            padding: '5px 10px',
            borderRadius: 7,
            border: 'none',
            background: value === option.value ? 'var(--gradient-primary)' : 'transparent',
            color: value === option.value ? 'var(--color-primary-contrast)' : 'var(--color-text-secondary)',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Select<T extends string>({
  value,
  options,
  onChange,
  width = 160,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  width?: number
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      style={{
        width,
        height: 34,
        borderRadius: 9,
        border: '1px solid var(--color-border-ghost)',
        background: 'var(--color-surface-high)',
        color: 'var(--color-text-primary)',
        padding: '0 10px',
        outline: 'none',
        fontSize: 12.5,
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

const settingsSurfaceStyle: CSSProperties = {
  borderRadius: 28,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface)',
  overflow: 'hidden',
}

function normalizeFallbackOrder(order: AIProvider[]): AIProvider[] {
  const unique = order.filter((provider, index) => order.indexOf(provider) === index)
  for (const provider of API_PROVIDERS.map((entry) => entry.id)) {
    if (!unique.includes(provider)) unique.push(provider)
  }
  return unique.slice(0, API_PROVIDERS.length)
}

function SettingsSection({
  title,
  description,
  children,
  first = false,
}: {
  title: string
  description: string
  children: ReactNode
  first?: boolean
}) {
  return (
    <section
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 28,
        padding: '26px 28px',
        borderTop: first ? 'none' : '1px solid var(--color-border-ghost)',
      }}
    >
      <div style={{ flex: '0 0 188px', maxWidth: 228 }}>
        {sectionTitle(title)}
        <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
          {description}
        </div>
      </div>
      <div style={{ flex: '1 1 560px', minWidth: 0, display: 'grid', gap: 18 }}>
        {children}
      </div>
    </section>
  )
}

function updateStatusLabel(status: UpdaterStatusInfo | null, version: string | null): string {
  if (!status) return 'Ready.'
  switch (status.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return typeof status.progressPct === 'number'
        ? `Downloading ${status.version ?? 'update'} — ${status.progressPct}%`
        : `Downloading ${status.version ?? 'update'}…`
    case 'downloaded':
      return `${status.version ?? 'Update'} ready to install. Restart to finish.`
    case 'installing':
      return `Installing ${status.version ?? 'update'}…`
    case 'not-available':
      return version ? `You're on the latest version (${version}).` : 'No updates available.'
    case 'error':
      return status.errorMessage ?? 'Update check failed.'
    case 'idle':
    default:
      return version ? `Current version: ${version}.` : 'Ready.'
  }
}

function formatSyncTimestamp(value: number | null): string {
  if (!value) return 'Not synced yet.'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatDurationShort(totalSeconds: number): string {
  if (totalSeconds >= 3600) return `${(totalSeconds / 3600).toFixed(totalSeconds >= 36_000 ? 0 : 1)}h`
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}m`
  return `${Math.max(1, Math.round(totalSeconds))}s`
}

const inlineButtonStyle: CSSProperties = {
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface-high)',
  color: 'var(--color-text-primary)',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
}

const infoPanelStyle: CSSProperties = {
  marginTop: 14,
  padding: '14px 16px',
  borderRadius: 14,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface-low)',
  display: 'grid',
  gap: 8,
}

function UpdatesSection() {
  const [status, setStatus] = useState<UpdaterStatusInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)

  useEffect(() => {
    void ipc.updater.getStatus().then((info) => {
      setStatus(info)
      if (info.version) setCurrentVersion((prev) => prev ?? info.version)
    })
    void ipc.tracking.getDiagnostics()
      .then((diagnostics) => setPlatform((diagnostics as TrackingDiagnosticsPayload | null)?.platform ?? null))
      .catch(() => null)
    const cleanup = ipc.updater.onStatus((info) => setStatus(info))
    return cleanup
  }, [])

  async function handleCheck() {
    track(ANALYTICS_EVENT.UPDATE_CHECK_REQUESTED, {
      surface: 'settings',
      trigger: 'settings',
    })
    setChecking(true)
    try {
      const info = await ipc.updater.check()
      setStatus(info)
    } finally {
      setChecking(false)
    }
  }

  const isDownloaded = status?.status === 'downloaded'
  const isBusy = checking || status?.status === 'checking' || status?.status === 'downloading' || status?.status === 'installing'
  const installCopy = getInstallUpdateExpectation(platform)

  return (
    <SettingsSection
      title="Updates"
      description="Check for new builds. Installs on next restart."
    >
      <div>
        <SettingsRow
          first
          title="App updates"
          description={updateStatusLabel(status, currentVersion)}
          control={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {isDownloaded && (
                <button
                  type="button"
                  onClick={() => {
                    track(ANALYTICS_EVENT.UPDATE_INSTALL_REQUESTED, {
                      surface: 'settings',
                      trigger: 'settings',
                      version: status?.version ?? undefined,
                    })
                    void ipc.updater.install()
                  }}
                  style={{
                    height: 32,
                    padding: '0 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'var(--gradient-primary)',
                    color: 'var(--color-primary-contrast)',
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Restart to install
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleCheck()}
                disabled={isBusy}
                style={{
                  height: 32,
                  padding: '0 14px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface-high)',
                  color: 'var(--color-text-primary)',
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: isBusy ? 'default' : 'pointer',
                  opacity: isBusy ? 0.6 : 1,
                }}
              >
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
          }
        />
        {status?.supportMessage && (
          <div style={infoPanelStyle}>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
              {status.supportMessage}
            </div>
          </div>
        )}
        <div style={infoPanelStyle}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
            {installCopy.title}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
            {installCopy.body}
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [cliTools, setCliTools] = useState<{ claude: string | null; codex: string | null }>({ claude: null, codex: null })
  const [trackingDiagnostics, setTrackingDiagnostics] = useState<TrackingDiagnosticsPayload | null>(null)
  const [showAdvancedAI, setShowAdvancedAI] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncBusy, setSyncBusy] = useState<'link' | 'browser-link' | 'mnemonic' | 'disconnect' | null>(null)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [browserLink, setBrowserLink] = useState<BrowserLinkResult | null>(null)
  const [workspaceMnemonic, setWorkspaceMnemonic] = useState<string | null>(null)
  const [recentApps, setRecentApps] = useState<AppUsageSummary[]>([])
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, AppCategory>>({})
  const [categoryBusyBundleId, setCategoryBusyBundleId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const [current, tools, tracking, status, summaries, overrides] = await Promise.all([
        ipc.settings.get(),
        ipc.ai.detectCliTools().catch(() => ({ claude: null, codex: null })),
        ipc.tracking.getDiagnostics().catch(() => null),
        ipc.sync.getStatus().catch(() => null),
        ipc.db.getAppSummaries(30).catch(() => []),
        ipc.db.getCategoryOverrides().catch(() => ({})),
      ])
      const access = current.aiProvider === 'claude-cli'
        ? !!tools.claude
        : current.aiProvider === 'codex-cli'
          ? !!tools.codex
          : await ipc.settings.hasApiKey(current.aiProvider)
      setSettings(current)
      setHasApiKey(access)
      setCliTools(tools as { claude: string | null; codex: string | null })
      setTrackingDiagnostics(tracking as TrackingDiagnosticsPayload | null)
      setSyncStatus(status)
      setRecentApps((summaries as AppUsageSummary[])
        .filter((summary) => summary.totalSeconds > 0 && summary.bundleId)
        .sort((left, right) => right.totalSeconds - left.totalSeconds)
        .slice(0, 8))
      setCategoryOverrides(overrides as Record<string, AppCategory>)
    })()
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const next = await ipc.tracking.getDiagnostics().catch(() => null)
      if (!cancelled) setTrackingDiagnostics(next as TrackingDiagnosticsPayload | null)
    }

    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!settings) return
    if (settings.aiProvider === 'claude-cli') {
      setHasApiKey(!!cliTools.claude)
      return
    }
    if (settings.aiProvider === 'codex-cli') {
      setHasApiKey(!!cliTools.codex)
      return
    }
    void ipc.settings.hasApiKey(settings.aiProvider).then((access) => setHasApiKey(access))
  }, [cliTools, settings?.aiProvider])

  async function persist(partial: Partial<AppSettings>) {
    if (!settings) return
    const next = { ...settings, ...partial }
    setSettings(next)
    await ipc.settings.set(partial)
  }

  async function refreshAIAccess() {
    const current = await ipc.settings.get()
    const access = current.aiProvider === 'claude-cli'
      ? !!cliTools.claude
      : current.aiProvider === 'codex-cli'
        ? !!cliTools.codex
        : await ipc.settings.hasApiKey(current.aiProvider)
    setSettings(current)
    setHasApiKey(access)
  }

  async function refreshSyncStatus() {
    const status = await ipc.sync.getStatus().catch(() => null)
    setSyncStatus(status)
    return status
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setSyncNote('Copied to clipboard.')
    } catch {
      setSyncNote('Copy failed in this environment. You can still select the text manually.')
    }
  }

  async function handleCreateWorkspace() {
    setSyncBusy('link')
    setSyncNote(null)
    try {
      const result = await ipc.sync.link()
      setBrowserLink({
        displayCode: result.linkCode,
        fullToken: result.linkToken,
      })
      setWorkspaceMnemonic(result.mnemonic)
      setSyncNote(`Workspace ${result.workspaceId} linked. Keep the recovery words somewhere safe before you disconnect this device.`)
      await refreshSyncStatus()
    } catch (error) {
      setSyncNote(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncBusy(null)
    }
  }

  async function handleCreateBrowserLink() {
    setSyncBusy('browser-link')
    setSyncNote(null)
    try {
      const link = await ipc.sync.createBrowserLink()
      setBrowserLink(link)
      setSyncNote('Browser link code ready. Use it from the Daylens web or MCP linking flow.')
      await refreshSyncStatus()
    } catch (error) {
      setSyncNote(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncBusy(null)
    }
  }

  async function handleRevealMnemonic() {
    setSyncBusy('mnemonic')
    setSyncNote(null)
    try {
      const mnemonic = await ipc.sync.getMnemonic()
      if (!mnemonic) {
        setSyncNote('No recovery words are stored on this device yet.')
        return
      }
      setWorkspaceMnemonic(mnemonic)
    } catch (error) {
      setSyncNote(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncBusy(null)
    }
  }

  async function handleDisconnectWorkspace() {
    setSyncBusy('disconnect')
    setSyncNote(null)
    try {
      await ipc.sync.disconnect()
      setBrowserLink(null)
      setWorkspaceMnemonic(null)
      setSyncNote('Workspace disconnected on this device. Local history stays here.')
      await refreshSyncStatus()
    } catch (error) {
      setSyncNote(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncBusy(null)
    }
  }

  async function handleCategoryOverrideChange(bundleId: string, category: AppCategory) {
    setCategoryBusyBundleId(bundleId)
    try {
      await ipc.db.setCategoryOverride(bundleId, category)
      setCategoryOverrides((current) => ({ ...current, [bundleId]: category }))
    } finally {
      setCategoryBusyBundleId(null)
    }
  }

  async function handleCategoryOverrideClear(bundleId: string) {
    setCategoryBusyBundleId(bundleId)
    try {
      await ipc.db.clearCategoryOverride(bundleId)
      setCategoryOverrides((current) => {
        const next = { ...current }
        delete next[bundleId]
        return next
      })
    } finally {
      setCategoryBusyBundleId(null)
    }
  }

  if (!settings) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Loading settings…</p>
      </div>
    )
  }

  const linuxTracking = trackingDiagnostics?.linuxTracking ?? null
  const linuxDesktop = trackingDiagnostics?.linuxDesktop ?? null
  const linuxSupportTone = linuxTracking?.supportLevel === 'ready'
    ? 'success'
    : linuxTracking?.supportLevel === 'limited'
      ? 'warning'
      : linuxTracking?.supportLevel === 'unsupported'
        ? 'error'
        : 'neutral'
  const linuxHelperSummary = linuxTracking
    ? [
        `hyprctl ${linuxTracking.helperCommands.hyprctl ? 'yes' : 'no'}`,
        `swaymsg ${linuxTracking.helperCommands.swaymsg ? 'yes' : 'no'}`,
        `xdotool ${linuxTracking.helperCommands.xdotool ? 'yes' : 'no'}`,
        `xprop ${linuxTracking.helperCommands.xprop ? 'yes' : 'no'}`,
      ].join(' · ')
    : null
  const linuxBackendTrace = trackingDiagnostics?.trackingStatus.backendTrace ?? []
  const linuxBackendLabel = trackingDiagnostics?.trackingStatus.lastResolvedWindow?.backend
    ?? trackingDiagnostics?.trackingStatus.moduleSource
    ?? null
  const currentPlatform = trackingDiagnostics?.platform ?? null
  const quickAccessCopy = getQuickAccessExpectation(currentPlatform)
  const launchOnLoginDescription = getLaunchOnLoginDescription(currentPlatform)

  return (
    <div style={{ padding: '30px 32px 48px', maxWidth: 1080 }}>
      <div style={{ marginBottom: 24, maxWidth: 680 }}>
        <h1 style={{ fontSize: 32, lineHeight: 1.05, letterSpacing: '-0.03em', margin: 0, color: 'var(--color-text-primary)' }}>
          Settings
        </h1>
      </div>

      <div style={settingsSurfaceStyle}>
        <SettingsSection
          first
          title="Tracking"
          description="Runs quietly in the background."
        >
          <div>
            <SettingsRow
              first
              title="Automatic tracking"
              description="Keeps tracking while the main window is closed."
              control={<StatusPill label="Active" tone="success" />}
            />
            <SettingsRow
              title="Launch on login"
              description={launchOnLoginDescription}
              control={<Toggle checked={settings.launchOnLogin} onChange={(value) => void persist({ launchOnLogin: value })} />}
            />
            <div style={infoPanelStyle}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                {quickAccessCopy.title}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                {quickAccessCopy.body}
              </div>
            </div>
            {trackingDiagnostics?.platform === 'linux' && linuxTracking && (
              <div style={infoPanelStyle}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                      Linux tracking
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.65, marginTop: 6 }}>
                      {linuxTracking.supportMessage}
                    </div>
                  </div>
                  <StatusPill label={linuxTracking.supportLevel} tone={linuxSupportTone} />
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                  Session: {linuxTracking.sessionType || 'unknown'}
                  {linuxTracking.desktop ? ` · Desktop: ${linuxTracking.desktop}` : ''}
                  {linuxBackendLabel ? ` · Backend: ${linuxBackendLabel}` : ''}
                </div>
                {linuxHelperSummary && (
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                    Helpers: {linuxHelperSummary}
                  </div>
                )}
                {linuxDesktop && (
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                    Secure store: {linuxDesktop.secureStoreAvailable ? 'ready' : 'limited'}
                    {linuxDesktop.secretServiceReachable === false ? ' · Secret Service unreachable' : ''}
                    {linuxDesktop.packageType ? ` · Package: ${linuxDesktop.packageType}` : ''}
                  </div>
                )}
                {linuxBackendTrace.length > 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.65 }}>
                    Trace: {linuxBackendTrace.join(' | ')}
                  </div>
                )}
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          title="Sync"
          description="Link this device to a Daylens workspace for browser linking and editor context."
        >
          <div>
            <SettingsRow
              first
              title="Workspace status"
              description={
                syncStatus?.isLinked
                  ? `Linked${syncStatus.workspaceId ? ` to ${syncStatus.workspaceId}` : ''}. Last sync: ${formatSyncTimestamp(syncStatus.lastSyncAt)}`
                  : 'This device is local-only.'
              }
              control={<StatusPill label={syncStatus?.isLinked ? 'Linked' : 'Local only'} tone={syncStatus?.isLinked ? 'success' : 'neutral'} />}
            />
            <SettingsRow
              title={syncStatus?.isLinked ? 'Workspace actions' : 'Create workspace'}
              description={
                syncStatus?.isLinked
                  ? 'New browser link, reveal recovery words, or disconnect.'
                  : 'Creates an anonymous workspace and stores recovery words locally.'
              }
              align="start"
              control={
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {!syncStatus?.isLinked && (
                    <button
                      type="button"
                      onClick={() => void handleCreateWorkspace()}
                      disabled={syncBusy !== null}
                      style={{ ...inlineButtonStyle, opacity: syncBusy !== null ? 0.6 : 1, cursor: syncBusy !== null ? 'default' : 'pointer' }}
                    >
                      {syncBusy === 'link' ? 'Creating…' : 'Create workspace'}
                    </button>
                  )}
                  {syncStatus?.isLinked && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleCreateBrowserLink()}
                        disabled={syncBusy !== null}
                        style={{ ...inlineButtonStyle, opacity: syncBusy !== null ? 0.6 : 1, cursor: syncBusy !== null ? 'default' : 'pointer' }}
                      >
                        {syncBusy === 'browser-link' ? 'Preparing…' : 'Create browser link'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRevealMnemonic()}
                        disabled={syncBusy !== null}
                        style={{ ...inlineButtonStyle, opacity: syncBusy !== null ? 0.6 : 1, cursor: syncBusy !== null ? 'default' : 'pointer' }}
                      >
                        {syncBusy === 'mnemonic' ? 'Loading…' : 'Reveal recovery words'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDisconnectWorkspace()}
                        disabled={syncBusy !== null}
                        style={{
                          ...inlineButtonStyle,
                          color: '#f87171',
                          opacity: syncBusy !== null ? 0.6 : 1,
                          cursor: syncBusy !== null ? 'default' : 'pointer',
                        }}
                      >
                        {syncBusy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    </>
                  )}
                </div>
              }
            />

            {browserLink && (
              <div style={infoPanelStyle}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                  Browser link
                </div>
                <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                  Code <strong style={{ color: 'var(--color-text-primary)' }}>{browserLink.displayCode}</strong> is ready. The full token stays local until you paste it into the Daylens browser or MCP linking flow.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <code style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--color-surface-high)', color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>
                    {browserLink.fullToken}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyValue(browserLink.fullToken)}
                    style={inlineButtonStyle}
                  >
                    Copy token
                  </button>
                </div>
              </div>
            )}

            {workspaceMnemonic && (
              <div style={infoPanelStyle}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                  Recovery words
                </div>
                <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                  These words recover the workspace identity. Treat them like a password.
                </div>
                <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--color-surface-high)', color: 'var(--color-text-primary)', fontSize: 13, lineHeight: 1.7 }}>
                  {workspaceMnemonic}
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => void copyValue(workspaceMnemonic)}
                    style={inlineButtonStyle}
                  >
                    Copy recovery words
                  </button>
                </div>
              </div>
            )}

            {syncNote && (
              <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                {syncNote}
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          title="AI"
          description="Optional provider access for grounded questions and reports."
        >
          <div style={{ display: 'grid', gap: 18 }}>
            <ConnectAI
              variant="embedded"
              initialProvider={settings.aiProvider}
              hasSavedAccess={hasApiKey}
              onConnected={() => { void refreshAIAccess() }}
            />
            <div style={{ borderTop: '1px solid var(--color-border-ghost)', paddingTop: 16, display: 'grid', gap: 12 }}>
              <button
                type="button"
                onClick={() => setShowAdvancedAI((value) => !value)}
                style={{
                  justifySelf: 'start',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--color-text-tertiary)',
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                {showAdvancedAI ? 'Hide advanced AI controls' : 'Show advanced AI controls'}
              </button>
              {showAdvancedAI && (
                <div style={{ display: 'grid', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
                      Routing strategy
                    </div>
                    <Segmented<AIModelStrategy>
                      value={settings.aiModelStrategy}
                      options={[
                        { value: 'quality', label: 'Best quality' },
                        { value: 'balanced', label: 'Balanced' },
                        { value: 'economy', label: 'Cheapest' },
                        { value: 'custom', label: 'Custom' },
                      ]}
                      onChange={(value) => void persist({ aiModelStrategy: value })}
                    />
                  </div>

                  <div>
                    <SettingsRow
                      first
                      title="Anthropic model"
                      description="Applied when strategy is Custom."
                      control={
                        <Select<string>
                          value={settings.anthropicModel}
                          width={228}
                          options={ANTHROPIC_MODEL_OPTIONS}
                          onChange={(value) => void persist({ anthropicModel: value })}
                        />
                      }
                    />
                    <SettingsRow
                      title="OpenAI model"
                      description="Applied when strategy is Custom."
                      control={
                        <Select<string>
                          value={settings.openaiModel}
                          width={228}
                          options={OPENAI_MODEL_OPTIONS}
                          onChange={(value) => void persist({ openaiModel: value })}
                        />
                      }
                    />
                    <SettingsRow
                      title="Fallback order"
                      description="Used when the preferred provider is unavailable."
                      control={
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                          {settings.aiFallbackOrder.map((provider, index) => (
                            <Select<AIProvider>
                              key={`${provider}:${index}`}
                              value={provider}
                              width={118}
                              options={API_PROVIDERS.map((entry) => ({ value: entry.id, label: `${index + 1}. ${entry.label}` }))}
                              onChange={(value) => {
                                const nextOrder = settings.aiFallbackOrder.slice() as AIProvider[]
                                nextOrder[index] = value
                                void persist({ aiFallbackOrder: normalizeFallbackOrder(nextOrder) })
                              }}
                            />
                          ))}
                        </div>
                      }
                      align="start"
                    />
                    <SettingsRow
                      title="Chat provider"
                      description="AI view and starter prompts."
                      control={
                        <Select<AIProviderMode>
                          value={settings.aiChatProvider ?? settings.aiProvider}
                          options={PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
                          onChange={(value) => void persist({ aiChatProvider: value })}
                        />
                      }
                    />
                    <SettingsRow
                      title="Block naming provider"
                      description="Closed-block relabeling and overnight cleanup."
                      control={
                        <Select<AIProviderMode>
                          value={settings.aiBlockNamingProvider ?? settings.aiProvider}
                          options={PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
                          onChange={(value) => void persist({ aiBlockNamingProvider: value })}
                        />
                      }
                    />
                    <SettingsRow
                      title="Summary provider"
                      description="Day, week, and app narratives."
                      control={
                        <Select<AIProviderMode>
                          value={settings.aiSummaryProvider ?? settings.aiProvider}
                          options={PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
                          onChange={(value) => void persist({ aiSummaryProvider: value })}
                        />
                      }
                    />
                    <SettingsRow
                      title="Artifact provider"
                      description="Reports, tables, charts, exports."
                      control={
                        <Select<AIProviderMode>
                          value={settings.aiArtifactProvider ?? settings.aiProvider}
                          options={PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
                          onChange={(value) => void persist({ aiArtifactProvider: value })}
                        />
                      }
                    />
                    <SettingsRow
                      title="Background enrichment"
                      description="Non-blocking relabel and cleanup jobs."
                      control={<Toggle checked={settings.aiBackgroundEnrichment ?? true} onChange={(value) => void persist({ aiBackgroundEnrichment: value })} />}
                    />
                    <SettingsRow
                      title="Active-block preview naming"
                      description="Provisional live labels while you work."
                      control={<Toggle checked={settings.aiActiveBlockPreview ?? false} onChange={(value) => void persist({ aiActiveBlockPreview: value })} />}
                    />
                    <SettingsRow
                      title="Prompt caching"
                      description="Provider-side caching for repeated prefixes."
                      control={<Toggle checked={settings.aiPromptCachingEnabled ?? true} onChange={(value) => void persist({ aiPromptCachingEnabled: value })} />}
                    />
                    <SettingsRow
                      title="Spend soft limit (USD)"
                      control={
                        <input
                          type="number"
                          min={0}
                          max={500}
                          step={1}
                          value={settings.aiSpendSoftLimitUsd ?? 10}
                          onChange={(event) => void persist({ aiSpendSoftLimitUsd: Math.max(0, Number(event.target.value) || 0) })}
                          style={inputStyle(84)}
                        />
                      }
                    />
                    <SettingsRow
                      title="Redact file paths"
                      description="Mask local paths in cloud prompts."
                      control={<Toggle checked={settings.aiRedactFilePaths ?? false} onChange={(value) => void persist({ aiRedactFilePaths: value })} />}
                    />
                    <SettingsRow
                      title="Redact email addresses"
                      description="Mask email-style strings in cloud prompts."
                      control={<Toggle checked={settings.aiRedactEmails ?? false} onChange={(value) => void persist({ aiRedactEmails: value })} />}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Labels"
          description="Override categories for apps Daylens has seen."
        >
          <div>
            {recentApps.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                Needs a little more tracked history first.
              </div>
            ) : (
              recentApps.map((summary, index) => {
                const override = categoryOverrides[summary.bundleId]
                const effectiveCategory = override ?? summary.category
                const busy = categoryBusyBundleId === summary.bundleId
                return (
                  <SettingsRow
                    key={summary.bundleId}
                    first={index === 0}
                    title={summary.appName}
                    description={`${formatDurationShort(summary.totalSeconds)} over 30 days${override ? ` · override: ${CATEGORY_OPTIONS.find((option) => option.value === override)?.label ?? override}` : ''}`}
                    control={
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        <Select<AppCategory>
                          value={effectiveCategory}
                          width={150}
                          options={CATEGORY_OPTIONS}
                          onChange={(value) => void handleCategoryOverrideChange(summary.bundleId, value)}
                        />
                        {override && (
                          <button
                            type="button"
                            onClick={() => void handleCategoryOverrideClear(summary.bundleId)}
                            disabled={busy}
                            style={{ ...inlineButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    }
                  />
                )
              })
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          title="Notifications"
          description="Nudges that help you close the day well."
        >
          <div>
            <SettingsRow
              first
              title="Daily recap"
              description="End-of-day recap from your local summary."
              control={<Toggle checked={settings.dailySummaryEnabled ?? true} onChange={(value) => void persist({ dailySummaryEnabled: value })} />}
            />
            <SettingsRow
              title="Morning nudge"
              description="Reminder if the day has started and tracking is quiet."
              control={<Toggle checked={settings.morningNudgeEnabled ?? true} onChange={(value) => void persist({ morningNudgeEnabled: value })} />}
            />
            <SettingsRow
              title="Distraction alerts"
              description="Warn when a focus session drifts."
              control={<Toggle checked={settings.distractionAlertsEnabled ?? false} onChange={(value) => void persist({ distractionAlertsEnabled: value })} />}
            />
            <SettingsRow
              title="Distraction threshold (minutes)"
              control={
                <input
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={settings.distractionAlertThresholdMinutes ?? 10}
                  onChange={(event) => {
                    const minutes = Math.max(1, Number(event.target.value) || 10)
                    void persist({ distractionAlertThresholdMinutes: minutes })
                    void ipc.distractionAlerter.setThreshold({ minutes })
                  }}
                  style={inputStyle(72)}
                />
              }
            />
            {trackingDiagnostics?.platform === 'linux' && linuxDesktop && !linuxDesktop.notificationSupported && (
              <div style={infoPanelStyle}>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                  Desktop notifications are unavailable in this Linux session right now, so Daylens can keep tracking but distraction alerts and recaps may not surface as native notifications until the session notification service is available.
                </div>
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          title="Appearance"
          description="Window theme."
        >
          <div>
            <SettingsRow
              first
              align="start"
              title="Theme"
              description="Follow the system, or pin to light or dark."
              control={
                <Segmented<AppTheme>
                  value={settings.theme}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                  onChange={(value) => {
                    void persist({ theme: value })
                    window.dispatchEvent(new CustomEvent('daylens:theme-changed', { detail: value }))
                  }}
                />
              }
            />
          </div>
        </SettingsSection>

        <UpdatesSection />

        <SettingsSection
          title="Privacy"
          description="History stays local. Telemetry never includes titles, paths, URLs, or prompt text."
        >
          <div>
            <SettingsRow
              first
              title="Analytics"
              description="Anonymous product telemetry."
              control={<Toggle checked={settings.analyticsOptIn} onChange={(value) => void persist({ analyticsOptIn: value })} />}
            />
            <SettingsRow
              title="Local data"
              description="Tracked history lives in the local Daylens database."
              control={<StatusPill label="Local only" />}
            />
            <SettingsRow
              title="Website icon fallback"
              description="Allow a domain-only fallback when no local favicon exists."
              control={<Toggle checked={settings.allowThirdPartyWebsiteIconFallback ?? true} onChange={(value) => void persist({ allowThirdPartyWebsiteIconFallback: value })} />}
            />
          </div>
        </SettingsSection>
      </div>
    </div>
  )
}

function inputStyle(width = 220): CSSProperties {
  return {
    width,
    height: 34,
    borderRadius: 9,
    border: '1px solid var(--color-border-ghost)',
    background: 'var(--color-surface-high)',
    color: 'var(--color-text-primary)',
    padding: '0 12px',
    outline: 'none',
    fontSize: 12.5,
  }
}
