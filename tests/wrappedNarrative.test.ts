import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildFallbackNarrative,
  buildWrappedPrompts,
  computeFactsHash,
  validateWrappedNarrativeResponse,
} from '../src/main/lib/wrappedNarrative.ts'
import { planDayWrapSlides } from '../src/renderer/lib/wrapDeck.ts'
import { buildDayWrapFacts, type DayWrapFacts } from '../src/renderer/lib/dayWrapScenes.ts'
import type { AppCategory, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeBlock(opts: {
  label: string
  start: number
  durationSeconds: number
  category?: AppCategory
  appName?: string
}): WorkContextBlock {
  const category: AppCategory = opts.category ?? 'development'
  const appName = opts.appName ?? 'Cursor'
  return {
    id: `b:${opts.label}:${opts.start}`,
    startTime: opts.start,
    endTime: opts.start + opts.durationSeconds * 1000,
    dominantCategory: category,
    categoryDistribution: { [category]: opts.durationSeconds },
    ruleBasedLabel: opts.label,
    aiLabel: null,
    sessions: [],
    topApps: [{ bundleId: appName.toLowerCase(), appName, category, totalSeconds: opts.durationSeconds, sessionCount: 1, isBrowser: false }],
    websites: [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: [],
    workflowRefs: [],
    label: {
      current: opts.label,
      source: 'rule',
      confidence: 0.92,
      narrative: null,
      ruleBased: opts.label,
      aiSuggested: null,
      override: null,
    },
    focusOverlap: { totalSeconds: opts.durationSeconds, pct: 100, sessionIds: [] },
    evidenceSummary: { apps: [], pages: [], documents: [], domains: [] },
    heuristicVersion: 'test',
    computedAt: opts.start,
    switchCount: 0,
    confidence: 'high',
    review: { ...DEFAULT_TIMELINE_BLOCK_REVIEW, state: 'auto-approved' },
    isLive: false,
  }
}

function makeDayPayload(blocks: WorkContextBlock[]): DayTimelinePayload {
  const total = blocks.reduce((s, b) => s + Math.round((b.endTime - b.startTime) / 1000), 0)
  return {
    date: '2026-05-12',
    sessions: [],
    websites: [],
    blocks,
    segments: [],
    focusSessions: [],
    computedAt: Date.now(),
    version: 'test',
    totalSeconds: total,
    focusSeconds: total,
    focusPct: 100,
    appCount: 0,
    siteCount: 0,
  }
}

const NINE_AM = new Date('2026-05-12T09:00:00').getTime()
const ONE_PM = new Date('2026-05-12T13:00:00').getTime()
const SIX_PM = new Date('2026-05-12T18:00:00').getTime()

function workingDayFacts(): DayWrapFacts {
  return buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: NINE_AM, durationSeconds: 90 * 60, category: 'development', appName: 'Cursor' }),
    makeBlock({ label: 'Design review', start: ONE_PM, durationSeconds: 40 * 60, category: 'design', appName: 'Figma' }),
    // A short leisure tail so the honest work/leisure split slide exists.
    makeBlock({ label: 'YouTube', start: SIX_PM, durationSeconds: 25 * 60, category: 'entertainment', appName: 'YouTube' }),
  ]))
}

function emptyFacts(): DayWrapFacts {
  return buildDayWrapFacts(makeDayPayload([]))
}

/** A clean deck response: one plausible line per asked slide id, plus a real
 *  question and reflection. Built from the SAME plan the validator replans. */
function deckResponse(facts: DayWrapFacts, over: Record<string, unknown> = {}): string {
  const lines: Record<string, string> = {}
  for (const spec of planDayWrapSlides(facts)) {
    if (!spec.ask) continue
    lines[spec.id] = spec.id === 'opening'
      ? 'A steady one, mostly heads-down on the auth work.'
      : 'A steady, honest stretch of the day, plainly told.'
  }
  return JSON.stringify({
    lines,
    question: 'What pulled you into the design review after lunch?',
    reflection: 'You went into the code early and stayed there most of the morning. The afternoon turned to the design review, and a little of the evening went to unwinding. It reads like a day that knew what it was for.',
    ...over,
  })
}

