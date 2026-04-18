import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { ANALYTICS_EVENT } from '@shared/analytics'
import type { AIProvider, AIProviderMode, ProviderConnectionResult } from '@shared/types'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { AI_PROVIDER_META, AI_PROVIDERS, detectProviderFromApiKey } from '../lib/aiProvider'

const PRIMARY_PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  google: 'Gemini',
}

function providerLabel(provider: AIProviderMode): string {
  return AI_PROVIDER_META[provider].shortLabel
}

export default function ConnectAI({
  variant = 'hero',
  initialProvider,
  hasSavedAccess,
  onConnected,
}: {
  variant?: 'hero' | 'inline' | 'embedded'
  initialProvider: AIProviderMode
  hasSavedAccess: boolean
  onConnected?: (provider: AIProviderMode) => void
}) {
  const [selectedProvider, setSelectedProvider] = useState<AIProviderMode>(initialProvider)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(initialProvider === 'claude-cli' || initialProvider === 'codex-cli')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'neutral' | 'success' | 'error'; message: string } | null>(null)
  const [allowSaveAnyway, setAllowSaveAnyway] = useState<ProviderConnectionResult | null>(null)
  const [connectedProvider, setConnectedProvider] = useState<AIProviderMode | null>(hasSavedAccess ? initialProvider : null)
  const [cliTools, setCliTools] = useState<{ claude: string | null; codex: string | null }>({ claude: null, codex: null })
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    setSelectedProvider(initialProvider)
    setConnectedProvider(hasSavedAccess ? initialProvider : null)
    if (initialProvider === 'claude-cli' || initialProvider === 'codex-cli') {
      setShowAdvanced(true)
    }
  }, [hasSavedAccess, initialProvider])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!showAdvanced) return
    void ipc.ai.detectCliTools().then((tools) => {
      setCliTools(tools as { claude: string | null; codex: string | null })
    }).catch(() => {
      setCliTools({ claude: null, codex: null })
    })
  }, [showAdvanced])

  const detectedProvider = useMemo(() => detectProviderFromApiKey(apiKey), [apiKey])
  const activeApiProvider: AIProvider = (selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli'
    ? (detectedProvider ?? 'anthropic')
    : selectedProvider)
  const isEmbedded = variant === 'embedded'
  const selectedProviderConnected = connectedProvider === selectedProvider
  const selectedCliProvider = selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli'

  useEffect(() => {
    if (!detectedProvider) return
    if (selectedProvider === detectedProvider) return
    if (selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli' || AI_PROVIDERS.includes(selectedProvider as AIProvider)) {
      setSelectedProvider(detectedProvider)
      setFeedback({
        tone: 'neutral',
        message: `That key looks like ${PRIMARY_PROVIDER_LABELS[detectedProvider]}. Daylens switched the provider for you.`,
      })
      setAllowSaveAnyway(null)
    }
  }, [detectedProvider, selectedProvider])

  function clearFeedbackSoon() {
    window.setTimeout(() => setFeedback(null), 3200)
  }

  async function persistConnection(provider: AIProviderMode, key: string | null) {
    if (key && provider !== 'claude-cli' && provider !== 'codex-cli') {
      await ipc.settings.setApiKey(key, provider)
    }
    const currentSettings = await ipc.settings.get()
    await ipc.settings.set({
      aiProvider: provider,
      onboardingState: {
        ...currentSettings.onboardingState,
        aiSetupState: 'connected',
      },
    })
    setConnectedProvider(provider)
    setApiKey('')
    setAllowSaveAnyway(null)
    onConnected?.(provider)
  }

  async function handleConnect(forceSave = false) {
    if (busy) return
    setBusy(true)
    setFeedback(null)

    track(ANALYTICS_EVENT.AI_PROVIDER_CONNECTION_STARTED, {
      connection_kind: selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli' ? 'cli' : 'api_key',
      provider: selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli' ? selectedProvider : activeApiProvider,
      surface: isEmbedded ? 'settings' : 'ai',
      trigger: 'manual',
    })

    try {
      if (selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli') {
        const available = selectedProvider === 'claude-cli' ? cliTools.claude : cliTools.codex
        if (!available) {
          track(ANALYTICS_EVENT.AI_PROVIDER_CONNECTION_FAILED, {
            connection_kind: 'cli',
            failure_kind: 'provider',
            provider: selectedProvider,
            result: 'not_installed',
            surface: isEmbedded ? 'settings' : 'ai',
          })
          setFeedback({
            tone: 'error',
            message: `${providerLabel(selectedProvider)} is not installed on this machine yet.`,
          })
          return
        }
        await persistConnection(selectedProvider, null)
        track(ANALYTICS_EVENT.AI_PROVIDER_CONNECTION_COMPLETED, {
          connection_kind: 'cli',
          provider: selectedProvider,
          result: 'success',
          surface: isEmbedded ? 'settings' : 'ai',
        })
        setFeedback({
          tone: 'success',
          message: `${providerLabel(selectedProvider)} is connected and ready.`,
        })
        clearFeedbackSoon()
        return
      }

      const trimmed = apiKey.trim()
      const validation = forceSave && allowSaveAnyway
        ? allowSaveAnyway
        : await ipc.settings.validateApiKey(activeApiProvider, trimmed)

      if (validation.detectedProvider && validation.detectedProvider !== activeApiProvider) {
        setSelectedProvider(validation.detectedProvider)
      }

      if (validation.status === 'valid' || (forceSave && validation.canSaveAnyway)) {
        await persistConnection(activeApiProvider, trimmed)
        track(ANALYTICS_EVENT.AI_PROVIDER_CONNECTION_COMPLETED, {
          connection_kind: 'api_key',
          provider: activeApiProvider,
          result: validation.status === 'valid' ? 'success' : 'saved_anyway',
          surface: isEmbedded ? 'settings' : 'ai',
        })
        setFeedback({
          tone: 'success',
          message: validation.status === 'valid'
            ? validation.message
            : `${PRIMARY_PROVIDER_LABELS[activeApiProvider]} was saved. Daylens will retry validation later.`,
        })
        clearFeedbackSoon()
        return
      }

      if (validation.status === 'provider_unreachable' && validation.canSaveAnyway) {
        track(ANALYTICS_EVENT.AI_PROVIDER_CONNECTION_FAILED, {
          connection_kind: 'api_key',
          failure_kind: 'network',
          provider: activeApiProvider,
          result: validation.status,
          surface: isEmbedded ? 'settings' : 'ai',
        })
        setAllowSaveAnyway(validation)
        setFeedback({ tone: 'error', message: validation.message })
        return
      }

      setAllowSaveAnyway(null)
      track(ANALYTICS_EVENT.AI_PROVIDER_CONNECTION_FAILED, {
        connection_kind: 'api_key',
        failure_kind: validation.status === 'unsupported_format' ? 'provider' : 'auth',
        provider: activeApiProvider,
        result: validation.status,
        surface: isEmbedded ? 'settings' : 'ai',
      })
      setFeedback({
        tone: validation.status === 'unsupported_format' ? 'neutral' : 'error',
        message: validation.message,
      })
    } finally {
      setBusy(false)
    }
  }

  const badgeLabel = selectedProviderConnected ? 'Connected' : 'Not connected'
  const cardPadding = variant === 'hero' ? '22px 24px' : variant === 'inline' ? '18px 20px' : 0
  const titleSize = variant === 'hero' ? 18 : isEmbedded ? 14 : 15
  const bodySize = variant === 'hero' ? 13.5 : 12.75
  const showEducationalCopy = variant === 'hero'
  const containerStyle: CSSProperties = isEmbedded
    ? { padding: 0 }
    : {
        borderRadius: 18,
        border: '1px solid var(--color-border-ghost)',
        background: 'var(--color-surface)',
        padding: cardPadding,
        transition: reducedMotion ? undefined : 'border-color 160ms ease, background 160ms ease',
      }
  const primaryButtonLabel = busy
    ? 'Connecting…'
    : selectedProviderConnected
      ? 'Connected'
      : selectedCliProvider
        ? 'Connect'
        : 'Save and test'

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: titleSize, fontWeight: 760, color: 'var(--color-text-primary)' }}>
            {isEmbedded ? 'Connection' : 'Connect AI'}
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: bodySize,
              lineHeight: 1.7,
              color: 'var(--color-text-secondary)',
              maxWidth: showEducationalCopy ? 620 : 560,
            }}
          >
            {showEducationalCopy
              ? 'Daylens AI turns your tracked work into usable answers. An API key is just the credential that lets Daylens talk to your own provider account. The key stays in your OS keychain, and billing stays with your provider.'
              : 'Connect your own provider account so Daylens can answer questions about your work history.'}
          </div>
        </div>
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 999,
            border: selectedProviderConnected ? '1px solid rgba(79, 219, 200, 0.24)' : '1px solid var(--color-border-ghost)',
            background: selectedProviderConnected ? 'rgba(79, 219, 200, 0.10)' : 'rgba(255, 255, 255, 0.03)',
            color: selectedProviderConnected ? 'var(--color-focus-green)' : 'var(--color-text-tertiary)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          {badgeLabel}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {AI_PROVIDERS.map((provider) => {
          const selected = selectedProvider === provider
          return (
            <button
              type="button"
              key={provider}
              onClick={() => setSelectedProvider(provider)}
              style={{
                padding: '8px 14px',
                borderRadius: 999,
                border: selected ? '1px solid rgba(125, 193, 255, 0.40)' : '1px solid var(--color-border-ghost)',
                background: selected ? 'rgba(97, 165, 255, 0.12)' : 'transparent',
                color: selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                fontSize: 12.5,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {PRIMARY_PROVIDER_LABELS[provider]}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ position: 'relative' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value)
              setAllowSaveAnyway(null)
            }}
            placeholder={`Paste your ${AI_PROVIDER_META[activeApiProvider].label} key`}
            style={{
              width: '100%',
              height: 42,
              borderRadius: 12,
              border: '1px solid var(--color-border-ghost)',
              background: 'var(--color-surface-high)',
              color: 'var(--color-text-primary)',
              padding: '0 44px 0 14px',
              outline: 'none',
              fontSize: 13,
            }}
            disabled={busy || selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli'}
          />
          <button
            type="button"
            onClick={() => setShowKey((value) => !value)}
            disabled={busy || selectedProvider === 'claude-cli' || selectedProvider === 'codex-cli'}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 42,
              height: 42,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              cursor: 'pointer',
            }}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={() => void handleConnect(false)}
            disabled={busy || ((selectedProvider !== 'claude-cli' && selectedProvider !== 'codex-cli') && !apiKey.trim())}
            style={{
              minWidth: 126,
              height: 40,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: selectedProviderConnected ? 'rgba(79, 219, 200, 0.16)' : 'var(--gradient-primary)',
              color: selectedProviderConnected ? 'var(--color-focus-green)' : 'var(--color-primary-contrast)',
              fontSize: 12.5,
              fontWeight: 800,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {primaryButtonLabel}
            {selectedProviderConnected && (
              <span style={{ fontSize: 12, lineHeight: 1 }} aria-hidden="true">✓</span>
            )}
          </button>

          {allowSaveAnyway && (
            <button
              type="button"
              onClick={() => void handleConnect(true)}
              disabled={busy}
              style={{
                height: 40,
                padding: '0 14px',
                borderRadius: 12,
                border: '1px solid var(--color-border-ghost)',
                background: 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 12.5,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Save anyway
            </button>
          )}

          <button
            type="button"
            onClick={() => { ipc.shell.openExternal(AI_PROVIDER_META[activeApiProvider].docsUrl) }}
            style={{
              height: 40,
              padding: '0 14px',
              borderRadius: 12,
              border: '1px solid var(--color-border-ghost)',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Where do I get this?
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          style={{
            justifySelf: 'start',
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--color-text-tertiary)',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
        </button>

        {showAdvanced && (
          <div style={{
            display: 'grid',
            gap: 10,
            borderRadius: 16,
            border: isEmbedded ? 'none' : '1px solid var(--color-border-ghost)',
            background: isEmbedded ? 'var(--color-surface-low)' : 'rgba(255, 255, 255, 0.02)',
            padding: isEmbedded ? '12px 14px' : '14px 14px 12px',
          }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
              Advanced lets you route Daylens through a local CLI instead of an API key.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(['claude-cli', 'codex-cli'] as const).map((provider) => {
                const installed = provider === 'claude-cli' ? cliTools.claude : cliTools.codex
                const selected = selectedProvider === provider
                return (
                  <button
                    type="button"
                    key={provider}
                    onClick={() => setSelectedProvider(provider)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 12,
                      border: selected ? '1px solid rgba(125, 193, 255, 0.40)' : '1px solid var(--color-border-ghost)',
                      background: selected ? 'rgba(97, 165, 255, 0.10)' : 'transparent',
                      color: 'var(--color-text-primary)',
                      cursor: 'pointer',
                      minWidth: 156,
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>{providerLabel(provider)}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                      {installed ? `Detected at ${installed}` : 'Not installed yet'}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {feedback && (
          <div
            style={{
              borderRadius: 12,
              border: feedback.tone === 'success'
                ? '1px solid rgba(79, 219, 200, 0.22)'
                : feedback.tone === 'error'
                  ? '1px solid rgba(248, 113, 113, 0.24)'
                  : '1px solid var(--color-border-ghost)',
              background: feedback.tone === 'success'
                ? 'rgba(79, 219, 200, 0.10)'
                : feedback.tone === 'error'
                  ? 'rgba(248, 113, 113, 0.08)'
                  : 'rgba(255, 255, 255, 0.03)',
              color: feedback.tone === 'success'
                ? 'var(--color-focus-green)'
                : feedback.tone === 'error'
                  ? '#fecaca'
                  : 'var(--color-text-secondary)',
              padding: '11px 12px',
              fontSize: 12.5,
              lineHeight: 1.65,
            }}
          >
            {feedback.message}
          </div>
        )}
      </div>

    </div>
  )
}
