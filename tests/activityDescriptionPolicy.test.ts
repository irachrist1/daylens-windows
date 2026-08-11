import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_DESCRIPTION_DIRECTIVES,
  ACTIVITY_DESCRIPTION_RULES,
  BANNED_VOCAB,
  DESCRIPTION_PLUMBING_VOCAB,
  JUDGMENT_RE,
  LABEL_PLUMBING_VOCAB,
  PROSE_PLUMBING_VOCAB,
  activityDescriptionFindings,
  assertEvidenceOwned,
  evaluateActivityDescription,
  supportedDetailNames,
  uncertaintyStatement,
  type SupportedInterpretation,
} from '../src/shared/activityDescription.ts'
import { recapVoiceFindings } from '../src/shared/labelVoice.ts'
import { PLUMBING_VOCAB, findBannedVocab, findPlumbingVocab } from '../src/main/ai/voiceContract.ts'

// WO-99 / REQ-VIC-001, REQ-VIC-003. Every fixture below is invented activity:
// an invented client (Ridgeline), an invented project (the sync engine), and
// invented window titles. Nothing here is copied from a real tracked day.

function findingFor(text: string, rule: string, context = {}) {
  return evaluateActivityDescription(text, context).find((entry) => entry.rule === rule)!
}

const INTERPRETATION: SupportedInterpretation = {
  activity: 'Reworking the sync engine',
  provenance: 'evidence',
  supportedDetails: [
    { name: 'sync engine', kind: 'window-title' },
    { name: 'Ridgeline', kind: 'calendar' },
  ],
  facts: {
    duration: ['1h 24m'],
    url: ['docs.example-invented.dev'],
    file: ['scheduler.ts'],
  },
}

// ── AC-VIC-001.1: one executable policy ────────────────────────────────────

test('AC-VIC-001.1: label rules and description rules read one vocabulary', () => {
  // Identity, not a copied list: the point of the convergence is that there is
  // exactly one definition site, so a term added there binds everywhere.
  assert.equal(PLUMBING_VOCAB, PROSE_PLUMBING_VOCAB)
  assert.equal(findPlumbingVocab('Safari was foreground 40m'), 'foreground')
  assert.equal(findBannedVocab('Great question, let us dive into your day.'), 'dive into')
  // The prose check exported from labelVoice.ts is the same implementation.
  assert.equal(recapVoiceFindings, activityDescriptionFindings)
})

test('AC-VIC-001.1: every rule names the acceptance criterion it makes executable', () => {
  for (const rule of ACTIVITY_DESCRIPTION_RULES) {
    assert.match(rule.criterion, /^AC-VIC-00[13]\.\d$/, `${rule.id} has no criterion`)
    assert.ok(rule.requirement.length > 20, `${rule.id} has no stated requirement`)
  }
  const covered = new Set(ACTIVITY_DESCRIPTION_RULES.map((rule) => rule.criterion))
  for (const criterion of ['AC-VIC-001.2', 'AC-VIC-001.3', 'AC-VIC-001.4', 'AC-VIC-003.2', 'AC-VIC-003.3']) {
    assert.ok(covered.has(criterion), `no rule makes ${criterion} executable`)
  }
})

test('AC-VIC-001.1: the prompt directives are generated from the enforced vocabulary', () => {
  // Prompt and checker must not drift: the ban the model is told about is the
  // ban the check applies.
  const directives = ACTIVITY_DESCRIPTION_DIRECTIVES.join('\n')
  for (const term of DESCRIPTION_PLUMBING_VOCAB) {
    assert.ok(directives.includes(term), `the plumbing ban never states "${term}"`)
  }
  for (const term of BANNED_VOCAB) {
    assert.ok(directives.includes(term), `the banned-vocabulary line never states "${term}"`)
  }
})

// ── AC-VIC-001.2: no unsupported named detail ──────────────────────────────

test('AC-VIC-001.2: naming a client the evidence does not support fails', () => {
  const failed = findingFor(
    'Drafting the Ridgeline renewal for Calderwood.',
    'no-unsupported-detail',
    { interpretation: INTERPRETATION, candidateDetails: ['Calderwood', 'Ridgeline'] },
  )
  assert.equal(failed.passed, false)
  assert.match(failed.detail!, /Calderwood/)
  assert.equal(failed.criterion, 'AC-VIC-001.2')
})

test('AC-VIC-001.2: the same description passes once the evidence supports the name', () => {
  const supported: SupportedInterpretation = {
    ...INTERPRETATION,
    supportedDetails: [...INTERPRETATION.supportedDetails, { name: 'Calderwood', kind: 'calendar' }],
  }
  const finding = findingFor(
    'Drafting the Ridgeline renewal for Calderwood.',
    'no-unsupported-detail',
    { interpretation: supported, candidateDetails: ['Calderwood', 'Ridgeline'] },
  )
  assert.equal(finding.passed, true)
})

test('AC-VIC-001.2: a supported name inside a longer word is not a mention', () => {
  // A client called "Ash" must not be "found" inside "dashboard".
  const finding = findingFor(
    'Reading the dashboard notes.',
    'no-unsupported-detail',
    { interpretation: INTERPRETATION, candidateDetails: ['Ash'] },
  )
  assert.equal(finding.passed, true)
})

test('AC-VIC-001.2: with no interpretation the rule reports passed rather than guessing', () => {
  // An unevaluable rule is not a violation. Extracting proper nouns from prose
  // would accuse honest descriptions.
  assert.equal(findingFor('Drafting the Ridgeline renewal.', 'no-unsupported-detail').passed, true)
})

// ── AC-VIC-001.3: activity before telemetry ────────────────────────────────

