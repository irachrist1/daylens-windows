// Tier-3 context escalation: the agent may look at the user's live screen —
// one still, on demand, never stored.
//
// The contract, in order:
//   1. Consent gate OUTSIDE the model: the screen-context experiment toggle in
//      Settings (plus the OS Screen Recording permission). Off → an honest
//      refusal the model can relay, never a prompt.
//   2. A mandatory `reason` — it shows verbatim in the activity trail, so the
//      user always sees why the agent looked.
//   3. Pixels reach the model as an image content part and nothing else: the
//      tool's JSON result (what the trace persists) carries only metadata,
//      and the frame is dropped from memory once handed to the model.
import { tool } from 'ai'
import { z } from 'zod'
import { getSettings } from '../services/settings'

const REFUSAL = {
  captured: false as const,
  reason: 'Screen access is off. The user can turn it on in Settings → Screen context. Answer from the activity database and file tools instead.',
}

// Frames in flight between execute() and toModelOutput(), keyed by capture id.
// Popped exactly once — nothing retains the pixels after the model has them.
const pendingFrames = new Map<string, string>()
let captureCounter = 0

export function buildScreenTools() {
  return {
    capture_screen: tool({
      description: 'Look at the user\'s live screen: one downscaled still of the active display, never stored. EXPENSIVE and privacy-sensitive, use only after the activity database and file tools cannot answer, and only for questions about what is on screen RIGHT NOW. The reason you give is shown to the user.',
      inputSchema: z.object({
        reason: z.string().min(12).describe('Why the database and file tools cannot answer this — shown verbatim to the user.'),
      }),
      execute: async () => {
        const settings = getSettings()
        if (!settings.screenContextExperimentEnabled || settings.screenContextPaused) {
          return REFUSAL
        }
        let frame: Uint8Array | null = null
        try {
          const { createElectronScreenFrameSource, screenRecordingPermissionGranted } =
            await import('../services/screenContext/electronFrameSource')
          if (!screenRecordingPermissionGranted()) {
            return {
              captured: false as const,
              reason: 'macOS Screen Recording permission is not granted for Daylens, so the screen cannot be read.',
            }
          }
          frame = await createElectronScreenFrameSource().capture(null)
        } catch {
          // Headless / test runtime without Electron's desktopCapturer.
          return { captured: false as const, reason: 'Screen capture is unavailable in this runtime.' }
        }
        if (!frame) {
          return { captured: false as const, reason: 'The display could not be captured (protected content or no active display).' }
        }
        const captureId = `frame-${++captureCounter}`
        pendingFrames.set(captureId, Buffer.from(frame).toString('base64'))
        return {
          captured: true as const,
          captureId,
          note: 'One still of the active display was captured and attached for this turn only; it is not stored.',
        }
      },
      toModelOutput: ({ output }) => {
        if (!output.captured) return { type: 'json', value: output }
        const data = pendingFrames.get(output.captureId)
        pendingFrames.delete(output.captureId)
        if (!data) return { type: 'json', value: { captured: false, reason: 'The frame expired before it reached the model.' } }
        return {
          type: 'content',
          value: [
            { type: 'media', data, mediaType: 'image/png' },
            { type: 'text', text: 'The current screen, captured just now. Describe only what is visible; the image is not stored.' },
          ],
        }
      },
    }),
  }
}
