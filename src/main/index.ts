import { BrowserWindow, app, ipcMain, nativeImage } from 'electron'
import path from 'node:path'
import { registerAIHandlers } from './ipc/ai.handlers'
import { registerDbHandlers } from './ipc/db.handlers'
import { registerDebugHandlers } from './ipc/debug.handlers'
import { registerFocusHandlers } from './ipc/focus.handlers'
import { registerSettingsHandlers } from './ipc/settings.handlers'
import { initDb, closeDb } from './services/database'
import { initSettings } from './services/settings'
import { startTracking, stopTracking } from './services/tracking'
import { startBrowserTracking, stopBrowserTracking } from './services/browser'
import { startSync, stopSync, finalizePreviousDay } from './services/syncUploader'
import { computeAllMissingSummaries } from './db/dailySummaries'
import { createTray, destroyTray } from './tray'

// Fix macOS path collision with native Swift companion app.
// Electron defaults userData to ~/Library/Application Support/<productName> which on macOS
// would be "Daylens" — the same folder the Swift app owns. Must be called before app.whenReady().
if (process.platform === 'darwin') {
  app.setPath('userData', path.join(app.getPath('appData'), 'DaylensWindows'))
  // Set Dock icon from build assets so it shows the app icon during development
  const dockIcon = path.join(__dirname, '..', '..', 'build', 'icon.png')
  try { app.dock.setIcon(nativeImage.createFromPath(dockIcon)) } catch { /* packaged builds embed the icon */ }
}

// Handle Squirrel events on Windows (installer lifecycle)
if (require('electron-squirrel-startup')) app.quit()

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
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }

  win.once('ready-to-show', () => win.show())

  // Hide to tray on close — real quit only via tray menu
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  return win
}

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
})

app.whenReady().then(async () => {
  await initSettings()
  initDb()

  registerDbHandlers()
  registerDebugHandlers()
  registerFocusHandlers()
  registerAIHandlers()
  registerSettingsHandlers()

  mainWindow = createWindow()
  createTray(mainWindow)

  startTracking()
  startBrowserTracking()
  startSync()

  // Compute any missing daily summaries in the background
  try { computeAllMissingSummaries() } catch (err) { console.warn('[init] daily summaries:', err) }

  // Finalize previous day's snapshot shortly after startup
  setTimeout(() => finalizePreviousDay(), 30_000)
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
