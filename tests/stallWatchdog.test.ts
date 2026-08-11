// DEV-261: a blocked main thread must become part of the day's record, not a
// silent hole. The heartbeat cannot fire while the thread is blocked, so a
// late tick is the stall itself; CPU across the hole separates a wedge (burns
// CPU) from machine sleep (burns none, and is owned by the poll gap detector).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import {
  classifyHeartbeatHole,
  setStallObserverForTests,
  startStallWatchdog,
  stopStallWatchdog,
  type StallObservation,
} from '../src/main/services/stallWatchdog.ts'
import { queryCorrectedActivityFactsForDay } from '../src/main/core/query/activityFactsQuery.ts'

test('classification: short holes are nothing, busy holes are stalls, idle holes are sleep', () => {
  assert.equal(classifyHeartbeatHole(3_000, 3_000), null)
  assert.equal(classifyHeartbeatHole(30_000, 29_000), 'stall')
  assert.equal(classifyHeartbeatHole(30_000, 100), 'machine-asleep')
  assert.equal(classifyHeartbeatHole(4 * 3_600_000, 50_000), 'machine-asleep')
  assert.equal(classifyHeartbeatHole(90 * 60_000, 85 * 60_000), 'stall')
})

test('a confirmed stall lands in the evidence stream and projects as capture unavailable', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const observations: StallObservation[] = []
  setStallObserverForTests((o) => observations.push(o))

  // Scripted clock: first tick normal, then a 2-minute hole burning CPU.
  const base = new Date(2026, 6, 22, 14, 0, 0, 0).getTime()
  let nowValue = base
  let cpuValue = 0
  const ticks: Array<{ now: number; cpu: number }> = [
    { now: base + 1_000, cpu: 100 },
    { now: base + 1_000 + 121_000, cpu: 115_000 },
  ]
  startStallWatchdog({
    now: () => nowValue,
    cpuMs: () => cpuValue,
  })
  try {
    // Drive the interval manually by invoking its callback via timers is not
    // possible here; instead simulate by re-entering through the public seam:
    // stop and restart with a fake interval is overkill — the watchdog's
    // interval fires on real time, so poke the scripted values and wait one
    // real heartbeat per scripted tick.
    for (const tick of ticks) {
      nowValue = tick.now
      cpuValue = tick.cpu
      await new Promise((resolve) => setTimeout(resolve, 1_100))
    }

    assert.equal(observations.length, 1)
    assert.equal(observations[0].kind, 'stall')
    assert.ok(observations[0].durationMs >= 119_000)

    const supervisor = db.prepare(
      "SELECT event_type, ts_ms FROM focus_events WHERE event_type IN ('capture_failed','capture_recovered') ORDER BY ts_ms",
    ).all() as Array<{ event_type: string; ts_ms: number }>
    assert.deepEqual(supervisor.map((row) => row.event_type), ['capture_failed', 'capture_recovered'])
    assert.equal(supervisor[0].ts_ms, base + 1_000)

    const facts = queryCorrectedActivityFactsForDay(db, '2026-07-22', { nowMs: base + 10 * 60_000 })
    const gap = facts.gaps.find((g) => g.kind === 'capture_unavailable')
    assert.ok(gap, 'the stall must appear on the day as a capture-unavailable gap')
    assert.equal(gap.startMs, base + 1_000)
  } finally {
    stopStallWatchdog()
    setStallObserverForTests(null)
    clearTestDb()
    db.close()
  }
})

test('a machine-sleep hole records nothing — sleep belongs to the poll gap detector', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const observations: StallObservation[] = []
  setStallObserverForTests((o) => observations.push(o))

  const base = new Date(2026, 6, 22, 22, 0, 0, 0).getTime()
  let nowValue = base
  const cpuValue = 500
  startStallWatchdog({ now: () => nowValue, cpuMs: () => cpuValue })
  try {
    nowValue = base + 8 * 3_600_000 // 8h hole, zero CPU burned
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    assert.equal(observations.length, 1)
    assert.equal(observations[0].kind, 'machine-asleep')
    const supervisor = db.prepare(
      "SELECT COUNT(*) AS c FROM focus_events WHERE event_type IN ('capture_failed','capture_recovered')",
    ).get() as { c: number }
    assert.equal(supervisor.c, 0)
  } finally {
    stopStallWatchdog()
    setStallObserverForTests(null)
    clearTestDb()
    db.close()
  }
})
