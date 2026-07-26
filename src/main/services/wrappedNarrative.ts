// Wrapped narrative — structured AI gloss on top of the deterministic facts
// layer. Wrapped opens instantly using the fallback; the AI overlay loads
// asynchronously and is rejected outright when it contradicts facts or comes
// back empty / shaped wrong.
//
// Pure logic (facts construction, hash, prompt build, validation, fallback)
// lives in `../lib/wrappedNarrative` so it can be tested without the AI
// orchestration / settings chain.

import type { AIInvocationSource, AIWrappedNarrative, DayTimelinePayload } from '@shared/types'
import { voiceDirective } from '@shared/summaryVoice'
import { userProfileDirective } from '@shared/userProfile'
import { getSettings } from './settings'
import {
  executeTextAIJob,
  type ResolvedProviderConfig,
  type AITextJobExecutionOptions,
  type ProviderTextResponse,
} from './aiOrchestration'
import { buildDayWrapFacts } from '../../renderer/lib/dayWrapScenes'
import {
  DAY_WRAP_PROMPT_VERSION,
  buildFallbackNarrative,
  buildWrappedPrompts,
  buildWrappedRepairMessage,
  computeFactsHash,
  mergeWrapRepair,
  parseWrapResponse,
  reconcileStoredNarrative,
  validateWrappedNarrativeObject,
} from '../lib/wrappedNarrative'
import { buildDayFactTable } from '../lib/wrapFactTable'
import { getDb } from './database'
import { localDateString } from '../lib/localDate'
import { resolveDayEnrichment } from './enrichmentResolve'
import { runExternalSignalBackfill } from './externalSignals'
import { getStoredWrappedNarrative, putStoredWrappedNarrative } from '../db/wrappedNarrativeStore'
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

/**
 * Wire up the provider sender. Called once on main startup so this module
 * doesn't have to take a hard dependency on the ai.ts barrel.
 */
export function registerWrappedNarrativeProvider(runner: ProviderRunner): void {
  providerRunner = runner
}

// Belt over the per-job timeout (JOB_DEFINITIONS.wrapped_narrative = 40s); sits
// just above it so the job timeout governs. A full Sonnet deck runs ~15-25s.
// Overridable for the offline benchmark on slower days.
const NARRATIVE_TIMEOUT_MS = Number(process.env.WRAPPED_NARRATIVE_TIMEOUT_MS) || 45_000

/** A stored narrative from before the deck rewrite has no `lines` object; it
 *  cannot drive the new deck, so treat it as absent and generate once. */
function isDeckNarrative(value: unknown): value is AIWrappedNarrative {
  return Boolean(value && typeof value === 'object' && typeof (value as AIWrappedNarrative).lines === 'object')
}

export interface WrappedNarrativeOptions {
  triggerSource?: AIInvocationSource
  force?: boolean
  /** How a STORED narrative whose facts hash no longer matches the day is
   *  treated. 'reconcile' (the default, in-app opens): stored prose is
   *  re-grounded against the current facts and any piece that would contradict
   *  the cards falls back deterministically, without spending a call.
   *  'regenerate' (notification delivery): a brief must be generated from the
   *  facts at delivery time, never a stale cache, so a mismatch spends a call
   *  to regenerate; if that fails the result is the deterministic fallback,
   *  which the notifier treats as silence. */
  onStale?: 'reconcile' | 'regenerate'
}

