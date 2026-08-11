import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  executeWrappedTool,
  getDayComparison,
  getDistractionProfile,
  getLongestFocusStretch,
  getMostSurprisingFact,
  getWindowTitleContext,
  WRAPPED_TOOL_NAMES,
} from '../src/main/services/wrappedTools.ts'
import { looksLikeRawArtifactLabel } from '../src/renderer/lib/wrappedFacts.ts'

// Wrapped tool layer — tested against the REAL database, not mocks. Set
// DAYLENS_REAL_DB_PATH to a copy of the live daylens.sqlite and
// DAYLENS_REAL_DB_DATE to an analyzed day inside it. When the env is absent
// (CI, hermetic suite) every real-data test skips itself.

const DB_PATH = process.env.DAYLENS_REAL_DB_PATH
const DATE = process.env.DAYLENS_REAL_DB_DATE ?? '2026-07-07'
const hasRealDb = Boolean(DB_PATH && fs.existsSync(DB_PATH))
const controls = { enabled: false, excludedApps: [], excludedSites: [] } as never

function openDb(): InstanceType<typeof Database> {
  return new Database(DB_PATH!, { readonly: true })
}

test('real DB: getWindowTitleContext clusters an app\'s titles semantically', { skip: !hasRealDb }, () => {
  const db = openDb()
  try {
    // The busiest titled app of the day, found from the DB itself.
    const row = db.prepare(`
      SELECT app_name, COUNT(*) c FROM app_sessions
      WHERE start_time >= strftime('%s', ?)*1000 AND start_time < strftime('%s', ?, '+1 day')*1000
        AND window_title IS NOT NULL AND window_title != '' AND window_title != app_name
      GROUP BY app_name ORDER BY c DESC LIMIT 1
    `).get(DATE, DATE) as { app_name: string } | undefined
    assert.ok(row, `no titled sessions on ${DATE}`)
    const result = getWindowTitleContext({ date: DATE, appName: row!.app_name }, db)
    assert.ok(result, 'expected clusters for the busiest titled app')
    assert.ok(result!.clusters.length >= 1)
    for (const cluster of result!.clusters) {
      assert.ok(cluster.sessions >= 1)
      assert.ok(cluster.seconds >= 60)
      assert.ok(!cluster.label.includes('@'), `email leaked: ${cluster.label}`)
      assert.ok(!/^\(/.test(cluster.label), `badge leaked: ${cluster.label}`)
    }
    console.log(`  [real] ${result!.appName}: ${result!.clusters.map((c) => `${c.label} (${c.sessions}s/${Math.round(c.seconds / 60)}m)`).join(' | ')}`)
  } finally {
    db.close()
  }
})

test('real DB: getWindowTitleContext returns null for an unknown app', { skip: !hasRealDb }, () => {
  const db = openDb()
  try {
    assert.equal(getWindowTitleContext({ date: DATE, appName: 'NoSuchAppEver' }, db), null)
  } finally {
    db.close()
  }
})

test('real DB: getDayComparison reconciles against snapshots', { skip: !hasRealDb }, () => {
  const db = openDb()
  try {
    const result = getDayComparison({ date: DATE }, db)
    assert.ok(result, `no comparison for ${DATE}`)
    assert.ok(result!.trackedSeconds > 0)
    if (result!.sevenDayAverageSeconds != null) {
      assert.ok(result!.sevenDayAverageSeconds > 0)
      assert.equal(typeof result!.vsAveragePct, 'number')
    }
    console.log(`  [real] ${DATE}: tracked ${result!.tracked}, 7d avg ${result!.sevenDayAverage}, vs avg ${result!.vsAveragePct}%, same weekday last week ${result!.sameWeekdayLastWeek}`)
  } finally {
    db.close()
  }
})

test('real DB: getLongestFocusStretch names a clean subject or none', { skip: !hasRealDb }, () => {
  const db = openDb()
  try {
    const result = getLongestFocusStretch({ date: DATE }, db)
    assert.ok(result, `no stretch found on ${DATE}`)
    assert.ok(result!.durationSeconds >= 20 * 60)
    assert.match(result!.startClock, /^\d{1,2}(:\d{2})?(am|pm)$/)
    if (result!.subject) assert.ok(!looksLikeRawArtifactLabel(result!.subject), `raw label leaked: ${result!.subject}`)
    console.log(`  [real] longest stretch: ${result!.duration} ${result!.startClock}-${result!.endClock} on ${result!.subject ?? result!.primaryApp}`)
  } finally {
    db.close()
  }
})

test('real DB: getDistractionProfile splits and names surfaces', { skip: !hasRealDb }, () => {
  const db = openDb()
  try {
    const result = getDistractionProfile({ date: DATE }, db)
    assert.ok(result, `no profile for ${DATE}`)
    assert.ok(result!.highDistractionSeconds >= 0)
    assert.ok(result!.lowDistractionSeconds > 0)
    for (const site of result!.sites) {
      assert.ok(site.seconds >= 60)
      assert.ok(!site.name.includes('/'), `path leaked: ${site.name}`)
    }
    console.log(`  [real] distraction: high ${result!.highDistraction} / low ${result!.lowDistraction}; sites ${result!.sites.map((s) => `${s.name} ${s.time}`).join(', ')}`)
  } finally {
    db.close()
  }
})

test('real DB: getMostSurprisingFact returns a scored fact or an honest null', { skip: !hasRealDb }, () => {
  const db = openDb()
  try {
    const result = getMostSurprisingFact({ date: DATE }, db)
    if (result) {
      assert.ok(result.score >= 0.6, 'below the surprise floor')
      assert.ok(result.caption.length > 10)
      console.log(`  [real] surprise (${result.kind}, score ${result.score}): ${result.value}, ${result.caption}`)
    } else {
      console.log('  [real] surprise: null (nothing above the floor, which is allowed)')
    }
  } finally {
    db.close()
  }
})

test('real DB: git/calendar tools serve stored signals without collecting', { skip: !hasRealDb }, async () => {
  const db = openDb()
  try {
    // allowCollect false: read-only handle, stored signals only (MCP posture).
    const git = await executeWrappedTool('getGitActivity', { date: DATE }, db, controls, { allowCollect: false })
    const calendar = await executeWrappedTool('getCalendarEvents', { date: DATE }, db, controls, { allowCollect: false })
    console.log(`  [real] stored git signal: ${git ? 'present' : 'null'}; stored calendar signal: ${calendar ? 'present' : 'null'}`)
    // Presence depends on whether background collection has run for this copy;
    // both null and populated are valid — the contract is "never throws".
    assert.ok(git === null || typeof git === 'object')
    assert.ok(calendar === null || typeof calendar === 'object')
  } finally {
    db.close()
  }
})

test('real DB: every tool dispatches through executeWrappedTool sanitized', { skip: !hasRealDb }, async () => {
  const db = openDb()
  try {
    for (const name of WRAPPED_TOOL_NAMES) {
      const result = await executeWrappedTool(
        name,
        { date: DATE, appName: 'Safari' },
        db,
        controls,
        { allowCollect: false },
      )
      // Sanitized results must never carry an OAuth-ish blob or query string.
      const text = JSON.stringify(result ?? null)
      assert.ok(!/[?&](token|key|secret|code)=/i.test(text), `${name} leaked a query credential`)
    }
  } finally {
    db.close()
  }
})

// ─── Hermetic: run-level stretch semantics ────────────────────────────────────
// The stretch must come from session evidence, not block bounds: a mixed block
// with a real leisure detour in the middle yields the longest work RUN with its
// own bounds, and a placeholder label ("Morning", "Active now") never ships as
// the subject.
test('hermetic: longest stretch is the work run inside a mixed block, never the block span', async () => {
  const { createProductionTestDatabase } = await import('./support/testDatabase.ts')
  const db = createProductionTestDatabase()
  try {
    const anchor = new Date()
    anchor.setDate(anchor.getDate() - 3)
    const date = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`
    const at = (hour: number, minute = 0): number =>
      new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), hour, minute, 0, 0).getTime()
    const insert = db.prepare(`
      INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
        category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
        capture_source, capture_version)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'test', 1)
    `)
    const seed = (app: string, startMs: number, endMs: number, category: string, title: string): void => {
      insert.run(`com.test.${app.toLowerCase()}`, app, startMs, endMs,
        Math.round((endMs - startMs) / 1000), category, title, app, app.toLowerCase(), `com.test.${app.toLowerCase()}`)
    }
    // One continuous sitting 9:00–13:00: work, a 15m Netflix detour, more work
    // — then an afternoon of plain browsing (neutral, NOT work) that must
    // neither count toward nor extend any run.
    seed('Cursor', at(9, 0), at(10, 30), 'development', 'daylens - fixing tools')
    seed('Safari', at(10, 30), at(10, 45), 'entertainment', 'Netflix')
    seed('Cursor', at(10, 45), at(13, 0), 'development', 'daylens - fixing tools')
    seed('Dia', at(13, 0), at(16, 0), 'browsing', 'Dia')

    const result = getLongestFocusStretch({ date }, db)
    assert.ok(result, 'expected a stretch from the seeded day')
    // The 15m entertainment detour breaks the run: the honest answer is the
    // 10:45–13:00 run (8100s), never the 9:00–13:00 block span (14400s), and
    // never 9:00–16:00 with browsing chained in.
    assert.equal(result!.durationSeconds, 8100)
    assert.equal(result!.startClock, '10:45am')
    assert.equal(result!.endClock, '1pm')
    const placeholders = ['active now', 'earlier today', 'late night', 'morning', 'afternoon', 'evening', 'night']
    if (result!.subject) {
      assert.ok(!placeholders.includes(result!.subject.toLowerCase()), `placeholder subject shipped: ${result!.subject}`)
    }
  } finally {
    db.close()
  }
})
