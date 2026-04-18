import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { getLatestAppIdentity } from '../src/main/core/inference/appIdentityRegistry.ts'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE app_identities (
      app_instance_id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL,
      raw_app_name TEXT NOT NULL,
      canonical_app_id TEXT,
      display_name TEXT NOT NULL,
      default_category TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `)
  return db
}

test('getLatestAppIdentity prefers an exact app_instance_id match over looser canonical matches', () => {
  const db = makeDb()
  db.prepare(`
    INSERT INTO app_identities (
      app_instance_id,
      bundle_id,
      raw_app_name,
      canonical_app_id,
      display_name,
      default_category,
      first_seen_at,
      last_seen_at,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'C:\\Apps\\Dia\\dia.exe',
    'C:\\Apps\\Dia\\dia.exe',
    'Dia',
    'dia',
    'Dia',
    'aiTools',
    100,
    1_000,
    JSON.stringify({ executablePath: 'C:\\Apps\\Dia\\dia.exe' }),
  )
  db.prepare(`
    INSERT INTO app_identities (
      app_instance_id,
      bundle_id,
      raw_app_name,
      canonical_app_id,
      display_name,
      default_category,
      first_seen_at,
      last_seen_at,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'C:\\Apps\\Dia Beta\\dia.exe',
    'C:\\Apps\\Dia Beta\\dia.exe',
    'Dia',
    'dia',
    'Dia',
    'aiTools',
    200,
    2_000,
    JSON.stringify({ executablePath: 'C:\\Apps\\Dia Beta\\dia.exe' }),
  )

  const exact = getLatestAppIdentity(db, {
    appInstanceId: 'C:\\Apps\\Dia\\dia.exe',
    canonicalAppId: 'dia',
    appName: 'NotebookLM',
  })

  assert.equal(exact?.appInstanceId, 'C:\\Apps\\Dia\\dia.exe')
  assert.equal(exact?.bundleId, 'C:\\Apps\\Dia\\dia.exe')
})
