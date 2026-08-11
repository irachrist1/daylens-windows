#!/usr/bin/env node
// In dev the running bundle is node_modules/electron/dist/Electron.app, so macOS
// surfaces that read the *bundle* icon — Stage Manager cards, the Finder entry,
// the About panel — show the Electron atom. app.dock.setIcon() cannot reach those;
// it only covers the Dock tile and the Cmd-Tab switcher. Copying our icns over the
// bundle's is the only way to fix them short of packaging.
//
// Only touches node_modules, and re-runs on every `npm start`, so it survives
// reinstalls and picks up regenerated artwork.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'build', 'icon.icns')
const BUNDLE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app')
const TARGET = path.join(BUNDLE, 'Contents', 'Resources', 'electron.icns')

if (process.platform !== 'darwin') process.exit(0)
if (!fs.existsSync(SOURCE) || !fs.existsSync(TARGET)) process.exit(0)

const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

try {
  if (digest(SOURCE) === digest(TARGET)) process.exit(0)
  fs.copyFileSync(SOURCE, TARGET)
  // macOS caches bundle icons keyed on the bundle's mtime, so the copy alone is not
  // enough — the stale Electron icon survives until the bundle looks modified.
  const now = new Date()
  fs.utimesSync(path.join(BUNDLE, 'Contents', 'Info.plist'), now, now)
  fs.utimesSync(BUNDLE, now, now)
  console.log('[dev-icon] applied Daylens icon to the dev Electron bundle')
} catch (error) {
  // Never block `npm start` over cosmetics.
  console.warn('[dev-icon] skipped:', error.message)
}
