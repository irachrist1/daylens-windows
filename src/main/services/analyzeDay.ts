// One shared "analyze a day" pipeline: AI regroup (merge same-intent
// neighbours) → per-block AI relabel. Both the manual "Analyze" IPC action and
// the automatic day-rollover / startup finalization call THIS function, so
// invariant 3 ("same-intent neighbours merge into one block") is enforced the
// same way whether or not the user clicked a button.
//
// The engine over-splits a real day (a browser switch, a category change starts
// a new heuristic block), so the regroup can only ever make the day FEWER,
// truer blocks. The merge itself rides the durable boundary-correction path
// (timeline_boundary_corrections), so it survives every future rebuild
// (invariant 8). User corrections always win: a user-renamed block is never
// merged away. If the AI provider is unavailable or rate-limited, the regroup
// and relabel fall back cleanly to the heuristic blocks — nothing throws in the
// automatic path.
import type Database from 'better-sqlite3'
import type { LiveSession, WorkContextBlock, WorkContextInsight, DayTimelinePayload, TimelineAnalyzeProgress } from '@shared/types'
import { materializeTimelineDayProjection } from '../core/query/projections'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { dayBoundaryCorrectionAnchors, mergeTimelineEpisodes, shouldReanalyzeBlockWithAI, writeTimelineBlockReview } from './workBlocks'
import { getBlockLabelOverride, setBlockLabelOverride, writeAIBlockLabel } from '../db/queries'
import { generateWorkBlockInsight, generateDayRegroupPlan } from './ai'
import { absenceSpannedBy, formatAbsenceRange, partitionAtRealAbsences } from '../lib/absenceGuard'
import { buildDaySnapshot } from '../lib/daySnapshot'
import { appendDayAnalysisVersion } from '../db/dayAnalysisVersions'
import { evaluateInterpretationRun, interpretationAgentEnabled } from '../lib/interpretationEval'
import { findRawArtifactLeak } from '../lib/wrapNarrativeShared'
import {
  isInterpretationContextPacketFailure,
  runInterpretationAgentRelabel,
  type InterpretationAgentInsight,
} from './interpretationAgent'
import { runExternalSignalBackfill } from './externalSignals'
import { getSettings } from './settings'

export type BlockInsightTrigger = 'user' | 'background' | 'system'

/** Bumped whenever the regroup/relabel analysis semantics change (prompts,
 *  merge rules, absence guard), so a stored analysis version records WHICH
 *  pipeline produced it (DEV-206: reproducible, inspectable versions). */
export const ANALYZE_DAY_PROMPT_VERSION = 1

export interface AnalyzeTimelineDayDeps {
  // A freeform note about what the user actually did (from the wrap flow / the
  // manual Analyze hint). Passed to the model as a strong grounding signal.
  userHint?: string
  // How the day resolves its live session. Past days (the automatic finalize
  // path) have none; the manual path passes the handler's resolver.
  resolveLiveSession?: (dateStr: string) => LiveSession | null
  // Which invocation source to record for the relabel jobs. Manual clicks are
  // 'user'; the automatic finalize path is 'background'.
  triggerSource?: BlockInsightTrigger
  // Whether a total relabel failure should throw (so the manual "Analyze" UI
  // can show an error). The automatic finalize path sets this false: a provider
  // outage there must fall back cleanly to the heuristic blocks, never throw
  // into the scheduler. Default true (manual behaviour).
  surfaceErrors?: boolean
  // Injectable AI calls — real by default, mocked in tests so the suite never
  // reaches a provider.
  regroupPlan?: (
    blocks: WorkContextBlock[],
    opts: { userHint?: string },
  ) => Promise<number[][] | null | undefined>
  blockInsight?: (
    block: WorkContextBlock,
    opts: { jobType: 'block_cleanup_relabel'; triggerSource: BlockInsightTrigger; throwOnError: boolean; userHint?: string },
  ) => Promise<WorkContextInsight>
  // The interpretation-agent turn for one low-confidence block (only consulted
  // when interpretationAgentEnabled is on). Real by default, mocked in tests.
  // Any throw falls back to the direct blockInsight path for that block.
  agentBlockInsight?: (
    block: WorkContextBlock,
    opts: { triggerSource: BlockInsightTrigger; userHint?: string },
  ) => Promise<InterpretationAgentInsight>
  // Streams what the pipeline is actually doing (DEV-270), so the Analyze UI can
  // show real progress instead of a blank spinner. Absent in the automatic path.
  onProgress?: (update: TimelineAnalyzeProgress) => void
}

