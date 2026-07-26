import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDayWrapFacts, workActionPhrase } from '../src/renderer/lib/dayWrapScenes.ts'
import { planDayWrapSlides } from '../src/renderer/lib/wrapDeck.ts'
import { looksLikeRawArtifactLabel } from '../src/renderer/lib/wrappedFacts.ts'
import type { AppCategory, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeBlock(opts: {
  label: string
  start: number
  durationSeconds: number
  category?: AppCategory
}): WorkContextBlock {
  const category: AppCategory = opts.category ?? 'development'
  return {
    id: `b:${opts.label}:${opts.start}`,
    startTime: opts.start,
    endTime: opts.start + opts.durationSeconds * 1000,
    dominantCategory: category,
    categoryDistribution: { [category]: opts.durationSeconds },
    ruleBasedLabel: opts.label,
    aiLabel: null,
    sessions: [],
    topApps: [],
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
    date: '2026-06-23', // a fixed past Tuesday so weekday/date labels are stable
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

const NINE_AM = new Date('2026-06-23T09:00:00').getTime()

// ─── Tests ─────────────────────────────────────────────────────────────────────

test('headline, ribbon, and the work split all reconcile to one number', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: NINE_AM, durationSeconds: 90 * 60, category: 'development' }),
    makeBlock({ label: 'Design review', start: NINE_AM + 100 * 60_000, durationSeconds: 40 * 60, category: 'design' }),
  ]))
  const ribbonTotal = facts.ribbon.reduce((s, seg) => s + seg.seconds, 0)
  assert.equal(facts.activeSeconds, facts.workSeconds + facts.leisureSeconds + facts.personalSeconds)
  assert.equal(facts.activeSeconds, ribbonTotal)
  assert.equal(facts.workSeconds, 130 * 60)
  assert.equal(facts.leisureSeconds, 0)
})

test('a raw filename never leaks as an activity name', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'BofA_Internship_Essay.docx', start: NINE_AM, durationSeconds: 80 * 60, category: 'writing' }),
    makeBlock({ label: 'MLPipeline_Week2.ipynb', start: NINE_AM + 90 * 60_000, durationSeconds: 60 * 60, category: 'development' }),
  ]))
  for (const activity of facts.workActivities) {
    assert.ok(!looksLikeRawArtifactLabel(activity.name), `leaked raw label: ${activity.name}`)
    assert.ok(!/_/.test(activity.name), `underscore leaked: ${activity.name}`)
    assert.ok(!/\.(docx|ipynb)$/i.test(activity.name), `extension leaked: ${activity.name}`)
  }
})

test('corrected subject and label win over inferred page subjects in wrap facts', () => {
  const block = makeBlock({
    label: 'Competitor pricing pages',
    start: NINE_AM,
    durationSeconds: 90 * 60,
    category: 'research',
  })
  block.topApps = [{
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    category: 'browsing',
    totalSeconds: 90 * 60,
    sessionCount: 1,
    isBrowser: true,
  }]
  block.websites = [{
    domain: 'competitor.example',
    totalSeconds: 45 * 60,
    visitCount: 1,
    pageTitles: ['Compare plans — Competitor'],
  }]
  // pageRefs are what inferWorkIntent reads — without them the correction
  // would win by default and this test would not catch a regression.
  block.pageRefs = [{
    id: 'page:competitor.example:Compare plans',
    artifactType: 'page',
    displayTitle: 'Compare plans — Competitor',
    pageTitle: 'Compare plans — Competitor',
    domain: 'competitor.example',
    totalSeconds: 45 * 60,
    confidence: 0.9,
    openTarget: { kind: 'external_url', value: 'https://competitor.example/plans' },
    url: 'https://competitor.example/plans',
    normalizedUrl: 'https://competitor.example/plans',
  }]
  block.review = {
    ...DEFAULT_TIMELINE_BLOCK_REVIEW,
    state: 'corrected',
    correctedLabel: 'Acme pricing strategy research',
    correctedIntentRole: 'research',
    correctedIntentSubject: 'Acme pricing',
  }
  const facts = buildDayWrapFacts(makeDayPayload([block]))
  const names = facts.workActivities.map((a) => a.name)
  assert.ok(
    names.some((name) => /Acme pricing/i.test(name)),
    `expected corrected subject in workActivities, got ${names.join(' | ') || '(none)'}`,
  )
  assert.ok(
    names.every((name) => !/Compare plans/i.test(name)),
    `inferred page subject leaked into workActivities: ${names.join(' | ')}`,
  )
  assert.ok(facts.standout, 'expected a standout')
  assert.match(facts.standout!.name, /Acme pricing/i)
  assert.doesNotMatch(facts.standout!.name, /Compare plans/i)
})

