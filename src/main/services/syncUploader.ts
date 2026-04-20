import { getDeviceId } from './credentials'
import { localDateString, daysFromTodayLocalDateString } from '../lib/localDate'
import {
  getConvexSiteUrl,
  getSessionToken,
  repairStoredWorkspaceSession,
} from './workspaceLinker'
import { buildRemoteSyncPayload, buildWorkspaceLivePresence } from './remoteSync'
import { onTrackingTick } from './tracking'

const HEARTBEAT_INTERVAL_MS = 15_000
const SYNC_INTERVAL_MS = 60_000
const TRACKING_SYNC_DEBOUNCE_MS = 20_000

const dirtyDays = new Set<string>()
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeTrackingTick: (() => void) | null = null
let lastHeartbeatAt: number | null = null
let lastSuccessfulDaySyncAt: number | null = null
let lastHeartbeatFailureAt: number | null = null
let lastHeartbeatFailureMessage: string | null = null
let lastDaySyncFailureAt: number | null = null
let lastDaySyncFailureMessage: string | null = null
let hasCompletedInitialDaySync = false
let lastTrackingTriggeredSyncAt = 0
let heartbeatInFlight = false
let syncInFlight = false

export interface SyncRuntimeState {
  lastHeartbeatAt: number | null
  lastSuccessfulDaySyncAt: number | null
  lastHeartbeatFailureAt: number | null
  lastHeartbeatFailureMessage: string | null
  lastDaySyncFailureAt: number | null
  lastDaySyncFailureMessage: string | null
  hasCompletedInitialDaySync: boolean
}

export function startSync(): void {
  if (heartbeatTimer || syncTimer) return

  markDirty(todayStr())

  setTimeout(() => {
    void heartbeatNow()
    void syncNow()
  }, 5_000)

  heartbeatTimer = setInterval(() => {
    void heartbeatNow()
  }, HEARTBEAT_INTERVAL_MS)

  syncTimer = setInterval(() => {
    markDirty(todayStr())
    void syncNow()
  }, SYNC_INTERVAL_MS)

  unsubscribeTrackingTick = onTrackingTick(() => {
    markDirty(todayStr())
    const now = Date.now()
    if (now - lastTrackingTriggeredSyncAt < TRACKING_SYNC_DEBOUNCE_MS) {
      return
    }
    lastTrackingTriggeredSyncAt = now
    void heartbeatNow()
    void syncNow()
  })

  console.log('[sync] started', {
    heartbeatSeconds: HEARTBEAT_INTERVAL_MS / 1000,
    syncSeconds: SYNC_INTERVAL_MS / 1000,
  })
}

export function stopSync(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  if (unsubscribeTrackingTick) {
    unsubscribeTrackingTick()
    unsubscribeTrackingTick = null
  }
  markDirty(todayStr())
  console.log('[sync] stopped')
}

export async function syncNowForQuit(): Promise<void> {
  markDirty(todayStr())
  await heartbeatNow()
  await syncNow()
}

export function markDirty(dateStr: string): void {
  dirtyDays.add(dateStr)
}

export function getLastSyncAt(): number | null {
  return lastSuccessfulDaySyncAt
}

export function getSyncRuntimeState(): SyncRuntimeState {
  return {
    lastHeartbeatAt,
    lastSuccessfulDaySyncAt,
    lastHeartbeatFailureAt,
    lastHeartbeatFailureMessage,
    lastDaySyncFailureAt,
    lastDaySyncFailureMessage,
    hasCompletedInitialDaySync,
  }
}

export function finalizePreviousDay(): void {
  const yesterday = daysFromTodayLocalDateString(-1)
  markDirty(yesterday)
  void syncNow()
}

async function heartbeatNow(): Promise<void> {
  if (heartbeatInFlight) return
  heartbeatInFlight = true

  try {
    const siteUrl = getConvexSiteUrl()
    const sessionToken = await getSessionToken()
    const deviceId = await getDeviceId()

    if (!siteUrl || !sessionToken || !deviceId) {
      return
    }

    const presence = buildWorkspaceLivePresence(deviceId)
    const res = await postWithSessionRepair(
      siteUrl,
      sessionToken,
      'remote/heartbeat',
      presence,
    )

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      recordHeartbeatFailure(`heartbeat failed: ${res.status} ${text}`.trim())
      return
    }

    recordHeartbeatSuccess()
  } catch (error) {
    recordHeartbeatFailure(`heartbeat error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    heartbeatInFlight = false
  }
}

async function syncNow(): Promise<void> {
  if (syncInFlight || dirtyDays.size === 0) return
  syncInFlight = true

  try {
    const siteUrl = getConvexSiteUrl()
    const sessionToken = await getSessionToken()
    const deviceId = await getDeviceId()

    if (!siteUrl || !sessionToken || !deviceId) {
      return
    }

    const dates = [...dirtyDays].sort()

    for (const dateStr of dates) {
      try {
        const payload = buildRemoteSyncPayload(dateStr, deviceId)
        const res = await postWithSessionRepair(
          siteUrl,
          sessionToken,
          'remote/syncDay',
          payload,
        )

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          recordDaySyncFailure(`day sync failed for ${dateStr}: ${res.status} ${text}`.trim())
          continue
        }

        dirtyDays.delete(dateStr)
        hasCompletedInitialDaySync = true
        recordDaySyncSuccess()
        console.log(`[sync] remote day synced ${dateStr}`)
      } catch (error) {
        recordDaySyncFailure(`day sync error for ${dateStr}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    syncInFlight = false
  }
}

function todayStr(): string {
  return localDateString()
}

function recordHeartbeatSuccess(): void {
  lastHeartbeatAt = Date.now()
  lastHeartbeatFailureAt = null
  lastHeartbeatFailureMessage = null
}

function recordHeartbeatFailure(message: string): void {
  lastHeartbeatFailureAt = Date.now()
  lastHeartbeatFailureMessage = message
  console.warn('[sync]', message)
}

function recordDaySyncSuccess(): void {
  lastSuccessfulDaySyncAt = Date.now()
  lastDaySyncFailureAt = null
  lastDaySyncFailureMessage = null
}

function recordDaySyncFailure(message: string): void {
  lastDaySyncFailureAt = Date.now()
  lastDaySyncFailureMessage = message
  console.warn('[sync]', message)
}

async function postWithSessionRepair(
  siteUrl: string,
  sessionToken: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const initial = await post(siteUrl, sessionToken, path, body)
  if (initial.ok) {
    return initial
  }

  const initialText = await initial.clone().text().catch(() => '')
  if (!shouldAttemptSessionRepair(initial.status, initialText)) {
    return initial
  }

  const repaired = await repairStoredWorkspaceSession()
  if (!repaired) {
    return initial
  }

  const freshToken = await getSessionToken()
  if (!freshToken) {
    return initial
  }

  return post(siteUrl, freshToken, path, body)
}

function post(
  siteUrl: string,
  sessionToken: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${siteUrl}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(body),
  })
}

function shouldAttemptSessionRepair(status: number, bodyText: string): boolean {
  if (status !== 401 && status !== 403) return false

  return bodyText.includes('identity mismatch')
    || bodyText.includes('Unknown device')
    || bodyText.includes('Not authenticated')
    || bodyText.includes('Session revoked')
}
