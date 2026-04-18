import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blockCountBucket,
  classifyAIOutputIntent,
  sanitizeAnalyticsProperties,
  sanitizeSettingsChangedKeys,
  trackedTimeBucket,
} from '../src/shared/analytics.ts'

test('sanitizeAnalyticsProperties keeps coarse analytics fields and strips unsafe text', () => {
  const sanitized = sanitizeAnalyticsProperties({
    answer_kind: 'freeform_chat',
    comment: 'I loved the report about the ACME migration',
    failure_kind: 'network',
    has_comment: true,
    query_kind: 'report',
    reason: 'https://example.com/private/doc',
    score: 5,
    settings_changed_keys: ['analyticsOptIn', 'launchOnLogin', 'windowTitle', 'launchOnLogin'],
    suggestion_text: 'Summarize the repo named daylens-windows',
    surface: 'ai',
    tracked_time_bucket: '1_3h',
    trigger: 'freeform',
    version: '1.0.26',
  })

  assert.deepEqual(sanitized, {
    answer_kind: 'freeform_chat',
    failure_kind: 'network',
    has_comment: true,
    query_kind: 'report',
    score: 5,
    settings_changed_keys: ['analyticsOptIn', 'launchOnLogin'],
    surface: 'ai',
    tracked_time_bucket: '1_3h',
    trigger: 'freeform',
    version: '1.0.26',
  })
})

test('sanitizeSettingsChangedKeys only keeps supported settings keys', () => {
  assert.deepEqual(
    sanitizeSettingsChangedKeys([
      'theme',
      'analyticsOptIn',
      'windowTitle',
      'launchOnLogin',
      'theme',
    ]),
    ['analyticsOptIn', 'launchOnLogin', 'theme'],
  )
})

test('classifyAIOutputIntent detects report-like actions without storing prompt text', () => {
  assert.equal(classifyAIOutputIntent('Summarize today as a short report I could share'), 'report')
  assert.equal(classifyAIOutputIntent('Show me a chart of my tracked time this week'), 'chart')
  assert.equal(classifyAIOutputIntent('Give me a table by day and app'), 'table')
  assert.equal(classifyAIOutputIntent('Export this as something I can send'), 'export')
  assert.equal(classifyAIOutputIntent('What did I actually get done today?'), 'question')
})

test('bucket helpers keep timeline telemetry coarse', () => {
  assert.equal(blockCountBucket(0), '0')
  assert.equal(blockCountBucket(3), '2_3')
  assert.equal(blockCountBucket(11), '8_15')

  assert.equal(trackedTimeBucket(0), '0m')
  assert.equal(trackedTimeBucket(20 * 60), '15_59m')
  assert.equal(trackedTimeBucket(2 * 60 * 60), '1_3h')
  assert.equal(trackedTimeBucket(11 * 60 * 60), '10h_plus')
})