// ─── Facts shape (unchanged layer, still pinned) ──────────────────────────────

test('facts: a working day yields appSites, a story, and a wildcard hook', () => {
  const facts = workingDayFacts()
  assert.ok(facts.appSites.length >= 2, 'expected app/site distribution')
  assert.ok(facts.dayStory.some((s) => s.part === 'morning'), 'expected a morning beat')
  assert.ok(facts.dayStory.some((s) => s.part === 'midday'), 'expected a midday beat')
  assert.ok(facts.wildcardHook, 'expected a wildcard hook')
})

test('facts: the app/site distribution sums to the headline exactly', () => {
  const facts = workingDayFacts()
  const sum = facts.appSites.reduce((s, slice) => s + slice.seconds, 0)
  assert.equal(sum, facts.activeSeconds)
})

test('facts: the same date seeds identically', () => {
  assert.equal(workingDayFacts().seed, workingDayFacts().seed)
})

// ─── validateWrappedNarrativeResponse ─────────────────────────────────────────

test('validate: accepts a clean deck response and keys lines by slide id', () => {
  const facts = workingDayFacts()
  const result = validateWrappedNarrativeResponse(deckResponse(facts), facts, 'abc123')
  assert.ok(result)
  assert.equal(result!.source, 'ai')
  assert.equal(result!.factsHash, 'abc123')
  assert.equal(result!.lead, 'A steady one, mostly heads-down on the auth work.')
  assert.ok(result!.lines['story-morning'], 'expected a morning line')
  assert.ok(result!.question?.endsWith('?'), 'expected a real question')
  assert.ok(result!.reflection && result!.reflection.length >= 80, 'expected a real reflection paragraph')
})

test('validate: tolerates a fenced ```json block', () => {
  const facts = workingDayFacts()
  assert.ok(validateWrappedNarrativeResponse('```json\n' + deckResponse(facts) + '\n```', facts, 'h'))
})

test('validate: a missing or dead opening kills the whole response', () => {
  const facts = workingDayFacts()
  const linesWithout = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  delete linesWithout.lines.opening
  assert.equal(validateWrappedNarrativeResponse(JSON.stringify(linesWithout), facts, 'h'), null)
})

test('validate: one bad line dies alone, the deck survives', () => {
  const facts = workingDayFacts()
  const parsed = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  parsed.lines.headline = 'A full one — mostly heads-down.' // em dash: banned
  const result = validateWrappedNarrativeResponse(JSON.stringify(parsed), facts, 'h')
  assert.ok(result, 'the wrap must survive a single bad line')
  assert.equal(result!.lines.headline, null, 'the bad line falls back')
  assert.ok(result!.lead, 'the opening still leads')
})

test('validate: rejects an invented percentage, keeps the slide-shown one', () => {
  const facts = workingDayFacts()
  const plan = planDayWrapSlides(facts)
  const split = plan.find((s) => s.id === 'split')
  assert.ok(split?.split, 'fixture should produce a split slide')

  // A percentage no slide shows is an invented grade: the line dies.
  const bad = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  bad.lines.headline = 'You were productive 87% of the day, a strong showing.'
  const badResult = validateWrappedNarrativeResponse(JSON.stringify(bad), facts, 'h')
  assert.ok(badResult)
  assert.equal(badResult!.lines.headline, null)

  // The exact percentage the split slide shows is allowed.
  const good = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  good.lines.split = `About ${split!.split!.aPct}% of the day was real work, and the rest was rest.`
  const goodResult = validateWrappedNarrativeResponse(JSON.stringify(good), facts, 'h')
  assert.ok(goodResult)
  assert.ok(goodResult!.lines.split, 'the slide-shown percentage must survive')
})

test('validate: rejects an hour claim that exceeds the day total', () => {
  const facts = workingDayFacts()
  const parsed = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  parsed.lines.headline = 'You shipped 12 hours of deep development work today.'
  const result = validateWrappedNarrativeResponse(JSON.stringify(parsed), facts, 'h')
  assert.ok(result)
  assert.equal(result!.lines.headline, null)
})

