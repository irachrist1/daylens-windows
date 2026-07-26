// The evening recap can never disagree with the wrap it opens. The notifier
// reuses the STORED wrap's lead only while the stored facts hash still equals
// the day's current facts hash; a drifted wrap is regenerated at delivery
// time (onStale 'regenerate') or, when no provider can generate, the result
// is the deterministic fallback — which the notifier treats as silence, never
// a stale line. In-app opens of a drifted wrap re-ground the stored prose so
// no line can contradict the cards it sits on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { clearTestDb, setTestDb } from './support/database-stub.mjs'
import { getWrappedNarrative } from '../src/main/services/wrappedNarrative.ts'
import { resolveDayEnrichment } from '../src/main/services/enrichmentResolve.ts'
import { buildFallbackNarrative, computeFactsHash, factOnlyRecapLine } from '../src/main/lib/wrappedNarrative.ts'
import { buildDayFactTable, firstUngroundedNumericToken, groundingFormsForRuntime } from '../src/main/lib/wrapFactTable.ts'
import { aiNarrativeAttemptsExhausted, recordAiNarrativeAttempt, AI_ATTEMPT_MAX_PER_DAY, AI_ATTEMPT_MIN_GAP_MS, type DailyNotifierState } from '../src/main/lib/dailySummaryScheduler.ts'
import { putStoredWrappedNarrative, getStoredWrappedNarrative } from '../src/main/db/wrappedNarrativeStore.ts'
import { buildDayWrapFacts, formatHm } from '../src/renderer/lib/dayWrapScenes.ts'
import { planDayWrapSlides, resolveSlideLine } from '../src/renderer/lib/wrapDeck.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'
import type { AIWrappedNarrative, AppCategory, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

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
    date: TEST_DATE,
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

function workingDayPayload(): DayTimelinePayload {
  return makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: localMs(9), durationSeconds: 150 * 60 }),
    makeBlock({ label: 'Design review', start: localMs(13), durationSeconds: 40 * 60, category: 'design', appName: 'Figma' }),
    makeBlock({ label: 'YouTube', start: localMs(18), durationSeconds: 25 * 60, category: 'entertainment', appName: 'YouTube' }),
  ])
}

const STORED_LEAD = 'A steady one, mostly heads-down on the auth work.'

function storedNarrative(over: Partial<AIWrappedNarrative> = {}): AIWrappedNarrative {
  return {
    lead: STORED_LEAD,
    lines: {
      opening: STORED_LEAD,
      headline: 'The day found its shape early, going by 6:45am.',
    },
    question: 'What pulled you into the design review after lunch?',
    reflection: null,
    source: 'ai',
    factsHash: 'ignored',
    ...over,
  }
}

test('a stored wrap whose facts still hold IS the recap: same lead, no regeneration', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    const payload = workingDayPayload()
    const currentHash = computeFactsHash(buildDayWrapFacts(payload), resolveDayEnrichment(db, TEST_DATE))
    const generatedAt = Date.parse('2026-04-22T14:00:00')
    putStoredWrappedNarrative(db, 'day', TEST_DATE, storedNarrative(), currentHash, generatedAt)

    const narrative = await getWrappedNarrative(payload, { triggerSource: 'system', onStale: 'regenerate' })
    assert.equal(narrative.source, 'ai')
    assert.equal(narrative.lead, STORED_LEAD, 'the notification line is the stored wrap lead, verbatim')
    assert.equal(narrative.generatedAt, generatedAt, 'served as stored, not regenerated')
  } finally {
    clearTestDb()
    db.close()
  }
})

test('an in-app open of a drifted wrap re-grounds the prose instead of trusting it', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    const payload = workingDayPayload()
    putStoredWrappedNarrative(db, 'day', TEST_DATE, storedNarrative(), 'stale-hash', Date.now())

    const narrative = await getWrappedNarrative(payload)
    assert.equal(narrative.source, 'ai', 'grounded stored prose still shows')
    assert.equal(narrative.lead, STORED_LEAD, 'the numberless lead survives re-grounding')
    assert.equal(narrative.lines.headline, null,
      'the stale clock claim cannot render; its slide falls back deterministically')
  } finally {
    clearTestDb()
    db.close()
  }
})

test('delivery of a drifted wrap without a provider yields the fallback — silence, never a stale line', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    const payload = workingDayPayload()
    putStoredWrappedNarrative(db, 'day', TEST_DATE, storedNarrative(), 'stale-hash', Date.now())

    const narrative = await getWrappedNarrative(payload, { triggerSource: 'system', onStale: 'regenerate' })
    assert.equal(narrative.source, 'fallback',
      'not AI output → the notifier fires nothing (no-credits rule), and never the stale stored lead')
    assert.notEqual(narrative.lead, STORED_LEAD)

    const stored = getStoredWrappedNarrative<AIWrappedNarrative>(db, 'day', TEST_DATE)
    assert.equal(stored?.narrative.lead, STORED_LEAD,
      'a failed delivery-time regeneration does not clobber the stored wrap')
  } finally {
    clearTestDb()
    db.close()
  }
})

test('an empty day serves the honest empty-day narrative, never invented content', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    const narrative = await getWrappedNarrative(makeDayPayload([]))
    assert.equal(narrative.source, 'fallback')
    assert.match(narrative.lead, /Not much tracked yet/i)
  } finally {
    clearTestDb()
    db.close()
  }
})

// ─── The fact-only fallback line (fallback order: fact-only, then silence) ───

