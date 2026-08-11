export const ANALYTICS_EVENT = {
  APP_LAUNCHED: 'app_launched',
  APP_CRASHED: 'app_crashed',
  MAIN_THREAD_STALLED: 'main_thread_stalled',
  VIEW_OPENED: 'view_opened',
  ANALYZE_DAY_CLICKED: 'analyze_day_clicked',
  AI_CHAT_SENT: 'ai_chat_sent',
  BLOCK_EDITED: 'block_edited',
  TRACKING_PAUSED: 'tracking_paused',
  TRACKING_RESUMED: 'tracking_resumed',
  PAYWALL_SEEN: 'paywall_seen',
  SUBSCRIPTION_STARTED: 'subscription_started',

  ONBOARDING_STARTED: 'onboarding_started',
  ONBOARDING_STEP_COMPLETED: 'onboarding_step_completed',
  ONBOARDING_COMPLETED: 'onboarding_completed',
  TRACKING_PERMISSION_UPDATED: 'tracking_permission_updated',
  TRACKING_PROOF_READY: 'tracking_proof_ready',

  TIMELINE_OPENED: 'timeline_opened',
  TIMELINE_BLOCK_OPENED: 'timeline_block_opened',
  APPS_OPENED: 'apps_opened',
  APP_DETAIL_OPENED: 'app_detail_opened',
  AI_SCREEN_OPENED: 'ai_screen_opened',

  AI_SUMMARY_GENERATED: 'ai_summary_generated',
  AI_SUGGESTED_QUESTION_IMPRESSION: 'ai_suggested_question_impression',
  AI_SUGGESTED_QUESTION_CLICKED: 'ai_suggested_question_clicked',
  AI_QUERY_SENT: 'ai_query_sent',
  AI_QUERY_ANSWERED: 'ai_query_answered',
  AI_ANSWER_COPIED: 'ai_answer_copied',
  AI_ANSWER_RETRIED: 'ai_answer_retried',
  AI_ANSWER_RATED: 'ai_answer_rated',
  AI_OUTPUT_REQUESTED: 'ai_output_requested',
  AI_OUTPUT_REDACTED: 'ai_output_redacted',
  AI_FOLLOWUP_SUGGESTIONS_FALLBACK: 'ai_followup_suggestions_fallback',
  AI_FOLLOWUP_RESOLUTION: 'ai_followup_resolution',
  AI_CITATION_RETRY: 'ai_citation_retry',
  AI_CITATION_FALLBACK: 'ai_citation_fallback',
  AI_EMPTY_RESPONSE_RETRY: 'ai_empty_response_retry',
  AI_JOB_COMPLETED: 'ai_job_completed',
  AI_JOB_FAILED: 'ai_job_failed',
  AI_PROVIDER_BREAKER_OPENED: 'ai_provider_breaker_opened',
  AI_PROVIDER_BREAKER_CLOSED: 'ai_provider_breaker_closed',
  AI_PROVIDER_BREAKER_SKIPPED: 'ai_provider_breaker_skipped',
  AI_USAGE_RETENTION_RUN: 'ai_usage_retention_run',

  FOCUS_SESSION_STARTED: 'focus_session_started',
  FOCUS_SESSION_STOPPED: 'focus_session_stopped',
  ARTIFACT_CREATED: 'artifact_created',
  AI_THREAD_CREATED: 'ai_thread_created',
  AI_THREAD_ARCHIVED: 'ai_thread_archived',
  AI_THREAD_DELETED: 'ai_thread_deleted',

  FEEDBACK_SUBMITTED: 'feedback_submitted',
  SETTINGS_CHANGED: 'settings_changed',
  UPDATE_CHECK_REQUESTED: 'update_check_requested',
  UPDATE_CHECK_COMPLETED: 'update_check_completed',
  UPDATE_AVAILABLE: 'update_available',
  UPDATE_DOWNLOADED: 'update_downloaded',
  UPDATE_INSTALL_REQUESTED: 'update_install_requested',
  UPDATE_INSTALL_STARTED: 'update_install_started',
  UPDATE_ERROR: 'update_error',
  SYNC_LINK_STARTED: 'sync_link_started',
  SYNC_LINK_COMPLETED: 'sync_link_completed',
  SYNC_LINK_FAILED: 'sync_link_failed',
  SYNC_BROWSER_LINK_CREATED: 'sync_browser_link_created',
  SYNC_DISCONNECTED: 'sync_disconnected',
  AI_PROVIDER_CONNECTION_STARTED: 'ai_provider_connection_started',
  AI_PROVIDER_CONNECTION_COMPLETED: 'ai_provider_connection_completed',
  AI_PROVIDER_CONNECTION_FAILED: 'ai_provider_connection_failed',

  TRACKING_ENGINE_HEALTH: 'tracking_engine_health',
  BROWSER_TRACKING_HEALTH: 'browser_tracking_health',
  DATABASE_HEALTH: 'database_health',
  DATABASE_INIT_FAILED: 'database_init_failed',
  RENDERER_PROCESS_GONE: 'renderer_process_gone',

  // Which optional Wrapped connectors fired for a day (source NAMES only,
  // never the data) — tells us what enrichment to prioritize building next.
  WRAPPED_EXTERNAL_SOURCES: 'wrapped_external_sources',

  ACTIVATION_COMPLETED: 'activation_completed',
  FIRST_DAY_WITH_RECONSTRUCTED_TIMELINE: 'first_day_with_reconstructed_timeline',
  FIRST_AI_QUESTION_ANSWERED: 'first_ai_question_answered',
  FIRST_REPORT_EXPORTED: 'first_report_exported',
  FEATURE_ADOPTION: 'feature_adoption',
  WEEKLY_ACTIVE_USER: 'weekly_active_user',
  RETAINED_DAY_1: 'retained_day_1',
  RETAINED_DAY_7: 'retained_day_7',

  // Screen-context experiment measurement contract: consent transitions,
  // capture attempts/blocks by closed-enum reason, extraction outcomes with
  // latency/size/backlog BUCKETS only. No event may carry an image, OCR text,
  // title, URL, domain, application name, filename, person, project, client,
  // evidence identifier, or exact activity timestamp.
  SCREEN_CONTEXT_CONSENT: 'screen_context_consent',
  SCREEN_CONTEXT_CAPTURE: 'screen_context_capture',
  SCREEN_CONTEXT_EXTRACTION: 'screen_context_extraction',
  SCREEN_CONTEXT_BACKLOG: 'screen_context_backlog',
} as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT)[keyof typeof ANALYTICS_EVENT]

