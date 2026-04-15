import { BrowserWindow } from 'electron'
import type { ProjectionInvalidationEvent, ProjectionScope } from '@shared/core'
import { IPC } from '@shared/types'

export function emitProjectionInvalidation(
  payload: Omit<ProjectionInvalidationEvent, 'at'>,
): ProjectionInvalidationEvent {
  const event: ProjectionInvalidationEvent = {
    ...payload,
    at: Date.now(),
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(IPC.PROJECTIONS.INVALIDATED, event)
  }

  return event
}

export function invalidateProjectionScope(
  scope: ProjectionScope,
  reason: string,
  options?: {
    date?: string | null
    canonicalAppId?: string | null
  },
): ProjectionInvalidationEvent {
  return emitProjectionInvalidation({
    scope,
    reason,
    date: options?.date ?? null,
    canonicalAppId: options?.canonicalAppId ?? null,
  })
}
