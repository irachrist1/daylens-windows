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
//   macOS: Chrome, Brave, Arc, Microsoft Edge
//   Windows: Chrome, Edge, Brave (all profiles), Firefox

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getDb } from './database'
import { insertWebsiteVisit } from '../db/queries'
import { normalizeUrlForStorage, pageKeyForUrl, resolveCanonicalBrowser } from '../lib/appIdentity'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { localDateString } from '../lib/localDate'

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

interface BrowserEntry {
  name: string
  bundleId: string      // macOS bundle ID or Windows exe name
  historyPath: string
  type: 'chromium' | 'firefox'
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

interface ProcessedHistoryRow {
  domain: string
  pageTitle: string | null
  url: string
  visitTime: number    // Unix ms
  visitTimeUs: bigint  // microseconds (Chrome: from Chrome epoch; Firefox: from Unix epoch)
  durationSec: number
}

function macBrowsers(): BrowserEntry[] {
  const home = os.homedir()
  return [
    {
      name:        'Google Chrome',
      bundleId:    'com.google.Chrome',
      historyPath: path.join(home, 'Library/Application Support/Google/Chrome/Default/History'),
      type:        'chromium',
    },
    {
      name:        'Brave',
      bundleId:    'com.brave.Browser',
      historyPath: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/History'),
      type:        'chromium',
    },
    {
      name:        'Arc',
      bundleId:    'company.thebrowser.Browser',
      historyPath: path.join(home, 'Library/Application Support/Arc/User Data/Default/History'),
      type:        'chromium',
    },
    {
      name:        'Microsoft Edge',
      bundleId:    'com.microsoft.edgemac',
      historyPath: path.join(home, 'Library/Application Support/Microsoft Edge/Default/History'),
      type:        'chromium',
    },
  ]
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

function windowsBrowsers(): BrowserEntry[] {
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

  return entries
}

function getBrowserEntries(): BrowserEntry[] {
  if (process.platform === 'darwin') return macBrowsers()
  if (process.platform === 'win32') return windowsBrowsers()
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

// ─── State ────────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null

// Per-browser cursor: Map<bundleId, last processed visit_time_us as bigint>
const browserCursors = new Map<string, bigint>()

export const browserStatus = {
  lastPoll:         null as number | null,
  visitsToday:      0,
  error:            null as string | null,
  browsersPollable: 0,
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startBrowserTracking(): void {
  if (pollTimer) return
  // First poll fires immediately after startBrowserTracking() is called
  // (caller defers the call by 5 s after window show — see index.ts)
  void pollAll()
  pollTimer = setInterval(() => void pollAll(), 60_000)
  console.log('[browser] tracking started')
}

export function stopBrowserTracking(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function getBrowserStatus() {
  return { ...browserStatus }
}

// ─── Chromium poll ─────────────────────────────────────────────────────────────

function pollChromium(
  browser: BrowserEntry,
  db: ReturnType<typeof getDb>,
): { inserted: number; error: string | null } {
  const tmpBase = path.join(os.tmpdir(), `daylens_bh_${Date.now()}`)
  const tmpDb   = tmpBase + '.sqlite'
  const tmpWal  = tmpBase + '.sqlite-wal'
  const tmpShm  = tmpBase + '.sqlite-shm'

  let inserted = 0
  let error: string | null = null

  const lastCursorUs = browserCursors.get(browser.bundleId) ?? null
  // If no cursor yet, start from 24h ago
  const fromUs: bigint = lastCursorUs ?? msToChromeUs(Date.now() - 86_400_000)

  try {
    fs.copyFileSync(browser.historyPath, tmpDb)
    const walSrc = browser.historyPath + '-wal'
    const shmSrc = browser.historyPath + '-shm'
    if (fs.existsSync(walSrc)) fs.copyFileSync(walSrc, tmpWal)
    if (fs.existsSync(shmSrc)) fs.copyFileSync(shmSrc, tmpShm)

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
        const browserIdentity = resolveCanonicalBrowser(browser.bundleId)
        const didInsert = insertWebsiteVisit(db, {
          domain:          processed.domain,
          pageTitle:       processed.pageTitle,
          url:             processed.url,
          normalizedUrl:   normalizeUrlForStorage(processed.url),
          pageKey:         pageKeyForUrl(processed.url),
          visitTime:       processed.visitTime,
          visitTimeUs:     processed.visitTimeUs,
          durationSec:     processed.durationSec,
          browserBundleId: browser.bundleId,
          canonicalBrowserId: browserIdentity.canonicalBrowserId,
          browserProfileId: browserIdentity.browserProfileId,
          source:          'chrome_history',
        })
        if (didInsert) inserted++
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

    // Persist the cursor so next poll continues from where we left off
    browserCursors.set(browser.bundleId, cursor)

    histDb.close()
  } catch (err) {
    error = String(err)
    console.warn(`[browser] failed to poll ${browser.name}:`, err)
  } finally {
    for (const f of [tmpDb, tmpWal, tmpShm]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {}
    }
  }

  return { inserted, error }
}

// ─── Firefox poll ─────────────────────────────────────────────────────────────

function pollFirefox(
  browser: BrowserEntry,
  db: ReturnType<typeof getDb>,
): { inserted: number; error: string | null } {
  const tmpBase = path.join(os.tmpdir(), `daylens_ff_${Date.now()}`)
  const tmpDb   = tmpBase + '.sqlite'
  const tmpWal  = tmpBase + '.sqlite-wal'
  const tmpShm  = tmpBase + '.sqlite-shm'

  let inserted = 0
  let error: string | null = null

  // Firefox visit_date is Unix µs — not Chrome epoch µs
  const lastCursorUs = browserCursors.get(browser.bundleId) ?? null
  const fromUs: bigint = lastCursorUs ?? (BigInt(Date.now() - 86_400_000) * 1000n)

  try {
    fs.copyFileSync(browser.historyPath, tmpDb)
    const walSrc = browser.historyPath + '-wal'
    const shmSrc = browser.historyPath + '-shm'
    if (fs.existsSync(walSrc)) fs.copyFileSync(walSrc, tmpWal)
    if (fs.existsSync(shmSrc)) fs.copyFileSync(shmSrc, tmpShm)

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
        const browserIdentity = resolveCanonicalBrowser(browser.bundleId)
        const didInsert = insertWebsiteVisit(db, {
          domain:          processed.domain,
          pageTitle:       processed.pageTitle,
          url:             processed.url,
          normalizedUrl:   normalizeUrlForStorage(processed.url),
          pageKey:         pageKeyForUrl(processed.url),
          visitTime:       processed.visitTime,
          visitTimeUs:     processed.visitTimeUs,
          durationSec:     processed.durationSec,
          browserBundleId: browser.bundleId,
          canonicalBrowserId: browserIdentity.canonicalBrowserId,
          browserProfileId: browserIdentity.browserProfileId,
          source:          'firefox_history',
        })
        if (didInsert) inserted++
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

    browserCursors.set(browser.bundleId, cursor)
    histDb.close()
  } catch (err) {
    error = String(err)
    console.warn(`[browser] failed to poll ${browser.name}:`, err)
  } finally {
    for (const f of [tmpDb, tmpWal, tmpShm]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {}
    }
  }

  return { inserted, error }
}

// ─── Poll all browsers ────────────────────────────────────────────────────────

async function pollAll(): Promise<void> {
  const browsers = getBrowserEntries()
  const db       = getDb()
  const pollNow  = Date.now()

  let totalInserted = 0
  let pollable      = 0
  let lastError: string | null = null

  for (const browser of browsers) {
    if (!fs.existsSync(browser.historyPath)) continue
    pollable++

    const { inserted, error } = browser.type === 'firefox'
      ? pollFirefox(browser, db)
      : pollChromium(browser, db)

    totalInserted += inserted
    if (error) lastError = error
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
