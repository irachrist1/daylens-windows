// Evidence coverage for factual answer claims (WO-53 / AC-AIA-002.1, .2, .3).
//
// The AI Agent blueprint's ADR-004 binds citations to the exchange evidence
// record, and closes by naming what was still missing: "Broader claim coverage
// and hard enforcement remain required for every factual assertion, not only
// marker-formatted claims." contextCitations covers the marker-formatted half.
// This module covers the rest: it reads the factual claims out of a finished
// answer, binds each one that the exchange can back to the evidence item that
// backs it, and reports the ones nothing backs so the answer can say so.
//
// The evidence index is built ONLY from this exchange: the turn's own recorded
// context packet, the turn's own tool results, and the turn's own computed
// facts. That is AC-AIA-002.3 by construction rather than by filtering. The
// system prompt, the provider configuration, the API key, and every earlier
// message in the thread are simply never offered to this module, so there is
// no path by which inspection could surface them.
import type { ContextPacket } from '../services/contextPacket'
import type { DeterministicFact, DeterministicFactKind } from './deterministicFacts'
import type { SubjectedNumber } from './factClaims'
import { extractNamedEntities } from '../ai/citations'
import { countSubjectPattern } from './deterministicFacts'
import {
  durationSecondsOf,
  scanClockTimes,
  scanDurations,
  scanIntegers,
  scanIsoDates,
  scanSubjectedNumbers,
} from './factClaims'

/** A stated duration within this much of an evidence figure is that figure. */
const DURATION_TOLERANCE_SECONDS = 60

export type EvidenceEntryKind = 'packet' | 'tool' | 'computed'

/** One inspectable thing this exchange actually saw. */
export interface ExchangeEvidenceEntry {
  /** Packet identity, `tool:<name>#<n>`, or a computed fact's identity. */
  identity: string
  kind: EvidenceEntryKind
  /** What a citation to this entry resolves to, in plain language. */
  statement: string
  /** Lowercased searchable text. Never leaves this module. */
  haystack: string
  /** Durations this entry states outright: as prose ("3h 12m"), or as a number
   *  under a label that names its unit ("totalSeconds": 11520). This is what a
   *  repair may treat as a figure the model quoted rather than produced. */
  durationSeconds: number[]
  /** Every reading of this entry's bare integers as a duration, on top of the
   *  stated ones. Deciding whether to hedge a figure is the opposite trade from
   *  deciding whether to repair one: a reading missed here staples a false
   *  caveat onto a grounded answer, so this side stays generous. */
  possibleDurationSeconds: number[]
  /** Every count this entry asserts, each kept with the subject its own source
   *  named it for, so an unrelated integer cannot stand in for a count of the
   *  thing at issue. Precomputed so a lookup never rescans a tool payload that
   *  can run to tens of thousands of characters. */
  counts: SubjectedNumber[]
}

export interface ExchangeEvidence {
  entries: ExchangeEvidenceEntry[]
}

export interface BuildExchangeEvidenceInput {
  /** This turn's recorded packet. */
  packet: ContextPacket | null
  /** This turn's tool trace: name plus the JSON output already truncated for
   *  persistence, exactly as the trace stores it. */
  toolTrace: ReadonlyArray<{ tool: string; output: string; failed?: boolean }>
  /** This turn's computed facts. */
  deterministic?: readonly DeterministicFact[]
}

interface EvidenceFigures {
  durationSeconds: number[]
  possibleDurationSeconds: number[]
  counts: SubjectedNumber[]
}

/** The figures one evidence entry asserts. A figure written as prose ("3h 12m")
 *  and the same figure written as a labelled number ("totalSeconds": 11520) are
 *  the same assertion, so both readings are indexed. A number its source gave no
 *  unit is not a stated duration, only a possible one. */
function figuresIn(text: string): EvidenceFigures {
  const seconds = new Set<number>()
  for (const match of scanDurations(text)) seconds.add(match.seconds)
  const counts: SubjectedNumber[] = []
  for (const entry of scanSubjectedNumbers(text)) {
    const duration = durationSecondsOf(entry)
    if (duration == null) counts.push(entry)
    else seconds.add(duration)
  }
  const possible = new Set(seconds)
  for (const value of scanIntegers(text)) {
    possible.add(value)
    possible.add(value * 60)
  }
  return { durationSeconds: [...seconds], possibleDurationSeconds: [...possible], counts }
}

/**
 * The exchange's evidence index. Built from the turn's own packet, tool
 * results, and computed facts, and from nothing else.
 */
export function buildExchangeEvidence(input: BuildExchangeEvidenceInput): ExchangeEvidence {
  const entries: ExchangeEvidenceEntry[] = []

  for (const item of input.packet?.items ?? []) {
    entries.push({
      identity: item.identity,
      kind: 'packet',
      statement: item.statement,
      haystack: item.statement.toLowerCase(),
      ...figuresIn(item.statement),
    })
  }

  input.toolTrace.forEach((entry, index) => {
    // A failed call proves nothing. Indexing its error payload as evidence
    // would let "tool error" text accidentally back a claim.
    if (entry.failed) return
    entries.push({
      identity: `tool:${entry.tool}#${index + 1}`,
      kind: 'tool',
      statement: `${entry.tool} returned this result`,
      haystack: entry.output.toLowerCase(),
      ...figuresIn(entry.output),
    })
  })

  for (const fact of input.deterministic ?? []) {
    const figures = figuresIn(fact.statement)
    // A computed fact asserts its own value in its own dimension, whatever the
    // prose of its statement happens to read as.
    entries.push({
      identity: fact.identity,
      kind: 'computed',
      statement: fact.statement,
      haystack: fact.statement.toLowerCase(),
      durationSeconds: fact.dimension === 'duration'
        ? [fact.value, ...figures.durationSeconds]
        : figures.durationSeconds,
      possibleDurationSeconds: fact.dimension === 'duration'
        ? [fact.value, ...figures.possibleDurationSeconds]
        : figures.possibleDurationSeconds,
      counts: fact.dimension === 'count'
        ? [{ value: fact.value, subject: fact.subject.toLowerCase() }, ...figures.counts]
        : figures.counts,
    })
  }

  return { entries }
}

