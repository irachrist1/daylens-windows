// Browser history polling service.
// Reads local browser SQLite history files periodically, extracts domain-level
// visit data, and writes it to the website_visits table.
//
// Architecture:
//   - Copy History + WAL + SHM to a tmp location before opening (avoids lock contention)
//   - Only read visits newer than the last successful poll cursor per browser
//   - INSERT OR IGNORE on (browser_bundle_id, visit_time_us, url) prevents duplicate rows
//   - All failures are silent — never crashes the main app startup
//
// Platform support:
//   macOS: Chrome, Brave, Arc, Dia, Comet, Microsoft Edge
//   Windows: Chrome, Edge, Brave, Arc, Dia, Comet (all Chromium profiles), Firefox

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import type { SafariHistoryAccessStatus } from '@shared/types'
import { getDb } from './database'
import {
  getBrowserHistoryCursor,
  insertWebsiteVisit,
  setBrowserHistoryCursor,
} from '../db/queries'
import { normalizeUrlForStorage, pageKeyForUrl, resolveCanonicalBrowser, sanitizeUrlForPersistence } from '../lib/appIdentity'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { localDateString } from '../lib/localDate'
import { capture, captureRateLimited } from './analytics'
import {
  getLinuxBrowserHistoryLocations,
  getMacBrowserHistoryLocations,
  type BrowserFamily,
} from './browserRegistry'
import { getWindowsBrowserHistoryLocations } from './windowsBrowserRegistry'
import { decideAppCapture, decideSiteCapture, trackingControlsStateFromSettings } from '@shared/trackingControls'
import { getSettings } from './settings'

// ─── Chrome timestamp arithmetic ─────────────────────────────────────────────
// Chrome stores timestamps as microseconds since 1601-01-01 00:00:00 UTC.
// Current values (~1.34e16) exceed Number.MAX_SAFE_INTEGER (~9.0e15), so BigInt
// arithmetic is required to avoid precision loss.

const CHROME_OFFSET_US = 11_644_473_600_000_000n  // µs between 1601 and Unix epoch

function msToChromeUs(ms: number): bigint {
  return BigInt(ms) * 1000n + CHROME_OFFSET_US
}

function chromeUsToMs(us: bigint): number {
  return Number((us - CHROME_OFFSET_US) / 1000n)
}

// ─── Browser path registry ────────────────────────────────────────────────────

export interface BrowserEntry {
  name: string
  bundleId: string      // macOS bundle ID or Windows executable/browser identifier
  historyPath: string
  type: BrowserFamily
}

interface ChromiumHistoryRow {
  url: string
  title: string | null
  visit_time: bigint
  visit_duration: bigint
}

interface FirefoxHistoryRow {
  url: string
  title: string | null
  visit_date: bigint   // microseconds since Unix epoch
  visit_type: number
}

interface WebKitHistoryRow {
  url: string
  title: string | null
  visit_time: number
}

interface ProcessedHistoryRow {
  domain: string
  pageTitle: string | null
  url: string
  visitTime: number    // Unix ms
  visitTimeUs: bigint  // microseconds (Chrome: from Chrome epoch; Firefox: from Unix epoch)
  durationSec: number
}

function macBrowsers(): BrowserEntry[] {
  return getMacBrowserHistoryLocations().map((location) => ({
    name: location.profileId === 'default'
      ? location.name
      : `${location.name} (${location.profileId})`,
    bundleId: location.profileId === 'default'
      ? location.bundleId
      : `${location.bundleId}:${location.profileId}`,
    historyPath: location.historyPath,
    type: location.family,
  }))
}

