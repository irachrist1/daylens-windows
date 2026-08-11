// Deterministic scorers for the journal-anchored day eval. Pure functions
// over the day's ground truth and what Daylens actually rendered — no DB, no
// provider, so they are unit-testable and run in the fast loop.

import { isDisqualifiedWorkSubject } from '../../src/shared/workNameGuards'
import { recapVoiceFindings } from '../../src/shared/labelVoice'
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
  /** The day recap, when the run generated one (DEV-292). Null in the fast
   *  loop: unlike wrapped, the recap has no stored artifact to read, so
   *  scoring it costs a provider call and is opt-in. */
  recap: string | null
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
    observed.recap ?? '',
  ].join('\n').toLowerCase()
}

/** The recap's prose against the voice contract. Deterministic: generating a
 *  recap needs a provider, scoring one does not. A day with no recap scores
 *  1/1 rather than 0 — an ungenerated recap is not a voice failure. */
export function scoreRecapVoice(observed: ObservedDay): DimensionScore {
  if (!observed.recap) return { score: 1, max: 1, violations: [] }
  const findings = recapVoiceFindings(observed.recap)
  return {
    score: findings.length === 0 ? 1 : 0,
    max: 1,
    violations: findings.map((finding) => `recap voice: "${finding.phrase}" — ${finding.reason}`),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Alias hits require word boundaries — bare substring matching lets 'ml'
 *  match 'html' and 'alu' match 'evaluate'. */
function aliasHits(corpus: string, alias: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(alias.toLowerCase())}(?:[^a-z0-9]|$)`).test(corpus)
}

export function scorePrimaryWork(day: EvalDay, observed: ObservedDay): DimensionScore {
  const corpus = visibleCorpus(observed)
  const violations: string[] = []
  let named = 0
  for (const work of day.primaryWork) {
    const hit = work.aliases.some((alias) => aliasHits(corpus, alias))
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
  // Generated prose gets the substring check only — full sentences legitimately
  // mention tools ("driving Claude in Slack"), so isDisqualifiedWorkSubject
  // (built for labels) would misfire there. The recap is prose on the same
  // footing as a wrapped line (DEV-292): both are sentences a person reads
  // about their day, and neither may present a banned surface as the work.
  const proseLines: Array<{ kind: string; text: string }> = [
    ...[observed.wrappedLead ?? '', ...observed.wrappedLines]
      .filter((l) => l.trim())
      .map((text) => ({ kind: 'wrapped line', text })),
    ...(observed.recap?.trim() ? [{ kind: 'recap', text: observed.recap }] : []),
  ]
  let dirtyProseLines = 0
  for (const line of proseLines) {
    const lower = line.text.toLowerCase()
    const bannedHit = banned.find((b) => lower.includes(b))
    if (bannedHit) {
      dirtyProseLines += 1
      violations.push(`${line.kind} presents banned-as-work "${bannedHit}": "${line.text.slice(0, 90)}"`)
    }
  }
  // Every user-visible unit counts: block labels AND generated prose. A day the
  // user never opened (zero blocks, zero lines) is vacuously clean, not dirty.
  const units = observed.blockLabels.length + proseLines.length
  if (units === 0) return { score: 1, max: 1, violations }
  const clean = units - violations.filter((v) => v.startsWith('block label')).length - dirtyProseLines
  return { score: Math.max(0, clean), max: units, violations }
}

function parseClock(date: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) {
    throw new Error(`Bad gap clock "${hhmm}" — HH:MM, 00:00–23:59`)
  }
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
    recapVoice: scoreRecapVoice(observed),
    observed: {
      blockLabels: observed.blockLabels,
      wrappedLead: observed.wrappedLead,
      wrappedLines: observed.wrappedLines,
      recap: observed.recap,
      blockCount: observed.blockCount,
      trackedSeconds: observed.trackedSeconds,
    },
  }
}
