import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { ANALYTICS_EVENT } from '@shared/analytics'
import { CLI_PROVIDERS, cliToolForProvider, isCliProvider } from '@shared/aiProviderState'
import type { AIProvider, AIProviderMode, ProviderConnectionResult } from '@shared/types'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { AI_PROVIDER_META, AI_PROVIDERS, detectProviderFromApiKey } from '../lib/aiProvider'

const PRIMARY_PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  google: 'Gemini',
  openrouter: 'OpenRouter',
}

const MODEL_SETTING_KEY: Record<AIProvider, 'anthropicModel' | 'openaiModel' | 'googleModel' | 'openrouterModel'> = {
  anthropic: 'anthropicModel',
  openai: 'openaiModel',
  google: 'googleModel',
  openrouter: 'openrouterModel',
}

type CLIToolDetection = {
  claude: string | null
  chatgpt: string | null
  gemini: string | null
  codex?: string | null
}

const CLI_PROVIDER_BASE: Partial<Record<AIProviderMode, AIProvider>> = {
  'claude-cli': 'anthropic',
  'chatgpt-cli': 'openai',
  'gemini-cli': 'google',
  'codex-cli': 'openai',
}

function providerLabel(provider: AIProviderMode): string {
  return AI_PROVIDER_META[provider].shortLabel
}

