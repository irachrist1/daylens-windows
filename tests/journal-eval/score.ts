// Deterministic scorers for the journal-anchored day eval. Pure functions
// over the day's ground truth and what Daylens actually rendered — no DB, no
// provider, so they are unit-testable and run in the fast loop.

import { isDisqualifiedWorkSubject } from '../../src/shared/workNameGuards'
import type { DayScore, DimensionScore, EvalDay } from './schema'

export interface ObservedDay {
  /** User-visible label per block, in time order. */
  blockLabels: string[]
  /** Block clock bounds in epoch ms, matching blockLabels order. */
  blockBounds: Array<{ startMs: number; endMs: number }>
  /** Per-block AI narratives (may be empty strings). */
  blockNarratives: string[]
  wrappedLead: string | null
  wrappedLines: string[]
  blockCount: number
  trackedSeconds: number
}

/** Every string the user actually reads for this day. */
function visibleCorpus(observed: ObservedDay): string {
  return [
    ...observed.blockLabels,
    ...observed.blockNarratives,
    observed.wrappedLead ?? '',
    ...observed.wrappedLines,
  ].join('\n').toLowerCase()
}

export function scorePrimaryWork(day: EvalDay, observed: ObservedDay): DimensionScore {
  const corpus = visibleCorpus(observed)
  const violations: string[] = []
  let named = 0
  for (const work of day.primaryWork) {
    const hit = work.aliases.some((alias) => corpus.includes(alias.toLowerCase()))
    if (hit) named += 1
    else violations.push(`primary work never named anywhere visible: ${work.name} (aliases: ${work.aliases.join(', ')})`)
  }
  return { score: named, max: day.primaryWork.length, violations }
}

export function scoreToolSurfaces(day: EvalDay, observed: ObservedDay): DimensionScore {
  const violations: string[] = []
  const banned = (day.bannedAsWork ?? []).map((b) => b.toLowerCase())
  for (const label of observed.blockLabels) {
    if (isDisqualifiedWorkSubject(label)) {
      violations.push(`block label is a tool surface, not work: "${label}"`)
      continue
    }
    const lower = label.toLowerCase()
    const bannedHit = banned.find((b) => lower.includes(b))
    if (bannedHit) violations.push(`block label matches banned-as-work "${bannedHit}": "${label}"`)
  }
  // Wrapped prose gets the substring check only — full sentences legitimately
  // mention tools ("driving Claude in Slack"), so isDisqualifiedWorkSubject
  // (built for labels) would misfire there.
  for (const line of [observed.wrappedLead ?? '', ...observed.wrappedLines]) {
    const lower = line.toLowerCase()
    const bannedHit = banned.find((b) => lower.includes(b))
    if (bannedHit) violations.push(`wrapped line presents banned-as-work "${bannedHit}": "${line.slice(0, 90)}"`)
  }
  // score = blocks with clean labels
  const clean = observed.blockLabels.length - violations.filter((v) => v.startsWith('block label')).length
  return { score: Math.max(0, clean), max: Math.max(1, observed.blockLabels.length), violations }
}

function parseClock(date: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const base = new Date(`${date}T00:00:00`)
  base.setHours(h, m, 0, 0)
  return base.getTime()
}

export function scoreGapHonesty(day: EvalDay, observed: ObservedDay): DimensionScore {
  const gaps = day.gaps ?? []
  if (gaps.length === 0) return { score: 1, max: 1, violations: [] }
  const violations: string[] = []
  const TOLERANCE_MS = 20 * 60_000
  for (const gap of gaps) {
    // Gap times are owned-day local clock. A gap whose end precedes its start
    // crosses midnight ("22:00"–"01:30" = late night into the owned day's
    // spill-over); an early-morning gap on the owned day itself is written in
    // plain order ("01:30"–"12:00").
    const gapStart = parseClock(day.date, gap.from)
    let gapEnd = parseClock(day.date, gap.to)
    if (gapEnd <= gapStart) gapEnd += 24 * 3_600_000
    for (let i = 0; i < observed.blockBounds.length; i += 1) {
      const block = observed.blockBounds[i]
      if (block.startMs < gapStart - TOLERANCE_MS && block.endMs > gapEnd + TOLERANCE_MS) {
        violations.push(
          `block "${observed.blockLabels[i]}" spans the ${gap.from}–${gap.to} off-computer gap (${gap.reason ?? 'declared gap'})`,
        )
      }
    }
  }
  return { score: violations.length === 0 ? 1 : 0, max: 1, violations }
}

export function scoreDay(day: EvalDay, observed: ObservedDay): DayScore {
  return {
    date: day.date,
    confidence: day.confidence,
    primaryWork: scorePrimaryWork(day, observed),
    toolSurfaces: scoreToolSurfaces(day, observed),
    gapHonesty: scoreGapHonesty(day, observed),
    observed: {
      blockLabels: observed.blockLabels,
      wrappedLead: observed.wrappedLead,
      wrappedLines: observed.wrappedLines,
      blockCount: observed.blockCount,
      trackedSeconds: observed.trackedSeconds,
    },
  }
}
