// Capability signals the attribution read layer needs from the capture layer
// without importing it. browser.ts (the history poller) owns the Safari
// Full Disk Access state but sits behind electron imports; the Apps read
// model (appDetail) runs in plain node during tests and inside the query
// worker, so it reads the state through this registration seam instead.
// The filesystem-access classification lives here for the same reason: it
// has no electron dependency and needs deterministic unit coverage.
import fs from 'node:fs'
import type { SafariHistoryAccessStatus } from '@shared/types'

export function isPermissionDeniedError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EPERM' || code === 'EACCES') return true
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('Operation not permitted') || message.includes('EPERM') || message.includes('EACCES')
}

export type HistoryPathAvailability = 'readable' | 'missing' | 'denied'

// fs.existsSync cannot tell a TCC-denied path from a missing one — it swallows
// the EPERM and reports false, which silently skipped Safari's poll forever
// and left the Full Disk Access state stuck at 'unknown' (DEV-238). A real
// stat keeps the error, so denied and missing stay distinguishable.
export function historyPathAvailability(historyPath: string): HistoryPathAvailability {
  try {
    fs.statSync(historyPath)
    return 'readable'
  } catch (err) {
    return isPermissionDeniedError(err) ? 'denied' : 'missing'
  }
}

let safariHistoryAccessProvider: (() => SafariHistoryAccessStatus) | null = null

export function registerSafariHistoryAccessProvider(
  provider: () => SafariHistoryAccessStatus,
): void {
  safariHistoryAccessProvider = provider
}

/** 'unknown' when no capture layer registered (tests, query worker). */
export function currentSafariHistoryAccessStatus(): SafariHistoryAccessStatus {
  return safariHistoryAccessProvider?.() ?? 'unknown'
}
