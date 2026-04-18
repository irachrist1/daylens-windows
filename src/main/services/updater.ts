import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { capture, captureException } from './analytics'
import { getLinuxPackageDiagnostics, type LinuxPackageType } from './linuxDesktop'

export interface UpdaterState {
  status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'installing'
  version: string | null
  progressPct: number | null
  errorMessage: string | null
  releaseName: string | null
  releaseNotesText: string | null
  releaseDate: string | null
  packageType: LinuxPackageType
  supported: boolean
  supportMessage: string | null
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
  releaseName: null,
  releaseNotesText: null,
  releaseDate: null,
  packageType: null,
  supported: false,
  supportMessage: null,
}

export function isInstallingUpdate(): boolean { return _installingUpdate }
export function registerUpdaterShutdown(fn: () => Promise<void>): void { _beforeInstall = fn }
export function getUpdaterState(): UpdaterState { return { ..._state } }

function getAutoUpdateSupport(): { supported: boolean; message: string | null; packageType: LinuxPackageType } {
  if (!app.isPackaged) {
    return {
      supported: false,
      message: 'Automatic updates are only available in packaged builds.',
      packageType: null,
    }
  }

  if (process.platform === 'win32') {
    return {
      supported: true,
      message: null,
      packageType: null,
    }
  }

  if (process.platform === 'linux') {
    const packageDiagnostics = getLinuxPackageDiagnostics()
    const packageType = packageDiagnostics?.packageType ?? null

    if (packageType === 'appimage') {
      return {
        supported: true,
        message: 'AppImage runtime detected. Daylens can download and apply updates for this install.',
        packageType,
      }
    }

    if (packageType === 'deb') {
      return {
        supported: true,
        message: `DEB-managed install detected${packageDiagnostics?.owner ? ` (${packageDiagnostics.owner})` : ''}. Daylens can download a newer .deb and hand it off to dpkg or apt.`,
        packageType,
      }
    }

    if (packageType === 'rpm') {
      return {
        supported: true,
        message: `RPM-managed install detected${packageDiagnostics?.owner ? ` (${packageDiagnostics.owner})` : ''}. Daylens can download a newer .rpm and hand it off to the system package manager.`,
        packageType,
      }
    }

    if (packageType === 'pacman') {
      return {
        supported: false,
        message: `Pacman-managed install detected${packageDiagnostics?.owner ? ` (${packageDiagnostics.owner})` : ''}, but this repo does not publish a native pacman artifact yet. Built-in updates stay disabled here for now.`,
        packageType,
      }
    }

    return {
      supported: false,
      message: 'This Linux install could not be matched to an AppImage, DEB, or RPM package, so built-in updates stay disabled here.',
      packageType,
    }
  }

  return {
    supported: false,
    message: 'Automatic updates are not enabled for this platform yet.',
    packageType: null,
  }
}

function supportsAutoUpdates(): boolean {
  return getAutoUpdateSupport().supported
}

function normalizeUpdaterErrorMessage(message: string): string {
  if (process.platform !== 'linux') return message

  if (/APPIMAGE/i.test(message)) {
    return 'Automatic updates are unavailable for this Linux install. Use the AppImage, DEB, or RPM release instead of the tarball build.'
  }

  if (/latest-linux\.yml|latest\.yml|Cannot find channel/i.test(message)) {
    return 'Daylens could not find published Linux update metadata for this release.'
  }

  if (/Cannot find.*(AppImage|deb|rpm|pacman)/i.test(message)) {
    return 'Daylens found Linux update metadata, but it did not include an artifact compatible with this install type.'
  }

  if (/pkexec|sudo/i.test(message)) {
    return 'Daylens downloaded the Linux update, but the system package manager could not start with elevated permissions.'
  }

  if (/zypper|dnf|yum|rpm|dpkg|apt-get|apt\b|pacman/i.test(message) && /not found|ENOENT/i.test(message)) {
    return 'Daylens could not find a compatible Linux package manager to install the downloaded update automatically.'
  }

  return message
}

function emitState(): void {
  _statusWindow?.webContents.send('update:status', getUpdaterState())
}

function setUpdaterState(partial: Partial<UpdaterState>): void {
  _state = { ..._state, ...partial }
  emitState()
}

function getReleaseNotesText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(value)) {
    const combined = value
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim()
        if (!entry || typeof entry !== 'object') return ''
        const note = (entry as { note?: unknown }).note
        return typeof note === 'string' ? note.trim() : ''
      })
      .filter(Boolean)
      .join('\n\n')

    return combined.length > 0 ? combined : null
  }

  return null
}

function getReleaseMetadata(info: unknown): Pick<UpdaterState, 'releaseName' | 'releaseNotesText' | 'releaseDate'> {
  if (!info || typeof info !== 'object') {
    return { releaseName: null, releaseNotesText: null, releaseDate: null }
  }

  const candidate = info as {
    releaseName?: unknown
    releaseNotes?: unknown
    releaseDate?: unknown
  }

  return {
    releaseName: typeof candidate.releaseName === 'string' ? candidate.releaseName : null,
    releaseNotesText: getReleaseNotesText(candidate.releaseNotes),
    releaseDate: typeof candidate.releaseDate === 'string' ? candidate.releaseDate : null,
  }
}

