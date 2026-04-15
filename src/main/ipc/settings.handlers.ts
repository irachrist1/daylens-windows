import { ipcMain, app } from 'electron'
import {
  getSettingsAsync,
  setSettings,
  hasApiKey,
  setApiKey,
  clearApiKey,
} from '../services/settings'
import { IPC } from '@shared/types'
import type { AIProviderMode, AppSettings } from '@shared/types'
import { invalidateProjectionScope } from '../core/projections/invalidation'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS.GET, async () => {
    return getSettingsAsync()
  })

  ipcMain.handle(IPC.SETTINGS.SET, async (_e, partial: Partial<AppSettings>) => {
    await setSettings(partial)
    if ('launchOnLogin' in partial && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: partial.launchOnLogin as boolean })
    }
    if ('aiProvider' in partial || 'anthropicModel' in partial || 'openaiModel' in partial || 'googleModel' in partial) {
      invalidateProjectionScope('insights', 'ai_settings_changed')
    }
  })

  ipcMain.handle(IPC.SETTINGS.HAS_API_KEY, async (_e, provider?: AIProviderMode) => {
    const resolvedProvider = provider ?? (await getSettingsAsync()).aiProvider ?? 'anthropic'
    return hasApiKey(resolvedProvider)
  })

  ipcMain.handle(IPC.SETTINGS.SET_API_KEY, async (_e, key: string, provider?: AIProviderMode) => {
    const resolvedProvider = provider ?? (await getSettingsAsync()).aiProvider ?? 'anthropic'
    if (key.trim()) {
      await setApiKey(resolvedProvider, key.trim())
    } else {
      await clearApiKey(resolvedProvider)
    }
    invalidateProjectionScope('insights', 'ai_credentials_changed')
  })

  ipcMain.handle(IPC.SETTINGS.CLEAR_API_KEY, async (_e, provider?: AIProviderMode) => {
    const resolvedProvider = provider ?? (await getSettingsAsync()).aiProvider ?? 'anthropic'
    await clearApiKey(resolvedProvider)
    invalidateProjectionScope('insights', 'ai_credentials_changed')
  })
}
