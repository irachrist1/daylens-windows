// Activity tracker — polls active window every 5 s and flushes completed sessions to DB.
// Uses @paymoapp/active-window which supports Windows, macOS, and Linux natively.
import { app, powerMonitor } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { insertAppSession } from '../db/queries'
import { getDb } from './database'
import type { AppCategory, LiveSession } from '@shared/types'
import { isCategoryFocused } from '../lib/focusScore'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActiveWinResult {
  title: string
  application: string
  path: string
  pid: number
  icon: string
  windows?: {
    isUWPApp: boolean
    uwpPackage: string
  }
}

interface InFlightSession {
  bundleId: string
  appName: string
  startTime: number
  category: AppCategory
}

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 5_000
const MIN_SESSION_SEC   = 10    // discard sub-10s noise (5s/10s micro-fragments)
const IDLE_THRESHOLD_SEC = 120  // 2 min of no input → hold the session open provisionally
const AWAY_THRESHOLD_SEC = 300  // 5 min of no input → treat as away and flush

interface NormalizationMap {
  aliases: Record<string, string>
  catalog: Record<string, { displayName: string; defaultCategory: AppCategory }>
}

let _normMap: NormalizationMap | null = null

function getNormalizationMap(): NormalizationMap {
  if (_normMap) return _normMap

  const candidates = [
    ...(typeof process !== 'undefined' && process.resourcesPath
      ? [path.join(process.resourcesPath, 'app-normalization.v1.json')]
      : []),
    path.join(__dirname, '..', '..', 'shared', 'app-normalization.v1.json'),
    path.join(process.cwd(), 'shared', 'app-normalization.v1.json'),
  ]

  for (const candidate of candidates) {
    try {
      _normMap = JSON.parse(fs.readFileSync(candidate, 'utf8')) as NormalizationMap
      return _normMap
    } catch {
      // Try next candidate.
    }
  }

  _normMap = { aliases: {}, catalog: {} }
  return _normMap
}

// ─── active-window singleton ─────────────────────────────────────────────────
// @paymoapp/active-window is a native CJS module — synchronous getActiveWindow().
// Lazy-load to avoid crashing if native bindings fail to load.

let _activeWindowMod: typeof import('@paymoapp/active-window').default | null = null
let _activeWindowInitFailed = false

export const trackingStatus = {
  moduleSource: null as 'package' | 'unpacked' | null,
  loadError: null as string | null,
  pollError: null as string | null,
  lastRawWindow: null as {
    application: string
    path: string
    isUWPApp: boolean
    uwpPackage: string
  } | null,
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

function requireActiveWindowModule() {
  try {
    trackingStatus.moduleSource = 'package'
    return require('@paymoapp/active-window')
  } catch (packageErr) {
    if (!app.isPackaged) throw packageErr

    const unpackedEntry = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@paymoapp',
      'active-window',
      'dist',
      'index.js',
    )

    try {
      trackingStatus.moduleSource = 'unpacked'
      return require(unpackedEntry)
    } catch (unpackedErr) {
      const combined = new Error(
        [
          `package require failed: ${formatError(packageErr)}`,
          `unpacked require failed: ${formatError(unpackedErr)}`,
        ].join(' | '),
      )
      trackingStatus.moduleSource = null
      throw combined
    }
  }
}

function getActiveWindowModule(): typeof import('@paymoapp/active-window').default | null {
  if (_activeWindowInitFailed) return null
  if (!_activeWindowMod) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = requireActiveWindowModule()
      const ActiveWindow = mod.default ?? mod
      ActiveWindow.initialize()
      if (process.platform === 'darwin') {
        ActiveWindow.requestPermissions()
      }
      _activeWindowMod = ActiveWindow
      trackingStatus.loadError = null
      console.log(`[tracking] active-window loaded via ${trackingStatus.moduleSource ?? 'unknown source'}`)
    } catch (err) {
      trackingStatus.loadError = formatError(err)
      console.warn('[tracking] @paymoapp/active-window failed to load:', err)
      _activeWindowInitFailed = true
      return null
    }
  }
  return _activeWindowMod
}

function deriveWindowIdentity(win: ActiveWinResult): { bundleId: string; appName: string } {
  const exeName = win.path ? path.basename(win.path) : ''
  const uwpPackage = win.windows?.isUWPApp ? win.windows.uwpPackage : ''
  const appName = win.application || exeName || uwpPackage || 'Unknown app'
  const bundleId = win.path || uwpPackage || appName
  return { bundleId, appName }
}

// ─── OS noise filter ─────────────────────────────────────────────────────────
// System processes that appear as "frontmost app" but are not user-initiated.
// Writing these to the DB creates junk sessions that inflate totals and
// pollute the category breakdown.