test('the standout is the single longest work stretch and never exceeds the headline', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Short sync', start: NINE_AM, durationSeconds: 30 * 60, category: 'meetings' }),
    makeBlock({ label: 'Deep build', start: NINE_AM + 40 * 60_000, durationSeconds: 134 * 60, category: 'development' }),
  ]))
  assert.ok(facts.standout, 'expected a standout')
  assert.equal(facts.standout!.seconds, 134 * 60)
  assert.ok(facts.standout!.seconds <= facts.activeSeconds)
})

test('no standout when nothing clears the bar', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Email triage', start: NINE_AM, durationSeconds: 12 * 60, category: 'email' }),
    makeBlock({ label: 'Quick fix', start: NINE_AM + 20 * 60_000, durationSeconds: 18 * 60, category: 'development' }),
  ]))
  assert.equal(facts.standout, null)
})

test('a leisure-heavy day is flagged as a rest day', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Watching', start: NINE_AM, durationSeconds: 120 * 60, category: 'entertainment' }),
    makeBlock({ label: 'Quick patch', start: NINE_AM + 130 * 60_000, durationSeconds: 20 * 60, category: 'development' }),
  ]))
  assert.equal(facts.isLeisureDay, true)
  assert.ok(facts.leisureSeconds >= facts.workSeconds)
})

test('framing labels are human and dated', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: NINE_AM, durationSeconds: 90 * 60, category: 'development' }),
  ]))
  assert.equal(facts.weekday, 'TUESDAY')
  assert.equal(facts.dateLabel, 'JUN 23')
})

// ─── Variation engine + reconciliation (wrapped.md §6, invariant 1) ───────────

test('the where-the-time-went distribution sums to the headline exactly', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: NINE_AM, durationSeconds: 90 * 60, category: 'development' }),
    makeBlock({ label: 'Design review', start: NINE_AM + 100 * 60_000, durationSeconds: 40 * 60, category: 'design' }),
  ]))
  const sum = facts.appSites.reduce((s, slice) => s + slice.seconds, 0)
  assert.equal(sum, facts.activeSeconds, 'app/site slices must reconcile to the headline')
})

test('the seed is stable for a date and differs for another date', () => {
  const a = buildDayWrapFacts(makeDayPayload([makeBlock({ label: 'X', start: NINE_AM, durationSeconds: 90 * 60 })]))
  const b = buildDayWrapFacts(makeDayPayload([makeBlock({ label: 'X', start: NINE_AM, durationSeconds: 90 * 60 })]))
  assert.equal(a.seed, b.seed)
  const c = buildDayWrapFacts({ ...makeDayPayload([makeBlock({ label: 'X', start: NINE_AM, durationSeconds: 90 * 60 })]), date: '2026-06-24' })
  assert.notEqual(a.seed, c.seed)
})

test('every candidate hook is true: durations never exceed the day, wildcard is one of them', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Deep build', start: NINE_AM, durationSeconds: 134 * 60, category: 'development' }),
    makeBlock({ label: 'Design review', start: NINE_AM + 140 * 60_000, durationSeconds: 40 * 60, category: 'design' }),
  ]))
  assert.ok(facts.candidateHooks.length >= 1, 'expected candidate hooks')
  for (const hook of facts.candidateHooks) {
    if (hook.seconds != null) assert.ok(hook.seconds <= facts.activeSeconds, `hook exceeds the day: ${hook.kind}`)
  }
  // The longest-stretch hook, when present, must match the computed standout.
  const longest = facts.candidateHooks.find((h) => h.kind === 'longestStretch')
  if (longest) assert.equal(longest.seconds, facts.standout!.seconds)
  assert.ok(facts.wildcardHook && facts.candidateHooks.includes(facts.wildcardHook))
})

