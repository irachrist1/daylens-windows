// ─── Global error handlers — must be first, before any imports' side effects ──
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err)
  try {
    const {
      capture: analyticsCapture,
      captureException: analyticsCaptureException,
    } = require('./services/analytics') as typeof import('./services/analytics')
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
  try {
    const { dialog: d } = require('electron') as typeof import('electron')
    d.showErrorBox('Daylens crashed', `${err.name}: ${err.message}\n\nPlease restart Daylens.`)
  } catch { /* dialog may not be ready */ }
})

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason)
  try {
    const {
      capture: analyticsCapture,
      captureException: analyticsCaptureException,
    } = require('./services/analytics') as typeof import('./services/analytics')
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
})

import { BrowserWindow, Menu, app, dialog, ipcMain, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ANALYTICS_EVENT, classifyFailureKind, type AnalyticsEventName } from '@shared/analytics'
import { capture, captureException, initAnalytics, shutdown } from './services/analytics'
import { registerAIHandlers } from './ipc/ai.handlers'
import { registerDbHandlers } from './ipc/db.handlers'
import { registerDebugHandlers } from './ipc/debug.handlers'
import { registerFocusHandlers } from './ipc/focus.handlers'
import { registerSettingsHandlers } from './ipc/settings.handlers'
import { registerSyncHandlers } from './ipc/sync.handlers'
import { initDb, closeDb } from './services/database'
import { hasApiKey, initSettings, getSettings, setSettings } from './services/settings'
import { startTracking, stopTracking, trackingStatus } from './services/tracking'
import { getBrowserStatus, startBrowserTracking, stopBrowserTracking } from './services/browser'
import { startSync, stopSync, finalizePreviousDay, syncNowForQuit } from './services/syncUploader'
import { computeAllMissingSummaries } from './db/dailySummaries'
import { backfillWindowsHistory } from './services/windowsHistory'
import { createTray, destroyTray, getTrayDiagnostics, hasTray } from './tray'
import { getUpdaterState, initUpdater, isInstallingUpdate, registerUpdaterShutdown, getUpdateAvailable } from './services/updater'
import { setDailySummaryNotificationWindow, startDailySummaryNotifier } from './services/dailySummaryNotifier'
import { registerDistractionAlerterHandlers, setDistractionAlertWindow, startDistractionAlerter } from './services/distractionAlerter'
import { getLinuxDesktopDiagnostics, syncLinuxLaunchOnLogin } from './services/linuxDesktop'
import { startProcessMonitor, stopProcessMonitor } from './services/processMonitor'
import { reconcileOnboardingState } from './services/onboarding'
import { shouldStartTrackingForSettings } from './lib/onboardingState'
import { IPC } from '@shared/types'
import {
  APP_DISPLAY_NAME,
  chooseUserDataPath,
  createBackupManifest,
  isHealthyUserDataState,
  selectLatestRestorableBackup,
} from './services/userData'

const APP_USER_MODEL_ID = 'com.daylens.desktop'
const SMOKE_TEST = process.env.DAYLENS_SMOKE_TEST === '1'
const SMOKE_REPORT_PATH = process.env.DAYLENS_SMOKE_REPORT_PATH?.trim() || path.join(os.tmpdir(), 'daylens-smoke-report.json')

