import { contextBridge, ipcRenderer } from 'electron'
import os from 'node:os'
import type { PaywallTrigger } from '@shared/analytics'
import type { CaptureConsentState } from '@shared/captureConsent'
import type { ProjectionInvalidationEvent } from '@shared/core'
import type {
  AppCategory,
  AppUsageSummary,
  AIChatSendRequest,
  AIChatStreamEvent,
  AIAgentQuestionEvent,
  AIActionWidget,
  AIActionUndo,
  AIActionCommitResult,
  AIMessageFeedbackUpdate,
  AIChatTurnResult,
  AIStarterSuggestionResult,
  AIWrappedNarrative,
  AISurfaceSummary,
  AIThreadMessage,
  AIThreadSettings,
  AIThreadDetail,
  AIThreadPageRequest,
  AIThreadSummary,
  AIDaySummaryResult,
  AIProvider,
  AppActivityDigest,
  AppDetailPayload,
  AppSettings,
  AIProviderMode,
  BrowserLinkResult,
  BillingAccessSnapshot,
  BillingUsageReport,
  IntercomIdentity,
  CategoryOverrideEffect,
  ClientRecord,
  BreakRecommendation,
  CalendarRangeDay,
  DayTimelinePayload,
  DistractionCostPayload,
  FocusReflectionSavePayload,
  FocusSession,
  FocusStartPayload,
  PaymentRecord,
  IconRequest,
  ProviderConnectionResult,
  ResolvedIconPayload,
  SyncStatus,
  TimelineBlockReviewUpdate,
  TimelineBlockEditPayload,
  TimelineBlockEditResult,
  PurgeTrackedEvidencePayload,
  MemoryBackfillResult,
  TrackingDiagnosticsPayload,
  TrackingPermissionDetails,
  TrackingPermissionState,
  NotificationPermissionState,
  WorkContextInsight,
  WorkMemorySettingsSummary,
  WorkMemoryProfile,
  WorkMemoryMutationResult,
  WorkMemoryFact,
  ScopedMemoryProfile,
  MemoryAuditEntry,
  WorkspaceResult,
  WrappedAskRequest,
  WrappedAskResult,
  WrappedPeriod,
  WrappedPeriodFacts,
  WrappedPeriodNarrative,
  WrapPreflightResult,
  WrapProviderState,
  EnrichmentSourcesState,
  RendererCrashReport,
} from '@shared/types'
import { IPC } from '@shared/types'
import type { McpServerConfig } from '../main/services/mcpServer'

export interface UpdaterStatusInfo {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error' | 'installing'
  version: string | null
  progressPct: number | null
  errorMessage: string | null
  releaseName: string | null
  releaseNotesText: string | null
  releaseDate: string | null
  packageType?: string | null
  supported?: boolean
  supportMessage?: string | null
  downloadUrl?: string | null
  canAutoInstall?: boolean
}

export interface SearchOptions {
  startDate?: string
  endDate?: string
  limit?: number
}

export type DaylensSearchResult =
  | {
      type: 'session'
      id: number
      appName: string
      windowTitle: string | null
      startTime: number
      endTime: number
      date: string
      excerpt: string
    }
  | {
      type: 'block'
      id: string
      label: string
      startTime: number
      endTime: number
      date: string
      excerpt: string
    }
  | {
      type: 'browser'
      id: number
      domain: string
      pageTitle: string | null
      url: string | null
      startTime: number
      endTime: number
      date: string
      excerpt: string
    }
  | {
      type: 'artifact'
      id: number
      title: string
      filePath: string | null
      startTime: number
      endTime: number
      date: string
      excerpt: string
    }

