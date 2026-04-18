import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'
import path from 'node:path'

let tray: Tray | null = null
let trayError: string | null = null

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export function createTray(mainWindow: BrowserWindow): boolean {
  if (tray) return true
  // In packaged builds the assets/ folder is unpacked next to the asar.
  // In dev the assets/ folder lives at the repo root.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon.png')
    : path.join(__dirname, '..', '..', 'build', 'icon.png')

  try {
    const raw = nativeImage.createFromPath(iconPath)
    const icon = raw.isEmpty() ? nativeImage.createEmpty() : raw.resize({ width: 16, height: 16 })

    tray = new Tray(icon)
    trayError = null
    tray.setToolTip('Daylens')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Daylens',
        click: () => {
          mainWindow.show()
          mainWindow.focus()
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit()
        },
      },
    ])

    tray.setContextMenu(contextMenu)

    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    return true
  } catch (error) {
    tray = null
    trayError = formatError(error)
    console.warn('[tray] failed to create tray icon:', error)
    return false
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
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