test('validate: rejects carryover homework and grading, per line', () => {
  const facts = workingDayFacts()
  const parsed = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  parsed.lines.focus = 'The design review is still open, pick it up tomorrow morning.'
  parsed.lines.apps = 'Your drift stayed low through the whole afternoon session.'
  const result = validateWrappedNarrativeResponse(JSON.stringify(parsed), facts, 'h')
  assert.ok(result)
  assert.equal(result!.lines.focus, null)
  assert.equal(result!.lines.apps, null)
})

test('validate: the question must actually be a question', () => {
  const facts = workingDayFacts()
  const result = validateWrappedNarrativeResponse(
    deckResponse(facts, { question: 'Tell me about the best part of the day.' }),
    facts, 'h',
  )
  assert.ok(result)
  assert.equal(result!.question, null)
})

test('validate: a homework-shaped reflection is dropped', () => {
  const facts = workingDayFacts()
  const result = validateWrappedNarrativeResponse(
    deckResponse(facts, { reflection: 'A good day overall with real progress through the morning. The auth work moved and the review landed. Tomorrow you should pick it back up early and carry the momentum forward into the next block of work.' }),
    facts, 'h',
  )
  assert.ok(result)
  assert.equal(result!.reflection, null)
})

test('validate: rejects non-JSON garbage and truncated JSON', () => {
  const facts = workingDayFacts()
  assert.equal(validateWrappedNarrativeResponse('Sure! Here is the summary.', facts, 'h'), null)
  assert.equal(validateWrappedNarrativeResponse('{"lines": {"opening": "About two hours tracked', facts, 'h'), null)
})

test('validate: never writes a line for a slide the plan does not have', () => {
  const facts = workingDayFacts()
  const parsed = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  parsed.lines['made-up-slide'] = 'A line for a slide that does not exist in the plan.'
  const result = validateWrappedNarrativeResponse(JSON.stringify(parsed), facts, 'h')
  assert.ok(result)
  assert.equal('made-up-slide' in result!.lines, false)
})

// ─── buildFallbackNarrative ──────────────────────────────────────────────────

test('fallback: empty quality returns a modest lead and nothing else', () => {
  const result = buildFallbackNarrative(emptyFacts(), 'h')
  assert.equal(result.source, 'fallback')
  assert.deepEqual(result.lines, {})
  assert.equal(result.reflection, null)
  assert.match(result.lead, /not much tracked/i)
})

test('fallback: a working day has a lead, a question, and a reflection', () => {
  const result = buildFallbackNarrative(workingDayFacts(), 'h')
  assert.ok(result.lead)
  assert.ok(result.question, 'expected the deterministic question')
  assert.ok(result.reflection, 'expected the deterministic reflection')
})

test('fallback: never predicts tomorrow, assigns homework, or dashes', () => {
  const facts = workingDayFacts()
  const result = buildFallbackNarrative(facts, 'h')
  const everything = [result.lead, result.reflection, ...planDayWrapSlides(facts).map((s) => s.fallbackLine)]
  for (const line of everything) {
    if (!line) continue
    assert.doesNotMatch(line, /tomorrow|pick (it|this|that) up|needs? review|carry/i, `homework leaked: ${line}`)
    assert.doesNotMatch(line, /[—–]/, `dash leaked: ${line}`)
  }
})

// ─── computeFactsHash ────────────────────────────────────────────────────────

test('hash: identical facts produce identical hashes', () => {
  assert.equal(computeFactsHash(workingDayFacts()), computeFactsHash(workingDayFacts()))
})

test('hash: changing the date changes the hash', () => {
  const a = workingDayFacts()
  const b = { ...a, date: '2026-05-13' }
  assert.notEqual(computeFactsHash(a), computeFactsHash(b))
})

