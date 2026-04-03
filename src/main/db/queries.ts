// Raw better-sqlite3 queries — will be typed Drizzle functions in Phase 2a
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { FOCUSED_CATEGORIES } from '@shared/types'
import type {
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

// ─── App name normalization ────────────────────────────────────────────────────

function loadNormMap(): { aliases: Record<string, string>; catalog: Record<string, { displayName: string }> } {
  const candidates = [
    // Packaged build: extraResources unpacks the JSON next to the asar
    ...(typeof process !== 'undefined' && (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      ? [path.join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, 'app-normalization.v1.json')]
      : []),
    path.join(__dirname, '..', '..', 'shared', 'app-normalization.v1.json'),
    path.join(process.cwd(), 'shared', 'app-normalization.v1.json'),
  ]
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* try next */ }
  }
  return { aliases: {}, catalog: {} }
}
const normMap = loadNormMap()

function resolveDisplayName(bundleId: string, fallbackName: string): string {
  // Look up by bundle_id first (exact match), then by lowercased exe basename
  const exeBase = path.basename(bundleId).toLowerCase()
  const key = normMap.aliases[bundleId] ?? normMap.aliases[exeBase]
  return (key && normMap.catalog[key]?.displayName) || fallbackName
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
]

// Minimum session duration exposed to the UI (seconds).
// Sessions shorter than this are noise from brief app transitions.
const MIN_DISPLAY_SEC = 15
const SAME_APP_MERGE_GAP_MS = 15_000

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
  }
}

function mergeSessions(sessions: AppSession[]): AppSession[] {
  if (sessions.length <= 1) return sessions

  const merged: AppSession[] = [{ ...sessions[0] }]

  for (let i = 1; i < sessions.length; i++) {
    const curr = sessions[i]
    const last = merged[merged.length - 1]
    const gap = curr.startTime - appSessionEndTime(last)

    if (curr.bundleId === last.bundleId && gap <= SAME_APP_MERGE_GAP_MS) {
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

// ---------------------------------------------------------------------------
// App sessions
// ---------------------------------------------------------------------------

export function insertAppSession(
  db: Database.Database,
  session: Omit<AppSession, 'id'>,
): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused)
    VALUES (@bundleId, @appName, @startTime, @endTime, @durationSeconds, @category, @isFocused)
  `)
  const result = stmt.run({
    ...session,
    isFocused: session.isFocused ? 1 : 0,
  })
  return result.lastInsertRowid as number
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
        const category: AppCategory = overrides[row.bundle_id] ?? row.category ?? 'uncategorized'
        return clipRowToRange(row, fromMs, toMs, category)
      })
      .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)
  )

  const summaryMap = new Map<string, AppUsageSummary>()

  for (const session of clippedSessions) {
    const existing = summaryMap.get(session.bundleId)
    if (existing) {
      existing.totalSeconds += session.durationSeconds
      existing.sessionCount = (existing.sessionCount ?? 0) + 1
    } else {
      summaryMap.set(session.bundleId, {
        bundleId: session.bundleId,
        appName: resolveDisplayName(session.bundleId, session.appName),
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
        const category: AppCategory = overrides[row.bundle_id] ?? row.category
        return clipRowToRange(row, fromMs, toMs, category, resolveDisplayName(row.bundle_id, row.app_name))
      })
      .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)
  ).filter((session) => session.durationSeconds >= MIN_DISPLAY_SEC)
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

  const rows = db
    .prepare<[string, string]>(`
      SELECT date, total_active_sec, focus_sec, focus_score
      FROM daily_summaries
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC
    `)
    .all(startDateStr, endDateStr) as {
    date: string
    total_active_sec: number
    focus_sec: number
    focus_score: number
  }[]

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
): void {
  db.prepare(
    `INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`
  ).run(conversationId, role, content, Date.now())
}

export function getConversationMessages(
  db: Database.Database,
  conversationId: number,
): { role: 'user' | 'assistant'; content: string }[] {
  return db
    .prepare(
      `SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId) as { role: 'user' | 'assistant'; content: string }[]
}

export function clearConversation(db: Database.Database, conversationId: number): void {
  db.prepare(`DELETE FROM ai_messages WHERE conversation_id = ?`).run(conversationId)
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
  visitTime: number        // Unix ms
  visitTimeUs: bigint      // Microsecond timestamp from source browser (Chrome or Unix epoch µs)
  durationSec: number
  browserBundleId: string
  source: string
}

export function insertWebsiteVisit(
  db: Database.Database,
  visit: WebsiteVisitInsert,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO website_visits
      (domain, page_title, url, visit_time, visit_time_us, duration_sec, browser_bundle_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    visit.domain,
    visit.pageTitle,
    visit.url,
    visit.visitTime,
    visit.visitTimeUs,
    visit.durationSec,
    visit.browserBundleId,
    visit.source,
  )
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
             MIN(browser_bundle_id) AS browser_id
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
    }[]

  return rows.map((r) => ({
    domain:          r.domain,
    totalSeconds:    r.total_sec,
    visitCount:      r.visit_count,
    topTitle:        r.top_title,
    browserBundleId: r.browser_id,
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
