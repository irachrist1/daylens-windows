// DEV-202: Wrapped rides the shared corrected facts.
//
// Every number a wrap shows comes from the same corrected activity-fact seam
// Timeline and Apps read (getTimelineDayPayload → the corrected session
// query), so:
//   - day wrap facts, the Timeline payload, and the Apps totals reconcile
//     exactly for the same day, before AND after a correction;
//   - the wrap tools (window-title context, distraction profile) honor the
//     deletion/exclusion ledger — a deleted block's titles or an excluded
//     site can never resurface inside a wrap;
//   - a correction drops the day's frozen snapshot, so week/month/year wraps
//     refreeze from the corrected facts instead of serving stale totals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import {
  getTimelineDayPayload,
  invalidateTimelineDayBlocks,
  writeIgnoredBlockReviewBackstop,
  writeTimelineBlockReview,
} from '../src/main/services/workBlocks.ts'
import { getAppSummariesForTimelineDay } from '../src/main/services/appsFacts.ts'
import { getDistractionProfile, getWindowTitleContext } from '../src/main/services/wrappedTools.ts'
import { buildWrappedPeriodFacts } from '../src/main/services/wrappedPeriodNarrative.ts'
import { buildDayWrapFacts } from '../src/renderer/lib/dayWrapScenes.ts'
import { planDayWrapSlides } from '../src/renderer/lib/wrapDeck.ts'
import { buildDaySnapshot } from '../src/main/lib/daySnapshot.ts'
import { getDaySnapshotRow, upsertDaySnapshot } from '../src/main/db/queries.ts'

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function localMsOnDate(dateStr: string, hour: number, minute = 0): number {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function insertFocusEvent(
  db: Database.Database,
  tsMs: number,
  eventType: string,
  bundleId: string,
  appName: string,
  windowTitle: string | null = null,
): void {
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, ?, ?, ?, 4242, ?, NULL, NULL, 'foreground_poll', 'observed', 'darwin', 2)
  `).run(tsMs, tsMs * 1_000_000, eventType, bundleId, appName, windowTitle)
}

function seedCanonicalStretch(
  db: Database.Database,
  bundleId: string,
  appName: string,
  startMs: number,
  endMs: number,
  windowTitle = 'Work',
): void {
  insertFocusEvent(db, startMs, 'app_activated', bundleId, appName, windowTitle)
  insertFocusEvent(db, endMs, 'app_deactivated', bundleId, appName, windowTitle)
}

function insertLegacySession(
  db: Database.Database,
  bundleId: string,
  appName: string,
  startMs: number,
  endMs: number,
  category = 'development',
  windowTitle: string | null = 'Work',
): void {
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 1)
  `).run(bundleId, appName, startMs, endMs, Math.round((endMs - startMs) / 1000), category, windowTitle, appName, bundleId.toLowerCase())
}

function seedYoutubeVisit(db: Database.Database, browserBundle: string, visitMs: number): void {
  db.prepare(`
    INSERT INTO website_visits (domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, source)
    VALUES ('youtube.com', 'Some Video', 'https://www.youtube.com/watch?v=x', ?, ?, 30, ?, 'chrome', 'chrome_history')
  `).run(visitMs, visitMs * 1000, browserBundle)
}

function ignoreSpan(db: Database.Database, startMs: number, endMs: number): void {
  const blockId = `ignored_${randomUUID().slice(0, 8)}`
  writeIgnoredBlockReviewBackstop(db, {
    date: TEST_DATE,
    blockId,
    evidenceKey: blockId,
    originalBlockJson: JSON.stringify({ startTime: startMs, endTime: endMs }),
  })
}

function appsTotal(db: Database.Database): number {
  return getAppSummariesForTimelineDay(db, TEST_DATE, null)
    .reduce((sum, row) => sum + row.totalSeconds, 0)
}

// ─── One total across the wrap, Timeline, and Apps ────────────────────────────

