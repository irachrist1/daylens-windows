import test from 'node:test'
import assert from 'node:assert/strict'
import type { DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'
import { buildDayMemoryInput } from '../src/main/services/memoryMirrorBuild.ts'
import { proseDurationViolations, renderDayMemoryMarkdown } from '../src/main/services/memoryMirror.ts'

const DAY_START = Date.parse('2026-08-14T08:00:00.000Z')

function block(overrides: Partial<WorkContextBlock> = {}): WorkContextBlock {
  const base = {
    id: 'blk_1',
    startTime: DAY_START,
    endTime: DAY_START + 3_600_000,
    dominantCategory: 'design',
    categoryDistribution: {},
    ruleBasedLabel: 'Design work',
    aiLabel: null,
    sessions: [],
    topApps: [
      { bundleId: 'com.figma.Desktop', appName: 'Figma', category: 'design', totalSeconds: 2400, sessionCount: 3, isBrowser: false },
      { bundleId: 'com.google.Chrome', appName: 'Google Chrome', category: 'browser', totalSeconds: 1200, sessionCount: 5, isBrowser: true },
    ],
    websites: [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: [],
    workflowRefs: [],
    label: {
      current: 'Designed the onboarding screens',
      source: 'ai',
      confidence: 0.9,
      narrative: 'You worked through the onboarding flow and checked the build.',
      ruleBased: 'Design work',
      aiSuggested: 'Designed the onboarding screens',
      override: null,
    },
    focusOverlap: { totalSeconds: 0, pct: 0, sessionIds: [] },
    evidenceSummary: { apps: [], pages: [], documents: [], domains: [] },
    heuristicVersion: 'v1',
    computedAt: DAY_START,
    switchCount: 4,
    confidence: 'high',
    review: { state: 'unreviewed', source: 'default', originalBlockId: null, originalLabel: null, originalIntentRole: null, originalIntentSubject: null, correctedLabel: null, correctedIntentRole: null, correctedIntentSubject: null },
    isLive: false,
  } as unknown as WorkContextBlock
  return { ...base, ...overrides } as WorkContextBlock
}

function payload(blocks: WorkContextBlock[], overrides: Partial<DayTimelinePayload> = {}): DayTimelinePayload {
  return {
    date: '2026-08-14',
    sessions: [],
    websites: [],
    blocks,
    segments: [],
    focusSessions: [],
    computedAt: DAY_START,
    version: 'v1',
    totalSeconds: 3600,
    focusSeconds: 1800,
    focusPct: 50,
    appCount: 2,
    siteCount: 1,
    ...overrides,
  } as unknown as DayTimelinePayload
}

test('a day projects onto the mirror input', () => {
  const input = buildDayMemoryInput(payload([block()]), { timezone: 'UTC', generatedAtMs: DAY_START })
  assert.equal(input.date, '2026-08-14')
  assert.equal(input.trackedSeconds, 3600)
  assert.equal(input.blocks.length, 1)
  assert.equal(input.blocks[0].title, 'Designed the onboarding screens')
  assert.deepEqual(input.blocks[0].apps, ['Figma', 'Google Chrome'])
  assert.equal(input.blocks[0].corrected, false)
})

test('a correction is marked so an agent trusts it over anything it infers', () => {
  const corrected = block({
    review: { ...block().review, state: 'corrected', correctedLabel: 'Rebuilt the signup flow' },
    label: { ...block().label, override: 'Rebuilt the signup flow' },
  })
  const input = buildDayMemoryInput(payload([corrected]), { timezone: 'UTC' })
  assert.equal(input.blocks[0].corrected, true)
  assert.equal(input.blocks[0].title, 'Rebuilt the signup flow')
})

test('live and provisional blocks are never written', () => {
  const input = buildDayMemoryInput(
    payload([
      block({ id: 'live', isLive: true }),
      block({ id: 'prov', provisional: true }),
      block({ id: 'real' }),
    ]),
    { timezone: 'UTC' },
  )
  assert.deepEqual(input.blocks.map((b) => b.id), ['real'])
})

test('sub-minute blocks are dropped rather than burying the day', () => {
  const brief = block({ id: 'brief', endTime: DAY_START + 20_000 })
  const input = buildDayMemoryInput(payload([brief, block({ id: 'real' })]), { timezone: 'UTC' })
  assert.deepEqual(input.blocks.map((b) => b.id), ['real'])
})

test('app seconds accumulate across blocks and exclude skipped ones', () => {
  const second = block({ id: 'blk_2', startTime: DAY_START + 7_200_000, endTime: DAY_START + 10_800_000 })
  const live = block({ id: 'live', isLive: true })
  const input = buildDayMemoryInput(payload([block(), second, live]), { timezone: 'UTC' })
  const figma = input.apps.find((a) => a.name === 'Figma')
  assert.equal(figma?.seconds, 4800)
  assert.equal(figma?.bundleId, 'com.figma.Desktop')
})

test('a narrative that only repeats the title is dropped', () => {
  const repeated = block({
    label: { ...block().label, narrative: 'Designed the onboarding screens' },
  })
  assert.equal(buildDayMemoryInput(payload([repeated]), { timezone: 'UTC' }).blocks[0].narrative, null)
})

test('a block with no usable label still gets a title', () => {
  const unlabeled = block({
    ruleBasedLabel: '',
    aiLabel: null,
    label: { ...block().label, current: '', ruleBased: '', aiSuggested: null, override: null, narrative: null },
  })
  assert.equal(buildDayMemoryInput(payload([unlabeled]), { timezone: 'UTC' }).blocks[0].title, 'Untitled activity')
})

test('only projects and clients become entities', () => {
  const input = buildDayMemoryInput(
    payload([block()], {
      dayEntities: [
        { id: 'e1', type: 'client', name: 'Acme', seconds: 100 },
        { id: 'e2', type: 'project', name: 'Onboarding', seconds: 50 },
        { id: 'e3', type: 'person', name: 'A Colleague', seconds: 10 },
        { id: 'e4', type: 'meeting', name: 'Standup', seconds: 10 },
      ],
    } as Partial<DayTimelinePayload>),
    { timezone: 'UTC' },
  )
  assert.deepEqual(input.entities.sort(), ['Acme', 'Onboarding'])
})

test('a day with nothing writable still renders a valid file', () => {
  const input = buildDayMemoryInput(payload([block({ isLive: true })], { totalSeconds: 0 }), { timezone: 'UTC' })
  const out = renderDayMemoryMarkdown(input)
  assert.match(out, /block_count: 0/)
  assert.match(out, /No tracked activity was recorded for this day\./)
})

test('a real projected day carries no duration in its prose', () => {
  const input = buildDayMemoryInput(payload([block()]), {
    timezone: 'UTC',
    narrative: 'You spent the morning on onboarding design.',
  })
  const out = renderDayMemoryMarkdown(input)
  const body = out.slice(out.indexOf('\n---\n', 4) + 5)
  assert.deepEqual(proseDurationViolations(body), [])
})
