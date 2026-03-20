// Raw better-sqlite3 queries — will be typed Drizzle functions in Phase 2a
import type Database from 'better-sqlite3'
import type { AppSession, AppUsageSummary, AppCategory, FocusSession } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

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
      SELECT bundle_id, app_name, SUM(duration_sec) AS total_sec
      FROM app_sessions
      WHERE start_time >= ? AND start_time < ?
      GROUP BY bundle_id
      ORDER BY total_sec DESC
    `)
    .all(fromMs, toMs) as { bundle_id: string; app_name: string; total_sec: number }[]

  return rows.map((r) => {
    const category: AppCategory = overrides[r.bundle_id] ?? (r.bundle_id as AppCategory) ?? 'uncategorized'
    return {
      bundleId: r.bundle_id,
      appName: r.app_name,
      category,
      totalSeconds: r.total_sec,
      isFocused: FOCUSED_CATEGORIES.includes(category),
    }
  })
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
      WHERE start_time >= ? AND start_time < ?
      ORDER BY start_time ASC
    `)
    .all(fromMs, toMs) as {
    id: number
    bundle_id: string
    app_name: string
    start_time: number
    end_time: number | null
    duration_sec: number
    category: AppCategory
    is_focused: number
  }[]

  return rows.map((r) => {
    const category: AppCategory = overrides[r.bundle_id] ?? r.category
    return {
      id: r.id,
      bundleId: r.bundle_id,
      appName: r.app_name,
      startTime: r.start_time,
      endTime: r.end_time,
      durationSeconds: r.duration_sec,
      category,
      isFocused: FOCUSED_CATEGORIES.includes(category),
    }
  })
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
