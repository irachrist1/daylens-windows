// Canonical capture parity: the poll-based tracking FSM mirrors every
// observation into canonical focus_events while keeping its legacy
// app_sessions write. These tests drive the real FSM through scripted activity
// and prove (1) the canonical record rebuilds the same sessions as the legacy
// path, (2) foreground ownership never overlaps, (3) machine-state and idle
// transitions are explicit canonical events, and (4) pause blocks canonical
// persistence exactly like legacy.
//
// Documented parity tolerance: the legacy path drops sessions shorter than its
// MIN_SESSION_SEC floor and splits sessions at local midnight for per-day
// totals. Canonical evidence keeps brief switches (Timeline decides later) and
// records one interval across midnight, so the comparison applies the same
// floor and runs inside one calendar day.

import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'
import {
  __setTrackingFsmTestHarness,
  __pollForTest,
  flushCurrentSession,
  recordTrackingPauseTransition,
} from '../src/main/services/tracking.ts'
import { rebuildPollForegroundSessions } from '../src/main/services/captureEvidence.ts'

const MIN_SESSION_SEC = 10

const WIN_A = {
  title: 'Draft notes',
  application: 'TextEdit',
  path: '/Applications/TextEdit.app',
  pid: 4321,
  icon: '',
}
const WIN_A_RENAMED = { ...WIN_A, title: 'Draft notes — edited' }
const WIN_B = {
  title: 'Inbox',
  application: 'Mail',
  path: '/Applications/Mail.app',
  pid: 8765,
  icon: '',
}

// All timestamps live inside one local calendar day so no midnight split fires.
const BASE = new Date(2026, 6, 3, 10, 0, 0, 0).getTime()

interface Rig {
  db: Database.Database
  poll: (nowMs: number, opts?: { input?: boolean }) => Promise<void>
  setWindow: (win: typeof WIN_A) => void
  failWindow: (error: Error | null) => void
  teardown: () => void
}

function makeRig(platform: NodeJS.Platform = 'darwin'): Rig {
  const db = createProductionTestDatabase()
  setTestDb(db)
  const clock = { now: BASE, lastInput: BASE }
  let activeWin = WIN_A
  let activeWindowError: Error | null = null
  __setTrackingFsmTestHarness({
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow: () => {
      if (activeWindowError) throw activeWindowError
      return activeWin
    },
    platform,
  })
  return {
    db,
    poll: (nowMs, opts) => {
      clock.now = nowMs
      if (opts?.input) clock.lastInput = nowMs
      return __pollForTest()
    },
    setWindow: (win) => { activeWin = win },
    failWindow: (error) => { activeWindowError = error },
    teardown: () => {
      __setTrackingFsmTestHarness(null)
      clearTestDb()
      db.close()
      __resetSettings()
    },
  }
}

function pollEvents(db: Database.Database): Array<{ event_type: string; app_name: string | null; ts_ms: number }> {
  return db.prepare(`
    SELECT event_type, app_name, ts_ms FROM focus_events
    WHERE source = 'foreground_poll'
    ORDER BY ts_ms ASC, mono_ns ASC, id ASC
  `).all() as Array<{ event_type: string; app_name: string | null; ts_ms: number }>
}

function supervisorEvents(db: Database.Database): Array<{ event_type: string; ts_ms: number }> {
  return db.prepare(`
    SELECT event_type, ts_ms FROM focus_events
    WHERE source = 'capture_supervisor'
    ORDER BY ts_ms ASC, mono_ns ASC, id ASC
  `).all() as Array<{ event_type: string; ts_ms: number }>
}

