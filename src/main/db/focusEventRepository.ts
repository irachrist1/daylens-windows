import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EvidenceEnvelope, EvidenceSensitivity } from '../core/evidence/envelope'
import {
  CAPTURE_POLICY_VERSION,
  FOCUS_EVENT_SCHEMA_VERSION,
  evidenceKindForFocusEventType,
  provenanceForFocusEventSource,
  validateFocusEventForInsert,
  type FocusEvent,
  type FocusEventInsert,
  type FocusEventRejectionReason,
  type FocusEvidenceKind,
} from '../core/evidence/focusEvent'
import { recordCaptureEventRejection } from '../lib/captureRejections'

export interface StoredFocusEvent extends FocusEvent {
  id: number
  evidence_id: string
  display_id: number | null
  sensitivity: EvidenceSensitivity
  provenance_method: string
  permission_scope: string
  policy_version: number
}

/** What a projection fold sees: evidence identity and provenance bookkeeping
 *  stay in the repository. `StoredFocusEvent` satisfies this shape, so a
 *  caller holding full rows can still pass them to a fold. */
export type ProjectionFocusEvent = Pick<
  StoredFocusEvent,
  | 'ts_ms'
  | 'event_type'
  | 'source'
  | 'display_id'
  | 'app_bundle_id'
  | 'app_name'
  | 'window_title'
  | 'url'
  | 'page_title'
  | 'confidence'
>

export interface InsertFocusEventsResult {
  inserted: number
  duplicates: number
  rejected: number
  rejectedReasons: FocusEventRejectionReason[]
}

// INSERT OR IGNORE + the idx_focus_events_identity unique index (source
// identity: adapter, kind, clock readings, and content) make a retried batch
// idempotent: already-committed evidence keeps its row and its evidence_id,
// the retry inserts nothing new.
const INSERT_FOCUS_EVENT = `
  INSERT OR IGNORE INTO focus_events
    (evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid, window_title,
     url, page_title, source, confidence, platform, display_id, sensitivity,
     provenance_method, permission_scope, policy_version, schema_ver)
  VALUES
    (@evidence_id, @ts_ms, @mono_ns, @event_type, @app_bundle_id, @app_name, @pid, @window_title,
     @url, @page_title, @source, @confidence, @platform, @display_id, @sensitivity,
     @provenance_method, @permission_scope, @policy_version, @schema_ver)
`

const STORED_COLUMNS = `
  id, evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
  window_title, url, page_title, source, confidence, platform, display_id, sensitivity,
  provenance_method, permission_scope, policy_version, schema_ver
`

// The columns the session, gap, and display-visibility folds actually read.
// A window read is the widest thing on the corrected-facts path — one Apps
// "All" range is half a million rows — and the ten columns left out (the
// evidence uuid, provenance, policy and schema bookkeeping) cost more to
// hydrate into JavaScript than the ten the folds consume.
const PROJECTION_COLUMNS = `
  ts_ms, event_type, source, display_id, app_bundle_id, app_name,
  window_title, url, page_title, confidence
`

function canonicalRow(event: FocusEventInsert): StoredFocusEvent {
  const provenance = provenanceForFocusEventSource(event.source)
  return {
    id: 0,
    evidence_id: event.evidence_id ?? randomUUID(),
    ts_ms: event.ts_ms,
    mono_ns: event.mono_ns,
    event_type: event.event_type,
    app_bundle_id: event.app_bundle_id,
    app_name: event.app_name,
    pid: event.pid,
    window_title: event.window_title,
    url: event.url,
    page_title: event.page_title,
    source: event.source,
    confidence: event.confidence,
    platform: event.platform,
    display_id: event.display_id ?? null,
    sensitivity: event.sensitivity ?? 'standard',
    provenance_method: event.provenance_method ?? provenance.method,
    permission_scope: event.permission_scope ?? provenance.permissionScope,
    policy_version: event.policy_version ?? CAPTURE_POLICY_VERSION,
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
  }
}

