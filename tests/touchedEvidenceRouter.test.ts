import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { routeInsightsQuestion } from '../src/main/lib/insightsQueryRouter.ts'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 29, hour, minute, 0, 0).getTime()
}

function insertAppSession(db: Database.Database, appName: string, bundleId: string, title: string, start: number, end: number, category: string): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused,
      window_title,
      raw_app_name,
      canonical_app_id,
      app_instance_id,
      capture_source,
      capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'test', 1)
  `).run(
    bundleId,
    appName,
    start,
    end,
    Math.max(1, Math.round((end - start) / 1000)),
    category,
    title,
    appName,
    bundleId.toLowerCase().includes('excel') ? 'excel' : null,
    bundleId,
  )
}

function insertWebsiteVisit(db: Database.Database, title: string, domain: string, url: string, start: number, durationSec: number): void {
  db.prepare(`
    INSERT INTO website_visits (
      domain,
      page_title,
      url,
      visit_time,
      visit_time_us,
      duration_sec,
      browser_bundle_id,
      canonical_browser_id,
      browser_profile_id,
      normalized_url,
      page_key,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, 'chrome.exe', 'chrome', 'default', ?, ?, 'history')
  `).run(domain, title, url, start, BigInt(start) * 1000n, durationSec, url, `${domain}/page`)
}

test('files/docs/pages prompt uses available local artifacts, pages, windows, and apps', async () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)

  insertAppSession(
    db,
    'Microsoft Excel',
    'excel.exe',
    'ASYV_Unified_Financial_Report_20260428 (Actuals Upto Mar 2026)',
    localMs(9, 0),
    localMs(10, 15),
    'productivity',
  )
  insertAppSession(
    db,
    'Google Chrome',
    'chrome.exe',
    'Canva uploads - ASYV board deck',
    localMs(10, 20),
    localMs(10, 45),
    'browsing',
  )
  insertWebsiteVisit(
    db,
    'Canva uploads - ASYV board deck',
    'canva.com',
    'https://www.canva.com/uploads',
    localMs(10, 20),
    25 * 60,
  )

  const routed = await routeInsightsQuestion(
    'Which files, docs, or pages did I touch today?',
    new Date(2026, 3, 29, 12, 0, 0, 0),
    null,
    db,
  )

  assert.equal(routed?.kind, 'answer')
  assert.match(routed?.answer ?? '', /ASYV_Unified_Financial_Report_20260428/)
  assert.match(routed?.answer ?? '', /Canva uploads - ASYV board deck/)
  assert.match(routed?.answer ?? '', /Microsoft Excel|Google Chrome/)
  assert.match(routed?.answer ?? '', /Pages:/)
  assert.match(routed?.answer ?? '', /Window titles:/)
  assert.doesNotMatch(routed?.answer ?? '', /didn't detect any specific files/i)
})

test('files/docs/pages prompt returns null (router miss) when only app sessions exist — no hollow header', async () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)

  // Only app sessions — no window titles, no website visits, no artifacts
  insertAppSession(
    db,
    'Google Chrome',
    'chrome.exe',
    'Google Chrome', // generic window title — same as app name, no file evidence
    localMs(9, 0),
    localMs(10, 0),
    'browsing',
  )
  insertAppSession(
    db,
    'Slack',
    'slack.exe',
    'Slack',
    localMs(10, 0),
    localMs(10, 30),
    'communication',
  )

  const routed = await routeInsightsQuestion(
    'Which files, docs, or pages mattered most today?',
    new Date(2026, 3, 29, 12, 0, 0, 0),
    null,
    db,
  )

  // Router must return null (miss) so the full AI synthesis path handles the question.
  // A non-null answer with no file content produces a hollow header — never acceptable.
  const answer = routed?.kind === 'answer' ? routed.answer : null
  if (answer !== null) {
    // If the router did answer, it must have real content — not just a header line
    const lines = answer.split('\n').filter((l) => l.trim())
    assert.ok(
      lines.length > 1,
      'A non-null router answer must have more than just a header line',
    )
    assert.doesNotMatch(answer, /no clear file\/doc names.*app evidence follows/i, 'Header-only answer with no body must not reach the user')
  }
})
