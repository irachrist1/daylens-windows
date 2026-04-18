import type { AIAnswerKind, AIJobType, AISurface } from './types'

export const ANALYTICS_EVENT = {
  APP_LAUNCHED: 'app_launched',
  APP_CRASHED: 'app_crashed',
  VIEW_OPENED: 'view_opened',

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
  AI_FOLLOWUP_SUGGESTIONS_FALLBACK: 'ai_followup_suggestions_fallback',
  AI_FOLLOWUP_RESOLUTION: 'ai_followup_resolution',
  AI_JOB_COMPLETED: 'ai_job_completed',
  AI_JOB_FAILED: 'ai_job_failed',

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

  ACTIVATION_COMPLETED: 'activation_completed',
  FIRST_DAY_WITH_RECONSTRUCTED_TIMELINE: 'first_day_with_reconstructed_timeline',
  FIRST_AI_QUESTION_ANSWERED: 'first_ai_question_answered',
  FIRST_REPORT_EXPORTED: 'first_report_exported',
  FEATURE_ADOPTION: 'feature_adoption',
  WEEKLY_ACTIVE_USER: 'weekly_active_user',
  RETAINED_DAY_1: 'retained_day_1',
  RETAINED_DAY_7: 'retained_day_7',
} as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT)[keyof typeof ANALYTICS_EVENT]

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
  'suggestion_count',
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
])

const SAFE_ARRAY_KEYS = new Set([
  'settings_changed_keys',
])

export const TRACKING_SETTING_KEYS = [
  'launchOnLogin',
] as const

export const AI_SETTING_KEYS = [
  'aiProvider',
  'anthropicModel',
  'openaiModel',
  'googleModel',
  'aiFallbackOrder',
  'aiModelStrategy',
  'aiChatProvider',
  'aiBlockNamingProvider',
  'aiSummaryProvider',
  'aiArtifactProvider',
  'aiBackgroundEnrichment',
  'aiActiveBlockPreview',
  'aiPromptCachingEnabled',
  'aiSpendSoftLimitUsd',
  'aiRedactFilePaths',
  'aiRedactEmails',
] as const

export const PRIVACY_SETTING_KEYS = [
  'analyticsOptIn',
  'allowThirdPartyWebsiteIconFallback',
] as const

export const NOTIFICATION_SETTING_KEYS = [
  'dailySummaryEnabled',
  'morningNudgeEnabled',
  'distractionAlertsEnabled',
  'distractionAlertThresholdMinutes',
] as const

export const APPEARANCE_SETTING_KEYS = [
  'theme',
] as const

export const SAFE_SETTINGS_KEYS = new Set<string>([
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
        sanitized[key] = Math.round(rawValue)
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
  if (view === 'ai') return 'ai'
  return null
}

export function featureForSurface(surface: AISurface | 'timeline' | 'apps' | 'ai' | 'settings'): AnalyticsFeature | null {
  if (surface === 'timeline' || surface === 'timeline_day' || surface === 'timeline_week') return 'timeline'
  if (surface === 'apps' || surface === 'apps_list' || surface === 'app_detail') return 'apps'
  if (surface === 'ai' || surface === 'ai_chat') return 'ai'
  return null
}

export function isExportLikeJob(jobType: AIJobType, answerKind?: AIAnswerKind | null): boolean {
  return jobType === 'report_generation' || answerKind === 'day_summary_style'
}
