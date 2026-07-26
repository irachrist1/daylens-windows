import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planDayWrapSlides,
  planPeriodWrapSlides,
  periodWrapDeckMeta,
  resolveSlideLine,
} from '../src/renderer/lib/wrapDeck.ts'
import { buildDayWrapFacts } from '../src/renderer/lib/dayWrapScenes.ts'
import type { AppCategory, DayTimelinePayload, WorkContextBlock, WrappedPeriodFacts } from '../src/shared/types.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'

// The deck planner is THE contract between the facts, the AI prompt, and the
// renderer: same plan on both sides, every number a facts number. These tests
// drive it with realistic data — a real working day, a real full week — and
// pin the required bar: a full week yields at least 20 slides, no slide ever
// appears without the data to back it, and every deck ends with the question,
// the reflection, and the finale.

// ─── Day fixture ──────────────────────────────────────────────────────────────

function makeBlock(opts: { label: string; start: number; durationSeconds: number; category?: AppCategory; appName?: string }): WorkContextBlock {
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
    label: { current: opts.label, source: 'rule', confidence: 0.92, narrative: null, ruleBased: opts.label, aiSuggested: null, override: null },
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
    date: '2026-05-12', sessions: [], websites: [], blocks, segments: [], focusSessions: [],
    computedAt: Date.now(), version: 'test', totalSeconds: total, focusSeconds: total, focusPct: 100, appCount: 0, siteCount: 0,
  }
}

const at = (time: string) => new Date(`2026-05-12T${time}:00`).getTime()

function fullDayFacts() {
  return buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: at('09:00'), durationSeconds: 150 * 60, category: 'development', appName: 'Cursor' }),
    makeBlock({ label: 'Design review', start: at('13:00'), durationSeconds: 60 * 60, category: 'design', appName: 'Figma' }),
    makeBlock({ label: 'Standup notes', start: at('15:00'), durationSeconds: 25 * 60, category: 'writing', appName: 'Notion' }),
    makeBlock({ label: 'Team sync', start: at('16:00'), durationSeconds: 45 * 60, category: 'meetings', appName: 'Zoom' }),
    makeBlock({ label: 'YouTube', start: at('22:30'), durationSeconds: 40 * 60, category: 'entertainment', appName: 'YouTube' }),
  ]))
}

// ─── Week fixture (a real, full week) ────────────────────────────────────────

const WEEK_DAYS = [
  { dateStr: '2026-06-22', dayLabel: 'Monday', totalSeconds: 6 * 3600, workSeconds: 5 * 3600, leisureSeconds: 3600 },
  { dateStr: '2026-06-23', dayLabel: 'Tuesday', totalSeconds: 8 * 3600, workSeconds: 7 * 3600, leisureSeconds: 3600 },
  { dateStr: '2026-06-24', dayLabel: 'Wednesday', totalSeconds: 5 * 3600, workSeconds: 4 * 3600, leisureSeconds: 3600 },
  { dateStr: '2026-06-25', dayLabel: 'Thursday', totalSeconds: 7 * 3600, workSeconds: 6 * 3600, leisureSeconds: 3600 },
  { dateStr: '2026-06-26', dayLabel: 'Friday', totalSeconds: 4 * 3600, workSeconds: 3 * 3600, leisureSeconds: 3600 },
  { dateStr: '2026-06-27', dayLabel: 'Saturday', totalSeconds: 2 * 3600, workSeconds: 3600, leisureSeconds: 3600 },
]

