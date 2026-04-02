import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Notification, app } from 'electron'
import { getActiveFocusSession, getRecentFocusSessions } from '../db/queries'
import { localDateString, localDayBounds } from '../lib/localDate'
import { getDb } from './database'
import { getSettings } from './settings'

interface DailyNotifierState {
  lastDailySummaryDate?: string
  lastMorningNudgeDate?: string
}

let notifierTimer: ReturnType<typeof setInterval> | null = null
let navigationWindow: BrowserWindow | null = null

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

function notifyWithNavigation(title: string, body: string, channel: 'navigate:today' | 'navigate:focus'): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => {
    if (!navigationWindow || navigationWindow.isDestroyed()) return
    if (navigationWindow.isMinimized()) navigationWindow.restore()
    navigationWindow.show()
    navigationWindow.focus()
    navigationWindow.webContents.send(channel)
  })
  notification.show()
}

function hasStartedFocusSessionToday(today: string): boolean {
  const [fromMs, toMs] = localDayBounds(today)
  const recentSession = getRecentFocusSessions(getDb(), 200)
    .some((session) => session.startTime >= fromMs && session.startTime < toMs)
  const activeSession = getActiveFocusSession(getDb())
  return recentSession || Boolean(activeSession && activeSession.startTime >= fromMs && activeSession.startTime < toMs)
}

function checkDailySummary(): void {
  const settings = getSettings()
  if (!settings.dailySummaryEnabled) return

  const now = new Date()
  const today = localDateString(now)
  const state = readState()
  if (state.lastDailySummaryDate === today) return
  if (now.getHours() !== 18 || now.getMinutes() !== 0) return

  notifyWithNavigation('Daylens', 'See where your day went.', 'navigate:today')
  writeState({ ...state, lastDailySummaryDate: today })
}

function checkMorningNudge(): void {
  const settings = getSettings()
  if (!settings.morningNudgeEnabled) return

  const now = new Date()
  const today = localDateString(now)
  const state = readState()
  if (state.lastMorningNudgeDate === today) return
  if (now.getHours() !== 9 || now.getMinutes() !== 0) return
  if (hasStartedFocusSessionToday(today)) return

  notifyWithNavigation('Daylens', "What's your focus for today?", 'navigate:focus')
  writeState({ ...state, lastMorningNudgeDate: today })
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
    try {
      checkMorningNudge()
      checkDailySummary()
    } catch (err) {
      console.warn('[daily-summary] notifier check failed:', err)
    }
  }

  runChecks()
  notifierTimer = setInterval(runChecks, 60_000)
}
