// Focus capture (mac): supervises the capture relay subprocess and ingests
// its on-disk spool into focus_events. The relay (packages/capture-relay)
// owns the native helper and writes every gated event to disk the moment it
// is observed (DEV-262), so a frozen, crashed, or killed main process loses
// at most the relay's current write buffer — never the hours an in-memory
// pipe used to hold. Ingestion tails the spool with a durable cursor and
// runs alongside tracking.ts; it does not replace the existing capture path.
// macOS-only.
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getDb } from './database'
import { getSettings } from './settings'
import { trackingControlsStateFromSettings } from '@shared/trackingControls'
import { ingestSpool, deleteSpool } from './captureSpool'

// The privacy gate lives in captureEventGate (it must run inside the relay,
// before disk); re-exported here because it is part of this module's
// long-standing test surface.
export { shouldCaptureFocusEvent, eventParams } from './captureEventGate'

let relay: ChildProcess | null = null
let stopping = false
// Consent revoked while the relay was still exiting: its last flush can land
// after the immediate purge, so sweep the spool again once it is truly gone.
let purgeSpoolOnRelayExit = false
let restartTimer: ReturnType<typeof setTimeout> | null = null
let shutdownKillTimer: ReturnType<typeof setTimeout> | null = null
let ingestTimer: ReturnType<typeof setInterval> | null = null
let controlsTimer: ReturnType<typeof setInterval> | null = null
let restartDelay = 1000
let spawnedAt = 0
const MAX_RESTART_DELAY = 30_000
const STABLE_UPTIME_MS = 10_000
const SHUTDOWN_KILL_DELAY_MS = 1500
const INGEST_INTERVAL_MS = 250
// The relay gates with the controls snapshot it holds; refresh it on the same
// cadence the permission watcher uses so settings changes reach the gate
// within seconds.
const CONTROLS_PUSH_INTERVAL_MS = 5_000

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'capture-helper')
    : path.join(__dirname, '..', '..', 'build', 'capture-helper')
}

export function captureSpoolDir(): string {
  return path.join(app.getPath('userData'), 'capture-spool')
}

function resolveRelayPaths():
  | { serverPath: string; execArgv: string[] }
  | null {
  if (app.isPackaged) {
    const bundlePath = path.join(app.getAppPath(), 'dist', 'capture-relay', 'index.cjs')
    if (fs.existsSync(bundlePath)) return { serverPath: bundlePath, execArgv: [] }
    return null
  }
  const roots = [...new Set([app.getAppPath(), path.resolve(__dirname, '..', '..')])]
  for (const root of roots) {
    const loaderPath = path.join(root, 'packages', 'mcp-server', 'loader.mjs')
    const serverPath = path.join(root, 'packages', 'capture-relay', 'src', 'index.ts')
    if (fs.existsSync(loaderPath) && fs.existsSync(serverPath)) {
      return { serverPath, execArgv: ['--loader', `file://${loaderPath}`] }
    }
  }
  for (const root of roots) {
    const bundlePath = path.join(root, 'dist', 'capture-relay', 'index.cjs')
    if (fs.existsSync(bundlePath)) return { serverPath: bundlePath, execArgv: [] }
  }
  return null
}

function pushControls(): void {
  if (!relay || relay.killed) return
  try {
    relay.send({ op: 'controls', controls: trackingControlsStateFromSettings(getSettings()) })
  } catch {
    /* relay is going down; restart handling owns it */
  }
}

function ingestTick(): void {
  try {
    ingestSpool(getDb(), captureSpoolDir())
  } catch (err) {
    console.warn('[focusCapture] spool ingest failed:', err)
  }
}

function scheduleRestart(): void {
  if (stopping || restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY)
    spawnRelay()
  }, restartDelay)
}