const OS_NOISE_BUNDLE_IDS = new Set([
  'com.apple.loginwindow',
  'com.apple.dock',
  'com.apple.systemuiserver',
  'com.apple.notificationcenterui',
  'com.apple.controlcenter',
  'com.apple.screensaver.engine',
  'com.apple.backgroundtaskmanagementagent',
  'com.apple.usernotificationcenter',
  'com.apple.WindowManager',
])

// Lowercase app name exact matches (covers both macOS and Windows noise)
const OS_NOISE_APP_NAMES = new Set([
  'loginwindow',
  'windowserver',
  'universalaccessd',
  'dock',
  'systemuiserver',
  // Windows OS-level processes
  'dwm.exe',
  'csrss.exe',
  'svchost.exe',
])

// Self-exclusion: only this app's own exe names, not all Electron-based apps.
// Previously matched 'electron' as a substring which filtered VS Code, Discord,
// Slack, Figma, and every other Electron app. Now uses exact exe name matching.
const SELF_NOISE_EXE_NAMES = new Set([
  'daylens windows.exe',
  'daylenswindows.exe',
  'electron.exe',      // dev mode — raw electron runner, not a user app
])

function isOsNoise(bundleId: string, appName: string, winPath?: string): boolean {
  if (OS_NOISE_BUNDLE_IDS.has(bundleId)) return true
  const lowerName = appName.toLowerCase()
  if (OS_NOISE_APP_NAMES.has(lowerName)) return true
  // Exact exe name match — allows VS Code, Discord, Slack etc. through
  const exeName = (winPath ? path.basename(winPath) : appName).toLowerCase()
  if (SELF_NOISE_EXE_NAMES.has(exeName)) return true
  // App name substring match for 'daylens' only
  if (lowerName.includes('daylens')) return true
  if (lowerName.includes('cmux') || lowerName.includes('node.js')) return true
  return false
}

// ─── State ────────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null
let currentSession: InFlightSession | null = null
type IdleState = 'active' | 'provisional_idle' | 'away'
let idleState: IdleState = 'active'
let provisionalIdleStart: number | null = null
let powerMonitorListenersRegistered = false

function handleLockScreen(): void {
  if (currentSession) {
    flushCurrent()
    console.log('[tracking] screen locked — session flushed')
  }
  idleState = 'away'
  provisionalIdleStart = null
}

