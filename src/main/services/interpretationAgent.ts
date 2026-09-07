// The interpretation-agent relabel turn (agent-runtime-and-context.md §Agent
// roles / §Two consumers, one loop): for ONE low-confidence timeline block,
// run the same packet-based AI SDK runtime as chat instead of a single direct
// relabel call. The agent may pull Tier-1 context (window titles, calendar,
// git, entities) before naming a historical block. Live screen capture is
// registered only when the block is still current, and the executor re-checks
// that authorization. Same evidence prompt as the direct relabel
// (workBlockPrompt), same voice rules, same output contract.
//
// Boundaries, deliberately identical to the chat agent's:
//   - the turn starts from a recorded interpret-purpose Context packet;
//   - tools reuse the SAME executors as the wrap/MCP/chat surfaces
//     (executeWrappedTool, executeTool, buildContextTools, buildScreenTools);
//   - no ask_user / interaction / correction tools — interpretation proposes
//     over evidence in the background, it never talks to the person;
//   - usage meters through recordInterpretationAgentUsage (its own
//     'interpretation_agent' lane, grouped under Timeline labeling);
//   - the caller (analyzeDay) treats runtime failures as "fall back to the
//     direct relabel"; disclosure-recording failures keep the local label.
import { tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { AIInvocationSource, WorkContextBlock, WorkContextInsight } from '@shared/types'
import { labelCandidateViolation, labelVoiceContextForBlock } from '@shared/labelVoice'
import { effectiveBlockKind } from '@shared/workKind'
import { VOICE_SYSTEM_PROMPT } from '../ai/voiceContract'
import { upsertWorkContextInsight } from '../db/queries'
import { stripCodeFence } from '../lib/wrapNarrativeShared'
import { languageModelFor } from '../agent/providerModel'
import { AISdkAgentRuntime } from '../agent/agentRuntime'
import { buildContextTools } from '../agent/contextTools'
import { buildScreenTools } from '../agent/screenTools'
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
import {
  buildContextPacket,
  contextPacketsAvailable,
  recordContextPacket,
  type AgentToolDescriptor,
  type ContextPacket,
} from './contextPacket'

// Small loop by design: one look at the evidence, at most a few context pulls,
// one answer. A block that needs more than this isn't going to be named better
// by more steps — it's going to be named by the person.
const INTERPRETATION_AGENT_MAX_STEPS = 4
const INTERPRETATION_AGENT_TIMEOUT_MS = 45_000
const INTERPRETATION_AGENT_MAX_OUTPUT_TOKENS = 1_000

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('Local date, YYYY-MM-DD')

const INTERPRETATION_TOOL_DESCRIPTORS: AgentToolDescriptor[] = [
  {
    name: 'get_window_title_context',
    description: 'Window-title clusters for one app on one day',
    source: 'daylens',
    permissionState: 'available',
  },
  {
    name: 'get_calendar_events',
    description: 'The day\'s meetings',
    source: 'daylens',
    permissionState: 'available',
  },
  {
    name: 'get_git_activity',
    description: 'The day\'s git story',
    source: 'daylens',
    permissionState: 'available',
  },
  {
    name: 'read_meeting_notes',
    description: 'Consented Granola meeting notes',
    source: 'daylens',
    permissionState: 'requires_permission',
  },
  {
    name: 'lookup_entity',
    description: 'Work attributed to one named client or project',
    source: 'daylens',
    permissionState: 'available',
  },
]

const LIVE_CAPTURE_DESCRIPTOR: AgentToolDescriptor = {
  name: 'capture_screen',
  description: 'One consented still of the live screen, never stored',
  source: 'daylens',
  permissionState: 'requires_permission',
}

function interpretationToolDescriptors(block: WorkContextBlock): AgentToolDescriptor[] {
  if (!block.isLive) return INTERPRETATION_TOOL_DESCRIPTORS
  return [...INTERPRETATION_TOOL_DESCRIPTORS, LIVE_CAPTURE_DESCRIPTOR]
}

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

/** The SAME standard the direct relabel path enforces
 *  (generateWorkBlockInsight's labelRejection in jobs/aiService.ts), through
 *  the one shared gate (labelCandidateViolation): every invariant rule —
 *  which bounds the label to 90 chars / 12 words — the two target rules that
 *  catch echoed window titles and bare app names ("Slack" is software, not
 *  an activity), and the work-name-guard vocabulary, so a tool surface can't
 *  hide behind a verb lead ("Working on Cursor Agents"). Returns the
 *  violation detail, or null when the label passes. Exported for direct
 *  testing. */
export function agentLabelViolation(label: string | null | undefined, block: WorkContextBlock): string | null {
  return labelCandidateViolation(label, labelVoiceContextForBlock(block, effectiveBlockKind(block)))
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

function interpretQuestion(block: WorkContextBlock, date: string): string {
  const apps = block.topApps.map((app) => app.appName.trim()).filter(Boolean).slice(0, 5)
  const titles = (block.evidenceSummary.windowTitles ?? [])
    .map((window) => window.title?.trim())
    .filter((title): title is string => Boolean(title))
    .slice(0, 4)
  const parts = [
    `Name the activity in the low-confidence block on ${date}.`,
    `Heuristic label: ${block.label.current.trim() || 'unnamed'}.`,
  ]
  if (apps.length > 0) parts.push(`Apps: ${apps.join(', ')}.`)
  if (titles.length > 0) parts.push(`Window titles: ${titles.join('; ')}.`)
  return parts.join(' ')
}

function renderInterpretPacket(packet: ContextPacket): string {
  if (packet.items.length === 0) {
    return [
      `Context packet ${packet.id} — assembled locally for this interpretation turn.`,
      'It contains no additional recorded items. Use the block evidence and the read-only tools. Never invent activity.',
    ].join(' ')
  }
  const lines = packet.items.map((item) => `- ${item.statement}`)
  const extras: string[] = []
  if (packet.conflicts.length > 0) {
    extras.push(
      'Where the record disagrees with itself, treat the person\'s correction as authority:',
      ...packet.conflicts.map((conflict) => `- ${conflict.detail}`),
    )
  }
  if (packet.gaps.length > 0) {
    extras.push(
      'Gaps in the record — do not read silence as inactivity:',
      ...packet.gaps.map((gap) => `- ${gap.detail}`),
    )
  }
  return [
    `Context packet ${packet.id} — assembled locally from corrected Daylens data before this request. Orienting context only; verify specifics with tools. Do not put citation markers in the JSON label or narrative.`,
    'Recorded items:',
    ...lines,
    ...extras,
  ].join('\n')
}

async function assembleInterpretPacket(
  db: Database.Database,
  block: WorkContextBlock,
  date: string,
  destination: string,
  availableTools: AgentToolDescriptor[],
): Promise<ContextPacket> {
  const now = new Date()
  const question = interpretQuestion(block, date)
  const packet = await buildContextPacket(db, {
    purpose: 'interpret',
    question,
    dates: [date],
    now,
    destination,
    availableTools,
  })
  if (!contextPacketsAvailable(db)) {
    throw markContextPacketFailure(new Error('Context packet recording is unavailable.'))
  }
  try {
    recordContextPacket(db, packet, {
      exchangeKind: 'day_analysis',
      scopeKey: date,
    })
  } catch (error) {
    throw markContextPacketFailure(error instanceof Error ? error : new Error(String(error)))
  }
  return packet
}

// Tier-1 read-only context. Calendar, git, and meeting notes come from the SAME
// builders the chat agent uses; window titles
// and entity lookup reuse the wrap/MCP executors so every result crosses the
// same privacy boundaries before reaching the model. Live screen capture is
// registered only for a current block, and the executor re-checks that the
// block is still current.
function buildInterpretationTools(
  db: Database.Database,
  options: { allowCollect: boolean; block: WorkContextBlock },
) {
  const run = async (fn: () => Promise<unknown> | unknown): Promise<unknown> => {
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
        run(() => executeWrappedTool('getWindowTitleContext', { date, appName }, db)),
    }),
    ...buildContextTools(db, { allowCollect: options.allowCollect }),
    lookup_entity: tool({
      description: 'Work attributed to one named client or project (partial name match). Use to check whether a name in the evidence is a known client/project.',
      inputSchema: z.object({ entityName: z.string().min(1) }),
      execute: ({ entityName }) =>
        run(() => executeTool('getAttributionContext', { entityName }, db)),
    }),
    ...(options.block.isLive
      ? buildScreenTools({ isAuthorized: () => options.block.isLive })
      : {}),
  }
}

