// Adversarial honesty checks. Each block builds the situation most likely to
// TEMPT the writer into a specific dishonest claim and proves the
// deterministic guards kill it — as true negatives, with an honest control
// line that must survive, so the guard is strict without being trigger-happy.
//
// The same guard functions run inside the live benchmark's deterministic
// pre-check (tests/wrapped-bench/harness.ts) and inside the runtime validator,
// so a live deck that makes any of these claims fails the paid gate AND never
// ships to a user. The six claims:
//   1. attendance         — a calendar event is a schedule, not proof of presence
//   2. unobserved time    — time away from the screen is unknown, never narrated
//   3. reading / watching — an open page or player was open, not consumed
//   4. finishing          — no completion claim without a verified artifact
//   5. attention quality  — an unbroken stretch is observable, "focus" is not
//   6. an unwritten plan  — no morning-intention field exists; any plan is invented

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findOverclaimViolation,
  findUnverifiedCompletionClaim,
  wrapLineViolation,
  type LineGuardContext,
} from '../src/main/lib/wrapNarrativeShared.ts'
import { validateWrappedNarrativeObject } from '../src/main/lib/wrappedNarrative.ts'
import { planDayWrapSlides } from '../src/renderer/lib/wrapDeck.ts'
import type { DayWrapFacts } from '../src/renderer/lib/dayWrapScenes.ts'

// ─── A tempting day ───────────────────────────────────────────────────────────
// Calendar-looking meeting time, a long YouTube block, a repo-shaped work
// thread with a long unbroken stretch, and a thin afternoon: every ingredient
// each overclaim needs, with no enrichment to verify any of it.

function temptingFacts(overrides: Partial<DayWrapFacts> = {}): DayWrapFacts {
  return {
    date: '2026-07-07', weekday: 'TUESDAY', dateLabel: 'JUL 7',
    workSeconds: 4 * 3600, leisureSeconds: 3600, personalSeconds: 0, meetingsSeconds: 35 * 60,
    activeSeconds: 5 * 3600,
    workActivities: [{ name: 'The tracking engine', seconds: 4 * 3600, category: 'development', kind: 'work' }],
    ribbon: [], ribbonStartClock: '9:12am', ribbonEndClock: '6:04pm',
    standout: { name: 'The tracking engine', seconds: 2 * 3600 + 29 * 60, startClock: '7:12am', endClock: '9:41am' },
    topLeisure: ['YouTube'], isLeisureDay: false, quality: 'full',
    seed: 7,
    appSites: [
      { name: 'Cursor', seconds: 3 * 3600, category: 'development', kind: 'work' },
      { name: 'YouTube', seconds: 3600, category: 'entertainment', kind: 'leisure' },
    ],
    candidateHooks: [], wildcardHook: null,
    dayStory: [], mainStartClock: '9:12am', titleContext: [],
    ...overrides,
  }
}

const ctx: LineGuardContext = {
  totalHours: 5,
  hourTolerance: 1.05,
  allowedPercents: new Set(),
  allowedTimes: new Set(['9:12am', '6:04pm']),
}

// ─── 1. Attendance ────────────────────────────────────────────────────────────

test('adversarial: 35 minutes of meeting-category time never becomes attendance', () => {
  for (const line of [
    'You attended the design review and got back to the engine after.',
    'You joined the standup and built through the rest of the morning.',
    'You hopped on the client call before the real work started.',
    'You went to the 1:1 and the afternoon opened up after it.',
  ]) {
    assert.ok(wrapLineViolation(line, ctx), `attendance claim survived: ${line}`)
  }
  // The honest calendar-anchored phrasing must survive.
  assert.equal(wrapLineViolation('Your calendar had the design review, and the engine got the rest of the morning.', ctx), null)
})

// ─── 2. Activity during unobserved time ───────────────────────────────────────

test('adversarial: a gap in tracking is never narrated as what filled it', () => {
  for (const line of [
    'You stepped away for a long lunch and came back sharper.',
    'You took a walk between the two blocks.',
    'You went to the gym in the quiet stretch after 2.',
    'The afternoon was mostly idle.',
    'A long break, probably lunch with the team.',
  ]) {
    assert.ok(wrapLineViolation(line, ctx), `unobserved-time claim survived: ${line}`)
  }
  // Anchoring the honesty to the screen is the legal form.
  assert.equal(wrapLineViolation('Most of the afternoon happened away from this screen, so the story picks back up in the evening.', ctx), null)
})

// ─── 3. Reading / watching (open ≠ consumed) ──────────────────────────────────

test('adversarial: an hour of YouTube in front never becomes "you watched"', () => {
  for (const line of [
    'You watched an hour of videos before the evening wound down.',
    'You read the whole methods paper before lunch.',
    'You caught up on the backlog of talks in the afternoon.',
    'You listened to the full episode while the build ran.',
  ]) {
    assert.ok(wrapLineViolation(line, ctx), `consumption claim survived: ${line}`)
  }
  // Naming the surface and the time is the honest form.
  assert.equal(wrapLineViolation('YouTube held the biggest leisure share, and it sat in the evening where it belonged.', ctx), null)
})

// ─── 4. Finishing without verified output ─────────────────────────────────────

