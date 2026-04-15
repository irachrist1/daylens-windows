import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectionInvalidationEvent } from '@shared/core'
import type {
  AppDetailPayload,
  AppCategory,
  AppCharacter,
  AppSettings,
  AppCategorySuggestion,
  AIProviderMode,
  BreakRecommendation,
  FocusStartPayload,
  HistoryDayPayload,
  DayTimelinePayload,
  PeakHoursResult,
  ProcessSnapshot,
  RangeSummaryPayload,
  WeeklySummary,
  WorkContextBlock,
  WorkContextInsight,
  ArtifactRef,
  ClientDetailPayload,
  WorkSessionPayload,
  ActivitySegmentPayload,
  RollupEntry,
  DayWorkSessionsPayload,
} from '@shared/types'
import { IPC } from '@shared/types'

export interface UpdaterStatusInfo {
  status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'installing'
  version: string | null
  progressPct: number | null
  errorMessage: string | null
  releaseName: string | null
  releaseNotesText: string | null
  releaseDate: string | null
}

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
    getHistoryDay: (date: string): Promise<HistoryDayPayload> => ipcRenderer.invoke(IPC.DB.GET_HISTORY_DAY, date),
    getTimelineDay: (date: string): Promise<DayTimelinePayload> => ipcRenderer.invoke(IPC.DB.GET_TIMELINE_DAY, date),
    getAppSummaries: (days?: number) => ipcRenderer.invoke(IPC.DB.GET_APP_SUMMARIES, days),
    getAppSessions: (bundleId: string, days?: number) =>
      ipcRenderer.invoke(IPC.DB.GET_APP_SESSIONS, bundleId, days),
    getWebsiteSummaries: (days?: number) =>
      ipcRenderer.invoke(IPC.DB.GET_WEBSITE_SUMMARIES, days),
    getPeakHours: (): Promise<PeakHoursResult | null> =>
      ipcRenderer.invoke(IPC.DB.GET_PEAK_HOURS),
    getWeeklySummary: (endDateStr: string): Promise<WeeklySummary> =>
      ipcRenderer.invoke(IPC.DB.GET_WEEKLY_SUMMARY, endDateStr),
    getAppCharacter: (bundleId: string, daysBack: number): Promise<AppCharacter | null> =>
      ipcRenderer.invoke(IPC.DB.GET_APP_CHARACTER, bundleId, daysBack),
    getAppDetail: (canonicalAppId: string, days?: number): Promise<AppDetailPayload> =>
      ipcRenderer.invoke(IPC.DB.GET_APP_DETAIL, canonicalAppId, days),
    getBlockDetail: (blockId: string): Promise<WorkContextBlock | null> =>
      ipcRenderer.invoke(IPC.DB.GET_BLOCK_DETAIL, blockId),
    getWorkflowSummaries: (days?: number): Promise<RangeSummaryPayload['workflows']> =>
      ipcRenderer.invoke(IPC.DB.GET_WORKFLOW_SUMMARIES, days),
    getArtifactDetails: (artifactId: string): Promise<ArtifactRef | null> =>
      ipcRenderer.invoke(IPC.DB.GET_ARTIFACT_DETAILS, artifactId),
    setBlockLabelOverride: (payload: { blockId: string; label: string; narrative?: string | null }) =>
      ipcRenderer.invoke(IPC.DB.SET_BLOCK_LABEL_OVERRIDE, payload),
    setCategoryOverride: (bundleId: string, category: AppCategory) =>
      ipcRenderer.invoke('db:set-category-override', bundleId, category),
    clearCategoryOverride: (bundleId: string) =>
      ipcRenderer.invoke('db:clear-category-override', bundleId),
    getCategoryOverrides: (): Promise<Record<string, AppCategory>> =>
      ipcRenderer.invoke('db:get-category-overrides'),
    getAppIcon: (exePath: string): Promise<string | null> =>
      ipcRenderer.invoke('app:get-icon', exePath),
  },
  focus: {
    start: (payload?: string | FocusStartPayload) => ipcRenderer.invoke(IPC.FOCUS.START, payload ?? null),
    stop: (id: number) => ipcRenderer.invoke(IPC.FOCUS.STOP, id),
    getActive: () => ipcRenderer.invoke(IPC.FOCUS.GET_ACTIVE),
    getRecent: (limit?: number) => ipcRenderer.invoke(IPC.FOCUS.GET_RECENT, limit),
    getByDateRange: (payload: { fromMs: number; toMs: number }) => ipcRenderer.invoke(IPC.FOCUS.GET_BY_DATE_RANGE, payload),
    saveReflection: (payload: { sessionId: number; note: string }) => ipcRenderer.invoke(IPC.FOCUS.SAVE_REFLECTION, payload),
    getDistractionCount: (payload: { sessionId: number }) => ipcRenderer.invoke(IPC.FOCUS.GET_DISTRACTION_COUNT, payload),
    getBreakRecommendation: (): Promise<BreakRecommendation | null> =>
      ipcRenderer.invoke(IPC.FOCUS.GET_BREAK_RECOMMENDATION),
  },
  ai: {
    sendMessage: (message: string) => ipcRenderer.invoke(IPC.AI.SEND_MESSAGE, message),
    getHistory: () => ipcRenderer.invoke(IPC.AI.GET_HISTORY),
    clearHistory: () => ipcRenderer.invoke(IPC.AI.CLEAR_HISTORY),
    detectCliTools: () => ipcRenderer.invoke(IPC.AI.DETECT_CLI_TOOLS),
    testCliTool: (payload: { tool: 'claude' | 'codex' }) => ipcRenderer.invoke(IPC.AI.TEST_CLI_TOOL, payload),
    generateBlockInsight: (block: WorkContextBlock): Promise<WorkContextInsight> =>
      ipcRenderer.invoke(IPC.AI.GENERATE_BLOCK_INSIGHT, block),
    suggestAppCategory: (bundleId: string, appName: string): Promise<AppCategorySuggestion> =>
      ipcRenderer.invoke(IPC.AI.SUGGEST_APP_CATEGORY, bundleId, appName),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS.GET),
    set: (partial: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS.SET, partial),
    hasApiKey: (provider?: AIProviderMode): Promise<boolean> => ipcRenderer.invoke(IPC.SETTINGS.HAS_API_KEY, provider),
    setApiKey: (key: string, provider?: AIProviderMode): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS.SET_API_KEY, key, provider),
    clearApiKey: (provider?: AIProviderMode): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS.CLEAR_API_KEY, provider),
  },
  attribution: {
    getClientQuery: (clientId: string, fromMs: number, toMs: number, question: string) =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.GET_CLIENT_QUERY, clientId, fromMs, toMs, question),
    getDayContext: (dateStr: string) =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.GET_DAY_CONTEXT, dateStr),
    findClient: (name: string) =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.FIND_CLIENT, name),
    listClients: (): Promise<Array<{ id: string; name: string; projectCount: number }>> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.LIST_CLIENTS),
    runForRange: (fromMs: number, toMs: number) =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.RUN_FOR_RANGE, fromMs, toMs),
    getClientDetail: (clientId: string, fromDate: string, toDate: string): Promise<ClientDetailPayload | null> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.GET_CLIENT_DETAIL, clientId, fromDate, toDate),
    getWorkSessionsForDay: (dateStr: string): Promise<DayWorkSessionsPayload> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.GET_WORK_SESSIONS_FOR_DAY, dateStr),
    getWorkSessionSegments: (sessionId: string): Promise<ActivitySegmentPayload[]> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.GET_WORK_SESSION_SEGMENTS, sessionId),
    getRollups: (clientId: string | null, fromDate: string, toDate: string): Promise<RollupEntry[]> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.GET_ROLLUPS, clientId, fromDate, toDate),
    getAppWorkSessions: (bundleId: string, days?: number): Promise<WorkSessionPayload[]> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.GET_APP_WORK_SESSIONS, bundleId, days),
    reassignSession: (sessionId: string, clientId: string | null, projectId: string | null): Promise<void> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.REASSIGN_SESSION, sessionId, clientId, projectId),
  },
  tracking: {
    getLiveSession: () => ipcRenderer.invoke(IPC.TRACKING.GET_LIVE),
    getProcessMetrics: (): Promise<ProcessSnapshot[]> =>
      ipcRenderer.invoke(IPC.TRACKING.GET_PROCESS_METRICS),
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
    openPath: (targetPath: string) => ipcRenderer.invoke(IPC.SHELL.OPEN_PATH, targetPath),
  },
  distractionAlerter: {
    setThreshold: (payload: { minutes: number }) => ipcRenderer.invoke('distraction-alerter:set-threshold', payload),
  },
  analytics: {
    capture: (event: string, properties: Record<string, unknown>) =>
      ipcRenderer.send('analytics:capture', event, properties),
  },
  navigation: {
    // Subscribe to main-process navigation requests (e.g. notification click → route).
    // Returns a cleanup function — call it in useEffect's return to avoid leaks.
    onNavigate: (callback: (route: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, route: string) => callback(route)
      ipcRenderer.on('navigate', handler)
      return () => { ipcRenderer.removeListener('navigate', handler) }
    },
  },
  updater: {
    onStatus: (
      callback: (info: UpdaterStatusInfo) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        info: UpdaterStatusInfo,
      ) => callback(info)
      ipcRenderer.on('update:status', handler)
      return () => { ipcRenderer.removeListener('update:status', handler) }
    },
    getStatus: (): Promise<UpdaterStatusInfo> => ipcRenderer.invoke('update:get-status'),
    check: (): Promise<UpdaterStatusInfo> => ipcRenderer.invoke('update:check'),
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
  },
  projections: {
    onInvalidated: (
      callback: (event: ProjectionInvalidationEvent) => void,
    ) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        event: ProjectionInvalidationEvent,
      ) => callback(event)
      ipcRenderer.on(IPC.PROJECTIONS.INVALIDATED, handler)
      return () => { ipcRenderer.removeListener(IPC.PROJECTIONS.INVALIDATED, handler) }
    },
  },
}

contextBridge.exposeInMainWorld('daylens', api)

// Type augmentation for renderer window access
export type DaylensAPI = typeof api
