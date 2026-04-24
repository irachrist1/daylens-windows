import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseRouter } from '../src/main/lib/insightsQueryRouter.ts'

// ── Five that SHOULD use the router (pure numeric lookups) ─────────────────

test('routes "how long on Figma today?"', () => {
  assert.equal(shouldUseRouter('How long on Figma today?'), true)
})

test('routes "how much time on Cursor this week?"', () => {
  assert.equal(shouldUseRouter('How much time on Cursor this week?'), true)
})

test('routes "what\'s my focus score today?"', () => {
  assert.equal(shouldUseRouter("What's my focus score today?"), true)
})

test('routes "how many hours did I work today?"', () => {
  assert.equal(shouldUseRouter('How many hours did I work today?'), true)
})

test('routes "how many sessions in Slack this week?"', () => {
  assert.equal(shouldUseRouter('How many sessions in Slack this week?'), true)
})

// ── Five that should NOT use the router (open-ended synthesis) ─────────────

test('does not route "what did I do today?"', () => {
  assert.equal(shouldUseRouter('What did I do today?'), false)
})

test('does not route "which files did I touch this morning?"', () => {
  assert.equal(shouldUseRouter('Which files did I touch this morning?'), false)
})

test('does not route "summarize my Monday"', () => {
  assert.equal(shouldUseRouter('Summarize my Monday.'), false)
})

test('does not route "compare my coding time this week vs last week"', () => {
  assert.equal(shouldUseRouter('Compare my coding time this week vs last week.'), false)
})

test('does not route "how did my focus go this afternoon?"', () => {
  assert.equal(shouldUseRouter('How did my focus go this afternoon?'), false)
})
