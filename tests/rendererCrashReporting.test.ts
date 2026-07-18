// Renderer crash reporting (DEV-209): a render error caught by the renderer's
// ErrorBoundary crosses IPC to the main process and lands in Sentry with
// component context. The end-to-end test drives the real registered handler
// against the real analytics module, with only PostHog/Sentry themselves faked
// — the same seam analytics.service.test.ts uses.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ipcRecord } from './support/electron-stub.mjs'
import { __resetElectronStore } from './support/electron-store-stub.mjs'
import { __resetSettings } from './support/settings-stub.mjs'
import { IPC } from '../src/shared/types.ts'

// The ts-loader bakes __SENTRY_DSN__/__POSTHOG_KEY__ into the analytics module
// at load time, preferring a globalThis override. Set the overrides BEFORE the
// import below pulls analytics.ts in, or Sentry stays disabled for the file.
globalThis.__POSTHOG_KEY__ = 'phc_test_key'
globalThis.__POSTHOG_HOST__ = ''
globalThis.__SENTRY_DSN__ = 'https://public@example.ingest.sentry.io/1'
const { registerErrorHandlers, sanitizeRendererCrashReport } = await import('../src/main/ipc/errors.handlers.ts')

type SentryCaptureCall = {
  context: { extra?: Record<string, unknown>; tags?: Record<string, string> }
  error: Error
}

function createTelemetryHarness() {
  const sentryCaptures: SentryCaptureCall[] = []
  const posthogCaptures: Array<{ event: string; properties: Record<string, unknown> }> = []

  class FakePostHog {
    capture(args: { event: string; properties: Record<string, unknown> }) {
      posthogCaptures.push({ event: args.event, properties: args.properties })
    }

    on() {}
    register() {}
    async flush() {}
    async shutdown() {}
  }

  const sentryModule = {
    captureException(error: Error, context: SentryCaptureCall['context']) {
      sentryCaptures.push({ context, error })
    },
    async close() {},
    async flush() {},
    init() {},
    setTag() {},
    setUser() {},
  }

  const nodeRequire = createRequire(import.meta.url)
  const previousRequire = globalThis.require
  globalThis.require = ((specifier: string) => {
    if (specifier === 'posthog-node') return { PostHog: FakePostHog }
    if (specifier === '@sentry/electron/main') return sentryModule
    return nodeRequire(specifier)
  }) as typeof require

  const restore = () => {
    if (previousRequire === undefined) {
      delete (globalThis as { require?: unknown }).require
      return
    }
    globalThis.require = previousRequire
  }

  return { posthogCaptures, restore, sentryCaptures }
}

function getRegisteredHandler(): (event: unknown, payload: unknown) => void {
  const handlers = ipcRecord.events.get(IPC.ERRORS.RENDERER_CRASH) as
    | Array<(event: unknown, payload: unknown) => void>
    | undefined
  assert.ok(handlers && handlers.length === 1, 'exactly one renderer-crash handler should be registered')
  return handlers[0]
}

test('a render error forwarded over IPC reaches Sentry with component context', () => {
  __resetElectronStore()
  __resetSettings()
  const harness = createTelemetryHarness()

  try {
    ipcRecord.reset()
    registerErrorHandlers()
    const handler = getRegisteredHandler()

    handler({}, {
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'blocks')",
      stack: "TypeError: Cannot read properties of undefined (reading 'blocks')\n    at Timeline",
      componentStack: '\n    at Timeline\n    at ErrorBoundary\n    at App',
      boundary: 'Timeline',
    })

    assert.equal(harness.sentryCaptures.length, 1)
    const { error, context } = harness.sentryCaptures[0]
    assert.equal(error.name, 'TypeError')
    assert.equal(error.message, "Cannot read properties of undefined (reading 'blocks')")
    assert.ok(error.stack?.includes('errors.handlers'))
    assert.ok(!error.stack?.includes('at Timeline'))
    assert.equal(context.tags?.process_type, 'renderer')
    assert.equal(context.tags?.reason, 'render_error')
    assert.equal(context.tags?.boundary, 'Timeline')
    assert.ok(String(context.extra?.component_stack).includes('at Timeline'))

    const crashEvents = harness.posthogCaptures.filter((c) => c.event === 'app_crashed')
    assert.equal(crashEvents.length, 1)
    assert.equal(crashEvents[0].properties.process_type, 'renderer')
    assert.equal(crashEvents[0].properties.reason, 'render_error')
  } finally {
    harness.restore()
  }
})

test('a malformed payload from a compromised renderer is dropped, never reported', () => {
  __resetElectronStore()
  __resetSettings()
  const harness = createTelemetryHarness()

  try {
    ipcRecord.reset()
    registerErrorHandlers()
    const handler = getRegisteredHandler()

    for (const garbage of [null, undefined, 'boom', 42, [], { name: 'NoMessage' }, { message: 17 }]) {
      assert.doesNotThrow(() => handler({}, garbage))
    }

    assert.equal(harness.sentryCaptures.length, 0)
  } finally {
    harness.restore()
  }
})

test('sanitize keeps only bounded error identity and known component names', () => {
  const report = sanitizeRendererCrashReport({
    name: 'RangeError',
    message: `m${'x'.repeat(10_000)}`,
    stack: `s${'y'.repeat(20_000)}`,
    componentStack: '\n    at Apps',
    boundary: 'Apps',
    // Fields that must not survive the boundary, whatever they claim to be.
    windowTitle: 'Legacy forum thread',
    activity: { url: 'https://example.com/private' },
  })

  assert.ok(report)
  assert.equal(report.name, 'RangeError')
  assert.equal(report.message.length, 512)
  assert.equal(report.stack, null)
  assert.equal(report.componentStack, '\n    at Apps')
  assert.equal(report.boundary, 'Apps')
  assert.deepEqual(
    Object.keys(report).sort(),
    ['boundary', 'componentStack', 'message', 'name', 'stack'],
  )
})

test('missing optional fields fall back to safe defaults', () => {
  const report = sanitizeRendererCrashReport({ message: 'boom' })
  assert.ok(report)
  assert.equal(report.name, 'Error')
  assert.equal(report.stack, null)
  assert.equal(report.componentStack, null)
  assert.equal(report.boundary, 'unknown')
})

test('empty messages are reported with a safe fallback', () => {
  const report = sanitizeRendererCrashReport({ message: '', boundary: 'Timeline' })
  assert.ok(report)
  assert.equal(report.message, 'Unknown renderer error')
  assert.equal(report.boundary, 'Timeline')
})

test('unknown boundary names and renderer stacks cannot reach telemetry', () => {
  const report = sanitizeRendererCrashReport({
    message: 'boom',
    boundary: 'private document contents',
    stack: 'secret renderer content',
  })
  assert.ok(report)
  assert.equal(report.boundary, 'unknown')
  assert.equal(report.stack, null)
})