// S1: natural-language search response — ranked results plus the interpreted
// intent + the terms that produced them (the "why it matched" signal).
export interface DaylensNaturalSearchResult {
  results: DaylensSearchResult[]
  intent: string | null
  terms: string[]
  usedProvider: boolean
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
    rebuildTimelineDay: (date: string, hint?: string): Promise<DayTimelinePayload> => ipcRenderer.invoke(IPC.DB.REBUILD_TIMELINE_DAY, date, hint),
    getRecapRange: (dates: string[]): Promise<DayTimelinePayload[]> => ipcRenderer.invoke(IPC.DB.GET_RECAP_RANGE, dates),
    getTimelineRangeBlocks: (fromDate: string, toDate: string): Promise<CalendarRangeDay[]> =>
      ipcRenderer.invoke(IPC.DB.GET_TIMELINE_RANGE_BLOCKS, fromDate, toDate),
    getDistractionCost: (): Promise<DistractionCostPayload> => ipcRenderer.invoke(IPC.DB.GET_DISTRACTION_COST),
    getAppSummaries: (days?: number): Promise<AppUsageSummary[]> => ipcRenderer.invoke(IPC.DB.GET_APP_SUMMARIES, days),
    getAppSummariesForDate: (date: string): Promise<AppUsageSummary[]> => ipcRenderer.invoke(IPC.DB.GET_APP_SUMMARIES_FOR_DATE, date),
    getAllAppsForLabeling: (): Promise<AppUsageSummary[]> => ipcRenderer.invoke(IPC.DB.GET_ALL_APPS_FOR_LABELING),
    getCategoryOverrides: (): Promise<Record<string, AppCategory>> => ipcRenderer.invoke(IPC.DB.GET_CATEGORY_OVERRIDES),
    setCategoryOverride: (bundleId: string, category: AppCategory): Promise<CategoryOverrideEffect> =>
      ipcRenderer.invoke(IPC.DB.SET_CATEGORY_OVERRIDE, bundleId, category),
    clearCategoryOverride: (bundleId: string): Promise<void> => ipcRenderer.invoke(IPC.DB.CLEAR_CATEGORY_OVERRIDE, bundleId),
    setBlockLabelOverride: (payload: { blockId: string; date?: string | null; label: string; narrative?: string | null }): Promise<void> =>
      ipcRenderer.invoke(IPC.DB.SET_BLOCK_LABEL_OVERRIDE, payload),
    clearBlockLabelOverride: (blockId: string): Promise<void> => ipcRenderer.invoke(IPC.DB.CLEAR_BLOCK_LABEL_OVERRIDE, blockId),
    setBlockReview: (payload: TimelineBlockReviewUpdate): Promise<void> =>
      ipcRenderer.invoke(IPC.DB.SET_BLOCK_REVIEW, payload),
    deleteTimelineBlock: (payload: { blockId: string; date?: string | null }): Promise<{ deleted: boolean }> =>
      ipcRenderer.invoke(IPC.DB.DELETE_TIMELINE_BLOCK, payload),
    mergeTimelineEpisodes: (payload: { blockIds: [string, string]; date?: string | null }): Promise<DayTimelinePayload> =>
      ipcRenderer.invoke(IPC.DB.MERGE_TIMELINE_EPISODES, payload),
    setBlockSpan: (payload: { blockId: string; date: string; startMs: number; endMs: number }): Promise<{ changed: boolean }> =>
      ipcRenderer.invoke(IPC.DB.SET_BLOCK_SPAN, payload),
    updateTimelineBlock: (payload: TimelineBlockEditPayload): Promise<TimelineBlockEditResult> =>
      ipcRenderer.invoke(IPC.DB.UPDATE_TIMELINE_BLOCK, payload),
    purgeTrackedEvidence: (payload: PurgeTrackedEvidencePayload): Promise<{ purged: boolean }> =>
      ipcRenderer.invoke(IPC.DB.PURGE_TRACKED_EVIDENCE, payload),
    purgeTimelineBlock: (payload: { blockId: string; date?: string | null }): Promise<{ purged: boolean }> =>
      ipcRenderer.invoke(IPC.DB.PURGE_TIMELINE_BLOCK, payload),
    getAppDetail: (canonicalAppId: string, days?: number | string): Promise<AppDetailPayload> =>
      ipcRenderer.invoke(IPC.DB.GET_APP_DETAIL, canonicalAppId, days),
    getAppActivityDigest: (days?: number): Promise<AppActivityDigest[]> =>
      ipcRenderer.invoke(IPC.DB.GET_APP_ACTIVITY_DIGEST, days),
    getWorkMemorySummary: (): Promise<WorkMemorySettingsSummary> =>
      ipcRenderer.invoke(IPC.DB.GET_WORK_MEMORY_SUMMARY),
    forgetWorkMemoryPattern: (patternId: string): Promise<WorkMemorySettingsSummary> =>
      ipcRenderer.invoke(IPC.DB.FORGET_WORK_MEMORY_PATTERN, patternId),
    forgetAllWorkMemory: (): Promise<WorkMemorySettingsSummary> =>
      ipcRenderer.invoke(IPC.DB.FORGET_ALL_WORK_MEMORY),
    getWorkMemoryProfile: (): Promise<WorkMemoryProfile> =>
      ipcRenderer.invoke(IPC.DB.GET_WORK_MEMORY_PROFILE),
    updateWorkMemoryFact: (id: string, text: string): Promise<WorkMemoryProfile> =>
      ipcRenderer.invoke(IPC.DB.UPDATE_WORK_MEMORY_FACT, id, text),
    addWorkMemoryFact: (text: string): Promise<WorkMemoryProfile> =>
      ipcRenderer.invoke(IPC.DB.ADD_WORK_MEMORY_FACT, text),
    forgetWorkMemoryFact: (id: string): Promise<WorkMemoryMutationResult> =>
      ipcRenderer.invoke(IPC.DB.FORGET_WORK_MEMORY_FACT, id),
    rebuildWorkMemory: (): Promise<WorkMemoryMutationResult> =>
      ipcRenderer.invoke(IPC.DB.REBUILD_WORK_MEMORY),
    getMemoryAudit: (): Promise<MemoryAuditEntry[]> =>
      ipcRenderer.invoke(IPC.DB.GET_MEMORY_AUDIT),
    getScopedMemoryProfile: (): Promise<ScopedMemoryProfile> =>
      ipcRenderer.invoke(IPC.DB.GET_SCOPED_MEMORY_PROFILE),
    addClientMemoryFact: (clientId: string, text: string): Promise<WorkMemoryFact[]> =>
      ipcRenderer.invoke(IPC.DB.ADD_CLIENT_MEMORY_FACT, clientId, text),
  },
  memory: {
    backfill: (): Promise<MemoryBackfillResult> =>
      ipcRenderer.invoke(IPC.DB.BACKFILL_WORK_MEMORY),
  },
  icons: {
    resolve: (request: IconRequest): Promise<ResolvedIconPayload> => ipcRenderer.invoke(IPC.ICONS.RESOLVE, request),
  },
  ai: {
    sendMessage: (payload: AIChatSendRequest): Promise<AIChatTurnResult> => ipcRenderer.invoke(IPC.AI.SEND_MESSAGE, payload),
    cancelMessage: (clientRequestId: string): Promise<boolean> => ipcRenderer.invoke(IPC.AI.CANCEL_MESSAGE, { clientRequestId }),
    getStarterSuggestions: (): Promise<AIStarterSuggestionResult> => ipcRenderer.invoke(IPC.AI.GET_STARTER_SUGGESTIONS),
    onStream: (callback: (event: AIChatStreamEvent) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: AIChatStreamEvent) => callback(event)
      ipcRenderer.on(IPC.AI.STREAM_EVENT, handler)
      return () => { ipcRenderer.removeListener(IPC.AI.STREAM_EVENT, handler) }
    },
    onAgentQuestion: (callback: (event: AIAgentQuestionEvent) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: AIAgentQuestionEvent) => callback(event)
      ipcRenderer.on(IPC.AI.AGENT_QUESTION, handler)
      return () => { ipcRenderer.removeListener(IPC.AI.AGENT_QUESTION, handler) }
    },
    answerAgentQuestion: (payload: { questionId: string; answer: string }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.AI.AGENT_ANSWER, payload),
    setMessageFeedback: (payload: AIMessageFeedbackUpdate): Promise<AIThreadMessage | null> =>
      ipcRenderer.invoke(IPC.AI.SET_MESSAGE_FEEDBACK, payload),
    commitAction: (action: AIActionWidget): Promise<AIActionCommitResult> =>
      ipcRenderer.invoke(IPC.AI.COMMIT_ACTION, action),
    undoAction: (undo: AIActionUndo): Promise<AIActionCommitResult> =>
      ipcRenderer.invoke(IPC.AI.UNDO_ACTION, undo),
    generateDaySummary: (date: string): Promise<AIDaySummaryResult> =>
      ipcRenderer.invoke(IPC.AI.GENERATE_DAY_SUMMARY, date),
    getWeekReview: (weekStart: string, force?: boolean): Promise<AISurfaceSummary | null> =>
      ipcRenderer.invoke(IPC.AI.GET_WEEK_REVIEW, { weekStart, force }),
    getAppNarrative: (canonicalAppId: string, daysOrDate?: number | string, force?: boolean): Promise<AISurfaceSummary | null> =>
      ipcRenderer.invoke(IPC.AI.GET_APP_NARRATIVE, { canonicalAppId, daysOrDate, force }),
    getWrappedNarrative: (date: string, force?: boolean): Promise<AIWrappedNarrative | null> =>
      ipcRenderer.invoke(IPC.AI.GET_WRAPPED_NARRATIVE, { date, force }),
    getWrappedPeriodWrap: (period: WrappedPeriod, anchorDate: string, force?: boolean): Promise<{ facts: WrappedPeriodFacts; narrative: WrappedPeriodNarrative } | null> =>
      ipcRenderer.invoke(IPC.AI.GET_WRAPPED_PERIOD_NARRATIVE, { period, anchorDate, force }),
    getWrapProviderState: (): Promise<WrapProviderState> =>
      ipcRenderer.invoke(IPC.AI.GET_WRAP_PROVIDER_STATE),
    getWrapPreflight: (date: string): Promise<WrapPreflightResult> =>
      ipcRenderer.invoke(IPC.AI.GET_WRAP_PREFLIGHT, { date }),
    askWrapped: (payload: WrappedAskRequest): Promise<WrappedAskResult> =>
      ipcRenderer.invoke(IPC.AI.ASK_WRAPPED, payload),
    regenerateBlockLabel: (blockId: string): Promise<WorkContextInsight> =>
      ipcRenderer.invoke(IPC.AI.REGENERATE_BLOCK_LABEL, blockId),
    detectCliTools: () => ipcRenderer.invoke(IPC.AI.DETECT_CLI_TOOLS),
    listThreads: (payload?: { includeArchived?: boolean }): Promise<AIThreadSummary[]> =>
      ipcRenderer.invoke(IPC.AI.LIST_THREADS, payload),
    getThread: (threadId: number, options?: Omit<AIThreadPageRequest, 'threadId'>): Promise<AIThreadDetail> =>
      ipcRenderer.invoke(IPC.AI.GET_THREAD, { threadId, ...options }),
    archiveThread: (threadId: number, archived: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.AI.ARCHIVE_THREAD, { threadId, archived }),
    renameThread: (threadId: number, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.AI.RENAME_THREAD, { threadId, title }),
    deleteThread: (threadId: number): Promise<void> =>
      ipcRenderer.invoke(IPC.AI.DELETE_THREAD, { threadId }),
    getThreadSettings: (threadId: number): Promise<AIThreadSettings> =>
      ipcRenderer.invoke(IPC.AI.GET_THREAD_SETTINGS, { threadId }),
    setThreadSettings: (threadId: number, settings: AIThreadSettings): Promise<AIThreadSettings> =>
      ipcRenderer.invoke(IPC.AI.SET_THREAD_SETTINGS, { threadId, settings }),
    openArtifact: (artifactId: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.AI.OPEN_ARTIFACT, { artifactId }),
  },
  search: {
    all: (query: string, opts?: SearchOptions): Promise<DaylensSearchResult[]> =>
      ipcRenderer.invoke('search:all', { query, opts }),
    sessions: (query: string, opts?: SearchOptions): Promise<Extract<DaylensSearchResult, { type: 'session' }>[]> =>
      ipcRenderer.invoke('search:sessions', { query, opts }),
    blocks: (query: string, opts?: SearchOptions): Promise<Extract<DaylensSearchResult, { type: 'block' }>[]> =>
      ipcRenderer.invoke('search:blocks', { query, opts }),
    browser: (query: string, opts?: SearchOptions): Promise<Extract<DaylensSearchResult, { type: 'browser' }>[]> =>
      ipcRenderer.invoke('search:browser', { query, opts }),
    artifacts: (query: string, opts?: SearchOptions): Promise<Extract<DaylensSearchResult, { type: 'artifact' }>[]> =>
      ipcRenderer.invoke('search:artifacts', { query, opts }),
    natural: (query: string, opts?: SearchOptions): Promise<DaylensNaturalSearchResult> =>
      ipcRenderer.invoke('search:natural', { query, opts }),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS.GET),
    set: (partial: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS.SET, partial),
    hasApiKey: (provider?: AIProviderMode): Promise<boolean> => ipcRenderer.invoke(IPC.SETTINGS.HAS_API_KEY, provider),
    setApiKey: (key: string, provider?: AIProviderMode): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS.SET_API_KEY, key, provider),
    clearApiKey: (provider?: AIProviderMode): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS.CLEAR_API_KEY, provider),
    validateApiKey: (provider: AIProvider, key: string): Promise<ProviderConnectionResult> =>
      ipcRenderer.invoke(IPC.SETTINGS.VALIDATE_API_KEY, { provider, key }),
    getEnrichmentSources: (): Promise<EnrichmentSourcesState> =>
      ipcRenderer.invoke(IPC.SETTINGS.GET_ENRICHMENT_SOURCES),
  },
  billing: {
    getAccess: (): Promise<BillingAccessSnapshot> => ipcRenderer.invoke(IPC.BILLING.GET_ACCESS),
    refresh: (): Promise<BillingAccessSnapshot> => ipcRenderer.invoke(IPC.BILLING.REFRESH),
    getUsage: (from: number, to: number): Promise<BillingUsageReport> =>
      ipcRenderer.invoke(IPC.BILLING.GET_USAGE, { from, to }),
    createPolarCheckout: (trigger?: PaywallTrigger): Promise<boolean> =>
      ipcRenderer.invoke(IPC.BILLING.CREATE_POLAR_CHECKOUT, { trigger }),
    createFlutterwaveCheckout: (email: string, trigger?: PaywallTrigger): Promise<boolean> =>
      ipcRenderer.invoke(IPC.BILLING.CREATE_FLUTTERWAVE_CHECKOUT, { email, trigger }),
    openPortal: (): Promise<boolean> => ipcRenderer.invoke(IPC.BILLING.OPEN_PORTAL),
    exportUsageCsv: (from: number, to: number): Promise<{ canceled: boolean; path?: string }> =>
      ipcRenderer.invoke(IPC.BILLING.EXPORT_USAGE_CSV, { from, to }),
    getPayments: (): Promise<PaymentRecord[]> => ipcRenderer.invoke(IPC.BILLING.GET_PAYMENTS),
  },
  intercom: {
    getIdentity: (): Promise<IntercomIdentity> => ipcRenderer.invoke(IPC.INTERCOM.GET_IDENTITY),
  },
  tracking: {
    getLiveSession: () => ipcRenderer.invoke(IPC.TRACKING.GET_LIVE),
    getDiagnostics: (): Promise<TrackingDiagnosticsPayload> => ipcRenderer.invoke(IPC.TRACKING.GET_DIAGNOSTICS),
    getPermissionState: (): Promise<TrackingPermissionState> => ipcRenderer.invoke(IPC.TRACKING.GET_PERMISSION_STATE),
    getPermissionDetails: (): Promise<TrackingPermissionDetails> => ipcRenderer.invoke(IPC.TRACKING.GET_PERMISSION_DETAILS),
    requestScreenPermission: (): Promise<TrackingPermissionState> => ipcRenderer.invoke(IPC.TRACKING.REQUEST_SCREEN_PERMISSION),
    deleteAppHistory: (payload: { bundleId?: string | null; appName?: string | null }): Promise<{ deletedRows: number; affectedDates: string[] }> =>
      ipcRenderer.invoke(IPC.TRACKING.DELETE_APP_HISTORY, payload),
    deleteSiteHistory: (payload: { domain: string }): Promise<{ deletedRows: number; affectedDates: string[] }> =>
      ipcRenderer.invoke(IPC.TRACKING.DELETE_SITE_HISTORY, payload),
    deleteActivity: (payload: {
      appSessionIds?: number[] | null
      derivedSessionIds?: number[] | null
      bundleId?: string | null
      canonicalAppId?: string | null
      appName?: string | null
      domain?: string | null
      url?: string | null
      normalizedUrl?: string | null
      pageKey?: string | null
      startTime?: number | null
      endTime?: number | null
      date?: string | null
    }): Promise<{ deletedRows: number; affectedDates: string[] }> =>
      ipcRenderer.invoke(IPC.TRACKING.DELETE_ACTIVITY, payload),
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
    getDefaultUserName: (): Promise<string> => Promise.resolve(os.userInfo().username),
    getComputerName: (): Promise<string> => ipcRenderer.invoke(IPC.APP.GET_COMPUTER_NAME),
    relaunch: (): Promise<void> => ipcRenderer.invoke(IPC.APP.RELAUNCH),
    resetAndUninstall: (): Promise<{ started: boolean }> => ipcRenderer.invoke(IPC.APP.RESET_AND_UNINSTALL),
    completeOnboarding: (): Promise<void> => ipcRenderer.invoke(IPC.APP.COMPLETE_ONBOARDING),
    // Record the explicit capture-consent decision; granting starts capture,
    // declining leaves the app running with capture off.
    setCaptureConsent: (granted: boolean): Promise<CaptureConsentState> =>
      ipcRenderer.invoke(IPC.APP.SET_CAPTURE_CONSENT, granted),
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
  attribution: {
    listClientsDetailed: (): Promise<ClientRecord[]> => ipcRenderer.invoke(IPC.ATTRIBUTION.LIST_CLIENTS_DETAILED),
    createClient: (payload: { name: string; color?: string | null }): Promise<ClientRecord> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.CREATE_CLIENT, payload),
    ensureClients: (names: string[]): Promise<ClientRecord[]> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.ENSURE_CLIENTS, names),
    updateClient: (payload: { id: string; name?: string; color?: string | null }): Promise<ClientRecord | null> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.UPDATE_CLIENT, payload),
    archiveClient: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ATTRIBUTION.ARCHIVE_CLIENT, id),
    restoreClient: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ATTRIBUTION.RESTORE_CLIENT, id),
    deleteClient: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ATTRIBUTION.DELETE_CLIENT, id),
    reassignSession: (
      sessionId: string,
      payload: { clientId?: string | null; clientName?: string | null; projectId?: string | null },
    ): Promise<{ clientId: string | null; projectId: string | null }> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.REASSIGN_SESSION, sessionId, payload),
    reassignRange: (
      payload: { fromMs: number; toMs: number; clientId?: string | null; clientName?: string | null; projectId?: string | null },
    ): Promise<{ clientId: string | null; projectId: string | null; sessionsUpdated: number }> =>
      ipcRenderer.invoke(IPC.ATTRIBUTION.REASSIGN_RANGE, payload),
  },
  distractionAlerter: {
    setThreshold: (payload: { minutes: number }) => ipcRenderer.invoke('distraction-alerter:set-threshold', payload),
  },
  mcp: {
    getConfig: (): Promise<McpServerConfig | null> => ipcRenderer.invoke(IPC.MCP.GET_CONFIG),
  },
  analytics: {
    capture: (event: string, properties: Record<string, unknown>) =>
      ipcRenderer.send('analytics:capture', event, properties),
  },
  errors: {
    // Forward a render crash caught by an ErrorBoundary to the main process,
    // which reports it to Sentry the same way main-process errors are.
    reportRenderCrash: (report: RendererCrashReport) =>
      ipcRenderer.send(IPC.ERRORS.RENDERER_CRASH, report),
  },
  navigation: {
    // Subscribe to main-process navigation requests (e.g. notification click → route).
    // Returns a cleanup function — call it in useEffect's return to avoid leaks.
    onNavigate: (callback: (route: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, route: string) => callback(route)
      ipcRenderer.on('navigate', handler)
      return () => { ipcRenderer.removeListener('navigate', handler) }
    },
    // Drain any route that main queued before this listener mounted.
    consumePending: (): Promise<string | null> => ipcRenderer.invoke('navigation:consume-pending'),
  },
  notifications: {
    getPermissionState: (): Promise<NotificationPermissionState> =>
      ipcRenderer.invoke(IPC.NOTIFICATIONS.GET_PERMISSION_STATE),
    requestPermission: (): Promise<NotificationPermissionState> =>
      ipcRenderer.invoke(IPC.NOTIFICATIONS.REQUEST_PERMISSION),
    openSettings: (): Promise<void> => ipcRenderer.invoke(IPC.NOTIFICATIONS.OPEN_SETTINGS),
  },
  dev: {
    fireTestDailyNotification: (): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('dev:fire-test-daily-notification'),
    fireTestNotifications: (): Promise<{ permission: NotificationPermissionState; results: Array<{ kind: string; ok: boolean; reason?: string }> }> =>
      ipcRenderer.invoke('dev:fire-test-notifications'),
  },
  palette: {
    // Fired by the global shortcut handler in main. Renderer should toggle the palette open/closed.
    onToggle: (callback: () => void): (() => void) => {
      const handler = () => callback()
      ipcRenderer.on('palette:toggle', handler)
      return () => { ipcRenderer.removeListener('palette:toggle', handler) }
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
  system: {
    // Fired by main whenever nativeTheme changes. Carries the resolved OS
    // appearance ('dark' | 'light') so the renderer can re-apply the theme
    // without a full settings reload.
    onThemeChanged: (callback: (appearance: 'dark' | 'light') => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, appearance: 'dark' | 'light') =>
        callback(appearance)
      ipcRenderer.on(IPC.SYSTEM.THEME_CHANGED, handler)
      return () => { ipcRenderer.removeListener(IPC.SYSTEM.THEME_CHANGED, handler) }
    },
  },
}

contextBridge.exposeInMainWorld('daylens', api)

// Type augmentation for renderer window access
export type DaylensAPI = typeof api
