import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type BetterSqlite from 'better-sqlite3'
import { insertWebsiteVisit } from '../db/queries'
import { normalizeUrlForStorage, pageKeyForUrl, resolveCanonicalBrowser, sanitizeUrlForPersistence } from '../lib/appIdentity'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { localDateString } from '../lib/localDate'
import { getBrowserEntries, type BrowserEntry } from './browser'
import { getSettings } from './settings'
import { decideSiteCapture, detectIncognitoFromTitle, trackingControlsStateFromSettings, type CaptureBlockReason } from '@shared/trackingControls'
import { categoryForDomain } from '@shared/domainCategories'
import {
  resolveBrowserApplication,
  type BrowserApplication,
} from './browserRegistry'
import { getDb } from './database'

const MIN_CONTEXT_SEC = 10
const RECENT_HISTORY_LOOKBACK_MS = 2 * 60_000
// How long the unchanged-title fast path may reuse the last tab read before a
// re-read is forced. Caps how long two same-title tabs could be conflated while
// still cutting the per-5s-poll osascript/history reads during steady reading.
const TAB_CACHE_TRUST_MS = 30_000
const CHROME_OFFSET_US = 11_644_473_600_000_000n

export interface ActiveBrowserWindowSnapshot {
  bundleId: string
  appName: string
  windowTitle: string | null
  capturedAt: number
  executablePath?: string | null
}

export interface ActiveBrowserTab {
  url: string
  title: string | null
  // True when the read produced a structured private/incognito signal (e.g.
  // Chromium's AppleScript `mode of front window`). Private windows are never
  // tracked — no website visit, no app session — regardless of settings.
  isPrivate?: boolean
  // False when the browser could not report its window mode (Chromium forks
  // that dropped the property, WebKit). Page title/URL are not persisted from
  // these reads — only browser identity and timing (via app sessions) remain
  // until the browser's own non-private history corroborates the page.
  modeKnown?: boolean
}

export type ActiveBrowserTabReader = (snapshot: ActiveBrowserWindowSnapshot) => ActiveBrowserTab | null

export interface ActiveBrowserContextSample {
  isPrivate: boolean
  passivePresence: boolean
  captureBlockReason?: CaptureBlockReason
}

interface InFlightBrowserContext {
  snapshot: ActiveBrowserWindowSnapshot
  tab: ActiveBrowserTab
  normalizedUrl: string | null
  startedAt: number
  lastSeenAt: number
}

function msToChromeUs(ms: number): bigint {
  return BigInt(ms) * 1000n + CHROME_OFFSET_US
}

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function passivePresenceForDomain(domain: string, snapshot: ActiveBrowserWindowSnapshot): boolean {
  const decision = decideSiteCapture(
    trackingControlsStateFromSettings(getSettings()),
    { domain, windowTitle: snapshot.windowTitle },
  )
  if (!decision.capture) return false
  const category = categoryForDomain(domain)
  return category === 'entertainment' || category === 'meetings'
}

function browserAppIdFor(snapshot: ActiveBrowserWindowSnapshot): string | null {
  const application = resolveBrowserApplication({
    bundleId: snapshot.bundleId,
    appName: snapshot.appName,
    executablePath: snapshot.executablePath,
  })
  if (!application) return null
  return resolveCanonicalBrowser(application.bundleId).canonicalBrowserId ?? application.bundleId.toLowerCase()
}

function sameContext(left: InFlightBrowserContext, right: ActiveBrowserTab, normalizedUrl: string | null): boolean {
  if (left.normalizedUrl && normalizedUrl) return left.normalizedUrl === normalizedUrl
  return left.tab.url === right.url
}

function parseTabOutput(output: string): ActiveBrowserTab | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const url = lines[0]
  if (!url) return null
  const title = lines.slice(1).join(' ').trim() || null
  return { url, title }
}

function execOsaScript(script: string): string | null {
  try {
    return execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_500,
    })
  } catch {
    return null
  }
}

function runOsaScript(script: string): ActiveBrowserTab | null {
  const output = execOsaScript(script)
  return output == null ? null : parseTabOutput(output)
}

function browserApplicationFor(snapshot: ActiveBrowserWindowSnapshot): BrowserApplication | null {
  return resolveBrowserApplication({
    bundleId: snapshot.bundleId,
    appName: snapshot.appName,
    executablePath: snapshot.executablePath,
  })
}

