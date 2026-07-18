// Spawns the native capture helper (src/native/capture-helper) and appends its
// newline-delimited JSON events to focus_events. Runs alongside tracking.ts;
// it does not replace the existing capture path. macOS-only.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getDb } from './database'
import { insertFocusEvents } from '../db/focusEventRepository'
import { getSettings } from './settings'
import { resolveCanonicalApp } from '../lib/appIdentity'
import { resolveBrowserApplication } from './browserRegistry'
import { decideAppCapture, decideSiteCapture, detectIncognitoFromTitle, trackingControlsStateFromSettings, type TrackingControlsState } from '@shared/trackingControls'
import { isSystemNoiseApp } from '@shared/systemNoise'
import {
  FOCUS_EVENT_SCHEMA_VERSION,
  isFocusEventConfidence,
  isFocusEventType,
  isMacFocusEventSource,
  isSupportedFocusEventSchemaVersion,
  sourceAcceptsFocusEventType,
  type FocusEvent,
  type MacFocusEventSource,
} from '../core/evidence/focusEvent'
import { recordCaptureEventRejection } from '../lib/captureRejections'

type HelperEvent = FocusEvent<MacFocusEventSource>

let child: ChildProcessWithoutNullStreams | null = null
let stopping = false
let restartTimer: ReturnType<typeof setTimeout> | null = null
let shutdownKillTimer: ReturnType<typeof setTimeout> | null = null
let restartDelay = 1000
let spawnedAt = 0
const MAX_RESTART_DELAY = 30_000
const STABLE_UPTIME_MS = 10_000
const SHUTDOWN_KILL_DELAY_MS = 1500

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'capture-helper')
    : path.join(__dirname, '..', '..', 'build', 'capture-helper')
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
}

function reject(reason: 'malformed' | 'unsupported_schema_version'): null {
  recordCaptureEventRejection('mac_focus_helper', reason)
  return null
}

function normalizeHelperEvent(raw: unknown): HelperEvent | null {
  if (!isObject(raw)) return reject('malformed')
  const eventType = raw.event_type
  const source = raw.source
  const confidence = raw.confidence
  const schemaVersion = raw.schema_ver ?? FOCUS_EVENT_SCHEMA_VERSION
  if (!isSupportedFocusEventSchemaVersion(schemaVersion)) return reject('unsupported_schema_version')
  if (typeof raw.ts_ms !== 'number' || !Number.isFinite(raw.ts_ms)) return reject('malformed')
  if (typeof raw.mono_ns !== 'number' || !Number.isFinite(raw.mono_ns)) return reject('malformed')
  if (!isFocusEventType(eventType)) return reject('malformed')
  if (!isMacFocusEventSource(source)) return reject('malformed')
  if (!isFocusEventConfidence(confidence)) return reject('malformed')
  if (!isNullableString(raw.app_bundle_id)) return reject('malformed')
  if (!isNullableString(raw.app_name)) return reject('malformed')
  if (!isNullableNumber(raw.pid)) return reject('malformed')
  if (!isNullableString(raw.window_title)) return reject('malformed')
  if (!isNullableString(raw.url)) return reject('malformed')
  if (!isNullableString(raw.page_title)) return reject('malformed')
  if (!isNullableString(raw.platform)) return reject('malformed')

  const url = raw.url ?? null
  const pageTitle = raw.page_title ?? null

  if (!sourceAcceptsFocusEventType(source, eventType)) return reject('malformed')
  if (confidence === 'unknown' && (url !== null || pageTitle !== null)) return reject('malformed')
  if (source === 'apple_events_tab' && confidence === 'observed' && !url) return reject('malformed')
  if (source === 'nsworkspace_event' && (url !== null || pageTitle !== null)) return reject('malformed')

  return {
    ts_ms: raw.ts_ms,
    mono_ns: raw.mono_ns,
    event_type: eventType,
    app_bundle_id: raw.app_bundle_id ?? null,
    app_name: raw.app_name ?? null,
    pid: raw.pid ?? null,
    window_title: raw.window_title ?? null,
    url,
    page_title: pageTitle,
    source,
    confidence,
    platform: raw.platform ?? 'darwin',
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
  }
}

// Dense tab-switching can emit many helper events per second. Rather than one
// prepared INSERT per line (one WAL write each), events are queued and flushed
// in a single transaction every FOCUS_FLUSH_INTERVAL_MS or once the batch hits
// FOCUS_FLUSH_MAX_BATCH, plus an explicit flush on shutdown.
const FOCUS_FLUSH_INTERVAL_MS = 250
const FOCUS_FLUSH_MAX_BATCH = 100
let pendingEvents: HelperEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function eventParams(ev: HelperEvent): FocusEvent<MacFocusEventSource> {
  // A browser's window title/url is page content, and the focus helper cannot
  // know whether the window is private. Browser page detail only enters the
  // store through the corroborated visit pipeline; focus events for browsers
  // keep app identity and timing only.
  const isBrowser = resolveBrowserApplication({ bundleId: ev.app_bundle_id ?? null, appName: ev.app_name ?? null }) != null
  return {
    ts_ms: ev.ts_ms,
    mono_ns: ev.mono_ns,
    event_type: ev.event_type,
    app_bundle_id: ev.app_bundle_id ?? null,
    app_name: ev.app_name ?? null,
    pid: ev.pid ?? null,
    window_title: isBrowser ? null : ev.window_title ?? null,
    url: isBrowser ? null : ev.url ?? null,
    page_title: isBrowser ? null : ev.page_title ?? null,
    source: ev.source,
    confidence: ev.confidence,
    platform: ev.platform,
    schema_ver: ev.schema_ver,
  }
}

