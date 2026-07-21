// Deletion ownership registry (privacy-retention-and-sync.md §Deletion,
// canonical-deletion ticket).
//
// Every table in the production schema is classified here, and the structural
// test (tests/deletionOwnership.test.ts) fails when a table exists that this
// registry does not know — so a new evidence-derived table cannot silently
// escape deletion. The registry states, for each table, which deletion path
// owns removing its rows when the person deletes the evidence in scope.
//
// Kinds:
//   evidence — raw captured, connected, or high-sensitivity source rows.
//   derived  — rebuilt projections, indexes, caches, and aggregates whose
//              rows exist only because evidence does; deletion of the
//              evidence in scope must remove or rebuild them.
//   user     — user-authored facts, corrections, grants, threads, and
//              connections; deleted by their own explicit flows, never as a
//              side effect of evidence deletion.
//   system   — infrastructure and bookkeeping with no personal evidence
//              content; removed by device-level deletion only.

export type DeletionKind = 'evidence' | 'derived' | 'user' | 'system'

export interface DeletionOwnership {
  kind: DeletionKind
  /** The deletion path responsible for this table's rows. */
  owner: string
}

const TRACKED_ACTIVITY =
  'trackingHistory (deleteTrackedActivity / deleteHistoryForApp / deleteHistoryForSite / purgeTrackedEvidenceRows / purgeTimelineBlockSpanRows) + deletionJournal replay'
const PROJECTION_REBUILD =
  'day projection rebuild after evidence deletion (invalidateTimelineDayBlocks / projectDay) + trackingHistory scrub'
const MEMORY_INDEX =
  'memory index reprojection (indexMemoryForDay) after evidence deletion; rows carry deleted_at tombstones'
const ENTITY_LIFECYCLE =
  'entity repository lifecycle: evidence refs pruned with their evidence; explicit corrections outlive inference'
const AI_THREADS = 'AI thread deletion (aiThreadDeletion) and per-message deletion'
const OWN_SETTINGS_FLOW = 'its own explicit Settings/chat flow'
const DEVICE_ONLY = 'device-level deletion (uninstallCleanup / delete-everything)'
const CONNECTOR_PURGE = 'connector disconnect purge (purgeConnectorDerivedData)'
const SCREEN_LIFECYCLE = 'screen-context lifecycle (atomic extract-then-delete, quarantine, purge controls)'

