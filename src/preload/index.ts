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
  AIAgentTurnPhaseEvent,
  AIModelCostCatalog,
  AgentTurnCheckpointView,
  AIActionWidget,
  AIActionUndo,
  AIActionCommitResult,
  AIMessageFeedbackUpdate,
  AIChatTurnResult,
  AIStarterSuggestionResult,
  AIWrappedNarrative,
  DayAnalysisVersionSummary,
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
  HistoryExportPlan,
  ScreenContextBacklogFrame,
  ScreenContextStatus,
  HistoryExportProgress,
  HistoryExportRunResult,
  HistoryExportVerification,
  WrapSlidesExportResult,
  MemoryMirrorSyncResult,
  BillingUsageReport,
  SpendGuardrailsReport,
  IntercomIdentity,
  CategoryOverrideEffect,
  ClientRecord,
  ContextPacketInspection,
  ContextPacketListEntry,
  AttributionProject,
  BreakRecommendation,
  CalendarRangeDay,
  DayTimelinePayload,
  RebuildTimelineDayResult,
  TimelineAnalyzeProgress,
  TimelineClarification,
  TimelineClarificationAnswer,
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
  CorrectionCommand,
  CorrectionPreview,
  CorrectionApplyResult,
  CorrectionUndoResult,
  TimelineBlockEditResult,
  PurgeTrackedEvidencePayload,
  MemoryBackfillResult,
  TrackingDiagnosticsPayload,
  CaptureVerificationState,
  TrackingPermissionDetails,
  TrackingPermissionState,
  NotificationPermissionState,
  WorkContextInsight,
  WorkMemorySettingsSummary,
  WorkMemoryProfile,
  WorkMemoryMutationResult,
  WorkMemoryFact,
  SuppliedMemoryFactView,
  MemoryProposalRejectionView,
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
  // The scopes a person can narrow a search to. Whatever is set here restricts
  // every eligible retrieval path; a path whose tables cannot express a set
  // filter returns nothing rather than rows that ignore it.
  applications?: string[]
  websites?: string[]
  projects?: string[]
  clients?: string[]
  people?: string[]
  meetings?: string[]
  sources?: ('observed' | 'connected' | 'supplied' | 'inferred')[]
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
      // DEV-178: memory type of the backing record — observed capture,
      // connected source (meetings), supplied, or inferred.
      sourceType?: 'observed' | 'connected' | 'supplied' | 'inferred'
      // DEV-180: set when the hit was found by local semantic search rather
      // than an exact word match ("Similar meaning" in the palette).
      foundBy?: 'meaning'
      similarity?: number
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
  // DEV-178: a durable entity matched by canonical name or alias — projects,
  // clients, people, meetings, apps, files. `date` is the day the entity was
  // last part of (where a click lands); empty when never observed.
  | {
      type: 'entity'
      id: string
      name: string
      entityType: string
      matchedAlias: string | null
      sourceType: 'observed' | 'connected' | 'supplied' | 'inferred'
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

export type DaylensRetrievalPath = 'structured' | 'exact' | 'semantic'

// One reconciled result: the activity, not one table's row for it. A result
// carrying more than one `foundBy` was produced independently by that many
// paths, and `representations` holds the raw rows behind it.
export interface DaylensRetrievalResult {
  id: string
  kind: 'entity' | 'moment' | 'structured'
  title: string
  startTime: number
  endTime: number
  date: string
  excerpt: string
  sourceType: 'observed' | 'connected' | 'supplied' | 'inferred'
  foundBy: DaylensRetrievalPath[]
  matchExplanation: string
  score: number
  representations: DaylensSearchResult[]
}

export interface DaylensRetrievalResponse {
  plan: {
    query: string
    scope: {
      startDate?: string
      endDate?: string
      timeRangeSource: 'filter' | 'query-text' | 'none'
      lexicalText: string
      entities: Array<{
        id: string
        name: string
        entityType: string
        matchedAlias: string | null
        groupIds: string[]
      }>
      // The query named something that resolved to more than one entity at the
      // same strength; the candidates are kept separate rather than merged.
      ambiguousEntity: boolean
    }
    paths: DaylensRetrievalPath[]
    unavailable: Array<{ path: DaylensRetrievalPath; reason: string }>
  }
  results: DaylensRetrievalResult[]
  // An eligible path could not run. The query still succeeded.
  degraded: boolean
}

// DEV-180: local semantic-search status for the Settings surface — which
// engine and model run on this device, whether the artifact is present, and
// how far the background embedding has gotten.
export interface DaylensSemanticSearchStatus {
  available: boolean
  reason: 'ready' | 'model-missing' | 'runtime-missing' | 'load-failed' | 'vector-store-unavailable'
  detail: string | null
  engine: string
  modelId: string
  modelRevision: string
  modelPresent: boolean
  modelBytes: number
  embeddedRecords: number
  pendingRecords: number
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
    rebuildTimelineDay: (date: string, hint?: string): Promise<RebuildTimelineDayResult> => ipcRenderer.invoke(IPC.DB.REBUILD_TIMELINE_DAY, date, hint),
    // Subscribe to analyze progress ticks (DEV-270) for the duration of one run.
    onAnalyzeProgress: (callback: (update: TimelineAnalyzeProgress) => void): (() => void) => {
      const handler = (_e: unknown, update: TimelineAnalyzeProgress): void => callback(update)
      ipcRenderer.on(IPC.DB.ANALYZE_PROGRESS, handler)
      return () => { ipcRenderer.removeListener(IPC.DB.ANALYZE_PROGRESS, handler) }
    },
    // The day-analysis agent's answer-or-skip questions, and the channel to
    // resolve one (DEV-247/270 clarification).
    getDayClarifications: (date: string): Promise<TimelineClarification[]> => ipcRenderer.invoke(IPC.DB.GET_DAY_CLARIFICATIONS, date),
    resolveDayClarification: (date: string, answer: TimelineClarificationAnswer): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.DB.RESOLVE_DAY_CLARIFICATION, date, answer),
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
    previewCorrection: (command: CorrectionCommand): Promise<CorrectionPreview> =>
      ipcRenderer.invoke(IPC.DB.PREVIEW_CORRECTION, command),
    applyCorrection: (command: CorrectionCommand): Promise<CorrectionApplyResult> =>
      ipcRenderer.invoke(IPC.DB.APPLY_CORRECTION, command),
    undoCorrection: (correctionId: string): Promise<CorrectionUndoResult> =>
      ipcRenderer.invoke(IPC.DB.UNDO_CORRECTION, correctionId),
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
    confirmDraftedMemoryFact: (id: string): Promise<WorkMemoryProfile> =>
      ipcRenderer.invoke(IPC.DB.CONFIRM_DRAFTED_MEMORY_FACT, id),
    listSuppliedMemoryFacts: (): Promise<SuppliedMemoryFactView[]> =>
      ipcRenderer.invoke(IPC.DB.LIST_SUPPLIED_MEMORY_FACTS),
    updateSuppliedMemoryFact: (id: string, statement: string): Promise<SuppliedMemoryFactView[]> =>
      ipcRenderer.invoke(IPC.DB.UPDATE_SUPPLIED_MEMORY_FACT, id, statement),
    deleteSuppliedMemoryFact: (id: string): Promise<SuppliedMemoryFactView[]> =>
      ipcRenderer.invoke(IPC.DB.DELETE_SUPPLIED_MEMORY_FACT, id),
    listMemoryProposalRejections: (): Promise<MemoryProposalRejectionView[]> =>
      ipcRenderer.invoke(IPC.DB.LIST_MEMORY_PROPOSAL_REJECTIONS),
    deleteMemoryProposalRejection: (id: string): Promise<MemoryProposalRejectionView[]> =>
      ipcRenderer.invoke(IPC.DB.DELETE_MEMORY_PROPOSAL_REJECTION, id),
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
    pauseMessage: (clientRequestId: string): Promise<boolean> => ipcRenderer.invoke(IPC.AI.PAUSE_MESSAGE, { clientRequestId }),
    listPausedTurns: (threadId?: number | null): Promise<AgentTurnCheckpointView[]> =>
      ipcRenderer.invoke(IPC.AI.LIST_PAUSED_TURNS, { threadId }),
    discardPausedTurn: (checkpointId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.AI.DISCARD_PAUSED_TURN, { checkpointId }),
    getModelCosts: (models: Array<{ provider: AIProviderMode; modelId: string }>): Promise<AIModelCostCatalog> =>
      ipcRenderer.invoke(IPC.AI.GET_MODEL_COSTS, { models }),
    onTurnPhase: (callback: (event: AIAgentTurnPhaseEvent) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: AIAgentTurnPhaseEvent) => callback(event)
      ipcRenderer.on(IPC.AI.TURN_PHASE, handler)
      return () => { ipcRenderer.removeListener(IPC.AI.TURN_PHASE, handler) }
    },
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
    dismissAction: (action: AIActionWidget): Promise<void> =>
      ipcRenderer.invoke(IPC.AI.DISMISS_ACTION, action),
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
    getDayAnalysisHistory: (date: string, period?: WrappedPeriod): Promise<{ day: DayAnalysisVersionSummary[]; timeline: DayAnalysisVersionSummary[] }> =>
      ipcRenderer.invoke(IPC.AI.GET_DAY_ANALYSIS_HISTORY, { date, period }),
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
    // The unified boundary: the planner scopes, retrieves, reconciles, and
    // ranks, and hands back one ordered result set plus the plan that produced
    // it. The single-path calls below remain for surfaces not yet migrated.
    unified: (query: string, opts?: SearchOptions): Promise<DaylensRetrievalResponse> =>
      ipcRenderer.invoke('search:unified', { query, opts }),
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
    // DEV-180: by-meaning results — always session-shaped moments with
    // foundBy: 'meaning'; [] when the local model is unavailable.
    semantic: (query: string, opts?: SearchOptions): Promise<Extract<DaylensSearchResult, { type: 'session' }>[]> =>
      ipcRenderer.invoke('search:semantic', { query, opts }),
    semanticStatus: (): Promise<DaylensSemanticSearchStatus> =>
      ipcRenderer.invoke('search:semanticStatus'),
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
    getSpendGuardrails: (): Promise<SpendGuardrailsReport> =>
      ipcRenderer.invoke(IPC.BILLING.GET_SPEND_GUARDRAILS),
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
    getCaptureVerification: (): Promise<CaptureVerificationState | null> =>
      ipcRenderer.invoke(IPC.TRACKING.GET_CAPTURE_VERIFICATION),
    // DEV-229: pushed by the main-process permission watcher on every status
    // change, so a revoked Accessibility grant surfaces within seconds even
    // when no settings page is polling.
    onCaptureVerificationChanged: (callback: (state: CaptureVerificationState) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, state: CaptureVerificationState) => callback(state)
      ipcRenderer.on(IPC.TRACKING.CAPTURE_VERIFICATION_CHANGED, handler)
      return () => { ipcRenderer.removeListener(IPC.TRACKING.CAPTURE_VERIFICATION_CHANGED, handler) }
    },
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
    listProjects: (): Promise<AttributionProject[]> => ipcRenderer.invoke(IPC.ATTRIBUTION.LIST_PROJECTS),
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
  entities: {
    list: (payload: { type?: string | null; search?: string | null; limit?: number } = {}): Promise<Array<{
      id: string
      type: string
      name: string
      nameSource: 'inferred' | 'user'
      origin: string
      sensitivity: string
      status: string
      firstObservedAt: number | null
      lastObservedAt: number | null
      aliases: string[]
      evidenceCount: number
    }>> =>
      ipcRenderer.invoke(IPC.ENTITIES.LIST, payload),
    detail: (entityId: string) => ipcRenderer.invoke(IPC.ENTITIES.DETAIL, entityId),
    suggestedMerges: () => ipcRenderer.invoke(IPC.ENTITIES.SUGGESTED_MERGES),
    mergeAllDuplicates: (
      payload: { excludedPairs?: Array<{ leftId: string; rightId: string }> } = {},
    ): Promise<{ merged: number; failed: number; lastCorrectionId: string | null; lastDescription: string | null }> =>
      ipcRenderer.invoke(IPC.ENTITIES.MERGE_ALL_DUPLICATES, payload),
    previewCorrection: (command: unknown) => ipcRenderer.invoke(IPC.ENTITIES.PREVIEW_CORRECTION, command),
    applyCorrection: (command: unknown) => ipcRenderer.invoke(IPC.ENTITIES.APPLY_CORRECTION, command),
    undoCorrection: (correctionId: string) => ipcRenderer.invoke(IPC.ENTITIES.UNDO_CORRECTION, correctionId),
    createProject: (payload: { name: string; clientId?: string | null; color?: string | null }) =>
      ipcRenderer.invoke(IPC.ENTITIES.CREATE_PROJECT, payload),
  },
  fileAccess: {
    listGrants: (payload: { includeRevoked?: boolean } = {}) =>
      ipcRenderer.invoke(IPC.FILE_ACCESS.LIST_GRANTS, payload),
    addGrant: (payload: { scopeKind: 'file' | 'folder'; path: string; state: 'indexed' | 'model_readable'; allowHighSensitivity?: boolean }) =>
      ipcRenderer.invoke(IPC.FILE_ACCESS.ADD_GRANT, payload),
    revokeGrant: (grantId: string) => ipcRenderer.invoke(IPC.FILE_ACCESS.REVOKE_GRANT, grantId),
    listDisclosures: (payload: { limit?: number } = {}) =>
      ipcRenderer.invoke(IPC.FILE_ACCESS.LIST_DISCLOSURES, payload),
    pickPath: (payload: { scopeKind?: 'file' | 'folder' } = {}): Promise<{ path: string; scopeKind: 'file' | 'folder' } | null> =>
      ipcRenderer.invoke(IPC.FILE_ACCESS.PICK_PATH, payload),
  },
  screenContext: {
    // DEV-198: the screen-context experiment surface. Status, the explicit
    // consent decision, pause/resume, revoke, backlog with Retry/Delete, the
    // per-source deletion offers, and the full wipe. All local-only.
    status: (): Promise<ScreenContextStatus> => ipcRenderer.invoke(IPC.SCREEN_CONTEXT.STATUS),
    enable: (): Promise<{ ok: boolean; reason: string | null; status: ScreenContextStatus }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.ENABLE),
    setPaused: (paused: boolean): Promise<{ ok: boolean; reason: string | null; status: ScreenContextStatus }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.SET_PAUSED, paused),
    revoke: (payload: { wipeEverything?: boolean } = {}): Promise<{ ok: boolean; reason: string | null; status: ScreenContextStatus }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.REVOKE, payload),
    listBacklog: (): Promise<{ frames: ScreenContextBacklogFrame[]; totals: { frames: number; bytes: number } }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.LIST_BACKLOG),
    retryFrame: (frameId: string): Promise<{ ok: boolean; reason: string | null }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.RETRY_FRAME, frameId),
    deleteFrame: (frameId: string): Promise<{ ok: boolean; reason: string | null }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.DELETE_FRAME, frameId),
    deleteForSource: (source: string): Promise<{ ok: boolean; deleted: number }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.DELETE_FOR_SOURCE, source),
    wipe: (): Promise<{ ok: boolean; deleted: number }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.WIPE),
    diagnosticSample: (): Promise<{ captured: boolean; reason: string | null }> =>
      ipcRenderer.invoke(IPC.SCREEN_CONTEXT.DIAGNOSTIC_SAMPLE),
  },
  export: {
    // DEV-196: full-history export. Plans, progress, and verification reports
    // only — raw rows go straight from the database to the person's disk.
    plan: (payload: { includeHighSensitivity?: boolean } = {}): Promise<HistoryExportPlan> =>
      ipcRenderer.invoke(IPC.EXPORT.PLAN, payload),
    chooseDestination: (): Promise<{ canceled: boolean; dir?: string }> =>
      ipcRenderer.invoke(IPC.EXPORT.CHOOSE_DESTINATION),
    run: (payload: { destinationDir: string; includeHighSensitivity?: boolean }): Promise<HistoryExportRunResult> =>
      ipcRenderer.invoke(IPC.EXPORT.RUN, payload),
    verify: (payload: { exportDir?: string } = {}): Promise<
      { canceled: true } | { canceled: false; exportDir: string; verification: HistoryExportVerification }
    > =>
      ipcRenderer.invoke(IPC.EXPORT.VERIFY, payload),
    onProgress: (callback: (event: HistoryExportProgress) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: HistoryExportProgress) => callback(event)
      ipcRenderer.on(IPC.EXPORT.PROGRESS, handler)
      return () => { ipcRenderer.removeListener(IPC.EXPORT.PROGRESS, handler) }
    },
    // DEV-248: the wrap deck's per-slide export — one folder pick, one PNG per
    // slide. Rejects (never resolves) when a write fails, so the deck can say so.
    wrapSlides: (payload: { stem: string; files: Array<{ filename: string; bytes: Uint8Array }> }): Promise<WrapSlidesExportResult> =>
      ipcRenderer.invoke(IPC.EXPORT.WRAP_SLIDES, payload),
  },
  memoryMirror: {
    // The readable memory mirror: one Markdown file per finished day.
    list: (): Promise<string[]> => ipcRenderer.invoke(IPC.MEMORY_MIRROR.LIST),
    root: (): Promise<string | null> => ipcRenderer.invoke(IPC.MEMORY_MIRROR.ROOT),
    // Opens the day's actual file in the OS file manager.
    reveal: (date: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.MEMORY_MIRROR.REVEAL, { date }),
    sync: (date: string): Promise<MemoryMirrorSyncResult | null> =>
      ipcRenderer.invoke(IPC.MEMORY_MIRROR.SYNC, { date }),
    delete: (date: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.MEMORY_MIRROR.DELETE, { date }),
  },
  contextPackets: {
    // DEV-181: the recorded, deterministic bundle behind an AI exchange.
    get: (packetId: string) => ipcRenderer.invoke(IPC.CONTEXT_PACKETS.GET, packetId),
    getForMessage: (messageId: number) =>
      ipcRenderer.invoke(IPC.CONTEXT_PACKETS.GET_FOR_MESSAGE, messageId),
    list: (payload: { limit?: number; exchangeKind?: 'chat' | 'day_analysis'; scopeKey?: string } = {}) =>
      ipcRenderer.invoke(IPC.CONTEXT_PACKETS.LIST, payload),
    // DEV-183: the read-only "What the AI saw" inspection for one exchange —
    // by packet id, or by the assistant message the packet is bound to.
    inspect: (payload: { packetId?: string | null; messageId?: number | null }): Promise<ContextPacketInspection | null> =>
      ipcRenderer.invoke(IPC.CONTEXT_PACKETS.INSPECT, payload),
    listEntries: (payload: { limit?: number } = {}): Promise<ContextPacketListEntry[]> =>
      ipcRenderer.invoke(IPC.CONTEXT_PACKETS.LIST_ENTRIES, payload),
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
    // which reports it to PostHog the same way main-process errors are.
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
