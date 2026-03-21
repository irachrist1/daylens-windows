import { getDb } from '../services/database'

/**
 * Daily summary computation and persistence.
 * Runs at end of day and on-demand to pre-compute aggregate metrics.
 */

interface DailySummaryRow {
  date: string
  total_active_sec: number
  focus_sec: number
  app_count: number
  domain_count: number
  session_count: number
  context_switches: number
  focus_score: number
  top_app_bundle_id: string | null
  top_domain: string | null
  ai_summary: string | null
  computed_at: number
}

/**
 * Compute and persist daily summary for a given date (YYYY-MM-DD).
 */
export function computeDailySummary(dateStr: string): void {
  const db = getDb()

  // Date boundaries (midnight UTC)
  const dayStart = new Date(dateStr + 'T00:00:00').getTime()
  const dayEnd = dayStart + 86400_000

  // App session aggregates
  const appAgg = db
    .prepare(
      `SELECT
        COUNT(DISTINCT bundle_id) as app_count,
        COUNT(*) as session_count,
        COALESCE(SUM(duration_sec), 0) as total_sec,
        COALESCE(SUM(CASE WHEN is_focused = 1 THEN duration_sec ELSE 0 END), 0) as focus_sec
      FROM app_sessions
      WHERE start_time >= ? AND start_time < ?
        AND duration_sec >= 10`
    )
    .get(dayStart, dayEnd) as {
    app_count: number
    session_count: number
    total_sec: number
    focus_sec: number
  }

  // Context switches (count of distinct consecutive app changes)
  const sessions = db
    .prepare(
      `SELECT bundle_id FROM app_sessions
       WHERE start_time >= ? AND start_time < ?
         AND duration_sec >= 10
       ORDER BY start_time`
    )
    .all(dayStart, dayEnd) as { bundle_id: string }[]

  let switches = 0
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].bundle_id !== sessions[i - 1].bundle_id) {
      switches++
    }
  }

  // Top app
  const topApp = db
    .prepare(
      `SELECT bundle_id, SUM(duration_sec) as total
       FROM app_sessions
       WHERE start_time >= ? AND start_time < ?
         AND duration_sec >= 10
       GROUP BY bundle_id
       ORDER BY total DESC
       LIMIT 1`
    )
    .get(dayStart, dayEnd) as { bundle_id: string; total: number } | undefined

  // Domain count and top domain
  const domainAgg = db
    .prepare(
      `SELECT COUNT(DISTINCT domain) as domain_count
       FROM website_visits
       WHERE visit_time >= ? AND visit_time < ?`
    )
    .get(dayStart, dayEnd) as { domain_count: number }

  const topDomain = db
    .prepare(
      `SELECT domain, SUM(duration_sec) as total
       FROM website_visits
       WHERE visit_time >= ? AND visit_time < ?
       GROUP BY domain
       ORDER BY total DESC
       LIMIT 1`
    )
    .get(dayStart, dayEnd) as { domain: string; total: number } | undefined

  // Focus score
  const totalSec = appAgg.total_sec
  const focusSec = appAgg.focus_sec
  const hours = totalSec / 3600
  const switchesPerHour = hours > 0 ? switches / hours : 0
  let focusScore = 0
  if (totalSec > 0) {
    const focusedRatio = focusSec / totalSec
    const penalty = Math.min(switchesPerHour / 300, 0.15)
    focusScore = Math.round(100 * focusedRatio * (1 - penalty))
  }

  // Upsert
  db.prepare(
    `INSERT INTO daily_summaries
       (date, total_active_sec, focus_sec, app_count, domain_count,
        session_count, context_switches, focus_score,
        top_app_bundle_id, top_domain, ai_summary, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(date) DO UPDATE SET
       total_active_sec = excluded.total_active_sec,
       focus_sec = excluded.focus_sec,
       app_count = excluded.app_count,
       domain_count = excluded.domain_count,
       session_count = excluded.session_count,
       context_switches = excluded.context_switches,
       focus_score = excluded.focus_score,
       top_app_bundle_id = excluded.top_app_bundle_id,
       top_domain = excluded.top_domain,
       computed_at = excluded.computed_at`
  ).run(
    dateStr,
    totalSec,
    focusSec,
    appAgg.app_count,
    domainAgg.domain_count,
    appAgg.session_count,
    switches,
    focusScore,
    topApp?.bundle_id ?? null,
    topDomain?.domain ?? null,
    Date.now()
  )
}

/**
 * Get daily summary for a specific date.
 */
export function getDailySummary(dateStr: string): DailySummaryRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM daily_summaries WHERE date = ?').get(dateStr) as
    | DailySummaryRow
    | undefined
}

/**
 * Compute summaries for all days that have session data but no summary.
 */
export function computeAllMissingSummaries(): void {
  const db = getDb()
  const dates = db
    .prepare(
      `SELECT DISTINCT date(start_time / 1000, 'unixepoch', 'localtime') as d
       FROM app_sessions
       WHERE d NOT IN (SELECT date FROM daily_summaries)
       ORDER BY d DESC
       LIMIT 60`
    )
    .all() as { d: string }[]

  for (const { d } of dates) {
    computeDailySummary(d)
  }
}
