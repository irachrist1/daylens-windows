// WO-105 / REQ-VIC-001, REQ-VIC-002, REQ-VIC-003. The agent describes the same
// activity the recap and Wrapped describe, so it describes it under the same
// policy and in the person's chosen tone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentSystemPrompt } from '../src/main/agent/systemPrompt.ts'
import {
  ACTIVITY_DESCRIPTION_DIRECTIVES,
  DESCRIPTION_PLUMBING_VOCAB,
} from '../src/shared/activityDescription.ts'
import { SUMMARY_VOICES, voiceDirective } from '../src/shared/summaryVoice.ts'
import type { SummaryVoice } from '../src/shared/types.ts'

const NOW = new Date('2026-06-22T11:30:00')

function prompt(summaryVoice?: SummaryVoice | null): string {
  return buildAgentSystemPrompt({
    now: NOW,
    timezone: 'UTC',
    trackingStart: '2026-01-05',
    providerLabel: 'Anthropic',
    model: 'test-model',
    homeDir: '/home/person',
    ...(summaryVoice === undefined ? {} : { summaryVoice }),
  })
}

// ── AC-VIC-002.1 / .2: the agent speaks in the chosen tone ─────────────────

test('AC-VIC-002.2: the agent prompt carries the selected tone', () => {
  for (const voice of SUMMARY_VOICES) {
    assert.ok(
      prompt(voice).includes(voiceDirective(voice)),
      `the agent prompt does not carry the ${voice} tone`,
    )
  }
})

test('AC-VIC-002.1: an absent or null tone falls back to warm, never to no tone', () => {
  // The bench and the packet tests build a prompt without settings. They must
  // get the default voice, not a prompt with the tone line missing.
  for (const absent of [undefined, null] as const) {
    assert.ok(
      prompt(absent).includes(voiceDirective('warm')),
      `an ${String(absent)} tone produced a prompt with no tone directive`,
    )
  }
})

test('AC-VIC-002.2: choosing a tone changes the prompt', () => {
  assert.notEqual(prompt('straight'), prompt('witty'))
})

// ── AC-VIC-001 / 003: the agent takes the shared policy ────────────────────

test('AC-VIC-001.1: the agent prompt carries every shared description directive', () => {
  const text = prompt('warm')
  for (const directive of ACTIVITY_DESCRIPTION_DIRECTIVES) {
    assert.ok(text.includes(directive), `missing directive: ${directive.slice(0, 60)}…`)
  }
})

test('AC-VIC-001.4: the plumbing ban the agent gets is the shared one', () => {
  const text = prompt('warm')
  for (const term of DESCRIPTION_PLUMBING_VOCAB) {
    assert.ok(text.includes(term), `the agent's plumbing ban never states "${term}"`)
  }
})

test('AC-VIC-003.3: the evidence-ownership rule reaches the agent', () => {
  assert.match(prompt('warm'), /FACTS ARE NOT YOURS TO CREATE/)
})

test('AC-VIC-003.2: the no-grading rule reaches the agent', () => {
  assert.match(prompt('warm'), /NO GRADING/)
})

// ── The prompt must not argue with itself ──────────────────────────────────

test('the evidence-ownership rule does not forbid the exactness the agent is required to give', () => {
  // The agent is told to compute a span precisely from a tool result's own
  // start and end. A flat "never state a duration that is not in the evidence"
  // would forbid exactly that, and a prompt that contradicts itself is worse
  // than one rule fewer. Deriving from recorded evidence has to stay explicitly
  // allowed.
  const text = prompt('warm')
  assert.match(text, /compute it precisely from the tool result's start and end/)
  assert.match(text, /Deriving a figure from evidence you were given is fine/)
})

test('no directive composed into the agent prompt teaches an em dash', () => {
  for (const directive of ACTIVITY_DESCRIPTION_DIRECTIVES) {
    assert.doesNotMatch(directive, /—/, `directive teaches an em dash: ${directive.slice(0, 60)}`)
  }
})
