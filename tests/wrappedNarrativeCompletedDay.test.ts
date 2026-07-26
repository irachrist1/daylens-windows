// Completed-day regeneration policy (gap-analysis S1: "report frozen at
// 10:38am forever"). A stored day wrap whose facts hash no longer matches the
// day's facts is treated differently by WHEN the day is opened:
//   - a PAST day: the stored wrap was generated mid-day and frozen; its facts
//     have settled, so one provider call regenerates it — after which the
//     hash matches and the stored wrap is served forever (no churn, no loop).
//   - TODAY: reconcile only. The day is still accruing; regenerating on every
//     open would churn calls all day long.
// Failure is never allowed to make things worse: an unusable regeneration
// returns the deterministic floor WITHOUT persisting, so the stored wrap
// survives (still reconcilable) and a later open can retry.
//
// Hermetic: the provider is a fake runner via registerWrappedNarrativeProvider
// (same pattern as eveningRecapFreshness.test.ts). This file runs in its own
// process, so the module-level runner cannot leak into other files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import * as settingsStub from './support/settings-stub.mjs'
import { getWrappedNarrative, registerWrappedNarrativeProvider } from '../src/main/services/wrappedNarrative.ts'
import { resolveDayEnrichment } from '../src/main/services/enrichmentResolve.ts'
import { computeFactsHash } from '../src/main/lib/wrappedNarrative.ts'
import { localDateString } from '../src/main/lib/localDate.ts'
import { getStoredWrappedNarrative, putStoredWrappedNarrative } from '../src/main/db/wrappedNarrativeStore.ts'
import { buildDayWrapFacts } from '../src/renderer/lib/dayWrapScenes.ts'
import { planDayWrapSlides } from '../src/renderer/lib/wrapDeck.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'
import type { AIWrappedNarrative, AppCategory, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'

const PAST_DATE = '2026-04-22' // long completed relative to any run date

function dayMs(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime()
}

function makeBlock(opts: {
  date: string
  label: string
  hour: number
  durationSeconds: number
  category?: AppCategory
  appName?: string
}): WorkContextBlock {
  const category: AppCategory = opts.category ?? 'development'
  const appName = opts.appName ?? 'Cursor'
  const start = dayMs(opts.date, opts.hour)
  return {
    id: `b:${opts.label}:${start}`,
    startTime: start,
    endTime: start + opts.durationSeconds * 1000,
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
    computedAt: start,
    switchCount: 0,
    confidence: 'high',
    review: { ...DEFAULT_TIMELINE_BLOCK_REVIEW, state: 'auto-approved' },
    isLive: false,
  }
}

function makeDayPayload(date: string, blocks: WorkContextBlock[]): DayTimelinePayload {
  const total = blocks.reduce((s, b) => s + Math.round((b.endTime - b.startTime) / 1000), 0)
  return {
    date,
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

function workingDayPayload(date: string): DayTimelinePayload {
  return makeDayPayload(date, [
    makeBlock({ date, label: 'Auth refactor', hour: 9, durationSeconds: 150 * 60 }),
    makeBlock({ date, label: 'Design review', hour: 13, durationSeconds: 40 * 60, category: 'design', appName: 'Figma' }),
  ])
}

const STORED_LEAD = 'A steady one, mostly heads-down on the auth work.'

function storedNarrative(): AIWrappedNarrative {
  return {
    lead: STORED_LEAD,
    lines: { opening: STORED_LEAD },
    question: null,
    reflection: null,
    source: 'ai',
    factsHash: 'ignored',
  }
}

/** A runner whose behavior each test swaps: 'good' writes a clean deck for
 *  the given payload, 'garbage' returns unparseable prose, 'throw' fails. */
let runnerMode: 'good' | 'garbage' | 'throw' = 'good'
let runnerPayload: DayTimelinePayload | null = null
let providerCalls = 0

registerWrappedNarrativeProvider(async () => {
  providerCalls += 1
  if (runnerMode === 'throw') throw new Error('provider down')
  if (runnerMode === 'garbage') {
    return { text: 'sorry, I cannot produce JSON today' } as never
  }
  const facts = buildDayWrapFacts(runnerPayload!)
  const lines: Record<string, string> = {}
  for (const spec of planDayWrapSlides(facts)) {
    if (spec.ask) lines[spec.id] = `The ${spec.id.replace(/[^a-z]/gi, ' ')} beat of the day held steady and real.`
  }
  return {
    text: JSON.stringify({
      lines,
      question: 'What made the auth work the thing you kept coming back to?',
      reflection: 'You kept the day simple, one long stretch of real building with a design pass beside it. Plainly told, that was enough.',
    }),
    config: { model: 'test-model' },
  } as never
})

test.before(async () => {
  await settingsStub.setApiKey('anthropic', 'test-key')
})
test.after(async () => {
  await settingsStub.clearApiKey('anthropic')
})

test('a failed regeneration of a completed day never marks the cache fresh or clobbers the stored wrap', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    const payload = workingDayPayload(PAST_DATE)
    runnerPayload = payload
    putStoredWrappedNarrative(db, 'day', PAST_DATE, storedNarrative(), 'stale-hash', dayMs(PAST_DATE, 10, 38))

    runnerMode = 'garbage'
    providerCalls = 0
    const afterGarbage = await getWrappedNarrative(payload)
    assert.equal(providerCalls, 1, 'the completed drifted day spent exactly one generation call')
    assert.equal(afterGarbage.source, 'fallback', 'unusable output falls back deterministically')

    const storedAfterFail = getStoredWrappedNarrative<AIWrappedNarrative>(db, 'day', PAST_DATE)
    assert.equal(storedAfterFail?.narrative.lead, STORED_LEAD, 'the stored wrap survives the failed regeneration')
    assert.equal(storedAfterFail?.factsHash, 'stale-hash', 'the cache is NOT marked fresh by a failure')

    // A thrown provider error behaves the same: floor returned, nothing persisted.
    runnerMode = 'throw'
    const afterThrow = await getWrappedNarrative(payload)
    assert.equal(afterThrow.source, 'fallback')
    assert.equal(getStoredWrappedNarrative<AIWrappedNarrative>(db, 'day', PAST_DATE)?.factsHash, 'stale-hash')

    // Because the failure never marked the cache fresh, a later open retries
    // and the one successful call fixes the day forever.
    runnerMode = 'good'
    const callsBefore = providerCalls
    const regenerated = await getWrappedNarrative(payload)
    assert.ok(providerCalls > callsBefore, 'the retry regenerates')
    assert.equal(regenerated.source, 'ai')
    assert.notEqual(regenerated.lead, STORED_LEAD, 'the mid-day snapshot is replaced')

    const currentHash = computeFactsHash(buildDayWrapFacts(payload), resolveDayEnrichment(db, PAST_DATE))
    assert.equal(getStoredWrappedNarrative<AIWrappedNarrative>(db, 'day', PAST_DATE)?.factsHash, currentHash,
      'success persists under the current facts hash — the loop closes')

    const callsAfterSuccess = providerCalls
    const served = await getWrappedNarrative(payload)
    assert.equal(providerCalls, callsAfterSuccess, 'subsequent opens serve the store, never another call')
    assert.equal(served.lead, regenerated.lead)
  } finally {
    clearTestDb()
    db.close()
  }
})

test('a same-day open of a drifted wrap reconciles without spending a call, even with a provider connected', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    const today = localDateString()
    const payload = workingDayPayload(today)
    runnerPayload = payload
    runnerMode = 'good'
    putStoredWrappedNarrative(db, 'day', today, storedNarrative(), 'stale-hash', Date.now())

    providerCalls = 0
    const narrative = await getWrappedNarrative(payload)
    assert.equal(providerCalls, 0, 'today never regenerates on open — no churn while the day accrues')
    assert.equal(narrative.source, 'ai', 'the stored prose is re-grounded, not discarded')
    assert.equal(narrative.lead, STORED_LEAD, 'the numberless lead survives re-grounding')

    assert.equal(getStoredWrappedNarrative<AIWrappedNarrative>(db, 'day', today)?.factsHash, 'stale-hash',
      'reconciling is read-only: the stored row is untouched')
  } finally {
    clearTestDb()
    db.close()
  }
})
