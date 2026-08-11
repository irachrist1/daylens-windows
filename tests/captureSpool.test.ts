// DEV-262: captured moments must survive a frozen or killed app, and a gated
// event must never exist on disk. Two halves under test:
//   1. the relay subprocess — spawns the (fake) helper, runs the full privacy
//      gate, and appends only permitted, stripped events to the spool;
//   2. spool ingestion — lands spooled events in focus_events with original
//      timestamps, exactly once, resuming from a durable cursor as if the
//      app had been dead the whole time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { ingestSpool } from '../src/main/services/captureSpool.ts'
import { captureSpoolDir, purgeFocusCaptureSpool } from '../src/main/services/focusCapture.ts'

const projectRoot = path.resolve(__dirname, '..')

function makeSpoolDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-spool-'))
}

function helperEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ts_ms: Date.now(),
    mono_ns: 1,
    event_type: 'app_activated',
    app_bundle_id: 'dev.warp.Warp-Stable',
    app_name: 'Warp',
    pid: 42,
    window_title: 'daylens — build',
    source: 'nsworkspace_event',
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: 1,
    ...overrides,
  }
}

async function runRelay(
  events: Array<Record<string, unknown>>,
  spoolDir: string,
  controls: Record<string, unknown>,
  expectAtLeast = 0,
): Promise<void> {
  const relay = fork(
    path.join(projectRoot, 'packages', 'capture-relay', 'src', 'index.ts'),
    [],
    {
      execArgv: ['--loader', `file://${path.join(projectRoot, 'packages', 'mcp-server', 'loader.mjs')}`],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAYLENS_CAPTURE_HELPER_PATH: process.execPath,
        DAYLENS_CAPTURE_HELPER_ARGS: JSON.stringify([path.join(projectRoot, 'tests', 'support', 'fakeCaptureHelper.mjs')]),
        DAYLENS_CAPTURE_SPOOL_DIR: spoolDir,
        DAYLENS_FAKE_HELPER_EVENTS: JSON.stringify(events),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    },
  )
  // The relay announces itself once its loader has booted and the helper is
  // spawned. Waiting for that instead of a fixed delay is what makes this
  // deterministic: under parallel load the boot alone can outlast any constant,
  // and shutting down early leaves the spool empty and the assertions lying.
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('relay never reported ready')), 45_000)
    relay.on('message', (message: { op?: string }) => {
      if (message?.op === 'ready') {
        clearTimeout(deadline)
        resolve()
      }
    })
  })
  relay.send({ op: 'controls', controls })
  // Then drain: wait until the spool has at least what this case expects and has
  // stopped growing, so a slow helper cannot be mistaken for a gated one.
  const settledAt = Date.now() + 20_000
  let previous = -1
  let stableFor = 0
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const count = readSpool(spoolDir).length
    stableFor = count === previous ? stableFor + 1 : 0
    previous = count
    if (count >= expectAtLeast && stableFor >= 5) break
    if (Date.now() > settledAt) break
  }
  relay.send({ op: 'shutdown' })
  await new Promise<void>((resolve) => {
    relay.on('exit', () => resolve())
    setTimeout(() => {
      relay.kill('SIGKILL')
      resolve()
    }, 5_000)
  })
}

function readSpool(spoolDir: string): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = []
  for (const name of fs.readdirSync(spoolDir)) {
    if (!name.endsWith('.ndjson')) continue
    for (const line of fs.readFileSync(path.join(spoolDir, name), 'utf8').split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line))
    }
  }
  return lines
}

const CONSENTED_CONTROLS = {
  consented: true,
  enabled: true,
  paused: false,
  excludedApps: [],
  excludedSites: [],
}

test('relay spools only gated events: incognito, excluded, and noise never reach disk', { timeout: 60_000 }, async () => {
  const spoolDir = makeSpoolDir()
  try {
    await runRelay([
      helperEvent({ window_title: 'daylens — build' }),
      helperEvent({ window_title: 'Secret research — Private Browsing' }),
      helperEvent({ app_bundle_id: 'com.apple.loginwindow', app_name: 'loginwindow', window_title: null }),
      helperEvent({ app_bundle_id: 'com.excluded.app', app_name: 'Excluded' }),
      helperEvent({ app_bundle_id: 'com.apple.Safari', app_name: 'Safari', window_title: 'My bank statement' }),
    ], spoolDir, { ...CONSENTED_CONTROLS, excludedApps: ['com.excluded.app'] }, 2)

    const spooled = readSpool(spoolDir)
    const names = spooled.map((event) => event.app_name)
    assert.ok(names.includes('Warp'), 'ordinary event must be spooled')
    assert.ok(!names.includes('loginwindow'), 'system noise must never reach disk')
    assert.ok(!names.includes('Excluded'), 'excluded app must never reach disk')
    assert.ok(
      !spooled.some((event) => String(event.window_title ?? '').includes('Private Browsing')),
      'incognito titles must never reach disk',
    )
    const safari = spooled.find((event) => event.app_name === 'Safari')
    assert.ok(safari, 'browser identity event is kept')
    assert.equal(safari.window_title, null, 'browser page content must be stripped before disk')
  } finally {
    fs.rmSync(spoolDir, { recursive: true, force: true })
  }
})