function handleSuspend(): void {
  if (currentSession) {
    flushCurrent()
    console.log('[tracking] system suspended — session flushed')
  }
  idleState = 'away'
  provisionalIdleStart = null
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startTracking(): void {
  if (pollTimer) return
  if (!powerMonitorListenersRegistered) {
    powerMonitor.on('lock-screen', handleLockScreen)
    powerMonitor.on('suspend', handleSuspend)
    powerMonitorListenersRegistered = true
  }
  // Fire immediately — don't wait 5 s for the first data point
  void poll()
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  console.log('[tracking] started')
}

export function stopTracking(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (powerMonitorListenersRegistered) {
    powerMonitor.removeListener('lock-screen', handleLockScreen)
    powerMonitor.removeListener('suspend', handleSuspend)
    powerMonitorListenersRegistered = false
  }
  flushCurrent()
  idleState = 'active'
  provisionalIdleStart = null
  console.log('[tracking] stopped')
}

export function getCurrentSession(): LiveSession | null {
  return currentSession
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  try {
    // ── Idle detection ───────────────────────────────────────────────────────
    const idleSec = powerMonitor.getSystemIdleTime()
    if (idleSec >= AWAY_THRESHOLD_SEC) {
      if (idleState !== 'away' && currentSession) {
        const idleStartMs = provisionalIdleStart ?? (Date.now() - Math.round(idleSec) * 1_000)
        flushCurrent(idleStartMs)
        console.log(`[tracking] user away ${Math.round(idleSec)}s — session flushed`)
      }
      idleState = 'away'
      provisionalIdleStart = null
      return
    } else if (idleSec >= IDLE_THRESHOLD_SEC) {
      if (idleState === 'active') {
        provisionalIdleStart = Date.now() - Math.round(idleSec) * 1_000
        idleState = 'provisional_idle'
        console.log(`[tracking] provisional idle at ${Math.round(idleSec)}s — session held open`)
      }
    } else {
      if (idleState === 'away' || idleState === 'provisional_idle') {
        // Returning from provisional_idle: the session was intentionally held open
        // through the 2–5 min idle window to avoid fragmenting media playback.
        // The idle time is attributed to the session — this is the desired behaviour.
        // Returning from away: session was already flushed, a new one will start below.
        console.log(`[tracking] user returned from ${idleState}`)
      }
      idleState = 'active'
      provisionalIdleStart = null
    }

    // ── Active window ────────────────────────────────────────────────────────
    const awMod = getActiveWindowModule()
    if (!awMod) return

    let win: ActiveWinResult
    try {
      win = awMod.getActiveWindow()
    } catch (err) {
      trackingStatus.pollError = formatError(err)
      return
    }
    if (!win) {
      trackingStatus.pollError = null
      trackingStatus.lastRawWindow = null
      return
    }
    trackingStatus.pollError = null
    trackingStatus.lastRawWindow = {
      application: win.application,
      path: win.path,
      isUWPApp: win.windows?.isUWPApp ?? false,
      uwpPackage: win.windows?.uwpPackage ?? '',
    }

    // Prefer the display name from the addon, but fall back to exe/UWP metadata on Windows.
    const { bundleId, appName } = deriveWindowIdentity(win)

    // Skip OS infrastructure processes
    if (isOsNoise(bundleId, appName, win.path)) return

    // App switched → flush the previous session
    if (currentSession && currentSession.bundleId !== bundleId) {
      flushCurrent()
    }

    // Start a new session if none is in-flight for this app
    if (!currentSession || currentSession.bundleId !== bundleId) {
      currentSession = {
        bundleId,
        appName,
        startTime: Date.now(),
        category:  classifyApp(bundleId, appName),
      }
    }
  } catch (err) {
    // active-window can throw on permissions denial (macOS) or unsupported platform
    trackingStatus.pollError = formatError(err)
    console.warn('[tracking] poll error:', err)
  }
}

// ─── Flush ────────────────────────────────────────────────────────────────────

function flushCurrent(overrideEndTime?: number): void {
  if (!currentSession) return

  const endTime = overrideEndTime ?? Date.now()

  // Guard: never write a session with non-positive duration
  if (endTime <= currentSession.startTime) {
    currentSession = null
    return
  }

  const durationSeconds = Math.round((endTime - currentSession.startTime) / 1_000)

  if (durationSeconds >= MIN_SESSION_SEC) {
    try {
      const { isFocused, category } = classifyResult(currentSession.bundleId, currentSession.appName)
      insertAppSession(getDb(), {
        bundleId:        currentSession.bundleId,
        appName:         currentSession.appName,
        startTime:       currentSession.startTime,
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

// ─── Classifier ───────────────────────────────────────────────────────────────
// Rules are matched in order — first match wins.
// The target string is "<bundleId> <appName>" lowercased.
// On macOS, bundleId is the real bundle ID (e.g. "com.todesktop.230313mzl4w4u92 Cursor").
// On Windows, bundleId falls back to the exe name (e.g. "Code.exe Code").

const RULES: [RegExp, AppCategory][] = [
  // ── Meetings — video calls ──────────────────────────────────────────────────
  // MUST come before communication so zoom/webex/meet are captured here first.
  [/\bzoom\b|webex|google.?meet|\bgmeet\b/i, 'meetings'],

  // ── Development ─────────────────────────────────────────────────────────────
  // Editors & IDEs
  [/\bcode\b|cursor|windsurf|zed|xcode|intellij|pycharm|webstorm|phpstorm|goland|rider|clion|rubymine|datagrip|android.?studio/i, 'development'],
  [/\bvim\b|neovim|\bnvim\b|sublime|emacs\b|nano\b|helix\b|fleet\b/i, 'development'],
  [/devenv|visual.?studio(?!.?code)|rust.?rover/i, 'development'],
  // Terminals (macOS + Windows — "windowsterminal" is the Windows Terminal process name)
  [/\bterminal\b|windowsterminal|iterm|wezterm|alacritty|warp|hyper|kitty|ghostty|powershell|pwsh\b/i, 'development'],
  // Version control GUIs
  [/github.?desktop|sourcetree|\btower\b|\bfork\b|gitkraken|lazygit/i, 'development'],
  // API / DB tools
  [/postman|insomnia|tableplus|sequel.?pro|dbeaver|beekeeper|hoppscotch/i, 'development'],
  // Containers & virtualization
  [/docker.?desktop|rancher.?desktop|orbstack/i, 'development'],
  // Network / proxy / debug
  [/charles.?proxy|proxyman|wireshark|http.?toolkit|\bpaw\b/i, 'development'],
  // Remote access
  [/\bssh\b|putty|mobaxterm/i, 'development'],

  // ── Email — MUST come before browsing so that email clients that use WebView2
  //    (e.g. New Outlook / olk.exe) are not misclassified as browsers.
  //    \bolk\b matches the New Outlook for Windows Store exe name.
  [/\bmail\b|outlook|\bolk\b|\bgmail\b|thunderbird|spark|airmail|mimestream/i, 'email'],

  // ── Communication — messaging only (no video calls) ─────────────────────────
  [/slack|teams|discord|skype|telegram|signal|whatsapp|lark|google.?chat|mattermost/i, 'communication'],

  // ── Browsing ─────────────────────────────────────────────────────────────────
  [/safari|chrome|firefox|\bedge\b|msedge|arc|brave|opera|vivaldi|chromium/i, 'browsing'],

  // ── Writing / notes ──────────────────────────────────────────────────────────
  [/notion|obsidian|\bword\b|winword|pages|typora|ulysses|scrivener|\bbear\b|\bcraft\b/i, 'writing'],
  [/evernote|logseq|roam.?research|day.?one|marktext|\bnotes\b/i, 'writing'],

  // ── Design ───────────────────────────────────────────────────────────────────
  [/figma|sketch|affinity|photoshop|illustrator|lightroom|capture.?one|luminar|canva|framer/i, 'design'],
  [/penpot|inkscape|blender|cinema.?4d|maya\b|pixelmator|acorn\b/i, 'design'],

  // ── AI tools ─────────────────────────────────────────────────────────────────
  [/claude|chatgpt|copilot|gemini|perplexity|mistral|ollama|lm.?studio|jan\.ai/i, 'aiTools'],

  // ── Research ─────────────────────────────────────────────────────────────────
  [/reader|readwise|pocket|instapaper|kindle|\bbooks\b|zotero|reeder|\bdash\b|kapeli/i, 'research'],

  // ── Productivity — task managers, calendars, office spreadsheets/slides ──────
  [/calendar|fantastical|things|todoist|omnifocus|linear|asana|jira|trello|basecamp/i, 'productivity'],
  [/\bexcel\b|xlsx|powerpoint|powerpnt|keynote|\bnumbers\b|airtable/i, 'productivity'],
  [/raycast|alfred\b|1password|bitwarden|reminders\b/i, 'productivity'],

  // ── Entertainment ────────────────────────────────────────────────────────────
  [/spotify|netflix|youtube|vlc|\bmusic\b|plex|twitch|hulu|disney|prime.?video/i, 'entertainment'],
  [/steam|epicgames|epic.?games|gog\.com|battle\.net|origin\b|eadesktop/i, 'entertainment'],

  // ── System ───────────────────────────────────────────────────────────────────
  [/finder|explorer|system.?preferences|activity.?monitor|\bconsole\b|keychain/i, 'system'],
  [/task.?manager|taskmgr|regedit|registry.?editor|appcleaner|cleanmymac/i, 'system'],
]

// ─── App name normalization ───────────────────────────────────────────────────
// On Windows, active-window returns exe-based names (e.g. "Code.exe", "msedge.exe",
// "WindowsTerminal") which won't match rules expecting clean names. Strip the
// .exe and .app suffixes before building the match target. Nothing stored in the
// DB changes — this only affects the string the classifier sees.

function normalizeForClassify(bundleId: string, appName: string): string {
  const strip = (s: string) => s
    .replace(/\.exe$/i, '')
    .replace(/\.app$/i, '')
    .trim()
  return `${strip(bundleId)} ${strip(appName)}`.toLowerCase()
}

function normalizedCatalogCategory(bundleId: string, appName: string): AppCategory | null {
  const map = getNormalizationMap()
  const candidates = [
    bundleId,
    path.basename(bundleId).toLowerCase(),
    path.basename(bundleId).replace(/\.exe$/i, '').toLowerCase(),
    appName.toLowerCase(),
    appName.replace(/\.exe$/i, '').toLowerCase(),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const key = map.aliases[candidate] ?? candidate
    const catalogEntry = map.catalog[key]
    if (catalogEntry?.defaultCategory) {
      return catalogEntry.defaultCategory
    }
  }

  return null
}

// Last match info exposed for the debug panel
export let lastClassifyMatch: { target: string; category: AppCategory } = {
  target: '',
  category: 'uncategorized',
}

function classifyApp(bundleId: string, appName: string): AppCategory {
  const normalizedCategory = normalizedCatalogCategory(bundleId, appName)
  if (normalizedCategory) {
    lastClassifyMatch = { target: `${bundleId} ${appName}`, category: normalizedCategory }
    return normalizedCategory
  }

  const target = normalizeForClassify(bundleId, appName)
  for (const [pattern, category] of RULES) {
    if (pattern.test(target)) {
      lastClassifyMatch = { target, category }
      return category
    }
  }
  lastClassifyMatch = { target, category: 'uncategorized' }
  return 'uncategorized'
}

export function classifyResult(
  bundleId: string,
  appName: string,
): { category: AppCategory; isFocused: boolean } {
  const category = classifyApp(bundleId, appName)
  return { category, isFocused: isCategoryFocused(category) }
}
