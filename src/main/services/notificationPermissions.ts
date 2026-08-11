import { Notification, app, shell } from 'electron'
import type { NotificationPermissionState } from '@shared/types'
import { getSettings, setSettings } from './settings'
import { isRealDayHarness } from '../lib/realDayHarness'

function systemSettingsBundleId(): string {
  // In packaged builds the bundle ID matches the app's user model ID.
  // In dev builds Electron uses its own identifier (com.github.electron
  // or similar) — the deep link may not work, but it's best-effort.
  if (app.isPackaged) return 'com.daylens.desktop'
  // Dev: try to use whatever identifier the OS registered for this build.
  // app.getAppUserModelId() returns the value we set in index.ts:131, but
  // on macOS the OS-level registration may differ. Best-effort fallback.
  try { return (app as any).getAppUserModelId?.() || 'com.daylens.desktop' } catch { return 'com.daylens.desktop' }
}

const MAC_NOTIFICATION_SETTINGS_URL = (() => {
  const bundleId = systemSettingsBundleId()
  return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`
})()

export const NOTIFICATIONS_DENIED_MESSAGE =
  'Notifications are off for Daylens. Open System Settings → Notifications → Daylens and allow alerts.'

export function getNotificationPermissionState(): NotificationPermissionState {
  if (!Notification.isSupported()) return 'unsupported'
  if (process.platform !== 'darwin') return 'granted'
  return getSettings().notificationPermissionState ?? 'not-determined'
}

export function canDeliverNotifications(): boolean {
  const state = getNotificationPermissionState()
  if (state === 'unsupported') return false
  if (process.platform !== 'darwin') return Notification.isSupported()
  // Only block on explicit 'denied'. 'not-determined' means we haven't probed
  // permission yet — let the OS decide. If the OS already granted permission,
  // the notification will show and we'll persist 'granted' via on('show').
  if (state === 'denied') return false
  return true
}

export function notificationBlockedReason(): string | null {
  if (!Notification.isSupported()) return 'Desktop notifications are not supported on this system.'
  if (process.platform === 'darwin' && getNotificationPermissionState() === 'denied') {
    return NOTIFICATIONS_DENIED_MESSAGE
  }
  return null
}

async function persistNotificationPermissionState(state: NotificationPermissionState): Promise<void> {
  await setSettings({ notificationPermissionState: state })
}

export async function openNotificationSettings(): Promise<void> {
  if (isRealDayHarness()) return
  if (process.platform !== 'darwin') return
  try {
    await shell.openExternal(MAC_NOTIFICATION_SETTINGS_URL)
  } catch (err) {
    console.warn('[notifications] failed to open System Settings:', err)
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isRealDayHarness()) return getNotificationPermissionState()
  if (!Notification.isSupported()) {
    await persistNotificationPermissionState('unsupported')
    return 'unsupported'
  }

  if (process.platform !== 'darwin') {
    await persistNotificationPermissionState('granted')
    return 'granted'
  }

  const existing = getNotificationPermissionState()
  if (existing === 'denied') {
    await openNotificationSettings()
    return 'denied'
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (state: NotificationPermissionState) => {
      if (settled) return
      settled = true
      void persistNotificationPermissionState(state).finally(() => resolve(state))
    }

    const notification = new Notification({
      title: 'Daylens notifications',
      body: 'Morning briefs, evening wraps, and focus nudges will show up here.',
      silent: false,
    })

    notification.on('show', () => {
      console.log('[notifications] OS notification permission granted')
      finish('granted')
    })
    notification.on('failed', (_event, error) => {
      console.warn('[notifications] OS notification permission denied or failed:', error)
      finish('denied')
    })
    notification.on('close', () => {
      if (!settled) finish(getNotificationPermissionState())
    })

    setTimeout(() => {
      if (!settled) finish(getNotificationPermissionState())
    }, 12_000)

    notification.show()
  })
}

// B3: Called from deliverNotification() when a notification shows successfully.
// Persists 'granted' so future canDeliverNotifications() calls won't hesitate.
export async function handleDeliverySuccess(): Promise<void> {
  if (process.platform !== 'darwin') return
  const current = getNotificationPermissionState()
  if (current !== 'granted') {
    await persistNotificationPermissionState('granted')
    console.log('[notifications] delivery success: persisted granted')
  }
}

// B3: Called from deliverNotification() when a notification fails to show.
export async function handleDeliveryFailure(error?: string): Promise<void> {
  if (process.platform !== 'darwin') return
  const current = getNotificationPermissionState()
  if (current !== 'denied') {
    await persistNotificationPermissionState('denied')
    console.warn(`[notifications] delivery failure: persisted denied${error ? ` (${error})` : ''}`)
  }
}

export function logNotificationBlocked(surface: string): void {
  const reason = notificationBlockedReason()
  if (!reason) return
  console.warn(`[notifications] ${surface} blocked: ${reason}`)
}
