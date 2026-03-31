import { useEffect, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import type { AIProvider } from '@shared/types'
import { AI_PROVIDER_META, AI_PROVIDERS, detectProviderFromApiKey } from '../lib/aiProvider'

// ─── Goal definitions ─────────────────────────────────────────────────────────

const GOALS = [
  {
    id: 'deep-work',
    label: 'Deep work & focus',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="10" cy="10" r="8" />
        <circle cx="10" cy="10" r="3.5" />
        <line x1="10" y1="2" x2="10" y2="5" />
        <line x1="10" y1="15" x2="10" y2="18" />
        <line x1="2" y1="10" x2="5" y2="10" />
        <line x1="15" y1="10" x2="18" y2="10" />
      </svg>
    ),
  },
  {
    id: 'understand-habits',
    label: 'Understand my habits',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="13" width="3" height="5" rx="1" />
        <rect x="8.5" y="8" width="3" height="10" rx="1" />
        <rect x="15" y="4" width="3" height="14" rx="1" />
      </svg>
    ),
  },
  {
    id: 'less-distraction',
    label: 'Less time on distractions',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="10" cy="10" r="8" />
        <circle cx="10" cy="10" r="3" />
        <line x1="10" y1="2" x2="10" y2="7" />
        <line x1="10" y1="13" x2="10" y2="18" />
        <line x1="13" y1="10" x2="10" y2="10" />
      </svg>
    ),
  },
  {
    id: 'ai-insights',
    label: 'AI-powered insights',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2 L11.8 7.2 L17 7.2 L12.9 10.3 L14.4 15.5 L10 12.5 L5.6 15.5 L7.1 10.3 L3 7.2 L8.2 7.2 Z" />
      </svg>
    ),
  },
]

// ─── Animated character-by-character text reveal ──────────────────────────────

function AnimatedText({
  text,
  delayPerChar = 30,
  onComplete,
}: {
  text: string
  delayPerChar?: number
  onComplete?: () => void
}) {
  const [revealed, setRevealed] = useState(0)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    setRevealed(0)
    if (!text) return
    let i = 0
    const tick = () => {
      i++
      setRevealed(i)
      if (i < text.length) {
        setTimeout(tick, delayPerChar)
      } else {
        onCompleteRef.current?.()
      }
    }
    const t = setTimeout(tick, delayPerChar)
    return () => clearTimeout(t)
  }, [text, delayPerChar])

  return (
    <span>
      {text.slice(0, revealed)}
      <span style={{ opacity: 0 }}>{text.slice(revealed)}</span>
    </span>
  )
}

// ─── Screen 1: Name input ─────────────────────────────────────────────────────

function Screen1({
  name,
  onNameChange,
  onContinue,
}: {
  name: string
  onNameChange: (v: string) => void
  onContinue: () => void
}) {
  return (
    <div className="onboarding-screen">
      <h1 className="onboarding-title">Welcome to Daylens.</h1>
      <p className="onboarding-sub">
        A quiet companion that watches how you spend your time — so you don't have to.
      </p>

      <div className="onboarding-field">
        <label className="onboarding-label">What should we call you?</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && onContinue()}
          placeholder="Your first name"
          className="onboarding-input"
          autoFocus
        />
      </div>

      <button
        onClick={onContinue}
        disabled={!name.trim()}
        className="onboarding-btn-primary"
      >
        Continue
      </button>
    </div>
  )
}

// ─── Screen 2: Goals selection ────────────────────────────────────────────────

function Screen2({
  name,
  goals,
  onGoalToggle,
  onContinue,
}: {
  name: string
  goals: Set<string>
  onGoalToggle: (id: string) => void
  onContinue: () => void
}) {
  const [bodyVisible, setBodyVisible] = useState(false)
  const headingText = `Fantastic to meet you, ${name}.`

  return (
    <div className="onboarding-screen">
      <h1 className="onboarding-title" style={{ minHeight: '2.4em' }}>
        <AnimatedText text={headingText} delayPerChar={30} onComplete={() => setBodyVisible(true)} />
      </h1>

      <div
        className="onboarding-body-block"
        style={{
          opacity: bodyVisible ? 1 : 0,
          transition: 'opacity 400ms ease',
        }}
      >
        <p className="onboarding-sub">
          This app watches the apps and websites you use, and turns that into insight.
          What would you most like help with?
        </p>

        <div className="onboarding-goals-grid">
          {GOALS.map((goal) => {
            const selected = goals.has(goal.id)
            return (
              <button
                key={goal.id}
                onClick={() => onGoalToggle(goal.id)}
                className="onboarding-goal-card"
                style={{
                  borderColor: selected ? 'var(--color-accent)' : 'rgba(104,174,255,0.2)',
                  background: selected ? 'rgba(104,174,255,0.08)' : 'transparent',
                  color: selected ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                }}
              >
                <span className="onboarding-goal-icon">{goal.icon}</span>
                <span className="onboarding-goal-label">{goal.label}</span>
              </button>
            )
          })}
        </div>

        <p className="onboarding-hint">
          We'll personalise what you see. You can change this any time.
        </p>

        <button onClick={onContinue} className="onboarding-btn-primary">
          Continue
        </button>
      </div>
    </div>
  )
}

