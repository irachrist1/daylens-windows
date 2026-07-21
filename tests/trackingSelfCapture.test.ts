import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { trackedForegroundSessionExclusionReason } from '../src/main/services/tracking.ts'

function setupDb(): Database.Database {
  return createProductionTestDatabase()
}

test('Daylens foreground sessions are excluded from capture', () => {
  const db = setupDb()

  const reason = trackedForegroundSessionExclusionReason({
    bundleId: 'com.daylens.app',
    appName: 'Daylens',
    windowTitle: 'Daylens: This test the Best Environment. Straight from my claude directory',
    rawAppName: 'Daylens',
  })

  assert.equal(reason, 'daylens_self_capture')
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM app_sessions').get() as { count: number }).count, 0)

  const payload = getTimelineDayPayload(db, '2026-04-30', null)
  assert.equal(payload.sessions.length, 0)
  assert.equal(payload.blocks.length, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number }).count, 0)

  db.close()
})

test('development tool sessions with Daylens project titles are excluded from capture', () => {
  const db = setupDb()

  const reason = trackedForegroundSessionExclusionReason({
    bundleId: '/Applications/Claude.app',
    appName: 'Claude',
    windowTitle: 'Daylens: This test the Best Environment. Straight from my claude directory',
    rawAppName: 'Claude',
  })

  assert.equal(reason, 'daylens_project_title')
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM app_sessions').get() as { count: number }).count, 0)

  const payload = getTimelineDayPayload(db, '2026-04-30', null)
  assert.equal(payload.blocks.length, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number }).count, 0)

  db.close()
})

test('an ordinary foreground session is not excluded', () => {
  const reason = trackedForegroundSessionExclusionReason({
    bundleId: 'com.todesktop.230313mzl4w4u92',
    appName: 'Cursor',
    windowTitle: 'activityFactsQuery.ts — daylens',
    rawAppName: 'Cursor',
  })
  assert.equal(reason, null)
})