const KNOWN_ANALYTICS_EVENTS = new Set<string>(Object.values(ANALYTICS_EVENT))

// The renderer reaches capture() only through IPC (analytics:capture) — this
// is the main process's check that the string it received is actually one of
// ours before forwarding it to PostHog, not whatever a compromised or buggy
// renderer sent across the bridge.
export function isKnownAnalyticsEvent(event: string): event is AnalyticsEventName {
  return KNOWN_ANALYTICS_EVENTS.has(event)
}

// Where a paywall was shown or a checkout was launched from. Shared by
// paywall_seen and subscription_started so a purchase attributes to the
// surface that sold it, not a hardcoded default.
export const PAYWALL_TRIGGERS = ['onboarding', 'proof_screen', 'day3_prompt', 'settings'] as const

export type PaywallTrigger = (typeof PAYWALL_TRIGGERS)[number]

// Checkout trigger strings cross the IPC bridge from the renderer — validate
// them the same way event names are validated above.
export function isPaywallTrigger(value: unknown): value is PaywallTrigger {
  return typeof value === 'string' && (PAYWALL_TRIGGERS as readonly string[]).includes(value)
}

export interface AIGenerationUsage {
  traceId: string
  jobType: string
  provider?: string | null
  model?: string | null
  latencyMs: number
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  isError?: boolean
  daylensCostUsd?: number | null
  daylensCostSource?: 'provider' | 'estimated' | null
}

// The $ai_generation payload for PostHog LLM analytics. Two invariants this
// build must never break: (1) no prompt or completion content — only numeric
// usage, model, and job names leave the machine; (2) no $ai_*_cost_usd
// properties — PostHog then prices the tokens itself (OpenRouter data), which
// is the point: an independent cost figure to check the local meter
// (daylens_cost_usd, same call, our pricing table) against.
export function buildAIGenerationProperties(usage: AIGenerationUsage): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {
    $ai_trace_id: usage.traceId,
    $ai_span_name: usage.jobType,
    $ai_latency: Math.max(0, usage.latencyMs) / 1000,
  }
  if (usage.provider) properties.$ai_provider = usage.provider
  if (usage.model) properties.$ai_model = usage.model
  if (usage.inputTokens != null) properties.$ai_input_tokens = usage.inputTokens
  if (usage.outputTokens != null) properties.$ai_output_tokens = usage.outputTokens
  if (usage.cacheReadTokens != null) properties.$ai_cache_read_input_tokens = usage.cacheReadTokens
  if (usage.cacheWriteTokens != null) properties.$ai_cache_creation_input_tokens = usage.cacheWriteTokens
  if (usage.isError) properties.$ai_is_error = true
  if (usage.daylensCostUsd != null) {
    properties.daylens_cost_usd = usage.daylensCostUsd
    properties.daylens_cost_source = usage.daylensCostSource ?? 'estimated'
  }
  return properties
}