test('an ordinary working stretch rebuilds identical sessions from canonical evidence', async () => {
  __resetSettings()
  const rig = makeRig()
  try {
    // WIN_A for 2 minutes with a title change at the 1-minute mark.
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 60_000, { input: true })
    rig.setWindow(WIN_A_RENAMED)
    await rig.poll(BASE + 65_000, { input: true })
    // Switch to WIN_B for 1 minute, then flush at the end of the scenario.
    rig.setWindow(WIN_B)
    await rig.poll(BASE + 120_000, { input: true })
    await rig.poll(BASE + 180_000, { input: true })
    flushCurrentSession()

    const events = pollEvents(rig.db)
    assert.deepEqual(
      events.map((e) => `${e.event_type}:${e.app_name}`),
      [
        'app_activated:TextEdit',
        'window_changed:TextEdit',
        'app_deactivated:TextEdit',
        'app_activated:Mail',
        'app_deactivated:Mail',
      ],
    )

    // Parity: canonical rebuild == legacy app_sessions, same bounds.
    const rebuilt = rebuildPollForegroundSessions(rig.db, BASE - 1, BASE + 86_400_000)
      .filter((s) => (s.endMs - s.startMs) / 1_000 >= MIN_SESSION_SEC)
    const legacy = rig.db.prepare(`
      SELECT app_name AS appName, start_time AS startMs, end_time AS endMs
      FROM app_sessions ORDER BY start_time ASC
    `).all() as Array<{ appName: string; startMs: number; endMs: number }>

    assert.equal(legacy.length, 2)
    assert.deepEqual(
      rebuilt.map((s) => ({ appName: s.appName, startMs: s.startMs, endMs: s.endMs })),
      legacy,
    )

    // Foreground ownership never overlaps.
    for (let i = 1; i < rebuilt.length; i++) {
      assert.ok(rebuilt[i].startMs >= rebuilt[i - 1].endMs, 'rebuilt sessions must not overlap')
    }
  } finally {
    rig.teardown()
  }
})

test('going away emits canonical idle transitions and closes the interval at the idle boundary', async () => {
  __resetSettings()
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 60_000, { input: true })
    // No input for 6 minutes → away. The FSM flushes at the last-input time.
    await rig.poll(BASE + 60_000 + 360_000)
    // Return with fresh input.
    await rig.poll(BASE + 60_000 + 420_000, { input: true })
    flushCurrentSession()

    const supervisor = supervisorEvents(rig.db).map((e) => e.event_type)
    assert.ok(supervisor.includes('idle_started'), 'away must record canonical idle_started')
    assert.ok(supervisor.includes('idle_ended'), 'return must record canonical idle_ended')

    // The canonical deactivation carries the same idle-boundary end the legacy
    // session got — not the poll time that discovered the absence.
    const legacy = rig.db.prepare(`
      SELECT end_time AS endMs FROM app_sessions ORDER BY start_time ASC LIMIT 1
    `).get() as { endMs: number }
    const rebuilt = rebuildPollForegroundSessions(rig.db, BASE - 1, BASE + 86_400_000)
    assert.equal(rebuilt[0].endMs, legacy.endMs)

    // Supervisor rows are content-free by contract.
    const contentful = rig.db.prepare(`
      SELECT COUNT(*) AS c FROM focus_events
      WHERE source = 'capture_supervisor' AND (
        app_bundle_id IS NOT NULL OR app_name IS NOT NULL OR window_title IS NOT NULL
        OR url IS NOT NULL OR page_title IS NOT NULL
      )
    `).get() as { c: number }
    assert.equal(contentful.c, 0)
  } finally {
    rig.teardown()
  }
})

test('pause prevents canonical persistence exactly like legacy', async () => {
  __resetSettings()
  __setSettings({ trackingPaused: true })
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 60_000, { input: true })
    flushCurrentSession()

    assert.equal(pollEvents(rig.db).length, 0, 'no canonical foreground rows while paused')
    const legacy = rig.db.prepare('SELECT COUNT(*) AS c FROM app_sessions').get() as { c: number }
    assert.equal(legacy.c, 0, 'no legacy rows while paused')
  } finally {
    rig.teardown()
  }
})

