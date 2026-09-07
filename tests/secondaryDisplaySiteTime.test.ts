// DEV-223: a long Coursera stretch on a second monitor, full-screen in Dia,
// must not collapse to the history row's 608s guess. Page time fills the
// display-visible Dia span; app totals stay input-focused.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { insertFocusEvents } from '../src/main/db/focusEventRepository.ts'
import type { FocusEventInsert } from '../src/main/core/evidence/focusEvent.ts'
import {
  getCorrectedAppSummariesForRange,
  getCorrectedPageFactsForRange,
  getCorrectedWebsiteSummariesForRange,
} from '../src/main/services/activityFacts.ts'
import { ownedDayBounds } from '../src/main/lib/dayOwnership.ts'
import { localDayBounds } from '../src/main/lib/localDate.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import {
  detectDeterministicFactRequests,
  deterministicFactsForQuestion,
  enforceDeterministicFacts,
  siteLabelsFromDomains,
} from '../src/main/agent/deterministicFacts.ts'
import { scanDurations } from '../src/main/agent/factClaims.ts'

const DIA = 'company.thebrowser.dia'
const DISPLAY_2 = 724062012
const DATE = '2026-07-20'

function localMs(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 6, 20, hour, minute, second, 0).getTime()
}

function displayEvent(
  tsMs: number,
  eventType: 'display_visible_changed' | 'display_visible_sampled',
  displayId = DISPLAY_2,
): FocusEventInsert {
  return {
    ts_ms: tsMs,
    mono_ns: tsMs * 1_000_000,
    event_type: eventType,
    app_bundle_id: DIA,
    app_name: 'Dia',
    pid: 4242,
    window_title: null,
    url: null,
    page_title: null,
    source: 'cg_display_visibility',
    confidence: 'observed',
    platform: 'darwin',
    schema_ver: 2,
    display_id: displayId,
  }
}

function heartbeats(startMs: number, endMs: number): FocusEventInsert[] {
  const out: FocusEventInsert[] = []
  for (let ts = startMs + 10_000; ts <= endMs; ts += 10_000) {
    out.push(displayEvent(ts, 'display_visible_sampled'))
  }
  return out
}

function seedMorning(db: Database.Database, visitDurationSec = 608): { fromMs: number; toMs: number } {
  const fromMs = localMs(9, 13)
  const toMs = localMs(11, 23)
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('notion.id', 'Notion', ?, ?, ?, 'writing', 1, 'ML roadmap', 'Notion', 'notion', 'notion.id', 'test', 1)
  `).run(fromMs, toMs, Math.round((toMs - fromMs) / 1000))

  insertFocusEvents(db, [
    displayEvent(fromMs, 'display_visible_changed'),
    ...heartbeats(fromMs, toMs),
  ])

  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source)
    VALUES ('www.coursera.org', 'Supervised Machine Learning — Coursera',
      'https://www.coursera.org/learn/machine-learning', ?, ?, ?, ?, 'chrome_history')
  `).run(fromMs, fromMs * 1000, visitDurationSec, DIA)

  return { fromMs, toMs }
}

test('second-monitor Dia Coursera fills to the visible span, not the 608s history guess', () => {
  const db = createProductionTestDatabase()
  const { fromMs, toMs } = seedMorning(db)
  const visibleSeconds = Math.round((toMs - fromMs) / 1000)

  const sites = getCorrectedWebsiteSummariesForRange(db, fromMs, toMs)
  const coursera = sites.find((site) => site.domain.includes('coursera'))
  assert.ok(coursera, 'Coursera must appear in corrected site totals')
  assert.ok(
    coursera.totalSeconds >= visibleSeconds - 30,
    `Coursera should cover the visible morning (got ${coursera.totalSeconds}s, visible ${visibleSeconds}s)`,
  )
  assert.ok(coursera.totalSeconds > 608, 'must not stay stuck at the stored 608s visit')

  const apps = getCorrectedAppSummariesForRange(db, fromMs, toMs)
  const notion = apps.find((app) => app.appName === 'Notion')
  const dia = apps.find((app) => app.appName === 'Dia')
  assert.ok(notion && notion.totalSeconds >= visibleSeconds - 30, 'Notion still owns the focused morning')
  assert.ok(!dia || dia.totalSeconds === 0, 'visible Dia must not inflate foreground app totals')

  const [dayFrom, dayTo] = ownedDayBounds(db, DATE)
  const daySites = getCorrectedWebsiteSummariesForRange(db, dayFrom, dayTo)
  const dayCoursera = daySites.find((site) => site.domain.includes('coursera'))
  const timeline = getTimelineDayPayload(db, DATE, null)
  const timelineCoursera = timeline.websites.find((site) => site.domain.includes('coursera'))
  assert.ok(dayCoursera && timelineCoursera, 'Timeline day websites must include Coursera')
  assert.equal(
    timelineCoursera.totalSeconds,
    dayCoursera.totalSeconds,
    'Timeline site total must equal the Apps/AI reconciled ledger for the same day bounds',
  )
  assert.ok(dayCoursera.totalSeconds > 608, 'day-level Coursera must still leave the 608s guess')
  assert.ok(
    (timeline.secondaryDisplay ?? []).some((span) => span.appName === 'Dia'),
    'Timeline must still show Dia as second-display presence',
  )

  const pages = getCorrectedPageFactsForRange(db, fromMs, toMs)
  const courseraPage = pages.pages.find((page) => page.domain.includes('coursera'))
  assert.ok(courseraPage && courseraPage.totalSeconds > 608, 'page facts must fill the visible span too')
  const diaCoverage = pages.coverage.find((entry) => entry.appName === 'Dia' || entry.canonicalBrowserId.includes('dia'))
  assert.ok(diaCoverage && diaCoverage.visibleSeconds >= visibleSeconds - 30, 'coverage must name the second-display Dia span')
  db.close()
})

