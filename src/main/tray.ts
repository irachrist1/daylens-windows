import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'
import path from 'node:path'
import { getSettings, setSettings } from './services/settings'
import { syncLinuxLaunchOnLogin } from './services/linuxDesktop'

let tray: Tray | null = null
let trayError: string | null = null
let trayWindow: BrowserWindow | null = null
let trayWindowSyncHandler: (() => void) | null = null
let activeController: TrayController | null = null
const TRAY_GUID = '4c82ef49-77d4-4f66-a5d0-4ea5c157d4fa'

export interface TrayController {
  mainWindow: BrowserWindow
  isWindowVisible: () => boolean
  showMainWindow: (route?: string) => void
  hideMainWindow: () => void
  quitApp: () => void
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function resolveAssetPath(filename: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', filename)
    : path.join(__dirname, '..', '..', 'build', filename)
}

function createTrayImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const templatePath = resolveAssetPath('trayTemplate.png')
    const template = nativeImage.createFromPath(templatePath)
    if (!template.isEmpty()) {
      template.setTemplateImage(true)
      return template
    }
  }

  const fallbackPath = resolveAssetPath('icon.png')
  const fallback = nativeImage.createFromPath(fallbackPath)
  if (!fallback.isEmpty()) {
    return fallback.resize({ width: 16, height: 16 })
  }

  return nativeImage.createEmpty()
}

function clearTrayWindowListeners(): void {
  if (!trayWindow || !trayWindowSyncHandler) return
  trayWindow.removeListener('show', trayWindowSyncHandler)
  trayWindow.removeListener('hide', trayWindowSyncHandler)
  trayWindow.removeListener('closed', trayWindowSyncHandler)
  trayWindowSyncHandler = null
  trayWindow = null
}

async function toggleLaunchAtLogin(nextValue: boolean): Promise<void> {
  try {
    await setSettings({ launchOnLogin: nextValue })
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: nextValue })
      await syncLinuxLaunchOnLogin(nextValue)
    }
  } catch (err) {
    console.warn('[tray] failed to toggle launch at login:', err)
  } finally {
    if (activeController) refreshTrayMenu(activeController)
  }
}

function buildContextMenu(controller: TrayController): Electron.Menu {
  const visible = controller.isWindowVisible()
  const settings = getSettings()
  const version = app.getVersion()
  const showLabel = visible ? 'Hide Daylens' : 'Open Daylens'
  const showAccelerator = process.platform === 'darwin' ? 'Cmd+Shift+D' : undefined

  return Menu.buildFromTemplate([
    {
      label: 'Daylens',
      enabled: false,
    },
    {
      label: `Tracking quietly · v${version}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: showLabel,
      accelerator: showAccelerator,
      click: () => {
        if (controller.isWindowVisible()) {
          controller.hideMainWindow()
          return
        }
        controller.showMainWindow()
      },
    },
    { type: 'separator' },
    { label: 'Timeline', click: () => controller.showMainWindow('/timeline') },
    { label: 'Apps', click: () => controller.showMainWindow('/apps') },
    { label: 'AI', click: () => controller.showMainWindow('/ai') },
    { label: 'Settings', click: () => controller.showMainWindow('/settings') },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: Boolean(settings.launchOnLogin),
      click: (item) => { void toggleLaunchAtLogin(item.checked) },
    },
    { type: 'separator' },
    {
      label: 'Quit Daylens',
      accelerator: process.platform === 'darwin' ? 'Cmd+Q' : undefined,
      click: () => controller.quitApp(),
    },
  ])
}

function refreshTrayMenu(controller: TrayController): void {
  if (!tray) return
  tray.setContextMenu(buildContextMenu(controller))
}

export function createTray(controller: TrayController): boolean {
  activeController = controller

  if (tray && trayWindow === controller.mainWindow) {
    refreshTrayMenu(controller)
    return true
  }

  if (tray && trayWindow && trayWindow !== controller.mainWindow) {
    destroyTray()
  }

  try {
    const icon = createTrayImage()

    tray = new Tray(icon, TRAY_GUID)
    trayError = null
    tray.setToolTip('Daylens — tracking quietly')

    if (process.platform === 'darwin') {
      tray.setPressedImage(icon)
      tray.setIgnoreDoubleClickEvents(true)
    }

    trayWindow = controller.mainWindow
    trayWindowSyncHandler = () => refreshTrayMenu(controller)
    trayWindow.on('show', trayWindowSyncHandler)
    trayWindow.on('hide', trayWindowSyncHandler)
    trayWindow.on('closed', trayWindowSyncHandler)
    refreshTrayMenu(controller)

    // On macOS, when a context menu is attached, left-click shows the menu automatically
    // and the click event is not emitted — so this handler only matters on Windows/Linux.
    tray.on('click', () => {
      if (process.platform === 'darwin') {
        controller.showMainWindow()
        return
      }

      if (controller.isWindowVisible()) {
        controller.hideMainWindow()
        return
      }

      controller.showMainWindow()
    })
    return true
  } catch (error) {
    clearTrayWindowListeners()
    tray = null
    activeController = null
    trayError = formatError(error)
    console.warn('[tray] failed to create tray icon:', error)
    return false
  }
}

export function destroyTray(): void {
  clearTrayWindowListeners()
  tray?.destroy()
  tray = null
  activeController = null
}

export function hasTray(): boolean {
  return tray !== null
}

export function getTrayDiagnostics(): { available: boolean; error: string | null } {
  return {
    available: tray !== null,
    error: trayError,
  }
}
