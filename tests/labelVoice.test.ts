import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LABEL_VOICE_RULES,
  evaluateLabelVoice,
  labelCandidateViolation,
  labelVoiceContextForBlock,
  labelVoiceReportLines,
  rawLabelForm,
  summarizeLabelVoice,
  type LabelVoiceContext,
  type LabelVoiceRuleId,
} from '../src/shared/labelVoice.ts'
import { buildLabelVoiceReview, labelVoiceMarkdownLines } from '../scripts/real-day/lib.ts'

function failedRules(label: string, context: LabelVoiceContext = {}): LabelVoiceRuleId[] {
  return evaluateLabelVoice(label, context)
    .filter((finding) => !finding.passed)
    .map((finding) => finding.rule)
}

test('the recorded voice examples pass every rule', () => {
  const context: LabelVoiceContext = {
    appNames: ['Cursor', 'Google Chrome'],
    windowTitles: ['wrapDeck.ts'],
    pageTitles: ['Wrapped design review'],
    kind: 'work',
    hasSubjectEvidence: true,
  }
  assert.deepEqual(failedRules('Developed the Daylens Wrapped feature', context), [])
  assert.deepEqual(failedRules('Researched television upgrade options', context), [])
  assert.deepEqual(
    failedRules('Watching a Formula 1 documentary', { kind: 'leisure' }),
    [],
  )
})

test('every rule id is unique and carries a tier and requirement', () => {
  const ids = LABEL_VOICE_RULES.map((rule) => rule.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const rule of LABEL_VOICE_RULES) {
    assert.ok(rule.requirement.length > 0)
    assert.ok(rule.tier === 'invariant' || rule.tier === 'target')
  }
})

test('nonempty-bounded rejects empty, run-on, and sentence-shaped labels', () => {
  assert.ok(failedRules('').includes('nonempty-bounded'))
  assert.ok(
    failedRules(
      'Working through the whole morning on many different unrelated things one after the other today',
    ).includes('nonempty-bounded'),
  )
  assert.ok(failedRules('Reviewed the quarterly report.').includes('nonempty-bounded'))
  assert.ok(!failedRules('Reviewed the quarterly report').includes('nonempty-bounded'))
})

test('no-raw-artifact-forms names the machine form it rejects', () => {
  assert.equal(rawLabelForm('https://github.com/spcsorg/daylens/pull/1'), 'raw URL')
  assert.equal(rawLabelForm('youtube.com'), 'bare domain')
  assert.equal(rawLabelForm('report_final_v2.xlsx'), 'file extension')
  assert.equal(rawLabelForm('W2_Reading assignment'), 'underscore filename')
  assert.equal(rawLabelForm('AGENT-EXECUTION-PLAN.md'), 'machine identifier')
  assert.equal(rawLabelForm('(3) Inbox'), 'notification count')
  // A bare date is an internal key, not an activity — it must never rank as a
  // week activity. A date inside a real phrase stays allowed.
  assert.equal(rawLabelForm('2026-07-20'), 'bare date')
  assert.equal(rawLabelForm('2026/7/20'), 'bare date')
  assert.equal(rawLabelForm('Reviewed the FY2026 report'), null)
  assert.equal(rawLabelForm('W2 Reading | Intro to ML | Perusall'), 'browser-tab soup')
  assert.equal(rawLabelForm('Quarterly plan - Google Chrome'), 'trailing browser name')
  // DEV-276: a filename of any kind is never a label — including ordinary
  // code/text filenames an earlier design allowed. Repo paths stay allowed.
  assert.equal(rawLabelForm('handoff.md'), 'filename')
  assert.equal(rawLabelForm('run.ts'), 'filename')
  assert.equal(rawLabelForm('timeline-eval/run.ts'), null)
  // DEV-276: JSON and bracketed tab-title fragments are machine forms.
  assert.equal(rawLabelForm('{"questions":[{"header":"Scope"}]}'), 'JSON fragment')
  assert.equal(rawLabelForm('Wants to run AskUserQuestion: {"questions":[…'), 'JSON fragment')
  assert.equal(rawLabelForm('[Week 1]'), 'bracketed title fragment')
  assert.equal(rawLabelForm('Sprint planning: retro notes'), null)
  assert.equal(rawLabelForm('Reviewed the "Q3 Roadmap": key priorities'), null)
  assert.equal(rawLabelForm('Version 1.0.45 release notes'), null)
  assert.equal(rawLabelForm('Reviewed the quarterly report'), null)
  assert.ok(failedRules('(3) Inbox').includes('no-raw-artifact-forms'))
})

