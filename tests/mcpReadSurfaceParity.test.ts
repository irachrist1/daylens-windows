// WO-15 / AC-MCP-007.2: an external MCP client and Daylens chat must answer a
// Daylens activity question from the same facts and the same calculation.
//
// A shared catalogue proves the two surfaces publish the same capability names.
// It does not prove they return the same numbers, which is what a person notices
// when Claude Desktop and the Daylens chat disagree about the same afternoon. So
// these tests run both paths over one seeded database and compare the results
// object for object.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getSettings } from './support/settings-stub.mjs'
import { trackingControlsStateFromSettings } from '../src/shared/trackingControls.ts'
import { buildDaylensTools } from '../src/main/agent/daylensTools.ts'
import { localDayBounds } from '../src/main/lib/localDate.ts'
import { callDaylensReadTool, UnavailableCapabilityError } from '../packages/mcp-server/src/dispatch.ts'

const DATE = '2026-07-15'
const BROWSER_BUNDLE = 'company.thebrowser.dia'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 6, 15, hour, minute, 0, 0).getTime()
}

function seedDay(db: Database.Database): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, 'Dia', ?, ?, ?, 'browsing', 0, 'Supervised ML', 'Dia', 'dia', ?, 'test', 1)
  `).run(BROWSER_BUNDLE, localMs(9, 0), localMs(11, 0), 7_200, BROWSER_BUNDLE)
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('com.microsoft.VSCode', 'Cursor', ?, ?, ?, 'coding', 1, 'daylens — mcpServer.ts', 'Cursor', 'cursor', 'com.microsoft.VSCode', 'test', 1)
  `).run(localMs(11, 0), localMs(13, 30), 9_000)
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('coursera.org', 'Supervised ML | Coursera', 'https://www.coursera.org/learn/ml', ?, ?, 3600, ?, 'dia', 'chrome_history')
  `).run(localMs(9, 0), localMs(9, 0) * 1000, BROWSER_BUNDLE)
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('news.ycombinator.com', 'Hacker News', 'https://news.ycombinator.com/', ?, ?, 3600, ?, 'dia', 'chrome_history')
  `).run(localMs(10, 0), localMs(10, 0) * 1000, BROWSER_BUNDLE)
}

function seedVisitAt(db: Database.Database, domain: string, title: string, atMs: number): void {
  const endMs = atMs + 15 * 60 * 1000
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, 'Dia', ?, ?, ?, 'browsing', 0, ?, 'Dia', 'dia', ?, 'test', 1)
  `).run(BROWSER_BUNDLE, atMs, endMs, 900, title, BROWSER_BUNDLE)
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES (?, ?, ?, ?, ?, 900, ?, 'dia', 'chrome_history')
  `).run(domain, title, `https://${domain}/`, atMs, atMs * 1000, BROWSER_BUNDLE)
}

async function bothPaths(
  db: Database.Database,
  mcpTool: string,
  chatTool: string,
  input: Record<string, unknown>,
): Promise<{ mcp: unknown; chat: unknown }> {
  const controls = trackingControlsStateFromSettings(getSettings())
  const tools = buildDaylensTools(db) as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>
  return {
    mcp: await callDaylensReadTool(mcpTool, input, db, controls),
    chat: await tools[chatTool].execute(input, {}),
  }
}

test('app usage is the same object through MCP and through chat', async () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const { mcp, chat } = await bothPaths(db, 'getAppUsage', 'get_app_usage', {
    appName: 'Dia',
    startDate: DATE,
    endDate: DATE,
  })
  assert.equal((mcp as { totalSeconds: number }).totalSeconds, 7_200, 'the fixture must produce real time for this comparison to mean anything')
  assert.deepEqual(mcp, chat)
  db.close()
})

test('page visits are the same object through MCP and through chat', async () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const { mcp, chat } = await bothPaths(db, 'listPageVisits', 'list_page_visits', {
    startDate: DATE,
    endDate: DATE,
  })
  assert.equal((mcp as { found: boolean }).found, true, 'the fixture must produce pages for this comparison to mean anything')
  assert.deepEqual(mcp, chat)
  db.close()
})

test('the moment reader is the same object through MCP and through chat', async () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const { mcp, chat } = await bothPaths(db, 'getMoment', 'get_moment', { date: DATE, time: '10:30' })
  assert.deepEqual(mcp, chat)
  db.close()
})

test('the day summary matches chat once chat’s capture-state superset is removed', async () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const { mcp, chat } = await bothPaths(db, 'getDaySummary', 'get_day_overview', { date: DATE })
  const chatShared = { ...(chat as Record<string, unknown>) }
  // The chat tool merges capture state (machine sleep/lock spans, untracked
  // gaps) onto the same summary; the MCP path serves the summary itself.
  delete chatShared.machineStateSpans
  delete chatShared.untrackedGaps
  delete chatShared.captureCoverage
  assert.deepEqual(mcp, chatShared)
  db.close()
})

test('search reaches the same executor through both paths', async () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const { mcp, chat } = await bothPaths(db, 'searchSessions', 'search_history', { query: 'Cursor', limit: 10 })
  assert.deepEqual(mcp, chat)
  db.close()
})

// A local day is 23 or 25 hours long across a daylight-saving transition, so a
// range that ends 24 hours after local midnight either drops the last hour of
// the requested date or reaches into the next one.
for (const date of ['2026-03-08', '2026-11-01']) {
  test(`page visits cover exactly the local day of ${date}`, async () => {
    const db = createProductionTestDatabase()
    const nextMidnight = localDayBounds(date)[1]
    seedVisitAt(db, 'lasthour.example', 'Last local hour', nextMidnight - 30 * 60 * 1000)
    seedVisitAt(db, 'nextday.example', 'Next local day', nextMidnight + 30 * 60 * 1000)

    const controls = trackingControlsStateFromSettings(getSettings())
    const result = await callDaylensReadTool(
      'listPageVisits', { startDate: date, endDate: date }, db, controls,
    ) as { found: boolean; pages?: Array<{ domain: string }> }

    const domains = (result.pages ?? []).map((page) => page.domain)
    assert.ok(domains.includes('lasthour.example'), 'the last local hour of the date is inside the range')
    assert.ok(!domains.includes('nextday.example'), 'the next local date is outside the range')
    db.close()
  })
}

test('a capability this path cannot serve fails with its recorded reason', async () => {
  const db = createProductionTestDatabase()
  const controls = trackingControlsStateFromSettings(getSettings())
  await assert.rejects(
    () => callDaylensReadTool('getTimeChunks', { date: DATE, incrementMinutes: 30 }, db, controls),
    (error: unknown) => {
      assert.ok(error instanceof UnavailableCapabilityError)
      assert.match(error.message, /getMoment once per increment/)
      return true
    },
  )
  await assert.rejects(
    () => callDaylensReadTool('deleteEverything', {}, db, controls),
    /Unknown tool: deleteEverything/,
  )
  db.close()
})
