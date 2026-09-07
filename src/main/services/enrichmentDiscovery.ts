// Enrichment discovery — optional local sources beyond
// Daylens' own tracking: MCP servers configured in Claude Desktop, Claude Code,
// and Cursor, plus known focus-timer apps installed on this machine.
//
// Discovery only. This module never launches an MCP server, never calls a
// tool, and never spawns a subprocess. It reads JSON config files and probes
// the filesystem for known app bundles/containers, nothing else. Every path
// is best-effort and silent: a missing file, a malformed config, or an
// unreadable store returns an empty/null result, never a thrown error.
//
// Server command arguments, paths, and env values are deliberately never
// surfaced here (they can carry tokens/secrets) — only the server name,
// transport kind, and which config named it leave this module.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FocusAppSignal, McpDiscoverySource } from '@shared/types'
import {
  claudeCodeConfigDisplayPath,
  claudeDesktopConfigDisplayPath,
  cursorMcpConfigDisplayPath,
} from '@shared/platformPaths'

export interface McpServerDiscovery {
  /** Server key from the config ("notion", "linear", "jira"). */
  name: string
  /** 'stdio' when a command is configured, 'http' when a url is. */
  transport: 'stdio' | 'http' | 'unknown'
  source?: McpDiscoverySource
  sourceLabel?: string
}

export interface McpConfigFile {
  source: McpDiscoverySource
  label: string
  path: string
  displayPath: string
}

export interface McpDiscoveryResult {
  servers: Array<McpServerDiscovery & { source: McpDiscoverySource; sourceLabel: string }>
  checkedFiles: Array<{ label: string; displayPath: string }>
}

export interface McpDiscoveryRoots {
  homeDir?: string
  platform?: NodeJS.Platform
  appData?: string
}

export interface FocusAppDiscovery {
  app: string // "Raycast Focus" | "Be Focused" | "Session"
  installed: boolean
}

/** Where a discovery scan should look. Every field is optional and defaults
 *  to the real machine so tests can point at a temp directory structure. */
export interface FocusAppRoots {
  homeDir?: string
  /** Directories that may each contain a top-level .app bundle. */
  applicationsDirs?: string[]
  /** The `~/Library/Containers` equivalent, for Mac App Store sandboxed apps. */
  containersDir?: string
}

type RawSessionRecord = Record<string, unknown>
type ParsedSession = FocusAppSignal['sessions'][number]

/** Path to the Claude Desktop MCP config for this platform. Injectable via
 *  the arguments so tests can point at a temp fixture. */
export function claudeDesktopConfigPath(
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  appData: string | undefined = process.env.APPDATA,
): string {
  if (platform === 'win32') {
    const base = appData && appData.length > 0 ? appData : path.join(homeDir, 'AppData', 'Roaming')
    return path.join(base, 'Claude', 'claude_desktop_config.json')
  }
  if (platform === 'linux') {
    return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json')
  }
  return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
}

export function claudeCodeConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude.json')
}

export function cursorMcpConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.cursor', 'mcp.json')
}

const SOURCE_LABEL: Record<McpDiscoverySource, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
}

function transportOf(value: unknown): McpServerDiscovery['transport'] {
  if (!value || typeof value !== 'object') return 'unknown'
  const entry = value as Record<string, unknown>
  if (typeof entry.command === 'string' && entry.command.length > 0) return 'stdio'
  if (typeof entry.url === 'string' && entry.url.length > 0) return 'http'
  return 'unknown'
}

function serversFromObject(servers: unknown): McpServerDiscovery[] {
  if (!servers || typeof servers !== 'object') return []
  return Object.entries(servers as Record<string, unknown>).map(([name, value]) => ({
    name,
    transport: transportOf(value),
  }))
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  return parsed as Record<string, unknown>
}

/** Installed MCP servers from one config file. Discovery ONLY —
 *  never launches or calls them. Empty array when no config exists. */
export function discoverMcpServers(configPath: string = claudeDesktopConfigPath()): McpServerDiscovery[] {
  const parsed = readJsonObject(configPath)
  if (!parsed) return []
  return serversFromObject(parsed.mcpServers)
}

function serversFromClaudeCodeConfig(parsed: Record<string, unknown>): McpServerDiscovery[] {
  const found = serversFromObject(parsed.mcpServers)
  const seen = new Set(found.map((server) => server.name))
  const projects = parsed.projects
  if (!projects || typeof projects !== 'object') return found
  for (const project of Object.values(projects as Record<string, unknown>)) {
    if (!project || typeof project !== 'object') continue
    for (const server of serversFromObject((project as Record<string, unknown>).mcpServers)) {
      if (seen.has(server.name)) continue
      seen.add(server.name)
      found.push(server)
    }
  }
  return found
}

