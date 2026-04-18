import { app, Notification } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getLinuxSessionBusInfo, getSecureStoreDiagnostics } from './secureStore'

const AUTOSTART_FILE = 'daylens.desktop'
const EXEC_WRAPPERS = new Set(['env', 'flatpak', 'snap', 'gtk-launch', 'sh', 'bash'])
const PACKAGE_DIAGNOSTICS_CACHE_MS = 30_000

interface DesktopEntryRecord {
  desktopId: string
  name: string
  exec: string | null
  filePath: string
  candidates: string[]
}

export interface LinuxDesktopIdentity {
  desktopId: string
  name: string
  exec: string | null
  filePath: string
}

export type LinuxPackageType = 'appimage' | 'deb' | 'rpm' | 'pacman' | 'unknown' | null

export interface LinuxPackageDiagnostics {
  packageType: LinuxPackageType
  source: 'appimage-env' | 'dpkg-query' | 'rpm-query' | 'pacman-query' | 'unresolved' | null
  owner: string | null
  managerCommand: 'dpkg-query' | 'rpm' | 'pacman' | null
  matchedPath: string | null
  errors: string[]
}

let desktopEntriesCache: DesktopEntryRecord[] | null = null
const commandAvailabilityCache = new Map<string, boolean>()
let linuxPackageDiagnosticsCache: { expiresAt: number; diagnostics: LinuxPackageDiagnostics } | null = null

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function cleanToken(value: string): string {
  return value
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .trim()
}

function execCandidateTokens(exec: string | null): string[] {
  if (!exec) return []

  const parts = exec
    .replace(/%[fFuUdDnNickvm]/g, ' ')
    .split(/\s+/)
    .map(cleanToken)
    .filter(Boolean)

  const tokens: string[] = []
  for (const part of parts) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue
    if (EXEC_WRAPPERS.has(part)) continue
    if (part.startsWith('-')) continue
    tokens.push(part)
  }

  return tokens
}

function desktopApplicationsDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.local/share/applications'),
    path.join(home, '.local/share/flatpak/exports/share/applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
  ]
}

function linuxDesktopLabel(): string | null {
  const tokens = [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.XDG_SESSION_DESKTOP,
    process.env.DESKTOP_SESSION,
    process.env.GDMSESSION,
  ]
    .flatMap((value) => (value ?? '').split(/[:;]/))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)

  return tokens.length > 0 ? tokens.join(':') : null
}

function parseDesktopEntryFile(filePath: string): DesktopEntryRecord | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const lines = raw.split(/\r?\n/)
    let inDesktopEntry = false
    const fields = new Map<string, string>()

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (trimmed === '[Desktop Entry]') {
        inDesktopEntry = true
        continue
      }
      if (trimmed.startsWith('[') && trimmed !== '[Desktop Entry]') {
        if (inDesktopEntry) break
        continue
      }
      if (!inDesktopEntry) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      fields.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim())
    }

    if (fields.get('Type') !== 'Application') return null
    if (fields.get('NoDisplay') === 'true' || fields.get('Hidden') === 'true') return null

    const name = fields.get('Name')?.trim()
    if (!name) return null

    const exec = fields.get('Exec')?.trim() || null
    const fileBase = path.basename(filePath, '.desktop')
    const execTokens = execCandidateTokens(exec)

    const candidates = [name, fileBase, ...execTokens, ...execTokens.map((token) => path.basename(token))]
      .map(normalizeKey)
      .filter(Boolean)

    return {
      desktopId: fileBase,
      name,
      exec,
      filePath,
      candidates,
    }
  } catch {
    return null
  }
}

function getDesktopEntries(): DesktopEntryRecord[] {
  if (desktopEntriesCache) return desktopEntriesCache

  const parsed: DesktopEntryRecord[] = []
  for (const dir of desktopApplicationsDirs()) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.desktop')) continue
        const record = parseDesktopEntryFile(path.join(dir, entry.name))
        if (record) parsed.push(record)
      }
    } catch {
      // Ignore missing directories.
    }
  }

  desktopEntriesCache = parsed
  return parsed
}

function identityCandidates(values: string[]): string[] {
  const candidates = new Set<string>()
  for (const value of values) {
    if (!value) continue
    for (const raw of [
      value,
      path.basename(value),
      value.replace(/\.(desktop|appimage|exe)$/i, ''),
      path.basename(value).replace(/\.(desktop|appimage|exe)$/i, ''),
    ]) {
      const normalized = normalizeKey(raw)
      if (normalized) candidates.add(normalized)
    }
  }
  return [...candidates]
}

