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

// ─── Media pages: the fill is evidence-gated (DEV-290) ───────────────────────
// A titleless browser's last-visited media page must never absorb hours of
// foreground time on the strength of one stale history row. Fill past the
// stored duration requires corroboration: a passive-media hold, a window
// title naming the site, or a same-domain re-visit at watching cadence.

const UNCORROBORATED_MEDIA_FILL_SEC = 15 * 60

function seedTitledDiaSession(db: Database.Database, startMs: number, endMs: number, title: string): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, 'Dia', ?, ?, ?, 'browsing', 0, ?, 'Dia', 'dia', ?, 'test', 1)
  `).run(DIA_BUNDLE, startMs, endMs, Math.round((endMs - startMs) / 1000), title, DIA_BUNDLE)
}

test('an uncorroborated media row cannot absorb hours of a titleless browser', () => {
  const db = createProductionTestDatabase()
  // Four hours of foreground Dia after one Netflix navigation, with no
  // playback hold, no titles, and no later navigation: the work dwell in
  // Dia's titleless tabs must stay "no page recorded", not become Netflix.
  seedDiaSession(db, localMs(20, 0), localMs(24, 0))
  seedHistoryVisit(db, localMs(20, 0), 30, 'https://netflix.com/watch/81234567', 'Netflix', 'netflix.com')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].domain, 'netflix.com')
  assert.equal(summaries[0].totalSeconds, 30 + UNCORROBORATED_MEDIA_FILL_SEC)
  db.close()
})

test('a passive-media hold corroborates the media fill for as long as playback held', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(20, 0), localMs(24, 0))
  seedHistoryVisit(db, localMs(20, 0), 30, 'https://netflix.com/watch/81234567', 'Netflix', 'netflix.com')
  // The user idles at 20:10 (idle detection backdates two minutes) while
  // Netflix keeps playing, and comes back at 22:30.
  db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, 'idle_start', 'tracking', '{"idleSeconds":120,"heldForMediaPlayback":true}'),
           (?, 'idle_end', 'tracking', '{}')
  `).run(localMs(20, 10), localMs(22, 30))

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  // Credit runs to the hold's end plus one uncorroborated grace, then stops:
  // 20:00 through 22:45. The 22:45-24:00 stretch stays unattributed.
  assert.equal(
    summaries[0].totalSeconds,
    Math.round((localMs(22, 45) - localMs(20, 0)) / 1000),
  )
  db.close()
})

test('a window title naming the site corroborates the media fill', () => {
  const db = createProductionTestDatabase()
  // The browser reports titles here: two hours titled with the show, then a
  // titleless tail. Credit follows the title evidence, not the whole session.
  seedTitledDiaSession(db, localMs(20, 0), localMs(22, 0), 'Stranger Things | Netflix')
  seedDiaSession(db, localMs(22, 0), localMs(24, 0))
  seedHistoryVisit(db, localMs(20, 0), 30, 'https://netflix.com/watch/81234567', 'Netflix', 'netflix.com')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(
    summaries[0].totalSeconds,
    Math.round((localMs(22, 15) - localMs(20, 0)) / 1000),
  )
  db.close()
})

test('same-domain re-visits at watching cadence keep the stretch between them', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(20, 0), localMs(22, 0))
  // Two episodes: rows 45 minutes apart bracket the first stretch. The last
  // row has no evidence past it and stops at the uncorroborated cap.
  seedHistoryVisit(db, localMs(20, 0), 30, 'https://netflix.com/watch/1', 'Netflix', 'netflix.com')
  seedHistoryVisit(db, localMs(20, 45), 30, 'https://netflix.com/watch/2', 'Netflix', 'netflix.com')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  const bracketedSec = Math.round((localMs(20, 45) - localMs(20, 0)) / 1000)
  const tailSec = 30 + UNCORROBORATED_MEDIA_FILL_SEC
  assert.equal(summaries[0].totalSeconds, bracketedSec + tailSec)
  db.close()
})

