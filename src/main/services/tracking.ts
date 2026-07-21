// Activity tracker — polls active window every 5 s and flushes completed sessions to DB.
// Uses @paymoapp/active-window which supports Windows, macOS, and Linux natively.
import { app, powerMonitor } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  clearLiveAppSessionSnapshot,
  getLiveAppSessionSnapshot,
  markActivityStateEventHeldForMediaPlayback,
  recordActivityStateEvent,
  upsertLiveAppSessionSnapshot,
} from '../db/queries'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { upsertAppIdentityObservation } from '../core/inference/appIdentityRegistry'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { createLeadingTrailingThrottle } from '../lib/coalescer'
import { getDb } from './database'
import {
  recordPollForegroundEvent,
  recordPollMachineStateEvent,
  recordSupervisorEvent,
  type PollMachineStateEventType,
} from './captureEvidence'
import type {
  AppCategory,
  AppSession,
  LinuxTrackingDiagnostics,
  LiveSession,
  TrackingModuleSource,
} from '@shared/types'
import { isCategoryFocused } from '../lib/focusScore'
import { resolveCanonicalApp } from '../lib/appIdentity'
import { stripBrowserUrlFromTitle } from '@shared/aiSanitize'
import { localDateString, localDayBounds } from '../lib/localDate'
import { passivePresenceHoldKind, READING_HOLD_MAX_SEC, type PassiveHoldKind } from '../lib/passivePresence'
import { capture, captureException, captureRateLimited, captureTrackingPauseTransition } from './analytics'
import { resolveLinuxDesktopIdentity } from './linuxDesktop'
import { flushActiveBrowserContext, recordActiveBrowserContextSample } from './browserContext'
import { macBundleIdentifierForExecutablePath, resolveBrowserApplication } from './browserRegistry'
import { getRecentWindowsPrivateWindowSignal } from './windowsFocusCapture'
import { getSettings } from './settings'
import { decideAppCapture, trackingControlsStateFromSettings } from '@shared/trackingControls'
import { isSystemNoiseApp, isSystemNoiseTitle } from '@shared/systemNoise'
import { runAttributionForRange } from './attribution'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActiveWinResult {
  title: string
  application: string
  path: string
  bundleId?: string
  pid: number
  icon: string
  windows?: {
    isUWPApp: boolean
    uwpPackage: string
  }
}

interface MacFocusEventWindow extends ActiveWinResult {
  observedAt: number
}

interface InFlightSession {
  bundleId: string
  appName: string
  windowTitle: string | null
  rawAppName: string
  canonicalAppId: string | null
  appInstanceId: string | null
  captureSource: string
  startTime: number
  category: AppCategory
  passivePresence: boolean
  passiveHold?: PassiveHoldKind | null
  windowTitles?: { title: string | null; ticks: number }[]
  // Set when the session's start was stamped from the true input time on a
  // return from away/provisional_idle. Lets the MIN_SESSION_SEC floor log why a
  // just-born session collapsed, instead of dropping it silently.
  bornOnIdleReturn?: boolean
}

