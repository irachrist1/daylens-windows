import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { capture, captureException } from './analytics'
import { SCHEMA_SQL } from '../db/schema'
import { runMigrations } from '../db/migrations'
import { ensureAIThreadSchema } from '../db/aiThreadSchema'
import { repairStoredAppIdentityObservations } from '../core/inference/appIdentityRegistry'
import { repairStoredIdentityColumns, syncDerivedStateMetadata } from '../core/projections/metadata'

let _db: Database.Database | null = null

// Cache of table names known to exist. `tableExists` is called on hot paths
// (per-block work-memory evidence, settings summaries, consolidation) where the
// repeated `SELECT name FROM sqlite_master` adds up. Positive results are cached
// for the lifetime of the connection; misses are re-queried so a table created
// later (migration, lazy schema) is still picked up.
const _knownTables = new Set<string>()

export function tableExists(db: Database.Database, tableName: string): boolean {
  if (_knownTables.has(tableName)) return true
  const row = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined
  if (row) {
    _knownTables.add(tableName)
    return true
  }
  return false
}

function primeTableCache(db: Database.Database): void {
  _knownTables.clear()
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  for (const row of rows) _knownTables.add(row.name)
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialised — call initDb() first')
  return _db
}

// Temporarily point getDb() at a specific handle for the duration of fn.
// Used by the deletion-journal replay, which runs against a freshly restored
// database BEFORE initDb() — the deletion services it re-runs all resolve
// their connection through getDb().
export function runWithDb<T>(db: Database.Database, fn: () => T): T {
  const previous = _db
  _db = db
  try {
    return fn()
  } finally {
    _db = previous
  }
}

export function initDb(): void {
  const dbPath = path.join(app.getPath('userData'), 'daylens.sqlite')
  let stage = 'open'

  try {
    _db = new Database(dbPath)

    stage = 'pragma'
    // On a brand-new database (no pages yet), enable incremental auto-vacuum
    // BEFORE the first table is created — it cannot be turned on later without
    // a full VACUUM. This lets the AI-telemetry retention job
    // (aiUsageRetention.ts) physically shrink the file after big prunes.
    // Existing DBs keep whatever mode they were created with; freed pages
    // there go to the freelist and are reused, which stops growth without a
    // blocking VACUUM.
    if ((_db.pragma('page_count', { simple: true }) as number) === 0) {
      _db.pragma('auto_vacuum = INCREMENTAL')
    }
    // WAL mode for concurrent reads during tracking flushes
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    // The real database is large (500MB+, growing). Tune for that scale:
    // - busy_timeout: wait out a tracking-flush write lock instead of throwing,
    //   which previously surfaced as UI stalls during capture.
    // - cache_size: negative = KiB; 64MB keeps hot pages (indexes, recent days)
    //   resident instead of re-reading from disk on every navigation.
    // - mmap_size: memory-map up to 512MB so reads avoid per-page read() syscalls.
    // - synchronous NORMAL: safe with WAL, fewer fsyncs on the write path.
    _db.pragma('busy_timeout = 5000')
    _db.pragma('cache_size = -65536')
    _db.pragma('mmap_size = 536870912')
    _db.pragma('synchronous = NORMAL')

    stage = 'schema'
    // Apply schema (all CREATE TABLE IF NOT EXISTS — safe to run every launch)
    _db.exec(SCHEMA_SQL)

    stage = 'migrations'
    // Run versioned migrations (adds daily_summaries, etc.)
    runMigrations()

    stage = 'schema_repair'
    // Repair additive schema drift that older local DBs may still carry even
    // when their recorded migration version says they are up to date.
    ensureAIThreadSchema(_db)

    stage = 'metadata_sync'
    // Synchronize versioned derived-state metadata and repair older local DBs
    // whose schema drifted before the formal metadata layer existed.
    syncDerivedStateMetadata(_db)
    // Deferred to a background macrotask to keep cold launch instantaneous (F1 & F2 optimization)
    setImmediate(() => {
      try {
        if (_db) {
          repairStoredIdentityColumns(_db)
          repairStoredAppIdentityObservations(_db)
          console.log('[db] background startup repairs completed')
        }
      } catch (err) {
        console.warn('[db] deferred repairs failed:', err)
      }
      // Heal stored block labels that today's work-name guards disqualify
      // ("Working on Cursor Agents", leisure headlines on work blocks). Runs
      // once per guard version (WORK_NAME_GUARD_VERSION stamp), in bounded
      // batches, and is safe to interrupt. Dynamic import: labelGuardRepair
      // pulls in the whole workBlocks module, which must not join the cold
      // launch path.
      if (_db) {
        const db = _db
        import('./labelGuardRepair')
          .then(({ runLabelGuardRepairIfNeeded }) => runLabelGuardRepairIfNeeded(db))
          .then((result) => {
            if (result.status === 'ran' && result.healedBlocks > 0) {
              console.log(
                `[db] label guard repair healed ${result.healedBlocks} block(s) `
                + `across ${result.affectedDates.length} day(s)`,
              )
            }
          })
          .catch((err) => console.warn('[db] label guard repair failed:', err))
      }
    })

    // Snapshot the table set after all schema/migration work so hot-path
    // `tableExists` calls resolve from memory.
    primeTableCache(_db)

    capture(ANALYTICS_EVENT.DATABASE_HEALTH, {
      stage,
      status: 'ok',
      surface: 'database',
    })
    console.log('[db] initialised at', dbPath)
  } catch (error) {
    capture(ANALYTICS_EVENT.DATABASE_INIT_FAILED, {
      failure_kind: classifyFailureKind(error),
      stage,
      status: 'error',
      surface: 'database',
    })
    captureException(error, {
      extra: { stage },
      tags: {
        process_type: 'main',
        reason: 'database_init_failed',
      },
    })
    throw error
  }
}

export function closeDb(): void {
  _db?.close()
  _db = null
  _knownTables.clear()
}
