import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import {
  ANALYTICS_EVENT,
  NOTIFICATION_SETTING_KEYS,
  blockCountBucket,
  classifyFailureKind,
  featureForView,
  sanitizeAnalyticsProperties,
  type AnalyticsEventName,
  type AnalyticsFeature,
  type AnalyticsPropertyValue,
} from '@shared/analytics'
import { getSettings } from './settings'

declare const __POSTHOG_KEY__: string
declare const __POSTHOG_HOST__: string
declare const __SENTRY_DSN__: string

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

type SentryMain = typeof import('@sentry/electron/main')

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
let sentryMain: SentryMain | null = null
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

async function persistAnalyticsState(): Promise<void> {
  try {
    const store = await getStore()
    store.set(ANALYTICS_STATE_KEY, analyticsState)
  } catch {
    // Best effort only — analytics state should never block the app.
  }
}

function isTelemetryEnabled(): boolean {
  return getSettings().analyticsOptIn
}

function isPosthogEnabled(): boolean {
  return isTelemetryEnabled() && Boolean(__POSTHOG_KEY__)
}

function isSentryEnabled(): boolean {
  return isTelemetryEnabled() && Boolean(__SENTRY_DSN__)
}

function getPosthog(): PostHogClient | null {
  if (!isPosthogEnabled()) return null

  if (!posthogClient) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PostHog } = require('posthog-node') as typeof import('posthog-node')
      posthogClient = new PostHog(__POSTHOG_KEY__, {
        disableGeoip: true,
        flushAt: 5,
        flushInterval: 15_000,
        host: __POSTHOG_HOST__ || 'https://us.i.posthog.com',
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

function redactSentryText(value: unknown): string | undefined {
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

function sanitizeSentryExtra(value: unknown): unknown {
  if (typeof value === 'string') return redactSentryText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitizeSentryExtra(item))
  if (!value || typeof value !== 'object') return undefined

  const sanitizedEntries = Object.entries(value as Record<string, unknown>)
    .slice(0, 20)
    .map(([key, entry]) => [key, sanitizeSentryExtra(entry)] as const)
    .filter(([, entry]) => entry !== undefined)

  return Object.fromEntries(sanitizedEntries)
}

function sanitizeSentryEvent(event: Record<string, any>): Record<string, any> | null {
  event.user = undefined
  event.request = undefined
  event.breadcrumbs = []

  if (typeof event.message === 'string') {
    event.message = redactSentryText(event.message)
  }

  if (event.logentry) {
    event.logentry = {
      ...event.logentry,
      formatted: redactSentryText(event.logentry.formatted),
      message: redactSentryText(event.logentry.message),
    }
  }

  if (Array.isArray(event.exception?.values)) {
    event.exception.values = event.exception.values.map((value: Record<string, unknown>) => ({
      ...value,
      value: redactSentryText(value.value),
    }))
  }

  if (event.extra && typeof event.extra === 'object') {
    event.extra = sanitizeSentryExtra(event.extra)
  }

  return event
}

function getSentry(): SentryMain | null {
  if (!isSentryEnabled()) return null

  if (!sentryMain) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Sentry = require('@sentry/electron/main') as SentryMain
      Sentry.init({
        beforeBreadcrumb: () => null,
        beforeSend: ((event: any) => sanitizeSentryEvent(event)) as any,
        dsn: __SENTRY_DSN__,
        enabled: true,
        environment: buildChannel(),
        release: `daylens@${app.getVersion()}`,
        sendDefaultPii: false,
      })
      Sentry.setTag('app_version', app.getVersion())
      Sentry.setTag('build_channel', buildChannel())
      Sentry.setTag('platform', process.platform)
      sentryMain = Sentry
    } catch {
      return null
    }
  }

  return sentryMain
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

  if (event === ANALYTICS_EVENT.VIEW_OPENED && typeof properties.view === 'string') {
    const feature = featureForView(properties.view)
    if (feature) recordFeatureAdoption(feature, properties.view)
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

export function identifyAnonymousIdentity(): void {
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
    const Sentry = getSentry()
    if (!Sentry) return
    Sentry.setTag('analytics_opt_in', String(isTelemetryEnabled()))
    Sentry.setUser({ id: distinctId })
  } catch {
    // Best effort only.
  }
}

export async function updateAnalyticsPreference(enabled: boolean): Promise<void> {
  if (enabled) {
    await initAnalytics()
    return
  }

  try {
    posthogClient?.disable?.()
  } catch {
    // Best effort only.
  }

  posthogClient = null
  posthogErrorHandlerAttached = false

  if (sentryMain) {
    try {
      void sentryMain.close(2_000)
    } catch {
      // Best effort only.
    }
  }

  sentryMain = null
}

export function capture(event: AnalyticsEventName, properties?: Record<string, unknown>): void {
  const sanitized = sanitizeAnalyticsProperties(properties)
  captureInternal(event, sanitized)
  maybeRecordDerivedEvents(event, sanitized)
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
    const Sentry = getSentry()
    if (!Sentry) return
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    Sentry.captureException(normalizedError, {
      extra: sanitizeSentryExtra({
        error_name: errorName,
        failure_kind: failureKind,
        ...context?.extra,
      }) as Record<string, unknown> | undefined,
      fingerprint: context?.fingerprint,
      tags: {
        build_channel: buildChannel(),
        platform: process.platform,
        ...context?.tags,
      },
    })
  } catch {
    // Never let crash reporting crash the app.
  }
}

export async function flush(): Promise<void> {
  const pending: Array<Promise<unknown>> = []

  try {
    if (posthogClient?.flush) pending.push(posthogClient.flush())
  } catch {
    // Best effort only.
  }

  try {
    if (sentryMain?.flush) pending.push(sentryMain.flush(2_000))
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

  try {
    if (sentryMain?.close) pending.push(sentryMain.close(2_000))
  } catch {
    // Best effort only.
  }

  if (pending.length > 0) {
    await Promise.allSettled(pending)
  }

  posthogClient = null
  posthogErrorHandlerAttached = false
  sentryMain = null
}
