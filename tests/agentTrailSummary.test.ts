// The settled trail's collapsed line (DEV-244, the Codex pattern): duration
// formatting and headline composition are deterministic — "Worked for Xm Ys"
// when the turn recorded its duration, an honest step-count fallback for
// answers persisted before durations existed, then the source summary.
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkedDuration, trailHeadline, summarizeAgentTurn } from '../src/shared/agentTrail.ts'

test('formatWorkedDuration renders human durations and never sub-second noise', () => {
  assert.equal(formatWorkedDuration(0), '1s')
  assert.equal(formatWorkedDuration(400), '1s')
  assert.equal(formatWorkedDuration(12_000), '12s')
  assert.equal(formatWorkedDuration(59_400), '59s')
  assert.equal(formatWorkedDuration(60_000), '1m')
  assert.equal(formatWorkedDuration(102_000), '1m 42s')
  assert.equal(formatWorkedDuration(3_840_000), '1h 4m')
  assert.equal(formatWorkedDuration(7_200_000), '2h')
})

test('trailHeadline leads with the worked duration when the turn recorded one', () => {
  assert.equal(
    trailHeadline({ durationMs: 102_000, stepCount: 6, summaryLabel: 'Used 4 sources · 1 file' }),
    'Worked for 1m 42s',
  )
  assert.equal(
    trailHeadline({ durationMs: 900, stepCount: 0, summaryLabel: '' }),
    'Worked for 1s',
  )
})

test('trailHeadline degrades honestly for answers without a recorded duration', () => {
  // Older persisted answers carry no duration: the step count speaks instead.
  assert.equal(
    trailHeadline({ durationMs: null, stepCount: 3, summaryLabel: 'Used 2 sources' }),
    'Worked through 3 steps',
  )
  assert.equal(
    trailHeadline({ durationMs: undefined, stepCount: 1, summaryLabel: '' }),
    'Worked through 1 step',
  )
  // No duration and no steps: the source summary is the whole story.
  assert.equal(
    trailHeadline({ durationMs: null, stepCount: 0, summaryLabel: 'Answered from your day record' }),
    'Answered from your day record',
  )
  // Nothing at all to disclose composes to empty — the caller hides the row.
  assert.equal(trailHeadline({ durationMs: 0, stepCount: 0, summaryLabel: '' }), '')
})

test('the headline composes from the same aggregation the inspector uses', () => {
  const summary = summarizeAgentTurn({
    toolTrace: [
      { tool: 'get_day_overview', input: {}, output: '{}' },
      { tool: 'search_history', input: {}, output: '{}' },
    ],
    fileDisclosures: [{ path: '/notes/plan.md' }],
    citations: [],
  })
  assert.ok(summary)
  assert.equal(summary!.label, 'Used 2 sources · 1 file')
  assert.equal(
    trailHeadline({ durationMs: null, stepCount: 0, summaryLabel: summary!.label }),
    'Used 2 sources · 1 file',
  )
})
