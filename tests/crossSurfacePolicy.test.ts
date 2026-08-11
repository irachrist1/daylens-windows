// WO-107 / REQ-VIC-001 through REQ-VIC-004.
// Cross-surface drift guard: every consumer of the activity-description policy
// is named here, and each invariant the Voice & Interpretation Contract requires
// is asserted once against the landed code — not re-implemented.
//
// Out of scope for this work order: production changes. This file is tests only.
// Fixtures are invented activity throughout.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTIVITY_DESCRIPTION_RULES,
  BANNED_VOCAB,
  DESCRIPTION_PLUMBING_VOCAB,
  JUDGMENT_RE,
  LABEL_PLUMBING_VOCAB,
  PROSE_PLUMBING_VOCAB,
  activityDescriptionFindings,
  assertEvidenceOwned,
  evaluateActivityDescription,
  uncertaintyStatement,
  type SupportedInterpretation,
} from '../src/shared/activityDescription.ts'
import { PLUMBING_VOCAB } from '../src/main/ai/voiceContract.ts'
import { labelProvenance, recapVoiceFindings, userAuthoredLabel } from '../src/shared/labelVoice.ts'
import { voiceDirective, normalizeSummaryVoice, SUMMARY_VOICES } from '../src/shared/summaryVoice.ts'
import { renderTimeChunkAnswer } from '../src/main/agent/timeChunkAnswer.ts'
import { buildAgentSystemPrompt } from '../src/main/agent/systemPrompt.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

function source(relativePath: string): string {
  const absolute = path.join(REPO_ROOT, relativePath)
  assert.ok(fs.existsSync(absolute), `missing on disk: ${relativePath}`)
  return fs.readFileSync(absolute, 'utf8')
}

function findingFor(text: string, rule: string, context = {}) {
  return evaluateActivityDescription(text, context).find((entry) => entry.rule === rule)!
}

const POLICY_CONSUMERS: Array<{ path: string; label: string; must: RegExp }> = [
  { path: 'src/shared/labelVoice.ts', label: 'Timeline labels', must: /activityDescriptionFindings|LABEL_PLUMBING_VOCAB/ },
  { path: 'src/main/ai/voiceContract.ts', label: 'generated-prose contract', must: /@shared\/activityDescription/ },
  { path: 'src/main/agent/systemPrompt.ts', label: 'agent', must: /ACTIVITY_DESCRIPTION_DIRECTIVES|voiceDirective/ },
  { path: 'src/main/jobs/aiService.ts', label: 'brief / week / apps', must: /voiceDirective|USER_AUTHORED_LABEL_RULE/ },
  { path: 'src/main/lib/wrappedNarrative.ts', label: 'Wrapped day composer', must: /INTERPRETATION_DIRECTIVES/ },
  { path: 'src/main/lib/wrappedPeriodNarrative.ts', label: 'Wrapped period composer', must: /INTERPRETATION_DIRECTIVES/ },
  { path: 'src/main/services/wrappedQuestion.ts', label: 'Wrapped question', must: /INTERPRETATION_DIRECTIVES|voiceDirective/ },
  { path: 'src/main/agent/timeChunkAnswer.ts', label: 'time-chunk renderer', must: /rawLabelForm|naturalizeLabel/ },
]

const INTERPRETATION: SupportedInterpretation = {
  activity: 'Reworking the sync engine',
  provenance: 'evidence',
  supportedDetails: [
    { name: 'sync engine', kind: 'window-title' },
    { name: 'Harbor', kind: 'calendar' },
  ],
  facts: {
    duration: ['1h 24m'],
    url: ['docs.harbor.example.dev'],
    file: ['sync.ts'],
  },
}

const NOW = new Date('2026-06-22T11:30:00')

// ── AC-VIC-001.1: one policy, every consumer ───────────────────────────────

test('AC-VIC-001.1: every activity-description consumer reads the shared policy', () => {
  for (const site of POLICY_CONSUMERS) {
    const text = source(site.path)
    assert.match(text, site.must, `${site.label} (${site.path}) is not wired to the shared policy`)
  }
})

test('AC-VIC-001.1: prose and label plumbing share one definition site', () => {
  assert.equal(PLUMBING_VOCAB, PROSE_PLUMBING_VOCAB)
  assert.ok(LABEL_PLUMBING_VOCAB.includes('window title'))
  assert.ok(!PROSE_PLUMBING_VOCAB.includes('window title'))
  assert.ok(DESCRIPTION_PLUMBING_VOCAB.includes('window title'))
  assert.ok(DESCRIPTION_PLUMBING_VOCAB.includes('page-level detail'))
  assert.equal(recapVoiceFindings, activityDescriptionFindings)
})

// ── AC-VIC-001.2 / .3 / .4 ─────────────────────────────────────────────────

test('AC-VIC-001.2: unsupported named detail fails; supported detail passes', () => {
  const bad = findingFor(
    'Reworking the Ridgeline renewal in Harbor',
    'no-unsupported-detail',
    { interpretation: INTERPRETATION, candidateDetails: ['Ridgeline', 'Harbor'] },
  )
  assert.equal(bad.passed, false)

  const supported: SupportedInterpretation = {
    ...INTERPRETATION,
    supportedDetails: [...INTERPRETATION.supportedDetails, { name: 'Ridgeline', kind: 'calendar' }],
  }
  const good = findingFor(
    'Reworking the Ridgeline renewal in Harbor',
    'no-unsupported-detail',
    { interpretation: supported, candidateDetails: ['Ridgeline', 'Harbor'] },
  )
  assert.equal(good.passed, true)
})

