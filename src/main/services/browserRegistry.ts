import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getLinuxBrowserHistoryLocations,
  isLinuxBrowserApplication,
  resolveLinuxBrowserApplication,
} from './linuxBrowserRegistry'
import { isWindowsBrowserApplication, resolveWindowsBrowserApplication } from './windowsBrowserRegistry'

export type BrowserFamily = 'chromium' | 'firefox' | 'webkit'

export interface BrowserApplication {
  name: string
  bundleId: string
  appPath: string
  family: BrowserFamily
  source: 'launch_services' | 'info_plist'
}

export interface BrowserHistoryLocation extends BrowserApplication {
  historyPath: string
  profileId: string
}

export interface BrowserCandidate {
  bundleId?: string | null
  appName?: string | null
  executablePath?: string | null
}

const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const REGISTRY_CACHE_MS = 60_000
const HISTORY_CACHE_MS = 5 * 60_000
const MAX_HISTORY_SCAN_DEPTH = 6
const SKIPPED_SCAN_DIRECTORIES = new Set([
  'cache',
  'caches',
  'code cache',
  'gpucache',
  'indexeddb',
  'local storage',
  'service worker',
  'session storage',
  'storage',
])

let registryCache: { readAt: number; applications: BrowserApplication[] } | null = null
let historyCache: { readAt: number; locations: BrowserHistoryLocation[] } | null = null

function unique<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyFor(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizedPath(value: string): string {
  try {
    return path.resolve(value).toLowerCase()
  } catch {
    return value.toLowerCase()
  }
}

function appBundlePath(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  const match = raw.match(/^(.+?\.app)(?:\/|$)/i)
  return match?.[1] ?? (raw.toLowerCase().endsWith('.app') ? raw : null)
}

// Reading an Info.plist costs a plutil subprocess (~4ms), and the read paths
// that ask "is this a browser?" ask it about every distinct app a person has
// ever focused — hundreds on a real profile, re-resolved from cold on every
// launch. The answer only changes when the bundle does, so it is remembered
// against the Info.plist's own mtime and size: a reinstall or an update is
// still re-read, a repeat lookup of an unchanged bundle spawns nothing.
const plistByAppPath = new Map<string, { stamp: string; plist: Record<string, unknown> | null }>()
const PLIST_CACHE_LIMIT = 2_000
const MISSING_PLIST_STAMP = 'missing'

let plistSpawnCount = 0

/** How many times a bundle was actually inspected on disk. Test-only: the
 *  point of the cache is that this does not grow with repeated lookups. */
export function macBundleInspectionCountForTest(): number {
  return plistSpawnCount
}

/** Test-only: forget every remembered bundle so a case starts from cold. */
export function resetMacBundleInspectionCacheForTest(): void {
  plistByAppPath.clear()
  bundleIdentifierByAppPath.clear()
  plistSpawnCount = 0
}

function infoPlistStamp(infoPlistPath: string): string {
  try {
    const stat = fs.statSync(infoPlistPath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return MISSING_PLIST_STAMP
  }
}

function rememberPlist(key: string, stamp: string, plist: Record<string, unknown> | null): void {
  plistByAppPath.delete(key)
  plistByAppPath.set(key, { stamp, plist })
  while (plistByAppPath.size > PLIST_CACHE_LIMIT) {
    const oldest = plistByAppPath.keys().next().value
    if (oldest === undefined) break
    plistByAppPath.delete(oldest)
  }
}

function plistJson(appPath: string): Record<string, unknown> | null {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist')
  const stamp = infoPlistStamp(infoPlistPath)
  const key = normalizedPath(appPath)
  const remembered = plistByAppPath.get(key)
  if (remembered && remembered.stamp === stamp) return remembered.plist
  // No readable Info.plist: plutil would fail the same way, so skip the spawn.
  if (stamp === MISSING_PLIST_STAMP) {
    rememberPlist(key, stamp, null)
    return null
  }
  plistSpawnCount += 1
  let plist: Record<string, unknown> | null = null
  try {
    const raw = execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', infoPlistPath],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      },
    )
    const parsed = JSON.parse(raw) as unknown
    plist = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    plist = null
  }
  rememberPlist(key, stamp, plist)
  return plist
}

function plistString(plist: Record<string, unknown>, key: string): string | null {
  const value = plist[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function registeredSchemes(plist: Record<string, unknown>): Set<string> {
  const schemes = new Set<string>()
  const urlTypes = plist.CFBundleURLTypes
  if (!Array.isArray(urlTypes)) return schemes

  for (const value of urlTypes) {
    if (!value || typeof value !== 'object') continue
    const typeSchemes = (value as Record<string, unknown>).CFBundleURLSchemes
    if (!Array.isArray(typeSchemes)) continue
    for (const scheme of typeSchemes) {
      if (typeof scheme === 'string') schemes.add(scheme.trim().toLowerCase())
    }
  }
  return schemes
}

function handlesWebUrls(plist: Record<string, unknown>): boolean {
  const schemes = registeredSchemes(plist)
  return schemes.has('http') && schemes.has('https')
}

function classifyMacBrowserFamily(appPath: string): BrowserFamily {
  if (
    fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'omni.ja'))
    || fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'browser', 'omni.ja'))
  ) {
    return 'firefox'
  }

  try {
    const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')
    const frameworks = fs.readdirSync(frameworksPath)
    if (frameworks.some((entry) =>
      /\sframework\.framework$/i.test(entry)
      || /^arccore\.framework$/i.test(entry)
      || /(?:chromium|chrome|electron|cef).*\.framework$/i.test(entry))) {
      return 'chromium'
    }
  } catch {
    // A WebKit app may have no app-private browser framework.
  }

  return 'webkit'
}

