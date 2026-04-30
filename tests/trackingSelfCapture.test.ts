import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { ensureSearchSchema } from '../src/main/db/migrations.ts'
import { getTimelineDayPayload } from '../src/main/services/workBlocks.ts'
import { persistTrackedForegroundSession } from '../src/main/services/tracking.ts'

function setupDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  ensureSearchSchema(db)
  return db
}

test('Daylens foreground sessions are not persisted as tracked artifacts', () => {
  const db = setupDb()
  const startTime = new Date(2026, 3, 30, 9, 0, 0, 0).getTime()

  const insertedId = persistTrackedForegroundSession(db, {
    bundleId: 'com.daylens.app',
    appName: 'Daylens',
    windowTitle: 'Daylens: This test the Best Environment. Straight from my claude directory',
    rawAppName: 'Daylens',
    canonicalAppId: 'daylens',
    appInstanceId: 'com.daylens.app',
    captureSource: 'foreground_poll',
    endedReason: 'app_switch',
    captureVersion: 2,
    startTime,
    endTime: startTime + 30 * 60_000,
    durationSeconds: 30 * 60,
    category: 'development',
    isFocused: true,
  })

  assert.equal(insertedId, null)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM app_sessions').get() as { count: number }).count, 0)

  const payload = getTimelineDayPayload(db, '2026-04-30', null)
  assert.equal(payload.sessions.length, 0)
  assert.equal(payload.blocks.length, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number }).count, 0)

  db.close()
})

test('development tool sessions with Daylens project titles are not persisted', () => {
  const db = setupDb()
  const startTime = new Date(2026, 3, 30, 10, 0, 0, 0).getTime()

  const insertedId = persistTrackedForegroundSession(db, {
    bundleId: '/Applications/Claude.app',
    appName: 'Claude',
    windowTitle: 'Daylens: This test the Best Environment. Straight from my claude directory',
    rawAppName: 'Claude',
    canonicalAppId: 'claude',
    appInstanceId: '/Applications/Claude.app',
    captureSource: 'foreground_poll',
    endedReason: 'app_switch',
    captureVersion: 2,
    startTime,
    endTime: startTime + 20 * 60_000,
    durationSeconds: 20 * 60,
    category: 'aiTools',
    isFocused: true,
  })

  assert.equal(insertedId, null)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM app_sessions').get() as { count: number }).count, 0)

  const payload = getTimelineDayPayload(db, '2026-04-30', null)
  assert.equal(payload.blocks.length, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number }).count, 0)

  db.close()
})
