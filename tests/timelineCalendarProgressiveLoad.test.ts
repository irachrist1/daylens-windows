// First Timeline open paints from stored activity and lets today's calendar
// arrive afterwards. The projection is a pure read; persistence invalidates
// the mounted view so events appear without a reopen. A missing or failing
// calendar cannot break the day or force a second read.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { localDateString } from '../src/main/lib/localDate.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { getExternalSignal } from '../src/main/services/externalSignals.ts'
import {
  __resetCalendarProgressiveLoadForTests,
  collectExternalSignals,
  collectTodayCalendarContext,
  type CollectExternalSignalsDeps,
} from '../src/main/services/externalSignals.ts'
import type { CalendarSignal } from '../src/shared/types.ts'

const TODAY = localDateString()
const dayStart = new Date(`${TODAY}T00:00:00`).getTime()
const at = (hour: number, minute: number) => dayStart + (hour * 60 + minute) * 60_000

const STANDUP: CalendarSignal = {
  events: [{ title: 'Standup', startClock: '10:00', durationMinutes: 30, attendeeCount: 3 }],
}

function session(db: Database.Database): void {
  db.prepare(`
    INSERT INTO app_sessions
      (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused,
       window_title, raw_app_name, capture_source, capture_version)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'notes', ?, 'test', 1)
  `).run('com.apple.Notes', 'Notes', at(9, 0), at(11, 0), 2 * 60 * 60, 'writing', 'Notes')
}

function deps(
  db: Database.Database,
  over: Partial<CollectExternalSignalsDeps> & {
    calendar?: () => Promise<CalendarSignal | null>
    invalidations?: Array<{ reason: string; date: string }>
  } = {},
): CollectExternalSignalsDeps & { calendarCalls: number; gitCalls: number } {
  const invalidations = over.invalidations ?? []
  let calendarCalls = 0
  let gitCalls = 0
  return {
    db,
    collectGit: async () => {
      gitCalls += 1
      return null
    },
    collectCalendar: async () => {
      calendarCalls += 1
      return over.calendar ? await over.calendar() : STANDUP
    },
    collectFocus: async () => null,
    enrichmentSources: {},
    isConsentCurrent: () => true,
    invalidateTimeline: (reason, date) => {
      invalidations.push({ reason, date })
    },
    ...over,
    get calendarCalls() { return calendarCalls },
    get gitCalls() { return gitCalls },
  }
}

test('first paint: Timeline reads stored activity and does not collect calendar', () => {
  __resetCalendarProgressiveLoadForTests()
  const db = createProductionTestDatabase()
  session(db)

  const payload = getTimelineDayPayload(db, TODAY, null, { materialize: false })
  assert.ok(payload.blocks.length > 0, 'core Timeline blocks render from activity')
  assert.equal(payload.scheduledMeetings, undefined, 'no calendar row yet')
  assert.equal(getExternalSignal(db, TODAY, 'calendar'), null)
  db.close()
})

test('GET_TIMELINE_DAY is a sync projection read — connectors are not a precondition', () => {
  const handlerSource = fs.readFileSync(new URL('../src/main/ipc/db.handlers.ts', import.meta.url), 'utf8')
  const start = handlerSource.indexOf('ipcMain.handle(IPC.DB.GET_TIMELINE_DAY')
  const next = handlerSource.indexOf('ipcMain.handle', start + 1)
  const handler = handlerSource.slice(start, next)
  assert.match(handler, /getTimelineDayProjection/)
  assert.doesNotMatch(handler, /collectExternalSignals|collectTodayCalendarContext|collectCalendarEvents/)
  assert.doesNotMatch(handler, /await /)
})

