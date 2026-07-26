import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getWebsiteSummariesForRange } from '../src/main/db/queries.ts'

// A site visited inside a browser is a breakdown of the browser's own tracked
// time, never additional time on top of it (avoiding the app/site
// double-count). These tests pin the reconciliation rules:
//   1. Site time clips to when its browser was actually frontmost.
//   2. A visit behind another focused app is a background tab → zero.
//   3. A visit in a capture gap (nothing tracked at all) stays evidence.
//   4. Overlapping visits of one domain (two capture sources) count once.

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 12, hour, minute, 0, 0).getTime()
}

function makeDb(): Database.Database {
  return createProductionTestDatabase()
}

function insertSession(db: Database.Database, bundleId: string, appName: string, startMs: number, endMs: number, category = 'browsing'): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'foreground_poll', 1)
  `).run(bundleId, appName, startMs, endMs, Math.round((endMs - startMs) / 1000), category)
}

function insertVisit(db: Database.Database, domain: string, visitMs: number, durationSec: number, browserBundleId: string | null = 'company.thebrowser.dia'): void {
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'history')
  `).run(domain, `${domain} page`, `https://${domain}/`, visitMs, visitMs * 1000, durationSec, browserBundleId)
}

test('site time clips to the browser foreground — never more than the browser itself had', () => {
  const db = makeDb()
  // Dia frontmost 10:00–11:00, Warp frontmost 11:00–12:00.
  insertSession(db, 'company.thebrowser.dia', 'Dia', localMs(10), localMs(11))
  insertSession(db, 'dev.warp.Warp-Stable', 'Warp', localMs(11), localMs(12), 'development')

  // Inside Dia's foreground hour; as the last known page it also fills the
  // browser's foreground time until the Meet navigation at 10:30.
  insertVisit(db, 'x.com', localMs(10), 1200)
  // A Meet tab that keeps accruing history duration while Warp is in front:
  // only the 10:30–11:00 slice inside Dia counts, the rest was a background tab.
  insertVisit(db, 'meet.google.com', localMs(10, 30), 5400)

  const sites = new Map(getWebsiteSummariesForRange(db, localMs(10), localMs(12)).map((site) => [site.domain, site.totalSeconds]))
  assert.equal(sites.get('x.com'), 1800)
  assert.equal(sites.get('meet.google.com'), 1800, 'background-tab minutes behind another focused app must not count')

  const browserSeconds = 3600
  const siteTotal = [...sites.values()].reduce((sum, seconds) => sum + seconds, 0)
  assert.ok(siteTotal <= browserSeconds, `site breakdown (${siteTotal}s) must fit inside the browser's own time (${browserSeconds}s)`)
  db.close()
})

test('a visit while another app is focused reconciles to zero; a visit in a capture gap survives', () => {
  const db = makeDb()
  insertSession(db, 'dev.warp.Warp-Stable', 'Warp', localMs(9), localMs(10), 'development')

  // Netflix "playing" behind Warp: background tab, zero.
  insertVisit(db, 'netflix.com', localMs(9), 1800)
  // A visit at 13:00 when nothing at all was tracked: Daylens has no evidence
  // against it, so the history record stays.
  insertVisit(db, 'github.com', localMs(13), 900)

  const sites = new Map(getWebsiteSummariesForRange(db, localMs(9), localMs(14)).map((site) => [site.domain, site.totalSeconds]))
  assert.equal(sites.get('netflix.com'), undefined, 'a background tab behind a focused app must not appear at all')
  assert.equal(sites.get('github.com'), 900, 'a history visit in a capture gap is real evidence')
  db.close()
})

test('an idle-covered gap gives sites no credit — only signal-less gaps do', () => {
  const db = makeDb()
  insertSession(db, 'company.thebrowser.dia', 'Dia', localMs(9), localMs(10))
  // 10:00–11:00 has no sessions, but idle events say the user wasn't there.
  db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, 'idle_start', 'tracking', '{"idleSeconds":0}'), (?, 'idle_end', 'tracking', '{}')
  `).run(localMs(10), localMs(11))

  // A Netflix tab left open through the idle hour: not browsing.
  insertVisit(db, 'netflix.com', localMs(10), 3600)
  // A visit at 12:00 with no signal at all: Daylens wasn't looking — evidence.
  insertVisit(db, 'github.com', localMs(12), 600)

  const sites = new Map(getWebsiteSummariesForRange(db, localMs(9), localMs(13)).map((site) => [site.domain, site.totalSeconds]))
  assert.equal(sites.get('netflix.com'), undefined, 'idle time is not browsing time')
  assert.equal(sites.get('github.com'), 600)
  db.close()
})

test('within one browser, overlapping visits of different domains partition the time — the active tab wins', () => {
  const db = makeDb()
  insertSession(db, 'company.thebrowser.dia', 'Dia', localMs(10), localMs(11))

  // History says a Meet tab spanned the whole hour; the active-tab tracker
  // saw the user on x.com for 20 minutes of it. One browser, one active tab:
  // the hour must split 40/20, not read as 60+20.
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active_browser_context')
  `).run('x.com', 'Home / X', 'https://x.com/home', localMs(10, 20), localMs(10, 20) * 1000, 1200, 'company.thebrowser.dia')
  insertVisit(db, 'meet.google.com', localMs(10), 3600)

  const sites = new Map(getWebsiteSummariesForRange(db, localMs(10), localMs(11)).map((site) => [site.domain, site.totalSeconds]))
  assert.equal(sites.get('x.com'), 1200, 'the observed active tab keeps its time')
  assert.equal(sites.get('meet.google.com'), 2400, 'the history visit only gets the minutes the active tab does not claim')
  db.close()
})

test('overlapping visits of one domain count each second once', () => {
  const db = makeDb()
  insertSession(db, 'company.thebrowser.dia', 'Dia', localMs(10), localMs(11))

  // Two history rows record the same stretch on one domain. Their slices stay
  // disjoint (never 600+600 over the same minutes), and the later row — the
  // last recorded navigation — fills the browser's remaining foreground time.
  // (A neutral work domain: media/feed domains carry the evidence-gated fill
  // pinned by historyForegroundFill.test.ts and stop earlier by design.)
  insertVisit(db, 'github.com', localMs(10, 5), 600)
  insertVisit(db, 'github.com', localMs(10, 10), 600)

  const sites = getWebsiteSummariesForRange(db, localMs(10), localMs(11))
  const github = sites.find((site) => site.domain === 'github.com')
  assert.ok(github)
  assert.equal(github.totalSeconds, 3300, '10:05–11:00 partitioned once, never double-counted')
  assert.equal(github.visitCount, 2)
  db.close()
})
