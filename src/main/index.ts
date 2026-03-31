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
import fs from 'node:fs'
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
import { startSync, stopSync, finalizePreviousDay, syncNowForQuit } from './services/syncUploader'
import { computeAllMissingSummaries } from './db/dailySummaries'
import { backfillWindowsHistory } from './services/windowsHistory'
import { createTray, destroyTray } from './tray'
import { initUpdater, isInstallingUpdate, registerUpdaterShutdown } from './services/updater'
import { startDailySummaryNotifier } from './services/dailySummaryNotifier'
import { startDistractionAlerter } from './services/distractionAlerter'
import { startProcessMonitor, stopProcessMonitor } from './services/processMonitor'

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

// Pin taskbar icon correctly on Windows
app.setAppUserModelId('com.daylens.windows')

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null
// Set to true once the user explicitly quits via tray menu
let isQuitting = false
// Set to latest version string when a newer release is detected
export let updateAvailable: string | null = null

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

    console.log('[update] backed up user data to', backupDir)
  } catch (err) {
    console.warn('[update] backup failed:', err)
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

  if (options?.backupBeforeExit) {
    await backupUserDataForUpdate()
  }

  destroyTray()
  shutdown()
}

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

  win.once('ready-to-show', () => win.show())

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
  capture(event, properties)
})

app.whenReady()
  .then(async () => {
    await initSettings()
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: getSettings().launchOnLogin })
    }

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
    startProcessMonitor()

    registerDbHandlers()
    registerDebugHandlers()
    registerFocusHandlers()
    registerAIHandlers()
    registerSettingsHandlers()
    registerSyncHandlers()

    mainWindow = createWindow()
    createTray(mainWindow)
    initUpdater(mainWindow)
    registerUpdaterShutdown(async () => {
      isQuitting = true
      await shutdownApp({ awaitFinalSync: true, backupBeforeExit: true })
    })

    startTracking()
    startSync()
    startDailySummaryNotifier()
    startDistractionAlerter()

    // Deferred 5s — after window is visible: browser tracking + Windows history backfill (#4, #5)
    setTimeout(() => {
      startBrowserTracking()
      setImmediate(() => {
        try { backfillWindowsHistory() } catch (err) { console.warn('[init] win history:', err) }
      })
    }, 5_000)

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
  // The app runs in the system tray on all platforms — do not quit here.
  // The only exit path is the tray "Quit" menu item which sets isQuitting = true.
  // On macOS (no tray on some versions), still keep running via app.on('activate').
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
