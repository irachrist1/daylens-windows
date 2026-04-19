import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  chooseUserDataPath,
  describeUserDataDirectory,
  isHealthyUserDataState,
  selectLatestRestorableBackup,
} from '../src/main/services/userData.ts'

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-userdata-'))
}

function writeState(dirPath: string, options: { onboardingComplete?: boolean; dbBytes?: number; dbMtime?: number }): void {
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(
    path.join(dirPath, 'config.json'),
    `${JSON.stringify({ onboardingComplete: options.onboardingComplete ?? false })}\n`,
    'utf8',
  )

  if (options.dbBytes && options.dbBytes > 0) {
    fs.writeFileSync(path.join(dirPath, 'daylens.sqlite'), Buffer.alloc(options.dbBytes, 1))
  }

  if (options.dbMtime) {
    const timestamp = new Date(options.dbMtime)
    fs.utimesSync(path.join(dirPath, 'config.json'), timestamp, timestamp)
    if (options.dbBytes && options.dbBytes > 0) {
      fs.utimesSync(path.join(dirPath, 'daylens.sqlite'), timestamp, timestamp)
    }
  }
}

test('macOS chooses the richest legacy Daylens data folder before the stale DaylensWindows path', () => {
  const appDataPath = createTempDir()
  const daylensDir = path.join(appDataPath, 'Daylens')
  const legacyDir = path.join(appDataPath, 'DaylensWindows')

  writeState(daylensDir, {
    onboardingComplete: true,
    dbBytes: 8_192,
    dbMtime: Date.UTC(2026, 3, 19, 18, 30, 0),
  })
  writeState(legacyDir, {
    onboardingComplete: true,
    dbBytes: 1_024,
    dbMtime: Date.UTC(2026, 3, 18, 9, 15, 0),
  })

  assert.equal(chooseUserDataPath(appDataPath, 'darwin'), daylensDir)
})

test('new macOS installs still default to Daylens Desktop when no prior data exists', () => {
  const appDataPath = createTempDir()
  assert.equal(
    chooseUserDataPath(appDataPath, 'darwin'),
    path.join(appDataPath, 'Daylens Desktop'),
  )
})

test('healthy userData requires both completed onboarding and a timeline database', () => {
  const appDataPath = createTempDir()
  const healthyDir = path.join(appDataPath, 'healthy')
  const blankDir = path.join(appDataPath, 'blank')

  writeState(healthyDir, { onboardingComplete: true, dbBytes: 2_048 })
  writeState(blankDir, { onboardingComplete: true, dbBytes: 0 })

  assert.equal(isHealthyUserDataState(healthyDir), true)
  assert.equal(isHealthyUserDataState(blankDir), false)

  const snapshot = describeUserDataDirectory(blankDir)
  assert.equal(snapshot.onboardingComplete, true)
  assert.equal(snapshot.hasTimelineDatabase, false)
})

test('backup recovery prefers the newest backup with both onboarding and database state', () => {
  const root = createTempDir()
  const backupRoot = path.join(root, 'pre-update-backups')
  const older = path.join(backupRoot, '2026-04-19T08-00-00-000Z')
  const newerBlank = path.join(backupRoot, '2026-04-19T09-00-00-000Z')
  const newestValid = path.join(backupRoot, '2026-04-19T10-00-00-000Z')

  writeState(older, { onboardingComplete: true, dbBytes: 1_024 })
  writeState(newerBlank, { onboardingComplete: true, dbBytes: 0 })
  writeState(newestValid, { onboardingComplete: true, dbBytes: 4_096 })

  assert.equal(selectLatestRestorableBackup(backupRoot), newestValid)
})
