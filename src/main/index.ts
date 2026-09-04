// ─── Global error handlers — must be first, before any imports' side effects ──
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err)
  if (process.env.DAYLENS_REAL_DAY_HARNESS !== '1') {
    try {
      const {
        capture: analyticsCapture,
        captureException: analyticsCaptureException,
      } = require('./services/analytics') as typeof import('./services/analytics') // eslint-disable-line @typescript-eslint/no-require-imports
      analyticsCapture('app_crashed', {
        process_type: 'main',
        reason: 'uncaught_exception',
      })
      analyticsCaptureException(err, {
        tags: {
          process_type: 'main',
          reason: 'uncaught_exception',
        },
      })
    } catch { /* analytics may not be ready */ }
  }
  // A crashed main process owns tracking, so staying dead means the user's day
  // silently stops being captured until they notice and reopen. Auto-relaunch
  // instead — but guard against a crash LOOP (relaunch → crash → relaunch): if
  // we've already relaunched too many times in a short window, give up and show
  // the dialog so we don't hammer the machine. Packaged only; a dev crash should
  // surface, not respawn.
  try {
    const { app: a, dialog: d } = require('electron') as typeof import('electron') // eslint-disable-line @typescript-eslint/no-require-imports
    if (process.env.DAYLENS_REAL_DAY_HARNESS !== '1' && a.isPackaged && !recentCrashLoop()) {
      a.relaunch()
      a.exit(1)
      return
    }
    d.showErrorBox('Daylens crashed', `${err.name}: ${err.message}\n\nPlease restart Daylens.`)
  } catch { /* dialog / app may not be ready */ }
})

/** True when the main process has crashed-and-relaunched too many times in a
 *  short window — the signal of a crash loop we should NOT keep respawning
 *  through. Records this crash's timestamp. Best-effort, temp-file backed so it
 *  works even before userData is configured; any failure returns false (relaunch
 *  is the safer default for a lone transient crash). */
function recentCrashLoop(): boolean {
  const MAX_CRASHES = 3
  const WINDOW_MS = 5 * 60 * 1000
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(os.tmpdir(), 'daylens-crash-guard.json')
    const now = Date.now()
    let times: number[] = []
    try {
      times = (JSON.parse(fs.readFileSync(file, 'utf8')) as { times?: number[] }).times ?? []
    } catch { /* no prior record */ }
    times = times.filter((t) => now - t < WINDOW_MS)
    times.push(now)
    try { fs.writeFileSync(file, JSON.stringify({ times })) } catch { /* best-effort */ }
    return times.length > MAX_CRASHES
  } catch {
    return false
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason)
  if (process.env.DAYLENS_REAL_DAY_HARNESS !== '1') {
    try {
      const {
        capture: analyticsCapture,
        captureException: analyticsCaptureException,
      } = require('./services/analytics') as typeof import('./services/analytics') // eslint-disable-line @typescript-eslint/no-require-imports
      analyticsCapture('app_crashed', {
        process_type: 'main',
        reason: 'unhandled_rejection',
      })
      analyticsCaptureException(reason, {
        tags: {
          process_type: 'main',
          reason: 'unhandled_rejection',
        },
      })
    } catch { /* analytics may not be ready */ }
  }
})

import { BrowserWindow, Menu, app, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, session, shell } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ANALYTICS_EVENT, classifyFailureKind, isKnownAnalyticsEvent } from '@shared/analytics'
import { capture, captureException, initAnalytics, shutdown } from './services/analytics'
import { getBillingAccess } from './services/billing'
import { registerAIHandlers } from './ipc/ai.handlers'
import { registerDbHandlers } from './ipc/db.handlers'
import { registerEntityHandlers } from './ipc/entities.handlers'
import { registerErrorHandlers } from './ipc/errors.handlers'
import { registerDebugHandlers } from './ipc/debug.handlers'
import { registerFocusHandlers } from './ipc/focus.handlers'
import { registerSettingsHandlers } from './ipc/settings.handlers'
import { registerBillingHandlers } from './ipc/billing.handlers'
import { registerIntercomHandlers } from './ipc/intercom.handlers'
import { registerNotificationHandlers } from './ipc/notifications.handlers'
import { registerSearchHandlers } from './ipc/search.handlers'
import { registerSyncHandlers } from './ipc/sync.handlers'
import { startMcpServer, stopMcpServer } from './services/mcpServer'
import { initDb, closeDb, getDb } from './services/database'
import { startAIUsageRetentionSchedule, stopAIUsageRetentionSchedule } from './services/aiUsageRetention'
import { recoverInterruptedTurns } from './services/agentTurnState'
import { runPendingDerivedStateReset } from './core/projections/metadata'
import { hasApiKey, initSettings, getSettings, setSettings } from './services/settings'
import { getCurrentSession, getLinuxTrackingDiagnostics, startTracking, stopTracking, trackingStatus } from './services/tracking'
import { startFocusCapture, stopFocusCapture, purgeFocusCaptureSpool } from './services/focusCapture'
import { startWindowsFocusCapture, stopWindowsFocusCapture } from './services/windowsFocusCapture'
import { ensureProcessMonitor } from './services/processMonitor'
import { getBrowserStatus, startBrowserTracking, stopBrowserTracking } from './services/browser'
import { prewarmBrowserRegistry } from './services/browserRegistry'
import { startSync, stopSync, finalizePreviousDay, syncNowForQuit } from './services/syncUploader'
import { startMemoryIndexBackfill, stopMemoryIndexBackfill } from './services/memoryIndex'
import { startMemoryMirrorBackfill, stopMemoryMirrorBackfill } from './services/memoryMirrorService'
import { startSemanticIndexBackfill, stopSemanticIndexBackfill } from './services/semanticIndex'
import { backfillWindowsHistory } from './services/windowsHistory'
import { createTray, destroyTray, getTrayDiagnostics, hasTray } from './tray'
import { cancelPendingAutoInstall, getUpdaterState, initUpdater, isInstallingUpdate, registerUpdaterShutdown, getUpdateAvailable } from './services/updater'
import { setDailySummaryNotificationWindow, startDailySummaryNotifier, triggerDailySummaryChecks } from './services/dailySummaryNotifier'
import { fireTestDailyNotification } from './services/notificationHarness'
import { consumePendingNavigationRoute } from './services/dailySummaryNavigation'
import { registerCommandPaletteShortcut, unregisterCommandPaletteShortcut } from './services/commandPalette'
import { registerDistractionAlerterHandlers, resetDistractionStateOnResume, setDistractionAlertWindow, startDistractionAlerter } from './services/distractionAlerter'
import { setSpendAlertWindow } from './services/aiSpendGuardrails'
import { stopRangeWorker } from './services/rangeWorker'
import { installEmbedWorkerTransport, stopEmbedWorker } from './services/embedWorkerHost'
import { startStallWatchdog, stopStallWatchdog } from './services/stallWatchdog'
import { setPermissionWatcherWindow, startPermissionWatcher, stopPermissionWatcher } from './services/permissionWatcher'
import { ensureExternalSignalsForDate, registerExternalSignalBackfill, startExternalSignalCollection, stopExternalSignalCollection } from './services/externalSignals'
import { registerExportHandlers } from './ipc/export.handlers'
import { registerScreenContextHandlers } from './ipc/screenContext.handlers'
import { getLinuxDesktopDiagnostics, syncLinuxLaunchOnLogin } from './services/linuxDesktop'
import {
  performUninstallCleanup,
  resolveUninstallChoice,
  uninstallPrimaryChoiceDialogOptions,
} from './services/uninstallCleanup'
import { detectCLITools } from './jobs/aiService'
import { stopProcessMonitor } from './services/processMonitor'
import { reconcileOnboardingState } from './services/onboarding'
import { shouldStartTrackingForSettings } from './lib/onboardingState'
import { assertIsolatedRealDayUserData, isRealDayHarness } from './lib/realDayHarness'
import { resolvePreloadPath } from './lib/preloadPath'
import { isAllowedExternalUrl } from './lib/externalUrlPolicy'
import { IPC } from '@shared/types'
import { grantedCaptureConsent, declinedCaptureConsent } from '@shared/captureConsent'
import {
  APP_DISPLAY_NAME,
  chooseUserDataPath,
  createBackupManifest,
  isHealthyUserDataState,
  selectLatestRestorableBackup,
} from './services/userData'
import {
  checkDatabaseIntegrity,
  consumeCleanShutdownMarker,
  recoverCorruptDatabase,
  writeCleanShutdownMarker,
} from './services/databaseRecovery'
import {
  parseBackupDirTimestampMs,
  pruneDeletionJournalOlderThan,
  replayDeletionJournal,
  selectBackupSourceEntries,
} from './services/deletionJournal'