function configureUserDataPath(): void {
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

// Pin taskbar icon correctly on Windows
app.setAppUserModelId(APP_USER_MODEL_ID)

if (process.platform === 'linux' && SMOKE_TEST) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null
// Set to true once the user explicitly quits via tray menu
let isQuitting = false
let backgroundServicesStarted = false
// Set to latest version string when a newer release is detected
export let updateAvailable: string | null = null

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

async function runSmokeValidation(win: BrowserWindow): Promise<void> {
  try {
    await waitForRendererLoad(win)
    await new Promise((resolve) => setTimeout(resolve, 2_500))

    writeSmokeReport({
      ok: true,
      stage: 'smoke-complete',
      reportPath: SMOKE_REPORT_PATH,
      platform: process.platform,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      windowVisible: win.isVisible(),
      currentSession: null,
      trackingStatus: { ...trackingStatus },
      linuxDesktop: getLinuxDesktopDiagnostics(),
      browserStatus: getBrowserStatus(),
      tray: getTrayDiagnostics(),
      updater: getUpdaterState(),
    })

    isQuitting = true
    await shutdownApp()
    app.exit(0)
  } catch (err) {
    writeSmokeReport({
      ok: false,
      stage: 'smoke-runtime',
      reportPath: SMOKE_REPORT_PATH,
      platform: process.platform,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack ?? null : null,
      trackingStatus: { ...trackingStatus },
      linuxDesktop: getLinuxDesktopDiagnostics(),
      browserStatus: getBrowserStatus(),
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

function startBackgroundServices(): void {
  if (backgroundServicesStarted) return
  if (!shouldStartTrackingForSettings(getSettings())) return

  startTracking()
  startSync()
  startDailySummaryNotifier(mainWindow)
  setDistractionAlertWindow(mainWindow)
  startDistractionAlerter()
  backgroundServicesStarted = true

  setTimeout(() => {
    startBrowserTracking()
    setImmediate(() => {
      try { backfillWindowsHistory() } catch (err) { console.warn('[init] win history:', err) }
    })
  }, 5_000)

  setTimeout(() => {
    capture(ANALYTICS_EVENT.TRACKING_ENGINE_HEALTH, {
      module_source: trackingStatus.moduleSource,
      status: trackingStatus.moduleSource ? 'ok' : 'error',
      surface: 'tracking',
      ...(trackingStatus.loadError ? { failure_kind: classifyFailureKind(trackingStatus.loadError) } : {}),
    })
  }, 5_000)

  setTimeout(() => {
    try { computeAllMissingSummaries() } catch (err) { console.warn('[init] summaries:', err) }
    setTimeout(() => finalizePreviousDay(), 0)
  }, 10_000)
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
    for (const entry of fs.readdirSync(userDataPath)) {
      if (entry === path.basename(backupRoot)) continue
      fs.cpSync(path.join(userDataPath, entry), path.join(backupDir, entry), {
        recursive: true,
        force: true,
      })
    }

    const backups = fs
      .readdirSync(backupRoot)
      .sort()
    while (backups.length > 3) {
      const oldest = backups.shift()
      if (!oldest) break
      fs.rmSync(path.join(backupRoot, oldest), { recursive: true, force: true })
    }

    const manifest = createBackupManifest(userDataPath, app.getVersion())
    fs.writeFileSync(path.join(backupDir, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    console.log('[update] backed up user data to', backupDir)
  } catch (err) {
    console.warn('[update] backup failed:', err)
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
      return
    }
    console.warn('[update] post-upgrade blank state detected but no valid backup found')
  } catch (err) {
    console.warn('[update] recovery check failed:', err)
  }
}

async function shutdownApp(options?: { awaitFinalSync?: boolean; backupBeforeExit?: boolean }): Promise<void> {
  stopTracking()
  stopBrowserTracking()
  stopSync()
  stopProcessMonitor()

  if (options?.awaitFinalSync) {
    await Promise.race([
      syncNowForQuit(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
  }

  closeDb()

  // Back up userData if explicitly requested, OR if an update has been downloaded
  // and will run automatically on quit via autoInstallOnAppQuit.
  if (options?.backupBeforeExit || getUpdateAvailable() !== null) {
    await backupUserDataForUpdate()
  }

  destroyTray()
  await shutdown()
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
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    icon: iconPath,
    // Hidden title bar on both platforms so the renderer owns the full chrome.
    // On macOS the traffic lights are preserved at trafficLightPosition.
    // On Windows this removes the native frame entirely — custom TitleBar handles drag.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 12 },
    // Prevent white flash before the renderer paints
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

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

  win.once('ready-to-show', () => {
    win.show()
    if (SMOKE_TEST && process.platform === 'linux') {
      void runSmokeValidation(win)
    }
  })

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
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url)
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
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url)
    } catch { /* ignore */ }
    return { action: 'deny' }
  })

  win.webContents.on('render-process-gone', (_, details) => {
    console.error('[renderer] process gone:', details.reason, details.exitCode)
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
    }
  })

  return win
}

// Shell — open external URLs safely (renderer cannot call shell.openExternal directly)
ipcMain.on('shell:open-external', (_e, url: string) => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') {
      void shell.openExternal(url)
    }
  } catch {
    // Ignore malformed URLs
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
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
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

ipcMain.handle(IPC.APP.COMPLETE_ONBOARDING, async () => {
  ensureTray()
  startBackgroundServices()
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

// Analytics IPC — renderer sends events through main process (network stays in main)
ipcMain.on('analytics:capture', (_e, event: string, properties: Record<string, unknown>) => {
  capture(event as AnalyticsEventName, properties)
})

app.whenReady()
  .then(async () => {
    // Must run before initSettings() — restores electron-store config.json from
    // backup if NSIS wiped userData during the update, before electron-store reads it.
    await recoverFromUpdateIfNeeded()
    await initSettings()
    const reconciledSettings = await reconcileOnboardingState()
    await initAnalytics()
    installApplicationMenu()
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: getSettings().launchOnLogin })
      await syncLinuxLaunchOnLogin(getSettings().launchOnLogin)
    }

    // Set firstLaunchDate on first run (used for day-7 feedback prompt)
    const s = getSettings()
    if (!s.firstLaunchDate) {
      await setSettings({ firstLaunchDate: Date.now() })
    }

    const launchSettings = getSettings()
    const launchProvider = launchSettings.aiChatProvider ?? launchSettings.aiProvider
    const hasAiProvider = launchProvider === 'claude-cli' || launchProvider === 'codex-cli'
      ? true
      : await hasApiKey(launchProvider)

    capture(ANALYTICS_EVENT.APP_LAUNCHED, {
      has_ai_provider: hasAiProvider,
      os_version: os.release(),
      onboarding_complete: reconciledSettings.onboardingComplete,
    })

    initDb()
    startProcessMonitor()

    registerDbHandlers()
    registerDebugHandlers()
    registerFocusHandlers()
    registerAIHandlers()
    registerSettingsHandlers()
    registerSyncHandlers()
    registerDistractionAlerterHandlers()

    mainWindow = createWindow()
    setDailySummaryNotificationWindow(mainWindow)
    setDistractionAlertWindow(mainWindow)
    ensureTray()
    initUpdater(mainWindow)
    registerUpdaterShutdown(async () => {
      isQuitting = true
      await shutdownApp({ awaitFinalSync: true, backupBeforeExit: true })
    })

    startBackgroundServices()

    if (SMOKE_TEST && process.platform === 'linux') {
      startBrowserTracking()
    }
  })
  .catch((err) => {
    showFatalStartupError('Daylens failed to start', err)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (!shouldUseTrayBehavior() || (process.platform !== 'darwin' && !hasTray())) {
    isQuitting = true
    void (async () => {
      await shutdownApp({ awaitFinalSync: false })
      app.quit()
    })()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
    setDailySummaryNotificationWindow(mainWindow)
    setDistractionAlertWindow(mainWindow)
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
