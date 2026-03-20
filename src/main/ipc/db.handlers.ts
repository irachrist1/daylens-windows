import { ipcMain } from 'electron'
import {
  getAppSummariesForRange,
  getSessionsForRange,
  setCategoryOverride,
} from '../db/queries'
import { getDb } from '../services/database'
import { IPC } from '@shared/types'

// Helpers for day bounds
function dayBounds(dateStr: string): [number, number] {
  const d = new Date(dateStr)
  d.setHours(0, 0, 0, 0)
  const from = d.getTime()
  const to = from + 86_400_000
  return [from, to]
}

export function registerDbHandlers(): void {
  ipcMain.handle(IPC.DB.GET_TODAY, () => {
    const today = new Date().toISOString().split('T')[0]
    const [from, to] = dayBounds(today)
    return getAppSummariesForRange(getDb(), from, to)
  })

  ipcMain.handle(IPC.DB.GET_HISTORY, (_e, dateStr: string) => {
    const [from, to] = dayBounds(dateStr)
    return getSessionsForRange(getDb(), from, to)
  })

  ipcMain.handle(IPC.DB.GET_APP_SUMMARIES, (_e, days = 7) => {
    const to = Date.now()
    const from = to - days * 86_400_000
    return getAppSummariesForRange(getDb(), from, to)
  })

  ipcMain.handle('db:set-category-override', (_e, bundleId: string, category: string) => {
    setCategoryOverride(getDb(), bundleId, category as import('@shared/types').AppCategory)
  })
}