// Chromium exposes the front window's mode ("normal"/"incognito") through its
// AppleScript dictionary; browsers whose fork dropped the property (Dia does
// not implement it) answer "unknown" via the try block and read as normal.
function parseChromiumTabOutput(output: string): ActiveBrowserTab | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const url = lines[0]
  if (!url) return null
  const mode = (lines[1] ?? '').toLowerCase()
  if (mode.includes('incognito')) {
    // Never carry the private URL/title out of the read — the signal is all
    // the caller needs to drop the sample.
    return { url: '', title: null, isPrivate: true, modeKnown: true }
  }
  const title = lines.slice(2).join(' ').trim() || null
  return { url, title, modeKnown: mode.includes('normal') }
}

function macActiveTab(snapshot: ActiveBrowserWindowSnapshot): ActiveBrowserTab | null {
  const application = browserApplicationFor(snapshot)
  if (!application || application.family === 'firefox') return null

  if (application.family === 'webkit') {
    const tab = runOsaScript(`
      tell application "${application.name}"
        if (count of windows) is 0 then return ""
        if (count of tabs of front window) is 0 then return ""
        return URL of current tab of front window & linefeed & name of current tab of front window
      end tell
    `)
    // WebKit has no window-mode signal at all — every visit goes through the
    // history-corroboration quarantine.
    return tab ? { ...tab, modeKnown: false } : null
  }

  const output = execOsaScript(`
    tell application "${application.name}"
      if (count of windows) is 0 then return ""
      set windowMode to "unknown"
      try
        set windowMode to (mode of front window) as text
      end try
      if (count of tabs of front window) is 0 then return ""
      return URL of active tab of front window & linefeed & windowMode & linefeed & title of active tab of front window
    end tell
  `)
  return output == null ? null : parseChromiumTabOutput(output)
}

function cleanupHistoryCopy(paths: { dbPath: string; walPath: string; shmPath: string }): void {
  for (const target of [paths.dbPath, paths.walPath, paths.shmPath]) {
    try { if (fs.existsSync(target)) fs.unlinkSync(target) } catch { /* best-effort: temp file may already be gone */ }
  }
}

// This fallback runs on the synchronous 5s foreground poll path, so a full
// byte copy of a multi-hundred-MB History DB would freeze the main process
// for the whole copy. Clone first (O(1) copy-on-write on APFS); when cloning
// is impossible, only small files are byte-copied and anything larger skips
// the read entirely — the 60s history poll backfills those sites.
const MAX_SYNC_HISTORY_COPY_BYTES = 64 * 1024 * 1024

function copyHistoryDb(historyPath: string, prefix: string): { dbPath: string; walPath: string; shmPath: string } | null {
  const tmpBase = path.join(os.tmpdir(), `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`)
  const paths = {
    dbPath: `${tmpBase}.sqlite`,
    walPath: `${tmpBase}.sqlite-wal`,
    shmPath: `${tmpBase}.sqlite-shm`,
  }

  const cloneOrBoundedCopy = (src: string, dst: string): boolean => {
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE_FORCE)
      return true
    } catch {
      try {
        if (fs.statSync(src).size > MAX_SYNC_HISTORY_COPY_BYTES) return false
        fs.copyFileSync(src, dst)
        return true
      } catch {
        return false
      }
    }
  }

  if (!cloneOrBoundedCopy(historyPath, paths.dbPath)) {
    cleanupHistoryCopy(paths)
    return null
  }
  if (fs.existsSync(`${historyPath}-wal`) && !cloneOrBoundedCopy(`${historyPath}-wal`, paths.walPath)) {
    cleanupHistoryCopy(paths)
    return null
  }
  if (fs.existsSync(`${historyPath}-shm`) && !cloneOrBoundedCopy(`${historyPath}-shm`, paths.shmPath)) {
    cleanupHistoryCopy(paths)
    return null
  }

  return paths
}

function titleTokens(value: string | null | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4)
}

function titleMatchesWindow(pageTitle: string | null, windowTitle: string | null): boolean {
  const pageTokens = new Set(titleTokens(pageTitle))
  if (pageTokens.size === 0) return false
  return titleTokens(windowTitle).some((token) => pageTokens.has(token))
}

function recentChromiumTab(entry: BrowserEntry, now: number, windowTitle: string | null): ActiveBrowserTab | null {
  const copy = copyHistoryDb(entry.historyPath, 'daylens_active_chromium')
  if (!copy) return null
  try {
    const db = new Database(copy.dbPath, { readonly: true })
    db.defaultSafeIntegers(true)
    const rows = db.prepare(`
      SELECT u.url, u.title, v.visit_time
      FROM visits v
      JOIN urls u ON v.url = u.id
      WHERE v.visit_time > ?
      ORDER BY v.visit_time DESC
      LIMIT 12
    `).all(msToChromeUs(now - RECENT_HISTORY_LOOKBACK_MS)) as { url: string; title: string | null; visit_time: bigint }[]
    db.close()

    const row = rows.find((candidate) => titleMatchesWindow(candidate.title, windowTitle)) ?? rows[0]
    // History is non-private by definition — treat as mode-verified.
    return row ? { url: row.url, title: row.title ?? null, modeKnown: true } : null
  } catch {
    return null
  } finally {
    cleanupHistoryCopy(copy)
  }
}

