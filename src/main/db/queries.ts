// Raw better-sqlite3 queries — will be typed Drizzle functions in Phase 2a
import type Database from 'better-sqlite3'
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
  FocusSession,
  FocusStartPayload,
  PeakHoursResult,
  WeeklySummary,
  WebsiteSummary,
  WorkContextInsight,
} from '@shared/types'
import { isCategoryFocused } from '../lib/focusScore'
import { localDayBounds } from '../lib/localDate'
import { resolveCanonicalApp } from '../lib/appIdentity'

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

// Minimum session duration exposed to the UI (seconds).
// Sessions shorter than this are noise from brief app transitions.
const MIN_DISPLAY_SEC = 15
const SAME_APP_MERGE_GAP_MS = 15_000
const LEGACY_WEAK_AI_LABELS = [
  'AI Tools',
  'Browsing',
  'Communication',
  'Design',
  'Development',
  'Email',
  'Insufficient Data',
  'Insufficient Data For Label',
  'Meetings',
  'Mixed Work',
  'Productivity',
  'Research',
  'Research & AI Chat',
  'System',
  'Uncategorized',
  'Web Session',
  'Writing',
]

function isUxNoise(appName: string): boolean {
  const lower = appName.toLowerCase()
  return UX_NOISE_SUBSTRINGS.some((s) => lower.includes(s))
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
  return row.end_time ?? (row.start_time + row.duration_sec * 1_000)
}

function appSessionEndTime(session: Pick<AppSession, 'startTime' | 'endTime' | 'durationSeconds'>): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1_000)
}

