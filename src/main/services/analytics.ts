import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import {
  ANALYTICS_EVENT,
  NOTIFICATION_SETTING_KEYS,
  blockCountBucket,
  buildAIGenerationProperties,
  classifyFailureKind,
  featureForView,
  sanitizeAnalyticsProperties,
  type AIGenerationUsage,
  type AnalyticsEventName,
  type AnalyticsFeature,
  type AnalyticsPropertyValue,
} from '@shared/analytics'
import { getSettings } from './settings'
import { isRealDayExternalAccessAllowed } from '../lib/realDayHarness'

declare const __POSTHOG_KEY__: string
declare const __POSTHOG_HOST__: string

type StoreLike = {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

type PostHogClient = {
  capture: (args: Record<string, unknown>) => void
  disable?: () => void
  flush?: () => Promise<void>
  identify?: (args: Record<string, unknown>) => void
  on?: (event: string, listener: (error: unknown) => void) => void
  register?: (properties: Record<string, unknown>) => void
  shutdown: () => Promise<void>
}


interface AnalyticsState {
  activationCompletedAt: number | null
  featureAdoptions: Partial<Record<AnalyticsFeature, number>>
  firstSeenAt: number | null
  lastWeeklyActiveWeek: string | null
  milestones: Record<string, number>
  retainedDay1At: number | null
  retainedDay7At: number | null
}

const ANALYTICS_ID_KEY = 'analyticsId'
const ANALYTICS_STATE_KEY = 'analyticsState'
const DAY_MS = 86_400_000

let distinctId: string = randomUUID()
let analyticsState: AnalyticsState = defaultAnalyticsState()
let storePromise: Promise<StoreLike> | null = null
let posthogClient: PostHogClient | null = null
let analyticsBootstrapped = false
let posthogErrorHandlerAttached = false
const rateLimitAt = new Map<string, number>()

function defaultAnalyticsState(): AnalyticsState {
  return {
    activationCompletedAt: null,
    featureAdoptions: {},
    firstSeenAt: null,
    lastWeeklyActiveWeek: null,
    milestones: {},
    retainedDay1At: null,
    retainedDay7At: null,
  }
}

function buildChannel(): string {
  const version = app.getVersion().toLowerCase()
  if (!app.isPackaged) return 'development'
  if (version.includes('alpha')) return 'alpha'
  if (version.includes('beta')) return 'beta'
  if (version.includes('rc')) return 'rc'
  return 'stable'
}

function hasTrackingPermission(): boolean {
  return getSettings().onboardingState.trackingPermissionState === 'granted'
}

function globalProperties(): Record<string, AnalyticsPropertyValue> {
  return sanitizeAnalyticsProperties({
    app_version: app.getVersion(),
    build_channel: buildChannel(),
    has_tracking_permission: hasTrackingPermission(),
    is_packaged: app.isPackaged,
    platform: process.platform,
  })
}

async function getStore(): Promise<StoreLike> {
  if (!storePromise) {
    storePromise = import('electron-store')
      .then(({ default: Store }) => new Store() as StoreLike)
  }
  return storePromise
}

async function loadIdentityAndState(): Promise<void> {
  const store = await getStore()

  let storedId = store.get(ANALYTICS_ID_KEY, null) as string | null
  if (!storedId) {
    storedId = randomUUID()
    store.set(ANALYTICS_ID_KEY, storedId)
  }
  distinctId = storedId

  const persisted = store.get(ANALYTICS_STATE_KEY, null)
  const candidate = persisted && typeof persisted === 'object'
    ? persisted as Partial<AnalyticsState>
    : {}

  analyticsState = {
    activationCompletedAt: typeof candidate.activationCompletedAt === 'number' ? candidate.activationCompletedAt : null,
    featureAdoptions: candidate.featureAdoptions && typeof candidate.featureAdoptions === 'object'
      ? candidate.featureAdoptions as AnalyticsState['featureAdoptions']
      : {},
    firstSeenAt: typeof candidate.firstSeenAt === 'number' ? candidate.firstSeenAt : null,
    lastWeeklyActiveWeek: typeof candidate.lastWeeklyActiveWeek === 'string' ? candidate.lastWeeklyActiveWeek : null,
    milestones: candidate.milestones && typeof candidate.milestones === 'object'
      ? candidate.milestones as Record<string, number>
      : {},
    retainedDay1At: typeof candidate.retainedDay1At === 'number' ? candidate.retainedDay1At : null,
    retainedDay7At: typeof candidate.retainedDay7At === 'number' ? candidate.retainedDay7At : null,
  }

  if (!analyticsState.firstSeenAt) {
    analyticsState.firstSeenAt = Date.now()
    void persistAnalyticsState()
  }
}

// Intercom uses the same id as PostHog so both tools see one person per install.
// Valid after initAnalytics() has run (app startup); before that it's a
// throwaway UUID that never leaves the process.
export function getAnalyticsDistinctId(): string {
  return distinctId
}

async function persistAnalyticsState(): Promise<void> {
  try {
    const store = await getStore()
    store.set(ANALYTICS_STATE_KEY, analyticsState)
  } catch {
    // Best effort only — analytics state should never block the app.
  }
}

function isTelemetryEnabled(): boolean {
  // Telemetry ships on by default. Events are anonymous and
  // allowlist-sanitized; the only kill switch is building without a
  // PostHog key.
  return isRealDayExternalAccessAllowed('analytics')
}

function isPosthogEnabled(): boolean {
  return isTelemetryEnabled() && Boolean(__POSTHOG_KEY__)
}

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

// posthog-node forwards `host` straight into fetch() with no scheme check of
// its own — a misconfigured build secret (typo, accidental http://, a stray
// query string) would otherwise send telemetry in plaintext or to whatever
// host that string names. This is the one place that risk is closed off:
// only an https: URL is ever handed to the client.
function safePosthogHost(): string {
  const configured = __POSTHOG_HOST__.trim()
  if (!configured) return DEFAULT_POSTHOG_HOST
  try {
    const parsed = new URL(configured)
    if (parsed.protocol === 'https:') return configured
  } catch {
    // Malformed host string — fall through to the safe default.
  }
  console.warn('[analytics] POSTHOG_HOST is not a valid https URL; using the default host instead.')
  return DEFAULT_POSTHOG_HOST
}

function getPosthog(): PostHogClient | null {
  if (!isPosthogEnabled()) return null

  if (!posthogClient) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PostHog } = require('posthog-node') as typeof import('posthog-node')
      posthogClient = new PostHog(__POSTHOG_KEY__, {
        disableGeoip: true,
        flushAt: 5,
        flushInterval: 15_000,
        host: safePosthogHost(),
      }) as unknown as PostHogClient
      posthogClient.register?.(globalProperties())
      if (!posthogErrorHandlerAttached) {
        posthogClient.on?.('error', (error) => {
          console.warn('[analytics] PostHog error:', error)
        })
        posthogErrorHandlerAttached = true
      }
    } catch {
      return null
    }
  }

  return posthogClient
}

function redactTelemetryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed
    .replace(/\bhttps?:\/\/\S+\b/gi, '[url]')
    .replace(/\b\S+@\S+\.\S+\b/g, '[email]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\/Users\/[^\s]+/g, '[path]')
    .replace(/\/home\/[^\s]+/g, '[path]')
    .replace(/\/var\/[^\s]+/g, '[path]')
    .replace(/\/tmp\/[^\s]+/g, '[path]')
    .slice(0, 180)
}

function sanitizeTelemetryExtra(value: unknown): unknown {
  if (typeof value === 'string') return redactTelemetryText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitizeTelemetryExtra(item))
  if (!value || typeof value !== 'object') return undefined

  const sanitizedEntries = Object.entries(value as Record<string, unknown>)
    .slice(0, 20)
    .map(([key, entry]) => [key, sanitizeTelemetryExtra(entry)] as const)
    .filter(([, entry]) => entry !== undefined)

  return Object.fromEntries(sanitizedEntries)
}

function captureInternal(
  event: AnalyticsEventName,
  properties?: Record<string, unknown>,
): void {
  try {
    const client = getPosthog()
    if (!client) return

    client.register?.(globalProperties())

    client.capture({
      disableGeoip: true,
      distinctId,
      event,
      properties: {
        ...globalProperties(),
        ...sanitizeAnalyticsProperties(properties),
        $process_person_profile: false,
      },
    })
  } catch {
    // Never let analytics crash the app.
  }
}

