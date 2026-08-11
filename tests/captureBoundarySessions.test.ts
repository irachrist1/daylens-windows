// Capture boundaries must bound derived sessions and gaps. The regression
// this guards: an overnight crash loop (no capture_stopped, capture_started
// on each restart) left the last focused app's session open across every dead
// stretch, so a machine nobody touched projected as a night of continuous
// use — the day view reported the user never slept.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { insertFocusEvents } from '../src/main/db/focusEventRepository.ts'
import {
  FOCUS_EVENT_SCHEMA_VERSION,
  POLL_FOCUS_EVENT_SOURCE,
  SUPERVISOR_FOCUS_EVENT_SOURCE,
  type FocusEventInsert,
} from '../src/main/core/evidence/focusEvent.ts'
import { queryCorrectedActivityFactsForDay } from '../src/main/core/query/activityFactsQuery.ts'

const DATE = '2026-04-22'

function ms(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 3, 22, hour, minute, second, 0).getTime()
}

function focusEvent(
  tsMs: number,
  eventType: FocusEventInsert['event_type'],
  overrides: Partial<FocusEventInsert> = {},
): FocusEventInsert {
  return {
    ts_ms: tsMs,
    mono_ns: tsMs * 1_000_000,
    event_type: eventType,
    app_bundle_id: overrides.app_bundle_id ?? 'dev.warp.Warp-Stable',
    app_name: overrides.app_name ?? 'Warp',
    pid: overrides.pid ?? 1001,
    window_title: overrides.window_title ?? 'daylens — session',
    url: null,
    page_title: null,
    source: POLL_FOCUS_EVENT_SOURCE,
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: FOCUS_EVENT_SCHEMA_VERSION,
    ...overrides,
  }
}

function supervisorEvent(
  tsMs: number,
  eventType: FocusEventInsert['event_type'],
): FocusEventInsert {
  return focusEvent(tsMs, eventType, {
    app_bundle_id: null,
    app_name: null,
    pid: null,
    window_title: null,
    source: SUPERVISOR_FOCUS_EVENT_SOURCE,
  })
}

function facts(db: Database.Database) {
  return queryCorrectedActivityFactsForDay(db, DATE, { nowMs: ms(23, 59) })
}

test('a clean capture_stopped closes the open session and opens a capture gap', () => {
  const db = createProductionTestDatabase()
  try {
    insertFocusEvents(db, [
      focusEvent(ms(9, 0), 'app_activated'),
      supervisorEvent(ms(9, 30), 'capture_stopped'),
      supervisorEvent(ms(11, 0), 'capture_started'),
      focusEvent(ms(11, 0, 5), 'app_activated'),
      focusEvent(ms(11, 30), 'app_deactivated'),
    ])
    const result = facts(db)

    const warp = result.sessions.filter((s) => s.appName === 'Warp')
    assert.equal(warp.length, 2)
    assert.equal(warp[0].endTime, ms(9, 30), 'first session must end at capture_stopped')
    assert.equal(warp[1].startTime, ms(11, 0, 5))

    const captureGap = result.gaps.find((gap) => gap.kind === 'capture_unavailable')
    assert.ok(captureGap, 'stop → start stretch must surface as capture_unavailable')
    assert.equal(captureGap.startMs, ms(9, 30))
    assert.equal(captureGap.endMs, ms(11, 0))
  } finally {
    db.close()
  }
})

test('a crash (capture_started with no stop) ends the dangling session at its last evidence', () => {
  const db = createProductionTestDatabase()
  try {
    insertFocusEvents(db, [
      focusEvent(ms(22, 0), 'app_activated'),
      focusEvent(ms(22, 45), 'window_changed', { window_title: 'daylens — build' }),
      // Crash here: no capture_stopped, five silent hours, then a restart.
      supervisorEvent(ms(23, 30), 'capture_started'),
      focusEvent(ms(23, 30, 10), 'app_activated'),
      focusEvent(ms(23, 40), 'app_deactivated'),
    ])
    const result = facts(db)

    const warp = result.sessions.filter((s) => s.appName === 'Warp')
    assert.equal(warp.length, 2)
    assert.equal(
      warp[0].endTime,
      ms(22, 45),
      'the pre-crash session must end at its last recorded event, not span the dead stretch',
    )
    assert.equal(warp[1].startTime, ms(23, 30, 10))
  } finally {
    db.close()
  }
})

test('the overnight crash-loop shape does not project as continuous activity', () => {
  const db = createProductionTestDatabase()
  try {
    // The July 21 shape compressed into one day: the user stops touching the
    // machine at 20:37; the app restarts through the evening while a terminal
    // keeps changing titles in the background.
    insertFocusEvents(db, [
      focusEvent(ms(20, 0), 'app_activated'),
      supervisorEvent(ms(20, 37), 'idle_started'),
      // Wedged run dies without a stop; restarts follow.
      supervisorEvent(ms(21, 30), 'capture_started'),
      // Restart steals focus back and forth; the user is not there.
      focusEvent(ms(21, 30, 5), 'app_activated'),
      focusEvent(ms(21, 30, 40), 'window_changed', { window_title: 'daylens — rebuild' }),
      supervisorEvent(ms(23, 0), 'capture_started'),
      focusEvent(ms(23, 0, 5), 'app_activated'),
      focusEvent(ms(23, 0, 30), 'window_changed', { window_title: 'daylens — rebuild 2' }),
    ])
    const result = facts(db)

    const activeSeconds = result.totalSeconds
    // Honest reading: ~37 min before idle, plus the seconds each restart
    // actually recorded evidence for, plus the trailing open session. The
    // 20:00 → 23:59 window is almost four hours; anything close to that means
    // dead stretches were counted as use.
    assert.ok(
      activeSeconds < 2 * 3_600,
      `dead overnight stretches must not count as activity (got ${activeSeconds}s)`,
    )
    const idleGap = result.gaps.find((gap) => gap.kind === 'idle' && gap.startMs === ms(20, 37))
    assert.ok(idleGap, 'the idle boundary before the crash must open a gap')
  } finally {
    db.close()
  }
})