export function listMcpConfigFiles(roots: McpDiscoveryRoots = {}): McpConfigFile[] {
  const homeDir = roots.homeDir ?? os.homedir()
  const platform = roots.platform ?? process.platform
  const appData = roots.appData ?? process.env.APPDATA
  return [
    {
      source: 'claude-desktop',
      label: SOURCE_LABEL['claude-desktop'],
      path: claudeDesktopConfigPath(homeDir, platform, appData),
      displayPath: claudeDesktopConfigDisplayPath(platform),
    },
    {
      source: 'claude-code',
      label: SOURCE_LABEL['claude-code'],
      path: claudeCodeConfigPath(homeDir),
      displayPath: claudeCodeConfigDisplayPath(platform),
    },
    {
      source: 'cursor',
      label: SOURCE_LABEL.cursor,
      path: cursorMcpConfigPath(homeDir),
      displayPath: cursorMcpConfigDisplayPath(platform),
    },
  ]
}

/** MCP servers from Claude Desktop, Claude Code (user + project-scoped),
 *  and Cursor. Deduplicated by server name; first config in listMcpConfigFiles
 *  order wins. */
export function discoverAllMcpServers(roots: McpDiscoveryRoots = {}): McpDiscoveryResult {
  const files = listMcpConfigFiles(roots)
  const seen = new Set<string>()
  const servers: McpDiscoveryResult['servers'] = []
  for (const file of files) {
    const parsed = readJsonObject(file.path)
    const found = parsed
      ? file.source === 'claude-code'
        ? serversFromClaudeCodeConfig(parsed)
        : serversFromObject(parsed.mcpServers)
      : []
    for (const server of found) {
      if (seen.has(server.name)) continue
      seen.add(server.name)
      servers.push({
        ...server,
        source: file.source,
        sourceLabel: file.label,
      })
    }
  }
  return {
    servers,
    checkedFiles: files.map(({ label, displayPath }) => ({ label, displayPath })),
  }
}

function defaultFocusAppRoots(homeDir: string): Required<Omit<FocusAppRoots, 'homeDir'>> {
  return {
    applicationsDirs: ['/Applications', path.join(homeDir, 'Applications')],
    containersDir: path.join(homeDir, 'Library', 'Containers'),
  }
}

function appBundleExists(dirs: string[], bundleName: string): boolean {
  return dirs.some((dir) => {
    try {
      return fs.existsSync(path.join(dir, bundleName))
    } catch {
      return false
    }
  })
}

function containerMatches(containersDir: string, patterns: RegExp[]): boolean {
  try {
    const entries = fs.readdirSync(containersDir)
    return entries.some((entry) => patterns.some((re) => re.test(entry)))
  } catch {
    return false
  }
}

/** Which known focus tools are installed on this machine. Windows returns []
 *  for now — none of the known tools are cross-platform detected yet. */
export function detectFocusApps(roots: FocusAppRoots = {}): FocusAppDiscovery[] {
  if (process.platform === 'win32') return []

  const homeDir = roots.homeDir ?? os.homedir()
  const defaults = defaultFocusAppRoots(homeDir)
  const applicationsDirs = roots.applicationsDirs ?? defaults.applicationsDirs
  const containersDir = roots.containersDir ?? defaults.containersDir

  const raycastInstalled = appBundleExists(applicationsDirs, 'Raycast.app')
  const beFocusedInstalled =
    appBundleExists(applicationsDirs, 'Be Focused.app') ||
    containerMatches(containersDir, [/\.BeFocused/i, /^com\.xwavesoft\.befocused/i])
  const sessionInstalled = appBundleExists(applicationsDirs, 'Session.app')

  return [
    { app: 'Raycast Focus', installed: raycastInstalled },
    { app: 'Be Focused', installed: beFocusedInstalled },
    { app: 'Session', installed: sessionInstalled },
  ]
}

/** "2:30pm" style: lowercase, no leading zero, no ":00" on the hour. */
function clock(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(' ', '')
    .toLowerCase()
}

function localDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const SESSION_ARRAY_KEYS = ['sessions', 'focusSessions', 'items', 'history']
const START_KEYS = ['start', 'startTime', 'startedAt', 'date', 'timestamp', 'ts']
const DURATION_KEYS = ['duration', 'durationMinutes', 'minutes', 'lengthMinutes']
const LABEL_KEYS = ['label', 'title', 'name', 'project']

