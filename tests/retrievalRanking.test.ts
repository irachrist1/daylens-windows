// WO-7 / REQ-SM-003: the ranking rules as arithmetic.
//
// These are the two claims the planner's order rests on, isolated from the
// database so they cannot be masked by fixture luck:
//   1. the signal set is closed and carries no behavioral judgment (AC-SM-003.4);
//   2. an exact date or entity match is never overtaken by a newer non-match,
//      at any recency gap (AC-SM-003.3).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RANKING_SCORE,
  RANKING_SIGNAL_KEYS,
  RANKING_WEIGHTS,
  compareRanked,
  emptySignals,
  isMatchedTier,
  scoreSignals,
  type RankableResult,
  type RankingSignals,
} from '../src/main/services/retrievalRanking.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function rankable(signals: Partial<RankingSignals>, startTime: number): RankableResult {
  const full = { ...emptySignals(), ...signals }
  return { signals: full, score: scoreSignals(full), startTime }
}

test('the signal set is exactly the nine factors AC-SM-003.2 names', () => {
  assert.deepEqual([...RANKING_SIGNAL_KEYS].sort(), [
    'confirmedRelationship',
    'corroboration',
    'entityMatch',
    'exactLexical',
    'explicitCorrection',
    'queryImpliedRecency',
    'semanticSimilarity',
    'sourceQuality',
    'timeRangeFit',
  ])
  assert.equal(RANKING_SIGNAL_KEYS.length, 9)
  // The keys of the weight table and the signal record cannot drift apart.
  assert.deepEqual(Object.keys(RANKING_WEIGHTS).sort(), [...RANKING_SIGNAL_KEYS].sort())
  assert.deepEqual(Object.keys(emptySignals()).sort(), [...RANKING_SIGNAL_KEYS].sort())
})

test('AC-SM-003.4: no productivity, focus, or behavioral signal is a ranking input', () => {
  // "quality" is deliberately absent: AC-SM-003.2 *requires* source quality as
  // a factor. What AC-SM-003.4 forbids is judgment about how the person spent
  // their time, not judgment about how good a record's provenance is.
  const forbidden = [
    'productivity', 'productive', 'focus', 'focused', 'distraction', 'distracted',
    'behaviour', 'behavior', 'idle', 'efficiency', 'streak', 'wasted', 'goal',
  ]
  for (const key of RANKING_SIGNAL_KEYS) {
    const lowered = key.toLowerCase()
    for (const term of forbidden) {
      assert.ok(
        !lowered.includes(term),
        `ranking signal "${key}" reads as a ${term} judgment, which AC-SM-003.4 forbids`,
      )
    }
  }
})

test('every weight is positive and the score is bounded by the weight total', () => {
  for (const key of RANKING_SIGNAL_KEYS) {
    assert.ok(RANKING_WEIGHTS[key] > 0, `${key} must carry weight`)
  }
  assert.equal(scoreSignals(emptySignals()), 0)

  const saturated = Object.fromEntries(
    RANKING_SIGNAL_KEYS.map((key) => [key, 1]),
  ) as unknown as RankingSignals
  assert.equal(scoreSignals(saturated), MAX_RANKING_SCORE)

  // Out-of-range signals clamp rather than blowing past the ceiling.
  const overflowing = Object.fromEntries(
    RANKING_SIGNAL_KEYS.map((key) => [key, 99]),
  ) as unknown as RankingSignals
  assert.equal(scoreSignals(overflowing), MAX_RANKING_SCORE)
})

test('AC-SM-003.3: an exact match outranks a newer non-match at every recency gap', () => {
  // The matched result is deliberately weak on every other signal, and the
  // newer one deliberately strong, so only the tier rule can carry it.
  const matched = rankable({ timeRangeFit: 1 }, Date.UTC(2026, 0, 1))
  const gaps = [1, 7, 30, 365, 365 * 5]

  for (const days of gaps) {
    const newer = rankable(
      {
        exactLexical: 1,
        semanticSimilarity: 1,
        sourceQuality: 1,
        corroboration: 1,
        queryImpliedRecency: 1,
        confirmedRelationship: 1,
        explicitCorrection: 1,
      },
      matched.startTime + days * DAY_MS,
    )
    assert.ok(
      newer.score > matched.score,
      `fixture check: the newer result should out-score the matched one at ${days}d`,
    )
    assert.ok(
      compareRanked(matched, newer) < 0,
      `a non-matching result ${days} days newer must not outrank an exact match`,
    )
    assert.ok(compareRanked(newer, matched) > 0, 'the comparator must be antisymmetric')
  }
})

test('an exact entity match is tiered the same way as an exact date match', () => {
  const matched = rankable({ entityMatch: 1 }, Date.UTC(2025, 0, 1))
  const newer = rankable({ exactLexical: 1, queryImpliedRecency: 1 }, Date.UTC(2026, 0, 1))
  assert.ok(isMatchedTier(matched.signals))
  assert.ok(!isMatchedTier(newer.signals))
  assert.ok(compareRanked(matched, newer) < 0)
})

test('a partial time-range overlap does not reach the matched tier', () => {
  // Only an exact fit earns the tier; a result that merely brushes the range
  // stays in the ordinary weighted order.
  assert.ok(!isMatchedTier({ ...emptySignals(), timeRangeFit: 0.5 }))
  assert.ok(isMatchedTier({ ...emptySignals(), timeRangeFit: 1 }))
})

test('inside a tier, recency orders results', () => {
  const older = rankable({ entityMatch: 1, exactLexical: 0.5 }, Date.UTC(2026, 0, 1))
  const newer = rankable({ entityMatch: 1, exactLexical: 0.5 }, Date.UTC(2026, 5, 1))
  assert.equal(older.score, newer.score)
  assert.ok(compareRanked(newer, older) < 0, 'the newer of two equal matches sorts first')

  const unmatchedOld = rankable({ exactLexical: 0.5 }, Date.UTC(2026, 0, 1))
  const unmatchedNew = rankable({ exactLexical: 0.5 }, Date.UTC(2026, 5, 1))
  assert.ok(compareRanked(unmatchedNew, unmatchedOld) < 0)
})

test('independent corroboration raises an otherwise identical result', () => {
  const single = rankable({ exactLexical: 0.8 }, 1_700_000_000_000)
  const corroborated = rankable({ exactLexical: 0.8, corroboration: 1 }, 1_700_000_000_000)
  assert.ok(corroborated.score > single.score)
  assert.ok(compareRanked(corroborated, single) < 0)
})

test('sorting a mixed set puts every match above every non-match', () => {
  const results = [
    rankable({ exactLexical: 1, queryImpliedRecency: 1 }, Date.UTC(2026, 7, 10)),
    rankable({ timeRangeFit: 1 }, Date.UTC(2024, 2, 3)),
    rankable({ semanticSimilarity: 0.9 }, Date.UTC(2026, 7, 11)),
    rankable({ entityMatch: 1, exactLexical: 0.4 }, Date.UTC(2025, 1, 1)),
  ].sort(compareRanked)

  const tiers = results.map((result) => isMatchedTier(result.signals))
  assert.deepEqual(tiers, [true, true, false, false])
})