function clipRowToRange(
  row: AppSessionRow,
  fromMs: number,
  toMs: number,
  category: AppCategory,
  resolvedName?: string,
): AppSession | null {
  const clippedStart = Math.max(row.start_time, fromMs)
  const clippedEnd = Math.min(sessionEndTime(row), toMs)
  if (clippedEnd <= clippedStart) return null

  return {
    id: row.id,
    bundleId: row.bundle_id,
    appName: resolvedName ?? row.app_name,
    startTime: clippedStart,
    endTime: clippedEnd,
    durationSeconds: Math.max(1, Math.round((clippedEnd - clippedStart) / 1_000)),
    category,
    isFocused: isCategoryFocused(category),
    windowTitle: row.window_title ?? null,
    rawAppName: row.raw_app_name ?? row.app_name,
    canonicalAppId: row.canonical_app_id ?? null,
    appInstanceId: row.app_instance_id ?? row.bundle_id,
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

function toLocalDateKey(timestampMs: number): string {
  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftLocalDateString(dateStr: string, offsetDays: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return toLocalDateKey(new Date(year, month - 1, day + offsetDays).getTime())
}

function formatCategoryLabel(category: AppCategory): string {
  if (category === 'aiTools') return 'AI tools'
  return category
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
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
  return {
    fromMs: parseDateBound(opts.startDate, 'start') ?? 0,
    toMs: parseDateBound(opts.endDate, 'end') ?? Number.MAX_SAFE_INTEGER,
    limit: normalizedSearchLimit(opts.limit),
  }
}

function toFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .match(/"[^"]+"|\S+/g)
    ?.map((token) => token.replace(/^"|"$/g, '').replace(/"/g, '""').trim())
    .filter(Boolean) ?? []

  return tokens.map((token) => `"${token}"`).join(' AND ')
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
    artifacts: metadata.artifacts ?? [],
    rating,
    ratingUpdatedAt,
  }
}

// ---------------------------------------------------------------------------
// App sessions
// ---------------------------------------------------------------------------

export function insertAppSession(
  db: Database.Database,
  session: Omit<AppSession, 'id'>,
): number {
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
  return result.lastInsertRowid as number
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
    windowTitle: snapshot.windowTitle ?? null,
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
): AppUsageSummary[] {
  const overrides = getCategoryOverrides(db)

  const rows = db
    .prepare<[number, number]>(`
      SELECT *
      FROM app_sessions
      WHERE COALESCE(end_time, start_time + duration_sec * 1000) > ? AND start_time < ?
      ORDER BY start_time ASC
    `)
    .all(fromMs, toMs) as AppSessionRow[]

  const clippedSessions = mergeSessions(
    rows
      .filter((row) => !isUxNoise(row.app_name))
      .map((row) => {
        // User overrides first; fall through to catalog's default category for
        // sessions that were captured before the catalog was fully populated.
        const catalogCategory = resolveCanonicalApp(row.bundle_id, row.app_name).defaultCategory
        const category: AppCategory =
          overrides[row.bundle_id]
          ?? (row.category && row.category !== 'uncategorized' ? row.category : null)
          ?? catalogCategory
          ?? 'uncategorized'
        return clipRowToRange(row, fromMs, toMs, category)
      })
      .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)
  )

  const summaryMap = new Map<string, AppUsageSummary>()

  for (const session of clippedSessions) {
    const identity = resolveCanonicalApp(session.bundleId, session.appName)
    const mapKey = session.canonicalAppId ?? identity.canonicalAppId ?? session.bundleId
    const existing = summaryMap.get(mapKey)
    if (existing) {
      existing.totalSeconds += session.durationSeconds
      existing.sessionCount = (existing.sessionCount ?? 0) + 1
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
): AppSession[] {
  const overrides = getCategoryOverrides(db)

  const rows = db
    .prepare<[number, number]>(`
      SELECT * FROM app_sessions
      WHERE COALESCE(end_time, start_time + duration_sec * 1000) > ? AND start_time < ?
      ORDER BY start_time ASC
    `)
    .all(fromMs, toMs) as AppSessionRow[]

  return mergeSessions(
    rows
      .filter((row) => !isUxNoise(row.app_name))
      .map((row) => {
        const catalogCategory = resolveCanonicalApp(row.bundle_id, row.app_name).defaultCategory
        const category: AppCategory =
          overrides[row.bundle_id]
          ?? (row.category && row.category !== 'uncategorized' ? row.category : null)
          ?? catalogCategory
          ?? 'uncategorized'
        return clipRowToRange(row, fromMs, toMs, category, resolveDisplayName(row.bundle_id, row.app_name))
      })
      .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)
  ).filter((session) => session.durationSeconds >= MIN_DISPLAY_SEC)
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
    date: toLocalDateKey(row.start_time),
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

  const rows = db.prepare(`
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
    date: toLocalDateKey(row.visit_time),
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
    date: toLocalDateKey(row.created_at),
    excerpt: row.excerpt ?? row.title,
  }))
}

export function searchAll(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  const limit = normalizedSearchLimit(opts.limit)
  return [
    ...searchSessions(db, query, { ...opts, limit }),
    ...searchBlocks(db, query, { ...opts, limit }),
    ...searchBrowser(db, query, { ...opts, limit }),
    ...searchArtifacts(db, query, { ...opts, limit }),
  ]
    .sort((left, right) => right.startTime - left.startTime)
    .slice(0, limit)
}

export function getHourlyBreakdown(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): { hour: number; totalSeconds: number; focusSeconds: number }[] {
  const focusedCategoryPlaceholders = FOCUSED_CATEGORIES.map(() => '?').join(', ')
  const noiseFilters = UX_NOISE_SUBSTRINGS.map(() => 'LOWER(app_sessions.app_name) NOT LIKE ?').join(' AND ')
  const rows = db
    .prepare(`
      SELECT
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
      GROUP BY hour
      ORDER BY hour ASC
    `)
    .all(
      ...FOCUSED_CATEGORIES,
      fromMs,
      toMs,
      ...UX_NOISE_SUBSTRINGS.map((substring) => `%${substring}%`),
    ) as { hour: number; total_seconds: number; focus_seconds: number }[]

  const breakdown = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    totalSeconds: 0,
    focusSeconds: 0,
  }))

  for (const row of rows) {
    breakdown[row.hour] = {
      hour: row.hour,
      totalSeconds: row.total_seconds ?? 0,
      focusSeconds: row.focus_seconds ?? 0,
    }
  }

  return breakdown
}

export function getPeakHours(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): PeakHoursResult | null {
  const dayRows = db
    .prepare<[number, number]>(`
      SELECT start_time, app_name
      FROM app_sessions
      WHERE start_time >= ? AND start_time < ?
      ORDER BY start_time ASC
    `)
    .all(fromMs, toMs) as { start_time: number; app_name: string }[]

  const distinctDays = new Set(
    dayRows
      .filter((row) => !isUxNoise(row.app_name))
      .map((row) => toLocalDateKey(row.start_time)),
  )
  if (distinctDays.size < 3) return null

  const hourlyBreakdown = getHourlyBreakdown(db, fromMs, toMs)
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
    total_seconds: number
  }[]

  return {
    totalTrackedSeconds,
    totalFocusSeconds,
    focusPct,
    avgFocusScore,
    bestDay: bestDayRow,
    mostActiveDay: mostActiveDayRow,
    topApps: topAppRows.map((row) => ({
      appName: resolveDisplayName(row.bundle_id, row.app_name),
      bundleId: row.bundle_id,
      totalSeconds: Math.round(row.total_seconds),
      category: row.category,
    })),
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

export function getCategoryOverrides(db: Database.Database): Record<string, AppCategory> {
  const rows = db
    .prepare(`SELECT bundle_id, category FROM category_overrides`)
    .all() as { bundle_id: string; category: AppCategory }[]
  return Object.fromEntries(rows.map((r) => [r.bundle_id, r.category]))
}

export function clearCategoryOverride(db: Database.Database, bundleId: string): void {
  db.prepare(`DELETE FROM category_overrides WHERE bundle_id = ?`).run(bundleId)
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
    artifacts: metadata?.artifacts ?? [],
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
        cache_hit = ?
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
    .prepare<[string, number, number]>(`
      SELECT * FROM app_sessions
      WHERE bundle_id = ? AND COALESCE(end_time, start_time + duration_sec * 1000) > ? AND start_time < ?
      ORDER BY start_time ASC
    `)
    .all(bundleId, fromMs, toMs) as AppSessionRow[]

  const clipped = rows
    .filter((r) => !isUxNoise(r.app_name))
    .map((r) => {
      const category: AppCategory = overrides[r.bundle_id] ?? r.category
      return clipRowToRange(r, fromMs, toMs, category, resolveDisplayName(r.bundle_id, r.app_name))
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
    visit.url,
    visit.visitTime,
    visit.visitTimeUs,
    visit.durationSec,
    visit.browserBundleId,
    visit.canonicalBrowserId,
    visit.browserProfileId,
    visit.normalizedUrl,
    visit.pageKey,
    visit.source,
  )
  return result.changes > 0
}

export function getWebsiteSummariesForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  browserBundleId?: string,
): WebsiteSummary[] {
  const whereExtra = browserBundleId ? ' AND browser_bundle_id = ?' : ''
  const params: (number | string)[] = browserBundleId
    ? [fromMs, toMs, browserBundleId]
    : [fromMs, toMs]

  const rows = db
    .prepare(`
      SELECT domain,
             SUM(duration_sec)  AS total_sec,
             COUNT(*)           AS visit_count,
             MAX(page_title)    AS top_title,
             MIN(browser_bundle_id) AS browser_id,
             MIN(canonical_browser_id) AS canonical_browser_id
      FROM website_visits
      WHERE visit_time >= ? AND visit_time < ?${whereExtra}
      GROUP BY domain
      ORDER BY total_sec DESC, visit_count DESC
      LIMIT 20
    `)
    .all(...params) as {
      domain: string
      total_sec: number
      visit_count: number
      top_title: string | null
      browser_id: string | null
      canonical_browser_id: string | null
    }[]

  return rows.map((r) => ({
    domain:          r.domain,
    totalSeconds:    r.total_sec,
    visitCount:      r.visit_count,
    topTitle:        r.top_title,
    browserBundleId: r.browser_id,
    canonicalBrowserId: r.canonical_browser_id,
  }))
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

  const placeholders = domains.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT domain,
             url,
             MAX(page_title)   AS title,
             SUM(duration_sec) AS total_sec
      FROM website_visits
      WHERE visit_time >= ? AND visit_time < ?
        AND domain IN (${placeholders})
      GROUP BY domain, url
      ORDER BY domain ASC, total_sec DESC
    `)
    .all(fromMs, toMs, ...domains) as {
      domain: string
      url: string
      title: string | null
      total_sec: number
    }[]

  return rows.reduce<Record<string, { url: string; title: string | null; totalSeconds: number }[]>>(
    (grouped, row) => {
      const bucket = grouped[row.domain] ?? []
      if (bucket.length < limitPerDomain) {
        bucket.push({
          url: row.url,
          title: row.title,
          totalSeconds: row.total_sec,
        })
      }
      grouped[row.domain] = bucket
      return grouped
    },
    {},
  )
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
  db.prepare(`
    INSERT INTO block_label_overrides (block_id, label, narrative, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(block_id) DO UPDATE SET
      label = excluded.label,
      narrative = excluded.narrative,
      updated_at = excluded.updated_at
  `).run(blockId, label, narrative, Date.now())
}

export function clearBlockLabelOverride(
  db: Database.Database,
  blockId: string,
): void {
  db.prepare(`DELETE FROM block_label_overrides WHERE block_id = ?`).run(blockId)
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

export function upsertWorkContextCleanupReview(
  db: Database.Database,
  payload: {
    startMs: number
    endMs: number
    stableLabel?: string | null
    sourceBlockIds?: string[]
  },
): void {
  const stableLabel = payload.stableLabel?.trim() || null
  const observation = JSON.stringify({
    kind: 'blockCleanupReview',
    stableLabel,
    reviewedAt: Date.now(),
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

export function listPendingWorkContextCleanupDates(
  db: Database.Database,
  anchorDate: string,
): string[] {
  const [, anchorDayEndMs] = localDayBounds(anchorDate)
  const weakAiPlaceholders = LEGACY_WEAK_AI_LABELS.map(() => '?').join(', ')
  const rows = db.prepare(`
    WITH pending_persisted_dates AS (
      SELECT DISTINCT timeline_blocks.date AS date
      FROM timeline_blocks
      LEFT JOIN block_label_overrides
        ON block_label_overrides.block_id = timeline_blocks.id
      LEFT JOIN work_context_observations
        ON work_context_observations.start_ts = timeline_blocks.start_time
        AND work_context_observations.end_ts = timeline_blocks.end_time
      WHERE timeline_blocks.invalidated_at IS NULL
        AND timeline_blocks.is_live = 0
        AND timeline_blocks.date <= ?
        AND block_label_overrides.block_id IS NULL
        AND work_context_observations.id IS NULL
    ),
    pending_legacy_ai_dates AS (
      SELECT DISTINCT timeline_blocks.date AS date
      FROM timeline_blocks
      LEFT JOIN block_label_overrides
        ON block_label_overrides.block_id = timeline_blocks.id
      JOIN work_context_observations
        ON work_context_observations.start_ts = timeline_blocks.start_time
        AND work_context_observations.end_ts = timeline_blocks.end_time
      WHERE timeline_blocks.invalidated_at IS NULL
        AND timeline_blocks.is_live = 0
        AND timeline_blocks.date <= ?
        AND block_label_overrides.block_id IS NULL
        AND json_extract(work_context_observations.observation, '$.kind') = 'blockInsight'
        AND trim(COALESCE(json_extract(work_context_observations.observation, '$.label'), '')) IN (${weakAiPlaceholders})
    ),
    pending_unpersisted_dates AS (
      SELECT DISTINCT strftime('%Y-%m-%d', app_sessions.start_time / 1000, 'unixepoch', 'localtime') AS date
      FROM app_sessions
      WHERE app_sessions.start_time < ?
        AND NOT EXISTS (
          SELECT 1
          FROM timeline_blocks
          WHERE timeline_blocks.date = strftime('%Y-%m-%d', app_sessions.start_time / 1000, 'unixepoch', 'localtime')
            AND timeline_blocks.invalidated_at IS NULL
        )
    )
    SELECT date
    FROM pending_persisted_dates
    UNION
    SELECT date
    FROM pending_legacy_ai_dates
    UNION
    SELECT date
    FROM pending_unpersisted_dates
    ORDER BY date ASC
  `).all(anchorDate, anchorDate, ...LEGACY_WEAK_AI_LABELS, anchorDayEndMs) as Array<{ date: string }>

  return rows.map((row) => row.date)
}
