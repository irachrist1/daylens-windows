import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkDatabaseIntegrity,
  consumeCleanShutdownMarker,
  quarantineCorruptDatabase,
  recoverCorruptDatabase,
  writeCleanShutdownMarker,
} from '../src/main/services/databaseRecovery.ts'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-db-recovery-'))
}

function createHealthyDatabase(dbPath: string, marker: string): void {
  const db = new Database(dbPath)
  db.exec(SCHEMA_SQL)
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(marker, marker, 1_000, 2_000, 1, 'development', 1)
  db.close()
}

function corruptFile(dbPath: string): void {
  fs.writeFileSync(dbPath, 'this is definitely not a sqlite database, repeated. '.repeat(64))
}

function readMarker(dbPath: string): string | undefined {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.prepare('SELECT bundle_id AS bundleId FROM app_sessions LIMIT 1').get() as { bundleId: string } | undefined
    return row?.bundleId
  } finally {
    db.close()
  }
}

test('a missing or empty database file passes the integrity check', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')

  assert.deepEqual(checkDatabaseIntegrity(dbPath), { ok: true })

  fs.writeFileSync(dbPath, '')
  assert.deepEqual(checkDatabaseIntegrity(dbPath), { ok: true })
})

test('clean shutdown marker is consumed exactly once', () => {
  const dir = makeTempDir()

  assert.equal(consumeCleanShutdownMarker(dir), false)
  writeCleanShutdownMarker(dir)
  assert.equal(consumeCleanShutdownMarker(dir), true)
  assert.equal(consumeCleanShutdownMarker(dir), false)
})

test('a healthy database passes the integrity check and is untouched', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  createHealthyDatabase(dbPath, 'com.daylens.healthy')

  const before = fs.readFileSync(dbPath)
  assert.deepEqual(checkDatabaseIntegrity(dbPath), { ok: true })
  assert.ok(before.equals(fs.readFileSync(dbPath)))
  assert.equal(readMarker(dbPath), 'com.daylens.healthy')
})

test('a corrupt database file fails the integrity check with a reason', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  corruptFile(dbPath)

  const result = checkDatabaseIntegrity(dbPath)
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.reason.length > 0)
})

test('quick mode passes a healthy database and fails a corrupt one', () => {
  const dir = makeTempDir()
  const healthyPath = path.join(dir, 'healthy.sqlite')
  createHealthyDatabase(healthyPath, 'com.daylens.quick')
  assert.deepEqual(checkDatabaseIntegrity(healthyPath, 'quick'), { ok: true })

  const corruptPath = path.join(dir, 'corrupt.sqlite')
  corruptFile(corruptPath)
  const result = checkDatabaseIntegrity(corruptPath, 'quick')
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.reason.length > 0)
})

test('quarantine moves the database and its sidecars aside', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  corruptFile(dbPath)
  fs.writeFileSync(`${dbPath}-wal`, 'wal bytes')
  fs.writeFileSync(`${dbPath}-shm`, 'shm bytes')

  const quarantinePath = quarantineCorruptDatabase(dbPath)

  assert.ok(quarantinePath)
  assert.ok(!fs.existsSync(dbPath))
  assert.ok(!fs.existsSync(`${dbPath}-wal`))
  assert.ok(!fs.existsSync(`${dbPath}-shm`))
  assert.ok(fs.existsSync(quarantinePath!))
  assert.ok(fs.existsSync(`${quarantinePath}-wal`))
  assert.ok(fs.existsSync(`${quarantinePath}-shm`))
})

test('quarantine never overwrites an earlier database with the same timestamp', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  const now = new Date('2026-07-18T00:00:00.000Z')
  corruptFile(dbPath)

  const firstPath = quarantineCorruptDatabase(dbPath, now)
  assert.ok(firstPath)
  const firstBytes = fs.readFileSync(firstPath!)

  fs.writeFileSync(dbPath, 'different corrupt backup bytes')
  const secondPath = quarantineCorruptDatabase(dbPath, now)

  assert.ok(secondPath)
  assert.notEqual(secondPath, firstPath)
  assert.ok(firstBytes.equals(fs.readFileSync(firstPath!)))
  assert.equal(fs.readFileSync(secondPath!, 'utf8'), 'different corrupt backup bytes')
})

test('choosing restore recovers the backup copy and keeps the damaged file', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  const backupDir = path.join(dir, 'pre-update-backups', '2026-07-18T00-00-00-000Z')
  fs.mkdirSync(backupDir, { recursive: true })
  createHealthyDatabase(path.join(backupDir, 'daylens.sqlite'), 'com.daylens.from-backup')
  corruptFile(dbPath)

  const recovery = recoverCorruptDatabase(dbPath, backupDir, 'restore')

  assert.equal(recovery.outcome, 'restored')
  assert.ok(recovery.quarantinedTo && fs.existsSync(recovery.quarantinedTo))
  assert.deepEqual(checkDatabaseIntegrity(dbPath), { ok: true })
  assert.equal(readMarker(dbPath), 'com.daylens.from-backup')
})

test('choosing fresh leaves an empty slot that opens as a working database', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  corruptFile(dbPath)

  const recovery = recoverCorruptDatabase(dbPath, null, 'fresh')

  assert.equal(recovery.outcome, 'fresh')
  assert.ok(recovery.quarantinedTo && fs.existsSync(recovery.quarantinedTo))
  assert.ok(!fs.existsSync(dbPath))

  // The open path initDb() runs against the now-empty slot.
  createHealthyDatabase(dbPath, 'com.daylens.fresh')
  assert.deepEqual(checkDatabaseIntegrity(dbPath), { ok: true })
})

test('restoring from a corrupt backup falls back to fresh instead of a crash loop', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  const backupDir = path.join(dir, 'pre-update-backups', '2026-07-18T00-00-00-000Z')
  fs.mkdirSync(backupDir, { recursive: true })
  corruptFile(path.join(backupDir, 'daylens.sqlite'))
  corruptFile(dbPath)

  const recovery = recoverCorruptDatabase(dbPath, backupDir, 'restore')

  assert.equal(recovery.outcome, 'fresh')
  assert.ok(!fs.existsSync(dbPath))
})

test('restore with no backup available falls back to fresh', () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'daylens.sqlite')
  corruptFile(dbPath)

  const recovery = recoverCorruptDatabase(dbPath, null, 'restore')

  assert.equal(recovery.outcome, 'fresh')
  assert.ok(!fs.existsSync(dbPath))
})