const APP_USER_MODEL_ID = 'com.daylens.desktop'
const SMOKE_TEST = process.env.DAYLENS_SMOKE_TEST === '1'
const REAL_DAY_HARNESS = isRealDayHarness()
const SMOKE_REPORT_PATH = process.env.DAYLENS_SMOKE_REPORT_PATH?.trim() || path.join(os.tmpdir(), 'daylens-smoke-report.json')
const SMOKE_FOREGROUND_TITLE = process.env.DAYLENS_SMOKE_EXPECT_FOREGROUND_TITLE?.trim() || null
const SMOKE_FULLSCREEN_TITLE = process.env.DAYLENS_SMOKE_EXPECT_FULLSCREEN_TITLE?.trim() || null

function logStartupTiming(stage: string): void {
  console.log(`[startup] ${stage} +${Math.round(process.uptime() * 1_000)}ms`)
}

function configureUserDataPath(): void {
  const devUserDataPath = process.env.DAYLENS_DEV_USERDATA?.trim()
  if (REAL_DAY_HARNESS) {
    const appDataPath = app.getPath('appData')
    const liveUserDataPath = chooseUserDataPath(appDataPath, process.platform)
    const isolatedPath = assertIsolatedRealDayUserData(devUserDataPath, liveUserDataPath)
    app.setPath('userData', isolatedPath)
    console.log('[app] using isolated real-day userData path', isolatedPath)
    return
  }
  if (devUserDataPath) {
    app.setPath('userData', devUserDataPath)
    console.log('[app] using DEV userData path', devUserDataPath)
    return
  }
  const appDataPath = app.getPath('appData')
  const selectedPath = chooseUserDataPath(appDataPath, process.platform)
  app.setPath('userData', selectedPath)
  console.log('[app] using userData path', selectedPath)
}

app.setName(APP_DISPLAY_NAME)
configureUserDataPath()

if (process.platform === 'darwin') {
  // Keep the visible app name as Daylens while avoiding collisions with any native companion app's data folder.
  const dockIcon = path.join(__dirname, '..', '..', 'build', 'icon.png')
  try { app.dock.setIcon(nativeImage.createFromPath(dockIcon)) } catch { /* packaged builds embed the icon */ }
}

// Production Windows releases ship via NSIS through electron-builder, not Squirrel.
// Keep startup free of Squirrel-only hooks so packaged builds can boot normally.

// Single-instance lock — prevents duplicate processes on hot-reload
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}
const previousShutdownWasClean = gotTheLock && consumeCleanShutdownMarker(app.getPath('userData'))

// Pin taskbar icon correctly on Windows
app.setAppUserModelId(APP_USER_MODEL_ID)

if (process.platform === 'linux' && SMOKE_TEST) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null
// Set to true once the user explicitly quits via tray menu
let isQuitting = false
let databaseReady = false
let deferredIntegrationStartup: ReturnType<typeof setTimeout> | null = null
let backgroundServicesStarted = false
let captureAdapterStartupTimer: ReturnType<typeof setTimeout> | null = null
// Set to latest version string when a newer release is detected
export const updateAvailable: string | null = null

function navigateMainWindow(route?: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || !route) return

  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('navigate', route)
    })
    return
  }

  mainWindow.webContents.send('navigate', route)
}

function showMainWindow(route?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  navigateMainWindow(route)

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }

  mainWindow.focus()
}

function hideMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible()) return
  mainWindow.hide()
}

