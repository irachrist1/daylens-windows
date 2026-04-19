import test from 'node:test'
import assert from 'node:assert/strict'
import type { ArtifactRef, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'
import { buildRecapSummaries, getMonthStart, getWeekStart, recapDateWindow, shiftDate } from '../src/renderer/lib/recap.ts'

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
    focusOverlap: {
      totalSeconds: durationSeconds,
      pct: 100,
      sessionIds: [],
    },
    evidenceSummary: {
      apps: [],
      pages: [],
      documents: [],
      domains: [],
    },
    heuristicVersion: 'test',
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
    version: 'test',
    totalSeconds: options.totalSeconds,
    focusSeconds: options.focusSeconds ?? options.totalSeconds,
    focusPct: options.totalSeconds > 0 ? Math.round(((options.focusSeconds ?? options.totalSeconds) / options.totalSeconds) * 100) : 0,
    appCount: 0,
    siteCount: 0,
  }
}

test('daily recap highlights the main thread, deep stretch, and artifacts', () => {
  const today = '2026-04-19'
  const buildSpec = makeBlock(
    'Launch polish',
    new Date('2026-04-19T09:00:00').getTime(),
    2 * 3600,
    {
      switchCount: 2,
      artifacts: [makeArtifact('build/dmg-background.svg', 2 * 3600)],
    },
  )
  const validateSpec = makeBlock(
    'Provider validation',
    new Date('2026-04-19T12:00:00').getTime(),
    75 * 60,
    {
      switchCount: 1,
      artifacts: [makeArtifact('src/renderer/views/Insights.tsx', 75 * 60)],
    },
  )

  const recap = buildRecapSummaries([
    makeDay(today, {
      totalSeconds: 3 * 3600 + 15 * 60,
      focusSeconds: 2 * 3600 + 30 * 60,
      focusSessionCount: 2,
      blocks: [buildSpec, validateSpec],
    }),
    makeDay(shiftDate(today, -1), { totalSeconds: 90 * 60, focusSeconds: 45 * 60 }),
  ], today)

  assert.equal(recap.day.hasData, true)
  assert.match(recap.day.summary, /Launch polish/)
  assert.match(recap.day.summary, /build\/dmg-background\.svg/)
  assert.equal(recap.day.metrics[0]?.label, 'Tracked')
  assert.equal(recap.day.topWorkstreams[0]?.label, 'Launch polish')
})

test('weekly recap compares against the same point last week', () => {
  const today = '2026-04-16'
  const weekStart = getWeekStart(today)
  const previousWeekStart = shiftDate(weekStart, -7)

  const payloads = [
    makeDay(weekStart, {
      totalSeconds: 2 * 3600,
      focusSeconds: 90 * 60,
      blocks: [makeBlock('Recap work', new Date(`${weekStart}T09:00:00`).getTime(), 2 * 3600)],
    }),
    makeDay(shiftDate(weekStart, 1), {
      totalSeconds: 3 * 3600,
      focusSeconds: 2 * 3600,
      blocks: [makeBlock('Recap work', new Date(`${shiftDate(weekStart, 1)}T10:00:00`).getTime(), 3 * 3600)],
    }),
    makeDay(previousWeekStart, {
      totalSeconds: 60 * 60,
      focusSeconds: 30 * 60,
      blocks: [makeBlock('Older thread', new Date(`${previousWeekStart}T09:00:00`).getTime(), 60 * 60)],
    }),
    makeDay(shiftDate(previousWeekStart, 1), {
      totalSeconds: 90 * 60,
      focusSeconds: 45 * 60,
      blocks: [makeBlock('Older thread', new Date(`${shiftDate(previousWeekStart, 1)}T09:00:00`).getTime(), 90 * 60)],
    }),
  ]

  const recap = buildRecapSummaries(payloads, today)

  assert.equal(recap.week.trend.length, 4)
  assert.match(recap.week.changeSummary, /the same point last week/)
  assert.match(recap.week.changeSummary, /rose|improved|shifted/)
  assert.equal(recap.week.topWorkstreams[0]?.label, 'Recap work')
})

