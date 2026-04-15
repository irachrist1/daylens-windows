import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { AIProvider, AIProviderMode, AIModelStrategy, AppSettings, AppTheme } from '@shared/types'
import { ipc } from '../lib/ipc'
import { AI_PROVIDER_META, detectProviderFromApiKey } from '../lib/aiProvider'

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

function sectionTitle(label: string) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 800,
      letterSpacing: '0.10em',
      textTransform: 'uppercase',
      color: 'var(--color-text-tertiary)',
      marginBottom: 10,
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
      onClick={() => onChange(!checked)}
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
}: {
  title: string
  description?: string
  control?: ReactNode
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 14,
      padding: '12px 0',
      borderTop: '1px solid var(--color-border-ghost)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>{title}</div>
        {description && (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3, lineHeight: 1.55 }}>
            {description}
          </div>
        )}
      </div>
      {control && <div style={{ flexShrink: 0 }}>{control}</div>}
    </div>
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

function normalizeFallbackOrder(order: AIProvider[]): AIProvider[] {
  const unique = order.filter((provider, index) => order.indexOf(provider) === index)
  for (const provider of API_PROVIDERS.map((entry) => entry.id)) {
    if (!unique.includes(provider)) unique.push(provider)
  }
  return unique.slice(0, API_PROVIDERS.length)
}