function weekKeyForDate(timestamp: number): string {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + diff)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localMidnight(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function recordMilestoneOnce(event: AnalyticsEventName, properties?: Record<string, unknown>): void {
  if (analyticsState.milestones[event]) return
  const recordedAt = Date.now()
  analyticsState.milestones[event] = recordedAt
  if (event === ANALYTICS_EVENT.ACTIVATION_COMPLETED) {
    analyticsState.activationCompletedAt = recordedAt
  }
  void persistAnalyticsState()
  captureInternal(event, properties)
}

function recordFeatureAdoption(feature: AnalyticsFeature, surface?: string): void {
  if (analyticsState.featureAdoptions[feature]) return
  analyticsState.featureAdoptions[feature] = Date.now()
  void persistAnalyticsState()
  captureInternal(ANALYTICS_EVENT.FEATURE_ADOPTION, {
    feature,
    ...(surface ? { surface } : {}),
  })
}

function maybeRecordWeeklyActiveUser(): void {
  const currentWeekKey = weekKeyForDate(Date.now())
  if (analyticsState.lastWeeklyActiveWeek === currentWeekKey) return
  analyticsState.lastWeeklyActiveWeek = currentWeekKey
  void persistAnalyticsState()
  captureInternal(ANALYTICS_EVENT.WEEKLY_ACTIVE_USER)
}

function maybeRecordRetention(): void {
  if (!analyticsState.activationCompletedAt) return

  const daysSinceActivation = Math.floor(
    (localMidnight(Date.now()) - localMidnight(analyticsState.activationCompletedAt)) / DAY_MS,
  )

  if (daysSinceActivation >= 1 && !analyticsState.retainedDay1At) {
    analyticsState.retainedDay1At = Date.now()
    void persistAnalyticsState()
    captureInternal(ANALYTICS_EVENT.RETAINED_DAY_1, { days_since_activation: 1 })
  }

  if (daysSinceActivation >= 7 && !analyticsState.retainedDay7At) {
    analyticsState.retainedDay7At = Date.now()
    void persistAnalyticsState()
    captureInternal(ANALYTICS_EVENT.RETAINED_DAY_7, { days_since_activation: 7 })
  }
}

function maybeRecordDerivedEvents(
  event: AnalyticsEventName,
  properties: Record<string, AnalyticsPropertyValue>,
): void {
  if (event === ANALYTICS_EVENT.APP_LAUNCHED || event === ANALYTICS_EVENT.VIEW_OPENED) {
    maybeRecordWeeklyActiveUser()
    maybeRecordRetention()
  }

  if (event === ANALYTICS_EVENT.VIEW_OPENED) {
    const viewName = typeof properties.view_name === 'string'
      ? properties.view_name
      : typeof properties.view === 'string' ? properties.view : null
    const feature = viewName ? featureForView(viewName) : null
    if (feature && viewName) recordFeatureAdoption(feature, viewName)
  }

  if (event === ANALYTICS_EVENT.TIMELINE_OPENED) {
    recordFeatureAdoption('timeline', String(properties.surface ?? 'timeline'))

    const hasBlocks = properties.block_count_bucket && properties.block_count_bucket !== blockCountBucket(0)
    const hasTrackedTime = properties.tracked_time_bucket && properties.tracked_time_bucket !== '0m'
    if (hasBlocks || hasTrackedTime) {
      recordMilestoneOnce(ANALYTICS_EVENT.FIRST_DAY_WITH_RECONSTRUCTED_TIMELINE, properties)
      if (getSettings().onboardingComplete) {
        recordMilestoneOnce(ANALYTICS_EVENT.ACTIVATION_COMPLETED, properties)
      }
    }
  }

  if (event === ANALYTICS_EVENT.APPS_OPENED) {
    recordFeatureAdoption('apps', String(properties.surface ?? 'apps'))
  }

  if (event === ANALYTICS_EVENT.AI_SCREEN_OPENED) {
    recordFeatureAdoption('ai', String(properties.surface ?? 'ai'))
  }

  if (event === ANALYTICS_EVENT.AI_QUERY_ANSWERED && properties.query_kind === 'question') {
    recordMilestoneOnce(ANALYTICS_EVENT.FIRST_AI_QUESTION_ANSWERED, properties)
  }

  if (event === ANALYTICS_EVENT.AI_OUTPUT_REQUESTED) {
    recordFeatureAdoption('export', String(properties.surface ?? 'ai'))
    if (properties.export_type === 'export') {
      recordMilestoneOnce(ANALYTICS_EVENT.FIRST_REPORT_EXPORTED, properties)
    }
  }

  if (event === ANALYTICS_EVENT.SETTINGS_CHANGED) {
    const changedKeys = Array.isArray(properties.settings_changed_keys)
      ? properties.settings_changed_keys
      : []
    if (changedKeys.some((key) => NOTIFICATION_SETTING_KEYS.includes(key as typeof NOTIFICATION_SETTING_KEYS[number]))) {
      recordFeatureAdoption('notifications', String(properties.surface ?? 'settings'))
    }
  }
}

export async function initAnalytics(): Promise<void> {
  if (analyticsBootstrapped) {
    identifyAnonymousIdentity()
    return
  }

  analyticsBootstrapped = true
  try {
    await loadIdentityAndState()
    identifyAnonymousIdentity()
  } catch {
    analyticsBootstrapped = false
  }
}

function identifyAnonymousIdentity(): void {
  try {
    const client = getPosthog()
    if (!client) return
    client.register?.(globalProperties())
    client.identify?.({
      distinctId,
      properties: globalProperties(),
    })
  } catch {
    // Best effort only.
  }

  try {
    // PostHog identifies through capture's distinct_id; no separate call needed.
    void distinctId
  } catch {
    // Best effort only.
  }
}

export function capture(event: AnalyticsEventName, properties?: Record<string, unknown>): void {
  if (!isRealDayExternalAccessAllowed('analytics')) return
  const sanitized = sanitizeAnalyticsProperties(properties)
  captureInternal(event, sanitized)
  maybeRecordDerivedEvents(event, sanitized)
}

// The single call site for tracking_paused / tracking_resumed: every pause
// toggle path (settings IPC, tray) reports the transition through here.
// `reason` is 'user' for explicit toggles; excluded-app and incognito gates
// are momentary per-sample skips, not pause transitions, and do not fire this.
export function captureTrackingPauseTransition(paused: boolean, reason: 'user' | 'app_excluded' | 'incognito'): void {
  capture(paused ? ANALYTICS_EVENT.TRACKING_PAUSED : ANALYTICS_EVENT.TRACKING_RESUMED, { reason })
}

// PostHog LLM analytics ($ai_generation). Deliberately bypasses the
// feature-event sanitizer: the $ai_* namespace is PostHog's own schema (the
// allowlist would strip it), and the payload is built entirely in the main
// process from numeric usage data — buildAIGenerationProperties guarantees no
// prompt/completion content and no cost properties, so PostHog prices the
// tokens independently of the local meter.
export function captureAIGeneration(usage: AIGenerationUsage): void {
  try {
    const client = getPosthog()
    if (!client) return
    client.capture({
      disableGeoip: true,
      distinctId,
      event: '$ai_generation',
      properties: {
        ...globalProperties(),
        ...buildAIGenerationProperties(usage),
        $process_person_profile: false,
      },
    })
  } catch {
    // Never let analytics crash the app.
  }
}

export function captureRateLimited(
  event: AnalyticsEventName,
  rateKey: string,
  properties?: Record<string, unknown>,
  minIntervalMs = 30 * 60 * 1_000,
): void {
  const now = Date.now()
  const previous = rateLimitAt.get(rateKey) ?? 0
  if (now - previous < minIntervalMs) return
  rateLimitAt.set(rateKey, now)
  capture(event, properties)
}

// A stack filename must survive redaction or the trace is useless, but the
// absolute path names the person's home directory. Keep the code-identifying
// tail (everything from the last src/, dist/, app.asar/ or node_modules/
// boundary) and drop the machine-specific prefix entirely.
function redactStackPath(raw: string): string {
  const path = raw.replace(/^.*?(?=(?:src|dist|app\.asar|node_modules)\/)/, '')
  const trimmed = path === raw ? raw.split('/').slice(-2).join('/') : path
  return trimmed.replace(/^[A-Za-z]:\\/, '').slice(0, 180)
}

// Parsed frames give PostHog a readable trace instead of one opaque string.
// Capped at 50: a stack-overflow trace is thousands of identical frames and the
// payload still has to be ingestible.
function stackFrames(error: Error): Array<Record<string, unknown>> {
  const lines = (error.stack ?? '').split('\n').slice(1, 51)
  return lines.map((line) => {
    const match = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line)
    if (!match) return { raw_id: redactTelemetryText(line.trim()) }
    return {
      colno: Number(match[4]),
      filename: redactStackPath(match[2]),
      function: match[1] ?? '<anonymous>',
      in_app: !match[2].includes('node_modules'),
      lineno: Number(match[3]),
    }
  })
}

