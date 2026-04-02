// Raw SQL schema — will be replaced by Drizzle in Phase 2a (see docs/next-steps.md)

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id       TEXT    NOT NULL,
  app_name        TEXT    NOT NULL,
  start_time      INTEGER NOT NULL,
  end_time        INTEGER,
  duration_sec    INTEGER NOT NULL DEFAULT 0,
  category        TEXT    NOT NULL DEFAULT 'uncategorized',
  is_focused      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_start ON app_sessions (start_time);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  start_time   INTEGER NOT NULL,
  end_time     INTEGER,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  label        TEXT,
  target_minutes INTEGER,
  planned_apps TEXT NOT NULL DEFAULT '[]',
  reflection_note TEXT
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  messages   TEXT    NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

-- Normalised AI message storage — appends one row per message instead of
-- rewriting the entire JSON blob on every chat turn.
CREATE TABLE IF NOT EXISTS ai_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id),
  role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
  content         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS distraction_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES focus_sessions(id) ON DELETE SET NULL,
  app_name TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  triggered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_distraction_events_session ON distraction_events (session_id, triggered_at);

CREATE TABLE IF NOT EXISTS category_overrides (
  bundle_id TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Website visits from local browser history files (browser.ts service).
-- visit_time_us stores the raw microsecond timestamp from the source browser
-- (Chrome epoch µs for Chromium, Unix epoch µs for Firefox).
-- The UNIQUE constraint uses (browser_bundle_id, visit_time_us, url) so that
-- distinct visits with the same millisecond timestamp are preserved.
CREATE TABLE IF NOT EXISTS website_visits (
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

CREATE INDEX IF NOT EXISTS idx_website_visits_time   ON website_visits (visit_time);
CREATE INDEX IF NOT EXISTS idx_website_visits_domain ON website_visits (domain, visit_time);

CREATE TABLE IF NOT EXISTS work_context_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  observation TEXT NOT NULL,
  source_block_ids TEXT NOT NULL DEFAULT '[]',
  UNIQUE(start_ts, end_ts)
);

CREATE INDEX IF NOT EXISTS idx_work_context_observations_range ON work_context_observations (start_ts, end_ts);
`
