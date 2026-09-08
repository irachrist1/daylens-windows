// Startup maintenance heals historical drift and nothing the first paint reads
// is waiting on it. It used to start on the macrotask after initDb(), which
// lands before the renderer has loaded — so on the one launch it actually does
// work, the first after a WORK_NAME_GUARD_VERSION bump, it held the window off
// screen for eleven seconds on a real database. Someone who gave up and quit
// got the whole pass again next launch, because the completion stamp is only
// written at the end.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  holdStartupMaintenance,
  resetStartupMaintenanceGateForTest,
  scheduleStartupMaintenance,
} from '../src/main/lib/startupMaintenanceGate.ts'

/** Enough loop turns for a setImmediate handoff to settle. */
async function settle(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('with nobody holding it, maintenance keeps its original timing', async () => {
  // The range worker, the CLI and the tests all open the database without a
  // window. They set no holder, so nothing should start waiting for one.
  resetStartupMaintenanceGateForTest()
  let ran = false
  scheduleStartupMaintenance(() => { ran = true })
  assert.equal(ran, false, 'still a macrotask away, exactly as before')
  await settle()
  assert.equal(ran, true)
})

test('a held gate keeps maintenance from starting until it is released', async () => {
  resetStartupMaintenanceGateForTest()
  const release = holdStartupMaintenance()
  let ran = false
  scheduleStartupMaintenance(() => { ran = true })

  await settle()
  assert.equal(
    ran,
    false,
    'that window is the one the app spends getting on screen; maintenance must not be in it',
  )

  release()
  await settle()
  assert.equal(ran, true)
})

test('work scheduled before a hold exists is not captured by it', async () => {
  // initDb() schedules; the app holds before calling it. If the order ever
  // inverts, the work must still run rather than be swallowed.
  resetStartupMaintenanceGateForTest()
  let ran = false
  scheduleStartupMaintenance(() => { ran = true })
  holdStartupMaintenance()
  await settle()
  assert.equal(ran, true)
})

test('the release tolerates being called more than once', async () => {
  // The app releases from three places — the window becoming paintable, the
  // renderer finishing its load, and a timeout behind both — so that a launch
  // where the first two never arrive still gets its maintenance.
  resetStartupMaintenanceGateForTest()
  const release = holdStartupMaintenance()
  let runs = 0
  scheduleStartupMaintenance(() => { runs += 1 })

  release()
  release()
  release()
  await settle()
  assert.equal(runs, 1, 'released three times, run once')
})

test('a stale release cannot open a newer hold', async () => {
  resetStartupMaintenanceGateForTest()
  const stale = holdStartupMaintenance()
  const current = holdStartupMaintenance()
  let ran = false
  scheduleStartupMaintenance(() => { ran = true })

  stale()
  await settle()
  assert.equal(ran, false, 'the previous hold\'s release must not open this one')

  current()
  await settle()
  assert.equal(ran, true)
})

test('a hold taken with nothing scheduled releases cleanly', async () => {
  resetStartupMaintenanceGateForTest()
  const release = holdStartupMaintenance()
  release()
  await settle()
  // Reaching here is the assertion: a launch that fails before initDb() still
  // releases the gate, and that must not throw on the way out.
  assert.ok(true)
})