function resolveDesktopEntry(...values: string[]): DesktopEntryRecord | null {
  const candidates = new Set(identityCandidates(values))
  for (const entry of getDesktopEntries()) {
    if (entry.candidates.some((candidate) => candidates.has(candidate))) {
      return entry
    }
  }
  return null
}

function quoteExecArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

function execText(command: string, args: string[], extraEnv?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync(command, args, {
      timeout: 1_500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    }).trim()
  } catch {
    return null
  }
}

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

function existingLinuxPackageCandidates(): string[] {
  const candidates = new Set<string>()

  for (const candidate of [
    process.execPath,
    (() => {
      try {
        return fs.realpathSync(process.execPath)
      } catch {
        return ''
      }
    })(),
    path.join(process.resourcesPath, 'app.asar'),
    path.join(process.resourcesPath, 'app.asar.unpacked'),
  ]) {
    if (!candidate) continue
    if (fs.existsSync(candidate)) candidates.add(candidate)
  }

  return [...candidates]
}

function parseDpkgOwner(output: string): string | null {
  const line = output.split(/\r?\n/).find(Boolean) ?? ''
  const match = line.match(/^([^:]+):/)
  return match?.[1]?.trim() ?? null
}

function parseRpmOwner(output: string): string | null {
  const line = output.split(/\r?\n/).find(Boolean) ?? ''
  const trimmed = line.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parsePacmanOwner(output: string): string | null {
  const line = output.split(/\r?\n/).find(Boolean) ?? ''
  const match = line.match(/\s+is owned by\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

function detectLinuxOwnedPackage(
  command: 'dpkg-query' | 'rpm' | 'pacman',
  argsForPath: (filePath: string) => string[],
  parseOwner: (output: string) => string | null,
  packageType: Exclude<LinuxPackageType, 'appimage' | 'unknown' | null>,
  source: Exclude<LinuxPackageDiagnostics['source'], 'appimage-env' | 'unresolved' | null>,
  errors: string[],
): LinuxPackageDiagnostics | null {
  if (!commandAvailable(command)) {
    errors.push(`${command}: command not found`)
    return null
  }

  for (const filePath of existingLinuxPackageCandidates()) {
    const output = execText(command, argsForPath(filePath))
    if (!output) continue

    const owner = parseOwner(output)
    if (!owner) {
      errors.push(`${command}: could not parse owning package for ${filePath}`)
      continue
    }

    return {
      packageType,
      source,
      owner,
      managerCommand: command,
      matchedPath: filePath,
      errors,
    }
  }

  return null
}

function resolveLinuxPackageDiagnostics(): LinuxPackageDiagnostics {
  const now = Date.now()
  if (linuxPackageDiagnosticsCache && linuxPackageDiagnosticsCache.expiresAt > now) {
    return linuxPackageDiagnosticsCache.diagnostics
  }

  const errors: string[] = []
  let diagnostics: LinuxPackageDiagnostics

  if (process.env.APPIMAGE?.trim()) {
    diagnostics = {
      packageType: 'appimage',
      source: 'appimage-env',
      owner: path.basename(process.env.APPIMAGE.trim()),
      managerCommand: null,
      matchedPath: process.env.APPIMAGE.trim(),
      errors,
    }
  } else {
    diagnostics =
      detectLinuxOwnedPackage('dpkg-query', (filePath) => ['-S', filePath], parseDpkgOwner, 'deb', 'dpkg-query', errors)
      ?? detectLinuxOwnedPackage('rpm', (filePath) => ['-qf', filePath], parseRpmOwner, 'rpm', 'rpm-query', errors)
      ?? detectLinuxOwnedPackage('pacman', (filePath) => ['-Qo', filePath], parsePacmanOwner, 'pacman', 'pacman-query', errors)
      ?? {
        packageType: 'unknown',
        source: 'unresolved',
        owner: null,
        managerCommand: null,
        matchedPath: null,
        errors,
      }
  }

  linuxPackageDiagnosticsCache = {
    diagnostics,
    expiresAt: now + PACKAGE_DIAGNOSTICS_CACHE_MS,
  }

  return diagnostics
}

function getLinuxSecretServiceStatus(): {
  sessionBusAddress: string | null
  sessionBusAddressInferred: boolean
  secretServiceReachable: boolean | null
} {
  const sessionBus = getLinuxSessionBusInfo()
  const sessionBusAddress = sessionBus.address
  if (!sessionBusAddress) {
    return {
      sessionBusAddress: null,
      sessionBusAddressInferred: false,
      secretServiceReachable: false,
    }
  }

  if (commandAvailable('gdbus')) {
    const output = execText('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.ListNames',
    ], sessionBus.inferred ? { DBUS_SESSION_BUS_ADDRESS: sessionBusAddress } : undefined)

    if (output) {
      return {
        sessionBusAddress,
        sessionBusAddressInferred: sessionBus.inferred,
        secretServiceReachable: output.includes('org.freedesktop.secrets'),
      }
    }
  }

  return {
    sessionBusAddress,
    sessionBusAddressInferred: sessionBus.inferred,
    secretServiceReachable: null,
  }
}

function buildAutostartDesktopFile(): string | null {
  const execTarget = process.env.APPIMAGE?.trim() || process.execPath
  if (!execTarget) return null

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Daylens',
    'Comment=Cross-platform activity tracker with an AI-ready work timeline',
    `Exec=${quoteExecArg(execTarget)}`,
    'StartupWMClass=daylens',
    'StartupNotify=true',
    'Terminal=false',
    'Categories=Office;Utility;Productivity;',
    'X-GNOME-UsesNotifications=true',
    '',
  ].join('\n')
}

export function getLinuxPackageDiagnostics(): LinuxPackageDiagnostics | null {
  if (process.platform !== 'linux' || !app.isPackaged) return null
  return resolveLinuxPackageDiagnostics()
}

export function getLinuxPackageType(): LinuxPackageType {
  if (process.platform !== 'linux' || !app.isPackaged) return null
  return resolveLinuxPackageDiagnostics().packageType
}

export function getLinuxAutostartFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
  return path.join(configHome, 'autostart', AUTOSTART_FILE)
}

