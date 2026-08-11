// Regression guard for the reconciled browser breakdown inside
// AppDetailPayload. When the selected app is a browser, `getAppDetailPayload`
// must populate `browserActivity` (domains → pages, reconciled against the
// browser's own foreground time). When the selected app is a native app, it
// must be omitted so the renderer can hide the section.
//
// Fixtures reuse the AI bench infra so the ground truth is the same as the
// rest of the harness.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture } from './ai-bench/fixtures'
import { MIN_DOMAIN_ROW_SECONDS } from '../src/shared/types'
import { foldTinyDomains, getAppDetailPayload } from '../src/main/services/appDetail'

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function daysFromFixtureThroughToday(fixtureToday: Date): number {
  const fixtureDay = new Date(localDateKey(fixtureToday)).getTime()
  const today = new Date(localDateKey(new Date())).getTime()
  return Math.max(1, Math.floor((today - fixtureDay) / 86_400_000) + 1)
}

test('browser app detail includes the reconciled domain breakdown', () => {
  const { db, today } = setupFixture('allDayChatGPT')
  // canonical id for Google Chrome in the appIdentity catalog is "chrome".
  const detail = getAppDetailPayload(db, 'chrome', daysFromFixtureThroughToday(today), null)
  assert.ok(detail.browserActivity, 'browserActivity must be present for a browser app')
  const domains = detail.browserActivity?.domains ?? []
  const domainNames = domains.map((d) => d.domain)
  assert.ok(domainNames.includes('chatgpt.com'), `expected chatgpt.com in ${JSON.stringify(domainNames)}`)
  assert.ok(domainNames.includes('claude.ai'), `expected claude.ai in ${JSON.stringify(domainNames)}`)
  const chatgpt = domains.find((d) => d.domain === 'chatgpt.com')
  assert.ok(chatgpt && chatgpt.totalSeconds > 0, 'chatgpt.com should have a non-zero total')
  db.close()
})

test('browser breakdown reconciles: pages sum to their domain, domains + remainder sum to the header', () => {
  const { db, today } = setupFixture('allDayChatGPT')
  const detail = getAppDetailPayload(db, 'chrome', daysFromFixtureThroughToday(today), null)
  const activity = detail.browserActivity
  assert.ok(activity)
  for (const domain of activity.domains) {
    const pageSum = domain.pages.reduce((sum, page) => sum + page.totalSeconds, 0)
    assert.equal(pageSum, domain.totalSeconds, `pages of ${domain.domain} must sum to the domain total`)
  }
  const domainSum = activity.domains.reduce((sum, domain) => sum + domain.totalSeconds, 0)
    + (activity.everythingElse?.totalSeconds ?? 0)
  assert.equal(domainSum, activity.attributedSeconds, 'domain rows plus the everything-else fold must sum to attributedSeconds')
  assert.ok(activity.attributedSeconds <= activity.totalSeconds, 'attributed time can never exceed the header total')
  assert.equal(
    activity.attributedSeconds + activity.unattributedSeconds,
    activity.totalSeconds,
    'attributed + "No page recorded" must equal the header total exactly',
  )
  assert.equal(activity.totalSeconds, detail.totalSeconds, 'the breakdown must anchor on the same header total the view shows')
  db.close()
})

test('native app detail omits the browser breakdown', () => {
  const { db, today } = setupFixture('codingDay')
  const detail = getAppDetailPayload(db, 'cursor', daysFromFixtureThroughToday(today), null)
  assert.equal(detail.browserActivity, undefined, 'non-browser apps must not carry browserActivity')
  db.close()
})

// DEV-239: drive-by domains (1-2 second visits) never earn their own rows —
// they fold into one "Everything else" line whose seconds stay reconciled.
test('domains under the minimum-row threshold fold into everything else', () => {
  const domain = (name: string, totalSeconds: number, visitCount: number) => ({
    domain: name,
    totalSeconds,
    visitCount,
    pages: [],
  })
  const folded = foldTinyDomains([
    domain('github.com', 3600, 12),
    domain('claude.ai', 900, 4),
    domain('redirect-hop.example', 2, 1),
    domain('cdn-interstitial.example', 1, 2),
  ])
  assert.deepEqual(folded.rows.map((row) => row.domain), ['github.com', 'claude.ai'])
  assert.deepEqual(folded.everythingElse, { totalSeconds: 3, domainCount: 2, visitCount: 3 })

  // Nothing to fold: no everything-else line at all.
  const untouched = foldTinyDomains([domain('github.com', 3600, 12)])
  assert.deepEqual(untouched.rows.map((row) => row.domain), ['github.com'])
  assert.equal(untouched.everythingElse, undefined)

  // The threshold boundary belongs to the visible rows.
  const boundary = foldTinyDomains([domain('exactly.example', MIN_DOMAIN_ROW_SECONDS, 1)])
  assert.equal(boundary.rows.length, 1)
  assert.equal(boundary.everythingElse, undefined)
})

test('every rendered domain row meets the minimum-row threshold', () => {
  const { db, today } = setupFixture('allDayChatGPT')
  const detail = getAppDetailPayload(db, 'chrome', daysFromFixtureThroughToday(today), null)
  for (const domain of detail.browserActivity?.domains ?? []) {
    assert.ok(
      domain.totalSeconds >= MIN_DOMAIN_ROW_SECONDS,
      `${domain.domain} (${domain.totalSeconds}s) is under the minimum-row threshold and must fold`,
    )
  }
  db.close()
})

test('domain rollup is ordered by duration desc', () => {
  const { db, today } = setupFixture('allDayChatGPT')
  const detail = getAppDetailPayload(db, 'chrome', daysFromFixtureThroughToday(today), null)
  const domains = detail.browserActivity?.domains ?? []
  for (let i = 1; i < domains.length; i++) {
    assert.ok(
      domains[i - 1].totalSeconds >= domains[i].totalSeconds,
      `domains must be sorted by duration desc, but ${domains[i - 1].domain} (${domains[i - 1].totalSeconds}s) < ${domains[i].domain} (${domains[i].totalSeconds}s)`,
    )
  }
  db.close()
})
