const DEFAULT_SETTINGS = Object.freeze({
  allowThirdPartyWebsiteIconFallback: true,
  shareAIFeedbackExamples: true,
  onboardingComplete: false,
  onboardingState: {
    trackingPermissionState: 'missing',
  },
  // Most tests model a person who already consented to capture; the consent
  // regression tests override this explicitly.
  captureConsent: {
    status: 'granted',
    policyVersion: 1,
    decidedAt: 0,
  },
})

let settings = cloneDefaultSettings()

function cloneDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    onboardingState: {
      ...DEFAULT_SETTINGS.onboardingState,
    },
  }
}

export function getSettings() {
  return settings
}

export function __setSettings(overrides = {}) {
  settings = {
    ...settings,
    ...overrides,
    onboardingState: {
      ...settings.onboardingState,
      ...(overrides.onboardingState ?? {}),
    },
  }
  return settings
}

export function __resetSettings() {
  settings = cloneDefaultSettings()
  apiKeys.clear()
  return settings
}

// Mirror the rest of the real settings surface used across the main process so
// modules that import it (e.g. aiOrchestration) resolve under the stub loader.
// API keys live in an in-memory map — no keytar, no network.
const apiKeys = new Map()

export async function getSettingsAsync() {
  return settings
}

export async function setSettings(partial = {}) {
  __setSettings(partial)
}

export async function initSettings() {}

export async function hasApiKey(provider) {
  return apiKeys.has(provider)
}

export async function getApiKey(provider) {
  return apiKeys.get(provider) ?? null
}

export async function setApiKey(provider, key) {
  apiKeys.set(provider, key)
}

export async function clearApiKey(provider) {
  apiKeys.delete(provider)
}

export async function hasAnthropicApiKey() {
  return hasApiKey('anthropic')
}

export async function getAnthropicApiKey() {
  return getApiKey('anthropic')
}

export async function setAnthropicApiKey(key) {
  return setApiKey('anthropic', key)
}

export async function clearAnthropicApiKey() {
  return clearApiKey('anthropic')
}