function fullWeekFacts(): WrappedPeriodFacts {
  const totalSeconds = WEEK_DAYS.reduce((s, d) => s + d.totalSeconds, 0)
  const workSeconds = WEEK_DAYS.reduce((s, d) => s + d.workSeconds, 0)
  const leisureSeconds = WEEK_DAYS.reduce((s, d) => s + d.leisureSeconds, 0)
  return {
    period: 'week',
    anchorDate: '2026-06-24',
    rangeLabel: 'Jun 22 – Jun 28',
    totalSeconds,
    workSeconds,
    leisureSeconds,
    personalSeconds: 0,
    previousPeriodSeconds: totalSeconds - 6 * 3600,
    daysWithActivity: WEEK_DAYS.length,
    dominantWorkCategory: 'development',
    dominantWorkCategoryPct: 62,
    categories: [
      { category: 'development', seconds: 16 * 3600 },
      { category: 'design', seconds: 4 * 3600 },
      { category: 'meetings', seconds: 3 * 3600 },
      { category: 'writing', seconds: 2 * 3600 },
    ],
    topApps: [
      { appName: 'Cursor', seconds: 14 * 3600 },
      { appName: 'Figma', seconds: 4 * 3600 },
      { appName: 'Zoom', seconds: 3 * 3600 },
      { appName: 'Notion', seconds: 2 * 3600 },
      { appName: 'Linear', seconds: 45 * 60 },
    ],
    threads: [
      { subject: 'The timeline rework', seconds: 12 * 3600, daysActive: 4 },
      { subject: 'The onboarding polish', seconds: 6 * 3600, daysActive: 3 },
      { subject: 'Support articles', seconds: 3 * 3600, daysActive: 2 },
    ],
    leisureSurfaces: ['YouTube', 'Netflix'],
    busiestDay: { dateStr: '2026-06-23', dayLabel: 'Tuesday', totalSeconds: 8 * 3600 },
    quietestActiveDay: { dateStr: '2026-06-27', dayLabel: 'Saturday', totalSeconds: 2 * 3600 },
    longestStretch: { dateStr: '2026-06-23', dayLabel: 'Tuesday', seconds: 152 * 60, label: 'The timeline rework', startClock: '9:04am' },
    buckets: WEEK_DAYS.map((d) => ({ label: d.dayLabel.slice(0, 3), totalSeconds: d.totalSeconds, dominantWorkCategory: 'development' as const })),
    busiestBucket: { label: 'Tue', totalSeconds: 8 * 3600 },
    days: WEEK_DAYS,
    meetingsSeconds: 3 * 3600,
    dayEdges: [
      { dateStr: '2026-06-22', dayLabel: 'Monday', firstClock: '8:41am', lastClock: '6:10pm', firstHour: 8, lastHour: 18 },
      { dateStr: '2026-06-23', dayLabel: 'Tuesday', firstClock: '6:12am', lastClock: '11:48pm', firstHour: 6, lastHour: 23 },
      { dateStr: '2026-06-24', dayLabel: 'Wednesday', firstClock: '9:02am', lastClock: '11:31pm', firstHour: 9, lastHour: 23 },
      { dateStr: '2026-06-25', dayLabel: 'Thursday', firstClock: '8:55am', lastClock: '7:20pm', firstHour: 8, lastHour: 19 },
    ],
  }
}

// ─── Day plan ─────────────────────────────────────────────────────────────────

test('day plan: a full day yields the whole arc with unique ids', () => {
  const slides = planDayWrapSlides(fullDayFacts())
  const ids = slides.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'slide ids must be unique')
  for (const required of ['opening', 'headline', 'focus', 'apps', 'question', 'reflection', 'finale']) {
    assert.ok(ids.includes(required), `expected slide ${required}, got: ${ids.join(', ')}`)
  }
  assert.ok(ids.includes('story-morning'), 'expected the morning story beat')
  assert.equal(ids[ids.length - 1], 'finale', 'the finale closes the deck')
})

test('day plan: every duration on a slide is a facts number', () => {
  const facts = fullDayFacts()
  const slides = planDayWrapSlides(facts)
  for (const spec of slides) {
    if (spec.stat?.seconds != null) {
      assert.ok(spec.stat.seconds <= facts.activeSeconds, `${spec.id} claims more than the day total`)
    }
    for (const bar of spec.bars ?? []) {
      assert.ok(bar.seconds <= facts.activeSeconds, `${spec.id} bar exceeds the day total`)
    }
  }
})

