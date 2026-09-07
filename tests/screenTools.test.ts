// capture_screen contract: consent-gated outside the model, honest refusals,
// and the JSON result (what the trace persists) never carries pixels.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScreenTools } from '../src/main/agent/screenTools.ts'
import { __setSettings } from './support/settings-stub.mjs'

test('capture_screen refuses honestly when the experiment is off', async () => {
  __setSettings({ screenContextExperimentEnabled: false, screenContextPaused: false })
  const tools = buildScreenTools()
  const result = await tools.capture_screen.execute!({ reason: 'checking what is on screen right now' }, { toolCallId: 't1', messages: [] })
  assert.equal(result.captured, false)
  assert.match(result.reason, /Settings/)
})

test('capture_screen refuses when paused', async () => {
  __setSettings({ screenContextExperimentEnabled: true, screenContextPaused: true })
  const tools = buildScreenTools()
  const result = await tools.capture_screen.execute!({ reason: 'checking what is on screen right now' }, { toolCallId: 't2', messages: [] })
  assert.equal(result.captured, false)
})

test('capture_screen degrades honestly without a capture runtime', async () => {
  __setSettings({ screenContextExperimentEnabled: true, screenContextPaused: false })
  const tools = buildScreenTools()
  const result = await tools.capture_screen.execute!({ reason: 'checking what is on screen right now' }, { toolCallId: 't3', messages: [] })
  // The hermetic electron stub has no desktopCapturer: the tool must return a
  // structured miss, never throw, and never fabricate a frame.
  assert.equal(result.captured, false)
  assert.ok(result.reason.length > 0)
})

test('capture_screen refuses when the caller is not authorized for a live capture', async () => {
  __setSettings({ screenContextExperimentEnabled: true, screenContextPaused: false })
  const tools = buildScreenTools({ isAuthorized: () => false })
  const result = await tools.capture_screen.execute!({ reason: 'checking what is on screen right now' }, { toolCallId: 't-auth', messages: [] })
  assert.equal(result.captured, false)
  assert.match(result.reason, /historical block/)
})

test('a refusal maps to a JSON tool result, never image content', async () => {
  __setSettings({ screenContextExperimentEnabled: false, screenContextPaused: false })
  const tools = buildScreenTools()
  const output = await tools.capture_screen.execute!({ reason: 'checking what is on screen right now' }, { toolCallId: 't4', messages: [] })
  const modelOutput = await tools.capture_screen.toModelOutput!({ toolCallId: 't4', input: { reason: 'x' }, output })
  assert.equal(modelOutput.type, 'json')
})
