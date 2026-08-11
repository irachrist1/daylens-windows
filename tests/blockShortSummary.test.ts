import test from 'node:test'
import assert from 'node:assert/strict'
import type { AppCategory, WorkContextBlock } from '../src/shared/types.ts'
import { blockShortSummary } from '../src/renderer/lib/timelineText.ts'

// DEV-266: a block summary once read "Spent 37m spent on ChatGPT" — the
// default category verb was "spent on", doubling the template's own "Spent".
// These tests pin every category's sentence to a single clean reading.

const ALL_CATEGORIES: AppCategory[] = [
  'development', 'design', 'writing', 'research', 'aiTools', 'email',
  'communication', 'meetings', 'browsing', 'productivity', 'entertainment',
  'social', 'system', 'uncategorized',
]

function makeBlock(overrides: Partial<{
  category: AppCategory
  appName: string | null
  artifactTitle: string | null
  artifactType: string
  domain: string | null
}>): WorkContextBlock {
  const startTime = Date.UTC(2026, 3, 23, 9, 0, 0)
  const endTime = startTime + 37 * 60_000
  const apps = overrides.appName
    ? [{
        bundleId: 'com.test.app',
        appName: overrides.appName,
        category: overrides.category ?? 'aiTools',
        totalSeconds: 37 * 60,
        sessionCount: 1,
        isBrowser: false,
        isFocused: true,
      }]
    : []
  return {
    id: 'blk_test',
    startTime,
    endTime,
    isLive: false,
    provisional: false,
    dominantCategory: overrides.category ?? 'aiTools',
    categoryDistribution: {},
    switchCount: 2,
    sessions: [{ id: 1, startTime, endTime, durationSeconds: 37 * 60 }],
    topApps: apps,
    websites: overrides.domain
      ? [{ domain: overrides.domain, totalSeconds: 600, pageCount: 3 }]
      : [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: overrides.artifactTitle
      ? [{
          displayTitle: overrides.artifactTitle,
          artifactType: overrides.artifactType ?? 'page',
          totalSeconds: 600,
          ownerBundleId: null,
        }]
      : [],
    workflowRefs: [],
    label: { current: 'ChatGPT', override: null },
  } as unknown as WorkContextBlock
}

test('no summary ever doubles its verb ("Spent Xm spent on…")', () => {
  for (const category of ALL_CATEGORIES) {
    const variants = [
      makeBlock({ category }),
      makeBlock({ category, appName: 'ChatGPT' }),
      makeBlock({ category, appName: 'ChatGPT', domain: 'chatgpt.com' }),
      makeBlock({ category, appName: 'ChatGPT', artifactTitle: 'ChatGPT' }),
    ]
    for (const block of variants) {
      const summary = blockShortSummary(block)
      assert.doesNotMatch(
        summary,
        /\bspent\b[^.]*\bspent\b/i,
        `category "${category}" produced a doubled verb: "${summary}"`,
      )
      assert.match(summary, /^Spent 37m /, `category "${category}" must open with the duration once: "${summary}"`)
    }
  }
})

test('the summary describes the activity, never the hosting tool (DEV-280)', () => {
  // The July 22 failure: "Spent 7h 28m editing Cursor Agents, mostly in
  // Cursor" — a window title as the object and the tool as the location.
  for (const category of ALL_CATEGORIES) {
    const summary = blockShortSummary(makeBlock({ category, appName: 'Cursor', artifactTitle: null }))
    assert.doesNotMatch(summary, /mostly in|supporting context/i, `category "${category}" names the tool: "${summary}"`)
    assert.doesNotMatch(summary, /\bCursor\b/, `category "${category}" names the app: "${summary}"`)
  }
})

test('a clean subject is kept; a raw filename subject is dropped', () => {
  const withSubject = blockShortSummary(makeBlock({ category: 'research', artifactTitle: 'Intro to Machine Learning' }))
  assert.equal(withSubject, 'Spent 37m researching Intro to Machine Learning.')
  const withRawSubject = blockShortSummary(makeBlock({ category: 'development', artifactTitle: 'handoff.md', artifactType: 'document' }))
  assert.doesNotMatch(withRawSubject, /handoff\.md/, `raw filename must not surface: "${withRawSubject}"`)
})

test('a mixed block names the other activities alongside the dominant one', () => {
  const block = makeBlock({ category: 'development' })
  ;(block as { categoryDistribution: Partial<Record<AppCategory, number>> }).categoryDistribution = {
    development: 5 * 3600,
    research: 45 * 60,
    writing: 35 * 60,
  }
  const summary = blockShortSummary(block)
  assert.match(summary, /research/i)
  assert.match(summary, /writing/i)
})
