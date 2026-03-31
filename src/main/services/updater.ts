import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { capture } from './analytics'

export interface UpdaterState {
  status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'installing'
  version: string | null
  progressPct: number | null
  errorMessage: string | null
}

let _updateAvailable: string | null = null
export function getUpdateAvailable(): string | null { return _updateAvailable }

let _installingUpdate = false
let _statusWindow: BrowserWindow | null = null
let _beforeInstall: (() => Promise<void>) | null = null
let _state: UpdaterState = {
  status: 'idle',
  version: null,
  progressPct: null,
  errorMessage: null,
}

export function isInstallingUpdate(): boolean { return _installingUpdate }
export function registerUpdaterShutdown(fn: () => Promise<void>): void { _beforeInstall = fn }
export function getUpdaterState(): UpdaterState { return { ..._state } }

function emitState(): void {
  _statusWindow?.webContents.send('update:status', getUpdaterState())
}

function setUpdaterState(partial: Partial<UpdaterState>): void {
  _state = { ..._state, ...partial }
  emitState()
}

export function initUpdater(win: BrowserWindow): void {
  _statusWindow = win
  emitState()

  // Only run on Windows — macOS auto-updates require code signing
  if (process.platform !== 'win32') return
  // Only run in packaged builds — not in dev
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setUpdaterState({
      status: 'checking',
      errorMessage: null,
      progressPct: null,
    })
  })

  autoUpdater.on('update-available', (info) => {
    _updateAvailable = info.version
    capture('update_available', { version: info.version })
    setUpdaterState({
      status: 'downloading',
      version: info.version,
      progressPct: 0,
      errorMessage: null,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setUpdaterState({
      status: 'downloading',
      progressPct: Math.max(0, Math.min(100, Math.round(progress.percent))),
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    capture('update_downloaded', { version: info.version })
    setUpdaterState({
      status: 'downloaded',
      version: info.version,
      progressPct: 100,
      errorMessage: null,
    })
  })

  autoUpdater.on('update-not-available', () => {
    _updateAvailable = null
    setUpdaterState({
      status: 'not-available',
      version: app.getVersion(),
      progressPct: null,
      errorMessage: null,
    })
  })

  autoUpdater.on('error', (err) => {
    _updateAvailable = null
    capture('update_error', { error_message: err.message })
    setUpdaterState({
      status: 'error',
      errorMessage: err.message,
      progressPct: null,
    })
  })

  ipcMain.handle('update:get-status', () => {
    return getUpdaterState()
  })

  ipcMain.handle('update:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // errors are reflected through the updater state
    }
    return getUpdaterState()
  })

  ipcMain.handle('update:install', async () => {
    if (_state.status !== 'downloaded' || _installingUpdate) return false

    try {
      setUpdaterState({ status: 'installing', errorMessage: null })

      if (_beforeInstall) {
        await _beforeInstall()
      }

      _installingUpdate = true

      setImmediate(() => {
        autoUpdater.quitAndInstall()
      })

      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Daylens could not prepare the update install.'
      _installingUpdate = false
      capture('update_error', { error_message: message })
      setUpdaterState({
        status: 'error',
        errorMessage: message,
      })
      return false
    }
  })

  // Check 10s after launch so it doesn't slow startup
  setTimeout(() => {
    console.log('[updater] checking for updates…')
    autoUpdater.checkForUpdates().catch(() => { /* silent */ })
  }, 10_000)
}
