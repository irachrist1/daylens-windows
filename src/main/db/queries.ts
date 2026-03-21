// Raw better-sqlite3 queries — will be typed Drizzle functions in Phase 2a
import type Database from 'better-sqlite3'
import type { AppSession, AppUsageSummary, AppCategory, FocusSession, WebsiteSummary } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

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
  'cmux',       // tmux manager shim
  'node.js',    // Node.js runtime windows
]

// Minimum session duration exposed to the UI (seconds).
// Sessions shorter than this are noise from rapid app switches.
const MIN_DISPLAY_SEC = 15

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

function clipRowToRange(
  row: AppSessionRow,
  fromMs: number,
  toMs: number,
  category: AppCategory,
): AppSession | null {
  const clippedStart = Math.max(row.start_time, fromMs)
  const clippedEnd = Math.min(sessionEndTime(row), toMs)
  if (clippedEnd <= clippedStart) return null

  return {
    id: row.id,
    bundleId: row.bundle_id,
    appName: row.app_name,
    startTime: clippedStart,
    endTime: clippedEnd,
    durationSeconds: Math.max(1, Math.round((clippedEnd - clippedStart) / 1_000)),
    category,
    isFocused: FOCUSED_CATEGORIES.includes(category),
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
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused)
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

  const summaryMap = new Map<string, AppUsageSummary>()

  for (const row of rows) {
    if (isUxNoise(row.app_name)) continue

    const category: AppCategory = overrides[row.bundle_id] ?? row.category ?? 'uncategorized'
    const clipped = clipRowToRange(row, fromMs, toMs, category)
    if (!clipped) continue

    const existing = summaryMap.get(row.bundle_id)
    if (existing) {
      existing.totalSeconds += clipped.durationSeconds
      existing.sessionCount = (existing.sessionCount ?? 0) + 1
    } else {
      summaryMap.set(row.bundle_id, {
        bundleId: row.bundle_id,
        appName: row.app_name,
        category,
        totalSeconds: clipped.durationSeconds,
        isFocused: FOCUSED_CATEGORIES.includes(category),
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

  return rows
    .filter((r) => !isUxNoise(r.app_name))
    .map((r) => ({
      row: r,
      session: (() => {
      const category: AppCategory = overrides[r.bundle_id] ?? r.category
      return clipRowToRange(r, fromMs, toMs, category)
      })(),
    }))
    .filter((entry): entry is { row: AppSessionRow; session: AppSession } => {
      if (!entry.session) return false
      return entry.session.durationSeconds > 0 &&
        (entry.session.durationSeconds >= MIN_DISPLAY_SEC || entry.row.duration_sec >= MIN_DISPLAY_SEC)
    })
    .map((entry) => entry.session)
}

// ---------------------------------------------------------------------------
// Focus sessions
// ---------------------------------------------------------------------------

export function startFocusSession(db: Database.Database, label: string | null): number {
  const result = db
    .prepare(`INSERT INTO focus_sessions (start_time, label) VALUES (?, ?)`)
    .run(Date.now(), label)
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
    .get() as {
    id: number
    start_time: number
    end_time: number | null
    duration_sec: number
    label: string | null
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_sec,
    label: row.label,
  }
}

// ---------------------------------------------------------------------------
// Category overrides
// ---------------------------------------------------------------------------

function getCategoryOverrides(db: Database.Database): Record<string, AppCategory> {
  const rows = db
    .prepare(`SELECT bundle_id, category FROM category_overrides`)
    .all() as { bundle_id: string; category: AppCategory }[]
  return Object.fromEntries(rows.map((r) => [r.bundle_id, r.category]))
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
  const row = db
    .prepare(`SELECT messages FROM ai_conversations WHERE id = ?`)
    .get(conversationId) as { messages: string } | undefined
  if (!row) return
  const messages = JSON.parse(row.messages) as object[]
  messages.push({ role, content, timestamp: Date.now() })
  db.prepare(`UPDATE ai_conversations SET messages = ? WHERE id = ?`).run(
    JSON.stringify(messages),
    conversationId,
  )
}

export function getConversationMessages(
  db: Database.Database,
  conversationId: number,
): { role: 'user' | 'assistant'; content: string }[] {
  const row = db
    .prepare(`SELECT messages FROM ai_conversations WHERE id = ?`)
    .get(conversationId) as { messages: string } | undefined
  if (!row) return []
  return JSON.parse(row.messages) as { role: 'user' | 'assistant'; content: string }[]
}

export function clearConversation(db: Database.Database, conversationId: number): void {
  db.prepare(`UPDATE ai_conversations SET messages = '[]' WHERE id = ?`).run(conversationId)
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
      ORDER BY start_time DESC
    `)
    .all(bundleId, fromMs, toMs) as AppSessionRow[]

  return rows
    .filter((r) => !isUxNoise(r.app_name))
    .map((r) => {
      const category: AppCategory = overrides[r.bundle_id] ?? r.category
      return clipRowToRange(r, fromMs, toMs, category)
    })
    .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)
}

// Last N app sessions across all apps — for the debug panel.
// Column aliases map snake_case DB names to the camelCase TypeScript type.
export function getRecentAppSessions(
  db: Database.Database,
  limit = 5,
): { appName: string; category: string; durationSec: number; startTime: number }[] {
  return db
    .prepare<number>(`
      SELECT app_name   AS appName,
             category,
             duration_sec AS durationSec,
             start_time   AS startTime
      FROM app_sessions
      ORDER BY start_time DESC
      LIMIT ?
    `)
    .all(limit) as { appName: string; category: string; durationSec: number; startTime: number }[]
}

// ---------------------------------------------------------------------------
// Website visits
// ---------------------------------------------------------------------------

export interface WebsiteVisitInsert {
  domain: string
  pageTitle: string | null
  url: string
  visitTime: number        // Unix ms
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
      (domain, page_title, url, visit_time, duration_sec, browser_bundle_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    visit.domain,
    visit.pageTitle,
    visit.url,
    visit.visitTime,
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
    .all(limit) as {
    id: number
    start_time: number
    end_time: number
    duration_sec: number
    label: string | null
  }[]
  return rows.map((r) => ({
    id:              r.id,
    startTime:       r.start_time,
    endTime:         r.end_time,
    durationSeconds: r.duration_sec,
    label:           r.label,
  }))
}
