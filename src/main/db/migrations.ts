import { getDb } from '../services/database'
import { normalizeUrlForStorage, pageKeyForUrl, resolveCanonicalApp, resolveCanonicalBrowser } from '../lib/appIdentity'
import { deriveClientAliasTokens } from '../lib/clientAliases'
import { ensureAIMessageFeedbackSchema, ensureAIThreadSchema } from './aiThreadSchema'
import { runEntityAdoptionBackfill } from '../services/entities/entityAdoption'
import { dedupeAppIdentityTwins } from '../services/entities/appIdentityTwinDedupe'
import { macBundleIdentifierForExecutablePath } from '../services/browserRegistry'
import {
  migrateLegacyUserFactsToSupplied,
  reconcileSuppliedMemoryRecords,
} from '../services/suppliedMemory'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { canonicalAppCategory } from '../../shared/activityCategories'

/**
 * Versioned migration system for Daylens.
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

export function ensureSearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIEW IF NOT EXISTS app_sessions_fts_content AS
    SELECT
      id AS rowid,
      app_name,
      window_title
    FROM app_sessions;

    CREATE VIEW IF NOT EXISTS timeline_blocks_fts_content AS
    SELECT
      timeline_blocks.rowid AS rowid,
      timeline_blocks.label_current AS label_current,
      COALESCE((
        SELECT group_concat(label, ' ')
        FROM (
          SELECT label
          FROM timeline_block_labels
          WHERE block_id = timeline_blocks.id
          ORDER BY created_at ASC, id ASC
        )
      ), '') AS merged_labels
    FROM timeline_blocks;

    CREATE VIEW IF NOT EXISTS website_visits_fts_content AS
    SELECT
      id AS rowid,
      url,
      page_title
    FROM website_visits;

    CREATE VIEW IF NOT EXISTS ai_artifacts_fts_content AS
    SELECT
      id AS rowid,
      title,
      CASE
        WHEN inline_content IS NOT NULL AND length(inline_content) < 32768 THEN inline_content
        ELSE NULL
      END AS inline_content
    FROM ai_artifacts;

    CREATE VIRTUAL TABLE IF NOT EXISTS app_sessions_fts USING fts5(
      app_name,
      window_title,
      content='app_sessions_fts_content',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS timeline_blocks_fts USING fts5(
      label_current,
      merged_labels,
      content='timeline_blocks_fts_content',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS website_visits_fts USING fts5(
      url,
      page_title,
      content='website_visits_fts_content',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ai_artifacts_fts USING fts5(
      title,
      inline_content,
      content='ai_artifacts_fts_content',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS app_sessions_fts_ai
    AFTER INSERT ON app_sessions BEGIN
      INSERT INTO app_sessions_fts(rowid, app_name, window_title)
      VALUES (new.id, new.app_name, new.window_title);
    END;

    CREATE TRIGGER IF NOT EXISTS app_sessions_fts_bd
    BEFORE DELETE ON app_sessions BEGIN
      INSERT INTO app_sessions_fts(app_sessions_fts, rowid, app_name, window_title)
      VALUES ('delete', old.id, old.app_name, old.window_title);
    END;

    CREATE TRIGGER IF NOT EXISTS app_sessions_fts_bu
    BEFORE UPDATE OF app_name, window_title ON app_sessions BEGIN
      INSERT INTO app_sessions_fts(app_sessions_fts, rowid, app_name, window_title)
      VALUES ('delete', old.id, old.app_name, old.window_title);
    END;

    CREATE TRIGGER IF NOT EXISTS app_sessions_fts_au
    AFTER UPDATE OF app_name, window_title ON app_sessions BEGIN
      INSERT INTO app_sessions_fts(rowid, app_name, window_title)
      VALUES (new.id, new.app_name, new.window_title);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_blocks_fts_ai
    AFTER INSERT ON timeline_blocks BEGIN
      INSERT INTO timeline_blocks_fts(rowid, label_current, merged_labels)
      SELECT rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = new.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_blocks_fts_bd
    BEFORE DELETE ON timeline_blocks BEGIN
      INSERT INTO timeline_blocks_fts(timeline_blocks_fts, rowid, label_current, merged_labels)
      SELECT 'delete', rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_blocks_fts_bu
    BEFORE UPDATE OF label_current ON timeline_blocks BEGIN
      INSERT INTO timeline_blocks_fts(timeline_blocks_fts, rowid, label_current, merged_labels)
      SELECT 'delete', rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_blocks_fts_au
    AFTER UPDATE OF label_current ON timeline_blocks BEGIN
      INSERT INTO timeline_blocks_fts(rowid, label_current, merged_labels)
      SELECT rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = new.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_block_labels_fts_ai
    AFTER INSERT ON timeline_block_labels BEGIN
      INSERT INTO timeline_blocks_fts(timeline_blocks_fts, rowid, label_current, merged_labels)
      SELECT
        'delete',
        timeline_blocks.rowid,
        timeline_blocks.label_current,
        COALESCE((
          SELECT group_concat(label, ' ')
          FROM (
            SELECT label
            FROM timeline_block_labels
            WHERE block_id = new.block_id AND id != new.id
            ORDER BY created_at ASC, id ASC
          )
        ), '')
      FROM timeline_blocks
      WHERE timeline_blocks.id = new.block_id;

      INSERT INTO timeline_blocks_fts(rowid, label_current, merged_labels)
      SELECT rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = (SELECT rowid FROM timeline_blocks WHERE id = new.block_id);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_block_labels_fts_bd
    BEFORE DELETE ON timeline_block_labels BEGIN
      INSERT INTO timeline_blocks_fts(timeline_blocks_fts, rowid, label_current, merged_labels)
      SELECT 'delete', rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = (SELECT rowid FROM timeline_blocks WHERE id = old.block_id);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_block_labels_fts_ad
    AFTER DELETE ON timeline_block_labels BEGIN
      INSERT INTO timeline_blocks_fts(rowid, label_current, merged_labels)
      SELECT rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = (SELECT rowid FROM timeline_blocks WHERE id = old.block_id);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_block_labels_fts_bu
    BEFORE UPDATE OF label ON timeline_block_labels BEGIN
      INSERT INTO timeline_blocks_fts(timeline_blocks_fts, rowid, label_current, merged_labels)
      SELECT 'delete', rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = (SELECT rowid FROM timeline_blocks WHERE id = old.block_id);
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_block_labels_fts_au
    AFTER UPDATE OF label ON timeline_block_labels BEGIN
      INSERT INTO timeline_blocks_fts(rowid, label_current, merged_labels)
      SELECT rowid, label_current, merged_labels
      FROM timeline_blocks_fts_content
      WHERE rowid = (SELECT rowid FROM timeline_blocks WHERE id = new.block_id);
    END;

    CREATE TRIGGER IF NOT EXISTS website_visits_fts_ai
    AFTER INSERT ON website_visits BEGIN
      INSERT INTO website_visits_fts(rowid, url, page_title)
      VALUES (new.id, new.url, new.page_title);
    END;

    CREATE TRIGGER IF NOT EXISTS website_visits_fts_bd
    BEFORE DELETE ON website_visits BEGIN
      INSERT INTO website_visits_fts(website_visits_fts, rowid, url, page_title)
      VALUES ('delete', old.id, old.url, old.page_title);
    END;

    CREATE TRIGGER IF NOT EXISTS website_visits_fts_bu
    BEFORE UPDATE OF url, page_title ON website_visits BEGIN
      INSERT INTO website_visits_fts(website_visits_fts, rowid, url, page_title)
      VALUES ('delete', old.id, old.url, old.page_title);
    END;

    CREATE TRIGGER IF NOT EXISTS website_visits_fts_au
    AFTER UPDATE OF url, page_title ON website_visits BEGIN
      INSERT INTO website_visits_fts(rowid, url, page_title)
      VALUES (new.id, new.url, new.page_title);
    END;

    CREATE TRIGGER IF NOT EXISTS ai_artifacts_fts_ai
    AFTER INSERT ON ai_artifacts BEGIN
      INSERT INTO ai_artifacts_fts(rowid, title, inline_content)
      VALUES (
        new.id,
        new.title,
        CASE
          WHEN new.inline_content IS NOT NULL AND length(new.inline_content) < 32768 THEN new.inline_content
          ELSE NULL
        END
      );
    END;

    CREATE TRIGGER IF NOT EXISTS ai_artifacts_fts_bd
    BEFORE DELETE ON ai_artifacts BEGIN
      INSERT INTO ai_artifacts_fts(ai_artifacts_fts, rowid, title, inline_content)
      VALUES (
        'delete',
        old.id,
        old.title,
        CASE
          WHEN old.inline_content IS NOT NULL AND length(old.inline_content) < 32768 THEN old.inline_content
          ELSE NULL
        END
      );
    END;

    CREATE TRIGGER IF NOT EXISTS ai_artifacts_fts_bu
    BEFORE UPDATE OF title, inline_content ON ai_artifacts BEGIN
      INSERT INTO ai_artifacts_fts(ai_artifacts_fts, rowid, title, inline_content)
      VALUES (
        'delete',
        old.id,
        old.title,
        CASE
          WHEN old.inline_content IS NOT NULL AND length(old.inline_content) < 32768 THEN old.inline_content
          ELSE NULL
        END
      );
    END;

    CREATE TRIGGER IF NOT EXISTS ai_artifacts_fts_au
    AFTER UPDATE OF title, inline_content ON ai_artifacts BEGIN
      INSERT INTO ai_artifacts_fts(rowid, title, inline_content)
      VALUES (
        new.id,
        new.title,
        CASE
          WHEN new.inline_content IS NOT NULL AND length(new.inline_content) < 32768 THEN new.inline_content
          ELSE NULL
        END
      );
    END;
  `)

  db.exec(`
    INSERT INTO app_sessions_fts(app_sessions_fts) VALUES ('rebuild');
    INSERT INTO timeline_blocks_fts(timeline_blocks_fts) VALUES ('rebuild');
    INSERT INTO website_visits_fts(website_visits_fts) VALUES ('rebuild');
    INSERT INTO ai_artifacts_fts(ai_artifacts_fts) VALUES ('rebuild');
  `)
}

// Exact-retrieval FTS over memory_records.exact_text (DEV-178). Same
// external-content pattern as the legacy FTS tables above; triggers keep the
// index in sync with day reindexes (delete + reinsert per day) so a corrected
// or deleted moment leaves the index in the same transaction that removes its
// record.
export function ensureMemorySearchSchema(db: Database.Database): void {
  // On a rebuild path (memory_records dropped and recreated) the FTS5 table
  // and its content view survive the DROP. We cannot CREATE them again while
  // they exist: memory_records_fts_content matches FTS5's reserved '_content'
  // shadow-table suffix, so SQLite rejects any CREATE of that name while
  // memory_records_fts is present ("object name reserved for internal use") —
  // the reserved-name check fires before IF NOT EXISTS is even considered.
  // Drop the vtable first to lift the shadow-name reservation, then the view,
  // then recreate from scratch. On the fresh path these are no-ops.
  db.exec(`
    DROP TABLE IF EXISTS memory_records_fts;
    DROP VIEW IF EXISTS memory_records_fts_content;
  `)

  db.exec(`
    CREATE VIEW IF NOT EXISTS memory_records_fts_content AS
    SELECT
      rowid AS rowid,
      exact_text
    FROM memory_records;

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
      exact_text,
      content='memory_records_fts_content',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memory_records_fts_ai
    AFTER INSERT ON memory_records BEGIN
      INSERT INTO memory_records_fts(rowid, exact_text)
      VALUES (new.rowid, new.exact_text);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_records_fts_bd
    BEFORE DELETE ON memory_records BEGIN
      INSERT INTO memory_records_fts(memory_records_fts, rowid, exact_text)
      VALUES ('delete', old.rowid, old.exact_text);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_records_fts_bu
    BEFORE UPDATE OF exact_text ON memory_records BEGIN
      INSERT INTO memory_records_fts(memory_records_fts, rowid, exact_text)
      VALUES ('delete', old.rowid, old.exact_text);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_records_fts_au
    AFTER UPDATE OF exact_text ON memory_records BEGIN
      INSERT INTO memory_records_fts(rowid, exact_text)
      VALUES (new.rowid, new.exact_text);
    END;
  `)

  db.exec(`
    INSERT INTO memory_records_fts(memory_records_fts) VALUES ('rebuild');
  `)
}

export function scrubStaleAppNarrativeMetricSummaries(db: Database.Database): number {
  // B4: older app-detail narratives cached prose like "2 hours 18 minutes
  // across 59 sessions" while the header rendered live canonical totals.
  // New app narratives are forbidden from mentioning totals; delete stale
  // metric-bearing app summaries so the renderer falls back to deterministic
  // activity context until a fresh narrative is generated.
  const metricClauses = [
    `LOWER(summary_text) LIKE '% across % session%'`,
    `LOWER(summary_text) LIKE '% session totaling %'`,
    `LOWER(summary_text) LIKE '% sessions totaling %'`,
    `LOWER(summary_text) LIKE '% total of %'`,
    `LOWER(summary_text) LIKE '% totaling %'`,
    `LOWER(summary_text) LIKE '% totaled %'`,
    `LOWER(summary_text) LIKE '% totalled %'`,
    `LOWER(summary_text) LIKE '% hours % sessions%'`,
    `LOWER(summary_text) LIKE '% minutes % sessions%'`,
  ]
  const result = db.prepare(`
    DELETE FROM ai_surface_summaries
    WHERE scope_type = 'app_detail'
      AND (${metricClauses.join(' OR ')})
  `).run()
  return result.changes
}

function ensureAppSessionIdentityColumns(): void {
  const db = getDb()

  if (!hasColumn('app_sessions', 'raw_app_name')) {
    db.exec(`ALTER TABLE app_sessions ADD COLUMN raw_app_name TEXT`)
  }
  if (!hasColumn('app_sessions', 'canonical_app_id')) {
    db.exec(`ALTER TABLE app_sessions ADD COLUMN canonical_app_id TEXT`)
  }
  if (!hasColumn('app_sessions', 'app_instance_id')) {
    db.exec(`ALTER TABLE app_sessions ADD COLUMN app_instance_id TEXT`)
  }
  if (!hasColumn('app_sessions', 'capture_source')) {
    db.exec(`ALTER TABLE app_sessions ADD COLUMN capture_source TEXT NOT NULL DEFAULT 'foreground_poll'`)
  }
  if (!hasColumn('app_sessions', 'ended_reason')) {
    db.exec(`ALTER TABLE app_sessions ADD COLUMN ended_reason TEXT`)
  }
  if (!hasColumn('app_sessions', 'capture_version')) {
    db.exec(`ALTER TABLE app_sessions ADD COLUMN capture_version INTEGER NOT NULL DEFAULT 1`)
  }
}

function ensureWebsiteVisitIdentityColumns(): void {
  const db = getDb()

  if (!hasColumn('website_visits', 'canonical_browser_id')) {
    db.exec(`ALTER TABLE website_visits ADD COLUMN canonical_browser_id TEXT`)
  }
  if (!hasColumn('website_visits', 'browser_profile_id')) {
    db.exec(`ALTER TABLE website_visits ADD COLUMN browser_profile_id TEXT`)
  }
  if (!hasColumn('website_visits', 'normalized_url')) {
    db.exec(`ALTER TABLE website_visits ADD COLUMN normalized_url TEXT`)
  }
  if (!hasColumn('website_visits', 'page_key')) {
    db.exec(`ALTER TABLE website_visits ADD COLUMN page_key TEXT`)
  }
}

function backfillAppSessionsIdentity(): void {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, bundle_id, app_name
    FROM app_sessions
  `).all() as { id: number; bundle_id: string; app_name: string }[]

  const update = db.prepare(`
    UPDATE app_sessions
    SET raw_app_name = ?,
        canonical_app_id = ?,
        app_instance_id = ?,
        capture_source = COALESCE(capture_source, 'foreground_poll'),
        capture_version = COALESCE(capture_version, 1)
    WHERE id = ?
  `)

  const tx = db.transaction(() => {
    for (const row of rows) {
      const identity = resolveCanonicalApp(row.bundle_id, row.app_name)
      update.run(identity.rawAppName, identity.canonicalAppId, identity.appInstanceId, row.id)
    }
  })

  tx()
}

function backfillWebsiteIdentity(): void {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, browser_bundle_id, url
    FROM website_visits
  `).all() as { id: number; browser_bundle_id: string | null; url: string | null }[]

  const update = db.prepare(`
    UPDATE website_visits
    SET canonical_browser_id = ?,
        browser_profile_id = ?,
        normalized_url = ?,
        page_key = ?
    WHERE id = ?
  `)

  const tx = db.transaction(() => {
    for (const row of rows) {
      const browserIdentity = resolveCanonicalBrowser(row.browser_bundle_id)
      update.run(
        browserIdentity.canonicalBrowserId,
        browserIdentity.browserProfileId,
        normalizeUrlForStorage(row.url),
        pageKeyForUrl(row.url),
        row.id,
      )
    }
  })

  tx()
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
  {
    version: 9,
    description: 'Add raw capture identity columns and activity/browser normalization tables',
    up: () => {
      const db = getDb()
      if (!hasColumn('app_sessions', 'window_title')) {
        db.exec(`ALTER TABLE app_sessions ADD COLUMN window_title TEXT`)
      }
      ensureAppSessionIdentityColumns()
      if (!hasColumn('app_sessions', 'capture_source')) {
        db.exec(`ALTER TABLE app_sessions ADD COLUMN capture_source TEXT NOT NULL DEFAULT 'foreground_poll'`)
      }
      if (!hasColumn('app_sessions', 'ended_reason')) {
        db.exec(`ALTER TABLE app_sessions ADD COLUMN ended_reason TEXT`)
      }
      if (!hasColumn('app_sessions', 'capture_version')) {
        db.exec(`ALTER TABLE app_sessions ADD COLUMN capture_version INTEGER NOT NULL DEFAULT 1`)
      }

      ensureWebsiteVisitIdentityColumns()

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_app_sessions_canonical_app
          ON app_sessions (canonical_app_id, start_time);
        CREATE INDEX IF NOT EXISTS idx_website_visits_browser
          ON website_visits (canonical_browser_id, visit_time);
        CREATE INDEX IF NOT EXISTS idx_website_visits_page_key
          ON website_visits (page_key, visit_time);

        CREATE TABLE IF NOT EXISTS activity_state_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_ts INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'system',
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_activity_state_events_time
          ON activity_state_events (event_ts);
      `)
    },
  },
  {
    version: 10,
    description: 'Add persisted timeline, artifacts, workflows, caches, and block label overrides',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS timeline_blocks (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          block_kind TEXT NOT NULL,
          dominant_category TEXT NOT NULL,
          category_distribution_json TEXT NOT NULL DEFAULT '{}',
          switch_count INTEGER NOT NULL DEFAULT 0,
          label_current TEXT NOT NULL,
          label_source TEXT NOT NULL DEFAULT 'rule',
          label_confidence REAL NOT NULL DEFAULT 0.5,
          narrative_current TEXT,
          evidence_summary_json TEXT NOT NULL DEFAULT '{}',
          is_live INTEGER NOT NULL DEFAULT 0,
          heuristic_version TEXT NOT NULL,
          computed_at INTEGER NOT NULL,
          invalidated_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_timeline_blocks_date
          ON timeline_blocks (date, start_time);
        CREATE INDEX IF NOT EXISTS idx_timeline_blocks_valid
          ON timeline_blocks (date, invalidated_at, start_time);

        CREATE TABLE IF NOT EXISTS timeline_block_members (
          block_id TEXT NOT NULL REFERENCES timeline_blocks(id) ON DELETE CASCADE,
          member_type TEXT NOT NULL,
          member_id TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          weight_seconds INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (block_id, member_type, member_id)
        );
        CREATE INDEX IF NOT EXISTS idx_timeline_block_members_member
          ON timeline_block_members (member_type, member_id);

        CREATE TABLE IF NOT EXISTS timeline_block_labels (
          id TEXT PRIMARY KEY,
          block_id TEXT NOT NULL REFERENCES timeline_blocks(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          narrative TEXT,
          source TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          created_at INTEGER NOT NULL,
          model_info_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_timeline_block_labels_block
          ON timeline_block_labels (block_id, created_at);

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          artifact_type TEXT NOT NULL,
          canonical_key TEXT NOT NULL UNIQUE,
          display_title TEXT NOT NULL,
          url TEXT,
          path TEXT,
          host TEXT,
          canonical_app_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_type
          ON artifacts (artifact_type, last_seen_at);

        CREATE TABLE IF NOT EXISTS artifact_mentions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          evidence_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_mentions_source
          ON artifact_mentions (source_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_artifact_mentions_artifact
          ON artifact_mentions (artifact_id, start_time);

        CREATE TABLE IF NOT EXISTS app_profile_cache (
          canonical_app_id TEXT NOT NULL,
          range_key TEXT NOT NULL,
          character_json TEXT NOT NULL DEFAULT '{}',
          top_artifacts_json TEXT NOT NULL DEFAULT '[]',
          paired_apps_json TEXT NOT NULL DEFAULT '[]',
          top_block_ids_json TEXT NOT NULL DEFAULT '[]',
          computed_at INTEGER NOT NULL,
          PRIMARY KEY (canonical_app_id, range_key)
        );

        CREATE TABLE IF NOT EXISTS workflow_signatures (
          id TEXT PRIMARY KEY,
          signature_key TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          dominant_category TEXT NOT NULL,
          canonical_apps_json TEXT NOT NULL DEFAULT '[]',
          artifact_keys_json TEXT NOT NULL DEFAULT '[]',
          rule_version TEXT NOT NULL,
          computed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workflow_occurrences (
          workflow_id TEXT NOT NULL REFERENCES workflow_signatures(id) ON DELETE CASCADE,
          block_id TEXT NOT NULL REFERENCES timeline_blocks(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          PRIMARY KEY (workflow_id, block_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_occurrences_date
          ON workflow_occurrences (date, workflow_id);

        CREATE TABLE IF NOT EXISTS block_label_overrides (
          block_id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          narrative TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 11,
    description: 'Backfill canonical app/browser identity and normalized page keys',
    up: () => {
      const db = getDb()

      // Some older local databases report earlier versions as applied but still
      // lack the identity columns. Repair those schemas before backfilling.
      ensureAppSessionIdentityColumns()
      ensureWebsiteVisitIdentityColumns()

      const sessionRows = db.prepare(`
        SELECT id, bundle_id, app_name
        FROM app_sessions
        WHERE canonical_app_id IS NULL OR app_instance_id IS NULL OR raw_app_name IS NULL
      `).all() as { id: number; bundle_id: string; app_name: string }[]

      const updateSession = db.prepare(`
        UPDATE app_sessions
        SET raw_app_name = ?,
            canonical_app_id = ?,
            app_instance_id = ?
        WHERE id = ?
      `)

      for (const row of sessionRows) {
        const identity = resolveCanonicalApp(row.bundle_id, row.app_name)
        updateSession.run(identity.rawAppName, identity.canonicalAppId, identity.appInstanceId, row.id)
      }

      const visitRows = db.prepare(`
        SELECT id, browser_bundle_id, url
        FROM website_visits
        WHERE canonical_browser_id IS NULL OR browser_profile_id IS NULL OR normalized_url IS NULL OR page_key IS NULL
      `).all() as { id: number; browser_bundle_id: string | null; url: string | null }[]

      const updateVisit = db.prepare(`
        UPDATE website_visits
        SET canonical_browser_id = ?,
            browser_profile_id = ?,
            normalized_url = ?,
            page_key = ?
        WHERE id = ?
      `)

      for (const row of visitRows) {
        const browserIdentity = resolveCanonicalBrowser(row.browser_bundle_id)
        updateVisit.run(
          browserIdentity.canonicalBrowserId,
          browserIdentity.browserProfileId,
          normalizeUrlForStorage(row.url),
          pageKeyForUrl(row.url),
          row.id,
        )
      }
    },
  },
  {
    version: 12,
    description: 'Clear workflow signatures so labels regenerate with display names',
    up: () => {
      const db = getDb()
      db.exec('DELETE FROM workflow_occurrences')
      db.exec('DELETE FROM workflow_signatures')
    },
  },
  {
    version: 13,
    description: 'Repair identity column drift and create derived-state metadata tables',
    up: () => {
      const db = getDb()

      ensureAppSessionIdentityColumns()
      ensureWebsiteVisitIdentityColumns()
      backfillAppSessionsIdentity()
      backfillWebsiteIdentity()

      db.exec(`
        CREATE TABLE IF NOT EXISTS app_identities (
          app_instance_id TEXT PRIMARY KEY,
          bundle_id TEXT NOT NULL,
          raw_app_name TEXT NOT NULL,
          canonical_app_id TEXT,
          display_name TEXT NOT NULL,
          default_category TEXT,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_app_identities_canonical
          ON app_identities (canonical_app_id, last_seen_at);

        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'active',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_client
          ON projects (client_id, updated_at);

        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT REFERENCES workflow_signatures(id) ON DELETE CASCADE,
          block_id TEXT REFERENCES timeline_blocks(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_date
          ON workflow_runs (date, start_time);

        CREATE TABLE IF NOT EXISTS block_attributions (
          id TEXT PRIMARY KEY,
          block_id TEXT NOT NULL REFERENCES timeline_blocks(id) ON DELETE CASCADE,
          attribution_type TEXT NOT NULL,
          subject_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_block_attributions_block
          ON block_attributions (block_id, subject_type);
        CREATE INDEX IF NOT EXISTS idx_block_attributions_subject
          ON block_attributions (subject_type, subject_id);

        CREATE TABLE IF NOT EXISTS artifact_links (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          linked_subject_type TEXT NOT NULL,
          linked_subject_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_links_artifact
          ON artifact_links (artifact_id, relation_type);
        CREATE INDEX IF NOT EXISTS idx_artifact_links_subject
          ON artifact_links (linked_subject_type, linked_subject_id);

        CREATE TABLE IF NOT EXISTS derived_state_versions (
          component TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          rebuild_required INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rebuild_jobs (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          reason TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_rebuild_jobs_scope
          ON rebuild_jobs (scope, started_at DESC);
      `)
    },
  },
  {
    version: 14,
    description: 'Rewrite to attribution-first schema (work_sessions, segments, evidence, rollups)',
    up: () => {
      const db = getDb()
      const now = Date.now()

      // ── 1a. Drop tables that are entirely replaced or no longer used. ─────
      // workflow_runs / block_attributions / artifact_links / app_profile_cache
      // were the old app-centric attribution model. daily_summaries is replaced
      // by daily_entity_rollups.
      db.exec(`
        DROP TABLE IF EXISTS workflow_runs;
        DROP TABLE IF EXISTS block_attributions;
        DROP TABLE IF EXISTS artifact_links;
        DROP TABLE IF EXISTS app_profile_cache;
        DROP TABLE IF EXISTS daily_summaries;
      `)

      // ── 1b. Migrate the existing clients/projects tables to the new shape.
      // Old shape: (id, slug, display_name, status, metadata_json, ...)
      // New shape: (id, name UNIQUE, color, status, created_at,
      // updated_at) and projects gain code/color and lose metadata.
      const existingClients = (() => {
        try {
          return db.prepare(`
            SELECT id, display_name, status, created_at, updated_at FROM clients
          `).all() as { id: string; display_name: string; status: string; created_at: number; updated_at: number }[]
        } catch {
          return [] as { id: string; display_name: string; status: string; created_at: number; updated_at: number }[]
        }
      })()
      const existingProjects = (() => {
        try {
          return db.prepare(`
            SELECT id, client_id, display_name, status, created_at, updated_at FROM projects
          `).all() as { id: string; client_id: string | null; display_name: string; status: string; created_at: number; updated_at: number }[]
        } catch {
          return [] as { id: string; client_id: string | null; display_name: string; status: string; created_at: number; updated_at: number }[]
        }
      })()

      db.exec(`
        DROP TABLE IF EXISTS projects;
        DROP TABLE IF EXISTS clients;

        CREATE TABLE IF NOT EXISTS clients (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          color       TEXT,
          status      TEXT NOT NULL DEFAULT 'active',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS client_aliases (
          id               TEXT PRIMARY KEY,
          client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          alias            TEXT NOT NULL,
          alias_normalized TEXT NOT NULL,
          source           TEXT NOT NULL,
          created_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_client_aliases_norm ON client_aliases (alias_normalized);
        CREATE INDEX IF NOT EXISTS idx_client_aliases_client ON client_aliases (client_id);

        CREATE TABLE IF NOT EXISTS projects (
          id          TEXT PRIMARY KEY,
          client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          code        TEXT,
          color       TEXT,
          status      TEXT NOT NULL DEFAULT 'active',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_client ON projects (client_id, status);

        CREATE TABLE IF NOT EXISTS project_aliases (
          id               TEXT PRIMARY KEY,
          project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          alias            TEXT NOT NULL,
          alias_normalized TEXT NOT NULL,
          source           TEXT NOT NULL,
          created_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_aliases_norm ON project_aliases (alias_normalized);
        CREATE INDEX IF NOT EXISTS idx_project_aliases_project ON project_aliases (project_id);
      `)

      const insertClient = db.prepare(`
        INSERT OR IGNORE INTO clients (id, name, color, status, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?)
      `)
      for (const row of existingClients) {
        insertClient.run(row.id, row.display_name, row.status || 'active', row.created_at, row.updated_at)
      }
      const insertProject = db.prepare(`
        INSERT OR IGNORE INTO projects (id, client_id, name, code, color, status, created_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
      `)
      for (const row of existingProjects) {
        if (!row.client_id) continue
        insertProject.run(row.id, row.client_id, row.display_name, row.status || 'active', row.created_at, row.updated_at)
      }

      // ── 1c. Build all new tables in the current layered schema. ───────────
      db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id          TEXT PRIMARY KEY,
          hostname    TEXT NOT NULL,
          platform    TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS apps (
          bundle_id        TEXT PRIMARY KEY,
          app_name         TEXT NOT NULL,
          category         TEXT NOT NULL,
          attention_class  TEXT NOT NULL,
          default_weight   REAL NOT NULL DEFAULT 1.0,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS raw_window_sessions (
          id                TEXT PRIMARY KEY,
          device_id         TEXT NOT NULL,
          bundle_id         TEXT NOT NULL,
          process_id        INTEGER,
          window_title      TEXT,
          started_at        INTEGER NOT NULL,
          ended_at          INTEGER NOT NULL,
          duration_ms       INTEGER NOT NULL,
          is_frontmost      INTEGER NOT NULL,
          input_events      INTEGER NOT NULL,
          keystrokes        INTEGER NOT NULL,
          mouse_events      INTEGER NOT NULL,
          scroll_events     INTEGER NOT NULL,
          idle_ms           INTEGER NOT NULL,
          privacy_redacted  INTEGER NOT NULL,
          created_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_raw_window_sessions_time ON raw_window_sessions (started_at);

        CREATE TABLE IF NOT EXISTS browser_context_events (
          id                       TEXT PRIMARY KEY,
          raw_window_session_id    TEXT NOT NULL,
          bundle_id                TEXT NOT NULL,
          tab_url                  TEXT,
          domain                   TEXT,
          registrable_domain       TEXT,
          tab_title                TEXT,
          page_path                TEXT,
          started_at               INTEGER NOT NULL,
          ended_at                 INTEGER NOT NULL,
          duration_ms              INTEGER NOT NULL,
          is_active_tab            INTEGER NOT NULL,
          created_at               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_browser_context_events_time ON browser_context_events (started_at);
        CREATE INDEX IF NOT EXISTS idx_browser_context_events_domain ON browser_context_events (registrable_domain, started_at);

        CREATE TABLE IF NOT EXISTS file_activity_events (
          id                     TEXT PRIMARY KEY,
          raw_window_session_id  TEXT,
          bundle_id              TEXT NOT NULL,
          file_path              TEXT NOT NULL,
          file_name              TEXT NOT NULL,
          file_ext               TEXT,
          project_root           TEXT,
          repo_remote_url        TEXT,
          operation              TEXT NOT NULL,
          started_at             INTEGER NOT NULL,
          ended_at               INTEGER,
          duration_ms            INTEGER,
          created_at             INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_activity_time ON file_activity_events (started_at);

        CREATE TABLE IF NOT EXISTS idle_periods (
          id          TEXT PRIMARY KEY,
          device_id   TEXT NOT NULL,
          started_at  INTEGER NOT NULL,
          ended_at    INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          reason      TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_idle_periods_time ON idle_periods (started_at);

        CREATE TABLE IF NOT EXISTS attribution_rules (
          id              TEXT PRIMARY KEY,
          client_id       TEXT,
          project_id      TEXT,
          signal_type     TEXT NOT NULL,
          operator        TEXT NOT NULL,
          pattern         TEXT NOT NULL,
          scope_bundle_id TEXT,
          weight          REAL NOT NULL,
          source          TEXT NOT NULL,
          status          TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attribution_rules_status ON attribution_rules (status, signal_type);

        CREATE TABLE IF NOT EXISTS entity_suggestions (
          id               TEXT PRIMARY KEY,
          client_id        TEXT,
          project_id       TEXT,
          suggestion_type  TEXT NOT NULL,
          label            TEXT,
          top_signals_json TEXT NOT NULL,
          sample_count     INTEGER NOT NULL,
          status           TEXT NOT NULL,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_entity_suggestions_status ON entity_suggestions (status, suggestion_type);

        CREATE TABLE IF NOT EXISTS activity_segments (
          id                    TEXT PRIMARY KEY,
          device_id             TEXT NOT NULL,
          started_at            INTEGER NOT NULL,
          ended_at              INTEGER NOT NULL,
          duration_ms           INTEGER NOT NULL,
          primary_bundle_id     TEXT NOT NULL,
          window_title          TEXT,
          domain                TEXT,
          file_path             TEXT,
          input_score           REAL NOT NULL,
          attention_score       REAL NOT NULL,
          idle_ratio            REAL NOT NULL,
          class                 TEXT NOT NULL,
          raw_session_ids_json  TEXT NOT NULL,
          created_at            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_segments_time ON activity_segments (started_at);
        CREATE INDEX IF NOT EXISTS idx_activity_segments_device_time ON activity_segments (device_id, started_at);

        CREATE TABLE IF NOT EXISTS segment_attributions (
          id                    TEXT PRIMARY KEY,
          segment_id            TEXT NOT NULL REFERENCES activity_segments(id) ON DELETE CASCADE,
          client_id             TEXT,
          project_id            TEXT,
          score                 REAL NOT NULL,
          confidence            REAL NOT NULL,
          rank                  INTEGER NOT NULL,
          decision_source       TEXT NOT NULL,
          matched_signals_json  TEXT NOT NULL,
          created_at            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_segment_attributions_segment ON segment_attributions (segment_id, rank);
        CREATE INDEX IF NOT EXISTS idx_segment_attributions_client ON segment_attributions (client_id);

        CREATE TABLE IF NOT EXISTS work_sessions (
          id                       TEXT PRIMARY KEY,
          device_id                TEXT NOT NULL,
          started_at               INTEGER NOT NULL,
          ended_at                 INTEGER NOT NULL,
          duration_ms              INTEGER NOT NULL,
          active_ms                INTEGER NOT NULL,
          idle_ms                  INTEGER NOT NULL,
          client_id                TEXT,
          project_id               TEXT,
          attribution_status       TEXT NOT NULL,
          attribution_confidence   REAL,
          title                    TEXT,
          primary_bundle_id        TEXT,
          app_bundle_ids_json      TEXT NOT NULL,
          created_at               INTEGER NOT NULL,
          updated_at               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_work_sessions_time ON work_sessions (started_at);
        CREATE INDEX IF NOT EXISTS idx_work_sessions_client ON work_sessions (client_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_work_sessions_project ON work_sessions (project_id, started_at);

        CREATE TABLE IF NOT EXISTS work_session_segments (
          work_session_id  TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
          segment_id       TEXT NOT NULL,
          role             TEXT NOT NULL,
          contribution_ms  INTEGER NOT NULL,
          PRIMARY KEY (work_session_id, segment_id)
        );

        CREATE TABLE IF NOT EXISTS work_session_evidence (
          id                 TEXT PRIMARY KEY,
          work_session_id    TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
          evidence_type      TEXT NOT NULL,
          evidence_value     TEXT NOT NULL,
          weight             REAL NOT NULL,
          source_segment_id  TEXT,
          created_at         INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_work_session_evidence_session
          ON work_session_evidence (work_session_id, weight);

        CREATE TABLE IF NOT EXISTS daily_entity_rollups (
          day_local       TEXT NOT NULL,
          timezone        TEXT NOT NULL,
          client_id       TEXT,
          project_id      TEXT,
          attributed_ms   INTEGER NOT NULL,
          ambiguous_ms    INTEGER NOT NULL,
          session_count   INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          PRIMARY KEY (day_local, timezone, client_id, project_id)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_entity_rollups_client
          ON daily_entity_rollups (client_id, day_local);
        CREATE INDEX IF NOT EXISTS idx_daily_entity_rollups_project
          ON daily_entity_rollups (project_id, day_local);
      `)

      // ── 1d. Seed apps from existing app_identities + category_overrides. ───
      // attention_class is derived from category (focus/supporting/ambient).
      try {
        const overrides = db.prepare(`SELECT bundle_id, category FROM category_overrides`).all() as {
          bundle_id: string; category: string
        }[]
        const overrideMap = new Map(overrides.map((row) => [row.bundle_id, row.category]))

        // app_identities is keyed by app_instance_id but we want one row per
        // bundle_id. Pick the most-recently-seen identity per bundle.
        const identityRows = db.prepare(`
          SELECT bundle_id, display_name, default_category, last_seen_at
          FROM app_identities
          ORDER BY last_seen_at DESC
        `).all() as { bundle_id: string; display_name: string; default_category: string | null; last_seen_at: number }[]

        const seen = new Set<string>()
        const insertApp = db.prepare(`
          INSERT OR IGNORE INTO apps (bundle_id, app_name, category, attention_class, default_weight, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        for (const row of identityRows) {
          if (seen.has(row.bundle_id)) continue
          seen.add(row.bundle_id)
          const category = overrideMap.get(row.bundle_id)
            ?? row.default_category
            ?? 'uncategorized'
          const attention = attentionClassForCategory(category)
          insertApp.run(row.bundle_id, row.display_name, category, attention, 1.0, now, now)
        }

        // Backstop: any bundle we've seen in app_sessions but not yet in apps.
        const sessionBundles = db.prepare(`
          SELECT bundle_id, MAX(app_name) AS app_name
          FROM app_sessions
          GROUP BY bundle_id
        `).all() as { bundle_id: string; app_name: string }[]
        for (const row of sessionBundles) {
          if (seen.has(row.bundle_id)) continue
          seen.add(row.bundle_id)
          const category = overrideMap.get(row.bundle_id) ?? 'uncategorized'
          const attention = attentionClassForCategory(category)
          insertApp.run(row.bundle_id, row.app_name, category, attention, 1.0, now, now)
        }
      } catch (error) {
        console.warn('[migrations] v14 apps seed skipped:', error)
      }
    },
  },
  {
    version: 15,
    description: 'Add AI usage telemetry table for per-job provider/model accounting',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_usage_events (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          screen TEXT NOT NULL,
          trigger_source TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          success INTEGER NOT NULL DEFAULT 0,
          failure_reason TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          latency_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          cache_hit INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_events_started_at
          ON ai_usage_events (started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_events_job_type
          ON ai_usage_events (job_type, started_at DESC);
      `)
    },
  },
  {
    version: 16,
    description: 'Persist live app session snapshots for crash recovery',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS live_app_session_snapshot (
          singleton        INTEGER PRIMARY KEY CHECK(singleton = 1),
          bundle_id        TEXT    NOT NULL,
          app_name         TEXT    NOT NULL,
          window_title     TEXT,
          raw_app_name     TEXT,
          canonical_app_id TEXT,
          app_instance_id  TEXT,
          capture_source   TEXT    NOT NULL DEFAULT 'foreground_poll',
          category         TEXT    NOT NULL DEFAULT 'uncategorized',
          start_time       INTEGER NOT NULL,
          last_seen_at     INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 17,
    description: 'Persist AI thread metadata and conversation state',
    up: () => {
      const db = getDb()
      if (!hasColumn('ai_messages', 'metadata_json')) {
        db.exec(`ALTER TABLE ai_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`)
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_conversation_state (
          conversation_id INTEGER PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE CASCADE,
          state_json      TEXT    NOT NULL DEFAULT '{}',
          updated_at      INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 18,
    description: 'Persist AI surface summaries for week review and app narratives',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_surface_summaries (
          scope_type      TEXT NOT NULL,
          scope_key       TEXT NOT NULL,
          job_type        TEXT NOT NULL,
          title           TEXT,
          summary_text    TEXT NOT NULL,
          input_signature TEXT NOT NULL,
          metadata_json   TEXT NOT NULL DEFAULT '{}',
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          PRIMARY KEY (scope_type, scope_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_surface_summaries_job
          ON ai_surface_summaries (job_type, updated_at DESC);
      `)
    },
  },
  {
    version: 19,
    description: 'Add ai_threads, ai_artifacts tables and thread_id column on ai_messages (backfilled to per-conversation Imported chat threads)',
    up: () => {
      const db = getDb()
      ensureAIThreadSchema(db)
    },
  },
  {
    version: 20,
    description: 'Repair ai thread schema drift on older local databases',
    up: () => {
      ensureAIThreadSchema(getDb())
    },
  },
  {
    version: 21,
    description: 'Add FTS5 search indexes for sessions, blocks, browser visits, and AI artifacts',
    up: () => {
      ensureSearchSchema(getDb())
    },
  },
  {
    version: 22,
    description: 'Add queryable AI message feedback ratings',
    up: () => {
      ensureAIMessageFeedbackSchema(getDb())
    },
  },
  {
    version: 23,
    description: 'Reserved no-op after removing the iMessage capture table migration',
    up: () => {},
  },
  {
    version: 24,
    description: 'Scrub pipe-joined tab-title soup from persisted timeline_blocks.label_current (B1/B10 backfill)',
    up: () => {
      // BUGS.md B1/B10: the label-writing path now rejects/naturalises
      // pipe-joined strings ("Course | Perusall", "W2_Reading | Intro to ML
      // | Perusall"), but every existing persisted row still carries the
      // old soup. The renderer's safety net (`isUsefulLabel`) then rejects
      // those, leaving the timeline showing the raw string or falling back
      // to a category placeholder.
      //
      // Backfill: rewrite every `label_current` containing ' | ' to the
      // longest content-bearing segment. Generic placeholders (e.g.
      // "Browsing", "Development") are excluded so a soup like
      // "Browsing | Daylens AI refactor" yields "Daylens AI refactor", not
      // "Browsing".
      const db = getDb()
      const GENERIC_LABELS = new Set([
        'AI Tools', 'Browsing', 'Communication', 'Design', 'Development',
        'Email', 'Insufficient Data', 'Insufficient Data For Label',
        'Meetings', 'Mixed Work', 'Productivity', 'Research',
        'Research & AI Chat', 'System', 'Uncategorized', 'Web Session',
      ])
      const naturalize = (value: string): string => {
        const segments = value
          .split(/\s*\|\s*/)
          .map((segment) => segment.trim())
          .filter((segment) => segment.length > 0 && !GENERIC_LABELS.has(segment))
        if (segments.length === 0) return value
        return segments.reduce(
          (best, segment) => segment.length > best.length ? segment : best,
          segments[0],
        )
      }
      const rows = db
        .prepare(`SELECT id, label_current FROM timeline_blocks WHERE label_current LIKE '% | %'`)
        .all() as Array<{ id: string; label_current: string }>
      if (rows.length === 0) return
      const update = db.prepare(`UPDATE timeline_blocks SET label_current = ? WHERE id = ?`)
      const tx = db.transaction((items: Array<{ id: string; label_current: string }>) => {
        for (const row of items) {
          const cleaned = naturalize(row.label_current)
          if (cleaned === row.label_current) continue
          update.run(cleaned, row.id)
        }
      })
      tx(rows)
    },
  },
  {
    version: 25,
    description: 'Invalidate timeline_blocks labels sourced from feed pages so they regenerate',
    up: () => {
      const db = getDb()
      const SOCIAL_FEED_PATTERNS = [
        '%/ X | %',
        '% / X',
        '%| Twitter%',
        '%| Instagram%',
        '%| TikTok%',
        '%reddit.com%',
      ]
      const socialClause = SOCIAL_FEED_PATTERNS.map(() => `label_current LIKE ?`).join(' OR ')
      const result = db
        .prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE invalidated_at IS NULL AND (${socialClause})`)
        .run(Date.now(), ...SOCIAL_FEED_PATTERNS)
      console.log(`[migrations:v25] invalidated ${result.changes} block label(s)`)
    },
  },
  {
    version: 26,
    description: 'Delete stale metric-bearing app narrative summaries so B4 canonical totals cannot drift',
    up: () => {
      const changes = scrubStaleAppNarrativeMetricSummaries(getDb())
      console.log(`[migrations:v26] deleted ${changes} stale app narrative summar${changes === 1 ? 'y' : 'ies'}`)
    },
  },
  {
    version: 27,
    description: 'Add focus_events capture layer (Swift helper ndjson sink)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS focus_events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ts_ms         INTEGER NOT NULL,
          mono_ns       INTEGER NOT NULL,
          event_type    TEXT    NOT NULL CHECK(event_type IN (
            'app_activated',
            'app_deactivated',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock',
            'tab_changed',
            'tab_sampled'
          )),
          app_bundle_id TEXT,
          app_name      TEXT,
          pid           INTEGER,
          window_title  TEXT,
          url           TEXT,
          page_title    TEXT,
          source        TEXT    NOT NULL CHECK(source IN ('nsworkspace_event', 'apple_events_tab')),
          confidence    TEXT    NOT NULL CHECK(confidence IN ('observed', 'unknown')),
          platform      TEXT    NOT NULL DEFAULT 'darwin',
          schema_ver    INTEGER NOT NULL DEFAULT 1 CHECK(schema_ver = 1),
          CHECK(confidence <> 'unknown' OR (url IS NULL AND page_title IS NULL)),
          CHECK(source <> 'nsworkspace_event' OR (url IS NULL AND page_title IS NULL)),
          CHECK(source <> 'apple_events_tab' OR confidence <> 'observed' OR url IS NOT NULL),
          CHECK(source <> 'apple_events_tab' OR event_type IN ('tab_changed', 'tab_sampled')),
          CHECK(source <> 'nsworkspace_event' OR event_type IN (
            'app_activated',
            'app_deactivated',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock'
          ))
        );
        CREATE INDEX IF NOT EXISTS idx_focus_events_ts ON focus_events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_focus_events_type ON focus_events(event_type);
      `)
    },
  },
  {
    version: 28,
    description: 'Add derived session and block projection cache tables',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS derived_sessions (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          date               TEXT    NOT NULL,
          start_ts_ms        INTEGER NOT NULL,
          end_ts_ms          INTEGER NOT NULL,
          active_seconds     INTEGER NOT NULL,
          app_bundle_id      TEXT,
          app_name           TEXT,
          window_title       TEXT,
          url                TEXT,
          page_title         TEXT,
          confidence         TEXT    NOT NULL CHECK(confidence IN ('observed', 'uncertain')),
          category           TEXT    NOT NULL DEFAULT 'uncategorized',
          is_browser         INTEGER NOT NULL DEFAULT 0,
          domain             TEXT,
          projection_version INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_derived_sessions_date_start
          ON derived_sessions (date, start_ts_ms);
        CREATE INDEX IF NOT EXISTS idx_derived_sessions_app
          ON derived_sessions (date, app_bundle_id);

        CREATE TABLE IF NOT EXISTS derived_blocks (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          date               TEXT    NOT NULL,
          start_ts_ms        INTEGER NOT NULL,
          end_ts_ms          INTEGER NOT NULL,
          active_seconds     INTEGER NOT NULL,
          label              TEXT    NOT NULL,
          label_source       TEXT    NOT NULL CHECK(label_source IN ('artifact', 'domain', 'app', 'ai')),
          dominant_category  TEXT,
          confidence         TEXT    NOT NULL CHECK(confidence IN ('observed', 'uncertain')),
          projection_version INTEGER NOT NULL,
          finalized_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_derived_blocks_date_start
          ON derived_blocks (date, start_ts_ms);
        CREATE INDEX IF NOT EXISTS idx_derived_blocks_version
          ON derived_blocks (projection_version);

        CREATE TABLE IF NOT EXISTS derived_block_sessions (
          block_id   INTEGER NOT NULL REFERENCES derived_blocks(id) ON DELETE CASCADE,
          session_id INTEGER NOT NULL REFERENCES derived_sessions(id) ON DELETE CASCADE,
          PRIMARY KEY (block_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_derived_block_sessions_session
          ON derived_block_sessions (session_id);

        CREATE TABLE IF NOT EXISTS derived_projection_runs (
          date               TEXT PRIMARY KEY,
          projection_version INTEGER NOT NULL,
          events_in          INTEGER NOT NULL,
          sessions_out       INTEGER NOT NULL,
          blocks_out         INTEGER NOT NULL,
          finalized_at       INTEGER NOT NULL,
          started_at         INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_derived_projection_runs_version
          ON derived_projection_runs (projection_version);
      `)
    },
  },
  {
    version: 29,
    description: 'Add local work memory pattern tables',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS context_patterns (
          id                  TEXT PRIMARY KEY,
          pattern_type        TEXT NOT NULL CHECK(pattern_type IN ('app_combo', 'window_match', 'domain_match', 'override')),
          pattern_key         TEXT NOT NULL UNIQUE,
          label_suggestion    TEXT NOT NULL,
          category_suggestion TEXT,
          confidence          REAL NOT NULL DEFAULT 0.5,
          recall_count        INTEGER NOT NULL DEFAULT 1,
          status              TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'promoted', 'decayed', 'ignored')),
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          last_recalled_at    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_context_patterns_status ON context_patterns (status, confidence);
        CREATE INDEX IF NOT EXISTS idx_context_patterns_key ON context_patterns (pattern_key);

        CREATE TABLE IF NOT EXISTS pattern_occurrences (
          id                  TEXT PRIMARY KEY,
          pattern_id          TEXT NOT NULL REFERENCES context_patterns(id) ON DELETE CASCADE,
          block_id            TEXT NOT NULL,
          matched_at          INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pattern_occurrences_pattern ON pattern_occurrences (pattern_id);
        CREATE INDEX IF NOT EXISTS idx_pattern_occurrences_block ON pattern_occurrences (block_id);

        CREATE TABLE IF NOT EXISTS user_memory_facts (
          id                  TEXT PRIMARY KEY,
          fact_type           TEXT NOT NULL CHECK(fact_type IN ('project', 'client', 'preference')),
          fact_key            TEXT NOT NULL UNIQUE,
          subject             TEXT NOT NULL,
          fact_value_json     TEXT NOT NULL DEFAULT '{}',
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_memory_facts_type ON user_memory_facts (fact_type);

        CREATE TABLE IF NOT EXISTS daily_memory_archive (
          date                TEXT PRIMARY KEY,
          archive_markdown    TEXT NOT NULL,
          archive_json        TEXT NOT NULL,
          created_at          INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 30,
    description: 'Add hot-path index for focus session lookups',
    up: () => {
      // Only idx_focus_sessions_start is created here. The (bundle_id, start_time)
      // and timeline_block_members(block_id) indexes this migration used to add
      // were redundant: the former duplicates the UNIQUE idx_app_sessions_dedup
      // (v3) and the latter duplicates the timeline_block_members PRIMARY KEY
      // leading column. Existing DBs that already ran the old v30 keep those
      // harmless extra indexes; new installs no longer create them.
      getDb().exec(`
        CREATE INDEX IF NOT EXISTS idx_focus_sessions_start
          ON focus_sessions (start_time);
      `)
    },
  },
  {
    version: 31,
    description: 'Add startup maintenance run markers',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS maintenance_runs (
          key TEXT PRIMARY KEY,
          completed_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 32,
    description: 'Add timeline block review states and correction lineage',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS timeline_block_reviews (
          id TEXT PRIMARY KEY,
          block_id TEXT NOT NULL,
          date TEXT NOT NULL,
          evidence_key TEXT NOT NULL,
          review_state TEXT NOT NULL CHECK(review_state IN ('auto-approved', 'pending', 'approved', 'corrected', 'ignored')),
          original_block_json TEXT NOT NULL DEFAULT '{}',
          correction_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_block_reviews_block
          ON timeline_block_reviews (block_id);
        CREATE INDEX IF NOT EXISTS idx_timeline_block_reviews_evidence
          ON timeline_block_reviews (date, evidence_key, updated_at);
        CREATE INDEX IF NOT EXISTS idx_timeline_block_reviews_state
          ON timeline_block_reviews (review_state, updated_at);
      `)
    },
  },
  {
    version: 33,
    description: 'Add user episode boundary corrections (split/merge correction memory)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS timeline_boundary_corrections (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          left_session_id INTEGER NOT NULL,
          right_session_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('split', 'merge')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_boundary_corrections_pair
          ON timeline_boundary_corrections (left_session_id, right_session_id);
        CREATE INDEX IF NOT EXISTS idx_timeline_boundary_corrections_date
          ON timeline_boundary_corrections (date);
      `)
    },
  },
  {
    version: 34,
    description: 'Add editable work-memory profile facts (ChatGPT-style, replaces opaque patterns)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS work_memory_facts (
          id          TEXT PRIMARY KEY,
          fact_text   TEXT NOT NULL,
          origin      TEXT NOT NULL CHECK(origin IN ('drafted', 'user')),
          status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
          topic_key   TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_work_memory_facts_status
          ON work_memory_facts (status, sort_order);
      `)
    },
  },
  {
    version: 35,
    description: 'Expand focus_events for Windows UIA capture sources and window_changed',
    up: () => {
      getDb().exec(`
        CREATE TABLE focus_events_v35 (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ts_ms         INTEGER NOT NULL,
          mono_ns       INTEGER NOT NULL,
          event_type    TEXT    NOT NULL CHECK(event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock',
            'tab_changed',
            'tab_sampled'
          )),
          app_bundle_id TEXT,
          app_name      TEXT,
          pid           INTEGER,
          window_title  TEXT,
          url           TEXT,
          page_title    TEXT,
          source        TEXT    NOT NULL CHECK(source IN (
            'nsworkspace_event',
            'apple_events_tab',
            'uia_foreground',
            'uia_tab'
          )),
          confidence    TEXT    NOT NULL CHECK(confidence IN ('observed', 'unknown')),
          platform      TEXT    NOT NULL DEFAULT 'darwin',
          schema_ver    INTEGER NOT NULL DEFAULT 1 CHECK(schema_ver = 1),
          CHECK(confidence <> 'unknown' OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground') OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR confidence <> 'observed' OR url IS NOT NULL),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR event_type IN ('tab_changed', 'tab_sampled')),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground') OR event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock'
          ))
        );

        INSERT INTO focus_events_v35 (
          id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
          window_title, url, page_title, source, confidence, platform, schema_ver
        )
        SELECT
          id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
          window_title, url, page_title, source, confidence, platform, schema_ver
        FROM focus_events;

        DROP TABLE focus_events;
        ALTER TABLE focus_events_v35 RENAME TO focus_events;
        CREATE INDEX IF NOT EXISTS idx_focus_events_ts ON focus_events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_focus_events_type ON focus_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_focus_events_platform ON focus_events(platform);
      `)
    },
  },
  {
    version: 36,
    description: 'Add day_snapshots — frozen daily numbers for weekly/monthly/annual wraps',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS day_snapshots (
          date           TEXT    PRIMARY KEY,
          total_active   INTEGER NOT NULL DEFAULT 0,
          work_sec       INTEGER NOT NULL DEFAULT 0,
          leisure_sec    INTEGER NOT NULL DEFAULT 0,
          personal_sec   INTEGER NOT NULL DEFAULT 0,
          facts_json     TEXT    NOT NULL,
          facts_hash     TEXT    NOT NULL,
          finalized_at   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_day_snapshots_date ON day_snapshots (date);
      `)
    },
  },
  {
    version: 37,
    description: 'Memory v2 (DEV-107) — work_memory_facts.source/scope + memory_audit',
    up: () => {
      const db = getDb()
      if (getTableSql('work_memory_facts') != null) {
        if (!hasColumn('work_memory_facts', 'source')) {
          db.exec(`ALTER TABLE work_memory_facts ADD COLUMN source TEXT NOT NULL DEFAULT 'evidence'`)
          // Backfill provenance from the existing origin: drafted facts came
          // from evidence; user-authored facts were hand edits/adds.
          db.prepare(`UPDATE work_memory_facts SET source = 'hand' WHERE origin = 'user'`).run()
        }
        if (!hasColumn('work_memory_facts', 'scope')) {
          db.exec(`ALTER TABLE work_memory_facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'general'`)
        }
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_work_memory_facts_scope ON work_memory_facts (scope, status);
        CREATE TABLE IF NOT EXISTS memory_audit (
          id          TEXT PRIMARY KEY,
          action      TEXT NOT NULL CHECK(action IN ('remembered', 'updated', 'forgot')),
          fact_text   TEXT NOT NULL,
          source      TEXT NOT NULL CHECK(source IN ('chat', 'hand')),
          scope       TEXT NOT NULL DEFAULT 'general',
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_audit_created ON memory_audit (created_at DESC);
      `)
    },
  },
  {
    version: 38,
    description: 'Add honest AI cost and billing-mode fields for Billing & Usage',
    up: () => {
      const db = getDb()
      if (!hasColumn('ai_usage_events', 'cost_usd')) {
        db.exec(`ALTER TABLE ai_usage_events ADD COLUMN cost_usd REAL`)
      }
      if (!hasColumn('ai_usage_events', 'billing_mode')) {
        db.exec(`ALTER TABLE ai_usage_events ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'own_key'`)
      }
    },
  },
  {
    version: 39,
    description: 'Backfill short client aliases (DEV-108) so "Andersen" resolves "Andersen in Rwanda"',
    up: () => {
      const db = getDb()
      if (getTableSql('clients') == null || getTableSql('client_aliases') == null) return
      const clients = db.prepare(`SELECT id, name FROM clients WHERE status = 'active'`).all() as Array<{ id: string; name: string }>
      const now = Date.now()
      const insert = db.prepare(`
        INSERT INTO client_aliases (id, client_id, alias, alias_normalized, source, created_at)
        VALUES (?, ?, ?, ?, 'derived', ?)
      `)
      for (const client of clients) {
        const tokens = deriveClientAliasTokens(client.name)
        if (tokens.length === 0) continue
        const existing = new Set(
          (db.prepare(`SELECT alias_normalized FROM client_aliases WHERE client_id = ?`).all(client.id) as { alias_normalized: string }[])
            .map((r) => r.alias_normalized),
        )
        for (const token of tokens) {
          if (existing.has(token)) continue
          insert.run(randomUUID(), client.id, token, token, now)
          existing.add(token)
        }
      }
    },
  },
  {
    version: 40,
    description: 'Add wrapped_narratives — persist a generated wrap so it is shown on open, not regenerated (DEV-118)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS wrapped_narratives (
          cadence        TEXT    NOT NULL,
          period_key     TEXT    NOT NULL,
          facts_hash     TEXT    NOT NULL,
          narrative_json TEXT    NOT NULL,
          generated_at   INTEGER NOT NULL,
          PRIMARY KEY (cadence, period_key)
        );
      `)
    },
  },
  {
    version: 41,
    description: 'Key merge corrections by time span — session ids live in two namespaces (app_sessions today, derived_sessions on past days), so id-keyed merges silently stopped re-applying once the day flipped read paths',
    up: () => {
      const db = getDb()
      if (!hasColumn('timeline_boundary_corrections', 'span_start_ms')) {
        db.exec(`ALTER TABLE timeline_boundary_corrections ADD COLUMN span_start_ms INTEGER`)
      }
      if (!hasColumn('timeline_boundary_corrections', 'span_end_ms')) {
        db.exec(`ALTER TABLE timeline_boundary_corrections ADD COLUMN span_end_ms INTEGER`)
      }
    },
  },
  {
    version: 42,
    description: 'Drop the dead capture layer — raw_window_sessions, browser_context_events, file_activity_events, idle_periods were never written to in production (0 rows, 0 writers anywhere in src/); the active pipeline reads app_sessions, website_visits, and activity_state_events instead',
    up: () => {
      getDb().exec(`
        DROP TABLE IF EXISTS raw_window_sessions;
        DROP TABLE IF EXISTS browser_context_events;
        DROP TABLE IF EXISTS file_activity_events;
        DROP TABLE IF EXISTS idle_periods;
      `)
    },
  },
  {
    version: 43,
    description: 'external_signals — per-day results from optional local connectors (git commits, calendar events, focus apps). One row per date+source, replaced on refresh; feeds the Wrapped data layer (wrapped Stage 0.2)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS external_signals (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          date         TEXT    NOT NULL,
          source       TEXT    NOT NULL,
          payload_json TEXT    NOT NULL,
          captured_at  INTEGER NOT NULL,
          UNIQUE(date, source)
        );
        CREATE INDEX IF NOT EXISTS idx_external_signals_date ON external_signals (date);
      `)
    },
  },
  {
    version: 44,
    description: 'Provider circuit breaker state + ai_usage_events daily rollup — persist quota/credit cooldowns across restarts, and give the telemetry retention job (aiUsageRetention.ts) a compact aggregate to roll old per-event rows into (W1-B: 888k rows / ~364 MB of ai_usage_events in the largest real DB)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS provider_breaker_state (
          provider            TEXT PRIMARY KEY,
          opened_at           INTEGER NOT NULL,
          cooldown_until      INTEGER NOT NULL,
          reason              TEXT NOT NULL,
          retry_after_seconds INTEGER,
          updated_at          INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_usage_daily_rollup (
          day                TEXT NOT NULL,
          job_type           TEXT NOT NULL,
          screen             TEXT NOT NULL DEFAULT '',
          trigger_source     TEXT NOT NULL DEFAULT '',
          provider           TEXT NOT NULL DEFAULT '',
          model              TEXT NOT NULL DEFAULT '',
          billing_mode       TEXT NOT NULL DEFAULT 'own_key',
          calls              INTEGER NOT NULL DEFAULT 0,
          successes          INTEGER NOT NULL DEFAULT 0,
          failures           INTEGER NOT NULL DEFAULT 0,
          input_tokens       INTEGER NOT NULL DEFAULT 0,
          output_tokens      INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd           REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (day, job_type, screen, trigger_source, provider, model, billing_mode)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_rollup_day ON ai_usage_daily_rollup (day);
      `)
    },
  },
  {
    version: 45,
    description: 'website_visits_pending — live-observed visits from browsers that cannot report their window mode wait here until the browser\'s own history corroborates them; corroborated rows are promoted to website_visits, the rest are deleted',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS website_visits_pending (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          domain                TEXT    NOT NULL,
          page_title            TEXT,
          url                   TEXT    NOT NULL,
          normalized_url        TEXT,
          page_key              TEXT,
          visit_time            INTEGER NOT NULL,
          visit_time_us         INTEGER NOT NULL,
          duration_sec          INTEGER NOT NULL,
          browser_bundle_id     TEXT    NOT NULL,
          canonical_browser_id  TEXT,
          browser_profile_id    TEXT,
          observed_at           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_website_visits_pending_browser
          ON website_visits_pending (canonical_browser_id, observed_at);
      `)
    },
  },
  {
    version: 46,
    description: 'Canonical evidence contract on focus_events — stable evidence identity, sensitivity, provenance, machine/capture-state kinds, schema v2 (DEV-162)',
    up: () => {
      const db = getDb()
      const hasLegacyTable = getTableSql('focus_events') != null
      const before = hasLegacyTable
        ? (db.prepare('SELECT COUNT(*) AS c FROM focus_events').get() as { c: number }).c
        : 0
      db.exec(`
        CREATE TABLE focus_events_v46 (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          evidence_id       TEXT    NOT NULL DEFAULT (lower(hex(randomblob(16)))) UNIQUE,
          ts_ms             INTEGER NOT NULL,
          mono_ns           INTEGER NOT NULL,
          event_type        TEXT    NOT NULL CHECK(event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock',
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered',
            'tab_changed',
            'tab_sampled'
          )),
          app_bundle_id     TEXT,
          app_name          TEXT,
          pid               INTEGER,
          window_title      TEXT,
          url               TEXT,
          page_title        TEXT,
          source            TEXT    NOT NULL CHECK(source IN (
            'nsworkspace_event',
            'apple_events_tab',
            'uia_foreground',
            'uia_tab',
            'capture_supervisor'
          )),
          confidence        TEXT    NOT NULL CHECK(confidence IN ('observed', 'corroborated', 'inferred', 'unknown')),
          platform          TEXT    NOT NULL DEFAULT 'darwin',
          sensitivity       TEXT    NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          provenance_method TEXT    NOT NULL DEFAULT 'unknown',
          permission_scope  TEXT    NOT NULL DEFAULT 'unknown',
          policy_version    INTEGER NOT NULL DEFAULT 0,
          schema_ver        INTEGER NOT NULL DEFAULT 2 CHECK(schema_ver = 2),
          CHECK(confidence <> 'unknown' OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground') OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR confidence <> 'observed' OR url IS NOT NULL),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR event_type IN ('tab_changed', 'tab_sampled')),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground') OR event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock'
          )),
          CHECK(source <> 'capture_supervisor' OR event_type IN (
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered'
          )),
          CHECK(event_type NOT IN (
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered'
          ) OR source = 'capture_supervisor'),
          CHECK(source <> 'capture_supervisor' OR (
            app_bundle_id IS NULL AND app_name IS NULL AND window_title IS NULL
            AND url IS NULL AND page_title IS NULL
          ))
        );

        CREATE UNIQUE INDEX idx_focus_events_identity ON focus_events_v46 (
          source, event_type, ts_ms, mono_ns,
          COALESCE(app_bundle_id, ''), COALESCE(app_name, ''),
          COALESCE(pid, -1), COALESCE(window_title, ''), COALESCE(url, ''),
          COALESCE(page_title, ''), confidence, platform
        );
      `)
      if (hasLegacyTable) {
        db.exec(`
          INSERT OR IGNORE INTO focus_events_v46 (
            id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
            window_title, url, page_title, source, confidence, platform,
            provenance_method, permission_scope, policy_version, schema_ver
          )
          SELECT
            id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
            window_title, url, page_title, source, confidence, platform,
            source,
            CASE source
              WHEN 'nsworkspace_event' THEN 'macos_foreground_observation'
              WHEN 'apple_events_tab'  THEN 'macos_apple_events_automation'
              WHEN 'uia_foreground'    THEN 'windows_uia_foreground'
              WHEN 'uia_tab'           THEN 'windows_uia_foreground'
              ELSE 'unknown'
            END,
            0, 2
          FROM focus_events
          ORDER BY id;

          DROP TABLE focus_events;
        `)
      }
      db.exec(`
        ALTER TABLE focus_events_v46 RENAME TO focus_events;
        CREATE INDEX IF NOT EXISTS idx_focus_events_ts ON focus_events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_focus_events_type ON focus_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_focus_events_platform ON focus_events(platform);
      `)
      const after = (db.prepare('SELECT COUNT(*) AS c FROM focus_events').get() as { c: number }).c
      if (after !== before) {
        console.log(`[migrations:v46] collapsed ${before - after} duplicate focus event${before - after === 1 ? '' : 's'} (identical source identity and content)`)
      }
    },
  },
  {
    version: 47,
    description: 'Admit the foreground_poll adapter into canonical focus_events — the interval sampler emits the same application/window/machine-state family as the native helpers (DEV-163)',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE focus_events_v47 (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          evidence_id       TEXT    NOT NULL DEFAULT (lower(hex(randomblob(16)))) UNIQUE,
          ts_ms             INTEGER NOT NULL,
          mono_ns           INTEGER NOT NULL,
          event_type        TEXT    NOT NULL CHECK(event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock',
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered',
            'tab_changed',
            'tab_sampled'
          )),
          app_bundle_id     TEXT,
          app_name          TEXT,
          pid               INTEGER,
          window_title      TEXT,
          url               TEXT,
          page_title        TEXT,
          source            TEXT    NOT NULL CHECK(source IN (
            'nsworkspace_event',
            'apple_events_tab',
            'uia_foreground',
            'uia_tab',
            'capture_supervisor',
            'foreground_poll'
          )),
          confidence        TEXT    NOT NULL CHECK(confidence IN ('observed', 'corroborated', 'inferred', 'unknown')),
          platform          TEXT    NOT NULL DEFAULT 'darwin',
          sensitivity       TEXT    NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          provenance_method TEXT    NOT NULL DEFAULT 'unknown',
          permission_scope  TEXT    NOT NULL DEFAULT 'unknown',
          policy_version    INTEGER NOT NULL DEFAULT 0,
          schema_ver        INTEGER NOT NULL DEFAULT 2 CHECK(schema_ver = 2),
          CHECK(confidence <> 'unknown' OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground', 'foreground_poll') OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR confidence <> 'observed' OR url IS NOT NULL),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR event_type IN ('tab_changed', 'tab_sampled')),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground', 'foreground_poll') OR event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock'
          )),
          CHECK(source <> 'capture_supervisor' OR event_type IN (
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered'
          )),
          CHECK(event_type NOT IN (
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered'
          ) OR source = 'capture_supervisor'),
          CHECK(source <> 'capture_supervisor' OR (
            app_bundle_id IS NULL AND app_name IS NULL AND window_title IS NULL
            AND url IS NULL AND page_title IS NULL
          ))
        );

        INSERT INTO focus_events_v47 (
          id, evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
          window_title, url, page_title, source, confidence, platform,
          sensitivity, provenance_method, permission_scope, policy_version, schema_ver
        )
        SELECT
          id, evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
          window_title, url, page_title, source, confidence, platform,
          sensitivity, provenance_method, permission_scope, policy_version, schema_ver
        FROM focus_events
        ORDER BY id;

        DROP TABLE focus_events;
        ALTER TABLE focus_events_v47 RENAME TO focus_events;

        CREATE UNIQUE INDEX idx_focus_events_identity ON focus_events (
          source, event_type, ts_ms, mono_ns,
          COALESCE(app_bundle_id, ''), COALESCE(app_name, ''),
          COALESCE(pid, -1), COALESCE(window_title, ''), COALESCE(url, ''),
          COALESCE(page_title, ''), confidence, platform
        );
        CREATE INDEX IF NOT EXISTS idx_focus_events_ts ON focus_events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_focus_events_type ON focus_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_focus_events_platform ON focus_events(platform);
      `)
    },
  },
  {
    version: 48,
    description:
      'Drop website_visits_pending (unverified page content at rest) and add durable browser history source cursors',
    up: () => {
      const db = getDb()
      db.exec(`
        DROP TABLE IF EXISTS website_visits_pending;
        CREATE TABLE IF NOT EXISTS browser_history_cursors (
          browser_bundle_id TEXT PRIMARY KEY,
          cursor_us         TEXT    NOT NULL,
          updated_at        INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 49,
    description:
      'Reversible evidence exclusions and the correction undo ledger (timeline spec, Corrections)',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS evidence_exclusions (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('app', 'site')),
          bundle_id TEXT,
          app_name TEXT,
          domain TEXT,
          span_start_ms INTEGER NOT NULL,
          span_end_ms INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_exclusions_span
          ON evidence_exclusions (span_start_ms, span_end_ms);
        CREATE TABLE IF NOT EXISTS correction_undo_log (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          kind TEXT NOT NULL,
          description TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          undone_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_correction_undo_log_date
          ON correction_undo_log (date, created_at);
      `)
    },
  },
  {
    version: 50,
    description:
      'Durable entities (memory-and-entities.md, DEV-177): entities, entity_aliases, entity_evidence_refs, entity_relationships; relax projects.client_id to nullable (a project may exist without a client); adopt existing clients, projects, app identities, artifacts, and external signals into the entity store keeping their identifiers',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id                TEXT PRIMARY KEY,
          entity_type       TEXT NOT NULL CHECK(entity_type IN (
            'application', 'page', 'file', 'person', 'meeting', 'repository',
            'project', 'client', 'timeline_block', 'ai_thread'
          )),
          identity_key      TEXT NOT NULL,
          canonical_name    TEXT NOT NULL,
          name_source       TEXT NOT NULL DEFAULT 'inferred' CHECK(name_source IN ('inferred', 'user')),
          origin            TEXT NOT NULL DEFAULT 'observed' CHECK(origin IN ('observed', 'connected', 'supplied', 'inferred')),
          sensitivity       TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          status            TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'merged', 'deleted')),
          merged_into_id    TEXT,
          first_observed_at INTEGER,
          last_observed_at  INTEGER,
          metadata_json     TEXT NOT NULL DEFAULT '{}',
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_identity ON entities (entity_type, identity_key);
        CREATE INDEX IF NOT EXISTS idx_entities_type_status ON entities (entity_type, status, last_observed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON entities (merged_into_id);

        CREATE TABLE IF NOT EXISTS entity_aliases (
          id               TEXT PRIMARY KEY,
          entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          alias            TEXT NOT NULL,
          alias_normalized TEXT NOT NULL,
          raw_label        TEXT,
          source           TEXT NOT NULL DEFAULT 'inferred',
          created_at       INTEGER NOT NULL,
          UNIQUE (entity_id, alias_normalized)
        );
        CREATE INDEX IF NOT EXISTS idx_entity_aliases_norm ON entity_aliases (alias_normalized);

        CREATE TABLE IF NOT EXISTS entity_evidence_refs (
          id            TEXT PRIMARY KEY,
          entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          source_type   TEXT NOT NULL,
          source_id     TEXT NOT NULL,
          span_start_ms INTEGER,
          span_end_ms   INTEGER,
          created_at    INTEGER NOT NULL,
          UNIQUE (entity_id, source_type, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_entity_evidence_refs_source ON entity_evidence_refs (source_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_entity_evidence_refs_entity ON entity_evidence_refs (entity_id);

        CREATE TABLE IF NOT EXISTS entity_relationships (
          id                TEXT PRIMARY KEY,
          entity_id         TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          related_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          kind              TEXT NOT NULL,
          confidence        REAL NOT NULL DEFAULT 0.5,
          source            TEXT NOT NULL DEFAULT 'inferred' CHECK(source IN ('inferred', 'user', 'connected')),
          created_at        INTEGER NOT NULL,
          UNIQUE (entity_id, related_entity_id, kind)
        );
        CREATE INDEX IF NOT EXISTS idx_entity_relationships_related ON entity_relationships (related_entity_id);
      `)

      // Relax the NOT NULL foreign key from projects to clients (spec
      // migration slice 4): SQLite cannot drop NOT NULL in place, so the
      // table is rebuilt. project_aliases rows are backed up first because
      // with foreign_keys ON (the production pragma) dropping the old
      // projects table would cascade-delete them.
      const projectsSql = getTableSql('projects') ?? ''
      if (/client_id\s+TEXT\s+NOT\s+NULL/i.test(projectsSql)) {
        db.exec(`
          CREATE TABLE projects_v50 (
            id          TEXT PRIMARY KEY,
            client_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            code        TEXT,
            color       TEXT,
            status      TEXT NOT NULL DEFAULT 'active',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
          );
          INSERT INTO projects_v50 (id, client_id, name, code, color, status, created_at, updated_at)
            SELECT id, client_id, name, code, color, status, created_at, updated_at FROM projects;
          CREATE TABLE project_aliases_v50_backup AS SELECT * FROM project_aliases;
          -- With foreign_keys ON, DROP TABLE's implicit DELETE raises an FK
          -- violation while child rows exist, so the aliases are cleared first
          -- and restored from the backup once the rebuilt table is in place.
          DELETE FROM project_aliases;
          DROP TABLE projects;
          ALTER TABLE projects_v50 RENAME TO projects;
          INSERT INTO project_aliases (id, project_id, alias, alias_normalized, source, created_at)
            SELECT id, project_id, alias, alias_normalized, source, created_at FROM project_aliases_v50_backup;
          DROP TABLE project_aliases_v50_backup;
          CREATE INDEX IF NOT EXISTS idx_projects_client ON projects (client_id, status);
        `)
      }

      // Adoption backfill (spec migration slice 3, extended per type):
      // idempotent, keeps existing identifiers, never overwrites a
      // user-corrected name.
      runEntityAdoptionBackfill(db)
    },
  },
  {
    version: 51,
    description:
      'Safe agent file access (agent-runtime-and-context.md §File and document access, DEV-184): file_access_grants (three-state grants above the visible-home floor) and file_disclosures (per-request disclosure ledger shaped like the spec ContextDisclosure)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS file_access_grants (
          id                     TEXT PRIMARY KEY,
          scope_kind             TEXT NOT NULL CHECK(scope_kind IN ('file', 'folder')),
          path                   TEXT NOT NULL,
          state                  TEXT NOT NULL CHECK(state IN ('indexed', 'model_readable')),
          allow_high_sensitivity INTEGER NOT NULL DEFAULT 0,
          source                 TEXT NOT NULL DEFAULT 'settings' CHECK(source IN ('settings', 'chat')),
          derived_text           TEXT,
          derived_text_extracted_at INTEGER,
          created_at             INTEGER NOT NULL,
          revoked_at             INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_file_access_grants_active ON file_access_grants (revoked_at, state, path);

        CREATE TABLE IF NOT EXISTS file_disclosures (
          id                  TEXT PRIMARY KEY,
          thread_id           INTEGER,
          message_id          INTEGER,
          file_path           TEXT NOT NULL,
          display_name        TEXT NOT NULL,
          version_fingerprint TEXT NOT NULL,
          excerpt_start       INTEGER NOT NULL,
          excerpt_end         INTEGER NOT NULL,
          reason              TEXT NOT NULL,
          sensitivity         TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          destination         TEXT NOT NULL,
          left_device         INTEGER NOT NULL DEFAULT 1,
          disclosed_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_disclosures_time ON file_disclosures (disclosed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_file_disclosures_thread ON file_disclosures (thread_id, disclosed_at DESC);
      `)
    },
  },
  {
    version: 52,
    description:
      'Exact-retrieval memory records (memory-and-entities.md §Memory record, DEV-178): memory_records projected per day from corrected facts, entity tags for alias-aware retrieval, per-day index bookkeeping, and the memory_records_fts index replacing app_sessions_fts as the session search path. No backfill here — days index in the background and on demand; unindexed days keep serving through the legacy FTS path until then.',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_records (
          id                TEXT PRIMARY KEY,
          record_kind       TEXT NOT NULL CHECK(record_kind IN ('session', 'meeting', 'artifact')),
          memory_type       TEXT NOT NULL CHECK(memory_type IN ('observed', 'connected', 'supplied', 'inferred')),
          statement         TEXT NOT NULL,
          exact_text        TEXT NOT NULL DEFAULT '',
          semantic_text     TEXT,
          date              TEXT NOT NULL,
          start_ms          INTEGER NOT NULL,
          end_ms            INTEGER NOT NULL,
          app_bundle_id     TEXT,
          app_name          TEXT,
          title             TEXT,
          primary_entity_id TEXT,
          source_refs_json  TEXT NOT NULL DEFAULT '[]',
          confidence        TEXT NOT NULL DEFAULT 'observed',
          provenance        TEXT NOT NULL DEFAULT 'capture',
          sensitivity       TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          embedding_model   TEXT,
          embedding_version INTEGER,
          created_at        INTEGER NOT NULL,
          deleted_at        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_memory_records_date ON memory_records (date);
        CREATE INDEX IF NOT EXISTS idx_memory_records_kind_start ON memory_records (record_kind, start_ms DESC);

        CREATE TABLE IF NOT EXISTS memory_record_entities (
          record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
          entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          PRIMARY KEY (record_id, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_record_entities_entity ON memory_record_entities (entity_id);

        CREATE TABLE IF NOT EXISTS memory_index_days (
          date         TEXT PRIMARY KEY,
          fingerprint  TEXT NOT NULL,
          indexed_at   INTEGER NOT NULL,
          record_count INTEGER NOT NULL DEFAULT 0
        );

        -- The per-day input fingerprint scans these by time range.
        CREATE INDEX IF NOT EXISTS idx_entity_evidence_refs_span ON entity_evidence_refs (span_start_ms);
        CREATE INDEX IF NOT EXISTS idx_artifact_mentions_time ON artifact_mentions (start_time);
      `)
      ensureMemorySearchSchema(db)
    },
  },
  {
    version: 53,
    description:
      'Semantic search by meaning (memory-and-entities.md §Local semantic search, DEV-180): memory_record_vectors bookkeeping keyed to memory record ids with ON DELETE CASCADE, so embeddings die with day re-projection and deletions/corrections propagate for free. The float vectors live in the sqlite-vec vec0 virtual table created at runtime by the semantic index (the extension may be absent here); rows without a bookkeeping entry are invisible to queries and garbage-collected in the background. No backfill — records embed in bounded background batches.',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_record_vectors (
          vec_rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
          record_id     TEXT NOT NULL UNIQUE REFERENCES memory_records(id) ON DELETE CASCADE,
          date          TEXT NOT NULL,
          model         TEXT NOT NULL,
          model_version INTEGER NOT NULL,
          dims          INTEGER NOT NULL,
          created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_record_vectors_date ON memory_record_vectors (date);
      `)
    },
  },
  {
    version: 54,
    description:
      'Context packets (agent-runtime-and-context.md §Context packet, DEV-181): one recorded, deterministic disclosure bundle per AI exchange — the generalization of the DEV-184 file_disclosures ledger to every content kind. The full packet (items with identity/version/source-type/reason, disclosure record, content fingerprint) is stored as JSON before the request leaves the local boundary; message_id binds it to the persisted assistant message afterwards. LOCAL-ONLY — no sync-allowlist keys.',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS context_packets (
          id                  TEXT PRIMARY KEY,
          purpose             TEXT NOT NULL CHECK(purpose IN ('answer', 'interpret')),
          exchange_kind       TEXT NOT NULL CHECK(exchange_kind IN ('chat', 'day_analysis')),
          thread_id           INTEGER,
          message_id          INTEGER,
          scope_key           TEXT,
          question            TEXT NOT NULL,
          destination         TEXT NOT NULL,
          left_device         INTEGER NOT NULL DEFAULT 1,
          policy_version      INTEGER NOT NULL,
          item_count          INTEGER NOT NULL,
          content_fingerprint TEXT NOT NULL,
          packet_json         TEXT NOT NULL,
          created_at          INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_packets_message ON context_packets (message_id);
        CREATE INDEX IF NOT EXISTS idx_context_packets_thread ON context_packets (thread_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_context_packets_scope ON context_packets (exchange_kind, scope_key, created_at DESC);
      `)
    },
  },
  {
    version: 55,
    description:
      'Supplied memory (memory-and-entities.md §Conversational memory, §Migration slices 1–2, DEV-185): supplied_memory_facts as the canonical store for explicitly confirmed facts (mirrored into memory_records for retrieval), memory_proposal_rejections so declined proposals are not re-suggested, record_kind widened to admit the supplied_fact mirror rows, and migration slice 1 — user-created or hand-edited work_memory_facts/user_memory_facts rows become supplied memory with their content and creation times; evidence-drafted rows stay behind as inferred proposals (slice 2) and are never silently promoted. LOCAL-ONLY tables — no sync-allowlist keys.',
    up: () => {
      const db = getDb()

      // Widen the record_kind CHECK for the supplied_fact mirror rows. SQLite
      // cannot alter a CHECK in place; memory_records holds only projection
      // rows at this point (supplied rows do not exist before this migration),
      // so it is wiped and rebuilt — days re-project lazily through the
      // fingerprint check and the background backfill, and embeddings rebuild
      // in bounded background batches. Children are cleared first because with
      // foreign_keys ON, DROP TABLE raises an FK violation while child rows
      // exist. Fresh installs already have the widened shape from SCHEMA_SQL.
      const memoryRecordsSql = getTableSql('memory_records') ?? ''
      if (memoryRecordsSql && !memoryRecordsSql.includes('supplied_fact')) {
        db.exec(`
          DELETE FROM memory_record_vectors;
          DELETE FROM memory_record_entities;
          DELETE FROM memory_records;
          DELETE FROM memory_index_days;
          DROP TABLE memory_records;
          CREATE TABLE memory_records (
            id                TEXT PRIMARY KEY,
            record_kind       TEXT NOT NULL CHECK(record_kind IN ('session', 'meeting', 'artifact', 'supplied_fact')),
            memory_type       TEXT NOT NULL CHECK(memory_type IN ('observed', 'connected', 'supplied', 'inferred')),
            statement         TEXT NOT NULL,
            exact_text        TEXT NOT NULL DEFAULT '',
            semantic_text     TEXT,
            date              TEXT NOT NULL,
            start_ms          INTEGER NOT NULL,
            end_ms            INTEGER NOT NULL,
            app_bundle_id     TEXT,
            app_name          TEXT,
            title             TEXT,
            primary_entity_id TEXT,
            source_refs_json  TEXT NOT NULL DEFAULT '[]',
            confidence        TEXT NOT NULL DEFAULT 'observed',
            provenance        TEXT NOT NULL DEFAULT 'capture',
            sensitivity       TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
            embedding_model   TEXT,
            embedding_version INTEGER,
            created_at        INTEGER NOT NULL,
            deleted_at        INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_memory_records_date ON memory_records (date);
          CREATE INDEX IF NOT EXISTS idx_memory_records_kind_start ON memory_records (record_kind, start_ms DESC);
        `)
        // Dropping the table dropped its FTS triggers; recreate them and
        // rebuild the index over the (now empty) content view.
        ensureMemorySearchSchema(db)
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS supplied_memory_facts (
          id           TEXT PRIMARY KEY,
          statement    TEXT NOT NULL,
          scope        TEXT NOT NULL DEFAULT 'general',
          source       TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat', 'hand', 'migrated')),
          context      TEXT,
          thread_id    INTEGER,
          sensitivity  TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          confirmed_at INTEGER NOT NULL,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_supplied_memory_facts_scope ON supplied_memory_facts (scope, confirmed_at DESC);

        CREATE TABLE IF NOT EXISTS memory_proposal_rejections (
          id            TEXT PRIMARY KEY,
          statement     TEXT NOT NULL,
          statement_key TEXT NOT NULL,
          sensitivity   TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          thread_id     INTEGER,
          rejected_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_proposal_rejections_key ON memory_proposal_rejections (statement_key);
      `)

      migrateLegacyUserFactsToSupplied(db)
      reconcileSuppliedMemoryRecords(db)
    },
  },
  {
    version: 56,
    description:
      'Connector foundation (connectors.md, DEV-186): connector_connections (one row per connected external source; credential-free config, internal cursor) and connector_records (normalized-record ledger keyed by opaque source identity — idempotent re-syncs, explicit tombstones for provider deletions, entity_id back-references for disconnect cleanup). Credentials live only in the OS secure store, never here. LOCAL-ONLY tables — no sync-allowlist keys.',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE IF NOT EXISTS connector_connections (
          connector_id         TEXT PRIMARY KEY,
          status               TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected', 'needs_attention', 'disconnected')),
          account_label        TEXT,
          config_json          TEXT NOT NULL DEFAULT '{}',
          sync_cursor          TEXT,
          connected_at         INTEGER NOT NULL,
          last_sync_at         INTEGER,
          last_sync_error      TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          next_retry_at        INTEGER,
          items_ingested       INTEGER NOT NULL DEFAULT 0,
          updated_at           INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS connector_records (
          id               TEXT PRIMARY KEY,
          connector_id     TEXT NOT NULL,
          source_record_id TEXT NOT NULL,
          kind             TEXT NOT NULL,
          entity_id        TEXT,
          date             TEXT,
          effective_at     INTEGER,
          retrieved_at     INTEGER NOT NULL,
          sensitivity      TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          permission_scope TEXT NOT NULL,
          envelope_json    TEXT NOT NULL,
          tombstoned_at    INTEGER,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          UNIQUE(connector_id, source_record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_connector_records_connector ON connector_records (connector_id, tombstoned_at);
        CREATE INDEX IF NOT EXISTS idx_connector_records_date ON connector_records (date);
      `)
    },
  },
  // v57 is intentionally skipped: it was reserved for the app-identity twin
  // dedupe (#22), but v58 shipped on main first and runMigrations() filters on
  // MAX(applied version) — a database already at v58 would never gap-fill a
  // later-added v57. The dedupe therefore landed as v59 below.
  {
    version: 58,
    description:
      'Per-display visibility evidence (#21 part 2): admit the cg_display_visibility adapter and its display_visible_changed / display_visible_sampled events into canonical focus_events, with a display_id column so a full-screen app on a second monitor is evidence, not a blind spot',
    up: () => {
      const db = getDb()
      db.exec(`
        CREATE TABLE focus_events_v58 (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          evidence_id       TEXT    NOT NULL DEFAULT (lower(hex(randomblob(16)))) UNIQUE,
          ts_ms             INTEGER NOT NULL,
          mono_ns           INTEGER NOT NULL,
          event_type        TEXT    NOT NULL CHECK(event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock',
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered',
            'tab_changed',
            'tab_sampled',
            'display_visible_changed',
            'display_visible_sampled'
          )),
          app_bundle_id     TEXT,
          app_name          TEXT,
          pid               INTEGER,
          window_title      TEXT,
          url               TEXT,
          page_title        TEXT,
          source            TEXT    NOT NULL CHECK(source IN (
            'nsworkspace_event',
            'apple_events_tab',
            'uia_foreground',
            'uia_tab',
            'capture_supervisor',
            'foreground_poll',
            'cg_display_visibility'
          )),
          confidence        TEXT    NOT NULL CHECK(confidence IN ('observed', 'corroborated', 'inferred', 'unknown')),
          platform          TEXT    NOT NULL DEFAULT 'darwin',
          display_id        INTEGER,
          sensitivity       TEXT    NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          provenance_method TEXT    NOT NULL DEFAULT 'unknown',
          permission_scope  TEXT    NOT NULL DEFAULT 'unknown',
          policy_version    INTEGER NOT NULL DEFAULT 0,
          schema_ver        INTEGER NOT NULL DEFAULT 2 CHECK(schema_ver = 2),
          CHECK(confidence <> 'unknown' OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground', 'foreground_poll', 'cg_display_visibility') OR (url IS NULL AND page_title IS NULL)),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR confidence <> 'observed' OR url IS NOT NULL),
          CHECK(source NOT IN ('apple_events_tab', 'uia_tab') OR event_type IN ('tab_changed', 'tab_sampled')),
          CHECK(source NOT IN ('nsworkspace_event', 'uia_foreground', 'foreground_poll') OR event_type IN (
            'app_activated',
            'app_deactivated',
            'window_changed',
            'space_changed',
            'sleep',
            'wake',
            'lock',
            'unlock'
          )),
          CHECK(source <> 'capture_supervisor' OR event_type IN (
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered'
          )),
          CHECK(event_type NOT IN (
            'idle_started',
            'idle_ended',
            'capture_started',
            'capture_stopped',
            'capture_paused',
            'capture_resumed',
            'capture_failed',
            'capture_recovered'
          ) OR source = 'capture_supervisor'),
          CHECK(source <> 'capture_supervisor' OR (
            app_bundle_id IS NULL AND app_name IS NULL AND window_title IS NULL
            AND url IS NULL AND page_title IS NULL
          )),
          CHECK(source <> 'cg_display_visibility' OR event_type IN ('display_visible_changed', 'display_visible_sampled')),
          CHECK(event_type NOT IN ('display_visible_changed', 'display_visible_sampled') OR source = 'cg_display_visibility'),
          CHECK(source <> 'cg_display_visibility' OR display_id IS NOT NULL),
          CHECK(source = 'cg_display_visibility' OR display_id IS NULL)
        );

        INSERT INTO focus_events_v58 (
          id, evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
          window_title, url, page_title, source, confidence, platform,
          sensitivity, provenance_method, permission_scope, policy_version, schema_ver
        )
        SELECT
          id, evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
          window_title, url, page_title, source, confidence, platform,
          sensitivity, provenance_method, permission_scope, policy_version, schema_ver
        FROM focus_events
        ORDER BY id;

        DROP TABLE focus_events;
        ALTER TABLE focus_events_v58 RENAME TO focus_events;

        CREATE UNIQUE INDEX idx_focus_events_identity ON focus_events (
          source, event_type, ts_ms, mono_ns,
          COALESCE(app_bundle_id, ''), COALESCE(app_name, ''),
          COALESCE(pid, -1), COALESCE(window_title, ''), COALESCE(url, ''),
          COALESCE(page_title, ''), COALESCE(display_id, -1), confidence, platform
        );
        CREATE INDEX IF NOT EXISTS idx_focus_events_ts ON focus_events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_focus_events_type ON focus_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_focus_events_platform ON focus_events(platform);
      `)
    },
  },
  {
    version: 59,
    description:
      'Same app, one entity (#22 / DEV-224): the poll capture backend keyed apps by executable path when the active-window module reported no bundle id, while macOS focus events keyed the same install by its CFBundleIdentifier — one install became two app_identities rows and two entities. Resolve each path-keyed identity to its real bundle id via the installed bundle\'s Info.plist, link the rows through canonical_app_id, merge twin entities through the reversible merge machinery (user renames and prior explicit merges outrank), and stamp the unified id onto historical app_sessions so Apps/Timeline group one app. Identities that no longer resolve are left for the Needs-attention review — display names alone never merge. (Numbered v59, not the reserved v57: v58 shipped first and the runner never revisits versions below MAX(applied).)',
    up: () => {
      const result = dedupeAppIdentityTwins(getDb(), macBundleIdentifierForExecutablePath)
      if (result.pathIdentitiesResolved > 0) {
        console.log(
          `[migrations:v59] unified ${result.pathIdentitiesResolved} path-keyed app identit${result.pathIdentitiesResolved === 1 ? 'y' : 'ies'}: `
          + `${result.entitiesMerged} entit${result.entitiesMerged === 1 ? 'y' : 'ies'} merged, `
          + `${result.entitiesRekeyed} re-keyed, `
          + `${result.sessionsRestamped} session row${result.sessionsRestamped === 1 ? '' : 's'} restamped`,
        )
      }
    },
  },
  {
    version: 60,
    description:
      'GitHub connector (connectors.md §GitHub, DEV-191): widen the memory_records record_kind CHECK to admit connected_activity rows — the per-day projection of connector repository activity (commits, pull requests, reviews, issues) into searchable memory with connected origin. SQLite cannot alter a CHECK in place; projection rows are wiped and the table rebuilt — days re-project lazily through the fingerprint check and the background backfill. Supplied facts are re-mirrored from their canonical supplied_memory_facts store, so nothing explicitly confirmed is lost. LOCAL-ONLY, no sync-allowlist keys.',
    up: () => {
      const db = getDb()
      const memoryRecordsSql = getTableSql('memory_records') ?? ''
      if (!memoryRecordsSql || memoryRecordsSql.includes('connected_activity')) return
      db.exec(`
        DELETE FROM memory_record_vectors;
        DELETE FROM memory_record_entities;
        DELETE FROM memory_records;
        DELETE FROM memory_index_days;
        DROP TABLE memory_records;
        CREATE TABLE memory_records (
          id                TEXT PRIMARY KEY,
          record_kind       TEXT NOT NULL CHECK(record_kind IN ('session', 'meeting', 'artifact', 'supplied_fact', 'connected_activity')),
          memory_type       TEXT NOT NULL CHECK(memory_type IN ('observed', 'connected', 'supplied', 'inferred')),
          statement         TEXT NOT NULL,
          exact_text        TEXT NOT NULL DEFAULT '',
          semantic_text     TEXT,
          date              TEXT NOT NULL,
          start_ms          INTEGER NOT NULL,
          end_ms            INTEGER NOT NULL,
          app_bundle_id     TEXT,
          app_name          TEXT,
          title             TEXT,
          primary_entity_id TEXT,
          source_refs_json  TEXT NOT NULL DEFAULT '[]',
          confidence        TEXT NOT NULL DEFAULT 'observed',
          provenance        TEXT NOT NULL DEFAULT 'capture',
          sensitivity       TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
          embedding_model   TEXT,
          embedding_version INTEGER,
          created_at        INTEGER NOT NULL,
          deleted_at        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_memory_records_date ON memory_records (date);
        CREATE INDEX IF NOT EXISTS idx_memory_records_kind_start ON memory_records (record_kind, start_ms DESC);
      `)
      ensureMemorySearchSchema(db)
      reconcileSuppliedMemoryRecords(db)
    },
  },
  {
    version: 61,
    description:
      'Meeting attendance marks (DEV-189, timeline.md §Meetings: "A person can mark a scheduled meeting as attended, skipped, moved, or unrelated"). The day-level meeting resolution (calendar-only / captured-only / matched buckets, issue #3) re-reads these on every projection, so a mark is durable correction data that survives restart, reprojection, and source refresh, and propagates to the Timeline day payload, the wrap enrichment, search (via the user_confirmation occurrence ref), and the agent meeting report. event_key is the scheduled event\'s day-local identity (minutes-into-day + normalized title) — stable across re-syncs. LOCAL-ONLY, no sync-allowlist keys.',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS meeting_attendance_marks (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          event_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('attended', 'skipped', 'moved', 'unrelated')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (date, event_key)
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_attendance_marks_date
          ON meeting_attendance_marks (date);
      `)
    },
  },
  {
    version: 62,
    description:
      'Screen-context experiment lifecycle (DEV-197): the durable frame ledger and derived-evidence store behind the opt-in screen-sampling experiment. screen_context_frames tracks every sampled frame through its one lifecycle (captured → extracting → indexed → safe_to_delete → deleted, with failed → quarantined on extraction failure) so the raw-deletion invariant — no raw file is deleted before its derived evidence is atomically committed, and no raw file outlives the 24-hour safety window unquarantined — survives restarts and crashes. screen_context_evidence holds the high-sensitivity derived records (title, short OCR spans, subject references, provenance bounding, model/schema versions, a one-way frame digest) and is LOCAL-ONLY: never synced, never exported, never fed to MCP or a model outside the experiment boundary. Raw frame bytes live encrypted on disk, never in the database. (Numbered v62: drafted as v60 on the screen-context branch, renumbered at integration because the GitHub connector\'s memory_records widening shipped as v60 and meeting-attendance as v61 — merge the connector stack first; the runner never revisits versions below MAX(applied).)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS screen_context_frames (
          id TEXT PRIMARY KEY,
          captured_at INTEGER NOT NULL,
          trigger TEXT NOT NULL DEFAULT 'interval' CHECK (trigger IN (
            'stability', 'context_change', 'interval', 'diagnostic'
          )),
          app_bundle_id TEXT,
          app_name TEXT,
          display_id INTEGER,
          exclusion_policy_version INTEGER NOT NULL DEFAULT 0,
          local_path TEXT,
          byte_size INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL CHECK (state IN (
            'captured', 'extracting', 'indexed', 'safe_to_delete', 'deleted',
            'failed', 'quarantined'
          )),
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          next_retry_at INTEGER,
          first_failed_at INTEGER,
          deleted_without_evidence INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_screen_frames_state ON screen_context_frames(state);
        CREATE INDEX IF NOT EXISTS idx_screen_frames_captured ON screen_context_frames(captured_at);

        CREATE TABLE IF NOT EXISTS screen_context_evidence (
          id TEXT PRIMARY KEY,
          frame_id TEXT NOT NULL REFERENCES screen_context_frames(id),
          captured_at INTEGER NOT NULL,
          app_bundle_id TEXT,
          app_name TEXT,
          doc_title TEXT,
          ocr_spans_json TEXT NOT NULL DEFAULT '[]',
          subject_refs_json TEXT NOT NULL DEFAULT '[]',
          bounding_json TEXT,
          extractor_model TEXT NOT NULL,
          extractor_schema_version INTEGER NOT NULL,
          confidence REAL NOT NULL DEFAULT 0,
          sensitivity TEXT NOT NULL DEFAULT 'high',
          frame_digest TEXT NOT NULL,
          interval_start_ms INTEGER,
          interval_end_ms INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_screen_evidence_frame ON screen_context_evidence(frame_id);
        CREATE INDEX IF NOT EXISTS idx_screen_evidence_digest ON screen_context_evidence(frame_digest);
        CREATE INDEX IF NOT EXISTS idx_screen_evidence_captured ON screen_context_evidence(captured_at);
      `)
    },
  },
  // Numbering note (integration of the connector stack and the screen/wrapped
  // stack): v60 is the GitHub-connector memory_records widening and v61 the
  // meeting-attendance marks (connector stack); the screen-context experiment
  // migration — originally drafted as v60 on its own branch — landed as v62,
  // the slot that had been reserved for Linear + Granola and went unused
  // (Linear + Granola shipped without a migration). Same rule as the v59
  // renumbering: the runner applies every array entry with version >
  // MAX(applied), in array order, so any ordered gap is safe as long as
  // versions stay strictly increasing in this array.
  {
    version: 63,
    description:
      'Versioned day analysis (DEV-206): every AI analysis of a day — the day wrap narrative, the period wraps that contain it, and the timeline regroup/relabel run — is recorded as an append-only version row instead of silently replacing what came before. Each row carries what the analysis said (payload_json), the facts hash it was computed from, the model and prompt version that produced it, the trigger source, and WHY it exists (initial / facts-changed / correction / manual-regenerate). A correction retires the current version (retired_at + retired_reason) rather than erasing it, so the next generation is visibly a new version with a reason — old versions stay inspectable forever. LOCAL table: it exports with the timeline section of the history export and never rides a sync payload (the strict sync allowlist has no key for it). (Numbered v63, skipping v61/v62 claimed by the in-flight connector-stack branches — the runner never revisits versions below MAX(applied).)',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS day_analysis_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK (kind IN ('day', 'week', 'month', 'year', 'timeline')),
          period_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          facts_hash TEXT NOT NULL,
          model TEXT,
          prompt_version INTEGER NOT NULL DEFAULT 1,
          trigger_source TEXT NOT NULL DEFAULT 'user',
          source TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'fallback', 'deterministic')),
          reason TEXT NOT NULL CHECK (reason IN (
            'initial', 'facts-changed', 'correction', 'deletion',
            'evidence-change', 'manual-regenerate', 'regenerated'
          )),
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          retired_reason TEXT CHECK (retired_reason IN ('correction', 'deletion', 'evidence-change', 'superseded') OR retired_reason IS NULL),
          UNIQUE(kind, period_key, version)
        );
        CREATE INDEX IF NOT EXISTS idx_day_analysis_versions_key ON day_analysis_versions(kind, period_key);
      `)
    },
  },
  {
    version: 64,
    description:
      'Screen-context paired evaluation (DEV-198): the experiment is a MEASUREMENT, not a feature — each target question is answered once from normal evidence and once with screen-derived evidence, and a tester reviews which answer is more accurate, more specific, or unchanged (screen-context.md §Evaluation). screen_eval_pairs stores those pairs locally: the question, both answers, the target-difficulty kind, and the reviewed verdict. The ship-or-kill report is built ONLY from aggregate counts over these rows plus the frame/evidence ledgers — never from the stored text. LOCAL-ONLY like every screen-context table: withheld from the full-history export (named in the omissions manifest), no sync-allowlist key, never in analytics.',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS screen_eval_pairs (
          id TEXT PRIMARY KEY,
          target_kind TEXT NOT NULL CHECK (target_kind IN (
            'untitled_native_doc', 'generic_window_title', 'visual_research',
            'design_spreadsheet', 'false_context_risk', 'protected_surface'
          )),
          question TEXT NOT NULL,
          baseline_answer TEXT,
          screen_answer TEXT,
          asked_at INTEGER NOT NULL,
          verdict TEXT CHECK (verdict IN (
            'screen_more_accurate', 'screen_more_specific', 'unchanged', 'screen_worse'
          ) OR verdict IS NULL),
          reviewed_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_screen_eval_pairs_kind ON screen_eval_pairs(target_kind);
      `)
    },
  },
  {
    version: 65,
    description:
      'Agent turn checkpoints (DEV-200): a long-running agent turn can be paused and resumed, and a paused turn survives an app restart. agent_turn_checkpoints holds ONLY outstanding turns — a row is opened when the agent loop starts, moves through the one visible state machine (running → awaiting_user → running, running → paused), and is DELETED on every terminal phase (completed/cancelled/failed) because the durable thread transcript owns finished turns. The row stores the user question verbatim plus honest state (phase, why it is paused, which card was holding it, the last tool status line) — never in-flight provider session state: resume deliberately re-runs the question against a fresh context packet, per agent-runtime-and-context.md §Sessions and interruption ("provider session state … can be rebuilt from the Daylens thread plus a fresh context packet"). Restart recovery degrades any row still marked running/awaiting_user to paused(restart) — incomplete work is marked accurately, never assumed done. LOCAL-ONLY table: no sync-allowlist key exists for it, so the strict allowlist proves it can never ride a sync payload; it carries conversation text and is not exported.',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS agent_turn_checkpoints (
          id TEXT PRIMARY KEY,
          thread_id INTEGER,
          client_request_id TEXT,
          question TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('running', 'awaiting_user', 'paused')),
          pause_kind TEXT CHECK (pause_kind IN ('user', 'restart') OR pause_kind IS NULL),
          wait_kind TEXT CHECK (wait_kind IN (
            'clarification', 'file_permission', 'memory_confirmation', 'correction_confirmation'
          ) OR wait_kind IS NULL),
          last_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_turn_checkpoints_thread ON agent_turn_checkpoints(thread_id);
      `)
    },
  },
  {
    version: 66,
    description:
      'Day-analysis clarification skips (DEV-247/DEV-270 agentic recap). When the interpretation agent asks the person a clarifying question about the day (an unnamed block, an unconfirmed meeting) and they dismiss it, the dismissal is remembered here so the same question is not re-asked on every open. An ANSWERED question needs no row — it resolves through its durable correction (a block label override, an attendance mark). LOCAL-ONLY: no sync-allowlist key, never exported.',
    up: () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS timeline_clarification_skips (
          date TEXT NOT NULL,
          clarification_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (date, clarification_id)
        );
        CREATE INDEX IF NOT EXISTS idx_timeline_clarification_skips_date
          ON timeline_clarification_skips (date);
      `)
    },
  },
  {
    version: 67,
    description:
      'Canonicalize legacy display-form activity categories. Rows written before the category vocabulary settled carry display labels ("AI Tools", "Browsing", "Development", "Uncategorized"); every kind/intent rule compares canonical enum values, so those rows silently resolved to the wrong work-kind — hours of development on a historical day counted as "personal" and never reached the day wrap\'s work activities. Normalizes every stored category column plus the JSON copies embedded in timeline_blocks, and drops the derived day_snapshots cache (its work/leisure/personal splits were frozen from the broken vocabulary; snapshots re-freeze lazily).',
    up: () => {
      const db = getDb()

      const normalizeColumn = (table: string, column: string) => {
        const exists = db.prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
        ).get(table)
        if (!exists) return
        const rows = db.prepare(`SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ value: string }>
        for (const { value } of rows) {
          const canonical = canonicalAppCategory(value)
          if (canonical !== value) {
            db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(canonical, value)
          }
        }
      }
      normalizeColumn('app_sessions', 'category')
      normalizeColumn('apps', 'category')
      normalizeColumn('category_overrides', 'category')
      normalizeColumn('app_identities', 'default_category')
      normalizeColumn('workflow_signatures', 'dominant_category')
      normalizeColumn('timeline_blocks', 'dominant_category')
      normalizeColumn('live_app_session_snapshot', 'category')

      // The JSON copies on each block: category_distribution_json keys (a
      // single row can mix vocabularies — {"Development": …, "development": …}
      // — so colliding keys SUM), and evidence_summary_json apps[].category.
      const blocks = db.prepare(
        `SELECT id, category_distribution_json, evidence_summary_json FROM timeline_blocks`,
      ).all() as Array<{ id: string; category_distribution_json: string; evidence_summary_json: string }>
      const updateBlock = db.prepare(
        `UPDATE timeline_blocks SET category_distribution_json = ?, evidence_summary_json = ? WHERE id = ?`,
      )
      for (const block of blocks) {
        let changed = false
        let distributionJson = block.category_distribution_json
        try {
          const distribution = JSON.parse(block.category_distribution_json) as Record<string, number>
          const normalized: Record<string, number> = {}
          for (const [key, seconds] of Object.entries(distribution)) {
            const canonical = canonicalAppCategory(key)
            if (canonical !== key) changed = true
            normalized[canonical] = (normalized[canonical] ?? 0) + (typeof seconds === 'number' ? seconds : 0)
          }
          if (changed) distributionJson = JSON.stringify(normalized)
        } catch { /* malformed JSON: leave the row as it was */ }

        let evidenceJson = block.evidence_summary_json
        try {
          const evidence = JSON.parse(block.evidence_summary_json) as { apps?: Array<{ category?: string }> }
          let evidenceChanged = false
          for (const app of evidence.apps ?? []) {
            if (typeof app.category === 'string') {
              const canonical = canonicalAppCategory(app.category)
              if (canonical !== app.category) {
                app.category = canonical
                evidenceChanged = true
              }
            }
          }
          if (evidenceChanged) {
            evidenceJson = JSON.stringify(evidence)
            changed = true
          }
        } catch { /* malformed JSON: leave the row as it was */ }

        if (changed) updateBlock.run(distributionJson, evidenceJson, block.id)
      }

      db.exec(`DELETE FROM day_snapshots`)
    },
  },
]

export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0

function attentionClassForCategory(category: string): 'focus' | 'supporting' | 'ambient' {
  switch (category) {
    case 'development':
    case 'design':
    case 'writing':
    case 'research':
    case 'productivity':
    case 'aiTools':
    case 'spreadsheet':
    case 'editor':
      return 'focus'
    case 'communication':
    case 'email':
    case 'mail':
    case 'chat':
    case 'meetings':
    case 'meeting':
      return 'supporting'
    case 'entertainment':
    case 'social':
    case 'media':
    case 'system':
    case 'browsing':
    default:
      return 'ambient'
  }
}

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