type UsageRecordedError = Error & { usageRecorded?: boolean }

type ContextPacketFailure = Error & { contextPacketFailure?: boolean }

function markContextPacketFailure(error: Error): ContextPacketFailure {
  return Object.assign(error, { contextPacketFailure: true })
}

export function isInterpretationContextPacketFailure(
  error: unknown,
): error is ContextPacketFailure {
  return error instanceof Error && (error as ContextPacketFailure).contextPacketFailure === true
}

/** Marks an error whose failure event is already metered, so the outer catch
 *  never records the same turn twice. */
function markUsageRecorded(error: Error): UsageRecordedError {
  return Object.assign(error, { usageRecorded: true })
}

function addUsage(target: AIProviderUsage, incoming: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): void {
  target.inputTokens = (target.inputTokens ?? 0) + (incoming.inputTokens ?? 0)
  target.outputTokens = (target.outputTokens ?? 0) + (incoming.outputTokens ?? 0)
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (incoming.cacheReadTokens ?? 0)
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
  const usage: AIProviderUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const destination = `${config.provider}:${config.model}`
  let packet: ContextPacket
  try {
    packet = await assembleInterpretPacket(
      db,
      block,
      date,
      destination,
      interpretationToolDescriptors(block),
    )
  } catch (error) {
    recordInterpretationAgentUsage({
      config, usage: null, startedAt, success: false, triggerSource,
      failureReason: error instanceof Error ? error.message : String(error),
    })
    throw markUsageRecorded(error instanceof Error ? error : new Error(String(error)))
  }

  const system = [
    VOICE_SYSTEM_PROMPT,
    'You are Daylens.',
    'You label productivity timeline blocks from local activity evidence.',
    block.isLive
      ? 'This block\'s evidence was too weak for a confident name, so you may call the provided read-only tools to pull more context (window titles, calendar, git, known clients/projects, consented screen) before answering.'
      : 'This block\'s evidence was too weak for a confident name, so you may call the provided read-only tools to pull more context (window titles, calendar, git, known clients/projects) before answering.',
    block.isLive
      ? 'Exhaust cheaper tools first. Escalate to capture_screen only when the block is happening now, naming confidence is still low, and the database cannot resolve the ambiguity — and say why in the required reason.'
      : 'Do not request a live screen capture. This block is historical; name it from recorded evidence and the read-only tools.',
    'Call a tool only when it can plausibly resolve the ambiguity; answer directly when the evidence already suffices.',
    'Do not use emoji. Be concrete, restrained, and evidence-led. Never mention the model provider.',
    'When you have enough context, reply with ONLY strict JSON:',
    '{"label":"...","narrative":"...","confidence":0.0-1.0,"reasoning":"..."}',
    'label: a 2-7 word phrase naming what they were DOING (verb + object). NEVER a raw app name, window title, filename, page/video title, or bare category.',
    'narrative: 1-2 plain sentences, evidence-led, no hype.',
    'confidence: your honest 0-1 confidence in the label.',
    'reasoning: one sentence naming the evidence that decided it.',
    renderInterpretPacket(packet),
  ].join('\n\n')

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
    const runtime = new AISdkAgentRuntime(options.model ?? languageModelFor(config))
    const tools = buildInterpretationTools(db, { allowCollect: options.allowCollect ?? true, block })
    let finalText = ''
    let stepText = ''
    let stepUsedTool = false
    let runFailure: { message: string } | null = null
    for await (const event of runtime.run({
      runId: `interpret_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
      contextPacket: packet,
      tools,
      output: { kind: 'text' },
      limits: {
        maxSteps: INTERPRETATION_AGENT_MAX_STEPS,
        maxOutputTokens: INTERPRETATION_AGENT_MAX_OUTPUT_TOKENS,
        timeoutMs: INTERPRETATION_AGENT_TIMEOUT_MS,
      },
      system,
      messages: [{ role: 'user', content: prompt }],
      signal: abortSignal,
      execution: {
        provider: config.provider,
        cachePolicy: 'off',
        promptCachingEnabled: false,
        label: 'interpretation_agent',
      },
    })) {
      switch (event.type) {
        case 'step_started':
          stepText = ''
          stepUsedTool = false
          break
        case 'text':
          stepText += event.text
          break
        case 'tool_request':
          stepUsedTool = true
          toolsUsed.push(event.toolName)
          break
        case 'step_completed':
          if (!stepUsedTool && stepText.trim()) finalText = stepText.trim()
          break
        case 'completion':
          if (!stepUsedTool && stepText.trim()) finalText = stepText.trim()
          break
        case 'usage':
          addUsage(usage, {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheReadTokens,
          })
          break
        case 'failure':
          runFailure = event.error
          break
        case 'cancellation':
          throw new Error(event.reason || 'Interpretation agent run cancelled.')
        default:
          break
      }
    }
    if (runFailure) {
      throw new Error(runFailure.message)
    }
    const parsed = parseInterpretationAgentInsight(finalText)
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
        config, usage: usage.inputTokens || usage.outputTokens ? usage : null, startedAt, success: false, triggerSource,
        failureReason: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}