function recentFirefoxTab(entry: BrowserEntry, now: number, windowTitle: string | null): ActiveBrowserTab | null {
  const copy = copyHistoryDb(entry.historyPath, 'daylens_active_firefox')
  if (!copy) return null
  try {
    const db = new Database(copy.dbPath, { readonly: true })
    db.defaultSafeIntegers(true)
    const rows = db.prepare(`
      SELECT p.url, p.title, v.visit_date
      FROM moz_historyvisits v
      JOIN moz_places p ON v.place_id = p.id
      WHERE v.visit_date > ?
      ORDER BY v.visit_date DESC
      LIMIT 12
    `).all(BigInt(now - RECENT_HISTORY_LOOKBACK_MS) * 1000n) as { url: string; title: string | null; visit_date: bigint }[]
    db.close()

    const row = rows.find((candidate) => titleMatchesWindow(candidate.title, windowTitle)) ?? rows[0]
    return row ? { url: row.url, title: row.title ?? null, modeKnown: true } : null
  } catch {
    return null
  } finally {
    cleanupHistoryCopy(copy)
  }
}

function winActiveTab(snapshot: ActiveBrowserWindowSnapshot): ActiveBrowserTab | null {
  try {
    const row = getDb().prepare(`
      SELECT url, page_title
      FROM focus_events
      WHERE source = 'uia_tab'
        AND confidence = 'observed'
        AND url IS NOT NULL
        AND ts_ms >= ?
        AND (
          (? IS NOT NULL AND app_bundle_id = ?)
          OR (? IS NOT NULL AND app_name = ?)
        )
      ORDER BY ts_ms DESC, id DESC
      LIMIT 1
    `).get(
      snapshot.capturedAt - TAB_CACHE_TRUST_MS,
      snapshot.bundleId || null,
      snapshot.bundleId || null,
      snapshot.appName || null,
      snapshot.appName || null,
    ) as { url: string; page_title: string | null } | undefined
    if (!row?.url) return null
    return { url: row.url, title: row.page_title ?? null }
  } catch {
    return null
  }
}

function recentHistoryTab(snapshot: ActiveBrowserWindowSnapshot): ActiveBrowserTab | null {
  const browserId = browserAppIdFor(snapshot)
  if (!browserId) return null
  const application = browserApplicationFor(snapshot)

  const entries = getBrowserEntries()
    .filter((entry) => fs.existsSync(entry.historyPath))
    .filter((entry) => {
      if (application) return entry.bundleId.split(':', 1)[0] === application.bundleId
      return resolveCanonicalBrowser(entry.bundleId).canonicalBrowserId === browserId
    })

  for (const entry of entries) {
    const tab = entry.type === 'firefox'
      ? recentFirefoxTab(entry, snapshot.capturedAt, snapshot.windowTitle)
      : recentChromiumTab(entry, snapshot.capturedAt, snapshot.windowTitle)
    if (tab) return tab
  }

  return null
}

function readActiveBrowserTab(snapshot: ActiveBrowserWindowSnapshot): ActiveBrowserTab | null {
  if (!browserAppIdFor(snapshot)) return null

  if (process.platform === 'darwin') {
    return macActiveTab(snapshot) ?? recentHistoryTab(snapshot)
  }

  if (process.platform === 'win32') {
    // Windows has a UIA helper for live Chromium tabs. If that helper has no
    // observed tab, do not synchronously copy browser History DBs on the 5s
    // foreground poll path; the 60s browser-history poll will backfill sites.
    return winActiveTab(snapshot)
  }

  if (process.platform === 'linux') {
    return recentHistoryTab(snapshot)
  }

  return null
}

export class ActiveBrowserContextTracker {
  private inFlight: InFlightBrowserContext | null = null
  private pending: InFlightBrowserContext | null = null
  // The foreground window title (captured cheaply by the tracker) reflects the
  // active tab's page title. While it is unchanged we reuse the in-flight tab
  // instead of re-running the per-sample osascript / history-DB read, which is
  // what made every 5s poll tick stutter on browser-heavy macOS use (F19).
  private lastWindowTitle: string | null = null
  // When the last real tab read happened. The title-cache is only trusted for a
  // bounded window so that two distinct tabs sharing a title (e.g. two "Inbox"
  // pages) can't be merged indefinitely — we force a re-read after this.
  private lastTabReadAt = 0

