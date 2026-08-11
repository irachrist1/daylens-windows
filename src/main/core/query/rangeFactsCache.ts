// Range-facts memo cache (DEV-227). At 30 days the corrected-activity range
// query costs ~1s of synchronous main-thread work on a real database, and one
// Apps-view interaction runs it several times back-to-back (list, detail,
// narrative). The facts are deterministic — same evidence + same corrections
// + same versions + same window ⇒ same facts — so instead of re-scanning, a
// hit re-checks a cheap evidence signature (~20ms of indexed aggregates) and
// returns the cached result when nothing changed.
//
// The signature covers every input the query reads:
//   - focus_events in the window (count + max ts + max id — deletes shift all)
//   - the correction ledger (timeline_block_reviews count + max updated_at,
//     evidence_exclusions count + max created_at; global on purpose —
//     corrections are rare and small, so any change flushes every window)
//   - legacy app_sessions in the window, when that table still exists
//   - the focusApps setting (feeds isFocused) and both query versions
//
// Windows that extend past "now" (a live day) additionally expire after a
// short TTL, because the trailing open session's clip point moves with the
// clock even when no new event arrives.
import type Database from 'better-sqlite3'

const MAX_ENTRIES = 4
const LIVE_WINDOW_TTL_MS = 10_000

interface CacheEntry<T> {
  signature: string
  computedAt: number
  extendsPastNow: boolean
  facts: T
}

const entries = new Map<string, CacheEntry<unknown>>()

// Two different Database handles (tests, the recovery path) can hold windows
// with identical timestamps and identical-looking evidence. The cache key
// carries a per-handle id so facts never cross database connections.
const dbIds = new WeakMap<Database.Database, number>()
let nextDbId = 1

export function rangeFactsCacheKeyForDb(db: Database.Database, rest: string): string {
  let id = dbIds.get(db)
  if (id === undefined) {
    id = nextDbId++
    dbIds.set(db, id)
  }
  return `${id}:${rest}`
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name))
}

export function computeRangeEvidenceSignature(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  versionTag: string,
  focusApps: readonly string[],
): string {
  const events = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(MAX(ts_ms), 0) AS t, COALESCE(MAX(id), 0) AS i
    FROM focus_events
    WHERE ts_ms >= ? AND ts_ms < ?
  `).get(fromMs, toMs) as { n: number; t: number; i: number }

  const reviews = tableExists(db, 'timeline_block_reviews')
    ? db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS u
        FROM timeline_block_reviews
      `).get() as { n: number; u: number }
    : { n: 0, u: 0 }

  const exclusions = tableExists(db, 'evidence_exclusions')
    ? db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(MAX(created_at), 0) AS u
        FROM evidence_exclusions
      `).get() as { n: number; u: number }
    : { n: 0, u: 0 }

  const legacy = tableExists(db, 'app_sessions')
    ? db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS i
        FROM app_sessions
        WHERE start_time >= ? AND start_time < ?
      `).get(fromMs, toMs) as { n: number; i: number }
    : { n: 0, i: 0 }

  return JSON.stringify([
    versionTag,
    readEvidenceEpoch(db),
    events.n, events.t, events.i,
    reviews.n, reviews.u,
    exclusions.n, exclusions.u,
    legacy.n, legacy.i,
    focusApps,
  ])
}

export function getCachedRangeFacts<T>(
  key: string,
  signature: string,
  nowMs: number,
): T | null {
  const entry = entries.get(key)
  if (!entry) return null
  if (entry.signature !== signature) {
    entries.delete(key)
    return null
  }
  if (entry.extendsPastNow && nowMs - entry.computedAt > LIVE_WINDOW_TTL_MS) {
    entries.delete(key)
    return null
  }
  // LRU: re-insert so the most recently hit entry survives longest.
  entries.delete(key)
  entries.set(key, entry)
  return entry.facts as T
}

export function storeCachedRangeFacts<T>(
  key: string,
  signature: string,
  nowMs: number,
  extendsPastNow: boolean,
  facts: T,
): void {
  entries.delete(key)
  entries.set(key, { signature, computedAt: nowMs, extendsPastNow, facts })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function clearRangeFactsCache(): void {
  entries.clear()
}

// ─── Evidence epoch ─────────────────────────────────────────────────────────
// The signature's count/max aggregates cannot see an in-place UPDATE of
// evidence rows (title purges, canonical-id restamps). Those writers bump
// this database-backed counter instead; it is folded into every signature,
// so caches in EVERY process (main and the range worker) invalidate at once.

const EVIDENCE_EPOCH_KEY = 'range_facts_evidence_epoch'

export function bumpRangeFactsEvidenceEpoch(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_runs (
      key TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO maintenance_runs (key, completed_at) VALUES (?, 1)
    ON CONFLICT(key) DO UPDATE SET completed_at = completed_at + 1
  `).run(EVIDENCE_EPOCH_KEY)
  clearRangeFactsCache()
}

function readEvidenceEpoch(db: Database.Database): number {
  if (!tableExists(db, 'maintenance_runs')) return 0
  const row = db.prepare(
    `SELECT completed_at FROM maintenance_runs WHERE key = ?`,
  ).get(EVIDENCE_EPOCH_KEY) as { completed_at: number } | undefined
  return row?.completed_at ?? 0
}
