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
    <div className="p-6 max-w-lg mx-auto">
      <h1 className="text-lg font-semibold text-[var(--color-text-primary)] mb-6">Settings</h1>

      <div className="flex flex-col gap-5">
        {/* API key */}
        <div>
          <label className="block text-[12px] font-medium text-[var(--color-text-secondary)] mb-1.5">
            Anthropic API key
          </label>
          <input
            type="password"
            value={settings.anthropicApiKey}
            onChange={(e) => setSettings((s) => ({ ...s, anthropicApiKey: e.target.value }))}
            placeholder="sk-ant-…"
            className="w-full px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)] font-mono"
          />
          <p className="text-[11px] text-[var(--color-text-secondary)] mt-1">
            Stored in electron-store on your machine. Never sent anywhere except Anthropic.
          </p>
        </div>

        {/* Tracking toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-[var(--color-text-primary)]">Enable tracking</p>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              Track active app usage in the background
            </p>
          </div>
          <button
            onClick={() => setSettings((s) => ({ ...s, trackingEnabled: !s.trackingEnabled }))}
            className={[
              'w-10 h-6 rounded-full transition-colors relative',
              settings.trackingEnabled
                ? 'bg-[var(--color-accent)]'
                : 'bg-[var(--color-surface-overlay)]',
            ].join(' ')}
          >
            <span
              className={[
                'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
                settings.trackingEnabled ? 'translate-x-5' : 'translate-x-1',
              ].join(' ')}
            />
          </button>
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          className="mt-2 px-5 py-2 rounded-md bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-90 transition-opacity self-start"
        >
          {saved ? 'Saved ✓' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