// Gaps/threads were added to the hash unconditionally, which silently changed
// EVERY stored day's hash — one AI regeneration per historical day. A day with
// no gap and no thread facts must keep hashing exactly as it did before the
// fields existed; the keys enter the canonical form only when non-empty.
test('hash: empty gaps/threads keep the pre-gaps canonical hash', () => {
  const facts = workingDayFacts()
  assert.deepEqual(facts.gaps ?? [], [], 'fixture day has no gap facts')
  assert.deepEqual(facts.threads ?? [], [], 'fixture day has no thread facts')

  // The canonical form as it was BEFORE gaps/threads existed, reconstructed
  // verbatim: same keys, same order, no gaps/threads entries.
  const bucket = (s: number) => Math.round(s / 60)
  const preGapsCanonical = JSON.stringify({
    date: facts.date,
    quality: facts.quality,
    active: bucket(facts.activeSeconds),
    work: bucket(facts.workSeconds),
    leisure: bucket(facts.leisureSeconds),
    personal: bucket(facts.personalSeconds),
    isLeisure: facts.isLeisureDay,
    activities: facts.workActivities.map((a) => [a.name.toLowerCase(), bucket(a.seconds)]),
    appSites: facts.appSites.map((s) => [s.name.toLowerCase(), bucket(s.seconds)]),
    standout: facts.standout ? [facts.standout.name.toLowerCase(), bucket(facts.standout.seconds)] : null,
    wildcard: facts.wildcardHook ? [facts.wildcardHook.kind, facts.wildcardHook.value] : null,
    story: facts.dayStory.map((seg) => [seg.part, seg.items.map((i) => i.toLowerCase()), bucket(seg.seconds)]),
    entities: (facts.entities ?? []).map((e) => [e.type, e.name.toLowerCase(), bucket(e.seconds)]),
    enrichment: null,
  })
  const preGapsHash = createHash('sha1').update(preGapsCanonical).digest('hex').slice(0, 12)
  assert.equal(computeFactsHash(facts), preGapsHash,
    'a day without gap/thread facts must hash identically to its pre-change stored hash')

  // Facts frozen before the fields existed (undefined) and facts built today
  // (empty arrays) are the same day.
  const frozen = { ...facts }
  delete frozen.gaps
  delete frozen.threads
  assert.equal(computeFactsHash(frozen), computeFactsHash({ ...facts, gaps: [], threads: [] }))
})

test('hash: a day genuinely gaining gap or thread facts re-hashes once', () => {
  const base = workingDayFacts()
  const withGap: DayWrapFacts = {
    ...base,
    gaps: [{
      fromMs: NINE_AM + 2 * 3600_000, toMs: NINE_AM + 3 * 3600_000,
      fromClock: '11:00am', toClock: '12:00pm', minutes: 60, kind: 'away', matchesEvent: null,
    }],
  }
  const withThread: DayWrapFacts = {
    ...base,
    threads: [{
      name: 'Daylens', blockCount: 3, seconds: 5400,
      firstMs: NINE_AM, lastMs: SIX_PM, fromClock: '9:00am', toClock: '6:00pm', category: 'development',
    }],
  }
  assert.notEqual(computeFactsHash(base), computeFactsHash(withGap), 'a gap fact reflows the wrap')
  assert.notEqual(computeFactsHash(base), computeFactsHash(withThread), 'a thread fact reflows the wrap')
})

// ─── buildWrappedPrompts ─────────────────────────────────────────────────────

test('prompt: requests the deck JSON and bans invention, emoji, grades', () => {
  const { systemPrompt } = buildWrappedPrompts(workingDayFacts())
  assert.match(systemPrompt, /STRICT JSON/)
  assert.match(systemPrompt, /"lines"/)
  assert.match(systemPrompt, /"question"/)
  assert.match(systemPrompt, /"reflection"/)
  assert.match(systemPrompt, /No emoji/)
  assert.match(systemPrompt, /Never invent a number/)
  assert.match(systemPrompt, /NAME THE WORK, NEVER THE FILE/)
  assert.match(systemPrompt, /NEVER predict tomorrow/)
  assert.match(systemPrompt, /NEVER grade/)
})

