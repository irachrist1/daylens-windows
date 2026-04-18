import type { OnboardingStage } from './types'

export function nextMacStageAfterGrantedPermission({
  currentStage,
  permissionRequestedAt,
  origin,
}: {
  currentStage: OnboardingStage
  permissionRequestedAt: number | null
  origin: 'startup' | 'refresh'
}): OnboardingStage | null {
  if (origin === 'startup') {
    if (currentStage === 'permission' || currentStage === 'relaunch_required') {
      return 'verifying_permission'
    }
    return null
  }

  if (currentStage === 'permission') {
    return permissionRequestedAt ? 'relaunch_required' : 'verifying_permission'
  }

  if (currentStage === 'verifying_permission') {
    return 'proof'
  }

  return null
}