function enumerateChromiumProfiles(userDataDir: string, name: string, bundleId: string): BrowserEntry[] {
  const entries: BrowserEntry[] = []
  // Always include Default profile
  const defaultPath = path.join(userDataDir, 'Default', 'History')
  if (fs.existsSync(defaultPath)) {
    entries.push({ name, bundleId, historyPath: defaultPath, type: 'chromium' })
  }

  // Enumerate Profile 1, Profile 2, etc.
  try {
    const items = fs.readdirSync(userDataDir)
    for (const item of items) {
      if (/^Profile \d+$/.test(item)) {
        const profileHistoryPath = path.join(userDataDir, item, 'History')
        if (fs.existsSync(profileHistoryPath)) {
          entries.push({
            name:        `${name} (${item})`,
            bundleId:    `${bundleId}:${item}`,
            historyPath: profileHistoryPath,
            type:        'chromium',
          })
        }
      }
    }
  } catch { /* directory not readable */ }

  return entries
}

function enumerateChromiumProfileRoots(userDataDirs: string[], name: string, bundleId: string): BrowserEntry[] {
  const entries: BrowserEntry[] = []
  const seenHistoryPaths = new Set<string>()

  for (const userDataDir of userDataDirs) {
    for (const entry of enumerateChromiumProfiles(userDataDir, name, bundleId)) {
      const key = path.resolve(entry.historyPath).toLowerCase()
      if (seenHistoryPaths.has(key)) continue
      seenHistoryPaths.add(key)
      entries.push(entry)
    }
  }

  return entries
}