test('prompt: the user message lists every asked slide id with its facts', () => {
  const facts = workingDayFacts()
  const { userMessage } = buildWrappedPrompts(facts)
  assert.match(userMessage, /"date": "2026-05-12"/)
  for (const spec of planDayWrapSlides(facts)) {
    if (!spec.ask) continue
    assert.ok(userMessage.includes(`- "${spec.id}":`), `expected slide ${spec.id} in the prompt`)
  }
})

// ─── Clock-time grounding (the "started at midnight" bug) ─────────────────────

test('validate: a line claiming a clock time its slide never showed dies alone', () => {
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const story = slides.find((s) => s.id.startsWith('story-') && s.ask)
  assert.ok(story, 'expected a story slide')
  // The shipped failure: an 11am meeting narrated as "you started at midnight".
  const raw = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  raw.lines[story!.id] = 'You started at midnight on the meeting and kept going until 3:47am.'
  const result = validateWrappedNarrativeResponse(JSON.stringify(raw), facts, 'h')
  assert.ok(result)
  assert.equal(result!.lines[story!.id], null, 'the ungrounded midnight claim must die')
})

test('validate: a line quoting a clock time from its own slide facts survives', () => {
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const story = slides.find((s) => s.id.startsWith('story-') && s.ask)
  assert.ok(story)
  const match = story!.factsNote.match(/\b\d{1,2}(?::\d{2})?(?:am|pm)\b/i)
  assert.ok(match, `expected a clock time in the facts note: ${story!.factsNote}`)
  const raw = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  raw.lines[story!.id] = `You went straight in at ${match![0]} and stayed with it, no detours.`
  const result = validateWrappedNarrativeResponse(JSON.stringify(raw), facts, 'h')
  assert.ok(result)
  assert.equal(result!.lines[story!.id], raw.lines[story!.id], 'a grounded time must survive')
})

test('validate: a question or reflection with an ungrounded time is dropped', () => {
  const facts = workingDayFacts()
  const raw = JSON.parse(deckResponse(facts)) as Record<string, unknown>
  raw.question = 'What pulled you into work at midnight, and was that planned?'
  const result = validateWrappedNarrativeResponse(JSON.stringify(raw), facts, 'h')
  assert.ok(result)
  assert.equal(result!.question, null, 'the midnight question must die when no slide shows 12am')
})

// ─── Earned celebration (one emoji, at the end, from the set) ─────────────────

test('validate: one earned celebration emoji at the end of a line survives', () => {
  const facts = workingDayFacts()
  const raw = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  raw.lines.opening = 'A real building day, and you saw it through 🏆'
  const result = validateWrappedNarrativeResponse(JSON.stringify(raw), facts, 'h')
  assert.ok(result)
  assert.equal(result!.lead, 'A real building day, and you saw it through 🏆')
})

test('validate: emoji confetti still dies — multiple, mid-line, or off-set emoji', () => {
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const askable = slides.filter((s) => s.ask && s.id !== 'opening').map((s) => s.id)
  const raw = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  raw.lines[askable[0]] = 'Two wins today 🏆🔥 and both of them real.'
  raw.lines[askable[1]] = 'A 🚀 kind of day from the first hour onward.'
  const result = validateWrappedNarrativeResponse(JSON.stringify(raw), facts, 'h')
  assert.ok(result)
  assert.equal(result!.lines[askable[0]], null, 'two emoji must die')
  assert.equal(result!.lines[askable[1]], null, 'an off-set mid-line emoji must die')
})

// ─── Enrichment feeding the wrap ──────────────────────────────────────────────

import type { DayEnrichment } from '../src/shared/types.ts'
import { compactDayFacts } from '../src/main/lib/wrappedNarrative.ts'

function sampleEnrichment(): DayEnrichment {
  return {
    shipped: {
      commitsByProject: [{ project: 'billing service', commits: 9 }],
      highlights: ['add invoice export', 'fix the rate limiter'],
      pullRequests: [{ project: 'billing service', state: 'open', count: 1 }],
    },
    meetings: {
      count: 2,
      items: [
        { title: 'Design review', scheduled: '1h 15m', observed: '1h 4m', attendance: 'matched' as const, type: 'presentation' as const, confidence: 0.8 },
        { title: 'Standup', scheduled: '15m', observed: null, attendance: 'calendar_only' as const, type: 'team_meeting' as const, confidence: 0.9 },
      ],
      matched: 1,
      calendarOnly: 1,
      capturedOnly: 0,
    },
    focusSessions: null,
  }
}

