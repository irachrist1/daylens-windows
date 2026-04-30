// Activity tracker — polls active window every 5 s and flushes completed sessions to DB.
// Uses @paymoapp/active-window which supports Windows, macOS, and Linux natively.
import { app, powerMonitor } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  clearLiveAppSessionSnapshot,
  getLiveAppSessionSnapshot,
  insertAppSession,
  recordActivityStateEvent,
  upsertLiveAppSessionSnapshot,
} from '../db/queries'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { upsertAppIdentityObservation } from '../core/inference/appIdentityRegistry'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { getDb } from './database'
import type {
  AppCategory,
  AppSession,
  LinuxTrackingDiagnostics,
  LiveSession,
  TrackingModuleSource,
} from '@shared/types'
import type { WorkspacePresenceState } from '@daylens/remote-contract'
import { isCategoryFocused } from '../lib/focusScore'
import { resolveCanonicalApp } from '../lib/appIdentity'
import { localDateString } from '../lib/localDate'
import { capture, captureException, captureRateLimited } from './analytics'
import { resolveLinuxDesktopIdentity } from './linuxDesktop'

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
  windowTitle: string | null
  rawAppName: string
  canonicalAppId: string | null
  appInstanceId: string | null
  captureSource: string
  startTime: number
  category: AppCategory
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

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

function execText(command: string, args: string[]): string | null {
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

function windowHasMeaningfulIdentity(win: ActiveWinResult | null): boolean {
  if (!win) return false
  return Boolean(win.application?.trim() || win.path?.trim() || win.title?.trim())
}

function linuxFallbackActiveWindow(): { source: Exclude<TrackingModuleSource, 'package' | 'unpacked'>; win: ActiveWinResult | null; trace: string[] } | null {
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
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      trackingStatus.loadError = 'The active-window backend needs X11/XWayland (DISPLAY). Daylens will use compositor-specific Linux trackers when available.'
      _activeWindowInitFailed = true
      return null
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
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
    trackingStatus.pollError = formatError(err)
    console.warn('[tracking] failed to request permissions:', err)
    return null
  }
}

function resolveWindowIdentity(win: ActiveWinResult): ActiveWinResult & { bundleId: string; appName: string } {
  if (process.platform === 'linux') {
    return finalizeLinuxWindowIdentity(win)
  }

  const exeName = win.path ? path.basename(win.path) : ''
  const uwpPackage = win.windows?.isUWPApp ? win.windows.uwpPackage : ''
  const appName = win.application || exeName || uwpPackage || 'Unknown app'
  const bundleId = win.path || uwpPackage || appName
  return { ...win, bundleId, appName }
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
  'daylens',
  'daylens.exe',
  'daylens windows.exe',
  'daylenswindows.exe',
  'electron.exe',      // dev mode — raw electron runner, not a user app
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

function trackedForegroundSessionExclusionReason(
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

export function persistTrackedForegroundSession(
  db: Database.Database,
  session: Omit<AppSession, 'id'>,
): number | null {
  if (trackedForegroundSessionExclusionReason(session)) return null
  return insertAppSession(db, session)
}

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
let lastSnapshotPersistAt = 0
let lastMeaningfulCaptureAt = 0
let lastPresenceOverride: WorkspacePresenceState | null = null
type IdleState = 'active' | 'provisional_idle' | 'away'
let idleState: IdleState = 'active'
let provisionalIdleStart: number | null = null
let powerMonitorListenersRegistered = false
const trackingTickListeners = new Set<() => void>()

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

    const endTime = Math.min(Date.now(), Math.max(snapshot.lastSeenAt, snapshot.startTime))
    const durationSeconds = Math.max(0, Math.round((endTime - snapshot.startTime) / 1_000))
    const duplicate = db.prepare(`
      SELECT 1
      FROM app_sessions
      WHERE bundle_id = ? AND start_time = ?
      LIMIT 1
    `).get(snapshot.bundleId, snapshot.startTime)

    if (!duplicate && durationSeconds >= MIN_SESSION_SEC) {
      const { isFocused, category } = classifyResult(snapshot.bundleId, snapshot.appName)
      const insertedId = persistTrackedForegroundSession(db, {
        bundleId: snapshot.bundleId,
        appName: snapshot.appName,
        windowTitle: snapshot.windowTitle,
        rawAppName: snapshot.rawAppName,
        canonicalAppId: snapshot.canonicalAppId,
        appInstanceId: snapshot.appInstanceId,
        captureSource: snapshot.captureSource,
        endedReason: 'recovered_after_restart',
        captureVersion: 2,
        startTime: snapshot.startTime,
        endTime,
        durationSeconds,
        category,
        isFocused,
      })
      if (insertedId !== null) {
        upsertAppIdentityObservation(db, {
          bundleId: snapshot.bundleId,
          rawAppName: snapshot.rawAppName,
          appInstanceId: snapshot.appInstanceId,
          observedCategory: category,
          firstSeenAt: snapshot.startTime,
          lastSeenAt: endTime,
        })
        invalidateProjectionScope('timeline', 'activity_recorded', {
          date: localDateString(new Date(endTime)),
        })
        invalidateProjectionScope('apps', 'activity_recorded', {
          canonicalAppId: snapshot.canonicalAppId,
        })
        invalidateProjectionScope('insights', 'activity_recorded', {
          date: localDateString(new Date(endTime)),
        })
        console.log('[tracking] recovered live session snapshot after restart')
      }
    }

    clearPersistedLiveSnapshot()
  } catch (err) {
    console.warn('[tracking] failed to recover live snapshot:', err)
  }
}