test('a Spotify hold in another app cannot corroborate a stale Netflix row', () => {
  const db = createProductionTestDatabase()
  // Dia foreground 20:00-21:00 with a stale Netflix row, then the user
  // switches to Spotify and idles while music plays (21:10-22:50 hold), then
  // returns to Dia 23:00-24:00. The hold belongs to Spotify's foreground, not
  // Dia's, so it must not chain the Netflix fill into the later Dia stretch.
  seedDiaSession(db, localMs(20, 0), localMs(21, 0))
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('com.spotify.client', 'Spotify', ?, ?, ?, 'entertainment', 0, 'Spotify', 'Spotify',
      'spotify', 'com.spotify.client', 'test', 1)
  `).run(localMs(21, 0), localMs(23, 0), 2 * 3600)
  seedDiaSession(db, localMs(23, 0), localMs(24, 0))
  seedHistoryVisit(db, localMs(20, 0), 30, 'https://netflix.com/watch/81234567', 'Netflix', 'netflix.com')
  db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, 'idle_start', 'tracking', '{"idleSeconds":120,"heldForMediaPlayback":true}'),
           (?, 'idle_end', 'tracking', '{}')
  `).run(localMs(21, 12), localMs(22, 50))

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].domain, 'netflix.com')
  assert.equal(summaries[0].totalSeconds, 30 + UNCORROBORATED_MEDIA_FILL_SEC)
  db.close()
})

test('a hold inside a title-producing browser must name the site (Zoom call cannot vouch for YouTube)', () => {
  const db = createProductionTestDatabase()
  // The browser reports titles, and they say the user sat in a Zoom web call
  // for two hours. A stale YouTube row before the call must not ride the
  // call's playback hold; a titled browser corroborates only by naming the
  // site.
  seedTitledDiaSession(db, localMs(10, 0), localMs(12, 0), 'Zoom Meeting - Weekly sync')
  seedHistoryVisit(db, localMs(10, 0), 30, 'https://youtube.com/watch?v=1', 'A video', 'youtube.com')
  db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, 'idle_start', 'tracking', '{"idleSeconds":120,"heldForMediaPlayback":true}'),
           (?, 'idle_end', 'tracking', '{}')
  `).run(localMs(10, 10), localMs(11, 50))

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].domain, 'youtube.com')
  assert.equal(summaries[0].totalSeconds, 30 + UNCORROBORATED_MEDIA_FILL_SEC)
  db.close()
})

test('a short-core domain still earns title corroboration through its brand pattern', () => {
  const db = createProductionTestDatabase()
  // x.com's naming core is one letter, so the generic token match can never
  // fire; the brand table ("Home / X", "twitter") must carry it instead
  // during a genuinely attended session.
  seedTitledDiaSession(db, localMs(14, 0), localMs(14, 45), 'Home / X')
  seedDiaSession(db, localMs(14, 45), localMs(16, 0))
  seedHistoryVisit(db, localMs(14, 0), 30, 'https://x.com/home', 'Home / X', 'x.com')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].domain, 'x.com')
  // Corroborated through 14:45 plus one grace, honest remainder after 15:00.
  assert.equal(
    summaries[0].totalSeconds,
    Math.round((localMs(15, 0) - localMs(14, 0)) / 1000),
  )
  db.close()
})

test('a non-media page keeps the full corroborated fill (the Coursera morning survives)', () => {
  const db = createProductionTestDatabase()
  seedDiaSession(db, localMs(9, 0), localMs(12, 0))
  seedHistoryVisit(db, localMs(9, 0), 30, 'https://www.coursera.org/learn/ml', 'Supervised ML | Coursera')

  const summaries = getCorrectedWebsiteSummariesForRange(db, DAY_FROM, DAY_TO)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].totalSeconds, Math.round((localMs(12, 0) - localMs(9, 0)) / 1000))
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