test('AC-VIC-001.3: activity before telemetry', () => {
  assert.equal(
    findingFor('Cursor, reworking the sync engine', 'activity-before-telemetry', {
      appNames: ['Cursor'],
    }).passed,
    false,
  )
  assert.equal(
    findingFor('Reworking the sync engine, in Cursor', 'activity-before-telemetry', {
      appNames: ['Cursor'],
    }).passed,
    true,
  )
})

test('AC-VIC-001.4: banned forms each fail their own rule', () => {
  const cases: Array<[string, string]> = [
    ['foreground session on the tool', 'no-plumbing'],
    ['some work in the afternoon', 'no-weak-activity'],
    ['dive into the sync engine', 'no-hype'],
  ]
  for (const [text, rule] of cases) {
    assert.equal(findingFor(text, rule).passed, false, `${rule} did not fail on: ${text}`)
  }
  assert.ok(ACTIVITY_DESCRIPTION_RULES.length >= 7)
})

// ── AC-VIC-002: tone parity ────────────────────────────────────────────────

test('AC-VIC-002: agent, brief, and Wrapped all apply the same tone helper', () => {
  for (const voice of SUMMARY_VOICES) {
    const agent = buildAgentSystemPrompt({
      now: NOW,
      timezone: 'UTC',
      trackingStart: '2026-01-05',
      providerLabel: 'Anthropic',
      model: 'test-model',
      homeDir: '/home/person',
      summaryVoice: voice,
    })
    assert.ok(agent.includes(voiceDirective(voice)), `agent missing ${voice}`)
  }
  assert.equal(normalizeSummaryVoice('nope'), 'warm')
  for (const site of [
    'src/main/jobs/aiService.ts',
    'src/main/services/wrappedNarrative.ts',
    'src/main/services/wrappedPeriodNarrative.ts',
    'src/main/services/wrappedQuestion.ts',
    'src/main/agent/systemPrompt.ts',
  ]) {
    assert.match(source(site), /voiceDirective/, `${site} has no tone`)
  }
})

// ── AC-VIC-003: uncertainty, no judgment, evidence ownership ───────────────

test('AC-VIC-003.1 / .2: uncertainty is one judgment-free sentence', () => {
  const limited = uncertaintyStatement({
    ...INTERPRETATION,
    captureLimits: ['page titles were not captured for this stretch'],
  })
  assert.ok(limited)
  assert.equal((limited!.match(/\./g) ?? []).length, 1)
  assert.equal(JUDGMENT_RE.test(limited!), false)
  assert.equal(uncertaintyStatement(INTERPRETATION), null)
})

test('AC-VIC-003.3: evidence-owned facts cannot be invented by a description', () => {
  assert.throws(
    () => assertEvidenceOwned('spent 3h 10m on Harbor', INTERPRETATION),
    /Model-originated fact/,
  )
  assert.doesNotThrow(() => assertEvidenceOwned('spent 1h 24m on Harbor', INTERPRETATION))
  assert.throws(
    () => assertEvidenceOwned('opened https://other.example/x', INTERPRETATION),
    /Model-originated fact/,
  )
  assert.doesNotThrow(() => assertEvidenceOwned('opened docs.harbor.example.dev', INTERPRETATION))
})

test('AC-VIC-003.2: time-chunk gaps never judge the person', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-02',
    incrementMinutes: 30,
    chunks: [
      { startTime: '12:00', endTime: '12:30', durationMinutes: 30, activity: [], pages: [], gap: { kind: 'idle', label: 'no activity captured, likely away or idle' } },
    ],
  })
  assert.ok(answer)
  assert.doesNotMatch(answer!, /likely away|idle|distracted|productive|wasted/i)
  assert.match(answer!, /nothing was captured here/)
})

// ── AC-VIC-004: user-authored label precedence ─────────────────────────────

test('AC-VIC-004: user wording wins and keeps provenance', () => {
  const override = {
    label: { current: 'Development', source: 'rule', override: 'Ridgeline renewal' },
  }
  assert.equal(userAuthoredLabel(override), 'Ridgeline renewal')
  assert.equal(labelProvenance(override), 'user')

  const review = {
    label: { current: 'Ridgeline renewal', source: 'user', override: null },
  }
  assert.equal(userAuthoredLabel(review), 'Ridgeline renewal')
  assert.equal(labelProvenance(review), 'user')

  const evidence = {
    label: { current: 'Reworking the sync engine', source: 'ai', override: null },
  }
  assert.equal(userAuthoredLabel(evidence), null)
  assert.equal(labelProvenance(evidence), 'evidence')
})

test('AC-VIC-004: a user-authored covering label reaches the time-chunk table verbatim', () => {
  const answer = renderTimeChunkAnswer({
    found: true,
    date: '2026-08-02',
    incrementMinutes: 30,
    chunks: [{
      startTime: '09:00',
      endTime: '09:30',
      durationMinutes: 30,
      blockLabel: 'Ridgeline renewal',
      activity: [{ appName: 'Chrome', windowTitle: 'Dashboard', seconds: 1800 }],
      pages: [],
      gap: null,
    }],
  })
  assert.ok(answer)
  assert.match(answer!, /Ridgeline renewal/)
})

test('BANNED_VOCAB stays the 21-entry list voiceContract consumers rely on', () => {
  assert.equal(BANNED_VOCAB.length, 21)
})
