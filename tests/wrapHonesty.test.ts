// The evidence-honesty contract (docs/product/product.md, evidence-before-narrative): a wrap says only what
// was observed. These tests pin the deterministic guards — shared by the runtime
// validator AND the benchmark — and the coverage slide that makes every wrap
// name what it saw and what it didn't.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findOverclaimViolation,
  findRawArtifactLeak,
  wrapLineViolation,
  type LineGuardContext,
} from '../src/main/lib/wrapNarrativeShared.ts'
import { planDayWrapSlides, planPeriodWrapSlides } from '../src/renderer/lib/wrapDeck.ts'
import type { DayWrapFacts } from '../src/renderer/lib/dayWrapScenes.ts'
import type { WrappedPeriodFacts } from '../src/shared/types.ts'

// ─── Overclaim guard ──────────────────────────────────────────────────────────

test('overclaim guard kills attendance claims built on calendar evidence', () => {
  assert.ok(findOverclaimViolation('You attended the design review before lunch.'))
  assert.ok(findOverclaimViolation('You sat through a calendar full of meetings.'))
  assert.ok(findOverclaimViolation('You went to the 1:1 at midday.'))
  assert.ok(findOverclaimViolation('You showed up for the standup.'))
})

test('overclaim guard kills idle / off-task characterizations of unobserved time', () => {
  assert.ok(findOverclaimViolation('The afternoon was mostly idle.'))
  assert.ok(findOverclaimViolation('An hour went off task after lunch.'))
  assert.ok(findOverclaimViolation('Some off-task browsing crept in.'))
})

test('overclaim guard kills speculation words', () => {
  assert.ok(findOverclaimViolation('You probably kept working after the laptop closed.'))
  assert.ok(findOverclaimViolation('That break must have been lunch.'))
  assert.ok(findOverclaimViolation('Likely a walk, given the gap.'))
})

test('overclaim guard passes honest observed phrasing', () => {
  assert.equal(findOverclaimViolation('Your calendar had the design review at midday.'), null)
  assert.equal(findOverclaimViolation('Cursor was in front for 2h 14m this morning.'), null)
  assert.equal(findOverclaimViolation('The morning never reached this screen, so the story starts at 12:08pm.'), null)
  assert.equal(findOverclaimViolation('The 1:1 sat on the calendar and the afternoon built around it.'), null)
})

// The product never narrates in its own name — the exact failure the paid
// benchmark caught on thin days, where the old honesty directive induced
// "Daylens only saw ..." and the judge capped tone.

test('overclaim guard kills the product speaking as the narrator', () => {
  assert.ok(findOverclaimViolation('Daylens only saw 23 minutes of screen activity today.'))
  assert.ok(findOverclaimViolation('That was the whole of what Daylens saw today.'))
  assert.ok(findOverclaimViolation("Daylens didn't see the afternoon at all."))
  assert.ok(findOverclaimViolation('Daylens tracked a short window this morning.'))
})

test('Daylens as the thing worked on stays legal', () => {
  assert.equal(findOverclaimViolation('The evening went entirely to Daylens, one long run.'), null)
  assert.equal(findOverclaimViolation('Nine commits to Daylens by the end of the night.'), null)
  assert.equal(findOverclaimViolation('The Daylens work carried the whole afternoon.'), null)
})

test('overclaim guard kills continuity absolutes; the run itself stays legal', () => {
  // The longest-stretch fact is measured with tolerances; swearing nothing
  // else happened inside it is the shape-judge failure that capped real days.
  assert.ok(findOverclaimViolation('One long unbroken run on the timeline engine.'))
  assert.ok(findOverclaimViolation('Nothing broke it, 4:01pm to 10:01pm.'))
  assert.ok(findOverclaimViolation('Two hours straight through, uninterrupted.'))
  assert.ok(findOverclaimViolation('You worked without a break from lunch to dinner.'))
  assert.ok(findOverclaimViolation('Nothing interrupted the afternoon build.'))
  assert.equal(findOverclaimViolation('The longest run of the day, 1h 42m on the timeline engine.'), null)
  assert.equal(findOverclaimViolation('One stretch carried the afternoon.'), null)
})

