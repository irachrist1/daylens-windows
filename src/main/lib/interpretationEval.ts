// Offline interpretation evaluation (DEV-206 / agent-runtime-and-context.md).
// The interpretation agent — the packet-based runtime behind
// interpretationAgentEnabled, with the direct regroup/relabel pipeline as
// the floor — may only write product state if a run over representative-day
// fixtures upholds the interpretation invariants. This module is that gate:
// pure scoring of a before/after pair, no DB, no AI, so the fixture eval runs
// hermetically in CI and locally before any rollout.
//
// The invariants scored here are the spec's, not style preferences:
// - A person's correction outranks every automated inference (information
//   authority #1): corrected labels survive every reprocessing verbatim.
// - Interpretation proposes over evidence, it never destroys it: the day's
//   observed time is identical before and after.
// - A real absence is a hard boundary: no proposed block spans one.
// - The regroup only ever merges same-intent neighbours: fewer, truer blocks,
//   never more.
// - Proposed labels stay human (the voice-contract floor): non-empty, no raw
//   paths/branches/ids leaking into prose.
//
// The live switch (`interpretationAgentEnabled`) routes low-confidence
// relabels through the packet-based runtime. This eval is the write gate
// analyzeDay applies before any agent label persists.

import type { AppSettings, DayTimelinePayload } from '@shared/types'
import { blockActiveSeconds } from '@shared/blockDuration'
import { absenceSpannedBy, formatAbsenceRange } from './absenceGuard'
import { findRawArtifactLeak } from './wrapNarrativeShared'

/** True when the packet-based interpretation agent is switched on. */
export function interpretationAgentEnabled(
  settings: Pick<AppSettings, 'interpretationAgentEnabled'>,
): boolean {
  return settings.interpretationAgentEnabled === true
}

export interface InterpretationExpectations {
  /** Labels the person explicitly corrected — each must survive verbatim
   *  among the after-run block labels (correction precedence, authority #1). */
  correctedLabels?: string[]
  /** Optional ceiling from the accepted fixture reconstruction: the run must
   *  produce at most this many non-live blocks. */
  maxBlocks?: number
}

export interface InterpretationEvalViolation {
  rule:
    | 'correction-overwritten'
    | 'evidence-changed'
    | 'absence-spanned'
    | 'blocks-multiplied'
    | 'label-unusable'
  detail: string
}

export interface InterpretationEvalReport {
  pass: boolean
  violations: InterpretationEvalViolation[]
  /** Observed seconds before/after, for the fixture log. */
  observedSecondsBefore: number
  observedSecondsAfter: number
  blocksBefore: number
  blocksAfter: number
}

// Interpretation must not create or destroy observed time. Rounding at block
// boundaries can wobble a rebuild by a few seconds; a real minute is a leak.
const EVIDENCE_TOLERANCE_SECONDS = 60

function persistedBlocks(payload: DayTimelinePayload) {
  return payload.blocks.filter((block) => !block.isLive)
}

/** Score one interpretation run (before payload → after payload) against the
 *  interpretation invariants and the fixture's accepted expectations. */
export function evaluateInterpretationRun(input: {
  before: DayTimelinePayload
  after: DayTimelinePayload
  expectations?: InterpretationExpectations
}): InterpretationEvalReport {
  const violations: InterpretationEvalViolation[] = []
  const before = persistedBlocks(input.before)
  const after = persistedBlocks(input.after)

  // 1. Corrections survive verbatim.
  const afterLabels = new Set(after.map((block) => block.label.current.trim()))
  for (const corrected of input.expectations?.correctedLabels ?? []) {
    if (!afterLabels.has(corrected.trim())) {
      violations.push({
        rule: 'correction-overwritten',
        detail: `the corrected label "${corrected}" no longer exists after the run; a person's correction outranks every automated inference`,
      })
    }
  }

  // 2. Evidence preserved: same observed time in, same observed time out.
  const secondsBefore = Math.round(before.reduce((sum, block) => sum + blockActiveSeconds(block), 0))
  const secondsAfter = Math.round(after.reduce((sum, block) => sum + blockActiveSeconds(block), 0))
  if (Math.abs(secondsBefore - secondsAfter) > EVIDENCE_TOLERANCE_SECONDS) {
    violations.push({
      rule: 'evidence-changed',
      detail: `observed time moved from ${secondsBefore}s to ${secondsAfter}s; interpretation proposes over evidence, it never creates or destroys it`,
    })
  }

  // 3. No proposed block spans a real absence.
  for (const block of after) {
    if (block.provisional || block.sessions.length < 2) continue
    const gap = absenceSpannedBy(block.sessions)
    if (gap) {
      violations.push({
        rule: 'absence-spanned',
        detail: `block "${block.label.current}" spans a real absence (${formatAbsenceRange(gap)}); an absence is a hard boundary`,
      })
    }
  }

  // 4. Regroup only merges: fewer, truer blocks, never more.
  if (after.length > before.length) {
    violations.push({
      rule: 'blocks-multiplied',
      detail: `the run produced ${after.length} blocks from ${before.length}; interpretation may only merge same-intent neighbours`,
    })
  }
  const maxBlocks = input.expectations?.maxBlocks
  if (maxBlocks != null && after.length > maxBlocks) {
    violations.push({
      rule: 'blocks-multiplied',
      detail: `the accepted reconstruction has at most ${maxBlocks} blocks; the run produced ${after.length}`,
    })
  }

  // 5. Labels stay human.
  for (const block of after) {
    const label = block.label.current.trim()
    if (!label) {
      violations.push({ rule: 'label-unusable', detail: `block ${block.id} has an empty label` })
      continue
    }
    const leak = findRawArtifactLeak(label)
    if (leak) {
      violations.push({
        rule: 'label-unusable',
        detail: `block label "${label}" leaks raw technical text (${leak}); proposed names stay human words`,
      })
    }
  }

  return {
    pass: violations.length === 0,
    violations,
    observedSecondsBefore: secondsBefore,
    observedSecondsAfter: secondsAfter,
    blocksBefore: before.length,
    blocksAfter: after.length,
  }
}
