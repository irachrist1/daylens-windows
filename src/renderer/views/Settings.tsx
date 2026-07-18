import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { ANALYTICS_EVENT } from '@shared/analytics'
import type {
  AppCategory,
  AppSettings,
  AppTheme,
  AppUsageSummary,
  BillingAccessSnapshot,
  BillingUsageReport,
  ClientRecord,
  TrackingDiagnosticsPayload,
  NotificationPermissionState,
  WorkMemoryFact,
  ClientMemoryGroup,
  MemoryAuditEntry,
  EnrichmentSourcesState,
} from '@shared/types'
import { ACTIVITY_COLOR_CHOICES, ACTIVITY_COLOR_GROUPS, applyAppearanceSettings } from '@shared/activityColors'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { setPendingChatSeed } from '../lib/aiSeed'
import { showIntercom } from '../lib/intercom'
import type { UpdaterStatusInfo } from '../../preload/index'
import ConnectAI from '../components/ConnectAI'
import { formatUsdAmount } from '@shared/formatUsd'
import { CHANGELOG, LATEST_CHANGELOG, formatChangelogDate, changelogIssueLabel, type ChangelogEntry } from '@shared/changelog'
import { ALL_ACTIVITY_CATEGORY_OPTIONS } from '@shared/activityCategories'
import { claudeDesktopConfigDisplayPath } from '@shared/platformPaths'

const CATEGORY_OPTIONS: Array<{ value: AppCategory; label: string }> = ALL_ACTIVITY_CATEGORY_OPTIONS

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

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.09em',
      textTransform: 'uppercase',
      color: 'var(--color-text-secondary)',
      opacity: 0.65,
      marginBottom: 10,
    }}>
      {children}
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

