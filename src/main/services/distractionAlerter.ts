import { Notification, ipcMain } from 'electron'
import type { AppCategory } from '@shared/types'
import { getActiveFocusSession, recordDistractionEvent } from '../db/queries'
import { getDb } from './database'
import { getCurrentSession } from './tracking'
import { getSettings, setSettings } from './settings'

// ─── How distraction detection works in Daylens ───────────────────────────────
//
// The user should never have to declare anything for this to work. No focus
// sessions. No intent forms. The app observes passively and infers context.
//
// Model:
//   1. INFERRED WORK STATE — if the user has been in clearly work-type apps
//      (code editors, terminals, writing tools, design tools) for a sustained
//      period, they are considered to be in a work state. No button required.
//
//   2. LEISURE DURING WORK STATE — if the user is in an inferred work state and
//      then spends N consecutive minutes in clearly-leisure apps (entertainment,
//      social media), that is worth flagging. Not because entertainment is bad,
//      but because the pattern shift during a work state is meaningful signal.
//
//   3. EXPLICIT FOCUS SESSION (enhanced mode) — if the user has started a focus
//      session with planned apps, use off-plan detection instead (more precise).
//      This is a power feature, not a requirement.
//
// What we never do:
//   - Alert because a browser is open (browsers are tools, not distractions)
//   - Alert without first detecting a work state (leisure at any other time is fine)
//   - Require the user to tell us anything about their intent
//
// Over time the model gets smarter: learned peak hours, typical break patterns,
// and role context from onboarding should all inform what counts as a deviation.
// The current implementation is the rule-based foundation that gets layered on.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_MINUTES = 10

// Clearly work-type apps — strong signal that the user is in a work state.
// Browsers are intentionally excluded: Chrome open means nothing on its own.
const WORK_STATE_CATEGORIES: AppCategory[] = [
  'development',
  'design',
  'writing',
  'research',
  'productivity',
  'aiTools',
  'communication',
  'meetings',
  'email',
]

// Clearly leisure apps — the only categories we flag during a work state.
// Browsers are excluded: we don't know if a browser visit is research or Reddit.
const LEISURE_ALERT_CATEGORIES: AppCategory[] = ['entertainment', 'social']

// How long the user must be in work-type apps before we consider them in a
// work state. 20 minutes is a meaningful threshold — long enough to rule out
// quick checks, short enough to catch genuine work sessions.
const WORK_STATE_INFER_SECONDS = 20 * 60

interface ConsecutiveLeisureState {
  bundleId: string
  appName: string
  focusSessionId: number | null
  consecutiveSeconds: number
  hasAlertedForCurrentRun: boolean
}

let distractionTimer: ReturnType<typeof setInterval> | null = null
let workStateAccumulatorSeconds = 0
let lastWorkStateBundleId: string | null = null
let leisureState: ConsecutiveLeisureState | null = null
let thresholdMinutes = DEFAULT_THRESHOLD_MINUTES

function resetLeisureState(): void {
  leisureState = null
}

function isWorkStateCategory(category: AppCategory): boolean {
  return WORK_STATE_CATEGORIES.includes(category)
}

function isLeisureCategory(category: AppCategory): boolean {
  return LEISURE_ALERT_CATEGORIES.includes(category)
}

function isOffPlan(appName: string, bundleId: string, plannedApps: string[]): boolean {
  const nameLower = appName.toLowerCase()
  const idLower = bundleId.toLowerCase()
  return !plannedApps.some(
    (planned) =>
      nameLower.includes(planned.toLowerCase()) ||
      idLower.includes(planned.toLowerCase()),
  )
}

function fireAlert(appName: string, minutes: number, offPlan: boolean): void {
  if (!Notification.isSupported()) return
  const body = offPlan
    ? `${appName} isn't on your focus plan — you've been there ${minutes} minutes.`
    : `You've been on ${appName} for ${minutes} minutes.`
  new Notification({ title: 'Daylens', body }).show()
}

