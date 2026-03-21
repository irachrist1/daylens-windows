import { contextBridge, ipcRenderer } from 'electron'
import type { AppCategory, AppSettings } from '@shared/types'
import { IPC } from '@shared/types'

// Typed IPC surface exposed to the renderer — NO Node/electron APIs leak through
const api = {
  // Window controls — used by the custom TitleBar (needed on Windows frameless)
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  db: {
    getToday: () => ipcRenderer.invoke(IPC.DB.GET_TODAY),
    getHistory: (date: string) => ipcRenderer.invoke(IPC.DB.GET_HISTORY, date),
    getAppSummaries: (days?: number) => ipcRenderer.invoke(IPC.DB.GET_APP_SUMMARIES, days),
    getAppSessions: (bundleId: string, days?: number) =>
      ipcRenderer.invoke(IPC.DB.GET_APP_SESSIONS, bundleId, days),
    getWebsiteSummaries: (days?: number) =>
      ipcRenderer.invoke(IPC.DB.GET_WEBSITE_SUMMARIES, days),
    setCategoryOverride: (bundleId: string, category: AppCategory) =>
      ipcRenderer.invoke('db:set-category-override', bundleId, category),
    clearCategoryOverride: (bundleId: string) =>
      ipcRenderer.invoke('db:clear-category-override', bundleId),
    getCategoryOverrides: (): Promise<Record<string, AppCategory>> =>
      ipcRenderer.invoke('db:get-category-overrides'),
  },
  focus: {
    start: (label?: string) => ipcRenderer.invoke(IPC.FOCUS.START, label ?? null),
    stop: (id: number) => ipcRenderer.invoke(IPC.FOCUS.STOP, id),
    getActive: () => ipcRenderer.invoke(IPC.FOCUS.GET_ACTIVE),
    getRecent: (limit?: number) => ipcRenderer.invoke(IPC.FOCUS.GET_RECENT, limit),
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
  tracking: {
    getLiveSession: () => ipcRenderer.invoke(IPC.TRACKING.GET_LIVE),
  },
  debug: {
    getInfo: () => ipcRenderer.invoke(IPC.DEBUG.GET_INFO),
  },
  sync: {
    getStatus: () => ipcRenderer.invoke(IPC.SYNC.GET_STATUS),
    link: () => ipcRenderer.invoke(IPC.SYNC.LINK),
    createBrowserLink: () => ipcRenderer.invoke(IPC.SYNC.CREATE_BROWSER_LINK),
    disconnect: () => ipcRenderer.invoke(IPC.SYNC.DISCONNECT),
    getMnemonic: () => ipcRenderer.invoke(IPC.SYNC.GET_MNEMONIC),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.send(IPC.SHELL.OPEN_EXTERNAL, url),
  },
  analytics: {
    capture: (event: string, properties: Record<string, unknown>) =>
      ipcRenderer.send('analytics:capture', event, properties),
  },
  updater: {
    onStatus: (
      callback: (info: { status: 'available' | 'downloaded'; version: string }) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        info: { status: 'available' | 'downloaded'; version: string },
      ) => callback(info)
      ipcRenderer.on('update:status', handler)
      return () => { ipcRenderer.removeListener('update:status', handler) }
    },
    install: () => ipcRenderer.send('update:install'),
  },
}

contextBridge.exposeInMainWorld('daylens', api)

// Type augmentation for renderer window access
export type DaylensAPI = typeof api
