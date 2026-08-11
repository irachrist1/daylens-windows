// Main-thread stall watchdog (DEV-261). The July 21–22 incident: the main
// thread — the one that records the day, draws the screen, and services IPC —
// was blocked for stretches of minutes to hours while the app looked alive.
// Nothing noticed, so the freeze went undiagnosed and the frozen stretches
// rendered as invented activity or unexplained emptiness.
//
// A 1-second heartbeat cannot fire while the thread is blocked, so a late
// tick IS the stall, measured. The only other thing that stops the heartbeat
// is the machine itself sleeping — distinguished by CPU: a wedged thread
// burns CPU through the hole, a sleeping machine burns none. Confirmed stalls
// are written into the evidence stream as capture_failed → capture_recovered
// spanning the hole, which the gap projection already renders as "capture
// unavailable" — the stall becomes part of the day's honest record, never
// silent. Repeated or long stalls surface one native notification and a
// persistent in-app banner (via the capture-verification channel) that stays
// until stalls stop.
import type { RecorderStallBannerState } from '@shared/types'
import { recordSupervisorEvent } from './captureEvidence'
import { deliverNotification } from './notificationDelivery'
import { capture } from './analytics'
import { ANALYTICS_EVENT } from '@shared/analytics'
import { isRealDayHarness } from '../lib/realDayHarness'

const HEARTBEAT_INTERVAL_MS = 1_000
/** Holes shorter than this are ordinary hiccups (GC, a heavy query) — logged
 *  by nothing, recorded by nothing. */
const STALL_MIN_MS = 10_000
/** Product decision (DEV-261): freezing crosses from incident to pattern at
 *  three stalls in one session, or a single stall of a minute or more. That
 *  bar earns both the one-shot native notification and the persistent in-app
 *  banner, because past it the day probably has holes and the person should
 *  hear that from the app, not discover it on the timeline. */
export const REPEATED_STALL_COUNT = 3
export const SEVERE_STALL_MS = 60_000
/** Product decision: the banner clears after ten minutes without a stall —
 *  recording has demonstrably resumed and a warning that never leaves would
 *  train people to ignore it. A later stall brings it straight back, since
 *  the session's counters never reset while the app runs. */
export const STALL_BANNER_CLEAR_AFTER_QUIET_MS = 10 * 60_000
/** Below this share of the hole spent on CPU, the machine was asleep or
 *  suspended, not wedged — sleep is owned by the poll gap detector and the
 *  suspend/resume events, not by this watchdog. */
const STALL_CPU_RATIO = 0.25

export type HeartbeatHoleKind = 'stall' | 'machine-asleep' | null

/** Pure classification of one heartbeat hole. Exported for tests. */
export function classifyHeartbeatHole(holeMs: number, cpuBusyMs: number): HeartbeatHoleKind {
  if (holeMs < STALL_MIN_MS) return null
  return cpuBusyMs / holeMs >= STALL_CPU_RATIO ? 'stall' : 'machine-asleep'
}

interface WatchdogClock {
  now: () => number
  /** Cumulative process CPU time in ms. */
  cpuMs: () => number
}

