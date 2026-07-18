// DEV-162 — a representative upgraded database migrates forward: existing
// focus_events activity gains stable evidence identity, sensitivity, and
// provenance without losing activity or corrections.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { runMigrations } from '../src/main/db/migrations.ts'

// The production focus_events shape between migrations v35 and v45.
const LEGACY_FOCUS_EVENTS_SQL = `
  CREATE TABLE focus_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms         INTEGER NOT NULL,
    mono_ns       INTEGER NOT NULL,
    event_type    TEXT    NOT NULL,
    app_bundle_id TEXT,
    app_name      TEXT,
    pid           INTEGER,
    window_title  TEXT,
    url           TEXT,
    page_title    TEXT,
    source        TEXT    NOT NULL,
    confidence    TEXT    NOT NULL,
    platform      TEXT    NOT NULL DEFAULT 'darwin',
    schema_ver    INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_focus_events_ts ON focus_events(ts_ms);
  CREATE INDEX idx_focus_events_type ON focus_events(event_type);
  CREATE INDEX idx_focus_events_platform ON focus_events(platform);
`

interface LegacyRow {
  ts_ms: number
  mono_ns: number
  event_type: string
  app_bundle_id: string | null
  app_name: string | null
  pid: number | null
  window_title: string | null
  url: string | null
  page_title: string | null
  source: string
  confidence: string
  platform: string
}

function legacyRow(overrides: Partial<LegacyRow> & { ts_ms: number }): LegacyRow {
  return {
    mono_ns: overrides.ts_ms * 1_000_000,
    event_type: 'app_activated',
    app_bundle_id: 'com.example.editor',
    app_name: 'Editor',
    pid: 42,
    window_title: 'notes.md',
    url: null,
    page_title: null,
    source: 'nsworkspace_event',
    confidence: 'observed',
    platform: 'darwin',
    ...overrides,
  }
}