test('monthly recap handles empty data honestly', () => {
  const today = '2026-04-19'
  const recap = buildRecapSummaries([], today)

  assert.equal(recap.month.hasData, false)
  assert.match(recap.month.summary, /No tracked activity yet this month/)
  assert.match(recap.month.changeSummary, /Last month/)
})

test('recap date window covers the previous month through today', () => {
  const today = '2026-04-19'
  const dates = recapDateWindow(today)

  assert.equal(dates[0], '2026-03-01')
  assert.equal(dates.at(-1), today)
  assert.equal(dates.includes(getMonthStart(today)), true)
})

test('daily recap chapters tell a paced story with focus and artifacts', () => {
  const today = '2026-04-19'
  const buildSpec = makeBlock(
    'Launch polish',
    new Date('2026-04-19T09:00:00').getTime(),
    2 * 3600,
    {
      switchCount: 5,
      artifacts: [makeArtifact('build/dmg-background.svg', 2 * 3600)],
    },
  )

  const recap = buildRecapSummaries([
    makeDay(today, {
      totalSeconds: 2 * 3600,
      focusSeconds: 90 * 60,
      focusSessionCount: 1,
      blocks: [buildSpec],
    }),
  ], today)

  const chapterIds = recap.day.chapters.map((chapter) => chapter.id)
  assert.ok(chapterIds.includes('headline'))
  assert.ok(chapterIds.includes('focus'))
  assert.ok(chapterIds.includes('artifacts'))
  const focusChapter = recap.day.chapters.find((chapter) => chapter.id === 'focus')
  assert.ok(focusChapter && /handoff/.test(focusChapter.body))
  assert.match(recap.day.headline, /Launch polish/)
  const promptsJoined = recap.day.promptChips.join(' | ')
  assert.match(promptsJoined, /Launch polish/)
})

test('recap coverage honestly reports when most time is in unnamed blocks', () => {
  const today = '2026-04-19'
  const blocks: ReturnType<typeof makeBlock>[] = [
    makeBlock('', new Date('2026-04-19T09:00:00').getTime(), 90 * 60),
    makeBlock('', new Date('2026-04-19T11:00:00').getTime(), 60 * 60),
    makeBlock('Deep work', new Date('2026-04-19T13:00:00').getTime(), 30 * 60),
  ]

  const recap = buildRecapSummaries([
    makeDay(today, {
      totalSeconds: 3 * 3600,
      focusSeconds: 2 * 3600,
      blocks,
    }),
  ], today)

  assert.ok(recap.day.coverage.untitledPct >= 50)
  assert.ok(recap.day.coverage.coverageNote && /unnamed blocks/.test(recap.day.coverage.coverageNote))
  assert.match(recap.day.headline, /unnamed blocks|partial/)
})

test('weekly recap surfaces rhythm chapter with peak day and quiet days', () => {
  const today = '2026-04-19'
  const weekStart = getWeekStart(today)

  const payloads = [
    makeDay(weekStart, {
      totalSeconds: 4 * 3600,
      focusSeconds: 3 * 3600,
      blocks: [makeBlock('Deep thread', new Date(`${weekStart}T09:00:00`).getTime(), 4 * 3600)],
    }),
    makeDay(shiftDate(weekStart, 1), { totalSeconds: 0 }),
    makeDay(shiftDate(weekStart, 2), {
      totalSeconds: 2 * 3600,
      focusSeconds: 60 * 60,
      blocks: [makeBlock('Deep thread', new Date(`${shiftDate(weekStart, 2)}T09:00:00`).getTime(), 2 * 3600)],
    }),
  ]

  const recap = buildRecapSummaries(payloads, shiftDate(weekStart, 2))
  const rhythm = recap.week.chapters.find((chapter) => chapter.id === 'rhythm')
  assert.ok(rhythm, 'week recap should include a rhythm chapter')
  assert.match(rhythm!.body, /Busiest day/)
  assert.match(rhythm!.body, /no captured activity|had no captured/)
})
