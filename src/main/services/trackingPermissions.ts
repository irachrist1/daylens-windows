import { shell, systemPreferences } from 'electron'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import type { TrackingPermissionState } from '@shared/types'
import { capture, captureException } from './analytics'
import { getSettings, setSettings } from './settings'
import { requestTrackingPermission } from './tracking'

const MAC_SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

function normalizeMacScreenPermissionStatus(status: string): TrackingPermissionState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
    case 'restricted':
    case 'not-determined':
      return 'missing'
    default:
      return 'unsupported_or_unknown'
  }
}

export function getTrackingPermissionState(): TrackingPermissionState {
  if (process.platform !== 'darwin') return 'granted'

  try {
    return normalizeMacScreenPermissionStatus(systemPreferences.getMediaAccessStatus('screen'))
  } catch (err) {
    console.warn('[tracking-permissions] failed to read screen permission state:', err)
    return 'unsupported_or_unknown'
  }
}

export async function openTrackingPermissionSettings(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await shell.openExternal(MAC_SCREEN_RECORDING_SETTINGS_URL)
  } catch (err) {
    console.warn('[tracking-permissions] failed to open System Settings:', err)
    capture(ANALYTICS_EVENT.TRACKING_PERMISSION_UPDATED, {
      failure_kind: classifyFailureKind(err),
      permission_state: 'unsupported_or_unknown',
      result: 'error',
      surface: 'onboarding',
      trigger: 'request',
    })
  }
}

export async function requestScreenTrackingPermission(): Promise<TrackingPermissionState> {
  if (process.platform !== 'darwin') return 'granted'

  try {
    const granted = requestTrackingPermission()
    const permissionRequestedAt = Date.now()
    const nextState: TrackingPermissionState = granted ? 'awaiting_relaunch' : 'missing'
    await setSettings({
      onboardingState: {
        ...getSettings().onboardingState,
        trackingPermissionState: nextState,
        permissionRequestedAt,
        stage: granted ? 'relaunch_required' : 'permission',
      },
    })

    capture(ANALYTICS_EVENT.TRACKING_PERMISSION_UPDATED, {
      permission_state: nextState,
      result: granted ? 'success' : 'blocked',
      surface: 'onboarding',
      trigger: 'request',
    })

    if (!granted) {
      await openTrackingPermissionSettings()
    }

    return nextState
  } catch (error) {
    capture(ANALYTICS_EVENT.TRACKING_PERMISSION_UPDATED, {
      failure_kind: classifyFailureKind(error),
      permission_state: 'unsupported_or_unknown',
      result: 'error',
      surface: 'onboarding',
      trigger: 'request',
    })
    captureException(error, {
      tags: {
        process_type: 'main',
        reason: 'tracking_permission_request_failed',
      },
    })
    throw error
  }
}