test('AC-VIC-001.3: opening on the app name fails; tail attribution passes', () => {
  const bad = findingFor('Cursor, 1h 24m on the sync engine.', 'activity-before-telemetry', {
    appNames: ['Cursor', 'Safari'],
  })
  assert.equal(bad.passed, false)
  assert.match(bad.detail!, /Cursor/)

  const good = findingFor('Reworking the sync engine, in Cursor.', 'activity-before-telemetry', {
    appNames: ['Cursor', 'Safari'],
  })
  assert.equal(good.passed, true)
})

// ── AC-VIC-001.4: the banned forms ─────────────────────────────────────────

test('AC-VIC-001.4: each banned form fails its own rule and names the fragment', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['Safari was foreground for most of it.', 'no-plumbing', /foreground/],
    ['Time to elevate the sync engine work.', 'no-hype', /elevate/],
    ['A productive stretch on the sync engine.', 'no-judgment', /productive/],
    ['Focus held for 1h 24m of tracked time.', 'no-internal-template', /focus held for/],
    ['Some work on the laptop.', 'no-weak-activity', /some work/i],
    ['Reworking the sync engine — mostly the scheduler.', 'no-em-dash', /em dash/],
  ]
  for (const [text, rule, expected] of cases) {
    const finding = findingFor(text, rule)
    assert.equal(finding.passed, false, `"${text}" should fail ${rule}`)
    assert.match(finding.detail!, expected)
  }
})

test('AC-VIC-001.4: a clean description passes every invariant rule', () => {
  const findings = evaluateActivityDescription('Reworking the sync engine, in Cursor.', {
    appNames: ['Cursor'],
    interpretation: INTERPRETATION,
    candidateDetails: ['Calderwood'],
  })
  const failures = findings.filter((finding) => !finding.passed)
  assert.deepEqual(failures, [], `unexpected failures: ${JSON.stringify(failures)}`)
})

// ── AC-VIC-003.1 / .2: uncertainty, without judgment ───────────────────────

test('AC-VIC-003.1: capture limits produce exactly one sentence', () => {
  const statement = uncertaintyStatement({
    ...INTERPRETATION,
    captureLimits: ['which pages were open in Safari'],
  })
  assert.ok(statement)
  assert.equal(statement!.match(/\./g)?.length, 1, `not one sentence: ${statement}`)
  assert.match(statement!, /which pages were open in Safari/)
})

test('AC-VIC-003.1: two limits stay one sentence, and no limits produce nothing', () => {
  const statement = uncertaintyStatement({
    ...INTERPRETATION,
    captureLimits: ['which pages were open in Safari', 'who the 2pm call was with'],
  })
  assert.ok(statement)
  assert.equal(statement!.match(/\./g)?.length, 1, `not one sentence: ${statement}`)
  assert.match(statement!, / or /)
  assert.equal(uncertaintyStatement(INTERPRETATION), null)
})

test('AC-VIC-003.2: the uncertainty sentence never judges', () => {
  const statement = uncertaintyStatement({
    ...INTERPRETATION,
    captureLimits: ['what filled the gap after 3pm'],
  })!
  // Checked against the shared pattern itself, not a copy of it.
  assert.equal(JUDGMENT_RE.test(statement), false, `judgment in the uncertainty line: ${statement}`)
  assert.deepEqual(activityDescriptionFindings(statement), [])
})

// ── AC-VIC-003.3: evidence owns the facts ──────────────────────────────────

test('AC-VIC-003.3: a duration, URL, or file the evidence never recorded is rejected', () => {
  for (const text of [
    'Reworking the sync engine for 2h 10m.',
    'Reworking the sync engine on internal-invented.example.com.',
    'Reworking the sync engine in planner.ts.',
  ]) {
    assert.throws(
      () => assertEvidenceOwned(text, INTERPRETATION),
      /Model-originated fact/,
      `should reject: ${text}`,
    )
  }
})

test('AC-VIC-003.3: the same shapes pass when the interpretation recorded them', () => {
  assert.doesNotThrow(() => assertEvidenceOwned('Reworking the sync engine for 1h 24m.', INTERPRETATION))
  assert.doesNotThrow(() => assertEvidenceOwned('Reading docs.example-invented.dev.', INTERPRETATION))
  assert.doesNotThrow(() => assertEvidenceOwned('Editing scheduler.ts.', INTERPRETATION))
})

test('AC-VIC-003.3: an interpretation with no facts block makes no claim to contradict', () => {
  const noFacts: SupportedInterpretation = {
    activity: 'Reworking the sync engine',
    provenance: 'evidence',
    supportedDetails: [],
  }
  assert.doesNotThrow(() => assertEvidenceOwned('Reworking the sync engine for 2h 10m.', noFacts))
})

// ── The two plumbing scopes stay separate ──────────────────────────────────

test('the label scope is stricter than the prose scope, on purpose', () => {
  // The honest capability answer has to name window titles as something Daylens
  // captures; a LABEL reading "window title" is always wrong.
  assert.equal(findPlumbingVocab('I can see window titles and the pages you visit.'), null)
  assert.ok(LABEL_PLUMBING_VOCAB.includes('window title'))
  assert.ok(!PROSE_PLUMBING_VOCAB.includes('window title' as never))
  // A description ABOUT a day is held to both scopes.
  assert.ok(DESCRIPTION_PLUMBING_VOCAB.includes('window title'))
  assert.ok(DESCRIPTION_PLUMBING_VOCAB.includes('page-level detail'))
})

test('supportedDetailNames lowercases and drops blanks', () => {
  const names = supportedDetailNames({
    activity: 'Reworking the sync engine',
    provenance: 'evidence',
    supportedDetails: [
      { name: '  Ridgeline ', kind: 'calendar' },
      { name: '   ', kind: 'page' },
    ],
  })
  assert.deepEqual([...names], ['ridgeline'])
})
