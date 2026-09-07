// The day view shows the day's clarifying questions on first paint. Detecting
// them needs the day's payload and nothing else, so it asks for them with the
// payload instead of triggering a second projection to reach the same answer.
// On a real profile that second build cost 329-675ms of blocked main thread,
// while the detection itself cost 0-18ms of it.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import { ipcRecord } from './support/electron-stub.mjs'
import { registerDbHandlers } from '../src/main/ipc/db.handlers.ts'
import { detectDayClarifications } from '../src/main/services/dayClarifications.ts'
import { getTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { IPC, type DayTimelinePayload } from '../src/shared/types.ts'
import { localDateString } from '../src/main/lib/localDate.ts'

const DAY = localDateString(new Date(2026, 3, 22))
const dayStart = new Date(2026, 3, 22, 0, 0, 0, 0).getTime()
const at = (hour: number, minute = 0): number => dayStart + (hour * 60 + minute) * 60_000

function seedDay(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT INTO app_sessions
      (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused,
       window_title, raw_app_name, capture_source, capture_version)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'test', 1)
  `)
  insert.run('com.microsoft.VSCode', 'Code', at(9), at(10, 30), 90 * 60, 'development', 'checkout.ts', 'Code')
  insert.run('com.tinyspeck.slackmacgap', 'Slack', at(11), at(11, 40), 40 * 60, 'communication', 'acme', 'Slack')
}

async function invokeTimelineDay(
  options?: { withClarifications?: boolean },
): Promise<DayTimelinePayload> {
  const handler = ipcRecord.handlers.get(IPC.DB.GET_TIMELINE_DAY)
  assert.ok(handler, 'the timeline-day handler must be registered')
  return await handler({}, DAY, options) as DayTimelinePayload
}

test('the day payload carries its clarifications when the caller asks for them', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  ipcRecord.reset()
  try {
    seedDay(db)
    registerDbHandlers()

    const withThem = await invokeTimelineDay({ withClarifications: true })
    assert.ok(Array.isArray(withThem.clarifications), 'the payload must carry the list, even when empty')

    // Same answer the standalone detector gives over the same day — asking for
    // them with the payload must not change what is asked.
    const standalone = detectDayClarifications(
      db,
      getTimelineDayProjection(db, DAY, null, { materialize: false, analysis: false }),
    )
    assert.deepEqual(
      withThem.clarifications?.map((item) => item.id),
      standalone.map((item) => item.id),
    )
  } finally {
    clearTestDb()
    db.close()
  }
})

test('a caller that does not ask pays nothing and gets no field', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  ipcRecord.reset()
  try {
    seedDay(db)
    registerDbHandlers()

    // The week and month views read the same channel and never show questions.
    const plain = await invokeTimelineDay()
    assert.equal(plain.clarifications, undefined)
    assert.equal((await invokeTimelineDay({})).clarifications, undefined)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('the standalone clarifications channel still answers on its own', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  ipcRecord.reset()
  try {
    seedDay(db)
    registerDbHandlers()

    // The day refetches through this channel after an answer, so removing it
    // from first paint must not remove it.
    const handler = ipcRecord.handlers.get(IPC.DB.GET_DAY_CLARIFICATIONS)
    assert.ok(handler, 'the standalone channel must stay registered')
    const standalone = await handler({}, DAY)
    const carried = (await invokeTimelineDay({ withClarifications: true })).clarifications
    assert.deepEqual(
      (standalone as Array<{ id: string }>).map((item) => item.id),
      carried?.map((item) => item.id),
    )
  } finally {
    clearTestDb()
    db.close()
  }
})
