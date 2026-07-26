// Safari history access must be diagnosable, not silently absent (DEV-238).
// Without Full Disk Access, TCC makes ~/Library/Safari unreadable: the
// directory scan sees nothing and fs.existsSync reports the History.db as
// missing, so Safari used to vanish from discovery, its poll never ran, and
// capture health showed the access state as UNKNOWN forever. These tests pin
// the two fixes: discovery still emits Safari's canonical history location
// when the scan cannot see it, and the poll gate can tell a permission-denied
// path from a genuinely missing one.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  discoverMacBrowserHistoryLocations,
  type BrowserApplication,
} from '../src/main/services/browserRegistry.ts'
import {
  historyPathAvailability,
  isPermissionDeniedError,
} from '../src/main/services/browserCapability.ts'

const SAFARI_APP: BrowserApplication = {
  name: 'Safari',
  bundleId: 'com.apple.Safari',
  appPath: '/Applications/Safari.app',
  family: 'webkit',
  source: 'info_plist',
}

test('Safari keeps its canonical history location when the scan sees nothing (no Full Disk Access)', () => {
  // An empty home directory reproduces what TCC denial looks like to the
  // scanner: readdir on ~/Library/Safari yields nothing.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-safari-home-'))
  try {
    const locations = discoverMacBrowserHistoryLocations([SAFARI_APP], home)
    assert.equal(locations.length, 1)
    assert.equal(locations[0].bundleId, 'com.apple.Safari')
    assert.equal(locations[0].historyPath, path.join(home, 'Library', 'Safari', 'History.db'))
    assert.equal(locations[0].family, 'webkit')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a non-Safari webkit browser gets no synthesized history path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-orion-home-'))
  try {
    const locations = discoverMacBrowserHistoryLocations([{
      ...SAFARI_APP,
      name: 'Orion',
      bundleId: 'com.kagi.kagimacOS',
      appPath: '/Applications/Orion.app',
    }], home)
    assert.equal(locations.length, 0)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a discovered Safari History.db is still found by the normal scan', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-safari-home-'))
  try {
    const safariDir = path.join(home, 'Library', 'Safari')
    fs.mkdirSync(safariDir, { recursive: true })
    fs.writeFileSync(path.join(safariDir, 'History.db'), '')
    const locations = discoverMacBrowserHistoryLocations([SAFARI_APP], home)
    assert.equal(locations.length, 1)
    assert.equal(locations[0].historyPath, path.join(safariDir, 'History.db'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('historyPathAvailability tells denied apart from missing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-availability-'))
  try {
    assert.equal(historyPathAvailability(path.join(base, 'nope', 'History.db')), 'missing')

    const readableDir = path.join(base, 'ok')
    fs.mkdirSync(readableDir)
    const readableFile = path.join(readableDir, 'History.db')
    fs.writeFileSync(readableFile, '')
    assert.equal(historyPathAvailability(readableFile), 'readable')

    // chmod 000 on the parent simulates TCC's EPERM; skipped when running as
    // root, which bypasses permission checks entirely.
    if (typeof process.getuid === 'function' && process.getuid() !== 0 && process.platform !== 'win32') {
      const lockedDir = path.join(base, 'locked')
      fs.mkdirSync(lockedDir)
      const lockedFile = path.join(lockedDir, 'History.db')
      fs.writeFileSync(lockedFile, '')
      fs.chmodSync(lockedDir, 0o000)
      try {
        assert.equal(historyPathAvailability(lockedFile), 'denied')
      } finally {
        fs.chmodSync(lockedDir, 0o700)
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('permission-denied classification covers the TCC error shapes', () => {
  assert.equal(isPermissionDeniedError(Object.assign(new Error('x'), { code: 'EPERM' })), true)
  assert.equal(isPermissionDeniedError(Object.assign(new Error('x'), { code: 'EACCES' })), true)
  assert.equal(isPermissionDeniedError(new Error('EPERM: operation not permitted, stat …/Library/Safari/History.db')), true)
  assert.equal(isPermissionDeniedError(Object.assign(new Error('x'), { code: 'ENOENT' })), false)
})
