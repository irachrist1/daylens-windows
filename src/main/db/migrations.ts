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

function hasColumn(table: string, column: string): boolean {
  const db = getDb()
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

function getTableSql(table: string): string | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined
  return row?.sql ?? null
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
  {
    version: 3,
    description: 'Deduplicate app_sessions and add unique index for idempotent inserts',
    up: () => {
      const db = getDb()
      // Remove any exact duplicates (same bundle_id + start_time) keeping the lowest rowid
      db.exec(`
        DELETE FROM app_sessions
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM app_sessions GROUP BY bundle_id, start_time
        )
      `)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sessions_dedup
        ON app_sessions (bundle_id, start_time)
      `)
    },
  },
  {
    version: 4,
    description: 'Recompute daily summaries after tracking fixes',
    up: () => {
      const db = getDb()
      db.exec('DELETE FROM daily_summaries')
    },
  },
  {
    version: 5,
    description: 'Add visit_time_us column and richer UNIQUE constraint to website_visits',
    up: () => {
      const db = getDb()
      const hasVisitTimeUs = hasColumn('website_visits', 'visit_time_us')
      const websiteVisitsSql = getTableSql('website_visits') ?? ''
      const hasCorrectUniqueConstraint = /UNIQUE\s*\(\s*browser_bundle_id\s*,\s*visit_time_us\s*,\s*url\s*\)/i.test(
        websiteVisitsSql
      )

      // Fresh installs already get the correct v5 shape from SCHEMA_SQL.
      if (hasVisitTimeUs && hasCorrectUniqueConstraint) return

      if (!hasVisitTimeUs) {
        // Add visit_time_us column (microsecond timestamp from source browser)
        db.exec(`ALTER TABLE website_visits ADD COLUMN visit_time_us INTEGER NOT NULL DEFAULT 0`)
      }

      // Drop the old (browser_bundle_id, visit_time) unique constraint by recreating the table.
      // SQLite does not support DROP CONSTRAINT — we rename, copy, drop old, create index.
      db.exec(`
        DROP TABLE IF EXISTS website_visits_new;
        CREATE TABLE website_visits_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          domain            TEXT    NOT NULL,
          page_title        TEXT,
          url               TEXT,
          visit_time        INTEGER NOT NULL,
          visit_time_us     INTEGER NOT NULL DEFAULT 0,
          duration_sec      INTEGER NOT NULL DEFAULT 0,
          browser_bundle_id TEXT,
          source            TEXT    NOT NULL DEFAULT 'history',
          UNIQUE (browser_bundle_id, visit_time_us, url)
        );
        INSERT OR IGNORE INTO website_visits_new
          (id, domain, page_title, url, visit_time, visit_time_us, duration_sec, browser_bundle_id, source)
        SELECT
          id,
          domain,
          page_title,
          url,
          visit_time,
          CASE
            WHEN visit_time_us IS NOT NULL AND visit_time_us != 0 THEN visit_time_us
            ELSE visit_time * 1000
          END,
          duration_sec,
          browser_bundle_id,
          source
        FROM website_visits;
        DROP TABLE website_visits;
        ALTER TABLE website_visits_new RENAME TO website_visits;
        CREATE INDEX IF NOT EXISTS idx_website_visits_time   ON website_visits (visit_time);
        CREATE INDEX IF NOT EXISTS idx_website_visits_domain ON website_visits (domain, visit_time);
      `)
    },
  },
  {
    version: 6,
    description: 'Add ai_messages table for normalised AI conversation storage',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id),
          role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
          content         TEXT    NOT NULL,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages (conversation_id, created_at);
      `)
      // Migrate existing messages from the JSON blob into ai_messages rows
      const rows = db
        .prepare('SELECT id, messages FROM ai_conversations')
        .all() as { id: number; messages: string }[]
      const insert = db.prepare(
        'INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
      )
      const migrate = db.transaction(() => {
        for (const conv of rows) {
          try {
            const msgs = JSON.parse(conv.messages) as { role: string; content: string; timestamp?: number }[]
            let ts = Date.now()
            for (const msg of msgs) {
              insert.run(conv.id, msg.role, msg.content, msg.timestamp ?? ts++)
            }
          } catch { /* skip malformed blobs */ }
        }
      })
      migrate()
    },
  },
  {
    version: 7,
    description: 'Add focus session targets and planned apps metadata',
    up: () => {
      const db = getDb()
      if (!hasColumn('focus_sessions', 'target_minutes')) {
        db.exec(`ALTER TABLE focus_sessions ADD COLUMN target_minutes INTEGER`)
      }
      if (!hasColumn('focus_sessions', 'planned_apps')) {
        db.exec(`ALTER TABLE focus_sessions ADD COLUMN planned_apps TEXT NOT NULL DEFAULT '[]'`)
      }
    },
  },
  {
    version: 8,
    description: 'Add focus reflections, distraction events, and work context observations',
    up: () => {
      const db = getDb()
      if (!hasColumn('focus_sessions', 'reflection_note')) {
        db.exec(`ALTER TABLE focus_sessions ADD COLUMN reflection_note TEXT`)
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS distraction_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER REFERENCES focus_sessions(id) ON DELETE SET NULL,
          app_name TEXT NOT NULL,
          bundle_id TEXT NOT NULL,
          triggered_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_distraction_events_session
          ON distraction_events (session_id, triggered_at);

        CREATE TABLE IF NOT EXISTS work_context_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          observation TEXT NOT NULL,
          source_block_ids TEXT NOT NULL DEFAULT '[]',
          UNIQUE(start_ts, end_ts)
        );
        CREATE INDEX IF NOT EXISTS idx_work_context_observations_range
          ON work_context_observations (start_ts, end_ts);
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
