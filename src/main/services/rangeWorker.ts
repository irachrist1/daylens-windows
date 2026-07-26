// Client for the range-facts worker subprocess (DEV-227). Heavy multi-day
// Apps-view reads run in packages/range-worker on a read-only connection so
// the main process — the one drawing the screen — never blocks on them.
//
// Fail-open by design: if the worker is missing, crashed, or slow, callers
// fall back to running the same query inline (exactly what shipped before).
// The worker is an optimization, never a correctness dependency.
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { getSettings } from './settings'
import { currentSafariHistoryAccessStatus } from './browserCapability'
import { isRealDayHarness } from '../lib/realDayHarness'
import type { AppSettings, LiveSession } from '@shared/types'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 5 * 60_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let _proc: ChildProcess | null = null
let _nextId = 1
let _stopping = false
const _pending = new Map<number, PendingRequest>()
const _crashTimes: number[] = []

function resolveWorkerPaths():
  | { serverPath: string; execArgv: string[] }
  | null {
  if (app.isPackaged) {
    const bundlePath = path.join(app.getAppPath(), 'dist', 'range-worker', 'index.cjs')
    if (fs.existsSync(bundlePath)) return { serverPath: bundlePath, execArgv: [] }
    return null
  }

  // Unpackaged, getAppPath() depends on how the app was started: the project
  // root under electron-forge, but the main bundle's own directory when
  // launched as `electron dist/main/main.js`. Try both roots (__dirname is
  // <root>/dist/main or <root>/.vite/build — two levels down either way),
  // preferring TypeScript source through the shared subprocess loader, with
  // the compiled bundle as fallback.
  const roots = [...new Set([app.getAppPath(), path.resolve(__dirname, '..', '..')])]
  for (const root of roots) {
    const loaderPath = path.join(root, 'packages', 'mcp-server', 'loader.mjs')
    const serverPath = path.join(root, 'packages', 'range-worker', 'src', 'index.ts')
    if (fs.existsSync(loaderPath) && fs.existsSync(serverPath)) {
      return { serverPath, execArgv: ['--loader', `file://${loaderPath}`] }
    }
  }
  for (const root of roots) {
    const bundlePath = path.join(root, 'dist', 'range-worker', 'index.cjs')
    if (fs.existsSync(bundlePath)) return { serverPath: bundlePath, execArgv: [] }
  }
  return null
}

function workerDisabled(): boolean {
  const now = Date.now()
  while (_crashTimes.length > 0 && now - _crashTimes[0] > CRASH_WINDOW_MS) _crashTimes.shift()
  return _crashTimes.length >= MAX_CRASHES
}

function rejectAllPending(reason: string): void {
  for (const [, pending] of _pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error(reason))
  }
  _pending.clear()
}

function ensureWorker(): ChildProcess | null {
  if (isRealDayHarness()) return null
  if (_proc && !_proc.killed) return _proc
  if (workerDisabled()) return null

  const paths = resolveWorkerPaths()
  if (!paths) return null

  const dbPath = path.join(app.getPath('userData'), 'daylens.sqlite')
  try {
    _proc = fork(paths.serverPath, [], {
      execArgv: paths.execArgv,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAYLENS_DB_PATH: dbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })
  } catch (err) {
    console.error('[range-worker] failed to spawn:', err)
    _proc = null
    return null
  }

  _proc.stderr?.on('data', (chunk: Buffer) => {
    console.warn('[range-worker]', chunk.toString().trim())
  })
  _proc.on('message', (message: { id?: number; ok?: boolean; result?: unknown; error?: string; op?: string }) => {
    if (typeof message?.id !== 'number') return
    const pending = _pending.get(message.id)
    if (!pending) return
    _pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error ?? 'range worker error'))
  })
  _proc.on('error', (err) => {
    console.error('[range-worker] process error:', err)
    _crashTimes.push(Date.now())
    rejectAllPending('range worker errored')
    _proc = null
  })
  _proc.on('exit', (code, signal) => {
    // Any exit we didn't ask for counts toward the disable window — including
    // signal deaths (SIGKILL/OOM arrive as code null + a signal).
    if (!_stopping && code !== 0) {
      console.warn(`[range-worker] exited (code ${code}, signal ${signal ?? 'none'})`)
      _crashTimes.push(Date.now())
    }
    rejectAllPending('range worker exited')
    _proc = null
  })

  console.log(`[range-worker] started (pid ${_proc.pid})`)
  return _proc
}

// Settings the worker's shared query actually reads. Kept minimal on purpose
// — the snapshot rides every request so worker facts always match main facts.
function settingsSnapshot(): Partial<AppSettings> {
  const settings = getSettings()
  return { focusApps: settings.focusApps }
}

async function runWorkerOp<T>(payload: Record<string, unknown>): Promise<T> {
  const proc = ensureWorker()
  if (!proc) throw new Error('range worker unavailable')
  const id = _nextId++
  const message = {
    id,
    settings: settingsSnapshot(),
    // The worker subprocess never runs the history poller, so it cannot know
    // the Safari Full Disk Access state on its own; ship the main process's
    // current value with each request (same pattern as the settings snapshot)
    // so a multi-day app detail's coverage note matches the inline 1-day path.
    safariHistoryAccess: currentSafariHistoryAccessStatus(),
    ...payload,
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id)
      // A hung worker must not stay in rotation: kill it (respawn happens on
      // the next request) and count the hang toward the disable window, or a
      // wedged subprocess would add 30s of latency to every Apps read forever.
      _crashTimes.push(Date.now())
      proc.kill('SIGKILL')
      reject(new Error('range worker timed out'))
    }, REQUEST_TIMEOUT_MS)
    _pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    proc.send(message, (err) => {
      if (err) {
        _pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  })
}

export async function workerAppSummaries<T>(
  fromMs: number,
  toMs: number,
  liveSession: LiveSession | null,
): Promise<T> {
  return runWorkerOp<T>({ op: 'appSummaries', fromMs, toMs, liveSession })
}

export async function workerAppDetail<T>(
  canonicalAppId: string,
  daysOrDate: number | string,
  liveSession: LiveSession | null,
): Promise<T> {
  return runWorkerOp<T>({ op: 'appDetail', canonicalAppId, daysOrDate, liveSession })
}

/** Duplicate-entity scan for Settings -> Entities (DEV-257). Read-only, like
 *  every worker op; the caller falls back inline when the worker is missing. */
export async function workerSuggestedMerges<T>(): Promise<T> {
  return runWorkerOp<T>({ op: 'suggestedMerges' })
}

export function stopRangeWorker(): void {
  if (!_proc || _proc.killed) return
  _stopping = true
  const proc = _proc
  _proc = null
  rejectAllPending('range worker stopped')
  proc.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL')
  }, 5_000)
  proc.on('exit', () => clearTimeout(killTimer))
}