test('no-plumbing-or-hype rejects telemetry vocabulary and banned filler', () => {
  assert.ok(failedRules('Foreground app session review').includes('no-plumbing-or-hype'))
  assert.ok(failedRules('Deep dive into metrics').includes('no-plumbing-or-hype'))
  assert.ok(!failedRules('Reviewing evidence for the Harris case').includes('no-plumbing-or-hype'))
})

test('no-judgment rejects grading language but allows a real focus session', () => {
  assert.ok(failedRules('Unproductive browsing').includes('no-judgment'))
  assert.ok(failedRules('Wasted afternoon on video').includes('no-judgment'))
  assert.ok(failedRules('Doomscrolling on X').includes('no-judgment'))
  assert.ok(!failedRules('Focus session on the importer').includes('no-judgment'))
})

test('leisure labels must be activity-shaped; work labels are exempt', () => {
  assert.ok(
    failedRules('Big Buck Bunny 4K60', { kind: 'leisure' }).includes('leisure-activity-shaped'),
  )
  assert.ok(
    !failedRules('Watching Big Buck Bunny', { kind: 'leisure' }).includes(
      'leisure-activity-shaped',
    ),
  )
  assert.ok(!failedRules('Big Buck Bunny 4K60', { kind: 'work' }).includes('leisure-activity-shaped'))
})

test('activity-not-software rejects bare app names and app-plus-filler', () => {
  const context: LabelVoiceContext = { appNames: ['Cursor', 'Google Chrome', 'Slack'] }
  assert.ok(failedRules('Cursor', context).includes('activity-not-software'))
  assert.ok(failedRules('Chrome browsing', context).includes('activity-not-software'))
  assert.ok(failedRules('Slack session', context).includes('activity-not-software'))
  assert.ok(!failedRules('Refactoring the timeline engine', context).includes('activity-not-software'))
  // Naming the place work happened is fine; being only the place is not.
  assert.ok(!failedRules('Sprint planning in Slack', context).includes('activity-not-software'))
})

test('no-verbatim-window-title rejects a label equal to a captured title', () => {
  const context: LabelVoiceContext = {
    windowTitles: ['Roadmap board'],
    pageTitles: ['Budget tracker'],
  }
  assert.ok(failedRules('Roadmap board', context).includes('no-verbatim-window-title'))
  assert.ok(failedRules('Budget tracker', context).includes('no-verbatim-window-title'))
  assert.ok(
    !failedRules('Updating the roadmap board layout', context).includes(
      'no-verbatim-window-title',
    ),
  )
})

test('concrete-over-generic fires only when subject evidence exists', () => {
  assert.ok(
    failedRules('Development', { hasSubjectEvidence: true }).includes('concrete-over-generic'),
  )
  assert.ok(
    failedRules('Web Session', { hasSubjectEvidence: true }).includes('concrete-over-generic'),
  )
  assert.ok(
    !failedRules('Development', { hasSubjectEvidence: false }).includes('concrete-over-generic'),
  )
})

// labelCandidateViolation is the ONE relabel-time gate both AI label paths
// call (generateWorkBlockInsight's labelRejection and the interpretation
// agent's agentLabelViolation): voice invariants, the two echo rules, and
// the work-name-guard vocabulary — including a tool surface hiding behind a
// verb lead, which no per-rule check catches on its own.
test('labelCandidateViolation rejects a tool surface behind a verb lead at generation time', () => {
  assert.ok(labelCandidateViolation('Working on Cursor Agents'))
  assert.ok(labelCandidateViolation('Working on Cursor Agents in Daylens'))
  assert.ok(labelCandidateViolation('Microsoft Teams'))
  assert.ok(labelCandidateViolation('Inbox (1)'))
  assert.ok(labelCandidateViolation('Irachrist1/daylens-v1: Daylens'))
  assert.equal(labelCandidateViolation(''), 'the label was empty')
  assert.equal(labelCandidateViolation(null), 'the label was empty')
  // The voice rules still fire first: a bare app name from the block's own
  // evidence is software, not an activity.
  assert.ok(labelCandidateViolation('Slack', { appNames: ['Slack'] }))
  // Legit labels pass untouched.
  const legit = [
    'Git workflow cleanup',
    'Make the onboarding deck',
    'Setting up the work network with the Ubiquiti dashboard and Terminal',
    'Refactoring the timeline engine',
    'Sprint planning in Slack',
  ]
  for (const label of legit) {
    assert.equal(labelCandidateViolation(label, { appNames: ['Slack'] }), null, `rejected a legit label: "${label}"`)
  }
})

