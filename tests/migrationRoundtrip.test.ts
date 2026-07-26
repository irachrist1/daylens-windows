// C6 — migration ladder round-trip.
//
// Verifies the production install + upgrade paths:
//
//   1. Fresh install: SCHEMA_SQL boots into a working DB, then `runMigrations()`
//      advances `schema_version` to the latest version without throwing.
//   2. Idempotency: a second `runMigrations()` call on the same DB is a no-op.
//   3. Core tables exist after the round-trip (catches a regression where a
//      migration accidentally drops or renames a base table).
//
// Does not assert specific column counts — that would create maintenance noise
// every time a migration adds a column. Asserts the structural invariants only.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { runMigrations } from '../src/main/db/migrations.ts'

const REQUIRED_TABLES = [
  'app_sessions',
  'live_app_session_snapshot',
  'focus_sessions',
  'ai_conversations',
  'ai_messages',
  'ai_threads',
  'website_visits',
  'maintenance_runs',
  'schema_version',
]

function tableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function indexNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function currentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null } | undefined
  return row?.v ?? 0
}

test('fresh install: SCHEMA_SQL boots + runMigrations advances schema_version', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    assert.doesNotThrow(() => runMigrations())

    const version = currentSchemaVersion(db)
    assert.ok(version >= 22, `expected schema_version >= 22, got ${version}`)

    const tables = tableNames(db)
    for (const required of REQUIRED_TABLES) {
      assert.ok(tables.has(required), `missing required table: ${required}`)
    }

    // The migration ladder must be strictly increasing in array order:
    // runMigrations() filters on version > MAX(applied), so a migration added
    // below the current tip would never run on upgraded databases (this is why
    // the twin dedupe was renumbered v57 -> v59 and v57 stays a documented
    // gap). On a fresh install rows land in array order, so rowid order
    // reveals the array order.
    const applied = db
      .prepare('SELECT version FROM schema_version ORDER BY rowid')
      .all() as { version: number }[]
    for (let i = 1; i < applied.length; i++) {
      assert.ok(
        applied[i].version > applied[i - 1].version,
        `migration ladder not strictly increasing: v${applied[i].version} follows v${applied[i - 1].version}`,
      )
    }
  } finally {
    clearTestDb()
    db.close()
  }
})

test('runMigrations is idempotent on an up-to-date database', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()
    const firstVersion = currentSchemaVersion(db)

    assert.doesNotThrow(() => runMigrations())

    const secondVersion = currentSchemaVersion(db)
    assert.equal(secondVersion, firstVersion, 'second runMigrations() should not advance the version')
  } finally {
    clearTestDb()
    db.close()
  }
})

test('v36 database boots before the work-memory scope migration runs', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (36, 0);

    CREATE TABLE work_memory_facts (
      id          TEXT PRIMARY KEY,
      fact_text   TEXT NOT NULL,
      origin      TEXT NOT NULL CHECK(origin IN ('drafted', 'user')),
      status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
      topic_key   TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_work_memory_facts_status
      ON work_memory_facts (status, sort_order);

    CREATE TABLE ai_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      job_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cache_hit INTEGER NOT NULL DEFAULT 0
    );
  `)

  assert.doesNotThrow(() => db.exec(SCHEMA_SQL))

  setTestDb(db)
  try {
    assert.doesNotThrow(() => runMigrations())

    const columns = db.prepare(`PRAGMA table_info(work_memory_facts)`).all() as { name: string }[]
    assert.ok(columns.some((column) => column.name === 'source'))
    assert.ok(columns.some((column) => column.name === 'scope'))

    const indexes = indexNames(db)
    assert.ok(indexes.has('idx_work_memory_facts_scope'))
  } finally {
    clearTestDb()
    db.close()
  }
})

test('migration ladder does not drop any required base table', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()
    const tables = tableNames(db)
    for (const required of REQUIRED_TABLES) {
      assert.ok(tables.has(required), `migration dropped required table: ${required}`)
    }
  } finally {
    clearTestDb()
    db.close()
  }
})

test('migration ladder leaves the database queryable', () => {
  // Sanity: after migrations, a few representative queries should run without
  // syntax errors. Catches the case where a migration adds an index against
  // a non-existent column.
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()

    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM app_sessions').get())
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM website_visits').get())
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM ai_threads').get())
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM schema_version').get())
  } finally {
    clearTestDb()
    db.close()
  }
})

test('fresh schema and migrations include hot-path performance indexes', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  setTestDb(db)
  try {
    runMigrations()

    const indexes = indexNames(db)
    // idx_focus_sessions_start is the standalone hot-path index. (bundle_id,
    // start_time) is covered by the UNIQUE idx_app_sessions_dedup and
    // timeline_block_members(block_id) by that table's PRIMARY KEY, so we assert
    // those covering indexes exist rather than the removed redundant ones.
    for (const indexName of [
      'idx_focus_sessions_start',
      'idx_app_sessions_dedup',
    ]) {
      assert.ok(indexes.has(indexName), `missing hot-path index: ${indexName}`)
    }
  } finally {
    clearTestDb()
    db.close()
  }
})
