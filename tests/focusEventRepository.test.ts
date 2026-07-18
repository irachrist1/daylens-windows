import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  countFocusEventsInRange,
  insertFocusEvents,
  listFocusEventsInRange,
  listFocusEvidenceInRange,
  toFocusEvidenceEnvelope,
} from '../src/main/db/focusEventRepository.ts'
import { projectDay } from '../src/main/core/projections/chunk2.ts'
import type { FocusEventInsert } from '../src/main/core/evidence/focusEvent.ts'
import {
  getCaptureEventRejections,
  resetCaptureEventRejectionsForTest,
} from '../src/main/lib/captureRejections.ts'

function event(tsMs: number, appName: string, overrides: Partial<FocusEventInsert> = {}): FocusEventInsert {
  return {
    ts_ms: tsMs,
    mono_ns: tsMs * 1_000_000,
    event_type: 'app_activated',
    app_bundle_id: `test.${appName.toLowerCase().replace(/\s+/g, '')}`,
    app_name: appName,
    pid: 1,
    window_title: null,
    url: null,
    page_title: null,
    source: 'nsworkspace_event',
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: 2,
    ...overrides,
  }
}

test('focus event repository batches inserts and returns a stable range order', () => {
  const db = createProductionTestDatabase()
  try {
    insertFocusEvents(db, [event(200, 'Second'), event(100, 'First A'), event(100, 'First B')])

    const rows = listFocusEventsInRange(db, 100, 201)
    assert.deepEqual(rows.map((row) => row.app_name), ['First A', 'First B', 'Second'])
  } finally {
    db.close()
  }
})

test('range reads are half-open: start inclusive, end exclusive', () => {
  const db = createProductionTestDatabase()
  try {
    insertFocusEvents(db, [event(100, 'At Start'), event(199, 'Inside'), event(200, 'At End')])

    assert.equal(countFocusEventsInRange(db, 100, 200), 2)
    assert.equal(countFocusEventsInRange(db, 100, 201), 3)
    assert.deepEqual(
      listFocusEventsInRange(db, 100, 200).map((row) => row.app_name),
      ['At Start', 'Inside'],
    )
  } finally {
    db.close()
  }
})

test('focus event repository treats an empty insert as a no-op', () => {
  const db = createProductionTestDatabase()
  try {
    const result = insertFocusEvents(db, [])
    assert.deepEqual(result, { inserted: 0, duplicates: 0, rejected: 0, rejectedReasons: [] })
    assert.equal(countFocusEventsInRange(db, 0, 1_000), 0)
  } finally {
    db.close()
  }
})

test('every inserted event gets a stable, unique evidence identity and provenance', () => {
  const db = createProductionTestDatabase()
  try {
    insertFocusEvents(db, [event(100, 'Editor'), event(200, 'Browser')])

    const rows = listFocusEventsInRange(db, 0, 1_000)
    assert.equal(rows.length, 2)
    const ids = new Set(rows.map((row) => row.evidence_id))
    assert.equal(ids.size, 2)
    for (const row of rows) {
      assert.ok(row.evidence_id.length > 0)
      assert.equal(row.sensitivity, 'standard')
      assert.equal(row.provenance_method, 'nsworkspace_event')
      assert.equal(row.permission_scope, 'macos_foreground_observation')
      assert.equal(row.policy_version, 1)
      assert.equal(row.schema_ver, 2)
    }
  } finally {
    db.close()
  }
})

test('a retried batch is idempotent: no duplicate rows, evidence identities unchanged', () => {
  const db = createProductionTestDatabase()
  try {
    const batch = [event(100, 'Editor'), event(200, 'Browser')]
    const first = insertFocusEvents(db, batch)
    assert.equal(first.inserted, 2)

    const before = listFocusEventsInRange(db, 0, 1_000)

    const retry = insertFocusEvents(db, batch)
    assert.equal(retry.inserted, 0)
    assert.equal(retry.duplicates, 2)

    const after = listFocusEventsInRange(db, 0, 1_000)
    assert.deepEqual(after, before)
  } finally {
    db.close()
  }
})