function inspectMacBrowserApplication(appPath: string): BrowserApplication | null {
  const normalizedAppPath = appBundlePath(appPath)
  if (!normalizedAppPath) return null
  const plist = plistJson(normalizedAppPath)
  if (!plist || !handlesWebUrls(plist)) return null

  const bundleId = plistString(plist, 'CFBundleIdentifier')
  const name = plistString(plist, 'CFBundleDisplayName')
    ?? plistString(plist, 'CFBundleName')
    ?? path.basename(normalizedAppPath, '.app')
  if (!bundleId) return null

  return {
    name,
    bundleId,
    appPath: normalizedAppPath,
    family: classifyMacBrowserFamily(normalizedAppPath),
    source: 'info_plist',
  }
}

// Same-install identity across capture backends: the poll backend only knows
// the executable path when the active-window module reports no bundle id,
// while macOS focus events report the real CFBundleIdentifier. Reading the
// .app bundle's Info.plist maps the path onto that same identifier so one
// install never mints two identities. Results — including misses — are cached
// because this sits on the capture poll.
const bundleIdentifierByAppPath = new Map<string, string | null>()

export function macBundleIdentifierForExecutablePath(
  executablePath: string | null | undefined,
): string | null {
  const bundlePath = appBundlePath(executablePath)
  if (!bundlePath || !bundlePath.startsWith('/')) return null
  const cacheKey = normalizedPath(bundlePath)
  const cached = bundleIdentifierByAppPath.get(cacheKey)
  if (cached !== undefined) return cached
  const plist = plistJson(bundlePath)
  const bundleId = plist ? plistString(plist, 'CFBundleIdentifier') : null
  bundleIdentifierByAppPath.set(cacheKey, bundleId)
  return bundleId
}

export function parseLaunchServicesBrowserDump(dump: string): BrowserApplication[] {
  const applications: BrowserApplication[] = []
  const records = dump.split(/\n-{40,}\n/g)

  for (const record of records) {
    const claimedSchemes = record.match(/^claimed schemes:\s+(.+?)\s*$/im)?.[1] ?? ''
    if (!/(?:^|[,\s])http:(?:$|[,\s])/i.test(claimedSchemes)) continue
    if (!/(?:^|[,\s])https:(?:$|[,\s])/i.test(claimedSchemes)) continue
    const isRegisteredWebBrowser =
      /^more flags:\s+.*\bweb-browser\b/im.test(record)
      || /^claimed UTIs:\s+.*\bcom\.apple\.default-app\.web-browser\b/im.test(record)
      || /\bNSUserActivityTypeBrowsingWeb\b/.test(record)
    if (!isRegisteredWebBrowser) continue

    const appPath = record.match(/^path:\s+(.+?\.app)(?:\s+\(0x[0-9a-f]+\))?\s*$/im)?.[1]?.trim()
    const bundleId = record.match(/^identifier:\s+([^\s]+)\s*$/im)?.[1]?.trim()
    const name = record.match(/^displayName:\s+(.+?)\s*$/im)?.[1]?.trim()
      ?? record.match(/^name:\s+(.+?)\s*$/im)?.[1]?.trim()
    if (!appPath || !bundleId || !name) continue

    applications.push({
      name,
      bundleId,
      appPath,
      family: classifyMacBrowserFamily(appPath),
      source: 'launch_services',
    })
  }

  return unique(applications, (app) => app.bundleId.toLowerCase())
}

