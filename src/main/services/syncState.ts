import type { SyncRuntimeState } from './syncUploader'

const STALE_SYNC_MS = 5 * 60 * 1000

export function deriveSyncState(
  runtime: SyncRuntimeState,
  isLinked: boolean,
  now = Date.now(),
): 'local_only' | 'linked' | 'pending_first_sync' | 'healthy' | 'stale' | 'failed' {
  if (!isLinked) return 'local_only'
  if (runtime.lastDaySyncFailureAt && (!runtime.lastSuccessfulDaySyncAt || runtime.lastDaySyncFailureAt >= runtime.lastSuccessfulDaySyncAt)) {
    return 'failed'
  }
  if (!runtime.hasCompletedInitialDaySync) {
    return 'pending_first_sync'
  }
  if (runtime.lastHeartbeatAt && now - runtime.lastHeartbeatAt > STALE_SYNC_MS) {
    return 'stale'
  }
  if (!runtime.lastHeartbeatAt) {
    return 'linked'
  }
  return 'healthy'
}
