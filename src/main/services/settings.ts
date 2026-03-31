// Settings persistence via electron-store
// electron-store is ESM-only in v10 — dynamic import required
import type { AIProvider, AppSettings } from '@shared/types'

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
  analyticsOptIn: false,
  launchOnLogin: true,
  theme: 'system',
  onboardingComplete: false,
  userName: '',
  userGoals: [],
  dailyFocusGoalHours: 4,
  firstLaunchDate: 0,
  feedbackPromptShown: false,
  aiProvider: 'anthropic',
  anthropicModel: 'claude-opus-4-6',
  openaiModel: 'gpt-5.4',
  googleModel: 'gemini-3.1-flash-lite-preview',
}

export function getSettings(): AppSettings {
  if (!_store) {
    // Synchronous fallback before async init — return defaults
    return { ...DEFAULTS }
  }
  return {
    analyticsOptIn: (_store.get('analyticsOptIn', false) as boolean),
    launchOnLogin: (_store.get('launchOnLogin', true) as boolean),
    theme: (_store.get('theme', 'system') as AppSettings['theme']),
    onboardingComplete: (_store.get('onboardingComplete', false) as boolean),
    userName: (_store.get('userName', '') as string),
    userGoals: (_store.get('userGoals', []) as string[]),
    dailyFocusGoalHours: (_store.get('dailyFocusGoalHours', 4) as number),
    firstLaunchDate: (_store.get('firstLaunchDate', 0) as number),
    feedbackPromptShown: (_store.get('feedbackPromptShown', false) as boolean),
    aiProvider: (_store.get('aiProvider', 'anthropic') as AIProvider),
    anthropicModel: (_store.get('anthropicModel', 'claude-opus-4-6') as string),
    openaiModel: (_store.get('openaiModel', 'gpt-5.4') as string),
    googleModel: (_store.get('googleModel', 'gemini-3.1-flash-lite-preview') as string),
  }
}

export async function getSettingsAsync(): Promise<AppSettings> {
  await getStore()
  return getSettings()
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

// ─── AI provider API keys — stored in OS credential vault, never in plain-text ─

const KEYTAR_SERVICE = 'DaylensWindows'
const KEYTAR_ACCOUNTS: Record<AIProvider, string> = {
  anthropic: 'anthropic-api-key',
  openai: 'openai-api-key',
  google: 'google-api-key',
}

// keytar is a native CJS module — load it with require() to avoid ESM interop issues
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const keytar = require('keytar') as typeof import('keytar')

function keytarAccount(provider: AIProvider): string {
  return KEYTAR_ACCOUNTS[provider]
}

export async function hasApiKey(provider: AIProvider): Promise<boolean> {
  try {
    const key = await keytar.getPassword(KEYTAR_SERVICE, keytarAccount(provider))
    return !!key
  } catch (err) {
    console.error(`[settings] hasApiKey failed for ${provider}:`, err)
    return false
  }
}

export async function getApiKey(provider: AIProvider): Promise<string | null> {
  try {
    return await keytar.getPassword(KEYTAR_SERVICE, keytarAccount(provider))
  } catch {
    return null
  }
}

export async function setApiKey(provider: AIProvider, key: string): Promise<void> {
  try {
    await keytar.setPassword(KEYTAR_SERVICE, keytarAccount(provider), key)
  } catch (err) {
    console.error(`[settings] setApiKey failed for ${provider}:`, err)
    throw err
  }
}

export async function clearApiKey(provider: AIProvider): Promise<void> {
  try {
    await keytar.deletePassword(KEYTAR_SERVICE, keytarAccount(provider))
  } catch {
    // Key may not exist — ignore
  }
}

export async function hasAnthropicApiKey(): Promise<boolean> {
  return hasApiKey('anthropic')
}

export async function getAnthropicApiKey(): Promise<string | null> {
  return getApiKey('anthropic')
}

export async function setAnthropicApiKey(key: string): Promise<void> {
  await setApiKey('anthropic', key)
}

export async function clearAnthropicApiKey(): Promise<void> {
  await clearApiKey('anthropic')
}