interface LinuxProcessSnapshot {
  pid: number
  ppid: number
  exePath: string
  name: string
  cmdline: string[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 5_000
const SNAPSHOT_PERSIST_MS = 15_000
const MIN_SESSION_SEC   = 10    // discard sub-10s noise (5s/10s micro-fragments)
const IDLE_THRESHOLD_SEC = 120  // 2 min of no input → hold the session open provisionally
const AWAY_THRESHOLD_SEC = 300  // 5 min of no input → treat as away and flush
// A wall-clock hole between two poll ticks longer than this means the machine
// was asleep (or the process frozen): interval timers do not run during sleep,
// so the pre-sleep session would otherwise survive the gap and absorb it as
// active time. macOS lid-close proved able to sleep WITHOUT emitting the
// powerMonitor suspend/lock-screen events (idle_start 03:08 →
// unlock 12:52 with nothing in between, 9h44m counted as one Dia session), so
// gap detection is the primary sleep signal, not a fallback.
const GAP_FLUSH_MS = 60_000

// A finished foreground session flushes on every app/window switch. Firing a
// full-day timeline rebuild on each one is the dominant cost behind the app
// feeling slower the longer the day runs.
// Blocks are coarse and the *current* app is shown via the live-session path,
// so coalescing the timeline/insights invalidation to a leading+trailing
// window is safe. Explicit user actions (rebuild, label overrides, focus
// start/stop) still invalidate immediately from their own handlers.
const ACTIVITY_INVALIDATION_WINDOW_MS = 15_000
const scheduleActivityProjectionInvalidation = createLeadingTrailingThrottle(
  (date: string) => {
    invalidateProjectionScope('timeline', 'activity_recorded', { date })
    invalidateProjectionScope('insights', 'activity_recorded', { date })
  },
  ACTIVITY_INVALIDATION_WINDOW_MS,
)

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
  moduleSource: null as TrackingModuleSource | null,
  loadError: null as string | null,
  pollError: null as string | null,
  backendTrace: [] as string[],
  lastRawWindow: null as {
    title: string
    application: string
    path: string
    pid: number
    isUWPApp: boolean
    uwpPackage: string
  } | null,
  lastResolvedWindow: null as {
    backend: string
    bundleId: string
    appName: string
    title: string
    pid: number
    path: string
  } | null,
}

// Capture-health transitions are canonical evidence: the first failure of a
// burst emits capture_failed, the return to a clean poll emits
// capture_recovered. Steady state (healthy or persistently failing) emits
// nothing, so a broken helper can't flood the store.
function setPollHealth(error: string | null): void {
  const previous = trackingStatus.pollError
  trackingStatus.pollError = error
  if (error !== null && previous === null) {
    const eventTs = nowMs()
    if (currentSession) flushCurrent(eventTs, 'capture_failed')
    recordSupervisorEvent('capture_failed', eventTs)
  } else if (error === null && previous !== null) {
    recordSupervisorEvent('capture_recovered', nowMs())
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

function execTextDefault(command: string, args: string[]): string | null {
  try {
    const output = execFileSync(command, args, {
      timeout: 1_500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.trim()
  } catch {
    return null
  }
}

// Indirection so a test can feed canned window-manager output for the Linux
// capture path without a Linux box (see __setLinuxCaptureTestHarness).
let execTextImpl: (command: string, args: string[]) => string | null = execTextDefault
function execText(command: string, args: string[]): string | null {
  return execTextImpl(command, args)
}

const commandAvailabilityCache = new Map<string, boolean>()

function commandAvailable(command: string): boolean {
  if (path.isAbsolute(command)) return fs.existsSync(command)
  if (commandAvailabilityCache.has(command)) return commandAvailabilityCache.get(command) ?? false

  const pathEnv = process.env.PATH ?? ''
  const available = pathEnv
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, command), fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    })

  commandAvailabilityCache.set(command, available)
  return available
}

function linuxSessionType(): string {
  return (process.env.XDG_SESSION_TYPE ?? '').trim().toLowerCase()
}

function linuxDesktopTokens(): string[] {
  return [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.XDG_SESSION_DESKTOP,
    process.env.DESKTOP_SESSION,
    process.env.GDMSESSION,
  ]
    .flatMap((value) => (value ?? '').split(/[:;]/))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
}

function linuxDesktopName(): string {
  return linuxDesktopTokens().join(':')
}

function getLinuxTrackingSupportInfo(): LinuxTrackingDiagnostics {
  const sessionType = linuxSessionType()
  const desktop = linuxDesktopName()
  const helperCommands = {
    hyprctl: commandAvailable('hyprctl'),
    swaymsg: commandAvailable('swaymsg'),
    xdotool: commandAvailable('xdotool'),
    xprop: commandAvailable('xprop'),
  }
  const display = process.env.DISPLAY ?? null
  const waylandDisplay = process.env.WAYLAND_DISPLAY ?? null
  const hyprlandSession = Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE) || desktop.includes('hyprland')
  const swaySession = Boolean(process.env.SWAYSOCK) || desktop.includes('sway')
  const plasmaSession = desktop.includes('kde') || desktop.includes('plasma')
  const gnomeSession = desktop.includes('gnome')

  if (sessionType === 'x11') {
    return {
      supportLevel: 'ready',
      supportMessage: 'X11 session detected. Daylens can use the active-window backend plus xdotool and xprop fallbacks.',
      sessionType,
      desktop,
      helperCommands,
      display,
      waylandDisplay,
    }
  }

  if (hyprlandSession) {
    return {
      supportLevel: helperCommands.hyprctl ? 'ready' : 'limited',
      supportMessage: helperCommands.hyprctl
        ? 'Hyprland session detected. Daylens can read the focused window through hyprctl.'
        : 'Hyprland session detected, but hyprctl is unavailable, so focused-window tracking may stay incomplete until it is installed and on PATH.',
      sessionType,
      desktop,
      helperCommands,
      display,
      waylandDisplay,
    }
  }

  if (swaySession) {
    return {
      supportLevel: helperCommands.swaymsg ? 'ready' : 'limited',
      supportMessage: helperCommands.swaymsg
        ? 'Sway session detected. Daylens can read the focused window through swaymsg.'
        : 'Sway session detected, but swaymsg is unavailable, so focused-window tracking may stay incomplete until it is installed and on PATH.',
      sessionType,
      desktop,
      helperCommands,
      display,
      waylandDisplay,
    }
  }

  if (sessionType === 'wayland' && display) {
    const desktopLabel = gnomeSession
      ? 'GNOME Wayland'
      : plasmaSession
        ? 'KDE Plasma Wayland'
        : 'This Wayland session'

    return {
      supportLevel: 'limited',
      supportMessage: `${desktopLabel} has XWayland available, so Daylens can usually track X11/XWayland apps here, but native Wayland apps may still be missed without a compositor-specific backend.`,
      sessionType,
      desktop,
      helperCommands,
      display,
      waylandDisplay,
    }
  }

  if (sessionType === 'wayland') {
    const desktopLabel = gnomeSession
      ? 'GNOME Wayland'
      : plasmaSession
        ? 'KDE Plasma Wayland'
        : 'This Wayland session'

    return {
      supportLevel: 'unsupported',
      supportMessage: `${desktopLabel} does not currently expose a focused-window backend that Daylens can rely on. Tracking is best-effort only here until XWayland is available or a compositor-specific integration is added.`,
      sessionType,
      desktop,
      helperCommands,
      display,
      waylandDisplay,
    }
  }

  return {
    supportLevel: 'limited',
    supportMessage: 'Linux tracking backends are only partially available in this session, so focused-window tracking may be incomplete.',
    sessionType,
    desktop,
    helperCommands,
    display,
    waylandDisplay,
  }
}

export function getLinuxTrackingDiagnostics(): LinuxTrackingDiagnostics | null {
  if (process.platform !== 'linux') return null
  return getLinuxTrackingSupportInfo()
}

function cleanIdentityToken(value: string): string {
  return value
    .trim()
    .replace(/\.desktop$/i, '')
    .replace(/\.appimage$/i, '')
    .replace(/\.exe$/i, '')
    .replace(/^["']+|["']+$/g, '')
}

function prettifyLinuxAppName(value: string): string {
  const cleaned = cleanIdentityToken(value)
  if (!cleaned) return ''

  let candidate = path.isAbsolute(cleaned) ? path.basename(cleaned) : cleaned
  if (/^[a-z0-9.-]+$/i.test(candidate) && candidate.includes('.')) {
    const segments = candidate.split('.').filter(Boolean)
    candidate = segments[segments.length - 1] ?? candidate
  }

  return candidate
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function canonicalLinuxBundleId(...values: string[]): string {
  for (const value of values) {
    const cleaned = cleanIdentityToken(value)
    if (!cleaned) continue
    const basename = path.isAbsolute(cleaned) ? path.basename(cleaned) : cleaned
    return basename.toLowerCase()
  }
  return 'unknown-app'
}

const PROCESS_SNAPSHOT_CACHE_MS = 30_000
const processSnapshotCache = new Map<number, { expiresAt: number; snapshot: LinuxProcessSnapshot | null }>()
const CMDLINE_IDENTITY_FLAG_PREFIXES = [
  '--app-id=',
  '--binary=',
  '--class=',
  '--command=',
  '--desktop-file-hint=',
  '--exec=',
  '--name=',
  '--wmclass=',
]
const GENERIC_CMDLINE_TOKENS = new Set([
  'apprun',
  'appimagekit',
  'appimagelauncher',
  'appimagelauncherd',
  'bash',
  'bwrap',
  'dash',
  'dbus-run-session',
  'electron',
  'electron.real',
  'electron-wrapper',
  'env',
  'flatpak',
  'flatpak-spawn',
  'gtk-launch',
  'java',
  'node',
  'python',
  'python3',
  'run',
  'sh',
  'snap',
  'xdg-dbus-proxy',
  'zsh',
])

function processExecutablePath(pid: number): string {
  if (!pid || process.platform !== 'linux') return ''
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return ''
  }
}

function processName(pid: number): string {
  if (!pid || process.platform !== 'linux') return ''
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    const exePath = processExecutablePath(pid)
    return exePath ? path.basename(exePath) : ''
  }
}

function processCommandLine(pid: number): string[] {
  if (!pid || process.platform !== 'linux') return []
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\u0000')
      .map((part) => part.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function processParentPid(pid: number): number {
  if (!pid || process.platform !== 'linux') return 0
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    const match = status.match(/^PPid:\s+(\d+)$/m)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

function readLinuxProcessSnapshot(pid: number): LinuxProcessSnapshot | null {
  if (!pid || process.platform !== 'linux') return null

  const now = Date.now()
  const cached = processSnapshotCache.get(pid)
  if (cached && cached.expiresAt > now) return cached.snapshot

  const snapshot: LinuxProcessSnapshot | null = {
    pid,
    ppid: processParentPid(pid),
    exePath: processExecutablePath(pid),
    name: processName(pid),
    cmdline: processCommandLine(pid),
  }

  processSnapshotCache.set(pid, {
    snapshot,
    expiresAt: now + PROCESS_SNAPSHOT_CACHE_MS,
  })

  return snapshot
}

function linuxCmdlineIdentityTokens(cmdline: string[]): string[] {
  const tokens = new Set<string>()

  for (const entry of cmdline) {
    const cleanedEntry = cleanIdentityToken(entry)
    if (!cleanedEntry) continue

    const matchedFlag = CMDLINE_IDENTITY_FLAG_PREFIXES.find((prefix) => cleanedEntry.startsWith(prefix))
    if (matchedFlag) {
      const value = cleanIdentityToken(cleanedEntry.slice(matchedFlag.length))
      if (value) tokens.add(value)
      continue
    }

    if (cleanedEntry.startsWith('-')) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cleanedEntry)) continue
    if (cleanedEntry.includes('://')) continue

    const basename = path.basename(cleanedEntry).toLowerCase()
    if (GENERIC_CMDLINE_TOKENS.has(basename)) continue

    tokens.add(cleanedEntry)
    if (path.isAbsolute(cleanedEntry)) tokens.add(path.basename(cleanedEntry))
  }

  return [...tokens]
}

function linuxAncestorIdentityCandidates(pid: number, depth: number): string[] {
  const candidates: string[] = []
  const visited = new Set<number>()
  let currentPid = pid
  let stepsRemaining = depth

  while (stepsRemaining > 0) {
    const snapshot = readLinuxProcessSnapshot(currentPid)
    const parentPid = snapshot?.ppid ?? 0
    if (!parentPid || visited.has(parentPid)) break
    visited.add(parentPid)

    const parent = readLinuxProcessSnapshot(parentPid)
    if (!parent) break

    candidates.push(parent.exePath, parent.name, ...linuxCmdlineIdentityTokens(parent.cmdline))
    currentPid = parentPid
    stepsRemaining--
  }

  return candidates.filter(Boolean)
}

function normalizedCatalogDisplayName(...values: string[]): string | null {
  const map = getNormalizationMap()
  const candidates = values
    .flatMap((value) => {
      const cleaned = cleanIdentityToken(value)
      if (!cleaned) return []
      const basename = path.isAbsolute(cleaned) ? path.basename(cleaned) : cleaned
      return [
        cleaned,
        cleaned.toLowerCase(),
        basename,
        basename.toLowerCase(),
        basename.replace(/\.exe$/i, '').toLowerCase(),
      ]
    })
    .filter(Boolean)

  for (const candidate of candidates) {
    const key = map.aliases[candidate] ?? map.aliases[candidate.toLowerCase()] ?? candidate.toLowerCase()
    const entry = map.catalog[key]
    if (entry?.displayName) return entry.displayName
  }

  return null
}

function finalizeLinuxWindowIdentity(
  win: ActiveWinResult,
): ActiveWinResult & { bundleId: string; appName: string } {
  const currentSnapshot = readLinuxProcessSnapshot(win.pid)
  const exePath = currentSnapshot?.exePath || processExecutablePath(win.pid) || (path.isAbsolute(win.path) ? win.path : '')
  const procName = currentSnapshot?.name || processName(win.pid)
  const cmdline = currentSnapshot?.cmdline || processCommandLine(win.pid)
  const cmdlineCandidates = linuxCmdlineIdentityTokens(cmdline)

  let desktopIdentity = resolveLinuxDesktopIdentity(
    win.path,
    win.application,
    win.title,
    exePath,
    procName,
    ...cmdlineCandidates,
  )

  if (!desktopIdentity) {
    desktopIdentity = resolveLinuxDesktopIdentity(
      win.path,
      win.application,
      win.title,
      exePath,
      procName,
      ...cmdlineCandidates,
      ...linuxAncestorIdentityCandidates(win.pid, 2),
    )
  }

  const appName = desktopIdentity?.name
    || normalizedCatalogDisplayName(
      desktopIdentity?.desktopId ?? '',
      exePath,
      win.path,
      procName,
      win.application,
      ...cmdlineCandidates,
    )
    || prettifyLinuxAppName(win.application)
    || prettifyLinuxAppName(procName)
    || prettifyLinuxAppName(cmdlineCandidates[0] ?? '')
    || prettifyLinuxAppName(exePath)
    || prettifyLinuxAppName(win.title)
    || 'Unknown app'

  const bundleId = desktopIdentity?.desktopId
    || canonicalLinuxBundleId(
      exePath,
      cmdlineCandidates[0] ?? '',
      win.path,
      procName,
      win.application,
      win.title,
    )

  return {
    ...win,
    application: appName,
    path: exePath || win.path || bundleId,
    title: win.title || appName,
    bundleId,
    appName,
  }
}

function findFocusedSwayNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null
  const candidate = node as Record<string, unknown>
  if (candidate.focused === true) return candidate

  for (const key of ['nodes', 'floating_nodes']) {
    const children = candidate[key]
    if (!Array.isArray(children)) continue
    for (const child of children) {
      const focused = findFocusedSwayNode(child)
      if (focused) return focused
    }
  }

  return null
}

function hyprlandActiveWindow(): ActiveWinResult | null {
  if (!commandAvailable('hyprctl')) return null
  const output = execText('hyprctl', ['activewindow', '-j'])
  if (!output) return null

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    const pid = Number(parsed.pid ?? 0)
    const exePath = processExecutablePath(pid)
    const appClass = typeof parsed.class === 'string' ? parsed.class : ''
    const initialClass = typeof parsed.initialClass === 'string' ? parsed.initialClass : ''
    const title = typeof parsed.title === 'string' ? parsed.title : ''
    const application = appClass || initialClass || processName(pid) || title || 'Unknown app'

    return {
      title: title || application,
      application,
      path: exePath || appClass || initialClass || application,
      pid,
      icon: '',
    }
  } catch {
    return null
  }
}

function swayActiveWindow(): ActiveWinResult | null {
  if (!commandAvailable('swaymsg')) return null
  const output = execText('swaymsg', ['-t', 'get_tree'])
  if (!output) return null

  try {
    const tree = JSON.parse(output) as Record<string, unknown>
    const focused = findFocusedSwayNode(tree)
    if (!focused) return null

    const pid = Number(focused.pid ?? 0)
    const windowProps = (focused.window_properties && typeof focused.window_properties === 'object')
      ? focused.window_properties as Record<string, unknown>
      : null
    const title = typeof focused.name === 'string' ? focused.name : ''
    const appId = typeof focused.app_id === 'string' ? focused.app_id : ''
    const appClass = windowProps && typeof windowProps.class === 'string' ? windowProps.class : ''
    const exePath = processExecutablePath(pid)
    const application = appId || appClass || processName(pid) || title || 'Unknown app'

    return {
      title: title || application,
      application,
      path: exePath || appId || appClass || application,
      pid,
      icon: '',
    }
  } catch {
    return null
  }
}

function gnomeShellActiveWindow(): ActiveWinResult | null {
  if (!commandAvailable('gdbus')) return null
  const output = execText('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.gnome.Shell',
    '--object-path',
    '/org/gnome/Shell',
    '--method',
    'org.gnome.Shell.Eval',
    'global.display.focus_window ? global.display.focus_window.get_title() : ""',
  ])
  if (!output) return null

