import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { getAppDetailPayload } from '../src/main/services/workBlocks.ts'

function todayKey(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localMs(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

test('app detail omits app-name-only block appearances', () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  const date = todayKey()
  const start = localMs(date, 9)
  const end = start + 12 * 60_000

  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused,
      window_title,
      raw_app_name,
      capture_source,
      capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'test', 1)
  `).run(
    'com.whatsapp.WhatsApp',
    'whatsApp',
    start,
    end,
    12 * 60,
    'communication',
    'WhatsApp',
    'whatsApp',
  )

  const detail = getAppDetailPayload(db, 'whatsapp', 1, null)

  assert.equal(detail.displayName, 'WhatsApp')
  assert.deepEqual(detail.blockAppearances, [])
  db.close()
})
