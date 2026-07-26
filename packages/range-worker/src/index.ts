// Range-facts worker subprocess (DEV-227). better-sqlite3 is synchronous, so
// a 30-day corrected-activity scan (~1s on a real database) freezes whatever
// process runs it. This worker owns that scan: it opens its own READ-ONLY
// connection to the same WAL database and serves the Apps-view range reads
// (summaries, app detail) over the fork IPC channel, so the process that
// draws the screen never blocks on them.
//
// Runs under ELECTRON_RUN_AS_NODE like the MCP server subprocess, with the
// same loader/stubs in dev and a vite bundle (dist/range-worker) when
// packaged. It never writes: the connection is opened readonly, and every
// function it calls takes the db handle as an argument.
import Database from 'better-sqlite3'
import { getCorrectedAppSummariesForRange } from '../../../src/main/services/activityFacts'
import { getAppDetailPayload } from '../../../src/main/services/appDetail'
import { registerSafariHistoryAccessProvider } from '../../../src/main/services/browserCapability'
import { primeWorkerSettingsOverride } from '../../../src/main/services/settings'
import type { AppSettings, LiveSession, SafariHistoryAccessStatus } from '../../../src/shared/types'

interface WorkerRequest {
  id: number
  op: 'appSummaries' | 'appDetail'
  settings?: Partial<AppSettings>
  safariHistoryAccess?: SafariHistoryAccessStatus
  fromMs?: number
  toMs?: number
  canonicalAppId?: string
  daysOrDate?: number | string
  liveSession?: LiveSession | null
}

const dbPath = process.env.DAYLENS_DB_PATH
let db: Database.Database | null = null

function ensureDb(): Database.Database {
  if (!db) {
    if (!dbPath) throw new Error('DAYLENS_DB_PATH is not set')
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  }
  return db
}

function handle(request: WorkerRequest): unknown {
  // Each request carries the caller's current settings snapshot so facts
  // computed here (focusApps → isFocused) match the main process exactly.
  primeWorkerSettingsOverride(request.settings ?? {})
  // Same for the Safari Full Disk Access state: only the main process runs
  // the history poller, so the coverage note on a browser's unattributed time
  // must read the shipped value, never a locally stale 'unknown'.
  const safariHistoryAccess = request.safariHistoryAccess ?? 'unknown'
  registerSafariHistoryAccessProvider(() => safariHistoryAccess)
  switch (request.op) {
    case 'appSummaries':
      return getCorrectedAppSummariesForRange(
        ensureDb(),
        request.fromMs ?? 0,
        request.toMs ?? Date.now(),
        request.liveSession ?? null,
      )
    case 'appDetail':
      if (!request.canonicalAppId) throw new Error('appDetail requires canonicalAppId')
      return getAppDetailPayload(
        ensureDb(),
        request.canonicalAppId,
        request.daysOrDate ?? 7,
        request.liveSession ?? null,
      )
    default:
      throw new Error(`Unknown op: ${String(request.op)}`)
  }
}

process.on('message', (message: WorkerRequest) => {
  if (!message || typeof message.id !== 'number') return
  try {
    const result = handle(message)
    process.send?.({ id: message.id, ok: true, result })
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

process.send?.({ op: 'ready' })
