import test from 'node:test'
import assert from 'node:assert/strict'

// These tests run under the hermetic ts-loader which stubs 'electron'.
// We test the permission/delivery logic, not OS rendering.

test('notification permissions: default state is not-determined on macOS', async () => {
  const { getNotificationPermissionState } = await import('../src/main/services/notificationPermissions.ts')
  const state = getNotificationPermissionState()
  if (process.platform === 'darwin') {
    assert.equal(state, 'not-determined')
  }
})

test('canDeliverNotifications: allows when not-determined on macOS', async () => {
  const { canDeliverNotifications, getNotificationPermissionState } =
    await import('../src/main/services/notificationPermissions.ts')

  const state = getNotificationPermissionState()
  if (process.platform === 'darwin') {
    assert.equal(state, 'not-determined')
    assert.equal(canDeliverNotifications(), true, 'not-determined should not block delivery (B2 fix)')
  } else {
    assert.equal(canDeliverNotifications(), true)
  }
})

test('canDeliverNotifications: returns boolean', async () => {
  const { canDeliverNotifications } = await import('../src/main/services/notificationPermissions.ts')
  assert.equal(typeof canDeliverNotifications(), 'boolean')
})

test('notificationBlockedReason: returns null when state is not-determined or granted', async () => {
  const { notificationBlockedReason, NOTIFICATIONS_DENIED_MESSAGE } =
    await import('../src/main/services/notificationPermissions.ts')
  assert.equal(notificationBlockedReason(), null)
  assert.ok(NOTIFICATIONS_DENIED_MESSAGE.includes('System Settings'))
})

test('handleDeliverySuccess / handleDeliveryFailure: do not throw', async () => {
  const { handleDeliverySuccess, handleDeliveryFailure } =
    await import('../src/main/services/notificationPermissions.ts')

  await assert.doesNotReject(handleDeliverySuccess())
  await assert.doesNotReject(handleDeliveryFailure())
})
