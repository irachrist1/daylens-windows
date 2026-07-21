import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getWebsiteSummariesForRange, insertWebsiteVisit } from '../src/main/db/queries.ts'
import { resolveCanonicalBrowser } from '../src/main/lib/appIdentity.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'

Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

const tracking = await import('../src/main/services/tracking.ts')
const windowsFocus = await import('../src/main/services/windowsFocusCapture.ts')

const BASE = new Date(2026, 6, 7, 9, 0, 0, 0).getTime()

type WindowFixture = ReturnType<typeof notepadWindow> | ReturnType<typeof edgeWindow> | ReturnType<typeof uwpWindow>

interface FlushInfo {
  startTime: number
  endTime: number
  durationSeconds: number
  endedReason: string | null
  persisted: boolean
  bundleId: string
  appName: string
  rawAppName: string | null
  category: string
}

interface Rig {
  db: Database.Database
  clock: { now: number; lastInput: number }
  flushes: FlushInfo[]
  setWindow: (next: WindowFixture | null) => void
  poll: (nowMs: number, opts?: { input?: boolean }) => Promise<void>
  teardown: () => void
}

function setupDb(): Database.Database {
  const db = createProductionTestDatabase()
  setTestDb(db)
  return db
}

function notepadWindow() {
  return {
    title: 'notes.txt - Notepad',
    application: 'Notepad',
    path: 'C:\\Windows\\System32\\notepad.exe',
    pid: 101,
    icon: '',
  }
}

function edgeWindow() {
  return {
    title: 'Private account page',
    application: 'msedge',
    path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    pid: 202,
    icon: '',
  }
}

function uwpWindow() {
  return {
    title: 'PowerShell',
    application: 'ApplicationFrameHost',
    path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe',
    pid: 303,
    icon: '',
    windows: {
      isUWPApp: true,
      uwpPackage: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    },
  }
}

function makeRig(initialWindow: WindowFixture | null = notepadWindow()): Rig {
  const db = setupDb()
  const clock = { now: BASE, lastInput: BASE }
  const flushes: FlushInfo[] = []
  let activeWindow = initialWindow
  tracking.__setTrackingFsmTestHarness({
    now: () => clock.now,
    idleSeconds: () => Math.max(0, (clock.now - clock.lastInput) / 1_000),
    activeWindow: () => activeWindow,
    recordFlush: (info) => flushes.push(info),
  })
  return {
    db,
    clock,
    flushes,
    setWindow: (next) => {
      activeWindow = next
    },
    poll: async (nowMs, opts) => {
      clock.now = nowMs
      if (opts?.input) clock.lastInput = nowMs
      await tracking.__pollForTest()
    },
    teardown: () => {
      tracking.__setTrackingFsmTestHarness(null)
      windowsFocus.__setRecentWindowsPrivateWindowSignalForTest(null)
      clearTestDb()
      db.close()
    },
  }
}

test('Windows poll gaps end the foreground session at the last completed tick', async () => {
  const rig = makeRig()
  try {
    await rig.poll(BASE, { input: true })
    await rig.poll(BASE + 30_000, { input: true })

    const wake = BASE + 3 * 3_600_000
    await rig.poll(wake, { input: true })

    const flush = rig.flushes.find((f) => f.persisted)
    assert.ok(flush, 'sleep-gap flush should persist the pre-sleep Windows session')
    assert.equal(flush.endTime, BASE + 30_000)
    assert.equal(flush.durationSeconds, 30)
    assert.equal(flush.endedReason, 'sleep_gap')
  } finally {
    rig.teardown()
  }
})

test('Windows private-window helper signal records no app session', async () => {
  const rig = makeRig(edgeWindow())
  try {
    windowsFocus.__setRecentWindowsPrivateWindowSignalForTest({
      observedAt: BASE,
      appBundleId: 'msedge.exe',
      appName: 'msedge',
      pid: 202,
      windowTitle: 'Private account page',
    })

    await rig.poll(BASE, { input: true })
    windowsFocus.__setRecentWindowsPrivateWindowSignalForTest({
      observedAt: BASE + 20_000,
      appBundleId: 'msedge.exe',
      appName: 'msedge',
      pid: 202,
      windowTitle: 'Private account page',
    })
    await rig.poll(BASE + 20_000, { input: true })

    assert.equal(tracking.getCurrentSession(), null)
    const count = rig.db.prepare('SELECT COUNT(*) AS n FROM app_sessions').get() as { n: number }
    assert.equal(count.n, 0)
  } finally {
    rig.teardown()
  }
})

test('Windows UWP sessions use the package family instead of ApplicationFrameHost', async () => {
  const rig = makeRig(uwpWindow())
  try {
    await rig.poll(BASE, { input: true })
    rig.setWindow(notepadWindow())
    await rig.poll(BASE + 20_000, { input: true })

    const flush = rig.flushes.find((f) => f.persisted)
    assert.ok(flush)
    assert.equal(flush.bundleId, 'Microsoft.WindowsTerminal_8wekyb3d8bbwe')
    assert.equal(flush.appName, 'Windows Terminal')
    assert.equal(flush.rawAppName, 'Windows Terminal')
    assert.equal(flush.category, 'development')

    // Canonical evidence carries the same unified identity.
    const canonical = rig.db.prepare(`
      SELECT app_bundle_id FROM focus_events
      WHERE source = 'foreground_poll' AND app_name = 'Windows Terminal'
      LIMIT 1
    `).get() as { app_bundle_id: string } | undefined
    assert.equal(canonical?.app_bundle_id, 'Microsoft.WindowsTerminal_8wekyb3d8bbwe')
  } finally {
    rig.teardown()
  }
})

test('Windows browser history reconciles executable IDs to foreground browser time', async () => {
  const rig = makeRig(edgeWindow())
  try {
    await rig.poll(BASE, { input: true })
    rig.setWindow(notepadWindow())
    await rig.poll(BASE + 60_000, { input: true })
    rig.setWindow(uwpWindow())
    await rig.poll(BASE + 5 * 60_000, { input: true })

    const edgeCanonical = resolveCanonicalBrowser('msedge.exe')
    insertWebsiteVisit(rig.db, {
      domain: 'github.com',
      pageTitle: 'GitHub',
      url: 'https://github.com/',
      normalizedUrl: 'https://github.com/',
      pageKey: 'github.com',
      visitTime: BASE,
      visitTimeUs: BigInt(BASE) * 1000n,
      durationSec: 5 * 60,
      browserBundleId: 'msedge.exe',
      canonicalBrowserId: edgeCanonical.canonicalBrowserId,
      browserProfileId: edgeCanonical.browserProfileId,
      source: 'history',
    })

    const edge = rig.flushes.find((f) => f.persisted && /edge/i.test(f.appName))
    assert.ok(edge)
    assert.equal(edge.durationSeconds, 60)

    const sites = getWebsiteSummariesForRange(rig.db, BASE, BASE + 5 * 60_000)
    const siteTotal = sites.reduce((sum, site) => sum + site.totalSeconds, 0)
    assert.equal(siteTotal, edge.durationSeconds)
    assert.equal(sites.find((site) => site.domain === 'github.com')?.totalSeconds, 60)
  } finally {
    rig.teardown()
  }
})