test('window-visible collection starts today\'s calendar before the deferred cadence', () => {
  const source = fs.readFileSync(new URL('../src/main/services/externalSignals.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export function startExternalSignalCollection')
  const stop = source.indexOf('export function stopExternalSignalCollection')
  const body = source.slice(start, stop)
  assert.match(body, /collectTodayCalendarContext\(\)/)
  assert.ok(
    body.indexOf('collectTodayCalendarContext()') < body.indexOf('2 * 60 * 1000'),
    'today\'s calendar must start before the 2-minute git/focus pass',
  )
})

test('calendar persistence invalidates Timeline so events appear without a reopen', async () => {
  __resetCalendarProgressiveLoadForTests()
  const db = createProductionTestDatabase()
  session(db)
  const invalidations: Array<{ reason: string; date: string }> = []
  const injected = deps(db, { invalidations })

  const before = getTimelineDayPayload(db, TODAY, null, { materialize: false })
  assert.equal(before.scheduledMeetings, undefined)

  const outcome = await collectTodayCalendarContext({ date: TODAY, deps: injected })
  assert.equal(outcome, 'persisted')
  assert.equal(injected.gitCalls, 0, 'prompt calendar must not wait on git')
  assert.deepEqual(invalidations, [{ reason: 'calendar-collected', date: TODAY }])

  const after = getTimelineDayPayload(db, TODAY, null, { materialize: false })
  const standup = (after.scheduledMeetings ?? []).find((meeting) => meeting.title === 'Standup')
  assert.ok(standup, 'the scheduled event is on the payload after persistence')
  db.close()
})

test('an unavailable or empty calendar leaves the Timeline working and does not invalidate', async () => {
  __resetCalendarProgressiveLoadForTests()
  const db = createProductionTestDatabase()
  session(db)

  const emptyInvalidations: Array<{ reason: string; date: string }> = []
  const empty = deps(db, { calendar: async () => ({ events: [] }), invalidations: emptyInvalidations })
  const emptyBefore = getTimelineDayPayload(db, TODAY, null, { materialize: false })
  assert.equal(await collectTodayCalendarContext({ date: TODAY, deps: empty }), 'empty')
  const emptyAfter = getTimelineDayPayload(db, TODAY, null, { materialize: false })
  assert.equal(emptyAfter.blocks.length, emptyBefore.blocks.length)
  assert.equal(emptyAfter.scheduledMeetings, undefined)
  assert.deepEqual(emptyInvalidations, [])
  assert.equal(getExternalSignal(db, TODAY, 'calendar'), null)

  __resetCalendarProgressiveLoadForTests()
  const failingInvalidations: Array<{ reason: string; date: string }> = []
  const failing = deps(db, {
    calendar: async () => { throw new Error('icalBuddy missing') },
    invalidations: failingInvalidations,
  })
  const failBefore = getTimelineDayPayload(db, TODAY, null, { materialize: false })
  assert.equal(await collectTodayCalendarContext({ date: TODAY, deps: failing }), 'failed')
  const failAfter = getTimelineDayPayload(db, TODAY, null, { materialize: false })
  assert.equal(failAfter.blocks.length, failBefore.blocks.length)
  assert.equal(failAfter.totalSeconds, failBefore.totalSeconds)
  assert.equal(failAfter.scheduledMeetings, undefined)
  assert.deepEqual(failingInvalidations, [])

  __resetCalendarProgressiveLoadForTests()
  const emptyAgain = deps(db, { calendar: async () => ({ events: [] }), invalidations: [] })
  assert.equal(await collectTodayCalendarContext({ date: TODAY, deps: emptyAgain }), 'empty')
  assert.deepEqual(await collectExternalSignals(TODAY, { deps: emptyAgain }), [])
  assert.equal(emptyAgain.calendarCalls, 1, 'an empty first-open read is not repeated by the cadence')
  db.close()
})

test('the first-open calendar read and Timeline refetch are not repeated', async () => {
  __resetCalendarProgressiveLoadForTests()
  const db = createProductionTestDatabase()
  session(db)
  const invalidations: Array<{ reason: string; date: string }> = []
  let calendarCalls = 0
  const injected = deps(db, {
    invalidations,
    calendar: async () => {
      calendarCalls += 1
      return STANDUP
    },
  })

  assert.equal(await collectTodayCalendarContext({ date: TODAY, deps: injected }), 'persisted')
  const fired = await collectExternalSignals(TODAY, { deps: injected })
  assert.equal(await collectTodayCalendarContext({ date: TODAY, deps: injected }), 'skipped')

  assert.equal(calendarCalls, 1, 'icalBuddy/Outlook runs once')
  assert.equal(invalidations.length, 1, 'Timeline refetches once when the row lands')
  assert.ok(!fired.includes('calendar'), 'the deferred collect must not persist calendar again')
  db.close()
})

test('overlapping first-open and cadence collects share one in-flight calendar read', async () => {
  __resetCalendarProgressiveLoadForTests()
  const db = createProductionTestDatabase()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calendarCalls = 0
  const invalidations: Array<{ reason: string; date: string }> = []
  const injected = deps(db, {
    invalidations,
    calendar: async () => {
      calendarCalls += 1
      await gate
      return STANDUP
    },
  })

  const first = collectTodayCalendarContext({ date: TODAY, deps: injected })
  const second = collectTodayCalendarContext({ date: TODAY, deps: injected })
  release()
  assert.deepEqual(await Promise.all([first, second]), ['persisted', 'persisted'])
  assert.equal(calendarCalls, 1)
  assert.equal(invalidations.length, 1)
  db.close()
})
