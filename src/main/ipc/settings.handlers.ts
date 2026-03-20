import { ipcMain } from 'electron'
import { getSettings, setSettings } from '../services/settings'
import { IPC } from '@shared/types'
import type { AppSettings } from '@shared/types'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS.GET, () => {
    return getSettings()
  })

  ipcMain.handle(IPC.SETTINGS.SET, async (_e, partial: Partial<AppSettings>) => {
    await setSettings(partial)
  })
}