function flushFocusEvents(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingEvents.length === 0) return
  const batch = pendingEvents
  pendingEvents = []
  try {
    insertFocusEvents(getDb(), batch.map(eventParams))
  } catch (err) {
    console.warn('[focusCapture] batch insert failed:', err)
  }
}

// Focus events get the same system-noise and exclusion gates as foreground
// sessions, so a tab-switch or window-change for an excluded app/site (or a
// system surface like loginwindow) is never even written to focus_events — and
// so never reaches projections, Timeline, Apps, or the AI/MCP boundary. Pure
// and exported so the gate is directly testable without spawning the helper.
export function shouldCaptureFocusEvent(
  ev: Pick<HelperEvent, 'app_bundle_id' | 'app_name' | 'window_title' | 'url'>,
  controls: TrackingControlsState,
): boolean {
  // Consent gates every event unconditionally — including machine-state
  // events with no app or url, which the per-candidate gates below never see.
  if (!controls.consented) return false
  // Private/incognito windows are never tracked, regardless of any setting.
  // The gates below also check this, but the title check runs here first so
  // a private tab URL never even reaches the event queue.
  if (detectIncognitoFromTitle(ev.window_title)) return false
  if (ev.app_bundle_id || ev.app_name) {
    if (isSystemNoiseApp({ bundleId: ev.app_bundle_id, appName: ev.app_name })) return false
    const identity = resolveCanonicalApp(ev.app_bundle_id ?? '', ev.app_name ?? '')
    if (!decideAppCapture(controls, {
      bundleId: ev.app_bundle_id,
      canonicalAppId: identity.canonicalAppId,
      appName: ev.app_name,
      windowTitle: ev.window_title,
    }).capture) return false
  }
  if (ev.url) {
    try {
      const domain = new URL(ev.url).hostname
      if (!decideSiteCapture(controls, { domain, windowTitle: ev.window_title }).capture) return false
    } catch {
      return false
    }
  }
  return true
}

function enqueueEvent(ev: HelperEvent): void {
  if (!shouldCaptureFocusEvent(ev, trackingControlsStateFromSettings(getSettings()))) return
  pendingEvents.push(ev)
  if (pendingEvents.length >= FOCUS_FLUSH_MAX_BATCH) {
    flushFocusEvents()
    return
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flushFocusEvents, FOCUS_FLUSH_INTERVAL_MS)
  }
}

function handleLine(line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    recordCaptureEventRejection('mac_focus_helper', 'malformed')
    return
  }
  const ev = normalizeHelperEvent(parsed)
  if (!ev) return
  enqueueEvent(ev)
}

function scheduleRestart(): void {
  if (stopping || restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY)
    spawnHelper()
  }, restartDelay)
}

function spawnHelper(): void {
  if (stopping || child) return

  const bin = helperPath()
  if (!fs.existsSync(bin)) {
    console.warn(`[focusCapture] helper not found at ${bin} — run "npm run build:capture-helper"`)
    return
  }

  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    console.warn('[focusCapture] spawn failed:', err)
    scheduleRestart()
    return
  }
  child = proc
  spawnedAt = Date.now()

  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  })

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    const msg = chunk.trim()
    if (msg) console.log('[focusCapture]', msg)
  })

  proc.on('error', (err) => {
    console.warn('[focusCapture] process error:', err)
  })

  proc.on('exit', (code, signal) => {
    if (child === proc) child = null
    if (shutdownKillTimer) {
      clearTimeout(shutdownKillTimer)
      shutdownKillTimer = null
    }
    if (stopping) return
    // A run that stayed up resets the backoff; a fast crash escalates it.
    if (Date.now() - spawnedAt >= STABLE_UPTIME_MS) restartDelay = 1000
    console.warn(`[focusCapture] helper exited (code=${code} signal=${signal}); restarting`)
    scheduleRestart()
  })
}

export function startFocusCapture(): void {
  if (process.platform !== 'darwin') return
  stopping = false
  spawnHelper()
}

export function stopFocusCapture(): void {
  stopping = true
  // Persist anything still queued before we tear down.
  flushFocusEvents()
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (shutdownKillTimer) {
    clearTimeout(shutdownKillTimer)
    shutdownKillTimer = null
  }
  const proc = child
  if (proc) {
    try {
      proc.stdin.write('shutdown\n')
      proc.stdin.end()
    } catch {
      /* noop */
    }
    shutdownKillTimer = setTimeout(() => {
      shutdownKillTimer = null
      if (child !== proc) return
      try {
        proc.kill('SIGTERM')
      } catch {
        /* noop */
      }
      child = null
    }, SHUTDOWN_KILL_DELAY_MS)
  }
}
