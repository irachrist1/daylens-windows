// The MCP server's DAYLENS_DB_PATH fallback must find the SAME database the
// app opens. The regression this pins: the fallback used to hardcode the
// legacy macOS dir (~/Library/Application Support/Daylens), so on a machine
// where the app had moved to "Daylens Desktop" an MCP client launched without
// DAYLENS_DB_PATH silently served the months-stale legacy database.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultAppDataPath, resolveDefaultDbPath } from '../packages/mcp-server/src/dbPath'

// Fake macOS homedir: discovery derives appData as <home>/Library/Application Support.
function makeMacHome(): { home: string; appData: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-mcp-discovery-'))
  const appData = path.join(home, 'Library', 'Application Support')
  fs.mkdirSync(appData, { recursive: true })
  return { home, appData }
}

// A directory only counts in discovery when it holds meaningful data — a
// non-empty database and/or a completed onboarding config.
function seedUserDataDir(appData: string, dirName: string): string {
  const dir = path.join(appData, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'daylens.sqlite'), 'not-empty')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ onboardingComplete: true }))
  return dir
}

test('darwin: prefers Daylens Desktop over a stale legacy Daylens dir when both hold data', () => {
  const { home, appData } = makeMacHome()
  try {
    seedUserDataDir(appData, 'Daylens')
    const desktop = seedUserDataDir(appData, 'Daylens Desktop')
    assert.equal(resolveDefaultDbPath('darwin', {}, home), path.join(desktop, 'daylens.sqlite'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('darwin: falls back to the legacy dir when it is the only one with data', () => {
  const { home, appData } = makeMacHome()
  try {
    const legacy = seedUserDataDir(appData, 'Daylens')
    assert.equal(resolveDefaultDbPath('darwin', {}, home), path.join(legacy, 'daylens.sqlite'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('darwin: empty machine resolves to the preferred Daylens Desktop path', () => {
  const { home, appData } = makeMacHome()
  try {
    assert.equal(
      resolveDefaultDbPath('darwin', {}, home),
      path.join(appData, 'Daylens Desktop', 'daylens.sqlite'),
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('appData base matches Electron conventions per platform', () => {
  assert.equal(
    defaultAppDataPath('darwin', {}, '/Users/someone'),
    path.join('/Users/someone', 'Library', 'Application Support'),
  )
  assert.equal(
    defaultAppDataPath('win32', { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, 'C:\\Users\\someone'),
    'C:\\Users\\someone\\AppData\\Roaming',
  )
  assert.equal(
    defaultAppDataPath('win32', {}, '/home/x'),
    path.join('/home/x', 'AppData', 'Roaming'),
  )
  assert.equal(
    defaultAppDataPath('linux', { XDG_CONFIG_HOME: '/home/x/.cfg' }, '/home/x'),
    '/home/x/.cfg',
  )
  assert.equal(defaultAppDataPath('linux', {}, '/home/x'), path.join('/home/x', '.config'))
})
