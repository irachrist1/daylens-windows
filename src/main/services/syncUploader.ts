/**
 * SyncUploader — periodically syncs dirty days to the Convex backend.
 * Mirrors the macOS SyncUploader.swift for parity.
 */
import { exportSnapshot } from './snapshotExporter'
import { getDeviceId } from './credentials'
import { getConvexSiteUrl, getSessionToken, repairStoredWorkspaceSession } from './workspaceLinker'
import { daysFromTodayLocalDateString, localDateString } from '../lib/localDate'

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

// ─── State ───────────────────────────────────────────────────────────────────

const dirtyDays = new Set<string>()
let syncTimer: ReturnType<typeof setInterval> | null = null
let lastSyncAt: number | null = null

// ─── Public API ──────────────────────────────────────────────────────────────

export function startSync(): void {
  if (syncTimer) return

  // Mark today as dirty immediately
  markDirty(todayStr())

  // Fire first sync soon (10 seconds after startup)
  setTimeout(() => void syncNow(), 10_000)

  syncTimer = setInterval(() => {
    markDirty(todayStr()) // Today is always dirty while running
    void syncNow()
  }, SYNC_INTERVAL_MS)

  console.log('[sync] started — interval', SYNC_INTERVAL_MS / 1000, 's')
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  // Mark today dirty; the before-quit handler will call syncNowForQuit() and await it.
  markDirty(todayStr())
  console.log('[sync] stopped')
}

/**
 * Awaitable sync used during orderly shutdown.
 * Exported separately so before-quit can await it with a timeout.
 */
export async function syncNowForQuit(): Promise<void> {
  markDirty(todayStr())
  return syncNow()
}

export function markDirty(dateStr: string): void {
  dirtyDays.add(dateStr)
}

export function getLastSyncAt(): number | null {
  return lastSyncAt
}

/**
 * Called at end of day or on app quit to finalize the previous day's snapshot.
 */
export function finalizePreviousDay(): void {
  const yesterday = daysFromTodayLocalDateString(-1)
  markDirty(yesterday)
  void syncNow()
}

// ─── Sync logic ──────────────────────────────────────────────────────────────

async function syncNow(): Promise<void> {
  if (dirtyDays.size === 0) return

  const siteUrl = getConvexSiteUrl()
  if (!siteUrl) {
    console.warn('[sync] CONVEX_SITE_URL not set — skipping')
    return
  }

  const sessionToken = await getSessionToken()
  const deviceId = await getDeviceId()

  if (!sessionToken || !deviceId) {
    console.log('[sync] not linked — skipping')
    return
  }

  const dates = [...dirtyDays]

  for (const dateStr of dates) {
    try {
      const snapshot = exportSnapshot(dateStr, deviceId)

      const res = await uploadSnapshot(siteUrl, sessionToken, dateStr, snapshot)

      if (res.ok) {
        dirtyDays.delete(dateStr)
        lastSyncAt = Date.now()
        console.log(`[sync] uploaded ${dateStr}`)
      } else {
        const text = await res.text().catch(() => '')
        if (shouldAttemptSessionRepair(res.status, text)) {
          const repaired = await repairStoredWorkspaceSession()
          if (repaired) {
            const freshToken = await getSessionToken()
            if (freshToken) {
              const retryRes = await uploadSnapshot(siteUrl, freshToken, dateStr, snapshot)
              if (retryRes.ok) {
                dirtyDays.delete(dateStr)
                lastSyncAt = Date.now()
                console.log(`[sync] uploaded ${dateStr} after session repair`)
                continue
              }
              const retryText = await retryRes.text().catch(() => '')
              console.warn(`[sync] upload retry failed for ${dateStr}: ${retryRes.status} ${retryText}`)
              continue
            }
          }
        }

        console.warn(`[sync] upload failed for ${dateStr}: ${res.status} ${text}`)
      }
    } catch (err) {
      console.warn(`[sync] error uploading ${dateStr}:`, err)
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayStr(): string {
  return localDateString()
}

function uploadSnapshot(siteUrl: string, sessionToken: string, dateStr: string, snapshot: unknown): Promise<Response> {
  return fetch(`${siteUrl}/uploadSnapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      localDate: dateStr,
      snapshot,
    }),
  })
}

function shouldAttemptSessionRepair(status: number, bodyText: string): boolean {
  if (status !== 401 && status !== 403) return false

  return bodyText.includes('Snapshot identity mismatch')
    || bodyText.includes('Unknown device')
    || bodyText.includes('Not authenticated')
}