function parseFirefoxProfilesIni(iniPath: string): string[] {
  const profileDirs: string[] = []
  try {
    const content = fs.readFileSync(iniPath, 'utf-8')
    let currentPath = ''
    let isRelative = true

    for (const line of content.split(/\r?\n/)) {
      if (/^\[Profile\d+\]/i.test(line)) {
        currentPath = ''
        isRelative = true
      } else if (/^Path=/i.test(line)) {
        currentPath = line.replace(/^Path=/i, '').trim()
      } else if (/^IsRelative=0/i.test(line)) {
        isRelative = false
      } else if (/^\[/.test(line) && currentPath) {
        const resolved = isRelative
          ? path.join(path.dirname(iniPath), currentPath)
          : currentPath
        profileDirs.push(resolved)
        currentPath = ''
      }
    }
    // Push last profile
    if (currentPath) {
      const resolved = isRelative
        ? path.join(path.dirname(iniPath), currentPath)
        : currentPath
      profileDirs.push(resolved)
    }
  } catch { /* not found or unreadable */ }

  return profileDirs
}

function windowsBrowsersFromRegistry(): BrowserEntry[] {
  return getWindowsBrowserHistoryLocations().map((location) => ({
    name: location.profileId === 'default'
      ? location.name
      : `${location.name} (${location.profileId})`,
    bundleId: location.profileId === 'default'
      ? location.bundleId
      : `${location.bundleId}:${location.profileId}`,
    historyPath: location.historyPath,
    type: location.family,
  }))
}

function windowsBrowsersStatic(): BrowserEntry[] {
  const local = path.join(os.homedir(), 'AppData', 'Local')
  const roaming = path.join(os.homedir(), 'AppData', 'Roaming')
  const entries: BrowserEntry[] = []

  // Chrome — enumerate all profiles
  entries.push(
    ...enumerateChromiumProfiles(
      path.join(local, 'Google/Chrome/User Data'),
      'Google Chrome',
      'chrome.exe',
    ),
  )

  // Edge — enumerate all profiles
  entries.push(
    ...enumerateChromiumProfiles(
      path.join(local, 'Microsoft/Edge/User Data'),
      'Microsoft Edge',
      'msedge.exe',
    ),
  )

  // Brave — enumerate all profiles
  entries.push(
    ...enumerateChromiumProfiles(
      path.join(local, 'BraveSoftware/Brave-Browser/User Data'),
      'Brave',
      'brave.exe',
    ),
  )

  // Arc / Dia / Comet are Chromium-based, but vendor packaging can vary between
  // a direct user-data root and a product root that contains `User Data`.
  entries.push(
    ...enumerateChromiumProfileRoots([
      path.join(local, 'Arc'),
      path.join(local, 'Arc/User Data'),
      path.join(local, 'TheBrowserCompany/Arc'),
      path.join(local, 'TheBrowserCompany/Arc/User Data'),
      path.join(local, 'The Browser Company/Arc'),
      path.join(local, 'The Browser Company/Arc/User Data'),
    ], 'Arc', 'arc.exe'),
  )
  entries.push(
    ...enumerateChromiumProfileRoots([
      path.join(local, 'Dia'),
      path.join(local, 'Dia/User Data'),
      path.join(local, 'TheBrowserCompany/Dia'),
      path.join(local, 'TheBrowserCompany/Dia/User Data'),
      path.join(local, 'The Browser Company/Dia'),
      path.join(local, 'The Browser Company/Dia/User Data'),
    ], 'Dia', 'dia.exe'),
  )
  entries.push(
    ...enumerateChromiumProfileRoots([
      path.join(local, 'Comet'),
      path.join(local, 'Comet/User Data'),
      path.join(local, 'Perplexity/Comet'),
      path.join(local, 'Perplexity/Comet/User Data'),
    ], 'Comet', 'comet.exe'),
  )

  // Firefox — discover profiles from profiles.ini
  const firefoxIni = path.join(roaming, 'Mozilla/Firefox/profiles.ini')
  const ffProfiles = parseFirefoxProfilesIni(firefoxIni)
  for (let i = 0; i < ffProfiles.length; i++) {
    const dbPath = path.join(ffProfiles[i], 'places.sqlite')
    if (fs.existsSync(dbPath)) {
      entries.push({
        name:        i === 0 ? 'Firefox' : `Firefox (Profile ${i})`,
        bundleId:    i === 0 ? 'firefox.exe' : `firefox.exe:${i}`,
        historyPath: dbPath,
        type:        'firefox',
      })
    }
  }

  // Zen uses Firefox's places.sqlite format under its own roaming profile root.
  const zenIni = path.join(roaming, 'Zen/profiles.ini')
  const zenProfiles = parseFirefoxProfilesIni(zenIni)
  for (let i = 0; i < zenProfiles.length; i++) {
    const dbPath = path.join(zenProfiles[i], 'places.sqlite')
    if (fs.existsSync(dbPath)) {
      entries.push({
        name:        i === 0 ? 'Zen' : `Zen (Profile ${i})`,
        bundleId:    i === 0 ? 'zen.exe' : `zen.exe:${i}`,
        historyPath: dbPath,
        type:        'firefox',
      })
    }
  }

  return entries
}

function uniqueBrowserEntries(entries: BrowserEntry[]): BrowserEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = path.resolve(entry.historyPath).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function windowsBrowsers(): BrowserEntry[] {
  const registryEntries = windowsBrowsersFromRegistry()
  return uniqueBrowserEntries([...registryEntries, ...windowsBrowsersStatic()])
}

function linuxBrowsers(): BrowserEntry[] {
  return getLinuxBrowserHistoryLocations().map((location) => ({
    name: location.profileId === 'default'
      ? location.name
      : `${location.name} (${location.profileId})`,
    bundleId: location.profileId === 'default'
      ? location.bundleId
      : `${location.bundleId}:${location.profileId}`,
    historyPath: location.historyPath,
    type: location.family,
  }))
}

export function getBrowserEntries(): BrowserEntry[] {
  if (process.platform === 'darwin') return macBrowsers()
  if (process.platform === 'win32') return windowsBrowsers()
  if (process.platform === 'linux') return linuxBrowsers()
  return []
}

// ─── Domain extraction ────────────────────────────────────────────────────────

function extractDomain(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function processChromiumRows(rows: ChromiumHistoryRow[]): ProcessedHistoryRow[] {
  return rows
    .map((row, i) => {
      const visitMs = chromeUsToMs(row.visit_time)
      const chromeDurationSec = Math.max(0, Number(row.visit_duration / 1_000_000n))

      if (chromeDurationSec > 0 && chromeDurationSec < 2) return null

      const domain = extractDomain(row.url)
      if (!domain) return null

      let estimatedDurationSec: number
      if (i < rows.length - 1) {
        const nextVisitMs = chromeUsToMs(rows[i + 1].visit_time)
        estimatedDurationSec = Math.round((nextVisitMs - visitMs) / 1000)
        estimatedDurationSec = Math.min(Math.max(estimatedDurationSec, 0), 1800)
      } else {
        estimatedDurationSec = chromeDurationSec > 0 ? chromeDurationSec : 30
      }

      const finalDuration = chromeDurationSec > 2
        ? Math.max(Math.min(chromeDurationSec, estimatedDurationSec), 1)
        : Math.max(estimatedDurationSec, 5)

      return {
        domain,
        pageTitle: row.title ?? null,
        url: row.url,
        visitTime: visitMs,
        visitTimeUs: row.visit_time,
        durationSec: finalDuration,
      }
    })
    .filter((row): row is ProcessedHistoryRow => row !== null)
}

function processFirefoxRows(rows: FirefoxHistoryRow[]): ProcessedHistoryRow[] {
  return rows
    .map((row, i) => {
      // Firefox visit_date is microseconds since Unix epoch
      const visitMs = Number(row.visit_date / 1000n)

      // Skip bookmarks / history entries that aren't typed/linked visits (visit_type >= 1)
      // Type 0 means not a visit, types 1-9 are all real page views
      if (row.visit_type === 0) return null

      const domain = extractDomain(row.url)
      if (!domain) return null

      let estimatedDurationSec: number
      if (i < rows.length - 1) {
        const nextVisitMs = Number(rows[i + 1].visit_date / 1000n)
        estimatedDurationSec = Math.round((nextVisitMs - visitMs) / 1000)
        estimatedDurationSec = Math.min(Math.max(estimatedDurationSec, 0), 1800)
      } else {
        estimatedDurationSec = 30
      }

      return {
        domain,
        pageTitle: row.title ?? null,
        url: row.url,
        visitTime: visitMs,
        visitTimeUs: row.visit_date,
        durationSec: Math.max(estimatedDurationSec, 5),
      }
    })
    .filter((row): row is ProcessedHistoryRow => row !== null)
}

const WEBKIT_EPOCH_OFFSET_SEC = 978_307_200

function processWebKitRows(rows: WebKitHistoryRow[]): ProcessedHistoryRow[] {
  return rows
    .map((row, index) => {
      const visitMs = Math.round((row.visit_time + WEBKIT_EPOCH_OFFSET_SEC) * 1_000)
      const domain = extractDomain(row.url)
      if (!domain) return null

      const nextVisitMs = index < rows.length - 1
        ? Math.round((rows[index + 1].visit_time + WEBKIT_EPOCH_OFFSET_SEC) * 1_000)
        : visitMs + 30_000
      const estimatedDurationSec = Math.min(
        Math.max(Math.round((nextVisitMs - visitMs) / 1_000), 5),
        1_800,
      )

      return {
        domain,
        pageTitle: row.title ?? null,
        url: row.url,
        visitTime: visitMs,
        visitTimeUs: BigInt(visitMs) * 1_000n,
        durationSec: estimatedDurationSec,
      }
    })
    .filter((row): row is ProcessedHistoryRow => row !== null)
}

// ─── State ────────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null

// Per-browser cursor: Map<bundleId, last processed visit_time_us as bigint>
const browserCursors = new Map<string, bigint>()

const browserStatus = {
  lastPoll:         null as number | null,
  visitsToday:      0,
  error:            null as string | null,
  browsersPollable: 0,
}

// Safari's History.db lives under ~/Library/Safari, which is TCC-protected and
// requires Full Disk Access (FDA). macOS has no programmatic "is FDA granted?"
// API, so this is inferred purely from whether the WebKit poll's copyFileSync of
// History.db succeeds. Starts 'unknown' until the first WebKit poll attempt.
let safariHistoryAccessStatus: SafariHistoryAccessStatus = 'unknown'

function isPermissionDeniedError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EPERM' || code === 'EACCES') return true
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('Operation not permitted') || message.includes('EPERM') || message.includes('EACCES')
}

// Updates the persistent Safari FDA status and logs the transition once — not on
// every 60s poll — so denied/restored states don't spam the log while the poller
// keeps retrying in the background.
function setSafariHistoryAccessStatus(next: SafariHistoryAccessStatus, browser: BrowserEntry): void {
  if (safariHistoryAccessStatus === next) return
  const prev = safariHistoryAccessStatus
  safariHistoryAccessStatus = next
  if (next === 'denied') {
    console.warn(
      `[browser] Safari history capture blocked — reading ${browser.name} history requires Full Disk Access ` +
      `(System Settings > Privacy & Security > Full Disk Access). Daylens will pick it up automatically on the ` +
      `next poll once granted.`,
    )
  } else if (next === 'ok' && prev === 'denied') {
    console.log('[browser] Safari history access restored — Full Disk Access is granted, capturing Safari history again.')
  }
}

function getDiscoveredBrowserDiagnostics() {
  return getBrowserEntries().map((browser) => ({
    name: browser.name,
    bundleId: browser.bundleId,
    type: browser.type,
    historyPath: browser.historyPath,
    historyExists: fs.existsSync(browser.historyPath),
  }))
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startBrowserTracking(): void {
  if (pollTimer) return
  // First poll fires immediately after startBrowserTracking() is called
  // (caller defers the call by 5 s after window show — see index.ts)
  void pollAll()
  pollTimer = setInterval(() => void pollAll(), 60_000)
  capture(ANALYTICS_EVENT.BROWSER_TRACKING_HEALTH, {
    status: 'started',
    surface: 'browser',
  })
  console.log('[browser] tracking started')
}

export function stopBrowserTracking(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function getBrowserStatus() {
  return {
    ...browserStatus,
    safariHistoryAccess: safariHistoryAccessStatus,
    discoveredBrowsers: getDiscoveredBrowserDiagnostics(),
  }
}

// Copies a browser History DB (+WAL/SHM) for reading without stalling the
// main process: COPYFILE_FICLONE makes it an O(1) APFS clone when source and
// tmpdir share a volume, and the fallback byte copy runs on the libuv
// threadpool instead of blocking the event loop the way copyFileSync did
// (History DBs run to hundreds of MB).
async function copyHistorySnapshot(historyPath: string, tmpDb: string, tmpWal: string, tmpShm: string): Promise<void> {
  await fsp.copyFile(historyPath, tmpDb, fs.constants.COPYFILE_FICLONE)
  const walSrc = historyPath + '-wal'
  const shmSrc = historyPath + '-shm'
  if (fs.existsSync(walSrc)) await fsp.copyFile(walSrc, tmpWal, fs.constants.COPYFILE_FICLONE)
  if (fs.existsSync(shmSrc)) await fsp.copyFile(shmSrc, tmpShm, fs.constants.COPYFILE_FICLONE)
}

// ─── Chromium poll ─────────────────────────────────────────────────────────────

function loadBrowserCursor(db: ReturnType<typeof getDb>, bundleId: string): bigint | null {
  return browserCursors.get(bundleId) ?? getBrowserHistoryCursor(db, bundleId)
}

function persistBrowserCursor(
  db: ReturnType<typeof getDb>,
  bundleId: string,
  cursor: bigint,
): void {
  browserCursors.set(bundleId, cursor)
  setBrowserHistoryCursor(db, bundleId, cursor)
}

function historyVisitInsert(
  db: ReturnType<typeof getDb>,
  browser: BrowserEntry,
  processed: ProcessedHistoryRow,
  source: string,
): boolean {
  const persistedUrl = sanitizeUrlForPersistence(processed.url)
  if (!persistedUrl) return false
  const browserIdentity = resolveCanonicalBrowser(browser.bundleId)
  return insertWebsiteVisit(db, {
    domain: processed.domain,
    pageTitle: processed.pageTitle,
    url: persistedUrl,
    normalizedUrl: normalizeUrlForStorage(processed.url),
    pageKey: pageKeyForUrl(processed.url),
    visitTime: processed.visitTime,
    visitTimeUs: processed.visitTimeUs,
    durationSec: processed.durationSec,
    browserBundleId: browser.bundleId,
    canonicalBrowserId: browserIdentity.canonicalBrowserId,
    browserProfileId: browserIdentity.browserProfileId,
    source,
  })
}

async function pollChromium(
  browser: BrowserEntry,
  db: ReturnType<typeof getDb>,
): Promise<{ inserted: number; error: string | null }> {
  const tmpBase = path.join(os.tmpdir(), `daylens_bh_${Date.now()}`)
  const tmpDb   = tmpBase + '.sqlite'
  const tmpWal  = tmpBase + '.sqlite-wal'
  const tmpShm  = tmpBase + '.sqlite-shm'

  let inserted = 0
  let error: string | null = null

  const lastCursorUs = loadBrowserCursor(db, browser.bundleId)
  // If no cursor yet, start from 24h ago
  const fromUs: bigint = lastCursorUs ?? msToChromeUs(Date.now() - 86_400_000)
  const controls = trackingControlsStateFromSettings(getSettings())

  try {
    await copyHistorySnapshot(browser.historyPath, tmpDb, tmpWal, tmpShm)

    const histDb = new Database(tmpDb, { readonly: true })
    histDb.defaultSafeIntegers(true)

    const query = histDb.prepare(`
      SELECT u.url, u.title, v.visit_time, v.visit_duration
      FROM visits v
      JOIN urls u ON v.url = u.id
      WHERE v.visit_time > ?
      ORDER BY v.visit_time ASC
      LIMIT 500
    `)

    let cursor = fromUs
    let batchCount = 0
    const MAX_BATCHES = 10

    while (batchCount < MAX_BATCHES) {
      const rows = query.all(cursor) as ChromiumHistoryRow[]
      if (rows.length === 0) break

      const isFinalBatch = rows.length < 500
      // Hold the last row as a pending carry-over when the batch is not terminal
      // (its duration estimate needs the first row of the next batch as the successor)
      const rowsToProcess = isFinalBatch ? rows : rows.slice(0, -1)

      for (const processed of processChromiumRows(rowsToProcess)) {
        if (!decideSiteCapture(controls, { domain: processed.domain }).capture) continue
        if (historyVisitInsert(db, browser, processed, 'chrome_history')) inserted++
      }

      const lastRowUs = rows[rows.length - 1].visit_time

      if (isFinalBatch) {
        // Backlog fully drained — advance cursor past the last row
        cursor = lastRowUs
        batchCount++
        break
      }

      // Batch limit hit — advance cursor to last processed row (NOT pollNow).
      // The unprocessed last row will be the first result of the next batch.
      cursor = rows[rows.length - 2]?.visit_time ?? lastRowUs
      batchCount++

      if (batchCount === MAX_BATCHES) {
        console.warn(`[browser] hit batch limit while polling ${browser.name} — continuing next poll from cursor`)
        break
      }
    }

    // Persist the cursor only after a successful read/write pass.
    persistBrowserCursor(db, browser.bundleId, cursor)

    histDb.close()
  } catch (err) {
    error = String(err)
    console.warn(`[browser] failed to poll ${browser.name}:`, err)
    captureRateLimited(ANALYTICS_EVENT.BROWSER_TRACKING_HEALTH, `browser:${browser.bundleId}`, {
      failure_kind: classifyFailureKind(err),
      reason: 'poll',
      status: 'error',
      surface: 'browser',
    })
  } finally {
    for (const f of [tmpDb, tmpWal, tmpShm]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch { /* best-effort: temp file may already be gone */ }
    }
  }

  return { inserted, error }
}

// ─── Firefox poll ─────────────────────────────────────────────────────────────

async function pollFirefox(
  browser: BrowserEntry,
  db: ReturnType<typeof getDb>,
): Promise<{ inserted: number; error: string | null }> {
  const tmpBase = path.join(os.tmpdir(), `daylens_ff_${Date.now()}`)
  const tmpDb   = tmpBase + '.sqlite'
  const tmpWal  = tmpBase + '.sqlite-wal'
  const tmpShm  = tmpBase + '.sqlite-shm'

  let inserted = 0
  let error: string | null = null

  // Firefox visit_date is Unix µs — not Chrome epoch µs
  const lastCursorUs = loadBrowserCursor(db, browser.bundleId)
  const fromUs: bigint = lastCursorUs ?? (BigInt(Date.now() - 86_400_000) * 1000n)
  const controls = trackingControlsStateFromSettings(getSettings())

  try {
    await copyHistorySnapshot(browser.historyPath, tmpDb, tmpWal, tmpShm)

    const histDb = new Database(tmpDb, { readonly: true })
    histDb.defaultSafeIntegers(true)

    const query = histDb.prepare(`
      SELECT p.url, p.title, v.visit_date, v.visit_type
      FROM moz_historyvisits v
      JOIN moz_places p ON v.place_id = p.id
      WHERE v.visit_date > ?
      ORDER BY v.visit_date ASC
      LIMIT 500
    `)

    let cursor = fromUs
    let batchCount = 0
    const MAX_BATCHES = 10

    while (batchCount < MAX_BATCHES) {
      const rows = query.all(cursor) as FirefoxHistoryRow[]
      if (rows.length === 0) break

      const isFinalBatch = rows.length < 500
      const rowsToProcess = isFinalBatch ? rows : rows.slice(0, -1)

      for (const processed of processFirefoxRows(rowsToProcess)) {
        if (!decideSiteCapture(controls, { domain: processed.domain }).capture) continue
        if (historyVisitInsert(db, browser, processed, 'firefox_history')) inserted++
      }

      const lastRowUs = rows[rows.length - 1].visit_date
      cursor = isFinalBatch ? lastRowUs : (rows[rows.length - 2]?.visit_date ?? lastRowUs)
      batchCount++

      if (isFinalBatch || batchCount === MAX_BATCHES) {
        if (batchCount === MAX_BATCHES && !isFinalBatch) {
          console.warn(`[browser] hit batch limit while polling ${browser.name} — continuing next poll from cursor`)
        }
        break
      }
    }

    persistBrowserCursor(db, browser.bundleId, cursor)
    histDb.close()
  } catch (err) {
    error = String(err)
    console.warn(`[browser] failed to poll ${browser.name}:`, err)
    captureRateLimited(ANALYTICS_EVENT.BROWSER_TRACKING_HEALTH, `browser:${browser.bundleId}`, {
      failure_kind: classifyFailureKind(err),
      reason: 'poll',
      status: 'error',
      surface: 'browser',
    })
  } finally {
    for (const f of [tmpDb, tmpWal, tmpShm]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch { /* best-effort: temp file may already be gone */ }
    }
  }

  return { inserted, error }
}

async function pollWebKit(
  browser: BrowserEntry,
  db: ReturnType<typeof getDb>,
): Promise<{ inserted: number; error: string | null }> {
  const tmpBase = path.join(os.tmpdir(), `daylens_wk_${Date.now()}`)
  const tmpDb = `${tmpBase}.sqlite`
  const tmpWal = `${tmpBase}.sqlite-wal`
  const tmpShm = `${tmpBase}.sqlite-shm`
  let inserted = 0
  let error: string | null = null

  const lastCursorUs = loadBrowserCursor(db, browser.bundleId)
  const fromMs = lastCursorUs ? Number(lastCursorUs / 1_000n) : Date.now() - 86_400_000
  const fromWebKitSeconds = fromMs / 1_000 - WEBKIT_EPOCH_OFFSET_SEC

  try {
    await copyHistorySnapshot(browser.historyPath, tmpDb, tmpWal, tmpShm)
    // Reaching here means the TCC-protected copy of History.db succeeded, i.e.
    // Full Disk Access is granted — clear any prior 'denied' status.
    setSafariHistoryAccessStatus('ok', browser)

    const histDb = new Database(tmpDb, { readonly: true })
    const rows = histDb.prepare(`
      SELECT history_items.url AS url,
             COALESCE(history_visits.title, history_items.title) AS title,
             history_visits.visit_time AS visit_time
      FROM history_visits
      JOIN history_items ON history_visits.history_item = history_items.id
      WHERE history_visits.visit_time > ?
      ORDER BY history_visits.visit_time ASC
      LIMIT 5000
    `).all(fromWebKitSeconds) as WebKitHistoryRow[]

    histDb.close()

    const controls = trackingControlsStateFromSettings(getSettings())
    for (const processed of processWebKitRows(rows)) {
      if (!decideSiteCapture(controls, { domain: processed.domain }).capture) continue
      if (historyVisitInsert(db, browser, processed, 'webkit_history')) inserted++
    }

    const last = rows[rows.length - 1]
    if (last) {
      const lastMs = Math.round((last.visit_time + WEBKIT_EPOCH_OFFSET_SEC) * 1_000)
      persistBrowserCursor(db, browser.bundleId, BigInt(lastMs) * 1_000n)
    }
  } catch (err) {
    error = String(err)
    console.warn(`[browser] failed to poll ${browser.name}:`, err)
    if (isPermissionDeniedError(err)) {
      setSafariHistoryAccessStatus('denied', browser)
    }
    captureRateLimited(ANALYTICS_EVENT.BROWSER_TRACKING_HEALTH, `browser:${browser.bundleId}`, {
      failure_kind: classifyFailureKind(err),
      reason: 'poll',
      status: 'error',
      surface: 'browser',
    })
  } finally {
    for (const target of [tmpDb, tmpWal, tmpShm]) {
      try { if (fs.existsSync(target)) fs.unlinkSync(target) } catch { /* best effort */ }
    }
  }

  return { inserted, error }
}

// ─── Poll all browsers ────────────────────────────────────────────────────────

// Async polls must never overlap: an overlapping run would race the
// per-browser cursor writes and double-insert the same visits window.
let pollInFlight = false

async function pollAll(): Promise<void> {
  if (pollInFlight) return
  pollInFlight = true
  try {
    await pollAllInner()
  } finally {
    pollInFlight = false
  }
}

async function pollAllInner(): Promise<void> {
  const browsers = getBrowserEntries()
  const db       = getDb()
  const pollNow  = Date.now()

  let totalInserted = 0
  let pollable      = 0
  let lastError: string | null = null

  for (const browser of browsers) {
    if (!fs.existsSync(browser.historyPath)) continue
    const controls = trackingControlsStateFromSettings(getSettings())
    if (!decideAppCapture(controls, { bundleId: browser.bundleId, appName: browser.name }).capture) continue
    pollable++

    const result = browser.type === 'firefox'
      ? await pollFirefox(browser, db)
      : browser.type === 'webkit'
        ? await pollWebKit(browser, db)
        : await pollChromium(browser, db)

    totalInserted += result.inserted
    if (result.error) lastError = result.error
  }

  // Count today's visits for status
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const countRow = db
    .prepare(`SELECT COUNT(*) AS c FROM website_visits WHERE visit_time >= ?`)
    .get(todayStart.getTime()) as { c: number } | undefined

  browserStatus.lastPoll         = pollNow
  browserStatus.visitsToday      = countRow?.c ?? 0
  browserStatus.error            = lastError
  browserStatus.browsersPollable = pollable

  captureRateLimited(ANALYTICS_EVENT.BROWSER_TRACKING_HEALTH, 'browser:status', {
    result: totalInserted > 0 ? 'updated' : 'idle',
    status: lastError ? 'error' : 'ok',
    surface: 'browser',
  }, 6 * 60 * 60 * 1_000)

  if (totalInserted > 0) {
    console.log(`[browser] inserted ${totalInserted} visits from ${pollable} browser(s)`)
    invalidateProjectionScope('timeline', 'browser_history_updated', {
      date: localDateString(new Date(pollNow)),
    })
    invalidateProjectionScope('apps', 'browser_history_updated')
    invalidateProjectionScope('insights', 'browser_history_updated', {
      date: localDateString(new Date(pollNow)),
    })
  }
}