// How many per-block naming calls run at once. The relabel of one block is
// independent of another (each reads its own evidence, writes its own label), so
// naming an N-block day serially — the DEV-270 latency sink — is pure waste. The
// DB writes are collected after each network call resolves, so nothing races.
const RELABEL_CONCURRENCY = 4

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export interface AnalyzeTimelineDayResult {
  payload: DayTimelinePayload
  changed: boolean
  merged: boolean
  attempted: number
  failures: string[]
  // How many blocks the run actually re-labeled, and how many were absorbed by
  // a merge — so the UI can report what happened ("Re-labeled 3 blocks" /
  // "Already up to date") instead of a fixed success message (DEV-231).
  relabeled: number
  mergedCount: number
}

// Persist an AI label+narrative to a block, preserving user overrides.
function applyAIInsightToTimelineBlock(
  db: Database.Database,
  block: WorkContextBlock,
  insight: WorkContextInsight,
): boolean {
  const label = insight.label?.trim()
  if (!label) {
    throw new Error(`AI did not return a label for block ${block.id}.`)
  }
  const wrote = writeAIBlockLabel(db, {
    blockId: block.id,
    label,
    narrative: insight.narrative ?? null,
  })
  if (!wrote) {
    // A user can rename the block while the AI request is in flight. That race
    // is a valid preserve-override no-op, not an AI persistence failure.
    if (getBlockLabelOverride(db, block.id)?.label.trim()) return false
    throw new Error(`AI label could not be persisted for block ${block.id}.`)
  }
  return true
}

// Two labels name the same work when they are equal, or when one is the
// leading phrase of the other — "Preparing handoff" beside "Preparing handoff
// documentation and reviewing tasks" is one activity split by the engine
// (DEV-281). The WHOLE shorter label must be the prefix, at least two words
// long, so "Reviewing tasks" never joins "Reviewing email".
export function labelsNameSameWork(left: string, right: string): boolean {
  const tokens = (value: string): string[] =>
    value.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean)
  const a = tokens(left)
  const b = tokens(right)
  if (a.length === 0 || b.length === 0) return false
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length < 2 && shorter.length !== longer.length) return false
  return shorter.every((token, index) => longer[index] === token)
}

// Runs of consecutive blocks that name the same work and belong together:
// non-live, non-provisional, not renamed by the person, separated by no real
// absence and no explicit cut. Adjacency is judged over the day's full block
// sequence — a differently-labeled or ineligible block between two matches
// breaks the run.
export function sameLabelFragmentRuns(
  blocks: readonly WorkContextBlock[],
  cuts: readonly number[],
): WorkContextBlock[][] {
  const labelKey = (block: WorkContextBlock): string => block.label.current.trim().toLowerCase()
  // A block with no hydrated sessions can neither anchor a durable correction
  // nor be checked for a spanned absence — it never joins a run.
  const eligible = (block: WorkContextBlock): boolean =>
    !block.isLive && !block.provisional && !block.label.override?.trim()
    && labelKey(block).length > 0 && block.sessions.length > 0
  const ordered = [...blocks].sort((a, b) => a.startTime - b.startTime)
  const runs: WorkContextBlock[][] = []
  let run: WorkContextBlock[] = []
  const closeRun = () => {
    if (run.length >= 2) runs.push(run)
    run = []
  }
  for (const block of ordered) {
    if (!eligible(block)) {
      closeRun()
      continue
    }
    const previous = run[run.length - 1]
    const joinable = previous
      && (labelKey(previous) === labelKey(block) || labelsNameSameWork(previous.label.current, block.label.current))
      && !cuts.some((cut) => cut >= previous.endTime && cut <= block.startTime)
      && !absenceSpannedBy([...run.flatMap((member) => member.sessions), ...block.sessions])
    if (joinable) {
      run.push(block)
    } else {
      closeRun()
      run = [block]
    }
  }
  closeRun()
  return runs
}