test('short-activity-phrase targets 2-7 words', () => {
  assert.ok(failedRules('Meeting').includes('short-activity-phrase'))
  assert.ok(
    failedRules('Setting up the whole new work network for the office').includes(
      'short-activity-phrase',
    ),
  )
  assert.ok(!failedRules('Configuring the work network').includes('short-activity-phrase'))
})

test('labelVoiceContextForBlock reads apps, titles, pages, and files defensively', () => {
  const context = labelVoiceContextForBlock(
    {
      topApps: [{ appName: 'Cursor' }, { appName: '  ' }],
      websites: [{ topTitle: 'Ubiquiti dashboard' }],
      pageRefs: [{ displayTitle: 'Network setup guide' }, { pageTitle: 'Fallback title' }],
      evidenceSummary: {
        windowTitles: [{ title: 'unifi-controller' }],
        files: [{ filename: 'network.md' }],
      },
    },
    'work',
  )
  assert.deepEqual(context.appNames, ['Cursor'])
  assert.deepEqual(context.windowTitles, ['unifi-controller'])
  assert.deepEqual(context.pageTitles, ['Network setup guide', 'Fallback title', 'Ubiquiti dashboard'])
  assert.equal(context.kind, 'work')
  assert.equal(context.hasSubjectEvidence, true)

  const empty = labelVoiceContextForBlock({})
  assert.equal(empty.hasSubjectEvidence, false)
})

test('summary counts invariant and full-voice labels per rule with examples', () => {
  const evaluated = [
    { label: 'Configuring the work network', findings: evaluateLabelVoice('Configuring the work network') },
    { label: '(3) Inbox', findings: evaluateLabelVoice('(3) Inbox') },
    { label: 'Meeting', findings: evaluateLabelVoice('Meeting') },
  ]
  const summary = summarizeLabelVoice(evaluated)
  assert.equal(summary.labelsEvaluated, 3)
  assert.equal(summary.labelsMeetingInvariants, 2)
  assert.equal(summary.labelsMeetingTarget, 1)
  const rawRule = summary.rules.find((rule) => rule.rule === 'no-raw-artifact-forms')
  assert.equal(rawRule?.failed, 1)
  assert.match(rawRule?.example ?? '', /\(3\) Inbox/)
  const lines = labelVoiceReportLines(summary)
  assert.ok(lines.some((line) => line.includes('meeting the full voice: 1')))
  assert.ok(lines.some((line) => line.includes('no-raw-artifact-forms')))
})

test('real-day review names each failing label with rule, tier, and reason', () => {
  const review = buildLabelVoiceReview([
    {
      label: 'Configuring the work network',
      range: '09:00–11:10',
      context: { kind: 'work', hasSubjectEvidence: true },
    },
    {
      label: 'Big Buck Bunny 4K60',
      range: '20:00–21:30',
      context: { kind: 'leisure', pageTitles: ['Big Buck Bunny 4K60'], hasSubjectEvidence: true },
    },
  ])
  assert.equal(review.rubric, 'docs/specs/label-voice.md')
  assert.equal(review.summary.labelsEvaluated, 2)
  assert.equal(review.summary.labelsMeetingInvariants, 1)
  const leisureFailure = review.failures.find((f) => f.rule === 'leisure-activity-shaped')
  assert.equal(leisureFailure?.tier, 'invariant')
  assert.equal(leisureFailure?.label, 'Big Buck Bunny 4K60')
  const verbatim = review.failures.find((f) => f.rule === 'no-verbatim-window-title')
  assert.equal(verbatim?.tier, 'target')

  const lines = labelVoiceMarkdownLines(review)
  assert.ok(lines.some((line) => line.includes('docs/specs/label-voice.md')))
  assert.ok(
    lines.some((line) => line.includes('Big Buck Bunny 4K60') && line.includes('leisure-activity-shaped')),
  )

  const clean = buildLabelVoiceReview([
    {
      label: 'Reviewed the quarterly report',
      range: '09:00–10:00',
      context: { kind: 'work' },
    },
  ])
  assert.equal(clean.failures.length, 0)
  assert.ok(
    labelVoiceMarkdownLines(clean).some((line) => line.includes('meets the recorded voice')),
  )
})
