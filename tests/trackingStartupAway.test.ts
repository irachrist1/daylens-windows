// Starting (or restarting) tracking while the user is already away must
// record the away boundary. The regression this guards: after an overnight
// crash loop, each restart found no open session, silently entered 'away',
// and wrote nothing — so the projection had no idle boundary and the focus
// events the restarts themselves generated read as all-night presence.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import {
  __setTrackingFsmTestHarness,
  __pollForTest,
} from '../src/main/services/tracking.ts'

const WIN = {
  title: 'daylens — session',
  application: 'Warp',
  path: '/Applications/Warp.app',
  pid: 4321,
  icon: '',
}

const BASE = new Date(2026, 6, 22, 6, 30, 0, 0).getTime()

interface StateEventRow {
  event_type: string
  event_ts: number
  metadata_json: string
}

function stateEvents(db: Database.Database): StateEventRow[] {
  return db.prepare(
    'SELECT event_type, event_ts, metadata_json FROM activity_state_events ORDER BY id',
  ).all() as StateEventRow[]
}

test('first poll after start with the user long idle records a backdated away_start', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const clock = { now: BASE, lastInput: BASE - 8 * 3_600_000 }
  __setTrackingFsmTestHarness({
    platform: 'darwin',
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow: () => WIN,
    recordFlush: () => {},
  })
  try {
    await __pollForTest()

    const events = stateEvents(db)
    const awayStart = events.find((event) => event.event_type === 'away_start')
    assert.ok(awayStart, 'startup while away must record away_start')
    assert.equal(awayStart.event_ts, clock.lastInput, 'boundary must be backdated to the last input')
    assert.equal(JSON.parse(awayStart.metadata_json).inferredFrom, 'startup_idle')

    const supervisor = db.prepare(
      "SELECT ts_ms FROM focus_events WHERE event_type = 'idle_started'",
    ).all() as Array<{ ts_ms: number }>
    assert.equal(supervisor.length, 1, 'the canonical stream must get the idle boundary')
    assert.equal(supervisor[0].ts_ms, clock.lastInput)

    // Later polls with the user still away must not repeat the boundary.
    clock.now = BASE + 5_000
    await __pollForTest()
    clock.now = BASE + 10_000
    await __pollForTest()
    assert.equal(stateEvents(db).filter((event) => event.event_type === 'away_start').length, 1)

    // The user coming back closes the away period as before.
    clock.now = BASE + 60_000
    clock.lastInput = BASE + 60_000
    await __pollForTest()
    const after = stateEvents(db)
    assert.ok(after.some((event) => event.event_type === 'away_end'))
  } finally {
    __setTrackingFsmTestHarness(null)
    clearTestDb()
    db.close()
  }
})

test('starting with the user active records no phantom away boundary', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const clock = { now: BASE, lastInput: BASE - 1_000 }
  __setTrackingFsmTestHarness({
    platform: 'darwin',
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow: () => WIN,
    recordFlush: () => {},
  })
  try {
    await __pollForTest()
    assert.equal(stateEvents(db).filter((event) => event.event_type === 'away_start').length, 0)
  } finally {
    __setTrackingFsmTestHarness(null)
    clearTestDb()
    db.close()
  }
})
