import { getDb } from '../services/database'
import { normalizeUrlForStorage, pageKeyForUrl, resolveCanonicalApp, resolveCanonicalBrowser } from '../lib/appIdentity'

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
]

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