export async function analyzeTimelineDay(
  db: Database.Database,
  dateStr: string,
  deps: AnalyzeTimelineDayDeps = {},
): Promise<AnalyzeTimelineDayResult> {
  const userHint = deps.userHint?.trim() || undefined
  const resolveLiveSession = deps.resolveLiveSession ?? (() => null)
  const triggerSource = deps.triggerSource ?? 'user'

  // An analyzed day is about to be wrapped: make sure its external signals
  // (git commits, calendar) exist first — a historical day was never touched
  // by the today/yesterday background collector. Bounded and best-effort
  // inside; a no-op until production wiring registers the backfill, so the
  // hermetic suite never reaches real connectors.
  await runExternalSignalBackfill(dateStr)

  // The interpretation-agent live switch (DEV-206 / DEV-287): when on, the
  // per-block relabel of LOW-CONFIDENCE blocks becomes a packet-based agent
  // turn (services/interpretationAgent.ts — same runtime and tiered tools as
  // chat) instead of the single direct provider call. The deterministic
  // pipeline stays the floor: any agent failure falls back per block to the
  // exact direct behavior, except when disclosure recording failed and any
  // remote fallback must also stay closed. The whole agent pass is gated on
  // evaluateInterpretationRun before one label persists. Flag off → this
  // function is byte-identical to the direct pipeline.
  let agentEnabled = false
  try {
    agentEnabled = interpretationAgentEnabled(getSettings())
  } catch { /* settings unavailable in some harnesses — the direct pipeline is the default either way */ }
  // The models that actually wrote this run's regroup plan and relabels —
  // recorded on the analysis version row (DEV-206) so an old analysis stays
  // attributable to the model and prompt that produced it.
  const modelsUsed = new Set<string>()
  const onModel = (model: string) => { if (model) modelsUsed.add(model) }
  const regroupPlan = deps.regroupPlan ?? ((blocks, opts) => generateDayRegroupPlan(blocks, { ...opts, onModel }))
  const blockInsight = deps.blockInsight ?? ((block, opts) => generateWorkBlockInsight(block, { ...opts, onModel }))
  const agentBlockInsight = deps.agentBlockInsight
    ?? ((block: WorkContextBlock, opts: { triggerSource: BlockInsightTrigger; userHint?: string }) =>
      runInterpretationAgentRelabel(db, block, { ...opts, onModel }))

  const materialize = (): DayTimelinePayload =>
    materializeTimelineDayProjection(db, dateStr, resolveLiveSession(dateStr))

  const emitProgress = (update: TimelineAnalyzeProgress): void => {
    try { deps.onProgress?.(update) } catch { /* a dead renderer must never break analysis */ }
  }
  emitProgress({ stage: 'preparing', done: 0, total: 0 })

  let payload = materialize()
  let changed = false
  let merged = false
  let attempted = 0
  let relabeled = 0
  let mergedCount = 0
  const failures: string[] = []

  // REPAIR: a day stored before the absence guard existed can contain a
  // block that spans a real absence of 15+ minutes. Detect any such
  // block and force the day to rebuild from its sessions: the pipeline now
  // refuses to join across the gap (scoreBoundary treats a real absence as a
  // hard cut that outranks every stored merge correction), so the block splits
  // exactly at the absence. User corrections survive the rebuild — label
  // overrides and reviews re-attach by evidence key, AI names carry forward
  // inside persistTimelineDay, and cuts/valid merges replay from their durable
  // stores. This runs in the normal re-analyze flow (the Analyze button /
  // REBUILD_TIMELINE_DAY), so repairing a bad day is one click, never a
  // direct edit of anyone's database.
  const anchors = dayBoundaryCorrectionAnchors(db, dateStr)
  // A gap the person explicitly fused (a merge-anyway across time away) is not
  // a bad block to repair — their correction outranks the absence cut.
  const gapFusedByUser = (gap: { startMs: number; endMs: number }): boolean =>
    anchors.mergedSpans.some((span) => gap.startMs >= span.startMs && gap.endMs <= span.endMs)
  const spanningAbsence = payload.blocks.filter((block) => {
    if (block.isLive || block.provisional || block.sessions.length < 2) return false
    const gap = absenceSpannedBy(block.sessions)
    return gap !== null && !gapFusedByUser(gap)
  })
  if (spanningAbsence.length > 0) {
    const splitCorrections = spanningAbsence
      .filter((block) => block.review.state === 'corrected')
      .map((block) => ({
        block,
        label: block.review.correctedLabel,
        intentRole: block.review.correctedIntentRole,
        intentSubject: block.review.correctedIntentSubject,
        category: block.review.correctedCategory,
      }))
    for (const block of spanningAbsence) {
      const gap = absenceSpannedBy(block.sessions)
      console.warn(
        `[timeline] repairing ${dateStr}: block "${block.label.current}" spans a real absence `
        + `(${gap ? formatAbsenceRange(gap) : 'unknown'}) — splitting at the gap`,
      )
    }
    payload = materializeTimelineDayProjection(db, dateStr, resolveLiveSession(dateStr), { forceRebuild: true })
    // A fused block's evidence key necessarily changes when the absence guard
    // splits its session set. Preserve the user's intent deterministically on
    // the rebuilt half with the greatest time overlap (earlier half wins a
    // tie). Copying it to every half would turn one correction into a claim
    // that disconnected stretches were necessarily the same work.
    for (const correction of splitCorrections) {
      const target = payload.blocks
        .filter((block) => !block.isLive && block.startTime < correction.block.endTime && block.endTime > correction.block.startTime)
        .sort((left, right) => {
          const leftOverlap = Math.min(left.endTime, correction.block.endTime) - Math.max(left.startTime, correction.block.startTime)
          const rightOverlap = Math.min(right.endTime, correction.block.endTime) - Math.max(right.startTime, correction.block.startTime)
          return rightOverlap - leftOverlap || left.startTime - right.startTime
        })[0]
      if (!target) continue
      writeTimelineBlockReview(db, dateStr, target, {
        state: 'corrected',
        correctedLabel: correction.label,
        correctedIntentRole: correction.intentRole,
        correctedIntentSubject: correction.intentSubject,
        correctedCategory: correction.category,
      })
      if (correction.label?.trim()) setBlockLabelOverride(db, target.id, correction.label, null)
      // The correction has moved to the selected half. Demote the obsolete
      // fused review so interval readers cannot keep applying its category to
      // both sides of the repaired absence.
      writeTimelineBlockReview(db, dateStr, correction.block, { state: 'approved' })
    }
    if (splitCorrections.length > 0) payload = materialize()
    invalidateProjectionScope('timeline', 'absence-repair')
    invalidateProjectionScope('apps', 'absence-repair')
    invalidateProjectionScope('insights', 'absence-repair')
    changed = true
  }

  emitProgress({ stage: 'merging', done: 0, total: 0 })

  // Deterministic fragment repair (DEV-232): consecutive blocks carrying the
  // same label with no real absence between them are one continued activity
  // chopped by the old duration ceiling — four back-to-back "Working on Cursor
  // Agents" blocks are a segmentation artifact, not four activities. Joining
  // them never waits on an AI opinion. A person's cut is never re-joined, a
  // renamed block is never merged away, and a real absence still splits.
  const fragmentRuns = sameLabelFragmentRuns(payload.blocks, anchors.cuts)
  if (fragmentRuns.length > 0) {
    const blocksBeforeFragmentMerge = payload.blocks.length
    let fragmentsMerged = false
    for (const run of fragmentRuns) {
      try {
        mergeTimelineEpisodes(db, dateStr, run, { initiator: 'auto' })
        fragmentsMerged = true
      } catch (error) {
        console.warn('[timeline] same-label fragment merge skipped:', error)
      }
    }
    if (fragmentsMerged) {
      invalidateProjectionScope('timeline', 'fragment-merge')
      invalidateProjectionScope('apps', 'fragment-merge')
      invalidateProjectionScope('insights', 'fragment-merge')
      payload = materialize()
      changed = true
      merged = true
      mergedCount += Math.max(0, blocksBeforeFragmentMerge - payload.blocks.length)
    }
  }

  // AI-driven regroup (timeline.md §3.3 / §5): decide which adjacent heuristic
  // blocks are the same continued intent and should become one. The AI decides
  // only the grouping; the merge rides the durable boundary-correction path so
  // it survives every rebuild. Only blocks with persisted sessions can be
  // merged (a live/in-flight episode has nothing to anchor a correction on).
  const mergeable = payload.blocks.filter(
    (block) => !block.isLive && !block.provisional && block.sessions.some((session) => session.id >= 0),
  )
  if (mergeable.length >= 2) {
    const blocksBeforeMerge = payload.blocks.length
    try {
      const groups = await regroupPlan(mergeable, { userHint })
      let mergedAny = false
      for (const group of groups ?? []) {
        if (group.length < 2) continue
        const members = group.map((index) => mergeable[index]).filter(Boolean)
        if (members.length < 2) continue
        // A user-renamed block is never merged away.
        if (members.some((member) => getBlockLabelOverride(db, member.id)?.label?.trim())) continue
        if (members.some((member) => member.isLive || !member.sessions.some((session) => session.id >= 0))) continue
        // The absence guard vetoes any AI-proposed group that spans a real
        // absence of 15+ minutes (the AI proposes, the guard decides). The
        // contiguous runs on each side of the gap keep the AI's grouping
        // intent and still merge among themselves; mergeTimelineEpisodes
        // enforces the same veto again at the write, as the last line of
        // defense for every caller.
        for (const run of partitionAtRealAbsences(members, (member) => member.sessions)) {
          if (run.length < 2) continue
          try {
            mergeTimelineEpisodes(db, dateStr, run, { initiator: 'auto' })
            mergedAny = true
          } catch (error) {
            console.warn('[timeline] AI merge skipped for a group:', error)
          }
        }
      }
      if (mergedAny) {
        invalidateProjectionScope('timeline', 'timeline-ai-regroup')
        invalidateProjectionScope('apps', 'timeline-ai-regroup')
        invalidateProjectionScope('insights', 'timeline-ai-regroup')
        payload = materialize()
        changed = true
        merged = true
        mergedCount += Math.max(0, blocksBeforeMerge - payload.blocks.length)
      }
    } catch (error) {
      console.warn('[timeline] AI day regroup failed:', error)
    }
  }

  // Name each block that still needs it. The calls are independent, so they run
  // with bounded concurrency instead of one-at-a-time (DEV-270: the day no
  // longer spins for as long as it takes N serial provider round-trips). Each
  // insight is fetched over the network in parallel; the DB write that applies
  // it is done here, after the call resolves, so the writes never race.
  const relabelTargets = payload.blocks.filter((block) => shouldReanalyzeBlockWithAI(block))
  attempted += relabelTargets.length

  // Agent-assisted relabel pass (flag-gated, DEV-206): LOW-CONFIDENCE blocks
  // only — where the direct namer is most likely guessing — get one agent
  // turn each. High-confidence blocks keep the direct path (no cost increase
  // where confidence is fine). The pass is speculative until the eval gate
  // approves it: agent labels are simulated onto the day and scored with
  // evaluateInterpretationRun BEFORE anything persists; a violation discards
  // the whole agent pass and the affected blocks fall back to the direct
  // relabel below, exactly as if the flag were off.
  const agentHandled = new Set<string>()
  const agentAuditBlocked = new Set<string>()
  if (agentEnabled && relabelTargets.length > 0) {
    const isLowConfidence = (block: WorkContextBlock): boolean =>
      block.confidence === 'low' || block.label.confidence < 0.58
    const agentTargets = relabelTargets.filter(isLowConfidence)
    const agentResults: Array<{ block: WorkContextBlock; insight: InterpretationAgentInsight }> = []
    if (agentTargets.length > 0) {
      emitProgress({ stage: 'naming', done: 0, total: relabelTargets.length })
      await mapWithConcurrency(agentTargets, RELABEL_CONCURRENCY, async (block) => {
        try {
          const insight = await agentBlockInsight(
            { ...block, label: { ...block.label, override: null } },
            { triggerSource, userHint },
          )
          agentResults.push({ block, insight })
        } catch (error) {
          if (isInterpretationContextPacketFailure(error)) {
            agentAuditBlocked.add(block.id)
            failures.push('Daylens could not record what it was about to send, so it left this block\'s label alone.')
            console.warn(
              `[timeline] interpretation agent skipped for block ${block.id}; disclosure recording is unavailable:`,
              error.message,
            )
            return
          }
          // Per-block floor: the direct relabel below picks this block up.
          console.warn(
            `[timeline] interpretation agent failed for block ${block.id}; falling back to the direct relabel:`,
            error instanceof Error ? error.message : error,
          )
        }
      })
    }
    // Per-block label gate: a label that leaks raw technical text discards
    // THAT block's agent result (it falls back to the direct relabel below),
    // not the whole pass — one bad name must not throw away every good one.
    const cleanResults = agentResults.filter(({ block, insight }) => {
      const label = insight.label?.trim() ?? ''
      const leak = label ? findRawArtifactLeak(label) : 'the label was empty'
      if (!leak) return true
      console.warn(
        `[timeline] interpretation agent label for block ${block.id} discarded (${leak}); falling back to the direct relabel`,
      )
      return false
    })
    if (cleanResults.length > 0) {
      // The eval gate (lib/interpretationEval): score the proposed day against
      // the interpretation invariants before any write. A remaining violation
      // here — a person's correction overwritten, evidence created or
      // destroyed, an absence spanned — indicates SYSTEMIC misbehavior, so it
      // still discards the whole agent pass and the deterministic pipeline
      // result stands.
      const proposedById = new Map(cleanResults.map((entry) => [entry.block.id, entry.insight]))
      const simulatedAfter: DayTimelinePayload = {
        ...payload,
        blocks: payload.blocks.map((block) => {
          const proposed = proposedById.get(block.id)
          return proposed
            ? { ...block, label: { ...block.label, current: proposed.label, source: 'ai' as const } }
            : block
        }),
      }
      const report = evaluateInterpretationRun({
        before: payload,
        after: simulatedAfter,
        expectations: {
          correctedLabels: payload.blocks
            .filter((block) => !block.isLive && (block.label.override?.trim() || block.review.state === 'corrected'))
            .map((block) => block.label.current.trim())
            .filter(Boolean),
        },
      })
      if (report.pass) {
        for (const { block, insight } of cleanResults) {
          try {
            const wrote = applyAIInsightToTimelineBlock(db, block, insight)
            if (wrote) relabeled++
            changed = wrote || changed
            agentHandled.add(block.id)
          } catch (error) {
            // Persist failure is a per-block failure: leave it to the direct
            // relabel below rather than losing the block's attempt entirely.
            console.warn(`[timeline] interpretation agent label could not persist for block ${block.id}:`, error)
          }
        }
      } else {
        for (const violation of report.violations) {
          console.warn(`[timeline] interpretation agent pass discarded (${violation.rule}): ${violation.detail}`)
        }
      }
    }
  }

  const directTargets = relabelTargets.filter(
    (block) => !agentHandled.has(block.id) && !agentAuditBlocked.has(block.id),
  )
  if (directTargets.length > 0) {
    let named = 0
    emitProgress({ stage: 'naming', done: 0, total: directTargets.length })
    type RelabelOutcome =
      | { block: WorkContextBlock; insight: WorkContextInsight }
      | { block: WorkContextBlock; error: string }
    const nameBlock = async (block: WorkContextBlock): Promise<RelabelOutcome> => {
      try {
        const insight = await blockInsight(
          { ...block, label: { ...block.label, override: null } },
          { jobType: 'block_cleanup_relabel', triggerSource, throwOnError: true, userHint },
        )
        return { block, insight }
      } catch (error) {
        return { block, error: error instanceof Error ? error.message : String(error) }
      } finally {
        emitProgress({ stage: 'naming', done: ++named, total: directTargets.length })
      }
    }
    let insights = await mapWithConcurrency(directTargets, RELABEL_CONCURRENCY, nameBlock)

    // Provider failures under concurrency are usually transient (a 429, one
    // slow call hitting the timeout). A run must not give up on a block after
    // one attempt (DEV-278): retry the failed ones once, serially, before
    // reporting anything as un-nameable.
    const firstPassFailed = insights.filter((result): result is { block: WorkContextBlock; error: string } => 'error' in result)
    // "Everything failed" only signals an outage when there was more than one
    // call to corroborate it — a day with a single relabel target must still
    // get its retry (DEV-278).
    const looksLikeOutage = firstPassFailed.length === directTargets.length && directTargets.length > 1
    if (firstPassFailed.length > 0 && !looksLikeOutage) {
      named -= firstPassFailed.length
      const retried = await mapWithConcurrency(firstPassFailed.map((entry) => entry.block), 1, nameBlock)
      const retriedByBlock = new Map(retried.map((result) => [result.block.id, result]))
      insights = insights.map((result) =>
        'error' in result ? retriedByBlock.get(result.block.id) ?? result : result)
    }

    for (const result of insights) {
      if ('error' in result) {
        console.warn(`[timeline] AI re-analysis failed for block ${result.block.id}:`, result.error)
        failures.push(result.error)
        continue
      }
      const wrote = applyAIInsightToTimelineBlock(db, result.block, result.insight)
      if (wrote) relabeled++
      changed = wrote || changed
    }
  }

  emitProgress({ stage: 'finishing', done: relabelTargets.length, total: relabelTargets.length })

  if ((deps.surfaceErrors ?? true) && attempted > 0 && !changed && failures.length > 0) {
    throw new Error(`AI re-analysis failed: ${failures[0]}`)
  }

  if (changed) {
    invalidateProjectionScope('timeline', 'timeline-ai-reanalysis')
    invalidateProjectionScope('apps', 'timeline-ai-reanalysis')
    invalidateProjectionScope('insights', 'timeline-ai-reanalysis')
  }

  const refreshed = materialize()

  // DEV-206: a run that wrote product state is a new ANALYSIS VERSION of this
  // day — append it to the ledger with the facts it produced (the same
  // snapshot hash the wraps key on), the models that wrote it, and a compact
  // record of what it said. A run that changed nothing recorded no divergence
  // and appends nothing.
  if (changed) {
    try {
      const snapshot = buildDaySnapshot(refreshed)
      appendDayAnalysisVersion(db, {
        kind: 'timeline',
        periodKey: dateStr,
        factsHash: snapshot.factsHash,
        model: modelsUsed.size > 0 ? [...modelsUsed].join(',') : null,
        promptVersion: ANALYZE_DAY_PROMPT_VERSION,
        triggerSource,
        source: modelsUsed.size > 0 ? 'ai' : 'deterministic',
        payload: {
          summary: `${refreshed.blocks.length} blocks${merged ? ', neighbours merged' : ''}${attempted > 0 ? `, ${attempted} relabel${attempted === 1 ? '' : 's'} attempted` : ''}${failures.length > 0 ? `, ${failures.length} failed` : ''}`,
          merged,
          attempted,
          failureCount: failures.length,
          blockCount: refreshed.blocks.length,
          blockLabels: refreshed.blocks
            .filter((block) => !block.isLive)
            .slice(0, 30)
            .map((block) => block.label.current.slice(0, 80)),
          // Versioned inference (agent-runtime spec): each proposed piece of
          // understanding with its source evidence refs and confidence, so an
          // old version answers "what did it claim, from what, how surely".
          inferences: refreshed.blocks
            .filter((block) => !block.isLive)
            .slice(0, 30)
            .map((block) => ({
              blockId: block.id,
              label: block.label.current.slice(0, 80),
              labelSource: block.label.source,
              confidence: block.label.confidence,
              evidenceSessionIds: block.sessions
                .map((session) => session.id)
                .filter((id) => id >= 0)
                .slice(0, 12),
            })),
        },
      })
    } catch (versionError) {
      console.warn(`[timeline] failed to record analysis version for ${dateStr}:`, versionError)
    }
  }

  return { payload: refreshed, changed, merged, attempted, failures, relabeled, mergedCount }
}