export default function ConnectAI({
  variant = 'hero',
  initialProvider,
  hasSavedAccess,
  onConnected,
  onModelChange,
}: {
  variant?: 'hero' | 'inline' | 'embedded'
  initialProvider: AIProviderMode
  hasSavedAccess: boolean
  onConnected?: (provider: AIProviderMode) => void
  onModelChange?: () => void
}) {
  const [selectedProvider, setSelectedProvider] = useState<AIProviderMode>(initialProvider)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'neutral' | 'success' | 'error'; message: string } | null>(null)
  const [allowSaveAnyway, setAllowSaveAnyway] = useState<ProviderConnectionResult | null>(null)
  const [connectedProvider, setConnectedProvider] = useState<AIProviderMode | null>(hasSavedAccess ? initialProvider : null)
  const [cliTools, setCliTools] = useState<CLIToolDetection>({ claude: null, chatgpt: null, gemini: null, codex: null })
  const [reducedMotion, setReducedMotion] = useState(false)
  const [savedModels, setSavedModels] = useState<Record<AIProvider, string>>({
    anthropic: AI_PROVIDER_META.anthropic.defaultModel,
    openai: AI_PROVIDER_META.openai.defaultModel,
    google: AI_PROVIDER_META.google.defaultModel,
    openrouter: AI_PROVIDER_META.openrouter.defaultModel,
  })

  useEffect(() => {
    let alive = true
    void ipc.settings.get().then((s) => {
      if (!alive) return
      setSavedModels({
        anthropic: s.anthropicModel,
        openai: s.openaiModel,
        google: s.googleModel,
        openrouter: s.openrouterModel,
      })
    }).catch(() => { /* keep defaults */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    setSelectedProvider(initialProvider)
    setConnectedProvider(hasSavedAccess ? initialProvider : null)
  }, [hasSavedAccess, initialProvider])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    void ipc.ai.detectCliTools().then((tools) => {
      setCliTools(tools as CLIToolDetection)
    }).catch(() => {
      setCliTools({ claude: null, chatgpt: null, gemini: null, codex: null })
    })
  }, [])

  const detectedProvider = useMemo(() => detectProviderFromApiKey(apiKey), [apiKey])
  const activeApiProvider: AIProvider = (isCliProvider(selectedProvider)
    ? (CLI_PROVIDER_BASE[selectedProvider] ?? detectedProvider ?? 'anthropic')
    : selectedProvider as AIProvider)
  const isEmbedded = variant === 'embedded'
  const selectedProviderConnected = connectedProvider === selectedProvider
  const selectedCliProvider = isCliProvider(selectedProvider)
  const selectedCliTool = cliToolForProvider(selectedProvider)
  const selectedCliPath = selectedCliTool ? cliTools[selectedCliTool] : null
  const canSubmitKey = selectedCliProvider ? Boolean(selectedCliPath) : apiKey.trim().length > 0

  useEffect(() => {
    if (!detectedProvider) return
    if (selectedProvider === detectedProvider) return
    if (isCliProvider(selectedProvider) || AI_PROVIDERS.includes(selectedProvider as AIProvider)) {
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
    if (key && !isCliProvider(provider)) {
      await ipc.settings.setApiKey(key, provider)
    }
    const currentSettings = await ipc.settings.get()
    await ipc.settings.set({
      aiProvider: provider,
      // Connecting in Settings is the account default. Clear any leftover
      // chat pin so Settings and the picker resolve the same provider.
      aiChatProvider: null,
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

  async function persistModel(provider: AIProvider, model: string) {
    setSavedModels((prev) => ({ ...prev, [provider]: model }))
    await ipc.settings.set({ [MODEL_SETTING_KEY[provider]]: model })
    onModelChange?.()
  }

  async function handleConnect(forceSave = false) {
    if (busy) return
    setBusy(true)
    setFeedback(null)

    track(ANALYTICS_EVENT.AI_PROVIDER_CONNECTION_STARTED, {
      connection_kind: isCliProvider(selectedProvider) ? 'cli' : 'api_key',
      provider: isCliProvider(selectedProvider) ? selectedProvider : activeApiProvider,
      surface: isEmbedded ? 'settings' : 'ai',
      trigger: 'manual',
    })

    try {
      if (isCliProvider(selectedProvider)) {
        if (!selectedCliPath) {
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
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error),
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
  const primaryButtonLabel = busy ? 'Connecting…' : 'Connect'
  const cliProviderOptions = CLI_PROVIDERS.filter((provider) => {
    const tool = cliToolForProvider(provider)
    return Boolean(tool && cliTools[tool]) || provider === selectedProvider
  })

  const modelFieldStyle: CSSProperties = {
    width: '100%',
    height: 42,
    borderRadius: 12,
    border: '1px solid var(--color-border-ghost)',
    background: 'var(--color-surface-high)',
    color: 'var(--color-text-primary)',
    padding: '0 12px',
    outline: 'none',
    fontSize: 13,
  }
  const modelLabelStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--color-text-tertiary)',
  }
  const activeMeta = AI_PROVIDER_META[activeApiProvider]
  const currentModel = savedModels[activeApiProvider]
  const knownModel = activeMeta.models.find((m) => m.id === currentModel)
  const modelPicker = selectedCliProvider ? null : activeApiProvider === 'openrouter' ? (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={modelLabelStyle}>Model</div>
      <input
        type="text"
        value={currentModel}
        onChange={(event) => void persistModel('openrouter', event.target.value.trim())}
        placeholder="provider/model — e.g. anthropic/claude-sonnet-4.6"
        style={modelFieldStyle}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {activeMeta.models.map((model) => {
          const active = currentModel === model.id
          return (
            <button
              type="button"
              key={model.id}
              onClick={() => void persistModel('openrouter', model.id)}
              style={{
                padding: '5px 10px',
                borderRadius: 999,
                border: active ? '1px solid rgba(125, 193, 255, 0.40)' : '1px solid var(--color-border-ghost)',
                background: active ? 'rgba(97, 165, 255, 0.12)' : 'transparent',
                color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {model.label}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => { ipc.shell.openExternal('https://openrouter.ai/models') }}
          style={{
            padding: '5px 10px',
            borderRadius: 999,
            border: '1px solid var(--color-border-ghost)',
            background: 'transparent',
            color: 'var(--color-text-tertiary)',
            fontSize: 11.5,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Browse all models ↗
        </button>
      </div>
    </div>
  ) : (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={modelLabelStyle}>Model</div>
      <select
        value={currentModel}
        onChange={(event) => void persistModel(activeApiProvider, event.target.value)}
        style={modelFieldStyle}
      >
        {!knownModel && currentModel && (
          <option value={currentModel}>{currentModel} (current)</option>
        )}
        {activeMeta.models.map((model) => (
          <option key={model.id} value={model.id}>{model.label}</option>
        ))}
      </select>
      {knownModel && (
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-tertiary)' }}>
          {knownModel.description}
        </div>
      )}
    </div>
  )

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
              onClick={() => { setSelectedProvider(provider); setFeedback(null) }}
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
        {cliProviderOptions.map((provider) => {
          const selected = selectedProvider === provider
          return (
            <button
              type="button"
              key={provider}
              onClick={() => { setSelectedProvider(provider); setFeedback(null) }}
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
              {AI_PROVIDER_META[provider].shortLabel}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {selectedCliProvider && (
          <div style={{ borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-high)', padding: '11px 12px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
            {selectedCliPath
              ? `${providerLabel(selectedProvider)} found at ${selectedCliPath}. Daylens will send prompts to the local CLI through stdin and read the answer from stdout.`
              : `${providerLabel(selectedProvider)} is selected, but Daylens did not find it on PATH.`}
          </div>
        )}
        {!selectedCliProvider && <div style={{ position: 'relative' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value)
              setAllowSaveAnyway(null)
              setFeedback(null)
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
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setShowKey((value) => !value)}
            disabled={busy}
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
        </div>}

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={() => void handleConnect(false)}
            disabled={busy || !canSubmitKey}
            style={{
              minWidth: 126,
              height: 40,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: 'var(--gradient-primary)',
              color: 'var(--color-primary-contrast)',
              fontSize: 12.5,
              fontWeight: 800,
              cursor: busy || !canSubmitKey ? 'default' : 'pointer',
              opacity: busy || !canSubmitKey ? 0.55 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {primaryButtonLabel}
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
            onClick={() => { ipc.shell.openExternal(AI_PROVIDER_META[selectedProvider].docsUrl || AI_PROVIDER_META[activeApiProvider].docsUrl) }}
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

        {modelPicker}

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
