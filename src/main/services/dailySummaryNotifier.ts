import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Notification, app } from 'electron'
import { getSessionsForRange } from '../db/queries'
import { localDateString, localDayBounds } from '../lib/localDate'
import { getDb } from './database'
import { getSettings } from './settings'
import { prepareDailyReport } from './ai'

interface DailyNotifierState {
  lastDailySummaryDate?: string
  lastMorningNudgeDate?: string
}

let notifierTimer: ReturnType<typeof setInterval> | null = null
let navigationWindow: BrowserWindow | null = null
let dailySummaryPreparing = false

function statePath(): string {
  return path.join(app.getPath('userData'), 'daily-summary-state.json')
}

function readState(): DailyNotifierState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as DailyNotifierState
  } catch {
    return {}
  }
}

function writeState(state: DailyNotifierState): void {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2))
}

function notifyWithNavigation(title: string, body: string, route: string, options: { actionText?: string } = {}): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title,
    body,
    actions: options.actionText ? [{ type: 'button', text: options.actionText }] : undefined,
  })
  const openRoute = () => {
    if (!navigationWindow || navigationWindow.isDestroyed()) return
    if (navigationWindow.isMinimized()) navigationWindow.restore()
    navigationWindow.show()
    navigationWindow.focus()
    navigationWindow.webContents.send('navigate', route)
  }
  notification.on('click', openRoute)
  notification.on('action', openRoute)
  notification.show()
}

function hasTrackedActivityOn(date: string): boolean {
  const [fromMs, toMs] = localDayBounds(date)
  return getSessionsForRange(getDb(), fromMs, toMs).length > 0
}

function hasReachedLocalTime(now: Date, hour: number, minute = 0): boolean {
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)
}

function dailyReportRoute(report: { threadId: number | null; artifactId: number | null }): string {
  const params = new URLSearchParams()
  if (report.threadId != null) params.set('threadId', String(report.threadId))
  if (report.artifactId != null) params.set('artifactId', String(report.artifactId))
  if ('date' in report && typeof report.date === 'string') params.set('date', report.date)
  params.set('source', 'daily-summary')
  const query = params.toString()
  return query ? `/ai?${query}` : '/ai'
}

async function checkDailySummary(): Promise<void> {
  const settings = getSettings()
  if (!settings.dailySummaryEnabled) return
  if (dailySummaryPreparing) return

  const now = new Date()
  const today = localDateString(now)
  const state = readState()
  if (state.lastDailySummaryDate === today) return
  if (!hasReachedLocalTime(now, 18)) return
  if (!hasTrackedActivityOn(today)) return

  dailySummaryPreparing = true
  try {
    const report = await prepareDailyReport(today)
    if (report.status !== 'ready') return
    notifyWithNavigation('Daylens', 'Your day report is ready.', dailyReportRoute(report))
    writeState({ ...state, lastDailySummaryDate: today })
  } finally {
    dailySummaryPreparing = false
  }
}

async function checkMorningNudge(): Promise<void> {
  const settings = getSettings()
  if (!settings.morningNudgeEnabled) return
  if (dailySummaryPreparing) return

  const now = new Date()
  const today = localDateString(now)
  const yesterday = localDateString(new Date(now.getTime() - 86_400_000))
  const state = readState()
  if (state.lastMorningNudgeDate === today) return
  if (!hasReachedLocalTime(now, 9) || now.getHours() >= 12) return
  if (hasTrackedActivityOn(today)) return
  if (!hasTrackedActivityOn(yesterday)) return

  dailySummaryPreparing = true
  try {
    const report = await prepareDailyReport(yesterday)
    if (report.status !== 'ready') return
    notifyWithNavigation(
      'Morning Brief is ready',
      "Open yesterday's recap and carry the best signal into today.",
      dailyReportRoute(report),
      { actionText: 'Open' },
    )
    writeState({ ...state, lastMorningNudgeDate: today })
  } finally {
    dailySummaryPreparing = false
  }
}

export function setDailySummaryNotificationWindow(window: BrowserWindow | null): void {
  navigationWindow = window
}

export function startDailySummaryNotifier(window?: BrowserWindow | null): void {
  if (window) {
    navigationWindow = window
  }
  if (notifierTimer) return

  const runChecks = () => {
    void (async () => {
      try {
        await checkMorningNudge()
        await checkDailySummary()
      } catch (err) {
        console.warn('[daily-summary] notifier check failed:', err)
      }
    })()
  }

  runChecks()
  notifierTimer = setInterval(runChecks, 60_000)
}
