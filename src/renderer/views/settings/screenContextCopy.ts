// Plain-words status and diagnostic copy for the screen-context experiment
// surface (DEV-251). Pure functions so the honesty rules are testable: the
// page may only claim to be on when it can show evidence, and a diagnostic
// click always yields a visible, human-readable outcome.
import type { ScreenContextStatus } from '@shared/types'

// Every ScreenCaptureBlockReason from the sampler/scheduler plus the two
// sampler-tick reasons ('no_foreground', 'source_unavailable'), in words a
// person can act on.
const BLOCK_REASONS: Record<string, string> = {
  no_foreground: 'No app is in the foreground to capture right now.',
  source_unavailable: 'The screen returned no image. Check that Daylens has Screen Recording permission in System Settings.',
  consent_missing: 'You have not joined the experiment, so nothing can be captured.',
  screen_context_paused: 'Sampling is paused. Resume it first.',
  tracking_paused: 'Tracking is paused, which also pauses sampling.',
  excluded_app: 'The app in front is excluded from tracking, so it is refused before capture.',
  excluded_site: 'The site in front is excluded from tracking, so it is refused before capture.',
  private_browser: 'A browser is in front and its private-window state cannot be verified, so it is never captured.',
  protected_surface: 'A password, payment, or security screen is in front, so it is refused before capture.',
  screen_share: 'Your screen is being shared, so nothing is captured.',
  protected_media: 'Protected media is playing, so nothing is captured.',
  backlog_cap: 'The frame backlog is full. Delete frames to make room.',
  rate_min_interval: 'A frame was captured very recently. Try again in a few seconds.',
  rate_hourly_cap: 'The hourly capture cap was reached.',
  context_not_stable: 'The screen just changed. Try again in a few seconds.',
  bounded_interval: 'The next automatic frame is not due yet.',
  power_backoff: 'Sampling is backing off to save power right now.',
}

export function describeCaptureBlockReason(reason: string | null | undefined): string {
  if (!reason) return 'No frame was captured, and no reason was reported.'
  return BLOCK_REASONS[reason] ?? `No frame was captured (${reason.replace(/_/g, ' ')}).`
}

/** The one-line state claim. 'sampling on' is only claimed while the sampler
 *  loop itself reports active; anything else is stated as not capturing. */
export function screenContextHeadline(
  status: Pick<ScreenContextStatus, 'paused' | 'samplerActive'>,
): string {
  if (status.paused) return 'Joined, paused'
  return status.samplerActive ? 'Joined, sampling on' : 'Joined, not capturing'
}

/** The evidence backing the claim: what has actually been captured and when.
 *  Never invents activity; with no captures it says so plainly. */
export function captureEvidenceLine(
  status: Pick<ScreenContextStatus, 'backlog' | 'evidenceCount' | 'lastCapturedAt'>,
  formatTime: (ms: number) => string = (ms) => new Date(ms).toLocaleString(),
): string {
  if (status.lastCapturedAt == null) return 'No samples captured yet.'
  const frames = status.backlog.frames
  const parts = [`Last capture ${formatTime(status.lastCapturedAt)}`]
  parts.push(`${frames} frame${frames === 1 ? '' : 's'} stored`)
  if (status.evidenceCount > 0) {
    parts.push(`${status.evidenceCount} extracted record${status.evidenceCount === 1 ? '' : 's'}`)
  }
  return `${parts.join(' · ')}.`
}
