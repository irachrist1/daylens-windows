import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ANALYTICS_EVENT } from '../src/shared/analytics.ts'
import { __getElectronStoreSnapshot, __resetElectronStore } from './support/electron-store-stub.mjs'
import { __resetSettings, __setSettings } from './support/settings-stub.mjs'

type PostHogEventCall = {
  disableGeoip: boolean
  distinctId: string
  event: string
  properties: Record<string, unknown>
}

type PostHogIdentifyCall = {
  distinctId: string
  properties: Record<string, unknown>
}

type SentryCaptureCall = {
  context: Record<string, unknown>
  error: Error
}

function createPostHogHarness() {
  const instances: Array<{
    captures: PostHogEventCall[]
    disableCount: number
    flushCount: number
    identifyCalls: PostHogIdentifyCall[]
    key: string
    options: Record<string, unknown>
    registerCalls: Record<string, unknown>[]
    shutdownCount: number
  }> = []

  class FakePostHog {
    captures: PostHogEventCall[] = []
    disableCount = 0
    flushCount = 0
    identifyCalls: PostHogIdentifyCall[] = []
    key: string
    options: Record<string, unknown>
    registerCalls: Record<string, unknown>[] = []
    shutdownCount = 0

    constructor(key: string, options: Record<string, unknown>) {
      this.key = key
      this.options = options
      instances.push(this)
    }

    capture(args: PostHogEventCall) {
      this.captures.push(args)
    }

    disable() {
      this.disableCount += 1
    }

    async flush() {
      this.flushCount += 1
    }

    identify(args: PostHogIdentifyCall) {
      this.identifyCalls.push(args)
    }

    on() {
      // Listener registration is enough for these tests.
    }

    register(properties: Record<string, unknown>) {
      this.registerCalls.push(properties)
    }

    async shutdown() {
      this.shutdownCount += 1
    }
  }

  return {
    PostHog: FakePostHog,
    instances,
  }
}

function createSentryHarness() {
  const captureCalls: SentryCaptureCall[] = []
  const closeCalls: number[] = []
  const flushCalls: number[] = []
  const initCalls: Record<string, unknown>[] = []
  const tagCalls: Array<{ key: string, value: string }> = []
  const userCalls: Array<Record<string, unknown>> = []

  const module = {
    captureException(error: Error, context: Record<string, unknown>) {
      captureCalls.push({ context, error })
    },
    async close(timeout: number) {
      closeCalls.push(timeout)
    },
    async flush(timeout: number) {
      flushCalls.push(timeout)
    },
    init(options: Record<string, unknown>) {
      initCalls.push(options)
    },
    setTag(key: string, value: string) {
      tagCalls.push({ key, value })
    },
    setUser(user: Record<string, unknown>) {
      userCalls.push(user)
    },
  }

  return {
    captureCalls,
    closeCalls,
    flushCalls,
    initCalls,
    module,
    tagCalls,
    userCalls,
  }
}

function installRequireStub(posthogHarness: ReturnType<typeof createPostHogHarness>, sentryHarness: ReturnType<typeof createSentryHarness>) {
  const nodeRequire = createRequire(import.meta.url)
  const previousRequire = globalThis.require

  globalThis.require = ((specifier: string) => {
    if (specifier === 'posthog-node') {
      return { PostHog: posthogHarness.PostHog }
    }

    if (specifier === '@sentry/electron/main') {
      return sentryHarness.module
    }

    return nodeRequire(specifier)
  }) as typeof require

  return () => {
    if (previousRequire === undefined) {
      delete globalThis.require
      return
    }

    globalThis.require = previousRequire
  }
}

async function importFreshAnalyticsModule() {
  const moduleUrl = new URL(`../src/main/services/analytics.ts?test=${Date.now()}-${Math.random()}`, import.meta.url)
  return import(moduleUrl.href)
}

function resetHarnessState() {
  __resetElectronStore()
  __resetSettings()
  globalThis.__POSTHOG_KEY__ = 'phc_test_key'
  globalThis.__POSTHOG_HOST__ = ''
  globalThis.__SENTRY_DSN__ = 'https://public@example.ingest.sentry.io/1'
}

test('initAnalytics respects analytics opt-out while still persisting anonymous state', async () => {
  resetHarnessState()
  const posthogHarness = createPostHogHarness()
  const sentryHarness = createSentryHarness()
  const restoreRequire = installRequireStub(posthogHarness, sentryHarness)
  let analyticsModule: Awaited<ReturnType<typeof importFreshAnalyticsModule>> | null = null

  try {
    analyticsModule = await importFreshAnalyticsModule()
    await analyticsModule.initAnalytics()

    const storeSnapshot = __getElectronStoreSnapshot()

    assert.equal(typeof storeSnapshot.analyticsId, 'string')
    assert.equal(posthogHarness.instances.length, 0)
    assert.equal(sentryHarness.initCalls.length, 0)
  } finally {
    await analyticsModule?.shutdown()
    restoreRequire()
  }
})

