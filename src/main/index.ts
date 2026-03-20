import { BrowserWindow, app } from 'electron'
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

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

let mainWindow: BrowserWindow | null = null
// Set to true once the user explicitly quits (Cmd+Q / Tray → Quit)
let isQuitting = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for preload to access Node APIs
    },
    show: false,
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }

  win.once('ready-to-show', () => win.show())

  // Hide to tray on close — real quit only via tray menu or Cmd+Q
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  return win
}

app.on('before-quit', () => {
  isQuitting = true
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
  // On macOS keep running; on Windows quit when all windows are closed
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  } else {
    mainWindow?.show()
  }
})

app.on('before-quit', () => {
  stopTracking()
  closeDb()
  destroyTray()
})