  constructor(
    private readonly readTab: ActiveBrowserTabReader = readActiveBrowserTab,
    private readonly isBrowser: (snapshot: ActiveBrowserWindowSnapshot) => boolean =
      (snapshot) => browserAppIdFor(snapshot) !== null,
  ) {}

  private promotePending(db: BetterSqlite.Database, capturedAt: number): void {
    if (!this.pending || capturedAt - this.pending.startedAt < MIN_CONTEXT_SEC * 1_000) return
    const pending = this.pending
    this.pending = null
    this.flush(db, pending.startedAt)
    this.inFlight = pending
  }

  private observeTab(
    db: BetterSqlite.Database,
    snapshot: ActiveBrowserWindowSnapshot,
    tab: ActiveBrowserTab,
    normalizedUrl: string | null,
  ): void {
    if (!this.inFlight) {
      this.inFlight = {
        snapshot,
        tab,
        normalizedUrl,
        startedAt: snapshot.capturedAt,
        lastSeenAt: snapshot.capturedAt,
      }
      this.pending = null
      return
    }

    if (sameContext(this.inFlight, tab, normalizedUrl)) {
      this.pending = null
      this.inFlight.snapshot = snapshot
      this.inFlight.tab = tab
      this.inFlight.lastSeenAt = snapshot.capturedAt
      return
    }

    if (this.pending && sameContext(this.pending, tab, normalizedUrl)) {
      this.pending.snapshot = snapshot
      this.pending.tab = tab
      this.pending.lastSeenAt = snapshot.capturedAt
      this.promotePending(db, snapshot.capturedAt)
      return
    }

    this.pending = {
      snapshot,
      tab,
      normalizedUrl,
      startedAt: snapshot.capturedAt,
      lastSeenAt: snapshot.capturedAt,
    }
  }

  sample(db: BetterSqlite.Database, snapshot: ActiveBrowserWindowSnapshot): ActiveBrowserContextSample {
    if (!this.isBrowser(snapshot)) {
      this.flush(db, snapshot.capturedAt)
      this.pending = null
      this.lastWindowTitle = null
      return { isPrivate: false, passivePresence: false }
    }

    // Private windows are never tracked, independent of any setting. The
    // window-title markers are the cross-browser fallback; the structured
    // Chromium signal comes back on the tab read below.
    if (detectIncognitoFromTitle(snapshot.windowTitle)) {
      this.flush(db, snapshot.capturedAt)
      this.pending = null
      this.lastWindowTitle = null
      return { isPrivate: true, passivePresence: false }
    }

    // Same browser window + same title + still inside the trust window → almost
    // certainly the same active tab, so extend the current context without
    // paying for another tab read. The freshness cap bounds how long a
    // same-title tab switch could go unnoticed.
    if (
      (this.inFlight || this.pending)
      && snapshot.windowTitle
      && snapshot.windowTitle === this.lastWindowTitle
      && snapshot.bundleId === (this.pending?.snapshot.bundleId ?? this.inFlight?.snapshot.bundleId)
      && snapshot.capturedAt - this.lastTabReadAt < TAB_CACHE_TRUST_MS
    ) {
      const cached = this.pending ?? this.inFlight
      if (cached) {
        cached.snapshot = snapshot
        cached.lastSeenAt = snapshot.capturedAt
        if (this.pending) this.promotePending(db, snapshot.capturedAt)
      }
      const domain = cached ? extractDomain(cached.tab.url) : null
      return {
        isPrivate: false,
        passivePresence: domain ? passivePresenceForDomain(domain, snapshot) : false,
      }
    }

    const tab = this.readTab(snapshot)
    this.lastTabReadAt = snapshot.capturedAt

    if (tab?.isPrivate) {
      // Structured private signal: flush whatever regular context was open
      // (its time ended when the private window took focus) and record nothing.
      this.flush(db, snapshot.capturedAt)
      this.pending = null
      this.lastWindowTitle = null
      return { isPrivate: true, passivePresence: false }
    }

    const domain = tab ? extractDomain(tab.url) : null
    if (!tab || !domain) {
      this.flush(db, snapshot.capturedAt)
      this.pending = null
      this.lastWindowTitle = null
      return { isPrivate: false, passivePresence: false }
    }

    const captureDecision = decideSiteCapture(
      trackingControlsStateFromSettings(getSettings()),
      { domain, windowTitle: snapshot.windowTitle, isPrivate: tab.isPrivate },
    )
    if (!captureDecision.capture) {
      this.flush(db, snapshot.capturedAt)
      this.pending = null
      this.lastWindowTitle = null
      return {
        isPrivate: captureDecision.reason === 'incognito',
        passivePresence: false,
        captureBlockReason: captureDecision.reason ?? undefined,
      }
    }

    // Unverifiable window mode: keep browser app timing (tracking sessions)
    // but never accumulate page title/URL for persistence. History ingestion
    // is the only path that may later attach page detail.
    if (tab.modeKnown === false) {
      this.flush(db, snapshot.capturedAt)
      this.pending = null
      this.inFlight = null
      this.lastWindowTitle = snapshot.windowTitle ?? null
      return {
        isPrivate: false,
        passivePresence: passivePresenceForDomain(domain, snapshot),
      }
    }

    this.lastWindowTitle = snapshot.windowTitle ?? null

    const normalizedUrl = normalizeUrlForStorage(tab.url)
    this.observeTab(db, snapshot, tab, normalizedUrl)
    return {
      isPrivate: false,
      passivePresence: passivePresenceForDomain(domain, snapshot),
    }
  }