// ─── Raw-artifact leak guard ──────────────────────────────────────────────────

test('raw-artifact guard kills paths, branches, files, ids, and JSON', () => {
  assert.ok(findRawArtifactLeak('Most of it went to src/main/services/tracking.ts today.'))
  assert.ok(findRawArtifactLeak('You merged feat/wrapped-honesty before dinner.'))
  assert.ok(findRawArtifactLeak('The morning lived in MLPipeline_Week2.ipynb.'))
  assert.ok(findRawArtifactLeak('Commit 8a1e115f9c2d landed after lunch.'))
  assert.ok(findRawArtifactLeak('The response was {"lines": "..."} again.'))
})

test('raw-artifact guard passes ordinary prose, including slashes people write', () => {
  assert.equal(findRawArtifactLeak('Two and a half hours on the billing service, unbroken.'), null)
  assert.equal(findRawArtifactLeak('A back and/or forth kind of afternoon.'), null)
  assert.equal(findRawArtifactLeak('It ran close to 24/7 energy until the evening.'), null)
  assert.equal(findRawArtifactLeak('Nine commits to the billing service by 6pm.'), null)
})

// ─── Runtime integration: the line validator uses the same rules ─────────────

const ctx: LineGuardContext = {
  totalHours: 8,
  hourTolerance: 1.05,
  allowedPercents: new Set(),
  allowedTimes: new Set(['9am', '6pm']),
}

test('wrapLineViolation rejects attendance and leak lines with writer-facing reasons', () => {
  const attendance = wrapLineViolation('You attended the design review and kept building after.', ctx)
  assert.ok(attendance && /attendance/.test(attendance))
  const leak = wrapLineViolation('The work lived in src/main/services/tracking.ts most of the day.', ctx)
  assert.ok(leak && /raw technical text/.test(leak))
})

test('wrapLineViolation passes an honest calendar-anchored line', () => {
  assert.equal(wrapLineViolation('Your calendar held the design review, and the code got the rest of the morning from 9am.', ctx), null)
})

// ─── Time-of-day words ────────────────────────────────────────────────────────
// No time word is banned and none is forced; the only rule is accuracy. "noon"
// and "midnight" are precise clock claims (12pm / 12am) and must ground in the
// slide's own facts like any clock time; "midday" / "morning" / "the evening"
// are part-of-day words and free prose.

test('noon and midnight are clock claims that must ground in the slide facts', () => {
  assert.ok(wrapLineViolation('You were still at it at midnight.', ctx))
  assert.ok(wrapLineViolation('The close tied out by noon.', ctx))
  assert.equal(
    wrapLineViolation('The close tied out by noon.', { ...ctx, allowedTimes: new Set(['12pm']) }),
    null,
  )
  assert.equal(
    wrapLineViolation('You were still at it at midnight.', { ...ctx, allowedTimes: new Set(['12am']) }),
    null,
  )
})

test('midday and other part-of-day words are free prose, never clock tokens', () => {
  assert.equal(wrapLineViolation('The 1:1 sat on the calendar at midday and the afternoon built around it.', ctx), null)
  assert.equal(wrapLineViolation('The morning carried the close and the evening stayed quiet.', ctx), null)
})

test('wrapLineViolation allows factual distraction language but rejects blame and personal judgment', () => {
  assert.equal(
    wrapLineViolation('YouTube was the main distraction surface, and it sat in the evening where it belonged.', ctx),
    null,
  )
  assert.ok(wrapLineViolation('Distractions derailed the afternoon after the morning engine work.', ctx))
  assert.ok(wrapLineViolation('You got distracted and lost the afternoon to YouTube.', ctx))
  const drift = wrapLineViolation('The afternoon was just drift after the morning engine work.', ctx)
  assert.ok(drift && /drift/.test(drift))
  const score = wrapLineViolation('Your focus score landed well above the rest of the week.', ctx)
  assert.ok(score && /focus score/.test(score))
})

