/**
 * SyncUploader — periodically syncs dirty days to the Convex backend.
 * Mirrors the macOS SyncUploader.swift for parity.
 */
import { exportSnapshot } from './snapshotExporter'
import { getDeviceId, getWorkspaceId } from './credentials'

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || ''

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
  // Final sync attempt for today
  markDirty(todayStr())
  void syncNow()
  console.log('[sync] stopped')
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
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  markDirty(yesterday)
  void syncNow()
}

// ─── Sync logic ──────────────────────────────────────────────────────────────

async function syncNow(): Promise<void> {
  if (dirtyDays.size === 0) return

  const siteUrl = CONVEX_SITE_URL
  if (!siteUrl) {
    console.warn('[sync] CONVEX_SITE_URL not set — skipping')
    return
  }

  const workspaceId = await getWorkspaceId()
  const deviceId = await getDeviceId()

  if (!workspaceId || !deviceId) {
    console.log('[sync] not linked — skipping')
    return
  }

  const dates = [...dirtyDays]

  for (const dateStr of dates) {
    try {
      const snapshot = exportSnapshot(dateStr, deviceId)

      const res = await fetch(`${siteUrl}/uploadSnapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          deviceId,
          localDate: dateStr,
          snapshot,
        }),
      })

      if (res.ok) {
        dirtyDays.delete(dateStr)
        lastSyncAt = Date.now()
        console.log(`[sync] uploaded ${dateStr}`)
      } else {
        const text = await res.text().catch(() => '')
        console.warn(`[sync] upload failed for ${dateStr}: ${res.status} ${text}`)
      }
    } catch (err) {
      console.warn(`[sync] error uploading ${dateStr}:`, err)
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}
