// Resolving "is this app a browser?" reads the bundle's Info.plist, and on
// macOS that is a plutil subprocess. The read paths behind Timeline, Apps and
// a chat turn ask it about every distinct app a person has ever focused — a
// real profile spent 2.8s of one AI turn inside those spawns. The answer only
// changes when the bundle does, so it is remembered against the Info.plist's
// own mtime and size.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  macBundleIdentifierForExecutablePath,
  macBundleInspectionCountForTest,
  resetMacBundleInspectionCacheForTest,
  resolveBrowserApplication,
} from '../src/main/services/browserRegistry.ts'

const darwinOnly = { skip: process.platform !== 'darwin' ? 'macOS bundle layout' : false }

function writeBundle(root: string, name: string, plist: string): string {
  const appPath = path.join(root, `${name}.app`)
  fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), plist)
  return appPath
}

function browserPlist(bundleId: string, displayName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleDisplayName</key><string>${displayName}</string>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLSchemes</key><array><string>http</string><string>https</string></array>
  </dict></array>
</dict></plist>`
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-bundle-cache-'))
}

test('a bundle is inspected once, however often it is resolved', darwinOnly, () => {
  const root = tempRoot()
  try {
    const appPath = writeBundle(root, 'Testly', browserPlist('com.testly.browser', 'Testly'))
    resetMacBundleInspectionCacheForTest()

    const first = resolveBrowserApplication({ executablePath: appPath })
    assert.equal(first?.bundleId, 'com.testly.browser')
    const afterFirst = macBundleInspectionCountForTest()
    assert.ok(afterFirst > 0, 'the first resolution must actually read the bundle')

    for (let i = 0; i < 20; i++) {
      assert.equal(resolveBrowserApplication({ executablePath: appPath })?.bundleId, 'com.testly.browser')
    }
    assert.equal(
      macBundleInspectionCountForTest(),
      afterFirst,
      'repeat resolutions of an unchanged bundle must not read it again',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a rewritten Info.plist is read again, not served from the cache', darwinOnly, () => {
  const root = tempRoot()
  try {
    const appPath = writeBundle(root, 'Shifty', browserPlist('com.shifty.one', 'Shifty One'))
    resetMacBundleInspectionCacheForTest()
    assert.equal(resolveBrowserApplication({ executablePath: appPath })?.bundleId, 'com.shifty.one')

    // A reinstall or an update rewrites Info.plist. Bump the timestamp too:
    // a same-second rewrite of a different size already changes the stamp,
    // but real installs move both.
    fs.writeFileSync(
      path.join(appPath, 'Contents', 'Info.plist'),
      browserPlist('com.shifty.two', 'Shifty Two Renamed'),
    )
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(path.join(appPath, 'Contents', 'Info.plist'), later, later)

    assert.equal(resolveBrowserApplication({ executablePath: appPath })?.bundleId, 'com.shifty.two')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a bundle with no readable Info.plist is never inspected', darwinOnly, () => {
  const root = tempRoot()
  try {
    // Most apps a person focuses are not browsers, and some paths no longer
    // exist at all. plutil could only fail on these, so it must not be run.
    const emptyBundle = path.join(root, 'Hollow.app')
    fs.mkdirSync(path.join(emptyBundle, 'Contents'), { recursive: true })
    resetMacBundleInspectionCacheForTest()

    assert.equal(resolveBrowserApplication({ executablePath: emptyBundle }), null)
    assert.equal(resolveBrowserApplication({ executablePath: path.join(root, 'Gone.app') }), null)
    assert.equal(
      macBundleInspectionCountForTest(),
      0,
      'an unreadable Info.plist must not cost a subprocess that could only fail',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bundle-id resolution for an executable path shares the same single read', darwinOnly, () => {
  const root = tempRoot()
  try {
    const appPath = writeBundle(root, 'Shared', browserPlist('com.shared.browser', 'Shared'))
    resetMacBundleInspectionCacheForTest()

    const executable = path.join(appPath, 'Contents', 'MacOS', 'Shared')
    assert.equal(macBundleIdentifierForExecutablePath(executable), 'com.shared.browser')
    const afterFirst = macBundleInspectionCountForTest()
    assert.equal(resolveBrowserApplication({ executablePath: executable })?.bundleId, 'com.shared.browser')
    assert.equal(
      macBundleInspectionCountForTest(),
      afterFirst,
      'the capture poll and the browser check must not each pay their own read',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