// ─── Coverage slide ───────────────────────────────────────────────────────────

function dayFacts(overrides: Partial<DayWrapFacts> = {}): DayWrapFacts {
  return {
    date: '2026-07-07', weekday: 'TUESDAY', dateLabel: 'JUL 7',
    workSeconds: 4 * 3600, leisureSeconds: 3600, personalSeconds: 0, meetingsSeconds: 0,
    activeSeconds: 5 * 3600,
    workActivities: [{ name: 'Daylens', seconds: 4 * 3600, category: 'development', kind: 'work' }],
    ribbon: [], ribbonStartClock: '9:12am', ribbonEndClock: '6:04pm',
    standout: null, topLeisure: [], isLeisureDay: false, quality: 'full',
    seed: 7, appSites: [], candidateHooks: [], wildcardHook: null,
    dayStory: [], mainStartClock: '9:12am', titleContext: [],
    ...overrides,
  }
}

test('every day deck carries a deterministic coverage slide right after the headline', () => {
  const slides = planDayWrapSlides(dayFacts())
  assert.equal(slides[2].id, 'coverage')
  assert.equal(slides[2].ask, '', 'the coverage slide must never be AI-written')
  assert.match(slides[2].fallbackLine, /9:12am to 6:04pm on this computer/)
  assert.match(slides[2].fallbackLine, /didn't observe isn't in the story/)
})

test('coverage slide names sources honestly: present, absent, and unknown', () => {
  const withSources = planDayWrapSlides(dayFacts(), {
    browser: true,
    connectors: { calendar: true, git: false, focus: false, notes: false },
  })[2]
  const names = Object.fromEntries((withSources.coverage?.sources ?? []).map((s) => [s.name, s.present]))
  assert.equal(names['Browser activity'], true)
  assert.equal(names['Calendar'], true)
  assert.equal(names['Git commits'], false)
  assert.match(withSources.factsNote, /no data from:.*git commits/)

  // Unknown connectors (no preflight) must list nothing rather than claim absence.
  const unknown = planDayWrapSlides(dayFacts())[2]
  const unknownNames = (unknown.coverage?.sources ?? []).map((s) => s.name)
  assert.ok(!unknownNames.includes('Calendar'))
  assert.ok(!unknownNames.includes('Git commits'))
})

test('a thin day says so on its coverage slide', () => {
  const slides = planDayWrapSlides(dayFacts({ activeSeconds: 20 * 60, workSeconds: 20 * 60, leisureSeconds: 0, quality: 'partial' }))
  assert.match(slides[2].fallbackLine, /thin slice/)
})

function periodFacts(): WrappedPeriodFacts {
  return {
    period: 'week', anchorDate: '2026-07-06', rangeLabel: 'JUN 30 – JUL 6',
    totalSeconds: 20 * 3600, workSeconds: 15 * 3600, leisureSeconds: 5 * 3600, personalSeconds: 0,
    meetingsSeconds: 0, daysWithActivity: 5, previousPeriodSeconds: 0,
    dominantWorkCategory: 'development', dominantWorkCategoryPct: 70,
    categories: [], topApps: [], threads: [], days: [], buckets: [],
    busiestDay: null, quietestActiveDay: null, busiestBucket: null,
    longestStretch: null, leisureSurfaces: [], dayEdges: [],
  } as unknown as WrappedPeriodFacts
}

test('period decks pin a coverage slide after the headline, outside the shuffle', () => {
  const slides = planPeriodWrapSlides(periodFacts())
  assert.equal(slides[0].id, 'opening')
  assert.equal(slides[1].id, 'headline')
  assert.equal(slides[2].id, 'coverage')
  assert.equal(slides[2].ask, '')
  assert.match(slides[2].fallbackLine, /5 days of tracked activity on this computer/)
})

// ─── Deterministic planner copy passes its own guards ─────────────────────────
// The benchmark's deterministic pre-check runs on every SHOWN line — including
// a slide that fell back to its deterministic copy, and the fallback question/
// reflection. So the planner's own fallback lines must clear the same overclaim
// and raw-artifact guards the AI lines do, or a fallback would fail the paid
// gate on copy no model wrote. (Slides with ask: '' — coverage, finale — are
// exempt here exactly as they are in the bench: they are never judged.)

