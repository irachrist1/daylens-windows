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
`
