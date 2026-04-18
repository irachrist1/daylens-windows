import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import {
  appendConversationMessage,
  clearConversation,
  getConversationMessages,
  getConversationState,
  getOrCreateConversation,
  upsertConversationState,
} from '../src/main/db/queries.ts'
import { resolveFollowUp } from '../src/main/lib/followUpResolver.ts'
import {
  buildDeterministicFollowUpCandidates,
  parseFollowUpSuggestions,
} from '../src/main/lib/followUpSuggestions.ts'
import {
  fillDaySummaryQuestionSuggestions,
  normalizeDaySummaryQuestionSuggestion,
} from '../src/main/lib/daySummarySuggestions.ts'
import type { AIConversationState, AIThreadMessage } from '../src/shared/types.ts'

function weeklyState(): AIConversationState {
  return {
    dateRange: {
      fromMs: new Date(2026, 3, 11).getTime(),
      toMs: new Date(2026, 3, 18).getTime(),
      label: 'this week',
    },
    topic: 'AI',
    responseMode: 'exploration',
    lastIntent: 'weekly_topic_exploration_brief',
    evidenceKey: 'evidence-key',
    answerKind: 'weekly_brief',
    sourceKind: 'weekly_brief',
    followUpAffordances: ['deepen', 'literalize', 'narrow', 'compare', 'switch_topic', 'repair'],
    routingContext: {
      dateMs: new Date(2026, 3, 17, 10, 0, 0, 0).getTime(),
      timeWindowStartMs: null,
      timeWindowEndMs: null,
      weeklyBrief: {
        intent: 'weekly_topic_exploration_brief',
        responseMode: 'exploration',
        topic: 'AI',
        dateRange: {
          fromMs: new Date(2026, 3, 11).getTime(),
          toMs: new Date(2026, 3, 18).getTime(),
          label: 'this week',
        },
        evidenceKey: 'evidence-key',
      },
      entity: null,
    },
  }
}

function statsState(): AIConversationState {
  return {
    dateRange: null,
    topic: null,
    responseMode: null,
    lastIntent: null,
    evidenceKey: null,
    answerKind: 'deterministic_stats',
    sourceKind: 'deterministic',
    followUpAffordances: ['deepen', 'expand', 'compare', 'repair'],
    routingContext: null,
  }
}

function threadHistory(): AIThreadMessage[] {
  return [
    {
      id: 1,
      role: 'user',
      content: 'what have i explored AI related this week',
      createdAt: Date.now(),
    },
    {
      id: 2,
      role: 'assistant',
      content: 'The clearest story of the week is AI as working infrastructure.',
      createdAt: Date.now(),
      answerKind: 'weekly_brief',
      retryable: true,
      contextSnapshot: weeklyState(),
      suggestedFollowUps: [],
    },
  ]
}

test('weekly brief follow-up reuses context for go deeper', () => {
  const result = resolveFollowUp('gooo deepere', weeklyState(), threadHistory())
  assert.equal(result.kind, 'followup_reuse_context')
  assert.equal(result.followUpClass, 'deepen')
  assert.equal(result.effectivePrompt, 'gooo deepere')
  assert.equal(result.shouldReuseContext, true)
})

test('weekly brief topic pivot rewrites to scoped weekly prompt', () => {
  const result = resolveFollowUp('what about design?', weeklyState(), threadHistory())
  assert.equal(result.kind, 'followup_with_override')
  assert.equal(result.followUpClass, 'topic_pivot')
  assert.match(result.effectivePrompt, /design/i)
  assert.match(result.effectivePrompt, /this week/i)
})

test('explicit time override resets prior weekly context', () => {
  const result = resolveFollowUp('yesterday', weeklyState(), threadHistory())
  assert.equal(result.kind, 'followup_with_override')
  assert.equal(result.followUpClass, 'time_override')
  assert.equal(result.shouldResetContext, true)
})

test('stats answer does not reuse narrative follow-up context', () => {
  const result = resolveFollowUp('go deeper', statsState(), [
    {
      id: 1,
      role: 'user',
      content: 'focus score this week',
      createdAt: Date.now(),
    },
  ])
  assert.equal(result.shouldReuseContext, false)
  assert.equal(result.shouldResetContext, true)
  assert.match(result.effectivePrompt, /explain/i)
})

test('repair prompts stay classified as repair', () => {
  const result = resolveFollowUp('be more specific', weeklyState(), threadHistory())
  assert.equal(result.kind, 'followup_repair')
  assert.equal(result.followUpClass, 'repair')
})

test('deterministic follow-up candidates stay concrete and deduped', () => {
  const suggestions = buildDeterministicFollowUpCandidates('weekly_literal_list', weeklyState())
  assert.ok(suggestions.length >= 3)
  assert.ok(suggestions.every((item) => item.text.split(/\s+/).length <= 8))
  assert.equal(new Set(suggestions.map((item) => item.text.toLowerCase())).size, suggestions.length)
})

test('model suggestion parser falls back to deterministic suggestions on invalid JSON', () => {
  const fallback = buildDeterministicFollowUpCandidates('weekly_brief', weeklyState()).slice(0, 4)
  const parsed = parseFollowUpSuggestions('not valid json', fallback)
  assert.deepEqual(parsed, fallback)
})

test('day summary suggestions reject assistant-to-user questions and fill from fallback', () => {
  const filled = fillDaySummaryQuestionSuggestions([
    'Are you building a specific ML model right now?',
    'Did task planning settle into place?',
    'What did I actually get done today?',
  ], [
    'Which files, docs, or pages did I touch today?',
    'Where did my focus break down today?',
    'What should I pick back up next?',
  ])

  assert.deepEqual(filled, [
    'What did I actually get done today?',
    'Which files, docs, or pages did I touch today?',
    'Where did my focus break down today?',
  ])
})

test('day summary suggestions normalize valid user-voiced query chips', () => {
  assert.equal(
    normalizeDaySummaryQuestionSuggestion('  what did i actually finish today  '),
    'What did I actually finish today?',
  )
  assert.equal(
    normalizeDaySummaryQuestionSuggestion('Summarize today as a short report I could share'),
    'Summarize today as a short report I could share',
  )
})

test('conversation state persists alongside structured AI messages', () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  const conversationId = getOrCreateConversation(db)
  const state = weeklyState()

  const user = appendConversationMessage(db, conversationId, 'user', 'what have i explored AI related this week')
  appendConversationMessage(db, conversationId, 'assistant', 'AI as working infrastructure.', {
    metadata: {
      answerKind: 'weekly_brief',
      retryable: true,
      retrySourceUserMessageId: user.id,
      contextSnapshot: state,
      suggestedFollowUps: buildDeterministicFollowUpCandidates('weekly_brief', state).slice(0, 3),
    },
  })
  upsertConversationState(db, conversationId, state)

  const history = getConversationMessages(db, conversationId)
  assert.equal(history.length, 2)
  assert.equal(history[1].answerKind, 'weekly_brief')
  assert.equal(history[1].retrySourceUserMessageId, user.id)
  assert.equal(history[1].suggestedFollowUps?.length, 3)
  assert.deepEqual(getConversationState(db, conversationId), state)

  clearConversation(db, conversationId)
  assert.equal(getConversationMessages(db, conversationId).length, 0)
  assert.equal(getConversationState(db, conversationId), null)
  db.close()
})
