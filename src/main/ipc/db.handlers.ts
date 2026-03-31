import { ipcMain, app } from 'electron'
import {
  getAppCharacter,
  getAppSummariesForRange,
  getWeeklySummary,
  getPeakHours,
  getSessionsForRange,
  getSessionsForApp,
  getWebsiteSummariesForRange,
  setCategoryOverride,
  clearCategoryOverride,
  getCategoryOverrides,
} from '../db/queries'
import { getDb } from '../services/database'
import { getCurrentSession } from '../services/tracking'
import { getLatestSnapshot } from '../services/processMonitor'
import { getHistoryDayPayload } from '../services/workBlocks'
import { IPC } from '@shared/types'
import type { AppSession } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

// ─── Date helpers ─────────────────────────────────────────────────────────────

// Returns today's date as a local YYYY-MM-DD string.
// DO NOT use new Date().toISOString().split('T')[0] — that returns the UTC date,
// which is wrong in UTC- timezones (e.g. EST) after ~7pm.
function localDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Returns [fromMs, toMs] spanning the full local calendar day for a YYYY-MM-DD string.
// Constructs from year/month/day components so the result is always local midnight,
// regardless of how Date() parses ISO strings (which vary by platform/timezone).
function dayBounds(dateStr: string): [number, number] {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(y, m - 1, d).getTime()  // local midnight
  return [from, from + 86_400_000]
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function registerDbHandlers(): void {
  // Today's app summaries — uses local calendar day, not UTC day
  ipcMain.handle(IPC.DB.GET_TODAY, () => {
    const [from, to] = dayBounds(localDateString())
    return getAppSummariesForRange(getDb(), from, to)
  })

  // Raw sessions for a given date — used by History and Today timeline
  ipcMain.handle(IPC.DB.GET_HISTORY, (_e, dateStr: string) => {
    const [from, to] = dayBounds(dateStr)
    return mergeLiveSessionForDate(getSessionsForRange(getDb(), from, to), dateStr)
  })

  ipcMain.handle(IPC.DB.GET_HISTORY_DAY, (_e, dateStr: string) => {
    return getHistoryDayPayload(getDb(), dateStr, getLiveSessionForDate(dateStr))
  })

  // App usage summaries for a range — used by Apps view
  // days=1 → today since local midnight (not rolling 24h)
  // days=7/30 → rolling window ending at end of today
  ipcMain.handle(IPC.DB.GET_APP_SUMMARIES, (_e, days: number = 7) => {
    const [todayFrom, todayTo] = dayBounds(localDateString())
    if (days <= 1) {
      return getAppSummariesForRange(getDb(), todayFrom, todayTo)
    }
    // N days: from (N-1) days before today's midnight to end of today
    const from = todayFrom - (days - 1) * 86_400_000
    return getAppSummariesForRange(getDb(), from, todayTo)
  })

  ipcMain.handle('db:set-category-override', (_e, bundleId: string, category: string) => {
    setCategoryOverride(getDb(), bundleId, category as import('@shared/types').AppCategory)
  })

  ipcMain.handle('db:clear-category-override', (_e, bundleId: string) => {
    clearCategoryOverride(getDb(), bundleId)
  })

  ipcMain.handle('db:get-category-overrides', () => {
    return getCategoryOverrides(getDb())
  })

  // Per-app session drill-down — used by Apps detail panel
  ipcMain.handle(IPC.DB.GET_APP_SESSIONS, (_e, bundleId: string, days: number = 7) => {
    const [todayFrom, todayTo] = dayBounds(localDateString())
    if (days <= 1) return getSessionsForApp(getDb(), bundleId, todayFrom, todayTo)
    const from = todayFrom - (days - 1) * 86_400_000
    return getSessionsForApp(getDb(), bundleId, from, todayTo)
  })

  // Website summaries — used by Today's Top Websites card
  ipcMain.handle(IPC.DB.GET_WEBSITE_SUMMARIES, (_e, days: number = 1) => {
    const [todayFrom, todayTo] = dayBounds(localDateString())
    if (days <= 1) return getWebsiteSummariesForRange(getDb(), todayFrom, todayTo)
    const from = todayFrom - (days - 1) * 86_400_000
    return getWebsiteSummariesForRange(getDb(), from, todayTo)
  })

  ipcMain.handle(IPC.DB.GET_PEAK_HOURS, () => {
    const now = Date.now()
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000
    return getPeakHours(getDb(), fourteenDaysAgo, now)
  })

  ipcMain.handle(IPC.DB.GET_WEEKLY_SUMMARY, (_e, endDateStr: string) => {
    return getWeeklySummary(getDb(), endDateStr)
  })

  ipcMain.handle(IPC.DB.GET_APP_CHARACTER, (_e, bundleId: string, daysBack: number) => {
    return getAppCharacter(getDb(), bundleId, daysBack)
  })

  // Returns the current in-flight session (not yet flushed to DB) so the renderer
  // can display live totals without waiting for the next app switch.
  ipcMain.handle(IPC.TRACKING.GET_LIVE, () => getCurrentSession())

  ipcMain.handle(IPC.TRACKING.GET_PROCESS_METRICS, () => {
    return getLatestSnapshot()
  })

  // Returns a base64 PNG data URL for a given bundleId/exe path, or null if unavailable.
  // On Windows the bundleId is the full exe path — passed directly to getFileIcon.
  // On macOS the bundleId is a bundle identifier (e.g. 'com.anthropic.claude') — resolved
  // to the .app path via mdfind before calling getFileIcon.
  ipcMain.handle('app:get-icon', async (_e, bundleId: string): Promise<string | null> => {
    try {
      let filePath = bundleId

      if (process.platform === 'darwin' && !bundleId.startsWith('/')) {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execAsync = promisify(execFile)
        try {
          const { stdout } = await execAsync('mdfind', [
            `kMDItemCFBundleIdentifier == '${bundleId}'`,
          ])
          const resolved = stdout.trim().split('\n').find((p) => p.endsWith('.app'))
          if (!resolved) return null
          filePath = resolved
        } catch {
          return null
        }
      }

      const icon = await app.getFileIcon(filePath, { size: 'normal' })
      return icon.toDataURL()
    } catch {
      return null
    }
  })
}

function getLiveSessionForDate(dateStr: string) {
  const live = getCurrentSession()
  if (!live) return null

  const [from, to] = dayBounds(dateStr)
  const liveEnd = Date.now()
  if (liveEnd <= from || live.startTime >= to) return null
  return live
}

function mergeLiveSessionForDate(sessions: AppSession[], dateStr: string): AppSession[] {
  const live = getLiveSessionForDate(dateStr)
  if (!live) return sessions

  const endTime = Date.now()
  return [
    ...sessions,
    {
      id: -1,
      bundleId: live.bundleId,
      appName: live.appName,
      startTime: live.startTime,
      endTime,
      durationSeconds: Math.max(1, Math.round((endTime - live.startTime) / 1000)),
      category: live.category,
      isFocused: FOCUSED_CATEGORIES.includes(live.category),
    },
  ].sort((left, right) => left.startTime - right.startTime)
}