test('initAnalytics wires PostHog and Sentry when telemetry is enabled, and shutdown flushes safely', async () => {
  resetHarnessState()
  __setSettings({
    analyticsOptIn: true,
    onboardingState: {
      trackingPermissionState: 'granted',
    },
  })

  const posthogHarness = createPostHogHarness()
  const sentryHarness = createSentryHarness()
  const restoreRequire = installRequireStub(posthogHarness, sentryHarness)
  let analyticsModule: Awaited<ReturnType<typeof importFreshAnalyticsModule>> | null = null

  try {
    analyticsModule = await importFreshAnalyticsModule()
    await analyticsModule.initAnalytics()

    assert.equal(posthogHarness.instances.length, 1)
    const client = posthogHarness.instances[0]
    const storeSnapshot = __getElectronStoreSnapshot()

    assert.equal(client.key, 'phc_test_key')
    assert.equal(client.options.host, 'https://us.i.posthog.com')
    assert.equal(client.identifyCalls.length, 1)
    assert.equal(client.identifyCalls[0].distinctId, storeSnapshot.analyticsId)
    assert.deepEqual(client.identifyCalls[0].properties, {
      app_version: '0.0.0-test',
      build_channel: 'development',
      has_tracking_permission: true,
      is_packaged: false,
      platform: process.platform,
    })
    assert.equal(sentryHarness.initCalls.length, 1)
    assert.deepEqual(sentryHarness.userCalls.at(-1), { id: storeSnapshot.analyticsId })

    await analyticsModule.shutdown()

    assert.equal(client.flushCount, 1)
    assert.equal(client.shutdownCount, 1)
    assert.deepEqual(sentryHarness.flushCalls, [2_000])
    assert.deepEqual(sentryHarness.closeCalls, [2_000])
  } finally {
    restoreRequire()
  }
})

test('updateAnalyticsPreference disables active analytics clients when the user opts out', async () => {
  resetHarnessState()
  __setSettings({
    analyticsOptIn: true,
  })

  const posthogHarness = createPostHogHarness()
  const sentryHarness = createSentryHarness()
  const restoreRequire = installRequireStub(posthogHarness, sentryHarness)
  let analyticsModule: Awaited<ReturnType<typeof importFreshAnalyticsModule>> | null = null

  try {
    analyticsModule = await importFreshAnalyticsModule()
    await analyticsModule.initAnalytics()

    const client = posthogHarness.instances[0]
    await analyticsModule.updateAnalyticsPreference(false)

    assert.equal(client.disableCount, 1)
    assert.deepEqual(sentryHarness.closeCalls, [2_000])
  } finally {
    await analyticsModule?.shutdown()
    restoreRequire()
  }
})

test('ai question milestone only records for question answers and remains one-time', async () => {
  resetHarnessState()
  __setSettings({
    analyticsOptIn: true,
  })

  const posthogHarness = createPostHogHarness()
  const sentryHarness = createSentryHarness()
  const restoreRequire = installRequireStub(posthogHarness, sentryHarness)
  let analyticsModule: Awaited<ReturnType<typeof importFreshAnalyticsModule>> | null = null

  try {
    analyticsModule = await importFreshAnalyticsModule()
    await analyticsModule.initAnalytics()

    const client = posthogHarness.instances[0]

    analyticsModule.capture(ANALYTICS_EVENT.AI_QUERY_ANSWERED, {
      query_kind: 'report',
      surface: 'ai',
      trigger: 'manual',
    })

    assert.deepEqual(
      client.captures.map((call) => call.event),
      [ANALYTICS_EVENT.AI_QUERY_ANSWERED],
    )

    analyticsModule.capture(ANALYTICS_EVENT.AI_QUERY_ANSWERED, {
      query_kind: 'question',
      surface: 'ai',
      trigger: 'manual',
    })

    analyticsModule.capture(ANALYTICS_EVENT.AI_QUERY_ANSWERED, {
      query_kind: 'question',
      surface: 'ai',
      trigger: 'manual',
    })

    assert.deepEqual(
      client.captures.map((call) => call.event),
      [
        ANALYTICS_EVENT.AI_QUERY_ANSWERED,
        ANALYTICS_EVENT.AI_QUERY_ANSWERED,
        ANALYTICS_EVENT.FIRST_AI_QUESTION_ANSWERED,
        ANALYTICS_EVENT.AI_QUERY_ANSWERED,
      ],
    )
  } finally {
    await analyticsModule?.shutdown()
    restoreRequire()
  }
})

test('timeline activation milestones derive from a non-empty reconstructed timeline once', async () => {
  resetHarnessState()
  __setSettings({
    analyticsOptIn: true,
    onboardingComplete: true,
  })

  const posthogHarness = createPostHogHarness()
  const sentryHarness = createSentryHarness()
  const restoreRequire = installRequireStub(posthogHarness, sentryHarness)
  let analyticsModule: Awaited<ReturnType<typeof importFreshAnalyticsModule>> | null = null

  try {
    analyticsModule = await importFreshAnalyticsModule()
    await analyticsModule.initAnalytics()

    const client = posthogHarness.instances[0]

    analyticsModule.capture(ANALYTICS_EVENT.TIMELINE_OPENED, {
      block_count_bucket: '2_3',
      surface: 'timeline',
      tracked_time_bucket: '1_3h',
    })

    analyticsModule.capture(ANALYTICS_EVENT.TIMELINE_OPENED, {
      block_count_bucket: '2_3',
      surface: 'timeline',
      tracked_time_bucket: '1_3h',
    })

    assert.deepEqual(
      client.captures.map((call) => call.event),
      [
        ANALYTICS_EVENT.TIMELINE_OPENED,
        ANALYTICS_EVENT.FEATURE_ADOPTION,
        ANALYTICS_EVENT.FIRST_DAY_WITH_RECONSTRUCTED_TIMELINE,
        ANALYTICS_EVENT.ACTIVATION_COMPLETED,
        ANALYTICS_EVENT.TIMELINE_OPENED,
      ],
    )
  } finally {
    await analyticsModule?.shutdown()
    restoreRequire()
  }
})
