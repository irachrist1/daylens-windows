import { BrowserWindow } from 'electron'
import type { AIDailyReportPreparationResult } from '@shared/types'

type NavigationWindow = Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'isVisible' | 'restore' | 'show' | 'focus' | 'webContents'>

let navigationWindow: BrowserWindow | null = null

export function setDailySummaryNavigationWindow(window: BrowserWindow | null): void {
  navigationWindow = window
}

function currentNavigationWindow(): BrowserWindow | null {
  if (navigationWindow && !navigationWindow.isDestroyed()) return navigationWindow
  const current = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
  navigationWindow = current
  return current
}

export function openDailySummaryRoute(
  route: string,
  getWindow: () => NavigationWindow | null = currentNavigationWindow,
): boolean {
  const window = getWindow()
  if (!window || window.isDestroyed()) return false

  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()

  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', () => {
      if (window.isDestroyed()) return
      window.webContents.send('navigate', route)
    })
  } else {
    window.webContents.send('navigate', route)
  }

  return true
}

export function buildDailyReportRoute(report: Pick<AIDailyReportPreparationResult, 'date' | 'threadId' | 'artifactId'>): string {
  const params = new URLSearchParams()
  if (report.threadId != null) params.set('threadId', String(report.threadId))
  if (report.artifactId != null) params.set('artifactId', String(report.artifactId))
  params.set('date', report.date)
  params.set('source', 'daily-summary')
  const query = params.toString()
  return query ? `/ai?${query}` : '/ai'
}
