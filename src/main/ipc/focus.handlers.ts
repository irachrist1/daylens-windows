import { ipcMain } from 'electron'
import { FOCUSED_CATEGORIES, IPC } from '@shared/types'
import type { FocusStartPayload } from '@shared/types'
import {
  getActiveFocusSession,
  getDistractionCountForSession,
  getFocusSessionsForDateRange,
  getRecentFocusSessions,
  saveFocusReflection,
  getSessionsForRange,
  startFocusSession,
  stopFocusSession,
} from '../db/queries'
import { getDb } from '../services/database'
import { invalidateProjectionScope } from '../core/projections/invalidation'

export function registerFocusHandlers(): void {
  ipcMain.handle(IPC.FOCUS.START, (_e, payload?: FocusStartPayload | string | null) => {
    const normalized: FocusStartPayload =
      typeof payload === 'string' || payload === null || payload === undefined
        ? { label: payload ?? null }
        : payload
    const sessionId = startFocusSession(getDb(), normalized)
    invalidateProjectionScope('timeline', 'focus_session_started')
    invalidateProjectionScope('insights', 'focus_session_started')
    return sessionId
  })

  ipcMain.handle(IPC.FOCUS.STOP, (_e, id: number) => {
    stopFocusSession(getDb(), id)
    invalidateProjectionScope('timeline', 'focus_session_stopped')
    invalidateProjectionScope('insights', 'focus_session_stopped')
  })

  ipcMain.handle(IPC.FOCUS.GET_ACTIVE, () => {
    return getActiveFocusSession(getDb())
  })

  ipcMain.handle(IPC.FOCUS.GET_RECENT, (_e, limit: number = 20) => {
    return getRecentFocusSessions(getDb(), limit)
  })

  ipcMain.handle(IPC.FOCUS.GET_BY_DATE_RANGE, (_e, payload: { fromMs: number; toMs: number }) => {
    return getFocusSessionsForDateRange(getDb(), payload.fromMs, payload.toMs)
  })

  ipcMain.handle(IPC.FOCUS.SAVE_REFLECTION, (_e, payload: { sessionId: number; note: string }) => {
    saveFocusReflection(getDb(), payload.sessionId, payload.note)
    invalidateProjectionScope('insights', 'focus_reflection_saved')
  })

  ipcMain.handle(IPC.FOCUS.GET_DISTRACTION_COUNT, (_e, payload: { sessionId: number }) => {
    return getDistractionCountForSession(getDb(), payload.sessionId)
  })

  ipcMain.handle(IPC.FOCUS.GET_BREAK_RECOMMENDATION, () => {
    const db = getDb()
    const now = Date.now()
    const ninetyMinsAgo = now - 90 * 60 * 1000
    const recentSessions = getSessionsForRange(db, ninetyMinsAgo, now)
    const focusedSeconds = recentSessions
      .filter((session) => FOCUSED_CATEGORIES.includes(session.category))
      .reduce((sum, session) => sum + session.durationSeconds, 0)

    if (focusedSeconds < 45 * 60) return null

    const focusedMinutes = Math.round(focusedSeconds / 60)
    const currentApp = recentSessions[recentSessions.length - 1]?.appName ?? null

    return {
      triggerReason: 'sustained_focus' as const,
      focusedMinutes,
      currentApp,
      message: `You've been focused for ${focusedMinutes} minutes${currentApp ? ` in ${currentApp}` : ''}. A short break will help.`,
      urgency: (focusedMinutes >= 90 ? 'high' : 'medium') as 'high' | 'medium',
    }
  })
}
