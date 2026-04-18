import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { capture, captureException } from './analytics'
import { SCHEMA_SQL } from '../db/schema'
import { runMigrations } from '../db/migrations'
import { repairStoredAppIdentityObservations } from '../core/inference/appIdentityRegistry'
import { repairStoredIdentityColumns, syncDerivedStateMetadata } from '../core/projections/metadata'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialised — call initDb() first')
  return _db
}

export function initDb(): void {
  const dbPath = path.join(app.getPath('userData'), 'daylens.sqlite')
  let stage = 'open'

  try {
    _db = new Database(dbPath)

    stage = 'pragma'
    // WAL mode for concurrent reads during tracking flushes
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')

    stage = 'schema'
    // Apply schema (all CREATE TABLE IF NOT EXISTS — safe to run every launch)
    _db.exec(SCHEMA_SQL)

    stage = 'migrations'
    // Run versioned migrations (adds daily_summaries, etc.)
    runMigrations()

    stage = 'metadata_sync'
    // Synchronize versioned derived-state metadata and repair older local DBs
    // whose schema drifted before the formal metadata layer existed.
    syncDerivedStateMetadata(_db)
    repairStoredIdentityColumns(_db)
    repairStoredAppIdentityObservations(_db)

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
}