// A malformed or unsupported event is rejected, counted, and never partially
// persisted; the rest of the batch still commits in one transaction.
export function insertFocusEvents(
  db: Database.Database,
  events: readonly FocusEventInsert[],
): InsertFocusEventsResult {
  const result: InsertFocusEventsResult = { inserted: 0, duplicates: 0, rejected: 0, rejectedReasons: [] }
  if (events.length === 0) return result

  const accepted: StoredFocusEvent[] = []
  for (const event of events) {
    const rejection = validateFocusEventForInsert(event)
    if (rejection) {
      result.rejected += 1
      result.rejectedReasons.push(rejection)
      recordCaptureEventRejection('focus_repository', rejection)
      continue
    }
    accepted.push(canonicalRow(event))
  }
  if (accepted.length === 0) return result

  const insert = db.prepare(INSERT_FOCUS_EVENT)
  db.transaction((batch: readonly StoredFocusEvent[]) => {
    for (const row of batch) {
      const { id: _id, ...params } = row
      result.inserted += insert.run(params).changes
    }
  })(accepted)
  result.duplicates = accepted.length - result.inserted
  return result
}

// Range reads are half-open: fromMs inclusive, toMs exclusive. Ordering is
// wall-clock time, then stable insertion order.
export function listFocusEventsInRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): StoredFocusEvent[] {
  return db.prepare(`
    SELECT ${STORED_COLUMNS}
      FROM focus_events
     WHERE ts_ms >= ? AND ts_ms < ?
     ORDER BY ts_ms ASC, id ASC
  `).all(fromMs, toMs) as StoredFocusEvent[]
}

/** The same window as `listFocusEventsInRange`, narrowed to the columns the
 *  projections read. Ordering is identical, so a fold cannot tell the two
 *  reads apart. */
export function listProjectionFocusEventsInRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): ProjectionFocusEvent[] {
  return db.prepare(`
    SELECT ${PROJECTION_COLUMNS}
      FROM focus_events
     WHERE ts_ms >= ? AND ts_ms < ?
     ORDER BY ts_ms ASC, id ASC
  `).all(fromMs, toMs) as ProjectionFocusEvent[]
}

export function countFocusEventsInRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM focus_events WHERE ts_ms >= ? AND ts_ms < ?',
  ).get(fromMs, toMs) as { count: number }
  return row.count
}

/** The canonical capture era's first moment — the timestamp of the earliest
 *  focus event ever recorded, or null before any canonical capture ran.
 *  Evidence before this moment can only exist as legacy app_sessions rows;
 *  evidence at or after it is owned by the canonical projection. */
export function firstFocusEventTsMs(db: Database.Database): number | null {
  const row = db.prepare(
    'SELECT MIN(ts_ms) AS first FROM focus_events',
  ).get() as { first: number | null }
  return row.first ?? null
}

export interface FocusEventTimeAndType {
  ts_ms: number
  event_type: string
}

/** The most recent machine-state transitions strictly before a boundary —
 *  lets a day reconstruct whether it began asleep or locked. Returned
 *  newest-first, capped. */
export const MACHINE_STATE_EVENTS_BEFORE_SQL = `
    SELECT ts_ms, event_type
    FROM focus_events
    WHERE ts_ms < ? AND event_type IN ('sleep', 'wake', 'lock', 'unlock')
    ORDER BY ts_ms DESC
    LIMIT ?
  `

export function listMachineStateEventsBefore(
  db: Database.Database,
  beforeMs: number,
  limit = 20,
): FocusEventTimeAndType[] {
  return db.prepare(MACHINE_STATE_EVENTS_BEFORE_SQL).all(beforeMs, limit) as FocusEventTimeAndType[]
}

/** Event timestamps and types for a window, chronological. */
export function listFocusEventTimesInRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): FocusEventTimeAndType[] {
  return db.prepare(`
    SELECT ts_ms, event_type
    FROM focus_events
    WHERE ts_ms >= ? AND ts_ms < ?
    ORDER BY ts_ms
  `).all(fromMs, toMs) as FocusEventTimeAndType[]
}

export interface CaptureTitleSampleStats {
  recentSamples: number
  withTitle: number
  lastCapturedAtMs: number | null
}

/** Capture-health counts: how many recent native-helper foreground samples
 *  carried a window title. Counts only — no titles or identities leave the
 *  repository. */
