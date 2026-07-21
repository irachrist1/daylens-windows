import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCaptureEventsDayFixture, loadDayFixture } from './support/dayFixture.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { __resetSettings } from './support/settings-stub.mjs'
import { driveCaptureDay, fixtureClockMs } from './support/captureDay.ts'
import { findDatabaseTextMatches } from './support/dayFixturePrivacy.ts'
import { projectDay } from '../src/main/core/projections/chunk2.ts'
import { writeTimelineBlockReview } from '../src/main/services/workBlocks.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { searchAll } from '../src/main/db/queries.ts'
import { getCorrectedAppSummariesForRange } from '../src/main/services/activityFacts.ts'
import { ensureDayMemoryIndexed } from '../src/main/services/memoryIndex.ts'
import { addWorkMemoryFact, chatMemoryPromptBlock } from '../src/main/services/workMemoryProfile.ts'
import { buildDaylensTools } from '../src/main/agent/daylensTools.ts'
import { collectExternalSignals, getExternalSignal } from '../src/main/services/externalSignals.ts'
import { syncNowForQuit } from '../src/main/services/syncUploader.ts'
import { executeTool } from '../src/main/services/aiTools.ts'
import type { CalendarSignal } from '../src/shared/types.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = loadDayFixture(
  path.join(HERE, 'timeline-eval', 'fixtures', 'reference-workday.json'),
)
if (!isCaptureEventsDayFixture(fixture)) {
  throw new Error('reference-workday must use capture-events input')
}
const calendar = fixture.context?.calendar
if (!calendar) throw new Error('reference-workday must include calendar context')

test('synthetic day agrees from source boundaries through every local fact surface', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)

  try {
    const { rejectedFocusEvents } = await driveCaptureDay(db, fixture)

    const projection = projectDay(db, fixture.date, {
      finalize: true,
      now: new Date(fixtureClockMs(fixture, '23:59')),
    })
    assert.equal(projection.skipped, false)
    assert.ok(
      projection.sessions >= 3,
      `expected at least 3 canonical sessions, got ${projection.sessions}`,
    )
    assert.equal(
      rejectedFocusEvents,
      2,
      'excluded and incognito helper events must be rejected before storage',
    )

    const external = await collectExternalSignals(fixture.date, {
      force: true,
      deps: {
        db,
        collectGit: async () => null,
        collectCalendar: async () => calendar,
        collectFocus: async () => null,
        enrichmentSources: {},
        isConsentCurrent: () => true,
      },
    })
    assert.deepEqual(external, ['calendar'])
    assert.deepEqual(
      getExternalSignal<CalendarSignal>(db, fixture.date, 'calendar')?.payload,
      calendar,
    )

    for (const fact of fixture.context?.memoryFacts ?? []) addWorkMemoryFact(db, fact)
    assert.match(chatMemoryPromptBlock(db, 'What should I know about Acme?'), /Atlas project/)

    const fromMs = fixtureClockMs(fixture, '00:00')
    const toMs = fromMs + 86_400_000
    const timeline = materializeTimelineDayProjection(db, fixture.date, null)
    const apps = getCorrectedAppSummariesForRange(db, fromMs, toMs)
    const appNames = apps.map((app) => app.appName)
    assert.ok(appNames.includes('Visual Studio Code'), `missing captured editor in ${appNames.join(', ')}`)
    assert.ok(appNames.includes('Google Chrome'), `missing Google Chrome in ${appNames.join(', ')}`)
    assert.ok(
      apps.some((app) => app.category === 'meetings'),
      `missing captured meeting app in ${appNames.join(', ')}`,
    )
    assert.ok(
      !appNames.some((name) => /SecretApp/i.test(name)),
      `excluded app leaked into Apps: ${appNames.join(', ')}`,
    )
    assert.ok(
      !timeline.blocks.some((block) =>
        /Private customer|Excluded customer/i.test(block.label.current),
      ),
      'private or excluded label leaked into Timeline',
    )

    for (const term of fixture.expected?.privacy?.prohibitedTerms ?? []) {
      assert.deepEqual(
        findDatabaseTextMatches(db, term),
        [],
        `${term} leaked into a database surface`,
      )
    }

    // Session moments are served from the memory-index projection of corrected
    // canonical facts (legacy app_sessions writes are retired).
    ensureDayMemoryIndexed(db, fixture.date)
    const search = searchAll(db, 'Acme', {
      startDate: fixture.date,
      endDate: fixture.date,
      limit: 20,
    })
    assert.ok(
      search.some((row) => row.type === 'session'),
      `Acme session missing from search: ${JSON.stringify(search)}`,
    )
    assert.equal(
      searchAll(db, 'Private customer', {
        startDate: fixture.date,
        endDate: fixture.date,
        limit: 20,
      }).length,
      0,
    )

    const tools = buildDaylensTools(db)
    const overview = await (
      tools.get_day_overview as { execute: (input: unknown, options: unknown) => Promise<unknown> }
    ).execute({ date: fixture.date }, {})
    assert.match(JSON.stringify(overview), /Acme/)
    assert.doesNotMatch(JSON.stringify(overview), /SecretApp|Private customer|excluded\.example/i)
    const mcp = executeTool('getDaySummary', { date: fixture.date }, db)
    assert.doesNotMatch(JSON.stringify(mcp), /SecretApp|Private customer|excluded\.example/i)
    for (const term of fixture.expected?.privacy?.prohibitedTerms ?? []) {
      assert.ok(
        !chatMemoryPromptBlock(db, term).toLowerCase().includes(term.toLowerCase()),
        `${term} leaked into memory`,
      )
    }

    const firstBlock = timeline.blocks[0]
    assert.ok(firstBlock, 'synthetic Timeline produced no blocks')
    writeTimelineBlockReview(db, fixture.date, firstBlock, {
      state: 'corrected',
      correctedLabel: 'Acme launch planning',
      correctedIntentRole: 'execution',
      correctedIntentSubject: 'Acme launch',
    })
    const corrected = materializeTimelineDayProjection(db, fixture.date, null)
    assert.ok(
      corrected.blocks.some((block) => block.label.current === 'Acme launch planning'),
      'corrected label did not survive Timeline rebuild',
    )

    const beforeOfflineSync = db.totalChanges
    await syncNowForQuit()
    assert.equal(
      db.totalChanges,
      beforeOfflineSync,
      'the accepted offline sync boundary must not mutate or upload local facts',
    )
  } finally {
    __resetSettings()
    clearTestDb()
    db.close()
  }
})