export type AnalyticsFeature =
  | 'timeline'
  | 'apps'
  | 'ai'
  | 'export'
  | 'notifications'

export type AnalyticsOutputKind = 'question' | 'report' | 'chart' | 'table' | 'export'

export type AnalyticsPropertyValue = string | number | boolean | null | string[]

const SAFE_STRING_KEYS = new Set([
  'action',
  'answer_kind',
  'block_count_bucket',
  'build_channel',
  'cache_policy',
  'connection_kind',
  'failure_kind',
  'feature',
  'followup_class',
  'job_type',
  'kind',
  'model',
  'module_source',
  'os_version',
  'permission_state',
  'platform',
  'process_type',
  'provider',
  'query_kind',
  'rating',
  'reason',
  'result',
  'screen',
  'source',
  'source_kind',
  'stage',
  'status',
  'step',
  'surface',
  'trigger',
  'trigger_source',
  'tracked_time_bucket',
  'view',
  'app_version',
  'export_type',
  'version',
  'duration_bucket',
  'artifact_kind',
  'byte_size_bucket',
  'thread_action',
  'view_name',
  'date_context',
  'date',
  'what_changed',
  'block_id',
  'thread_id',
  'model_used',
  'step_name',
  'subscription_status',
  'plan',
  // Screen-context measurement vocabulary — closed enums and buckets only.
  'outcome',
  'blocked_reason',
  'latency_bucket',
  'byte_bucket',
  'backlog_bucket',
])

const SAFE_NUMBER_KEYS = new Set([
  'cache_read_tokens',
  'cache_write_tokens',
  'date_offset_days',
  'days_since_activation',
  'input_tokens',
  'latency_ms',
  'output_tokens',
  'progress_pct',
  'score',
  'selected_goal_count',
  'source_count',
  'suggestion_count',
  'missing_entity_count',
  'rejected_generic_count',
  'rejected_temporal_count',
  'rejected_entity_count',
  'rejected_shape_count',
  'duration_sec',
  'target_minutes',
  'block_count',
  'block_count_before',
  'tracked_hours',
  'message_length',
  'days_since_install',
  'step_index',
  'total_steps',
  'price',
  'retry_count',
])

const SAFE_BOOLEAN_KEYS = new Set([
  'cache_hit',
  'has_ai_provider',
  'has_comment',
  'has_tracking_permission',
  'is_packaged',
  'onboarding_complete',
  'reset_context',
  'reused_context',
  'has_completed_onboarding',
  'has_date_context',
  'added_new_fact',
])

const SAFE_ARRAY_KEYS = new Set([
  'settings_changed_keys',
])

// Connector source names ('git', 'calendar', 'focus_app') — a closed enum, so
// the sanitizer passes only these exact values and never free text.
const SAFE_EXTERNAL_SOURCE_VALUES = new Set(['git', 'calendar', 'focus_app'])

const TRACKING_SETTING_KEYS = [
] as const

const AI_SETTING_KEYS = [
  'aiProvider',
  'anthropicModel',
  'openaiModel',
  'googleModel',
  'aiFallbackOrder',
  'aiModelStrategy',
  'aiChatProvider',
  'aiBackgroundEnrichment',
  'aiActiveBlockPreview',
  'aiPromptCachingEnabled',
  'aiSpendSoftLimitUsd',
  'aiRedactFilePaths',
  'aiRedactEmails',
] as const

const PRIVACY_SETTING_KEYS = [
  'shareAIFeedbackExamples',
  'allowThirdPartyWebsiteIconFallback',
] as const

export const NOTIFICATION_SETTING_KEYS = [
  'dailySummaryEnabled',
  'morningNudgeEnabled',
  'distractionAlertsEnabled',
  'distractionAlertThresholdMinutes',
] as const

const APPEARANCE_SETTING_KEYS = [
  'theme',
] as const

const SAFE_SETTINGS_KEYS = new Set<string>([
  ...TRACKING_SETTING_KEYS,
  ...AI_SETTING_KEYS,
  ...PRIVACY_SETTING_KEYS,
  ...NOTIFICATION_SETTING_KEYS,
  ...APPEARANCE_SETTING_KEYS,
])

const URL_LIKE_RE = /\b(?:https?:\/\/|www\.)/i
const EMAIL_LIKE_RE = /\b\S+@\S+\.\S+\b/
const PATH_LIKE_RE = /(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/var\/|\/tmp\/|\\{2}|\/[^/\s]+\/[^/\s]+)/

function isSensitiveString(value: string): boolean {
  return (
    value.length > 120
    || URL_LIKE_RE.test(value)
    || EMAIL_LIKE_RE.test(value)
    || PATH_LIKE_RE.test(value)
  )
}

