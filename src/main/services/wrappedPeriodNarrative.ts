// Period (week / month / year) Wrapped — service layer. Builds the facts by
// SUMMING frozen daily snapshots (so the stat card and narrative agree), then
// overlays the AI deck narrative.
//
// Persistence (DEV-118 / wrapped.md §3.3): a generated period wrap is stored
// keyed by cadence + period start. A CLOSED period never regenerates without an
// explicit force. An OPEN period (this week) is live: it regenerates when the
// underlying facts change, because "week so far" is allowed to grow.

import type {
  AIInvocationSource,
  WrappedPeriod,
  WrappedPeriodFacts,
  WrappedPeriodNarrative,
} from '@shared/types'
import {
  executeTextAIJob,
  type ResolvedProviderConfig,
  type AITextJobExecutionOptions,
  type ProviderTextResponse,
} from './aiOrchestration'
import { voiceDirective } from '@shared/summaryVoice'
import { userProfileDirective } from '@shared/userProfile'
import { isTrustedTimelineBlock } from '@shared/timelineReview'
import { effectiveBlockKind } from '@shared/workKind'
import { getSettings } from './settings'
import { getDaySnapshotsForRange } from './daySnapshots'
import { getTimelineDayPayload } from './workBlocks'
import { getDb } from './database'
import { getStoredWrappedNarrative, putStoredWrappedNarrative } from '../db/wrappedNarrativeStore'
import { computePeriodRange } from '../lib/wrappedPeriodRange'
import { rollupSnapshots, bucketTotals } from '../lib/wrappedPeriodFacts'
import {
  PERIOD_WRAP_PROMPT_VERSION,
  buildPeriodFallbackNarrative,
  buildPeriodPrompts,
  buildPeriodRepairMessage,
  computePeriodFactsHash,
  mergePeriodWrapRepair,
  parsePeriodWrapResponse,
  validatePeriodNarrativeObject,
} from '../lib/wrappedPeriodNarrative'
import { appendDayAnalysisVersion } from '../db/dayAnalysisVersions'

interface ProviderRunner {
  (
    config: ResolvedProviderConfig,
    systemPrompt: string,
    prior: Array<{ role: 'user' | 'assistant'; content: string }>,
    userMessage: string,
    options?: AITextJobExecutionOptions,
  ): Promise<ProviderTextResponse>
}

let providerRunner: ProviderRunner | null = null

export function registerWrappedPeriodNarrativeProvider(runner: ProviderRunner): void {
  providerRunner = runner
}

// Belt over the per-job timeout (JOB_DEFINITIONS.wrapped_period_narrative =
// 100s); sits just above it. Overridable for the offline benchmark (see
// wrappedNarrative).
const NARRATIVE_TIMEOUT_MS = Number(process.env.WRAPPED_NARRATIVE_TIMEOUT_MS) || 110_000

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatClock(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(':00', '')
    .replace(' ', '')
    .toLowerCase()
}

/** The real first/last activity clock per active day, from the same trusted
 *  timeline blocks the Timeline view shows. Clock facts only — every duration
 *  still comes from the frozen snapshots, so totals cannot drift. */
function computeDayEdges(
  activeDates: Array<{ dateStr: string; dayLabel: string }>,
): WrappedPeriodFacts['dayEdges'] {
  const db = getDb()
  const edges: WrappedPeriodFacts['dayEdges'] = []
  for (const day of activeDates) {
    try {
      const payload = getTimelineDayPayload(db, day.dateStr, null)
      const blocks = payload.blocks
        .filter(isTrustedTimelineBlock)
        .filter((b) => b.dominantCategory !== 'system' && b.dominantCategory !== 'uncategorized')
        .filter((b) => effectiveBlockKind(b) !== 'idle')
        .sort((a, b) => a.startTime - b.startTime)
      if (blocks.length === 0) continue
      const first = blocks[0].startTime
      const last = blocks[blocks.length - 1].endTime
      edges.push({
        dateStr: day.dateStr,
        dayLabel: day.dayLabel,
        firstClock: formatClock(first),
        lastClock: formatClock(last),
        firstHour: new Date(first).getHours(),
        lastHour: new Date(last).getHours(),
      })
    } catch {
      // A day that can't be read is a day without edges — the late-night /
      // early-start slides simply skip it rather than guess (invariant 10).
    }
  }
  return edges
}

/** Build period facts purely from frozen daily snapshots — the single source the
 *  stat card and the narrative both read. Day-edge clocks come from the same
 *  trusted timeline blocks; they carry no durations. */
