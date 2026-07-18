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
  sensitivity: EvidenceSensitivity
  provenance_method: string
  permission_scope: string
  policy_version: number
}

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
     url, page_title, source, confidence, platform, sensitivity,
     provenance_method, permission_scope, policy_version, schema_ver)
  VALUES
    (@evidence_id, @ts_ms, @mono_ns, @event_type, @app_bundle_id, @app_name, @pid, @window_title,
     @url, @page_title, @source, @confidence, @platform, @sensitivity,
     @provenance_method, @permission_scope, @policy_version, @schema_ver)
`

const STORED_COLUMNS = `
  id, evidence_id, ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
  window_title, url, page_title, source, confidence, platform, sensitivity,
  provenance_method, permission_scope, policy_version, schema_ver
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

export interface FocusEvidencePayload {
  eventType: FocusEvent['event_type']
  appBundleId: string | null
  appName: string | null
  pid: number | null
  windowTitle: string | null
  url: string | null
  pageTitle: string | null
  platform: string
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
