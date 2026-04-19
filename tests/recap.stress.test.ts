import test from 'node:test'
import assert from 'node:assert/strict'
import type { ArtifactRef, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'
import { buildRecapSummaries, getMonthStart, shiftDate } from '../src/renderer/lib/recap.ts'

function makeArtifact(title: string, totalSeconds: number): ArtifactRef {
  return {
    id: `artifact:${title}`,
    artifactType: 'document',
    displayTitle: title,
    totalSeconds,
    confidence: 0.9,
    openTarget: { kind: 'unsupported', value: null },
  }
}

function makeBlock(label: string, startTime: number, durationSeconds: number, options?: {
  switchCount?: number
  artifacts?: ArtifactRef[]
}): WorkContextBlock {
  return {
    id: `block:${label}:${startTime}`,
    startTime,
    endTime: startTime + durationSeconds * 1_000,
    dominantCategory: 'development',
    categoryDistribution: { development: durationSeconds },
    ruleBasedLabel: label,
    aiLabel: null,
    sessions: [],
    topApps: [],
    websites: [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: options?.artifacts ?? [],
    workflowRefs: [],
    label: {
      current: label,
      source: 'rule',
      confidence: 0.92,
      narrative: null,
      ruleBased: label,
      aiSuggested: null,
      override: null,
    },
    focusOverlap: { totalSeconds: durationSeconds, pct: 100, sessionIds: [] },
    evidenceSummary: { apps: [], pages: [], documents: [], domains: [] },
    heuristicVersion: 'stress',
    computedAt: startTime,
    switchCount: options?.switchCount ?? 0,
    confidence: 'high',
    isLive: false,
  }
}

function makeDay(date: string, options: {
  totalSeconds: number
  focusSeconds?: number
  blocks?: WorkContextBlock[]
  focusSessionCount?: number
}): DayTimelinePayload {
  return {
    date,
    sessions: [],
    websites: [],
    blocks: options.blocks ?? [],
    segments: [],
    focusSessions: Array.from({ length: options.focusSessionCount ?? 0 }, (_, index) => ({
      id: index + 1,
      startTime: new Date(`${date}T09:00:00`).getTime(),
      endTime: new Date(`${date}T09:30:00`).getTime(),
      durationSeconds: 30 * 60,
      label: 'Focus',
      targetMinutes: 30,
      plannedApps: [],
    })),
    computedAt: Date.now(),
    version: 'stress',
    totalSeconds: options.totalSeconds,
    focusSeconds: options.focusSeconds ?? options.totalSeconds,
    focusPct: options.totalSeconds > 0 ? Math.round(((options.focusSeconds ?? options.totalSeconds) / options.totalSeconds) * 100) : 0,
    appCount: 0,
    siteCount: 0,
  }
}

test('monthly recap does not invent a delta when current month is longer than previous', () => {
  // May 31 following April 30: both windows must be the same length.
  const today = '2026-05-31'
  const monthStart = getMonthStart(today)
  const prevStart = '2026-04-01'
  const payloads: DayTimelinePayload[] = []
  // 31 days in May and 30 days in April, all with identical 3h/day tracked.
  for (let i = 0; i < 31; i += 1) {
    payloads.push(makeDay(shiftDate(monthStart, i), { totalSeconds: 3 * 3600, focusSeconds: 2 * 3600 }))
  }
  for (let i = 0; i < 30; i += 1) {
    payloads.push(makeDay(shiftDate(prevStart, i), { totalSeconds: 3 * 3600, focusSeconds: 2 * 3600 }))
  }

  const recap = buildRecapSummaries(payloads, today)
  const changeChapter = recap.month.chapters.find((chapter) => chapter.id === 'change')

  // Before the fix, aggregator summed 31 vs 30 days and reported ~3h "rose".
  // After the fix, clipping to 30 days on both sides should produce held-steady copy.
  assert.match(recap.month.changeSummary, /held steady/, recap.month.changeSummary)
  assert.ok(changeChapter, 'expected change chapter')
  assert.equal(changeChapter!.title, 'A similar shape', changeChapter!.title)
})

test('monthly recap clips March 31 comparison to February symmetry', () => {
  // March 31 following February (28 days in 2026 — not a leap year).
  const today = '2026-03-31'
  const payloads: DayTimelinePayload[] = []
  for (let i = 0; i < 31; i += 1) {
    payloads.push(makeDay(shiftDate('2026-03-01', i), { totalSeconds: 2 * 3600, focusSeconds: 3600 }))
  }
  for (let i = 0; i < 28; i += 1) {
    payloads.push(makeDay(shiftDate('2026-02-01', i), { totalSeconds: 2 * 3600, focusSeconds: 3600 }))
  }

  const recap = buildRecapSummaries(payloads, today)
  const changeChapter = recap.month.chapters.find((chapter) => chapter.id === 'change')

  // Without the fix this would report a ~6h delta from the 3 extra March days.
  assert.match(recap.month.changeSummary, /held steady/, recap.month.changeSummary)
  assert.ok(changeChapter)
  assert.equal(changeChapter!.title, 'A similar shape')
})

test('workstream list surfaces dominant untitled work even when three named threads exist', () => {
  const today = '2026-04-19'
  const base = new Date(`${today}T09:00:00`).getTime()
  const blocks: WorkContextBlock[] = [
    // Three small named blocks.
    makeBlock('Named A', base, 30 * 60),
    makeBlock('Named B', base + 31 * 60_000, 20 * 60),
    makeBlock('Named C', base + 52 * 60_000, 15 * 60),
    // One enormous unnamed block.
    makeBlock('', base + 68 * 60_000, 10 * 3600),
  ]

  const recap = buildRecapSummaries([
    makeDay(today, { totalSeconds: 10 * 3600 + 65 * 60, focusSeconds: 10 * 3600, blocks }),
  ], today)

  const labels = recap.day.topWorkstreams.map((item) => item.label)
  assert.ok(
    labels.includes('Unnamed work blocks'),
    `dominant unnamed work must surface in top 3; got ${JSON.stringify(labels)}`,
  )
  assert.equal(recap.day.topWorkstreams.length, 3)
})

test('workstream list drops untitled when it is a minor slice next to three strong named threads', () => {
  const today = '2026-04-19'
  const base = new Date(`${today}T09:00:00`).getTime()
  const blocks: WorkContextBlock[] = [
    makeBlock('Named A', base, 3 * 3600),
    makeBlock('Named B', base + 3 * 3600_000 + 60_000, 2 * 3600),
    makeBlock('Named C', base + 5 * 3600_000 + 2 * 60_000, 90 * 60),
    makeBlock('', base + 6 * 3600_000 + 33 * 60_000, 5 * 60), // tiny
  ]

  const recap = buildRecapSummaries([
    makeDay(today, { totalSeconds: 6 * 3600 + 38 * 60, focusSeconds: 5 * 3600, blocks }),
  ], today)

  const labels = recap.day.topWorkstreams.map((item) => item.label)
  assert.ok(!labels.includes('Unnamed work blocks'), `non-dominant unnamed should not displace named; got ${JSON.stringify(labels)}`)
})

test('change title and body agree across the entire threshold boundary', () => {
  // Generate three comparison days around the shared 60s threshold.
  const today = '2026-04-19'
  const yesterday = shiftDate(today, -1)
  const scenarios: Array<{ diff: number; expectedTitle: string; expectedBody: RegExp }> = [
    { diff: 0, expectedTitle: 'A similar shape', expectedBody: /held steady/ },
    { diff: 59, expectedTitle: 'A similar shape', expectedBody: /held steady/ },
    { diff: 60, expectedTitle: 'Heavier than before', expectedBody: /rose/ },
    { diff: 300, expectedTitle: 'Heavier than before', expectedBody: /rose/ },
    { diff: -60, expectedTitle: 'Lighter than before', expectedBody: /fell/ },
    { diff: -1000, expectedTitle: 'Lighter than before', expectedBody: /fell/ },
  ]

  for (const { diff, expectedTitle, expectedBody } of scenarios) {
    const base = 2 * 3600
    const current = base + Math.max(0, diff)
    const prev = base + Math.max(0, -diff)
    const recap = buildRecapSummaries([
      makeDay(today, { totalSeconds: current, focusSeconds: current, blocks: [makeBlock('Work', new Date(`${today}T09:00:00`).getTime(), current)] }),
      makeDay(yesterday, { totalSeconds: prev, focusSeconds: prev, blocks: [makeBlock('Work', new Date(`${yesterday}T09:00:00`).getTime(), prev)] }),
    ], today)
    const changeChapter = recap.day.chapters.find((chapter) => chapter.id === 'change')
    assert.ok(changeChapter, `diff=${diff}: expected change chapter`)
    assert.equal(changeChapter!.title, expectedTitle, `diff=${diff}: title`)
    assert.match(recap.day.changeSummary, expectedBody, `diff=${diff}: body`)
  }
})

test('rhythm copy uses singular verb when exactly one focus session fires', () => {
  const today = '2026-04-19'
  const weekStart = shiftDate(today, -2)
  const recap = buildRecapSummaries([
    makeDay(weekStart, { totalSeconds: 4 * 3600, focusSeconds: 3 * 3600, focusSessionCount: 1, blocks: [makeBlock('Work', new Date(`${weekStart}T09:00:00`).getTime(), 4 * 3600)] }),
    makeDay(shiftDate(weekStart, 1), { totalSeconds: 0 }),
    makeDay(today, { totalSeconds: 2 * 3600, focusSeconds: 60 * 60, blocks: [makeBlock('Work', new Date(`${today}T09:00:00`).getTime(), 2 * 3600)] }),
  ], today)

  const rhythm = recap.week.chapters.find((chapter) => chapter.id === 'rhythm')
  assert.ok(rhythm, 'expected rhythm chapter')
  assert.match(rhythm!.body, /1 focus session was captured/, rhythm!.body)
  assert.doesNotMatch(rhythm!.body, /1 focus session were/, rhythm!.body)
})

test('rhythm copy uses plural verb for multiple focus sessions', () => {
  const today = '2026-04-19'
  const weekStart = shiftDate(today, -3)
  const recap = buildRecapSummaries([
    makeDay(weekStart, { totalSeconds: 4 * 3600, focusSeconds: 3 * 3600, focusSessionCount: 3, blocks: [makeBlock('Work', new Date(`${weekStart}T09:00:00`).getTime(), 4 * 3600)] }),
    makeDay(shiftDate(weekStart, 1), { totalSeconds: 0 }),
    makeDay(today, { totalSeconds: 2 * 3600, focusSeconds: 60 * 60, blocks: [makeBlock('Work', new Date(`${today}T09:00:00`).getTime(), 2 * 3600)] }),
  ], today)

  const rhythm = recap.week.chapters.find((chapter) => chapter.id === 'rhythm')
  assert.ok(rhythm)
  assert.match(rhythm!.body, /3 focus sessions were captured/)
})