test('the fact-only recap line speaks only numbers the day fact table grounds', () => {
  const payload = workingDayPayload()
  const facts = buildDayWrapFacts(payload)
  const line = factOnlyRecapLine(facts)
  assert.ok(line, 'a real day has a fact-only line')
  assert.ok(line!.includes(formatHm(facts.activeSeconds)), 'the line carries the shared corrected total')

  const table = buildDayFactTable(facts, payload.blocks, facts.date, null)
  const forms = groundingFormsForRuntime(table, '')
  assert.equal(
    firstUngroundedNumericToken(line!, forms),
    null,
    'every number in the notification line is a fact-table fact',
  )
})

test('the fact-only recap line reflects a deletion: corrected facts in, corrected line out', () => {
  const fullDay = buildDayWrapFacts(workingDayPayload())
  const afterDeletion = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Auth refactor', start: localMs(9), durationSeconds: 150 * 60 }),
  ]))
  const lineBefore = factOnlyRecapLine(fullDay)
  const lineAfter = factOnlyRecapLine(afterDeletion)
  assert.ok(lineBefore && lineAfter)
  assert.ok(lineBefore!.includes(formatHm(fullDay.activeSeconds)))
  assert.ok(lineAfter!.includes(formatHm(afterDeletion.activeSeconds)))
  assert.notEqual(lineBefore, lineAfter, 'deleted evidence changes the notification line with the day')
})

test('a day too thin to recap yields no line at all: silence over invention', () => {
  assert.equal(factOnlyRecapLine(buildDayWrapFacts(makeDayPayload([]))), null)
  const barely = buildDayWrapFacts(makeDayPayload([
    makeBlock({ label: 'Email', start: localMs(9), durationSeconds: 3 * 60 }),
  ]))
  assert.equal(factOnlyRecapLine(barely), null, 'below the quality floor there is nothing honest to push')
  // The 45-minute delivery gate (NOTIFY_MIN_SECONDS, tested with the
  // scheduler) keeps the partial band from ever reaching this line builder.
})

test('the AI budget distinguishes waiting for a retry from being spent for the day', () => {
  const t0 = Date.parse('2026-04-22T18:00:00')
  let state: DailyNotifierState = {}
  assert.equal(aiNarrativeAttemptsExhausted(state, 'evening-wrap', TEST_DATE), false)
  state = recordAiNarrativeAttempt(state, 'evening-wrap', TEST_DATE, t0)
  // One failed attempt: not exhausted — the recap window holds for a retry
  // instead of firing the fact-only line early.
  assert.equal(aiNarrativeAttemptsExhausted(state, 'evening-wrap', TEST_DATE), false)
  for (let i = 1; i < AI_ATTEMPT_MAX_PER_DAY; i += 1) {
    state = recordAiNarrativeAttempt(state, 'evening-wrap', TEST_DATE, t0 + i * AI_ATTEMPT_MIN_GAP_MS)
  }
  // Budget spent: now (and only now) the fact-only line ends the window.
  assert.equal(aiNarrativeAttemptsExhausted(state, 'evening-wrap', TEST_DATE), true)
})

// ─── A no-provider wrap still renders complete deterministic scenes ──────────

test('without a model, every planned scene renders its deterministic line', () => {
  const payload = workingDayPayload()
  const facts = buildDayWrapFacts(payload)
  const narrative = buildFallbackNarrative(facts, 'hash')
  assert.equal(narrative.source, 'fallback')
  for (const spec of planDayWrapSlides(facts)) {
    const line = resolveSlideLine(spec, narrative.lines)
    assert.ok(line.trim().length > 0, `slide "${spec.id}" renders without a model`)
    assert.equal(line, spec.fallbackLine, `slide "${spec.id}" shows its deterministic line`)
  }
})

// ─── A settled completed day regenerates once instead of reconciling forever ─
// Registers a provider stub, so it must stay the LAST test in this file.

test('an in-app open of a drifted wrap for a COMPLETED day regenerates from full facts', async () => {
  const { registerWrappedNarrativeProvider } = await import('../src/main/services/wrappedNarrative.ts')
  const settingsStub = await import('./support/settings-stub.mjs')
  await settingsStub.setApiKey('anthropic', 'test-key')
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    const payload = workingDayPayload() // TEST_DATE is in the past
    putStoredWrappedNarrative(db, 'day', TEST_DATE, storedNarrative(), 'stale-hash', Date.parse('2026-04-22T10:38:00'))

    let providerCalls = 0
    registerWrappedNarrativeProvider(async () => {
      providerCalls += 1
      const facts = buildDayWrapFacts(payload)
      const lines: Record<string, string> = {}
      for (const spec of planDayWrapSlides(facts)) {
        if (spec.ask) lines[spec.id] = `The ${spec.id.replace(/[^a-z]/gi, ' ')} beat of the day held steady and real.`
      }
      return {
        text: JSON.stringify({ lines, question: null, reflection: null }),
        config: { model: 'test-model' },
      } as never
    })

    const narrative = await getWrappedNarrative(payload)
    assert.ok(providerCalls >= 1, 'a completed drifted day regenerates instead of reconciling')
    assert.notEqual(narrative.lead, STORED_LEAD, 'the mid-day snapshot is replaced, not re-grounded')
    const callsAfterFirstOpen = providerCalls

    const stored = getStoredWrappedNarrative<AIWrappedNarrative>(db, 'day', TEST_DATE)
    const currentHash = computeFactsHash(buildDayWrapFacts(payload), resolveDayEnrichment(db, TEST_DATE))
    assert.equal(stored?.factsHash, currentHash, 'the regenerated wrap is persisted under the current facts hash')

    const second = await getWrappedNarrative(payload)
    assert.equal(providerCalls, callsAfterFirstOpen, 'the regenerated wrap is served from the store afterwards')
    assert.equal(second.lead, narrative.lead)
  } finally {
    await settingsStub.clearApiKey('anthropic')
    clearTestDb()
    db.close()
  }
})
