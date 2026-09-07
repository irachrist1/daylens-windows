// The reads that ask for one kind of focus event inside a window must seek,
// not scan. Before (event_type, ts_ms) existed, the per-block tab-evidence
// query could only use the event_type index: it walked every tab event ever
// recorded — 128k rows on a real profile — once per block, then sorted the
// result in a temp B-tree. The Timeline day payload spent 651ms there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  MACHINE_STATE_EVENTS_BEFORE_SQL,
  insertFocusEvents,
} from '../src/main/db/focusEventRepository.ts'
import { TAB_EVIDENCE_SQL } from '../src/main/services/workBlocks.ts'
import type { FocusEventInsert } from '../src/main/core/evidence/focusEvent.ts'

// The statements below are imported, not copied: a plan assertion against a
// test-owned duplicate would keep passing after the real query stopped using
// the index.

function plan(db: ReturnType<typeof createProductionTestDatabase>, sql: string, ...params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(' | ')
}

function tabEvent(tsMs: number, url: string): FocusEventInsert {
  return {
    ts_ms: tsMs,
    mono_ns: tsMs * 1_000_000,
    event_type: 'tab_changed',
    app_bundle_id: 'com.google.Chrome',
    app_name: 'Google Chrome',
    pid: 1,
    window_title: 'Chrome',
    url,
    page_title: 'A page',
    source: 'apple_events_tab',
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: 2,
  }
}

test('focus_events carries the composite (event_type, ts_ms) index and not the single-column one', () => {
  const db = createProductionTestDatabase()
  try {
    const indexes = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'focus_events'`,
    ).all() as Array<{ name: string }>).map((row) => row.name)

    assert.ok(indexes.includes('idx_focus_events_type_ts'), `expected the composite index, got ${indexes.join(', ')}`)
    assert.ok(
      !indexes.includes('idx_focus_events_type'),
      'the single-column event_type index is redundant once the composite exists and must not linger on the insert path',
    )
    assert.ok(indexes.includes('idx_focus_events_ts'), 'range-only reads still need the ts_ms index')
  } finally {
    db.close()
  }
})

test('the per-block tab-evidence read seeks on event_type AND ts_ms', () => {
  const db = createProductionTestDatabase()
  try {
    const detail = plan(db, TAB_EVIDENCE_SQL, 0, 1)
    assert.match(detail, /idx_focus_events_type_ts/)
    assert.match(detail, /ts_ms>/, `the window must narrow the index seek, not filter after it: ${detail}`)
  } finally {
    db.close()
  }
})

test('the machine-state lookback seeks on event_type AND ts_ms', () => {
  const db = createProductionTestDatabase()
  try {
    const detail = plan(db, MACHINE_STATE_EVENTS_BEFORE_SQL, 0, 20)
    assert.match(detail, /idx_focus_events_type_ts/)
    assert.match(detail, /ts_ms</, `the boundary must narrow the index seek: ${detail}`)
  } finally {
    db.close()
  }
})

test('the tab-evidence read returns the same rows the window contains', () => {
  const db = createProductionTestDatabase()
  try {
    insertFocusEvents(db, [
      tabEvent(1_000, 'https://example.com/before'),
      tabEvent(2_000, 'https://example.com/inside-a'),
      tabEvent(2_500, 'https://example.com/inside-b'),
      tabEvent(3_000, 'https://example.com/after'),
    ])
    const rows = db.prepare(TAB_EVIDENCE_SQL).all(2_000, 3_000) as Array<{ url: string }>
    assert.deepEqual(rows.map((row) => row.url), [
      'https://example.com/inside-a',
      'https://example.com/inside-b',
    ])
  } finally {
    db.close()
  }
})
