// Raw better-sqlite3 queries — will be typed Drizzle functions in Phase 2a
import type Database from 'better-sqlite3'
import crypto from 'node:crypto'
import { FOCUSED_CATEGORIES } from '@shared/types'
import type {
  AIConversationState,
  AISurfaceSummary,
  AIThreadMessage,
  AIThreadMessageMetadata,
  AppCharacter,
  AppSession,
  AppUsageSummary,
  AppCategory,
  DaySnapshot,
  FocusSession,
  FocusStartPayload,
  PeakHoursResult,
  WeeklySummary,
  WebsiteSummary,
  WorkContextInsight,
} from '@shared/types'
import { isCategoryFocused } from '../lib/focusScore'
import { localDateString, localDayBounds, shiftLocalDateString } from '../lib/localDate'
import {
  normalizeUrlForStorage,
  pageKeyForUrl,
  resolveCanonicalApp,
  resolveCanonicalBrowser,
  sanitizeUrlForPersistence,
  type CanonicalAppIdentity,
} from '../lib/appIdentity'
import { resolveBrowserApplication } from '../services/browserRegistry'
import { learnFromBlockOverride } from '../services/workMemory'
import { isSystemNoiseApp } from '@shared/systemNoise'
import { activityCategoryLabel } from '@shared/activityCategories'
import { REAL_ABSENCE_MIN_MS } from '../lib/absenceGuard'

function resolveDisplayName(bundleId: string, fallbackName: string): string {
  return resolveCanonicalApp(bundleId, fallbackName).displayName
}

// ─── UX noise filter ──────────────────────────────────────────────────────────
// Applied at read time so junk data never surfaces in the UI.
// The DB is NOT mutated — raw data is always preserved for debugging / export.
//
// Matches lowercase substrings of the stored app_name value.
// Keep this in sync with the write-layer filter in tracking.ts so that anything
// added there also has a read-layer backstop here.
const UX_NOISE_SUBSTRINGS = [
  'electron',   // Electron shell (dev mode) and helper processes
  'daylens',    // This app tracking itself in production
  'activity tracker and ai insights', // Older app shell title / product description
  'cmux',       // tmux manager shim
  'node.js',    // Node.js runtime windows
  'loginwindow', // macOS lock screen / auth process — not a user app
]
const UX_NOISE_EXACT_NAMES = new Set([
  'finder',
  'siri',
  'usernotificationcenter',
  'notification center',
])

// Minimum session duration exposed to the UI (seconds).
// Sessions shorter than this are noise from brief app transitions.
const MIN_DISPLAY_SEC = 15
const SAME_APP_MERGE_GAP_MS = 15_000
const MIN_CAPTURE_DWELL_SEC = 10

// ─── Correction spans (one truth, three views — invariant 7) ─────────────────
// The time spans of Timeline blocks the user deleted (review state 'ignored').
// Raw capture is never mutated; a correction is applied at read time, with the
// SAME membership rule everywhere: a session belongs to a corrected-away span
// when it STARTED inside it (matching the timeline rebuild's
// withoutIgnoredSpans, so Apps/AI totals reconcile with the Timeline exactly).
export interface CorrectionSpan {
  startMs: number
  endMs: number
}

export function sessionStartsInsideSpans(
  session: { startTime: number },
  spans: readonly CorrectionSpan[],
): boolean {
  return spans.some((span) => session.startTime >= span.startMs && session.startTime < span.endMs)
}
const ENGAGEMENT_RETURN_GAP_MS = 2 * 60_000

// How far before a range's start we look for sessions that began earlier but
// overlap into the window. Range queries filter on `start_time` (the indexed
// column) so they need a lower bound to keep the index scan tight. Sessions are
// flushed on idle/away (AWAY_THRESHOLD in tracking) and the Windows backfill
// discards anything over 8h, so no real session spans longer than this; 12h
// leaves generous margin for a long continuous-activity session that crosses
// into the window while cutting the previous 48h over-scan by 4x.
const SESSION_OVERLAP_LOOKBACK_MS = 12 * 60 * 60 * 1000

// Columns hydrated into AppSessionRow / clipRowToRange. Selecting them
// explicitly (instead of SELECT *) keeps these hot range reads from pulling
// unused or future wide columns across the boundary.
const APP_SESSION_COLUMNS = `
  id, bundle_id, app_name, start_time, end_time, duration_sec, category,
  window_title, raw_app_name, canonical_app_id, app_instance_id,
  capture_source, ended_reason, capture_version
`
function normalizedNoiseIdentity(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isUxNoise(row: Pick<AppSessionRow, 'bundle_id' | 'app_name' | 'raw_app_name' | 'canonical_app_id'>): boolean {
  // Shared invisible-OS-identity policy first (bundle-id list lives in one
  // place); then the read-layer's own product-noise names/substrings.
  if (isSystemNoiseApp({ bundleId: row.bundle_id, appName: row.app_name })) return true
  const values = [row.bundle_id, row.app_name, row.raw_app_name, row.canonical_app_id]
    .filter((value): value is string => Boolean(value?.trim()))
  const normalizedExactNames = new Set([...UX_NOISE_EXACT_NAMES].map(normalizedNoiseIdentity))
  return values.some((value) => {
    const lower = value.toLowerCase()
    const normalized = normalizedNoiseIdentity(value)
    return UX_NOISE_EXACT_NAMES.has(lower)
      || normalizedExactNames.has(normalized)
      || UX_NOISE_SUBSTRINGS.some((substring) =>
        lower.includes(substring) || normalized.includes(normalizedNoiseIdentity(substring)))
  })
}

// Identity resolution for a session row is fully determined by its
// (bundle_id, app_name, canonical_app_id) triple. The fallback path below calls
// resolveBrowserApplication, which on every miss inspects the filesystem to
// classify the app as a browser. Over a large range (e.g. Apps "All-time",
// ~26k rows with thousands lacking a canonical id) that per-row filesystem work
// dominated and froze the main process for ~18s. Memoize so each distinct
// identity pays that cost at most once per process. Pure resolution only — does
// not touch capture, segmentation, or the evidence backend.
const rowIdentityCache = new Map<string, CanonicalAppIdentity>()
const ROW_IDENTITY_CACHE_LIMIT = 5000

function resolvedRowIdentity(
  row: Pick<AppSessionRow, 'bundle_id' | 'app_name' | 'canonical_app_id'>,
): CanonicalAppIdentity {
  const cacheKey = `${row.bundle_id}\u0000${row.app_name}\u0000${row.canonical_app_id ?? ''}`
  const cached = rowIdentityCache.get(cacheKey)
  if (cached) return cached

  const identity = computeRowIdentity(row)

  if (rowIdentityCache.size >= ROW_IDENTITY_CACHE_LIMIT) {
    rowIdentityCache.clear()
  }
  rowIdentityCache.set(cacheKey, identity)
  return identity
}

function computeRowIdentity(
  row: Pick<AppSessionRow, 'bundle_id' | 'app_name' | 'canonical_app_id'>,
): CanonicalAppIdentity {
  const staticIdentity = resolveCanonicalApp(row.bundle_id, row.app_name)
  if (staticIdentity.canonicalAppId) {
    return staticIdentity
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    const browser = resolveBrowserApplication({
      bundleId: row.bundle_id,
      appName: row.app_name,
      executablePath: row.bundle_id,
    })
    if (browser) {
      return {
        ...staticIdentity,
        canonicalAppId: row.canonical_app_id ?? browser.bundleId.toLowerCase(),
        appInstanceId: browser.bundleId,
        displayName: browser.name,
        defaultCategory: 'browsing',
      }
    }
  }

  return row.canonical_app_id
    ? { ...staticIdentity, canonicalAppId: row.canonical_app_id }
    : staticIdentity
}

function categoryOverrideFor(
  row: Pick<AppSessionRow, 'bundle_id' | 'app_name' | 'category'>,
  overrides: Record<string, AppCategory>,
  identity: CanonicalAppIdentity,
): AppCategory | undefined {
  return overrides[row.bundle_id]
    ?? (identity.canonicalAppId ? overrides[identity.canonicalAppId] : undefined)
}

function resolvedSessionCategory(
  row: Pick<AppSessionRow, 'bundle_id' | 'app_name' | 'category'>,
  overrides: Record<string, AppCategory>,
  identity: CanonicalAppIdentity,
): AppCategory {
  const override = categoryOverrideFor(row, overrides, identity)
  if (override) return override
  if (row.category && row.category !== 'uncategorized') return row.category
  return identity.defaultCategory ?? 'uncategorized'
}

function appLevelCategoryForIdentity(
  category: AppCategory,
  identity: CanonicalAppIdentity,
  hasOverride = false,
): AppCategory {
  if (hasOverride) return category
  if (identity.defaultCategory === 'browsing' || identity.isBrowser) return 'browsing'
  return category
}

interface AppSessionRow {
  id: number
  bundle_id: string
  app_name: string
  start_time: number
  end_time: number | null
  duration_sec: number
  category: AppCategory
  is_focused: number
  window_title?: string | null
  raw_app_name?: string | null
  canonical_app_id?: string | null
  app_instance_id?: string | null
  capture_source?: string | null
  ended_reason?: string | null
  capture_version?: number
}

export interface LiveAppSessionSnapshot {
  bundleId: string
  appName: string
  windowTitle: string | null
  rawAppName: string
  canonicalAppId: string | null
  appInstanceId: string | null
  captureSource: string
  category: AppCategory
  startTime: number
  lastSeenAt: number
}

function sessionEndTime(row: Pick<AppSessionRow, 'start_time' | 'end_time' | 'duration_sec'>): number {
  const capturedEnd = row.start_time + Math.max(0, row.duration_sec) * 1_000
  if (row.end_time == null) return capturedEnd
  // `end_time` is sometimes only a stale wall-clock envelope. Keep normal
  // polling/rounding drift, but never turn a >=15-minute uncovered tail into
  // captured activity before the absence guard gets to inspect the session.
  return row.end_time - capturedEnd >= REAL_ABSENCE_MIN_MS ? capturedEnd : row.end_time
}

function appSessionEndTime(session: Pick<AppSession, 'startTime' | 'endTime' | 'durationSeconds'>): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1_000)
}

function clipRowToRange(
  row: AppSessionRow,
  fromMs: number,
  toMs: number,
  category: AppCategory,
  identity: CanonicalAppIdentity,
): AppSession | null {
  const clippedStart = Math.max(row.start_time, fromMs)
  const clippedEnd = Math.min(sessionEndTime(row), toMs)
  if (clippedEnd <= clippedStart) return null

  return {
    id: row.id,
    bundleId: row.bundle_id,
    appName: identity.displayName || row.app_name,
    startTime: clippedStart,
    endTime: clippedEnd,
    durationSeconds: Math.max(1, Math.round((clippedEnd - clippedStart) / 1_000)),
    category,
    isFocused: isCategoryFocused(category),
    windowTitle: row.window_title ?? null,
    rawAppName: row.raw_app_name ?? row.app_name,
    canonicalAppId: identity.canonicalAppId ?? row.canonical_app_id ?? null,
    appInstanceId: row.app_instance_id ?? identity.appInstanceId,
    captureSource: row.capture_source ?? 'foreground_poll',
    endedReason: row.ended_reason ?? null,
    captureVersion: row.capture_version ?? 1,
  }
}

function mergeSessions(sessions: AppSession[]): AppSession[] {
  if (sessions.length <= 1) return sessions

  const merged: AppSession[] = [{ ...sessions[0] }]

  for (let i = 1; i < sessions.length; i++) {
    const curr = sessions[i]
    const last = merged[merged.length - 1]
    const gap = curr.startTime - appSessionEndTime(last)
    const sameWindowTitle = (curr.windowTitle ?? '').trim() === (last.windowTitle ?? '').trim()

    if (curr.bundleId === last.bundleId && sameWindowTitle && gap <= SAME_APP_MERGE_GAP_MS) {
      const newEnd = Math.max(appSessionEndTime(last), appSessionEndTime(curr))
      last.endTime = newEnd
      last.durationSeconds = Math.max(1, Math.round((newEnd - last.startTime) / 1000))
      continue
    }

    merged.push({ ...curr })
  }

  return merged
}

function formatCategoryLabel(category: AppCategory): string {
  return activityCategoryLabel(category)
}

function normalizePlannedApps(apps: string[] | null | undefined): string[] {
  if (!apps || apps.length === 0) return []
  return apps
    .map((app) => app.trim())
    .filter(Boolean)
    .filter((app, index, arr) => arr.indexOf(app) === index)
    .slice(0, 6)
}

interface FocusSessionRow {
  id: number
  start_time: number
  end_time: number | null
  duration_sec: number
  label: string | null
  target_minutes: number | null
  planned_apps: string | null
  reflection_note: string | null
}

function mapFocusSessionRow(row: FocusSessionRow): FocusSession {
  let plannedApps: string[] = []
  if (row.planned_apps) {
    try {
      const parsed = JSON.parse(row.planned_apps)
      if (Array.isArray(parsed)) {
        plannedApps = normalizePlannedApps(parsed.filter((value): value is string => typeof value === 'string'))
      }
    } catch {
      plannedApps = []
    }
  }

  return {
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_sec,
    label: row.label,
    targetMinutes: row.target_minutes,
    plannedApps,
    reflectionNote: row.reflection_note,
  }
}

function parseJsonObject<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export interface SearchOptions {
  startDate?: string
  endDate?: string
  limit?: number
  // Internal: a recency floor (epoch ms) applied on top of startDate. searchAll
  // raises this as it collects results so lower-yield tables only scan rows that
  // could still land in the final top-`limit` set. Not set by IPC callers.
  minStartMs?: number
  // Internal pagination ceiling used after corrected search filters ignored
  // Timeline spans. Not exposed over IPC.
  maxStartMs?: number
}

export interface SessionSearchResult {
  type: 'session'
  id: number
  appName: string
  windowTitle: string | null
  startTime: number
  endTime: number
  date: string
  excerpt: string
}

export interface BlockSearchResult {
  type: 'block'
  id: string
  label: string
  startTime: number
  endTime: number
  date: string
  excerpt: string
}

export interface BrowserSearchResult {
  type: 'browser'
  id: number
  domain: string
  pageTitle: string | null
  url: string | null
  startTime: number
  endTime: number
  date: string
  excerpt: string
}

export interface ArtifactSearchResult {
  type: 'artifact'
  id: number
  title: string
  filePath: string | null
  startTime: number
  endTime: number
  date: string
  excerpt: string
}

export type SearchResult =
  | SessionSearchResult
  | BlockSearchResult
  | BrowserSearchResult
  | ArtifactSearchResult

const SEARCH_LIMIT_MAX = 100
const SEARCH_LIMIT_DEFAULT = 25
const SEARCH_HIGHLIGHT_START = '[[mark]]'
const SEARCH_HIGHLIGHT_END = '[[/mark]]'

function normalizedSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return SEARCH_LIMIT_DEFAULT
  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit as number)))
}

function parseDateBound(date: string | undefined, edge: 'start' | 'end'): number | null {
  if (!date) return null
  const trimmed = date.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null
  const [start, end] = localDayBounds(trimmed)
  return edge === 'start' ? start : end
}

function searchBounds(opts: SearchOptions): { fromMs: number; toMs: number; limit: number } {
  const dateFloor = parseDateBound(opts.startDate, 'start') ?? 0
  return {
    fromMs: Math.max(dateFloor, opts.minStartMs ?? 0),
    toMs: Math.min(
      parseDateBound(opts.endDate, 'end') ?? Number.MAX_SAFE_INTEGER,
      opts.maxStartMs ?? Number.MAX_SAFE_INTEGER,
    ),
    limit: normalizedSearchLimit(opts.limit),
  }
}

function searchQueryTokens(query: string): string[] {
  return query
    .trim()
    .match(/"[^"]+"|\S+/g)
    ?.map((token) => token.replace(/^"|"$/g, '').replace(/"/g, '""').trim())
    .filter(Boolean) ?? []
}

function toFtsQuery(query: string): string {
  return searchQueryTokens(query).map((token) => `"${token}"`).join(' AND ')
}

function mapAIThreadMessage(
  row: {
    id: number
    role: 'user' | 'assistant'
    content: string
    createdAt: number
    metadataJson: string | null
    rating?: 'up' | 'down' | null
    ratingUpdatedAt?: number | null
  },
): AIThreadMessage {
  const metadata = parseJsonObject<AIThreadMessageMetadata>(row.metadataJson, {})
  const rating = row.rating === 'up' || row.rating === 'down'
    ? row.rating
    : metadata.rating ?? null
  const ratingUpdatedAt = typeof row.ratingUpdatedAt === 'number'
    ? row.ratingUpdatedAt
    : metadata.ratingUpdatedAt ?? null
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    answerKind: metadata.answerKind ?? null,
    suggestedFollowUps: metadata.suggestedFollowUps ?? [],
    retryable: metadata.retryable ?? false,
    retrySourceUserMessageId: metadata.retrySourceUserMessageId ?? null,
    contextSnapshot: metadata.contextSnapshot ?? null,
    providerError: metadata.providerError ?? false,
    actions: metadata.actions ?? [],
    actionWidgets: metadata.actionWidgets ?? [],
    artifacts: metadata.artifacts ?? [],
    agent: metadata.agent,
    rating,
    ratingUpdatedAt,
  }
}

// ---------------------------------------------------------------------------
// App sessions
// ---------------------------------------------------------------------------

// A browser's window title is the page title, and no capture path at this
// layer can prove the window was not private. Browser page detail is only
// stored through the corroborated visit pipeline (browserContext), so app
// sessions for browsers keep timing and identity but never a title.
function stripBrowserTitle(session: Omit<AppSession, 'id'>): Omit<AppSession, 'id'> {
  if (!session.windowTitle) return session
  const isBrowser = resolveBrowserApplication({ bundleId: session.bundleId, appName: session.appName }) != null
  return isBrowser ? { ...session, windowTitle: null } : session
}

export function insertAppSession(
  db: Database.Database,
  rawSession: Omit<AppSession, 'id'>,
): number | null {
  const session = stripBrowserTitle(rawSession)
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused,
      window_title,
      raw_app_name,
      canonical_app_id,
      app_instance_id,
      capture_source,
      ended_reason,
      capture_version
    )
    VALUES (
      @bundleId,
      @appName,
      @startTime,
      @endTime,
      @durationSeconds,
      @category,
      @isFocused,
      @windowTitle,
      @rawAppName,
      @canonicalAppId,
      @appInstanceId,
      @captureSource,
      @endedReason,
      @captureVersion
    )
  `)
  const result = stmt.run({
    ...session,
    isFocused: session.isFocused ? 1 : 0,
    windowTitle: session.windowTitle ?? null,
    rawAppName: session.rawAppName ?? session.appName,
    canonicalAppId: session.canonicalAppId ?? null,
    appInstanceId: session.appInstanceId ?? session.bundleId,
    captureSource: session.captureSource ?? 'foreground_poll',
    endedReason: session.endedReason ?? null,
    captureVersion: session.captureVersion ?? 1,
  })
  // INSERT OR IGNORE: on a dedup conflict (bundle_id, start_time) nothing was
  // written and lastInsertRowid still points at some earlier insert. Returning
  // it would make callers treat the skip as a real insert (identity
  // observations, projection invalidations) against a phantom row.
  return result.changes > 0 ? result.lastInsertRowid as number : null
}

export function upsertLiveAppSessionSnapshot(
  db: Database.Database,
  snapshot: LiveAppSessionSnapshot,
): void {
  db.prepare(`
    INSERT INTO live_app_session_snapshot (
      singleton,
      bundle_id,
      app_name,
      window_title,
      raw_app_name,
      canonical_app_id,
      app_instance_id,
      capture_source,
      category,
      start_time,
      last_seen_at
    )
    VALUES (
      1,
      @bundleId,
      @appName,
      @windowTitle,
      @rawAppName,
      @canonicalAppId,
      @appInstanceId,
      @captureSource,
      @category,
      @startTime,
      @lastSeenAt
    )
    ON CONFLICT(singleton) DO UPDATE SET
      bundle_id = excluded.bundle_id,
      app_name = excluded.app_name,
      window_title = excluded.window_title,
      raw_app_name = excluded.raw_app_name,
      canonical_app_id = excluded.canonical_app_id,
      app_instance_id = excluded.app_instance_id,
      capture_source = excluded.capture_source,
      category = excluded.category,
      start_time = excluded.start_time,
      last_seen_at = excluded.last_seen_at
  `).run({
    ...snapshot,
    windowTitle: snapshot.windowTitle && resolveBrowserApplication({ bundleId: snapshot.bundleId, appName: snapshot.appName }) != null
      ? null
      : snapshot.windowTitle ?? null,
    canonicalAppId: snapshot.canonicalAppId ?? null,
    appInstanceId: snapshot.appInstanceId ?? null,
  })
}

export function getLiveAppSessionSnapshot(
  db: Database.Database,
): LiveAppSessionSnapshot | null {
  const row = db.prepare(`
    SELECT
      bundle_id,
      app_name,
      window_title,
      raw_app_name,
      canonical_app_id,
      app_instance_id,
      capture_source,
      category,
      start_time,
      last_seen_at
    FROM live_app_session_snapshot
    WHERE singleton = 1
    LIMIT 1
  `).get() as {
    bundle_id: string
    app_name: string
    window_title: string | null
    raw_app_name: string | null
    canonical_app_id: string | null
    app_instance_id: string | null
    capture_source: string
    category: AppCategory
    start_time: number
    last_seen_at: number
  } | undefined

  if (!row) return null

  return {
    bundleId: row.bundle_id,
    appName: row.app_name,
    windowTitle: row.window_title ?? null,
    rawAppName: row.raw_app_name ?? row.app_name,
    canonicalAppId: row.canonical_app_id ?? null,
    appInstanceId: row.app_instance_id ?? null,
    captureSource: row.capture_source,
    category: row.category,
    startTime: row.start_time,
    lastSeenAt: row.last_seen_at,
  }
}

export function clearLiveAppSessionSnapshot(db: Database.Database): void {
  db.prepare('DELETE FROM live_app_session_snapshot WHERE singleton = 1').run()
}

export function getAppSummariesForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  options: { excludeSpans?: readonly CorrectionSpan[] } = {},
): AppUsageSummary[] {
  const overrides = getCategoryOverrides(db)
  const excludeSpans = options.excludeSpans ?? []

  const rows = db
    .prepare<[number, number, number]>(`
      SELECT ${APP_SESSION_COLUMNS}
      FROM app_sessions
      WHERE start_time >= ? AND start_time < ? AND COALESCE(end_time, start_time + duration_sec * 1000) > ?
      ORDER BY start_time ASC
    `)
    .all(fromMs - SESSION_OVERLAP_LOOKBACK_MS, toMs, fromMs) as AppSessionRow[]

  const clippedSessions = mergeSessions(
    rows
      .filter((row) => !isUxNoise(row))
      // Corrected truth (invariant 7): a session inside a span the user
      // deleted from the Timeline never counts toward an app total. Applied
      // BEFORE the quick-return merge so an excluded session can't smuggle
      // its seconds into a kept neighbour.
      .filter((row) => excludeSpans.length === 0 || !sessionStartsInsideSpans({ startTime: row.start_time }, excludeSpans))
      .map((row) => {
        // User overrides first; fall through to catalog's default category for
        // sessions that were captured before the catalog was fully populated.
        const identity = resolvedRowIdentity(row)
        const category = resolvedSessionCategory(row, overrides, identity)
        return clipRowToRange(
          row,
          fromMs,
          toMs,
          appLevelCategoryForIdentity(category, identity, Boolean(categoryOverrideFor(row, overrides, identity))),
          identity,
        )
      })
      .filter((session): session is AppSession => session !== null),
  ).filter((session) => session.durationSeconds >= MIN_CAPTURE_DWELL_SEC)

  const summaryMap = new Map<string, AppUsageSummary>()
  const lastEngagementEnd = new Map<string, number>()

  for (const session of clippedSessions) {
    const identity = resolveCanonicalApp(session.bundleId, session.appName)
    const mapKey = session.canonicalAppId ?? identity.canonicalAppId ?? session.bundleId
    const endTime = appSessionEndTime(session)
    const existing = summaryMap.get(mapKey)
    if (existing) {
      existing.totalSeconds += session.durationSeconds
      if (existing.category === 'uncategorized' && session.category !== 'uncategorized') {
        existing.category = session.category
        existing.isFocused = isCategoryFocused(session.category)
      }
      const previousEnd = lastEngagementEnd.get(mapKey) ?? session.startTime
      if (session.startTime - previousEnd >= ENGAGEMENT_RETURN_GAP_MS) {
        existing.sessionCount = (existing.sessionCount ?? 0) + 1
      }
      lastEngagementEnd.set(mapKey, Math.max(previousEnd, endTime))
    } else {
      summaryMap.set(mapKey, {
        bundleId: session.bundleId,
        canonicalAppId: mapKey,
        appName: identity.displayName || session.appName,
        category: session.category,
        totalSeconds: session.durationSeconds,
        isFocused: isCategoryFocused(session.category),
        sessionCount: 1,
      })
      lastEngagementEnd.set(mapKey, endTime)
    }
  }

  return Array.from(summaryMap.values())
    .filter((summary) => summary.totalSeconds > 0)
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
}

export function getSessionsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  options: { minimumDurationSeconds?: number } = {},
): AppSession[] {
  const overrides = getCategoryOverrides(db)

  const rows = db
    .prepare<[number, number, number]>(`
      SELECT ${APP_SESSION_COLUMNS} FROM app_sessions
      WHERE start_time >= ? AND start_time < ? AND COALESCE(end_time, start_time + duration_sec * 1000) > ?
      ORDER BY start_time ASC
    `)
    .all(fromMs - SESSION_OVERLAP_LOOKBACK_MS, toMs, fromMs) as AppSessionRow[]

  return mergeSessions(
    rows
      .filter((row) => !isUxNoise(row))
      .map((row) => {
        const identity = resolvedRowIdentity(row)
        const category = resolvedSessionCategory(row, overrides, identity)
        return clipRowToRange(row, fromMs, toMs, category, identity)
      })
      .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)
  ).filter((session) => session.durationSeconds >= (options.minimumDurationSeconds ?? MIN_DISPLAY_SEC))
}

export function searchSessions(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): SessionSearchResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery) return []
  const { fromMs, toMs, limit } = searchBounds(opts)

  const rows = db.prepare(`
    SELECT
      app_sessions.id,
      app_sessions.bundle_id,
      app_sessions.app_name,
      app_sessions.window_title,
      app_sessions.start_time,
      COALESCE(app_sessions.end_time, app_sessions.start_time + app_sessions.duration_sec * 1000) AS end_time,
      snippet(app_sessions_fts, -1, ?, ?, '...', 18) AS excerpt
    FROM app_sessions_fts
    JOIN app_sessions ON app_sessions.id = app_sessions_fts.rowid
    WHERE app_sessions_fts MATCH ?
      AND app_sessions.start_time >= ?
      AND app_sessions.start_time < ?
      AND NOT EXISTS (
        SELECT 1
        FROM timeline_block_reviews review
        WHERE review.review_state = 'ignored'
          AND app_sessions.start_time >= json_extract(review.original_block_json, '$.startTime')
          AND app_sessions.start_time < json_extract(review.original_block_json, '$.endTime')
      )
    ORDER BY app_sessions.start_time DESC
    LIMIT ?
  `).all(SEARCH_HIGHLIGHT_START, SEARCH_HIGHLIGHT_END, ftsQuery, fromMs, toMs, limit) as {
    id: number
    bundle_id: string
    app_name: string
    window_title: string | null
    start_time: number
    end_time: number
    excerpt: string | null
  }[]

  return rows.map((row) => ({
    type: 'session',
    id: row.id,
    appName: resolveDisplayName(row.bundle_id, row.app_name),
    windowTitle: row.window_title,
    startTime: row.start_time,
    endTime: row.end_time,
    date: localDateString(new Date(row.start_time)),
    excerpt: row.excerpt ?? row.window_title ?? row.app_name,
  }))
}

export function searchBlocks(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): BlockSearchResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery) return []
  const { fromMs, toMs, limit } = searchBounds(opts)

  const indexedRows = db.prepare(`
    SELECT
      timeline_blocks.id,
      timeline_blocks.label_current,
      timeline_blocks.start_time,
      timeline_blocks.end_time,
      timeline_blocks.date,
      snippet(timeline_blocks_fts, -1, ?, ?, '...', 18) AS excerpt
    FROM timeline_blocks_fts
    JOIN timeline_blocks ON timeline_blocks.rowid = timeline_blocks_fts.rowid
    WHERE timeline_blocks_fts MATCH ?
      AND timeline_blocks.start_time >= ?
      AND timeline_blocks.start_time < ?
      AND timeline_blocks.invalidated_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM timeline_block_reviews r
        WHERE r.block_id = timeline_blocks.id AND r.review_state = 'ignored'
      )
      AND NOT EXISTS (
        SELECT 1 FROM timeline_block_reviews r
        WHERE r.block_id = timeline_blocks.id
          AND r.review_state = 'corrected'
          AND json_type(r.correction_json, '$.label') = 'text'
          AND trim(json_extract(r.correction_json, '$.label')) != ''
      )
    ORDER BY timeline_blocks.start_time DESC
    LIMIT ?
  `).all(SEARCH_HIGHLIGHT_START, SEARCH_HIGHLIGHT_END, ftsQuery, fromMs, toMs, limit) as {
    id: string
    label_current: string
    start_time: number
    end_time: number
    date: string
    excerpt: string | null
  }[]

  const tokens = searchQueryTokens(query)
  const labelExpression = `LOWER(json_extract(reviews.correction_json, '$.label'))`
  const tokenClauses = tokens.map(() => `${labelExpression} LIKE ? ESCAPE '!'`).join(' AND ')
  const tokenParams = tokens.map((token) => {
    const escaped = token.toLowerCase().replace(/[!%_]/g, (character) => `!${character}`)
    return `%${escaped}%`
  })
  const correctedRows = tokens.length === 0
    ? []
    : db.prepare(`
      SELECT
        timeline_blocks.id,
        json_extract(reviews.correction_json, '$.label') AS label_current,
        timeline_blocks.start_time,
        timeline_blocks.end_time,
        timeline_blocks.date,
        json_extract(reviews.correction_json, '$.label') AS excerpt
      FROM timeline_block_reviews reviews
      JOIN timeline_blocks ON timeline_blocks.id = reviews.block_id
      WHERE reviews.review_state = 'corrected'
        AND json_type(reviews.correction_json, '$.label') = 'text'
        AND timeline_blocks.start_time >= ?
        AND timeline_blocks.start_time < ?
        AND timeline_blocks.invalidated_at IS NULL
        AND ${tokenClauses}
      ORDER BY timeline_blocks.start_time DESC
      LIMIT ?
    `).all(fromMs, toMs, ...tokenParams, limit) as typeof indexedRows

  const rows = [...indexedRows, ...correctedRows]
    .sort((left, right) => right.start_time - left.start_time)
    .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index)
    .slice(0, limit)

  return rows.map((row) => ({
    type: 'block',
    id: row.id,
    label: row.label_current,
    startTime: row.start_time,
    endTime: row.end_time,
    date: row.date,
    excerpt: row.excerpt ?? row.label_current,
  }))
}

export function searchBrowser(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): BrowserSearchResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery) return []
  const { fromMs, toMs, limit } = searchBounds(opts)

  const rows = db.prepare(`
    SELECT
      website_visits.id,
      website_visits.domain,
      website_visits.page_title,
      website_visits.url,
      website_visits.visit_time,
      website_visits.duration_sec,
      snippet(website_visits_fts, -1, ?, ?, '...', 18) AS excerpt
    FROM website_visits_fts
    JOIN website_visits ON website_visits.id = website_visits_fts.rowid
    WHERE website_visits_fts MATCH ?
      AND website_visits.visit_time >= ?
      AND website_visits.visit_time < ?
      AND NOT EXISTS (
        SELECT 1
        FROM timeline_block_reviews review
        WHERE review.review_state = 'ignored'
          AND website_visits.visit_time >= json_extract(review.original_block_json, '$.startTime')
          AND website_visits.visit_time < json_extract(review.original_block_json, '$.endTime')
      )
    ORDER BY website_visits.visit_time DESC
    LIMIT ?
  `).all(SEARCH_HIGHLIGHT_START, SEARCH_HIGHLIGHT_END, ftsQuery, fromMs, toMs, limit) as {
    id: number
    domain: string
    page_title: string | null
    url: string | null
    visit_time: number
    duration_sec: number
    excerpt: string | null
  }[]

  return rows.map((row) => ({
    type: 'browser',
    id: row.id,
    domain: row.domain,
    pageTitle: row.page_title,
    url: row.url,
    startTime: row.visit_time,
    endTime: row.visit_time + Math.max(0, row.duration_sec) * 1000,
    date: localDateString(new Date(row.visit_time)),
    excerpt: row.excerpt ?? row.page_title ?? row.url ?? row.domain,
  }))
}

export function searchArtifacts(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): ArtifactSearchResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery) return []
  const { fromMs, toMs, limit } = searchBounds(opts)

  const rows = db.prepare(`
    SELECT
      ai_artifacts.id,
      ai_artifacts.title,
      ai_artifacts.file_path,
      ai_artifacts.created_at,
      snippet(ai_artifacts_fts, -1, ?, ?, '...', 18) AS excerpt
    FROM ai_artifacts_fts
    JOIN ai_artifacts ON ai_artifacts.id = ai_artifacts_fts.rowid
    WHERE ai_artifacts_fts MATCH ?
      AND ai_artifacts.created_at >= ?
      AND ai_artifacts.created_at < ?
    ORDER BY ai_artifacts.created_at DESC
    LIMIT ?
  `).all(SEARCH_HIGHLIGHT_START, SEARCH_HIGHLIGHT_END, ftsQuery, fromMs, toMs, limit) as {
    id: number
    title: string
    file_path: string | null
    created_at: number
    excerpt: string | null
  }[]

  return rows.map((row) => ({
    type: 'artifact',
    id: row.id,
    title: row.title,
    filePath: row.file_path,
    startTime: row.created_at,
    endTime: row.created_at,
    date: localDateString(new Date(row.created_at)),
    excerpt: row.excerpt ?? row.title,
  }))
}

export function searchAll(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  // One parse + one empty short-circuit instead of four (each sub-search would
  // otherwise re-derive the FTS query and return [] independently).
  if (!toFtsQuery(query)) return []

  const limit = normalizedSearchLimit(opts.limit)

  // Run highest-yield tables (largest by row count in normal use) first, then
  // raise a recency floor: once we hold `limit` results, anything older than
  // the oldest of them can never make the final top-`limit`-by-recency set, so
  // later tables only scan rows newer than that floor. Output is identical to
  // merging all four unbounded and slicing — just less work per keystroke.
  const searchers = [searchSessions, searchBrowser, searchBlocks, searchArtifacts] as const
  let results: SearchResult[] = []
  let minStartMs = opts.minStartMs ?? 0

  for (const search of searchers) {
    const batch = search(db, query, { ...opts, limit, minStartMs })
    if (batch.length > 0) {
      results = results.concat(batch).sort((left, right) => right.startTime - left.startTime)
      if (results.length > limit) results = results.slice(0, limit)
      if (results.length === limit) {
        minStartMs = Math.max(minStartMs, results[limit - 1].startTime)
      }
    }
  }

  return results
}

export function getPeakHours(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): PeakHoursResult | null {
  // Single grouped scan returns per (local day, hour) buckets. From those we
  // derive both the distinct-day gate and the 24-hour breakdown, replacing the
  // previous two full scans (distinct-day pass + getHourlyBreakdown).
  const focusedCategoryPlaceholders = FOCUSED_CATEGORIES.map(() => '?').join(', ')
  const noiseFilters = UX_NOISE_SUBSTRINGS.map(() => 'LOWER(app_sessions.app_name) NOT LIKE ?').join(' AND ')
  const rows = db
    .prepare(`
      SELECT
        strftime('%Y-%m-%d', app_sessions.start_time / 1000, 'unixepoch', 'localtime') AS day,
        CAST(strftime('%H', app_sessions.start_time / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        SUM(app_sessions.duration_sec) AS total_seconds,
        SUM(
          CASE
            WHEN COALESCE(category_overrides.category, app_sessions.category) IN (${focusedCategoryPlaceholders})
              THEN app_sessions.duration_sec
            ELSE 0
          END
        ) AS focus_seconds
      FROM app_sessions
      LEFT JOIN category_overrides
        ON category_overrides.bundle_id = app_sessions.bundle_id
      WHERE app_sessions.start_time >= ? AND app_sessions.start_time < ?
        AND ${noiseFilters}
      GROUP BY day, hour
    `)
    .all(
      ...FOCUSED_CATEGORIES,
      fromMs,
      toMs,
      ...UX_NOISE_SUBSTRINGS.map((substring) => `%${substring}%`),
    ) as { day: string; hour: number; total_seconds: number; focus_seconds: number }[]

  const distinctDays = new Set<string>()
  const hourlyBreakdown = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    totalSeconds: 0,
    focusSeconds: 0,
  }))
  for (const row of rows) {
    distinctDays.add(row.day)
    const bucket = hourlyBreakdown[row.hour]
    bucket.totalSeconds += row.total_seconds ?? 0
    bucket.focusSeconds += row.focus_seconds ?? 0
  }
  if (distinctDays.size < 3) return null

  let bestWindow: PeakHoursResult | null = null
  let bestFocusSeconds = -1

  for (let startHour = 0; startHour < 24; startHour++) {
    const nextHour = (startHour + 1) % 24
    const totalSeconds =
      hourlyBreakdown[startHour].totalSeconds + hourlyBreakdown[nextHour].totalSeconds
    if (totalSeconds <= 0) continue

    const focusSeconds =
      hourlyBreakdown[startHour].focusSeconds + hourlyBreakdown[nextHour].focusSeconds
    const focusPct = Math.round((focusSeconds / totalSeconds) * 100)

    if (
      bestWindow === null ||
      focusPct > bestWindow.focusPct ||
      (focusPct === bestWindow.focusPct && focusSeconds > bestFocusSeconds)
    ) {
      bestWindow = {
        peakStart: startHour,
        peakEnd: (startHour + 2) % 24,
        focusPct,
      }
      bestFocusSeconds = focusSeconds
    }
  }

  return bestWindow
}

export function getWeeklySummary(
  db: Database.Database,
  endDateStr: string,
): WeeklySummary {
  const startDateStr = shiftLocalDateString(endDateStr, -6)
  const [fromMs] = localDayBounds(startDateStr)
  const [, toMs] = localDayBounds(endDateStr)

  // Migration v14 dropped daily_summaries in favour of daily_entity_rollups.
  // Until step 4 rewires WeeklySummary onto the new rollups table, return an
  // empty per-day list — getWeeklySummary callers fall back to live aggregates.
  void db
  void fromMs
  void toMs
  const rows: {
    date: string
    total_active_sec: number
    focus_sec: number
    focus_score: number
  }[] = []

  const totalTrackedSeconds = rows.reduce((sum, row) => sum + row.total_active_sec, 0)
  const totalFocusSeconds = rows.reduce((sum, row) => sum + row.focus_sec, 0)
  const focusPct = totalTrackedSeconds > 0
    ? Math.round((totalFocusSeconds / totalTrackedSeconds) * 100)
    : 0
  const avgFocusScore = rows.length > 0
    ? Math.round(rows.reduce((sum, row) => sum + row.focus_score, 0) / rows.length)
    : 0

  const bestDayRow = rows
    .filter((row) => row.total_active_sec > 0)
    .reduce<{
      date: string
      focusPct: number
    } | null>((best, row) => {
      const rowFocusPct = Math.round((row.focus_sec / row.total_active_sec) * 100)
      if (best === null || rowFocusPct > best.focusPct) {
        return { date: row.date, focusPct: rowFocusPct }
      }
      return best
    }, null)

  const mostActiveDayRow = rows.reduce<{
    date: string
    totalSeconds: number
  } | null>((best, row) => {
    if (best === null || row.total_active_sec > best.totalSeconds) {
      return { date: row.date, totalSeconds: row.total_active_sec }
    }
    return best
  }, null)

  const noiseFilters = UX_NOISE_SUBSTRINGS.map(() => 'LOWER(app_sessions.app_name) NOT LIKE ?').join(' AND ')
  const topAppRows = db
    .prepare(`
      SELECT
        app_sessions.bundle_id,
        MIN(app_sessions.app_name) AS app_name,
        COALESCE(category_overrides.category, MIN(app_sessions.category)) AS category,
        MAX(CASE WHEN category_overrides.category IS NOT NULL THEN 1 ELSE 0 END) AS has_override,
        SUM(
          (
            MIN(COALESCE(app_sessions.end_time, app_sessions.start_time + app_sessions.duration_sec * 1000), ?) -
            MAX(app_sessions.start_time, ?)
          ) / 1000.0
        ) AS total_seconds
      FROM app_sessions
      LEFT JOIN category_overrides
        ON category_overrides.bundle_id = app_sessions.bundle_id
      WHERE COALESCE(app_sessions.end_time, app_sessions.start_time + app_sessions.duration_sec * 1000) > ?
        AND app_sessions.start_time < ?
        AND ${noiseFilters}
      GROUP BY app_sessions.bundle_id
      HAVING total_seconds > 0
      ORDER BY total_seconds DESC
      LIMIT 5
    `)
    .all(
      toMs,
      fromMs,
      fromMs,
      toMs,
      ...UX_NOISE_SUBSTRINGS.map((substring) => `%${substring}%`),
    ) as {
    bundle_id: string
    app_name: string
    category: AppCategory
    has_override: number
    total_seconds: number
  }[]

  return {
    totalTrackedSeconds,
    totalFocusSeconds,
    focusPct,
    avgFocusScore,
    bestDay: bestDayRow,
    mostActiveDay: mostActiveDayRow,
    topApps: topAppRows.map((row) => {
      const identity = resolveCanonicalApp(row.bundle_id, row.app_name)
      return {
        appName: identity.displayName || row.app_name,
        bundleId: row.bundle_id,
        totalSeconds: Math.round(row.total_seconds),
        category: appLevelCategoryForIdentity(row.category, identity, row.has_override > 0),
      }
    }),
    dailyBreakdown: rows.map((row) => ({
      date: row.date,
      focusSeconds: row.focus_sec,
      totalSeconds: row.total_active_sec,
      focusScore: row.focus_score,
    })),
  }
}

export function getAppCharacter(
  db: Database.Database,
  bundleId: string,
  daysBack: number,
): AppCharacter | null {
  const now = Date.now()
  const fromMs = now - Math.max(daysBack, 1) * 24 * 60 * 60 * 1000
  const sessions = getSessionsForApp(db, bundleId, fromMs, now)

  if (sessions.length < 3) return null

  const avgSessionMinutes =
    sessions.reduce((sum, session) => sum + session.durationSeconds, 0) / sessions.length / 60

  const categoryTotals = new Map<AppCategory, number>()
  for (const session of sessions) {
    categoryTotals.set(
      session.category,
      (categoryTotals.get(session.category) ?? 0) + session.durationSeconds,
    )
  }

  const dominantCategory = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? sessions[0].category

  let character: AppCharacter['character'] = 'neutral'
  let label = formatCategoryLabel(dominantCategory)

  if (dominantCategory === 'meetings' || dominantCategory === 'communication') {
    character = 'communication'
    label = 'Communication & calls'
  } else if (avgSessionMinutes >= 25 && FOCUSED_CATEGORIES.includes(dominantCategory)) {
    character = 'deep_focus'
    label = 'Sustained use'
  } else if (avgSessionMinutes >= 15 && FOCUSED_CATEGORIES.includes(dominantCategory)) {
    character = 'flow_compatible'
    label = 'Long sessions'
  } else if (sessions.length >= 8 && avgSessionMinutes < 4) {
    character = 'context_switching'
    label = 'Quick app returns'
  } else if (dominantCategory === 'entertainment' || dominantCategory === 'social') {
    character = 'distraction'
    label = 'Short leisure sessions'
  } else if (avgSessionMinutes < 5 && sessions.length >= 5) {
    character = 'context_switching'
    label = 'Short repeated sessions'
  }

  return {
    character,
    label,
    confidence: Math.min(sessions.length / 10, 1),
    avgSessionMinutes: Math.round(avgSessionMinutes * 10) / 10,
    sessionCount: sessions.length,
  }
}

// ---------------------------------------------------------------------------
// Focus sessions
// ---------------------------------------------------------------------------

export function startFocusSession(
  db: Database.Database,
  payload: FocusStartPayload = {},
): number {
  const label = payload.label ?? null
  const targetMinutes = payload.targetMinutes ?? null
  const plannedApps = JSON.stringify(normalizePlannedApps(payload.plannedApps))
  const result = db
    .prepare(`
      INSERT INTO focus_sessions (start_time, label, target_minutes, planned_apps)
      VALUES (?, ?, ?, ?)
    `)
    .run(Date.now(), label, targetMinutes, plannedApps)
  return result.lastInsertRowid as number
}

export function stopFocusSession(db: Database.Database, id: number): void {
  const now = Date.now()
  const session = db
    .prepare<number>(`SELECT start_time FROM focus_sessions WHERE id = ?`)
    .get(id) as { start_time: number } | undefined
  if (!session) return
  const durationSec = Math.round((now - session.start_time) / 1000)
  db.prepare(`UPDATE focus_sessions SET end_time = ?, duration_sec = ? WHERE id = ?`).run(
    now,
    durationSec,
    id,
  )
}

export function getActiveFocusSession(db: Database.Database): FocusSession | null {
  const row = db
    .prepare(`SELECT * FROM focus_sessions WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1`)
    .get() as FocusSessionRow | undefined
  if (!row) return null
  return mapFocusSessionRow(row)
}

export function saveFocusReflection(
  db: Database.Database,
  sessionId: number,
  note: string,
): void {
  db.prepare(`
    UPDATE focus_sessions
    SET reflection_note = ?
    WHERE id = ?
  `).run(note.trim(), sessionId)
}

export function recordDistractionEvent(
  db: Database.Database,
  payload: { sessionId: number | null; appName: string; bundleId: string; triggeredAt?: number },
): void {
  db.prepare(`
    INSERT INTO distraction_events (session_id, app_name, bundle_id, triggered_at)
    VALUES (?, ?, ?, ?)
  `).run(payload.sessionId, payload.appName, payload.bundleId, payload.triggeredAt ?? Date.now())
}

export function getDistractionCountForSession(
  db: Database.Database,
  sessionId: number,
): number {
  const row = db
    .prepare<number, { count: number }>(`
      SELECT COUNT(*) AS count
      FROM distraction_events
      WHERE session_id = ?
    `)
    .get(sessionId)
  return row?.count ?? 0
}

// ---------------------------------------------------------------------------
// Category overrides
// ---------------------------------------------------------------------------

const categoryOverridesCache = new WeakMap<Database.Database, Record<string, AppCategory>>()

function invalidateCategoryOverridesCache(db: Database.Database): void {
  categoryOverridesCache.delete(db)
}

export function getCategoryOverrides(db: Database.Database): Record<string, AppCategory> {
  const cached = categoryOverridesCache.get(db)
  if (cached) return { ...cached }

  const rows = db
    .prepare(`SELECT bundle_id, category FROM category_overrides`)
    .all() as { bundle_id: string; category: AppCategory }[]
  const overrides = Object.fromEntries(rows.map((r) => [r.bundle_id, r.category])) as Record<string, AppCategory>
  categoryOverridesCache.set(db, overrides)
  return { ...overrides }
}

export function clearCategoryOverride(db: Database.Database, bundleId: string): void {
  db.prepare(`DELETE FROM category_overrides WHERE bundle_id = ?`).run(bundleId)
  invalidateCategoryOverridesCache(db)
}

export function setCategoryOverride(
  db: Database.Database,
  bundleId: string,
  category: AppCategory,
): void {
  db.prepare(`
    INSERT INTO category_overrides (bundle_id, category, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (bundle_id) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at
  `).run(bundleId, category, Date.now())
  invalidateCategoryOverridesCache(db)
}

// Every app the user has actually used, each with its effective category —
// including the uncategorized ones (settings spec §4, invariant #3). Unlike the
// Apps view this is NOT capped or windowed: a browser like Zen that only shows a
// little time must still be reachable here so it can be categorized. System
// noise (Finder, loginwindow, notification centre) is excluded — it is never a
// user app (invariant #11).
export function getAllAppsForLabeling(db: Database.Database): AppUsageSummary[] {
  const overrides = getCategoryOverrides(db)

  // Totals per bundle across all history.
  const totals = db.prepare(`
    SELECT bundle_id AS bundleId,
           SUM(duration_sec) AS totalSeconds,
           COUNT(*) AS sessionCount,
           MAX(start_time) AS lastSeen
    FROM app_sessions
    WHERE bundle_id IS NOT NULL AND bundle_id != ''
    GROUP BY bundle_id
  `).all() as Array<{ bundleId: string; totalSeconds: number; sessionCount: number; lastSeen: number }>

  // The most recent name + detected category for each bundle, so a relabelled
  // app still shows the name we last saw it under. Tie-break on the row id so
  // two sessions sharing the same max start_time pick one row deterministically.
  const latest = db.prepare(`
    SELECT s.bundle_id AS bundleId, s.app_name AS appName, s.category AS category
    FROM app_sessions s
    JOIN (
      SELECT bundle_id, MAX(start_time) AS ms
      FROM app_sessions
      WHERE bundle_id IS NOT NULL AND bundle_id != ''
      GROUP BY bundle_id
    ) l ON l.bundle_id = s.bundle_id AND l.ms = s.start_time
    WHERE s.id = (
      SELECT MAX(s2.id) FROM app_sessions s2
      WHERE s2.bundle_id = s.bundle_id AND s2.start_time = s.start_time
    )
  `).all() as Array<{ bundleId: string; appName: string; category: AppCategory }>

  const latestByBundle = new Map(latest.map((row) => [row.bundleId, row]))

  const summaries: AppUsageSummary[] = []
  for (const row of totals) {
    const meta = latestByBundle.get(row.bundleId)
    const appName = meta?.appName ?? row.bundleId
    const identity = resolveCanonicalApp(row.bundleId, appName)
    const sessionRow = {
      bundle_id: row.bundleId,
      app_name: appName,
      raw_app_name: appName,
      canonical_app_id: identity.canonicalAppId ?? null,
      category: meta?.category ?? 'uncategorized',
    }
    if (isUxNoise(sessionRow)) continue
    // Drop sub-dwell blips (brief app transitions) — they aren't apps the user
    // "used", just focus flicker — but keep genuinely low-usage real apps.
    if ((row.totalSeconds ?? 0) < MIN_CAPTURE_DWELL_SEC) continue

    const category = appLevelCategoryForIdentity(
      resolvedSessionCategory(sessionRow, overrides, identity),
      identity,
      Boolean(categoryOverrideFor(sessionRow, overrides, identity)),
    )
    summaries.push({
      bundleId: row.bundleId,
      canonicalAppId: identity.canonicalAppId ?? row.bundleId,
      appName: identity.displayName || appName,
      category,
      totalSeconds: row.totalSeconds ?? 0,
      isFocused: isCategoryFocused(category),
      sessionCount: row.sessionCount ?? 0,
    })
  }

  return summaries.sort((a, b) => b.totalSeconds - a.totalSeconds)
}

// How much captured history a relabel touches, so Settings can report its
// effect ("updated 3 days of blocks") instead of changing silently
// (settings spec §4). Days come straight from the app's own sessions, so the
// number reflects real data already on disk — not a guess.
export function getCategoryOverrideEffect(
  db: Database.Database,
  bundleId: string,
): { daysAffected: number; sessionsAffected: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS sessions,
           COUNT(DISTINCT date(start_time / 1000, 'unixepoch', 'localtime')) AS days
    FROM app_sessions
    WHERE bundle_id = ?
  `).get(bundleId) as { sessions: number; days: number } | undefined
  return {
    daysAffected: row?.days ?? 0,
    sessionsAffected: row?.sessions ?? 0,
  }
}

// ---------------------------------------------------------------------------
// AI conversations
// ---------------------------------------------------------------------------

export function getOrCreateConversation(db: Database.Database): number {
  const row = db
    .prepare(`SELECT id FROM ai_conversations ORDER BY created_at DESC LIMIT 1`)
    .get() as { id: number } | undefined
  if (row) return row.id
  const result = db
    .prepare(`INSERT INTO ai_conversations (messages, created_at) VALUES ('[]', ?)`)
    .run(Date.now())
  return result.lastInsertRowid as number
}

export function appendConversationMessage(
  db: Database.Database,
  conversationId: number,
  role: 'user' | 'assistant',
  content: string,
  options?: {
    metadata?: AIThreadMessageMetadata | null
    createdAt?: number
    threadId?: number | null
  },
): AIThreadMessage {
  const createdAt = options?.createdAt ?? Date.now()
  const metadata = options?.metadata ?? null
  const threadId = options?.threadId ?? null
  const result = db.prepare(
    `INSERT INTO ai_messages (
      conversation_id,
      role,
      content,
      created_at,
      metadata_json,
      thread_id,
      rating,
      rating_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    conversationId,
    role,
    content,
    createdAt,
    JSON.stringify(metadata ?? {}),
    threadId,
    metadata?.rating ?? null,
    metadata?.ratingUpdatedAt ?? null,
  )

  return {
    id: result.lastInsertRowid as number,
    role,
    content,
    createdAt,
    answerKind: metadata?.answerKind ?? null,
    suggestedFollowUps: metadata?.suggestedFollowUps ?? [],
    retryable: metadata?.retryable ?? false,
    retrySourceUserMessageId: metadata?.retrySourceUserMessageId ?? null,
    contextSnapshot: metadata?.contextSnapshot ?? null,
    providerError: metadata?.providerError ?? false,
    actions: metadata?.actions ?? [],
    actionWidgets: metadata?.actionWidgets ?? [],
    artifacts: metadata?.artifacts ?? [],
    agent: metadata?.agent,
    rating: metadata?.rating ?? null,
    ratingUpdatedAt: metadata?.ratingUpdatedAt ?? null,
  }
}

export function getConversationMessages(
  db: Database.Database,
  conversationId: number,
): AIThreadMessage[] {
  return db
    .prepare(
      `SELECT
         id,
         role,
         content,
         created_at AS createdAt,
         metadata_json AS metadataJson,
         rating,
         rating_updated_at AS ratingUpdatedAt
       FROM ai_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(conversationId)
    .map((row) => mapAIThreadMessage(row as {
      id: number
      role: 'user' | 'assistant'
      content: string
      createdAt: number
      metadataJson: string | null
      rating: 'up' | 'down' | null
      ratingUpdatedAt: number | null
    })) as AIThreadMessage[]
}

export function getThreadMessages(
  db: Database.Database,
  threadId: number,
): AIThreadMessage[] {
  return db
    .prepare(
      `SELECT
         id,
         role,
         content,
         created_at AS createdAt,
         metadata_json AS metadataJson,
         rating,
         rating_updated_at AS ratingUpdatedAt
       FROM ai_messages
       WHERE thread_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(threadId)
    .map((row) => mapAIThreadMessage(row as {
      id: number
      role: 'user' | 'assistant'
      content: string
      createdAt: number
      metadataJson: string | null
      rating: 'up' | 'down' | null
      ratingUpdatedAt: number | null
    })) as AIThreadMessage[]
}

// Newest page of a thread's messages for the chat view. Opening a conversation
// must not load its entire history (threads grow unbounded); the view loads the
// most recent `limit` messages and pages older ones in on demand. The cursor is
// the (createdAt, id) of the oldest already-loaded message so pages stay stable
// against ties in created_at. Returned messages are ascending, ready to render
// or prepend. The AI send path still reads full history via getThreadMessages.
export function getThreadMessagesPage(
  db: Database.Database,
  threadId: number,
  options: { limit: number; before?: { createdAt: number; id: number } | null },
): { messages: AIThreadMessage[]; hasEarlier: boolean } {
  const limit = Math.max(1, options.limit)
  const before = options.before ?? null
  const rows = db
    .prepare(
      `SELECT
         id,
         role,
         content,
         created_at AS createdAt,
         metadata_json AS metadataJson,
         rating,
         rating_updated_at AS ratingUpdatedAt
       FROM ai_messages
       WHERE thread_id = ?
         ${before ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(...(before
      ? [threadId, before.createdAt, before.createdAt, before.id, limit + 1]
      : [threadId, limit + 1])) as Array<{
      id: number
      role: 'user' | 'assistant'
      content: string
      createdAt: number
      metadataJson: string | null
      rating: 'up' | 'down' | null
      ratingUpdatedAt: number | null
    }>

  const hasEarlier = rows.length > limit
  const page = hasEarlier ? rows.slice(0, limit) : rows
  return {
    messages: page.reverse().map((row) => mapAIThreadMessage(row)) as AIThreadMessage[],
    hasEarlier,
  }
}

export function getThreadConversationState(
  db: Database.Database,
  threadId: number,
): AIConversationState | null {
  const rows = db
    .prepare(
      `SELECT metadata_json AS metadataJson
       FROM ai_messages
       WHERE thread_id = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(threadId) as { metadataJson: string | null }[]

  for (const row of rows) {
    const metadata = parseJsonObject<AIThreadMessageMetadata>(row.metadataJson, {})
    if (metadata.contextSnapshot) return metadata.contextSnapshot
  }
  return null
}

export function updateAIMessageFeedback(
  db: Database.Database,
  messageId: number,
  rating: AIThreadMessageMetadata['rating'],
): AIThreadMessage | null {
  const row = db.prepare(`
    SELECT
      id,
      role,
      content,
      created_at AS createdAt,
      metadata_json AS metadataJson,
      rating,
      rating_updated_at AS ratingUpdatedAt
    FROM ai_messages
    WHERE id = ?
    LIMIT 1
  `).get(messageId) as {
    id: number
    role: 'user' | 'assistant'
    content: string
    createdAt: number
    metadataJson: string | null
    rating: 'up' | 'down' | null
    ratingUpdatedAt: number | null
  } | undefined

  if (!row) return null

  const metadata = parseJsonObject<AIThreadMessageMetadata>(row.metadataJson, {})
  const nextMetadata: AIThreadMessageMetadata = {
    ...metadata,
    rating: rating ?? null,
    ratingUpdatedAt: rating ? Date.now() : null,
  }

  db.prepare(`
    UPDATE ai_messages
    SET metadata_json = ?,
        rating = ?,
        rating_updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(nextMetadata),
    nextMetadata.rating ?? null,
    nextMetadata.ratingUpdatedAt ?? null,
    messageId,
  )

  return mapAIThreadMessage({
    ...row,
    metadataJson: JSON.stringify(nextMetadata),
    rating: nextMetadata.rating ?? null,
    ratingUpdatedAt: nextMetadata.ratingUpdatedAt ?? null,
  })
}

export function getConversationState(
  db: Database.Database,
  conversationId: number,
): AIConversationState | null {
  const row = db.prepare(
    `SELECT state_json AS stateJson
     FROM ai_conversation_state
     WHERE conversation_id = ?`
  ).get(conversationId) as { stateJson: string } | undefined
  if (!row) return null
  return parseJsonObject<AIConversationState | null>(row.stateJson, null)
}

export function upsertConversationState(
  db: Database.Database,
  conversationId: number,
  state: AIConversationState | null,
): void {
  if (!state) {
    db.prepare(`DELETE FROM ai_conversation_state WHERE conversation_id = ?`).run(conversationId)
    return
  }
  db.prepare(`
    INSERT INTO ai_conversation_state (conversation_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).run(conversationId, JSON.stringify(state), Date.now())
}

export function clearConversation(db: Database.Database, conversationId: number): void {
  db.prepare(`DELETE FROM ai_messages WHERE conversation_id = ?`).run(conversationId)
  db.prepare(`DELETE FROM ai_conversation_state WHERE conversation_id = ?`).run(conversationId)
}

function mapAISurfaceSummary(
  row: {
    scope_type: string
    scope_key: string
    job_type: string
    title: string | null
    summary_text: string
    updated_at: number
  },
  stale = false,
): AISurfaceSummary {
  return {
    scope: row.scope_type as AISurfaceSummary['scope'],
    scopeKey: row.scope_key,
    jobType: row.job_type as AISurfaceSummary['jobType'],
    title: row.title,
    summary: row.summary_text,
    updatedAt: row.updated_at,
    stale,
  }
}

export function getAISurfaceSummary(
  db: Database.Database,
  scopeType: AISurfaceSummary['scope'],
  scopeKey: string,
  options?: { stale?: boolean },
): AISurfaceSummary | null {
  const row = db.prepare(`
    SELECT scope_type, scope_key, job_type, title, summary_text, updated_at
    FROM ai_surface_summaries
    WHERE scope_type = ? AND scope_key = ?
    LIMIT 1
  `).get(scopeType, scopeKey) as {
    scope_type: string
    scope_key: string
    job_type: string
    title: string | null
    summary_text: string
    updated_at: number
  } | undefined

  return row ? mapAISurfaceSummary(row, options?.stale ?? false) : null
}

export function upsertAISurfaceSummary(
  db: Database.Database,
  payload: {
    scopeType: AISurfaceSummary['scope']
    scopeKey: string
    jobType: AISurfaceSummary['jobType']
    inputSignature: string
    title?: string | null
    summary: string
    metadata?: Record<string, unknown> | null
  },
): AISurfaceSummary {
  const now = Date.now()
  db.prepare(`
    INSERT INTO ai_surface_summaries (
      scope_type,
      scope_key,
      job_type,
      title,
      summary_text,
      input_signature,
      metadata_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_type, scope_key) DO UPDATE SET
      job_type = excluded.job_type,
      title = excluded.title,
      summary_text = excluded.summary_text,
      input_signature = excluded.input_signature,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    payload.scopeType,
    payload.scopeKey,
    payload.jobType,
    payload.title ?? null,
    payload.summary,
    payload.inputSignature,
    JSON.stringify(payload.metadata ?? {}),
    now,
    now,
  )

  return {
    scope: payload.scopeType,
    scopeKey: payload.scopeKey,
    jobType: payload.jobType,
    title: payload.title ?? null,
    summary: payload.summary,
    updatedAt: now,
    stale: false,
  }
}

export function getAISurfaceSummarySignature(
  db: Database.Database,
  scopeType: AISurfaceSummary['scope'],
  scopeKey: string,
): string | null {
  const row = db.prepare(`
    SELECT input_signature
    FROM ai_surface_summaries
    WHERE scope_type = ? AND scope_key = ?
    LIMIT 1
  `).get(scopeType, scopeKey) as { input_signature: string } | undefined

  return row?.input_signature ?? null
}

export function startAIUsageEvent(
  db: Database.Database,
  payload: {
    id: string
    jobType: string
    screen: string
    triggerSource: string
    provider?: string | null
    model?: string | null
    startedAt: number
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO ai_usage_events (
      id,
      job_type,
      screen,
      trigger_source,
      provider,
      model,
      success,
      started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    payload.id,
    payload.jobType,
    payload.screen,
    payload.triggerSource,
    payload.provider ?? null,
    payload.model ?? null,
    payload.startedAt,
  )
}

// Backing count for the background-AI daily budget breaker: every attempted
// background call (success or not) since the given timestamp. Attempts count,
// not successes — a failing loop must trip the breaker just as fast.
export function countBackgroundAIUsageEventsSince(db: Database.Database, sinceMs: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM ai_usage_events
    WHERE trigger_source = 'background'
      AND started_at >= ?
  `).get(sinceMs) as { n: number }
  return row.n
}

export function finishAIUsageEvent(
  db: Database.Database,
  payload: {
    id: string
    provider?: string | null
    model?: string | null
    success: boolean
    failureReason?: string | null
    completedAt: number
    latencyMs?: number | null
    inputTokens?: number | null
    outputTokens?: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
    cacheHit?: boolean
    costUsd?: number | null
    billingMode?: string | null
  },
): void {
  db.prepare(`
    UPDATE ai_usage_events
    SET provider = COALESCE(?, provider),
        model = COALESCE(?, model),
        success = ?,
        failure_reason = ?,
        completed_at = ?,
        latency_ms = ?,
        input_tokens = ?,
        output_tokens = ?,
        cache_read_tokens = ?,
        cache_write_tokens = ?,
        cache_hit = ?,
        cost_usd = ?,
        billing_mode = COALESCE(?, billing_mode)
    WHERE id = ?
  `).run(
    payload.provider ?? null,
    payload.model ?? null,
    payload.success ? 1 : 0,
    payload.failureReason ?? null,
    payload.completedAt,
    payload.latencyMs ?? null,
    payload.inputTokens ?? null,
    payload.outputTokens ?? null,
    payload.cacheReadTokens ?? null,
    payload.cacheWriteTokens ?? null,
    payload.cacheHit ? 1 : 0,
    payload.costUsd ?? null,
    payload.billingMode ?? null,
    payload.id,
  )
}

// ---------------------------------------------------------------------------
// Recent focus sessions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sessions for a specific app (drill-down)
// ---------------------------------------------------------------------------

export function getSessionsForApp(
  db: Database.Database,
  bundleId: string,
  fromMs: number,
  toMs: number,
): AppSession[] {
  const overrides = getCategoryOverrides(db)

  const rows = db
    .prepare<[string, number, number, number]>(`
      SELECT ${APP_SESSION_COLUMNS} FROM app_sessions
      WHERE bundle_id = ? AND start_time >= ? AND start_time < ? AND COALESCE(end_time, start_time + duration_sec * 1000) > ?
      ORDER BY start_time ASC
    `)
    .all(bundleId, fromMs - SESSION_OVERLAP_LOOKBACK_MS, toMs, fromMs) as AppSessionRow[]

  const clipped = rows
    .filter((r) => !isUxNoise(r))
    .map((r) => {
      const identity = resolvedRowIdentity(r)
      const category = resolvedSessionCategory(r, overrides, identity)
      return clipRowToRange(r, fromMs, toMs, category, identity)
    })
    .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)

  return mergeSessions(clipped).reverse()
}

// Last N app sessions across all apps — for the debug panel.
// Column aliases map snake_case DB names to the camelCase TypeScript type.
export function getRecentAppSessions(
  db: Database.Database,
  limit = 5,
): { appName: string; category: string; durationSec: number; startTime: number }[] {
  const rows = db
    .prepare<number>(`
      SELECT bundle_id,
             app_name   AS appName,
             category,
             duration_sec AS durationSec,
             start_time   AS startTime
      FROM app_sessions
      ORDER BY start_time DESC
      LIMIT ?
    `)
    .all(limit) as { bundle_id: string; appName: string; category: string; durationSec: number; startTime: number }[]
  return rows.map(({ bundle_id, ...r }) => ({ ...r, appName: resolveDisplayName(bundle_id, r.appName) }))
}

// ---------------------------------------------------------------------------
// Website visits
// ---------------------------------------------------------------------------

export interface WebsiteVisitInsert {
  domain: string
  pageTitle: string | null
  url: string
  normalizedUrl: string | null
  pageKey: string | null
  visitTime: number        // Unix ms
  visitTimeUs: bigint      // Microsecond timestamp from source browser (Chrome or Unix epoch µs)
  durationSec: number
  browserBundleId: string
  canonicalBrowserId: string | null
  browserProfileId: string | null
  source: string
}

export function insertWebsiteVisit(
  db: Database.Database,
  visit: WebsiteVisitInsert,
): boolean {
  const url = sanitizeUrlForPersistence(visit.url)
  if (!url) return false
  const normalizedUrl = visit.normalizedUrl ?? normalizeUrlForStorage(visit.url)
  const pageKey = visit.pageKey ?? pageKeyForUrl(visit.url)
  const durationSec = clipWebsiteVisitDurationToBrowserForeground(db, {
    visitTime: visit.visitTime,
    durationSec: visit.durationSec,
    browserBundleId: visit.browserBundleId,
    canonicalBrowserId: visit.canonicalBrowserId,
  })

  const result = db.prepare(`
    INSERT OR IGNORE INTO website_visits
      (
        domain,
        page_title,
        url,
        visit_time,
        visit_time_us,
        duration_sec,
        browser_bundle_id,
        canonical_browser_id,
        browser_profile_id,
        normalized_url,
        page_key,
        source
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    visit.domain,
    visit.pageTitle,
    url,
    visit.visitTime,
    visit.visitTimeUs,
    durationSec,
    visit.browserBundleId,
    visit.canonicalBrowserId,
    visit.browserProfileId,
    normalizedUrl,
    pageKey,
    visit.source,
  )
  return result.changes > 0
}

/** Clip page duration to overlapping foreground browser time when any exists. */
export function clipWebsiteVisitDurationToBrowserForeground(
  db: Database.Database,
  visit: {
    visitTime: number
    durationSec: number
    browserBundleId: string
    canonicalBrowserId: string | null
  },
): number {
  if (visit.durationSec <= 0) return 0
  const visitEnd = visit.visitTime + visit.durationSec * 1000
  const visitCanonical =
    visit.canonicalBrowserId ?? resolveCanonicalBrowser(visit.browserBundleId).canonicalBrowserId
  const visitBundleBase = visit.browserBundleId.split(':', 1)[0]?.toLowerCase() ?? ''

  let rows: Array<{
    start_time: number
    end_time: number | null
    duration_sec: number
    bundle_id: string | null
    canonical_app_id: string | null
  }>
  try {
    rows = db.prepare(`
      SELECT start_time, end_time, duration_sec, bundle_id, canonical_app_id
      FROM app_sessions
      WHERE start_time < ?
        AND COALESCE(end_time, start_time + duration_sec * 1000) > ?
    `).all(visitEnd, visit.visitTime) as typeof rows
  } catch {
    return visit.durationSec
  }

  let overlapMs = 0
  for (const row of rows) {
    const bundle = (row.bundle_id ?? '').toLowerCase()
    const bundleBase = bundle.split(':', 1)[0] ?? ''
    const canonical = (row.canonical_app_id ?? '').toLowerCase()
    const sameBrowser =
      (visitCanonical != null && canonical !== '' && canonical === visitCanonical.toLowerCase())
      || (bundleBase !== '' && bundleBase === visitBundleBase)
      || bundle === visit.browserBundleId.toLowerCase()
    if (!sameBrowser) continue

    const sessionEnd = row.end_time ?? row.start_time + row.duration_sec * 1000
    const overlapStart = Math.max(visit.visitTime, row.start_time)
    const overlapEnd = Math.min(visitEnd, sessionEnd)
    if (overlapEnd > overlapStart) overlapMs += overlapEnd - overlapStart
  }

  // No foreground overlap: keep the source duration for retrieval; active-time
  // reconciliation still refuses to credit it against browser ownership.
  if (overlapMs <= 0) return visit.durationSec
  return Math.max(1, Math.round(overlapMs / 1000))
}

export function getBrowserHistoryCursor(
  db: Database.Database,
  browserBundleId: string,
): bigint | null {
  const row = db.prepare(`
    SELECT cursor_us FROM browser_history_cursors WHERE browser_bundle_id = ?
  `).get(browserBundleId) as { cursor_us: string } | undefined
  if (!row?.cursor_us) return null
  try {
    return BigInt(row.cursor_us)
  } catch {
    return null
  }
}

export function setBrowserHistoryCursor(
  db: Database.Database,
  browserBundleId: string,
  cursorUs: bigint,
  updatedAt = Date.now(),
): void {
  db.prepare(`
    INSERT INTO browser_history_cursors (browser_bundle_id, cursor_us, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(browser_bundle_id) DO UPDATE SET
      cursor_us = excluded.cursor_us,
      updated_at = excluded.updated_at
  `).run(browserBundleId, cursorUs.toString(), updatedAt)
}


// App Detail's browser breakdown: per-domain, per-page reconciled time for one
// canonical browser identity (all Chrome profiles under one number). This is
// the App Detail replacement for the old raw-SUM getDomainSummariesForBrowser /
// getPageSummariesForBrowser pair: raw SUM(duration_sec) kept accruing while
// the browser sat in the background and double-counted the two capture paths,
// so the domain and page sections could never add up to the app's own
// foreground total.
//
// Built on reconcileWebsiteVisits — the SAME per-visit ledger every other
// website number reads — with one extra clip: credit is intersected with THIS
// browser's own foreground sessions, dropping the global untracked-gap pool.
// The app header counts foreground seconds only, so the breakdown must too
// (browsing during an honest capture gap is real evidence for the timeline,
// but it is not part of "1h 56m in Dia" and would make the sum exceed the
// headline). Every credited second belongs to exactly one visit, one page,
// one domain, so by construction: Σ page seconds = its domain's seconds, and
// Σ domain seconds = attributedSeconds ≤ the app's foreground total. The
// caller renders the difference as an explicit "No page recorded" remainder,
// never smearing it into a domain (invariant 10).
export interface BrowserPageActivity {
  domain: string
  url: string | null
  normalizedUrl: string | null
  pageKey: string | null
  title: string | null
  totalSeconds: number
  visitCount: number
}

export interface BrowserDomainActivity {
  domain: string
  totalSeconds: number
  visitCount: number
  pages: BrowserPageActivity[]
}

export interface BrowserActivityBreakdown {
  domains: BrowserDomainActivity[]
  // Sum of every domain's totalSeconds (kept precomputed so callers derive
  // the "No page recorded" remainder from the same numbers they display).
  attributedSeconds: number
}

export function getBrowserActivityBreakdown(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  canonicalBrowserId: string,
  options: { excludeSpans?: readonly CorrectionSpan[]; sessions?: readonly AppSession[] } = {},
): BrowserActivityBreakdown {
  const excludeSpans = options.excludeSpans ?? []
  // Reconcile over the WHOLE range and every browser — the claim pool a page
  // draws from is shared with every other visit inside the same browser, and
  // filtering before reconciling would let a page fill time another visit had
  // already claimed (same rule as getTopPagesForDomains).
  const credits = reconcileWebsiteVisits(db, fromMs, toMs)
  if (credits.length === 0) return { domains: [], attributedSeconds: 0 }

  // This browser's own foreground windows, duration-bounded so the credited
  // total can never exceed what the app header counts (the header sums
  // duration_sec, not wall-clock spans).
  const foreground: { start: number; end: number }[] = []
  for (const session of options.sessions ?? getSessionsForRange(db, fromMs, toMs)) {
    if ((session.canonicalAppId ?? session.bundleId) !== canonicalBrowserId && session.bundleId !== canonicalBrowserId) continue
    // Corrected truth (invariant 7): a deleted Timeline block's foreground
    // windows carry no page credit — its domains/pages vanish with its total.
    if (!options.sessions && excludeSpans.length > 0 && sessionStartsInsideSpans(session, excludeSpans)) continue
    const start = Math.max(session.startTime, fromMs)
    const end = Math.min(
      Math.min(
        session.endTime ?? session.startTime + session.durationSeconds * 1000,
        session.startTime + session.durationSeconds * 1000,
      ),
      toMs,
    )
    if (end > start) foreground.push({ start, end })
  }
  if (foreground.length === 0) return { domains: [], attributedSeconds: 0 }
  foreground.sort((a, b) => a.start - b.start)

  type PageAccumulator = {
    domain: string
    url: string | null
    normalizedUrl: string | null
    pageKey: string | null
    intervals: { start: number; end: number }[]
    visitCount: number
    topTitle: string | null
    topTitleMs: number
    topTitleSpecific: boolean
  }
  const byPage = new Map<string, PageAccumulator>()

  for (const { visit, freeIntervals } of credits) {
    if (visit.canonical_browser_id !== canonicalBrowserId && visit.browser_bundle_id !== canonicalBrowserId) continue
    if (freeIntervals.length === 0) continue

    // Clip the visit's reconciled credit to this browser's foreground windows.
    const clipped: { start: number; end: number }[] = []
    for (const interval of freeIntervals) {
      for (const window of foreground) {
        const start = Math.max(interval.start, window.start)
        const end = Math.min(interval.end, window.end)
        if (end > start) clipped.push({ start, end })
      }
    }
    if (clipped.length === 0) continue

    const pageIdentity = visit.normalized_url ?? visit.page_key ?? visit.url ?? `domain:${visit.domain}`
    const key = `${visit.domain}${KEY_SEP}${pageIdentity}`
    let entry = byPage.get(key)
    if (!entry) {
      entry = {
        domain: visit.domain,
        url: null,
        normalizedUrl: null,
        pageKey: null,
        intervals: [],
        visitCount: 0,
        topTitle: null,
        topTitleMs: 0,
        topTitleSpecific: false,
      }
      byPage.set(key, entry)
    }
    entry.url ??= visit.url
    entry.normalizedUrl ??= visit.normalized_url
    entry.pageKey ??= visit.page_key
    entry.visitCount += 1
    let creditedMs = 0
    for (const interval of clipped) {
      entry.intervals.push(interval)
      creditedMs += interval.end - interval.start
    }
    // Same title rule as domain summaries: a specific title beats a generic
    // hub; among equals, more credited time wins.
    if (visit.page_title && creditedMs > 0) {
      const incomingSpecific = !isGenericIndexTitle(visit.page_title)
      const better = incomingSpecific !== entry.topTitleSpecific ? incomingSpecific : creditedMs > entry.topTitleMs
      if (entry.topTitle == null || better) {
        entry.topTitle = visit.page_title
        entry.topTitleMs = creditedMs
        entry.topTitleSpecific = incomingSpecific
      }
    }
  }

  // Union each page's intervals (two capture sources on one page count each
  // second once), then roll pages into domains. Rounding happens ONCE, at the
  // page level; domain totals are the sum of their pages' rounded seconds and
  // attributedSeconds the sum of the domains — so the arithmetic the user can
  // check on screen is exact at every level.
  const domainsByName = new Map<string, BrowserDomainActivity>()
  for (const entry of byPage.values()) {
    entry.intervals.sort((a, b) => a.start - b.start)
    let totalMs = 0
    let cursor = -Infinity
    for (const interval of entry.intervals) {
      const start = Math.max(interval.start, cursor)
      if (interval.end <= start) continue
      totalMs += interval.end - start
      cursor = interval.end
    }
    const totalSeconds = Math.round(totalMs / 1000)
    if (totalSeconds <= 0) continue

    let domainEntry = domainsByName.get(entry.domain)
    if (!domainEntry) {
      domainEntry = { domain: entry.domain, totalSeconds: 0, visitCount: 0, pages: [] }
      domainsByName.set(entry.domain, domainEntry)
    }
    domainEntry.totalSeconds += totalSeconds
    domainEntry.visitCount += entry.visitCount
    domainEntry.pages.push({
      domain: entry.domain,
      url: entry.url,
      normalizedUrl: entry.normalizedUrl,
      pageKey: entry.pageKey,
      title: entry.topTitle,
      totalSeconds,
      visitCount: entry.visitCount,
    })
  }

  let attributedSeconds = 0
  const domains: BrowserDomainActivity[] = []
  for (const domainEntry of domainsByName.values()) {
    domainEntry.pages.sort((a, b) => b.totalSeconds - a.totalSeconds || b.visitCount - a.visitCount)
    attributedSeconds += domainEntry.totalSeconds
    domains.push(domainEntry)
  }
  domains.sort((a, b) => b.totalSeconds - a.totalSeconds || b.visitCount - a.visitCount)

  return { domains, attributedSeconds }
}

interface ReconciledVisitRow {
  id: number
  domain: string
  page_title: string | null
  url: string | null
  normalized_url: string | null
  page_key: string | null
  visit_time: number
  duration_sec: number
  browser_bundle_id: string | null
  canonical_browser_id: string | null
  source: string
}

interface ReconciledVisitCredit {
  visit: ReconciledVisitRow
  // The slices of this visit's own duration that survived reconciliation -
  // clipped to when its browser was actually frontmost (or to an honest
  // capture gap), with claims from other visits in the same browser already
  // subtracted. An empty array means the visit was pure background-tab
  // noise and must not appear as evidence anywhere.
  freeIntervals: { start: number; end: number }[]
}

// One key separator used to keep composite Map keys unambiguous even when
// a domain or browser id happens to contain a space or other punctuation.
const KEY_SEP = String.fromCharCode(0)

// The shared reconciliation engine behind every website-time total in
// Daylens. A site (or one of its pages) is a breakdown of the browser's own
// tracked time, never additional time on top of it (spec: timeline.md S3.0
// "evidence object", invariant 6 "every number on screen comes from the
// same blocks"; apps.md's reconciliation rule). Raw visit durations can't
// be summed as-is: history-sourced visits keep accruing while the browser
// sits in the background (a Meet tab during a whole meeting), and the two
// capture paths (history poll + active-tab tracker) can both record the
// same minutes. So each visit is clipped to the moments its browser was
// actually frontmost - plus any stretch where nothing at all was tracked,
// because a history visit inside a capture gap is real evidence, not a
// background tab - and overlapping visits inside one browser exclusively
// claim disjoint slices of that shared pool (the observed active tab beats
// a history record; among equals the later navigation supersedes the
// earlier one).
//
// Both domain-level summaries (getWebsiteSummariesForRange) and page-level
// breakdowns (getTopPagesForDomains) read from this exact per-visit ledger,
// so a domain's reconciled total and the sum of its pages' reconciled
// totals can never disagree by construction - they're unions of the same
// underlying credited intervals, just grouped at different granularity.
function reconcileWebsiteVisits(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  browserBundleId?: string,
): ReconciledVisitCredit[] {
  const whereExtra = browserBundleId ? ' AND browser_bundle_id = ?' : ''
  const params: (number | string)[] = browserBundleId
    ? [fromMs - SESSION_OVERLAP_LOOKBACK_MS, toMs, fromMs, browserBundleId]
    : [fromMs - SESSION_OVERLAP_LOOKBACK_MS, toMs, fromMs]

  const visits = db
    .prepare(`
      SELECT id,
             domain,
             page_title,
             url,
             normalized_url,
             page_key,
             visit_time,
             duration_sec,
             browser_bundle_id,
             canonical_browser_id,
             source
      FROM website_visits
      WHERE visit_time >= ? AND visit_time < ?
        AND visit_time + duration_sec * 1000 > ?${whereExtra}
      ORDER BY visit_time ASC, id ASC
    `)
    .all(...params) as ReconciledVisitRow[]
  if (visits.length === 0) return []

  // Foreground intervals per browser, from the same session records every
  // other total is built on (one truth: sites reconcile with app time).
  const foregroundByBundle = new Map<string, { start: number; end: number }[]>()
  const foregroundByCanonical = new Map<string, { start: number; end: number }[]>()
  const allForeground: { start: number; end: number }[] = []
  for (const session of getSessionsForRange(db, fromMs, toMs)) {
    const interval = {
      start: session.startTime,
      end: session.endTime ?? (session.startTime + session.durationSeconds * 1000),
    }
    if (interval.end <= interval.start) continue
    allForeground.push(interval)
    const byBundle = foregroundByBundle.get(session.bundleId)
    if (byBundle) byBundle.push(interval)
    else foregroundByBundle.set(session.bundleId, [interval])
    if (session.canonicalAppId) {
      const byCanonical = foregroundByCanonical.get(session.canonicalAppId)
      if (byCanonical) byCanonical.push(interval)
      else foregroundByCanonical.set(session.canonicalAppId, [interval])
    }
  }

  // The capture gaps: stretches of the range where no app session exists at
  // all. A visit there can't be a background tab behind some other app -
  // there was no other app - so it stays countable evidence.
  allForeground.sort((a, b) => a.start - b.start)
  const gaps: { start: number; end: number }[] = []
  let gapCursor = fromMs
  for (const interval of allForeground) {
    if (interval.start > gapCursor) gaps.push({ start: gapCursor, end: interval.start })
    gapCursor = Math.max(gapCursor, interval.end)
  }
  if (gapCursor < toMs) gaps.push({ start: gapCursor, end: toMs })

  // ...but only the gaps no absence signal covers. An idle, away, asleep,
  // passive, or paused stretch means the user demonstrably wasn't active -
  // a tab left open there is not browsing. Only the honest "Daylens wasn't
  // running" gaps keep history visits as evidence. (idle_start fires after
  // the idle threshold already elapsed; idleSeconds backdates the absence
  // to when input actually stopped, matching where the app session was
  // trimmed.)
  const absences: { start: number; end: number }[] = []
  let openAbsenceStart: number | null = null
  const closeAbsence = (ts: number) => {
    if (openAbsenceStart != null && ts > openAbsenceStart) absences.push({ start: openAbsenceStart, end: ts })
    openAbsenceStart = null
  }
  for (const event of getActivityStateEventsForRange(db, fromMs - SESSION_OVERLAP_LOOKBACK_MS, toMs)) {
    switch (event.eventType) {
      case 'suspend':
      case 'lock_screen':
      case 'away_start':
      case 'tracking_paused':
        closeAbsence(event.eventTs)
        openAbsenceStart = event.eventTs
        break
      case 'idle_start': {
        let idleSeconds = 0
        try {
          idleSeconds = Number(JSON.parse(event.metadataJson || '{}').idleSeconds) || 0
        } catch { /* malformed metadata reads as idle-from-now */ }
        closeAbsence(event.eventTs)
        openAbsenceStart = event.eventTs - idleSeconds * 1000
        break
      }
      case 'resume':
      case 'unlock_screen':
      case 'away_end':
      case 'idle_end':
      case 'tracking_resumed':
        closeAbsence(event.eventTs)
        break
      default:
        break
    }
  }
  closeAbsence(toMs)
  absences.sort((a, b) => a.start - b.start)
  const untracked: { start: number; end: number }[] = []
  for (const gap of gaps) {
    let cursor = gap.start
    for (const absence of absences) {
      if (absence.end <= cursor || absence.start >= gap.end) continue
      if (absence.start > cursor) untracked.push({ start: cursor, end: Math.min(absence.start, gap.end) })
      cursor = Math.max(cursor, absence.end)
      if (cursor >= gap.end) break
    }
    if (cursor < gap.end) untracked.push({ start: cursor, end: gap.end })
  }

  const credits: ReconciledVisitCredit[] = []

  // Inside one browser exactly one tab is active at a time, so its visits
  // must partition the browser's time, never share it - a Meet tab's history
  // duration keeps accruing while the user reads x.com in the same window.
  // Each browser gets a claim pool over its allowed time (foreground +
  // capture gaps): the active-tab tracker's samples claim their seconds
  // first, history rows only fill what's left, and every claimed second
  // belongs to exactly one visit (and so exactly one page, exactly one
  // domain).
  const visitsByBrowser = new Map<string, ReconciledVisitRow[]>()
  for (const visit of visits) {
    // Canonical id first: the same browser's visits exist under two bundle-id
    // forms in history (exe path vs real bundle id). Keying pools by the raw
    // bundle id would give one browser two claim pools, letting two identity
    // forms of the same browser credit the same second twice.
    const browserKey = visit.canonical_browser_id ?? visit.browser_bundle_id
    if (!browserKey) {
      // Unknown browser: nothing to reconcile against - clip to the range.
      const start = Math.max(visit.visit_time, fromMs)
      const end = Math.min(visit.visit_time + visit.duration_sec * 1000, toMs)
      credits.push({ visit, freeIntervals: end > start ? [{ start, end }] : [] })
      continue
    }
    const list = visitsByBrowser.get(browserKey)
    if (list) list.push(visit)
    else visitsByBrowser.set(browserKey, [visit])
  }

  // Overlap-merge so an interval reachable under two keys (a session indexed
  // by both its bundle id and its canonical id) can't credit a second twice.
  const mergeIntervals = (intervals: { start: number; end: number }[]): { start: number; end: number }[] => {
    const sorted = [...intervals].sort((a, b) => a.start - b.start)
    const merged: { start: number; end: number }[] = []
    for (const interval of sorted) {
      const last = merged[merged.length - 1]
      if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
      else merged.push({ ...interval })
    }
    return merged
  }

  // First index whose interval could touch or overlap `x` from the left — the
  // earliest interval with end >= x. `claimed` below is kept sorted by start
  // with no overlaps, so this lets each visit jump straight to the relevant
  // slice instead of rescanning the whole array from the front.
  const firstTouchingIndex = (intervals: { start: number; end: number }[], x: number): number => {
    let lo = 0
    let hi = intervals.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (intervals[mid].end >= x) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  // Insert [start,end) into a sorted, non-overlapping interval array, merging
  // any neighbours it touches. A localized splice keeps `claimed` maintained in
  // place instead of rebuilding the whole array for every visit.
  const insertMergedInterval = (intervals: { start: number; end: number }[], start: number, end: number): void => {
    if (end <= start) return
    const i = firstTouchingIndex(intervals, start)
    let ns = start
    let ne = end
    let j = i
    while (j < intervals.length && intervals[j].start <= ne) {
      if (intervals[j].start < ns) ns = intervals[j].start
      if (intervals[j].end > ne) ne = intervals[j].end
      j++
    }
    intervals.splice(i, j - i, { start: ns, end: ne })
  }

  for (const browserVisits of visitsByBrowser.values()) {
    // Union of every identity form's foreground time: visits recorded under
    // either bundle-id form must reconcile against all of the browser's
    // sessions, not just the ones stored under the same form.
    // Gather each identity form's foreground time ONCE per distinct id, not once
    // per visit. The old per-visit push rebuilt the same ~N foreground intervals
    // for every one of the browser's (tens of thousands of) visits, producing a
    // multi-million-entry array that was then sorted — the dominant cost that
    // froze the Apps view for ~15s on a 30-day browser-heavy range.
    const foregroundPieces: { start: number; end: number }[] = []
    const seenBundleKeys = new Set<string>()
    const seenCanonicalKeys = new Set<string>()
    for (const visit of browserVisits) {
      if (visit.browser_bundle_id && !seenBundleKeys.has(visit.browser_bundle_id)) {
        seenBundleKeys.add(visit.browser_bundle_id)
        foregroundPieces.push(...(foregroundByBundle.get(visit.browser_bundle_id) ?? []))
      }
      if (visit.canonical_browser_id && !seenCanonicalKeys.has(visit.canonical_browser_id)) {
        seenCanonicalKeys.add(visit.canonical_browser_id)
        foregroundPieces.push(...(foregroundByCanonical.get(visit.canonical_browser_id) ?? []))
      }
    }
    const allowed = mergeIntervals([...foregroundPieces, ...untracked])
    // The observed active tab beats a history record; among equals the later
    // navigation supersedes the earlier one.
    const ordered = [...browserVisits].sort((a, b) => {
      const priorityA = a.source === 'active_browser_context' ? 0 : 1
      const priorityB = b.source === 'active_browser_context' ? 0 : 1
      return priorityA - priorityB || b.visit_time - a.visit_time
    })
    // `claimed` is the union of every already-processed visit's clipped time,
    // kept sorted by start with no overlaps. Each visit's free time is that
    // visit's clipped span minus `claimed`; we then fold the clipped span back
    // into `claimed`. Both steps use binary search + a localized splice so the
    // whole browser reconciles in ~O(visits · log) instead of the previous
    // O(visits²) full rescan — which blocked the main process for 15-30s and
    // froze the Apps view on a heavy browser user's 30-day range.
    const claimed: { start: number; end: number }[] = []
    for (const visit of ordered) {
      const start = Math.max(visit.visit_time, fromMs)
      const end = Math.min(visit.visit_time + visit.duration_sec * 1000, toMs)
      if (end <= start) {
        credits.push({ visit, freeIntervals: [] })
        continue
      }
      // Clip to the allowed windows, then subtract what earlier visits claimed.
      const clipped: { start: number; end: number }[] = []
      for (const window of allowed) {
        const overlapStart = Math.max(start, window.start)
        const overlapEnd = Math.min(end, window.end)
        if (overlapEnd > overlapStart) clipped.push({ start: overlapStart, end: overlapEnd })
      }
      const free: { start: number; end: number }[] = []
      for (const piece of clipped) {
        let cursor = piece.start
        for (let idx = firstTouchingIndex(claimed, piece.start); idx < claimed.length; idx++) {
          const taken = claimed[idx]
          if (taken.start >= piece.end) break
          if (taken.start > cursor) free.push({ start: cursor, end: Math.min(taken.start, piece.end) })
          if (taken.end > cursor) cursor = taken.end
          if (cursor >= piece.end) break
        }
        if (cursor < piece.end) free.push({ start: cursor, end: piece.end })
      }
      credits.push({ visit, freeIntervals: free })
      for (const piece of clipped) insertMergedInterval(claimed, piece.start, piece.end)
    }
  }

  return credits
}

// A page title that names a navigation surface (a workspace index, an inbox, a
// dashboard) rather than a specific document. These generic hubs out-dwell the
// specific pages a user opens briefly, so ranking evidence purely by time
// buries the intent-bearing titles ("AI Training Session | Notion") under the
// hub ("Notes | All Notes | Notion"). We keep hubs, but rank them below
// specific titles so the block evidence — and the name it drives — carries what
// the user was actually working on (invariant 5).
const GENERIC_INDEX_TITLE_RE = /(^|[\s|·—\-–])(all notes|recent|home|inbox|dashboard|notifications|overview|my drive|new tab|untitled|start page|getting started)([\s|·—\-–]|$)/i
function isGenericIndexTitle(title: string | null | undefined): boolean {
  if (!title) return true
  const t = title.trim()
  if (!t) return true
  return GENERIC_INDEX_TITLE_RE.test(t)
}

export function getWebsiteSummariesForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  browserBundleId?: string,
): WebsiteSummary[] {
  // A site visited inside a browser is a breakdown of the browser's own
  // tracked time, never additional time on top of it - see
  // reconcileWebsiteVisits (above) for the full reconciliation rules this
  // and getTopPagesForDomains both build on.
  const credits = reconcileWebsiteVisits(db, fromMs, toMs, browserBundleId)
  if (credits.length === 0) return []

  type DomainAccumulator = {
    domain: string
    intervals: { start: number; end: number }[]
    visitCount: number
    topTitle: string | null
    topTitleMs: number
    browserBundleId: string | null
    canonicalBrowserId: string | null
  }
  // A domain belongs to the browser that actually loaded it, never to
  // whichever visit happened to be inserted (and read back) first. So
  // the same domain visited from two different browsers must produce two
  // summary rows, each carrying only that browser's own time.
  const byDomainAndBrowser = new Map<string, DomainAccumulator>()
  const browserKeyOf = (visit: ReconciledVisitRow): string | null =>
    visit.browser_bundle_id ?? visit.canonical_browser_id ?? null
  const entryFor = (visit: ReconciledVisitRow): DomainAccumulator => {
    const key = `${visit.domain}${KEY_SEP}${browserKeyOf(visit) ?? ''}`
    let entry = byDomainAndBrowser.get(key)
    if (!entry) {
      entry = { domain: visit.domain, intervals: [], visitCount: 0, topTitle: null, topTitleMs: 0, browserBundleId: null, canonicalBrowserId: null }
      byDomainAndBrowser.set(key, entry)
    }
    entry.browserBundleId ??= visit.browser_bundle_id
    entry.canonicalBrowserId ??= visit.canonical_browser_id
    return entry
  }

  for (const { visit, freeIntervals } of credits) {
    const entry = entryFor(visit)
    entry.visitCount += 1
    let creditedMs = 0
    for (const interval of freeIntervals) {
      entry.intervals.push(interval)
      creditedMs += interval.end - interval.start
    }
    // Prefer a specific title over a generic hub even when the hub out-dwells
    // it; among titles of equal specificity, the one with more foreground time
    // wins. A title with no reconciled foreground time never labels the domain.
    if (visit.page_title && creditedMs > 0) {
      const incomingSpecific = !isGenericIndexTitle(visit.page_title)
      const currentSpecific = entry.topTitle != null && !isGenericIndexTitle(entry.topTitle)
      const better = incomingSpecific !== currentSpecific ? incomingSpecific : creditedMs > entry.topTitleMs
      if (entry.topTitle == null || better) {
        entry.topTitle = visit.page_title
        entry.topTitleMs = creditedMs
      }
    }
  }

  const summaries: WebsiteSummary[] = []
  for (const entry of byDomainAndBrowser.values()) {
    // Union the clipped intervals so overlapping visits (two capture sources,
    // two tabs on one domain, within the same browser) count each second once.
    entry.intervals.sort((a, b) => a.start - b.start)
    let totalMs = 0
    let cursor = -Infinity
    for (const interval of entry.intervals) {
      const start = Math.max(interval.start, cursor)
      if (interval.end <= start) continue
      totalMs += interval.end - start
      cursor = interval.end
    }
    const totalSeconds = Math.round(totalMs / 1000)
    if (totalSeconds <= 0) continue
    summaries.push({
      domain: entry.domain,
      totalSeconds,
      visitCount: entry.visitCount,
      topTitle: entry.topTitle,
      browserBundleId: entry.browserBundleId,
      // Visits recorded before canonical browser ids were stamped (e.g. Comet
      // rows keyed by exe path) carry none; resolve at read so the site can
      // still find its browser row when the bundle-id forms differ.
      canonicalBrowserId: entry.canonicalBrowserId
        ?? (entry.browserBundleId
          ? resolveCanonicalApp(entry.browserBundleId, '').canonicalAppId
          : null),
    })
  }
  return summaries
    .sort((a, b) => b.totalSeconds - a.totalSeconds || b.visitCount - a.visitCount)
    .slice(0, 20)
}

export function getTopPagesForDomains(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  domains: string[],
  limitPerDomain = 5,
): Record<string, { url: string; title: string | null; totalSeconds: number }[]> {
  if (domains.length === 0) {
    return {}
  }
  const domainSet = new Set(domains)

  // Page-level evidence must reconcile exactly the way domain-level does -
  // a page can't outlive the browser tab it was rendered in (spec:
  // timeline.md S3.0, invariant 6; apps.md's reconciliation rule). Reuse
  // the same per-visit ledger getWebsiteSummariesForRange is built from,
  // computed over the WHOLE range and every domain - not just the
  // requested ones - because the claim pool a page draws from is shared
  // with every other domain's visits inside the same browser. Filtering to
  // `domains` before reconciling would let a page fill time another
  // domain's visit had already claimed first, which would break the
  // invariant this function exists to uphold: a domain's page times must
  // sum to no more than that domain's own reconciled total.
  const credits = reconcileWebsiteVisits(db, fromMs, toMs)
  if (credits.length === 0) return {}

  type PageAccumulator = {
    domain: string
    url: string | null
    intervals: { start: number; end: number }[]
    topTitle: string | null
    topTitleMs: number
  }
  const byPage = new Map<string, PageAccumulator>()
  for (const { visit, freeIntervals } of credits) {
    // A visit with zero reconciled overlap (background-tab noise, or simply
    // a domain we weren't asked about) contributes nothing and never
    // becomes a page row.
    if (freeIntervals.length === 0 || !domainSet.has(visit.domain)) continue

    const browserKey = visit.browser_bundle_id ?? visit.canonical_browser_id ?? ''
    const pageIdentity = visit.normalized_url ?? visit.page_key ?? visit.url ?? `domain:${visit.domain}`
    const key = `${visit.domain}${KEY_SEP}${browserKey}${KEY_SEP}${pageIdentity}`
    let entry = byPage.get(key)
    if (!entry) {
      entry = { domain: visit.domain, url: visit.url, intervals: [], topTitle: null, topTitleMs: 0 }
      byPage.set(key, entry)
    }
    entry.url ??= visit.url
    let creditedMs = 0
    for (const interval of freeIntervals) {
      entry.intervals.push(interval)
      creditedMs += interval.end - interval.start
    }
    if (visit.page_title && creditedMs > entry.topTitleMs) {
      entry.topTitle = visit.page_title
      entry.topTitleMs = creditedMs
    }
  }

  const byDomain: Record<string, { url: string; title: string | null; totalSeconds: number }[]> = {}
  for (const entry of byPage.values()) {
    // Union per page the same way domain summaries union per domain - two
    // capture sources landing on one page count each second once.
    entry.intervals.sort((a, b) => a.start - b.start)
    let totalMs = 0
    let cursor = -Infinity
    for (const interval of entry.intervals) {
      const start = Math.max(interval.start, cursor)
      if (interval.end <= start) continue
      totalMs += interval.end - start
      cursor = interval.end
    }
    const totalSeconds = Math.round(totalMs / 1000)
    if (totalSeconds <= 0 || !entry.url) continue
    const bucket = byDomain[entry.domain] ?? []
    bucket.push({ url: entry.url, title: entry.topTitle, totalSeconds })
    byDomain[entry.domain] = bucket
  }

  for (const domain of Object.keys(byDomain)) {
    // Collapse repeated titles (same page reached by several URLs) to their
    // best-dwell instance, so distinct pages — not duplicates of one hub —
    // fill the limited slots.
    const byTitle = new Map<string, { url: string; title: string | null; totalSeconds: number }>()
    const untitled: { url: string; title: string | null; totalSeconds: number }[] = []
    for (const page of byDomain[domain]) {
      const key = page.title?.trim().toLowerCase()
      if (!key) { untitled.push(page); continue }
      const existing = byTitle.get(key)
      if (!existing || page.totalSeconds > existing.totalSeconds) byTitle.set(key, page)
    }
    byDomain[domain] = [...byTitle.values(), ...untitled]
      // Specific titles first (a generic index/hub ranks below a named page),
      // then by dwell — so an "AI Training Session" page opened for 12s still
      // reaches the evidence ahead of an "All Notes" hub idled on for 649s.
      .sort((a, b) => {
        const aGeneric = isGenericIndexTitle(a.title) ? 1 : 0
        const bGeneric = isGenericIndexTitle(b.title) ? 1 : 0
        if (aGeneric !== bGeneric) return aGeneric - bGeneric
        return b.totalSeconds - a.totalSeconds
      })
      .slice(0, limitPerDomain)
  }

  return byDomain
}

export interface ReconciledPageVisit {
  visit: WebsiteVisitRecord
  // Same semantics as ReconciledVisitCredit.freeIntervals above: the slices
  // of this visit that survived reconciliation against its browser's actual
  // foreground time. Empty means the visit never reached the foreground (or
  // an honest capture gap) inside the requested range at all.
  freeIntervals: { start: number; end: number }[]
}

// Public, camelCase wrapper around reconcileWebsiteVisits for callers
// outside this module that need per-visit evidence (not a domain/page
// aggregate) - e.g. the timeline engine's block-evidence builder, which
// must not let a background-accrued visit become a page artifact for a
// block it never actually appeared in front during (spec: timeline.md
// S3.0, invariant 6).
export function getReconciledWebsiteVisitsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): ReconciledPageVisit[] {
  return reconcileWebsiteVisits(db, fromMs, toMs).map(({ visit, freeIntervals }) => ({
    visit: {
      id: visit.id,
      domain: visit.domain,
      pageTitle: visit.page_title,
      url: visit.url,
      normalizedUrl: visit.normalized_url,
      pageKey: visit.page_key,
      visitTime: visit.visit_time,
      durationSec: visit.duration_sec,
      browserBundleId: visit.browser_bundle_id,
      canonicalBrowserId: visit.canonical_browser_id,
    },
    freeIntervals,
  }))
}

export interface DomainCreditInterval {
  domain: string
  start: number
  end: number
  visitId: number
}

// Reconciled per-domain credited time slices for a range, from the SAME
// per-visit ledger every other surface reads (invariant 7). Consumers that
// used to run raw SUM(duration_sec) over website_visits double-counted the
// two capture sources and counted background-tab history estimates as real
// time; this hands them only the seconds that survived reconciliation.
// Chunked internally by 24h windows so multi-month ranges stay bounded; a
// visit straddling a chunk boundary is clipped per chunk, so its slices stay
// disjoint by construction.
export function getReconciledDomainIntervals(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  domainFilter?: (domain: string) => boolean,
): DomainCreditInterval[] {
  const DAY_MS = 24 * 60 * 60 * 1000
  const out: DomainCreditInterval[] = []
  for (let chunkStart = fromMs; chunkStart < toMs; chunkStart += DAY_MS) {
    const chunkEnd = Math.min(chunkStart + DAY_MS, toMs)
    for (const { visit, freeIntervals } of reconcileWebsiteVisits(db, chunkStart, chunkEnd)) {
      if (!visit.domain) continue
      if (domainFilter && !domainFilter(visit.domain)) continue
      for (const interval of freeIntervals) {
        const start = Math.max(interval.start, chunkStart)
        const end = Math.min(interval.end, chunkEnd)
        if (end > start) out.push({ domain: visit.domain, start, end, visitId: visit.id })
      }
    }
  }
  return out
}

export interface WebsiteVisitRecord {
  id: number
  domain: string
  pageTitle: string | null
  url: string | null
  normalizedUrl: string | null
  pageKey: string | null
  visitTime: number
  durationSec: number
  browserBundleId: string | null
  canonicalBrowserId: string | null
}

export function getWebsiteVisitsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): WebsiteVisitRecord[] {
  return db.prepare(`
    SELECT
      id,
      domain,
      page_title AS pageTitle,
      url,
      normalized_url AS normalizedUrl,
      page_key AS pageKey,
      visit_time AS visitTime,
      duration_sec AS durationSec,
      browser_bundle_id AS browserBundleId,
      canonical_browser_id AS canonicalBrowserId
    FROM website_visits
    WHERE visit_time >= ? AND visit_time < ?
    ORDER BY visit_time ASC
  `).all(fromMs, toMs) as WebsiteVisitRecord[]
}

export interface ActivityStateEventRecord {
  id: number
  eventTs: number
  eventType: string
  source: string
  metadataJson: string
}

export function recordActivityStateEvent(
  db: Database.Database,
  payload: {
    eventTs: number
    eventType: string
    source: string
    metadata?: Record<string, unknown>
  },
): number {
  const result = db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, ?, ?, ?)
  `).run(
    payload.eventTs,
    payload.eventType,
    payload.source,
    JSON.stringify(payload.metadata ?? {}),
  )
  return result.lastInsertRowid as number
}

export function getActivityStateEventsForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): ActivityStateEventRecord[] {
  return db.prepare(`
    SELECT
      id,
      event_ts AS eventTs,
      event_type AS eventType,
      source,
      metadata_json AS metadataJson
    FROM activity_state_events
    WHERE event_ts >= ? AND event_ts < ?
    ORDER BY event_ts ASC
  `).all(fromMs, toMs) as ActivityStateEventRecord[]
}

export function setBlockLabelOverride(
  db: Database.Database,
  blockId: string,
  label: string,
  narrative: string | null = null,
): void {
  const trimmedLabel = label.trim()
  db.prepare(`
    INSERT INTO block_label_overrides (block_id, label, narrative, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(block_id) DO UPDATE SET
      label = excluded.label,
      narrative = excluded.narrative,
      updated_at = excluded.updated_at
  `).run(blockId, trimmedLabel, narrative, Date.now())
  learnFromBlockOverride(db, blockId, trimmedLabel)
}

export function clearBlockLabelOverride(
  db: Database.Database,
  blockId: string,
): void {
  db.prepare(`DELETE FROM block_label_overrides WHERE block_id = ?`).run(blockId)
  db.prepare(`DELETE FROM timeline_block_labels WHERE block_id = ? AND source = 'user'`).run(blockId)
  db.prepare(`
    UPDATE timeline_block_reviews
    SET review_state = 'pending',
        correction_json = '{}',
        updated_at = ?
    WHERE block_id = ?
  `).run(Date.now(), blockId)
}

// Single source of truth for persisting an AI block label, shared by the
// day-level "Re-analyze with AI" path and the per-block "Regenerate label"
// path so both write identically.
//   - force = false: preserve a user override (no-op if one exists).
//   - force = true:  the user explicitly asked to redo this block, so drop any
//     override and write unconditionally.
// Returns true if a row was written.
export function writeAIBlockLabel(
  db: Database.Database,
  params: {
    blockId: string
    label: string
    narrative?: string | null
    confidence?: number
    force?: boolean
  },
): boolean {
  const label = params.label.trim()
  if (!label) return false
  const narrative = params.narrative ?? null
  const confidence = params.confidence ?? 0.72
  const now = Date.now()

  if (params.force) {
    clearBlockLabelOverride(db, params.blockId)
  }

  const overrideGuard = params.force
    ? ''
    : 'AND NOT EXISTS (SELECT 1 FROM block_label_overrides WHERE block_id = ?)'
  const bindings: (string | number | null)[] = params.force
    ? [label, confidence, narrative, now, params.blockId]
    : [label, confidence, narrative, now, params.blockId, params.blockId]

  const result = db.prepare(`
    UPDATE timeline_blocks
    SET label_current = ?,
        label_source = 'ai',
        label_confidence = ?,
        narrative_current = ?,
        computed_at = ?
    WHERE id = ?
      ${overrideGuard}
  `).run(...bindings)

  if (result.changes === 0) return false

  const labelHash = crypto.createHash('sha1').update(label).digest('hex').slice(0, 8)
  db.prepare(`
    INSERT OR REPLACE INTO timeline_block_labels (
      id,
      block_id,
      label,
      narrative,
      source,
      confidence,
      created_at,
      model_info_json
    )
    VALUES (?, ?, ?, ?, 'ai', ?, ?, ?)
  `).run(`${params.blockId}:ai:${labelHash}`, params.blockId, label, narrative, confidence, now, null)

  return true
}

export function getBlockLabelOverride(
  db: Database.Database,
  blockId: string,
): { label: string; narrative: string | null; updatedAt: number } | null {
  const row = db.prepare(`
    SELECT label, narrative, updated_at AS updatedAt
    FROM block_label_overrides
    WHERE block_id = ?
    LIMIT 1
  `).get(blockId) as { label: string; narrative: string | null; updatedAt: number } | undefined

  return row ?? null
}

export function getRecentFocusSessions(
  db: Database.Database,
  limit = 20,
): FocusSession[] {
  const rows = db
    .prepare<number>(`
      SELECT * FROM focus_sessions
      WHERE end_time IS NOT NULL
      ORDER BY start_time DESC
      LIMIT ?
    `)
    .all(limit) as FocusSessionRow[]
  return rows.map(mapFocusSessionRow)
}

export function getFocusSessionsForDateRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): FocusSession[] {
  const rows = db
    .prepare<[number, number]>(`
      SELECT * FROM focus_sessions
      WHERE end_time IS NOT NULL AND start_time >= ? AND start_time < ?
      ORDER BY start_time DESC
    `)
    .all(fromMs, toMs) as FocusSessionRow[]
  return rows.map(mapFocusSessionRow)
}

function parseStoredWorkContextObservation(raw: string | null | undefined): WorkContextInsight | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as {
      kind?: unknown
      label?: unknown
      narrative?: unknown
    }
    if (parsed.kind !== 'blockInsight') return null

    const label = typeof parsed.label === 'string' ? parsed.label.trim() : null
    const narrative = typeof parsed.narrative === 'string' ? parsed.narrative.trim() : null
    if (!label && !narrative) return null

    return { label, narrative }
  } catch {
    return null
  }
}

export function getWorkContextInsightForRange(
  db: Database.Database,
  startMs: number,
  endMs: number,
): WorkContextInsight | null {
  const row = db
    .prepare<[number, number]>(`
      SELECT observation
      FROM work_context_observations
      WHERE start_ts = ? AND end_ts = ?
      LIMIT 1
    `)
    .get(startMs, endMs) as { observation: string } | undefined

  return parseStoredWorkContextObservation(row?.observation)
}

export function upsertWorkContextInsight(
  db: Database.Database,
  payload: {
    startMs: number
    endMs: number
    insight: WorkContextInsight
    sourceBlockIds?: string[]
  },
): void {
  const label = payload.insight.label?.trim() || null
  const narrative = payload.insight.narrative?.trim() || null
  if (!label && !narrative) return

  const observation = JSON.stringify({
    kind: 'blockInsight',
    label,
    narrative,
  })

  db.prepare(`
    INSERT INTO work_context_observations (start_ts, end_ts, observation, source_block_ids)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(start_ts, end_ts) DO UPDATE SET
      observation = excluded.observation,
      source_block_ids = excluded.source_block_ids
  `).run(
    payload.startMs,
    payload.endMs,
    observation,
    JSON.stringify(payload.sourceBlockIds ?? []),
  )
}

// The distraction rollups previously ran raw SUM(duration_sec) over
// website_visits, which double-counts the two capture sources and counts
// background-tab history estimates as real minutes. All three now bucket the
// reconciled per-domain credits instead, so "cost of distraction" agrees with
// the foreground time every other surface shows (invariant 7).
function distractionCreditIntervals(
  db: Database.Database,
  domains: string[],
  fromMs: number,
): DomainCreditInterval[] {
  const wanted = new Set(domains)
  return getReconciledDomainIntervals(db, fromMs, Date.now(), (domain) => wanted.has(domain))
}

export function getDistractionByMonth(
  db: Database.Database,
  domains: string[],
  fromMs: number,
): { month: string; totalSeconds: number }[] {
  if (domains.length === 0) return []
  const byMonth = new Map<string, number>()
  for (const interval of distractionCreditIntervals(db, domains, fromMs)) {
    const date = new Date(interval.start)
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    byMonth.set(month, (byMonth.get(month) ?? 0) + (interval.end - interval.start) / 1000)
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, totalSeconds]) => ({ month, totalSeconds: Math.round(totalSeconds) }))
}

export function getDistractionByHour(
  db: Database.Database,
  domains: string[],
  fromMs: number,
): { hour: number; totalSeconds: number }[] {
  if (domains.length === 0) return []
  const byHour = new Map<number, number>()
  for (const interval of distractionCreditIntervals(db, domains, fromMs)) {
    const hour = new Date(interval.start).getHours()
    byHour.set(hour, (byHour.get(hour) ?? 0) + (interval.end - interval.start) / 1000)
  }
  return [...byHour.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, totalSeconds]) => ({ hour, totalSeconds: Math.round(totalSeconds) }))
}

export function getDistractionByDomain(
  db: Database.Database,
  domains: string[],
  fromMs: number,
): { domain: string; totalSeconds: number }[] {
  if (domains.length === 0) return []
  const byDomain = new Map<string, number>()
  for (const interval of distractionCreditIntervals(db, domains, fromMs)) {
    byDomain.set(interval.domain, (byDomain.get(interval.domain) ?? 0) + (interval.end - interval.start) / 1000)
  }
  return [...byDomain.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([domain, totalSeconds]) => ({ domain, totalSeconds: Math.round(totalSeconds) }))
}

export function getDaysTracked(
  db: Database.Database,
  fromMs: number,
): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT date(datetime(start_time / 1000, 'unixepoch', 'localtime'))) AS day_count
    FROM app_sessions
    WHERE start_time >= ?
  `).get(fromMs) as { day_count: number }
  return row?.day_count ?? 0
}

// ─── Frozen daily snapshots ─────────────────────────────

interface DaySnapshotRow {
  facts_json: string
  facts_hash: string
  finalized_at: number
}

export function getDaySnapshotRow(db: Database.Database, date: string): DaySnapshot | null {
  const row = db.prepare(`SELECT facts_json, facts_hash, finalized_at FROM day_snapshots WHERE date = ?`).get(date) as DaySnapshotRow | undefined
  if (!row) return null
  return parseSnapshotRow(row)
}

export function getDaySnapshotRowsForRange(db: Database.Database, startDate: string, endDate: string): DaySnapshot[] {
  const rows = db.prepare(
    `SELECT facts_json, facts_hash, finalized_at FROM day_snapshots WHERE date >= ? AND date <= ? ORDER BY date ASC`,
  ).all(startDate, endDate) as DaySnapshotRow[]
  return rows.map(parseSnapshotRow).filter((s): s is DaySnapshot => s != null)
}

function parseSnapshotRow(row: DaySnapshotRow): DaySnapshot | null {
  try {
    const facts = JSON.parse(row.facts_json) as DaySnapshot
    // The persisted hash / finalized_at are authoritative over the blob copy.
    return { ...facts, factsHash: row.facts_hash, finalizedAt: row.finalized_at }
  } catch {
    return null
  }
}

export function upsertDaySnapshot(db: Database.Database, snapshot: DaySnapshot): void {
  db.prepare(`
    INSERT INTO day_snapshots (date, total_active, work_sec, leisure_sec, personal_sec, facts_json, facts_hash, finalized_at)
    VALUES (@date, @total, @work, @leisure, @personal, @json, @hash, @finalizedAt)
    ON CONFLICT(date) DO UPDATE SET
      total_active = excluded.total_active,
      work_sec     = excluded.work_sec,
      leisure_sec  = excluded.leisure_sec,
      personal_sec = excluded.personal_sec,
      facts_json   = excluded.facts_json,
      facts_hash   = excluded.facts_hash,
      finalized_at = excluded.finalized_at
  `).run({
    date: snapshot.date,
    total: snapshot.totalActiveSeconds,
    work: snapshot.kind.work,
    leisure: snapshot.kind.leisure,
    personal: snapshot.kind.personal,
    json: JSON.stringify(snapshot),
    hash: snapshot.factsHash,
    finalizedAt: snapshot.finalizedAt,
  })
}
