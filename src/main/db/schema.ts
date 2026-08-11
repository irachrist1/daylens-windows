// Raw SQL schema — will be replaced by Drizzle in Phase 2a.

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
-- (bundle_id, start_time) lookups are already served by the UNIQUE
-- idx_app_sessions_dedup (migration v3), so no separate index is needed here.

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
CREATE INDEX IF NOT EXISTS idx_focus_sessions_start ON focus_sessions (start_time);

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
  metadata_json   TEXT    NOT NULL DEFAULT '{}',
  thread_id       INTEGER,
  rating          TEXT CHECK(rating IN ('up', 'down') OR rating IS NULL),
  rating_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages (conversation_id, created_at);

-- Thread grouping over ai_messages. Messages reference a thread through the
-- ai_messages.thread_id column (added via migration on existing databases).
-- The thread index is created by ensureAIThreadSchema() after legacy databases
-- have been repaired so startup does not fail before repair can run.
CREATE TABLE IF NOT EXISTS ai_threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL DEFAULT 'New chat',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  archived        INTEGER NOT NULL DEFAULT 0,
  metadata_json   TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ai_threads_updated ON ai_threads (updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_artifacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id       INTEGER REFERENCES ai_threads(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES ai_messages(id) ON DELETE SET NULL,
  kind            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  summary         TEXT,
  file_path       TEXT,
  inline_content  TEXT,
  mime_type       TEXT    NOT NULL,
  byte_size       INTEGER NOT NULL DEFAULT 0,
  meta_json       TEXT    NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_thread ON ai_artifacts (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_message ON ai_artifacts (message_id);

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
  cache_hit INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  billing_mode TEXT NOT NULL DEFAULT 'own_key'
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_started_at ON ai_usage_events (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_job_type ON ai_usage_events (job_type, started_at DESC);

-- Provider circuit breaker (W1-B): when a provider comes back quota_exhausted
-- or credit_exhausted, this is the persisted "cooldown until" fact so a
-- background relabel loop stops hammering a wall provider across app
-- restarts. One row per provider; absence or cooldown_until <= now means the
-- breaker is closed. See src/main/services/providerCircuitBreaker.ts.
CREATE TABLE IF NOT EXISTS provider_breaker_state (
  provider            TEXT PRIMARY KEY,
  opened_at           INTEGER NOT NULL,
  cooldown_until      INTEGER NOT NULL,
  reason              TEXT NOT NULL,
  retry_after_seconds INTEGER,
  updated_at          INTEGER NOT NULL
);

-- Retention rollup for ai_usage_events (W1-B / storage hygiene): one row per
-- (day, job_type, screen, trigger_source, provider, model, billing_mode),
-- carrying the same call/success/failure counts and token sums the raw rows
-- had. Pricing is linear in tokens (see billing.ts priceTokensUsd), so a
-- summed group prices identically to summing each original row — nothing the
-- Settings Usage screen or billing reporting reads is lost, only per-event
-- rows older than the detail window. See src/main/services/aiUsageRetention.ts.
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

CREATE TABLE IF NOT EXISTS maintenance_runs (
  key          TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL
);

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
-- block_id lookups are already served by the PRIMARY KEY (block_id, member_type,
-- member_id) leading column, so no separate block_id index is needed.

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
CREATE INDEX IF NOT EXISTS idx_artifact_mentions_time ON artifact_mentions (start_time);

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

-- User corrections to episode boundaries. A 'split' asserts "there IS a
-- boundary between these two sessions"; a 'merge' asserts "there is NOT".
-- Anchored two ways: by the session-id pair straddling the boundary (exact),
-- and by the merged span's wall-clock range (span_start_ms/span_end_ms) —
-- session ids live in two namespaces (app_sessions for today, derived_sessions
-- for past days) and derived ids churn on reprojection, so time is the anchor
-- that survives every rebuild.
CREATE TABLE IF NOT EXISTS timeline_boundary_corrections (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  left_session_id INTEGER NOT NULL,
  right_session_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('split', 'merge')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  span_start_ms INTEGER,
  span_end_ms INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_boundary_corrections_pair
  ON timeline_boundary_corrections (left_session_id, right_session_id);
CREATE INDEX IF NOT EXISTS idx_timeline_boundary_corrections_date
  ON timeline_boundary_corrections (date);

-- Reversible evidence exclusions (timeline spec, Corrections: "exclude
-- specific evidence"). Unlike the permanent purge, an exclusion leaves the raw
-- rows untouched: the corrected activity-fact reads subtract the matching
-- identity inside the span, so Timeline, Apps, search, and the AI all skip it,
-- and undo simply deletes the exclusion row.
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

-- Meeting attendance marks (DEV-189, timeline.md §Meetings: "A person can
-- mark a scheduled meeting as attended, skipped, moved, or unrelated").
-- Durable correction data: the day-level meeting resolution re-reads these on
-- every projection, so a mark survives restart, reprojection, and source
-- refresh. event_key is the scheduled event's day-local identity
-- (minutes-into-day + normalized title) — the same identity the calendar day
-- signal carries, stable across re-syncs. LOCAL-ONLY: never synced.
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

-- Dismissed day-analysis clarifications. When the interpretation agent asks a
-- clarifying question about the day and the person skips it, the dismissal is
-- remembered so the same question is not re-asked. An answered question needs
-- no row — it resolves through its durable correction. LOCAL-ONLY: never synced.
CREATE TABLE IF NOT EXISTS timeline_clarification_skips (
  date TEXT NOT NULL,
  clarification_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (date, clarification_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_clarification_skips_date
  ON timeline_clarification_skips (date);

-- Undo ledger for correction commands. Each applied correction snapshots the
-- correction-ledger rows it may touch (reviews, boundary corrections, label
-- overrides, evidence exclusions, work-session attribution); undo restores the
-- snapshot in one transaction. Raw evidence never appears here — only the
-- correction overlay, so the log stays small and undo can never resurrect
-- purged data.
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

-- client_id is nullable (memory-and-entities.md migration slice 4): a project
-- may exist without a client. Projects that do have a client still cascade.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  client_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
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

-- Work memory as a short, human-readable profile (ChatGPT-style), not opaque
-- patterns. Each row is one plain-language fact. origin distinguishes a fact
-- Daylens drafted from evidence from one the user wrote/edited by hand; a
-- hand-edited fact becomes a correction (origin=user) that a rebuild never
-- overwrites. status=deleted tombstones a forgotten drafted fact (by its
-- topic_key) so a rebuild does not drag it back. See docs/specs/work-memory.md.
CREATE TABLE IF NOT EXISTS work_memory_facts (
  id          TEXT PRIMARY KEY,
  fact_text   TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK(origin IN ('drafted', 'user')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
  topic_key   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  -- DEV-107: where the fact came from (display provenance, not durability),
  -- and which scope it belongs to. 'general' is always-in-prompt memory;
  -- 'client:<id>' is per-client scoped memory pulled in only when relevant
  -- (DEV-108 fills the client side — DEV-107 lays the column).
  source      TEXT NOT NULL DEFAULT 'evidence' CHECK(source IN ('evidence', 'chat', 'hand')),
  scope       TEXT NOT NULL DEFAULT 'general',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_memory_facts_status ON work_memory_facts (status, sort_order);

-- DEV-107: a short, plain-language audit of what memory remembered, changed,
-- or forgot — so memory never feels like it's changing behind your back
-- (memory.md §3, invariant 7). Display-only; never feeds the AI prompt.
CREATE TABLE IF NOT EXISTS memory_audit (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL CHECK(action IN ('remembered', 'updated', 'forgot')),
  fact_text   TEXT NOT NULL,
  source      TEXT NOT NULL CHECK(source IN ('chat', 'hand')),
  scope       TEXT NOT NULL DEFAULT 'general',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_audit_created ON memory_audit (created_at DESC);

-- ─── Durable entities (memory-and-entities.md, DEV-177) ──────────────────────
-- One row per durable thing a day can be about. Identity is the per-type
-- identity_key (people by connector id, meetings by source event id, repos by
-- provider identity, apps by canonical app id, pages by canonical key,
-- clients/projects by their supplied record). Merges never rewrite aliases or
-- evidence refs: a merged entity keeps its rows and points at the survivor via
-- merged_into_id, so every automatic or explicit merge is trivially reversible.
-- name_source='user' marks an explicit rename that outranks later inference —
-- adoption/upsert may only touch canonical_name while name_source='inferred'.
-- LOCAL-ONLY: none of these tables have sync-allowlist keys; they can never
-- serialize into a remote payload (see tests/syncAllowlist.test.ts).
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

-- Aliases keep the raw label that produced them (spec: "without losing the raw
-- labels"). Rows stay on their original entity across merges; resolution unions
-- the merge group.
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

-- Evidence backing an entity. span_start_ms/span_end_ms is the degrade anchor
-- for timeline-block references: block ids churn on reprojection, the wall
-- clock does not, so a block ref can always remap to a successor block or
-- degrade to its evidence span — never dangle (spec §Timeline-block references).
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
CREATE INDEX IF NOT EXISTS idx_entity_evidence_refs_span ON entity_evidence_refs (span_start_ms);

-- Suggested vs confirmed relationships between entities. source='user' rows
-- are confirmed; 'inferred' rows stay suggestions until accepted.
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

-- ─── Agent file access (agent-runtime-and-context.md §File and document
-- access, DEV-184) ────────────────────────────────────────────────────────────
-- Three-state model above the visible-home path floor. A grant names a file or
-- folder and one state; granting 'indexed' never grants 'model_readable'.
-- derived_text is the Indexed-state extraction stub — revocation NULLs it in
-- the same statement that sets revoked_at, so removing access deletes derived
-- text. LOCAL-ONLY: no sync-allowlist keys.
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

-- Per-request disclosure ledger, written BEFORE content is returned to the
-- model. Shaped to match the runtime spec's ContextDisclosure (identity,
-- version, excerpt location, reason, destination, whether it left the device)
-- so the batch-10 context packet can generalize this row rather than replace
-- it. LOCAL-ONLY: no sync-allowlist keys.
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

-- ─── Exact-retrieval memory records (memory-and-entities.md §Memory record,
-- DEV-178) ────────────────────────────────────────────────────────────────────
-- One row per retrievable moment, projected per local day from the CORRECTED
-- activity facts (never raw app_sessions), plus meeting entities and artifact
-- mentions. exact_text is the index-time full-text; entity-named records keep
-- it EMPTY and are found through entity resolution (canonical name + aliases)
-- at query time so renames and alias removals apply without reindexing.
-- semantic_text is the minimized representation DEV-180 will embed;
-- embedding_model/embedding_version stay NULL until then. The FTS index over
-- exact_text (memory_records_fts) is created by migration v52 alongside the
-- other FTS tables. LOCAL-ONLY: none of these tables have sync-allowlist keys;
-- they can never serialize into a remote payload (tests/syncAllowlist.test.ts).
CREATE TABLE IF NOT EXISTS memory_records (
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

-- Entity tags: which durable entities a record is about. Search resolves a
-- query to entities through aliases, then finds tagged records by id — that is
-- what makes "acme" find Acme Corp's days. Cascades keep tags consistent with
-- both record reindexes and entity deletion.
CREATE TABLE IF NOT EXISTS memory_record_entities (
  record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (record_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_record_entities_entity ON memory_record_entities (entity_id);

-- Per-day index bookkeeping: the fingerprint digests every input that can
-- change a day's records, so reindexing is incremental and idempotent.
CREATE TABLE IF NOT EXISTS memory_index_days (
  date         TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,
  indexed_at   INTEGER NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0
);

-- ─── Semantic-search vector bookkeeping (memory-and-entities.md §Local
-- semantic search, DEV-180) ──────────────────────────────────────────────────
-- One row per embedded memory record. The float vectors themselves live in the
-- sqlite-vec vec0 virtual table (memory_semantic_vec, created at runtime by the
-- semantic index when the extension loads — virtual tables cannot be created
-- here because the extension may be absent). This table is the authority on
-- which embeddings are valid: vec_rowid is AUTOINCREMENT so a vec0 rowid is
-- never reused, and record_id cascades with memory_records — when a day
-- re-projects (correction, deletion, MEMORY_INDEX_VERSION bump) the records
-- are deleted and their embeddings die with them in the same transaction.
-- vec0 rows whose bookkeeping row is gone are invisible to every query (the
-- join is the filter) and are garbage-collected by the background indexer.
-- LOCAL-ONLY: no sync-allowlist keys; embeddings never leave the device
-- (tests/syncAllowlist.test.ts).
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

-- ─── Supplied memory (memory-and-entities.md §Conversational memory, DEV-185) ─
-- Facts the person explicitly confirmed or entered by hand — the only memory
-- that exists WITHOUT evidence (spec §Memory record). Each active fact mirrors
-- into memory_records under its own id (record_kind='supplied_fact',
-- memory_type='supplied') so exact search, semantic search, and context
-- packets retrieve it through the shared query boundary; the mirror row dies
-- in the same transaction as the fact, so a deleted fact leaves retrieval
-- immediately and a day re-projection never resurrects it (the day rebuild
-- skips supplied rows). thread_id records which chat confirmed the fact;
-- deleting that thread clears the reference but keeps the fact — the
-- confirmation (source + confirmed_at + context) explains why it remains.
-- LOCAL-ONLY: no sync-allowlist keys; supplied memory never serializes into a
-- remote payload (tests/syncAllowlist.test.ts).
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

-- Declined memory proposals (spec §Conversational memory): a rejected proposal
-- is stored so it is not re-proposed without new evidence. The row carries the
-- proposed fact's sensitivity, can be deleted like any memory, and its text is
-- purged (statement and match key blanked) when the supporting chat thread is
-- deleted. LOCAL-ONLY: no sync-allowlist keys (tests/syncAllowlist.test.ts).
CREATE TABLE IF NOT EXISTS memory_proposal_rejections (
  id            TEXT PRIMARY KEY,
  statement     TEXT NOT NULL,
  statement_key TEXT NOT NULL,
  sensitivity   TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard', 'personal', 'high')),
  thread_id     INTEGER,
  rejected_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_proposal_rejections_key ON memory_proposal_rejections (statement_key);

-- ─── Context packets (agent-runtime-and-context.md §Context packet, DEV-181) ─
-- One recorded, deterministic disclosure bundle per AI exchange — the
-- generalization of the file_disclosures ledger to every content kind. The
-- full packet (items with identity/version/source-type/reason, disclosure
-- record, content fingerprint) is stored as JSON BEFORE the request leaves the
-- local boundary; message_id binds it to the persisted assistant message
-- afterwards, so "what did the model see for this answer" is one lookup.
-- LOCAL-ONLY: no sync-allowlist keys; packets never leave the device
-- (tests/syncAllowlist.test.ts).
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

-- ─── Connectors (connectors.md, DEV-186) ─────────────────────────────────────
-- One row per connected external source. config_json is adapter-specific and
-- CREDENTIAL-FREE by contract — tokens live only in the OS secure store
-- (src/main/connectors/credentials.ts). sync_cursor is internal bookkeeping
-- and never crosses IPC. LOCAL-ONLY: no sync-allowlist keys; connections,
-- cursors, and connector records never serialize into a remote payload
-- (tests/syncAllowlist.test.ts, tests/connectorPrivacy.test.ts).
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

-- The normalized-record ledger: one row per source record a connector ever
-- ingested, keyed by opaque source identity so re-syncs are idempotent and
-- provider deletions become explicit local tombstones. entity_id points at
-- what the record minted through the entity repository, which is exactly what
-- disconnect-with-delete must clean up. envelope_json is the full normalized
-- envelope (provenance + entity payload) — quarantined records are NEVER
-- stored here, not even partially (connectors.md §Failure behavior).
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
`
