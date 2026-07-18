import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import {
  __setTrackingFsmTestHarness,
  __pollForTest,
  __recoverPersistedLiveSnapshotForTest,
  getCurrentSession,
} from '../src/main/services/tracking.ts'
import {
  ActiveBrowserContextTracker,
  __setActiveBrowserContextTrackerForTest,
} from '../src/main/services/browserContext.ts'

// Sleep-gap regression tests: macOS lid-close sleep froze the poll timer
// WITHOUT firing the powerMonitor suspend or lock-screen events, so the
// pre-sleep session survived a 9h44m hole and absorbed it as active time
// ("Active now · 16h 34m"). poll() now detects a wall-clock gap between two
// ticks and ends the session at the last evidence of activity — the
// provisional-idle input boundary when we were already idle, else the last
// completed tick.

interface FlushInfo {
  startTime: number
  endTime: number
  durationSeconds: number
  endedReason: string | null
  persisted: boolean
}

const WIN = {
  title: 'Draft notes',
  application: 'TextEdit',
  path: '/Applications/TextEdit.app',
  pid: 4321,
  icon: '',
}

const DIA_WIN = {
  title: null,
  application: 'Dia',
  path: '/Applications/Dia.app',
  pid: 7331,
  icon: '',
}

// 10:00 local, mid-day so a 10h sleep still lands inside one calendar day is
// NOT possible — the overnight scenario intentionally crosses midnight the way
// the real bug did, exercising the midnight split on the flushed slice.
const BASE = new Date(2026, 6, 3, 10, 0, 0, 0).getTime()

function setupDb(): Database.Database {
  const db = createProductionTestDatabase()
  setTestDb(db)
  return db
}

interface Rig {
  db: Database.Database
  flushes: FlushInfo[]
  poll: (nowMs: number, opts?: { input?: boolean }) => Promise<void>
  input: (nowMs: number) => void
  teardown: () => void
}

function makeRig(activeWindow = () => WIN): Rig {
  const db = setupDb()
  const flushes: FlushInfo[] = []
  const clock = { now: BASE, lastInput: BASE }
  __setTrackingFsmTestHarness({
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow,
    recordFlush: (info) => flushes.push(info),
  })
  return {
    db,
    flushes,
    poll: (nowMs, opts) => {
      clock.now = nowMs
      if (opts?.input) clock.lastInput = nowMs
      return __pollForTest()
    },
    input: (nowMs) => {
      clock.lastInput = nowMs
    },
    teardown: () => {
      __setTrackingFsmTestHarness(null)
      __setActiveBrowserContextTrackerForTest(null)
      clearTestDb()
      db.close()
    },
  }
}

test('sleep still ends titleless Netflix passive-media time at the last awake poll', async () => {
  __setActiveBrowserContextTrackerForTest(new ActiveBrowserContextTracker(
    () => ({ url: 'https://netflix.com/watch/81234567', title: 'Netflix', modeKnown: true }),
    () => true,
  ))
  const rig = makeRig(() => DIA_WIN)
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 30_000, { input: true })
    await rig.poll(BASE + 85_000)
    await rig.poll(BASE + 140_000)
    await rig.poll(BASE + 155_000)
    assert.ok(getCurrentSession(), 'Netflix should be held open during ordinary no-input time')

    const wake = BASE + 4 * 3_600_000
    await rig.poll(wake, { input: true })

    const gapFlush = rig.flushes.find((flush) => flush.endedReason === 'sleep_gap')
    assert.ok(gapFlush)
    assert.equal(gapFlush?.endTime, BASE + 155_000)
    assert.equal(gapFlush?.durationSeconds, 155)
  } finally {
    rig.teardown()
  }
})

test('the July 6 shape: sleep during provisional idle ends the session at the true last input', async () => {
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true }) // session starts
    await rig.poll(BASE + 60_000, { input: true }) // 60s of real work — last input
    await rig.poll(BASE + 185_000) // idle 125s → provisional_idle (held open)

    // Lid closes ~3 min into idle, BEFORE the 300s away threshold can fire.
    // Timers freeze; the next poll is the first tick after wake, 10 hours
    // later, with the wake touch as fresh input.
    const wake = BASE + 10 * 3_600_000
    await rig.poll(wake, { input: true })

    // The pre-sleep session must end at the last real input (the provisional
    // idle boundary), never at the wake tick.
    const gapFlush = rig.flushes.find((f) => f.endedReason === 'sleep_gap')
    assert.ok(gapFlush, 'expected a sleep_gap flush')
    assert.equal(gapFlush.endTime, BASE + 60_000, 'flush must end at the true last-input time')
    assert.equal(gapFlush.durationSeconds, 60)
    assert.ok(gapFlush.persisted)

    // No persisted session may span the sleep hole.
    const rows = rig.db.prepare('SELECT start_time, end_time, duration_sec FROM app_sessions').all() as
      Array<{ start_time: number; end_time: number; duration_sec: number }>
    for (const row of rows) {
      assert.ok(
        row.end_time <= BASE + 185_000 || row.start_time >= wake,
        `session ${row.start_time}–${row.end_time} spans the sleep gap`,
      )
    }

    // The hole is logged as an absence so website reconciliation excludes it:
    // away_start backdated to the input boundary, away_end at the wake tick.
    const events = rig.db.prepare(
      'SELECT event_ts, event_type, metadata_json FROM activity_state_events ORDER BY event_ts',
    ).all() as Array<{ event_ts: number; event_type: string; metadata_json: string }>
    const awayStart = events.find((e) => e.event_type === 'away_start')
    assert.ok(awayStart, 'expected an away_start event for the gap')
    assert.equal(awayStart.event_ts, BASE + 60_000)
    assert.match(awayStart.metadata_json, /poll_gap/)
    assert.ok(events.some((e) => e.event_type === 'away_end' && e.event_ts >= wake))

    // Presence resumes cleanly: a fresh session is live after the wake poll.
    const live = getCurrentSession()
    assert.ok(live, 'expected a new session after wake')
    assert.ok(live.startTime >= wake - 1_000)
  } finally {
    rig.teardown()
  }
})

