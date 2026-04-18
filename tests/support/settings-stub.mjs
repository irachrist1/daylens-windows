const DEFAULT_SETTINGS = Object.freeze({
  allowThirdPartyWebsiteIconFallback: true,
  analyticsOptIn: false,
  onboardingComplete: false,
  onboardingState: {
    trackingPermissionState: 'missing',
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
  return settings
}
