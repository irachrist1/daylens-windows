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

// Shadows the real plutil on PATH so a case can decide how the read behaves.
// `mode` is re-read on every run, so one shim can fail and then recover.
function installPlutilShim(root: string): { setMode: (mode: string) => void; restore: () => void } {
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const modeFile = path.join(root, 'plutil-mode')
  fs.writeFileSync(path.join(binDir, 'plutil'), [
    '#!/bin/sh',
    `mode=$(cat ${JSON.stringify(modeFile)})`,
    'if [ "$mode" = "killed" ]; then kill -TERM $$; fi',
    'if [ "$mode" = "rejected" ]; then exit 1; fi',
    'exec /usr/bin/plutil "$@"',
  ].join('\n'), { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${binDir}:${previousPath ?? ''}`
  return {
    setMode: (mode: string) => fs.writeFileSync(modeFile, mode),
    restore: () => { process.env.PATH = previousPath },
  }
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

test('a read that never finished is retried, not remembered as "not a browser"', darwinOnly, () => {
  const root = tempRoot()
  const shim = installPlutilShim(root)
  try {
    const appPath = writeBundle(root, 'Flaky', browserPlist('com.flaky.browser', 'Flaky'))
    resetMacBundleInspectionCacheForTest()

    // plutil dies on a signal — a timeout or a kill. That says nothing about
    // the bundle, so the next lookup must try again.
    shim.setMode('killed')
    assert.equal(resolveBrowserApplication({ executablePath: appPath }), null)

    shim.setMode('ok')
    assert.equal(
      resolveBrowserApplication({ executablePath: appPath })?.bundleId,
      'com.flaky.browser',
      'a transient read failure must not leave a real browser unresolved',
    )
  } finally {
    shim.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a plist plutil read and rejected is remembered, not re-read every lookup', darwinOnly, () => {
  const root = tempRoot()
  const shim = installPlutilShim(root)
  try {
    const appPath = writeBundle(root, 'Malformed', 'this is not a property list')
    resetMacBundleInspectionCacheForTest()

    // A non-zero exit means plutil read the file and rejected it. That is a
    // fact about the bundle, and it does not change until the bundle does.
    shim.setMode('rejected')
    assert.equal(resolveBrowserApplication({ executablePath: appPath }), null)
    const afterFirst = macBundleInspectionCountForTest()
    assert.ok(afterFirst > 0, 'the first lookup must actually try to read it')

    for (let i = 0; i < 5; i++) {
      assert.equal(resolveBrowserApplication({ executablePath: appPath }), null)
    }
    assert.equal(macBundleInspectionCountForTest(), afterFirst)
  } finally {
    shim.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