export function buildWrappedPeriodFacts(period: WrappedPeriod, anchorDate: string): WrappedPeriodFacts {
  const range = computePeriodRange(period, anchorDate)
  const snapshots = getDaySnapshotsForRange(range.startDate, range.endDate)
  const prevSnapshots = getDaySnapshotsForRange(range.prevStartDate, range.prevEndDate)
  const rollup = rollupSnapshots(snapshots, range.dayLabel)

  const previousPeriodSeconds = prevSnapshots.reduce((s, snap) => s + snap.totalActiveSeconds, 0)

  const bucketInput = range.buckets.map((b) => ({
    label: b.label,
    snapshots: snapshots.filter((s) => s.date >= b.startDate && s.date <= b.endDate),
  }))
  const { buckets, busiestBucket } = bucketTotals(bucketInput)

  // Edge clocks only for the week — month/year decks don't show per-day edges
  // and 30+ timeline reads per open would be waste.
  const dayEdges = period === 'week'
    ? computeDayEdges(rollup.days.map((d) => ({ dateStr: d.dateStr, dayLabel: d.dayLabel })))
    : []

  return {
    period,
    anchorDate,
    rangeLabel: range.rangeLabel,
    totalSeconds: rollup.totalSeconds,
    workSeconds: rollup.workSeconds,
    leisureSeconds: rollup.leisureSeconds,
    personalSeconds: rollup.personalSeconds,
    previousPeriodSeconds,
    daysWithActivity: rollup.daysWithActivity,
    dominantWorkCategory: rollup.dominantWorkCategory,
    dominantWorkCategoryPct: rollup.dominantWorkCategoryPct,
    categories: rollup.categories,
    topApps: rollup.topApps,
    threads: rollup.threads,
    leisureSurfaces: rollup.leisureSurfaces,
    busiestDay: rollup.busiestDay,
    quietestActiveDay: rollup.quietestActiveDay,
    longestStretch: rollup.longestStretch,
    buckets,
    busiestBucket,
    days: rollup.days,
    meetingsSeconds: rollup.meetingsSeconds,
    dayEdges,
  }
}

/** True while the period still contains today — a live "so far" period. */
function periodIsOpen(period: WrappedPeriod, anchorDate: string): boolean {
  const range = computePeriodRange(period, anchorDate)
  const today = localToday()
  return today >= range.startDate && today <= range.endDate
}

/** A stored narrative from before the deck rewrite has no `lines` object; it
 *  cannot drive the new deck, so treat it as absent and generate once. */
function isDeckNarrative(value: unknown): value is WrappedPeriodNarrative {
  return Boolean(value && typeof value === 'object' && typeof (value as WrappedPeriodNarrative).lines === 'object')
}

export interface WrappedPeriodWrapOptions {
  triggerSource?: AIInvocationSource
  force?: boolean
  /** How a STORED narrative whose facts hash no longer matches the period is
   *  treated. 'reconcile' (the default, in-app opens of a closed period):
   *  stored prose is re-grounded against the current facts without spending a
   *  call. 'regenerate' (notification delivery): a brief must be generated
   *  from the facts at delivery time, never a stale cache, so a mismatch
   *  spends a call to regenerate; if that fails the result is the
   *  deterministic fallback, which the notifier treats as silence. */
  onStale?: 'reconcile' | 'regenerate'
}

/** Facts + narrative for a period. Facts always come from snapshots; the
 *  narrative is AI when a provider is configured, else the deterministic
 *  baseline (the renderer gates on provider state and shows the connect message
 *  when none is connected — §7). */
export async function getWrappedPeriodWrap(
  period: WrappedPeriod,
  anchorDate: string,
  options: WrappedPeriodWrapOptions = {},
): Promise<{ facts: WrappedPeriodFacts; narrative: WrappedPeriodNarrative }> {
  const facts = buildWrappedPeriodFacts(period, anchorDate)
  const narrative = await getWrappedPeriodNarrative(facts, options)
  return { facts, narrative }
}