test('a version-1 wire event is lifted to the canonical contract on insert', () => {
  const db = createProductionTestDatabase()
  try {
    const result = insertFocusEvents(db, [event(100, 'Editor', { schema_ver: 1 })])
    assert.equal(result.inserted, 1)

    const [row] = listFocusEventsInRange(db, 0, 1_000)
    assert.equal(row.schema_ver, 2)
    assert.ok(row.evidence_id.length > 0)
  } finally {
    db.close()
  }
})

test('unsupported schema versions are rejected, counted, and never partially persisted', () => {
  const db = createProductionTestDatabase()
  resetCaptureEventRejectionsForTest()
  try {
    const result = insertFocusEvents(db, [
      event(100, 'Kept'),
      event(200, 'Future', { schema_ver: 3 }),
      event(300, 'Also Kept'),
    ])
    assert.equal(result.inserted, 2)
    assert.equal(result.rejected, 1)
    assert.deepEqual(result.rejectedReasons, ['unsupported_schema_version'])
    assert.deepEqual(
      listFocusEventsInRange(db, 0, 1_000).map((row) => row.app_name),
      ['Kept', 'Also Kept'],
    )

    const rejections = getCaptureEventRejections()
    assert.equal(rejections.focus_repository?.byReason.unsupported_schema_version, 1)
  } finally {
    resetCaptureEventRejectionsForTest()
    db.close()
  }
})

test('machine-state and capture-state events are first-class canonical evidence', () => {
  const db = createProductionTestDatabase()
  try {
    const supervisor = (tsMs: number, eventType: FocusEventInsert['event_type']): FocusEventInsert =>
      event(tsMs, 'ignored', {
        event_type: eventType,
        source: 'capture_supervisor',
        app_bundle_id: null,
        app_name: null,
        pid: null,
      })

    const result = insertFocusEvents(db, [
      supervisor(100, 'capture_started'),
      supervisor(200, 'idle_started'),
      supervisor(300, 'idle_ended'),
      supervisor(400, 'capture_paused'),
      supervisor(500, 'capture_resumed'),
      supervisor(600, 'capture_failed'),
      supervisor(700, 'capture_recovered'),
      supervisor(800, 'capture_stopped'),
    ])
    assert.equal(result.inserted, 8)
    assert.equal(result.rejected, 0)

    const envelopes = listFocusEvidenceInRange(db, 0, 1_000, 'device-under-test')
    assert.deepEqual(
      envelopes.map((envelope) => envelope.kind),
      [
        'capture_started', 'idle_started', 'idle_ended', 'capture_paused',
        'capture_resumed', 'capture_failed', 'capture_recovered', 'capture_stopped',
      ],
    )
    for (const envelope of envelopes) {
      assert.equal(envelope.payload.appName, null)
      assert.equal(envelope.payload.windowTitle, null)
      assert.equal(envelope.payload.url, null)
      assert.equal(envelope.provenance.method, 'capture_supervisor')
    }
  } finally {
    db.close()
  }
})

test('a supervisor event carrying content is rejected before persistence', () => {
  const db = createProductionTestDatabase()
  resetCaptureEventRejectionsForTest()
  try {
    const result = insertFocusEvents(db, [
      event(100, 'Leaky', { event_type: 'capture_failed', source: 'capture_supervisor' }),
      event(200, 'Idle Leak', { event_type: 'idle_started', source: 'capture_supervisor' }),
    ])
    assert.equal(result.inserted, 0)
    assert.deepEqual(result.rejectedReasons, ['supervisor_content', 'supervisor_content'])
    assert.equal(countFocusEventsInRange(db, 0, 1_000), 0)
  } finally {
    resetCaptureEventRejectionsForTest()
    db.close()
  }
})

test('a supervisor idle row carrying content violates the storage constraints too', () => {
  const db = createProductionTestDatabase()
  try {
    assert.throws(() => {
      db.prepare(`
        INSERT INTO focus_events
          (ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid, window_title,
           url, page_title, source, confidence, platform)
        VALUES (100, 100000000, 'idle_started', NULL, 'Leaky App', NULL, NULL,
                NULL, NULL, 'capture_supervisor', 'observed', 'darwin')
      `).run()
    }, /CHECK/)
  } finally {
    db.close()
  }
})