// ─── Screen 3: API key + finish ───────────────────────────────────────────────

function Screen3({
  provider,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  launchOnLogin,
  onLaunchOnLoginChange,
  onFinish,
  onSkip,
  saving,
  errorMessage,
}: {
  provider: AIProvider
  onProviderChange: (provider: AIProvider) => void
  apiKey: string
  onApiKeyChange: (v: string) => void
  launchOnLogin: boolean
  onLaunchOnLoginChange: (v: boolean) => void
  onFinish: () => void
  onSkip: () => void
  saving: boolean
  errorMessage: string | null
}) {
  const [showKey, setShowKey] = useState(false)
  const providerMeta = AI_PROVIDER_META[provider]

  return (
    <div className="onboarding-screen">
      <h1 className="onboarding-title">One last thing.</h1>
      <p className="onboarding-sub">
        Daylens can use Anthropic, OpenAI, or Gemini to answer questions about your day.
        Choose your provider and add an API key to unlock AI features.
      </p>

      <div className="onboarding-field">
        <label className="onboarding-label">AI provider</label>
        <div style={{
          display: 'flex', gap: 4, padding: 3, borderRadius: 12,
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
        }}>
          {AI_PROVIDERS.map((value) => {
            const selected = provider === value
            return (
              <button
                key={value}
                onClick={() => onProviderChange(value)}
                className="onboarding-btn-secondary"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: selected ? 'var(--color-accent)' : 'transparent',
                  color: selected ? '#0d1117' : 'var(--color-text-secondary)',
                  border: 'none',
                  padding: '10px 12px',
                }}
              >
                {AI_PROVIDER_META[value].shortLabel}
              </button>
            )
          })}
        </div>
      </div>

      <div className="onboarding-field">
        <label className="onboarding-label">{providerMeta.label} API key</label>
        <div style={{ position: 'relative' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={providerMeta.keyPlaceholder}
            className="onboarding-input"
            style={{ paddingRight: 44 }}
            disabled={saving}
          />
          <button
            onClick={() => setShowKey((v) => !v)}
            disabled={saving}
            style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-tertiary)',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {showKey ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                <circle cx="8" cy="8" r="1.5" />
                <line x1="2" y1="2" x2="14" y2="14" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                <circle cx="8" cy="8" r="1.5" />
              </svg>
            )}
          </button>
        </div>
        <button
          className="onboarding-external-link"
          onClick={() => ipc.shell.openExternal(providerMeta.docsUrl)}
        >
          Open the {providerMeta.shortLabel} key page
        </button>
      </div>

      {errorMessage && <p className="onboarding-error">{errorMessage}</p>}

      <label className="onboarding-checkbox-row">
        <input
          type="checkbox"
          checked={launchOnLogin}
          onChange={(e) => onLaunchOnLoginChange(e.target.checked)}
          className="onboarding-checkbox"
          disabled={saving}
        />
        <span className="onboarding-checkbox-label">Launch Daylens when I log in</span>
      </label>

      <button onClick={onFinish} className="onboarding-btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Open Daylens'}
      </button>

      <button onClick={onSkip} className="onboarding-btn-skip" disabled={saving}>
        {saving ? 'Saving…' : 'Skip for now'}
      </button>
    </div>
  )
}

// ─── Root Onboarding component ────────────────────────────────────────────────

