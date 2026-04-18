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
  is_focused      INTEGER NOT NULL DEFAULT 0,
  window_title    TEXT,
  raw_app_name    TEXT,
  canonical_app_id TEXT,
  app_instance_id TEXT,
  capture_source  TEXT    NOT NULL DEFAULT 'foreground_poll',
  ended_reason    TEXT,
  capture_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_start ON app_sessions (start_time);

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
  created_at      INTEGER NOT NULL,
  metadata_json   TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS ai_conversation_state (
  conversation_id INTEGER PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE CASCADE,
  state_json      TEXT    NOT NULL DEFAULT '{}',
  updated_at      INTEGER NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_started_at ON ai_usage_events (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_job_type ON ai_usage_events (job_type, started_at DESC);

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
  canonical_browser_id TEXT,
  browser_profile_id TEXT,
  normalized_url    TEXT,
  page_key          TEXT,
  source            TEXT    NOT NULL DEFAULT 'history',
  UNIQUE (browser_bundle_id, visit_time_us, url)
);

CREATE INDEX IF NOT EXISTS idx_website_visits_time   ON website_visits (visit_time);
CREATE INDEX IF NOT EXISTS idx_website_visits_domain ON website_visits (domain, visit_time);

CREATE TABLE IF NOT EXISTS activity_state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_activity_state_events_time ON activity_state_events (event_ts);

CREATE TABLE IF NOT EXISTS work_context_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  observation TEXT NOT NULL,
  source_block_ids TEXT NOT NULL DEFAULT '[]',
  UNIQUE(start_ts, end_ts)
);

CREATE INDEX IF NOT EXISTS idx_work_context_observations_range ON work_context_observations (start_ts, end_ts);

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

CREATE INDEX IF NOT EXISTS idx_timeline_blocks_date ON timeline_blocks (date, start_time);
CREATE INDEX IF NOT EXISTS idx_timeline_blocks_valid ON timeline_blocks (date, invalidated_at, start_time);

CREATE TABLE IF NOT EXISTS timeline_block_members (
  block_id TEXT NOT NULL REFERENCES timeline_blocks(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  weight_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (block_id, member_type, member_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_block_members_member ON timeline_block_members (member_type, member_id);

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

CREATE INDEX IF NOT EXISTS idx_timeline_block_labels_block ON timeline_block_labels (block_id, created_at);

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

CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts (artifact_type, last_seen_at);

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

CREATE INDEX IF NOT EXISTS idx_artifact_mentions_source ON artifact_mentions (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_artifact_mentions_artifact ON artifact_mentions (artifact_id, start_time);

-- app_profile_cache was removed in migration v14. Cache is
-- recomputed in-memory by workBlocks.ts; no persistent cache is required.

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

CREATE INDEX IF NOT EXISTS idx_workflow_occurrences_date ON workflow_occurrences (date, workflow_id);

CREATE TABLE IF NOT EXISTS block_label_overrides (
  block_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  narrative TEXT,
  updated_at INTEGER NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_app_identities_canonical ON app_identities (canonical_app_id, last_seen_at);

-- Attribution-first schema (v14). All timestamps are UTC epoch ms.
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  hostname    TEXT NOT NULL,
  platform    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_rebuild_jobs_scope ON rebuild_jobs (scope, started_at DESC);
`