  flush(db: BetterSqlite.Database, endTime = Date.now()): boolean {
    const context = this.inFlight
    this.inFlight = null
    this.pending = null
    if (!context) return false

    // Defense in depth: unverifiable reads must never reach website_visits.
    if (context.tab.modeKnown === false) return false

    const domain = extractDomain(context.tab.url)
    if (!domain) return false

    // T3: drop this website visit when the user excluded the site, paused
    // tracking, or it's an incognito window (by title) and skip-incognito is on.
    // Passthrough when Tracking Controls is off — the browser app session is
    // gated separately upstream in tracking.ts.
    if (!decideSiteCapture(trackingControlsStateFromSettings(getSettings()), { domain, windowTitle: context.snapshot.windowTitle }).capture) {
      return false
    }

    // Explicit cutoffs (idle/away/sleep-gap) are backdated to the last proven
    // active instant. Do not stretch the visit back out to a later cached sample.
    const effectiveEnd = Math.max(endTime, context.startedAt)
    const durationSec = Math.round((effectiveEnd - context.startedAt) / 1000)
    if (durationSec < MIN_CONTEXT_SEC) return false

    const browserIdentity = resolveCanonicalBrowser(context.snapshot.bundleId)
    const persistedUrl = sanitizeUrlForPersistence(context.tab.url)
    if (!persistedUrl) return false
    const visit = {
      domain,
      pageTitle: context.tab.title,
      url: persistedUrl,
      normalizedUrl: context.normalizedUrl ?? normalizeUrlForStorage(context.tab.url),
      pageKey: pageKeyForUrl(context.tab.url),
      visitTime: context.startedAt,
      visitTimeUs: BigInt(context.startedAt) * 1000n,
      durationSec,
      browserBundleId: context.snapshot.bundleId,
      canonicalBrowserId: browserIdentity.canonicalBrowserId,
      browserProfileId: browserIdentity.browserProfileId,
      source: 'active_browser_context',
    }

    const inserted = insertWebsiteVisit(db, visit)

    if (inserted) {
      invalidateProjectionScope('timeline', 'active_browser_context_recorded', {
        date: localDateString(new Date(context.startedAt)),
      })
      invalidateProjectionScope('apps', 'active_browser_context_recorded', {
        canonicalAppId: browserIdentity.canonicalBrowserId,
      })
      invalidateProjectionScope('insights', 'active_browser_context_recorded', {
        date: localDateString(new Date(context.startedAt)),
      })
    }

    return inserted
  }
}

let activeBrowserContextTracker = new ActiveBrowserContextTracker()

// Test seam: swap the module singleton so the tracking poll's private-window
// drop can be driven with a scripted tab reader (no osascript, no registry).
// Pass null to restore a fresh default tracker.
export function __setActiveBrowserContextTrackerForTest(tracker: ActiveBrowserContextTracker | null): void {
  activeBrowserContextTracker = tracker ?? new ActiveBrowserContextTracker()
}

export function recordActiveBrowserContextSample(
  db: BetterSqlite.Database,
  snapshot: ActiveBrowserWindowSnapshot,
): ActiveBrowserContextSample {
  return activeBrowserContextTracker.sample(db, snapshot)
}

export function flushActiveBrowserContext(
  db: BetterSqlite.Database,
  endTime = Date.now(),
): boolean {
  return activeBrowserContextTracker.flush(db, endTime)
}
