// ---------------------------------------------------------------------------
// Shared types — imported by both main and renderer via path alias @shared/*
// ---------------------------------------------------------------------------

export interface AppSession {
  id: number
  bundleId: string          // exe name on Windows, bundle ID on macOS
  appName: string
  startTime: number         // Unix ms
  endTime: number | null
  durationSeconds: number
  category: AppCategory
  isFocused: boolean
  windowTitle?: string | null
  rawAppName?: string | null
  canonicalAppId?: string | null
  appInstanceId?: string | null
  captureSource?: string | null
  endedReason?: string | null
  captureVersion?: number
}

export interface DailySummary {
  date: string              // YYYY-MM-DD
  totalTrackedSeconds: number
  focusSeconds: number
  topApps: AppUsageSummary[]
}

export interface AppUsageSummary {
  bundleId: string
  canonicalAppId?: string | null
  appName: string
  category: AppCategory
  totalSeconds: number
  isFocused: boolean
  sessionCount?: number   // populated from DB queries; absent for live/synthetic entries
}

export type BlockConfidence = 'high' | 'medium' | 'low'

export interface WorkContextAppSummary {
  bundleId: string
  appName: string
  category: AppCategory
  totalSeconds: number
  sessionCount: number
  isBrowser: boolean
}

export interface WorkContextBlock {
  id: string
  startTime: number
  endTime: number
  dominantCategory: AppCategory
  categoryDistribution: Partial<Record<AppCategory, number>>
  ruleBasedLabel: string
  aiLabel: string | null
  sessions: AppSession[]
  topApps: WorkContextAppSummary[]
  websites: WebsiteSummary[]
  keyPages: string[]
  pageRefs: PageRef[]
  documentRefs: DocumentRef[]
  topArtifacts: ArtifactRef[]
  workflowRefs: WorkflowRef[]
  label: BlockLabel
  focusOverlap: FocusOverlapSummary
  evidenceSummary: TimelineEvidenceSummary
  heuristicVersion: string
  computedAt: number
  switchCount: number
  confidence: BlockConfidence
  isLive: boolean
}

export type TimelineBlock = WorkContextBlock

export interface TimelineGapSegment {
  kind: 'idle_gap' | 'away' | 'machine_off'
  startTime: number
  endTime: number
  label: string
  source: 'derived_gap' | 'activity_event'
}

export interface TimelineBlockSegment {
  kind: 'work_block'
  startTime: number
  endTime: number
  blockId: string
}

export type TimelineSegment = TimelineBlockSegment | TimelineGapSegment

export interface DayTimelinePayload {
  date: string
  sessions: AppSession[]
  websites: WebsiteSummary[]
  blocks: WorkContextBlock[]
  segments: TimelineSegment[]
  focusSessions: FocusSession[]
  computedAt: number
  version: string
  totalSeconds: number
  focusSeconds: number
  focusPct: number
  appCount: number
  siteCount: number
}

export type HistoryDayPayload = DayTimelinePayload

export interface WorkContextInsight {
  label: string | null
  narrative: string | null
}

export interface AppCategorySuggestion {
  suggestedCategory: AppCategory | null
  reason: string | null
}

export interface FocusSession {
  id: number
  startTime: number
  endTime: number | null
  durationSeconds: number
  label: string | null
  targetMinutes: number | null
  plannedApps: string[]
  reflectionNote?: string | null
}

export interface FocusStartPayload {
  label?: string | null
  targetMinutes?: number | null
  plannedApps?: string[]
}