test('pausing closes the canonical interval at the toggle boundary', async () => {
  __resetSettings()
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    recordTrackingPauseTransition(true, 'settings', BASE + 30_000)

    const rebuilt = rebuildPollForegroundSessions(rig.db, BASE - 1, BASE + 60_000)
    assert.equal(rebuilt.length, 1)
    assert.equal(rebuilt[0].endMs, BASE + 30_000)
    assert.deepEqual(
      supervisorEvents(rig.db).map((event) => event.event_type),
      ['capture_paused'],
    )
  } finally {
    rig.teardown()
  }
})

test('committing provisional idle emits idle_started at the true idle boundary', async () => {
  __resetSettings()
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 120_000)
    await rig.poll(BASE + 300_000)

    const idleStarted = supervisorEvents(rig.db).find((event) => event.event_type === 'idle_started')
    assert.ok(idleStarted)
    assert.equal(idleStarted.ts_ms, BASE)
  } finally {
    rig.teardown()
  }
})

test('a capture failure closes the foreground interval before recording the gap', async () => {
  __resetSettings()
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    rig.failWindow(new Error('permission lost'))
    await rig.poll(BASE + 30_000, { input: true })

    const rebuilt = rebuildPollForegroundSessions(rig.db, BASE - 1, BASE + 60_000)
    assert.equal(rebuilt.length, 1)
    assert.equal(rebuilt[0].endMs, BASE + 30_000)
    assert.ok(supervisorEvents(rig.db).some((event) => event.event_type === 'capture_failed'))
  } finally {
    rig.teardown()
  }
})

test('a midnight legacy split emits one canonical deactivation', async () => {
  __resetSettings()
  const rig = makeRig()
  try {
    const beforeMidnight = new Date(2026, 6, 3, 23, 59, 50, 0).getTime()
    const afterMidnight = beforeMidnight + 20_000
    await rig.poll(beforeMidnight, { input: true })
    await rig.poll(afterMidnight, { input: true })
    flushCurrentSession()

    const deactivations = pollEvents(rig.db).filter((event) => event.event_type === 'app_deactivated')
    assert.equal(deactivations.length, 1)
    assert.equal(deactivations[0].ts_ms, afterMidnight)
  } finally {
    rig.teardown()
  }
})

test('Linux polling remains outside the macOS and Windows canonical adapter', async () => {
  __resetSettings()
  const rig = makeRig('linux')
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 30_000, { input: true })
    flushCurrentSession()
    assert.equal(pollEvents(rig.db).length, 0)
  } finally {
    rig.teardown()
  }
})

test('an excluded app never reaches the canonical store', async () => {
  __resetSettings()
  __setSettings({ trackingControlsEnabled: true, trackingExcludedApps: ['TextEdit'] })
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 60_000, { input: true })
    flushCurrentSession()

    assert.equal(pollEvents(rig.db).length, 0, 'no canonical rows for an excluded app')
  } finally {
    rig.teardown()
  }
})

test('a retried canonical batch is idempotent through the identity index', async () => {
  __resetSettings()
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 30_000, { input: true })
    rig.setWindow(WIN_B)
    await rig.poll(BASE + 60_000, { input: true })
    flushCurrentSession()

    const before = pollEvents(rig.db)
    // Re-insert the exact same rows — INSERT OR IGNORE plus the identity
    // index must keep the store unchanged.
    const rows = rig.db.prepare(`
      SELECT ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid, window_title,
             source, confidence, platform, schema_ver
      FROM focus_events WHERE source = 'foreground_poll'
    `).all() as Array<Record<string, unknown>>
    const insert = rig.db.prepare(`
      INSERT OR IGNORE INTO focus_events
        (ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid, window_title,
         url, page_title, source, confidence, platform, schema_ver)
      VALUES (@ts_ms, @mono_ns, @event_type, @app_bundle_id, @app_name, @pid, @window_title,
              NULL, NULL, @source, @confidence, @platform, @schema_ver)
    `)
    for (const row of rows) insert.run(row)

    assert.deepEqual(pollEvents(rig.db), before)
  } finally {
    rig.teardown()
  }
})