test('day wrap facts, the Timeline payload, and Apps report one reconciling total', () => {
  const db = createProductionTestDatabase()
  seedCanonicalStretch(db, 'com.mitchellh.ghostty', 'Ghostty', localMs(9), localMs(10, 45))
  seedCanonicalStretch(db, 'com.apple.Safari', 'Safari', localMs(11), localMs(11, 40))
  seedCanonicalStretch(db, 'com.tinyspeck.slackmacgap', 'Slack', localMs(14), localMs(14, 25))

  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const facts = buildDayWrapFacts(payload)
  assert.ok(facts.activeSeconds > 0)
  assert.equal(facts.activeSeconds, payload.totalSeconds, 'wrap headline equals the Timeline total')
  assert.equal(facts.activeSeconds, appsTotal(db), 'wrap headline equals the Apps total')
  assert.equal(
    facts.workSeconds + facts.leisureSeconds + facts.personalSeconds,
    facts.activeSeconds,
    'the split reconciles to the headline',
  )
  db.close()
})

test('a deleted Timeline block changes the wrap facts, Timeline, and Apps identically', () => {
  const db = createProductionTestDatabase()
  seedCanonicalStretch(db, 'com.mitchellh.ghostty', 'Ghostty', localMs(9), localMs(10, 45))
  seedCanonicalStretch(db, 'com.apple.Safari', 'Safari', localMs(11), localMs(11, 40))

  const before = buildDayWrapFacts(getTimelineDayPayload(db, TEST_DATE, null, { materialize: false }))
  ignoreSpan(db, localMs(11), localMs(11, 40))

  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const after = buildDayWrapFacts(payload)
  assert.ok(after.activeSeconds < before.activeSeconds, 'the deleted stretch left the wrap')
  assert.equal(after.activeSeconds, payload.totalSeconds, 'wrap and Timeline still reconcile')
  assert.equal(after.activeSeconds, appsTotal(db), 'wrap and Apps still reconcile')
  db.close()
})

// ─── Wrap tools honor the correction ledger ───────────────────────────────────

test('window-title context never resurfaces a deleted block\'s titles', () => {
  const db = createProductionTestDatabase()
  insertLegacySession(db, 'com.figma.Desktop', 'Figma', localMs(9), localMs(10), 'design', 'Homepage redesign v3')
  insertLegacySession(db, 'com.figma.Desktop', 'Figma', localMs(15), localMs(16), 'design', 'Homepage redesign v3')

  const before = getWindowTitleContext({ date: TEST_DATE, appName: 'Figma' }, db)
  assert.ok(before, 'titled sessions cluster before the deletion')

  // Delete both stretches: the tool must stop reporting the titles entirely.
  ignoreSpan(db, localMs(9), localMs(10))
  ignoreSpan(db, localMs(15), localMs(16))
  const after = getWindowTitleContext({ date: TEST_DATE, appName: 'Figma' }, db)
  assert.equal(after, null, 'titles inside deleted spans never resurface in a wrap tool')
  db.close()
})

test('window-title context honors reversible evidence exclusions', () => {
  const db = createProductionTestDatabase()
  insertLegacySession(db, 'com.figma.Desktop', 'Figma', localMs(9), localMs(10), 'design', 'Homepage redesign v3')

  db.prepare(`
    INSERT INTO evidence_exclusions (id, date, kind, bundle_id, app_name, domain, span_start_ms, span_end_ms, created_at)
    VALUES ('excl_wrap_test', ?, 'app', 'com.figma.Desktop', 'Figma', NULL, ?, ?, ?)
  `).run(TEST_DATE, localMs(9), localMs(10), Date.now())

  const result = getWindowTitleContext({ date: TEST_DATE, appName: 'Figma' }, db)
  assert.equal(result, null, 'an excluded app\'s titles never reach a wrap tool')
  db.close()
})

