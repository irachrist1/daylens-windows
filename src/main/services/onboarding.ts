import type { AppSettings, OnboardingStage, ProofState } from '@shared/types'
import { nextMacStageAfterGrantedPermission } from '@shared/onboarding'
import { grantedCaptureConsent, type CaptureConsentState } from '@shared/captureConsent'
import { getTrackingPermissionState } from './trackingPermissions'
import { getSettingsAsync, setSettings } from './settings'

// Stages at or before the point where the flow explains what Daylens captures.
// Anyone who advanced past these under the pre-consent-state flow already
// agreed to capture there — the recorded state just didn't exist yet.
const PRE_CONSENT_STAGES: ReadonlySet<OnboardingStage> = new Set(['welcome', 'why'])

function nextProofState(stage: OnboardingStage, current: ProofState): ProofState {
  if (stage === 'complete') return 'ready'
  if (stage === 'proof') return current === 'ready' ? 'ready' : 'collecting'
  return current
}

export async function reconcileOnboardingState(): Promise<AppSettings> {
  const settings = await getSettingsAsync()
  let changed = false
  const onboardingState = { ...settings.onboardingState }

  // Grandfather installs that predate the recorded consent state: completing
  // (or advancing past the capture explainer of) the old flow WAS the consent
  // act, so record it rather than silently stopping their capture on update.
  // Never overwrite an explicit decision — only 'unset' is reconciled.
  let captureConsent: CaptureConsentState = settings.captureConsent
  if (
    captureConsent.status === 'unset'
    && (settings.onboardingComplete || !PRE_CONSENT_STAGES.has(onboardingState.stage))
  ) {
    captureConsent = grantedCaptureConsent(Date.now())
    changed = true
  }

  if (settings.onboardingComplete && onboardingState.stage !== 'complete') {
    onboardingState.stage = 'complete'
    onboardingState.completedAt = onboardingState.completedAt ?? Date.now()
    onboardingState.proofState = 'ready'
    onboardingState.personalizationState = 'completed'
    changed = true
  }

  if (process.platform === 'darwin' && onboardingState.stage !== 'complete') {
    const permissionState = getTrackingPermissionState()
    if (onboardingState.trackingPermissionState !== permissionState) {
      onboardingState.trackingPermissionState = permissionState
      changed = true
    }

    if (permissionState === 'granted') {
      const nextStage = nextMacStageAfterGrantedPermission({
        currentStage: onboardingState.stage,
        permissionRequestedAt: onboardingState.permissionRequestedAt,
        origin: 'startup',
      })

      if (nextStage && onboardingState.stage !== nextStage) {
        onboardingState.stage = nextStage
        changed = true
      }
    }

    if (permissionState !== 'granted' && onboardingState.stage !== 'welcome' && onboardingState.stage !== 'permission') {
      onboardingState.stage = 'permission'
      onboardingState.proofState = 'idle'
      changed = true
    }
  } else if (process.platform !== 'darwin' && onboardingState.trackingPermissionState !== 'granted') {
    onboardingState.trackingPermissionState = 'granted'
    changed = true
  }

  onboardingState.proofState = nextProofState(onboardingState.stage, onboardingState.proofState)

  if (changed) {
    await setSettings({
      onboardingState,
      onboardingComplete: onboardingState.stage === 'complete',
      captureConsent,
    })
  }

  return changed
    ? { ...settings, onboardingState, onboardingComplete: onboardingState.stage === 'complete', captureConsent }
    : settings
}
