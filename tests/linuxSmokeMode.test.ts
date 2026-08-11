import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const MAIN_PROCESS_SOURCE = path.resolve(process.cwd(), 'src/main/index.ts')

test('linux smoke mode does not start remote sync or startup workload timers', () => {
  const source = fs.readFileSync(MAIN_PROCESS_SOURCE, 'utf8')

  assert.match(
    source,
    /if \(!SMOKE_TEST\) \{[\s\S]*?startSync\(\)[\s\S]*?startDailySummaryNotifier\(mainWindow\)[\s\S]*?startDistractionAlerter\(\)[\s\S]*?\}/,
    'smoke mode should not start remote sync, daily notification, or distraction timers',
  )
  assert.match(
    source,
    /if \(!SMOKE_TEST\) \{[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?finalizePreviousDay\(\)[\s\S]*?\}, 10_000\)[\s\S]*?\}/,
    'smoke mode should not run startup finalization, which can invoke remote sync',
  )
})

test('linux smoke mode disables gpu-dependent renderer startup paths', () => {
  const source = fs.readFileSync(MAIN_PROCESS_SOURCE, 'utf8')

  assert.match(
    source,
    /if \(process\.platform === 'linux' && SMOKE_TEST\) \{[\s\S]*?app\.disableHardwareAcceleration\(\)[\s\S]*?appendSwitch\('disable-gpu'\)[\s\S]*?appendSwitch\('disable-dev-shm-usage'\)[\s\S]*?\}/,
    'linux smoke mode should disable hardware/gpu paths before app ready',
  )
})

test('packaged smoke readiness signals are registered before the renderer starts loading', () => {
  const source = fs.readFileSync(MAIN_PROCESS_SOURCE, 'utf8')
  const didFinishLoadListener = source.indexOf("win.webContents.once('did-finish-load', () => {")
  const watchdog = source.indexOf("setTimeout(() => maybeRunSmokeValidation('watchdog'), 20_000)")
  const readyToShow = source.indexOf("win.once('ready-to-show'")
  const readyToShowSignal = source.indexOf("maybeRunSmokeValidation('ready-to-show')")
  const loadFile = source.indexOf('void win.loadFile(rendererPath)')
  const loadUrl = source.indexOf('win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)')

  assert.notEqual(didFinishLoadListener, -1, 'missing packaged smoke did-finish-load fallback')
  assert.match(
    source,
    /win\.webContents\.once\('did-finish-load', \(\) => \{[\s\S]*?if \(SMOKE_TEST && !win\.isVisible\(\)\) win\.show\(\)[\s\S]*?maybeRunSmokeValidation\('did-finish-load'\)/,
    'packaged smoke must show a renderer that loaded without ready-to-show',
  )
  assert.notEqual(watchdog, -1, 'missing packaged smoke watchdog fallback')
  assert.notEqual(readyToShow, -1, 'missing ready-to-show handler')
  assert.notEqual(readyToShowSignal, -1, 'missing packaged smoke ready-to-show signal')
  assert.notEqual(loadFile, -1, 'missing packaged renderer load')
  assert.notEqual(loadUrl, -1, 'missing dev renderer load')
  assert.ok(readyToShow < loadFile, 'packaged smoke ready-to-show handler must be registered before loadFile')
  assert.ok(readyToShow < loadUrl, 'dev smoke ready-to-show handler must be registered before loadURL')
  assert.ok(didFinishLoadListener < loadFile, 'packaged smoke fallback must be registered before loadFile')
  assert.ok(didFinishLoadListener < loadUrl, 'dev smoke fallback must be registered before loadURL')
  assert.ok(watchdog < loadFile, 'packaged smoke watchdog must be armed before loadFile')
  assert.ok(watchdog < loadUrl, 'dev smoke watchdog must be armed before loadURL')
})

test('packaged smoke runs tracking on a fresh isolated profile and waits for persisted capture', () => {
  const source = fs.readFileSync(MAIN_PROCESS_SOURCE, 'utf8')

  assert.match(
    source,
    /if \(!SMOKE_TEST && !shouldStartTrackingForSettings\(getSettings\(\)\)\) return/,
    'ordinary launches must honor onboarding while packaged smoke runs the production tracker',
  )
  assert.match(
    source,
    /if \(!SMOKE_TEST\) \{[\s\S]*?startBrowserTracking\(\)[\s\S]*?backfillWindowsHistory\(\)[\s\S]*?\}/,
    'packaged capture smoke must not read browser history',
  )
  assert.match(
    source,
    /initUpdater\(startupWindow, \{ diagnosticsOnly: SMOKE_TEST \}\)/,
    'packaged smoke must detect updater support without registering handlers or starting update checks',
  )
  assert.match(source, /if \(!SMOKE_TEST\) await initAnalytics\(\)/)
  assert.match(source, /if \(!REAL_DAY_HARNESS && !SMOKE_TEST\) void prewarmBrowserRegistry\(\)/)
  assert.match(source, /reason: 'offline-packaged-smoke'/)
  assert.match(source, /if \(!SMOKE_TEST\) registerCommandPaletteShortcut/)
  assert.match(source, /if \(!SMOKE_TEST && \(process\.platform === 'win32' \|\| process\.platform === 'linux'\)\) ensureProcessMonitor\(\)/)
  assert.match(source, /const captureProbe = await waitForSmokeCapture\(\)/)
  assert.match(source, /FROM app_sessions[\s\S]*?WHERE window_title IN \(\?, \?\)/)
})
