import path from 'node:path'
import { Notification, app, nativeImage } from 'electron'
import {
  canDeliverNotifications,
  handleDeliverySuccess,
  handleDeliveryFailure,
  logNotificationBlocked,
  notificationBlockedReason,
} from './notificationPermissions'

const liveNotifications = new Set<Notification>()

function notificationIcon(): Electron.NativeImage | undefined {
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(__dirname, '..', '..', 'build', 'icon.png')
    const img = nativeImage.createFromPath(iconPath)
    return img.isEmpty() ? undefined : img
  } catch {
    return undefined
  }
}

export interface DeliverNotificationInput {
  title: string
  body: string
  route?: string
  actionText?: string
  onClick?: () => void
  surface?: string
  silent?: boolean
}

export function deliverNotification(input: DeliverNotificationInput): boolean {
  const surface = input.surface ?? 'notification'
  if (!canDeliverNotifications()) {
    logNotificationBlocked(surface)
    return false
  }

  const icon = notificationIcon()
  const notification = new Notification({
    title: input.title,
    body: input.body,
    silent: input.silent ?? false,
    icon,
    actions: input.actionText && process.platform === 'darwin'
      ? [{ type: 'button', text: input.actionText }]
      : undefined,
  })

  liveNotifications.add(notification)

  const open = () => {
    input.onClick?.()
  }

  notification.on('click', open)
  notification.on('action', open)
  notification.on('show', () => {
    console.log(`[notifications] shown (${surface}):`, input.title)
    void handleDeliverySuccess()
  })
  notification.on('failed', (_event, error) => {
    console.warn(`[notifications] failed (${surface}):`, error)
    void handleDeliveryFailure(error)
  })
  notification.on('close', () => { liveNotifications.delete(notification) })

  notification.show()
  // unref: this cleanup timer must never keep the process alive on its own
  // (app quit, or a test process waiting for the event loop to drain).
  setTimeout(() => { liveNotifications.delete(notification) }, 30 * 60 * 1000).unref?.()
  return true
}

export function getNotificationDeliveryBlockedReason(): string | null {
  return notificationBlockedReason()
}