export function initUpdater(win: BrowserWindow): void {
  _statusWindow = win
  const support = getAutoUpdateSupport()
  _state = {
    ..._state,
    version: app.getVersion(),
    packageType: support.packageType,
    supported: support.supported,
    supportMessage: support.message,
  }
  emitState()

  ipcMain.removeHandler('update:get-status')
  ipcMain.removeHandler('update:check')
  ipcMain.removeHandler('update:install')

  ipcMain.handle('update:get-status', () => {
    return getUpdaterState()
  })

  ipcMain.handle('update:check', async () => {
    capture(ANALYTICS_EVENT.UPDATE_CHECK_REQUESTED, {
      surface: 'settings',
      trigger: 'manual',
    })

    if (!supportsAutoUpdates()) {
      setUpdaterState({
        status: 'not-available',
        version: app.getVersion(),
        progressPct: null,
        errorMessage: null,
        releaseName: null,
        releaseNotesText: null,
        releaseDate: null,
        packageType: support.packageType,
        supported: support.supported,
        supportMessage: support.message,
      })
      capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
        result: 'not_supported',
        status: 'not_available',
        surface: 'updater',
        trigger: 'manual',
      })
      return getUpdaterState()
    }

    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Errors are reflected through the updater state.
    }
    return getUpdaterState()
  })

  ipcMain.handle('update:install', async () => {
    if (!supportsAutoUpdates()) return false
    if (_state.status !== 'downloaded' || _installingUpdate) return false

    capture(ANALYTICS_EVENT.UPDATE_INSTALL_REQUESTED, {
      surface: 'updater',
      trigger: 'manual',
      version: _state.version ?? app.getVersion(),
    })

    try {
      setUpdaterState({ status: 'installing', errorMessage: null })
      capture(ANALYTICS_EVENT.UPDATE_INSTALL_STARTED, {
        surface: 'updater',
        trigger: 'manual',
        version: _state.version ?? app.getVersion(),
      })

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
      capture(ANALYTICS_EVENT.UPDATE_ERROR, {
        failure_kind: classifyFailureKind(err),
        result: 'error',
        surface: 'updater',
      })
      captureException(err, {
        tags: {
          process_type: 'main',
          reason: 'update_install_failed',
        },
      })
      setUpdaterState({
        status: 'error',
        errorMessage: normalizeUpdaterErrorMessage(message),
      })
      return false
    }
  })

  if (!supportsAutoUpdates()) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'linux'

  autoUpdater.on('checking-for-update', () => {
    setUpdaterState({
      status: 'checking',
      errorMessage: null,
      progressPct: null,
    })
  })

  autoUpdater.on('update-available', (info) => {
    _updateAvailable = info.version
    capture(ANALYTICS_EVENT.UPDATE_AVAILABLE, {
      result: 'available',
      status: 'available',
      version: info.version,
    })
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      result: 'available',
      status: 'available',
      version: info.version,
      surface: 'updater',
    })
    setUpdaterState({
      status: 'downloading',
      version: info.version,
      progressPct: 0,
      errorMessage: null,
      ...getReleaseMetadata(info),
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setUpdaterState({
      status: 'downloading',
      progressPct: Math.max(0, Math.min(100, Math.round(progress.percent))),
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    capture(ANALYTICS_EVENT.UPDATE_DOWNLOADED, {
      result: 'downloaded',
      status: 'downloaded',
      version: info.version,
    })
    setUpdaterState({
      status: 'downloaded',
      version: info.version,
      progressPct: 100,
      errorMessage: null,
      ...getReleaseMetadata(info),
    })
  })

  autoUpdater.on('update-not-available', () => {
    _updateAvailable = null
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      result: 'not_available',
      status: 'not_available',
      surface: 'updater',
    })
    setUpdaterState({
      status: 'not-available',
      version: app.getVersion(),
      progressPct: null,
      errorMessage: null,
      releaseName: null,
      releaseNotesText: null,
      releaseDate: null,
      packageType: support.packageType,
      supported: support.supported,
      supportMessage: support.message,
    })
  })

  autoUpdater.on('error', (err) => {
    _updateAvailable = null
    capture(ANALYTICS_EVENT.UPDATE_ERROR, {
      failure_kind: classifyFailureKind(err),
      result: 'error',
      surface: 'updater',
    })
    capture(ANALYTICS_EVENT.UPDATE_CHECK_COMPLETED, {
      failure_kind: classifyFailureKind(err),
      result: 'error',
      status: 'error',
      surface: 'updater',
    })
    captureException(err, {
      tags: {
        process_type: 'main',
        reason: 'update_error',
      },
    })
    setUpdaterState({
      status: 'error',
      errorMessage: normalizeUpdaterErrorMessage(err.message),
      progressPct: null,
      releaseName: null,
      releaseNotesText: null,
      releaseDate: null,
    })
  })

  setTimeout(() => {
    console.log('[updater] checking for updates…')
    autoUpdater.checkForUpdates().catch(() => { /* silent */ })
  }, 10_000)
}
