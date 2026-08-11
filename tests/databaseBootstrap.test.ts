import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { ensureAIThreadSchema } from '../src/main/db/aiThreadSchema.ts'
import { scrubStaleAppNarrativeMetricSummaries } from '../src/main/db/migrations.ts'
import { repairStoredAppIdentityObservations } from '../src/main/core/inference/appIdentityRegistry.ts'
import { repairStoredIdentityColumns } from '../src/main/core/projections/metadata.ts'

test('legacy ai_messages tables can boot through schema + repair without thread_id', () => {
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE ai_conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      messages   TEXT    NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE ai_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id),
      role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
      content         TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      metadata_json   TEXT    NOT NULL DEFAULT '{}'
    );

    INSERT INTO ai_conversations (id, messages, created_at) VALUES (1, '[]', 1000);
    INSERT INTO ai_messages (conversation_id, role, content, created_at, metadata_json)
    VALUES
      (1, 'user', 'What did I do?', 1100, '{}'),
      (1, 'assistant', 'You worked on Daylens.', 1200, '{}');
  `)

  assert.doesNotThrow(() => db.exec(SCHEMA_SQL))
  assert.doesNotThrow(() => ensureAIThreadSchema(db))

  const columns = db.prepare(`PRAGMA table_info(ai_messages)`).all() as { name: string }[]
  assert.ok(columns.some((column) => column.name === 'thread_id'))

  const indexes = db.prepare(`PRAGMA index_list(ai_messages)`).all() as { name: string }[]
  assert.ok(indexes.some((index) => index.name === 'idx_ai_messages_thread'))

  const threadCount = db.prepare(`SELECT COUNT(*) AS count FROM ai_threads`).get() as { count: number }
  assert.equal(threadCount.count, 1)

  db.close()
})

test('stale metric-bearing app narratives are deleted without touching activity-shaped narratives', () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO ai_surface_summaries (
      scope_type,
      scope_key,
      job_type,
      title,
      summary_text,
      input_signature,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `)

  insert.run(
    'app_detail',
    'app:dia:1d:2026-05-27',
    'app_narrative',
    'Dia today',
    'You used Dia across 59 sessions totaling 2 hours 18 minutes.',
    'old',
    now,
    now,
  )
  insert.run(
    'app_detail',
    'app:safari:1d:2026-05-27',
    'app_narrative',
    'Safari today',
    'Safari mostly carried Coursera lesson pages and paired with Notes for course work.',
    'fresh',
    now,
    now,
  )
  insert.run(
    'timeline_week',
    'week:2026-05-25',
    'week_review',
    'Week review',
    'This week had 10 hours across 4 sessions.',
    'week',
    now,
    now,
  )

  assert.equal(scrubStaleAppNarrativeMetricSummaries(db), 1)

  const rows = db.prepare(`SELECT scope_key FROM ai_surface_summaries ORDER BY scope_key`).all() as { scope_key: string }[]
  assert.deepEqual(rows.map((row) => row.scope_key), ['app:safari:1d:2026-05-27', 'week:2026-05-25'])
  db.close()
})

test('startup identity repairs are marked and skipped after first completion', () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('com.todesktop.cursor', 'Cursor', 1_000, 2_000, 1, 'development', 1)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      raw_app_name,
      app_instance_id,
      capture_source,
      capture_version,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('com.todesktop.cursor', 'Cursor', 'Cursor', 'com.todesktop.cursor', 'foreground_poll', 1, 3_000, 4_000, 1, 'development', 1)
  db.prepare(`
    INSERT INTO website_visits (
      domain,
      page_title,
      url,
      visit_time,
      visit_time_us,
      browser_bundle_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('github.com', 'Repo', 'https://github.com/daylens/app?utm_source=test#readme', 1_500, 1_500_000, 'com.google.Chrome')
  db.prepare(`
    INSERT INTO website_visits (
      domain,
      page_title,
      url,
      normalized_url,
      page_key,
      visit_time,
      visit_time_us,
      browser_bundle_id,
      browser_profile_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'github.com',
    'Repo',
    'https://github.com/daylens/app?utm_source=test#readme',
    'https://github.com/daylens/app',
    'github.com/daylens/app',
    3_500,
    3_500_000,
    'com.google.Chrome',
    'default',
  )

  repairStoredIdentityColumns(db)
  repairStoredAppIdentityObservations(db)

  const session = db.prepare(`
    SELECT raw_app_name AS rawAppName, canonical_app_id AS canonicalAppId, app_instance_id AS appInstanceId, capture_source AS captureSource
    FROM app_sessions
    ORDER BY start_time
  `).get() as { rawAppName: string | null; canonicalAppId: string | null; appInstanceId: string | null; captureSource: string | null }
  assert.equal(session.rawAppName, 'Cursor')
  assert.ok(session.canonicalAppId)
  assert.equal(session.appInstanceId, 'com.todesktop.cursor')
  assert.equal(session.captureSource, 'foreground_poll')
  const canonicalOnlySession = db.prepare(`
    SELECT canonical_app_id AS canonicalAppId
    FROM app_sessions
    WHERE start_time = 3000
  `).get() as { canonicalAppId: string | null }
  assert.ok(canonicalOnlySession.canonicalAppId)

  const visit = db.prepare(`
    SELECT canonical_browser_id AS canonicalBrowserId, browser_profile_id AS browserProfileId, normalized_url AS normalizedUrl, page_key AS pageKey
    FROM website_visits
    ORDER BY visit_time
  `).get() as { canonicalBrowserId: string | null; browserProfileId: string | null; normalizedUrl: string | null; pageKey: string | null }
  assert.ok(visit.canonicalBrowserId)
  assert.equal(visit.browserProfileId, 'default')
  assert.equal(visit.normalizedUrl, 'https://github.com/daylens/app')
  assert.equal(visit.pageKey, 'github.com/daylens/app')
  const canonicalOnlyVisit = db.prepare(`
    SELECT canonical_browser_id AS canonicalBrowserId
    FROM website_visits
    WHERE visit_time = 3500
  `).get() as { canonicalBrowserId: string | null }
  assert.ok(canonicalOnlyVisit.canonicalBrowserId)

  const identityCount = db.prepare(`SELECT COUNT(*) AS count FROM app_identities`).get() as { count: number }
  assert.equal(identityCount.count, 1)

  // Two repair markers plus the range-facts evidence epoch the repair bumps
  // (the repair UPDATEs evidence in place, which must invalidate cached
  // range facts — see rangeFactsCache.ts).
  const markerCount = db.prepare(`SELECT COUNT(*) AS count FROM maintenance_runs`).get() as { count: number }
  assert.equal(markerCount.count, 3)

  db.prepare(`UPDATE app_sessions SET raw_app_name = NULL`).run()
  repairStoredIdentityColumns(db)
  const skipped = db.prepare(`SELECT raw_app_name AS rawAppName FROM app_sessions LIMIT 1`).get() as { rawAppName: string | null }
  assert.equal(skipped.rawAppName, null)

  db.close()
})