// Settings → General → Activity colors. One row per activity group (the five
// kinds of work the calendar draws), each with the curated swatch palette.
// Picking a group's default is the same as resetting it, so overrides only
// persist for real changes and "Reset colors" simply clears the map.
function ActivityColorRows({
  overrides,
  onChange,
}: {
  overrides: Partial<Record<AppCategory, string>>
  onChange: (next: Partial<Record<AppCategory, string>>) => void
}) {
  return (
    <div style={{ display: 'grid', gap: 12, padding: '2px 0 14px' }}>
      {ACTIVITY_COLOR_GROUPS.map((group) => {
        const current = overrides[group.categories[0]] ?? group.defaultColor
        return (
          <div key={group.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{group.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{group.hint}</div>
            </div>
            <div role="radiogroup" aria-label={`${group.label} color`} style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
              {ACTIVITY_COLOR_CHOICES.map((choice) => {
                const selected = choice.hex.toLowerCase() === current.toLowerCase()
                return (
                  <button
                    key={choice.hex}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${choice.name}${choice.hex.toLowerCase() === group.defaultColor.toLowerCase() ? ' (default)' : ''}`}
                    title={choice.name}
                    onClick={() => {
                      const next = { ...overrides }
                      for (const category of group.categories) {
                        if (choice.hex.toLowerCase() === group.defaultColor.toLowerCase()) delete next[category]
                        else next[category] = choice.hex
                      }
                      onChange(next)
                    }}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      background: choice.hex,
                      boxShadow: selected
                        ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${choice.hex}`
                        : 'none',
                    }}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
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

// One focused settings page: a title + optional lead-in, then its controls
// stacked in a single column. This replaces the old long-scroll layout where
// every section shared one surface; now each section is its own page in the
// content pane, selected from the left rail.
function SectionPage({
  title,
  description,
  children,
  maxWidth = 640,
}: {
  title: string
  description?: string
  children: ReactNode
  maxWidth?: number
}) {
  return (
    <section style={{ maxWidth, display: 'grid', gap: 20 }}>
      <header style={{ display: 'grid', gap: 6 }}>
        <h2 style={{ fontSize: 20, fontWeight: 680, letterSpacing: '-0.02em', margin: 0, color: 'var(--color-text-primary)' }}>
          {title}
        </h2>
        {description && (
          <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.6, margin: 0 }}>
            {description}
          </p>
        )}
      </header>
      <div style={{ display: 'grid', gap: 18 }}>
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
    case 'available':
      return `Daylens ${status.version ?? 'update'} is available — install when you want Daylens to download and replace the app.`
    case 'downloading':
      return typeof status.progressPct === 'number'
        ? `Downloading ${status.version ?? 'update'} — ${status.progressPct}%`
        : `Downloading ${status.version ?? 'update'}…`
    case 'downloaded':
      return `${status.version ?? 'Update'} ready to install. Restart to finish.`
    case 'installing':
      return `Installing ${status.version ?? 'update'} and relaunching…`
    case 'not-available':
      return version ? `You're on the latest version (${version}).` : 'No updates available.'
    case 'error':
      return status.errorMessage ?? 'Update check failed.'
    case 'idle':
    default:
      return version ? `Current version: ${version}.` : 'Ready.'
  }
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

// A quiet, borderless text action (Edit / Forget) revealed on row hover in the
// Manage-memory view — so memory reads as plain sentences, not a control panel.
const memoryActionStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  cursor: 'pointer',
}

const CHANGELOG_SERIF = 'Georgia, "Times New Roman", "Iowan Old Style", serif'

// One release, told as a feature story: a dateline, a big serif headline, a
// human paragraph, and a gradient hero illustration. The newest release is the
// lead; older ones render compact below.
function ChangelogHeroStory({ entry }: { entry: ChangelogEntry }) {
  return (
    <article style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
        <span>{changelogIssueLabel(entry.issue)}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{formatChangelogDate(entry.date)}</span>
      </div>
      <h3 style={{ fontFamily: CHANGELOG_SERIF, fontSize: 34, lineHeight: 1.12, fontWeight: 600, letterSpacing: '-0.01em', margin: 0, color: 'var(--color-text-primary)' }}>
        {entry.headline}
      </h3>
      <p style={{ fontFamily: CHANGELOG_SERIF, fontSize: 17, lineHeight: 1.45, fontStyle: 'italic', margin: 0, color: 'var(--color-text-secondary)' }}>
        {entry.dek}
      </p>
      <div
        aria-hidden
        style={{
          position: 'relative',
          height: 200,
          borderRadius: 18,
          overflow: 'hidden',
          background: `linear-gradient(135deg, ${entry.hero.from}, ${entry.hero.to})`,
          boxShadow: '0 18px 50px rgba(0,0,0,0.16)',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 80% at 80% 0%, rgba(255,255,255,0.35), rgba(255,255,255,0) 60%)' }} />
        <div style={{ position: 'absolute', left: 22, bottom: 18, right: 22, color: 'rgba(255,255,255,0.96)' }}>
          <div style={{ fontSize: 11.5, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700, opacity: 0.9 }}>Daylens {entry.version}</div>
          <div style={{ fontFamily: CHANGELOG_SERIF, fontSize: 22, fontWeight: 600, marginTop: 4, textShadow: '0 1px 12px rgba(0,0,0,0.25)' }}>{entry.headline}</div>
        </div>
      </div>
      <p style={{ fontSize: 14, lineHeight: 1.7, margin: 0, color: 'var(--color-text-secondary)' }}>
        {entry.body}
      </p>
      {entry.notes && entry.notes.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 2 }}>
          <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-tertiary)', fontWeight: 700 }}>Also in this release</div>
          {entry.notes.map((note) => (
            <div key={note} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
              <span style={{ width: 5, height: 5, borderRadius: 999, background: entry.hero.accent, flexShrink: 0, transform: 'translateY(-2px)' }} />
              <span>{note}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function ChangelogContent({ appVersion }: { appVersion: string | null }) {
  const latest = LATEST_CHANGELOG
  const older = CHANGELOG.slice(1)
  return (
    <div style={{ border: '1px solid var(--color-border-ghost)', borderRadius: 18, overflow: 'hidden', background: 'var(--color-surface)' }}>
      {/* Masthead */}
      <div style={{ padding: '22px 24px 18px', borderBottom: '1px solid var(--color-border-ghost)', textAlign: 'center', display: 'grid', gap: 6 }}>
        <div style={{ fontFamily: CHANGELOG_SERIF, fontSize: 30, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--color-text-primary)' }}>
          Daylens Notes
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
          New features · how Daylens keeps getting better
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4, letterSpacing: '0.04em' }}>
          {changelogIssueLabel(latest.issue)}{appVersion ? ` · Daylens ${appVersion}` : ` · Daylens ${latest.version}`}
        </div>
      </div>
      {/* Lead story */}
      <div style={{ padding: '24px' }}>
        <ChangelogHeroStory entry={latest} />
      </div>
      {/* Older issues */}
      {older.length > 0 && (
        <div style={{ borderTop: '1px solid var(--color-border-ghost)', padding: '18px 24px 22px', background: 'var(--color-surface-low)', display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-tertiary)', fontWeight: 700 }}>Earlier issues</div>
          {older.map((entry) => (
            <div key={entry.issue} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div aria-hidden style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0, background: `linear-gradient(135deg, ${entry.hero.from}, ${entry.hero.to})`, boxShadow: '0 4px 14px rgba(0,0,0,0.12)' }} />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <div style={{ fontFamily: CHANGELOG_SERIF, fontSize: 15.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{entry.headline}</div>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{entry.dek}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{changelogIssueLabel(entry.issue)} · Daylens {entry.version} · {formatChangelogDate(entry.date)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function UpdatesContent() {
  const [status, setStatus] = useState<UpdaterStatusInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  useEffect(() => {
    void ipc.updater.getStatus().then((info) => {
      setStatus(info)
      if (info.version) setCurrentVersion((prev) => prev ?? info.version)
    })
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
  const isAvailableManual = status?.status === 'available' && !!status.downloadUrl
  // Explicit false only — the updater refuses in-place install when the feed
  // published no verification digest for the artifact.
  const canAutoInstall = status?.canAutoInstall !== false
  const isBusy = checking || status?.status === 'checking' || status?.status === 'downloading' || status?.status === 'installing'

  return (
      <div style={{ display: 'grid', gap: 18 }}>
        <ChangelogContent appVersion={currentVersion} />
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
              {isAvailableManual && (
                <>
                  {canAutoInstall && (
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
                    Install update
                  </button>
                  )}
                  {status?.downloadUrl && (
                    <button
                      type="button"
                      onClick={() => { ipc.shell.openExternal(status.downloadUrl as string) }}
                      style={{
                        height: 32,
                        padding: '0 14px',
                        borderRadius: 8,
                        border: '1px solid var(--color-border-ghost)',
                        background: 'var(--color-surface-high)',
                        color: 'var(--color-text-primary)',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Download manually
                    </button>
                  )}
                </>
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
      </div>
  )
}

// T3 — Tracking Controls. Opt-in, off by default. Pause works regardless of the
// master switch. Adding an exclusion also deletes that app/site's existing
// history so it disappears from the timeline/Apps/AI/search.
function ExclusionEditor({
  label,
  placeholder,
  values,
  onAdd,
  onRemove,
  busy,
}: {
  label: string
  placeholder: string
  values: string[]
  onAdd: (value: string) => void
  onRemove: (value: string) => void
  busy: boolean
}) {
  const [draft, setDraft] = useState('')
  const submit = () => {
    const value = draft.trim()
    if (!value) return
    onAdd(value)
    setDraft('')
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>{label}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          placeholder={placeholder}
          disabled={busy}
          style={{ flex: 1, minWidth: 0, height: 34, padding: '0 12px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12.5, outline: 'none' }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !draft.trim()}
          style={{ height: 34, padding: '0 14px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 700, cursor: busy || !draft.trim() ? 'default' : 'pointer', opacity: busy || !draft.trim() ? 0.6 : 1 }}
        >
          Add
        </button>
      </div>
      {values.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {values.map((value) => (
            <div
              key={value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                borderRadius: 8,
                background: 'var(--color-surface-muted)',
                border: '1px solid var(--color-border-ghost)',
                fontSize: 12.5,
                color: 'var(--color-text-secondary)',
                minHeight: 34,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {value}
              </span>
              <button
                type="button"
                onClick={() => onRemove(value)}
                aria-label={`Remove ${value}`}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--color-text-tertiary)',
                  cursor: 'pointer',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 14,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CaptureHealthContent({
  diagnostics,
}: {
  diagnostics: TrackingDiagnosticsPayload | null
}) {
  const captureHealth = diagnostics?.captureHealth
  const [troubleshootOpen, setTroubleshootOpen] = useState(false)

  if (!captureHealth) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
        Waiting for capture data — this fills in once Daylens has been tracking for a few minutes.
      </div>
    )
  }

  const titleStatus = captureHealth.windowTitles.status
  const browserNames = captureHealth.browsers?.names ?? []
  const safariHistoryAccess = captureHealth.browsers?.safariHistoryAccess
  const permissions = captureHealth.permissions
  const linuxTracking = diagnostics?.linuxTracking
  const platform = diagnostics?.platform

  const tone: 'success' | 'warning' | 'neutral' = titleStatus === 'healthy'
    ? 'success'
    : titleStatus === 'missing'
      ? 'warning'
      : 'neutral'
  const captureHelperUnhealthy = captureHealth.captureHelperRunning === false
  // Full Disk Access gates Safari history specifically — it's tracked independently
  // of the window-title tone above (a user can have titles working fine while
  // Safari history is still blocked, or vice versa).
  const safariAccessDenied = platform === 'darwin' && safariHistoryAccess === 'denied'
  const hasIssue = tone === 'warning' || captureHelperUnhealthy || safariAccessDenied

  const headline = tone === 'success'
    ? 'Daylens is seeing your work'
    : tone === 'warning'
      ? 'Daylens can\u2019t see what you\u2019re working on'
      : 'Getting started'
  const body = tone === 'success'
    ? 'It\u2019s capturing what you\u2019re working on inside each app, not just which app is open.'
    : tone === 'warning'
      ? (permissions.platformNote
          ? permissions.platformNote
          : 'Daylens sees which apps are open but not the titles inside them. Granting the screen/accessibility permission usually fixes this.')
      : 'Daylens needs a few minutes of activity to confirm it\u2019s capturing properly.'
  const accent = tone === 'success'
    ? { border: '1px solid rgba(79, 219, 200, 0.24)', background: 'rgba(79, 219, 200, 0.08)' }
    : tone === 'warning'
      ? { border: '1px solid rgba(251, 191, 36, 0.28)', background: 'rgba(251, 191, 36, 0.08)' }
      : { border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)' }

  const troubleshootingSteps: Array<{ label: string; detail: string; action?: { label: string; url: string } }> = []

  if (tone === 'warning') {
    if (platform === 'darwin') {
      const screenMissing = permissions.screenRecording === 'missing'
      const accessibilityMissing = permissions.accessibility === 'missing'
      if (screenMissing) {
        troubleshootingSteps.push({
          label: 'Grant Screen Recording permission',
          detail: 'System Settings > Privacy & Security > Screen Recording. Enable Daylens, then restart the app.',
          action: { label: 'Open Settings', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' },
        })
      }
      if (accessibilityMissing) {
        troubleshootingSteps.push({
          label: 'Grant Accessibility permission',
          detail: 'System Settings > Privacy & Security > Accessibility. Enable Daylens, then restart the app.',
          action: { label: 'Open Settings', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' },
        })
      }
      if (!screenMissing && !accessibilityMissing) {
        troubleshootingSteps.push({
          label: 'Restart Daylens',
          detail: 'Permissions look granted but titles are still missing. Quit and reopen Daylens so the capture helper picks up the new permissions.',
        })
      }
    } else if (platform === 'win32') {
      troubleshootingSteps.push({
        label: 'Check Windows tracking permissions',
        detail: 'Daylens needs access to read window titles. If you dismissed the permission prompt on first launch, restart Daylens to re-trigger it.',
      })
    } else {
      troubleshootingSteps.push({
        label: 'Check Linux tracking support',
        detail: linuxTracking?.supportMessage ?? 'Window title capture on Linux depends on your desktop environment and accessibility bus.',
      })
    }
  }

  if (captureHelperUnhealthy) {
    troubleshootingSteps.push({
      label: 'Capture helper not running',
      detail: 'The background helper that reads window titles is not running. Restart Daylens to relaunch it.',
    })
  }

  if (safariAccessDenied) {
    troubleshootingSteps.push({
      label: 'Grant Full Disk Access for Safari history',
      detail: 'Safari browsing history needs Full Disk Access. System Settings > Privacy & Security > Full Disk Access. Enable Daylens — no restart needed, it’s picked up automatically on the next check.',
      action: { label: 'Open Settings', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles' },
    })
  }

  return (
      <div>
        <div style={{ padding: '16px 18px', borderRadius: 14, display: 'grid', gap: 6, ...accent }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 680, color: 'var(--color-text-primary)' }}>{headline}</span>
            <StatusPill label={tone === 'success' ? 'Healthy' : tone === 'warning' ? 'Needs attention' : 'Waiting'} tone={tone} />
            {hasIssue && (
              <button
                type="button"
                onClick={() => setTroubleshootOpen((value) => !value)}
                style={{
                  height: 30,
                  padding: '0 14px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--gradient-primary)',
                  color: 'var(--color-primary-contrast)',
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  marginLeft: 'auto',
                }}
              >
                {troubleshootOpen ? 'Hide steps' : 'Troubleshoot'}
              </button>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>{body}</div>
        </div>

        {hasIssue && troubleshootOpen && troubleshootingSteps.length > 0 && (
          <div style={{ marginTop: 14, padding: '16px 18px', borderRadius: 14, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', display: 'grid', gap: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 620, color: 'var(--color-text-primary)' }}>
              What to do
            </div>
            {troubleshootingSteps.map((step, index) => (
              <div key={index} style={{ display: 'grid', gap: 4 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {index + 1}. {step.label}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                  {step.detail}
                </div>
                {step.action && (
                  <button
                    type="button"
                    onClick={() => { ipc.shell.openExternal(step.action!.url) }}
                    style={{ ...inlineButtonStyle, marginTop: 4, alignSelf: 'flex-start' }}
                  >
                    {step.action.label}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <details style={{ marginTop: 16 }} open={!hasIssue || !troubleshootOpen}>
          <summary style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', cursor: 'pointer', fontWeight: 600, listStyle: 'none' }}>
            Troubleshooting details
          </summary>
          <div style={{ marginTop: 12 }}>
            {linuxTracking && (
              <SettingsRow
                first
                title="Linux session"
                description={linuxTracking.supportMessage}
                control={
                  <StatusPill
                    label={linuxTracking.supportLevel === 'ready' ? 'Ready' : linuxTracking.supportLevel === 'limited' ? 'Limited' : 'Unsupported'}
                    tone={linuxTracking.supportLevel === 'ready' ? 'success' : linuxTracking.supportLevel === 'limited' ? 'warning' : 'neutral'}
                  />
                }
              />
            )}
            <SettingsRow
              first={!linuxTracking}
              title="Recent samples with titles"
              description={`${captureHealth.windowTitles.recentSamplesWithTitle} of ${captureHealth.windowTitles.recentSamples} samples in the last 15 minutes carried a title.`}
              control={<StatusPill label={`${captureHealth.windowTitles.recentSamplesWithTitle}/${captureHealth.windowTitles.recentSamples}`} />}
            />
            <SettingsRow
              title="Browsers discovered"
              description={browserNames.length > 0 ? browserNames.join(', ') : 'No browser history locations found yet.'}
              control={<StatusPill label={String(captureHealth.browsers?.discoveredCount ?? 0)} />}
            />
            {platform === 'darwin' && safariHistoryAccess && (
              <SettingsRow
                title="Safari history access"
                description={
                  safariHistoryAccess === 'ok'
                    ? 'Full Disk Access is granted — Safari browsing history is being captured.'
                    : safariHistoryAccess === 'denied'
                      ? 'Safari browsing history needs Full Disk Access to be captured.'
                      : 'Not yet checked — this fills in after the first Safari history poll.'
                }
                control={
                  <StatusPill
                    label={safariHistoryAccess === 'ok' ? 'Granted' : safariHistoryAccess === 'denied' ? 'Needs access' : 'Unknown'}
                    tone={safariHistoryAccess === 'ok' ? 'success' : safariHistoryAccess === 'denied' ? 'warning' : 'neutral'}
                  />
                }
              />
            )}
            {typeof captureHealth.captureHelperRunning === 'boolean' && (
              <SettingsRow
                title="Capture helper"
                description="The background helper that reads window titles."
                control={<StatusPill label={captureHealth.captureHelperRunning ? 'Running' : 'Not running'} tone={captureHealth.captureHelperRunning ? 'success' : 'warning'} />}
              />
            )}
          </div>
        </details>
      </div>
  )
}

function TrackingControlsContent({
  settings,
  persist,
}: {
  settings: AppSettings
  persist: (partial: Partial<AppSettings>) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const [privacyError, setPrivacyError] = useState<string | null>(null)
  const enabled = settings.trackingControlsEnabled ?? false
  const excludedApps = settings.trackingExcludedApps ?? []
  const excludedSites = settings.trackingExcludedSites ?? []

  const normalizeSite = (raw: string) => raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')

  const addApp = async (value: string) => {
    if (excludedApps.some((a) => a.toLowerCase() === value.toLowerCase())) return
    setBusy(true)
    setPrivacyError(null)
    try {
      const saved = await persist({ trackingExcludedApps: [...excludedApps, value] })
      if (!saved) return
      // Remove what was already captured so it disappears from history, not just future capture.
      await ipc.tracking.deleteAppHistory({ bundleId: value, appName: value })
    } catch (error) {
      setPrivacyError(`The exclusion was saved, but existing history could not be removed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  const removeApp = (value: string) => void persist({ trackingExcludedApps: excludedApps.filter((a) => a !== value) })

  const addSite = async (raw: string) => {
    const value = normalizeSite(raw)
    if (!value || excludedSites.some((s) => s.toLowerCase() === value)) return
    setBusy(true)
    setPrivacyError(null)
    try {
      const saved = await persist({ trackingExcludedSites: [...excludedSites, value] })
      if (!saved) return
      await ipc.tracking.deleteSiteHistory({ domain: value })
    } catch (error) {
      setPrivacyError(`The exclusion was saved, but existing history could not be removed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  const removeSite = (value: string) => void persist({ trackingExcludedSites: excludedSites.filter((s) => s !== value) })

  return (
    <>
      <SettingsRow
        first
        title="Pause tracking"
        description="Temporarily stop recording all activity. Stays paused until you turn it back on, even after a restart."
        control={<Toggle checked={settings.trackingPaused ?? false} onChange={(value) => void persist({ trackingPaused: value })} />}
      />
      <SettingsRow
        title="Limit what's tracked"
        description="Off by default — Daylens records everything. Turn this on to keep specific apps, sites, and private windows out of your history and AI answers."
        control={<Toggle checked={enabled} onChange={(value) => void persist({ trackingControlsEnabled: value })} />}
      />
      {enabled && (
        <>
          {privacyError && <div style={{ color: '#f87171', fontSize: 12.5, lineHeight: 1.5, padding: '8px 0' }}>{privacyError}</div>}
          <SettingsRow
            title="Skip private / incognito windows"
            description="When on, Daylens records nothing from a browser's incognito or private window — no URL, page title, or session."
            control={<Toggle checked={settings.trackingSkipIncognito ?? true} onChange={(value) => void persist({ trackingSkipIncognito: value })} />}
          />
          <ExclusionEditor
            label="Excluded apps"
            placeholder="App name (e.g. Messages) or bundle id"
            values={excludedApps}
            onAdd={(value) => void addApp(value)}
            onRemove={removeApp}
            busy={busy}
          />
          <div style={{ borderTop: '1px solid var(--color-border-ghost)', margin: '4px 0' }} />
          <ExclusionEditor
            label="Excluded sites"
            placeholder="Domain (e.g. youtube.com)"
            values={excludedSites}
            onAdd={(value) => void addSite(value)}
            onRemove={removeSite}
            busy={busy}
          />
        </>
      )}
    </>
  )
}

// ─── Section model ──────────────────────────────────────────────────────────
// The left rail is grouped, Claude-style. Each id maps to one focused page in
// the content pane. Adding a future section (e.g. richer Billing in DEV-106) is
// just a new entry here plus a case in renderSection — the shell holds it.
type SectionId =
  | 'general' | 'notifications' | 'billing' | 'usage'
  | 'ai' | 'memory'
  | 'labels' | 'clients' | 'privacy'
  | 'mcp' | 'enrichment' | 'capture' | 'updates' | 'help'

interface SectionDef { id: SectionId; label: string; keywords: string }
interface SectionGroup { label: string; items: SectionDef[] }

const SECTION_GROUPS: SectionGroup[] = [
  {
    label: 'Account',
    items: [
      { id: 'general', label: 'General', keywords: 'name profile display persona theme appearance light dark look system colors activity color palette dim leisure blocks' },
      { id: 'notifications', label: 'Notifications', keywords: 'morning brief evening wrap distraction alerts' },
      { id: 'billing', label: 'Billing', keywords: 'plan subscription subscribe upgrade payment credit free key' },
      { id: 'usage', label: 'Usage', keywords: 'credit meter cost spend remaining' },
    ],
  },
  {
    label: 'AI',
    items: [
      { id: 'ai', label: 'Provider & model', keywords: 'anthropic openai google claude api key model gpt gemini' },
      { id: 'memory', label: 'Memory', keywords: 'work memory facts remember knows about you' },
    ],
  },
  {
    label: 'Activity & data',
    items: [
      { id: 'labels', label: 'Labels', keywords: 'category app override propagate zen browsing' },
      { id: 'clients', label: 'Clients', keywords: 'project attribution company work' },
      { id: 'privacy', label: 'Privacy & tracking', keywords: 'pause exclude excluded incognito private analytics local data' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'mcp', label: 'MCP server', keywords: 'claude desktop cursor query external clients' },
      { id: 'enrichment', label: 'Enrichment sources', keywords: 'wrapped git calendar notion linear jira focus mcp connectors signals' },
      { id: 'capture', label: 'Capture health', keywords: 'window titles permissions browsers samples' },
      { id: 'updates', label: 'Updates', keywords: 'version install download release' },
      { id: 'help', label: 'Help & support', keywords: 'chat support contact message question bug feedback talk intercom' },
    ],
  },
]

const ALL_SECTIONS: SectionDef[] = SECTION_GROUPS.flatMap((group) => group.items)

function isSectionId(value: string | null): value is SectionId {
  return value !== null && ALL_SECTIONS.some((section) => section.id === value)
}

// One line-icon per section — the visual anchor that makes the rail scan as
// navigation (each row recognizable at a glance, the way Claude's settings do).
function SectionIcon({ id }: { id: SectionId }) {
  const p: Record<SectionId, ReactNode> = {
    general: <><circle cx="8" cy="5.5" r="2.4" /><path d="M3.5 13c0-2.4 2-3.9 4.5-3.9s4.5 1.5 4.5 3.9" /></>,
    notifications: <><path d="M4.5 6.5a3.5 3.5 0 0 1 7 0c0 3 1.3 4 1.3 4H3.2s1.3-1 1.3-4Z" /><path d="M6.6 13a1.5 1.5 0 0 0 2.8 0" /></>,
    billing: <><rect x="2" y="4" width="12" height="8" rx="1.5" /><path d="M2 6.7h12" /></>,
    usage: <><path d="M2.6 11.5a5.4 5.4 0 1 1 10.8 0" /><path d="M8 11.5 10.4 8" /></>,
    ai: <path d="M8 2 L8.7 6 L12.8 7 L8.7 8 L8 12 L7.3 8 L3.2 7 L7.3 6 Z" />,
    memory: <><rect x="4" y="4" width="8" height="8" rx="1.6" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6" /></>,
    labels: <><path d="M2.6 7.4 7.2 2.8h4.2v4.2L6.8 11.6Z" /><circle cx="9.4" cy="5.6" r="0.85" fill="currentColor" stroke="none" /></>,
    clients: <><rect x="2.3" y="5" width="11.4" height="7.6" rx="1.2" /><path d="M6 5V3.6h4V5" /></>,
    privacy: <path d="M8 1.9 13 3.7v4.1c0 3-2.2 5-5 6.3-2.8-1.3-5-3.3-5-6.3V3.7Z" />,
    mcp: <><rect x="2" y="3" width="12" height="10" rx="1.6" /><path d="M4.6 6.6 7 8.5 4.6 10.4" /><path d="M8.4 10.4h3" /></>,
    enrichment: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" /></>,
    capture: <path d="M2 8h2.6l1.4-4.2 2.6 8.4 1.4-4.2H14" />,
    updates: <><path d="M8 2.6v6.8" /><path d="M5.2 7 8 9.8 10.8 7" /><path d="M3.2 13h9.6" /></>,
    help: <><path d="M2.6 3.4h10.8v7.2H8.4L5.4 13.2v-2.6H2.6Z" /><path d="M5.4 6.4h5.2" /></>,
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      {p[id]}
    </svg>
  )
}

function RailItem({
  item,
  active,
  onSelect,
}: {
  item: SectionDef
  active: boolean
  onSelect: (id: SectionId) => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-current={active ? 'page' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        letterSpacing: '-0.01em',
        cursor: 'pointer',
        color: active || hovered ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        background: active ? 'var(--color-surface-low)' : hovered ? 'var(--color-pill-bg)' : 'transparent',
        border: active ? '1px solid var(--color-border-ghost)' : '1px solid transparent',
        opacity: active ? 1 : 0.82,
        transition: 'all 140ms',
      }}
    >
      <span style={{ display: 'flex', color: active ? 'var(--color-primary-glow)' : 'currentColor' }}>
        <SectionIcon id={item.id} />
      </span>
      {item.label}
    </button>
  )
}

function SettingsRail({
  active,
  onSelect,
  search,
  onSearch,
}: {
  active: SectionId
  onSelect: (id: SectionId) => void
  search: string
  onSearch: (value: string) => void
}) {
  const query = search.trim().toLowerCase()
  const matches = (item: SectionDef) =>
    query === ''
    || item.label.toLowerCase().includes(query)
    || item.keywords.includes(query)
  const groups = SECTION_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(matches) }))
    .filter((group) => group.items.length > 0)

  return (
    <aside
      style={{
        width: 232,
        flexShrink: 0,
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        borderRight: '1px solid var(--color-border-ghost)',
        background: 'var(--color-sidebar-bg)',
        padding: '30px 16px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <input
        type="text"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Search settings…"
        aria-label="Search settings"
        style={{
          width: '100%',
          height: 32,
          padding: '0 10px',
          borderRadius: 8,
          border: '1px solid var(--color-border-ghost)',
          background: 'var(--color-surface-high)',
          color: 'var(--color-text-primary)',
          fontSize: 12.5,
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {groups.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', padding: '4px 2px', lineHeight: 1.5 }}>
            No settings match “{search.trim()}”.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                color: 'var(--color-text-secondary)',
                opacity: 0.65,
                padding: '0 10px 6px',
              }}>
                {group.label}
              </div>
              {group.items.map((item) => (
                <RailItem key={item.id} item={item} active={item.id === active} onSelect={onSelect} />
              ))}
            </div>
          ))
        )}
      </nav>
    </aside>
  )
}

// ─── Billing & Usage (the shell DEV-106 fills) ────────────────────────────────
// Honest scaffolds: the structure billing plugs into, populated only with what's
// true today (which AI mode you're in) and clearly-marked "arriving with billing"
// notes. No fake numbers, no inert controls — every control here actually does
// something (the "Set up in AI" button jumps to the AI page). Settings invariant
// #1 and billing invariant #8 (no dark patterns) hold even while it's a scaffold.

const KEY_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'claude-cli': 'Claude CLI',
  openai: 'OpenAI',
  'chatgpt-cli': 'ChatGPT CLI',
  'gemini-cli': 'Gemini CLI',
  'codex-cli': 'Codex CLI',
  google: 'Google',
  openrouter: 'OpenRouter',
}

type CLIToolDetection = {
  claude: string | null
  chatgpt: string | null
  gemini: string | null
  codex: string | null
}

function cliToolForProvider(provider: string): keyof CLIToolDetection | null {
  if (provider === 'claude-cli') return 'claude'
  if (provider === 'chatgpt-cli') return 'chatgpt'
  if (provider === 'gemini-cli') return 'gemini'
  if (provider === 'codex-cli') return 'codex'
  return null
}

// The provider's display name, or null when we don't have a friendly label —
// callers phrase the fallback so it never reads "your own your provider key".
function providerName(provider: string): string | null {
  return KEY_PROVIDER_LABELS[provider] ?? null
}

function PlanCard({
  name,
  blurb,
  active,
  action,
}: {
  name: string
  blurb: string
  active?: boolean
  action?: ReactNode
}) {
  return (
    <div style={{
      padding: '16px 18px',
      borderRadius: 14,
      border: active ? '1px solid var(--color-glass-border)' : '1px solid var(--color-border-ghost)',
      background: active ? 'var(--color-accent-dim)' : 'var(--color-surface-low)',
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 680, color: 'var(--color-text-primary)' }}>{name}</span>
        {active && <StatusPill label="Current" tone="success" />}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{blurb}</div>
      {action && <div style={{ marginTop: 2 }}>{action}</div>}
    </div>
  )
}

function BillingPage({
  hasAiAccess,
  provider,
  onGoToAI,
}: {
  hasAiAccess: boolean
  provider: string
  onGoToAI: () => void
}) {
  const onOwnKey = hasAiAccess
  const [access, setAccess] = useState<BillingAccessSnapshot | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    const next = await ipc.billing.refresh()
    setAccess(next)
  }

  useEffect(() => {
    void ipc.billing.getAccess().then(setAccess).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [])

  // paywall_seen: once per Billing-page open, when the page shows plans the
  // user could buy (not when a subscription is already active). Onboarding's
  // AI-setup plans screen is the other paywall surface; it fires its own with
  // trigger 'onboarding'.
  const paywallTrackedRef = useRef(false)
  useEffect(() => {
    if (paywallTrackedRef.current || !access) return
    if (access.mode === 'subscription' || access.mode === 'local_pass') return
    paywallTrackedRef.current = true
    track(ANALYTICS_EVENT.PAYWALL_SEEN, { trigger: 'settings' })
  }, [access])

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const mode = onOwnKey ? 'own_key' : access?.mode
  return (
    <SectionPage
      title="Billing"
      description="How Daylens powers its AI. Start on free credit, subscribe when it runs out, or bring your own provider key and pay the provider directly."
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <PlanCard
          name="Free credit"
          active={mode === 'free_credit'}
          blurb={mode === 'free_credit'
            ? `$${(access?.creditRemainingUsd ?? 0).toFixed(2)} of your $5 credit remains. No card and no provider key.`
            : '$5 of AI on us when you start — no card, no key. It is granted once per person.'}
        />
        <PlanCard
          name="Subscription"
          active={mode === 'subscription'}
          blurb={mode === 'subscription'
            ? `Active${access?.renewalAt ? ` · renews ${new Date(access.renewalAt).toLocaleDateString()}` : ''}. Daylens handles the provider and tax; cancel whenever you want.`
            : 'A flat monthly plan through Polar. Daylens handles the provider and tax; your local history remains yours if you cancel.'}
          action={mode === 'subscription' && access?.portalAvailable ? (
            <button type="button" disabled={busy != null} onClick={() => void run('portal', () => ipc.billing.openPortal())} style={inlineButtonStyle}>
              {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
            </button>
          ) : access?.checkoutAvailable ? (
            <button type="button" disabled={busy != null} onClick={() => void run('polar', () => ipc.billing.createPolarCheckout('settings'))} style={{ ...inlineButtonStyle, border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)' }}>
              {busy === 'polar' ? 'Opening…' : 'See price and subscribe'}
            </button>
          ) : undefined}
        />
        <PlanCard
          name="Rwanda mobile money"
          active={mode === 'local_pass'}
          blurb={mode === 'local_pass'
            ? `Your 30-day access is active${access?.localPassExpiresAt ? ` until ${new Date(access.localPassExpiresAt).toLocaleDateString()}` : ''}.`
            : 'Pay with MTN or Airtel through Flutterwave for 30 days of managed AI. You re-authorize each renewal; we do not pretend it auto-renews.'}
          action={access?.localCheckoutAvailable ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Email for receipt"
                aria-label="Email for mobile money receipt"
                style={inputStyle(220)}
              />
              <button
                type="button"
                disabled={busy != null || !email.trim()}
                onClick={() => void run('flutterwave', () => ipc.billing.createFlutterwaveCheckout(email, 'settings'))}
                style={inlineButtonStyle}
              >
                {busy === 'flutterwave' ? 'Opening…' : 'Pay with mobile money'}
              </button>
            </div>
          ) : undefined}
        />
        <PlanCard
          name="Your own provider"
          active={onOwnKey}
          blurb={onOwnKey
            ? `You're using ${providerName(provider) ?? 'your own provider'}. Calls go straight from this machine — Daylens never bills you and never sees them.`
            : 'Use a provider key or local CLI and pay the provider directly. Calls go straight from your machine to the provider.'}
          action={
            <button
              type="button"
              onClick={onGoToAI}
              style={{ ...inlineButtonStyle, background: onOwnKey ? 'var(--color-surface-high)' : 'var(--gradient-primary)', color: onOwnKey ? 'var(--color-text-primary)' : 'var(--color-primary-contrast)', border: onOwnKey ? '1px solid var(--color-border-ghost)' : 'none' }}
            >
              {onOwnKey ? 'Manage in AI →' : 'Set up in AI →'}
            </button>
          }
        />
      </div>
      {error && <div style={{ ...infoPanelStyle, color: '#f87171' }}>{error}</div>}
      <div style={infoPanelStyle}>
        <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
          {access?.message ?? 'Checking your AI access…'} Whichever mode you're in, only the resolved facts needed for one answer leave your machine — never raw capture or your whole history. Managed usage stores the time, feature, model, tokens and cost; not the prompt or answer.
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy != null} style={{ ...inlineButtonStyle, marginTop: 10 }}>Refresh status</button>
      </div>
    </SectionPage>
  )
}

// Roll the raw `job_type` of each AI call up into a user-facing feature so spend
// is attributed to things people recognise ("Timeline labeling", "AI chat")
// rather than internal job names. Used by both the chart's "Group: Feature"
// view and the per-feature breakdown below the chart.
const JOB_FEATURE_GROUPS: Record<string, string> = {
  block_label_preview: 'Timeline labeling',
  block_label_finalize: 'Timeline labeling',
  block_cleanup_relabel: 'Timeline labeling',
  attribution_assist: 'Timeline labeling',
  day_summary: 'Morning brief',
  wrapped_narrative: 'Evening wrap-up',
  wrapped_period_narrative: 'Weekly & monthly wrap',
  week_review: 'Week review',
  app_narrative: 'App insights',
  chat_answer: 'AI chat',
  chat_followup_suggestions: 'Suggestions',
  search_intent: 'Search',
  report_generation: 'Reports',
  memory_write: 'Memory writes',
  weekly_brief: 'Weekly brief',
}

function formatJobFeature(feature: string | null | undefined) {
  if (!feature) return 'Other'
  return JOB_FEATURE_GROUPS[feature] ?? feature.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Local-calendar day key (YYYY-MM-DD). Must match the backend's bucketing so a
// call's day on the chart axis lines up with the day it was aggregated under.
function dayKey(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function UsagePage() {
  type RangeKey = '1d' | '7d' | '30d' | 'mtd' | 'last_month' | 'custom'
  type GroupKey = 'model' | 'type'
  type MetricKey = 'spend' | 'tokens'
  // Persist the view controls so navigating away and back keeps the user's
  // chosen window/grouping instead of snapping back to the 30d/model/spend
  // defaults every time.
  const readPref = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    try {
      const saved = localStorage.getItem(key)
      return saved && (allowed as readonly string[]).includes(saved) ? (saved as T) : fallback
    } catch { return fallback }
  }
  const [range, setRange] = useState<RangeKey>(() => readPref('daylens.usage.range', ['1d', '7d', '30d', 'mtd', 'last_month', 'custom'] as const, '30d'))
  const [groupBy, setGroupBy] = useState<GroupKey>(() => readPref('daylens.usage.groupBy', ['model', 'type'] as const, 'model'))
  const [metric, setMetric] = useState<MetricKey>(() => readPref('daylens.usage.metric', ['spend', 'tokens'] as const, 'spend'))
  useEffect(() => { try { localStorage.setItem('daylens.usage.range', range) } catch { /* ignore */ } }, [range])
  useEffect(() => { try { localStorage.setItem('daylens.usage.groupBy', groupBy) } catch { /* ignore */ } }, [groupBy])
  useEffect(() => { try { localStorage.setItem('daylens.usage.metric', metric) } catch { /* ignore */ } }, [metric])
  const [customFrom, setCustomFrom] = useState(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [report, setReport] = useState<BillingUsageReport | null>(null)
  const [access, setAccess] = useState<BillingAccessSnapshot | null>(null)
  const [hoveredChartIndex, setHoveredChartIndex] = useState<number | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bounds = useMemo(() => {
    const now = new Date()
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    if (range === '1d') return { from: end - 86400000, to: end }
    if (range === '7d') return { from: end - 7 * 86400000, to: end }
    if (range === '30d') return { from: end - 30 * 86400000, to: end }
    if (range === 'mtd') return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: end }
    if (range === 'last_month') {
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
        to: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      }
    }
    return {
      from: new Date(`${customFrom}T00:00:00`).getTime(),
      to: new Date(`${customTo}T00:00:00`).getTime() + 86400000,
    }
  }, [range, customFrom, customTo])

  useEffect(() => {
    let cancelled = false
    void ipc.billing.getAccess()
      .then((nextAccess) => { if (!cancelled) setAccess(nextAccess) })
      .catch(() => { /* access is optional context for summary split */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setRefreshing(true)
    setError(null)
    void ipc.billing.getUsage(bounds.from, bounds.to)
      .then((nextReport) => {
        if (cancelled) return
        setReport(nextReport)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) {
          setRefreshing(false)
          setInitialLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [bounds])

  const effectiveMetric = useMemo((): MetricKey => {
    if (metric === 'tokens') return 'tokens'
    if (!report) return metric
    if (report.totalSpendUsd > 0) return 'spend'
    if (report.totalTokens > 0) return 'tokens'
    return 'spend'
  }, [metric, report])

  const formatTokens = (value: number) => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
    return String(value)
  }

  const formatTokensExact = (value: number) => Math.round(value).toLocaleString()
  const formatSpend = (value: number) => formatUsdAmount(value)
  const formatMetricExact = (value: number) => effectiveMetric === 'spend' ? formatSpend(value) : formatTokensExact(value)
  const formatPercent = (value: number, total: number) => total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0.0%'
  const formatDate = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const formatFullDate = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const formatUsageType = (type: string) => {
    if (type === 'free_credit' || type === 'subscription' || type === 'local_pass') return 'Included'
    if (type === 'own_key') return 'On-demand'
    return type.replace(/_/g, ' ')
  }
  const formatCost = (type: string, costUsd: number | null) => {
    if (costUsd != null && costUsd > 0) return formatSpend(costUsd)
    if (type === 'free_credit' || type === 'subscription' || type === 'local_pass') return 'Included'
    return 'Provider billed'
  }

  const chart = useMemo(() => {
    if (!report) return null
    const chartMetric = effectiveMetric
    // Short windows (Today / ≤2-day custom) chart by the hour so a single day
    // isn't a single zero-width point; longer windows chart by the day.
    const hourly = (bounds.to - bounds.from) <= 2 * 86400000
    const HOUR = 3_600_000

    const buckets: string[] = []
    if (hourly) {
      // Bucket on UTC hour boundaries (what the backend keys on) so the axis and
      // the per-hour aggregate line up even in half-hour-offset timezones.
      for (let hour = Math.floor(bounds.from / HOUR) * HOUR; hour < bounds.to; hour += HOUR) {
        buckets.push(String(hour))
      }
    } else {
      const start = new Date(bounds.from)
      start.setHours(0, 0, 0, 0)
      const end = new Date(bounds.to)
      end.setHours(0, 0, 0, 0)
      for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
        buckets.push(dayKey(cursor.getTime()))
      }
      if (buckets.length === 0 || buckets.length > 62) {
        const dataDays = new Set<string>()
        for (const point of report.points ?? []) dataDays.add(point.day)
        for (const row of report.rows ?? []) dataDays.add(dayKey(row.occurredAt))
        buckets.splice(0, buckets.length, ...[...dataDays].sort())
      }
    }
    if (buckets.length === 0) return null

    const series = new Map<string, Map<string, number>>()
    const addValue = (name: string, bucket: string, value: number) => {
      if (!Number.isFinite(value) || value === 0) return
      if (!series.has(name)) series.set(name, new Map())
      const values = series.get(name)!
      values.set(bucket, (values.get(bucket) ?? 0) + value)
    }

    if (hourly) {
      // Per-hour aggregate carries both model and feature and is uncapped (the
      // rows table only holds the latest 2000, which a busy day can exceed).
      for (const point of report.hourlyPoints ?? []) {
        const bucket = String(Math.floor(point.hour / HOUR) * HOUR)
        const name = groupBy === 'model' ? point.model || 'auto' : formatJobFeature(point.feature)
        addValue(name, bucket, chartMetric === 'spend' ? point.costUsd ?? 0 : point.tokens)
      }
      if (series.size === 0) {
        for (const row of report.rows) {
          const bucket = String(Math.floor(row.occurredAt / HOUR) * HOUR)
          const name = groupBy === 'model' ? row.model || 'auto' : formatJobFeature(row.feature)
          addValue(name, bucket, chartMetric === 'spend' ? row.costUsd ?? 0 : row.tokens ?? 0)
        }
      }
    } else if (groupBy === 'type' && (report.featurePoints?.length ?? 0) > 0) {
      for (const point of report.featurePoints ?? []) {
        addValue(formatJobFeature(point.feature ?? point.model), point.day, chartMetric === 'spend' ? point.spendUsd : point.tokens)
      }
    } else if (groupBy === 'model' && report.points.length > 0) {
      for (const point of report.points) {
        addValue(point.model || 'auto', point.day, chartMetric === 'spend' ? point.spendUsd : point.tokens)
      }
    } else if (report.rows.length > 0) {
      for (const row of report.rows) {
        const bucket = dayKey(row.occurredAt)
        const name = groupBy === 'model' ? row.model || 'auto' : formatJobFeature(row.feature)
        addValue(name, bucket, chartMetric === 'spend' ? row.costUsd ?? 0 : row.tokens ?? 0)
      }
    } else {
      for (const point of report.points) {
        addValue(groupBy === 'model' ? point.model || 'auto' : 'Usage', point.day, chartMetric === 'spend' ? point.spendUsd : point.tokens)
      }
    }

    const cumulative = [...series.entries()]
      .map(([name, values]) => {
        let running = 0
        const daily = buckets.map((bucket) => values.get(bucket) ?? 0)
        return {
          name,
          daily,
          values: daily.map((value) => (running += value)),
        }
      })
      .filter((item) => item.daily.some((value) => value > 0))
    if (cumulative.length === 0) return null

    const totals = buckets.map((_, index) => cumulative.reduce((sum, item) => sum + item.values[index], 0))
    const dailyTotals = buckets.map((_, index) => cumulative.reduce((sum, item) => sum + item.daily[index], 0))
    return { days: buckets, granularity: hourly ? 'hour' as const : 'day' as const, cumulative, max: Math.max(...totals, 1), totals, dailyTotals }
  }, [bounds.from, bounds.to, groupBy, effectiveMetric, report])

  // Axis/tooltip labels adapt to the chart's granularity: clock time for hourly
  // buckets (ms-keyed), calendar dates for daily buckets (YYYY-MM-DD-keyed).
  const formatBucketShort = (key: string) => chart?.granularity === 'hour'
    ? new Date(Number(key)).toLocaleTimeString(undefined, { hour: 'numeric' })
    : formatDate(key)
  const formatBucketFull = (key: string) => chart?.granularity === 'hour'
    ? new Date(Number(key)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
    : formatFullDate(key)
  const bucketWord = chart?.granularity === 'hour' ? 'Hourly' : 'Daily'

  // Per-feature attribution: roll the per-(feature, screen, model) job summaries
  // up into user-facing features so people can see exactly where spend goes.
  const featureBreakdown = useMemo(() => {
    const summaries = report?.jobSummaries ?? []
    if (summaries.length === 0) return null
    const map = new Map<string, { feature: string; costUsd: number; tokens: number; calls: number }>()
    for (const summary of summaries) {
      const feature = formatJobFeature(summary.feature)
      const entry = map.get(feature) ?? { feature, costUsd: 0, tokens: 0, calls: 0 }
      entry.costUsd += summary.costUsd ?? 0
      entry.tokens += summary.tokens
      entry.calls += summary.calls
      map.set(feature, entry)
    }
    const items = [...map.values()]
    const totalCost = items.reduce((sum, item) => sum + item.costUsd, 0)
    const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0)
    const useSpend = totalCost > 0
    items.sort((left, right) => useSpend ? right.costUsd - left.costUsd : right.tokens - left.tokens)
    return { items, totalCost, totalTokens, useSpend }
  }, [report])

  const colors = ['#3aa17e', '#8fb4d8', '#5c80b6', '#c58bb8', '#9fbe83', '#d8a653']
  const quickRanges: Array<{ key: Exclude<RangeKey, 'custom'>; label: string }> = [
    { key: '1d', label: '1d' },
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: 'mtd', label: 'MTD' },
    { key: 'last_month', label: 'Last month' },
  ]
  const totalSpend = report?.totalSpendUsd ?? 0
  const paidSpend = report?.paidSpendUsd ?? 0
  const freeCreditUsed = report?.freeCreditUsedUsd ?? 0
  const includedSpend = access?.mode === 'own_key' ? 0 : (freeCreditUsed > 0 ? freeCreditUsed : Math.max(0, totalSpend - paidSpend))
  const onDemandSpend = access?.mode === 'own_key' ? totalSpend : paidSpend
  const totalTokens = report?.totalTokens ?? 0
  const showCardLoading = initialLoading && !report
  const summaryCards: Array<[string, string]> = [
    ['Total spend', formatSpend(totalSpend)],
    ['Included', formatSpend(includedSpend)],
    ['On-demand', formatSpend(onDemandSpend)],
    ['Total tokens', formatTokens(totalTokens)],
  ]
  const spendSourceNote = report?.source === 'daylens_managed'
    ? 'Spend from Daylens managed billing.'
    : report && totalSpend > 0
      ? 'Your AI spend — tokens used × Anthropic’s published per-model price.'
      : null

  return (
    <SectionPage
      title="Usage"
      description="Your AI usage for this billing period."
      maxWidth={980}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <select value={range} onChange={(event) => setRange(event.target.value as RangeKey)} style={inputStyle(150)}>
          <option value="1d">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="mtd">Month to date</option>
          <option value="last_month">Last month</option>
          <option value="custom">Custom</option>
        </select>
        {quickRanges.map(({ key, label }) => (
          <button key={key} type="button" onClick={() => setRange(key)} style={{ ...inlineButtonStyle, padding: '7px 10px', background: range === key ? 'var(--color-accent-dim)' : 'transparent', border: range === key ? '1px solid var(--color-border-ghost)' : '1px solid transparent' }}>
            {label}
          </button>
        ))}
        {range === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} style={inputStyle(145)} />
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 12 }}>to</span>
            <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} style={inputStyle(145)} />
          </>
        )}
      </div>

      {error && <div style={{ ...infoPanelStyle, color: '#f87171' }}>{error}</div>}
      {(spendSourceNote || refreshing) && (
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
          {spendSourceNote}{spendSourceNote && refreshing ? ' ' : ''}{refreshing ? 'Updating…' : ''}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        {summaryCards.map(([label, value]) => (
          <div key={label} style={{ padding: '18px 16px', border: '1px solid var(--color-border-ghost)', borderRadius: 10, background: 'var(--color-surface-low)' }}>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8, color: 'var(--color-text-primary)' }}>{showCardLoading ? '…' : value}</div>
          </div>
        ))}
      </div>

      <div style={{ border: '1px solid var(--color-border-ghost)', borderRadius: 10, padding: 18, background: 'var(--color-surface-low)', display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 560, color: 'var(--color-text-primary)' }}>Your Usage</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3 }}>Your usage {chart?.granularity === 'hour' ? 'per hour today' : 'per day across this range'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupKey)} style={inputStyle(170)}>
              <option value="model">Group: Model</option>
              <option value="type">Group: Feature</option>
            </select>
            <select value={metric} onChange={(event) => setMetric(event.target.value as MetricKey)} style={inputStyle(125)}>
              <option value="spend">Spend</option>
              <option value="tokens">Tokens</option>
            </select>
          </div>
        </div>
        {chart ? (
          <>
            <div
              style={{ position: 'relative' }}
              onMouseLeave={() => setHoveredChartIndex(null)}
              onMouseMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                const raw = (event.clientX - rect.left) / Math.max(1, rect.width)
                const index = Math.round(Math.min(1, Math.max(0, raw)) * Math.max(0, chart.days.length - 1))
                setHoveredChartIndex(index)
              }}
            >
              <svg viewBox="0 0 760 240" role="img" aria-label={`Cumulative AI ${effectiveMetric} chart`} style={{ width: '100%', minHeight: 220, display: 'block' }}>
                {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="48" x2="742" y1={20 + line * 48} y2={20 + line * 48} stroke="var(--color-border-ghost)" />)}
                {effectiveMetric === 'spend' && [0, 1, 2, 3, 4].map((line) => {
                  const value = (chart.max * (4 - line)) / 4
                  return (
                    <text key={`y-${line}`} x="42" y={24 + line * 48} textAnchor="end" fontSize="10" fill="var(--color-text-tertiary)">
                      {formatSpend(value)}
                    </text>
                  )
                })}
                {chart.cumulative.map((series, seriesIndex) => {
                  const lower = chart.cumulative.slice(0, seriesIndex).map((item) => item.values)
                  const top = series.values.map((value, index) => value + lower.reduce((sum, values) => sum + values[index], 0))
                  const bottom = series.values.map((_, index) => lower.reduce((sum, values) => sum + values[index], 0))
                  const x = (index: number) => 48 + (index / Math.max(1, chart.days.length - 1)) * 694
                  const y = (value: number) => 212 - (value / chart.max) * 184
                  const points = [
                    ...top.map((value, index) => `${x(index)},${y(value)}`),
                    ...bottom.map((_, index) => `${x(chart.days.length - 1 - index)},${y(bottom[chart.days.length - 1 - index])}`),
                  ].join(' ')
                  return <polygon key={series.name} points={points} fill={colors[seriesIndex % colors.length]} opacity={0.68} />
                })}
                {hoveredChartIndex != null && chart.days[hoveredChartIndex] && (
                  <>
                    <line
                      x1={48 + (hoveredChartIndex / Math.max(1, chart.days.length - 1)) * 694}
                      x2={48 + (hoveredChartIndex / Math.max(1, chart.days.length - 1)) * 694}
                      y1="16"
                      y2="216"
                      stroke="var(--color-text-tertiary)"
                      strokeDasharray="4 4"
                    />
                    <circle
                      cx={48 + (hoveredChartIndex / Math.max(1, chart.days.length - 1)) * 694}
                      cy={212 - ((chart.totals[hoveredChartIndex] ?? 0) / chart.max) * 184}
                      r="5"
                      fill="var(--color-accent)"
                      stroke="var(--color-surface-low)"
                      strokeWidth="3"
                    />
                  </>
                )}
                <line x1="742" x2="742" y1="16" y2="216" stroke="var(--color-text-tertiary)" strokeDasharray="4 4" opacity={0.45} />
                <text x="735" y="14" textAnchor="end" fontSize="10" fill="var(--color-text-tertiary)">{chart.granularity === 'hour' ? 'Now' : 'Today'}</text>
                <text x="48" y="232" fontSize="10" fill="var(--color-text-tertiary)">{formatBucketShort(chart.days[0])}</text>
                <text x="742" y="232" textAnchor="end" fontSize="10" fill="var(--color-text-tertiary)">{formatBucketShort(chart.days[chart.days.length - 1])}</text>
              </svg>
              {hoveredChartIndex != null && chart.days[hoveredChartIndex] && (
                <div
                  style={{
                    position: 'absolute',
                    top: 42,
                    left: `${Math.min(78, Math.max(8, (hoveredChartIndex / Math.max(1, chart.days.length - 1)) * 100))}%`,
                    transform: 'translateX(-50%)',
                    minWidth: 220,
                    padding: 12,
                    borderRadius: 10,
                    border: '1px solid var(--color-border-ghost)',
                    background: 'var(--color-surface)',
                    boxShadow: '0 16px 36px rgba(0, 0, 0, 0.18)',
                    pointerEvents: 'none',
                    zIndex: 2,
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 720, color: 'var(--color-text-primary)' }}>
                    {formatBucketFull(chart.days[hoveredChartIndex])}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                    {bucketWord} breakdown
                  </div>
                  <div style={{ display: 'grid', gap: 5, marginTop: 9 }}>
                    {chart.cumulative
                      .map((series, index) => ({ name: series.name, value: series.daily[hoveredChartIndex] ?? 0, color: colors[index % colors.length] }))
                      .filter((item) => item.value > 0)
                      .sort((left, right) => right.value - left.value)
                      .slice(0, 5)
                      .map((item) => (
                        <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span style={{ width: 7, height: 7, borderRadius: 999, background: item.color, flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                          </span>
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
                            <strong style={{ color: 'var(--color-text-primary)' }}>{formatMetricExact(item.value)}</strong>
                            <span style={{ color: 'var(--color-text-tertiary)' }}>{formatPercent(item.value, chart.dailyTotals[hoveredChartIndex] ?? 0)}</span>
                          </span>
                        </div>
                      ))}
                  </div>
                  <div style={{ borderTop: '1px solid var(--color-border-ghost)', marginTop: 9, paddingTop: 8, display: 'grid', gap: 4, fontSize: 11.5 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ color: 'var(--color-text-secondary)' }}>{bucketWord} total</span>
                      <strong style={{ color: 'var(--color-text-primary)' }}>{formatMetricExact(chart.dailyTotals[hoveredChartIndex] ?? 0)}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ color: 'var(--color-text-secondary)' }}>Cumulative total</span>
                      <strong style={{ color: 'var(--color-text-primary)' }}>{formatMetricExact(chart.totals[hoveredChartIndex] ?? 0)}</strong>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            {chart.cumulative.map((series, index) => (
              <span key={series.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
                  <span style={{ width: 13, height: 2, background: colors[index % colors.length] }} />{series.name}
                </span>
              ))}
            </div>
            {metric === 'spend' && effectiveMetric === 'tokens' && totalTokens > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                Spend is unavailable for this range. Showing token usage instead.
              </div>
            )}
          </>
        ) : (
          <div style={{ height: 220, display: 'grid', placeItems: 'center', color: 'var(--color-text-tertiary)', fontSize: 12.5 }}>
            {showCardLoading ? 'Loading usage…' : 'No AI calls in this range.'}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => void ipc.billing.exportUsageCsv(bounds.from, bounds.to)} style={inlineButtonStyle}>Export CSV</button>
        </div>
      </div>

      {featureBreakdown && (
        <div style={{ border: '1px solid var(--color-border-ghost)', borderRadius: 10, padding: 18, background: 'var(--color-surface-low)', display: 'grid', gap: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 560, color: 'var(--color-text-primary)' }}>Spend by feature</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
              Where your AI usage went across this range — cost and tokens per feature.
            </div>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {featureBreakdown.items.map((item, index) => {
              const share = featureBreakdown.useSpend
                ? (featureBreakdown.totalCost > 0 ? item.costUsd / featureBreakdown.totalCost : 0)
                : (featureBreakdown.totalTokens > 0 ? item.tokens / featureBreakdown.totalTokens : 0)
              return (
                <div key={item.feature} style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-text-primary)', minWidth: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: colors[index % colors.length], flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 540 }}>{item.feature}</span>
                      <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11.5, flexShrink: 0 }}>
                        {item.calls.toLocaleString()} {item.calls === 1 ? 'call' : 'calls'} · {formatTokens(item.tokens)} tokens
                      </span>
                    </span>
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline', flexShrink: 0 }}>
                      <strong style={{ color: 'var(--color-text-primary)' }}>
                        {item.costUsd > 0 ? formatSpend(item.costUsd) : 'Included'}
                      </strong>
                      <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11.5, minWidth: 42, textAlign: 'right' }}>
                        {(share * 100).toFixed(1)}%
                      </span>
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: 'var(--color-border-ghost)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(2, share * 100)}%`, height: '100%', borderRadius: 999, background: colors[index % colors.length], opacity: 0.85 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ border: '1px solid var(--color-border-ghost)', borderRadius: 10, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820, fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--color-surface-low)', color: 'var(--color-text-tertiary)', textAlign: 'left' }}>
              {['Date', 'Feature', 'Type', 'Model', 'Tokens', 'Cost'].map((heading) => <th key={heading} style={{ padding: '11px 14px', fontWeight: 620 }}>{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {(report?.rows ?? []).slice(0, 200).map((row) => (
              <tr key={row.id} style={{ borderTop: '1px solid var(--color-border-ghost)', color: 'var(--color-text-secondary)' }}>
                <td style={{ padding: '11px 14px' }}>{new Date(row.occurredAt).toLocaleString()}</td>
                <td style={{ padding: '11px 14px' }}>{formatJobFeature(row.feature)}</td>
                <td style={{ padding: '11px 14px' }}>{formatUsageType(row.type)}</td>
                <td style={{ padding: '11px 14px' }}>{row.model ?? '—'}</td>
                <td style={{ padding: '11px 14px' }}>{row.tokens == null ? '—' : formatTokens(row.tokens)}</td>
                <td style={{ padding: '11px 14px' }}>{formatCost(row.type, row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(report?.rows.length ?? 0) > 200 && (
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--color-border-ghost)', color: 'var(--color-text-tertiary)', fontSize: 11.5 }}>
            Showing the latest 200 calls. Export CSV includes the full selected range.
          </div>
        )}
        {!showCardLoading && !report?.rows.length && <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 12.5 }}>No usage in this range.</div>}
      </div>
    </SectionPage>
  )
}

export default function Settings({ initialSettings = null }: { initialSettings?: AppSettings | null } = {}) {
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings)
  // Which section the content pane shows. Honors a ?section= deep link on first
  // mount (so other surfaces can jump straight to e.g. Billing), then is local.
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const requested = searchParams.get('section')
    return isSectionId(requested) ? requested : 'general'
  })
  const [sectionSearch, setSectionSearch] = useState('')
  const [resetAndUninstallBusy, setResetAndUninstallBusy] = useState(false)
  const [navOrigin, setNavOrigin] = useState<SectionId | null>(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [cliTools, setCliTools] = useState<CLIToolDetection>({ claude: null, chatgpt: null, gemini: null, codex: null })
  const [trackingDiagnostics, setTrackingDiagnostics] = useState<TrackingDiagnosticsPayload | null>(null)
  const [defaultUserName, setDefaultUserName] = useState('')
  const [recentApps, setRecentApps] = useState<AppUsageSummary[]>([])
  const [labelsLoaded, setLabelsLoaded] = useState(false)
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, AppCategory>>({})
  const [categoryBusyBundleId, setCategoryBusyBundleId] = useState<string | null>(null)
  // The full app list can be long, so keep Labels tidy: show a handful by default,
  // expand to reveal the rest, and let a search jump straight to any app (DEV-102).
  const [labelsExpanded, setLabelsExpanded] = useState(false)
  const [labelSearch, setLabelSearch] = useState('')
  // What the last relabel touched, shown inline so a change is never silent.
  const [relabelEffect, setRelabelEffect] = useState<{ bundleId: string; message: string } | null>(null)
  const [workMemoryProfile, setWorkMemoryProfile] = useState<WorkMemoryFact[] | null>(null)
  const [workMemoryBusy, setWorkMemoryBusy] = useState<string | null>(null)
  const [workMemoryError, setWorkMemoryError] = useState<string | null>(null)
  const [workMemoryChange, setWorkMemoryChange] = useState<string | null>(null)
  // Inline edit buffers, keyed by fact id; plus the "add a fact" draft.
  const [factDrafts, setFactDrafts] = useState<Record<string, string>>({})
  const [newFactText, setNewFactText] = useState('')
  // The fact row currently under the pointer — quiet edit/forget controls only
  // appear on hover so the view reads as plain sentences, not a control panel.
  const [hoveredFactId, setHoveredFactId] = useState<string | null>(null)
  const [memoryExpanded, setMemoryExpanded] = useState(false)
  // DEV-108: each client's scoped memory, shown under that client; plus the
  // per-client "add a fact" drafts keyed by client id.
  const [clientMemory, setClientMemory] = useState<ClientMemoryGroup[]>([])
  const [clientFactDrafts, setClientFactDrafts] = useState<Record<string, string>>({})
  // A short audit of what memory remembered/edited/forgot (memory.md §3).
  const [memoryAudit, setMemoryAudit] = useState<MemoryAuditEntry[] | null>(null)
  const [mcpConfig, setMcpConfig] = useState<{ command: string; args: string[]; env: Record<string, string>; isPackaged: boolean; dbPath: string } | null>(null)
  const [mcpSnippetCopied, setMcpSnippetCopied] = useState(false)
  const [mcpAdvancedOpen, setMcpAdvancedOpen] = useState(false)
  const [enrichmentSources, setEnrichmentSources] = useState<EnrichmentSourcesState | null>(null)
  const [clients, setClients] = useState<ClientRecord[]>([])
  const [clientsLoaded, setClientsLoaded] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientColor, setNewClientColor] = useState('#7c8cff')
  const [addingClient, setAddingClient] = useState(false)
  const [clientFormError, setClientFormError] = useState<string | null>(null)
  const [clientBusyId, setClientBusyId] = useState<string | null>(null)
  const [editingClientId, setEditingClientId] = useState<string | null>(null)
  const [editingClientName, setEditingClientName] = useState('')
  const [editingClientColor, setEditingClientColor] = useState('')
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>('not-determined')
  const [settingsWriteError, setSettingsWriteError] = useState<string | null>(null)
  const [settingsLoadErrors, setSettingsLoadErrors] = useState<Record<string, string>>({})
  const settingsWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  const selectedAiProvider = settings?.aiProvider

  useEffect(() => {
    let cancelled = false

    // Render the Settings shell as soon as `ipc.settings.get()` resolves.
    // Section-owned data is loaded by the effects below only when that section
    // is visible; opening General must not start every Settings subsystem.
    void (async () => {
      // Reuse the settings App already loaded when available, so navigating to
      // Settings does not issue a second ipc.settings.get() round-trip (F56).
      try {
        const current = initialSettings ?? await ipc.settings.get()
        if (!cancelled) setSettings(current)
      } catch (error) {
        if (!cancelled) recordSettingsLoadError('Settings', error)
      }
    })()

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!['capture', 'notifications', 'mcp'].includes(activeSection)) return
    let cancelled = false
    const refresh = async () => {
      if (document.hidden) return
      try {
        const next = await ipc.tracking.getDiagnostics()
        if (!cancelled) setTrackingDiagnostics(next)
      } catch (error) {
        if (!cancelled) recordSettingsLoadError('Capture health', error)
      }
    }
    const refreshWhenVisible = () => {
      if (!document.hidden) void refresh()
    }

    void refresh()
    if (activeSection !== 'capture') return () => { cancelled = true }

    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(() => { void refresh() }, 5_000)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.clearInterval(timer)
    }
  }, [activeSection])

  useEffect(() => {
    if (activeSection !== 'general') return
    let cancelled = false
    void ipc.app.getDefaultUserName().catch(() => '').then((suggestedName) => {
      if (!cancelled) setDefaultUserName(String(suggestedName ?? ''))
    })
    return () => { cancelled = true }
  }, [activeSection])

  useEffect(() => {
    if (!['ai', 'billing'].includes(activeSection)) return
    let cancelled = false
    void ipc.ai.detectCliTools().catch(() => ({ claude: null, chatgpt: null, gemini: null, codex: null })).then((tools) => {
      if (!cancelled) setCliTools(tools as CLIToolDetection)
    })
    return () => { cancelled = true }
  }, [activeSection])

  useEffect(() => {
    if (activeSection !== 'notifications') return
    let cancelled = false
    void ipc.notifications.getPermissionState().then((state) => {
      if (!cancelled) setNotificationPermission(state)
    }).catch((error) => {
      if (!cancelled) recordSettingsLoadError('Notifications', error)
    })
    return () => { cancelled = true }
  }, [activeSection])

  useEffect(() => {
    if (activeSection !== 'labels' || labelsLoaded) return
    let cancelled = false
    void Promise.all([
      ipc.db.getAllAppsForLabeling(),
      ipc.db.getCategoryOverrides(),
    ]).then(([summaries, overrides]) => {
      if (cancelled) return
      setRecentApps(summaries.filter((summary) => summary.bundleId))
      setCategoryOverrides(overrides)
      setLabelsLoaded(true)
    }).catch((error) => {
      if (!cancelled) recordSettingsLoadError('Labels', error)
    })
    return () => { cancelled = true }
  }, [activeSection, labelsLoaded])

  useEffect(() => {
    if (activeSection !== 'memory' || workMemoryProfile !== null) return
    let cancelled = false
    void Promise.all([
      ipc.db.getScopedMemoryProfile(),
      ipc.db.getMemoryAudit(),
    ]).then(([profile, audit]) => {
      if (cancelled) return
      setWorkMemoryProfile(profile.general)
      setClientMemory(profile.clients)
      setMemoryAudit(audit)
    }).catch((error) => {
      if (!cancelled) recordSettingsLoadError('Memory', error)
    })
    return () => { cancelled = true }
  }, [activeSection, workMemoryProfile])

  useEffect(() => {
    if (!selectedAiProvider || !['ai', 'billing'].includes(activeSection)) return
    const cliTool = cliToolForProvider(selectedAiProvider)
    if (cliTool) {
      setHasApiKey(!!cliTools[cliTool])
      return
    }
    void ipc.settings.hasApiKey(selectedAiProvider).then((access) => setHasApiKey(access))
  }, [activeSection, cliTools, selectedAiProvider])

  useEffect(() => {
    if (activeSection !== 'mcp' || !settings?.mcpServerEnabled) return
    void ipc.mcp.getConfig().then((cfg) => setMcpConfig(cfg))
  }, [activeSection, settings?.mcpServerEnabled])

  useEffect(() => {
    if (activeSection !== 'enrichment') return
    void ipc.settings.getEnrichmentSources().then(setEnrichmentSources).catch((error) => recordSettingsLoadError('Enrichment', error))
  }, [activeSection])

  async function toggleEnrichmentSource(key: string, value: boolean) {
    if (!settings) return
    const next = { ...(settings.enrichmentSources ?? {}), [key]: value }
    if (!await persist({ enrichmentSources: next })) return
    setEnrichmentSources((prev) => prev && ({
      mcpServers: prev.mcpServers.map((s) => (`mcp:${s.name}` === key ? { ...s, enabled: value } : s)),
      focusApps: prev.focusApps.map((f) => (`focus:${f.app}` === key ? { ...f, enabled: value } : f)),
    }))
  }

  function recordSettingsLoadError(section: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    setSettingsLoadErrors((current) => ({ ...current, [section]: message }))
  }

  async function persist(partial: Partial<AppSettings>): Promise<boolean> {
    if (!settings) return false
    setSettingsWriteError(null)
    setSettings((current) => current ? { ...current, ...partial } : current)
    const write = settingsWriteQueueRef.current.then(() => ipc.settings.set(partial))
    settingsWriteQueueRef.current = write.catch(() => {})
    try {
      await write
      // Re-apply after the serialized write completes. If an earlier failed write
      // forced an authoritative reload while this one was queued, its successful
      // value must still win in the controlled UI.
      setSettings((current) => current ? { ...current, ...partial } : current)
      if ('mcpServerEnabled' in partial && partial.mcpServerEnabled) {
        const cfg = await ipc.mcp.getConfig()
        setMcpConfig(cfg)
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSettingsWriteError(`Could not save this setting: ${message}`)
      const authoritative = await ipc.settings.get().catch(() => null)
      if (authoritative) {
        setSettings(authoritative)
        applyAppearanceSettings(authoritative)
      }
      return false
    }
  }

  // Appearance changes (activity colors, leisure dimming) take effect the
  // moment they're saved: the shared module every surface reads is updated
  // alongside the persisted setting, so the calendar shows the new look on
  // its next render — no restart, no reload (settings.md invariant 1).
  function persistAppearance(partial: Pick<Partial<AppSettings>, 'activityColorOverrides' | 'dimLeisureBlocks'>) {
    if (!settings) return
    void persist(partial)
    applyAppearanceSettings({
      activityColorOverrides: partial.activityColorOverrides ?? settings.activityColorOverrides,
      dimLeisureBlocks: partial.dimLeisureBlocks ?? settings.dimLeisureBlocks,
    })
  }

  // Save an inline edit to a fact. A hand edit becomes a correction (the backend
  // flips its origin to 'user') that a rebuild never overwrites.
  async function reloadMemoryAudit() {
    try {
      setMemoryAudit(await ipc.db.getMemoryAudit())
    } catch (error) {
      recordSettingsLoadError('Memory history', error)
    }
  }

  // Refresh the per-client groups after any edit/forget/add that could touch a
  // client fact (edits/forgets go by id and return only the general profile).
  async function reloadClientMemory() {
    try {
      const profile = await ipc.db.getScopedMemoryProfile()
      setClientMemory(profile.clients)
    } catch (error) {
      recordSettingsLoadError('Memory', error)
    }
  }

  async function addClientMemoryFact(clientId: string) {
    const text = (clientFactDrafts[clientId] ?? '').trim()
    if (!text) return
    setWorkMemoryBusy(`clientadd:${clientId}`)
    setWorkMemoryError(null)
    try {
      await ipc.db.addClientMemoryFact(clientId, text)
      setClientFactDrafts((current) => {
        const next = { ...current }
        delete next[clientId]
        return next
      })
      setWorkMemoryChange('Added to this client — the AI uses it when you ask about them.')
      await reloadClientMemory()
      void reloadMemoryAudit()
    } catch (error) {
      setWorkMemoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkMemoryBusy(null)
    }
  }

  async function saveWorkMemoryFact(id: string) {
    const text = (factDrafts[id] ?? '').trim()
    if (!text) return
    setWorkMemoryBusy(id)
    setWorkMemoryError(null)
    try {
      const profile = await ipc.db.updateWorkMemoryFact(id, text)
      setWorkMemoryProfile(profile.facts)
      setFactDrafts((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setWorkMemoryChange('Saved — the AI will use this the next time it talks about you.')
      void reloadMemoryAudit()
      void reloadClientMemory()
    } catch (error) {
      setWorkMemoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkMemoryBusy(null)
    }
  }

  function startEditFact(id: string, text: string) {
    setWorkMemoryChange(null)
    setFactDrafts((current) => ({ ...current, [id]: text }))
  }

  function cancelEditFact(id: string) {
    setFactDrafts((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  // One fact rendered as a plain sentence with quiet hover edit/forget — shared
  // by the general sections and each client's scoped memory so they read the
  // same. Edits/forgets go by id, so client facts use the same handlers.
  function renderMemoryFactRow(fact: WorkMemoryFact) {
    const draft = factDrafts[fact.id]
    const isEditing = draft !== undefined
    const busy = workMemoryBusy === fact.id
    // Any in-flight mutation disables every control so two writes can't race.
    const anyBusy = workMemoryBusy !== null
    const hovered = hoveredFactId === fact.id
    const provenance = fact.source === 'chat'
      ? 'Remembered from chat'
      : fact.origin === 'user' ? 'Edited by you' : null

    if (isEditing) {
      return (
        <div key={fact.id} style={{ display: 'grid', gap: 8, padding: '8px 0' }}>
          <textarea
            value={draft}
            autoFocus
            onChange={(event) => setFactDrafts((current) => ({ ...current, [fact.id]: event.target.value }))}
            rows={2}
            style={{
              width: '100%',
              resize: 'vertical',
              fontSize: 13.5,
              lineHeight: 1.55,
              color: 'var(--color-text-primary)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-ghost)',
              borderRadius: 8,
              padding: '8px 10px',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              disabled={anyBusy}
              onClick={() => cancelEditFact(fact.id)}
              style={{ ...inlineButtonStyle, opacity: anyBusy ? 0.6 : 1, cursor: anyBusy ? 'default' : 'pointer' }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={anyBusy || draft.trim() === ''}
              onClick={() => void saveWorkMemoryFact(fact.id)}
              style={{ ...inlineButtonStyle, opacity: anyBusy || draft.trim() === '' ? 0.6 : 1, cursor: anyBusy || draft.trim() === '' ? 'default' : 'pointer' }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )
    }

    return (
      <div
        key={fact.id}
        onMouseEnter={() => setHoveredFactId(fact.id)}
        onMouseLeave={() => setHoveredFactId((current) => (current === fact.id ? null : current))}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '6px 8px',
          marginLeft: -8,
          marginRight: -8,
          borderRadius: 8,
          background: hovered ? 'var(--color-surface-high)' : 'transparent',
          transition: 'background 120ms',
        }}
      >
        <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.6, color: 'var(--color-text-primary)' }}>
          {fact.text}
          {provenance && (
            <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>· {provenance}</span>
          )}
        </span>
        <span
          style={{
            display: 'flex',
            gap: 14,
            flexShrink: 0,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            transition: 'opacity 120ms',
          }}
        >
          <button type="button" disabled={anyBusy} onClick={() => startEditFact(fact.id, fact.text)} style={memoryActionStyle}>
            Edit
          </button>
          <button type="button" disabled={anyBusy} onClick={() => void forgetWorkMemoryFact(fact.id)} style={{ ...memoryActionStyle, color: '#f87171' }}>
            {busy ? 'Forgetting…' : 'Forget'}
          </button>
        </span>
      </div>
    )
  }

  async function addWorkMemoryFact() {
    const text = newFactText.trim()
    if (!text) return
    setWorkMemoryBusy('add')
    setWorkMemoryError(null)
    try {
      const profile = await ipc.db.addWorkMemoryFact(text)
      setWorkMemoryProfile(profile.facts)
      setNewFactText('')
      setWorkMemoryChange('Added — the AI will use this the next time it talks about you.')
      void reloadMemoryAudit()
    } catch (error) {
      setWorkMemoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkMemoryBusy(null)
    }
  }

  async function forgetWorkMemoryFact(id: string) {
    setWorkMemoryBusy(id)
    setWorkMemoryError(null)
    try {
      const result = await ipc.db.forgetWorkMemoryFact(id)
      setWorkMemoryProfile(result.facts)
      setWorkMemoryChange(result.changeSummary)
      void reloadMemoryAudit()
      void reloadClientMemory()
    } catch (error) {
      setWorkMemoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkMemoryBusy(null)
    }
  }

  // Re-draft the profile from current evidence, keeping hand edits, and report
  // what changed in one line.
  async function rebuildWorkMemory() {
    setWorkMemoryBusy('rebuild')
    setWorkMemoryError(null)
    try {
      const result = await ipc.db.rebuildWorkMemory()
      setWorkMemoryProfile(result.facts)
      setWorkMemoryChange(result.changeSummary)
    } catch (error) {
      setWorkMemoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkMemoryBusy(null)
    }
  }

  async function forgetAllWorkMemory() {
    if (!window.confirm('Forget everything Daylens has learned about you?')) return
    setWorkMemoryBusy('all')
    setWorkMemoryError(null)
    try {
      await ipc.db.forgetAllWorkMemory()
      const profile = await ipc.db.getWorkMemoryProfile()
      setWorkMemoryProfile(profile.facts)
      setWorkMemoryChange('Forgot everything Daylens had learned about you.')
      void reloadMemoryAudit()
    } catch (error) {
      setWorkMemoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkMemoryBusy(null)
    }
  }

  async function startResetAndUninstall() {
    setResetAndUninstallBusy(true)
    try {
      // Main owns the confirmation dialogs and, when confirmed, quits the app —
      // this only resolves with started: false when the person cancels.
      const { started } = await ipc.app.resetAndUninstall()
      if (!started) setResetAndUninstallBusy(false)
    } catch {
      setResetAndUninstallBusy(false)
    }
  }

  async function refreshAIAccess() {
    const current = await ipc.settings.get()
    const cliTool = cliToolForProvider(current.aiProvider)
    const access = cliTool ? !!cliTools[cliTool] : await ipc.settings.hasApiKey(current.aiProvider)
    setSettings(current)
    setHasApiKey(access)
  }

  async function handleCategoryOverrideChange(bundleId: string, category: AppCategory) {
    setCategoryBusyBundleId(bundleId)
    try {
      const effect = await ipc.db.setCategoryOverride(bundleId, category)
      setCategoryOverrides((current) => ({ ...current, [bundleId]: category }))
      // Report what it touched — never change silently (settings spec §4).
      const days = effect?.daysAffected ?? 0
      setRelabelEffect({
        bundleId,
        message: days > 0
          ? `Updated ${days} ${days === 1 ? 'day' : 'days'} of activity — Apps, Timeline and the AI now read this label.`
          : 'Saved — new activity for this app will use this label.',
      })
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
      setRelabelEffect((current) => (current?.bundleId === bundleId ? null : current))
    } finally {
      setCategoryBusyBundleId(null)
    }
  }

  async function reloadClients() {
    try {
      const rows = await ipc.attribution.listClientsDetailed()
      setClients(rows)
      setSettingsLoadErrors((current) => {
        if (!('Clients' in current)) return current
        const next = { ...current }
        delete next.Clients
        return next
      })
    } catch (error) {
      recordSettingsLoadError('Clients', error)
    } finally {
      setClientsLoaded(true)
    }
  }

  useEffect(() => {
    if (activeSection === 'clients' && !clientsLoaded) void reloadClients()
  // reloadClients only closes over stable state setters and IPC.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, clientsLoaded])

  async function handleCreateClient() {
    const name = newClientName.trim()
    if (!name) {
      setClientFormError('Name is required.')
      return
    }
    setClientFormError(null)
    setClientBusyId('__new__')
    try {
      await ipc.attribution.createClient({ name, color: newClientColor || null })
      setNewClientName('')
      setNewClientColor('#7c8cff')
      setAddingClient(false)
      await reloadClients()
    } catch (error) {
      setClientFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setClientBusyId(null)
    }
  }

  function startEditingClient(client: ClientRecord) {
    setEditingClientId(client.id)
    setEditingClientName(client.name)
    setEditingClientColor(client.color ?? '#7c8cff')
    setClientFormError(null)
  }

  function cancelEditingClient() {
    setEditingClientId(null)
    setEditingClientName('')
    setEditingClientColor('')
    setClientFormError(null)
  }

  async function handleSaveClient(id: string) {
    const name = editingClientName.trim()
    if (!name) {
      setClientFormError('Name is required.')
      return
    }
    setClientBusyId(id)
    try {
      await ipc.attribution.updateClient({ id, name, color: editingClientColor || null })
      setEditingClientId(null)
      await reloadClients()
    } catch (error) {
      setClientFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setClientBusyId(null)
    }
  }

  async function handleArchiveClient(id: string) {
    setClientBusyId(id)
    try {
      await ipc.attribution.archiveClient(id)
      await reloadClients()
    } finally {
      setClientBusyId(null)
    }
  }

  async function handleRestoreClient(id: string) {
    setClientBusyId(id)
    try {
      await ipc.attribution.restoreClient(id)
      await reloadClients()
    } finally {
      setClientBusyId(null)
    }
  }

  async function handleDeleteClient(id: string, name: string) {
    if (!window.confirm(`Permanently delete "${name}"? This removes the client and its projects. Time attributed to it will become unattributed. This cannot be undone.`)) return
    setClientBusyId(id)
    try {
      await ipc.attribution.deleteClient(id)
      await reloadClients()
    } finally {
      setClientBusyId(null)
    }
  }

  if (!settings) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Loading settings…</p>
      </div>
    )
  }

  const linuxDesktop = trackingDiagnostics?.linuxDesktop ?? null
  const selectSection = (id: SectionId) => { setNavOrigin(null); setActiveSection(id) }
  const crossLinkToAI = (from: SectionId) => { setNavOrigin(from); setActiveSection('ai') }
  let content: ReactNode = null
  switch (activeSection) {
    case 'billing':
      content = <BillingPage hasAiAccess={hasApiKey} provider={settings.aiProvider} onGoToAI={() => crossLinkToAI('billing')} />
      break
    case 'usage':
      content = <UsagePage />
      break
    case 'general':
      content = (
        <SectionPage title="General" description="Your name and how Daylens looks.">
          <div>
            <SettingsRow
              first
              title="Display name"
              description="Used in the AI persona line. Leave blank if you prefer the generic Daylens voice."
              control={
                <input
                  type="text"
                  value={settings.userName}
                  placeholder={defaultUserName || 'Your name'}
                  maxLength={80}
                  onChange={(event) => void persist({ userName: event.target.value })}
                  style={inputStyle(240)}
                />
              }
            />
            <SettingsRow
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
            <SettingsRow
              align="start"
              title="Activity colors"
              description="One color per kind of work, used everywhere blocks are drawn — the day grid, week grid, and month dots."
              control={
                Object.keys(settings.activityColorOverrides ?? {}).length > 0 ? (
                  <button
                    type="button"
                    onClick={() => persistAppearance({ activityColorOverrides: {} })}
                    style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 10px', borderRadius: 8 }}
                  >
                    Reset colors
                  </button>
                ) : undefined
              }
            />
            <ActivityColorRows
              overrides={settings.activityColorOverrides ?? {}}
              onChange={(next) => persistAppearance({ activityColorOverrides: next })}
            />
            <SettingsRow
              title="Dim leisure blocks"
              description="Fade entertainment and personal blocks on the calendar so work stands out. Turn off to render every block at full strength."
              control={
                <Toggle
                  checked={settings.dimLeisureBlocks !== false}
                  onChange={(value) => persistAppearance({ dimLeisureBlocks: value })}
                />
              }
            />
          </div>
        </SectionPage>
      )
      break
    case 'ai':
      content = (
        <SectionPage title="AI" description="One provider, one model — used by every AI surface: chat, re-analyze, recaps, briefs, and wraps.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 10, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {hasApiKey
                ? cliToolForProvider(settings.aiProvider)
                  ? `Using your local ${KEY_PROVIDER_LABELS[settings.aiProvider] ?? settings.aiProvider}`
                  : `Using your own ${KEY_PROVIDER_LABELS[settings.aiProvider] ?? settings.aiProvider} key`
                : 'Using Daylens managed AI'}
            </span>
            <StatusPill label={hasApiKey ? 'BYOK' : 'Managed'} tone={hasApiKey ? 'success' : 'neutral'} />
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>
              {hasApiKey
                ? 'Calls go straight to the provider — Daylens never bills you.'
                : 'Calls go through Daylens with included credit or a subscription.'}
            </span>
          </div>
          <ConnectAI
            variant="embedded"
            initialProvider={settings.aiProvider}
            hasSavedAccess={hasApiKey}
            onConnected={() => { void refreshAIAccess() }}
            onModelChange={() => { void refreshAIAccess() }}
          />
        </SectionPage>
      )
      break
    case 'memory':
      content = (
        <SectionPage title="Memory" description="What Daylens knows about you, in plain language. Your edits always win — the AI uses them everywhere it talks about you.">
          <div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
              <button
                type="button"
                onClick={() => {
                  setPendingChatSeed("I want to talk about my work patterns and what you know about me — let's start there.")
                  navigate('/ai')
                }}
                style={{ ...inlineButtonStyle, background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', border: 'none' }}
              >
                Chat about your memory
              </button>
            </div>
            <button
              type="button"
              onClick={() => setMemoryExpanded((value) => !value)}
              aria-expanded={memoryExpanded}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                width: '100%',
                textAlign: 'left',
                padding: '16px 18px',
                borderRadius: 14,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-low)',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'grid', gap: 3 }}>
                <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>
                  View and manage memory
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                  {workMemoryProfile === null
                    ? 'Loading…'
                    : workMemoryProfile.length === 0
                      ? 'Nothing learned yet'
                      : `${workMemoryProfile.length} thing${workMemoryProfile.length === 1 ? '' : 's'} Daylens has learned about you`}
                </span>
              </span>
              <span
                aria-hidden
                style={{
                  fontSize: 18,
                  lineHeight: 1,
                  color: 'var(--color-text-tertiary)',
                  transform: memoryExpanded ? 'rotate(90deg)' : 'none',
                  transition: 'transform 140ms',
                }}
              >
                ›
              </span>
            </button>
            {memoryExpanded && (
            <div style={{ marginTop: 16 }}>
            {workMemoryError && (
              <div style={{ fontSize: 12, color: '#f87171', lineHeight: 1.55, marginBottom: 10 }}>
                {workMemoryError}
              </div>
            )}
            {workMemoryChange && (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.55, marginBottom: 10 }}>
                {workMemoryChange}
              </div>
            )}

            {workMemoryProfile === null ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Loading…</div>
            ) : workMemoryProfile.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                Nothing learned yet. Tell Daylens something in chat — “remember that Acme is my biggest
                client” — or add a fact by hand below.
              </div>
            ) : (
              // One calm panel: general memory read as plain sentences, grouped
              // into readable sections (memory.md §3 / settings.md §10.4) — not a
              // stack of bordered textareas. Quiet edit/forget appear on hover.
              <div style={{ ...infoPanelStyle, marginTop: 0, padding: '6px 18px 14px', display: 'block' }}>
                {([
                  { key: 'work', label: 'Work' },
                  { key: 'personal', label: 'Personal' },
                  { key: 'preferences', label: 'Preferences' },
                ] as const).map((section) => {
                  const sectionFacts = workMemoryProfile.filter((fact) => fact.category === section.key)
                  if (sectionFacts.length === 0) return null
                  return (
                    <div key={section.key} style={{ paddingTop: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                        {section.label}
                      </div>
                      <div style={{ display: 'grid' }}>
                        {sectionFacts.map((fact) => renderMemoryFactRow(fact))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <div style={{ ...infoPanelStyle, marginTop: 10, display: 'grid', gap: 8 }}>
              <textarea
                value={newFactText}
                onChange={(event) => setNewFactText(event.target.value)}
                rows={2}
                placeholder="Add a fact Daylens couldn't infer — e.g. “Acme is my biggest client.”"
                style={{
                  width: '100%',
                  resize: 'vertical',
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  color: 'var(--color-text-primary)',
                  background: 'transparent',
                  border: '1px solid var(--color-border-ghost)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  disabled={workMemoryBusy !== null || newFactText.trim() === ''}
                  onClick={() => void addWorkMemoryFact()}
                  style={{
                    ...inlineButtonStyle,
                    opacity: workMemoryBusy !== null || newFactText.trim() === '' ? 0.6 : 1,
                    cursor: workMemoryBusy !== null || newFactText.trim() === '' ? 'default' : 'pointer',
                  }}
                >
                  {workMemoryBusy === 'add' ? 'Adding…' : 'Add fact'}
                </button>
              </div>
            </div>

            {/* DEV-108: each client's scoped memory, organized under the client
                (memory.md §3). Only the named client's memory is pulled in when
                you ask about that client. */}
            {clientMemory.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                  Client memory
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 10 }}>
                  What Daylens knows about each client — used only when you ask about that client.
                </div>
                <div style={{ ...infoPanelStyle, marginTop: 0, padding: '6px 18px 16px', display: 'block' }}>
                  {clientMemory.map((group) => {
                    const draft = clientFactDrafts[group.clientId] ?? ''
                    const addBusy = workMemoryBusy === `clientadd:${group.clientId}`
                    const canAdd = workMemoryBusy === null && draft.trim() !== ''
                    return (
                      <div key={group.clientId} style={{ paddingTop: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          {group.color && (
                            <span style={{ width: 8, height: 8, borderRadius: 999, background: group.color, flexShrink: 0 }} />
                          )}
                          <span style={{ fontSize: 12.5, fontWeight: 680, color: 'var(--color-text-primary)' }}>{group.clientName}</span>
                        </div>
                        <div style={{ display: 'grid' }}>
                          {group.facts.length === 0 ? (
                            <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6, padding: '2px 0 4px' }}>
                              Nothing yet — add what Daylens should know about {group.clientName}.
                            </div>
                          ) : (
                            group.facts.map((fact) => renderMemoryFactRow(fact))
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                          <input
                            value={draft}
                            onChange={(event) => setClientFactDrafts((current) => ({ ...current, [group.clientId]: event.target.value }))}
                            onKeyDown={(event) => { if (event.key === 'Enter' && canAdd) void addClientMemoryFact(group.clientId) }}
                            placeholder={`Add a fact about ${group.clientName}…`}
                            style={{
                              flex: 1,
                              fontSize: 13,
                              color: 'var(--color-text-primary)',
                              background: 'transparent',
                              border: '1px solid var(--color-border-ghost)',
                              borderRadius: 8,
                              padding: '7px 10px',
                              fontFamily: 'inherit',
                              boxSizing: 'border-box',
                            }}
                          />
                          <button
                            type="button"
                            disabled={!canAdd}
                            onClick={() => void addClientMemoryFact(group.clientId)}
                            style={{ ...inlineButtonStyle, opacity: canAdd ? 1 : 0.6, cursor: canAdd ? 'pointer' : 'default' }}
                          >
                            {addBusy ? 'Adding…' : 'Add'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ paddingTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={workMemoryBusy !== null}
                onClick={() => void rebuildWorkMemory()}
                style={{
                  ...inlineButtonStyle,
                  opacity: workMemoryBusy !== null ? 0.6 : 1,
                  cursor: workMemoryBusy !== null ? 'default' : 'pointer',
                }}
              >
                {workMemoryBusy === 'rebuild' ? 'Rebuilding…' : 'Rebuild from recent activity'}
              </button>
              <button
                type="button"
                disabled={workMemoryBusy !== null || (workMemoryProfile?.length ?? 0) === 0}
                onClick={() => void forgetAllWorkMemory()}
                style={{
                  ...inlineButtonStyle,
                  borderColor: 'rgba(248, 113, 113, 0.28)',
                  color: '#f87171',
                  opacity: workMemoryBusy !== null || (workMemoryProfile?.length ?? 0) === 0 ? 0.6 : 1,
                  cursor: workMemoryBusy !== null || (workMemoryProfile?.length ?? 0) === 0 ? 'default' : 'pointer',
                }}
              >
                {workMemoryBusy === 'all' ? 'Forgetting…' : 'Forget everything'}
              </button>
            </div>

            {memoryAudit && memoryAudit.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 620, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  Recent changes
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {memoryAudit.map((entry) => (
                    <div key={entry.id} style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5, display: 'flex', gap: 8 }}>
                      <span style={{ flexShrink: 0 }}>
                        {entry.action === 'remembered' ? 'Remembered' : entry.action === 'updated' ? 'Updated' : 'Forgot'}
                        {entry.source === 'chat' ? ' from chat' : ''}
                      </span>
                      <span style={{ color: 'var(--color-text-secondary)' }}>{entry.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </div>
            )}
          </div>
        </SectionPage>
      )
      break
    case 'labels':
      content = (
        <SectionPage title="Labels" description="Every app you've used and its category — including ones not categorized yet. Your override wins in Apps, Timeline, and the AI, and survives every rebuild.">
          {(() => {
            const COLLAPSED_COUNT = 5
            const query = labelSearch.trim().toLowerCase()
            const searching = query.length > 0
            const matchedApps = searching
              ? recentApps.filter((summary) => summary.appName.toLowerCase().includes(query))
              : recentApps
            // When searching, show every match. Otherwise show the most-used handful
            // until the list is expanded, so Settings opens scannable.
            const visibleApps = searching || labelsExpanded
              ? matchedApps
              : matchedApps.slice(0, COLLAPSED_COUNT)
            return (
          <div>
            {!labelsLoaded ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                Loading app labels…
              </div>
            ) : recentApps.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                Needs a little more tracked history first.
              </div>
            ) : (
              <>
                {recentApps.length > COLLAPSED_COUNT && (
                  <input
                    type="text"
                    value={labelSearch}
                    onChange={(event) => setLabelSearch(event.target.value)}
                    placeholder="Search apps to label…"
                    aria-label="Search apps"
                    style={{
                      width: '100%',
                      height: 34,
                      marginBottom: 14,
                      padding: '0 12px',
                      borderRadius: 8,
                      border: '1px solid var(--color-border-ghost)',
                      background: 'var(--color-surface-high)',
                      color: 'var(--color-text-primary)',
                      fontSize: 12.5,
                      boxSizing: 'border-box',
                    }}
                  />
                )}
                {visibleApps.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                    No apps match “{labelSearch.trim()}”.
                  </div>
                ) : (
                  visibleApps.map((summary, index) => {
                const appIdentity = summary.canonicalAppId ?? summary.bundleId
                const override = categoryOverrides[appIdentity] ?? categoryOverrides[summary.bundleId]
                const effectiveCategory = override ?? summary.category
                const busy = categoryBusyBundleId === appIdentity
                const effectMessage = relabelEffect?.bundleId === appIdentity ? relabelEffect.message : null
                return (
                  <div key={appIdentity}>
                    <SettingsRow
                      first={index === 0}
                      title={summary.appName}
                      description={`${formatDurationShort(summary.totalSeconds)} over 30 days${override ? ` · override: ${CATEGORY_OPTIONS.find((option) => option.value === override)?.label ?? override}` : ''}`}
                      control={
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                          <Select<AppCategory>
                            value={effectiveCategory}
                            width={150}
                            options={CATEGORY_OPTIONS}
                            onChange={(value) => void handleCategoryOverrideChange(appIdentity, value)}
                          />
                          {override && (
                            <button
                              type="button"
                              onClick={() => void handleCategoryOverrideClear(appIdentity)}
                              disabled={busy}
                              style={{ ...inlineButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      }
                    />
                    {effectMessage && (
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', padding: '0 0 10px 2px', lineHeight: 1.5 }}>
                        {effectMessage}
                      </div>
                    )}
                  </div>
                )
                  })
                )}
                {!searching && recentApps.length > COLLAPSED_COUNT && (
                  <button
                    type="button"
                    onClick={() => setLabelsExpanded((value) => !value)}
                    style={{ ...inlineButtonStyle, marginTop: 12, alignSelf: 'flex-start' }}
                  >
                    {labelsExpanded ? 'Show less' : `Show all ${recentApps.length} apps`}
                  </button>
                )}
              </>
            )}
          </div>
            )
          })()}
        </SectionPage>
      )
      break
    case 'clients':
      content = (
        <SectionPage title="Clients" description={`Name the things you work on so the AI can attribute time to them — once a client exists, Daylens can answer "how much did I work on X this week" with a real number.`}>
          <div>
            {!clientsLoaded ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Loading clients…</div>
            ) : clients.length === 0 && !addingClient ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                No clients yet. Add your first one to start attributing work to it.
              </div>
            ) : (
              clients.map((client, index) => {
                const isEditing = editingClientId === client.id
                const busy = clientBusyId === client.id
                const archived = client.status === 'archived'
                return (
                  <SettingsRow
                    key={client.id}
                    first={index === 0}
                    title={isEditing ? '' : client.name}
                    description={isEditing
                      ? ''
                      : `${client.projectCount} project${client.projectCount === 1 ? '' : 's'}${archived ? ' · archived' : ''}`}
                    control={
                      isEditing ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                          <input
                            type="text"
                            value={editingClientName}
                            onChange={(event) => setEditingClientName(event.target.value)}
                            style={inputStyle(180)}
                          />
                          <input
                            type="color"
                            value={editingClientColor || '#7c8cff'}
                            onChange={(event) => setEditingClientColor(event.target.value)}
                            style={{ width: 36, height: 34, padding: 0, border: '1px solid var(--color-border-ghost)', borderRadius: 8, background: 'transparent', cursor: 'pointer' }}
                            aria-label="Client color"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveClient(client.id)}
                            disabled={busy}
                            style={{ ...inlineButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditingClient}
                            disabled={busy}
                            style={{ ...inlineButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {client.color && (
                            <span
                              style={{
                                width: 12,
                                height: 12,
                                borderRadius: 4,
                                background: client.color,
                                border: '1px solid var(--color-border-ghost)',
                              }}
                              aria-hidden
                            />
                          )}
                          {!archived && (
                            <button
                              type="button"
                              onClick={() => startEditingClient(client)}
                              disabled={busy}
                              style={{ ...inlineButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                            >
                              Edit
                            </button>
                          )}
                          {archived ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleRestoreClient(client.id)}
                                disabled={busy}
                                style={{ ...inlineButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                              >
                                Restore
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteClient(client.id, client.name)}
                                disabled={busy}
                                style={{ ...inlineButtonStyle, borderColor: 'rgba(248, 113, 113, 0.28)', color: '#f87171', opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleArchiveClient(client.id)}
                              disabled={busy}
                              style={{ ...inlineButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                            >
                              Archive
                            </button>
                          )}
                        </div>
                      )
                    }
                  />
                )
              })
            )}

            {addingClient ? (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                  padding: '14px 16px',
                  borderRadius: 12,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface-low)',
                  marginTop: 14,
                }}
              >
                <input
                  type="text"
                  placeholder="Client or project name"
                  value={newClientName}
                  autoFocus
                  onChange={(event) => setNewClientName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateClient() }}
                  style={inputStyle(220)}
                />
                <input
                  type="color"
                  value={newClientColor}
                  onChange={(event) => setNewClientColor(event.target.value)}
                  style={{ width: 36, height: 34, padding: 0, border: '1px solid var(--color-border-ghost)', borderRadius: 8, background: 'transparent', cursor: 'pointer' }}
                  aria-label="Client color"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateClient()}
                  disabled={clientBusyId === '__new__' || !newClientName.trim()}
                  style={{
                    ...inlineButtonStyle,
                    background: 'var(--gradient-primary)',
                    color: 'var(--color-primary-contrast)',
                    border: 'none',
                    opacity: clientBusyId === '__new__' || !newClientName.trim() ? 0.5 : 1,
                    cursor: clientBusyId === '__new__' || !newClientName.trim() ? 'default' : 'pointer',
                  }}
                >
                  {clientBusyId === '__new__' ? 'Adding…' : 'Add client'}
                </button>
                <button
                  type="button"
                  onClick={() => { setAddingClient(false); setNewClientName(''); setNewClientColor('#7c8cff'); setClientFormError(null) }}
                  style={inlineButtonStyle}
                >
                  Cancel
                </button>
                {clientFormError && (
                  <div style={{ flexBasis: '100%', fontSize: 12, color: 'var(--color-focus-amber, #d97706)' }}>{clientFormError}</div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setAddingClient(true); setClientFormError(null) }}
                style={{ ...inlineButtonStyle, marginTop: clients.length > 0 ? 16 : 0, alignSelf: 'flex-start' }}
              >
                + Add client
              </button>
            )}
          </div>
        </SectionPage>
      )
      break
    case 'notifications':
      content = (
        <SectionPage title="Notifications" description="Your morning brief, evening wrap, and focus alerts.">
          <div>
            <SettingsRow
              first
              title="Evening wrap"
              description="End-of-day recap of what you worked on."
              control={<Toggle checked={settings.dailySummaryEnabled ?? true} onChange={(value) => void persist({ dailySummaryEnabled: value })} />}
            />
            <SettingsRow
              title="Morning brief"
              description="Short morning recap of yesterday and the day ahead."
              control={<Toggle checked={settings.morningNudgeEnabled ?? true} onChange={(value) => void persist({ morningNudgeEnabled: value })} />}
            />
            <SettingsRow
              title="Distraction alerts"
              description="Warn when a focus session drifts."
              control={<Toggle checked={settings.distractionAlertsEnabled ?? true} onChange={(value) => void persist({ distractionAlertsEnabled: value })} />}
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
            {notificationPermission === 'denied' && (
              <div style={infoPanelStyle}>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                  Notifications are off for Daylens. Open System Settings → Notifications → Daylens and allow alerts, then restart Daylens if briefs still do not appear.
                </div>
                <button
                  type="button"
                  style={{ ...inlineButtonStyle, marginTop: 10 }}
                  onClick={() => void ipc.notifications.openSettings()}
                >
                  Open System Settings
                </button>
              </div>
            )}
            {trackingDiagnostics?.platform === 'linux' && linuxDesktop && !linuxDesktop.notificationSupported && (
              <div style={infoPanelStyle}>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                  Desktop notifications are unavailable in this Linux session right now, so Daylens can keep tracking but distraction alerts and recaps may not surface as native notifications until the session notification service is available.
                </div>
              </div>
            )}
          </div>
        </SectionPage>
      )
      break
    case 'updates':
      content = (
        <SectionPage title="Updates" description="Daylens keeps itself up to date. In a dev build, updates come through the dev workflow." maxWidth={760}>
          <UpdatesContent />
        </SectionPage>
      )
      break
    case 'help':
      content = (
        <SectionPage title="Help & support" description="Stuck, confused, or found something broken? Talk to us — a real answer, not a ticket number." maxWidth={760}>
          <div>
            <SettingsRow
              first
              title="Chat with us"
              description="Opens the in-app messenger. Ask a question, report a bug, or tell us what you wish Daylens did — replies land right here in the app."
              control={
                <button type="button" style={inlineButtonStyle} onClick={() => showIntercom()}>
                  Open chat
                </button>
              }
            />
          </div>
        </SectionPage>
      )
      break
    case 'mcp':
      content = (
        <SectionPage title="MCP server" description="Let other AI apps — Claude Desktop, Cursor, Claude Code — read your Daylens activity so you can ask them about your work. Off by default, and everything stays on your machine.">
          <div>
            <SettingsRow
              first
              title="Enable MCP server"
              description="When on, connected apps can query your local activity data (which apps and sites, for how long). They read only — nothing is written, and nothing leaves your machine except what you ask about."
              control={
                <Toggle
                  checked={settings.mcpServerEnabled ?? false}
                  onChange={(value) => void persist({ mcpServerEnabled: value })}
                />
              }
            />
            {(settings.mcpServerEnabled ?? false) && mcpConfig && (
              <div style={{ paddingTop: 14, borderTop: '1px solid var(--color-border-ghost)' }}>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                  Daylens is ready to connect. In your AI app, add Daylens as an MCP server using the configuration below.
                </div>
                <button
                  type="button"
                  onClick={() => setMcpAdvancedOpen((value) => !value)}
                  aria-expanded={mcpAdvancedOpen}
                  style={{ ...inlineButtonStyle, marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <span aria-hidden style={{ transform: mcpAdvancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 140ms' }}>›</span>
                  {mcpAdvancedOpen ? 'Hide configuration' : 'Advanced — show configuration'}
                </button>
                {mcpAdvancedOpen && (
                <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginBottom: 8, lineHeight: 1.55 }}>
                  Add the following to your MCP client config (Claude Desktop: <code style={{ fontSize: 11.5 }}>{claudeDesktopConfigDisplayPath(trackingDiagnostics?.platform ?? 'darwin')}</code>):
                </div>
                <div style={{ position: 'relative' }}>
                  <pre style={{
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    background: 'var(--color-surface-low)',
                    border: '1px solid var(--color-border-ghost)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    overflowX: 'auto',
                    margin: 0,
                    color: 'var(--color-text-primary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {JSON.stringify({
                      mcpServers: {
                        daylens: {
                          command: mcpConfig.command,
                          args: mcpConfig.args,
                          env: mcpConfig.env,
                        },
                      },
                    }, null, 2)}
                  </pre>
                  <button
                    type="button"
                    onClick={() => {
                      const snippet = JSON.stringify({
                        mcpServers: {
                          daylens: {
                            command: mcpConfig.command,
                            args: mcpConfig.args,
                            env: mcpConfig.env,
                          },
                        },
                      }, null, 2)
                      void navigator.clipboard.writeText(snippet).then(() => {
                        setMcpSnippetCopied(true)
                        setTimeout(() => setMcpSnippetCopied(false), 2000)
                      })
                    }}
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      height: 26,
                      padding: '0 10px',
                      borderRadius: 6,
                      border: '1px solid var(--color-border-ghost)',
                      background: 'var(--color-surface-high)',
                      color: 'var(--color-text-secondary)',
                      fontSize: 11.5,
                      cursor: 'pointer',
                    }}
                  >
                    {mcpSnippetCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 8, lineHeight: 1.55 }}>
                  Reads <code style={{ fontSize: 11 }}>{mcpConfig.dbPath}</code> — your real local database.
                </div>
                {!mcpConfig.isPackaged && (
                  <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 6, lineHeight: 1.55 }}>
                    Dev build — the paths above point at your source checkout. A packaged install runs the bundled
                    server from inside the app and ships with this server off by default.
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 6, lineHeight: 1.55 }}>
                  After updating the config, restart your MCP client for the changes to take effect.
                </div>
                </div>
                )}
              </div>
            )}
          </div>
        </SectionPage>
      )
      break
    case 'enrichment':
      content = (
        <SectionPage title="Enrichment sources" description="Optional local sources that make your Wrapped richer: what you shipped, what meetings you had, when you focused. Everything stays on this machine. Git and calendar are read automatically when the tools exist; focus apps and MCP servers stay off until you turn them on.">
          <div style={{ display: 'grid', gap: 24 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>Always available</div>
              <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
                Git commits and calendar events are read automatically when the tools exist on this machine (git, the gh CLI, icalBuddy). Nothing to configure.
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 10 }}>MCP servers on this machine</div>
              {enrichmentSources === null ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Looking for installed servers…</div>
              ) : enrichmentSources.mcpServers.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                  None found in your Claude Desktop config. If you use Notion, Linear, or Jira through MCP, they'll show up here as future wrap sources.
                </div>
              ) : (
                enrichmentSources.mcpServers.map((server, i) => (
                  <SettingsRow
                    key={server.name}
                    first={i === 0}
                    title={server.name}
                    description={`Discovered in your Claude Desktop config (${server.transport}). Turning it on marks it as a wrap source; Daylens doesn't read it yet.`}
                    control={
                      <Toggle
                        checked={server.enabled}
                        onChange={(value) => toggleEnrichmentSource(`mcp:${server.name}`, value)}
                      />
                    }
                  />
                ))
              )}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 10 }}>Focus apps</div>
              {enrichmentSources === null ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>Checking…</div>
              ) : enrichmentSources.focusApps.filter((f) => f.installed).length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                  No focus apps found. Daylens looks for Raycast Focus, Be Focused, and Session.
                </div>
              ) : (
                enrichmentSources.focusApps.filter((f) => f.installed).map((focus, i) => (
                  <SettingsRow
                    key={focus.app}
                    first={i === 0}
                    title={focus.app}
                    description="When on, focus sessions from this app can appear in your wraps."
                    control={
                      <Toggle
                        checked={focus.enabled}
                        onChange={(value) => toggleEnrichmentSource(`focus:${focus.app}`, value)}
                      />
                    }
                  />
                ))
              )}
            </div>
          </div>
        </SectionPage>
      )
      break
    case 'capture':
      content = (
        <SectionPage title="Capture health" description="Whether Daylens is capturing what you're working on — not just which app is open.">
          <CaptureHealthContent diagnostics={trackingDiagnostics} />
        </SectionPage>
      )
      break
    case 'privacy':
      content = (
        <SectionPage title="Privacy & tracking" description="Decide what Daylens sees. Your history stays on this machine, and exclusions are honored everywhere — including data already captured before you excluded them.">
          <div style={{ display: 'grid', gap: 24 }}>
            <div>
              <GroupLabel>Preferences</GroupLabel>
              <TrackingControlsContent settings={settings} persist={persist} />
            </div>
            <div>
              <GroupLabel>Your data</GroupLabel>
              <SettingsRow
                first
                title="Analytics"
                description="Anonymous product telemetry — event names and counts only. No titles, URLs, or file paths ever leave this machine."
                control={<StatusPill label="Anonymous" />}
              />
              <SettingsRow
                title="Local data"
                description="Tracked history lives in the local Daylens database."
                control={<StatusPill label="Local only" />}
              />
              <SettingsRow
                title="Reset and uninstall"
                description="Remove Daylens from this computer: the launch-at-login entry is cleared, and you choose whether your local data is deleted or kept."
                control={(
                  <button
                    type="button"
                    disabled={resetAndUninstallBusy}
                    onClick={() => void startResetAndUninstall()}
                    style={{
                      ...inlineButtonStyle,
                      borderColor: 'rgba(248, 113, 113, 0.28)',
                      color: '#f87171',
                      opacity: resetAndUninstallBusy ? 0.6 : 1,
                      cursor: resetAndUninstallBusy ? 'default' : 'pointer',
                    }}
                  >
                    {resetAndUninstallBusy ? 'Uninstalling…' : 'Reset and uninstall…'}
                  </button>
                )}
              />
            </div>
          </div>
        </SectionPage>
      )
      break
  }

  const originDef = navOrigin ? ALL_SECTIONS.find((s) => s.id === navOrigin) ?? null : null

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
      <SettingsRail
        active={activeSection}
        onSelect={selectSection}
        search={sectionSearch}
        onSearch={setSectionSearch}
      />
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        <div key={activeSection} style={{ padding: '34px 44px 72px' }}>
          {settingsWriteError && (
            <div role="alert" style={{ ...infoPanelStyle, color: '#f87171', marginTop: 0, marginBottom: 16 }}>
              {settingsWriteError}
            </div>
          )}
          {Object.keys(settingsLoadErrors).length > 0 && (
            <div role="alert" style={{ ...infoPanelStyle, color: '#f87171', marginTop: 0, marginBottom: 16 }}>
              Could not load {Object.keys(settingsLoadErrors).join(', ')}. The page is keeping the last known state instead of treating the failed read as empty.
            </div>
          )}
          {originDef && (
            <button
              type="button"
              onClick={() => selectSection(originDef.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 18,
                padding: '5px 10px 5px 8px',
                borderRadius: 8,
                border: '1px solid var(--color-border-ghost)',
                background: 'var(--color-surface-low)',
                color: 'var(--color-text-secondary)',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>←</span>
              Back to {originDef.label}
            </button>
          )}
          {content}
        </div>
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
