import { ipcMain } from 'electron'
import { ANALYTICS_EVENT } from '@shared/analytics'
import { IPC, type RendererCrashReport } from '@shared/types'
import { capture, captureException } from '../services/analytics'
import { isRealDayHarness } from '../lib/realDayHarness'

const MAX_IDENTITY_LENGTH = 512
const MAX_COMPONENT_STACK_LENGTH = 8_192
const RENDERER_BOUNDARIES = new Set(['Timeline', 'Apps', 'AI', 'Settings'])

function clampedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return value.slice(0, maxLength)
}

// The payload crosses the IPC boundary, so it is untrusted input: coerce every
// field to a bounded string and drop anything else on the floor. Only error
// identity and React component names survive — no room for activity data.
export function sanitizeRendererCrashReport(payload: unknown): RendererCrashReport | null {
  if (typeof payload !== 'object' || payload === null) return null
  const candidate = payload as Record<string, unknown>
  if (typeof candidate.message !== 'string') return null
  const boundary = clampedString(candidate.boundary, MAX_IDENTITY_LENGTH)
  return {
    name: clampedString(candidate.name, MAX_IDENTITY_LENGTH) ?? 'Error',
    message: clampedString(candidate.message, MAX_IDENTITY_LENGTH) ?? 'Unknown renderer error',
    stack: null,
    componentStack: clampedString(candidate.componentStack, MAX_COMPONENT_STACK_LENGTH),
    boundary: boundary && RENDERER_BOUNDARIES.has(boundary) ? boundary : 'unknown',
  }
}

export function registerErrorHandlers(): void {
  ipcMain.on(IPC.ERRORS.RENDERER_CRASH, (_e, payload: unknown) => {
    if (isRealDayHarness()) return
    const report = sanitizeRendererCrashReport(payload)
    if (!report) {
      console.warn('[errors] ignored malformed renderer crash report')
      return
    }

    console.error(`[renderer] render crash in ${report.boundary}: ${report.name}: ${report.message}`)
    capture(ANALYTICS_EVENT.APP_CRASHED, {
      process_type: 'renderer',
      reason: 'render_error',
      status: 'error',
      surface: report.boundary,
    })

    const error = new Error(report.message)
    error.name = report.name
    captureException(error, {
      extra: {
        boundary: report.boundary,
        component_stack: report.componentStack ?? undefined,
      },
      tags: {
        boundary: report.boundary,
        process_type: 'renderer',
        reason: 'render_error',
      },
    })
  })
}
