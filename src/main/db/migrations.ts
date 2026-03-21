import { getDb } from '../services/database'

/**
 * Versioned migration system for DaylensWindows.
 *
 * Each migration is a function that runs SQL statements.
 * Migrations are additive-only — never delete columns or tables.
 * Applied versions are tracked in a schema_version table.
 */

interface Migration {
  version: number
  description: string
  up: () => void
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Baseline schema — matches initial CREATE TABLE IF NOT EXISTS',
    up: () => {
      // Baseline: tables already created by SCHEMA_SQL.
      // This migration just records that v1 is applied.
    },
  },
  {
    version: 2,
    description: 'Add daily_summaries table',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_summaries (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          date              TEXT    NOT NULL UNIQUE,
          total_active_sec  INTEGER NOT NULL DEFAULT 0,
          focus_sec         INTEGER NOT NULL DEFAULT 0,
          app_count         INTEGER NOT NULL DEFAULT 0,
          domain_count      INTEGER NOT NULL DEFAULT 0,
          session_count     INTEGER NOT NULL DEFAULT 0,
          context_switches  INTEGER NOT NULL DEFAULT 0,
          focus_score       INTEGER NOT NULL DEFAULT 0,
          top_app_bundle_id TEXT,
          top_domain        TEXT,
          ai_summary        TEXT,
          computed_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries (date);
      `)
    },
  },
]

export function runMigrations(): void {
  const db = getDb()

  // Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  // Get current version
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as
    | { v: number | null }
    | undefined
  const currentVersion = row?.v ?? 0

  // Apply pending migrations
  const pending = migrations.filter((m) => m.version > currentVersion)
  if (pending.length === 0) {
    console.log('[migrations] schema up to date at v' + currentVersion)
    return
  }

  for (const migration of pending) {
    console.log(`[migrations] applying v${migration.version}: ${migration.description}`)
    const tx = db.transaction(() => {
      migration.up()
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now()
      )
    })
    tx()
  }

  console.log(`[migrations] migrated to v${pending[pending.length - 1].version}`)
}
