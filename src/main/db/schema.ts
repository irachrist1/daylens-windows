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
  label        TEXT
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  messages   TEXT    NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS category_overrides (
  bundle_id TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Website visits from local browser history files (browser.ts service).
-- Additive — CREATE TABLE IF NOT EXISTS is safe to run on every launch.
CREATE TABLE IF NOT EXISTS website_visits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  domain            TEXT    NOT NULL,
  page_title        TEXT,
  url               TEXT,
  visit_time        INTEGER NOT NULL,
  duration_sec      INTEGER NOT NULL DEFAULT 0,
  browser_bundle_id TEXT,
  source            TEXT    NOT NULL DEFAULT 'history',
  UNIQUE (browser_bundle_id, visit_time)
);

CREATE INDEX IF NOT EXISTS idx_website_visits_time   ON website_visits (visit_time);
CREATE INDEX IF NOT EXISTS idx_website_visits_domain ON website_visits (domain, visit_time);
`
