import { useEffect, useState } from 'react'
import { ipc } from '../lib/ipc'
import type { AppSettings } from '@shared/types'

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>({
    anthropicApiKey: '',
    launchOnLogin: false,
    trackingEnabled: true,
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    ipc.settings.get().then((s) => setSettings(s))
  }, [])

  async function handleSave() {
    await ipc.settings.set(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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
              Stored locally. Never sent anywhere except Anthropic.
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
              onClick={() => setSettings((s) => ({ ...s, trackingEnabled: !s.trackingEnabled }))}
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
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-surface)] text-[13px] font-medium hover:opacity-90 transition-opacity self-start"
        >
          {saved ? 'Saved ✓' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
