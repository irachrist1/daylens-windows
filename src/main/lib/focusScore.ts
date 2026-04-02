import { FOCUSED_CATEGORIES } from '@shared/types'
import type { AppCategory, PeakHoursResult } from '@shared/types'

export interface FocusScoreSession {
  durationSeconds: number
  isFocused: boolean
}

function isHourInPeakWindow(
  hour: number,
  peakWindow: Pick<PeakHoursResult, 'peakStart' | 'peakEnd'>,
): boolean {
  if (peakWindow.peakStart === peakWindow.peakEnd) return true
  if (peakWindow.peakStart < peakWindow.peakEnd) {
    return hour >= peakWindow.peakStart && hour < peakWindow.peakEnd
  }
  return hour >= peakWindow.peakStart || hour < peakWindow.peakEnd
}

export function computeEnhancedFocusScore(params: {
  focusedSeconds: number
  totalSeconds: number
  switchesPerHour: number
  sessions: FocusScoreSession[]
  peakHours?: Pick<PeakHoursResult, 'peakStart' | 'peakEnd'>
  currentHour?: number
  websiteFocusCreditSeconds?: number
}): number {
  const effectiveFocusedSeconds = params.focusedSeconds + (params.websiteFocusCreditSeconds ?? 0)
  if (params.totalSeconds < 60) return 0

  const focusRatio = effectiveFocusedSeconds / params.totalSeconds

  const focusedSessions = params.sessions.filter((session) => session.isFocused)
  const avgSessionMin = focusedSessions.length > 0
    ? focusedSessions.reduce((sum, session) => sum + session.durationSeconds, 0) / focusedSessions.length / 60
    : 0
  const consistencyBonus = Math.min(avgSessionMin / 30, 1) * 10

  const hasFlowState = focusedSessions.some((session) => session.durationSeconds >= 75 * 60)
  const flowBonus = hasFlowState ? 5 : 0
  const peakBonus = params.peakHours !== undefined && params.currentHour !== undefined &&
    isHourInPeakWindow(params.currentHour, params.peakHours)
    ? 5
    : 0

  // Raw switch frequency is descriptive telemetry, not direct evidence that focus was broken.
  const raw = (focusRatio * 100) + consistencyBonus + flowBonus + peakBonus
  return Math.min(Math.round(raw), 100)
}

export function computeFocusScore(params: {
  focusedSeconds: number
  totalSeconds: number
  switchesPerHour: number
  sessions?: FocusScoreSession[]
  peakHours?: Pick<PeakHoursResult, 'peakStart' | 'peakEnd'>
  currentHour?: number
  websiteFocusCreditSeconds?: number
}): number {
  return computeEnhancedFocusScore({
    ...params,
    sessions: params.sessions ?? [],
  })
}

export function isCategoryFocused(category: AppCategory | string): boolean {
  return FOCUSED_CATEGORIES.includes(category as AppCategory)
}