test('the day-as-a-story buckets the day and names the work, never a raw label', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'MLPipeline_Week2.ipynb', start: NINE_AM, durationSeconds: 80 * 60, category: 'development' }),
  ]))
  const morning = facts.dayStory.find((s) => s.part === 'morning')
  assert.ok(morning, 'a 9am block lands in the morning bucket')
  for (const item of morning!.items) {
    assert.ok(!looksLikeRawArtifactLabel(item), `raw label leaked into the story: ${item}`)
  }
})

test('a pre-dawn leftover is its own late-night beat, never merged into the morning', () => {
  // The Jul 6 bug: an overnight block plus late-morning work collapsed into one
  // "morning" beat mislabelled "Late night · 12am to 12:27pm". They must split.
  const MIDNIGHT = new Date(NINE_AM); MIDNIGHT.setHours(0, 5, 0, 0)
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Building Daylens', start: MIDNIGHT.getTime(), durationSeconds: 40 * 60, category: 'development' }),
    makeBlock({ label: 'Writing the essay', start: NINE_AM, durationSeconds: 60 * 60, category: 'writing' }),
  ]))
  const lateNight = facts.dayStory.find((s) => s.part === 'lateNight')
  const morning = facts.dayStory.find((s) => s.part === 'morning')
  assert.ok(lateNight, 'the 12:05am block is its own late-night beat')
  // A short pre-dawn beat with a real day after it is LAST NIGHT'S TAIL — it
  // must be marked spillover so the wrap never claims "the day started at 12am".
  assert.equal(lateNight!.spillover, true)
  assert.equal(lateNight!.label, "Last night's tail")
  assert.ok(morning, 'the 9am block stays in the morning beat')
  assert.equal(morning!.label, 'Morning')
  // The day PROPER begins at the first real beat, not the spillover sliver.
  assert.equal(facts.mainStartClock, morning!.clockStart)
  // Chronological order: late night comes before morning.
  assert.ok(
    facts.dayStory.findIndex((s) => s.part === 'lateNight') < facts.dayStory.findIndex((s) => s.part === 'morning'),
    'the day story is chronological',
  )
})

test('a long overnight session is a REAL late-night beat, never dismissed as spillover', () => {
  const MIDNIGHT = new Date(NINE_AM); MIDNIGHT.setHours(0, 5, 0, 0)
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Building Daylens', start: MIDNIGHT.getTime(), durationSeconds: 150 * 60, category: 'development' }),
    makeBlock({ label: 'Writing the essay', start: NINE_AM, durationSeconds: 60 * 60, category: 'writing' }),
  ]))
  const lateNight = facts.dayStory.find((s) => s.part === 'lateNight')
  assert.ok(lateNight)
  assert.ok(!lateNight!.spillover, 'a 2.5h overnight session is the day, not a tail')
  assert.equal(lateNight!.label, 'Late night')
})

test('a tool brand never becomes the work subject', () => {
  // "Designing Claude Code" when the person was designing IN Claude Code was a
  // real shipped absurdity. The tool is the instrument, never the subject.
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Claude Code', start: NINE_AM, durationSeconds: 80 * 60, category: 'development' }),
  ]))
  for (const activity of facts.workActivities) {
    assert.notEqual(activity.name.toLowerCase(), 'claude code')
  }
  for (const seg of facts.dayStory) {
    for (const item of seg.items) {
      assert.ok(!/\bclaude code\b/i.test(item), `tool brand leaked into the story: ${item}`)
    }
  }
})

// ─── Audit regressions: meeting-span counting ─────────────────────────────────

test('meetings count by block SPAN, not active seconds', () => {
  // An 11:15-12:28 meeting block (73m span) with 67m active reads as a
  // 49m-class undercount across the deck. Span is the meeting truth.
  const block = makeBlock({ label: 'Team sync', start: NINE_AM, durationSeconds: 73 * 60, category: 'meetings' })
  block.focusOverlap = { totalSeconds: 60 * 60, pct: 82, sessionIds: [] }
  const facts = buildDayWrapFacts(makeDayPayload([block]))
  assert.equal(facts.meetingsSeconds, 73 * 60)
})

