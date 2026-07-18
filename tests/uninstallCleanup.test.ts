import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildPosixDataCleanupScript,
  buildWindowsDataCleanupScript,
  collectLocalDataTargets,
  removalCommandForPackageType,
  windowsUninstallerPath,
} from '../src/main/services/uninstallCleanup'
import { listUserDataCandidatePaths } from '../src/main/services/userData'

function makeTempAppData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-uninstall-test-'))
}

test('candidate user-data paths cover the preferred and legacy directories per platform', () => {
  const mac = listUserDataCandidatePaths('/appdata', 'darwin')
  assert.deepEqual(mac, [
    path.join('/appdata', 'Daylens Desktop'),
    path.join('/appdata', 'Daylens'),
    path.join('/appdata', 'DaylensWindows'),
  ])

  const win = listUserDataCandidatePaths('/appdata', 'win32')
  assert.deepEqual(win, [
    path.join('/appdata', 'Daylens'),
    path.join('/appdata', 'DaylensWindows'),
  ])

  const linux = listUserDataCandidatePaths('/appdata', 'linux')
  assert.deepEqual(linux, [
    path.join('/appdata', 'Daylens'),
    path.join('/appdata', 'DaylensWindows'),
  ])
})

test('collectLocalDataTargets returns only directories that exist, deduplicated', () => {
  const appData = makeTempAppData()
  try {
    const preferred = path.join(appData, 'Daylens Desktop')
    const legacy = path.join(appData, 'DaylensWindows')
    fs.mkdirSync(preferred, { recursive: true })
    fs.mkdirSync(legacy, { recursive: true })
    // A stray FILE with a candidate name must not become a deletion target.
    fs.writeFileSync(path.join(appData, 'Daylens'), 'not a directory')

    const targets = collectLocalDataTargets(appData, preferred, 'darwin')
    assert.deepEqual(targets.sort(), [preferred, legacy].sort())
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
  }
})

test('collectLocalDataTargets includes an out-of-tree userData path (dev override) once', () => {
  const appData = makeTempAppData()
  const devUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-dev-userdata-'))
  try {
    const targets = collectLocalDataTargets(appData, devUserData, 'linux')
    assert.deepEqual(targets, [devUserData])
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
    fs.rmSync(devUserData, { recursive: true, force: true })
  }
})

test('posix cleanup script waits for the parent, removes every target, and self-deletes', () => {
  const script = buildPosixDataCleanupScript(4242, ["/tmp/Daylens Desktop", "/tmp/it's-legacy"], '/tmp/cleanup.log')
  assert.match(script, /^#!\/bin\/sh\n/)
  assert.match(script, /kill -0 4242/)
  assert.ok(script.includes("rm -rf '/tmp/Daylens Desktop' '/tmp/it'\\''s-legacy'"), 'targets must be single-quoted with escaped quotes')
  assert.match(script, /rm -- "\$0"/)
  // The wait loop must be bounded so a stuck parent cannot leave the helper running forever.
  assert.match(script, /-ge 200/)
})

test('windows cleanup script polls the parent pid with a bounded loop and removes each target', () => {
  const script = buildWindowsDataCleanupScript(555, ['C:\\Users\\me\\AppData\\Roaming\\Daylens'])
  assert.match(script, /PID eq 555/)
  assert.match(script, /if %tries% gtr 120 goto clean/)
  // Delayed expansion would corrupt paths containing "!".
  assert.ok(!script.includes('enabledelayedexpansion'))
  assert.ok(script.includes('rd /s /q "C:\\Users\\me\\AppData\\Roaming\\Daylens"'))
  assert.ok(script.includes('del "%~f0"'))
})

test('linux removal command matches the package manager that owns the install', () => {
  assert.equal(removalCommandForPackageType('deb', 'daylens'), 'sudo apt remove daylens')
  assert.equal(removalCommandForPackageType('rpm', 'daylens'), 'sudo dnf remove daylens')
  assert.equal(removalCommandForPackageType('pacman', 'daylens'), 'sudo pacman -R daylens')
  // Unowned installs (AppImage, tar.gz, unknown) are finished by deleting the
  // file, not by a package manager command.
  assert.equal(removalCommandForPackageType('appimage', null), null)
  assert.equal(removalCommandForPackageType('unknown', null), null)
  assert.equal(removalCommandForPackageType(null, null), null)
  // A missing owner falls back to the published package name.
  assert.equal(removalCommandForPackageType('deb', null), 'sudo apt remove daylens')
})

test('windows uninstaller path sits next to the executable with the product name', () => {
  const execPath = path.join(os.tmpdir(), 'Programs', 'Daylens', 'Daylens.exe')
  assert.equal(
    windowsUninstallerPath(execPath),
    path.join(os.tmpdir(), 'Programs', 'Daylens', 'Uninstall Daylens.exe'),
  )
})