export const DELETION_OWNERSHIP: Record<string, DeletionOwnership> = {
  // ── evidence ─────────────────────────────────────────────────────────────
  activity_state_events: { kind: 'evidence', owner: TRACKED_ACTIVITY },
  app_sessions: { kind: 'evidence', owner: `${TRACKED_ACTIVITY} (legacy rows; writes retired)` },
  focus_events: { kind: 'evidence', owner: TRACKED_ACTIVITY },
  website_visits: { kind: 'evidence', owner: TRACKED_ACTIVITY },
  connector_records: { kind: 'evidence', owner: CONNECTOR_PURGE },
  external_signals: { kind: 'evidence', owner: `${TRACKED_ACTIVITY}; refreshed per day` },
  screen_context_frames: { kind: 'evidence', owner: SCREEN_LIFECYCLE },
  screen_context_evidence: { kind: 'evidence', owner: SCREEN_LIFECYCLE },
  live_app_session_snapshot: { kind: 'evidence', owner: 'flush/clear on session end; device deletion' },

  // ── derived ──────────────────────────────────────────────────────────────
  activity_segments: { kind: 'derived', owner: TRACKED_ACTIVITY },
  ai_surface_summaries: { kind: 'derived', owner: 'cleared on any purge (clearGeneratedActivitySummaries)' },
  app_identities: { kind: 'derived', owner: `${TRACKED_ACTIVITY}; identity observations re-derive from remaining evidence` },
  apps: { kind: 'system', owner: 'application catalog (no personal evidence); device deletion' },
  artifact_mentions: { kind: 'derived', owner: PROJECTION_REBUILD },
  artifacts: { kind: 'derived', owner: PROJECTION_REBUILD },
  context_patterns: { kind: 'derived', owner: PROJECTION_REBUILD },
  daily_entity_rollups: { kind: 'derived', owner: ENTITY_LIFECYCLE },
  daily_memory_archive: { kind: 'derived', owner: MEMORY_INDEX },
  day_analysis_versions: { kind: 'derived', owner: PROJECTION_REBUILD },
  day_snapshots: { kind: 'derived', owner: 'deleteDaySnapshotRow on evidence change/deletion' },
  derived_block_sessions: { kind: 'derived', owner: TRACKED_ACTIVITY },
  derived_blocks: { kind: 'derived', owner: TRACKED_ACTIVITY },
  derived_projection_runs: { kind: 'derived', owner: `${DEVICE_ONLY}; run bookkeeping without content` },
  derived_sessions: { kind: 'derived', owner: TRACKED_ACTIVITY },
  derived_state_versions: { kind: 'derived', owner: `${DEVICE_ONLY}; version bookkeeping without content` },
  distraction_events: { kind: 'derived', owner: `${TRACKED_ACTIVITY} (legacy feature; removed in V2)` },
  entities: { kind: 'derived', owner: ENTITY_LIFECYCLE },
  entity_aliases: { kind: 'derived', owner: ENTITY_LIFECYCLE },
  entity_evidence_refs: { kind: 'derived', owner: ENTITY_LIFECYCLE },
  entity_relationships: { kind: 'derived', owner: ENTITY_LIFECYCLE },
  entity_suggestions: { kind: 'derived', owner: ENTITY_LIFECYCLE },
  memory_index_days: { kind: 'derived', owner: MEMORY_INDEX },
  memory_record_entities: { kind: 'derived', owner: MEMORY_INDEX },
  memory_record_vectors: { kind: 'derived', owner: MEMORY_INDEX },
  memory_records: { kind: 'derived', owner: MEMORY_INDEX },
  pattern_occurrences: { kind: 'derived', owner: PROJECTION_REBUILD },
  screen_eval_pairs: { kind: 'derived', owner: SCREEN_LIFECYCLE },
  segment_attributions: { kind: 'derived', owner: TRACKED_ACTIVITY },
  timeline_block_labels: { kind: 'derived', owner: PROJECTION_REBUILD },
  timeline_block_members: { kind: 'derived', owner: PROJECTION_REBUILD },
  timeline_blocks: { kind: 'derived', owner: PROJECTION_REBUILD },
  work_context_observations: { kind: 'derived', owner: TRACKED_ACTIVITY },
  work_session_evidence: { kind: 'derived', owner: TRACKED_ACTIVITY },
  work_session_segments: { kind: 'derived', owner: TRACKED_ACTIVITY },
  work_sessions: { kind: 'derived', owner: TRACKED_ACTIVITY },
  workflow_occurrences: { kind: 'derived', owner: PROJECTION_REBUILD },
  workflow_signatures: { kind: 'derived', owner: PROJECTION_REBUILD },
  wrapped_narratives: { kind: 'derived', owner: 'deleteWrappedNarrativesForDate on evidence change/deletion' },

  // ── user ─────────────────────────────────────────────────────────────────
  agent_turn_checkpoints: { kind: 'user', owner: AI_THREADS },
  ai_artifacts: { kind: 'user', owner: AI_THREADS },
  ai_conversation_state: { kind: 'user', owner: AI_THREADS },
  ai_conversations: { kind: 'user', owner: AI_THREADS },
  ai_messages: { kind: 'user', owner: AI_THREADS },
  ai_threads: { kind: 'user', owner: AI_THREADS },
  attribution_rules: { kind: 'user', owner: OWN_SETTINGS_FLOW },
  block_label_overrides: { kind: 'user', owner: 'correction undo/redo flows' },
  category_overrides: { kind: 'user', owner: OWN_SETTINGS_FLOW },
  client_aliases: { kind: 'user', owner: OWN_SETTINGS_FLOW },
  clients: { kind: 'user', owner: OWN_SETTINGS_FLOW },
  connector_connections: { kind: 'user', owner: `disconnect flow; ${CONNECTOR_PURGE}` },
  context_packets: { kind: 'user', owner: AI_THREADS },
  correction_undo_log: { kind: 'user', owner: 'correction undo/redo flows' },
  evidence_exclusions: { kind: 'user', owner: 'correction undo/redo flows' },
  file_access_grants: { kind: 'user', owner: 'grant revocation (revoke deletes derived text in the same statement)' },
  file_disclosures: { kind: 'user', owner: AI_THREADS },
  focus_sessions: { kind: 'user', owner: OWN_SETTINGS_FLOW },
  meeting_attendance_marks: { kind: 'user', owner: 'correction undo/redo flows' },
  memory_audit: { kind: 'user', owner: 'memory forget flow' },
  memory_proposal_rejections: { kind: 'user', owner: 'memory forget flow' },
  project_aliases: { kind: 'user', owner: OWN_SETTINGS_FLOW },
  projects: { kind: 'user', owner: OWN_SETTINGS_FLOW },
  supplied_memory_facts: { kind: 'user', owner: 'memory forget flow (deleteSuppliedFact)' },
  timeline_block_reviews: { kind: 'user', owner: 'correction undo/redo flows' },
  timeline_boundary_corrections: { kind: 'user', owner: 'correction undo/redo flows' },
  user_memory_facts: { kind: 'user', owner: 'memory forget flow' },
  work_memory_facts: { kind: 'user', owner: 'memory forget flow' },

  // ── system ───────────────────────────────────────────────────────────────
  ai_usage_daily_rollup: { kind: 'system', owner: DEVICE_ONLY },
  ai_usage_events: { kind: 'system', owner: `usage retention window; ${DEVICE_ONLY}` },
  browser_history_cursors: { kind: 'system', owner: DEVICE_ONLY },
  devices: { kind: 'system', owner: DEVICE_ONLY },
  maintenance_runs: { kind: 'system', owner: DEVICE_ONLY },
  provider_breaker_state: { kind: 'system', owner: DEVICE_ONLY },
  rebuild_jobs: { kind: 'system', owner: DEVICE_ONLY },
  schema_version: { kind: 'system', owner: DEVICE_ONLY },
}

// FTS5 shadow tables belong to their content table: the triggers that keep
// them in sync delete index rows in the same transaction that deletes the
// content row, so their ownership is the base table's ownership.
const FTS_SHADOW_SUFFIXES = ['_fts', '_fts_config', '_fts_data', '_fts_docsize', '_fts_idx']

/** The base table an FTS shadow belongs to, or null when not a shadow. */
export function ftsBaseTable(table: string): string | null {
  for (const suffix of FTS_SHADOW_SUFFIXES) {
    if (table.endsWith(suffix)) return table.slice(0, -suffix.length)
  }
  return null
}

/** Ownership for a table, resolving FTS shadows to their base table. */
export function deletionOwnershipFor(table: string): DeletionOwnership | null {
  const direct = DELETION_OWNERSHIP[table]
  if (direct) return direct
  const base = ftsBaseTable(table)
  if (base && DELETION_OWNERSHIP[base]) return DELETION_OWNERSHIP[base]
  return null
}
