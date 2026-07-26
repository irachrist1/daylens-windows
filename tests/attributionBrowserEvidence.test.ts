import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { runAttributionForRange } from '../src/main/services/attribution.ts'
import { executeTool } from '../src/main/services/aiTools.ts'
import type { GetAttributionContextResult } from '../src/main/services/aiTools.ts'
import { getAppDetailPayload } from '../src/main/services/appDetail.ts'
import { browserUnattributedReason } from '../src/main/services/activityFacts.ts'

function localMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function localDayBounds(year: number, month: number, day: number): [number, number] {
  const from = localMs(year, month, day, 0, 0)
  return [from, from + 86_400_000]
}

test('active browser page titles feed evidence-backed time answers', async () => {
  const db = createProductionTestDatabase()

  const startTime = localMs(2026, 5, 1, 10, 0)
  const endTime = localMs(2026, 5, 1, 10, 45)
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
    ) VALUES (?, ?, ?, ?, ?, 'browsing', 1, ?, ?, 'chrome', ?, 'test', 2)
  `).run(
    'chrome.exe',
    'Google Chrome',
    startTime,
    endTime,
    Math.round((endTime - startTime) / 1000),
    'Google Chrome',
    'Google Chrome',
    'chrome.exe',
  )

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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'default', ?, ?, 'active_browser_context')
  `).run(
    'docs.google.com',
    'ASYV renewal budget - Google Docs',
    'https://docs.google.com/document/d/asyv-renewal',
    startTime,
    BigInt(startTime) * 1000n,
    Math.round((endTime - startTime) / 1000),
    'chrome.exe',
    'chrome',
    'https://docs.google.com/document/d/asyv-renewal',
    'docs.google.com/document/d/asyv-renewal',
  )

  const [fromMs, toMs] = localDayBounds(2026, 5, 1)
  const attribution = runAttributionForRange(fromMs, toMs, {}, db)
  assert.equal(attribution.sessionCount, 1)

  const evidence = db.prepare(`
    SELECT evidence_value
    FROM work_session_evidence
    ORDER BY weight DESC
  `).all() as { evidence_value: string }[]
  assert.ok(evidence.some((row) => row.evidence_value.includes('ASYV renewal budget')))

  // "ASYV" has no `clients` row, so the attribution tool falls back to an
  // inferred breakdown from activity mentioning it — never a dead-end — and
  // the evidence it found (the ASYV renewal budget doc) must be in that
  // breakdown, tagged as inferred rather than structured attribution.
  const result = executeTool('getAttributionContext', { entityName: 'ASYV' }, db) as GetAttributionContextResult
  assert.equal(result.entityType, 'unknown', 'no clients row exists for ASYV yet')
  assert.ok(result.inferredActivity, 'expected an inferred breakdown instead of a dead-end')
  assert.ok(
    result.inferredActivity!.some((entry) => /ASYV renewal budget/.test(entry.label)),
    `expected the ASYV renewal budget evidence in inferredActivity, got: ${JSON.stringify(result.inferredActivity)}`,
  )
  assert.match(result.setupHint ?? '', /isn't set up as a client/)
  db.close()
})

test('Dia (a real browser with no "browser"-shaped bundle id) is detected and gets domain evidence', async () => {
  const db = createProductionTestDatabase()

  const startTime = localMs(2026, 5, 1, 10, 0)
  const endTime = localMs(2026, 5, 1, 10, 30)
  // Dia's bundle id/app name contain no "chrome|safari|firefox|edge|brave|arc|
  // opera|vivaldi|browser" substring, so the old regex-based looksLikeBrowser
  // never enriched its sessions. category is deliberately 'aiTools' (Dia's
  // catalog default), not 'browsing', so this exercises the app-identity
  // catalog tier of detection rather than the cheap category shortcut.
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
    ) VALUES (?, ?, ?, ?, ?, 'aiTools', 1, ?, ?, 'dia', ?, 'test', 2)
  `).run(
    'company.thebrowser.dia',
    'Dia',
    startTime,
    endTime,
    Math.round((endTime - startTime) / 1000),
    'Dia',
    'Dia',
    'company.thebrowser.dia',
  )

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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'default', ?, ?, 'active_browser_context')
  `).run(
    'notion.so',
    'ASYV renewal budget - Notion',
    'https://notion.so/asyv-renewal',
    startTime,
    BigInt(startTime) * 1000n,
    Math.round((endTime - startTime) / 1000),
    'company.thebrowser.dia',
    'dia',
    'https://notion.so/asyv-renewal',
    'notion.so/asyv-renewal',
  )

  const [fromMs, toMs] = localDayBounds(2026, 5, 1)
  const attribution = runAttributionForRange(fromMs, toMs, {}, db)
  assert.equal(attribution.sessionCount, 1)

  const segments = db.prepare(`
    SELECT domain, window_title AS windowTitle
    FROM activity_segments
    WHERE primary_bundle_id = 'company.thebrowser.dia'
  `).all() as { domain: string | null; windowTitle: string | null }[]

  assert.ok(segments.length > 0, 'expected at least one activity segment for the Dia session')
  assert.ok(
    segments.some((row) => row.domain === 'notion.so'),
    'Dia session should be enriched with browser evidence (domain), not left null',
  )
  db.close()
})