  const match = output.match(/\(\s*(?:true|false)\s*,\s*'((?:\\'|[^'])*)'\s*\)/)
  const title = match?.[1]?.replace(/\\'/g, "'").trim()
  if (!title) return null

  const application = title.includes(' - ')
    ? title.split(' - ').pop()?.trim() || title
    : title

  return {
    title,
    application,
    path: application,
    pid: 0,
    icon: '',
  }
}

function parseXpropField(output: string, field: string): string {
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(field))
  if (!line) return ''
  return line.slice(line.indexOf('=') + 1).trim()
}

function parseXpropQuotedValue(value: string): string {
  const match = value.match(/"([^"]+)"/)
  return match?.[1] ?? value.trim()
}

function parseXpropQuotedValues(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter(Boolean)
}

function x11WindowDetails(windowId: string): {
  pid: number
  classTokens: string[]
  title: string
  gtkApplicationId: string
  bamfDesktopFile: string
} | null {
  if (!commandAvailable('xprop')) return null

  const output = execText('xprop', [
    '-id',
    windowId,
    '_NET_WM_PID',
    'WM_CLASS',
    '_NET_WM_NAME',
    'WM_NAME',
    '_GTK_APPLICATION_ID',
    '_BAMF_DESKTOP_FILE',
  ])
  if (!output) return null

  const pid = Number(parseXpropField(output, '_NET_WM_PID').match(/\d+/)?.[0] ?? '0')
  const classTokens = parseXpropQuotedValues(parseXpropField(output, 'WM_CLASS'))
  const titleField = parseXpropField(output, '_NET_WM_NAME')
    || parseXpropField(output, 'WM_NAME')

  return {
    pid,
    classTokens,
    title: parseXpropQuotedValue(titleField),
    gtkApplicationId: parseXpropQuotedValue(parseXpropField(output, '_GTK_APPLICATION_ID')),
    bamfDesktopFile: parseXpropQuotedValue(parseXpropField(output, '_BAMF_DESKTOP_FILE')),
  }
}

function xdotoolActiveWindow(): ActiveWinResult | null {
  if (!commandAvailable('xdotool')) return null
  const windowId = execText('xdotool', ['getactivewindow'])
  if (!windowId) return null

  const details = x11WindowDetails(windowId)
  const classTokens = details?.classTokens ?? []
  const title = execText('xdotool', ['getwindowname', windowId]) ?? details?.title ?? ''
  const pid = Number(execText('xdotool', ['getwindowpid', windowId]) ?? String(details?.pid ?? 0))
  const exePath = processExecutablePath(pid)
  const application = details?.gtkApplicationId
    || path.basename(details?.bamfDesktopFile ?? '')
    || classTokens[classTokens.length - 1]
    || classTokens[0]
    || processName(pid)
    || title
    || 'Unknown app'

  return {
    title: title || application,
    application,
    path: exePath || details?.bamfDesktopFile || details?.gtkApplicationId || application,
    pid,
    icon: '',
  }
}

function xpropActiveWindow(): ActiveWinResult | null {
  if (!commandAvailable('xprop')) return null

  const activeWindow = execText('xprop', ['-root', '_NET_ACTIVE_WINDOW'])
  const windowId = activeWindow?.match(/window id # (0x[0-9a-f]+)/i)?.[1] ?? null
  if (!windowId || windowId === '0x0') return null

  const details = x11WindowDetails(windowId)
  if (!details) return null

  const pid = details.pid
  const exePath = processExecutablePath(pid)
  const application = details.gtkApplicationId
    || path.basename(details.bamfDesktopFile)
    || details.classTokens[details.classTokens.length - 1]
    || details.classTokens[0]
    || processName(pid)
    || details.title
    || 'Unknown app'

  return {
    title: details.title || application,
    application,
    path: exePath || details.bamfDesktopFile || details.gtkApplicationId || application,
    pid,
    icon: '',
  }
}

function linuxShouldPreferFallback(): boolean {
  const desktop = linuxDesktopName()
  return linuxSessionType() === 'wayland'
    && (
      Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE)
      || Boolean(process.env.SWAYSOCK)
      || desktop.includes('hyprland')
      || desktop.includes('sway')
    )
}

function windowHasMeaningfulIdentity(win: Pick<ActiveWinResult, 'application' | 'path' | 'title'> | null): boolean {
  if (!win) return false
  return Boolean(win.application?.trim() || win.path?.trim() || win.title?.trim())
}

export function linuxFallbackActiveWindow(): { source: Exclude<TrackingModuleSource, 'package' | 'unpacked'>; win: ActiveWinResult | null; trace: string[] } | null {
  const trace: string[] = []
  const desktop = linuxDesktopName()
  const hyprlandSession = Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE) || desktop.includes('hyprland')
  const swaySession = Boolean(process.env.SWAYSOCK) || desktop.includes('sway')

  if (hyprlandSession) {
    const win = hyprlandActiveWindow()
    if (win) return { source: 'hyprctl', win, trace: ['hyprctl: focused window found'] }
    trace.push(commandAvailable('hyprctl') ? 'hyprctl: no active window returned' : 'hyprctl: command not found')
  }

  if (swaySession) {
    const win = swayActiveWindow()
    if (win) return { source: 'swaymsg', win, trace: ['swaymsg: focused window found'] }
    trace.push(commandAvailable('swaymsg') ? 'swaymsg: no focused node returned' : 'swaymsg: command not found')
  }

  const gnomeSession = desktop.includes('gnome') && linuxSessionType() === 'wayland'
  if (gnomeSession) {
    const win = gnomeShellActiveWindow()
    if (win) return { source: 'xdotool', win, trace: ['gdbus: GNOME Shell focused window found'] }
    trace.push(commandAvailable('gdbus') ? 'gdbus: GNOME Shell did not return a focused title' : 'gdbus: command not found')
  }

  if (process.env.DISPLAY) {
    const xdotoolWin = xdotoolActiveWindow()
    if (xdotoolWin) return { source: 'xdotool', win: xdotoolWin, trace: ['xdotool: focused window found'] }
    trace.push(commandAvailable('xdotool') ? 'xdotool: no active window returned' : 'xdotool: command not found')

    const xpropWin = xpropActiveWindow()
    if (xpropWin) return { source: 'xprop', win: xpropWin, trace: ['xprop: focused window found'] }
    trace.push(commandAvailable('xprop') ? 'xprop: no active window returned' : 'xprop: command not found')
  }

  return trace.length > 0 ? { source: 'xprop', win: null, trace } : null
}

// Test seam: lets a simulation drive the Linux active-window resolver with
// canned window-manager output (and pretend the helper commands exist) so the
// Linux capture path can be verified without a Linux host. Pass null to restore
// the real execFileSync-backed implementation.
export function __setLinuxCaptureTestHarness(
  harness: { exec: (command: string, args: string[]) => string | null; availableCommands: string[] } | null,
): void {
  commandAvailabilityCache.clear()
  if (!harness) {
    execTextImpl = execTextDefault
    return
  }
  execTextImpl = harness.exec
  for (const command of harness.availableCommands) commandAvailabilityCache.set(command, true)
}