function handleLockScreen(): void {
  if (currentSession) {
    flushCurrent(undefined, 'lock_screen')
    console.log('[tracking] screen locked — session flushed')
  }
  recordActivityEvent('lock_screen')
  lastMeaningfulCaptureAt = Date.now()
  lastPresenceOverride = 'sleeping'
  idleState = 'away'
  provisionalIdleStart = null
}

function handleSuspend(): void {
  if (currentSession) {
    flushCurrent(undefined, 'suspend')
    console.log('[tracking] system suspended — session flushed')
  }
  recordActivityEvent('suspend')
  lastMeaningfulCaptureAt = Date.now()
  lastPresenceOverride = 'sleeping'
  idleState = 'away'
  provisionalIdleStart = null
}

function handleUnlockScreen(): void {
  recordActivityEvent('unlock_screen')
}

function handleResume(): void {
  recordActivityEvent('resume')
}

function recordActivityEvent(
  eventType: 'idle_start' | 'idle_end' | 'away_start' | 'away_end' | 'lock_screen' | 'unlock_screen' | 'suspend' | 'resume',
  metadata: Record<string, unknown> = {},
): void {
  try {
    recordActivityStateEvent(getDb(), {
      eventTs: Date.now(),
      eventType,
      source: 'tracking',
      metadata,
    })
  } catch (err) {
    console.warn('[tracking] failed to record activity event:', err)
  }
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

export function stopTracking(): void {
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
  idleState = 'active'
  provisionalIdleStart = null
  console.log('[tracking] stopped')
}

export function getCurrentSession(): LiveSession | null {
  return currentSession
}

export function getCurrentPresenceState(): WorkspacePresenceState {
  if (currentSession) {
    return currentSession.category === 'meetings' ? 'meeting' : 'active'
  }
  if (lastPresenceOverride === 'sleeping') {
    return 'sleeping'
  }
  if (idleState !== 'active') {
    return 'idle'
  }
  return lastPresenceOverride ?? 'offline'
}

export function getLastMeaningfulCaptureAt(): number | null {
  return lastMeaningfulCaptureAt > 0 ? lastMeaningfulCaptureAt : null
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  try {
    // ── Idle detection ───────────────────────────────────────────────────────
    const idleSec = powerMonitor.getSystemIdleTime()
    if (idleSec >= AWAY_THRESHOLD_SEC) {
      if (idleState !== 'away' && currentSession) {
        const idleStartMs = provisionalIdleStart ?? (Date.now() - Math.round(idleSec) * 1_000)
        if (idleState !== 'provisional_idle') {
          recordActivityEvent('away_start', { idleSeconds: Math.round(idleSec) })
        }
        flushCurrent(idleStartMs, 'away')
        console.log(`[tracking] user away ${Math.round(idleSec)}s — session flushed`)
        lastMeaningfulCaptureAt = idleStartMs
      }
      lastPresenceOverride = 'idle'
      idleState = 'away'
      provisionalIdleStart = null
      return
    } else if (idleSec >= IDLE_THRESHOLD_SEC) {
      if (idleState === 'active') {
        provisionalIdleStart = Date.now() - Math.round(idleSec) * 1_000
        idleState = 'provisional_idle'
        recordActivityEvent('idle_start', { idleSeconds: Math.round(idleSec) })
        console.log(`[tracking] provisional idle at ${Math.round(idleSec)}s — session held open`)
      }
      lastPresenceOverride = 'idle'
    } else {
      if (idleState === 'away' || idleState === 'provisional_idle') {
        // Returning from provisional_idle: the session was intentionally held open
        // through the 2–5 min idle window to avoid fragmenting media playback.
        // The idle time is attributed to the session — this is the desired behaviour.
        // Returning from away: session was already flushed, a new one will start below.
        console.log(`[tracking] user returned from ${idleState}`)
        recordActivityEvent(idleState === 'away' ? 'away_end' : 'idle_end')
      }
      idleState = 'active'
      provisionalIdleStart = null
      lastPresenceOverride = currentSession?.category === 'meetings' ? 'meeting' : 'active'
    }

    // ── Active window ────────────────────────────────────────────────────────
    let win: ActiveWinResult | null = null
    let backend = trackingStatus.moduleSource ?? 'unknown'
    const backendTrace: string[] = []

    if (process.platform === 'linux') {
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
    } else {
      const awMod = getActiveWindowModule()
      if (!awMod) return

      try {
        win = awMod.getActiveWindow() as ActiveWinResult | null
      } catch (err) {
        trackingStatus.pollError = formatError(err)
        captureRateLimited(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, 'tracking:get-active-window', {
          failure_kind: classifyFailureKind(err),
          reason: 'poll',
          status: 'error',
          surface: 'tracking',
        })
        return
      }
    }

    if (!win) {
      trackingStatus.pollError = null
      trackingStatus.lastRawWindow = null
      trackingStatus.lastResolvedWindow = null
      return
    }

    trackingStatus.pollError = null
    trackingStatus.lastRawWindow = {
      title: win.title,
      application: win.application,
      path: win.path,
      pid: win.pid,
      isUWPApp: win.windows?.isUWPApp ?? false,
      uwpPackage: win.windows?.uwpPackage ?? '',
    }

    const resolvedWin = resolveWindowIdentity(win)
    const { bundleId, appName } = resolvedWin
    const resolvedWindowTitle = resolvedWin.title?.trim() || null
    trackingStatus.lastResolvedWindow = {
      backend,
      bundleId,
      appName,
      title: resolvedWin.title,
      pid: resolvedWin.pid,
      path: resolvedWin.path,
    }
    const identity = resolveCanonicalApp(bundleId, appName)

    const exclusionReason = trackedForegroundSessionExclusionReason({
      bundleId,
      appName,
      windowTitle: resolvedWindowTitle,
      rawAppName: appName,
      executablePath: resolvedWin.path,
    })
    if (exclusionReason) {
      if (currentSession) flushCurrent(undefined, exclusionReason)
      clearPersistedLiveSnapshot()
      return
    }

    // Skip OS infrastructure processes
    if (isOsNoise(bundleId, appName, resolvedWin.path)) return

    // App switched → flush the previous session
    if (currentSession && currentSession.bundleId !== bundleId) {
      flushCurrent(undefined, 'app_switch')
    }

    // Start a new session if none is in-flight for this app
    if (!currentSession || currentSession.bundleId !== bundleId) {
      const startedAt = Date.now()
      const category = identity.defaultCategory ?? classifyApp(bundleId, appName)
      currentSession = {
        bundleId,
        appName: identity.displayName,
        windowTitle: resolvedWindowTitle,
        rawAppName: appName,
        canonicalAppId: identity.canonicalAppId,
        appInstanceId: identity.appInstanceId,
        captureSource: process.platform === 'linux' && backend !== 'package' && backend !== 'unpacked'
          ? `foreground_poll:${backend}`
          : 'foreground_poll',
        startTime: startedAt,
        category,
      }
      lastMeaningfulCaptureAt = startedAt
      lastPresenceOverride = category === 'meetings' ? 'meeting' : 'active'
      upsertAppIdentityObservation(getDb(), {
        bundleId,
        rawAppName: appName,
        appInstanceId: identity.appInstanceId,
        observedCategory: category,
        executablePath: resolvedWin.path?.trim() || null,
        uwpPackageFamily: resolvedWin.windows?.isUWPApp ? resolvedWin.windows.uwpPackage : null,
        activeWindowIconBase64: resolvedWin.icon?.trim() || null,
        activeWindowIconMime: 'image/png',
        firstSeenAt: startedAt,
        lastSeenAt: startedAt,
      })
      persistLiveSnapshot(true)
    } else {
      currentSession.windowTitle = resolvedWindowTitle
      lastMeaningfulCaptureAt = Date.now()
      lastPresenceOverride = currentSession.category === 'meetings' ? 'meeting' : 'active'
      persistLiveSnapshot()
    }
  } catch (err) {
    // active-window can throw on permissions denial (macOS) or unsupported platform
    trackingStatus.pollError = formatError(err)
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

  const endTime = overrideEndTime ?? Date.now()

  // Guard: never write a session with non-positive duration
  if (endTime <= currentSession.startTime) {
    clearPersistedLiveSnapshot()
    currentSession = null
    return
  }

  const durationSeconds = Math.round((endTime - currentSession.startTime) / 1_000)

  if (durationSeconds >= MIN_SESSION_SEC) {
    try {
      const db = getDb()
      const { isFocused, category } = classifyResult(currentSession.bundleId, currentSession.appName)
      const insertedId = persistTrackedForegroundSession(db, {
        bundleId:        currentSession.bundleId,
        appName:         currentSession.appName,
        windowTitle:     currentSession.windowTitle,
        rawAppName:      currentSession.rawAppName,
        canonicalAppId:  currentSession.canonicalAppId,
        appInstanceId:   currentSession.appInstanceId,
        captureSource:   currentSession.captureSource,
        endedReason,
        captureVersion:  2,
        startTime:       currentSession.startTime,
        endTime,
        durationSeconds,
        category,
        isFocused,
      })
      if (insertedId !== null) {
        upsertAppIdentityObservation(db, {
          bundleId: currentSession.bundleId,
          rawAppName: currentSession.rawAppName,
          appInstanceId: currentSession.appInstanceId,
          observedCategory: category,
          firstSeenAt: currentSession.startTime,
          lastSeenAt: endTime,
        })
        invalidateProjectionScope('timeline', 'activity_recorded', {
          date: localDateString(new Date(endTime)),
        })
        invalidateProjectionScope('apps', 'activity_recorded', {
          canonicalAppId: currentSession.canonicalAppId,
        })
        invalidateProjectionScope('insights', 'activity_recorded', {
          date: localDateString(new Date(endTime)),
        })
      }
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

  clearPersistedLiveSnapshot()
  if (endedReason === 'away') {
    lastPresenceOverride = 'idle'
  } else if (endedReason === 'lock_screen' || endedReason === 'suspend') {
    lastPresenceOverride = 'sleeping'
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
