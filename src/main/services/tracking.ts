// Activity tracker — polls active window every 5 s and flushes completed sessions to DB
// active-win is ESM-only; dynamic import is required at runtime
import { insertAppSession } from '../db/queries'
import { getDb } from './database'
import type { AppCategory } from '@shared/types'

interface ActiveWinResult {
  title: string
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  owner: {
    name: string
    processId: number
    bundleId?: string   // macOS only
    path: string
  }
  memoryUsage: number
  url?: string         // browsers only (macOS)
}

interface InFlightSession {
  bundleId: string
  appName: string
  startTime: number
  category: AppCategory
}

const POLL_INTERVAL_MS = 5_000
const MIN_SESSION_SEC = 3 // discard sub-3s noise

let pollTimer: ReturnType<typeof setInterval> | null = null
let currentSession: InFlightSession | null = null

export function startTracking(): void {
  if (pollTimer) return
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  console.log('[tracking] started')
}

export function stopTracking(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  flushCurrent()
  console.log('[tracking] stopped')
}

export function getCurrentSession(): InFlightSession | null {
  return currentSession
}

async function poll(): Promise<void> {
  try {
    // Dynamic import required — active-win is ESM-only
    const { default: activeWin } = await import('active-win')
    const win = (await activeWin()) as ActiveWinResult | undefined
    if (!win) return

    const bundleId = win.owner.bundleId ?? win.owner.name
    const appName = win.owner.name

    if (currentSession && currentSession.bundleId !== bundleId) {
      flushCurrent()
    }

    if (!currentSession || currentSession.bundleId !== bundleId) {
      currentSession = {
        bundleId,
        appName,
        startTime: Date.now(),
        category: classifyApp(bundleId, appName),
      }
    }
  } catch (err) {
    // active-win can throw on permissions denial (macOS) or unsupported platform
    console.warn('[tracking] poll error:', err)
  }
}

function flushCurrent(): void {
  if (!currentSession) return
  const endTime = Date.now()
  const durationSeconds = Math.round((endTime - currentSession.startTime) / 1000)

  if (durationSeconds >= MIN_SESSION_SEC) {
    try {
      const { isFocused, category } = classifyResult(currentSession.bundleId, currentSession.appName)
      insertAppSession(getDb(), {
        bundleId: currentSession.bundleId,
        appName: currentSession.appName,
        startTime: currentSession.startTime,
        endTime,
        durationSeconds,
        category,
        isFocused,
      })
    } catch (err) {
      console.error('[tracking] flush error:', err)
    }
  }

  currentSession = null
}

// ---------------------------------------------------------------------------
// Simple rule-based classifier — mirrors macOS AppCategory.classify()
// Extend this as you learn the Windows bundle/exe names
// ---------------------------------------------------------------------------

const RULES: [RegExp, AppCategory][] = [
  [/code|cursor|windsurf|zed|xcode|devtools|terminal|iterm|wezterm|alacritty/i, 'development'],
  [/slack|teams|discord|zoom|webex|skype|telegram|signal/i, 'communication'],
  [/safari|chrome|firefox|edge|arc|brave/i, 'browsing'],
  [/notion|obsidian|word|pages|google docs|typora/i, 'writing'],
  [/figma|sketch|affinity|photoshop|illustrator/i, 'design'],
  [/claude|chatgpt|copilot|gemini/i, 'aiTools'],
  [/mail|outlook|gmail/i, 'email'],
  [/spotify|netflix|youtube|vlc|music|plex/i, 'entertainment'],
  [/finder|explorer|system preferences|settings/i, 'system'],
]

function classifyApp(bundleId: string, appName: string): AppCategory {
  const target = `${bundleId} ${appName}`.toLowerCase()
  for (const [pattern, category] of RULES) {
    if (pattern.test(target)) return category
  }
  return 'uncategorized'
}

function classifyResult(
  bundleId: string,
  appName: string,
): { category: AppCategory; isFocused: boolean } {
  const category = classifyApp(bundleId, appName)
  const focused: AppCategory[] = ['development', 'research', 'writing', 'aiTools', 'design', 'productivity']
  return { category, isFocused: focused.includes(category) }
}