function sanitizeString(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || isSensitiveString(trimmed)) return null
  return trimmed
}

export function sanitizeSettingsChangedKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.filter((key) => SAFE_SETTINGS_KEYS.has(key)))).sort()
}

export function sanitizeAnalyticsProperties(
  properties?: Record<string, unknown>,
): Record<string, AnalyticsPropertyValue> {
  if (!properties) return {}

  const sanitized: Record<string, AnalyticsPropertyValue> = {}

  for (const [key, rawValue] of Object.entries(properties)) {
    if (SAFE_STRING_KEYS.has(key)) {
      if (typeof rawValue !== 'string') continue
      const value = sanitizeString(rawValue)
      if (value !== null) sanitized[key] = value
      continue
    }

    if (SAFE_NUMBER_KEYS.has(key)) {
      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        // Two decimals: integers pass through unchanged; fractional metrics
        // (e.g. tracked_hours) keep useful precision without leaking noise.
        sanitized[key] = Math.round(rawValue * 100) / 100
      }
      continue
    }

    if (SAFE_BOOLEAN_KEYS.has(key)) {
      if (typeof rawValue === 'boolean') sanitized[key] = rawValue
      continue
    }

    if (SAFE_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(rawValue)) continue
      sanitized[key] = sanitizeSettingsChangedKeys(
        rawValue.filter((value): value is string => typeof value === 'string'),
      )
      continue
    }

    if (key === 'external_sources') {
      if (!Array.isArray(rawValue)) continue
      sanitized[key] = rawValue
        .filter((value): value is string => typeof value === 'string' && SAFE_EXTERNAL_SOURCE_VALUES.has(value))
        .sort()
      continue
    }
  }

  return sanitized
}

export function blockCountBucket(count: number): string {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 3) return '2_3'
  if (count <= 7) return '4_7'
  if (count <= 15) return '8_15'
  return '16_plus'
}

export function focusDurationBucket(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0m'
  if (totalSeconds < 5 * 60) return 'under_5m'
  if (totalSeconds < 15 * 60) return '5_14m'
  if (totalSeconds < 25 * 60) return '15_24m'
  if (totalSeconds < 45 * 60) return '25_44m'
  if (totalSeconds < 90 * 60) return '45_89m'
  return '90m_plus'
}

export function byteSizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0'
  if (bytes < 1024) return 'under_1kb'
  if (bytes < 10 * 1024) return '1_10kb'
  if (bytes < 100 * 1024) return '10_100kb'
  if (bytes < 1024 * 1024) return '100kb_1mb'
  return 'over_1mb'
}

export function trackedTimeBucket(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0m'
  if (totalSeconds < 15 * 60) return 'under_15m'
  if (totalSeconds < 60 * 60) return '15_59m'
  if (totalSeconds < 3 * 60 * 60) return '1_3h'
  if (totalSeconds < 6 * 60 * 60) return '3_6h'
  if (totalSeconds < 10 * 60 * 60) return '6_10h'
  return '10h_plus'
}

export function classifyAIOutputIntent(text: string): AnalyticsOutputKind {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return 'question'
  if (/\bexport\b/.test(normalized)) return 'export'
  if (/\breport\b/.test(normalized)) return 'report'
  if (/\bchart\b|\bgraph\b|\bplot\b/.test(normalized)) return 'chart'
  if (/\btable\b|\bcsv\b|\bspreadsheet\b/.test(normalized)) return 'table'
  return 'question'
}

export function classifyFailureKind(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name} ${error.message}`.toLowerCase()
    : String(error).toLowerCase()

  if (!message.trim()) return 'unknown'
  if (/\b401\b|\b403\b|auth|credential|api key|forbidden|unauthorized/.test(message)) return 'auth'
  if (/\b402\b|\b429\b|quota|rate limit|rate-limited|too many requests/.test(message)) return 'quota_or_rate_limit'
  if (/timeout|timed out|etimedout|abort/.test(message)) return 'timeout'
  if (/network|fetch failed|econn|enotfound|dns|offline|socket/.test(message)) return 'network'
  if (/permission|denied|restricted/.test(message)) return 'permission'
  if (/sqlite|database|migration|pragma|wal/.test(message)) return 'database'
  if (/update|updater/.test(message)) return 'updater'
  if (/provider|model/.test(message)) return 'provider'
  if (/workspace|sync|link/.test(message)) return 'sync'
  return 'unknown'
}

export function featureForView(view: string): AnalyticsFeature | null {
  if (view === 'timeline') return 'timeline'
  if (view === 'apps') return 'apps'
  // 'ai' is the route name; 'insights' is the view_name the taxonomy uses.
  if (view === 'ai' || view === 'insights') return 'ai'
  return null
}
