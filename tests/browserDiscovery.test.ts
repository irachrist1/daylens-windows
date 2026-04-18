import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCanonicalBrowser } from '../src/main/lib/appIdentity.ts'
import { getBrowserEntries } from '../src/main/services/browser.ts'

function tempHomeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-browser-home-'))
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '')
}

async function withWindowsHome<T>(homeDir: string, run: () => Promise<T> | T): Promise<T> {
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const originalPlatform = process.platform

  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value:        'win32',
  })

  try {
    return await run()
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome

    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value:        originalPlatform,
    })
  }
}

test('windows browser discovery finds Arc, Dia, and Comet Chromium profiles', async () => {
  const homeDir = tempHomeDir()
  const local = path.join(homeDir, 'AppData', 'Local')

  const arcHistoryPath = path.join(local, 'The Browser Company', 'Arc', 'User Data', 'Default', 'History')
  const diaHistoryPath = path.join(local, 'Dia', 'User Data', 'Profile 1', 'History')
  const cometHistoryPath = path.join(local, 'Comet', 'Default', 'History')

  touch(arcHistoryPath)
  touch(diaHistoryPath)
  touch(cometHistoryPath)

  const entries = await withWindowsHome(homeDir, () => getBrowserEntries())

  const arc = entries.find((entry) => entry.bundleId === 'arc.exe')
  assert.equal(arc?.name, 'Arc')
  assert.equal(arc?.historyPath, arcHistoryPath)
  assert.equal(resolveCanonicalBrowser(arc?.bundleId).canonicalBrowserId, 'arc')

  const dia = entries.find((entry) => entry.bundleId === 'dia.exe:Profile 1')
  assert.equal(dia?.name, 'Dia (Profile 1)')
  assert.equal(dia?.historyPath, diaHistoryPath)
  assert.equal(resolveCanonicalBrowser(dia?.bundleId).canonicalBrowserId, 'dia')

  const comet = entries.find((entry) => entry.bundleId === 'comet.exe')
  assert.equal(comet?.name, 'Comet')
  assert.equal(comet?.historyPath, cometHistoryPath)
  assert.equal(resolveCanonicalBrowser(comet?.bundleId).canonicalBrowserId, 'comet')
})