function createUpgradedDatabase(additionalRows: readonly LegacyRow[] = []): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  db.exec(LEGACY_FOCUS_EVENTS_SQL)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (45, 0);
  `)

  const insert = db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (
      @ts_ms, @mono_ns, @event_type, @app_bundle_id, @app_name, @pid,
      @window_title, @url, @page_title, @source, @confidence, @platform, 1
    )
  `)

  const rows: LegacyRow[] = [
    legacyRow({ ts_ms: 1_000 }),
    legacyRow({
      ts_ms: 2_000,
      event_type: 'tab_changed',
      app_bundle_id: 'com.apple.Safari',
      app_name: 'Safari',
      window_title: 'Docs',
      url: 'https://example.com/docs',
      page_title: 'Docs',
      source: 'apple_events_tab',
    }),
    legacyRow({ ts_ms: 3_000, event_type: 'lock', app_bundle_id: null, app_name: null, window_title: null }),
    legacyRow({ ts_ms: 4_000, event_type: 'sleep', app_bundle_id: null, app_name: null, window_title: null }),
    legacyRow({
      ts_ms: 5_000,
      event_type: 'window_changed',
      app_bundle_id: 'com.example.editor',
      app_name: 'Editor',
      window_title: 'draft.md',
      source: 'uia_foreground',
      platform: 'win32',
    }),
    legacyRow({ ts_ms: 6_000, confidence: 'unknown', window_title: null }),
  ]
  for (const row of rows) insert.run(row)
  for (const row of additionalRows) insert.run(row)
  // An exact duplicate of the first row — a retried batch that was persisted
  // twice under the legacy path.
  insert.run(rows[0])

  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id, block_id, date, evidence_key, review_state,
      original_block_json, correction_json, created_at, updated_at
    ) VALUES ('review-1', 'block-1', '1970-01-01', 'evidence-key-1', 'corrected', '{}', '{"label":"Deep work"}', 1, 1)
  `).run()
  db.prepare(`
    INSERT INTO timeline_boundary_corrections (
      id, date, left_session_id, right_session_id, kind, created_at, updated_at, span_start_ms, span_end_ms
    ) VALUES ('boundary-1', '1970-01-01', 10, 11, 'merge', 1, 1, 1000, 5000)
  `).run()

  return db
}

test('an upgraded database migrates forward with activity and corrections intact', () => {
  const db = createUpgradedDatabase()
  setTestDb(db)
  const log = console.log
  console.log = () => {}
  try {
    assert.doesNotThrow(() => runMigrations())
  } finally {
    console.log = log
    clearTestDb()
  }

  try {
    const rows = db.prepare(`
      SELECT id, evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name,
             window_title, url, page_title, source, confidence, platform, sensitivity,
             provenance_method, permission_scope, policy_version, schema_ver
        FROM focus_events ORDER BY id ASC
    `).all() as Array<Record<string, unknown>>

    // Six distinct observations survive; the exact duplicate collapses.
    assert.equal(rows.length, 6)

    const identities = new Set(rows.map((row) => row.evidence_id))
    assert.equal(identities.size, 6)

    for (const row of rows) {
      assert.ok(typeof row.evidence_id === 'string' && row.evidence_id.length > 0)
      assert.equal(row.sensitivity, 'standard')
      assert.equal(row.policy_version, 0)
      assert.equal(row.schema_ver, 2)
      assert.equal(row.provenance_method, row.source)
    }

    // Activity content is untouched.
    assert.deepEqual(
      rows.map((row) => [row.ts_ms, row.event_type, row.app_name, row.url]),
      [
        [1_000, 'app_activated', 'Editor', null],
        [2_000, 'tab_changed', 'Safari', 'https://example.com/docs'],
        [3_000, 'lock', null, null],
        [4_000, 'sleep', null, null],
        [5_000, 'window_changed', 'Editor', null],
        [6_000, 'app_activated', 'Editor', null],
      ],
    )

    // Permission scope is derived from how each event was captured.
    assert.equal(rows[0].permission_scope, 'macos_foreground_observation')
    assert.equal(rows[1].permission_scope, 'macos_apple_events_automation')
    assert.equal(rows[4].permission_scope, 'windows_uia_foreground')

    // Corrections survive the migration untouched.
    const review = db.prepare(`SELECT review_state, correction_json FROM timeline_block_reviews WHERE id = 'review-1'`).get() as Record<string, unknown>
    assert.equal(review.review_state, 'corrected')
    assert.equal(review.correction_json, '{"label":"Deep work"}')
    const boundary = db.prepare(`SELECT kind, span_start_ms FROM timeline_boundary_corrections WHERE id = 'boundary-1'`).get() as Record<string, unknown>
    assert.equal(boundary.kind, 'merge')
    assert.equal(boundary.span_start_ms, 1000)
  } finally {
    db.close()
  }
})

test('migrating an upgraded database is idempotent for evidence identities', () => {
  const db = createUpgradedDatabase()
  setTestDb(db)
  const log = console.log
  console.log = () => {}
  try {
    runMigrations()
    const first = db.prepare('SELECT id, evidence_id FROM focus_events ORDER BY id').all()
    runMigrations()
    const second = db.prepare('SELECT id, evidence_id FROM focus_events ORDER BY id').all()
    assert.deepEqual(second, first)
  } finally {
    console.log = log
    clearTestDb()
    db.close()
  }
})

test('migration collapses only exact legacy duplicates', () => {
  const db = createUpgradedDatabase([
    legacyRow({ ts_ms: 1_000, pid: 43 }),
    legacyRow({ ts_ms: 1_000, confidence: 'unknown' }),
    legacyRow({ ts_ms: 1_000, platform: 'win32' }),
  ])
  setTestDb(db)
  const log = console.log
  console.log = () => {}
  try {
    runMigrations()
    const rows = db.prepare(`
      SELECT pid, confidence, platform
        FROM focus_events
       WHERE ts_ms = 1000
       ORDER BY id
    `).all()
    assert.deepEqual(rows, [
      { pid: 42, confidence: 'observed', platform: 'darwin' },
      { pid: 43, confidence: 'observed', platform: 'darwin' },
      { pid: 42, confidence: 'unknown', platform: 'darwin' },
      { pid: 42, confidence: 'observed', platform: 'win32' },
    ])
  } finally {
    console.log = log
    clearTestDb()
    db.close()
  }
})