export function getNativeCaptureTitleStats(
  db: Database.Database,
  sinceMs: number,
): CaptureTitleSampleStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS recent_samples,
      SUM(CASE WHEN window_title IS NOT NULL AND trim(window_title) <> '' THEN 1 ELSE 0 END) AS with_title,
      MAX(CASE WHEN window_title IS NOT NULL AND trim(window_title) <> '' THEN ts_ms ELSE NULL END) AS last_captured_at
    FROM focus_events
    WHERE source IN ('nsworkspace_event', 'uia_foreground')
      AND event_type IN ('app_activated', 'window_changed', 'space_changed')
      AND ts_ms >= ?
  `).get(sinceMs) as {
    recent_samples: number
    with_title: number | null
    last_captured_at: number | null
  }
  return {
    recentSamples: row.recent_samples,
    withTitle: row.with_title ?? 0,
    lastCapturedAtMs: row.last_captured_at,
  }
}

/** Display-visibility samples plus the machine-state boundaries that bound
 *  them, chronological. The projection needs both in one ordered stream so a
 *  sleep or lock closes a visible span exactly where it happened. */
export function listDisplayVisibilityEventsInRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): ProjectionFocusEvent[] {
  return db.prepare(`
    SELECT ${PROJECTION_COLUMNS}
      FROM focus_events
     WHERE ts_ms >= ? AND ts_ms < ?
       AND (
         source = 'cg_display_visibility'
         OR event_type IN ('sleep', 'lock', 'capture_stopped', 'capture_paused', 'capture_failed')
       )
     ORDER BY ts_ms ASC, id ASC
  `).all(fromMs, toMs) as ProjectionFocusEvent[]
}

export interface DisplayVisibilityStats {
  recentSamples: number
  distinctDisplays: number
  samplesWithApp: number
  lastSampleAtMs: number | null
}

/** Capture-health counts for the per-display visibility stream. Counts only —
 *  no app identities or titles leave the repository. */
export function getDisplayVisibilityStats(
  db: Database.Database,
  sinceMs: number,
): DisplayVisibilityStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS recent_samples,
      COUNT(DISTINCT display_id) AS distinct_displays,
      SUM(CASE WHEN app_bundle_id IS NOT NULL OR app_name IS NOT NULL THEN 1 ELSE 0 END) AS with_app,
      MAX(ts_ms) AS last_sample_at
    FROM focus_events
    WHERE source = 'cg_display_visibility'
      AND ts_ms >= ?
  `).get(sinceMs) as {
    recent_samples: number
    distinct_displays: number | null
    with_app: number | null
    last_sample_at: number | null
  }
  return {
    recentSamples: row.recent_samples,
    distinctDisplays: row.distinct_displays ?? 0,
    samplesWithApp: row.with_app ?? 0,
    lastSampleAtMs: row.last_sample_at,
  }
}

export interface FocusEvidencePayload {
  eventType: FocusEvent['event_type']
  appBundleId: string | null
  appName: string | null
  pid: number | null
  windowTitle: string | null
  url: string | null
  pageTitle: string | null
  platform: string
  // Set only on display-visibility evidence: which display showed the window.
  displayId: number | null
}

export type FocusEvidenceEnvelope = EvidenceEnvelope<FocusEvidenceKind, FocusEvidencePayload>

export function toFocusEvidenceEnvelope(
  row: StoredFocusEvent,
  deviceId: string,
): FocusEvidenceEnvelope | null {
  const kind = evidenceKindForFocusEventType(row.event_type)
  if (kind === null) return null
  return {
    evidenceId: row.evidence_id,
    kind,
    source: { adapter: row.source, deviceId, sourceRecordId: null },
    observedAtMs: row.ts_ms,
    monotonicNs: row.mono_ns,
    interval: null,
    subjects: {},
    sensitivity: row.sensitivity,
    confidence: row.confidence,
    provenance: {
      method: row.provenance_method,
      permissionScope: row.permission_scope,
      policyVersion: row.policy_version,
    },
    schemaVersion: row.schema_ver,
    payload: {
      eventType: row.event_type,
      appBundleId: row.app_bundle_id,
      appName: row.app_name,
      pid: row.pid,
      windowTitle: row.window_title,
      url: row.url,
      pageTitle: row.page_title,
      platform: row.platform,
      displayId: row.display_id ?? null,
    },
  }
}

// Application, machine-state, and capture-state evidence as canonical
// envelopes. Tab events are excluded: browser page evidence flows through the
// privacy-verified browser path, not this contract.
export function listFocusEvidenceInRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  deviceId: string,
): FocusEvidenceEnvelope[] {
  const envelopes: FocusEvidenceEnvelope[] = []
  for (const row of listFocusEventsInRange(db, fromMs, toMs)) {
    const envelope = toFocusEvidenceEnvelope(row, deviceId)
    if (envelope) envelopes.push(envelope)
  }
  return envelopes
}
