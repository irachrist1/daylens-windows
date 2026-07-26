// Capture permission watcher (DEV-229 part 2). macOS ties the Accessibility
// grant to the exact app binary, so a rebuild, an update, or the user
// revoking it makes capture go blind — window titles all NULL — while
// `isTrustedAccessibilityClient` may still say "granted". Nothing used to
// watch for this unless the Settings capture-health page happened to be open.
//
// This watcher runs in the main process from launch: every few seconds it
// verifies the grant BOTH ways — the OS flag, and whether recently persisted
// samples actually carry window titles (a real-read proxy, the same signal
// the capture-health page shows). On any change it pushes the new state to
// the renderer, and the moment capture goes blind it fires one native
// notification that lands the user on the capture-health walkthrough.
import { systemPreferences } from 'electron'
import type { BrowserWindow } from 'electron'
import type { CaptureVerificationState } from '@shared/types'
import { IPC } from '@shared/types'
import { getDb } from './database'
import { getNativeCaptureTitleStats } from '../db/focusEventRepository'
import { deliverNotification } from './notificationDelivery'
import { isRealDayHarness } from '../lib/realDayHarness'
import { getSettings } from './settings'
import { shouldStartTrackingForSettings } from '../lib/onboardingState'
import { getRecorderStallBannerState } from './stallWatchdog'

const CHECK_INTERVAL_MS = 5_000
const SAMPLE_WINDOW_MS = 15 * 60_000
// Below this many recent samples the titled ratio is noise, not evidence —
// the machine may simply have been idle. Judge only the flag until then.
const MIN_SAMPLES_FOR_VERDICT = 5
// "Most samples carry window titles" is the bar capture health is graded on;
// under half titled means something is wrong even if not fully blind.
const HEALTHY_TITLE_RATIO = 0.5

// Declaring "blind" while the OS flag says granted is a strong claim (it
// drives a notification and an app-wide banner), so it needs more evidence
// than the ordinary verdict: a short stretch in apps whose windows genuinely
// have no titles (some games/utilities) must not read as a dead grant.
const MIN_SAMPLES_FOR_BLIND_VERDICT = 10

export function deriveCaptureVerificationStatus(input: {
  axTrusted: boolean
  recentSamples: number
  recentSamplesWithTitle: number
}): CaptureVerificationState['status'] {
  if (!input.axTrusted) return 'blind'
  if (input.recentSamples < MIN_SAMPLES_FOR_VERDICT) return 'waiting'
  if (input.recentSamplesWithTitle === 0) {
    return input.recentSamples >= MIN_SAMPLES_FOR_BLIND_VERDICT ? 'blind' : 'waiting'
  }
  if (input.recentSamplesWithTitle / input.recentSamples < HEALTHY_TITLE_RATIO) return 'degraded'
  return 'healthy'
}

let watcherTimer: ReturnType<typeof setInterval> | null = null
let watcherWindow: BrowserWindow | null = null
let lastState: CaptureVerificationState | null = null
// One notification per blind episode: set when we notify, cleared only when
// the status fully recovers to healthy, so a broken grant can't spam.
let notifiedThisEpisode = false

export function setPermissionWatcherWindow(win: BrowserWindow | null): void {
  watcherWindow = win
}

export function getCaptureVerificationState(): CaptureVerificationState | null {
  return lastState
}

function openCaptureHealthSettings(): void {
  if (!watcherWindow || watcherWindow.isDestroyed()) return
  if (watcherWindow.isMinimized()) watcherWindow.restore()
  watcherWindow.show()
  watcherWindow.focus()
  watcherWindow.webContents.send('navigate', '/settings?section=capture')
}

function checkOnce(): void {
  // Capture intentionally off (consent declined, tracking paused) means a
  // missing grant is not a problem to alarm about — stand down entirely.
  if (!shouldStartTrackingForSettings(getSettings())) {
    lastState = null
    notifiedThisEpisode = false
    return
  }

  let axTrusted = true
  try {
    axTrusted = systemPreferences.isTrustedAccessibilityClient(false)
  } catch (err) {
    console.warn('[permission-watcher] failed to read accessibility flag:', err)
  }

  let recentSamples = 0
  let recentSamplesWithTitle = 0
  try {
    const stats = getNativeCaptureTitleStats(getDb(), Date.now() - SAMPLE_WINDOW_MS)
    recentSamples = stats.recentSamples
    recentSamplesWithTitle = stats.withTitle
  } catch (err) {
    console.warn('[permission-watcher] failed to read title stats:', err)
    return
  }

  const status = deriveCaptureVerificationStatus({ axTrusted, recentSamples, recentSamplesWithTitle })
  // DEV-261: the stall watchdog's banner verdict rides this channel so the
  // renderer has one source for "capture is compromised" banners. Read every
  // tick — the banner appears within one check of the threshold being crossed
  // and clears within one check of the quiet period ending.
  const recorderStall = getRecorderStallBannerState()
  const next: CaptureVerificationState = {
    status,
    axTrusted,
    recentSamples,
    recentSamplesWithTitle,
    recorderStall,
    checkedAt: Date.now(),
  }

  const changed = !lastState
    || lastState.status !== status
    || lastState.axTrusted !== axTrusted
    || (lastState.recorderStall?.stallCount ?? null) !== (recorderStall?.stallCount ?? null)
  lastState = next
  if (!changed) return

  console.log(`[permission-watcher] capture verification → ${status} (axTrusted=${axTrusted}, titled ${recentSamplesWithTitle}/${recentSamples})`)
  if (watcherWindow && !watcherWindow.isDestroyed()) {
    watcherWindow.webContents.send(IPC.TRACKING.CAPTURE_VERIFICATION_CHANGED, next)
  }

  if (status === 'blind' && !notifiedThisEpisode) {
    notifiedThisEpisode = true
    deliverNotification({
      title: 'Daylens lost access to window titles',
      body: axTrusted
        ? 'The Accessibility grant stopped working (this happens after updates). Tap to re-grant it — capture is blind until then.'
        : 'Accessibility permission was turned off. Tap to re-grant it — capture is blind until then.',
      actionText: 'Fix now',
      onClick: openCaptureHealthSettings,
      surface: 'capture-verification',
    })
  } else if (status === 'healthy') {
    notifiedThisEpisode = false
  }
}

export function startPermissionWatcher(): void {
  if (process.platform !== 'darwin') return
  if (isRealDayHarness()) return
  if (watcherTimer) return
  // First verdict right away — launch is exactly when a rebuilt binary's
  // dead grant must surface — then steadily, so revoking Accessibility
  // while the app runs is noticed within seconds.
  checkOnce()
  watcherTimer = setInterval(checkOnce, CHECK_INTERVAL_MS)
}

export function stopPermissionWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer)
    watcherTimer = null
  }
}