export interface AIConversation {
  id: number
  messages: AIMessage[]
  createdAt: number
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface WebsiteSummary {
  domain: string
  totalSeconds: number
  visitCount: number
  topTitle: string | null
  browserBundleId: string | null
  canonicalBrowserId?: string | null
}

export type LabelSource = 'rule' | 'artifact' | 'workflow' | 'ai' | 'user'

export interface OpenTarget {
  kind: 'external_url' | 'local_path' | 'unsupported'
  value: string | null
}

export interface ArtifactRef {
  id: string
  artifactType: 'domain' | 'page' | 'document' | 'project' | 'repo' | 'window'
  displayTitle: string
  subtitle?: string | null
  totalSeconds: number
  confidence: number
  canonicalAppId?: string | null
  url?: string | null
  path?: string | null
  host?: string | null
  canonicalKey?: string
  openTarget: OpenTarget
  metadata?: Record<string, unknown> | null
}

export interface PageRef extends ArtifactRef {
  artifactType: 'page'
  domain: string
  browserBundleId?: string | null
  canonicalBrowserId?: string | null
  normalizedUrl?: string | null
  pageTitle?: string | null
}

export interface DocumentRef extends ArtifactRef {
  artifactType: 'document' | 'project' | 'repo' | 'window'
  sourceSessionIds: number[]
}

export interface WorkflowRef {
  id: string
  signatureKey: string
  label: string
  confidence: number
  dominantCategory: AppCategory
  canonicalApps: string[]
  artifactKeys: string[]
}

export interface BlockLabel {
  current: string
  source: LabelSource
  confidence: number
  narrative: string | null
  ruleBased: string
  aiSuggested: string | null
  override: string | null
}

export interface AIJobUsageEvent {
  id: string
  jobType: AIJobType
  screen: AISurface
  triggerSource: AIInvocationSource
  provider: AIProviderMode | null
  model: string | null
  success: boolean
  failureReason: string | null
  startedAt: number
  completedAt: number | null
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  cacheHit: boolean
}

export interface FocusOverlapSummary {
  totalSeconds: number
  pct: number
  sessionIds: number[]
}

export interface TimelineEvidenceSummary {
  apps: WorkContextAppSummary[]
  pages: PageRef[]
  documents: DocumentRef[]
  domains: string[]
}

export interface PeakHoursResult {
  peakStart: number
  peakEnd: number
  focusPct: number
}

export interface WeeklySummary {
  totalTrackedSeconds: number
  totalFocusSeconds: number
  focusPct: number
  avgFocusScore: number
  bestDay: { date: string; focusPct: number } | null
  mostActiveDay: { date: string; totalSeconds: number } | null
  topApps: { appName: string; bundleId: string; totalSeconds: number; category: AppCategory }[]
  dailyBreakdown: {
    date: string
    focusSeconds: number
    totalSeconds: number
    focusScore: number
  }[]
}

export interface AppCharacter {
  character:
    | 'deep_focus'
    | 'flow_compatible'
    | 'context_switching'
    | 'distraction'
    | 'communication'
    | 'neutral'
  label: string
  confidence: number
  avgSessionMinutes: number
  sessionCount: number
}

export interface AppProfile {
  canonicalAppId: string
  displayName: string
  roleSummary: string
  topArtifacts: ArtifactRef[]
  pairedApps: Array<{ canonicalAppId: string; displayName: string; totalSeconds: number }>
  topBlockIds: string[]
  computedAt: number
}

export interface WorkflowPattern {
  id: string
  signatureKey: string
  label: string
  dominantCategory: AppCategory
  canonicalApps: string[]
  artifactKeys: string[]
  occurrenceCount: number
  lastSeenAt: number
}

export interface AppDetailPayload {
  canonicalAppId: string
  displayName: string
  appCharacter: AppCharacter | null
  profile: AppProfile
  totalSeconds: number
  sessionCount: number
  topArtifacts: ArtifactRef[]
  topPages: PageRef[]
  pairedApps: Array<{ canonicalAppId: string; displayName: string; totalSeconds: number }>
  blockAppearances: Array<{
    blockId: string
    startTime: number
    endTime: number
    label: string
    dominantCategory: AppCategory
  }>
  workflowAppearances: WorkflowRef[]
  timeOfDayDistribution: Array<{ hour: number; totalSeconds: number }>
  computedAt: number
  rangeKey: string
}

export interface RangeSummaryPayload {
  rangeKey: string
  blockCount: number
  topArtifacts: ArtifactRef[]
  workflows: WorkflowPattern[]
  computedAt: number
}

export interface BreakRecommendation {
  triggerReason: 'sustained_focus'
  focusedMinutes: number
  currentApp: string | null
  message: string
  urgency: 'medium' | 'high'
}

export type AIProvider = 'anthropic' | 'openai' | 'google'
export type AIProviderMode = AIProvider | 'claude-cli' | 'codex-cli'
export type AIJobType =
  | 'block_label_preview'
  | 'block_label_finalize'
  | 'block_cleanup_relabel'
  | 'day_summary'
  | 'week_review'
  | 'app_narrative'
  | 'chat_answer'
  | 'report_generation'
  | 'attribution_assist'

export type AISurface =
  | 'timeline_day'
  | 'timeline_week'
  | 'apps_list'
  | 'app_detail'
  | 'ai_chat'
  | 'settings'
  | 'background'

export type AIInvocationSource = 'user' | 'background' | 'system'
export type AIModelStrategy = 'balanced' | 'quality' | 'economy' | 'custom'

export interface ProcessSnapshot {
  pid: number
  name: string
  cpuPercent: number
  memoryMb: number
  capturedAt: number
}

export type AppTheme = 'system' | 'light' | 'dark'

export interface AppSettings {
  // Provider API keys are stored in OS keychain via keytar (never in plain-text)
  analyticsOptIn: boolean       // false = no telemetry (default)
  launchOnLogin: boolean
  theme: AppTheme
  onboardingComplete: boolean
  userName: string
  userGoals: string[]
  dailyFocusGoalHours: number
  firstLaunchDate: number       // Unix ms — set on first launch, used for day-7 feedback prompt
  feedbackPromptShown: boolean  // true once the day-7 prompt has been shown
  aiProvider: AIProviderMode
  anthropicModel: string
  openaiModel: string
  googleModel: string
  aiFallbackOrder: AIProvider[]
  aiModelStrategy: AIModelStrategy
  aiChatProvider?: AIProviderMode
  aiBlockNamingProvider?: AIProviderMode
  aiSummaryProvider?: AIProviderMode
  aiArtifactProvider?: AIProviderMode
  aiBackgroundEnrichment?: boolean
  aiActiveBlockPreview?: boolean
  aiPromptCachingEnabled?: boolean
  aiSpendSoftLimitUsd?: number
  aiRedactFilePaths?: boolean
  aiRedactEmails?: boolean
  dailySummaryEnabled?: boolean
  morningNudgeEnabled?: boolean
  distractionAlertThresholdMinutes?: number
  distractionAlertsEnabled?: boolean
  focusIntent?: string
  defaultFocusMinutes?: number
}

// In-flight session that has not yet been flushed to the DB.
// Exposed via IPC so the renderer can merge it into Today's display totals.
export interface LiveSession {
  bundleId: string
  appName: string
  startTime: number   // Unix ms
  category: AppCategory
  windowTitle?: string | null
  rawAppName?: string | null
  canonicalAppId?: string | null
  appInstanceId?: string | null
  captureSource?: string | null
}

export type AppCategory =
  | 'development'
  | 'communication'
  | 'research'
  | 'writing'
  | 'aiTools'
  | 'design'
  | 'browsing'
  | 'meetings'
  | 'entertainment'
  | 'email'
  | 'productivity'
  | 'social'
  | 'system'
  | 'uncategorized'

export const FOCUSED_CATEGORIES: AppCategory[] = [
  'development',
  'research',
  'writing',
  'aiTools',
  'design',
  'productivity',
]

// ─── Attribution / Work Session types for renderer ───────────────────────────

export type AttributionStatus = 'attributed' | 'ambiguous' | 'unattributed'

export interface ClientSummary {
  id: string
  name: string
  color: string | null
  status: string
  projectCount: number
}

export interface ProjectSummary {
  id: string
  client_id: string
  name: string
  color: string | null
}

export interface WorkSessionApp {
  app_name: string
  duration_ms: number
  role: string // primary | supporting | ambient
}

export interface WorkSessionEvidence {
  type: string   // domain | file_path | title | repo_remote | email_domain | sequence
  value: string
  weight: number
}

export interface WorkSessionPayload {
  id: string
  started_at: number
  ended_at: number
  duration_ms: number
  active_ms: number
  idle_ms: number
  client_id: string | null
  client_name: string | null
  client_color: string | null
  project_id: string | null
  project_name: string | null
  attribution_status: AttributionStatus
  attribution_confidence: number | null
  title: string | null
  apps: WorkSessionApp[]
  evidence: WorkSessionEvidence[]
}

export interface ActivitySegmentPayload {
  id: string
  started_at: number
  ended_at: number
  duration_ms: number
  primary_app_name: string
  class: string // focused | supporting | ambient | idle
}

export interface RollupEntry {
  day_local: string
  client_id: string | null
  project_id: string | null
  attributed_ms: number
  ambiguous_ms: number
  session_count: number
}

export interface ClientDetailPayload {
  client: ClientSummary
  projects: ProjectSummary[]
  rollups: RollupEntry[]
  sessions: WorkSessionPayload[]
  ambiguous_sessions: WorkSessionPayload[]
}

export interface TimelineWorkSession extends WorkSessionPayload {
  is_live?: boolean
}

export interface DayWorkSessionsPayload {
  date: string
  sessions: TimelineWorkSession[]
  total_attributed_ms: number
  total_ambiguous_ms: number
  total_unattributed_ms: number
}

// IPC channel names — single source of truth
export const IPC = {
  DB: {
    GET_TODAY: 'db:get-today',
    GET_HISTORY: 'db:get-history',
    GET_HISTORY_DAY: 'db:get-history-day',
    GET_TIMELINE_DAY: 'db:get-timeline-day',
    GET_APP_SUMMARIES: 'db:get-app-summaries',
    GET_APP_SESSIONS: 'db:get-app-sessions',
    GET_WEBSITE_SUMMARIES: 'db:get-website-summaries',
    GET_PEAK_HOURS: 'db:get-peak-hours',
    GET_WEEKLY_SUMMARY: 'db:get-weekly-summary',
    GET_APP_CHARACTER: 'db:get-app-character',
    GET_APP_DETAIL: 'db:get-app-detail',
    GET_BLOCK_DETAIL: 'db:get-block-detail',
    GET_WORKFLOW_SUMMARIES: 'db:get-workflow-summaries',
    GET_ARTIFACT_DETAILS: 'db:get-artifact-details',
    SET_BLOCK_LABEL_OVERRIDE: 'db:set-block-label-override',
  },
  DEBUG: {
    GET_INFO: 'debug:get-info',
  },
  FOCUS: {
    START: 'focus:start',
    STOP: 'focus:stop',
    GET_ACTIVE: 'focus:get-active',
    GET_RECENT: 'focus:get-recent',
    GET_BY_DATE_RANGE: 'focus:get-by-date-range',
    GET_BREAK_RECOMMENDATION: 'focus:get-break-recommendation',
    SAVE_REFLECTION: 'focus:save-reflection',
    GET_DISTRACTION_COUNT: 'focus:get-distraction-count',
  },
  AI: {
    SEND_MESSAGE: 'ai:send-message',
    GET_HISTORY: 'ai:get-history',
    CLEAR_HISTORY: 'ai:clear-history',
    GENERATE_BLOCK_INSIGHT: 'ai:generate-block-insight',
    SUGGEST_APP_CATEGORY: 'ai:suggest-app-category',
    DETECT_CLI_TOOLS: 'ai:detect-cli-tools',
    TEST_CLI_TOOL: 'ai:test-cli-tool',
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set',
    HAS_API_KEY: 'settings:has-api-key',
    SET_API_KEY: 'settings:set-api-key',
    CLEAR_API_KEY: 'settings:clear-api-key',
  },
  PROJECTIONS: {
    INVALIDATED: 'projections:invalidated',
  },
  TRACKING: {
    GET_LIVE: 'tracking:get-live',
    GET_PROCESS_METRICS: 'tracking:get-process-metrics',
  },
  SYNC: {
    GET_STATUS: 'sync:get-status',
    LINK: 'sync:link',
    CREATE_BROWSER_LINK: 'sync:create-browser-link',
    DISCONNECT: 'sync:disconnect',
    GET_MNEMONIC: 'sync:get-mnemonic',
  },
  ATTRIBUTION: {
    GET_CLIENT_QUERY: 'attribution:get-client-query',
    GET_DAY_CONTEXT: 'attribution:get-day-context',
    FIND_CLIENT: 'attribution:find-client',
    LIST_CLIENTS: 'attribution:list-clients',
    RUN_FOR_RANGE: 'attribution:run-for-range',
    GET_CLIENT_DETAIL: 'attribution:get-client-detail',
    GET_WORK_SESSIONS_FOR_DAY: 'attribution:get-work-sessions-for-day',
    GET_WORK_SESSION_SEGMENTS: 'attribution:get-work-session-segments',
    GET_ROLLUPS: 'attribution:get-rollups',
    GET_APP_WORK_SESSIONS: 'attribution:get-app-work-sessions',
    REASSIGN_SESSION: 'attribution:reassign-session',
  },
  SHELL: {
    OPEN_EXTERNAL: 'shell:open-external',
    OPEN_PATH: 'shell:open-path',
  },
} as const