export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [screen, setScreen]       = useState<1 | 2 | 3>(1)
  const [exiting, setExiting]     = useState(false)
  const [name, setName]           = useState('')
  const [goals, setGoals]         = useState<Set<string>>(new Set())
  const [provider, setProvider]   = useState<AIProvider>('anthropic')
  const [apiKey, setApiKey]       = useState('')
  const [launchOnLogin, setLaunchOnLogin] = useState(true)
  const [saving, setSaving] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  function transition(next: 1 | 2 | 3) {
    setExiting(true)
    setTimeout(() => {
      setScreen(next)
      setExiting(false)
    }, 300)
  }

  function toggleGoal(id: string) {
    setGoals((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function finish(skipApiKey = false) {
    if (saving) return
    const key = skipApiKey ? '' : apiKey.trim()
    const detectedProvider = detectProviderFromApiKey(key)
    const resolvedProvider = detectedProvider ?? provider
    setSaving(true)
    setFinishError(null)

    try {
      await ipc.settings.set({ aiProvider: resolvedProvider })
      if (key) await ipc.settings.setApiKey(key, resolvedProvider)
      await ipc.settings.set({
        onboardingComplete: true,
        userName: name.trim(),
        userGoals: Array.from(goals),
        launchOnLogin,
        aiProvider: resolvedProvider,
      })
      track('onboarding_completed', { goals: Array.from(goals), api_key_entered: !!key, provider: resolvedProvider })
      if (key) track('api_key_saved', { provider: resolvedProvider })
      onComplete()
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="onboarding-root">
      <div
        className="onboarding-container"
        style={{
          opacity: exiting ? 0 : 1,
          transform: exiting ? 'translateY(-8px)' : 'translateY(0)',
          transition: 'opacity 280ms ease-out, transform 280ms ease-out',
        }}
      >
        {screen === 1 && (
          <Screen1
            name={name}
            onNameChange={setName}
            onContinue={() => {
              if (name.trim()) {
                track('onboarding_step_completed', { step: 1 })
                transition(2)
              }
            }}
          />
        )}
        {screen === 2 && (
          <Screen2
            name={name.trim()}
            goals={goals}
            onGoalToggle={toggleGoal}
            onContinue={() => {
              track('onboarding_step_completed', { step: 2, goals: Array.from(goals) })
              transition(3)
            }}
          />
        )}
        {screen === 3 && (
          <Screen3
            provider={provider}
            onProviderChange={setProvider}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            launchOnLogin={launchOnLogin}
            onLaunchOnLoginChange={setLaunchOnLogin}
            onFinish={() => void finish(false)}
            onSkip={() => void finish(true)}
            saving={saving}
            errorMessage={finishError}
          />
        )}
      </div>

      <style>{`
        .onboarding-root {
          position: fixed;
          inset: 0;
          background: #1a1a1a;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px 24px;
          -webkit-app-region: drag;
        }
        .onboarding-container {
          width: 100%;
          max-width: 480px;
          -webkit-app-region: no-drag;
        }
        .onboarding-screen {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .onboarding-title {
          font-size: 28px;
          font-weight: 700;
          color: #c8dcf4;
          line-height: 1.2;
          letter-spacing: -0.5px;
          margin: 0;
        }
        .onboarding-sub {
          font-size: 14px;
          color: #5e7a92;
          line-height: 1.6;
          margin: 0;
        }
        .onboarding-body-block {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .onboarding-field {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .onboarding-label {
          font-size: 12px;
          font-weight: 500;
          color: #5e7a92;
          letter-spacing: 0.01em;
        }
        .onboarding-input {
          width: 100%;
          padding: 12px 14px;
          background: #0d1c2e;
          border: 1px solid #1c2d3e;
          border-radius: 10px;
          font-size: 14px;
          color: #c8dcf4;
          outline: none;
          transition: border-color 200ms;
          box-sizing: border-box;
          font-family: inherit;
        }
        .onboarding-input::placeholder {
          color: #3d5568;
        }
        .onboarding-input:focus {
          border-color: #68AEFF;
        }
        .onboarding-btn-primary {
          width: 100%;
          padding: 13px;
          background: linear-gradient(180deg, #68AEFF 0%, #003EB7 100%);
          border: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          color: #fff;
          cursor: pointer;
          transition: opacity 200ms;
          font-family: inherit;
        }
        .onboarding-btn-primary:hover {
          opacity: 0.92;
        }
        .onboarding-btn-primary:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .onboarding-btn-skip {
          background: none;
          border: none;
          font-size: 13px;
          color: #3d5568;
          cursor: pointer;
          padding: 4px 0;
          text-align: center;
          font-family: inherit;
          transition: color 200ms;
        }
        .onboarding-btn-skip:hover {
          color: #5e7a92;
        }
        .onboarding-goals-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .onboarding-goal-card {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
          padding: 14px;
          border: 1px solid rgba(104,174,255,0.2);
          border-radius: 10px;
          background: transparent;
          cursor: pointer;
          transition: border-color 180ms, background 180ms, color 180ms;
          text-align: left;
          font-family: inherit;
        }
        .onboarding-goal-card:hover {
          border-color: rgba(104,174,255,0.4);
        }
        .onboarding-goal-icon {
          opacity: 0.8;
        }
        .onboarding-goal-label {
          font-size: 13px;
          font-weight: 500;
          line-height: 1.3;
        }
        .onboarding-hint {
          font-size: 12px;
          color: #3d5568;
          margin: -6px 0;
        }
        .onboarding-error {
          font-size: 12px;
          color: #fca5a5;
          margin: -4px 0 0;
        }
        .onboarding-external-link {
          background: none;
          border: none;
          padding: 0;
          font-size: 12px;
          color: #68AEFF;
          cursor: pointer;
          text-align: left;
          font-family: inherit;
          transition: opacity 200ms;
        }
        .onboarding-external-link:hover {
          opacity: 0.75;
        }
        .onboarding-checkbox-row {
          display: flex;
          align-items: center;
          gap: 10px;
          cursor: pointer;
        }
        .onboarding-checkbox {
          width: 16px;
          height: 16px;
          accent-color: #68AEFF;
          cursor: pointer;
          flex-shrink: 0;
        }
        .onboarding-checkbox-label {
          font-size: 13px;
          color: #5e7a92;
        }
      `}</style>
    </div>
  )
}
