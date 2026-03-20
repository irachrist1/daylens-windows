import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'
import path from 'node:path'

let tray: Tray | null = null

export function createTray(mainWindow: BrowserWindow): void {
  // Load icon — falls back to empty image if asset missing during dev
  const iconPath = path.join(__dirname, '../../assets/icon.png')
  const icon = nativeImage.createFromPath(iconPath).isEmpty()
    ? nativeImage.createEmpty()
    : nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })

  tray = new Tray(icon)
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
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
