import { ipcMain, app } from 'electron'
import {
  getSettings,
  setSettings,
  hasApiKey,
  setApiKey,
  clearApiKey,
} from '../services/settings'
import { IPC } from '@shared/types'
import type { AIProvider, AppSettings } from '@shared/types'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS.GET, () => {
    return getSettings()
  })

  ipcMain.handle(IPC.SETTINGS.SET, async (_e, partial: Partial<AppSettings>) => {
    await setSettings(partial)
    if ('launchOnLogin' in partial && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: partial.launchOnLogin as boolean })
    }
  })

  ipcMain.handle(IPC.SETTINGS.HAS_API_KEY, async (_e, provider?: AIProvider) => {
    const resolvedProvider = provider ?? getSettings().aiProvider ?? 'anthropic'
    return hasApiKey(resolvedProvider)
  })

  ipcMain.handle(IPC.SETTINGS.SET_API_KEY, async (_e, key: string, provider?: AIProvider) => {
    const resolvedProvider = provider ?? getSettings().aiProvider ?? 'anthropic'
    if (key.trim()) {
      await setApiKey(resolvedProvider, key.trim())
    } else {
      await clearApiKey(resolvedProvider)
    }
  })

  ipcMain.handle(IPC.SETTINGS.CLEAR_API_KEY, async (_e, provider?: AIProvider) => {
    const resolvedProvider = provider ?? getSettings().aiProvider ?? 'anthropic'
    await clearApiKey(resolvedProvider)
  })
}
