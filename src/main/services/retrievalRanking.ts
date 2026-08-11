// The scoring core of the unified retrieval planner (WO-7, REQ-SM-003).
//
// Kept free of the database and of every retrieval path so the ranking rules
// are testable as arithmetic. `retrievalPlanner.ts` turns rows into signals;
// this file turns signals into an order.
//
// Two rules here are contracts, not tuning:
//
//   1. `RankingSignals` is closed. AC-SM-003.4 forbids productivity, focus, and
//      behavioral judgments as ranking inputs, and the only durable way to hold
//      that line is a type that cannot express them plus a test over its keys.
//   2. Ranking is tiered, not a single weighted sum. See `isMatchedTier`.

/** The nine factors AC-SM-003.2 names, each normalized to 0..1. */
export interface RankingSignals {
  /** Strength of exact word/phrase overlap between query and result text. */
  exactLexical: number
  /** Cosine similarity when the result came from semantic retrieval. */
  semanticSimilarity: number
  /** The result is tagged with an entity the query resolved to. */
  entityMatch: number
  /** How well the result sits inside the requested time range. */
  timeRangeFit: number
  /** Canonical corrected memory outranks a legacy raw-capture row. */
  sourceQuality: number
  /** The result carries an explicit correction the person made. */
  explicitCorrection: number
  /** The result rests on a confirmed relationship rather than an inferred one. */
  confirmedRelationship: number
  /** Recency, and only when the query implies it. */
  queryImpliedRecency: number
  /** More than one retrieval path independently produced this result. */
  corroboration: number
}

export const RANKING_SIGNAL_KEYS = [
  'exactLexical',
  'semanticSimilarity',
  'entityMatch',
  'timeRangeFit',
  'sourceQuality',
  'explicitCorrection',
  'confirmedRelationship',
  'queryImpliedRecency',
  'corroboration',
] as const satisfies readonly (keyof RankingSignals)[]

export const RANKING_WEIGHTS: Readonly<Record<keyof RankingSignals, number>> = {
  exactLexical: 3,
  semanticSimilarity: 2,
  entityMatch: 3,
  timeRangeFit: 2,
  sourceQuality: 1.5,
  explicitCorrection: 1.5,
  confirmedRelationship: 1,
  queryImpliedRecency: 1,
  corroboration: 1.5,
}

export const MAX_RANKING_SCORE = Object.values(RANKING_WEIGHTS)
  .reduce((total, weight) => total + weight, 0)

export function emptySignals(): RankingSignals {
  return {
    exactLexical: 0,
    semanticSimilarity: 0,
    entityMatch: 0,
    timeRangeFit: 0,
    sourceQuality: 0,
    explicitCorrection: 0,
    confirmedRelationship: 0,
    queryImpliedRecency: 0,
    corroboration: 0,
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** Weighted sum over the nine signals. Bounded by `MAX_RANKING_SCORE`. */
export function scoreSignals(signals: RankingSignals): number {
  let total = 0
  for (const key of RANKING_SIGNAL_KEYS) {
    total += clamp01(signals[key]) * RANKING_WEIGHTS[key]
  }
  return total
}

/**
 * AC-SM-003.3: a result that exactly matches the requested date or a resolved
 * entity must never be ranked below a more recent non-matching result "solely
 * because it is newer".
 *
 * A weighted sum cannot promise that. Recency has to carry *some* weight for
 * the ordinary undated query, and for any positive weight there is a recency
 * gap wide enough to overturn an exact match — so the guarantee would hold for
 * the cases a test happened to pick and fail silently elsewhere. Splitting the
 * order into two tiers makes it structural: everything that matched sorts above
 * everything that did not, and recency only ever moves a result within its own
 * tier.
 */
export function isMatchedTier(signals: RankingSignals): boolean {
  return signals.entityMatch >= 1 || signals.timeRangeFit >= 1
}

export interface RankableResult {
  signals: RankingSignals
  score: number
  startTime: number
}

/** Tier first, then score, then recency as the in-tier tiebreak. */
export function compareRanked(left: RankableResult, right: RankableResult): number {
  const leftTier = isMatchedTier(left.signals) ? 1 : 0
  const rightTier = isMatchedTier(right.signals) ? 1 : 0
  if (leftTier !== rightTier) return rightTier - leftTier
  if (left.score !== right.score) return right.score - left.score
  return right.startTime - left.startTime
}