function installApplicationMenu(): void {
  if (process.platform !== 'darwin') return

  const menu = Menu.buildFromTemplate([
    {
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_DISPLAY_NAME}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_DISPLAY_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${APP_DISPLAY_NAME}`, accelerator: 'Command+Q', click: () => { app.quit() } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: `Show ${APP_DISPLAY_NAME}`, click: () => showMainWindow() },
        { label: `Hide ${APP_DISPLAY_NAME}`, click: () => hideMainWindow() },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ])

  Menu.setApplicationMenu(menu)
}

function writeSmokeReport(report: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(SMOKE_REPORT_PATH), { recursive: true })
  fs.writeFileSync(SMOKE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function smokeBrowserStatus(): ReturnType<typeof getBrowserStatus> | {
  skipped: true
  reason: string
  discoveredBrowsers: []
} {
  if (!SMOKE_TEST) return getBrowserStatus()
  return {
    skipped: true,
    reason: 'offline-packaged-smoke',
    discoveredBrowsers: [],
  }
}

async function waitForRendererLoad(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoadingMainFrame()) return

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Renderer did not finish loading before the smoke timeout elapsed.'))
    }, 15_000)

    const cleanup = () => {
      clearTimeout(timeout)
      win.webContents.removeListener('did-finish-load', handleLoad)
      win.webContents.removeListener('did-fail-load', handleFail)
    }

    const handleLoad = () => {
      cleanup()
      resolve()
    }

    const handleFail = (_event: Electron.Event, errorCode: number, errorDescription: string) => {
      cleanup()
      reject(new Error(`Renderer failed to load (${errorCode}): ${errorDescription}`))
    }

    win.webContents.once('did-finish-load', handleLoad)
    win.webContents.once('did-fail-load', handleFail)
  })
}

type SmokeValidationTrigger = 'ready-to-show' | 'did-finish-load' | 'watchdog'

interface SmokeCaptureSession {
  id: number
  appName: string
  windowTitle: string | null
  durationSec: number
  captureSource: string
  endedReason: string | null
}

function readSmokeCaptureSessions(): SmokeCaptureSession[] {
  if (!SMOKE_FOREGROUND_TITLE || !SMOKE_FULLSCREEN_TITLE) return []
  return getDb().prepare(`
    SELECT
      id,
      app_name AS appName,
      window_title AS windowTitle,
      duration_sec AS durationSec,
      capture_source AS captureSource,
      ended_reason AS endedReason
    FROM app_sessions
    WHERE window_title IN (?, ?)
    ORDER BY start_time ASC
  `).all(SMOKE_FOREGROUND_TITLE, SMOKE_FULLSCREEN_TITLE) as SmokeCaptureSession[]
}

interface SmokeCanonicalEvent {
  eventType: string
  appName: string | null
  windowTitle: string | null
  source: string
  platform: string
}

// The canonical mirror of the probe capture: every desktop platform now emits
// foreground observations into focus_events, so a packaged smoke that only
// proved legacy app_sessions would let canonical capture regress silently.
function readSmokeCanonicalEvents(): SmokeCanonicalEvent[] {
  if (!SMOKE_FOREGROUND_TITLE || !SMOKE_FULLSCREEN_TITLE) return []
  return getDb().prepare(`
    SELECT
      event_type AS eventType,
      app_name AS appName,
      window_title AS windowTitle,
      source,
      platform
    FROM focus_events
    WHERE window_title IN (?, ?)
    ORDER BY ts_ms ASC, mono_ns ASC, id ASC
  `).all(SMOKE_FOREGROUND_TITLE, SMOKE_FULLSCREEN_TITLE) as SmokeCanonicalEvent[]
}

async function waitForSmokeCapture(): Promise<{
  required: boolean
  foregroundTitle: string | null
  fullscreenTitle: string | null
  sessions: SmokeCaptureSession[]
  canonicalEvents: SmokeCanonicalEvent[]
}> {
  if (!SMOKE_FOREGROUND_TITLE || !SMOKE_FULLSCREEN_TITLE) {
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    return {
      required: false,
      foregroundTitle: SMOKE_FOREGROUND_TITLE,
      fullscreenTitle: SMOKE_FULLSCREEN_TITLE,
      sessions: [],
      canonicalEvents: [],
    }
  }

  const deadline = Date.now() + 100_000
  while (Date.now() < deadline) {
    const sessions = readSmokeCaptureSessions()
    const foreground = sessions.find((session) => session.windowTitle === SMOKE_FOREGROUND_TITLE)
    const fullscreen = sessions.find((session) => session.windowTitle === SMOKE_FULLSCREEN_TITLE)
    if (foreground && fullscreen) {
      return {
        required: true,
        foregroundTitle: SMOKE_FOREGROUND_TITLE,
        fullscreenTitle: SMOKE_FULLSCREEN_TITLE,
        sessions,
        canonicalEvents: readSmokeCanonicalEvents(),
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  const sessions = readSmokeCaptureSessions()
  throw new Error(
    `Timed out waiting for packaged foreground/fullscreen capture. `
    + `Expected titles ${JSON.stringify([SMOKE_FOREGROUND_TITLE, SMOKE_FULLSCREEN_TITLE])}; `
    + `captured ${JSON.stringify(sessions)}; canonical ${JSON.stringify(readSmokeCanonicalEvents())}; `
    + `tracker ${JSON.stringify(trackingStatus)}; `
    + `live ${JSON.stringify(getCurrentSession())}.`,
  )
}

async function runSmokeValidation(win: BrowserWindow, trigger: SmokeValidationTrigger): Promise<void> {
  try {
    if (trigger === 'watchdog') {
      await waitForRendererLoad(win)
    }
    const captureProbe = await waitForSmokeCapture()

    writeSmokeReport({
      ok: true,
      stage: 'smoke-complete',
      smokeTrigger: trigger,
      reportPath: SMOKE_REPORT_PATH,
      platform: process.platform,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      windowVisible: win.isVisible(),
      currentSession: getCurrentSession(),
      captureProbe,
      trackingStatus: { ...trackingStatus },
      linuxTracking: getLinuxTrackingDiagnostics(),
      linuxDesktop: getLinuxDesktopDiagnostics(),
      browserStatus: smokeBrowserStatus(),
      tray: getTrayDiagnostics(),
      updater: getUpdaterState(),
    })

    isQuitting = true
    await shutdownApp()
    app.exit(0)
  } catch (err) {
    console.error('[smoke] validation failed:', err)
    writeSmokeReport({
      ok: false,
      stage: 'smoke-runtime',
      smokeTrigger: trigger,
      reportPath: SMOKE_REPORT_PATH,
      platform: process.platform,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack ?? null : null,
      currentSession: getCurrentSession(),
      captureProbe: {
        required: Boolean(SMOKE_FOREGROUND_TITLE && SMOKE_FULLSCREEN_TITLE),
        foregroundTitle: SMOKE_FOREGROUND_TITLE,
        fullscreenTitle: SMOKE_FULLSCREEN_TITLE,
        sessions: readSmokeCaptureSessions(),
        canonicalEvents: readSmokeCanonicalEvents(),
      },
      trackingStatus: { ...trackingStatus },
      linuxTracking: getLinuxTrackingDiagnostics(),
      linuxDesktop: getLinuxDesktopDiagnostics(),
      browserStatus: smokeBrowserStatus(),
      tray: getTrayDiagnostics(),
      updater: getUpdaterState(),
    })

    isQuitting = true
    await shutdownApp()
    app.exit(1)
  }
}

function shouldUseTrayBehavior(): boolean {
  const settings = getSettings()
  return settings.onboardingComplete && settings.onboardingState.stage === 'complete'
}

function ensureTray(): void {
  if (mainWindow && shouldUseTrayBehavior()) {
    createTray({
      mainWindow,
      isWindowVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      showMainWindow: (route?: string) => showMainWindow(route),
      hideMainWindow: () => hideMainWindow(),
      quitApp: () => { app.quit() },
    })
  }
}

function startCaptureServices(): void {
  if (!SMOKE_TEST && !shouldStartTrackingForSettings(getSettings())) return
  startTracking()
  if (process.platform === 'darwin') startFocusCapture()
  // DEV-229: verify from launch that the Accessibility grant actually works
  // (real reads, not just the flag) and keep verifying while the app runs.
  if (!SMOKE_TEST) startPermissionWatcher()
  if (!SMOKE_TEST) startStallWatchdog()
  if (process.platform === 'win32') startWindowsFocusCapture()
  if (!SMOKE_TEST && (process.platform === 'win32' || process.platform === 'linux')) ensureProcessMonitor()
  if (!SMOKE_TEST) startExternalSignalCollection()

  if (!SMOKE_TEST) {
    if (captureAdapterStartupTimer) clearTimeout(captureAdapterStartupTimer)
    captureAdapterStartupTimer = setTimeout(() => {
      captureAdapterStartupTimer = null
      if (!shouldStartTrackingForSettings(getSettings())) return
      startBrowserTracking()
      setImmediate(() => {
        try { backfillWindowsHistory() } catch (err) { console.warn('[init] win history:', err) }
      })
    }, 5_000)
  }
}

/** `purgeSpool` is the consent-revocation path (DEV-262): spooled-but-not-yet
 *  ingested events are deleted instead of drained into the database — nothing
 *  observed may outlive the user's decision. Ordinary stops keep the drain. */
function stopCaptureServices(options: { purgeSpool?: boolean } = {}): void {
  if (captureAdapterStartupTimer) {
    clearTimeout(captureAdapterStartupTimer)
    captureAdapterStartupTimer = null
  }
  stopTracking()
  stopFocusCapture({ finalDrain: !options.purgeSpool })
  stopWindowsFocusCapture()
  stopBrowserTracking()
  stopProcessMonitor()
  stopExternalSignalCollection()
  if (options.purgeSpool) purgeFocusCaptureSpool()
}

function startBackgroundServices(): void {
  if (REAL_DAY_HARNESS) {
    backgroundServicesStarted = true
    return
  }

  if (!backgroundServicesStarted) {
    if (!SMOKE_TEST) {
      startSync()
      startDailySummaryNotifier(mainWindow)
      setDistractionAlertWindow(mainWindow)
      setSpendAlertWindow(mainWindow)
      setPermissionWatcherWindow(mainWindow)
      startDistractionAlerter()
    }
    backgroundServicesStarted = true

    setTimeout(() => {
      capture(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, {
        module_source: trackingStatus.moduleSource,
        status: trackingStatus.moduleSource ? 'ok' : 'error',
        surface: 'tracking',
        ...(trackingStatus.loadError ? { failure_kind: classifyFailureKind(trackingStatus.loadError) } : {}),
      })
    }, 5_000)

    if (!SMOKE_TEST) {
      setTimeout(() => {
        setTimeout(() => finalizePreviousDay(), 0)
      }, 10_000)

      // DEV-178: project history into the exact-search memory index a few
      // days per tick, newest first, until every captured day is current.
      // Until a day is reached, its searches serve through the legacy path.
      setTimeout(() => startMemoryIndexBackfill(getDb), 15_000)

      // Write history into the readable memory mirror a few days per tick, so
      // the folder reflects the whole record rather than only the days analyzed
      // since the feature shipped. Later than the index backfill: it re-reads
      // the mirror directory on each step and is pure catch-up work.
      setTimeout(() => startMemoryMirrorBackfill(getDb), 45_000)

      // DEV-180: embed memory records for by-meaning search in bounded
      // background batches (local model; honest no-op when it is absent).
      // Inference runs in the embed-worker subprocess — never on this thread.
      installEmbedWorkerTransport()
      setTimeout(() => startSemanticIndexBackfill(getDb), 30_000)
    }
  }

  startCaptureServices()
}

async function backupUserDataForUpdate(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const backupRoot = path.join(userDataPath, 'pre-update-backups')
  const backupDir = path.join(
    backupRoot,
    new Date().toISOString().replace(/[:.]/g, '-'),
  )

  try {
    fs.mkdirSync(backupDir, { recursive: true })
    // The backup root is excluded from the copy, so the deletion journal that
    // lives inside it is never captured into a backup (DEV-220).
    for (const entry of selectBackupSourceEntries(fs.readdirSync(userDataPath))) {
      fs.cpSync(path.join(userDataPath, entry), path.join(backupDir, entry), {
        recursive: true,
        force: true,
      })
    }

    // Rotate only the timestamped backup directories — the backup root also
    // holds the deletion journal, which must never be rotated away.
    const backups = fs
      .readdirSync(backupRoot)
      .filter((entry) => parseBackupDirTimestampMs(entry) !== null)
      .sort()
    while (backups.length > 3) {
      const oldest = backups.shift()
      if (!oldest) break
      fs.rmSync(path.join(backupRoot, oldest), { recursive: true, force: true })
    }

    const manifest = createBackupManifest(userDataPath, app.getVersion())
    fs.writeFileSync(path.join(backupDir, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    // Journal entries older than the oldest retained backup can never
    // resurrect anything on a restore — drop them.
    const oldestBackupMs = backups
      .map((entry) => parseBackupDirTimestampMs(entry))
      .filter((value): value is number => value !== null)
      .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY)
    if (Number.isFinite(oldestBackupMs)) {
      pruneDeletionJournalOlderThan(userDataPath, oldestBackupMs)
    }

    console.log('[update] backed up user data to', backupDir)
  } catch (err) {
    console.warn('[update] backup failed:', err)
  }
}

// DEV-220: after either restore path copies a backup database back into
// place, re-run every journaled deletion against it so the restore cannot
// resurrect data the person deleted after that backup was taken. The main
// database isn't open yet at both call sites, so open it briefly just for the
// replay. Never fatal — a failed replay logs and startup continues.
function replayDeletionJournalAfterRestore(stage: string): void {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'daylens.sqlite')
  if (!fs.existsSync(dbPath)) return
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath)
    const { replayed, failed } = replayDeletionJournal(db, userDataPath)
    if (replayed > 0 || failed > 0) {
      console.log(`[deletion-journal] ${stage}: replayed ${replayed} deletion(s), ${failed} failed`)
    }
  } catch (err) {
    console.warn(`[deletion-journal] ${stage}: replay failed:`, err)
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

// Detect a post-update launch where NSIS wiped userData, and restore from the most recent backup.
// Must be called BEFORE initSettings() so electron-store reads the restored config on first open.
async function recoverFromUpdateIfNeeded(): Promise<void> {
  if (!app.isPackaged) return

  const userDataPath = app.getPath('userData')
  const versionFilePath = path.join(userDataPath, '.last-version')
  const currentVersion = app.getVersion()

  // Read which version last ran successfully
  let lastVersion: string | null = null
  try {
    lastVersion = fs.readFileSync(versionFilePath, 'utf8').trim()
  } catch { /* missing on first run — that's fine */ }

  // Always write the current version so the next launch knows what ran
  try { fs.writeFileSync(versionFilePath, currentVersion, 'utf8') } catch { /* non-fatal */ }

  // Only recover if this is a first launch after a version change
  if (!lastVersion || lastVersion === currentVersion) return

  if (isHealthyUserDataState(userDataPath)) return

  // Settings look blank after an update. Restore from the most recent valid backup.
  const backupRoot = path.join(userDataPath, 'pre-update-backups')
  try {
    const backupDir = selectLatestRestorableBackup(backupRoot)
    if (backupDir) {
      console.log('[update] restoring user data from backup after upgrade:', path.basename(backupDir))
      for (const file of fs.readdirSync(backupDir)) {
        if (file === 'pre-update-backups') continue
        if (file === 'backup-manifest.json') continue
        try {
          fs.cpSync(path.join(backupDir, file), path.join(userDataPath, file), {
            recursive: true,
            force: true,
          })
        } catch (err) {
          console.warn('[update] could not restore', file, ':', err)
        }
      }
      console.log('[update] user data restored successfully from', backupDir)
      // The backup predates any deletions made since it was taken — replay
      // the deletion journal so the restore does not resurrect them.
      replayDeletionJournalAfterRestore('post-update restore')
      return
    }
    console.warn('[update] post-upgrade blank state detected but no valid backup found')
  } catch (err) {
    console.warn('[update] recovery check failed:', err)
  }
}

// Corruption gate for the main database. Must run after recoverFromUpdateIfNeeded()
// and before initDb(): a corrupt file previously rethrew out of initDb() straight
// into app.quit(), which made corruption an unrecoverable crash loop. Returns
// false only when the person chose to quit instead of recovering.
function resolveCorruptDatabaseBeforeOpen(): boolean {
  if (!app.isPackaged || previousShutdownWasClean) {
    console.log(`[db] skipped full integrity check (${app.isPackaged ? 'clean shutdown' : 'development build'})`)
    return true
  }
  const dbPath = path.join(app.getPath('userData'), 'daylens.sqlite')
  const startedAt = performance.now()
  const quick = checkDatabaseIntegrity(dbPath, 'quick')
  console.log(`[db] quick integrity check completed in ${Math.round(performance.now() - startedAt)}ms`)
  if (quick.ok) return true

  // quick_check flagged a fault. Confirm with a full scan before the destructive
  // recovery flow — it both rules out a transient read and yields the detailed
  // reason shown to the person and recorded.
  console.warn('[db] quick integrity check flagged a problem; running full scan:', quick.reason)
  const integrity = checkDatabaseIntegrity(dbPath, 'full')
  if (integrity.ok) return true

  console.error('[db] integrity check failed:', integrity.reason)
  if (!REAL_DAY_HARNESS && !SMOKE_TEST) {
    capture(ANALYTICS_EVENT.DATABASE_HEALTH, {
      stage: 'integrity_check',
      status: 'corrupt',
      surface: 'database',
    })
  }

  const backupDir = SMOKE_TEST || REAL_DAY_HARNESS
    ? null
    : selectLatestRestorableBackup(path.join(app.getPath('userData'), 'pre-update-backups'))

  // Harness runs have no one to ask — recover to a fresh database so the run
  // still produces a report instead of dying on the old crash loop.
  let choice: 'restore' | 'fresh' | 'quit' = 'fresh'
  if (!SMOKE_TEST && !REAL_DAY_HARNESS) {
    const buttons = backupDir
      ? ['Restore from backup', 'Start fresh', 'Quit']
      : ['Start fresh', 'Quit']
    const detail = backupDir
      ? 'Your local database is damaged and cannot be opened. You can restore the most recent backup, or start with a fresh database. The damaged file is kept next to the database either way.'
      : 'Your local database is damaged and cannot be opened, and no restorable backup was found. You can start with a fresh database. The damaged file is kept next to the database.'
    const response = dialog.showMessageBoxSync({
      type: 'error',
      title: `${APP_DISPLAY_NAME} database problem`,
      message: 'Your Daylens database needs repair',
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    })
    const picked = buttons[response]
    choice = picked === 'Restore from backup' ? 'restore' : picked === 'Start fresh' ? 'fresh' : 'quit'
  }

  if (choice === 'quit') return false

  const recovery = recoverCorruptDatabase(dbPath, backupDir, choice)
  console.log(
    `[db] corrupt database recovered via ${recovery.outcome}`,
    recovery.quarantinedTo ? `(damaged file kept at ${recovery.quarantinedTo})` : '',
  )
  if (recovery.outcome === 'restored') {
    // The restored copy predates any deletions made since that backup was
    // taken — replay the deletion journal so none of them resurrect.
    replayDeletionJournalAfterRestore('corruption restore')
  }
  if (!REAL_DAY_HARNESS && !SMOKE_TEST) {
    capture(ANALYTICS_EVENT.DATABASE_HEALTH, {
      stage: 'integrity_check',
      status: `recovered_${recovery.outcome}`,
      surface: 'database',
    })
  }
  return true
}

async function shutdownApp(options?: { awaitFinalSync?: boolean; backupBeforeExit?: boolean }): Promise<void> {
  if (deferredIntegrationStartup) {
    clearTimeout(deferredIntegrationStartup)
    deferredIntegrationStartup = null
  }
  stopMcpServer()
  stopRangeWorker()
  stopPermissionWatcher()
  stopStallWatchdog()
  stopCaptureServices()
  stopSync()
  stopMemoryIndexBackfill()
  stopMemoryMirrorBackfill()
  stopSemanticIndexBackfill()
  stopEmbedWorker()
  stopAIUsageRetentionSchedule()
  unregisterCommandPaletteShortcut()

  if (options?.awaitFinalSync && !REAL_DAY_HARNESS) {
    await Promise.race([
      syncNowForQuit(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
  }

  closeDb()
  if (databaseReady) {
    writeCleanShutdownMarker(app.getPath('userData'))
    databaseReady = false
  }

  // Back up userData if explicitly requested, OR if an update has been downloaded
  // and will run automatically on quit via autoInstallOnAppQuit.
  if (!REAL_DAY_HARNESS && (options?.backupBeforeExit || getUpdateAvailable() !== null)) {
    await backupUserDataForUpdate()
  }

  destroyTray()
  if (!REAL_DAY_HARNESS) await shutdown()
}

function showFatalStartupError(title: string, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  console.error(`[fatal] ${title}:`, err)
  if (SMOKE_TEST) {
    try {
      writeSmokeReport({
        ok: false,
        stage: title,
        reportPath: SMOKE_REPORT_PATH,
        platform: process.platform,
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        error: message,
      })
    } catch {
      // Best effort only.
    }
    return
  }
  if (!REAL_DAY_HARNESS) {
    capture(ANALYTICS_EVENT.APP_CRASHED, {
      process_type: 'main',
      reason: 'startup_failure',
    })
    captureException(err, {
      tags: {
        process_type: 'main',
        reason: 'startup_failure',
      },
    })
  }
  try {
    dialog.showErrorBox(title, message)
  } catch {
    // Best-effort only — if the dialog cannot be shown we still keep the error in stderr.
  }
}

function createWindow(): BrowserWindow {
  const iconExt = process.platform === 'darwin'
    ? 'icns'
    : process.platform === 'win32'
      ? 'ico'
      : 'png'
  const iconPath = path.join(__dirname, '..', '..', 'build', `icon.${iconExt}`)

  const win = new BrowserWindow({
    // Open wide enough to clear Timeline's compact breakpoint (innerWidth < 1120),
    // so the "Today" side panel is visible on first launch instead of forcing the
    // user to drag the window wider. minWidth stays below the breakpoint so the
    // compact layout still kicks in for anyone who deliberately shrinks the window.
    width: 1240,
    height: 760,
    minWidth: 820,
    minHeight: 580,
    icon: iconPath,
    // Hidden title bar on both platforms so the renderer owns the full chrome.
    // On macOS the traffic lights are preserved at trafficLightPosition.
    // On Windows this removes the native frame entirely — custom TitleBar handles drag.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 12 },
    // Prevent white flash before the renderer paints. Match the OS appearance
    // so there is no colour mismatch on light-mode systems.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0e14' : '#ffffff',
    webPreferences: {
      preload: resolvePreloadPath(__dirname),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  let smokeValidationStarted = false
  const maybeRunSmokeValidation = (trigger: SmokeValidationTrigger) => {
    if (!SMOKE_TEST) return
    if (smokeValidationStarted) return
    smokeValidationStarted = true
    void runSmokeValidation(win, trigger)
  }

  win.once('ready-to-show', () => {
    win.show()
    logStartupTiming('window visible')
    maybeRunSmokeValidation('ready-to-show')
  })
  win.webContents.once('did-finish-load', () => {
    logStartupTiming('renderer loaded')
    if (SMOKE_TEST && !win.isVisible()) win.show()
    maybeRunSmokeValidation('did-finish-load')
  })
  if (SMOKE_TEST) {
    setTimeout(() => maybeRunSmokeValidation('watchdog'), 20_000)
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    // DevTools on demand — Ctrl+Shift+I / Cmd+Option+I.
    // Auto-open was spawning a stray window on every reload.
  } else {
    const rendererPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    void win.loadFile(rendererPath).catch((err) => {
      showFatalStartupError('Daylens failed to load', err)
      app.quit()
    })
  }

  // Block in-window navigation to external URLs — open in system browser instead.
  // titleBarStyle: 'hidden' means no native close button, so if the Electron window
  // ever ends up on an external URL the user has no way to close or go back.
  function isAppUrl(url: string): boolean {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)) return true
    if (url.startsWith('file://')) return true
    return false
  }

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      try {
        const parsed = new URL(url)
        if (!REAL_DAY_HARNESS && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) void shell.openExternal(url)
      } catch { /* ignore malformed URLs */ }
    }
  })

  // Belt-and-suspenders: if will-navigate failed to block and navigation completed,
  // reload back to the app immediately so the user is never trapped on an external page.
  win.webContents.on('did-navigate', (_, url) => {
    if (!isAppUrl(url)) {
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
      } else {
        const rendererPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
        void win.loadFile(rendererPath)
      }
    }
  })

  // Block new window opens (window.open etc.) — redirect to system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (!REAL_DAY_HARNESS && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) void shell.openExternal(url)
    } catch { /* ignore */ }
    return { action: 'deny' }
  })

  win.webContents.on('render-process-gone', (_, details) => {
    if ((details.reason as string) === 'clean-exit' || (details.reason as string) === 'normal') {
      console.log('[renderer] process exited cleanly:', details.reason, details.exitCode)
      return
    }

    console.error('[renderer] process gone:', details.reason, details.exitCode)
    if (!REAL_DAY_HARNESS) {
      capture(ANALYTICS_EVENT.RENDERER_PROCESS_GONE, {
        process_type: 'renderer',
        reason: details.reason,
        status: 'error',
        surface: 'renderer',
      })
      capture(ANALYTICS_EVENT.APP_CRASHED, {
        process_type: 'renderer',
        reason: 'render_process_gone',
        status: 'error',
      })
      captureException(new Error(`Renderer process exited: ${details.reason}`), {
        extra: {
          exitCode: details.exitCode,
          reason: details.reason,
        },
        tags: {
          process_type: 'renderer',
          reason: 'render_process_gone',
        },
      })
    }
    dialog.showErrorBox(
      'Daylens renderer crashed',
      `The app display process exited unexpectedly (${details.reason}). Restarting...`,
    )
    win.reload()
  })

  win.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    console.error('[renderer] failed to load:', errorCode, errorDescription)
  })

  // Hide to tray on close — real quit only via tray menu
  win.on('close', (e) => {
    if (!isQuitting && shouldUseTrayBehavior() && hasTray()) {
      e.preventDefault()
      hideMainWindow()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
      setDailySummaryNotificationWindow(null)
      setDistractionAlertWindow(null)
      setSpendAlertWindow(null)
      setPermissionWatcherWindow(null)
    }
  })

  return win
}

// Shell — open external URLs safely (renderer cannot call shell.openExternal directly)
ipcMain.on('shell:open-external', (_e, url: string) => {
  if (!REAL_DAY_HARNESS && isAllowedExternalUrl(url)) {
    void shell.openExternal(url)
  }
})

ipcMain.handle('shell:open-path', async (_e, targetPath: string) => {
  if (!targetPath || typeof targetPath !== 'string') return
  await shell.openPath(targetPath)
})

// Window controls IPC — used by the custom TitleBar component in the renderer
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on('window:close', () => {
  if (!mainWindow) return
  if (!isQuitting && shouldUseTrayBehavior() && hasTray()) {
    hideMainWindow()
    return
  }
  mainWindow.close()
})

ipcMain.handle(IPC.APP.RELAUNCH, async () => {
  isQuitting = true
  app.relaunch()
  app.exit(0)
})

ipcMain.handle(IPC.APP.RESET_AND_UNINSTALL, async (event): Promise<{ started: boolean }> => {
  if (REAL_DAY_HARNESS) return { started: false }
  const window = BrowserWindow.fromWebContents(event.sender)
  const ask = async (options: Electron.MessageBoxOptions) => (
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
  )

  const { response } = await ask(uninstallPrimaryChoiceDialogOptions())
  const choice = await resolveUninstallChoice(response, async () => {
    const confirm = await ask({
      type: 'warning',
      title: 'Delete local data',
      message: 'Permanently delete your local Daylens data?',
      detail: 'Your timeline database, settings, and stored API keys on this computer will be deleted. This cannot be undone.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })
    return confirm.response
  })
  if (!choice.proceed) return { started: false }
  const { deleteLocalData } = choice

  isQuitting = true
  cancelPendingAutoInstall()
  await shutdownApp()
  await performUninstallCleanup({ deleteLocalData })
  app.exit(0)
  return { started: true }
})

ipcMain.handle(IPC.APP.COMPLETE_ONBOARDING, async () => {
  ensureTray()
  startBackgroundServices()
})

// The explicit capture-consent decision. Granting starts capture immediately —
// including mid-onboarding, where the proof step needs real capture before
// completion. Declining stops every capture adapter and leaves the rest of the
// app running; the per-sample consent gate in @shared/trackingControls blocks
// any straggler in between.
ipcMain.handle(IPC.APP.SET_CAPTURE_CONSENT, async (_e, granted: unknown) => {
  const decision = granted === true
  await setSettings({
    captureConsent: decision ? grantedCaptureConsent(Date.now()) : declinedCaptureConsent(Date.now()),
  })
  if (decision) {
    startBackgroundServices()
  } else {
    stopCaptureServices({ purgeSpool: true })
  }
  return getSettings().captureConsent
})

// The friendly computer name ("Christian's MacBook Pro") used to seed the
// onboarding name field's placeholder. On macOS the pretty name comes from
// `scutil --get ComputerName`; everywhere else (and on failure) fall back to the
// hostname with the noisy `.local` suffix stripped.
ipcMain.handle(IPC.APP.GET_COMPUTER_NAME, async (): Promise<string> => {
  const hostnameFallback = (): string => os.hostname().replace(/\.local$/i, '').trim()
  if (process.platform !== 'darwin') return hostnameFallback()
  try {
    const { execFile } = await import('node:child_process')
    const name = await new Promise<string>((resolve, reject) => {
      execFile('scutil', ['--get', 'ComputerName'], { timeout: 2000 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout.toString().trim())
      })
    })
    return name || hostnameFallback()
  } catch {
    return hostnameFallback()
  }
})

app.on('before-quit', (event) => {
  if (isInstallingUpdate()) {
    isQuitting = true
    return
  }
  if (isQuitting) return
  isQuitting = true

  // Prevent immediate quit so we can await the final sync.
  event.preventDefault()

  void (async () => {
    await shutdownApp({ awaitFinalSync: true })
    app.quit()
  })()
})

// Analytics IPC — renderer sends events through main process (network stays in main).
// The renderer only ever runs our own bundled code (contextIsolation on, no
// remote content, navigation locked to app URLs), but the bridge itself
// doesn't know that — it must not forward an arbitrary string as an event
// name to PostHog just because something called ipcRenderer.send.
ipcMain.on('analytics:capture', (_e, event: string, properties: Record<string, unknown>) => {
  if (REAL_DAY_HARNESS) return
  if (!isKnownAnalyticsEvent(event)) {
    console.warn('[analytics] ignored unknown event name from renderer:', event)
    return
  }
  capture(event, properties)
})

app.whenReady()
  .then(async () => {
    logStartupTiming('electron ready')
    if (REAL_DAY_HARNESS) {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          const devRendererAllowed = Boolean(
            MAIN_WINDOW_VITE_DEV_SERVER_URL
            && details.url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL),
          )
          callback({ cancel: !devRendererAllowed })
        },
      )
    }
    // App identity is set ONCE at module load (APP_USER_MODEL_ID =
    // 'com.daylens.desktop', line ~133) and must stay consistent with the
    // electron-builder appId and the notification bundle id. A previous win32
    // override to 'dev.christiantonny.daylens' split the identity: Windows
    // toasts (keyed to the installer shortcut's AUMID) silently failed, and
    // every upgrade risked duplicate login items + re-granted permissions.
    // One identity, all platforms.
    if (!REAL_DAY_HARNESS) {
      powerMonitor.on('resume', () => {
        resetDistractionStateOnResume()
        triggerDailySummaryChecks()
      })
    }
    // Must run before initSettings() — restores electron-store config.json from
    // backup if NSIS wiped userData during the update, before electron-store reads it.
    if (!REAL_DAY_HARNESS) await recoverFromUpdateIfNeeded()
    await initSettings()
    logStartupTiming('settings ready')
    // The smoke and real-day harnesses exist to exercise capture itself, on
    // isolated profiles, run deliberately by an operator — that run IS the
    // consent. Seed it so the consent gate doesn't blind the harness.
    if (SMOKE_TEST || REAL_DAY_HARNESS) {
      await setSettings({ captureConsent: grantedCaptureConsent(Date.now()) })
    }
    if (!REAL_DAY_HARNESS && !SMOKE_TEST) {
      void detectCLITools().catch(() => undefined)
    }
    const reconciledSettings = await reconcileOnboardingState()
    logStartupTiming('onboarding state ready')
    installApplicationMenu()
    if (!REAL_DAY_HARNESS && app.isPackaged && !SMOKE_TEST) {
      app.setLoginItemSettings({ openAtLogin: reconciledSettings.launchOnLogin })
      await syncLinuxLaunchOnLogin(reconciledSettings.launchOnLogin)
    }

    // Set firstLaunchDate on first run (used for day-7 feedback prompt)
    const s = getSettings()
    if (!REAL_DAY_HARNESS && !s.firstLaunchDate) {
      await setSettings({ firstLaunchDate: Date.now() })
    }

    if (!resolveCorruptDatabaseBeforeOpen()) {
      app.quit()
      return
    }
    initDb()
    databaseReady = true
    logStartupTiming('database ready')

    // DEV-200 restart recovery: an agent turn interrupted by a quit or crash
    // (still marked running / waiting on a card) has no live promise anymore,
    // so its checkpoint degrades to a clean paused(restart) row the chat
    // offers to resume — incomplete work is marked accurately, never assumed
    // done (agent-runtime-and-context.md §Sessions and interruption).
    try {
      const recovered = recoverInterruptedTurns(getDb())
      if (recovered > 0) console.log(`[agent:turn-state] recovered ${recovered} interrupted turn(s) as paused`)
    } catch (error) {
      console.warn('[agent:turn-state] restart recovery failed:', error)
    }

    // AI-telemetry retention: deferred first pass after launch, then
    // daily. Wired here — not in startBackgroundServices — because the DB
    // needs pruning even when tracking is disabled or paused.
    if (!REAL_DAY_HARNESS && !SMOKE_TEST) startAIUsageRetentionSchedule()

    // On-demand enrichment backfill for wrap / Analyze of a HISTORICAL day
    // (the background collector only walks today and yesterday). Wired here —
    // not in startBackgroundServices — because regenerating an old day must
    // work even when tracking is disabled or paused; capture consent is still
    // enforced inside collection.
    if (!REAL_DAY_HARNESS && !SMOKE_TEST) {
      registerExternalSignalBackfill((date) => ensureExternalSignalsForDate(getDb(), date))
    }

    // The process monitor (Windows + Linux) is started in startBackgroundServices
    // once tracking is enabled; diagnostics requests reuse the same instance.

    registerDbHandlers()
    registerEntityHandlers()
    registerErrorHandlers()
    registerDebugHandlers()
    registerFocusHandlers()
    registerAIHandlers()
    registerSettingsHandlers()
    registerBillingHandlers()
    registerIntercomHandlers()
    registerSearchHandlers()
    registerSyncHandlers()
    registerDistractionAlerterHandlers()
    registerNotificationHandlers()
    registerExportHandlers()
    registerScreenContextHandlers()
    logStartupTiming('IPC handlers ready')

    // IPC: renderer drains any pending notification-route the main process
    // queued before the renderer's listener was attached.
    ipcMain.handle('navigation:consume-pending', () => consumePendingNavigationRoute())
    // IPC: dev shortcut fires a real main-process daily-summary notification.
    ipcMain.handle('dev:fire-test-daily-notification', () => (
      REAL_DAY_HARNESS ? null : fireTestDailyNotification()
    ))

    mainWindow = createWindow()
    logStartupTiming('window created')
    const startupWindow = mainWindow
    setDailySummaryNotificationWindow(mainWindow)
    setDistractionAlertWindow(mainWindow)
    setSpendAlertWindow(mainWindow)
    setPermissionWatcherWindow(mainWindow)
    startupWindow.once('show', () => {
      setImmediate(() => {
        if (isQuitting || startupWindow.isDestroyed()) return
        if (!REAL_DAY_HARNESS) ensureTray()
        initUpdater(startupWindow, { diagnosticsOnly: SMOKE_TEST })
        startBackgroundServices()
        if (!REAL_DAY_HARNESS && !SMOKE_TEST) void prewarmBrowserRegistry()
        if (!REAL_DAY_HARNESS) {
          void (async () => {
            if (!SMOKE_TEST) await initAnalytics()
            const launchSettings = getSettings()
            const launchProvider = launchSettings.aiProvider
            const hasAiProvider = SMOKE_TEST
              ? false
              : launchProvider === 'claude-cli' || launchProvider === 'chatgpt-cli' || launchProvider === 'gemini-cli' || launchProvider === 'codex-cli'
                ? true
                : await hasApiKey(launchProvider)
            const billingAccess = SMOKE_TEST ? null : await getBillingAccess().catch(() => null)
            const daysSinceInstall = launchSettings.firstLaunchDate > 0
              ? Math.floor((Date.now() - launchSettings.firstLaunchDate) / 86_400_000)
              : 0
            capture(ANALYTICS_EVENT.APP_LAUNCHED, {
              version: app.getVersion(),
              days_since_install: daysSinceInstall,
              has_completed_onboarding: reconciledSettings.onboardingComplete,
              subscription_status: billingAccess?.mode ?? 'unavailable',
              has_ai_provider: hasAiProvider,
              os_version: os.release(),
            })
            logStartupTiming('launch telemetry ready')
          })().catch((error) => {
            console.warn('[startup] launch telemetry failed:', error)
          })
        }
        if (!REAL_DAY_HARNESS) {
          try {
            if (runPendingDerivedStateReset(getDb())) {
              console.log('[derived-state] performed deferred reset after version change')
            }
          } catch (err) {
            console.warn('[derived-state] deferred reset failed:', err)
          }
        }
        logStartupTiming('post-paint services started')
      })
    })

    // Push OS appearance changes to all renderer windows so the theme updates
    // in real time when the user switches dark/light mode in System Settings.
    // Only fires when the user setting is 'system' — the renderer ignores the
    // push if a pinned theme is active (handled in App.tsx).
    nativeTheme.on('updated', () => {
      const appearance = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.SYSTEM.THEME_CHANGED, appearance)
        }
      }
    })
    if (!REAL_DAY_HARNESS) {
      registerUpdaterShutdown(async () => {
        isQuitting = true
        await shutdownApp({ awaitFinalSync: true, backupBeforeExit: true })
      })
    }

    if (!REAL_DAY_HARNESS) {
      if (!SMOKE_TEST) registerCommandPaletteShortcut(() => mainWindow)
    }

    // Optional integrations spawn subprocesses / open large stores, so start
    // them after the window is up rather than on the pre-paint critical path.
    // Tracked + isQuitting-guarded so a quit/update inside this 3s window can't
    // start services during teardown.
    if (!REAL_DAY_HARNESS) {
      deferredIntegrationStartup = setTimeout(() => {
        deferredIntegrationStartup = null
        if (isQuitting) return
        if (getSettings().mcpServerEnabled) {
          startMcpServer()
        }
      }, 3_000)
    }

  })
  .catch((err) => {
    showFatalStartupError('Daylens failed to start', err)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (REAL_DAY_HARNESS) {
    isQuitting = true
    void shutdownApp({ awaitFinalSync: false }).finally(() => app.quit())
    return
  }
  // Keep the background process (and tracking) alive whenever tracking is meant
  // to be running. This closes a Windows-specific silent-stop path: if the tray
  // icon fails to create (hasTray() === false), closing the window used to quit
  // the whole app and stop capture without the user knowing. Now capture
  // survives a window close on every platform once tracking is on; the user
  // gets the window back via a Dock/Start-menu relaunch (second-instance →
  // showMainWindow). An explicit Quit (tray menu / Cmd-Q) sets isQuitting and
  // still exits. Before onboarding completes, tracking isn't running, so the
  // old tray/darwin rule still governs whether to quit.
  const trackingShouldRun = shouldStartTrackingForSettings(getSettings())
  const persistForTray = shouldUseTrayBehavior() && (process.platform === 'darwin' || hasTray())
  if (trackingShouldRun || persistForTray) return
  isQuitting = true
  void (async () => {
    await shutdownApp({ awaitFinalSync: false })
    app.quit()
  })()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
    setDailySummaryNotificationWindow(mainWindow)
    setDistractionAlertWindow(mainWindow)
    setSpendAlertWindow(mainWindow)
    setPermissionWatcherWindow(mainWindow)
    ensureTray()
    startBackgroundServices()
  } else {
    showMainWindow()
  }
})

// Focus the existing window if a second instance tries to open
app.on('second-instance', () => {
  showMainWindow()
})
