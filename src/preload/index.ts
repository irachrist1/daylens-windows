import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectionInvalidationEvent } from '@shared/core'
import type {
  AppCategory,
  AppUsageSummary,
  AIChatSendRequest,
  AIChatStreamEvent,
  AIMessageFeedbackUpdate,
  AIChatTurnResult,
  AISurfaceSummary,
  AIThreadMessage,
  AIDaySummaryResult,
  AIProvider,
  AppDetailPayload,
  AppSettings,
  AIProviderMode,
  BrowserLinkResult,
  BreakRecommendation,
  DayTimelinePayload,
  FocusReflectionSavePayload,
  FocusSession,
  FocusStartPayload,
  IconRequest,
  ProviderConnectionResult,
  ResolvedIconPayload,
  SyncStatus,
  TrackingDiagnosticsPayload,
  TrackingPermissionState,
  WorkspaceResult,
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
  packageType?: string | null
  supported?: boolean
  supportMessage?: string | null
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
    getTimelineDay: (date: string): Promise<DayTimelinePayload> => ipcRenderer.invoke(IPC.DB.GET_TIMELINE_DAY, date),
    getAppSummaries: (days?: number): Promise<AppUsageSummary[]> => ipcRenderer.invoke(IPC.DB.GET_APP_SUMMARIES, days),
    getCategoryOverrides: (): Promise<Record<string, AppCategory>> => ipcRenderer.invoke(IPC.DB.GET_CATEGORY_OVERRIDES),
    setCategoryOverride: (bundleId: string, category: AppCategory): Promise<void> =>
      ipcRenderer.invoke(IPC.DB.SET_CATEGORY_OVERRIDE, bundleId, category),
    clearCategoryOverride: (bundleId: string): Promise<void> => ipcRenderer.invoke(IPC.DB.CLEAR_CATEGORY_OVERRIDE, bundleId),
    setBlockLabelOverride: (payload: { blockId: string; label: string; narrative?: string | null }): Promise<void> =>
      ipcRenderer.invoke(IPC.DB.SET_BLOCK_LABEL_OVERRIDE, payload),
    clearBlockLabelOverride: (blockId: string): Promise<void> => ipcRenderer.invoke(IPC.DB.CLEAR_BLOCK_LABEL_OVERRIDE, blockId),
    getAppDetail: (canonicalAppId: string, days?: number): Promise<AppDetailPayload> =>
      ipcRenderer.invoke(IPC.DB.GET_APP_DETAIL, canonicalAppId, days),
  },
  icons: {
    resolve: (request: IconRequest): Promise<ResolvedIconPayload> => ipcRenderer.invoke(IPC.ICONS.RESOLVE, request),
  },
  ai: {
    sendMessage: (payload: AIChatSendRequest): Promise<AIChatTurnResult> => ipcRenderer.invoke(IPC.AI.SEND_MESSAGE, payload),
    onStream: (callback: (event: AIChatStreamEvent) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: AIChatStreamEvent) => callback(event)
      ipcRenderer.on(IPC.AI.STREAM_EVENT, handler)
      return () => { ipcRenderer.removeListener(IPC.AI.STREAM_EVENT, handler) }
    },
    setMessageFeedback: (payload: AIMessageFeedbackUpdate): Promise<AIThreadMessage | null> =>
      ipcRenderer.invoke(IPC.AI.SET_MESSAGE_FEEDBACK, payload),
    generateDaySummary: (date: string): Promise<AIDaySummaryResult> =>
      ipcRenderer.invoke(IPC.AI.GENERATE_DAY_SUMMARY, date),
    getWeekReview: (weekStart: string): Promise<AISurfaceSummary | null> =>
      ipcRenderer.invoke(IPC.AI.GET_WEEK_REVIEW, { weekStart }),
    getAppNarrative: (canonicalAppId: string, days?: number): Promise<AISurfaceSummary | null> =>
      ipcRenderer.invoke(IPC.AI.GET_APP_NARRATIVE, { canonicalAppId, days }),
    getHistory: (): Promise<AIThreadMessage[]> => ipcRenderer.invoke(IPC.AI.GET_HISTORY),
    clearHistory: () => ipcRenderer.invoke(IPC.AI.CLEAR_HISTORY),
    detectCliTools: () => ipcRenderer.invoke(IPC.AI.DETECT_CLI_TOOLS),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS.GET),
    set: (partial: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS.SET, partial),
    hasApiKey: (provider?: AIProviderMode): Promise<boolean> => ipcRenderer.invoke(IPC.SETTINGS.HAS_API_KEY, provider),
    setApiKey: (key: string, provider?: AIProviderMode): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS.SET_API_KEY, key, provider),
    clearApiKey: (provider?: AIProviderMode): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS.CLEAR_API_KEY, provider),
    validateApiKey: (provider: AIProvider, key: string): Promise<ProviderConnectionResult> =>
      ipcRenderer.invoke(IPC.SETTINGS.VALIDATE_API_KEY, { provider, key }),
  },
  tracking: {
    getLiveSession: () => ipcRenderer.invoke(IPC.TRACKING.GET_LIVE),
    getDiagnostics: (): Promise<TrackingDiagnosticsPayload> => ipcRenderer.invoke(IPC.TRACKING.GET_DIAGNOSTICS),
    getPermissionState: (): Promise<TrackingPermissionState> => ipcRenderer.invoke(IPC.TRACKING.GET_PERMISSION_STATE),
    requestScreenPermission: (): Promise<TrackingPermissionState> => ipcRenderer.invoke(IPC.TRACKING.REQUEST_SCREEN_PERMISSION),
  },
  focus: {
    start: (payload?: FocusStartPayload | string | null): Promise<number> => ipcRenderer.invoke(IPC.FOCUS.START, payload),
    stop: (sessionId: number): Promise<void> => ipcRenderer.invoke(IPC.FOCUS.STOP, sessionId),
    getActive: (): Promise<FocusSession | null> => ipcRenderer.invoke(IPC.FOCUS.GET_ACTIVE),
    getRecent: (limit?: number): Promise<FocusSession[]> => ipcRenderer.invoke(IPC.FOCUS.GET_RECENT, limit),
    saveReflection: (payload: FocusReflectionSavePayload): Promise<void> => ipcRenderer.invoke(IPC.FOCUS.SAVE_REFLECTION, payload),
    getDistractionCount: (payload: { sessionId: number }): Promise<number> => ipcRenderer.invoke(IPC.FOCUS.GET_DISTRACTION_COUNT, payload),
    getBreakRecommendation: (): Promise<BreakRecommendation | null> => ipcRenderer.invoke(IPC.FOCUS.GET_BREAK_RECOMMENDATION),
  },
  app: {
    relaunch: (): Promise<void> => ipcRenderer.invoke(IPC.APP.RELAUNCH),
    completeOnboarding: (): Promise<void> => ipcRenderer.invoke(IPC.APP.COMPLETE_ONBOARDING),
  },
  sync: {
    getStatus: (): Promise<SyncStatus> => ipcRenderer.invoke(IPC.SYNC.GET_STATUS),
    link: (): Promise<WorkspaceResult> => ipcRenderer.invoke(IPC.SYNC.LINK),
    createBrowserLink: (): Promise<BrowserLinkResult> => ipcRenderer.invoke(IPC.SYNC.CREATE_BROWSER_LINK),
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