test('distraction profile counts only corrected leisure intervals — an excluded site vanishes', () => {
  const db = createProductionTestDatabase()
  insertLegacySession(db, 'com.google.Chrome', 'Chrome', localMs(20), localMs(21), 'entertainment', null)
  seedYoutubeVisit(db, 'com.google.Chrome', localMs(20))

  const before = getDistractionProfile({ date: TEST_DATE }, db)
  assert.ok(before, 'a leisure evening produces a profile')
  assert.ok(before!.sites.some((s) => s.name.toLowerCase().includes('youtube')), 'YouTube counted before the exclusion')

  db.prepare(`
    INSERT INTO evidence_exclusions (id, date, kind, bundle_id, app_name, domain, span_start_ms, span_end_ms, created_at)
    VALUES ('excl_site_test', ?, 'site', NULL, NULL, 'youtube.com', ?, ?, ?)
  `).run(TEST_DATE, localMs(20), localMs(21), Date.now())

  const after = getDistractionProfile({ date: TEST_DATE }, db)
  if (after) {
    assert.ok(!after.sites.some((s) => s.name.toLowerCase().includes('youtube')), 'an excluded site never appears in a wrap tool')
  }
  db.close()
})

// ─── Corrections invalidate the frozen day snapshot (period wraps) ────────────

test('a correction drops the frozen day snapshot so period wraps refreeze from corrected facts', () => {
  const db = createProductionTestDatabase()
  seedCanonicalStretch(db, 'com.mitchellh.ghostty', 'Ghostty', localMs(9), localMs(10, 45))
  seedCanonicalStretch(db, 'com.apple.Safari', 'Safari', localMs(11), localMs(11, 40))

  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const frozen = { ...buildDaySnapshot(payload), finalizedAt: Date.now() }
  upsertDaySnapshot(db, frozen)
  assert.ok(getDaySnapshotRow(db, TEST_DATE), 'the day froze')

  // A review-ledger correction (delete a block) drops the frozen row.
  const block = payload.blocks.find((b) => b.startTime >= localMs(11))
  assert.ok(block, 'the Safari block exists')
  writeTimelineBlockReview(db, TEST_DATE, block!, { state: 'ignored' })
  assert.equal(getDaySnapshotRow(db, TEST_DATE), null, 'the stale frozen snapshot is gone')

  // Refreeze from the corrected facts: the totals now match the corrected day.
  const corrected = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const refrozen = { ...buildDaySnapshot(corrected), finalizedAt: Date.now() }
  upsertDaySnapshot(db, refrozen)
  assert.ok(refrozen.totalActiveSeconds < frozen.totalActiveSeconds, 'the refrozen snapshot reflects the deletion')

  // An evidence purge / journal replay path invalidates the same way.
  invalidateTimelineDayBlocks(db, TEST_DATE)
  assert.equal(getDaySnapshotRow(db, TEST_DATE), null, 'purge invalidation drops the snapshot too')
  db.close()
})

// ─── Week / month / year totals reconcile with Timeline, before and after ────

