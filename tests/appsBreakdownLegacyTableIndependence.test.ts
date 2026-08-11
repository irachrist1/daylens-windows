// The Apps view domain breakdown must not depend on app_sessions being
// populated.
//
// getBrowserActivityBreakdown called reconcileWebsiteVisits without forwarding
// its caller's sessions, so the reconciler fell back to getSessionsForRange —
// which reads app_sessions only. Installs on the canonical focus_events
// evidence source stopped writing that table, so it returned zero rows for any
// recent day: the reconciler saw no foreground at all, every browser's claim
// pool collapsed to the stretches no absence signal covered, and page credit
// all but vanished. On a real day, Dia's 4h04m broke down into 55m of named
// pages and 3h09m of invented "No page recorded".
//
// The existing 30-day test could not catch this: it asserts only
// attributedSeconds <= totalSeconds, which a collapsed breakdown satisfies.
// This one pins the two-sided property — the breakdown accounts for the
// browser's time — and does it by computing the same range twice, once with
// app_sessions present and once with the table emptied underneath it. The
// caller's sessions are captured before the delete, exactly as the real caller
// gets them from the canonical source.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { insertAppSession, getBrowserActivityBreakdown, recordActivityStateEvent } from '../src/main/db/queries.ts'
import { getCorrectedSessionsForRange } from '../src/main/services/activityFacts.ts'

const DATE = '2026-06-18'
const [Y, M, D] = DATE.split('-').map(Number)
const dayStart = new Date(Y, M - 1, D).getTime()
const from = dayStart
const to = dayStart + 24 * 60 * 60 * 1000

const BROWSER_BUNDLE = 'com.apple.Safari'
const BROWSER_CANONICAL = 'safari'

function seed(db: Database.Database): void {
  // Safari in the foreground 10:00–12:00, captured as many short rows the way
  // the poller really records it.
  const start = dayStart + 10 * 3600_000
  for (let i = 0; i < 120; i++) {
    const sessionStart = start + i * 60_000
    insertAppSession(db, {
      bundleId: BROWSER_BUNDLE,
      appName: 'Safari',
      startTime: sessionStart,
      endTime: sessionStart + 60_000,
      durationSeconds: 60,
      category: 'browsing',
      isFocused: false,
      windowTitle: 'Safari',
      rawAppName: 'Safari',
      canonicalAppId: BROWSER_CANONICAL,
    })
  }

  // Four pages, each held for 30 minutes — the single-row-per-long-stay shape
  // a browser whose tabs cannot be read live produces.
  const insertVisit = db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id, canonical_browser_id,
      browser_profile_id, source)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'default', 'history')`)
  const domains = ['docs.example.com', 'news.example.com', 'mail.example.com', 'video.example.com']
  domains.forEach((domain, i) => {
    const visitTime = start + i * 30 * 60_000
    const url = `https://${domain}/page`
    insertVisit.run(domain, `Page on ${domain}`, url, url, url,
      visitTime, BigInt(visitTime) * 1000n, 30 * 60, BROWSER_BUNDLE, BROWSER_CANONICAL)
  })

  // Idle spans punched through the browsing window. These are what make the
  // fallback path collapse rather than merely change shape: with no sessions
  // to read, the reconciler treats the whole range as a capture gap and then
  // subtracts every absence from it, so the credit it can hand out is only the
  // few minutes no idle signal covers. A real day is full of these.
  for (let i = 0; i < 4; i++) {
    const windowStart = start + i * 30 * 60_000
    recordActivityStateEvent(db, {
      eventTs: windowStart + 2 * 60_000,
      eventType: 'idle_start',
      source: 'test',
      metadata: { idleSeconds: 0 },
    })
    recordActivityStateEvent(db, {
      eventTs: windowStart + 28 * 60_000,
      eventType: 'idle_end',
      source: 'test',
    })
  }
}

test('the domain breakdown survives an empty app_sessions table', () => {
  const db = createProductionTestDatabase()
  seed(db)

  // The sessions the real caller hands in. Captured while the legacy table is
  // still readable; on a canonical install these come from focus_events.
  const sessions = getCorrectedSessionsForRange(db, from, to)
  const browserSeconds = sessions
    .filter((session) => (session.canonicalAppId ?? session.bundleId) === BROWSER_CANONICAL)
    .reduce((sum, session) => sum + session.durationSeconds, 0)
  assert.ok(browserSeconds > 0, 'fixture must give the browser foreground time')

  const withLegacyTable = getBrowserActivityBreakdown(db, from, to, BROWSER_CANONICAL, { sessions })

  // Now the canonical-evidence install: nothing in app_sessions for this range.
  db.prepare('DELETE FROM app_sessions').run()
  const withoutLegacyTable = getBrowserActivityBreakdown(db, from, to, BROWSER_CANONICAL, { sessions })

  assert.equal(
    withoutLegacyTable.attributedSeconds,
    withLegacyTable.attributedSeconds,
    'an empty app_sessions table must not change the breakdown when the caller supplies sessions',
  )

  // And the breakdown must actually account for the browser's time, not just
  // stay under it — the property the <= assertion elsewhere cannot express.
  assert.ok(
    withoutLegacyTable.attributedSeconds >= browserSeconds * 0.9,
    `breakdown attributed ${withoutLegacyTable.attributedSeconds}s of the browser's `
    + `${browserSeconds}s; a collapsed claim pool is exactly the regression this guards`,
  )

  const domainSum = withoutLegacyTable.domains.reduce((sum, domain) => sum + domain.totalSeconds, 0)
  assert.equal(withoutLegacyTable.attributedSeconds, domainSum)
  db.close()
})