export async function getWrappedNarrative(
  payload: DayTimelinePayload,
  options: WrappedNarrativeOptions = {},
): Promise<AIWrappedNarrative> {
  const facts = buildDayWrapFacts(payload)
  const db = getDb()
  // A historical day opened for the first time has no external_signals rows —
  // the background collector only walks today and yesterday. Backfill once
  // through the production connectors, bounded; a scanned-empty day is
  // remembered and never re-collected, and any failure or timeout degrades to
  // no enrichment, never a blocked wrap. (No-op until index.ts registers it,
  // so hermetic tests never touch real git/calendar.)
  await runExternalSignalBackfill(facts.date)
  // Resolve the day's external signals (git / calendar / focus) deterministically
  // from stored rows — no tool loop, never blocks. Absent → null, never invented.
  const enrichment = resolveDayEnrichment(db, facts.date)
  const factsHash = computeFactsHash(facts, enrichment)
  // The one deterministic fact table for this day — the substrate every model
  // line is validated against, computed before and independently of any model.
  const factTable = buildDayFactTable(facts, payload.blocks, facts.date, enrichment)
  // Keyed by the DATE, not the facts hash, so today's wrap is stable as the day
  // accrues more activity (it does not rebuild every open). Only Regenerate replaces it.
  const periodKey = facts.date

  // A wrap is never silently regenerated: a stored wrap whose facts still hold
  // is shown as-is, with its real generated-at time. When the facts moved
  // (corrections invalidate the stored row at write time, so in practice this
  // is today accruing activity), the stored prose is re-grounded rather than
  // trusted — a line that would contradict the current cards cannot render.
  let regeneratingStale = false
  if (!options.force) {
    const stored = getStoredWrappedNarrative<AIWrappedNarrative>(db, 'day', periodKey)
    if (stored && isDeckNarrative(stored.narrative)) {
      if (stored.factsHash === factsHash) {
        return { ...stored.narrative, generatedAt: stored.generatedAt }
      }
      // A COMPLETED day whose stored wrap no longer matches its facts was
      // generated mid-day and frozen — a full day permanently described by
      // its first morning. Its facts can only have settled, so regenerate
      // once; after that the hash matches and the stored wrap is served
      // forever. Same-day opens keep reconciling so today's wrap stays
      // stable while activity accrues.
      const dayCompleted = facts.date < localDateString()
      if (options.onStale !== 'regenerate' && !(dayCompleted && providerRunner)) {
        const reconciled = reconcileStoredNarrative(stored.narrative, facts, factsHash, enrichment, factTable)
        if (reconciled) return { ...reconciled, generatedAt: stored.generatedAt }
        // Nothing of the stored prose grounds anymore: show the honest
        // deterministic narrative without spending a call. Regenerate (force)
        // or notification delivery produces a fresh one.
        return buildFallbackNarrative(facts, factsHash)
      }
      // onStale 'regenerate' or a settled completed day: fall through and
      // generate from the current facts.
      regeneratingStale = true
    }
  }

  // Persist a freshly produced wrap and stamp it with its generation time.
  // Every persist also appends to the analysis version ledger (DEV-206): what
  // this analysis said, from which facts, by which model and prompt version,
  // and why it replaced the previous one — never a silent overwrite.
  const persist = (result: AIWrappedNarrative, model: string | null = null): AIWrappedNarrative => {
    const generatedAt = Date.now()
    putStoredWrappedNarrative(db, 'day', periodKey, result, factsHash, generatedAt)
    try {
      appendDayAnalysisVersion(db, {
        kind: 'day',
        periodKey,
        factsHash,
        model,
        promptVersion: DAY_WRAP_PROMPT_VERSION,
        triggerSource: options.triggerSource ?? 'user',
        source: result.source === 'ai' ? 'ai' : 'fallback',
        payload: {
          lead: result.lead,
          lines: result.lines,
          question: result.question,
          reflection: result.reflection,
        },
        reason: options.force ? 'manual-regenerate' : regeneratingStale ? 'facts-changed' : undefined,
        now: generatedAt,
      })
    } catch (versionError) {
      console.warn(`[ai] failed to record analysis version for ${periodKey}:`, versionError)
    }
    return { ...result, generatedAt }
  }

  const fallback = buildFallbackNarrative(facts, factsHash)

  // Unusable model output. On a first generation the fallback is persisted
  // (the day has an honest wrap, Regenerate can replace it). But when this
  // call was a regeneration of a DRIFTED stored wrap, persisting the fallback
  // would mark the cache fresh under the new hash — clobbering the stored
  // wrap and freezing the deterministic floor in forever. Return the floor
  // WITHOUT persisting so the stored wrap survives and a later open retries.
  const settleUnusable = (): AIWrappedNarrative =>
    regeneratingStale ? fallback : persist(fallback)

  // Quality gates: no AI for empty/tooEarly days — the fallback is honest enough
  // and we don't want to spend tokens on "not enough data yet".
  if (facts.quality === 'empty' || facts.quality === 'tooEarly') {
    return persist(fallback)
  }

  // No provider: do NOT persist; the UI shows the connect-a-provider message,
  // and we want a real wrap generated the moment a provider is connected.
  if (!providerRunner) {
    return fallback
  }

  const { systemPrompt, userMessage } = buildWrappedPrompts(facts, enrichment)
  // Apply the user's chosen summary voice and who-they-are profile. The
  // facts/validation stay untouched — this only steers wording, never the numbers.
  const settings = getSettings()
  const profile = userProfileDirective(settings)
  const tunedSystemPrompt = [systemPrompt, profile, voiceDirective(settings.summaryVoice)]
    .filter(Boolean)
    .join('\n\n')

  try {
    const { text, config } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'wrapped_narrative',
          screen: 'timeline_day',
          triggerSource: options.triggerSource ?? 'user',
          systemPrompt: tunedSystemPrompt,
          userMessage,
        },
        providerRunner,
      ),
      NARRATIVE_TIMEOUT_MS,
      'wrapped_narrative timed out',
    )
    const model = config.model

    const parsed = parseWrapResponse(text)
    if (!parsed) return settleUnusable()
    let { narrative, rejections } = validateWrappedNarrativeObject(parsed, facts, factsHash, enrichment, factTable)

    // ONE repair round (wrapped-agent-plan: verify + at most one repair call).
    // The writer gets its own rejected lines back with the exact violations and
    // rewrites only those; anything still failing falls back honestly per slide.
    if (rejections.length > 0) {
      console.warn(`[ai] wrapped_narrative ${facts.date}: ${rejections.length} piece(s) rejected → repair round:`, rejections.map((r) => `${r.id}: ${r.reason}`).join(' | '))
      try {
        const { text: repairText } = await withTimeout(
          executeTextAIJob(
            {
              jobType: 'wrapped_narrative',
              screen: 'timeline_day',
              triggerSource: options.triggerSource ?? 'user',
              systemPrompt: tunedSystemPrompt,
              prior: [
                { role: 'user', content: userMessage },
                { role: 'assistant', content: text },
              ],
              userMessage: buildWrappedRepairMessage(facts, rejections),
            },
            providerRunner,
          ),
          NARRATIVE_TIMEOUT_MS,
          'wrapped_narrative repair timed out',
        )
        const merged = mergeWrapRepair(parsed, repairText, rejections)
        const second = validateWrappedNarrativeObject(merged, facts, factsHash, enrichment, factTable)
        if (second.narrative) {
          narrative = second.narrative
          rejections = second.rejections
        }
        if (rejections.length > 0) {
          console.warn(`[ai] wrapped_narrative ${facts.date}: still rejected after repair:`, rejections.map((r) => `${r.id}: ${r.reason}`).join(' | '))
        }
      } catch (repairError) {
        // The first pass's survivors still ship; only the repair was lost.
        console.warn(`[ai] wrapped_narrative repair failed for ${facts.date}:`, repairError)
      }
    }

    return narrative ? persist(narrative, model) : settleUnusable()
  } catch (error) {
    console.warn(`[ai] wrapped_narrative failed for ${facts.date}:`, error)
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