const execFileAsync = promisify(execFile)

// Populate the registry cache off the main thread. The synchronous reader falls
// back to `lsregister -dump`, a ~4s subprocess plus ~1.5s of parsing on macOS —
// catastrophic when it runs lazily on a user's first Apps/Timeline click. Run
// the same discovery asynchronously at startup so the subprocess never blocks
// the main thread and the cache is warm before the first interaction. Exact
// behaviour of the sync path is preserved; this only changes when it runs.
export async function prewarmBrowserRegistry(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (registryCache && Date.now() - registryCache.readAt < REGISTRY_CACHE_MS) return

  const helperCandidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'build', 'capture-helper')] : []),
    path.join(__dirname, '..', '..', 'build', 'capture-helper'),
    path.join(process.cwd(), 'build', 'capture-helper'),
  ]

  for (const helperPath of helperCandidates) {
    if (!fs.existsSync(helperPath)) continue
    try {
      const { stdout } = await execFileAsync(helperPath, [], {
        encoding: 'utf8',
        env: { ...process.env, DAYLENS_CAPTURE_HELPER_BROWSER_DISCOVERY: '1' },
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const parsed = JSON.parse(stdout) as BrowserApplication[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        registryCache = {
          readAt: Date.now(),
          applications: parsed.map((application) => ({
            ...application,
            family: classifyMacBrowserFamily(application.appPath),
            source: 'launch_services' as const,
          })),
        }
        historyCache = null
        return
      }
    } catch {
      // Helper unavailable or returned nothing — fall through to lsregister.
    }
  }

  try {
    const { stdout } = await execFileAsync(LSREGISTER_PATH, ['-dump'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
    })
    registryCache = { readAt: Date.now(), applications: parseLaunchServicesBrowserDump(stdout) }
    historyCache = null
  } catch {
    // Leave the cache cold; the lazy synchronous path still resolves on first use.
  }
}

let prewarmInFlight: Promise<void> | null = null

// Kick off a single background refresh; callers get whatever is cached now.
function ensureRegistryWarming(): void {
  if (prewarmInFlight) return
  prewarmInFlight = prewarmBrowserRegistry().finally(() => { prewarmInFlight = null })
}

function getBrowserApplications(): BrowserApplication[] {
  if (process.platform !== 'darwin') return []
  // Never block a synchronous read path on the ~5s LaunchServices dump. If the
  // cache is missing or stale, refresh it in the background and serve what we
  // have (an empty list until the first warm completes). Common browsers are
  // resolved from the app catalog before this fallback, so only obscure
  // non-catalog browsers are momentarily undetected right after launch.
  if (!registryCache || Date.now() - registryCache.readAt >= REGISTRY_CACHE_MS) {
    ensureRegistryWarming()
  }
  return registryCache?.applications ?? []
}

function candidateMatchesApplication(candidate: BrowserCandidate, application: BrowserApplication): boolean {
  const bundleId = candidate.bundleId?.trim().toLowerCase()
  if (bundleId && bundleId === application.bundleId.toLowerCase()) return true

  const candidatePaths = [candidate.executablePath, candidate.bundleId]
    .map(appBundlePath)
    .filter((value): value is string => Boolean(value))
    .map(normalizedPath)
  return candidatePaths.includes(normalizedPath(application.appPath))
}

export function resolveBrowserApplication(candidate: BrowserCandidate): BrowserApplication | null {
  if (process.platform === 'win32') return resolveWindowsBrowserApplication(candidate)
  if (process.platform === 'linux') return resolveLinuxBrowserApplication(candidate)
  if (process.platform !== 'darwin') return null

  for (const possiblePath of [candidate.executablePath, candidate.bundleId]) {
    const inspected = inspectMacBrowserApplication(possiblePath ?? '')
    if (!inspected) continue
    const applications = unique(
      [...(registryCache?.applications ?? []), inspected],
      (application) => application.bundleId.toLowerCase(),
    )
    registryCache = { readAt: Date.now(), applications }
    historyCache = null
    return inspected
  }

  return getBrowserApplications()
    .find((application) => candidateMatchesApplication(candidate, application))
    ?? null
}

export function isBrowserApplication(candidate: BrowserCandidate): boolean {
  if (process.platform === 'win32') return isWindowsBrowserApplication(candidate)
  if (process.platform === 'linux') return isLinuxBrowserApplication(candidate)
  return resolveBrowserApplication(candidate) !== null
}

function scanForHistoryFiles(root: string): string[] {
  const found: string[] = []
  const visit = (directory: string, depth: number) => {
    if (depth > MAX_HISTORY_SCAN_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isFile() && (entry.name === 'History' || entry.name === 'History.db' || entry.name === 'places.sqlite')) {
        found.push(fullPath)
        continue
      }
      if (!entry.isDirectory() || SKIPPED_SCAN_DIRECTORIES.has(entry.name.toLowerCase())) continue
      visit(fullPath, depth + 1)
    }
  }

  visit(root, 0)
  return found
}