test('enrichment: compactDayFacts includes shipped and meetings when present', () => {
  const facts = workingDayFacts()
  const compact = compactDayFacts(facts, sampleEnrichment()) as Record<string, unknown>
  assert.ok(compact.shipped, 'shipped rides along')
  assert.ok(compact.meetings, 'meetings ride along')
  assert.equal((compact.shipped as { commitsByProject: unknown[] }).commitsByProject.length, 1)
})

test('enrichment: compactDayFacts omits the keys entirely when absent', () => {
  const facts = workingDayFacts()
  const compact = compactDayFacts(facts, null) as Record<string, unknown>
  assert.ok(!('shipped' in compact), 'no shipped key when no enrichment')
  assert.ok(!('meetings' in compact), 'no meetings key when no enrichment')
  assert.ok(!('focusSessions' in compact))
})

test('enrichment: the prompt gains shipped/meetings directives and the facts JSON', () => {
  const facts = workingDayFacts()
  const withE = buildWrappedPrompts(facts, sampleEnrichment())
  assert.match(withE.systemPrompt, /shipped/i)
  assert.match(withE.systemPrompt, /commits to the billing service|shipped\.commitsByProject/i)
  assert.match(withE.userMessage, /"shipped"/)
  // The old "never state how many meetings" rule is replaced when calendar exists.
  assert.doesNotMatch(withE.systemPrompt, /Never state how MANY meetings/)
  // Without enrichment, that guard is back and no shipped directive appears.
  const without = buildWrappedPrompts(facts, null)
  assert.match(without.systemPrompt, /Never state how MANY meetings/)
  assert.doesNotMatch(without.userMessage, /"shipped"/)
})

test('enrichment: a real commit count survives, an invented one dies', () => {
  const facts = workingDayFacts()
  const enrichment = sampleEnrichment()
  const slides = planDayWrapSlides(facts)
  const askable = slides.filter((s) => s.ask && s.id !== 'opening').map((s) => s.id)

  const good = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  good.lines[askable[0]] = 'You wrote 9 commits to the billing service and opened a pull request.'
  const okResult = validateWrappedNarrativeResponse(JSON.stringify(good), facts, 'h', enrichment)
  assert.ok(okResult)
  assert.equal(okResult!.lines[askable[0]], 'You wrote 9 commits to the billing service and opened a pull request.')

  const bad = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  bad.lines[askable[1]] = 'You wrote 42 commits to the billing service today.'
  const badResult = validateWrappedNarrativeResponse(JSON.stringify(bad), facts, 'h', enrichment)
  assert.ok(badResult)
  assert.equal(badResult!.lines[askable[1]], null, 'an invented commit count must fall back')
})

test('enrichment: with no enrichment, any commit-count claim is treated as invented', () => {
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const askable = slides.filter((s) => s.ask && s.id !== 'opening').map((s) => s.id)
  const raw = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  raw.lines[askable[0]] = 'You pushed 5 commits before lunch.'
  const result = validateWrappedNarrativeResponse(JSON.stringify(raw), facts, 'h', null)
  assert.ok(result)
  assert.equal(result!.lines[askable[0]], null, 'an ungrounded commit count dies with no enrichment')
})

