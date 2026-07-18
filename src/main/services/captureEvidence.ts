import type Database from 'better-sqlite3'
import { getDb } from './database'
import { insertFocusEvents } from '../db/focusEventRepository'
import {
  POLL_FOCUS_EVENT_SOURCE,
  SUPERVISOR_FOCUS_EVENT_SOURCE,
  FOCUS_EVENT_SCHEMA_VERSION,
  type FocusEventInsert,
  type FocusEventType,
} from '../core/evidence/focusEvent'

// Canonical evidence emission for the poll-based capture path. The tracking
// FSM (tracking.ts) keeps its legacy app_sessions write for parity
// measurement; every observation it makes is ALSO recorded here as canonical
// focus_events rows, so the canonical store — not the legacy tables — is the
// record new consumers project from.
//
// Every caller sits downstream of the FSM's capture gates (pause, exclusions,
// private windows, consent), so an emission is always an observation that was
// allowed to exist. Emission itself is best-effort: a canonical write failure
// must never take down live capture, so failures log and count, never throw.

export type PollForegroundEventType = 'app_activated' | 'app_deactivated' | 'window_changed'
export type PollMachineStateEventType = 'sleep' | 'wake' | 'lock' | 'unlock'
export type SupervisorEventType =
  | 'idle_started'
  | 'idle_ended'
  | 'capture_started'
  | 'capture_stopped'
  | 'capture_paused'
  | 'capture_resumed'
  | 'capture_failed'
  | 'capture_recovered'

export interface PollForegroundObservation {
  tsMs: number
  bundleId: string | null
  appName: string | null
  pid: number | null
  windowTitle: string | null
}

let emissionFailureLogged = false

function baseEvent(eventType: FocusEventType, tsMs: number, platform: NodeJS.Platform = process.platform): FocusEventInsert {
  return {
    ts_ms: tsMs,
    mono_ns: Number(process.hrtime.bigint()),
    event_type: eventType,
    app_bundle_id: null,
    app_name: null,
    pid: null,
    window_title: null,
    url: null,
    page_title: null,
    source: POLL_FOCUS_EVENT_SOURCE,
    confidence: 'observed',
    platform,
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
  }
}

function persist(events: FocusEventInsert[]): void {
  try {
    insertFocusEvents(getDb(), events)
    emissionFailureLogged = false
  } catch (err) {
    // Log the first failure of a burst, then stay quiet: a broken canonical
    // write during a dense switch storm must not flood the log or slow polls.
    if (!emissionFailureLogged) {
      emissionFailureLogged = true
      console.warn('[capture-evidence] canonical emission failed:', err)
    }
  }
}

export function recordPollForegroundEvent(
  eventType: PollForegroundEventType,
  observation: PollForegroundObservation,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'linux') return
  persist([{
    ...baseEvent(eventType, observation.tsMs, platform),
    app_bundle_id: observation.bundleId,
    app_name: observation.appName,
    pid: observation.pid,
    window_title: observation.windowTitle,
  }])
}

// Machine-state transitions observed by the poll adapter (powerMonitor). They
// carry no application content — the transition itself is the fact.
export function recordPollMachineStateEvent(
  eventType: PollMachineStateEventType,
  tsMs: number,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'linux') return
  persist([baseEvent(eventType, tsMs, platform)])
}

// Idle and capture-health transitions. The capture_supervisor source is
// content-free by contract; the repository rejects any content that leaks in.
export function recordSupervisorEvent(eventType: SupervisorEventType, tsMs: number): void {
  persist([{
    ...baseEvent(eventType, tsMs),
    source: SUPERVISOR_FOCUS_EVENT_SOURCE,
  }])
}

// ─── Parity projection ────────────────────────────────────────────────────────

export interface RebuiltPollSession {
  bundleId: string | null
  appName: string | null
  startMs: number
  endMs: number
}

interface PollEventRow {
  ts_ms: number
  event_type: string
  app_bundle_id: string | null
  app_name: string | null
}

// Rebuild foreground sessions from canonical foreground_poll evidence alone —
// the measurement half of the parity requirement. Intervals are half-open: an
// activation closes any open interval and opens the next; a deactivation (or a
// machine-state boundary) closes without opening. By construction two
// applications can never own overlapping foreground time.
export function rebuildPollForegroundSessions(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): RebuiltPollSession[] {
  const rows = db.prepare(`
    SELECT ts_ms, event_type, app_bundle_id, app_name
    FROM focus_events
    WHERE source = ? AND ts_ms >= ? AND ts_ms < ?
    ORDER BY ts_ms ASC, mono_ns ASC, id ASC
  `).all(POLL_FOCUS_EVENT_SOURCE, fromMs, toMs) as PollEventRow[]

  const sessions: RebuiltPollSession[] = []
  let open: RebuiltPollSession | null = null

  const close = (endMs: number) => {
    if (!open) return
    if (endMs > open.startMs) {
      sessions.push({ ...open, endMs })
    }
    open = null
  }

  for (const row of rows) {
    switch (row.event_type) {
      case 'app_activated':
        close(row.ts_ms)
        open = {
          bundleId: row.app_bundle_id,
          appName: row.app_name,
          startMs: row.ts_ms,
          endMs: row.ts_ms,
        }
        break
      case 'app_deactivated':
      case 'sleep':
      case 'lock':
        close(row.ts_ms)
        break
      default:
        // window_changed updates visible context; it neither opens nor closes
        // foreground ownership.
        break
    }
  }

  // An interval still open at the window edge is not a completed duration.
  return sessions
}
