import type {
  AppSettings,
  OnboardingPlatform,
  OnboardingState,
  TrackingPermissionState,
} from '@shared/types'

export const ONBOARDING_FLOW_VERSION = 3

export function currentOnboardingPlatform(): OnboardingPlatform {
  switch (process.platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return 'linux'
  }
}

function initialTrackingPermissionState(platform: OnboardingPlatform): TrackingPermissionState {
  return platform === 'macos' ? 'missing' : 'granted'
}

export function createDefaultOnboardingState(legacyComplete = false): OnboardingState {
  const platform = currentOnboardingPlatform()
  return {
    flowVersion: ONBOARDING_FLOW_VERSION,
    platform,
    stage: legacyComplete ? 'complete' : 'welcome',
    trackingPermissionState: legacyComplete ? 'granted' : initialTrackingPermissionState(platform),
    permissionRequestedAt: null,
    proofState: legacyComplete ? 'ready' : 'idle',
    personalizationState: legacyComplete ? 'completed' : 'pending',
    aiSetupState: 'pending',
    completedAt: legacyComplete ? Date.now() : null,
  }
}

export function normalizeOnboardingState(raw: unknown, legacyComplete: boolean): OnboardingState {
  const fallback = createDefaultOnboardingState(legacyComplete)
  if (!raw || typeof raw !== 'object') {
    return fallback
  }

  const candidate = raw as Partial<OnboardingState>
  const stage = legacyComplete ? 'complete' : (candidate.stage ?? fallback.stage)
  const platform = candidate.platform ?? fallback.platform
  const trackingPermissionState = legacyComplete
    ? 'granted'
    : (candidate.trackingPermissionState ?? initialTrackingPermissionState(platform))

  return {
    flowVersion: typeof candidate.flowVersion === 'number' ? candidate.flowVersion : fallback.flowVersion,
    platform,
    stage,
    trackingPermissionState,
    permissionRequestedAt: typeof candidate.permissionRequestedAt === 'number' ? candidate.permissionRequestedAt : null,
    proofState: candidate.proofState ?? fallback.proofState,
    personalizationState: candidate.personalizationState ?? fallback.personalizationState,
    aiSetupState: candidate.aiSetupState ?? fallback.aiSetupState,
    completedAt: stage === 'complete'
      ? (typeof candidate.completedAt === 'number' ? candidate.completedAt : Date.now())
      : null,
  }
}

export function shouldStartTrackingForSettings(settings: AppSettings): boolean {
  if (process.platform !== 'darwin') return true
  return settings.onboardingState.trackingPermissionState === 'granted'
}