test('sleep while fully active ends the session at the last completed tick', async () => {
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 30_000, { input: true }) // active work, last tick before sleep

    const wake = BASE + 4 * 3_600_000
    await rig.poll(wake, { input: true })

    const gapFlush = rig.flushes.find((f) => f.endedReason === 'sleep_gap')
    assert.ok(gapFlush, 'expected a sleep_gap flush')
    assert.equal(gapFlush.endTime, BASE + 30_000, 'flush must end at the last completed poll tick')
    assert.equal(gapFlush.durationSeconds, 30)
  } finally {
    rig.teardown()
  }
})

test('normal poll cadence never triggers a gap flush', async () => {
  const rig = makeRig()
  try {
    for (let tick = 0; tick <= 12; tick++) {
      await rig.poll(BASE + tick * 5_000, { input: true })
    }
    assert.ok(!rig.flushes.some((f) => f.endedReason === 'sleep_gap'))
    assert.ok(getCurrentSession(), 'session stays live through normal cadence')
  } finally {
    rig.teardown()
  }
})

test('recovered live snapshot splits at local midnight', () => {
  const db = setupDb()
  try {
    // Reset FSM module state (also clears any live session from prior tests).
    __setTrackingFsmTestHarness(null)

    // The real shape: a session opened at 23:57 whose snapshot was last
    // bumped at 03:08 the next day (then the app died). Recovery must persist
    // one slice per calendar day, not a single cross-midnight row.
    const start = new Date(2026, 6, 5, 23, 57, 0, 0).getTime()
    const lastSeen = new Date(2026, 6, 6, 3, 8, 0, 0).getTime()
    db.prepare(`
      INSERT INTO live_app_session_snapshot (
        singleton, bundle_id, app_name, window_title, raw_app_name,
        canonical_app_id, app_instance_id, capture_source, category,
        start_time, last_seen_at
      ) VALUES (1, 'company.thebrowser.dia', 'Dia', 'Some page', 'Dia',
        'dia', 'company.thebrowser.dia', 'foreground_poll', 'browsing', ?, ?)
    `).run(start, lastSeen)
    db.prepare(`
      INSERT INTO focus_events (
        ts_ms, mono_ns, event_type, app_bundle_id, app_name, window_title,
        source, confidence, platform, schema_ver
      ) VALUES (?, 1, 'app_activated', 'company.thebrowser.dia', 'Dia', 'Some page',
        'foreground_poll', 'observed', 'darwin', 2)
    `).run(start)

    __recoverPersistedLiveSnapshotForTest()

    const rows = db.prepare(
      'SELECT start_time, end_time, duration_sec FROM app_sessions ORDER BY start_time',
    ).all() as Array<{ start_time: number; end_time: number; duration_sec: number }>
    assert.equal(rows.length, 2, 'expected one slice per calendar day')

    const midnight = new Date(2026, 6, 6, 0, 0, 0, 0).getTime()
    assert.equal(rows[0].start_time, start)
    assert.equal(rows[0].end_time, midnight)
    assert.equal(rows[1].start_time, midnight)
    assert.equal(rows[1].end_time, lastSeen)

    const deactivations = db.prepare(`
      SELECT ts_ms FROM focus_events
      WHERE source = 'foreground_poll' AND event_type = 'app_deactivated'
    `).all() as Array<{ ts_ms: number }>
    assert.deepEqual(deactivations, [{ ts_ms: lastSeen }])

    // Snapshot is consumed either way.
    const snapshotCount = db.prepare('SELECT COUNT(*) AS n FROM live_app_session_snapshot').get() as { n: number }
    assert.equal(snapshotCount.n, 0)
  } finally {
    // Clears the debounced attribution-refresh timer the recovery scheduled,
    // so it can't fire after the test DB is gone.
    __setTrackingFsmTestHarness(null)
    clearTestDb()
    db.close()
  }
})