function firstOf(obj: RawSessionRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key]
  }
  return undefined
}

/** Best-effort epoch-ms coercion: numbers are treated as ms (or seconds, if
 *  clearly too small to be ms) and strings are parsed as dates. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string') {
    const parsedMs = Date.parse(value)
    return Number.isFinite(parsedMs) ? parsedMs : null
  }
  return null
}

/** A store's shape is unknown ahead of time, so this accepts either a bare
 *  array of session-like records or an object with a plausibly-named array
 *  property. Anything else yields no sessions — never a throw. */
function extractSessionArray(parsed: unknown): RawSessionRecord[] {
  const isRecord = (x: unknown): x is RawSessionRecord => !!x && typeof x === 'object'
  if (Array.isArray(parsed)) return parsed.filter(isRecord)
  if (parsed && typeof parsed === 'object') {
    for (const key of SESSION_ARRAY_KEYS) {
      const value = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value.filter(isRecord)
    }
  }
  return []
}

/** Reads one candidate JSON store and returns the sessions that overlap the
 *  given local date. Missing file, malformed JSON, or an unrecognized shape
 *  all silently yield []. */
function parseSessionsForDate(jsonPath: string, date: string): ParsedSession[] {
  let raw: string
  try {
    raw = fs.readFileSync(jsonPath, 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  const sessions: ParsedSession[] = []
  for (const record of extractSessionArray(parsed)) {
    const startMs = toEpochMs(firstOf(record, START_KEYS))
    if (startMs === null || localDateKey(startMs) !== date) continue
    const durationRaw = firstOf(record, DURATION_KEYS)
    const labelRaw = firstOf(record, LABEL_KEYS)
    sessions.push({
      startClock:       clock(startMs),
      durationMinutes:  typeof durationRaw === 'number' ? durationRaw : null,
      label:            typeof labelRaw === 'string' ? labelRaw : null,
    })
  }
  return sessions
}

/** Plausible local-store locations per known focus app. Store formats are not
 *  documented, so these are best guesses — parsing is a bonus, not a
 *  requirement (see parseSessionsForDate's silent fallbacks).
 *
 *  Investigated on a real install: Raycast keeps its activity
 *  history (including Focus sessions) in raycast-activities-enc.sqlite,
 *  which is SQLCipher-ENCRYPTED — no SQLite magic header, unreadable without
 *  Raycast's own key. Its defaults hold only the last-used session settings,
 *  not history. So for Raycast, presence + empty sessions is not a shortcut,
 *  it is the ceiling; the JSON candidates below stay only in case a future
 *  Raycast version exports one. */
function candidateStorePaths(app: string, homeDir: string): string[] {
  switch (app) {
    case 'Raycast Focus':
      return [
        path.join(homeDir, 'Library', 'Application Support', 'com.raycast.macos', 'focus-sessions.json'),
        path.join(homeDir, 'Library', 'Application Support', 'com.raycast.macos', 'extensions', 'focus', 'sessions.json'),
      ]
    case 'Be Focused':
      return [
        path.join(homeDir, 'Library', 'Application Support', 'Be Focused', 'sessions.json'),
      ]
    case 'Session':
      return [
        path.join(homeDir, 'Library', 'Application Support', 'Session', 'sessions.json'),
      ]
    default:
      return []
  }
}

/** Focus sessions for a local date (YYYY-MM-DD) read from installed focus
 *  apps' local stores, when readable. Presence with unreadable logs yields a
 *  FocusAppSignal with sessions: []. Null when no focus app is installed. */
export async function collectFocusAppSignals(
  date: string,
  roots: FocusAppRoots = {},
  includeApp: (app: string) => boolean = () => true,
): Promise<FocusAppSignal[] | null> {
  // Only read the local store of an app the caller allows (the `focus:<app>`
  // toggle) — a disabled app's store is never even opened.
  const installedApps = detectFocusApps(roots).filter((entry) => entry.installed && includeApp(entry.app))
  if (installedApps.length === 0) return null

  const homeDir = roots.homeDir ?? os.homedir()
  return installedApps.map(({ app }): FocusAppSignal => {
    let sessions: ParsedSession[] = []
    for (const storePath of candidateStorePaths(app, homeDir)) {
      const parsed = parseSessionsForDate(storePath, date)
      if (parsed.length > 0) {
        sessions = parsed
        break
      }
    }
    return { app, sessions }
  })
}