// $exception carries a nested $exception_list that the scalar allowlist in
// sanitizeAnalyticsProperties() would strip to nothing. Its payload is already
// redacted field by field on the way in, so it emits directly instead of
// through captureInternal.
function captureExceptionInternal(properties: Record<string, unknown>): void {
  try {
    const client = getPosthog()
    if (!client) return
    client.register?.(globalProperties())
    client.capture({
      disableGeoip: true,
      distinctId,
      event: '$exception',
      properties: {
        ...globalProperties(),
        ...properties,
        $process_person_profile: false,
      },
    })
  } catch {
    // Never let crash reporting crash the app.
  }
}

export function captureException(
  error: unknown,
  context?: {
    extra?: Record<string, unknown>
    fingerprint?: string[]
    tags?: Record<string, string>
  },
): void {
  const failureKind = classifyFailureKind(error)
  const errorName = error instanceof Error ? error.name : 'UnknownError'

  try {
    const normalized = error instanceof Error ? error : new Error(String(error))
    // PostHog error tracking ingests $exception with an $exception_list payload.
    // The stack is the whole point of this call — it is the only place a frame
    // reaches telemetry — so it is redacted, never dropped.
    captureExceptionInternal({
      $exception_fingerprint: context?.fingerprint?.join(':'),
      $exception_list: [{
        mechanism: { handled: true, synthetic: false },
        stacktrace: { frames: stackFrames(normalized), type: 'raw' },
        type: errorName,
        value: redactTelemetryText(normalized.message) ?? errorName,
      }],
      $exception_message: redactTelemetryText(normalized.message),
      $exception_type: errorName,
      build_channel: buildChannel(),
      error_name: errorName,
      failure_kind: failureKind,
      platform: process.platform,
      ...(sanitizeTelemetryExtra(context?.extra) as Record<string, unknown> | undefined),
      ...context?.tags,
    })
  } catch {
    // Never let crash reporting crash the app.
  }
}

async function flush(): Promise<void> {
  const pending: Array<Promise<unknown>> = []

  try {
    if (posthogClient?.flush) pending.push(posthogClient.flush())
  } catch {
    // Best effort only.
  }

  if (pending.length === 0) return
  await Promise.allSettled(pending)
}

export async function shutdown(): Promise<void> {
  try {
    await flush()
  } catch {
    // Best effort only.
  }

  const pending: Array<Promise<unknown>> = []

  try {
    if (posthogClient) pending.push(posthogClient.shutdown())
  } catch {
    // Best effort only.
  }


  if (pending.length > 0) {
    await Promise.allSettled(pending)
  }

  posthogClient = null
  posthogErrorHandlerAttached = false
}
