// History-corroborated page time fills the browser's verified foreground
// spans (issue #21, cause 1). A browser without a readable tab (Dia) records
// one history row for a long single-page stay, and that row's stored duration
// is a navigation-gap guess — a whole Coursera morning used to reconcile to
// "608 seconds". These tests pin the fill rules: bounded by the browser's own
// foreground time, bounded by the next recorded navigation, capped, never
// extended into untracked gaps, and never persisting live page detail for an
// unverifiable window mode.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getCorrectedWebsiteSummariesForRange } from '../src/main/services/activityFacts.ts'
import { getWebsiteSummariesForRange } from '../src/main/db/queries.ts'
import { ActiveBrowserContextTracker, type ActiveBrowserWindowSnapshot } from '../src/main/services/browserContext.ts'

const DIA_BUNDLE = 'company.thebrowser.dia'

function localMs(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 6, 15, hour, minute, second, 0).getTime()
}

const DAY_FROM = new Date(2026, 6, 15, 0, 0, 0, 0).getTime()
const DAY_TO = DAY_FROM + 24 * 3600 * 1000

function seedDiaSession(db: Database.Database, startMs: number, endMs: number): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, 'Dia', ?, ?, ?, 'browsing', 0, NULL, 'Dia', 'dia', ?, 'test', 1)
  `).run(DIA_BUNDLE, startMs, endMs, Math.round((endMs - startMs) / 1000), DIA_BUNDLE)
}

function seedHistoryVisit(
  db: Database.Database,
  visitMs: number,
  durationSec: number,
  url: string,
  title: string,
  domain = 'coursera.org',
): void {
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'dia', 'chrome_history')
  `).run(domain, title, url, visitMs, visitMs * 1000, durationSec, DIA_BUNDLE)
}

test('a long single-page stay is attributed from the browser foreground span, not the 30s gap guess', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 13), localMs(11, 23))
  seedHistoryVisit(db, localMs(9, 13), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].domain, 'coursera.org')
  assert.equal(summaries[0].totalSeconds, Math.round((localMs(11, 23) - localMs(9, 13)) / 1000))
  db.close()
})

test('the fill stops at the next recorded navigation in the same browser', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 0), localMs(12, 0))
  seedHistoryVisit(db, localMs(9, 0), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')
  seedHistoryVisit(db, localMs(10, 0), 30, 'https://www.coursera.org/exam/1', 'Exam | Coursera')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  // The two pages partition the browser's own foreground time between them:
  // page one owns 9:00–10:00, the exam owns 10:00–12:00, no double counting.
  assert.equal(summaries[0].totalSeconds, Math.round((localMs(12, 0) - localMs(9, 0)) / 1000))
  db.close()
})

test('a single visit cannot fill more than the per-visit cap of foreground time', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 0), localMs(15, 0))
  seedHistoryVisit(db, localMs(9, 0), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  const fourHoursPlusStored = 4 * 3600 + 30
  assert.equal(summaries[0].totalSeconds, fourHoursPlusStored)
  // The remaining foreground time stays an honest "no page recorded" gap.
  assert.ok(summaries[0].totalSeconds < Math.round((localMs(15, 0) - localMs(9, 0)) / 1000))
  db.close()
})

test('the fill never extends into untracked gaps — only stored durations count there', () => {
  const db = createProductionTestDatabase()
  // No app sessions at all: the whole range is an untracked gap on the raw
  // path. The stored 30 seconds stay countable evidence; the fill must not
  // invent hours inside the capture hole.
  seedHistoryVisit(db, localMs(9, 0), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')

  const raw = getWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(raw.length, 1)
  assert.equal(raw[0].totalSeconds, 30)
  // The corrected path refuses even the stored duration without foreground.
  assert.equal(getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO).length, 0)
  db.close()
})

test('uncorroborated media on a titleless browser cannot fill hours of foreground', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 0), localMs(12, 0))
  seedHistoryVisit(
    db,
    localMs(9, 0),
    30,
    'https://www.netflix.com/watch/81234567',
    'Stranger Things | Netflix',
    'netflix.com',
  )

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].domain, 'netflix.com')
  // Stored 30s plus the 2-minute uncorroborated-media grace — not the 3h
  // Dia stay, and not the 4h general fill cap.
  assert.equal(summaries[0].totalSeconds, 30 + 2 * 60)
  db.close()
})

test('a later course page still receives the full fill after a media peek', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 0), localMs(12, 0))
  seedHistoryVisit(
    db,
    localMs(9, 0),
    30,
    'https://www.netflix.com/watch/81234567',
    'Stranger Things | Netflix',
    'netflix.com',
  )
  seedHistoryVisit(db, localMs(9, 1), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  const bySite = new Map(summaries.map((row) => [row.domain, row.totalSeconds]))
  assert.equal(bySite.get('netflix.com'), 60, 'media fill stops at the next navigation')
  assert.equal(bySite.get('coursera.org'), Math.round((localMs(12, 0) - localMs(9, 1)) / 1000))
  db.close()
})