test('no judged fallback line trips the deterministic guards', () => {
  const richDay = dayFacts({
    meetingsSeconds: 45 * 60,
    standout: { name: 'The tracking engine', seconds: 2 * 3600 + 28 * 60, startClock: '7:12am', endClock: '9:40am' },
    appSites: [
      { name: 'Cursor', seconds: 2 * 3600, category: 'development', kind: 'app' },
      { name: 'Claude Code', seconds: 90 * 60, category: 'aiTools', kind: 'app' },
      { name: 'YouTube', seconds: 40 * 60, category: 'entertainment', kind: 'site' },
      { name: 'Notion', seconds: 22 * 60, category: 'productivity', kind: 'app' },
    ],
    wildcardHook: { kind: 'count', value: '14', caption: 'separate returns to the proposal', seconds: undefined },
    dayStory: [
      { label: 'Morning', part: 'morning', clockStart: '9:12am', clockEnd: '12:01pm', items: ['The tracking engine'], aside: null, spillover: false, seconds: 3 * 3600 },
      { label: 'Evening', part: 'evening', clockStart: '6:10pm', clockEnd: '8:04pm', items: ['The settings screen', 'YouTube'], aside: 'YouTube', spillover: false, seconds: 2 * 3600 },
    ],
  } as Partial<DayWrapFacts>)
  const richWeek = {
    ...periodFacts(),
    previousPeriodSeconds: 18 * 3600,
    meetingsSeconds: 2 * 3600,
    categories: [
      { category: 'development', seconds: 10 * 3600 },
      { category: 'writing', seconds: 3 * 3600 },
    ],
    topApps: [
      { appName: 'Cursor', seconds: 9 * 3600 },
      { appName: 'Figma', seconds: 3 * 3600 },
      { appName: 'Slack', seconds: 2 * 3600 },
      { appName: 'Notion', seconds: 40 * 60 },
    ],
    threads: [
      { subject: 'The timeline rework', seconds: 8 * 3600, daysActive: 4 },
      { subject: 'The onboarding polish', seconds: 4 * 3600, daysActive: 2 },
    ],
    buckets: [
      { label: 'Mon', totalSeconds: 5 * 3600, dominantWorkCategory: 'development' },
      { label: 'Tue', totalSeconds: 8 * 3600, dominantWorkCategory: 'development' },
    ],
    busiestDay: { dateStr: '2026-07-01', dayLabel: 'Tuesday', totalSeconds: 8 * 3600 },
    quietestActiveDay: { dateStr: '2026-07-03', dayLabel: 'Thursday', totalSeconds: 2 * 3600 },
    busiestBucket: { label: 'Tue', totalSeconds: 8 * 3600 },
    longestStretch: { dateStr: '2026-07-01', dayLabel: 'Tuesday', seconds: 152 * 60, label: 'The timeline rework', startClock: '9:04am' },
    leisureSurfaces: ['YouTube', 'Netflix'],
    dayEdges: [
      { dateStr: '2026-07-01', dayLabel: 'Tuesday', firstHour: 5, lastHour: 23, firstClock: '5:40am', lastClock: '11:29pm' },
    ],
  } as unknown as WrappedPeriodFacts
  const slides = [...planDayWrapSlides(richDay), ...planPeriodWrapSlides(richWeek)]
  assert.ok(slides.filter((sl) => sl.ask).length >= 20, 'the sweep should cover a rich deck, not a stub')
  for (const spec of slides) {
    if (!spec.ask && spec.kind !== 'question' && spec.kind !== 'reflection') continue
    const where = `${spec.id} fallback "${spec.fallbackLine}"`
    assert.equal(findOverclaimViolation(spec.fallbackLine), null, `${where} trips the overclaim guard`)
    assert.equal(findRawArtifactLeak(spec.fallbackLine), null, `${where} leaks raw technical text`)
  }
})
