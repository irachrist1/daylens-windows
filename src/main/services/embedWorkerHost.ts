// Client for the embedding worker subprocess. The Electron main process
// installs this as the semantic embedder's transport (see
// setSemanticEmbedderWorkerTransport) so ONNX inference never runs on the
// thread that draws the screen. Unlike the range worker there is no inline
// fallback: running the model in-process is the failure mode this exists to
// prevent, so when the worker is unavailable semantic indexing reports itself
// unavailable and retries later.
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import {
  semanticModelCacheDir,
  setSemanticEmbedderWorkerTransport,
  SEMANTIC_EMBEDDING_DIMS,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_REVISION,
  SEMANTIC_EMBEDDING_VERSION,
  type SemanticEmbedderResult,
} from './semanticEmbedder'

// One batch is sub-batched to a bounded cost inside the worker, so a healthy
// embed call finishes in seconds; a worker that takes this long is wedged and
// gets killed rather than left to hold the queue.
const REQUEST_TIMEOUT_MS = 120_000
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
    const bundlePath = path.join(app.getAppPath(), 'dist', 'embed-worker', 'index.cjs')
    if (fs.existsSync(bundlePath)) return { serverPath: bundlePath, execArgv: [] }
    return null
  }

  const roots = [...new Set([app.getAppPath(), path.resolve(__dirname, '..', '..')])]
  for (const root of roots) {
    const loaderPath = path.join(root, 'packages', 'mcp-server', 'loader.mjs')
    const serverPath = path.join(root, 'packages', 'embed-worker', 'src', 'index.ts')
    if (fs.existsSync(loaderPath) && fs.existsSync(serverPath)) {
      return { serverPath, execArgv: ['--loader', `file://${loaderPath}`] }
    }
  }
  for (const root of roots) {
    const bundlePath = path.join(root, 'dist', 'embed-worker', 'index.cjs')
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
  if (_proc && !_proc.killed) return _proc
  if (workerDisabled()) return null

  const paths = resolveWorkerPaths()
  if (!paths) return null

  try {
    _proc = fork(paths.serverPath, [], {
      execArgv: paths.execArgv,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAYLENS_SEMANTIC_MODEL_DIR: semanticModelCacheDir(),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })
  } catch (err) {
    console.error('[embed-worker] failed to spawn:', err)
    _proc = null
    return null
  }

  _proc.stderr?.on('data', (chunk: Buffer) => {
    console.warn('[embed-worker]', chunk.toString().trim())
  })
  _proc.on('message', (message: { id?: number; ok?: boolean; result?: unknown; error?: string; op?: string }) => {
    if (typeof message?.id !== 'number') return
    const pending = _pending.get(message.id)
    if (!pending) return
    _pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error ?? 'embed worker error'))
  })
  _proc.on('error', (err) => {
    console.error('[embed-worker] process error:', err)
    _crashTimes.push(Date.now())
    rejectAllPending('embed worker errored')
    _proc = null
  })
  _proc.on('exit', (code, signal) => {
    if (!_stopping && code !== 0) {
      console.warn(`[embed-worker] exited (code ${code}, signal ${signal ?? 'none'})`)
      _crashTimes.push(Date.now())
    }
    rejectAllPending('embed worker exited')
    _proc = null
  })

  console.log(`[embed-worker] started (pid ${_proc.pid})`)
  return _proc
}

async function runWorkerOp<T>(payload: Record<string, unknown>): Promise<T> {
  const proc = ensureWorker()
  if (!proc) throw new Error('embed worker unavailable')
  const id = _nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id)
      // A wedged worker must not stay in rotation: kill it (respawn happens
      // on the next request) and count the hang toward the disable window.
      _crashTimes.push(Date.now())
      proc.kill('SIGKILL')
      reject(new Error('embed worker timed out'))
    }, REQUEST_TIMEOUT_MS)
    _pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    proc.send({ id, ...payload }, (err) => {
      if (err) {
        _pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  })
}

interface WorkerStatus {
  ok: boolean
  reason?: string
  detail?: string
  model?: string
  version?: number
  dims?: number
}

async function loadWorkerEmbedder(): Promise<SemanticEmbedderResult> {
  let status: WorkerStatus
  try {
    status = await runWorkerOp<WorkerStatus>({ op: 'status' })
  } catch (error) {
    return {
      ok: false,
      reason: 'load-failed',
      detail: `embed worker unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!status.ok) {
    const reason = status.reason === 'model-missing' || status.reason === 'runtime-missing'
      ? status.reason
      : 'load-failed'
    return { ok: false, reason, detail: status.detail ?? 'embed worker failed to load the model' }
  }
  return {
    ok: true,
    embedder: {
      model: status.model ?? `${SEMANTIC_MODEL_ID}@${SEMANTIC_MODEL_REVISION}`,
      version: status.version ?? SEMANTIC_EMBEDDING_VERSION,
      dims: status.dims ?? SEMANTIC_EMBEDDING_DIMS,
      async embed(texts) {
        if (texts.length === 0) return []
        const result = await runWorkerOp<{ vectors: number[][] }>({ op: 'embed', texts: [...texts] })
        return result.vectors.map((vector) => Float32Array.from(vector))
      },
    },
  }
}

/** Route all semantic embedding in this process through the worker. */
export function installEmbedWorkerTransport(): void {
  setSemanticEmbedderWorkerTransport(loadWorkerEmbedder)
}

export function stopEmbedWorker(): void {
  if (!_proc || _proc.killed) return
  _stopping = true
  const proc = _proc
  _proc = null
  rejectAllPending('embed worker stopped')
  proc.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL')
  }, 5_000)
  proc.on('exit', () => clearTimeout(killTimer))
}