test('day plan: the split percentages come from the real ratio and sum to 100', () => {
  const slides = planDayWrapSlides(fullDayFacts())
  const split = slides.find((s) => s.id === 'split')
  assert.ok(split?.split, 'a day with work and leisure gets the split slide')
  assert.equal(split!.split!.aPct + split!.split!.bPct, 100)
})

// The away card must not contradict itself: a 'passive' gap is screen ON,
// hands off, so it can never be headlined "Off the screen". The card picks the
// biggest gap that really was time away; a day whose only gaps are passive
// gets the passive card with an honest kicker.
test('day plan: the away slide never headlines a passive gap as "Off the screen"', () => {
  const gap = (fromH: number, toH: number, kind: 'passive' | 'away') => ({
    fromMs: at(`${String(fromH).padStart(2, '0')}:00`),
    toMs: at(`${String(toH).padStart(2, '0')}:00`),
    fromClock: `${((fromH + 11) % 12) + 1}:00${fromH < 12 ? 'am' : 'pm'}`,
    toClock: `${((toH + 11) % 12) + 1}:00${toH < 12 ? 'am' : 'pm'}`,
    minutes: (toH - fromH) * 60, kind, matchesEvent: null,
  })

  // A big passive gap next to a smaller real absence: the real absence leads.
  const mixed = { ...fullDayFacts(), gaps: [gap(10, 12, 'passive'), gap(13, 14, 'away')] }
  const awaySlide = planDayWrapSlides(mixed).find((s) => s.id === 'away')
  assert.ok(awaySlide, 'expected the away slide')
  assert.equal(awaySlide!.kicker, 'Off the screen')
  assert.match(awaySlide!.fallbackLine, /1:00pm to 2:00pm/, 'the non-passive gap leads the card')
  assert.doesNotMatch(awaySlide!.fallbackLine, /screen on/i)

  // Only passive gaps: the card stays, honestly titled.
  const passiveOnly = { ...fullDayFacts(), gaps: [gap(10, 12, 'passive')] }
  const passiveSlide = planDayWrapSlides(passiveOnly).find((s) => s.id === 'away')
  assert.ok(passiveSlide, 'a passive-only day still gets the card')
  assert.notEqual(passiveSlide!.kicker, 'Off the screen', 'a passive gap is not off the screen')
  assert.match(passiveSlide!.fallbackLine, /screen on, hands off/i, 'the phrase says what it was')
})

test('day plan: a late-running day gets the late-night slide with the real clock', () => {
  const facts = fullDayFacts() // last block ends past 11pm
  const slides = planDayWrapSlides(facts)
  const late = slides.find((s) => s.id === 'latenight')
  assert.ok(late, 'expected the late-night slide')
  assert.equal(late!.stat?.value, facts.ribbonEndClock)
})

test('day plan: meetings slide appears only with real meeting time', () => {
  const withMeetings = planDayWrapSlides(fullDayFacts())
  assert.ok(withMeetings.some((s) => s.id === 'meetings'), 'expected meetings slide (45m tracked)')

  const noMeetings = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: at('09:00'), durationSeconds: 150 * 60 }),
  ]))
  assert.ok(!planDayWrapSlides(noMeetings).some((s) => s.id === 'meetings'), 'no meetings, no slide')
})

test('day plan: an empty day yields no padded slides', () => {
  const facts = buildDayWrapFacts(makeDayPayload([]))
  const slides = planDayWrapSlides(facts)
  // Opening/headline/question/reflection/finale skeleton only — nothing data-backed.
  assert.ok(!slides.some((s) => ['focus', 'timesink', 'apps', 'split', 'forgotten', 'meetings', 'wildcard'].includes(s.id)))
})

// ─── Week plan ────────────────────────────────────────────────────────────────

test('week plan: a real full week yields at least 20 slides', () => {
  const slides = planPeriodWrapSlides(fullWeekFacts())
  assert.ok(slides.length >= 20, `expected >= 20 slides for a full week, got ${slides.length}: ${slides.map((s) => s.id).join(', ')}`)
})