function identityTokens(application: BrowserApplication): string[] {
  const values = [
    application.name,
    application.bundleId,
    path.basename(application.appPath, '.app'),
  ]
  const ignored = new Set(['app', 'browser', 'com', 'company', 'org', 'the', 'www'])
  return unique(
    values.flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
      .filter((token) => token.length >= 3 && !ignored.has(token)),
    (token) => token,
  )
}

function historyPathMatchesFamily(historyPath: string, family: BrowserFamily): boolean {
  const base = path.basename(historyPath)
  if (family === 'firefox') return base === 'places.sqlite'
  if (family === 'webkit') return base === 'History.db' || base === 'History'
  return base === 'History'
}

function identityPathScore(candidatePath: string, application: BrowserApplication): number {
  const lowerPath = candidatePath.toLowerCase()
  return identityTokens(application).reduce(
    (score, token) => score + (lowerPath.includes(token) ? token.length : 0),
    0,
  )
}

function profileIdForHistoryPath(historyPath: string): string {
  const parent = path.basename(path.dirname(historyPath))
  if (/^default$/i.test(parent)) return 'default'
  if (/^profile \d+$/i.test(parent)) return parent
  if (/profiles?$/i.test(parent)) return 'default'
  return parent || 'default'
}

export function discoverMacBrowserHistoryLocations(
  applications = getBrowserApplications(),
  home = os.homedir(),
): BrowserHistoryLocation[] {
  const locations: BrowserHistoryLocation[] = []
  const appSupport = path.join(home, 'Library', 'Application Support')
  const containers = path.join(home, 'Library', 'Containers')

  for (const application of applications) {
    const roots = new Set<string>()
    const considerChildren = (root: string, maxDepth: number) => {
      let current = [root]
      for (let depth = 0; depth <= maxDepth; depth++) {
        const next: string[] = []
        for (const directory of current) {
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(directory, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const child = path.join(directory, entry.name)
            if (identityPathScore(child, application) > 0) roots.add(child)
            next.push(child)
          }
        }
        current = next
      }
    }

    considerChildren(appSupport, 1)
    const containerRoot = path.join(containers, application.bundleId)
    if (fs.existsSync(containerRoot)) roots.add(containerRoot)
    if (identityTokens(application).includes('safari')) {
      roots.add(path.join(home, 'Library', 'Safari'))
    }

    const historyPaths = unique(
      [...roots].flatMap((root) => scanForHistoryFiles(root)),
      normalizedPath,
    )
    for (const historyPath of historyPaths) {
      if (!historyPathMatchesFamily(historyPath, application.family)) continue
      locations.push({
        ...application,
        historyPath,
        profileId: profileIdForHistoryPath(historyPath),
      })
    }
  }

  return unique(locations, (location) => normalizedPath(location.historyPath))
}

export function getMacBrowserHistoryLocations(): BrowserHistoryLocation[] {
  if (process.platform !== 'darwin') return []
  if (!historyCache || Date.now() - historyCache.readAt >= HISTORY_CACHE_MS) {
    historyCache = {
      readAt: Date.now(),
      locations: discoverMacBrowserHistoryLocations(),
    }
  }
  return historyCache.locations
}

export { getLinuxBrowserHistoryLocations }