function realClock(): WatchdogClock {
  return {
    now: () => Date.now(),
    cpuMs: () => {
      const usage = process.cpuUsage()
      return (usage.user + usage.system) / 1_000
    },
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let stallsThisSession = 0
let longestStallMs = 0
let lastStallEndMs: number | null = null
let notifiedThisSession = false

/** Everything the banner verdict needs, exposed for the pure derivation. */
export interface RecorderStallSnapshot {
  stallCount: number
  longestStallMs: number
  lastStallEndMs: number | null
}

/** Pure banner verdict over the watchdog's counters. Exported for tests. */
export function deriveRecorderStallBanner(
  snapshot: RecorderStallSnapshot,
  nowMs: number,
): RecorderStallBannerState | null {
  if (snapshot.lastStallEndMs === null) return null
  const crossed = snapshot.stallCount >= REPEATED_STALL_COUNT
    || snapshot.longestStallMs >= SEVERE_STALL_MS
  if (!crossed) return null
  if (nowMs - snapshot.lastStallEndMs >= STALL_BANNER_CLEAR_AFTER_QUIET_MS) return null
  return {
    stallCount: snapshot.stallCount,
    longestStallSeconds: Math.round(snapshot.longestStallMs / 1000),
  }
}

/** The live banner verdict for this session, read by the permission watcher
 *  and pushed to the renderer on the capture-verification channel. */
export function getRecorderStallBannerState(nowMs: number = Date.now()): RecorderStallBannerState | null {
  return deriveRecorderStallBanner({ stallCount: stallsThisSession, longestStallMs, lastStallEndMs }, nowMs)
}

export interface StallObservation {
  startMs: number
  endMs: number
  durationMs: number
  kind: 'stall' | 'machine-asleep'
}

/** Test seam: observe classified holes without wiring the real evidence path. */
let observerForTests: ((observation: StallObservation) => void) | null = null
export function setStallObserverForTests(observer: ((o: StallObservation) => void) | null): void {
  observerForTests = observer
}

function handleHole(observation: StallObservation): void {
  observerForTests?.(observation)
  if (observation.kind !== 'stall') {
    // Machine sleep: poll-gap detection and suspend/resume own the record.
    console.log(`[stall-watchdog] heartbeat hole of ${Math.round(observation.durationMs / 1000)}s with idle CPU — machine sleep, not a stall`)
    return
  }

  stallsThisSession += 1
  longestStallMs = Math.max(longestStallMs, observation.durationMs)
  lastStallEndMs = observation.endMs
  console.warn(`[stall-watchdog] main thread was blocked for ${Math.round(observation.durationMs / 1000)}s (stall #${stallsThisSession} this session) — recording the hole as capture unavailable`)
  try {
    recordSupervisorEvent('capture_failed', observation.startMs)
    recordSupervisorEvent('capture_recovered', observation.endMs)
  } catch (err) {
    console.warn('[stall-watchdog] failed to record stall in evidence stream:', err)
  }
  capture(ANALYTICS_EVENT.MAIN_THREAD_STALLED, {
    duration_ms: Math.round(observation.durationMs),
    stalls_this_session: stallsThisSession,
    surface: 'stall-watchdog',
  })

  const worthNotifying = observation.durationMs >= SEVERE_STALL_MS
    || stallsThisSession >= REPEATED_STALL_COUNT
  if (worthNotifying && !notifiedThisSession) {
    notifiedThisSession = true
    try {
      deliverNotification({
        title: 'Daylens froze and has recovered',
        body: `The app was unresponsive for ${Math.round(observation.durationMs / 1000)}s. The frozen stretch is marked "capture unavailable" on your timeline — nothing was invented for it.`,
        surface: 'stall-watchdog',
      })
    } catch (err) {
      console.warn('[stall-watchdog] failed to deliver stall notification:', err)
    }
  }
}

export function startStallWatchdog(clock: WatchdogClock = realClock()): void {
  if (heartbeatTimer) return
  if (isRealDayHarness()) return
  let lastTick = clock.now()
  let lastCpuMs = clock.cpuMs()
  heartbeatTimer = setInterval(() => {
    const now = clock.now()
    const cpuMs = clock.cpuMs()
    const holeMs = now - lastTick - HEARTBEAT_INTERVAL_MS
    const kind = classifyHeartbeatHole(holeMs, cpuMs - lastCpuMs)
    if (kind) {
      handleHole({ startMs: lastTick, endMs: now, durationMs: holeMs, kind })
    }
    lastTick = now
    lastCpuMs = cpuMs
  }, HEARTBEAT_INTERVAL_MS)
}

export function stopStallWatchdog(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  stallsThisSession = 0
  longestStallMs = 0
  lastStallEndMs = null
  notifiedThisSession = false
}
