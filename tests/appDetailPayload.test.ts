import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getAppDetailPayload } from '../src/main/services/appDetail.ts'

function todayKey(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localMs(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

test('app detail omits app-name-only block appearances', () => {
  const db = createProductionTestDatabase()
  const date = todayKey()
  const start = localMs(date, 9)
  const end = start + 12 * 60_000

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
      capture_source,
      capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'test', 1)
  `).run(
    'com.whatsapp.WhatsApp',
    'whatsApp',
    start,
    end,
    12 * 60,
    'communication',
    'WhatsApp',
    'whatsApp',
  )

  const detail = getAppDetailPayload(db, 'whatsapp', 1, null)

  assert.equal(detail.displayName, 'WhatsApp')
  assert.deepEqual(detail.blockAppearances, [])
  db.close()
})

test('app detail keeps total time but merges quick returns into one human session', () => {
  const db = createProductionTestDatabase()
  const date = todayKey()
  const start = localMs(date, 9)

  const insert = db.prepare(`
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
      capture_source,
      capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 1)
  `)

  insert.run('com.example.TestApp', 'Test App', start, start + 10_000, 10, 'development', 'Brief flicker', 'Test App', 'test-app')
  insert.run('com.example.TestApp', 'Test App', start + 60_000, start + 80_000, 20, 'development', 'Visible session', 'Test App', 'test-app')

  const detail = getAppDetailPayload(db, 'test-app', 1, null)

  assert.equal(detail.totalSeconds, 30)
  assert.equal(detail.sessionCount, 1)
  db.close()
})

test('browser detail reconciles overlapping visits into deduped pages under their domains', () => {
  const db = createProductionTestDatabase()
  const date = todayKey()
  const start = localMs(date, 9)

  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES ('com.apple.Safari', 'Safari', ?, ?, 3600, 'browsing', 0, 'Safari', 'Safari', 'safari', 'test', 2)
  `).run(start, start + 60 * 60_000)

  const insertVisit = db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key,
      visit_time, visit_time_us, duration_sec, browser_bundle_id,
      canonical_browser_id, browser_profile_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'com.apple.Safari', 'safari', 'default', 'test')
  `)
  const githubUrl = 'https://github.com/irachrist1/daylens/pull/82'
  insertVisit.run('github.com', 'DEV-89', githubUrl, githubUrl, 'github.com/irachrist1/daylens/pull/82', start, BigInt(start) * 1_000n, 60)
  insertVisit.run('github.com', 'DEV-89', githubUrl, githubUrl, 'github.com/irachrist1/daylens/pull/82', start + 120_000, BigInt(start + 120_000) * 1_000n, 60)
  const youtubeUrl = 'https://youtube.com/watch?v=1'
  insertVisit.run('youtube.com', 'A long video', youtubeUrl, youtubeUrl, 'youtube.com/watch', start + 240_000, BigInt(start + 240_000) * 1_000n, 1200)
  const secondYoutubeUrl = 'https://youtube.com/watch?v=2'
  insertVisit.run('youtube.com', 'A different video', secondYoutubeUrl, secondYoutubeUrl, 'youtube.com/watch', start + 360_000, BigInt(start + 360_000) * 1_000n, 600)

  const detail = getAppDetailPayload(db, 'safari', 1, null)
  const activity = detail.browserActivity
  assert.ok(activity, 'a browser app must carry browserActivity')

  // The overlapping YouTube visits claim disjoint slices of Safari's hour —
  // never each other's seconds. That was the whole bug: raw sums let a
  // background tab outgrow the browser itself. As history-sourced visits they
  // also fill forward, but YouTube is a media domain and its fill is
  // evidence-gated (DEV-290): the first video owns its slice until the second
  // video's navigation, and the second — the last recorded navigation, with
  // no playback hold or matching title past it — runs only to its stored end
  // plus the uncorroborated cap (9:16 + 15m), never Safari's whole hour.
  // First video: 9:04–9:06. Second video: 9:06–9:31. Total 27 minutes.
  const youtube = activity.domains.find((d) => d.domain === 'youtube.com')
  assert.ok(youtube)
  assert.equal(youtube.totalSeconds, 27 * 60)
  assert.equal(youtube.pages.length, 2)
  const youtubeUrls = youtube.pages.map((p) => p.normalizedUrl).sort()
  assert.deepEqual(youtubeUrls, [youtubeUrl, secondYoutubeUrl].sort())

  // The repeated GitHub visit dedupes into one page carrying both visits,
  // each filling only up to the next recorded navigation.
  const github = activity.domains.find((d) => d.domain === 'github.com')
  assert.ok(github)
  assert.equal(github.pages.length, 1)
  assert.equal(github.pages[0].visitCount, 2)
  assert.equal(github.totalSeconds, 240)

  // The hour still reconciles exactly — every attributed second belongs to
  // exactly one page, pages never exceed the browser's own hour, and the
  // uncorroborated tail past the last video stays an honest remainder.
  assert.equal(activity.totalSeconds, 3600)
  assert.equal(activity.attributedSeconds, 240 + 27 * 60)
  assert.equal(activity.unattributedSeconds, 3600 - (240 + 27 * 60))
  db.close()
})

test('browser detail subtracts a partial ignored span from both header and page credit', () => {
  const db = createProductionTestDatabase()
  const date = '2026-04-22'
  const start = localMs(date, 9)
  const end = localMs(date, 10)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES ('com.apple.Safari', 'Safari', ?, ?, 3600, 'browsing', 0,
      'Safari', 'Safari', 'safari', 'test', 2)
  `).run(start, end)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, normalized_url, page_key, visit_time,
      visit_time_us, duration_sec, browser_bundle_id, canonical_browser_id, source
    ) VALUES ('example.com', 'Example', 'https://example.com', 'https://example.com',
      'example.com', ?, ?, 3600, 'com.apple.Safari', 'safari', 'active_browser_context')
  `).run(start, BigInt(start) * 1_000n)
  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id, block_id, date, evidence_key, review_state, original_block_json,
      correction_json, created_at, updated_at
    ) VALUES ('review_partial_browser', 'partial_browser', ?, 'partial_browser', 'ignored', ?, '{}', ?, ?)
  `).run(date, JSON.stringify({ startTime: localMs(date, 9, 15), endTime: localMs(date, 9, 45) }), now, now)

  const detail = getAppDetailPayload(db, 'safari', date, null)
  assert.equal(detail.totalSeconds, 1800)
  assert.equal(detail.browserActivity?.attributedSeconds, 1800)
  assert.equal(detail.browserActivity?.domains[0]?.totalSeconds, 1800)
  assert.ok((detail.browserActivity?.attributedSeconds ?? 0) <= detail.totalSeconds)
  db.close()
})

test('past-day app detail never mixes in the current live session', () => {
  const db = createProductionTestDatabase()
  const past = new Date()
  past.setDate(past.getDate() - 1)
  const date = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`
  const start = localMs(date, 9)

  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES ('com.example.TestApp', 'Test App', ?, ?, 600, 'development', 1, 'Past work', 'Test App', 'test-app', 'test', 2)
  `).run(start, start + 10 * 60_000)

  const detail = getAppDetailPayload(db, 'test-app', date, {
    bundleId: 'com.example.TestApp',
    appName: 'Test App',
    canonicalAppId: 'test-app',
    startTime: Date.now() - 5 * 60_000,
    category: 'development',
  })

  assert.equal(detail.totalSeconds, 600)
  assert.equal(detail.sessionCount, 1)
  db.close()
})
