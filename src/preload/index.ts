import { contextBridge, ipcRenderer } from 'electron'
import type { AppCategory, AppSettings } from '@shared/types'
import { IPC } from '@shared/types'

// Typed IPC surface exposed to the renderer — NO Node/electron APIs leak through
const api = {
  db: {
    getToday: () => ipcRenderer.invoke(IPC.DB.GET_TODAY),
    getHistory: (date: string) => ipcRenderer.invoke(IPC.DB.GET_HISTORY, date),
    getAppSummaries: (days?: number) => ipcRenderer.invoke(IPC.DB.GET_APP_SUMMARIES, days),
    setCategoryOverride: (bundleId: string, category: AppCategory) =>
      ipcRenderer.invoke('db:set-category-override', bundleId, category),
  },
  focus: {
    start: (label?: string) => ipcRenderer.invoke(IPC.FOCUS.START, label ?? null),
    stop: (id: number) => ipcRenderer.invoke(IPC.FOCUS.STOP, id),
    getActive: () => ipcRenderer.invoke(IPC.FOCUS.GET_ACTIVE),
  },
  ai: {
    sendMessage: (message: string) => ipcRenderer.invoke(IPC.AI.SEND_MESSAGE, message),
    getHistory: () => ipcRenderer.invoke(IPC.AI.GET_HISTORY),
    clearHistory: () => ipcRenderer.invoke(IPC.AI.CLEAR_HISTORY),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS.GET),
    set: (partial: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS.SET, partial),
  },
}

contextBridge.exposeInMainWorld('daylens', api)

// Type augmentation for renderer window access
export type DaylensAPI = typeof api