test('enrichment: a real meeting count does NOT authorize an invented commit count', () => {
  // meetings.count = 2 but there is NO shipped/commit enrichment.
  const enrichment: DayEnrichment = {
    shipped: null,
    meetings: {
      count: 2,
      items: [
        { title: 'Standup', scheduled: '15m', observed: null, attendance: 'calendar_only' as const, type: 'team_meeting' as const, confidence: 0.9 },
        { title: 'Review', scheduled: '45m', observed: null, attendance: 'calendar_only' as const, type: 'generic' as const, confidence: 0 },
      ],
      matched: 0,
      calendarOnly: 2,
      capturedOnly: 0,
    },
    focusSessions: null,
  }
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const askable = slides.filter((s) => s.ask && s.id !== 'opening').map((s) => s.id)
  const raw = JSON.parse(deckResponse(facts)) as { lines: Record<string, string> }
  raw.lines[askable[0]] = 'You had 2 meetings and pushed 2 commits before lunch.'
  const result = validateWrappedNarrativeResponse(JSON.stringify(raw), facts, 'h', enrichment)
  assert.ok(result)
  assert.equal(result!.lines[askable[0]], null, '"2 commits" must die even though "2 meetings" is real')
})

// ─── The repair round (verify + at most one repair call) ─────────────────────

import {
  buildWrappedRepairMessage,
  mergeWrapRepair,
  parseWrapResponse,
  validateWrappedNarrativeObject,
} from '../src/main/lib/wrappedNarrative.ts'

test('repair: a guard death is recorded with a reason that names the offending value', () => {
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const victim = slides.filter((s) => s.ask && s.id !== 'opening').map((s) => s.id)[0]
  const raw = JSON.parse(deckResponse(facts)) as Record<string, unknown>
  ;(raw.lines as Record<string, string>)[victim] = 'The push started at 7:43am and did not let go until well after.'
  const { narrative, rejections } = validateWrappedNarrativeObject(raw, facts, 'h', null)
  assert.ok(narrative, 'the deck survives; only the poisoned slide dies')
  assert.equal(narrative!.lines[victim], null)
  const rejection = rejections.find((r) => r.id === victim)
  assert.ok(rejection, 'the death must be recorded')
  assert.match(rejection!.reason, /7:43am/, 'the reason names the ungrounded clock token')
  assert.equal(rejection!.candidate, (raw.lines as Record<string, string>)[victim])
})

test('repair: a missing question and reflection are rejections the repair round can fix', () => {
  const facts = workingDayFacts()
  const raw = JSON.parse(deckResponse(facts)) as Record<string, unknown>
  delete raw.question
  delete raw.reflection
  const { narrative, rejections } = validateWrappedNarrativeObject(raw, facts, 'h', null)
  assert.ok(narrative)
  assert.equal(narrative!.question, null)
  assert.ok(rejections.some((r) => r.id === 'question'))
  assert.ok(rejections.some((r) => r.id === 'reflection'))
})

test('repair: the repair message carries the ask, the rejected line, and the reason', () => {
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const victim = slides.filter((s) => s.ask && s.id !== 'opening').map((s) => s.id)[0]
  const spec = slides.find((s) => s.id === victim)!
  const raw = JSON.parse(deckResponse(facts)) as Record<string, unknown>
  ;(raw.lines as Record<string, string>)[victim] = 'The push started at 7:43am and did not let go until well after.'
  const { rejections } = validateWrappedNarrativeObject(raw, facts, 'h', null)
  const message = buildWrappedRepairMessage(facts, rejections.filter((r) => r.id === victim))
  assert.ok(message.includes(`"${victim}"`), 'names the slide id')
  assert.ok(message.includes(spec.factsNote), 'repeats the slide facts')
  assert.ok(message.includes('7:43am'), 'quotes the rejected line')
  assert.ok(message.includes('rejected because'), 'explains the violation')
  assert.ok(message.includes('Rewrite ONLY'), 'restricts the rewrite to the failed pieces')
})