test('a bucket-spanning block splits its story across the parts it covered', () => {
  // One 11:25am-8pm work block. Before the fix it landed wholly in "Morning"
  // with clockEnd 8pm ("Morning · 11:25am to 8pm").
  const start = new Date('2026-06-23T11:25:00').getTime()
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Redesigning the company website', start, durationSeconds: (8 * 60 + 35) * 60, category: 'development' }),
  ]))
  const parts = facts.dayStory.map((s) => s.part)
  assert.deepEqual(parts, ['morning', 'midday', 'evening'])
  const morning = facts.dayStory[0]
  assert.equal(morning.clockStart, '11:25am')
  assert.equal(morning.clockEnd, '12pm')
  // Every part the block really covered names the work.
  for (const seg of facts.dayStory) {
    assert.ok(seg.items.length > 0, `part ${seg.part} lost its work name`)
  }
  // Allocated seconds still sum to the block's active seconds (±rounding).
  const storySum = facts.dayStory.reduce((s, seg) => s + seg.seconds, 0)
  assert.ok(Math.abs(storySum - facts.activeSeconds) <= 3, `story sum ${storySum} vs ${facts.activeSeconds}`)
})

test('a tool brand with a decorative prefix never becomes the work name', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: '✳ Claude Code', start: NINE_AM, durationSeconds: 80 * 60, category: 'communication' }),
  ]))
  for (const activity of facts.workActivities) {
    assert.ok(!/claude/i.test(activity.name), `tool brand leaked: ${activity.name}`)
  }
  for (const seg of facts.dayStory) {
    for (const item of seg.items) assert.ok(!/claude code/i.test(item), `tool brand leaked in story: ${item}`)
  }
})

test('a pipe-joined tab title never becomes the work name', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'OC | Apply founder design to chrispin.jpeg', start: NINE_AM, durationSeconds: 70 * 60, category: 'development' }),
  ]))
  for (const activity of facts.workActivities) {
    assert.ok(!activity.name.includes('|'), `pipe title leaked: ${activity.name}`)
    assert.ok(!/\.jpe?g/i.test(activity.name), `filename leaked: ${activity.name}`)
  }
})

test('an app/site slice carries the SITE own category, not the block one', () => {
  const block = makeBlock({ label: 'Working in the browser', start: NINE_AM, durationSeconds: 60 * 60, category: 'browsing' })
  block.topApps = [{
    appName: 'Dia', bundleId: 'com.dia', category: 'browsing', totalSeconds: 60 * 60,
    isBrowser: true, sessionCount: 1,
  } as (typeof block.topApps)[number]]
  block.websites = [
    { domain: 'youtube.com', totalSeconds: 30 * 60, visitCount: 3 } as (typeof block.websites)[number],
    { domain: 'canva.com', totalSeconds: 30 * 60, visitCount: 3 } as (typeof block.websites)[number],
  ]
  const facts = buildDayWrapFacts(makeDayPayload([block]))
  const youtube = facts.appSites.find((s) => s.name === 'YouTube')
  const canva = facts.appSites.find((s) => s.name === 'Canva')
  assert.ok(youtube && canva, 'expected both site slices')
  assert.equal(youtube!.category, 'entertainment')
  assert.equal(canva!.category, 'design')
})

test('workActionPhrase never stacks a verb on a gerund label', () => {
  assert.equal(workActionPhrase('Reviewing work projects', 'development'), 'reviewing work projects')
  assert.equal(workActionPhrase('Daylens', 'development'), 'building Daylens')
})

test('workActionPhrase never stacks a verb on an imperative-led task title', () => {
  // "building Debug Daylens freezing..." shipped in a real floor line; the
  // captured title already leads with the verb, so it becomes the gerund.
  assert.equal(
    workActionPhrase('Debug Daylens freezing and sleep tracking issues', 'aiTools'),
    'debugging Daylens freezing and sleep tracking issues',
  )
  assert.equal(workActionPhrase('Fix the sync race', 'development'), 'fixing the sync race')
})

test('workActionPhrase never stacks a verb on a subject that already names the work', () => {
  // "Morning went to writing Oauth development" shipped in a real floor line:
  // the category verb was blindly prepended to a noun phrase that already IS
  // the work. Such subjects pass through as their own phrase.
  assert.equal(workActionPhrase('Oauth development', 'writing'), 'oauth development')
  assert.equal(workActionPhrase('OAuth development', 'writing'), 'OAuth development')
  assert.equal(workActionPhrase('Site maintenance', 'productivity'), 'site maintenance')
  // A bare subject still gets the category verb.
  assert.equal(workActionPhrase('The essay', 'writing'), 'writing The essay')
})