const panelStyle: CSSProperties = {
  borderRadius: 18,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface)',
  padding: '18px 20px',
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [cliTools, setCliTools] = useState<{ claude: string | null; codex: string | null }>({ claude: null, codex: null })

  useEffect(() => {
    void (async () => {
      const current = await ipc.settings.get()
      const [access, tools] = await Promise.all([
        ipc.settings.hasApiKey(current.aiProvider),
        ipc.ai.detectCliTools().catch(() => ({ claude: null, codex: null })),
      ])
      setSettings(current)
      setHasApiKey(access)
      setCliTools(tools as { claude: string | null; codex: string | null })
    })()
  }, [])

  useEffect(() => {
    if (!settings) return
    void ipc.settings.hasApiKey(settings.aiProvider).then((access) => setHasApiKey(access))
  }, [settings?.aiProvider])

  const providerStatus = useMemo(() => {
    if (!settings) return ''
    if (settings.aiProvider === 'claude-cli') return cliTools.claude ? 'Installed' : 'Not installed'
    if (settings.aiProvider === 'codex-cli') return cliTools.codex ? 'Installed' : 'Not installed'
    return hasApiKey ? 'Key saved' : 'No key saved'
  }, [cliTools, hasApiKey, settings])

  async function persist(partial: Partial<AppSettings>) {
    if (!settings) return
    const next = { ...settings, ...partial }
    setSettings(next)
    await ipc.settings.set(partial)
  }

  async function saveApiKey() {
    if (!settings) return
    const trimmed = apiKeyInput.trim()
    const detectedProvider = detectProviderFromApiKey(trimmed)

    if (trimmed && detectedProvider && detectedProvider !== settings.aiProvider) {
      await persist({ aiProvider: detectedProvider })
    }

    const activeProvider = detectedProvider ?? settings.aiProvider
    if (trimmed) {
      await ipc.settings.setApiKey(trimmed, activeProvider)
      setHasApiKey(true)
      setApiKeyInput('')
      setSaveMessage(`${AI_PROVIDER_META[activeProvider].label} key saved`)
    } else {
      await ipc.settings.clearApiKey(activeProvider)
      setHasApiKey(false)
      setSaveMessage(`${AI_PROVIDER_META[activeProvider].label} key cleared`)
    }
    window.setTimeout(() => setSaveMessage(null), 2400)
  }

  if (!settings) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Loading settings…</p>
      </div>
    )
  }

  return (
    <div style={{ padding: '30px 32px 40px', maxWidth: 920 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 32, lineHeight: 1.05, letterSpacing: '-0.03em', margin: 0, color: 'var(--color-text-primary)' }}>
          Settings
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', margin: '8px 0 0' }}>
          Real controls only: tracking, AI access, notifications, privacy, and background behavior.
        </p>
      </div>

      <div style={{ display: 'grid', gap: 18 }}>
        <section style={panelStyle}>
          {sectionTitle('Tracking')}
          <div style={{ borderTop: '1px solid transparent' }}>
            <SettingsRow
              title="Automatic tracking"
              description="Runs in the background while Daylens is open, and keeps tracking even when the main window is closed."
              control={<span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e' }}>Active</span>}
            />
            <SettingsRow
              title="Launch on login"
              description="Start Daylens automatically so tracking survives restarts and normal daily use."
              control={<Toggle checked={settings.launchOnLogin} onChange={(value) => void persist({ launchOnLogin: value })} />}
            />
            <SettingsRow
              title="Default focus session"
              description="Used when you start a focus session without choosing a duration."
              control={
                <input
                  type="number"
                  min={10}
                  max={180}
                  step={5}
                  value={settings.defaultFocusMinutes ?? 50}
                  onChange={(event) => void persist({ defaultFocusMinutes: Math.max(10, Number(event.target.value) || 50) })}
                  style={inputStyle(72)}
                />
              }
            />
          </div>
        </section>

        <section style={panelStyle}>
          {sectionTitle('AI')}
          <div style={{ marginBottom: 12 }}>
            <Segmented
              value={settings.aiProvider}
              options={PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
              onChange={(value) => void persist({ aiProvider: value })}
            />
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Primary provider status: {providerStatus}
          </div>
          {(settings.aiProvider === 'anthropic' || settings.aiProvider === 'openai' || settings.aiProvider === 'google') && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                placeholder={`Paste your ${AI_PROVIDER_META[settings.aiProvider].label} key`}
                style={{ ...inputStyle(), flex: 1 }}
              />
              <button onClick={() => void saveApiKey()} style={primaryButtonStyle}>
                {apiKeyInput.trim() ? 'Save key' : 'Clear key'}
              </button>
            </div>
          )}
          {(settings.aiProvider === 'claude-cli' || settings.aiProvider === 'codex-cli') && (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              {settings.aiProvider === 'claude-cli'
                ? cliTools.claude
                  ? `Claude CLI detected at ${cliTools.claude}.`
                  : 'Claude CLI is not detected yet. Install it first, then Daylens can route AI requests through your local CLI.'
                : cliTools.codex
                  ? `Codex detected at ${cliTools.codex}.`
                  : 'Codex is not detected yet. Install it first, then Daylens can route AI requests through your local CLI.'}
            </div>
          )}
          <div style={{ marginTop: 16, borderTop: '1px solid var(--color-border-ghost)', paddingTop: 16, display: 'grid', gap: 12 }}>
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

            <SettingsRow
              title="Fallback order"
              description="Provider fallback applies when the preferred route is missing, exhausted, or unavailable."
              control={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
            />
            <SettingsRow
              title="Chat provider"
              description="Used for the AI view and starter prompts."
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
              description="Used for closed-block relabeling and overnight cleanup."
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
              description="Used for day, week, and app narratives."
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
              description="Reserved for report, table, chart, and export generation."
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
              description="Runs non-blocking relabel and cleanup jobs without making the timeline depend on AI."
              control={<Toggle checked={settings.aiBackgroundEnrichment ?? true} onChange={(value) => void persist({ aiBackgroundEnrichment: value })} />}
            />
            <SettingsRow
              title="Active-block preview naming"
              description="Keeps provisional live naming opt-in so labels do not visibly thrash while you work."
              control={<Toggle checked={settings.aiActiveBlockPreview ?? false} onChange={(value) => void persist({ aiActiveBlockPreview: value })} />}
            />
            <SettingsRow
              title="Prompt caching"
              description="Allows provider-side prompt caching when Daylens is using long stable prefixes or repeated summary jobs."
              control={<Toggle checked={settings.aiPromptCachingEnabled ?? true} onChange={(value) => void persist({ aiPromptCachingEnabled: value })} />}
            />
            <SettingsRow
              title="Spend soft limit"
              description="A lightweight guardrail for future usage warnings and cost controls."
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
              description="Masks local paths before prompts go to cloud providers."
              control={<Toggle checked={settings.aiRedactFilePaths ?? false} onChange={(value) => void persist({ aiRedactFilePaths: value })} />}
            />
            <SettingsRow
              title="Redact email addresses"
              description="Masks email-style strings before prompts go to cloud providers."
              control={<Toggle checked={settings.aiRedactEmails ?? false} onChange={(value) => void persist({ aiRedactEmails: value })} />}
            />
          </div>
          {saveMessage && (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 10 }}>
              {saveMessage}
            </div>
          )}
        </section>

        <section style={panelStyle}>
          {sectionTitle('Notifications')}
          <div style={{ borderTop: '1px solid transparent' }}>
            <SettingsRow
              title="Daily recap"
              description="Show an end-of-day recap notification using your local summary."
              control={<Toggle checked={settings.dailySummaryEnabled ?? true} onChange={(value) => void persist({ dailySummaryEnabled: value })} />}
            />
            <SettingsRow
              title="Morning nudge"
              description="A small reminder if the day has started and tracking is still quiet."
              control={<Toggle checked={settings.morningNudgeEnabled ?? true} onChange={(value) => void persist({ morningNudgeEnabled: value })} />}
            />
            <SettingsRow
              title="Distraction alerts"
              description="Warn when a focus session drifts off course for too long."
              control={<Toggle checked={settings.distractionAlertsEnabled ?? false} onChange={(value) => void persist({ distractionAlertsEnabled: value })} />}
            />
            <SettingsRow
              title="Distraction threshold"
              description="How long Daylens waits before nudging you during a focus session."
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
          </div>
        </section>

        <section style={panelStyle}>
          {sectionTitle('Appearance')}
          <div style={{ marginBottom: 12 }}>
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
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
            Daylens should feel like a desktop app, so the appearance settings stay intentionally sparse.
          </div>
        </section>

        <section style={panelStyle}>
          {sectionTitle('Privacy')}
          <div style={{ borderTop: '1px solid transparent' }}>
            <SettingsRow
              title="Analytics"
              description="Share anonymous product telemetry so crashes and regressions are easier to fix."
              control={<Toggle checked={settings.analyticsOptIn} onChange={(value) => void persist({ analyticsOptIn: value })} />}
            />
            <SettingsRow
              title="Local data"
              description="Tracked history stays in your local Daylens database. There is no decorative export or delete control here until the action is actually implemented."
              control={<span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Local only</span>}
            />
          </div>
        </section>
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

const primaryButtonStyle: CSSProperties = {
  height: 34,
  borderRadius: 9,
  border: 'none',
  background: 'var(--gradient-primary)',
  color: 'var(--color-primary-contrast)',
  padding: '0 14px',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
}