test('repair: the merge takes rewrites for rejected ids only, never an accepted line', () => {
  const facts = workingDayFacts()
  const slides = planDayWrapSlides(facts)
  const victim = slides.filter((s) => s.ask && s.id !== 'opening').map((s) => s.id)[0]
  const raw = JSON.parse(deckResponse(facts)) as Record<string, unknown>
  const originalOpening = (raw.lines as Record<string, string>).opening
  ;(raw.lines as Record<string, string>)[victim] = 'The push started at 7:43am and did not let go until well after.'
  const { rejections } = validateWrappedNarrativeObject(raw, facts, 'h', null)
  const repair = JSON.stringify({ lines: {
    [victim]: 'A steady, honest stretch of the day, told without a clock.',
    opening: 'A sneaky overwrite of an accepted line.',
  } })
  const merged = mergeWrapRepair(raw, repair, rejections)
  const second = validateWrappedNarrativeObject(merged, facts, 'h', null)
  assert.ok(second.narrative)
  assert.equal(second.narrative!.lines[victim], 'A steady, honest stretch of the day, told without a clock.')
  assert.equal(second.narrative!.lines.opening, originalOpening, 'the accepted opening is final')
  assert.ok(!second.rejections.some((r) => r.id === victim), 'the repaired slide no longer rejects')
})

test('repair: a dead opening can be repaired into a live narrative', () => {
  const facts = workingDayFacts()
  const raw = JSON.parse(deckResponse(facts)) as Record<string, unknown>
  ;(raw.lines as Record<string, string>).opening = 'Should you dive into it again? A grade of 87% focus.'
  const first = validateWrappedNarrativeObject(raw, facts, 'h', null)
  assert.equal(first.narrative, null, 'a dead opening fails the deck')
  assert.ok(first.rejections.some((r) => r.id === 'opening'))
  const repair = JSON.stringify({ lines: { opening: 'A steady one, mostly heads-down on the auth work.' } })
  const merged = mergeWrapRepair(raw, repair, first.rejections)
  const second = validateWrappedNarrativeObject(merged, facts, 'h', null)
  assert.ok(second.narrative, 'the repaired opening revives the deck')
  assert.equal(second.narrative!.lead, 'A steady one, mostly heads-down on the auth work.')
})

test('repair: an unparseable repair response leaves the original result intact', () => {
  const facts = workingDayFacts()
  const raw = JSON.parse(deckResponse(facts)) as Record<string, unknown>
  const { rejections } = validateWrappedNarrativeObject(raw, facts, 'h', null)
  const merged = mergeWrapRepair(raw, 'not json at all', rejections)
  assert.deepEqual(merged, raw)
  assert.equal(parseWrapResponse('not json at all'), null)
})

// ─── Gap + thread facts reach the model (day-recap-and-analysis.md) ──────────

test('compactDayFacts carries gaps and day threads so the prose can tell the truth', () => {
  const hour = 3_600_000
  const blocks = [
    makeBlock({ label: 'Daylens development', start: NINE_AM, durationSeconds: 50 * 60 }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 2 * hour, durationSeconds: 50 * 60 }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 4 * hour, durationSeconds: 50 * 60 }),
  ]
  const gapStart = NINE_AM + 8 * hour  // 5pm
  const gapEnd = NINE_AM + 12 * hour   // 9pm
  const payload = {
    ...makeDayPayload(blocks),
    segments: [
      { kind: 'untracked' as const, startTime: gapStart, endTime: gapEnd, label: 'No data captured', source: 'derived_gap' as const },
    ],
  }
  const facts = buildDayWrapFacts(payload)
  assert.equal(facts.gaps.length, 1)
  assert.equal(facts.threads.length, 1)

  const compact = compactDayFacts(facts, null) as Record<string, unknown>
  const away = compact.awayFromScreen as Array<Record<string, string>>
  assert.ok(Array.isArray(away) && away.length === 1, 'awayFromScreen missing from compact facts')
  assert.equal(away[0].from, '5pm')
  assert.equal(away[0].to, '9pm')
  assert.equal(away[0].for, '4h')
  const threads = compact.dayThreads as Array<Record<string, string>>
  assert.ok(Array.isArray(threads) && threads.length === 1, 'dayThreads missing from compact facts')
  assert.match(threads[0].thread.toLowerCase(), /daylens/)
  assert.equal(threads[0].returnedToIn, '3 separate blocks')

  // The facts hash reflows when a gap or thread appears — a wrap frozen
  // before the hole existed regenerates once on a later-day open.
  const bare = buildDayWrapFacts(makeDayPayload(blocks.slice(0, 1)))
  assert.notEqual(computeFactsHash(facts, null), computeFactsHash(bare, null))
})