test('how long on Coursera binds to site_total_time and repairs a 608-second first answer', () => {
  const db = createProductionTestDatabase()
  seedMorning(db)
  const nowMs = localMs(14, 0)

  const facts = deterministicFactsForQuestion(
    db,
    `how many hours have i spent on coursera and studying this morning?`,
    { dates: [DATE] },
    { nowMs },
  )
  assert.equal(facts[0]?.kind, 'site_total_time')
  assert.ok(facts[0].value > 608, `first figure must be the filled morning, not 608 (got ${facts[0].value})`)
  assert.doesNotMatch(facts[0].statement, /\d+ seconds/)
  assert.match(facts[0].rendered, /h|m/)

  const lie = 'Based on your Daylens data, you spent approximately 10 minutes (608 seconds) on Coursera between 9:13 AM and 1:58 PM.'
  const enforced = enforceDeterministicFacts(lie, facts)
  assert.ok(enforced.repairs.length >= 1, 'the 10-minute / 608-second walk-back cannot ship')
  assert.doesNotMatch(enforced.text, /608 seconds/)
  assert.ok(
    Math.abs((scanDurations(enforced.text)[0]?.seconds ?? 0) - facts[0].value) <= 60
    || enforced.text.includes(facts[0].rendered),
    `repaired answer should state ${facts[0].rendered}: ${enforced.text}`,
  )

  const detection = detectDeterministicFactRequests(
    'how long was I on coursera this morning?',
    { dates: [DATE] },
    ['Notion', 'Cursor'],
    siteLabelsFromDomains(['www.coursera.org']),
  )
  assert.deepEqual(detection.map((request) => request.kind), ['site_total_time'])

  const dateQuestion = detectDeterministicFactRequests(
    `how long was I working on ${DATE}?`,
    { dates: [DATE] },
    ['Notion', 'Cursor'],
    [],
  )
  assert.deepEqual(
    dateQuestion.map((request) => request.kind),
    ['total_tracked_time'],
    'an ISO date is not a site name',
  )

  const projectQuestion = detectDeterministicFactRequests(
    'how long did I work on project-x?',
    { dates: [DATE] },
    ['Notion', 'Cursor'],
    [],
  )
  assert.deepEqual(projectQuestion.map((request) => request.kind), ['total_tracked_time'])

  const appQuestion = detectDeterministicFactRequests(
    'how long was I in Notion?',
    { dates: [DATE] },
    ['Notion'],
    ['notion'],
  )
  assert.deepEqual(appQuestion.map((request) => request.kind), ['app_total_time'])
  db.close()
})

