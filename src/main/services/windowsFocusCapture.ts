// Spawns the Windows UIA capture helper and appends NDJSON events to focus_events.
// Runs alongside tracking.ts on win32 only.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { shouldCaptureFocusEvent } from './focusCapture'
import { getDb } from './database'
import { insertFocusEvents } from '../db/focusEventRepository'
import { getSettings } from './settings'
import { resolveBrowserApplication } from './browserRegistry'
import { trackingControlsStateFromSettings } from '@shared/trackingControls'
import {
  FOCUS_EVENT_SCHEMA_VERSION,
  isFocusEventConfidence,
  isFocusEventType,
  isSupportedFocusEventSchemaVersion,
  isWindowsFocusEventSource,
  sourceAcceptsFocusEventType,
  type FocusEvent,
  type WindowsFocusEventSource,
} from '../core/evidence/focusEvent'
import { recordCaptureEventRejection } from '../lib/captureRejections'

type HelperEvent = FocusEvent<WindowsFocusEventSource> & { is_private: boolean }

let child: ChildProcessWithoutNullStreams | null = null
let stopping = false
let restartTimer: ReturnType<typeof setTimeout> | null = null
let shutdownKillTimer: ReturnType<typeof setTimeout> | null = null
let restartDelay = 1000
let spawnedAt = 0
const MAX_RESTART_DELAY = 30_000
const STABLE_UPTIME_MS = 10_000
const SHUTDOWN_KILL_DELAY_MS = 1500
const PRIVATE_SIGNAL_MAX_AGE_MS = 10_000

interface WindowsPrivateWindowSignal {
  observedAt: number
  appBundleId: string | null
  appName: string | null
  pid: number | null
  windowTitle: string | null
}

let recentPrivateWindowSignal: WindowsPrivateWindowSignal | null = null

function helperPath(): string {
  const fileName = 'windows-capture-helper.exe'
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', fileName)
    : path.join(__dirname, '..', '..', 'build', fileName)
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

function isNullableBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === 'boolean'
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function rememberPrivateWindowSignal(ev: HelperEvent): void {
  recentPrivateWindowSignal = {
    observedAt: ev.ts_ms,
    appBundleId: ev.app_bundle_id ?? null,
    appName: ev.app_name ?? null,
    pid: ev.pid ?? null,
    windowTitle: ev.window_title ?? null,
  }
}

export function getRecentWindowsPrivateWindowSignal(candidate: {
  bundleId?: string | null
  appName?: string | null
  pid?: number | null
  windowTitle?: string | null
  nowMs?: number
}): boolean {
  if (process.platform !== 'win32') return false
  const signal = recentPrivateWindowSignal
  if (!signal) return false
  const now = candidate.nowMs ?? Date.now()
  if (now - signal.observedAt > PRIVATE_SIGNAL_MAX_AGE_MS) return false

  const candidatePid = candidate.pid ?? null
  if (candidatePid != null && signal.pid != null && candidatePid === signal.pid) return true

  const bundle = normalizeIdentity(candidate.bundleId)
  const signalBundle = normalizeIdentity(signal.appBundleId)
  if (bundle && signalBundle && bundle === signalBundle) return true

  const appName = normalizeIdentity(candidate.appName)
  const signalName = normalizeIdentity(signal.appName)
  if (appName && signalName && appName === signalName) return true

  const title = normalizeIdentity(candidate.windowTitle)
  const signalTitle = normalizeIdentity(signal.windowTitle)
  return Boolean(title && signalTitle && title === signalTitle)
}

export function __setRecentWindowsPrivateWindowSignalForTest(signal: WindowsPrivateWindowSignal | null): void {
  recentPrivateWindowSignal = signal
}

function reject(reason: 'malformed' | 'unsupported_schema_version'): null {
  recordCaptureEventRejection('windows_focus_helper', reason)
  return null
}

export function normalizeWindowsHelperEvent(raw: unknown): HelperEvent | null {
  if (!isObject(raw)) return reject('malformed')
  const eventType = raw.event_type
  const source = raw.source
  const confidence = raw.confidence
  const schemaVersion = raw.schema_ver ?? FOCUS_EVENT_SCHEMA_VERSION
  if (!isSupportedFocusEventSchemaVersion(schemaVersion)) return reject('unsupported_schema_version')
  if (typeof raw.ts_ms !== 'number' || !Number.isFinite(raw.ts_ms)) return reject('malformed')
  if (typeof raw.mono_ns !== 'number' || !Number.isFinite(raw.mono_ns)) return reject('malformed')
  if (!isFocusEventType(eventType)) return reject('malformed')
  if (!isWindowsFocusEventSource(source)) return reject('malformed')
  if (!isFocusEventConfidence(confidence)) return reject('malformed')
  if (!isNullableString(raw.app_bundle_id)) return reject('malformed')
  if (!isNullableString(raw.app_name)) return reject('malformed')
  if (!isNullableNumber(raw.pid)) return reject('malformed')
  if (!isNullableString(raw.window_title)) return reject('malformed')
  if (!isNullableString(raw.url)) return reject('malformed')
  if (!isNullableString(raw.page_title)) return reject('malformed')
  if (!isNullableBoolean(raw.is_private)) return reject('malformed')
  if (!isNullableString(raw.platform)) return reject('malformed')

  const url = raw.url ?? null
  const pageTitle = raw.page_title ?? null
  const isPrivate = raw.is_private ?? false

  if (!sourceAcceptsFocusEventType(source, eventType)) return reject('malformed')
  if (confidence === 'unknown' && (url !== null || pageTitle !== null)) return reject('malformed')
  if (source === 'uia_tab' && confidence === 'observed' && !url) return reject('malformed')
  if (source === 'uia_foreground' && (url !== null || pageTitle !== null)) return reject('malformed')

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
    is_private: isPrivate,
    platform: raw.platform ?? 'win32',
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
  }
}