test('a Claude Code window title with a spinner glyph never reaches a floor line verbatim', () => {
  // Observed in a real wrap: "building ✳ Debug Daylens freezing and sleep
  // tracking issues" — the raw window title, glyph included, straight into a
  // deterministic fallback line. The only naming candidate this block offers
  // IS that title; the glyph must be stripped and the phrase must read as an
  // action, or the name must die to the category floor. Never the raw title.
  const RAW_TITLE = '✳ Debug Daylens freezing and sleep tracking issues'
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: RAW_TITLE, start: NINE_AM, durationSeconds: 120 * 60, category: 'aiTools' }),
    makeBlock({ label: 'Design review', start: NINE_AM + 130 * 60_000, durationSeconds: 40 * 60, category: 'design' }),
  ]))

  for (const activity of facts.workActivities) {
    assert.ok(!activity.name.includes('✳'), `glyph leaked into an activity name: ${activity.name}`)
  }
  for (const seg of facts.dayStory) {
    for (const item of seg.items) assert.ok(!item.includes('✳'), `glyph leaked into the story: ${item}`)
  }

  for (const spec of planDayWrapSlides(facts)) {
    assert.ok(!spec.fallbackLine.includes(RAW_TITLE), `raw window title verbatim in a floor line: ${spec.fallbackLine}`)
    assert.ok(!spec.fallbackLine.includes('✳'), `glyph in a floor line: ${spec.fallbackLine}`)
    assert.ok(!/\b(building|writing|designing) Debug\b/.test(spec.fallbackLine),
      `verb stacked on the imperative title: ${spec.fallbackLine}`)
  }
})

test('a subject carrying a category noun composes into an honest story line', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Oauth development', start: NINE_AM, durationSeconds: 90 * 60, category: 'writing' }),
  ]))
  for (const spec of planDayWrapSlides(facts)) {
    assert.ok(!/writing [Oo]auth development/.test(spec.fallbackLine),
      `nonsense verb+noun composition in a floor line: ${spec.fallbackLine}`)
  }
})

// ─── Gaps are facts (day-recap-and-analysis.md) ───────────────────────────────

function gapSegment(startMs: number, endMs: number, kind: 'untracked' | 'asleep' | 'idle' | 'passive' = 'untracked') {
  return { kind, startTime: startMs, endTime: endMs, label: 'No data captured', source: 'derived_gap' as const }
}

function withSegmentsAndMeetings(
  payload: DayTimelinePayload,
  segments: DayTimelinePayload['segments'],
  scheduledMeetings?: DayTimelinePayload['scheduledMeetings'],
): DayTimelinePayload {
  return { ...payload, segments, ...(scheduledMeetings ? { scheduledMeetings } : {}) }
}

const FIVE_14_PM = new Date('2026-06-23T17:14:00').getTime()
const NINE_24_PM = new Date('2026-06-23T21:24:00').getTime()

test('an untracked 45m+ hole becomes an explicit gap fact with clock bounds', () => {
  const blocks = [
    makeBlock({ label: 'Daylens development', start: NINE_AM, durationSeconds: 3 * 3600, category: 'development' }),
    makeBlock({ label: 'CI migration', start: NINE_24_PM, durationSeconds: 90 * 60, category: 'development' }),
  ]
  const payload = withSegmentsAndMeetings(makeDayPayload(blocks), [
    gapSegment(FIVE_14_PM, NINE_24_PM),
  ])
  const facts = buildDayWrapFacts(payload)
  assert.equal(facts.gaps.length, 1)
  const gap = facts.gaps[0]
  assert.equal(gap.fromClock, '5:14pm')
  assert.equal(gap.toClock, '9:24pm')
  assert.equal(gap.minutes, 250)
  assert.equal(gap.kind, 'untracked')
  assert.equal(gap.matchesEvent, null)

  // The deterministic deck gets an honest line instead of silence.
  const slides = planDayWrapSlides(facts)
  const away = slides.find((s) => s.id === 'away')
  assert.ok(away, 'expected an away-from-the-computer slide')
  assert.ok(away!.fallbackLine.includes('5:14pm to 9:24pm away from the computer'),
    `fallback does not state the gap plainly: ${away!.fallbackLine}`)
})