test('week, month, and year wrap totals reconcile exactly with the Timeline day totals — and a correction changes them after regeneration', () => {
  const db = createProductionTestDatabase()
  // Three active days inside one rolling week (the week window ends on its anchor).
  const days = ['2026-04-21', '2026-04-22', '2026-04-23']
  seedCanonicalStretch(db, 'com.mitchellh.ghostty', 'Ghostty', localMsOnDate(days[0], 9), localMsOnDate(days[0], 10, 30))
  seedCanonicalStretch(db, 'com.mitchellh.ghostty', 'Ghostty', localMsOnDate(days[1], 9), localMsOnDate(days[1], 11))
  seedCanonicalStretch(db, 'com.apple.Safari', 'Safari', localMsOnDate(days[1], 13), localMsOnDate(days[1], 13, 40))
  seedCanonicalStretch(db, 'com.tinyspeck.slackmacgap', 'Slack', localMsOnDate(days[2], 15), localMsOnDate(days[2], 15, 45))

  // The period facts service reads through the app database handle.
  setTestDb(db)
  try {
    const timelineSum = () => days.reduce(
      (sum, d) => sum + getTimelineDayPayload(db, d, null, { materialize: false }).totalSeconds, 0,
    )
    const appsSum = () => days.reduce(
      (sum, d) => sum + getAppSummariesForTimelineDay(db, d, null).reduce((s, row) => s + row.totalSeconds, 0), 0,
    )

    const expected = timelineSum()
    assert.ok(expected > 0)
    assert.equal(appsSum(), expected, 'Apps and Timeline agree on the seeded days')
    for (const period of ['week', 'month', 'year'] as const) {
      const facts = buildWrappedPeriodFacts(period, '2026-04-23')
      assert.equal(facts.totalSeconds, expected, `${period} wrap total reconciles exactly with Timeline and Apps`)
    }

    // Delete a block on one day (the production purge sequence: the ignored
    // backstop plus the day invalidation): the regenerated period facts must
    // reconcile with the corrected Timeline — not keep serving the frozen
    // pre-correction totals (the frozen snapshot drops on the correction write).
    const blockId = `ignored_${randomUUID().slice(0, 8)}`
    writeIgnoredBlockReviewBackstop(db, {
      date: days[1],
      blockId,
      evidenceKey: blockId,
      originalBlockJson: JSON.stringify({ startTime: localMsOnDate(days[1], 13), endTime: localMsOnDate(days[1], 13, 40) }),
    })
    invalidateTimelineDayBlocks(db, days[1])
    const corrected = timelineSum()
    assert.ok(corrected < expected, 'the deleted stretch left the Timeline')
    assert.equal(appsSum(), corrected, 'Apps still reconciles after the correction')
    for (const period of ['week', 'month', 'year'] as const) {
      const facts = buildWrappedPeriodFacts(period, '2026-04-23')
      assert.equal(facts.totalSeconds, corrected, `${period} wrap total reflects the correction exactly`)
    }
  } finally {
    clearTestDb()
  }
  db.close()
})

// ─── The visible deck is unchanged in this slice ──────────────────────────────

test('the visible deck plan renders unchanged for a fixture day', () => {
  const db = createProductionTestDatabase()
  seedCanonicalStretch(db, 'com.mitchellh.ghostty', 'Ghostty', localMs(9), localMs(10, 45), 'Auth refactor')
  seedCanonicalStretch(db, 'com.apple.Safari', 'Safari', localMs(11), localMs(11, 40), 'Docs')
  seedCanonicalStretch(db, 'com.tinyspeck.slackmacgap', 'Slack', localMs(14), localMs(14, 25), 'Team')

  const facts = buildDayWrapFacts(getTimelineDayPayload(db, TEST_DATE, null, { materialize: false }))
  const slides = planDayWrapSlides(facts, { browser: false, connectors: null })
  // The pinned deck shape for this fixture day: moving the facts onto the
  // shared corrected seam changes NUMBERS' provenance, never the deck.
  // (The 'away' slide is the honest 11:40am-2pm hole between the fixture's
  // stretches — gaps are facts, so the deck states it; the seeded shuffle
  // also reordered the middle when the new slide joined the pool.)
  assert.deepEqual(slides.map((s) => ({ id: s.id, kind: s.kind })), [
    { id: 'opening', kind: 'opening' },
    { id: 'headline', kind: 'stat' },
    { id: 'coverage', kind: 'coverage' },
    { id: 'story-morning', kind: 'text' },
    { id: 'story-midday', kind: 'text' },
    { id: 'wildcard', kind: 'stat' },
    { id: 'apps', kind: 'bars' },
    { id: 'focus', kind: 'stat' },
    { id: 'timesink', kind: 'stat' },
    { id: 'away', kind: 'stat' },
    { id: 'question', kind: 'question' },
    { id: 'reflection', kind: 'reflection' },
    { id: 'finale', kind: 'finale' },
  ])
  db.close()
})

test('the ignored-review backstop (block purge, journal replay) also drops the frozen snapshot', () => {
  const db = createProductionTestDatabase()
  seedCanonicalStretch(db, 'com.mitchellh.ghostty', 'Ghostty', localMs(9), localMs(10))

  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  upsertDaySnapshot(db, { ...buildDaySnapshot(payload), finalizedAt: Date.now() })
  assert.ok(getDaySnapshotRow(db, TEST_DATE))

  ignoreSpan(db, localMs(9), localMs(10))
  assert.equal(getDaySnapshotRow(db, TEST_DATE), null)
  db.close()
})