test('a live active-tab sample corroborates media so the ordinary fill cap applies', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 0), localMs(11, 0))
  seedHistoryVisit(
    db,
    localMs(9, 0),
    30,
    'https://www.netflix.com/watch/81234567',
    'Stranger Things | Netflix',
    'netflix.com',
  )
  // A later live sample of the same host is corroboration, not a 9:00
  // navigation that would hide whether the 4h cap or the 2-minute grace won.
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('netflix.com', 'Stranger Things | Netflix', 'https://www.netflix.com/watch/81234567', ?, ?, ?, ?, 'dia', 'active_browser_context')
  `).run(localMs(10, 0), localMs(10, 0) * 1000, 60, DIA_BUNDLE)

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].domain, 'netflix.com')
  // History fills 9:00–10:00 (ordinary cap, stopped by the live sample),
  // then the observed minute owns 10:00–10:01.
  assert.equal(summaries[0].totalSeconds, 3600 + 60)
  db.close()
})

test('a titled browser may still fill entertainment history up to the ordinary cap', () => {
  const db = createProductionTestDatabase()
  const safari = 'com.apple.Safari'
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, 'Safari', ?, ?, ?, 'entertainment', 0, 'Stranger Things · Netflix', 'Safari', 'safari', ?, 'test', 1)
  `).run(safari, localMs(9, 0), localMs(15, 0), Math.round((localMs(15, 0) - localMs(9, 0)) / 1000), safari)
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('netflix.com', 'Stranger Things | Netflix', 'https://www.netflix.com/watch/81234567', ?, ?, ?, ?, 'safari', 'chrome_history')
  `).run(localMs(9, 0), localMs(9, 0) * 1000, 30, safari)

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].totalSeconds, 4 * 3600 + 30)
  db.close()
})

test('a live active-tab sample keeps priority over the history fill', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 0), localMs(11, 0))
  seedHistoryVisit(db, localMs(9, 0), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('example.com', 'An article', 'https://example.com/article', ?, ?, ?, ?, 'dia', 'active_browser_context')
  `).run(localMs(10, 0), localMs(10, 0) * 1000, 1800, DIA_BUNDLE)

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  const bySite = new Map(summaries.map((row) => [row.domain, row.totalSeconds]))
  // The observed active tab owns its 30 minutes, and the history fill stops
  // at that navigation: 9:00–10:00 for the course page, 10:00–10:30 for the
  // article. The 10:30–11:00 tail has no corroborated page and stays an
  // honest "no page recorded" remainder.
  assert.equal(bySite.get('example.com'), 1800)
  assert.equal(bySite.get('coursera.org'), 3600)
  db.close()
})

// ─── Privacy: the fill never weakens the unverifiable-mode rule ──────────────

function snapshot(overrides: Partial<ActiveBrowserWindowSnapshot> = {}): ActiveBrowserWindowSnapshot {
  return {
    bundleId: '/Applications/Dia.app/Contents/MacOS/Dia',
    appName: 'Dia',
    windowTitle: 'Supervised ML | Coursera',
    capturedAt: localMs(9, 13),
    ...overrides,
  }
}

test('an unverifiable window mode still yields no live page capture, only the sample flags', () => {
  const db = createProductionTestDatabase()
  const tracker = new ActiveBrowserContextTracker(
    () => ({ url: 'https://www.coursera.org/learn/ml', title: 'Supervised ML | Coursera', modeKnown: false }),
    () => true,
  )

  const sample = tracker.sample(db, snapshot())
  assert.equal(sample.isPrivate, false)
  assert.equal(sample.windowModeUnverified, true)
  assert.equal(sample.passivePresence, true)
  assert.equal(sample.passiveHold, 'reading')

  tracker.sample(db, snapshot({ capturedAt: localMs(9, 14) }))
  assert.equal(tracker.flush(db, localMs(11, 23)), false)
  const count = db.prepare('SELECT COUNT(*) AS c FROM website_visits').get() as { c: number }
  assert.equal(count.c, 0, 'unverifiable-mode reads must never reach website_visits')
  db.close()
})

test('an unverifiable Chromium tab stays unpublished when history names the same page', () => {
  const db = createProductionTestDatabase()
  seedHistoryVisit(db, localMs(9, 12), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')
  const tracker = new ActiveBrowserContextTracker(
    () => ({ url: 'https://www.coursera.org/learn/ml', title: 'Supervised ML | Coursera', modeKnown: false }),
    () => true,
  )

  const sample = tracker.sample(db, snapshot())
  assert.equal(sample.windowModeUnverified, true)
  tracker.sample(db, snapshot({ capturedAt: localMs(9, 14) }))
  assert.equal(tracker.flush(db, localMs(9, 15)), false)

  const rows = db.prepare(`
    SELECT domain, source FROM website_visits WHERE source = 'active_browser_context'
  `).all() as { domain: string; source: string }[]
  assert.deepEqual(rows, [])
  db.close()
})

test('an unverifiable Chromium tab does not persist when the latest history row is a different page', () => {
  const db = createProductionTestDatabase()
  seedHistoryVisit(
    db,
    localMs(9, 12),
    30,
    'https://www.netflix.com/watch/81234567',
    'Stranger Things | Netflix',
    'netflix.com',
  )
  const tracker = new ActiveBrowserContextTracker(
    () => ({ url: 'https://www.coursera.org/learn/ml', title: 'Supervised ML | Coursera', modeKnown: false }),
    () => true,
  )

  const sample = tracker.sample(db, snapshot())
  assert.equal(sample.windowModeUnverified, true)
  assert.equal(tracker.flush(db, localMs(9, 15)), false)
  const live = db.prepare(`
    SELECT COUNT(*) AS c FROM website_visits WHERE source = 'active_browser_context'
  `).get() as { c: number }
  assert.equal(live.c, 0)
  db.close()
})