test('a gap under 45 minutes stays out of the gap facts', () => {
  const blocks = [
    makeBlock({ label: 'Daylens development', start: NINE_AM, durationSeconds: 3600, category: 'development' }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 100 * 60_000, durationSeconds: 3600, category: 'development' }),
  ]
  const payload = withSegmentsAndMeetings(makeDayPayload(blocks), [
    gapSegment(NINE_AM + 60 * 60_000, NINE_AM + 100 * 60_000), // 40 minutes
  ])
  const facts = buildDayWrapFacts(payload)
  assert.equal(facts.gaps.length, 0)
  assert.ok(!planDayWrapSlides(facts).some((s) => s.id === 'away'))
})

test('a gap fact names the calendar event that explains it', () => {
  const sixPm = new Date('2026-06-23T18:00:00').getTime()
  const eightPm = new Date('2026-06-23T20:00:00').getTime()
  const blocks = [
    makeBlock({ label: 'Daylens development', start: NINE_AM, durationSeconds: 3 * 3600, category: 'development' }),
    makeBlock({ label: 'CI migration', start: NINE_24_PM, durationSeconds: 90 * 60, category: 'development' }),
  ]
  const payload = withSegmentsAndMeetings(
    makeDayPayload(blocks),
    [gapSegment(FIVE_14_PM, NINE_24_PM, 'asleep')],
    [{
      title: 'Run',
      startMs: sixPm,
      endMs: eightPm,
      attendeeCount: null,
      participants: [],
      attendance: 'calendar_only',
      marked: null,
      matchedBlockId: null,
    }],
  )
  const facts = buildDayWrapFacts(payload)
  assert.equal(facts.gaps.length, 1)
  assert.equal(facts.gaps[0].matchesEvent, 'Run')
  const away = planDayWrapSlides(facts).find((s) => s.id === 'away')
  assert.ok(away)
  assert.ok(away!.fallbackLine.includes('matching "Run" on your calendar'), away!.fallbackLine)
  assert.ok(away!.factsNote.includes('Run'))
})

// ─── Day threads (day-recap-and-analysis.md) ──────────────────────────────────

test('a subject recurring across 4 blocks over 5 hours becomes a day thread', () => {
  const hour = 3_600_000
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Daylens development', start: NINE_AM, durationSeconds: 45 * 60, category: 'development' }),
    makeBlock({ label: 'ML coursework', start: NINE_AM + hour, durationSeconds: 40 * 60, category: 'research' }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 2 * hour, durationSeconds: 45 * 60, category: 'development' }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 3.5 * hour, durationSeconds: 30 * 60, category: 'development' }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 5 * hour, durationSeconds: 40 * 60, category: 'development' }),
  ]))
  assert.equal(facts.threads.length, 1)
  const thread = facts.threads[0]
  assert.match(thread.name.toLowerCase(), /daylens/)
  assert.equal(thread.blockCount, 4)
  assert.equal(thread.seconds, (45 + 45 + 30 + 40) * 60)
  assert.equal(thread.fromClock, '9am')
  assert.equal(thread.toClock, '2:40pm')

  const spec = planDayWrapSlides(facts).find((s) => s.id === 'daythread')
  assert.ok(spec, 'expected a through-line slide')
  assert.ok(spec!.fallbackLine.includes('4 separate blocks'), spec!.fallbackLine)
})

test('three blocks squeezed into under three hours are not a thread', () => {
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Daylens development', start: NINE_AM, durationSeconds: 40 * 60, category: 'development' }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 50 * 60_000, durationSeconds: 40 * 60, category: 'development' }),
    makeBlock({ label: 'Daylens development', start: NINE_AM + 100 * 60_000, durationSeconds: 40 * 60, category: 'development' }),
  ]))
  assert.equal(facts.threads.length, 0)
  assert.ok(!planDayWrapSlides(facts).some((s) => s.id === 'daythread'))
})

test('a disqualified tool surface never becomes a day thread', () => {
  const hour = 3_600_000
  const facts = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Cursor Agents', start: NINE_AM, durationSeconds: 45 * 60, category: 'aiTools' }),
    makeBlock({ label: 'Cursor Agents', start: NINE_AM + 2 * hour, durationSeconds: 45 * 60, category: 'aiTools' }),
    makeBlock({ label: 'Cursor Agents', start: NINE_AM + 4 * hour, durationSeconds: 45 * 60, category: 'aiTools' }),
    makeBlock({ label: 'Cursor Agents', start: NINE_AM + 6 * hour, durationSeconds: 45 * 60, category: 'aiTools' }),
  ]))
  assert.equal(facts.threads.length, 0)
})