const FOCUS_FLUSH_INTERVAL_MS = 250
const FOCUS_FLUSH_MAX_BATCH = 100
let pendingEvents: HelperEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function eventParams(ev: HelperEvent): FocusEvent<WindowsFocusEventSource> {
  // Browser window titles/urls are page content and the helper cannot know
  // whether the window is private; page detail only enters the store through
  // the corroborated visit pipeline.
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
    console.warn('[windowsFocusCapture] batch insert failed:', err)
  }
}

function enqueueEvent(ev: HelperEvent): void {
  if (ev.is_private) {
    rememberPrivateWindowSignal(ev)
    return
  }
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
    recordCaptureEventRejection('windows_focus_helper', 'malformed')
    return
  }
  const ev = normalizeWindowsHelperEvent(parsed)
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
    console.warn(`[windowsFocusCapture] helper not found at ${bin} — run "npm run build:capture-helper" on Windows`)
    return
  }

  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    console.warn('[windowsFocusCapture] spawn failed:', err)
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
    if (msg) console.log('[windowsFocusCapture]', msg)
  })

  proc.on('error', (err) => {
    console.warn('[windowsFocusCapture] process error:', err)
  })

  proc.on('exit', (code, signal) => {
    if (child === proc) child = null
    if (shutdownKillTimer) {
      clearTimeout(shutdownKillTimer)
      shutdownKillTimer = null
    }
    if (stopping) return
    if (Date.now() - spawnedAt >= STABLE_UPTIME_MS) restartDelay = 1000
    console.warn(`[windowsFocusCapture] helper exited (code=${code} signal=${signal}); restarting`)
    scheduleRestart()
  })
}

export function startWindowsFocusCapture(): void {
  if (process.platform !== 'win32') return
  stopping = false
  spawnHelper()
}

export function stopWindowsFocusCapture(): void {
  if (process.platform !== 'win32') return
  stopping = true
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
      proc.kill('SIGTERM')
    } catch {
      /* noop */
    }
    shutdownKillTimer = setTimeout(() => {
      shutdownKillTimer = null
      if (child !== proc) return
      try {
        proc.kill('SIGKILL')
      } catch {
        /* noop */
      }
      child = null
    }, SHUTDOWN_KILL_DELAY_MS)
  }
}

export function isWindowsFocusCaptureRunning(): boolean {
  return child !== null
}