/**
 * Does anything in this exchange assert a figure of this value? Durations are
 * given in seconds, counts as whole numbers. The deterministic enforcer uses
 * this to tell a figure the model quoted from evidence (leave it alone) from a
 * figure the model produced itself (the claim actually at issue).
 *
 * A count also needs the kind of count being checked, because a number only
 * backs it when the source attached that number to the same thing: a retry
 * count of 6 is not evidence that six apps were used. Without a kind no count
 * is backed, so the stated figure is treated as the model's own.
 */
export function evidenceBacksValue(
  evidence: ExchangeEvidence,
  value: number,
  dimension: 'duration' | 'count',
  kind?: DeterministicFactKind,
): boolean {
  if (dimension === 'duration') {
    return evidence.entries.some((entry) => entry.durationSeconds
      .some((candidate) => Math.abs(candidate - value) <= DURATION_TOLERANCE_SECONDS))
  }
  const subject = kind ? countSubjectPattern(kind) : null
  if (!subject) return false
  // A count is only backed by the exact integer, never by a near miss.
  return evidence.entries.some((entry) => entry.counts
    .some((candidate) => candidate.value === value && subject.test(candidate.subject)))
}

export type FactualClaimKind = 'duration' | 'clock_time' | 'date' | 'entity'

export interface FactualClaim {
  kind: FactualClaimKind
  /** The claim as the answer stated it. */
  text: string
  /** Seconds, for a duration claim. */
  seconds?: number
}

/**
 * The factual claims in an answer: stated durations, clock times, calendar
 * dates, and named entities. Entity extraction reuses the existing narrow
 * extractor rather than adding a second, looser idea of what a named thing is.
 */
export function extractFactualClaims(text: string): FactualClaim[] {
  const claims: FactualClaim[] = []
  if (!text) return claims
  const seen = new Set<string>()
  const add = (claim: FactualClaim) => {
    const key = `${claim.kind}:${claim.text.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    claims.push(claim)
  }
  for (const match of scanDurations(text)) add({ kind: 'duration', text: match.text, seconds: match.seconds })
  for (const clock of scanClockTimes(text)) add({ kind: 'clock_time', text: clock })
  for (const date of scanIsoDates(text)) add({ kind: 'date', text: date })
  for (const entity of extractNamedEntities(text)) add({ kind: 'entity', text: entity })
  return claims
}

/** A claim and the evidence item it traces to. */
export interface SupportedClaim {
  claim: FactualClaim
  identity: string
  kind: EvidenceEntryKind
  statement: string
}

export interface EvidenceCoverage {
  supported: SupportedClaim[]
  unsupported: FactualClaim[]
}

function backs(entry: ExchangeEvidenceEntry, claim: FactualClaim): boolean {
  if (claim.kind === 'duration') {
    const seconds = claim.seconds ?? -1
    return entry.possibleDurationSeconds.some((value) => Math.abs(value - seconds) <= DURATION_TOLERANCE_SECONDS)
  }
  return entry.haystack.includes(claim.text.toLowerCase())
}

/**
 * Bind every claim the exchange can back to the item that backs it, and report
 * the rest. A supported claim's identity is the association AC-AIA-002.1 asks
 * for; the unsupported list is what AC-AIA-002.2 makes the answer admit.
 */
export function assessEvidenceCoverage(
  claims: readonly FactualClaim[],
  evidence: ExchangeEvidence,
): EvidenceCoverage {
  const supported: SupportedClaim[] = []
  const unsupported: FactualClaim[] = []
  for (const claim of claims) {
    const entry = evidence.entries.find((candidate) => backs(candidate, claim))
    if (entry) {
      supported.push({ claim, identity: entry.identity, kind: entry.kind, statement: entry.statement })
    } else {
      unsupported.push(claim)
    }
  }
  return { supported, unsupported }
}

// Answers that already admit a limit must not be given a second, clumsier
// admission stapled underneath.
const ALREADY_UNCERTAIN = /\b(?:cannot back|could not back|not backed|no record of|nothing captured|not captured|uncertain|could not tell|no evidence)\b/i

/**
 * State the specific uncertainty (AC-AIA-002.2). Only figures get an explicit
 * line: a duration or a count the person will act on is worth one honest
 * sentence, while naming every unmatched word would bury a good answer in
 * hedging and read as the machinery talking about itself.
 *
 * Wording follows the voice contract: plain, specific, no em dash, and not a
 * bare refusal, because it rides underneath an answer that already said what
 * the evidence does show.
 */
export function applyUnsupportedFactDisclosure(
  text: string,
  unsupported: readonly FactualClaim[],
): { text: string; disclosed: string[] } {
  const figures = unsupported.filter((claim) => claim.kind === 'duration').map((claim) => claim.text)
  if (!text || figures.length === 0 || ALREADY_UNCERTAIN.test(text)) return { text, disclosed: [] }
  const named = figures.slice(0, 3)
  const list = named.length === 1
    ? named[0]
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  const noun = named.length === 1 ? 'figure' : 'figures'
  const verb = named.length === 1 ? 'is' : 'are'
  return {
    text: `${text.trimEnd()}\n\nOne caveat: the ${noun} ${list} ${verb} not backed by anything Daylens captured, so treat that as uncertain rather than measured.`,
    disclosed: named,
  }
}