test('week plan covers the required sink, ratio, comparison, meeting, edge, question, and reflection slides', () => {
  const ids = planPeriodWrapSlides(fullWeekFacts()).map((s) => s.id)
  for (const required of [
    'opening', 'headline', 'shape', 'bestday', 'worstday', 'focus', 'timesink', 'split',
    'compare', 'meetings', 'forgotten', 'latenights', 'earlystarts', 'question', 'reflection', 'finale',
  ]) {
    assert.ok(ids.includes(required), `expected slide ${required}, got: ${ids.join(', ')}`)
  }
})

test('week plan: ids are unique and the finale closes the deck', () => {
  const slides = planPeriodWrapSlides(fullWeekFacts())
  const ids = slides.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids[ids.length - 1], 'finale')
  assert.equal(ids[ids.length - 2], 'reflection')
})

test('week plan: the focus slide names the real stretch, day, and start clock', () => {
  const facts = fullWeekFacts()
  const focus = planPeriodWrapSlides(facts).find((s) => s.id === 'focus')
  assert.ok(focus?.stat)
  assert.equal(focus!.stat!.seconds, facts.longestStretch!.seconds)
  assert.match(focus!.stat!.sublabel ?? '', /Tuesday/)
  assert.match(focus!.stat!.sublabel ?? '', /9:04am/)
})

test('week plan: a thin week never pads — data-less slides are absent', () => {
  const thin: WrappedPeriodFacts = {
    ...fullWeekFacts(),
    daysWithActivity: 2,
    days: WEEK_DAYS.slice(0, 2),
    meetingsSeconds: 0,
    dayEdges: [],
    previousPeriodSeconds: 0,
    leisureSurfaces: [],
    leisureSeconds: 0,
    threads: [],
    topApps: [{ appName: 'Cursor', seconds: 4 * 3600 }],
    categories: [{ category: 'development', seconds: 4 * 3600 }],
    quietestActiveDay: null,
    longestStretch: null,
  }
  const ids = planPeriodWrapSlides(thin).map((s) => s.id)
  for (const absent of ['meetings', 'latenights', 'earlystarts', 'compare', 'leisure', 'split', 'focus', 'worstday', 'threads', 'forgotten']) {
    assert.ok(!ids.includes(absent), `thin week must not include ${absent}`)
  }
  // The skeleton still ends properly.
  assert.ok(ids.includes('question') && ids.includes('reflection') && ids.includes('finale'))
})

test('week plan: raw artifact labels never become a thread slide', () => {
  const facts = {
    ...fullWeekFacts(),
    threads: [
      { subject: 'src/main/services/tracking.ts', seconds: 10 * 3600, daysActive: 4 },
      { subject: 'The onboarding polish', seconds: 6 * 3600, daysActive: 3 },
    ],
  }
  const slides = planPeriodWrapSlides(facts)
  const threadSlides = slides.filter((s) => s.id.startsWith('thread-'))
  assert.ok(threadSlides.every((s) => !s.stat?.sublabel?.includes('tracking.ts')), 'raw label leaked into a slide')
})

test('meta: the deck meta headline is the facts total', () => {
  const facts = fullWeekFacts()
  const meta = periodWrapDeckMeta(facts)
  assert.match(meta.headline, /^\d+h/)
  assert.equal(meta.title, 'Your week, wrapped')
})

// ─── resolveSlideLine ─────────────────────────────────────────────────────────

test('resolveSlideLine: prefers the AI line, falls back per slide', () => {
  const slides = planPeriodWrapSlides(fullWeekFacts())
  const opening = slides.find((s) => s.id === 'opening')!
  assert.equal(resolveSlideLine(opening, { opening: 'A week that belonged to the rework.' }), 'A week that belonged to the rework.')
  assert.equal(resolveSlideLine(opening, { opening: null }), opening.fallbackLine)
  assert.equal(resolveSlideLine(opening, {}), opening.fallbackLine)
  assert.equal(resolveSlideLine(opening, { opening: '   ' }), opening.fallbackLine)
})

