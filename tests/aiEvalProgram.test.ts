// Q6 — structural guardrail for the answer-quality eval program. Hermetic and
// free (no provider calls): it locks in that the eval set stays well-formed and
// keeps covering every question family the spec + AI-PRODUCT-DIRECTION require,
// so a future edit can't silently drop "files", "meta", or the follow-up guard.
//
// The live, graded run is `npm run test:behaviour` (bills the API; per provider
// via DAYLENS_EVAL_PROVIDER) — that part is intentionally not in CI.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { JUDGE_SYSTEM } from './ai-behaviour/judge.ts'
import type { ScenarioRecord } from './ai-behaviour/types.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function loadScenarios(): ScenarioRecord[] {
  const doc = yaml.load(fs.readFileSync(path.join(HERE, 'ai-behaviour', 'scenarios.yaml'), 'utf8')) as {
    scenarios: ScenarioRecord[]
  }
  return doc.scenarios
}

// Question families the program must always cover (Q6 lists: today / this-week /
// by-project / by-app / by-client / files / focus / who-are-my-clients / meta,
// plus consistency and a hallucination trap).
const REQUIRED_FAMILIES = [
  'client_attribution', // who are my clients
  'time_at_moment',     // today at 4pm
  'specific_work',      // by project (e.g. Daylens this week)
  'time_and_duration',  // focus / by app / this week
  'generative',         // reports, status updates
  'reflective',         // deep-work pattern
  'hallucination_trap', // fabrication guard
  'files',              // Q2 — files != pages
  'meta',               // Q3 — identity + follow-ups
  'consistency',        // Q1 — one grounded number
  'specific_day',       // Q13 — "what did I do on <date>" as activities, not app lists
  'agent_native',       // Q13 — asks whose answer is a real artifact
  'timeline_edit',      // Q13 — merge/relabel intent → propose_correction flow
  'tool_transparency',  // Q13 — honest "what can you see about me"
]

test('eval set is well-formed (id/question/family/gold/rubric, unique ids)', () => {
  const scenarios = loadScenarios()
  assert.ok(scenarios.length >= 10, 'expected a substantive eval set')
  const ids = new Set<string>()
  for (const s of scenarios) {
    assert.ok(s.id, 'scenario missing id')
    assert.ok(!ids.has(s.id), `duplicate scenario id: ${s.id}`)
    ids.add(s.id)
    assert.ok(s.question?.trim(), `${s.id}: missing question`)
    assert.ok(s.family?.trim(), `${s.id}: missing family`)
    assert.ok((s.gold_answer_shape ?? '').trim().length > 20, `${s.id}: gold_answer_shape too thin`)
    assert.ok(s.rubric && Object.keys(s.rubric).length > 0, `${s.id}: empty rubric`)
  }
})

test('eval set covers every required question family', () => {
  const families = new Set(loadScenarios().map((s) => s.family))
  for (const fam of REQUIRED_FAMILIES) {
    assert.ok(families.has(fam), `eval set is missing a scenario for family: ${fam}`)
  }
})

test('the meta scenario guards templated follow-ups (Q3)', () => {
  const meta = loadScenarios().find((s) => s.family === 'meta')
  assert.ok(meta, 'no meta scenario in the eval set')
  assert.equal(meta?.rubric.follow_ups_must_not_template_meta_entity, true)
})

// ── Q13 family guards: each new family must keep the rubric flags that make
//    it worth having. Without these, a scenario edit could keep the family
//    name while dropping the actual bar it enforces.

test('specific-day scenarios grade activity, not app lists', () => {
  const days = loadScenarios().filter((s) => s.family === 'specific_day')
  assert.ok(days.length >= 2, 'expected at least two specific-day scenarios')
  for (const s of days) {
    assert.equal(s.rubric.must_describe_activity_not_just_minutes, true, `${s.id}: missing the activity-not-app flag`)
  }
})

test('agent-native scenarios require a real artifact', () => {
  const native = loadScenarios().filter((s) => s.family === 'agent_native')
  assert.ok(native.length >= 2, 'expected at least two agent-native scenarios')
  for (const s of native) {
    assert.equal(s.rubric.must_produce_artifact, true, `${s.id}: agent-native scenario without must_produce_artifact`)
  }
  // The weekly Excel ask must pin the deterministic export, not hand-typed rows.
  assert.ok(
    native.some((s) => s.rubric.must_use_deterministic_week_export === true),
    'no agent-native scenario guards the deterministic weekly export',
  )
})

test('timeline-edit scenarios enforce propose → preview, never silent edits', () => {
  const edits = loadScenarios().filter((s) => s.family === 'timeline_edit')
  assert.ok(edits.length >= 2, 'expected at least two timeline-edit scenarios')
  for (const s of edits) {
    assert.equal(s.rubric.must_use_correction_proposal_flow, true, `${s.id}: missing the correction-flow flag`)
    assert.equal(s.rubric.must_not_claim_unapplied_edit, true, `${s.id}: missing the no-silent-edit flag`)
  }
})

test('tool-transparency scenario demands both sides of the honesty ledger', () => {
  const transparency = loadScenarios().find((s) => s.family === 'tool_transparency')
  assert.ok(transparency, 'no tool-transparency scenario in the eval set')
  assert.equal(transparency?.rubric.must_list_real_capabilities, true)
  assert.equal(transparency?.rubric.must_name_what_is_not_captured, true)
  assert.equal(transparency?.rubric.must_mention_consent_gates, true)
})

test('hallucination traps cover fabricated client, pre-tracking date, and nonexistent person', () => {
  const traps = loadScenarios().filter((s) => s.family === 'hallucination_trap')
  assert.ok(traps.length >= 3, 'expected at least three hallucination traps')
  for (const s of traps) {
    assert.equal(s.rubric.must_admit_no_data, true, `${s.id}: trap without must_admit_no_data`)
  }
  assert.ok(traps.some((s) => s.rubric.must_name_tracking_start === true), 'no pre-tracking-date trap')
  assert.ok(traps.some((s) => s.rubric.must_not_invent_meetings_or_people === true), 'no nonexistent-person trap')
  assert.ok(traps.some((s) => s.rubric.must_not_invent_blocks === true && s.question.toLowerCase().includes('client')), 'no fabricated-client trap')
})

test('judge rubric documents the gold-answer-bar axes', () => {
  for (const axis of ['Activity, not app', 'Minute-level precision', 'Follow-up suggestion', 'gold_answer_shape']) {
    assert.ok(JUDGE_SYSTEM.includes(axis), `judge system prompt is missing the "${axis}" axis`)
  }
})
