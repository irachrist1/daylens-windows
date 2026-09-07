// DEV-246: domain-time questions must look up a website, not an app.
// Coursera is a site. A loose app substring ("Course") used to steal the
// first get_app_usage call and return ~10m; website lookup has the real total.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { buildDaylensTools } from '../src/main/agent/daylensTools.ts'
import {
  namedUsageSubject,
  resolveUsageLookupKind,
} from '../src/main/lib/usageLookup.ts'

const DATE = '2026-07-15'
const COURSERA_SECONDS = (3 * 3600) + (43 * 60)
const COURSE_APP_SECONDS = 10 * 60
const YOUTUBE_SECONDS = 90 * 60
const GITHUB_SECONDS = 20 * 60
const SLACK_SECONDS = 60 * 60

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 6, 15, hour, minute, 0, 0).getTime()
}

function seedSession(
  db: Database.Database,
  app: { bundleId: string; appName: string; canonicalAppId: string; category: string },
  startMs: number,
  endMs: number,
): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, capture_version)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, 'test', 1)
  `).run(
    app.bundleId,
    app.appName,
    startMs,
    endMs,
    Math.round((endMs - startMs) / 1000),
    app.category,
    app.appName,
    app.canonicalAppId,
    app.bundleId,
  )
}

function seedVisit(
  db: Database.Database,
  visit: { domain: string; title: string; url: string; browserBundleId: string; canonicalBrowserId: string },
  visitMs: number,
): void {
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES (?, ?, ?, ?, ?, 30, ?, ?, 'chrome_history')
  `).run(visit.domain, visit.title, visit.url, visitMs, visitMs * 1000, visit.browserBundleId, visit.canonicalBrowserId)
}