// ─── Spontaneity: the seeded middle shuffle ───────────────────────────────────

test('day plan: two different dates deal the middle slides in different orders', () => {
  const dayA = fullDayFacts()
  const payloadB = makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: new Date('2026-05-13T09:00:00').getTime(), durationSeconds: 150 * 60, category: 'development', appName: 'Cursor' }),
    makeBlock({ label: 'Design review', start: new Date('2026-05-13T13:00:00').getTime(), durationSeconds: 60 * 60, category: 'design', appName: 'Figma' }),
    makeBlock({ label: 'Standup notes', start: new Date('2026-05-13T15:00:00').getTime(), durationSeconds: 25 * 60, category: 'writing', appName: 'Notion' }),
    makeBlock({ label: 'Team sync', start: new Date('2026-05-13T16:00:00').getTime(), durationSeconds: 45 * 60, category: 'meetings', appName: 'Zoom' }),
    makeBlock({ label: 'YouTube', start: new Date('2026-05-13T22:30:00').getTime(), durationSeconds: 40 * 60, category: 'entertainment', appName: 'YouTube' }),
  ])
  const dayB = buildDayWrapFacts({ ...payloadB, date: '2026-05-13' })
  const idsA = planDayWrapSlides(dayA).map((s) => s.id)
  const idsB = planDayWrapSlides(dayB).map((s) => s.id)
  assert.deepEqual([...idsA].sort(), [...idsB].sort(), 'same data must yield the same slides')
  assert.notDeepEqual(idsA, idsB, 'adjacent days must not deal the identical order')
  // Reopening the same day is identical — the wrap is stable.
  assert.deepEqual(idsA, planDayWrapSlides(fullDayFacts()).map((s) => s.id))
})

test('day plan: the spine holds — opening and headline first, question, reflection, finale last', () => {
  const ids = planDayWrapSlides(fullDayFacts()).map((s) => s.id)
  assert.equal(ids[0], 'opening')
  assert.equal(ids[1], 'headline')
  assert.deepEqual(ids.slice(-3), ['question', 'reflection', 'finale'])
  // Story beats stay chronological relative to each other.
  const storyIdx = ids.filter((id) => id.startsWith('story-'))
  const expected = ['story-lateNight', 'story-morning', 'story-midday', 'story-evening'].filter((id) => storyIdx.includes(id))
  assert.deepEqual(storyIdx, expected, 'story beats must stay in day order')
})

test('week plan: the shuffled middle keeps the spine and stays stable per anchor', () => {
  const a = planPeriodWrapSlides(fullWeekFacts()).map((s) => s.id)
  const b = planPeriodWrapSlides(fullWeekFacts()).map((s) => s.id)
  assert.deepEqual(a, b, 'same week must be identical on reopen')
  assert.equal(a[0], 'opening')
  assert.equal(a[1], 'headline')
  assert.deepEqual(a.slice(-3), ['question', 'reflection', 'finale'])
})

// ─── Spillover: last night's tail never frames the day ────────────────────────

test('day plan: a short after-midnight tail is framed as last night, and the headline starts the day at the real beat', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Late fixes', start: at('00:02'), durationSeconds: 25 * 60, category: 'development', appName: 'Cursor' }),
    makeBlock({ label: 'Auth refactor', start: at('11:15'), durationSeconds: 150 * 60, category: 'development', appName: 'Cursor' }),
  ]))
  const slides = planDayWrapSlides(facts)
  const headline = slides.find((s) => s.id === 'headline')!
  assert.ok(headline.stat?.sublabel?.startsWith('11:15am'), `the day proper starts 11:15am, got: ${headline.stat?.sublabel}`)
  assert.match(headline.factsNote, /LAST night/, 'the prompt facts must explain the spillover')
  const tail = slides.find((s) => s.id === 'story-lateNight')
  assert.ok(tail, 'the tail still gets its beat')
  assert.match(tail!.kicker, /Last night's tail/)
  assert.match(tail!.ask, /TAIL OF THE PREVIOUS NIGHT/)
})
