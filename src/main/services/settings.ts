// Settings persistence via electron-store
// electron-store is ESM-only in v10 — dynamic import required
import type { AppSettings } from '@shared/types'

// We keep a synchronous in-memory cache after first load
let _store: { get: (k: string, d?: unknown) => unknown; set: (k: string, v: unknown) => void } | null = null

async function getStore() {
  if (!_store) {
    const { default: Store } = await import('electron-store')
    _store = new Store()
  }
  return _store
}

const DEFAULTS: AppSettings = {
  anthropicApiKey: '',
  launchOnLogin: false,
  trackingEnabled: true,
}

export function getSettings(): AppSettings {
  if (!_store) {
    // Synchronous fallback before async init — return defaults
    return { ...DEFAULTS }
  }
  return {
    anthropicApiKey: (_store.get('anthropicApiKey', '') as string),
    launchOnLogin: (_store.get('launchOnLogin', false) as boolean),
    trackingEnabled: (_store.get('trackingEnabled', true) as boolean),
  }
}

export async function setSettings(partial: Partial<AppSettings>): Promise<void> {
  const store = await getStore()
  for (const [k, v] of Object.entries(partial)) {
    store.set(k, v)
  }
}

export async function initSettings(): Promise<void> {
  await getStore()
}