function spawnRelay(): void {
  if (stopping || relay) return

  const bin = helperPath()
  if (!fs.existsSync(bin)) {
    console.warn(`[focusCapture] helper not found at ${bin} — run "npm run build:capture-helper"`)
    return
  }
  const paths = resolveRelayPaths()
  if (!paths) {
    console.warn('[focusCapture] capture relay not found — capture cannot start')
    return
  }

  let proc: ChildProcess
  try {
    proc = fork(paths.serverPath, [], {
      execArgv: paths.execArgv,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAYLENS_CAPTURE_HELPER_PATH: bin,
        DAYLENS_CAPTURE_SPOOL_DIR: captureSpoolDir(),
        // Feature gate for the per-display visibility stream: the helper
        // emits display_visible_* events only when the spawner declares it
        // understands them.
        DAYLENS_CAPTURE_DISPLAY_VISIBILITY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })
  } catch (err) {
    console.warn('[focusCapture] relay spawn failed:', err)
    scheduleRestart()
    return
  }
  relay = proc
  spawnedAt = Date.now()
  pushControls()

  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    const msg = String(chunk).trim()
    if (msg) console.log('[focusCapture]', msg)
  })
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    const msg = String(chunk).trim()
    if (msg) console.log('[focusCapture]', msg)
  })

  proc.on('message', (message: { op?: string; code?: number | null; signal?: string | null }) => {
    if (message?.op === 'helper-exited') {
      console.warn(`[focusCapture] helper exited inside relay (code=${message.code} signal=${message.signal})`)
    }
  })
  proc.on('error', (err) => {
    console.warn('[focusCapture] relay process error:', err)
  })
  proc.on('exit', (code, signal) => {
    if (relay === proc) relay = null
    if (shutdownKillTimer) {
      clearTimeout(shutdownKillTimer)
      shutdownKillTimer = null
    }
    if (purgeSpoolOnRelayExit) {
      purgeSpoolOnRelayExit = false
      purgeFocusCaptureSpool()
    }
    if (stopping) return
    if (Date.now() - spawnedAt >= STABLE_UPTIME_MS) restartDelay = 1000
    console.warn(`[focusCapture] relay exited (code=${code} signal=${signal}); restarting`)
    scheduleRestart()
  })
}

export function startFocusCapture(): void {
  if (process.platform !== 'darwin') return
  stopping = false
  // A fresh consent grant supersedes any pending revocation sweep.
  purgeSpoolOnRelayExit = false
  // Anything spooled while the app was down lands before live tailing begins.
  ingestTick()
  spawnRelay()
  if (!ingestTimer) ingestTimer = setInterval(ingestTick, INGEST_INTERVAL_MS)
  if (!controlsTimer) controlsTimer = setInterval(pushControls, CONTROLS_PUSH_INTERVAL_MS)
}

/** `finalDrain: false` is the consent-revocation path: skip the last ingest
 *  so spooled events are purged, not persisted (DEV-262). Every other stop
 *  drains, so a clean quit loses nothing the relay flushed. */
export function stopFocusCapture(options: { finalDrain?: boolean } = {}): void {
  const { finalDrain = true } = options
  stopping = true
  if (!finalDrain && relay) purgeSpoolOnRelayExit = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (ingestTimer) {
    clearInterval(ingestTimer)
    ingestTimer = null
  }
  if (controlsTimer) {
    clearInterval(controlsTimer)
    controlsTimer = null
  }
  const proc = relay
  if (proc) {
    try {
      proc.send({ op: 'shutdown' })
    } catch {
      /* noop */
    }
    shutdownKillTimer = setTimeout(() => {
      shutdownKillTimer = null
      if (relay !== proc) return
      try {
        proc.kill('SIGTERM')
      } catch {
        /* noop */
      }
      relay = null
    }, SHUTDOWN_KILL_DELAY_MS)
  }
  // Final drain so a clean quit persists everything the relay flushed.
  if (finalDrain) ingestTick()
}

/** Consent revoked: stop capture and remove anything spooled but not yet
 *  ingested — nothing observed may outlive the user's decision. */
export function purgeFocusCaptureSpool(): void {
  try {
    deleteSpool(captureSpoolDir())
  } catch (err) {
    console.warn('[focusCapture] spool purge failed:', err)
  }
}