function seedDomainDay(db: Database.Database): void {
  const dia = { bundleId: 'company.thebrowser.dia', appName: 'Dia', canonicalAppId: 'dia', category: 'browsing' }
  const course = { bundleId: 'edu.course.app', appName: 'Course', canonicalAppId: 'course', category: 'productivity' }
  const slack = { bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack', canonicalAppId: 'slack', category: 'communication' }
  const chrome = { bundleId: 'com.google.Chrome', appName: 'Google Chrome', canonicalAppId: 'chrome', category: 'browsing' }

  seedSession(db, dia, localMs(9, 0), localMs(12, 43))
  seedVisit(db, {
    domain: 'coursera.org',
    title: 'Supervised ML | Coursera',
    url: 'https://www.coursera.org/learn/ml',
    browserBundleId: dia.bundleId,
    canonicalBrowserId: 'dia',
  }, localMs(9, 0))

  seedSession(db, course, localMs(13, 0), localMs(13, 10))
  seedSession(db, slack, localMs(14, 0), localMs(15, 0))

  seedSession(db, chrome, localMs(15, 0), localMs(16, 30))
  seedVisit(db, {
    domain: 'youtube.com',
    title: 'Lecture - YouTube',
    url: 'https://www.youtube.com/watch?v=lecture',
    browserBundleId: chrome.bundleId,
    canonicalBrowserId: 'chrome',
  }, localMs(15, 0))

  seedSession(db, chrome, localMs(17, 0), localMs(17, 20))
  seedVisit(db, {
    domain: 'github.com',
    title: 'irachrist1/daylens',
    url: 'https://github.com/irachrist1/daylens',
    browserBundleId: chrome.bundleId,
    canonicalBrowserId: 'chrome',
  }, localMs(17, 0))
}

test('resolveUsageLookupKind: a website name is not a loose app match', () => {
  const apps = [
    { appName: 'Course', bundleId: 'edu.course.app', canonicalAppId: 'course' },
    { appName: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', canonicalAppId: 'slack' },
    { appName: 'Dia', bundleId: 'dia', canonicalAppId: 'dia' },
  ]
  const sites = ['coursera.org', 'youtube.com', 'github.com', 'slack.com']

  assert.equal(resolveUsageLookupKind({ lookup: 'Coursera', apps, siteDomains: sites }), 'site')
  assert.equal(resolveUsageLookupKind({ lookup: 'coursera.org', apps, siteDomains: sites }), 'site')
  assert.equal(resolveUsageLookupKind({ lookup: 'YouTube', apps, siteDomains: sites }), 'site')
  assert.equal(resolveUsageLookupKind({ lookup: 'github.com', apps, siteDomains: sites }), 'site')
  assert.equal(resolveUsageLookupKind({ lookup: 'Slack', apps, siteDomains: sites }), 'app')
  assert.equal(resolveUsageLookupKind({ lookup: 'Course', apps, siteDomains: sites }), 'app')
  assert.equal(resolveUsageLookupKind({ lookup: 'Dia', apps, siteDomains: sites }), 'app')
})

test('namedUsageSubject: domain-time wording routes to the site, app names stay apps', () => {
  const apps = ['Course', 'Slack', 'Dia', 'Google Chrome']
  const sites = ['coursera.org', 'youtube.com', 'github.com', 'slack.com']

  assert.deepEqual(
    namedUsageSubject('How much time did I spend on Coursera this week?', apps, sites),
    { kind: 'site', domain: 'coursera.org' },
  )
  assert.deepEqual(
    namedUsageSubject('How long was I on YouTube yesterday?', apps, sites),
    { kind: 'site', domain: 'youtube.com' },
  )
  assert.deepEqual(
    namedUsageSubject('How much time on github.com this week?', apps, sites),
    { kind: 'site', domain: 'github.com' },
  )
  assert.deepEqual(
    namedUsageSubject('How long was I in Slack on Tuesday?', apps, sites),
    { kind: 'app', name: 'Slack' },
  )
  assert.deepEqual(
    namedUsageSubject('How much time on slack.com this week?', apps, sites),
    { kind: 'site', domain: 'slack.com' },
  )
})

test('get_app_usage: Coursera returns website time, not the 10m Course app', async () => {
  const db = createProductionTestDatabase()
  seedDomainDay(db)
  const tools = buildDaylensTools(db)

  const coursera = await (tools.get_app_usage as any).execute(
    { appName: 'Coursera', startDate: DATE, endDate: DATE },
    {} as any,
  )
  assert.equal(coursera.fromWebsiteVisits, true)
  assert.equal(coursera.totalSeconds, COURSERA_SECONDS)
  assert.equal(coursera.appName, 'coursera.org')

  const pages = await (tools.list_page_visits as any).execute(
    { startDate: DATE, endDate: DATE, domainContains: 'coursera' },
    {} as any,
  )
  assert.equal(pages.found, true)
  const pageTotal = pages.pages.reduce((sum: number, page: { totalSeconds: number }) => sum + page.totalSeconds, 0)
  assert.equal(pageTotal, COURSERA_SECONDS, 'website lookup must match the page-visit ledger')

  const courseApp = await (tools.get_app_usage as any).execute(
    { appName: 'Course', startDate: DATE, endDate: DATE },
    {} as any,
  )
  assert.equal(courseApp.fromWebsiteVisits, undefined)
  assert.equal(courseApp.totalSeconds, COURSE_APP_SECONDS)
  db.close()
})

test('get_app_usage: YouTube and github.com are website lookups; Slack and Chrome stay apps', async () => {
  const db = createProductionTestDatabase()
  seedDomainDay(db)
  const tools = buildDaylensTools(db)

  const youtube = await (tools.get_app_usage as any).execute(
    { appName: 'YouTube', startDate: DATE, endDate: DATE },
    {} as any,
  )
  assert.equal(youtube.fromWebsiteVisits, true)
  assert.equal(youtube.totalSeconds, YOUTUBE_SECONDS)

  const github = await (tools.get_app_usage as any).execute(
    { appName: 'github.com', startDate: DATE, endDate: DATE },
    {} as any,
  )
  assert.equal(github.fromWebsiteVisits, true)
  assert.equal(github.totalSeconds, GITHUB_SECONDS)

  const slack = await (tools.get_app_usage as any).execute(
    { appName: 'Slack', startDate: DATE, endDate: DATE },
    {} as any,
  )
  assert.equal(slack.fromWebsiteVisits, undefined)
  assert.equal(slack.totalSeconds, SLACK_SECONDS)

  const chrome = await (tools.get_app_usage as any).execute(
    { appName: 'Chrome', startDate: DATE, endDate: DATE },
    {} as any,
  )
  assert.equal(chrome.fromWebsiteVisits, undefined)
  assert.equal(chrome.totalSeconds, YOUTUBE_SECONDS + GITHUB_SECONDS)
  db.close()
})