test('a value outside the storage allowlists is a counted rejection, not a duplicate', () => {
  const db = createProductionTestDatabase()
  resetCaptureEventRejectionsForTest()
  try {
    const result = insertFocusEvents(db, [
      event(100, 'Typo Kind', { event_type: 'app_actived' as never }),
      event(200, 'Typo Confidence', { confidence: 'certain' as never }),
      event(300, 'Typo Source', { source: 'unknown_helper' as never }),
    ])
    assert.equal(result.inserted, 0)
    assert.equal(result.duplicates, 0)
    assert.equal(result.rejected, 3)
    assert.deepEqual(result.rejectedReasons, ['unknown_event_type', 'unknown_confidence', 'unknown_source'])
    assert.equal(countFocusEventsInRange(db, 0, 1_000), 0)
    assert.equal(getCaptureEventRejections().focus_repository.total, 3)
  } finally {
    resetCaptureEventRejectionsForTest()
    db.close()
  }
})

test('stored rows round-trip into canonical evidence envelopes', () => {
  const db = createProductionTestDatabase()
  try {
    insertFocusEvents(db, [
      event(100, 'Editor', { window_title: 'notes.md' }),
      event(200, 'ignored', {
        event_type: 'lock',
        app_bundle_id: null,
        app_name: null,
        pid: null,
      }),
      event(300, 'Browser', {
        event_type: 'tab_changed',
        source: 'apple_events_tab',
        url: 'https://example.com/docs',
        page_title: 'Docs',
      }),
    ])

    const rows = listFocusEventsInRange(db, 0, 1_000)
    assert.equal(rows.length, 3)

    const envelopes = listFocusEvidenceInRange(db, 0, 1_000, 'device-under-test')
    assert.deepEqual(envelopes.map((envelope) => envelope.kind), ['app_activated', 'locked'])

    const [appEnvelope] = envelopes
    const appRow = rows[0]
    assert.equal(appEnvelope.evidenceId, appRow.evidence_id)
    assert.equal(appEnvelope.observedAtMs, appRow.ts_ms)
    assert.equal(appEnvelope.monotonicNs, appRow.mono_ns)
    assert.equal(appEnvelope.source.adapter, 'nsworkspace_event')
    assert.equal(appEnvelope.source.deviceId, 'device-under-test')
    assert.equal(appEnvelope.source.sourceRecordId, null)
    assert.equal(appEnvelope.sensitivity, 'standard')
    assert.equal(appEnvelope.confidence, 'observed')
    assert.equal(appEnvelope.provenance.policyVersion, 1)
    assert.equal(appEnvelope.schemaVersion, 2)
    assert.equal(appEnvelope.payload.windowTitle, 'notes.md')

    const tabRow = rows[2]
    assert.equal(toFocusEvidenceEnvelope(tabRow, 'device-under-test'), null)
  } finally {
    db.close()
  }
})

test('rebuilding a projection never changes an evidence identity', () => {
  const db = createProductionTestDatabase()
  try {
    const dayStart = new Date(2026, 5, 10, 9, 0, 0, 0).getTime()
    insertFocusEvents(db, [
      event(dayStart, 'Editor'),
      event(dayStart + 30 * 60_000, 'Browser'),
      event(dayStart + 60 * 60_000, 'ignored', {
        event_type: 'app_deactivated',
        app_bundle_id: null,
        app_name: null,
        pid: null,
      }),
    ])

    const identitiesBefore = listFocusEventsInRange(db, 0, Number.MAX_SAFE_INTEGER)
      .map((row) => [row.id, row.evidence_id])

    const firstRun = projectDay(db, '2026-06-10', { now: new Date(2026, 5, 12) })
    assert.equal(firstRun.skipped, false)
    const secondRun = projectDay(db, '2026-06-10', { now: new Date(2026, 5, 12) })
    assert.equal(secondRun.skipped, false)

    const identitiesAfter = listFocusEventsInRange(db, 0, Number.MAX_SAFE_INTEGER)
      .map((row) => [row.id, row.evidence_id])
    assert.deepEqual(identitiesAfter, identitiesBefore)
    assert.equal(firstRun.sessions, secondRun.sessions)
    assert.equal(firstRun.blocks, secondRun.blocks)
  } finally {
    db.close()
  }
})
