import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { LATEST_SCHEMA_VERSION } from '../src/main/db/migrations.ts'

test('production test database applies every migration and startup schema repair', () => {
  const db = createProductionTestDatabase()
  try {
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number
    }
    assert.equal(version.version, LATEST_SCHEMA_VERSION)

    const requiredTables = [
      'browser_history_cursors',
      'focus_events',
      'derived_sessions',
      'derived_blocks',
      'work_memory_facts',
      'ai_threads',
      'ai_messages',
    ]
    const placeholders = requiredTables.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (${placeholders})
      ORDER BY name
    `,
      )
      .all(...requiredTables) as Array<{ name: string }>
    assert.deepEqual(
      rows.map((row) => row.name),
      [...requiredTables].sort(),
    )

    const metadata = db
      .prepare(
        `
      SELECT component FROM derived_state_versions ORDER BY component
    `,
      )
      .all() as Array<{ component: string }>
    assert.ok(metadata.length > 0, 'startup metadata synchronization must run')
  } finally {
    db.close()
  }
})
