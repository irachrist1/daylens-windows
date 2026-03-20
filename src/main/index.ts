import { BrowserWindow, app, ipcMain } from 'electron'
import path from 'node:path'
import { registerAIHandlers } from './ipc/ai.handlers'
import { registerDbHandlers } from './ipc/db.handlers'
import { registerFocusHandlers } from './ipc/focus.handlers'
import { registerSettingsHandlers } from './ipc/settings.handlers'
import { initDb, closeDb } from './services/database'
import { initSettings } from './services/settings'
import { startTracking, stopTracking } from './services/tracking'
import { createTray, destroyTray } from './tray'

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
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    // Hidden title bar on both platforms so the renderer owns the full chrome.
    // On macOS the traffic lights are preserved at trafficLightPosition.
    // On Windows this removes the native frame entirely — custom TitleBar handles drag.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 12 },
    // Prevent white flash before the renderer paints
    backgroundColor: '#051425',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
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
  closeDb()
  destroyTray()
})

app.whenReady().then(async () => {
  await initSettings()
  initDb()

  registerDbHandlers()
  registerFocusHandlers()
  registerAIHandlers()
  registerSettingsHandlers()

  mainWindow = createWindow()
  createTray(mainWindow)

  startTracking()
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