test('equivalent www and bare domains aggregate into one site fact', () => {
  const db = createProductionTestDatabase()
  const { fromMs } = seedMorning(db, 600)
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, source)
    VALUES ('coursera.org', 'Coursera lesson', 'https://coursera.org/lesson', ?, ?, 300, ?, 'chrome_history')
  `).run(fromMs + 60_000, (fromMs + 60_000) * 1000, DIA)

  const facts = deterministicFactsForQuestion(
    db,
    'how long was I on Coursera?',
    { dates: [DATE] },
    { nowMs: localMs(14, 0) },
  )
  const [dayFrom, dayTo] = ownedDayBounds(db, DATE)
  const sites = getCorrectedWebsiteSummariesForRange(db, dayFrom, dayTo)
  const expected = sites
    .filter((site) => site.domain.replace(/^www\./, '') === 'coursera.org')
    .reduce((total, site) => total + site.totalSeconds, 0)
  assert.equal(facts[0]?.value, expected)
  const count = deterministicFactsForQuestion(
    db,
    'how many sites?',
    { dates: [DATE] },
    { nowMs: localMs(14, 0) },
  )
  assert.equal(count[0]?.kind, 'site_count')
  assert.equal(count[0]?.value, 1)
  db.close()
})

test('coverage unions the same browser visible on overlapping displays', () => {
  const db = createProductionTestDatabase()
  const fromMs = localMs(9)
  const toMs = localMs(10)
  const otherDisplay = DISPLAY_2 + 1
  insertFocusEvents(db, [
    displayEvent(fromMs, 'display_visible_changed'),
    displayEvent(fromMs, 'display_visible_changed', otherDisplay),
    ...heartbeats(fromMs, toMs),
    ...heartbeats(fromMs, toMs).map((event) => ({ ...event, display_id: otherDisplay })),
  ])

  const coverage = getCorrectedPageFactsForRange(db, fromMs, toMs).coverage
  const dia = coverage.find((entry) => entry.appName === 'Dia' || entry.canonicalBrowserId.includes('dia'))
  assert.ok(dia)
  assert.ok(dia.visibleSeconds <= Math.round((toMs - fromMs) / 1000))
  db.close()
})

test('scanDurations treats raw seconds as a duration so 608 seconds cannot hide', () => {
  const found = scanDurations('you spent 608 seconds on Coursera')
  assert.equal(found.length, 1)
  assert.equal(found[0].seconds, 608)
})

test('sealed cross-midnight site time follows owned-day bounds, not calendar midnight', () => {
  const db = createProductionTestDatabase()
  const sittingStart = new Date(2026, 5, 20, 23, 50, 0, 0).getTime()
  const sittingEnd = new Date(2026, 5, 21, 2, 45, 0, 0).getTime()
  const laterStart = new Date(2026, 5, 21, 4, 0, 0, 0).getTime()
  const laterEnd = new Date(2026, 5, 21, 5, 0, 0, 0).getTime()
  const nowMs = new Date(2026, 5, 21, 12, 0, 0, 0).getTime()
  const sittingSeconds = Math.round((sittingEnd - sittingStart) / 1000)

  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('com.google.Chrome', 'Google Chrome', ?, ?, ?, 'browsing', 1, 'Example Domain',
      'Google Chrome', 'chrome', 'com.google.Chrome', 'test', 1)
  `).run(sittingStart, sittingEnd, sittingSeconds)
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('example.com', 'Example Domain', 'https://example.com/', ?, ?, ?,
      'com.google.Chrome', 'chrome', 'chrome_history')
  `).run(sittingStart, sittingStart * 1000, sittingSeconds)
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES ('com.todesktop.230313mzl4w4u92', 'Cursor', ?, ?, ?, 'development', 1, 'daylens',
      'Cursor', 'cursor', 'com.todesktop.230313mzl4w4u92', 'test', 1)
  `).run(laterStart, laterEnd, Math.round((laterEnd - laterStart) / 1000))

  const june20 = getTimelineDayPayload(db, '2026-06-20', null)
  const june21 = getTimelineDayPayload(db, '2026-06-21', null)
  const june20Site = june20.websites.find((site) => site.domain.replace(/^www\./, '') === 'example.com')
  const june21Site = june21.websites.find((site) => site.domain.replace(/^www\./, '') === 'example.com')
  assert.ok(june20Site, 'Timeline must keep the sealed sitting on June 20')
  assert.equal(june20Site.totalSeconds, sittingSeconds)
  assert.equal(june21Site?.totalSeconds ?? 0, 0, 'Timeline June 21 must not take the overnight site')
  const [calendarFrom, calendarTo] = localDayBounds('2026-06-20')
  const calendarJune20 = getCorrectedWebsiteSummariesForRange(db, calendarFrom, calendarTo)
    .find((site) => site.domain.replace(/^www\./, '') === 'example.com')
  assert.ok(
    (calendarJune20?.totalSeconds ?? 0) < sittingSeconds,
    'calendar midnight would split the sitting; owned-day bounds must not',
  )

  const june20Facts = deterministicFactsForQuestion(
    db,
    'how long was I on example.com?',
    { dates: ['2026-06-20'] },
    { nowMs },
  )
  const june21Facts = deterministicFactsForQuestion(
    db,
    'how long was I on example.com?',
    { dates: ['2026-06-21'] },
    { nowMs },
  )
  const june20Count = deterministicFactsForQuestion(db, 'how many sites?', { dates: ['2026-06-20'] }, { nowMs })
  const june21Count = deterministicFactsForQuestion(db, 'how many sites?', { dates: ['2026-06-21'] }, { nowMs })

  assert.equal(june20Facts[0]?.kind, 'site_total_time')
  assert.equal(june20Facts[0].value, june20Site.totalSeconds)
  assert.equal(
    june21Facts.find((fact) => fact.kind === 'site_total_time')?.value ?? 0,
    june21Site?.totalSeconds ?? 0,
  )
  assert.equal(june20Count[0]?.kind, 'site_count')
  assert.equal(june20Count[0]?.value, 1)
  assert.equal(june21Count[0]?.kind, 'site_count')
  assert.equal(june21Count[0]?.value, 0)
  db.close()
})
