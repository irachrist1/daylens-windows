import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  buildAppDetailAccount,
  extractDisplayProse,
  looksLikeStructuredDump,
  resolveAppDetailAccount,
  visibleAppDetailCopy,
} from '../src/shared/appDetailAccount.ts'
import {
  isThinAppNarrative,
  parseSurfaceSummaryResult,
  selectVisibleAppNarrative,
  THIN_APP_NARRATIVE_SUMMARY,
} from '../src/shared/appNarrativeContract.ts'
import { getAppDetailPayload } from '../src/main/services/appDetail.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'

function todayKey(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localMs(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  values: {
    bundleId: string
    appName: string
    start: number
    seconds: number
    category: string
    windowTitle: string
    canonicalAppId: string
  },
): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 2)
  `).run(
    values.bundleId,
    values.appName,
    values.start,
    values.start + values.seconds * 1000,
    values.seconds,
    values.category,
    values.windowTitle,
    values.appName,
    values.canonicalAppId,
  )
}

test('structured dumps are not display-worthy and extract an inner title when present', () => {
  const notionJson = '{"id":"abc","title":"Q3 planning","type":"page"}'
  assert.equal(looksLikeStructuredDump(notionJson), true)
  assert.equal(extractDisplayProse(notionJson, 'Notion'), 'Q3 planning')
  assert.equal(extractDisplayProse('{"foo":1,"bar":2}', 'Notion'), null)
  assert.equal(extractDisplayProse('[object Object]', 'Safari'), null)
  assert.equal(extractDisplayProse('Safari', 'Safari'), null)
  assert.equal(extractDisplayProse('DEV-89 pull request', 'Safari'), 'DEV-89 pull request')
})

test('account names only evidence-backed subjects and stays silent without them', () => {
  assert.equal(buildAppDetailAccount([]), null)
  assert.equal(buildAppDetailAccount(['GitHub']), 'Most of this time was on GitHub.')
})

test('Generate parse never returns raw JSON as the on-screen summary', () => {
  const jsonBlob = '{"title":"Notion","summary":"{\\"type\\":\\"page\\"}"}'
  assert.equal(parseSurfaceSummaryResult(jsonBlob, 'Notion'), null)

  const wrapped = '```json\n{"title":"Cursor","summary":"You edited appDetail.ts and workBlocks.ts."}\n```'
  const parsed = parseSurfaceSummaryResult(wrapped, 'Cursor')
  assert.ok(parsed)
  assert.equal(parsed.summary, 'You edited appDetail.ts and workBlocks.ts.')
  assert.equal(looksLikeStructuredDump(parsed.summary), false)

  const bareJson = '{"unfinished": true'
  assert.equal(parseSurfaceSummaryResult(bareJson, 'Safari'), null)

  const prose = 'You reviewed the ACME report in Notion.'
  assert.deepEqual(parseSurfaceSummaryResult(prose, 'Notion'), {
    title: 'Notion',
    summary: prose,
  })
})

test('Generate path keeps grounded prose and drops invented or thin text', () => {
  const evidence = ['appDetail.ts', 'github.com']
  assert.equal(
    selectVisibleAppNarrative('You edited appDetail.ts while checking github.com.', evidence),
    'You edited appDetail.ts while checking github.com.',
  )
  assert.equal(
    selectVisibleAppNarrative('You mostly worked between 10 and 11 inventing a meeting with ACME.', evidence),
    null,
  )
  assert.equal(selectVisibleAppNarrative(THIN_APP_NARRATIVE_SUMMARY, evidence), null)
  assert.equal(isThinAppNarrative(THIN_APP_NARRATIVE_SUMMARY), true)
  assert.equal(selectVisibleAppNarrative('{"title":"x","summary":"y"}', evidence), null)
})

test('Safari with tracked time and no pages still has a breakdown, not an empty section', () => {
  const db = createProductionTestDatabase()
  const date = todayKey()
  const start = localMs(date, 9)
  insertSession(db, {
    bundleId: 'com.apple.Safari',
    appName: 'Safari',
    start,
    seconds: 19 * 60,
    category: 'browsing',
    windowTitle: 'Safari',
    canonicalAppId: 'safari',
  })

  const detail = getAppDetailPayload(db, 'safari', 1, null)
  const visible = visibleAppDetailCopy(detail)
  assert.equal(detail.totalSeconds, 19 * 60)
  assert.ok(detail.activityBreakdown, 'tracked Safari time must carry an activity breakdown')
  assert.equal(detail.activityBreakdown?.unattributedSeconds, 19 * 60)
  assert.equal(visible.showSection, true)
  assert.equal(visible.account, null)
  assert.ok(visible.labels.every((label) => !looksLikeStructuredDump(label)))
  db.close()
})

test('Notion JSON window titles never reach the visible account or breakdown labels', () => {
  const db = createProductionTestDatabase()
  const date = todayKey()
  const start = localMs(date, 10)
  insertSession(db, {
    bundleId: 'notion.id',
    appName: 'Notion',
    start,
    seconds: 40 * 60,
    category: 'productivity',
    windowTitle: '{"id":"blk","title":"Hiring plan","spaceId":"1"}',
    canonicalAppId: 'notion',
  })
  insertSession(db, {
    bundleId: 'notion.id',
    appName: 'Notion',
    start: start + 40 * 60_000,
    seconds: 10 * 60,
    category: 'productivity',
    windowTitle: '{"foo":true,"bar":[]}',
    canonicalAppId: 'notion',
  })

  const detail = getAppDetailPayload(db, 'notion', 1, null)
  const visible = visibleAppDetailCopy(detail, '{"title":"Notion","summary":{"raw":true}}')
  assert.ok(detail.activityBreakdown)
  assert.equal(visible.account, 'Most of this time was on Hiring plan.')
  assert.ok(detail.activityBreakdown?.groups.some((group) => (
    group.items.some((item) => item.displayTitle === 'Hiring plan')
  )))
  for (const label of visible.labels) {
    assert.equal(looksLikeStructuredDump(label), false, `JSON leaked onto screen: ${label}`)
  }
  assert.equal(resolveAppDetailAccount(detail, '{"oops":true}'), 'Most of this time was on Hiring plan.')
  db.close()
})

test('native apps get the same expandable breakdown shape as browsers', () => {
  const db = createProductionTestDatabase()
  const date = todayKey()
  const start = localMs(date, 11)
  insertSession(db, {
    bundleId: 'com.todesktop.230313mzl4w4u92',
    appName: 'Cursor',
    start,
    seconds: 25 * 60,
    category: 'development',
    windowTitle: 'src/main/services/appDetail.ts — daylens',
    canonicalAppId: 'cursor',
  })

  const detail = getAppDetailPayload(db, 'cursor', 1, null)
  assert.ok(detail.activityBreakdown)
  assert.ok(detail.activityBreakdown.groups.length > 0)
  assert.ok(detail.activityBreakdown.groups[0].items.length > 0)
  assert.equal(detail.activityBreakdown.groups[0].kind === 'domain'
    || detail.activityBreakdown.groups[0].kind === 'folder'
    || detail.activityBreakdown.groups[0].kind === 'collection', true)
  const visible = visibleAppDetailCopy(detail)
  assert.equal(visible.showSection, true)
  assert.ok(visible.account?.includes('appDetail.ts'))
  db.close()
})
