// The interpretation-agent relabel turn (agent-runtime-and-context.md §Agent
// roles / §Two consumers, one loop): for ONE low-confidence timeline block,
// run a small AI SDK tool loop instead of the single direct relabel call. The
// agent may pull Tier-1 read-only context — window-title clusters, calendar,
// git, entity attribution — before naming the block. Same evidence prompt as
// the direct relabel (workBlockPrompt), same voice rules, same output
// contract; the only new capability is going and getting more context.
//
// Boundaries, deliberately identical to the chat agent's:
//   - tools reuse the SAME executors as the wrap/MCP/chat surfaces
//     (executeWrappedTool, executeTool), which apply exclusion filtering +
//     string sanitization on every result;
//   - no ask_user / interaction / correction tools — interpretation proposes
//     over evidence in the background, it never talks to the person;
//   - usage meters through recordInterpretationAgentUsage (its own
//     'interpretation_agent' lane, grouped under Timeline labeling);
//   - the caller (analyzeDay) treats any throw as "fall back to the direct
//     relabel" — this module never needs to degrade internally.
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type { AIInvocationSource, WorkContextBlock, WorkContextInsight } from '@shared/types'
import { evaluateLabelVoice, labelVoiceContextForBlock } from '@shared/labelVoice'
import { effectiveBlockKind } from '@shared/workKind'
import { VOICE_SYSTEM_PROMPT } from '../ai/voiceContract'
import { upsertWorkContextInsight } from '../db/queries'
import { stripCodeFence } from '../lib/wrapNarrativeShared'
import { languageModelFor } from '../agent/providerModel'
import {
  recordInterpretationAgentUsage,
  resolveProviderConfigsForJob,
  type AIProviderUsage,
  type ResolvedProviderConfig,
} from './aiOrchestration'
import { getSettingsAsync } from './settings'
import { executeWrappedTool } from './wrappedTools'
import { executeTool } from './aiTools'
import { workBlockPrompt } from '../jobs/aiService'
import { localDateKeyForTimestamp } from './workBlocks'

// Small loop by design: one look at the evidence, at most a few context pulls,
// one answer. A block that needs more than this isn't going to be named better
// by more steps — it's going to be named by the person.
const INTERPRETATION_AGENT_MAX_STEPS = 4
const INTERPRETATION_AGENT_TIMEOUT_MS = 45_000
const INTERPRETATION_AGENT_MAX_OUTPUT_TOKENS = 1_000

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('Local date, YYYY-MM-DD')

/** The agent's output contract: the direct relabel's {label, narrative} plus
 *  the agent's own confidence and reasoning (logged and versioned, never
 *  written into product labels). */
// A parse-time ceiling on the label, BEFORE any validation: a runaway model
// can emit thousands of characters, and nothing that long is ever a label.
// The voice contract's 90-char bound is enforced later with block context;
// this is the hard cap that keeps garbage out of the validation path.
const PARSED_LABEL_HARD_MAX_CHARS = 200

const agentInsightSchema = z.object({
  label: z.string().trim().min(1).max(PARSED_LABEL_HARD_MAX_CHARS),
  narrative: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).nullish(),
  reasoning: z.string().nullish(),
})

export interface InterpretationAgentInsight extends WorkContextInsight {
  label: string
  narrative: string
  confidence: number | null
  reasoning: string | null
  /** Which tools the loop actually called, for the analysis-version record. */
  toolsUsed: string[]
}

export function parseInterpretationAgentInsight(raw: string): InterpretationAgentInsight | null {
  const candidate = stripCodeFence(raw).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = agentInsightSchema.safeParse(JSON.parse(candidate.slice(start, end + 1)))
    if (!parsed.success) return null
    return {
      label: parsed.data.label,
      narrative: parsed.data.narrative,
      confidence: parsed.data.confidence ?? null,
      reasoning: parsed.data.reasoning?.trim() || null,
      toolsUsed: [],
    }
  } catch {
    return null
  }
}

/** The SAME label-voice standard the direct relabel path enforces
 *  (generateWorkBlockInsight's labelRejection in jobs/aiService.ts): every
 *  invariant rule — which bounds the label to 90 chars / 12 words — plus the
 *  two target rules that catch echoed window titles and bare app names
 *  ("Slack" is software, not an activity). Returns the violation detail, or
 *  null when the label passes. Exported for direct testing. */
