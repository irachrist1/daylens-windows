import { ipcMain } from 'electron'
import {
  getAppSummariesForRange,
  getSessionsForRange,
  getSessionsForApp,
  getWebsiteSummariesForRange,
  setCategoryOverride,
} from '../db/queries'
import { getDb } from '../services/database'
import { getCurrentSession } from '../services/tracking'
import { IPC } from '@shared/types'

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
    return getSessionsForRange(getDb(), from, to)
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

  // Returns the current in-flight session (not yet flushed to DB) so the renderer
  // can display live totals without waiting for the next app switch.
  ipcMain.handle(IPC.TRACKING.GET_LIVE, () => getCurrentSession())
}
