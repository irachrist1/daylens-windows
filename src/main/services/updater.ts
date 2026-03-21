import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { capture } from './analytics'

export function initUpdater(win: BrowserWindow): void {
  // Only run on Windows — macOS auto-updates require code signing
  if (process.platform !== 'win32') return
  // Only run in packaged builds — not in dev
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    capture('update_available', { version: info.version })
    win.webContents.send('update:status', { status: 'available', version: info.version })
  })

  autoUpdater.on('update-downloaded', (info) => {
    capture('update_downloaded', { version: info.version })
    win.webContents.send('update:status', { status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    capture('update_error', { error_message: err.message })
  })

  ipcMain.on('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  // Check 10s after launch so it doesn't slow startup
  setTimeout(() => {
    console.log('[updater] checking for updates…')
    autoUpdater.checkForUpdates().catch(() => { /* silent */ })
  }, 10_000)
}