test('relay with consent off writes nothing at all', { timeout: 60_000 }, async () => {
  const spoolDir = makeSpoolDir()
  try {
    await runRelay([helperEvent({})], spoolDir, { ...CONSENTED_CONTROLS, consented: false })
    assert.deepEqual(readSpool(spoolDir), [])
  } finally {
    fs.rmSync(spoolDir, { recursive: true, force: true })
  }
})

test('ingestion is durable and exactly-once: a dead app catches up from the cursor', () => {
  const spoolDir = makeSpoolDir()
  const db = createProductionTestDatabase()
  try {
    const stamp = (offsetDays: number): string => {
      const d = new Date()
      d.setDate(d.getDate() + offsetDays)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const spoolLine = (tsMs: number): string => JSON.stringify({
      ts_ms: tsMs,
      mono_ns: tsMs * 1_000,
      event_type: 'app_activated',
      app_bundle_id: 'dev.warp.Warp-Stable',
      app_name: 'Warp',
      pid: 42,
      window_title: 'daylens — build',
      url: null,
      page_title: null,
      source: 'nsworkspace_event',
      confidence: 'observed',
      platform: 'darwin',
      schema_ver: 1,
      display_id: null,
    })

    // "The app was frozen for hours": the relay kept appending the whole time.
    const yesterdayFile = path.join(spoolDir, `spool-${stamp(-1)}.ndjson`)
    const base = Date.now() - 12 * 3_600_000
    fs.writeFileSync(yesterdayFile, [spoolLine(base), spoolLine(base + 60_000)].join('\n') + '\n')

    const first = ingestSpool(db, spoolDir)
    assert.equal(first.events, 2, 'everything spooled while the app was down must land')

    // Re-running must not duplicate anything.
    const second = ingestSpool(db, spoolDir)
    assert.equal(second.events, 0)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM focus_events').get() as { c: number }).c
    assert.equal(count, 2)

    // The consumed prior-day file is cleaned up.
    assert.ok(!fs.existsSync(yesterdayFile), 'fully consumed prior-day spool must be deleted')

    // New lines appended later (app alive again) resume from the cursor,
    // and a torn partial line is left for the next pass.
    const todayFile = path.join(spoolDir, `spool-${stamp(0)}.ndjson`)
    fs.writeFileSync(todayFile, spoolLine(base + 120_000) + '\n' + '{"torn":')
    const third = ingestSpool(db, spoolDir)
    assert.equal(third.events, 1)
    fs.appendFileSync(todayFile, '"line"}\n')
    ingestSpool(db, spoolDir)
    const finalCount = (db.prepare('SELECT COUNT(*) AS c FROM focus_events').get() as { c: number }).c
    assert.equal(finalCount, 3, 'the completed torn line is malformed json-shape and must be rejected, not crash')
  } finally {
    db.close()
    fs.rmSync(spoolDir, { recursive: true, force: true })
  }
})

test('consent revocation purges spooled-but-uningested events: nothing observed outlives the decision', () => {
  // DEV-262: the SET_CAPTURE_CONSENT decline path calls purgeFocusCaptureSpool()
  // (via stopCaptureServices({ purgeSpool: true })) instead of draining the
  // spool into the database. This exercises exactly that purge against the
  // real spool location the running app uses.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-userdata-'))
  app.setPath('userData', userData)
  const db = createProductionTestDatabase()
  try {
    const spoolDir = captureSpoolDir()
    fs.mkdirSync(spoolDir, { recursive: true })
    const spoolFile = path.join(spoolDir, 'spool-2026-07-25.ndjson')
    fs.writeFileSync(spoolFile, JSON.stringify({
      ts_ms: Date.now(),
      mono_ns: 1,
      event_type: 'app_activated',
      app_bundle_id: 'dev.warp.Warp-Stable',
      app_name: 'Warp',
      pid: 42,
      window_title: 'daylens — build',
      source: 'nsworkspace_event',
      confidence: 'observed',
      platform: 'darwin',
      schema_ver: 1,
    }) + '\n')
    fs.writeFileSync(`${spoolFile}.cursor`, '0')

    purgeFocusCaptureSpool()

    const leftovers = fs.readdirSync(spoolDir)
      .filter((name) => name.endsWith('.ndjson') || name.endsWith('.cursor'))
    assert.deepEqual(leftovers, [], 'spool files and cursors must be deleted on revocation')
    const ingested = ingestSpool(db, spoolDir)
    assert.equal(ingested.events, 0, 'nothing purged may reach the database afterwards')
    const count = (db.prepare('SELECT COUNT(*) AS c FROM focus_events').get() as { c: number }).c
    assert.equal(count, 0)
  } finally {
    db.close()
    fs.rmSync(userData, { recursive: true, force: true })
  }
})