export function agentLabelViolation(label: string | null | undefined, block: WorkContextBlock): string | null {
  const candidate = label?.trim()
  if (!candidate) return 'the label was empty'
  const voiceContext = labelVoiceContextForBlock(block, effectiveBlockKind(block))
  for (const finding of evaluateLabelVoice(candidate, voiceContext)) {
    if (finding.passed) continue
    if (finding.tier === 'invariant'
      || finding.rule === 'no-verbatim-window-title'
      || finding.rule === 'activity-not-software') {
      return finding.detail ?? finding.rule
    }
  }
  return null
}

export interface InterpretationAgentOptions {
  userHint?: string
  triggerSource?: AIInvocationSource
  /** Injectable model for hermetic tests — the loop never reaches a provider
   *  when this is set (mirrors ChatAgentDeps.model). */
  model?: LanguageModel
  /** Pass false where fresh signal collection must not run (tests, read-only
   *  handles) — stored calendar/git signals are still served. */
  allowCollect?: boolean
  /** Reports the provider model that produced the label, for the DEV-206
   *  analysis-version ledger. */
  onModel?: (model: string) => void
  signal?: AbortSignal
}

// Tier-1 read-only context tools. Executors are the SAME functions the
// wrap/MCP surface (executeWrappedTool) and the chat tools (executeTool)
// dispatch through, so every result crosses the same two privacy boundaries
// (exclusion filtering + sanitization) before reaching the model.
function buildInterpretationTools(db: Database.Database, options: { allowCollect: boolean; onTool: (name: string) => void }) {
  const run = async (name: string, fn: () => Promise<unknown> | unknown): Promise<unknown> => {
    options.onTool(name)
    try {
      const result = await fn()
      return result ?? { found: false, reason: 'No data for that query.' }
    } catch (error) {
      return { found: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    get_window_title_context: tool({
      description: 'What the window titles say was being done in one app on one day, clustered into semantic groups. Use to understand what a vague block was really about.',
      inputSchema: z.object({ date: DATE, appName: z.string().min(1) }),
      execute: ({ date, appName }) =>
        run('get_window_title_context', () => executeWrappedTool('getWindowTitleContext', { date, appName }, db)),
    }),
    get_calendar_events: tool({
      description: 'The day\'s meetings: calendar events (names, times, durations, attendee counts) plus which were actually attended. Use when the block might be a meeting.',
      inputSchema: z.object({ date: DATE }),
      execute: ({ date }) =>
        run('get_calendar_events', () => executeWrappedTool('getCalendarEvents', { date }, db, undefined, { allowCollect: options.allowCollect })),
    }),
    get_git_activity: tool({
      description: 'The day\'s git story: repositories touched, commit messages and times, PR activity. Use when the block might be development work.',
      inputSchema: z.object({ date: DATE }),
      execute: ({ date }) =>
        run('get_git_activity', () => executeWrappedTool('getGitActivity', { date }, db, undefined, { allowCollect: options.allowCollect })),
    }),
    lookup_entity: tool({
      description: 'Work attributed to one named client or project (partial name match). Use to check whether a name in the evidence is a known client/project.',
      inputSchema: z.object({ entityName: z.string().min(1) }),
      execute: ({ entityName }) =>
        run('lookup_entity', () => executeTool('getAttributionContext', { entityName }, db)),
    }),
  }
}

type UsageRecordedError = Error & { usageRecorded?: boolean }

/** Marks an error whose failure event is already metered, so the outer catch
 *  never records the same turn twice. */
function markUsageRecorded(error: Error): UsageRecordedError {
  return Object.assign(error, { usageRecorded: true })
}

function usageFromTotal(total: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined): AIProviderUsage {
  return {
    inputTokens: total?.inputTokens ?? 0,
    outputTokens: total?.outputTokens ?? 0,
    cacheReadTokens: total?.cachedInputTokens ?? 0,
    cacheWriteTokens: 0,
  }
}

/** Run one agent-assisted relabel turn for one low-confidence block. Returns a
 *  validated {label, narrative, confidence, reasoning} or THROWS — the caller
 *  owns the fallback to the direct relabel, so a failure here is loud, never a
 *  silent half-answer. */
export async function runInterpretationAgentRelabel(
  db: Database.Database,
  block: WorkContextBlock,
  options: InterpretationAgentOptions = {},
): Promise<InterpretationAgentInsight> {
  const settings = await getSettingsAsync()
  const configs = await resolveProviderConfigsForJob('interpretation_agent', settings)
  // Defensive: resolveProviderConfigsForJob throws when nothing resolves, but
  // an empty array from a stub or future refactor must fail with the same
  // clean message, never an undefined-config crash mid-turn.
  if (configs.length === 0) {
    throw new Error('AI access is paused. Subscribe or add your own key in Settings.')
  }
  const config: ResolvedProviderConfig = configs[0]
  const startedAt = Date.now()
  const triggerSource = options.triggerSource ?? 'background'
  const date = localDateKeyForTimestamp(block.startTime)
  const toolsUsed: string[] = []

  const system = [
    VOICE_SYSTEM_PROMPT,
    'You are Daylens.',
    'You label productivity timeline blocks from local activity evidence.',
    'This block\'s evidence was too weak for a confident name, so you may call the provided read-only tools to pull more context (window titles, calendar, git, known clients/projects) before answering.',
    'Call a tool only when it can plausibly resolve the ambiguity; answer directly when the evidence already suffices.',
    'Do not use emoji. Be concrete, restrained, and evidence-led. Never mention the model provider.',
    'When you have enough context, reply with ONLY strict JSON:',
    '{"label":"...","narrative":"...","confidence":0.0-1.0,"reasoning":"..."}',
    'label: a 2-7 word phrase naming what they were DOING (verb + object). NEVER a raw app name, window title, filename, page/video title, or bare category.',
    'narrative: 1-2 plain sentences, evidence-led, no hype.',
    'confidence: your honest 0-1 confidence in the label.',
    'reasoning: one sentence naming the evidence that decided it.',
  ].join(' ')

  const prompt = [
    workBlockPrompt(block),
    `The block's local date is ${date} (for tool calls).`,
    options.userHint?.trim()
      ? `The user described their day as: "${options.userHint.trim()}". Treat this as a strong hint, but stay grounded in the evidence, and only apply it where it fits this block's activity.`
      : '',
  ].filter(Boolean).join('\n\n')

  const timeoutSignal = AbortSignal.timeout(INTERPRETATION_AGENT_TIMEOUT_MS)
  const abortSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

  try {
    const result = await generateText({
      model: options.model ?? languageModelFor(config),
      system,
      prompt,
      tools: buildInterpretationTools(db, {
        allowCollect: options.allowCollect ?? true,
        onTool: (name) => toolsUsed.push(name),
      }),
      stopWhen: stepCountIs(INTERPRETATION_AGENT_MAX_STEPS),
      maxOutputTokens: INTERPRETATION_AGENT_MAX_OUTPUT_TOKENS,
      abortSignal,
    })
    const usage = usageFromTotal(result.totalUsage)
    const parsed = parseInterpretationAgentInsight(result.text)
    if (!parsed) {
      recordInterpretationAgentUsage({
        config, usage, startedAt, success: false, triggerSource,
        failureReason: 'interpretation agent returned no usable {label, narrative} JSON',
      })
      throw markUsageRecorded(new Error(`Interpretation agent returned no usable label for block ${block.id}.`))
    }
    // The label-voice contract, held to the SAME standard as the direct
    // relabel: a bare app name or an over-long label is an agent FAILURE the
    // caller falls back from, never a label that persists and gets floored.
    const violation = agentLabelViolation(parsed.label, block)
    if (violation) {
      recordInterpretationAgentUsage({
        config, usage, startedAt, success: false, triggerSource,
        failureReason: `interpretation agent label rejected: ${violation}`,
      })
      throw markUsageRecorded(new Error(`Interpretation agent label for block ${block.id} was rejected: ${violation}`))
    }
    recordInterpretationAgentUsage({ config, usage, startedAt, success: true, triggerSource })
    options.onModel?.(config.model)
    // The same observation write the direct path performs (aiService's
    // generateWorkBlockInsight): an agent-labelled block records its insight
    // into work_context_observations, so downstream observation readers see
    // one store regardless of which path named the block. A later direct
    // relabel of the same range overwrites it (upsert by time range).
    if (!block.isLive) {
      upsertWorkContextInsight(db, {
        startMs: block.startTime,
        endMs: block.endTime,
        insight: { label: parsed.label, narrative: parsed.narrative },
        sourceBlockIds: [block.id],
      })
    }
    return { ...parsed, toolsUsed }
  } catch (error) {
    // Paths above record their own usage event before throwing.
    if (!(error instanceof Error && (error as UsageRecordedError).usageRecorded)) {
      recordInterpretationAgentUsage({
        config, usage: null, startedAt, success: false, triggerSource,
        failureReason: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}