test('a stale media row cannot absorb hours of titleless browser time (DEV-290)', () => {
  const db = createProductionTestDatabase()

  // One Netflix navigation, then four hours of foreground Dia with no titles,
  // no live tab events, no playback hold, and no further navigation. The
  // history fill must stop at the uncorroborated media cap; the rest is an
  // honest "No page recorded" remainder with a reason attached (DEV-238).
  const startTime = localMs(2026, 5, 1, 20, 0)
  const endTime = localMs(2026, 5, 2, 0, 0)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id,
      app_instance_id, capture_source, capture_version
    ) VALUES ('company.thebrowser.dia', 'Dia', ?, ?, ?, 'browsing',
      0, NULL, 'Dia', 'dia', 'company.thebrowser.dia', 'test', 2)
  `).run(startTime, endTime, Math.round((endTime - startTime) / 1000))
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source
    ) VALUES ('netflix.com', 'Netflix', 'https://netflix.com/watch/81234567',
      'https://netflix.com/watch/81234567', 'netflix.com/watch/81234567',
      ?, ?, 600, 'company.thebrowser.dia', 'dia', 'chrome_history')
  `).run(startTime, BigInt(startTime) * 1000n)

  const detail = getAppDetailPayload(db, 'dia', '2026-05-01')
  const activity = detail.browserActivity
  assert.ok(activity, 'Dia is a browser and must carry the breakdown')

  const netflix = activity!.domains.find((domain) => domain.domain === 'netflix.com')
  assert.ok(netflix, 'the recorded visit still appears as evidence')
  // Stored duration (600s) plus the uncorroborated media fill cap (15m) is
  // the most a single stale row may claim. Hours are impossible.
  assert.equal(netflix!.totalSeconds, 600 + 15 * 60)

  // The rest of the evening is unattributed, and the row explains why in
  // plain language instead of dead-ending.
  assert.equal(activity!.attributedSeconds + activity!.unattributedSeconds, activity!.totalSeconds)
  assert.ok(activity!.unattributedSeconds >= 2 * 3600, 'the work dwell stays unattributed')
  assert.ok(activity!.coverageNote, 'unattributed time carries a reason')
  assert.match(activity!.coverageNote!, /Dia does not share its active tab or window titles/)
  assert.doesNotMatch(activity!.coverageNote!, /—/, 'no em dashes in product strings')
  db.close()
})

test('the unattributed reason names the missing Safari capability and how to grant it', () => {
  const reason = browserUnattributedReason({
    canonicalBrowserId: 'safari',
    displayName: 'Safari',
    platform: 'darwin',
    safariHistoryAccess: 'denied',
    attributedSeconds: 0,
    hasLiveTabSamples: false,
    hasUsefulWindowTitles: true,
  })
  assert.match(reason, /Safari history/)
  assert.match(reason, /Full Disk Access/)
  assert.match(reason, /System Settings/)
  assert.doesNotMatch(reason, /—/, 'no em dashes in product strings')

  // The same status while unknown (never checked) still explains the grant,
  // because zero attributed pages plus an unverified grant is the same user
  // problem; once access is verified 'ok' the generic wording applies.
  const unknownReason = browserUnattributedReason({
    canonicalBrowserId: 'safari',
    displayName: 'Safari',
    platform: 'darwin',
    safariHistoryAccess: 'unknown',
    attributedSeconds: 0,
    hasLiveTabSamples: false,
    hasUsefulWindowTitles: true,
  })
  assert.match(unknownReason, /Full Disk Access/)

  const grantedReason = browserUnattributedReason({
    canonicalBrowserId: 'safari',
    displayName: 'Safari',
    platform: 'darwin',
    safariHistoryAccess: 'ok',
    attributedSeconds: 0,
    hasLiveTabSamples: false,
    hasUsefulWindowTitles: false,
  })
  assert.doesNotMatch(grantedReason, /Full Disk Access/)
})

test('passive-media idle metadata preserves the full attribution segment', () => {
  const db = createProductionTestDatabase()

  const startTime = localMs(2026, 5, 1, 20, 0)
  const endTime = startTime + 10 * 60_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id,
      app_instance_id, capture_source, capture_version
    ) VALUES ('company.thebrowser.dia', 'Dia', ?, ?, 600, 'browsing',
      0, NULL, 'Dia', 'dia', 'company.thebrowser.dia', 'test', 2)
  `).run(startTime, endTime)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source
    ) VALUES ('netflix.com', 'Netflix', 'https://netflix.com/watch/81234567',
      ?, ?, 600, 'company.thebrowser.dia', 'dia', 'active_browser_context')
  `).run(startTime, BigInt(startTime) * 1000n)
  db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, 'idle_start', 'tracking', '{"heldForMediaPlayback":true}'),
           (?, 'idle_end', 'tracking', '{}')
  `).run(startTime + 2 * 60_000, endTime)

  runAttributionForRange(startTime, endTime, {}, db)

  const total = db.prepare(`
    SELECT COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM activity_segments
    WHERE primary_bundle_id = 'company.thebrowser.dia'
  `).get() as { durationMs: number }
  assert.equal(total.durationMs, 10 * 60_000)
  db.close()
})