function requireActiveWindowModule() {
  try {
    trackingStatus.moduleSource = 'package'
    return require('@paymoapp/active-window') // eslint-disable-line @typescript-eslint/no-require-imports
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
      return require(unpackedEntry) // eslint-disable-line @typescript-eslint/no-require-imports
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
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      trackingStatus.loadError = 'The active-window backend needs X11/XWayland (DISPLAY). Daylens will use compositor-specific Linux trackers when available.'
      _activeWindowInitFailed = true
      return null
    }
    try {
      const mod = requireActiveWindowModule()
      const ActiveWindow = mod.default ?? mod
      ActiveWindow.initialize()
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

export function requestTrackingPermission(): boolean | null {
  const awMod = getActiveWindowModule()
  if (!awMod || typeof awMod.requestPermissions !== 'function') return null
  try {
    return awMod.requestPermissions()
  } catch (err) {
    setPollHealth(formatError(err))
    console.warn('[tracking] failed to request permissions:', err)
    return null
  }
}

function resolveWindowIdentity(
  win: ActiveWinResult,
  platform: NodeJS.Platform = process.platform,
): ActiveWinResult & { bundleId: string; appName: string } {
  if (platform === 'linux') {
    return finalizeLinuxWindowIdentity(win)
  }

  const exeName = win.path ? windowsAwareBasename(win.path, platform) : ''
  const uwpPackage = win.windows?.isUWPApp ? win.windows.uwpPackage : ''
  const reportedAppName = win.application || ''
  const normalizedWindowsAppName = platform === 'win32'
    ? windowsBrowserExecutableAppName(reportedAppName, exeName)
    : reportedAppName
  const isWindowsUwp = platform === 'win32' && Boolean(win.windows?.isUWPApp && uwpPackage)
  const appName = isWindowsUwp
    ? windowsUwpDisplayName(uwpPackage, normalizedWindowsAppName || exeName)
    : (normalizedWindowsAppName || exeName || uwpPackage || 'Unknown app')
  // On macOS the two capture backends must mint ONE identity for the same
  // install: focus events report the real CFBundleIdentifier while the
  // active-window poll may only know the executable path. Resolve the path to
  // the bundle's own identifier before falling back to the raw path, so
  // Traycer is `com.traycer.app` from either backend instead of splitting into
  // a path-keyed twin (issue #22).
  const macBundleId = platform === 'darwin' && !win.bundleId && win.path
    ? resolveMacExecutableBundleId(win.path)
    : null
  const bundleId = win.bundleId
    || macBundleId
    || (isWindowsUwp ? uwpPackage : (win.path || uwpPackage || appName))
  return { ...win, bundleId, appName }
}

// Harness-aware indirection: scripted FSM tests resolve deterministically via
// the seam (or not at all when the harness omits it — the Info.plist of a
// fixture path must never depend on the machine running the suite).
function resolveMacExecutableBundleId(executablePath: string): string | null {
  if (fsmTestHarness) return fsmTestHarness.resolveMacBundleId?.(executablePath) ?? null
  return macBundleIdentifierForExecutablePath(executablePath)
}

// The focus-events backend carries the bundle id in the window's `path` field
// (see recentMacFocusEventWindow). Identity metadata must only record real
// filesystem paths — a bundle id overwriting the stored executablePath would
// erase the very mapping the twin dedupe relies on.
function executablePathForMetadata(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed) ? trimmed : null
}

function windowsAwareBasename(filePath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.win32.basename(filePath) : path.basename(filePath)
}

function windowsBrowserExecutableAppName(reportedAppName: string, exeName: string): string {
  if (!reportedAppName || !exeName) return reportedAppName
  const exeStem = exeName.replace(/\.exe$/i, '')
  if (reportedAppName.toLowerCase() !== exeStem.toLowerCase()) return reportedAppName
  if (!/^(?:msedge|chrome|firefox|brave|zen|arc|dia|comet|opera|vivaldi)$/i.test(exeStem)) return reportedAppName
  return exeName
}

function windowsUwpDisplayName(packageFamily: string, fallback: string): string {
  const trimmedFallback = fallback.trim()
  if (trimmedFallback && !/^applicationframehost(?:\.exe)?$/i.test(trimmedFallback)) return trimmedFallback

  const packageName = packageFamily.split('_')[0] || packageFamily
  const segments = packageName
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part, index) => {
      const lower = part.toLowerCase()
      if (index === 0 && lower === 'microsoft') return false
      return lower !== 'windows'
    })
  const labelParts = segments.length > 0 ? segments : [packageName]
  return labelParts
    .map((part) => part.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .join(' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || packageName
}

function recentMacFocusEventWindow(maxAgeMs = 15 * 60_000): MacFocusEventWindow | null {
  if (process.platform !== 'darwin') return null
  try {
    const row = getDb().prepare(`
      SELECT ts_ms, app_bundle_id, app_name, pid, window_title
      FROM focus_events
      WHERE (
          (source = 'nsworkspace_event' AND event_type IN ('app_activated', 'window_changed', 'space_changed'))
          OR (source = 'apple_events_tab' AND event_type IN ('tab_changed', 'tab_sampled'))
        )
        AND (app_bundle_id IS NOT NULL OR app_name IS NOT NULL)
      ORDER BY ts_ms DESC, id DESC
      LIMIT 1
    `).get() as {
      ts_ms: number
      app_bundle_id: string | null
      app_name: string | null
      pid: number | null
      window_title: string | null
    } | undefined

    if (!row || Date.now() - row.ts_ms > maxAgeMs) return null
    const application = row.app_name?.trim() || row.app_bundle_id?.trim() || 'Unknown app'
    const bundleId = row.app_bundle_id?.trim() || application
    const matchingCurrentSession = currentSession
      && (
        currentSession.bundleId === bundleId
        || currentSession.appName === application
        || currentSession.rawAppName === application
      )
    const stablePath = matchingCurrentSession && currentSession ? currentSession.bundleId : bundleId
    return {
      title: row.window_title?.trim() || application,
      application,
      path: stablePath,
      pid: row.pid ?? 0,
      icon: '',
      observedAt: row.ts_ms,
    }
  } catch {
    return null
  }
}

function normalizedMacAppToken(value: string | null | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return ''
  return path.basename(trimmed)
    .replace(/\.app$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function shouldPreferMacFocusEventWindow(
  activeWindow: Pick<ActiveWinResult, 'application' | 'path' | 'pid' | 'title'> | null,
  focusWindow: Pick<MacFocusEventWindow, 'application' | 'path' | 'pid' | 'title' | 'observedAt'> | null,
): boolean {
  if (!focusWindow) return false
  if (!windowHasMeaningfulIdentity(activeWindow)) return true

  const activeApp = normalizedMacAppToken(activeWindow?.application || activeWindow?.path)
  const focusApp = normalizedMacAppToken(focusWindow.application || focusWindow.path)
  if (activeApp && focusApp && activeApp !== focusApp) return true

  const activePid = activeWindow?.pid ?? 0
  const focusPid = focusWindow.pid ?? 0
  return Boolean(activePid && focusPid && activePid !== focusPid && !activeApp && !focusApp)
}

// ─── OS noise filter ─────────────────────────────────────────────────────────
// System processes that appear as "frontmost app" but are not user-initiated.
// Writing these to the DB creates junk sessions that inflate totals and
// pollute the category breakdown. The invisible-OS-identity list lives in
// @shared/systemNoise so capture, queries, projections, and the AI/MCP
// boundary all share one policy that can't drift between layers.

// Self-exclusion: only this app's own exe names, not all Electron-based apps.
// Previously matched 'electron' as a substring which filtered VS Code, Discord,
// Slack, Figma, and every other Electron app. Now uses exact exe name matching.
const SELF_NOISE_EXE_NAMES = new Set([
  'daylens',
  'daylens.exe',
  'daylens windows.exe',
  'daylenswindows.exe',
  'electron.exe',      // dev mode — raw electron runner, not a user app
  'electron',          // same runner on macOS (node_modules/electron/dist/Electron.app)
])

const DAYLENS_SELF_BUNDLE_IDS = new Set([
  'com.daylens.desktop',
  'com.daylens.app',
  'com.daylens.app.dev',
  'daylens',
  'daylens.desktop',
])

const DAYLENS_SELF_PROCESS_NAMES = new Set([
  'daylens',
  'daylens desktop',
  'daylens windows',
  'daylenswindows',
])

function normalizedSelfIdentity(value: string | null | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return ''
  const basename = path.basename(trimmed)
  return basename
    .replace(/\.app$/i, '')
    .replace(/\.appimage$/i, '')
    .replace(/\.desktop$/i, '')
    .replace(/\.exe$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function isDaylensSelfIdentity(bundleId: string, appName: string, rawAppName?: string | null, winPath?: string | null): boolean {
  const lowerBundleId = bundleId.trim().toLowerCase()
  if (DAYLENS_SELF_BUNDLE_IDS.has(lowerBundleId)) return true

  const appNameIdentity = normalizedSelfIdentity(appName)
  if (DAYLENS_SELF_PROCESS_NAMES.has(appNameIdentity)) return true

  const rawAppNameIdentity = normalizedSelfIdentity(rawAppName)
  if (DAYLENS_SELF_PROCESS_NAMES.has(rawAppNameIdentity)) return true

  const pathIdentity = normalizedSelfIdentity(winPath)
  if (DAYLENS_SELF_PROCESS_NAMES.has(pathIdentity)) return true

  return false
}

// A watched video, a live call, an online class, or a long course/reading page
// is presence, not idle. See `passivePresence.ts`. Held open through a no-input
// stretch so a 2-hour Meet class or a Coursera morning is not flushed away at
// the 5-minute idle cutoff. 'media' holds are open-ended (playback proves
// presence) and end at the lock/sleep event itself; 'reading' holds are bounded
// by READING_HOLD_MAX_SEC and end back at the last real input, because reading
// cannot prove the user stayed.
function sessionPassiveHoldKind(session: InFlightSession): PassiveHoldKind | null {
  return passivePresenceHoldKind(session)
}

function looksLikePassiveMediaSession(session: InFlightSession): boolean {
  return sessionPassiveHoldKind(session) === 'media'
}

// Whether a no-input stretch of `idleSec` should keep the session open.
function passiveHoldActive(session: InFlightSession, idleSec: number): boolean {
  const kind = sessionPassiveHoldKind(session)
  if (kind === 'media') return true
  return kind === 'reading' && idleSec < READING_HOLD_MAX_SEC
}

export function trackedForegroundSessionExclusionReason(
  session: Pick<Omit<AppSession, 'id'>, 'bundleId' | 'appName' | 'windowTitle' | 'rawAppName'> & { executablePath?: string | null },
): string | null {
  if (isDaylensSelfIdentity(session.bundleId, session.appName, session.rawAppName, session.executablePath)) {
    return 'daylens_self_capture'
  }
  if (session.windowTitle?.trimStart().startsWith('Daylens:')) {
    return 'daylens_project_title'
  }
  return null
}

function isOsNoise(bundleId: string, appName: string, winPath?: string): boolean {
  if (isSystemNoiseApp({ bundleId, appName })) return true
  const lowerName = appName.toLowerCase()
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
let lastSnapshotPersistAt = 0
type IdleState = 'active' | 'provisional_idle' | 'away'
let idleState: IdleState = 'active'
let provisionalIdleStart: number | null = null
// Row id of the idle_start event that opened the current provisional idle, and
// whether that event already carries heldForMediaPlayback. Production always
// crosses the 2-minute threshold (plain idle_start) before the 5-minute media
// hold decision, so the hold upgrades the open event in place — consumers
// (attribution idle exclusion, work-block gap labels) read the flag off it.
let provisionalIdleEventId: number | null = null
let provisionalIdleHeldForMedia = false
// True last-input time captured on the poll where the user returns from
// away/provisional_idle, consumed by the next session start so its boundary is
// stamped from real input rather than the poll wall-clock (two-clock fix).
let returnFromIdleAtMs: number | null = null
// End boundary of the most recently flushed session. A restamped start is
// clamped to be ≥ this so sessions never overlap backwards.
let lastFlushEndMs: number | null = null
// Wall-clock time of the previous completed poll tick, for sleep-gap
// detection. Null until the first poll after start/reset.
let lastPollTickMs: number | null = null
let powerMonitorListenersRegistered = false
const trackingTickListeners = new Set<() => void>()
const ATTRIBUTION_REFRESH_DEBOUNCE_MS = 3_000
const pendingAttributionDates = new Set<string>()
let attributionRefreshTimer: ReturnType<typeof setTimeout> | null = null

function emitTrackingTick(): void {
  for (const listener of trackingTickListeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[tracking] tick listener failed:', error)
    }
  }
}

export function onTrackingTick(listener: () => void): () => void {
  trackingTickListeners.add(listener)
  return () => {
    trackingTickListeners.delete(listener)
  }
}

function attributionDateKeysForRange(startTime: number, endTime: number): string[] {
  const startDate = localDateString(new Date(startTime))
  const endDate = localDateString(new Date(Math.max(startTime, endTime - 1)))
  if (startDate === endDate) return [startDate]

  const dates: string[] = []
  const cursor = new Date(startTime)
  cursor.setHours(0, 0, 0, 0)
  const end = new Date(Math.max(startTime, endTime - 1))
  end.setHours(0, 0, 0, 0)
  while (cursor <= end) {
    dates.push(localDateString(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return dates
}

function flushPendingAttributionRefresh(): void {
  attributionRefreshTimer = null
  const dates = Array.from(pendingAttributionDates)
  pendingAttributionDates.clear()
  if (dates.length === 0) return

  const db = getDb()
  for (const date of dates) {
    const [fromMs, toMs] = localDayBounds(date)
    try {
      runAttributionForRange(fromMs, toMs, {}, db)
      invalidateProjectionScope('apps', 'attribution_refreshed', { date })
      invalidateProjectionScope('insights', 'attribution_refreshed', { date })
    } catch (err) {
      console.warn('[tracking] attribution refresh failed:', err)
      captureRateLimited(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, 'tracking:attribution-refresh', {
        failure_kind: classifyFailureKind(err),
        reason: 'attribution_refresh_failed',
        status: 'error',
        surface: 'tracking',
      })
    }
  }
}

function scheduleAttributionRefreshForSession(startTime: number, endTime: number): void {
  for (const date of attributionDateKeysForRange(startTime, endTime)) {
    pendingAttributionDates.add(date)
  }
  if (attributionRefreshTimer) return
  attributionRefreshTimer = setTimeout(flushPendingAttributionRefresh, ATTRIBUTION_REFRESH_DEBOUNCE_MS)
}

function persistLiveSnapshot(force = false): void {
  if (!currentSession) return

  const now = Date.now()
  if (!force && now - lastSnapshotPersistAt < SNAPSHOT_PERSIST_MS) return

  try {
    upsertLiveAppSessionSnapshot(getDb(), {
      bundleId: currentSession.bundleId,
      appName: currentSession.appName,
      windowTitle: currentSession.windowTitle,
      rawAppName: currentSession.rawAppName,
      canonicalAppId: currentSession.canonicalAppId,
      appInstanceId: currentSession.appInstanceId,
      captureSource: currentSession.captureSource,
      category: currentSession.category,
      startTime: currentSession.startTime,
      lastSeenAt: now,
    })
    lastSnapshotPersistAt = now
  } catch (err) {
    console.warn('[tracking] failed to persist live snapshot:', err)
  }
}

function clearPersistedLiveSnapshot(): void {
  try {
    clearLiveAppSessionSnapshot(getDb())
  } catch (err) {
    console.warn('[tracking] failed to clear live snapshot:', err)
  }
  lastSnapshotPersistAt = 0
}

function recoverPersistedLiveSnapshot(): void {
  try {
    const db = getDb()
    const snapshot = getLiveAppSessionSnapshot(db)
    if (!snapshot) return

    const endTime = Math.min(nowMs(), Math.max(snapshot.lastSeenAt, snapshot.startTime))

    // Per-day slices drive identity observations and projection invalidation
    // for every calendar day the recovered session touched; day ownership of
    // the cross-midnight stretch itself is decided by the canonical record.
    const slices: Array<{ startMs: number; endMs: number }> = []
    let sliceStart = snapshot.startTime
    while (localDateString(new Date(sliceStart)) !== localDateString(new Date(endTime))) {
      const [, midnightMs] = localDayBounds(localDateString(new Date(sliceStart)))
      slices.push({ startMs: sliceStart, endMs: midnightMs })
      sliceStart = midnightMs
    }
    slices.push({ startMs: sliceStart, endMs: endTime })

    // Legacy app_sessions writes are retired (capture migration slice 10).
    // Recovery persists nothing per-slice; the recovered deactivation event
    // emitted below closes the canonical span, and the projection derives the
    // recovered session from focus_events alone.
    let recovered = false
    if (trackedForegroundSessionExclusionReason({
      bundleId: snapshot.bundleId,
      appName: snapshot.appName,
      windowTitle: snapshot.windowTitle,
      rawAppName: snapshot.rawAppName,
    }) === null) {
      const { category } = classifyResult(snapshot.bundleId, snapshot.appName)
      for (const slice of slices) {
        const durationSeconds = Math.max(0, Math.round((slice.endMs - slice.startMs) / 1_000))
        if (durationSeconds < MIN_SESSION_SEC) continue
        recovered = true
        upsertAppIdentityObservation(db, {
          bundleId: snapshot.bundleId,
          rawAppName: snapshot.rawAppName,
          appInstanceId: snapshot.appInstanceId,
          observedCategory: category,
          firstSeenAt: slice.startMs,
          lastSeenAt: slice.endMs,
        })
        invalidateProjectionScope('timeline', 'activity_recorded', {
          date: localDateString(new Date(slice.endMs)),
        })
        invalidateProjectionScope('apps', 'activity_recorded', {
          canonicalAppId: snapshot.canonicalAppId,
        })
        invalidateProjectionScope('insights', 'activity_recorded', {
          date: localDateString(new Date(slice.endMs)),
        })
        scheduleAttributionRefreshForSession(slice.startMs, slice.endMs)
      }
    }
    if (recovered) {
      recordPollForegroundEvent('app_deactivated', {
        tsMs: endTime,
        bundleId: snapshot.bundleId,
        appName: snapshot.appName,
        pid: null,
        windowTitle: snapshot.windowTitle,
      }, trackingPlatform())
      console.log('[tracking] recovered live session snapshot after restart')
    }

    clearPersistedLiveSnapshot()
  } catch (err) {
    console.warn('[tracking] failed to recover live snapshot:', err)
  }
}

function handleLockScreen(): void {
  const endMs = currentSession && looksLikePassiveMediaSession(currentSession)
    ? undefined
    : provisionalIdleStart ?? undefined
  if (currentSession) {
    // Ordinary idle ends at the last input; passive media ends at the lock.
    flushCurrent(endMs, 'lock_screen')
    console.log('[tracking] screen locked — session flushed')
  }
  flushActiveBrowserContext(getDb(), endMs)
  recordActivityEvent('lock_screen')
  idleState = 'away'
  provisionalIdleStart = null
}

function handleSuspend(): void {
  const endMs = currentSession && looksLikePassiveMediaSession(currentSession)
    ? undefined
    : provisionalIdleStart ?? undefined
  if (currentSession) {
    flushCurrent(endMs, 'suspend')
    console.log('[tracking] system suspended — session flushed')
  }
  flushActiveBrowserContext(getDb(), endMs)
  recordActivityEvent('suspend')
  idleState = 'away'
  provisionalIdleStart = null
}

// Wake-side belt-and-braces: lid-close sleep has been observed to skip the
// suspend/lock-screen events entirely, so the open session may still be
// carrying the whole sleep. End it at the last evidence of activity; the
// poll-level gap check catches the same hole if these events don't fire
// either.
function cutSessionAfterWake(reason: 'unlock_screen' | 'resume'): void {
  if (!currentSession) return
  const endMs = looksLikePassiveMediaSession(currentSession)
    ? lastPollTickMs ?? undefined
    : provisionalIdleStart ?? lastPollTickMs ?? undefined
  flushCurrent(endMs, reason)
  flushActiveBrowserContext(getDb(), endMs)
  idleState = 'away'
  provisionalIdleStart = null
  console.log(`[tracking] ${reason} with a session still open — flushed at last activity`)
}

function handleUnlockScreen(): void {
  cutSessionAfterWake('unlock_screen')
  recordActivityEvent('unlock_screen')
}

function handleResume(): void {
  cutSessionAfterWake('resume')
  recordActivityEvent('resume')
}

// Legacy activity-state names → canonical focus-event kinds, emitted at the
// same call site with the same timestamp so the two records can be compared.
// Provisional idle_start/idle_end stay legacy-only: a provisional idle can be
// cancelled by a return, so the committed canonical boundary is away_start.
const CANONICAL_MACHINE_STATE: Partial<Record<string, PollMachineStateEventType>> = {
  lock_screen: 'lock',
  unlock_screen: 'unlock',
  suspend: 'sleep',
  resume: 'wake',
}

function recordActivityEvent(
  eventType: 'idle_start' | 'idle_end' | 'away_start' | 'away_end' | 'lock_screen' | 'unlock_screen' | 'suspend' | 'resume',
  metadata: Record<string, unknown> = {},
  // Backdated events (a sleep gap discovered on the first poll after wake)
  // pass the true boundary; live events default to now.
  eventTs: number = Date.now(),
  // Returns the activity_state_events row id (null when the insert failed) so
  // the poll FSM can later upgrade a provisional idle_start in place.
): number | null {
  let eventId: number | null = null
  try {
    eventId = recordActivityStateEvent(getDb(), {
      eventTs,
      eventType,
      source: 'tracking',
      metadata,
    })
  } catch (err) {
    console.warn('[tracking] failed to record activity event:', err)
  }
  const machineState = CANONICAL_MACHINE_STATE[eventType]
  if (machineState) {
    recordPollMachineStateEvent(machineState, eventTs, trackingPlatform())
  } else if (eventType === 'away_start') {
    recordSupervisorEvent('idle_started', eventTs)
  } else if (eventType === 'away_end') {
    recordSupervisorEvent('idle_ended', eventTs)
  }
  return eventId
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startTracking(): void {
  if (pollTimer) return
  recoverPersistedLiveSnapshot()
  if (!powerMonitorListenersRegistered) {
    powerMonitor.on('lock-screen', handleLockScreen)
    powerMonitor.on('unlock-screen', handleUnlockScreen)
    powerMonitor.on('suspend', handleSuspend)
    powerMonitor.on('resume', handleResume)
    powerMonitorListenersRegistered = true
  }
  recordSupervisorEvent('capture_started', Date.now())
  // Fire immediately — don't wait 5 s for the first data point
  void poll()
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  capture(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, {
    module_source: trackingStatus.moduleSource,
    status: 'started',
    surface: 'tracking',
  })
  console.log('[tracking] started')
}

export function recordTrackingPauseTransition(
  paused: boolean,
  source: 'settings' | 'tray',
  eventTs: number = Date.now(),
): void {
  if (paused && currentSession) flushCurrent(eventTs, 'tracking_paused')
  try {
    recordActivityStateEvent(getDb(), {
      eventTs,
      eventType: paused ? 'tracking_paused' : 'tracking_resumed',
      source,
    })
  } catch {
    // The persisted setting still gates capture if evidence storage is unavailable.
  }
  recordSupervisorEvent(paused ? 'capture_paused' : 'capture_resumed', eventTs)
  captureTrackingPauseTransition(paused, 'user')
}

export function stopTracking(): void {
  // A stop with no tracker running (e.g. shutdown before capture ever
  // started) is not a capture-state transition — record nothing.
  const wasRunning = pollTimer != null
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (powerMonitorListenersRegistered) {
    powerMonitor.removeListener('lock-screen', handleLockScreen)
    powerMonitor.removeListener('unlock-screen', handleUnlockScreen)
    powerMonitor.removeListener('suspend', handleSuspend)
    powerMonitor.removeListener('resume', handleResume)
    powerMonitorListenersRegistered = false
  }
  flushCurrent()
  flushActiveBrowserContext(getDb())
  if (wasRunning) recordSupervisorEvent('capture_stopped', Date.now())
  idleState = 'active'
  provisionalIdleStart = null
  returnFromIdleAtMs = null
  lastPollTickMs = null
  console.log('[tracking] stopped')
}

export function getCurrentSession(): LiveSession | null {
  return currentSession
}

// Close out the in-flight session to the DB right now, giving it a real id. A
// merge that includes the still-live block has nothing stable to pin its
// boundary correction to (the live session is ephemeral, id -1), so the merge
// would re-split on the next tick. Flushing first turns the live block into a
// persisted block the merge can anchor on. The next poll starts a fresh session.
export function flushCurrentSession(): void {
  flushCurrent(undefined, 'user_merge')
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

// Test seam: drives the idle/session FSM with a scripted clock, idle timer, and
// active-window result so the return → idle → away lifecycle can be exercised
// without a real desktop, the native active-window module, or wall-clock time.
// `recordFlush` (optional) observes every flush's final bounds so a test can
// assert the end ≥ start invariant. Production reads go through nowMs() /
// getIdleSeconds() / the real capture path unchanged when this is null.
interface TrackingFsmTestHarness {
  now: () => number
  idleSeconds: () => number
  activeWindow: () => ActiveWinResult | null
  platform?: NodeJS.Platform
  /** macOS executable path → CFBundleIdentifier, standing in for the
   *  Info.plist read so identity unification is scriptable off-macOS.
   *  Omitted → the harness resolves nothing (legacy path-keyed behavior). */
  resolveMacBundleId?: (executablePath: string) => string | null
  recordFlush?: (info: {
    startTime: number
    endTime: number
    durationSeconds: number
    endedReason: string | null
    persisted: boolean
    bundleId: string
    appName: string
    rawAppName: string | null
    category: AppCategory
  }) => void
}
let fsmTestHarness: TrackingFsmTestHarness | null = null

export function __setTrackingFsmTestHarness(harness: TrackingFsmTestHarness | null): void {
  fsmTestHarness = harness
  // Reset all FSM state so each scripted scenario starts from a clean slate.
  currentSession = null
  idleState = 'active'
  provisionalIdleStart = null
  provisionalIdleEventId = null
  provisionalIdleHeldForMedia = false
  returnFromIdleAtMs = null
  lastFlushEndMs = null
  lastPollTickMs = null
  lastSnapshotPersistAt = 0
  if (attributionRefreshTimer) {
    clearTimeout(attributionRefreshTimer)
    attributionRefreshTimer = null
  }
  pendingAttributionDates.clear()
}

// Test-only single-poll driver. Production drives poll() on the interval timer.
export function __pollForTest(): Promise<void> {
  return poll()
}

// Test-only recovery driver: production runs it once inside startTracking(),
// which needs the real powerMonitor and interval timer.
export function __recoverPersistedLiveSnapshotForTest(): void {
  recoverPersistedLiveSnapshot()
}

function nowMs(): number {
  return fsmTestHarness ? fsmTestHarness.now() : Date.now()
}

function trackingPlatform(): NodeJS.Platform {
  return fsmTestHarness?.platform ?? process.platform
}

function getIdleSeconds(): number {
  if (!fsmTestHarness && process.env.DAYLENS_SMOKE_TEST === '1') return 0
  return fsmTestHarness ? fsmTestHarness.idleSeconds() : powerMonitor.getSystemIdleTime()
}

async function poll(): Promise<void> {
  try {
    // ── Sleep-gap detection ──────────────────────────────────────────────────
    // Interval timers freeze while the machine sleeps, so a sleep shows up as
    // one poll tick landing far beyond the last. Everything inside that hole
    // was absence: end the open session at the last evidence of activity (the
    // provisional-idle input boundary when we were already idle, else the last
    // completed tick) and log the hole as away so website reconciliation
    // excludes it too. This is the primary sleep signal — the powerMonitor
    // suspend/lock events have been observed not to fire on lid-close.
    const tickMs = nowMs()
    if (lastPollTickMs != null && tickMs - lastPollTickMs > GAP_FLUSH_MS) {
      const gapStartMs = currentSession && looksLikePassiveMediaSession(currentSession)
        ? lastPollTickMs
        : provisionalIdleStart ?? lastPollTickMs
      if (currentSession) {
        flushCurrent(gapStartMs, 'sleep_gap')
        console.log(`[tracking] ${Math.round((tickMs - gapStartMs) / 1000)}s poll gap — session flushed at last activity`)
      }
      flushActiveBrowserContext(getDb(), gapStartMs)
      // Backdate the absence start to where activity really ended; the normal
      // return-from-away path below emits the matching away_end this tick.
      recordActivityEvent('away_start', { inferredFrom: 'poll_gap', gapMs: tickMs - lastPollTickMs }, gapStartMs)
      idleState = 'away'
      provisionalIdleStart = null
    }
    lastPollTickMs = tickMs

    // ── Idle detection ───────────────────────────────────────────────────────
    const idleSec = getIdleSeconds()
    if (idleSec >= AWAY_THRESHOLD_SEC) {
      if (currentSession && passiveHoldActive(currentSession, idleSec)) {
        const holdKind = sessionPassiveHoldKind(currentSession)
        if (idleState === 'active') {
          provisionalIdleStart = nowMs() - Math.round(idleSec) * 1_000
          idleState = 'provisional_idle'
          provisionalIdleEventId = recordActivityEvent('idle_start', { idleSeconds: Math.round(idleSec), heldForMediaPlayback: true, holdKind })
          provisionalIdleHeldForMedia = true
          console.log(`[tracking] idle ${Math.round(idleSec)}s during passive ${holdKind} presence — session held open`)
        } else if (idleState === 'provisional_idle' && !provisionalIdleHeldForMedia) {
          // Production reaches the away threshold via provisional_idle (the
          // 2-minute branch below fires first), so the plain idle_start is
          // already on record. Upgrade it in place — otherwise the hold is
          // invisible and attribution slices the held media span out.
          try {
            if (provisionalIdleEventId != null) {
              markActivityStateEventHeldForMediaPlayback(getDb(), provisionalIdleEventId)
            } else {
              provisionalIdleEventId = recordActivityEvent('idle_start', { idleSeconds: Math.round(idleSec), heldForMediaPlayback: true, holdKind }, provisionalIdleStart ?? undefined)
            }
            provisionalIdleHeldForMedia = true
          } catch (err) {
            console.warn('[tracking] failed to mark idle_start as passive-presence hold:', err)
          }
          console.log(`[tracking] idle ${Math.round(idleSec)}s during passive ${holdKind} presence — provisional idle upgraded to hold`)
        }
      } else {
        if (idleState !== 'away' && currentSession) {
          const idleStartMs = provisionalIdleStart ?? (nowMs() - Math.round(idleSec) * 1_000)
          if (idleState !== 'provisional_idle') {
            recordActivityEvent('away_start', { idleSeconds: Math.round(idleSec) }, idleStartMs)
          } else {
            recordSupervisorEvent('idle_started', idleStartMs)
          }
          flushCurrent(idleStartMs, 'away')
          flushActiveBrowserContext(getDb(), idleStartMs)
          console.log(`[tracking] user away ${Math.round(idleSec)}s — session flushed`)
        }
        idleState = 'away'
        provisionalIdleStart = null
        return
      }
    } else if (idleSec >= IDLE_THRESHOLD_SEC) {
      if (idleState === 'active') {
        provisionalIdleStart = nowMs() - Math.round(idleSec) * 1_000
        idleState = 'provisional_idle'
        provisionalIdleEventId = recordActivityEvent('idle_start', { idleSeconds: Math.round(idleSec) })
        provisionalIdleHeldForMedia = false
        console.log(`[tracking] provisional idle at ${Math.round(idleSec)}s — session held open`)
      }
    } else {
      if (idleState === 'away' || idleState === 'provisional_idle') {
        // Returning from provisional_idle: the session was intentionally held open
        // through the 2–5 min idle window to avoid fragmenting media playback.
        // The idle time is attributed to the session — this is the desired behaviour.
        // Returning from away: session was already flushed, a new one will start below.
        console.log(`[tracking] user returned from ${idleState}`)
        recordActivityEvent(idleState === 'away' ? 'away_end' : 'idle_end')
        // Stamp the true last-input time for the session that starts on this poll.
        // idleSec here is <120s (< IDLE_THRESHOLD_SEC), so this at most back-dates
        // the start by the sub-grace input gap — never into counted idle time. The
        // session-start clamp to lastFlushEndMs keeps this from overlapping the
        // previously flushed session (e.g. an app switch during provisional_idle).
        returnFromIdleAtMs = nowMs() - Math.round(idleSec) * 1_000
      }
      idleState = 'active'
      provisionalIdleStart = null
    }

    // ── Active window ────────────────────────────────────────────────────────
    let win: ActiveWinResult | null = null
    let backend = trackingStatus.moduleSource ?? 'unknown'
    const backendTrace: string[] = []

    if (fsmTestHarness) {
      win = fsmTestHarness.activeWindow()
      backend = 'test'
    } else if (process.platform === 'linux') {
      const preferFallback = linuxShouldPreferFallback()
      const support = getLinuxTrackingDiagnostics()
      let fallback: ReturnType<typeof linuxFallbackActiveWindow> = null

      if (preferFallback) {
        fallback = linuxFallbackActiveWindow()
        if (fallback) backendTrace.push(...fallback.trace)
        if (fallback?.win) {
          trackingStatus.moduleSource = fallback.source
          trackingStatus.loadError = null
          backend = fallback.source
          win = fallback.win
        }
      }

      if (!win && process.env.DISPLAY) {
        const awMod = getActiveWindowModule()
        if (awMod) {
          try {
            const activeWindowWin = awMod.getActiveWindow() as ActiveWinResult | null
            if (windowHasMeaningfulIdentity(activeWindowWin)) {
              win = activeWindowWin
              backend = trackingStatus.moduleSource ?? 'unknown'
              backendTrace.push(`active-window (${backend}): focused window found`)
            } else {
              backendTrace.push(`active-window (${trackingStatus.moduleSource ?? 'unknown'}): returned an incomplete window`)
            }
          } catch (err) {
            backendTrace.push(`active-window (${trackingStatus.moduleSource ?? 'unknown'}): ${formatError(err)}`)
          }
        } else if (trackingStatus.loadError) {
          backendTrace.push(`active-window: ${trackingStatus.loadError}`)
        }
      } else if (!process.env.DISPLAY) {
        backendTrace.push('active-window: skipped because DISPLAY is unavailable')
      }

      if (!win) {
        fallback = fallback ?? linuxFallbackActiveWindow()
        if (fallback && (!preferFallback || !fallback.trace.every((entry) => backendTrace.includes(entry)))) {
          backendTrace.push(...fallback.trace)
        }
        if (fallback?.win) {
          trackingStatus.moduleSource = fallback.source
          trackingStatus.loadError = null
          backend = fallback.source
          win = fallback.win
        }
      }

      trackingStatus.backendTrace = backendTrace.length > 0
        ? backendTrace.slice(-8)
        : (support ? [support.supportMessage] : [])

      // An unsupported session that produced no window is a capture-health
      // fact, not an empty poll: report it once through the canonical
      // capture_failed / capture_recovered transition instead of letting the
      // generic no-window return below mark the poll healthy. Silent partial
      // capture is exactly what the evidence contract forbids on Linux.
      if (!win && support?.supportLevel === 'unsupported') {
        flushActiveBrowserContext(getDb())
        if (currentSession) { currentSession.passivePresence = false; currentSession.passiveHold = null }
        setPollHealth(support.supportMessage)
        trackingStatus.lastRawWindow = null
        trackingStatus.lastResolvedWindow = null
        return
      }
    } else {
      const awMod = getActiveWindowModule()
      if (!awMod) {
        win = recentMacFocusEventWindow()
        backend = win ? 'focus_events' : backend
        if (!win) {
          flushActiveBrowserContext(getDb())
          if (currentSession) { currentSession.passivePresence = false; currentSession.passiveHold = null }
          return
        }
      }

      if (awMod) {
        try {
          const activeWindowWin = awMod.getActiveWindow() as ActiveWinResult | null
          const fallback = recentMacFocusEventWindow()
          if (shouldPreferMacFocusEventWindow(activeWindowWin, fallback)) {
            win = fallback
            backend = 'focus_events'
          } else {
            win = activeWindowWin
            if (!windowHasMeaningfulIdentity(win) && fallback) {
              win = fallback
              backend = 'focus_events'
            }
          }
        } catch (err) {
          const fallback = recentMacFocusEventWindow()
          if (fallback) {
            win = fallback
            backend = 'focus_events'
          } else {
            flushActiveBrowserContext(getDb())
            if (currentSession) { currentSession.passivePresence = false; currentSession.passiveHold = null }
            setPollHealth(formatError(err))
            captureRateLimited(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, 'tracking:get-active-window', {
              failure_kind: classifyFailureKind(err),
              reason: 'poll',
              status: 'error',
              surface: 'tracking',
            })
            return
          }
        }
      }
    }

    if (!win) {
      flushActiveBrowserContext(getDb())
      if (currentSession) { currentSession.passivePresence = false; currentSession.passiveHold = null }
      setPollHealth(null)
      trackingStatus.lastRawWindow = null
      trackingStatus.lastResolvedWindow = null
      return
    }

    if (process.platform === 'darwin' && (!win.title?.trim() || win.title.trim() === win.application.trim())) {
      const nativeWindow = recentMacFocusEventWindow()
      if (
        nativeWindow?.title?.trim()
        && (
          nativeWindow.application === win.application
          || nativeWindow.path === win.path
          || nativeWindow.pid === win.pid
        )
      ) {
        win = { ...win, title: nativeWindow.title }
        backend = `${backend}+focus_title`
      }
    }

    setPollHealth(null)
    trackingStatus.lastRawWindow = {
      title: win.title,
      application: win.application,
      path: win.path,
      pid: win.pid,
      isUWPApp: win.windows?.isUWPApp ?? false,
      uwpPackage: win.windows?.uwpPackage ?? '',
    }

    const resolvedWin = resolveWindowIdentity(win, fsmTestHarness?.platform)
    const browserApplication = resolveBrowserApplication({
      bundleId: resolvedWin.bundleId,
      appName: resolvedWin.appName,
      executablePath: resolvedWin.path,
    })
    const bundleId = browserApplication?.bundleId ?? resolvedWin.bundleId
    const appName = browserApplication?.name ?? resolvedWin.appName
    const rawResolvedTitle = resolvedWin.title?.trim() || null
    // 1A capture-side hygiene: when a browser app's window title contains a
    // URL token, strip query/fragment (and the path for non-allowlisted hosts)
    // before it lands in app_sessions. The full URL still flows into
    // website_visits.url via the browser-history reader.
    const isBrowserApp = Boolean(browserApplication)
      || resolveCanonicalApp(bundleId, appName).defaultCategory === 'browsing'
    const resolvedWindowTitle = stripBrowserUrlFromTitle(rawResolvedTitle, isBrowserApp)
    trackingStatus.lastResolvedWindow = {
      backend,
      bundleId,
      appName,
      title: resolvedWin.title,
      pid: resolvedWin.pid,
      path: resolvedWin.path,
    }
    const resolvedIdentity = resolveCanonicalApp(bundleId, appName)
    const identity = browserApplication && !resolvedIdentity.canonicalAppId
      ? {
          ...resolvedIdentity,
          canonicalAppId: browserApplication.bundleId.toLowerCase(),
          displayName: browserApplication.name,
          defaultCategory: 'browsing' as const,
        }
      : resolvedIdentity

    const exclusionReason = trackedForegroundSessionExclusionReason({
      bundleId,
      appName,
      windowTitle: resolvedWindowTitle,
      rawAppName: appName,
      executablePath: resolvedWin.path,
    })
    if (exclusionReason) {
      if (currentSession) flushCurrent(undefined, exclusionReason)
      flushActiveBrowserContext(getDb())
      clearPersistedLiveSnapshot()
      return
    }

    // T3: user Tracking Controls. When OFF and not paused this is a passthrough
    // (capture unchanged). Otherwise a paused tracker, an excluded app, or an
    // incognito window (by title) is dropped exactly like the exclusions above —
    // no app session AND no browser context for this foreground window.
    const trackingDecision = decideAppCapture(
      trackingControlsStateFromSettings(getSettings()),
      { bundleId, canonicalAppId: identity.canonicalAppId, appName, windowTitle: resolvedWindowTitle },
    )
    if (!trackingDecision.capture) {
      if (currentSession) flushCurrent(undefined, `tracking_controls:${trackingDecision.reason}`)
      flushActiveBrowserContext(getDb())
      clearPersistedLiveSnapshot()
      return
    }

    // Skip OS infrastructure processes — by app identity, or by a window title
    // that belongs to the OS itself (lock screen, notification toast) even when
    // the reported process looks like a normal app. Either way the time is not
    // work and must not accumulate (invariant 11).
    if (isOsNoise(bundleId, appName, resolvedWin.path) || isSystemNoiseTitle(resolvedWindowTitle)) {
      if (currentSession) flushCurrent(undefined, 'system_noise')
      flushActiveBrowserContext(getDb())
      clearPersistedLiveSnapshot()
      return
    }

    if (process.platform === 'win32' && getRecentWindowsPrivateWindowSignal({
      bundleId,
      appName,
      pid: resolvedWin.pid,
      windowTitle: resolvedWindowTitle,
      nowMs: tickMs,
    })) {
      if (currentSession) flushCurrent(undefined, 'incognito')
      flushActiveBrowserContext(getDb())
      clearPersistedLiveSnapshot()
      return
    }

    // Browser context is sampled BEFORE any session is created or continued,
    // because the tab read is also the private-window signal: an incognito
    // window must produce no website visit AND no app session — this applies
    // regardless of the Tracking Controls master switch; the opt-in title
    // gate above stays for parity with user exclusions.
    // For non-browser apps this call flushes whatever browser context was open.
    const browserSample = recordActiveBrowserContextSample(getDb(), {
      bundleId,
      appName: identity.displayName,
      windowTitle: resolvedWindowTitle,
      capturedAt: tickMs,
      executablePath: resolvedWin.path,
    })
    if (browserSample.isPrivate) {
      if (currentSession) flushCurrent(undefined, 'incognito')
      clearPersistedLiveSnapshot()
      return
    }
    if (browserSample.captureBlockReason) {
      if (currentSession) flushCurrent(undefined, `tracking_controls:${browserSample.captureBlockReason}`)
      clearPersistedLiveSnapshot()
      return
    }

    // Unverifiable window mode (capture spec, private-window rule): only
    // browser identity and timing may persist. The raw title stays available
    // above for incognito detection and exclusion checks, but nothing past
    // this point may store it — not the session, not focus events.
    const persistedWindowTitle = browserSample.windowModeUnverified ? null : resolvedWindowTitle

    // Consume the one-shot return-from-idle signal set earlier this poll. It
    // applies only to a session that starts on this same poll; anything that
    // doesn't start a session (excluded/noise apps returned above, or a session
    // that continues unchanged) must not carry it forward to a later poll.
    const returnedAtMs = returnFromIdleAtMs
    returnFromIdleAtMs = null

    // App switched → flush the previous session
    if (currentSession && currentSession.bundleId !== bundleId) {
      flushCurrent(undefined, 'app_switch')
    }

    // Start a new session if none is in-flight for this app
    if (!currentSession || currentSession.bundleId !== bundleId) {
      // Two-clock fix: when this session is born on a return from away/idle,
      // stamp its start from the true last-input time rather than the poll
      // wall-clock, clamped to the previous flush end so sessions never overlap.
      // Otherwise the away/idle end (input-derived) can predate a poll-stamped
      // start and the session gets silently discarded on flush.
      const bornOnIdleReturn = returnedAtMs != null
      const startedAt = bornOnIdleReturn
        ? Math.max(returnedAtMs, lastFlushEndMs ?? 0)
        : nowMs()
      const category = identity.defaultCategory ?? classifyApp(bundleId, appName)
      currentSession = {
        bundleId,
        appName: identity.displayName,
        windowTitle: persistedWindowTitle,
        rawAppName: appName,
        canonicalAppId: identity.canonicalAppId,
        appInstanceId: identity.appInstanceId,
        captureSource: process.platform === 'linux' && backend !== 'package' && backend !== 'unpacked'
          ? `foreground_poll:${backend}`
          : 'foreground_poll',
        startTime: startedAt,
        category,
        passivePresence: browserSample.passivePresence,
        passiveHold: browserSample.passiveHold ?? null,
        bornOnIdleReturn,
        windowTitles: [{ title: persistedWindowTitle, ticks: 1 }],
      }
      // Canonical mirror of this observation. Daylens' own windows are
      // rejected before persistence on the legacy path (flush time); reject
      // them here at activation time for the same reason.
      if (!trackedForegroundSessionExclusionReason({
        bundleId,
        appName: identity.displayName,
        windowTitle: persistedWindowTitle,
        rawAppName: appName,
        executablePath: resolvedWin.path?.trim() || null,
      })) {
        recordPollForegroundEvent('app_activated', {
          tsMs: startedAt,
          bundleId,
          appName: identity.displayName,
          pid: resolvedWin.pid ?? null,
          windowTitle: persistedWindowTitle,
        }, trackingPlatform())
      }
      upsertAppIdentityObservation(getDb(), {
        bundleId,
        rawAppName: appName,
        appInstanceId: identity.appInstanceId,
        observedCategory: category,
        executablePath: executablePathForMetadata(resolvedWin.path),
        uwpPackageFamily: resolvedWin.windows?.isUWPApp ? resolvedWin.windows.uwpPackage : null,
        activeWindowIconBase64: resolvedWin.icon?.trim() || null,
        activeWindowIconMime: 'image/png',
        firstSeenAt: startedAt,
        lastSeenAt: startedAt,
      })
      persistLiveSnapshot(true)
    } else {
      // A title change is visible-context evidence; it never adds time. Emit
      // only on a real change so per-tick sampling stays out of the store.
      if (currentSession.windowTitle !== persistedWindowTitle
        && !trackedForegroundSessionExclusionReason({
          bundleId,
          appName: currentSession.appName,
          windowTitle: persistedWindowTitle,
          rawAppName: currentSession.rawAppName,
          executablePath: resolvedWin.path?.trim() || null,
        })) {
        recordPollForegroundEvent('window_changed', {
          tsMs: nowMs(),
          bundleId,
          appName: currentSession.appName,
          pid: resolvedWin.pid ?? null,
          windowTitle: persistedWindowTitle,
        }, trackingPlatform())
      }
      currentSession.windowTitle = persistedWindowTitle
      currentSession.passivePresence = browserSample.passivePresence
      currentSession.passiveHold = browserSample.passiveHold ?? null
      if (!currentSession.windowTitles) {
        currentSession.windowTitles = [{ title: persistedWindowTitle, ticks: 1 }]
      } else {
        const existing = currentSession.windowTitles.find((t) => t.title === persistedWindowTitle)
        if (existing) {
          existing.ticks++
        } else {
          currentSession.windowTitles.push({ title: persistedWindowTitle, ticks: 1 })
        }
      }
      persistLiveSnapshot()
    }

    if (
      idleSec >= AWAY_THRESHOLD_SEC
      && idleState === 'provisional_idle'
      && currentSession
      && !passiveHoldActive(currentSession, idleSec)
    ) {
      flushCurrent(nowMs(), 'away')
      flushActiveBrowserContext(getDb(), nowMs())
      recordActivityEvent('away_start', {
        idleSeconds: Math.round(idleSec),
        passivePresenceEnded: true,
      })
      idleState = 'away'
      provisionalIdleStart = null
    }
  } catch (err) {
    // active-window can throw on permissions denial (macOS) or unsupported platform
    setPollHealth(formatError(err))
    console.warn('[tracking] poll error:', err)
    captureRateLimited(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, 'tracking:poll', {
      failure_kind: classifyFailureKind(err),
      reason: 'poll',
      status: 'error',
      surface: 'tracking',
    })
  } finally {
    emitTrackingTick()
  }
}

// ─── Flush ────────────────────────────────────────────────────────────────────

function flushCurrent(overrideEndTime?: number, endedReason: string | null = null): void {
  if (!currentSession) return

  // Two-clock safety. A session's start is stamped from poll wall-clock, but an
  // away/idle flush end is derived from the true last-input time (idleStartMs),
  // which can predate the poll that opened the session. Clamp any explicit end
  // forward to the session start so end < start is impossible; a session that
  // collapses to zero length then dies at the explicit MIN_SESSION_SEC floor
  // (logged when it was born on a return), never via a silent negative-duration
  // discard. Wall-clock flushes (no override) are already monotonic.
  const endTime = overrideEndTime != null
    ? Math.max(overrideEndTime, currentSession.startTime)
    : nowMs()

  // Split sessions that cross midnight into two records so that each calendar
  // day's totals only include time that actually fell within that day.
  const startDate = localDateString(new Date(currentSession.startTime))
  const endDate   = localDateString(new Date(endTime))
  if (startDate !== endDate && endedReason !== 'midnight_split') {
    const [, midnightMs] = localDayBounds(startDate)
    // Snapshot fields before the recursive call — flushCurrent sets
    // currentSession = null so we can't read it afterwards.
    const snapshot = { ...currentSession }
    flushCurrent(midnightMs, 'midnight_split')
    // Restore for the second slice (midnight → endTime).
    currentSession = { ...snapshot, startTime: midnightMs }
    flushCurrent(endTime, endedReason)
    return
  }

  // A midnight split is a legacy-storage detail, so only the final slice emits
  // the observed deactivation.
  if (endedReason !== 'midnight_split' && !trackedForegroundSessionExclusionReason({
    bundleId: currentSession.bundleId,
    appName: currentSession.appName,
    windowTitle: currentSession.windowTitle,
    rawAppName: currentSession.rawAppName,
  })) {
    recordPollForegroundEvent('app_deactivated', {
      tsMs: endTime,
      bundleId: currentSession.bundleId,
      appName: currentSession.appName,
      pid: null,
      windowTitle: currentSession.windowTitle,
    }, trackingPlatform())
  }

  if (currentSession.windowTitles && currentSession.windowTitles.length > 0) {
    let dominantTitle = currentSession.windowTitle
    let maxTicks = 0
    for (const item of currentSession.windowTitles) {
      if (item.ticks > maxTicks) {
        maxTicks = item.ticks
        dominantTitle = item.title
      }
    }
    currentSession.windowTitle = dominantTitle
  }

  const durationSeconds = Math.max(0, Math.round((endTime - currentSession.startTime) / 1_000))

  if (durationSeconds < MIN_SESSION_SEC && currentSession.bornOnIdleReturn) {
    // Diagnosable drop: a session born on a return from away/idle collapsed under
    // the noise floor. Previously this vanished via the silent negative-duration
    // discard; now it is explicit so brief post-away sittings are traceable.
    console.log(
      `[tracking] dropped ${durationSeconds}s return session (${currentSession.appName}) at MIN_SESSION_SEC floor — endedReason=${endedReason}`,
    )
  }

  // Legacy app_sessions writes are retired (capture migration slice 10). The
  // canonical focus_events emitted through recordPollForegroundEvent are the
  // only persisted record of this session; the side effects below keep running
  // so identity, projections, and attribution stay current on the canonical path.
  if (durationSeconds >= MIN_SESSION_SEC && !trackedForegroundSessionExclusionReason({
    bundleId: currentSession.bundleId,
    appName: currentSession.appName,
    windowTitle: currentSession.windowTitle,
    rawAppName: currentSession.rawAppName,
  })) {
    try {
      const db = getDb()
      const { category } = classifyResult(currentSession.bundleId, currentSession.appName)
      upsertAppIdentityObservation(db, {
        bundleId: currentSession.bundleId,
        rawAppName: currentSession.rawAppName,
        appInstanceId: currentSession.appInstanceId,
        observedCategory: category,
        firstSeenAt: currentSession.startTime,
        lastSeenAt: endTime,
      })
      // Timeline + insights coalesce (heavy full-day rebuild); apps stays
      // immediate so its targeted per-app refresh keeps the canonicalAppId.
      scheduleActivityProjectionInvalidation(localDateString(new Date(endTime)))
      invalidateProjectionScope('apps', 'activity_recorded', {
        canonicalAppId: currentSession.canonicalAppId,
      })
      scheduleAttributionRefreshForSession(currentSession.startTime, endTime)
    } catch (err) {
      console.error('[tracking] flush error:', err)
      captureRateLimited(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, 'tracking:flush', {
        failure_kind: classifyFailureKind(err),
        reason: 'flush',
        status: 'error',
        surface: 'tracking',
      })
      captureException(err, {
        tags: {
          process_type: 'main',
          reason: 'tracking_flush_failed',
        },
      })
    }
  }

  // Record the boundary so a restamped next-session start can clamp to it and
  // never overlap backwards, then let a test observe the final (clamped) bounds.
  lastFlushEndMs = endTime
  fsmTestHarness?.recordFlush?.({
    startTime: currentSession.startTime,
    endTime,
    durationSeconds,
    endedReason,
    persisted: durationSeconds >= MIN_SESSION_SEC,
    bundleId: currentSession.bundleId,
    appName: currentSession.appName,
    rawAppName: currentSession.rawAppName ?? null,
    category: classifyResult(currentSession.bundleId, currentSession.appName).category,
  })

  clearPersistedLiveSnapshot()
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
    const key = map.aliases[candidate] ?? map.aliases[candidate.toLowerCase()] ?? candidate
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