test('adversarial: four hours on one thread never becomes "finished" without an artifact', () => {
  const unverified = { ...ctx, outputVerified: false }
  for (const line of [
    'You finished the tracking engine rewrite by evening.',
    'The proposal is done, four hours of steady pushing.',
    'The refactor got done before the light went.',
    'The deck crossed the line an hour before the readout.',
  ]) {
    assert.ok(wrapLineViolation(line, unverified), `unverified completion survived: ${line}`)
  }
  // With verified output (git shipped / recorded notes), completion words are
  // exactly what voice.md loves — the same line must survive.
  const verified = { ...ctx, outputVerified: true }
  assert.equal(wrapLineViolation('You finished the tracking engine rewrite by evening.', verified), null)
  assert.equal(findUnverifiedCompletionClaim('The fix merged before lunch.', true), null)
  assert.ok(findUnverifiedCompletionClaim('The fix merged before lunch.', false))
})

// ─── 5. Attention / focus quality ─────────────────────────────────────────────

test('adversarial: a 2h 29m stretch never becomes a focus grade', () => {
  for (const line of [
    'A deeply focused morning on the engine, your best in weeks.',
    'You stayed focused for the whole stretch.',
    'Your deepest focus landed before the standup.',
    'Two and a half hours of pure focus on the tracking work.',
  ]) {
    assert.ok(wrapLineViolation(line, ctx), `attention-quality claim survived: ${line}`)
  }
  // The observable fact — the measured run — is the legal form; continuity
  // absolutes ("unbroken") die with the grades.
  assert.equal(wrapLineViolation('Two and a half hours on the engine, the longest run of the day.', ctx), null)
  assert.ok(wrapLineViolation('Two and a half hours on the engine, one unbroken run.', ctx))
  // A real focus-timer fact stays nameable (the enrichment noun, not a grade).
  assert.equal(findOverclaimViolation('Three focus sessions in Forest, all before lunch.'), null)
})

// ─── 6. A plan that was never written ─────────────────────────────────────────

test('adversarial: no plan exists in the data, so no plan is ever claimed', () => {
  for (const line of [
    'The plan was to ship the tracking fix, and the day mostly obeyed.',
    'You planned to clear the inbox and the morning went exactly there.',
    'You set out to close the bug and stayed with it.',
    'The day went almost exactly as planned.',
  ]) {
    assert.ok(wrapLineViolation(line, ctx), `invented-plan claim survived: ${line}`)
  }
  // Asking about intent is legal (the question slide's job); claiming it is not.
  assert.equal(findOverclaimViolation('The engine took the whole morning. Was that the idea, or did it take over?'), null)
})

// ─── The runtime deck path enforces the same rules ────────────────────────────

function deckResponse(facts: DayWrapFacts, over: Record<string, string> = {}): Record<string, unknown> {
  const lines: Record<string, string> = {}
  for (const spec of planDayWrapSlides(facts)) {
    if (!spec.ask) continue
    lines[spec.id] = spec.id === 'opening'
      ? 'A steady one, mostly heads-down on the tracking engine.'
      : 'A steady, honest stretch of the day, plainly told.'
  }
  Object.assign(lines, over)
  return {
    lines,
    question: 'What pulled the engine work into the whole morning?',
    reflection: 'You went into the engine early and stayed there most of the morning. The afternoon opened up after the calendar cleared, and a little of the evening went to unwinding. It reads like a day that knew what it was for.',
  }
}

test('adversarial: an off-by-one duration dies at the validator, not at the paid judge', () => {
  // The exact week-bench failure: facts say 2h 29m, the writer rounds to 2h 28m.
  const facts = temptingFacts()
  const bad = deckResponse(facts, { focus: 'From 7:12am you went 2h 28m on the engine without surfacing.' })
  const { narrative, rejections } = validateWrappedNarrativeObject(bad, facts, 'h', null)
  assert.ok(narrative, 'the deck survives; the poisoned slide dies alone')
  assert.equal(narrative!.lines.focus, null, 'the off-by-one duration must die')
  const rejection = rejections.find((r) => r.id === 'focus')
  assert.ok(rejection && /2h 28m/.test(rejection.reason), 'the reason names the ungrounded duration')

  // The exact facts duration survives.
  const good = deckResponse(facts, { focus: 'From 7:12am you went 2h 29m on the engine without surfacing.' })
  const goodResult = validateWrappedNarrativeObject(good, facts, 'h', null)
  assert.equal(goodResult.narrative!.lines.focus, good.lines ? (good.lines as Record<string, string>).focus : null)
})

test('adversarial: the deck keeps ONE emoji; a second earned-looking one dies', () => {
  const facts = temptingFacts()
  const raw = deckResponse(facts, {
    opening: 'A real building day, and you saw it through 🏆',
    headline: 'Most of it stacked up before the calendar filled 🔥',
  })
  const { narrative, rejections } = validateWrappedNarrativeObject(raw, facts, 'h', null)
  assert.ok(narrative)
  assert.equal(narrative!.lead, 'A real building day, and you saw it through 🏆', 'the first emoji is the earned one')
  assert.equal(narrative!.lines.headline, null, 'the second emoji-bearing line dies')
  const rejection = rejections.find((r) => r.id === 'headline')
  assert.ok(rejection && /one emoji/.test(rejection.reason), 'the reason teaches the deck budget')
})

test('adversarial: the benchmark pre-check catches every category deterministically', () => {
  // The harness's deterministic pre-check runs findOverclaimViolation on every
  // shipped line — these must all trip it so the PAID gate fails such a deck
  // regardless of how well the judge scores the prose.
  for (const line of [
    'You attended the design review before lunch.',
    'You probably kept at it after the laptop closed.',
    'You watched an hour of videos to wind down.',
    'A deeply focused morning, your sharpest in weeks.',
    'The plan was to ship the fix, and you did.',
  ]) {
    assert.ok(findOverclaimViolation(line), `bench pre-check missed: ${line}`)
  }
})