async function getWrappedPeriodNarrative(
  facts: WrappedPeriodFacts,
  options: WrappedPeriodWrapOptions = {},
): Promise<WrappedPeriodNarrative> {
  const factsHash = computePeriodFactsHash(facts)
  const db = getDb()
  const range = computePeriodRange(facts.period, facts.anchorDate)
  const periodKey = range.startDate
  const open = periodIsOpen(facts.period, facts.anchorDate)

  if (!options.force) {
    const stored = getStoredWrappedNarrative<WrappedPeriodNarrative>(db, facts.period, periodKey)
    if (stored && isDeckNarrative(stored.narrative)) {
      // A closed period never silently regenerates. An open one is live: show
      // the stored wrap while the facts still match, regenerate when they grew.
      if (stored.factsHash === factsHash) {
        return { ...stored.narrative, generatedAt: stored.generatedAt }
      }
      if (!open && options.onStale !== 'regenerate') {
        // A closed period's facts moved under the stored prose (corrections
        // delete the stored row at write time, so this is the rare leftover,
        // e.g. a snapshot rebuilt by a newer builder). Re-ground every piece
        // against the current facts rather than serving lines that could
        // contradict the cards; pieces that fail fall back per slide.
        if (stored.narrative.source === 'ai') {
          const reground = validatePeriodNarrativeObject(
            {
              lines: stored.narrative.lines ?? {},
              question: stored.narrative.question,
              reflection: stored.narrative.reflection,
            },
            facts,
            factsHash,
          )
          if (reground.narrative) {
            return { ...reground.narrative, generatedAt: stored.generatedAt }
          }
        }
        return buildPeriodFallbackNarrative(facts, factsHash)
      }
    }
  }

  // Every persist also appends to the analysis version ledger (DEV-206): what
  // this analysis said, from which facts, by which model and prompt version,
  // and why it replaced the previous one — never a silent overwrite.
  const persist = (result: WrappedPeriodNarrative, model: string | null = null): WrappedPeriodNarrative => {
    const generatedAt = Date.now()
    putStoredWrappedNarrative(db, facts.period, periodKey, result, factsHash, generatedAt)
    try {
      appendDayAnalysisVersion(db, {
        kind: facts.period,
        periodKey,
        factsHash,
        model,
        promptVersion: PERIOD_WRAP_PROMPT_VERSION,
        triggerSource: options.triggerSource ?? 'user',
        source: result.source === 'ai' ? 'ai' : 'fallback',
        payload: {
          lead: result.lead,
          lines: result.lines,
          question: result.question,
          reflection: result.reflection,
        },
        reason: options.force ? 'manual-regenerate' : undefined,
        now: generatedAt,
      })
    } catch (versionError) {
      console.warn(`[ai] failed to record analysis version for ${facts.period} ${periodKey}:`, versionError)
    }
    return { ...result, generatedAt }
  }

  const fallback = buildPeriodFallbackNarrative(facts, factsHash)

  // No data or no provider: do NOT persist — the UI shows its own message, and
  // a real wrap should generate the moment a provider is connected.
  if (facts.totalSeconds <= 0 || !providerRunner) {
    return fallback
  }

  const { systemPrompt, userMessage } = buildPeriodPrompts(facts)
  const settings = getSettings()
  const tunedSystemPrompt = [systemPrompt, userProfileDirective(settings), voiceDirective(settings.summaryVoice)]
    .filter(Boolean)
    .join('\n\n')

  try {
    const { text, config } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'wrapped_period_narrative',
          screen: 'timeline_week',
          triggerSource: options.triggerSource ?? 'user',
          systemPrompt: tunedSystemPrompt,
          userMessage,
        },
        providerRunner,
      ),
      NARRATIVE_TIMEOUT_MS,
      'wrapped_period_narrative timed out',
    )
    const model = config.model

    const parsed = parsePeriodWrapResponse(text)
    if (!parsed) return persist(fallback)
    let { narrative, rejections } = validatePeriodNarrativeObject(parsed, facts, factsHash)

    // ONE repair round (wrapped-agent-plan: verify + at most one repair call).
    if (rejections.length > 0) {
      console.warn(`[ai] wrapped_period_narrative ${facts.period} ${facts.anchorDate}: ${rejections.length} piece(s) rejected → repair round:`, rejections.map((r) => `${r.id}: ${r.reason}`).join(' | '))
      try {
        const { text: repairText } = await withTimeout(
          executeTextAIJob(
            {
              jobType: 'wrapped_period_narrative',
              screen: 'timeline_week',
              triggerSource: options.triggerSource ?? 'user',
              systemPrompt: tunedSystemPrompt,
              prior: [
                { role: 'user', content: userMessage },
                { role: 'assistant', content: text },
              ],
              userMessage: buildPeriodRepairMessage(facts, rejections),
            },
            providerRunner,
          ),
          NARRATIVE_TIMEOUT_MS,
          'wrapped_period_narrative repair timed out',
        )
        const merged = mergePeriodWrapRepair(parsed, repairText, rejections)
        const second = validatePeriodNarrativeObject(merged, facts, factsHash)
        if (second.narrative) {
          narrative = second.narrative
          rejections = second.rejections
        }
        if (rejections.length > 0) {
          console.warn(`[ai] wrapped_period_narrative ${facts.period} ${facts.anchorDate}: still rejected after repair:`, rejections.map((r) => `${r.id}: ${r.reason}`).join(' | '))
        }
      } catch (repairError) {
        console.warn(`[ai] wrapped_period_narrative repair failed for ${facts.period} ${facts.anchorDate}:`, repairError)
      }
    }

    return persist(narrative ?? fallback, narrative ? model : null)
  } catch (error) {
    console.warn(`[ai] wrapped_period_narrative failed for ${facts.period} ${facts.anchorDate}:`, error)
    // A transient failure is not a generated wrap — return the floor without
    // persisting, so a retry can still produce and store the real one.
    return fallback
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