export async function setLinuxLaunchOnLogin(enabled: boolean): Promise<boolean> {
  if (process.platform !== 'linux' || !app.isPackaged) return false

  const autostartPath = getLinuxAutostartFilePath()
  try {
    if (enabled) {
      const content = buildAutostartDesktopFile()
      if (!content) return false
      fs.mkdirSync(path.dirname(autostartPath), { recursive: true })
      fs.writeFileSync(autostartPath, content, 'utf8')
      return true
    }

    fs.rmSync(autostartPath, { force: true })
    return true
  } catch (error) {
    console.warn('[linux-desktop] failed to set launch-on-login:', error)
    return false
  }
}

export async function syncLinuxLaunchOnLogin(enabled: boolean): Promise<void> {
  if (process.platform !== 'linux') return
  await setLinuxLaunchOnLogin(enabled)
}

export function resolveLinuxDesktopIdentity(...values: string[]): LinuxDesktopIdentity | null {
  if (process.platform !== 'linux') return null

  const desktopEntry = resolveDesktopEntry(...values)
  if (!desktopEntry) return null

  return {
    desktopId: desktopEntry.desktopId,
    name: desktopEntry.name,
    exec: desktopEntry.exec,
    filePath: desktopEntry.filePath,
  }
}

export function getLinuxDesktopDiagnostics() {
  if (process.platform !== 'linux') return null

  const autostartPath = getLinuxAutostartFilePath()
  const secureStore = getSecureStoreDiagnostics()
  const secretService = getLinuxSecretServiceStatus()
  const packageDiagnostics = getLinuxPackageDiagnostics()

  return {
    sessionType: process.env.XDG_SESSION_TYPE ?? null,
    display: process.env.DISPLAY ?? null,
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
    desktop: linuxDesktopLabel(),
    packageType: packageDiagnostics?.packageType ?? null,
    packageDetectionSource: packageDiagnostics?.source ?? null,
    packageOwner: packageDiagnostics?.owner ?? null,
    packageManagerCommand: packageDiagnostics?.managerCommand ?? null,
    packageMatchedPath: packageDiagnostics?.matchedPath ?? null,
    packageDetectionErrors: packageDiagnostics?.errors ?? [],
    appImage: process.env.APPIMAGE ?? null,
    autostartPath,
    autostartEnabled: fs.existsSync(autostartPath),
    notificationSupported: Notification.isSupported(),
    secureStoreAvailable: secureStore.available,
    secureStoreError: secureStore.loadError,
    secureStoreHint: secureStore.hint,
    dbusSessionBusAddress: secretService.sessionBusAddress,
    dbusSessionBusAddressInferred: secretService.sessionBusAddressInferred,
    secretServiceReachable: secretService.secretServiceReachable,
  }
}
