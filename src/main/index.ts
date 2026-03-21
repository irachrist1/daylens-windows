// ─── Global error handlers — must be first, before any imports' side effects ──
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err)
  try {
    const { capture: analyticsCapture } = require('./services/analytics') as typeof import('./services/analytics')
    analyticsCapture('crash', { error_name: err.name, error_message: err.message, stack: err.stack })
  } catch { /* analytics may not be ready */ }
  try {
    const { dialog: d } = require('electron') as typeof import('electron')
    d.showErrorBox('Daylens crashed', `${err.name}: ${err.message}\n\nPlease restart Daylens.`)
  } catch { /* dialog may not be ready */ }
})

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason)
})

import { BrowserWindow, app, dialog, ipcMain, nativeImage, shell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { capture, shutdown } from './services/analytics'
import { registerAIHandlers } from './ipc/ai.handlers'
import { registerDbHandlers } from './ipc/db.handlers'
import { registerDebugHandlers } from './ipc/debug.handlers'
import { registerFocusHandlers } from './ipc/focus.handlers'
import { registerSettingsHandlers } from './ipc/settings.handlers'
import { registerSyncHandlers } from './ipc/sync.handlers'
import { initDb, closeDb } from './services/database'
import { initSettings, getSettings, setSettings } from './services/settings'
import { startTracking, stopTracking, trackingStatus } from './services/tracking'
import { startBrowserTracking, stopBrowserTracking } from './services/browser'
import { startSync, stopSync, finalizePreviousDay } from './services/syncUploader'
import { computeAllMissingSummaries } from './db/dailySummaries'
import { backfillWindowsHistory } from './services/windowsHistory'
import { createTray, destroyTray } from './tray'
import { initUpdater } from './services/updater'

// Fix macOS path collision with native Swift companion app.
// Electron defaults userData to ~/Library/Application Support/<productName> which on macOS
// would be "Daylens" — the same folder the Swift app owns. Must be called before app.whenReady().
if (process.platform === 'darwin') {
  app.setPath('userData', path.join(app.getPath('appData'), 'DaylensWindows'))
  // Set Dock icon from build assets so it shows the app icon during development
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

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null
// Set to true once the user explicitly quits via tray menu
let isQuitting = false
// Set to latest version string when a newer release is detected
export let updateAvailable: string | null = null

function showFatalStartupError(title: string, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  console.error(`[fatal] ${title}:`, err)
  try {
    dialog.showErrorBox(title, message)
  } catch {
    // Best-effort only — if the dialog cannot be shown we still keep the error in stderr.
  }
}

function createWindow(): BrowserWindow {
  const iconExt = process.platform === 'darwin' ? 'icns' : 'ico'
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
    backgroundColor: '#051425',
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

  win.once('ready-to-show', () => win.show())

  win.webContents.on('render-process-gone', (_, details) => {
    console.error('[renderer] process gone:', details.reason, details.exitCode)
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
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
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

// Window controls IPC — used by the custom TitleBar component in the renderer
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.on('window:close', () => {
  if (!mainWindow) return
  if (!isQuitting) mainWindow.hide()
})

app.on('before-quit', () => {
  isQuitting = true
  stopTracking()
  stopBrowserTracking()
  stopSync()
  closeDb()
  destroyTray()
  shutdown()
})

// Analytics IPC — renderer sends events through main process (network stays in main)
ipcMain.on('analytics:capture', (_e, event: string, properties: Record<string, unknown>) => {
  capture(event, properties)
})

app.whenReady()
  .then(async () => {
    await initSettings()
    app.setLoginItemSettings({ openAtLogin: getSettings().launchOnLogin })

    // Set firstLaunchDate on first run (used for day-7 feedback prompt)
    const s = getSettings()
    if (!s.firstLaunchDate) {
      await setSettings({ firstLaunchDate: Date.now() })
    }

    capture('app_launched', {
      version: app.getVersion(),
      platform: process.platform,
      os_version: os.release(),
      onboarding_complete: getSettings().onboardingComplete,
    })

    initDb()

    registerDbHandlers()
    registerDebugHandlers()
    registerFocusHandlers()
    registerAIHandlers()
    registerSettingsHandlers()
    registerSyncHandlers()

    mainWindow = createWindow()
    createTray(mainWindow)
    initUpdater(mainWindow)

    startTracking()
    startBrowserTracking()
    startSync()

    // Deferred 3s — after window is visible
    setTimeout(() => {
      try { backfillWindowsHistory() } catch (err) { console.warn('[init] win history:', err) }
    }, 3_000)

    // Deferred 5s — report tracking engine health
    setTimeout(() => {
      capture('tracking_engine_status', {
        status: trackingStatus.moduleSource ? 'ok' : 'error',
        module_source: trackingStatus.moduleSource,
        ...(trackingStatus.loadError ? { error_message: trackingStatus.loadError } : {}),
      })
    }, 5_000)

    // Deferred 10s — background maintenance
    setTimeout(() => {
      try { computeAllMissingSummaries() } catch (err) { console.warn('[init] summaries:', err) }
      setTimeout(() => finalizePreviousDay(), 0)
    }, 10_000)
  })
  .catch((err) => {
    showFatalStartupError('Daylens failed to start', err)
    app.quit()
  })

app.on('window-all-closed', () => {
  // On macOS keep running in tray; on Windows quit when all windows closed
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  } else {
    mainWindow?.show()
  }
})

// Focus the existing window if a second instance tries to open
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})