function checkDistraction(): void {
  const live = getCurrentSession()
  const db = getDb()

  if (!live) {
    workStateAccumulatorSeconds = 0
    lastWorkStateBundleId = null
    resetLeisureState()
    return
  }

  // ── Path A: explicit focus session with planned apps (enhanced precision) ──
  const activeFocusSession = getActiveFocusSession(db)
  if (activeFocusSession && activeFocusSession.plannedApps.length > 0) {
    // Reset passive tracking — the explicit session takes over
    workStateAccumulatorSeconds = 0

    if (!isOffPlan(live.appName, live.bundleId, activeFocusSession.plannedApps)) {
      resetLeisureState()
      return
    }

    const sessionChanged = leisureState?.focusSessionId !== activeFocusSession.id
    if (!leisureState || leisureState.bundleId !== live.bundleId || sessionChanged) {
      leisureState = {
        bundleId: live.bundleId,
        appName: live.appName,
        focusSessionId: activeFocusSession.id,
        consecutiveSeconds: 60,
        hasAlertedForCurrentRun: false,
      }
    } else {
      leisureState.consecutiveSeconds += 60
    }

    const threshold = Math.max(1, thresholdMinutes) * 60
    if (leisureState.hasAlertedForCurrentRun || leisureState.consecutiveSeconds < threshold) return

    fireAlert(leisureState.appName, thresholdMinutes, true)
    recordDistractionEvent(db, {
      sessionId: activeFocusSession.id,
      appName: leisureState.appName,
      bundleId: leisureState.bundleId,
    })
    leisureState.hasAlertedForCurrentRun = true
    return
  }

  // ── Path B: passive inference — no focus session required ──────────────────

  // Update the work state accumulator.
  if (isWorkStateCategory(live.category)) {
    if (lastWorkStateBundleId !== live.bundleId) {
      // Switched to a different work app — keep accumulating (work state persists)
      lastWorkStateBundleId = live.bundleId
    }
    workStateAccumulatorSeconds += 60
    // Returning to work resets any in-progress leisure tracking
    resetLeisureState()
    return
  }

  // User is in a non-work-state app.
  if (workStateAccumulatorSeconds < WORK_STATE_INFER_SECONDS) {
    // Haven't established a work state yet — no basis for a distraction signal
    resetLeisureState()
    return
  }

  // Work state is established. Only flag clearly-leisure apps.
  if (!isLeisureCategory(live.category)) {
    // Ambiguous app (e.g. browser) — don't alert, don't reset work state
    resetLeisureState()
    return
  }

  // Leisure during established work state — track consecutive time
  if (!leisureState || leisureState.bundleId !== live.bundleId) {
    leisureState = {
      bundleId: live.bundleId,
      appName: live.appName,
      focusSessionId: null,
      consecutiveSeconds: 60,
      hasAlertedForCurrentRun: false,
    }
  } else {
    leisureState.consecutiveSeconds += 60
  }

  const threshold = Math.max(1, thresholdMinutes) * 60
  if (leisureState.hasAlertedForCurrentRun || leisureState.consecutiveSeconds < threshold) return

  fireAlert(leisureState.appName, thresholdMinutes, false)
  recordDistractionEvent(db, {
    sessionId: activeFocusSession?.id ?? null,
    appName: leisureState.appName,
    bundleId: leisureState.bundleId,
  })
  leisureState.hasAlertedForCurrentRun = true
}

export async function setDistractionThreshold(minutes: number): Promise<void> {
  thresholdMinutes = Math.max(1, Math.round(minutes))
  await setSettings({ distractionAlertThresholdMinutes: thresholdMinutes })
  if (leisureState && leisureState.consecutiveSeconds < thresholdMinutes * 60) {
    leisureState.hasAlertedForCurrentRun = false
  }
}

export function registerDistractionAlerterHandlers(): void {
  ipcMain.handle('distraction-alerter:set-threshold', async (_e, payload: { minutes: number }) => {
    await setDistractionThreshold(payload.minutes)
  })
}

export function startDistractionAlerter(): void {
  if (distractionTimer) return

  thresholdMinutes = Math.max(1, getSettings().distractionAlertThresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES)
  workStateAccumulatorSeconds = 0
  lastWorkStateBundleId = null
  resetLeisureState()
  checkDistraction()
  distractionTimer = setInterval(() => {
    try {
      checkDistraction()
    } catch (err) {
      console.warn('[distraction] alerter check failed:', err)
    }
  }, 60_000)
}
