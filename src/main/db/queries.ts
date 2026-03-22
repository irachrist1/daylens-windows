// Raw better-sqlite3 queries — will be typed Drizzle functions in Phase 2a
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AppSession, AppUsageSummary, AppCategory, FocusSession, WebsiteSummary } from '@shared/types'
import { isCategoryFocused } from '../lib/focusScore'

// ─── App name normalization ────────────────────────────────────────────────────

function loadNormMap(): { aliases: Record<string, string>; catalog: Record<string, { displayName: string }> } {
  const candidates = [
    path.join(__dirname, '..', '..', 'shared', 'app-normalization.v1.json'),
    path.join(process.cwd(), 'shared', 'app-normalization.v1.json'),
  ]
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* try next */ }
  }
  return { aliases: {}, catalog: {} }
}
const normMap = loadNormMap()

function resolveDisplayName(rawName: string): string {
  const key = normMap.aliases[rawName.toLowerCase()]
  return (key && normMap.catalog[key]?.displayName) || rawName
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
  'cmux',       // tmux manager shim
  'node.js',    // Node.js runtime windows
]

// Minimum session duration exposed to the UI (seconds).
// Sessions shorter than this are noise from rapid app switches.
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
        appName: resolveDisplayName(session.appName),
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
        return clipRowToRange(row, fromMs, toMs, category, resolveDisplayName(row.app_name))
      })
      .filter((session): session is AppSession => session !== null && session.durationSeconds > 0)
  ).filter((session) => session.durationSeconds >= MIN_DISPLAY_SEC)
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
      ORDER BY start_time ASC
    `)
    .all(bundleId, fromMs, toMs) as AppSessionRow[]

  const clipped = rows
    .filter((r) => !isUxNoise(r.app_name))
    .map((r) => {
      const category: AppCategory = overrides[r.bundle_id] ?? r.category
      return clipRowToRange(r, fromMs, toMs, category, resolveDisplayName(r.app_name))
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
      SELECT app_name   AS appName,
             category,
             duration_sec AS durationSec,
             start_time   AS startTime
      FROM app_sessions
      ORDER BY start_time DESC
      LIMIT ?
    `)
    .all(limit) as { appName: string; category: string; durationSec: number; startTime: number }[]
  return rows.map((r) => ({ ...r, appName: resolveDisplayName(r.appName) }))
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
