// The chat agent loop. One loop for every chat answer: the model
// reasons over the conversation, calls read-only tools, optionally asks the
// user one clarifying question, and streams the answer in the Daylens voice.
//
// Grounding is enforced here, not hoped for:
//   - every tool returns real rows or an explicit miss (tool contracts),
//   - the turn keeps a full tool trace (persisted with the message),
//   - clock times and named entities in the final text are verified against
//     the turn's tool results; one violation triggers one corrective retry
//     whose replacement streams over the same snapshot channel.
//
// This function is the ONE chat entrypoint body — the IPC handler and the
// terminal bench both reach it through sendMessage. Keep every
// behavior deps-injected so the bench cannot diverge from the UI.
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { AIAgentStep, AIMessageArtifact, AgentTurnWaitKind } from '@shared/types'
import { statusForTool } from '@shared/agentTrail'
import type { ResolvedProviderConfig, AIProviderUsage } from '../services/aiOrchestration'
import { providerLabel } from '../services/aiOrchestration'
import { recordProviderCall } from '../services/aiRateLimiter'
import { verifyTimestamps, verifyCitedEntities } from '../ai/citations'
import { languageModelFor } from './providerModel'
import { buildDaylensTools } from './daylensTools'
import { buildContextTools } from './contextTools'
import { buildScreenTools } from './screenTools'
import { buildSystemTools, type FileAccessAnswer } from './systemTools'
import { buildTerminalTools, type TerminalAccessAnswer } from './terminalTools'
import type { FileDisclosureRow } from '../services/fileAccess'
import { buildExportTools, buildInteractionTools, createArtifact, type AgentQuestion, type InteractionDeps } from './interactionTools'
import { buildMemoryTools } from './memoryTools'
import { buildCorrectionTools, type CorrectionToolHooks } from './correctionTools'
import { connectMcpTools, type McpServerConfig } from './mcpTools'
import {
  buildContextPacket,
  CONTEXT_POLICY_VERSION,
  contextPacketsAvailable,
  DEFAULT_CONTEXT_BUDGET,
  recordContextPacket,
  renderContextPacketForAgent,
  type ContextPacket,
} from '../services/contextPacket'
import { resolvePacketCitations, type PacketCitation } from './contextCitations'
import { getCurrentTrace } from '../ai/trace'
import { buildAgentSystemPrompt } from './systemPrompt'
import { renderTimeChunkAnswer, wantsTimeChunkTable, type TimeChunkResult } from './timeChunkAnswer'
import { sanitizeForRender } from '@shared/aiSanitize'
import { pausedError } from '../lib/aiCancellation'
import {
  AISdkAgentRuntime,
  type AgentToolInteraction,
} from './agentRuntime'

const MAX_STEPS = 14
const MAX_OUTPUT_TOKENS = 8_000
const MAX_TOOL_RESULT_CHARS = 60_000

const PERSON_INPUT_TOOLS = new Set([
  'ask_user',
  'propose_memory',
  'forget_memory',
  'propose_correction',
  'undo_correction',
])

const PERMISSION_TOOLS = new Set([
  'read_file',
  'run_command',
])

function toolInteractionsFor(tools: ToolSet): Record<string, AgentToolInteraction> {
  const interactions: Record<string, AgentToolInteraction> = {}
  for (const name of Object.keys(tools)) {
    if (PERSON_INPUT_TOOLS.has(name)) interactions[name] = 'person_input'
    else if (PERMISSION_TOOLS.has(name)) interactions[name] = 'permission'
    else interactions[name] = 'tool'
  }
  return interactions
}

function emptyContextPacket(question: string, destination: string, now: Date): ContextPacket {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return {
    id: `ctx_empty_${now.getTime().toString(36)}`,
    purpose: 'answer',
    request: {
      originalText: question,
      timeRange: {
        startDate: date,
        endDate: date,
        dates: [date],
        resolution: 'default',
      },
      dates: [date],
      entityIds: [],
    },
    person: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      confirmedPreferences: [],
    },
    items: [],
    conflicts: [],
    gaps: [],
    permissions: [],
    tools: [],
    actionContext: null,
    contextBudget: DEFAULT_CONTEXT_BUDGET,
    disclosure: {
      destination,
      leftDevice: false,
      policyVersion: CONTEXT_POLICY_VERSION,
      itemCount: 0,
      counts: {},
      omissions: [{ kind: 'day_fact', count: 1, reason: 'unavailable' }],
    },
    policyVersion: CONTEXT_POLICY_VERSION,
    contentFingerprint: 'empty',
    assembledAt: now.getTime(),
  }
}

interface PageVisitToolResult {
  pages?: Array<{ pageTitle?: string | null; url?: string | null; totalSeconds?: number; visitCount?: number }>
}

export interface AgentToolTraceEntry {
  tool: string
  input: unknown
  /** JSON of the tool result, truncated for persistence. */
  output: string
  /** The call errored (distinct from a tool's own explicit miss), so a
   *  reconstructed trail can show the failure honestly. */
  failed?: boolean
}

export interface ChatAgentDeps {
  db: Database.Database
  config: ResolvedProviderConfig
  /** Streams the growing answer (and tool status lines) to the renderer / bench collector. */
  onStreamEvent?: (event: { delta: string; snapshot: string; status?: string; step?: AIAgentStep }) => void | Promise<void>
  askUser: (question: AgentQuestion) => Promise<string>
  artifactDir: string
  mcpServers?: McpServerConfig[]
  extraSystem?: string | null
  signal?: AbortSignal
  now?: Date
  trackingStart?: string | null
  model?: LanguageModel
  /** Thread the turn belongs to; recorded on file disclosures (DEV-184). */
  threadId?: number | null
  /** Production hooks for agent-proposed corrections (DEV-199): live-session
   *  resolution, pre-merge session flush, projection invalidation. Optional so
   *  the bench and tests run without Electron; the tools themselves are always
   *  available and always confirm through the askUser card. */
  corrections?: CorrectionToolHooks
  /** The turn's visible state machine (DEV-200): every agent-initiated wait —
   *  clarification, file permission, memory or correction confirmation, all of
   *  which ride the askUser channel — reports `awaiting_user` with its kind
   *  before the card goes up, and `running` when the answer arrives. */
  onPhase?: (event: { phase: 'running' | 'awaiting_user'; waitKind: AgentTurnWaitKind | null }) => void
}

export interface ChatAgentResult {
  text: string
  toolTrace: AgentToolTraceEntry[]
  artifacts: AIMessageArtifact[]
  usage: AIProviderUsage
  stepCount: number
  groundingRetried: boolean
  /** The recorded context packet the turn answered from (DEV-182); null when
   *  the packet ledger is unavailable on this database. */
  contextPacketId: string | null
  /** Verified packet citations in the answer, in display order — every entry
   *  resolves to an item in the recorded packet. */
  citations: PacketCitation[]
  /** Files whose contents were disclosed to the model this turn (DEV-184) —
   *  persisted with the message so the sources row can cite opened files. */
  fileDisclosures: Array<{
    path: string
    name: string
    versionFingerprint: string
    excerptStart: number
    excerptEnd: number
    disclosedAt: number
  }>
}

/**
 * Tool results carry epoch-ms numbers; the verifiers compare literal strings.
 * Augment the evidence corpus with local HH:MM / YYYY-MM-DD renderings of every
 * epoch-shaped number so a correctly cited time never reads as a violation.
 */
function evidenceWithFormattedTimes(raw: string): string {
  const extras = new Set<string>()
  const numberPattern = /\b1[5-9]\d{11}\b|\b2[0-2]\d{11}\b/g
  let match: RegExpExecArray | null
  while ((match = numberPattern.exec(raw)) !== null) {
    const value = Number(match[0])
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) continue
    extras.add(`${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`)
    extras.add(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)
  }
  return extras.size > 0 ? `${raw}\n${[...extras].join(' ')}` : raw
}

export async function runChatAgentTurn(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  deps: ChatAgentDeps,
): Promise<ChatAgentResult> {
  const now = deps.now ?? new Date()
  const artifacts: AIMessageArtifact[] = []
  const toolTrace: AgentToolTraceEntry[] = []
  const toolResultStrings: string[] = []
  let timeChunkResult: TimeChunkResult | null = null
  let pageVisitResult: PageVisitToolResult | null = null
  let stepCount = 0

  const usage: AIProviderUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const addUsage = (u: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined) => {
    if (!u) return
    usage.inputTokens = (usage.inputTokens ?? 0) + (u.inputTokens ?? 0)
    usage.outputTokens = (usage.outputTokens ?? 0) + (u.outputTokens ?? 0)
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (u.cachedInputTokens ?? 0)
  }

  // The exchange starts from the recorded context packet (DEV-182): assembled
  // deterministically from the corrected read models, persisted BEFORE any
  // request leaves the device, then rendered into the model prompt with
  // per-item citation markers. Assembly failure degrades to an empty packet so
  // the provider-independent runtime still has a typed context boundary — it
  // never blocks the answer.
  const destination = `${deps.config.provider}:${deps.config.model}`
  let contextPacket: ContextPacket = emptyContextPacket(question, destination, now)
  let contextPacketRecorded = false
  try {
    contextPacket = await buildContextPacket(deps.db, {
      purpose: 'answer',
      question,
      now,
      destination,
    })
    if (contextPacketsAvailable(deps.db)) {
      recordContextPacket(deps.db, contextPacket, {
        exchangeKind: 'chat',
        threadId: deps.threadId ?? null,
      })
      contextPacketRecorded = true
    }
  } catch (error) {
    console.warn('[agent] context packet assembly failed; answering from tools only', error)
    contextPacket = emptyContextPacket(question, destination, now)
  }
  // Packet statements count as evidence for the grounding verifiers: a time or
  // name the packet disclosed is cited, not hallucinated, even when the model
  // answered without re-fetching it through a tool.
  const packetEvidence = contextPacket.items.length > 0
    ? contextPacket.items.map((item) => item.statement).join('\n')
    : ''

  const mcp = await connectMcpTools(deps.mcpServers ?? [])
  try {
    // Every user-facing card the agent can raise goes through askUser; wrapping
    // it per kind is what makes the waits ONE visible state machine (DEV-200):
    // the turn reports awaiting_user (with which card) while paused on the
    // promise, and running again the moment the answer lands.
    const askUserAs = (waitKind: AgentTurnWaitKind) => async (question: AgentQuestion): Promise<string> => {
      deps.onPhase?.({ phase: 'awaiting_user', waitKind })
      try {
        return await deps.askUser(question)
      } finally {
        deps.onPhase?.({ phase: 'running', waitKind: null })
      }
    }
    const interactionDeps: InteractionDeps = {
      askUser: askUserAs('clarification'),
      artifactDir: deps.artifactDir,
      onArtifact: (artifact) => artifacts.push(artifact),
      signal: deps.signal,
    }
    // The in-chat file-permission card (DEV-184): a content read on an
    // ungranted path pauses the turn through the existing askUser machinery.
    // "Allow this folder" persists a chat-sourced model-readable grant;
    // "Allow once" covers exactly this turn; anything else is a denial.
    const fileDisclosures: FileDisclosureRow[] = []
    const askFilePermission = askUserAs('file_permission')
    const requestFileAccess = async (request: { path: string; sizeBytes: number | null; reason: string }): Promise<FileAccessAnswer> => {
      const size = request.sizeBytes != null ? ` (${Math.max(1, Math.round(request.sizeBytes / 1024))} KB)` : ''
      const answer = await askFilePermission({
        question: `Daylens wants to open ${request.path}${size} to answer this.`,
        options: ['Allow once', 'Allow this folder', 'Deny'],
        allowFreeText: false,
      })
      const normalized = answer.trim().toLowerCase()
      if (normalized === 'allow once') return 'allow_once'
      if (normalized === 'allow this folder') return 'allow_folder'
      return 'deny'
    }
    // The consent card for run_command rides the SAME permission machinery as
    // file reads: the turn pauses as awaiting_user(file_permission), and only
    // an explicit allow runs anything.
    const requestTerminalAccess = async (request: { command: string; args: string[]; cwd: string; reason: string }): Promise<TerminalAccessAnswer> => {
      const commandLine = [request.command, ...request.args].join(' ')
      const answer = await askFilePermission({
        question: `Daylens wants to run \`${commandLine}\` in ${request.cwd} — ${request.reason}`,
        options: ['Allow once', 'Allow for this session', 'Deny'],
        allowFreeText: false,
      })
      const normalized = answer.trim().toLowerCase()
      if (normalized === 'allow once') return 'allow_once'
      if (normalized === 'allow for this session') return 'allow_session'
      return 'deny'
    }
    const tools: ToolSet = {
      ...buildDaylensTools(deps.db),
      // Calendar, git-signal, and meeting-notes context: same executors as
      // the wrap/MCP surface, policy-gated in the tools themselves.
      ...buildContextTools(deps.db),
      ...buildSystemTools({
        db: deps.db,
        fileAccess: {
          db: deps.db,
          threadId: deps.threadId ?? null,
          destination: `${deps.config.provider}:${deps.config.model}`,
          requestFileAccess,
          onDisclosure: (row) => fileDisclosures.push(row),
        },
      }),
      ...buildInteractionTools(interactionDeps),
      // Tier-3 live-screen escalation: consent-gated in Settings, refuses
      // honestly when the toggle is off.
      ...buildScreenTools(),
      // Consent-gated read-only terminal access: allowlist-first, no shell,
      // off by default, first use per session confirmed on the same card.
      ...buildTerminalTools({
        db: deps.db,
        threadId: deps.threadId ?? null,
        destination: `${deps.config.provider}:${deps.config.model}`,
        signal: deps.signal,
        requestTerminalAccess,
        onDisclosure: (row) => fileDisclosures.push(row),
      }),
      ...buildExportTools(deps.db, interactionDeps),
      // The confirmed-memory proposal card (DEV-185): a durable personal fact
      // pauses the turn through the same askUser machinery as file access;
      // only an explicit confirmation (or a typed correction) persists.
      ...buildMemoryTools({
        db: deps.db,
        askUser: askUserAs('memory_confirmation'),
        threadId: deps.threadId ?? null,
        signal: deps.signal,
      }),
      // Conversational corrections (DEV-199): the same preview/confirm/apply/
      // undo machinery as the Timeline's correction UI, behind an explicit
      // confirmation card — the model can propose, never silently write.
      ...buildCorrectionTools({
        db: deps.db,
        askUser: askUserAs('correction_confirmation'),
        hooks: deps.corrections,
        signal: deps.signal,
      }),
      ...mcp.tools,
    }

    const renderedPacket = renderContextPacketForAgent(contextPacket)
    // The trace recorder (eval harness / DAYLENS_AI_TRACE_DIR) needs the packet
    // as evidence: facts the model quotes from it are grounded, not fabricated.
    if (renderedPacket) {
      getCurrentTrace()?.addEvent({
        kind: 'context_packet',
        rendered: renderedPacket,
        itemCount: contextPacket.items.length,
      })
    }
    const system = [
      buildAgentSystemPrompt({
        now,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        trackingStart: deps.trackingStart ?? null,
        providerLabel: providerLabel(deps.config.provider),
        model: deps.config.model,
        homeDir: os.homedir(),
        extraSystem: deps.extraSystem,
      }),
      renderedPacket,
    ].filter(Boolean).join('\n\n')

    const messages: ModelMessage[] = [
      ...history.map((message) => ({ role: message.role, content: message.content } as ModelMessage)),
      { role: 'user', content: question },
    ]

    const runtime = new AISdkAgentRuntime(deps.model ?? languageModelFor(deps.config))
    const toolInteractions = toolInteractionsFor(tools)

    const streamTurn = async (turnMessages: ModelMessage[]): Promise<string> => {
      let finalText = ''
      let stepText = ''
      let stepUsedTool = false
      let stepToolUses: Array<{ id: string; name: string; input: unknown }> = []
      let stepUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null = null
      const openSteps = new Map<string, AIAgentStep>()
      const toolInputs = new Map<string, unknown>()
      const settleStep = async (toolCallId: string, state: 'done' | 'failed') => {
        const opened = openSteps.get(toolCallId)
        if (!opened) return
        openSteps.delete(toolCallId)
        await deps.onStreamEvent?.({ delta: '', snapshot: '', step: { ...opened, state } })
      }
      const openToolStep = async (toolCallId: string, toolName: string, input: unknown) => {
        stepUsedTool = true
        toolInputs.set(toolCallId, input)
        stepToolUses.push({ id: toolCallId, name: toolName, input })
        const step: AIAgentStep = {
          id: toolCallId,
          label: statusForTool(toolName, input),
          state: 'active',
          startedAt: Date.now(),
        }
        openSteps.set(toolCallId, step)
        await deps.onStreamEvent?.({ delta: '', snapshot: '', status: step.label, step })
      }

      for await (const event of runtime.run({
        runId: `chat_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
        contextPacket,
        tools,
        toolInteractions,
        output: { kind: 'text' },
        limits: {
          maxSteps: MAX_STEPS,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
        system,
        messages: turnMessages,
        signal: deps.signal,
      })) {
        switch (event.type) {
          case 'step_started':
            stepCount += 1
            recordProviderCall()
            stepText = ''
            stepUsedTool = false
            stepToolUses = []
            stepUsage = null
            break
          case 'text':
            stepText += event.text
            break
          case 'tool_request':
          case 'permission_request':
          case 'person_input_request':
            await openToolStep(event.toolCallId, event.toolName, event.input)
            break
          case 'tool_result': {
            if (event.toolName === 'get_time_chunks') timeChunkResult = event.output as TimeChunkResult
            if (event.toolName === 'list_page_visits') pageVisitResult = event.output as PageVisitToolResult
            const input = toolInputs.get(event.toolCallId)
            const failedReason = event.failed
              && event.output
              && typeof event.output === 'object'
              && 'message' in event.output
              && typeof (event.output as { message?: unknown }).message === 'string'
              ? (event.output as { message: string }).message
              : 'tool error'
            const output = event.failed
              ? JSON.stringify({ found: false, reason: failedReason })
              : JSON.stringify(event.output ?? null)
            const truncated = !event.failed && output.length > MAX_TOOL_RESULT_CHARS
            const bounded = truncated ? `${output.slice(0, MAX_TOOL_RESULT_CHARS)}…` : output
            toolTrace.push({
              tool: event.toolName,
              input,
              output: bounded,
              ...(event.failed ? { failed: true } : {}),
            })
            if (!event.failed) toolResultStrings.push(evidenceWithFormattedTimes(bounded))
            getCurrentTrace()?.addEvent({
              kind: 'tool_result',
              name: event.toolName,
              input,
              output: event.failed
                ? { found: false, reason: 'tool error' }
                : truncated ? bounded : event.output ?? null,
              toolUseId: event.toolCallId,
              durationMs: Math.max(0, Date.now() - (openSteps.get(event.toolCallId)?.startedAt ?? Date.now())),
              truncated,
            })
            await settleStep(event.toolCallId, event.failed ? 'failed' : 'done')
            break
          }
          case 'usage':
            addUsage({
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cachedInputTokens: event.usage.cacheReadTokens,
            })
            stepUsage = {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheReadTokens: event.usage.cacheReadTokens,
            }
            break
          case 'step_completed':
            getCurrentTrace()?.addEvent({
              kind: 'turn',
              role: 'assistant',
              text: stepText.trim(),
              toolUses: stepToolUses,
              usage: stepUsage,
            })
            if (!stepUsedTool && stepText.trim()) finalText = stepText.trim()
            break
          case 'completion':
            if (stepText.trim()) finalText = stepText.trim()
            break
          case 'cancellation': {
            // Pending pause must surface as the product pause error so
            // aiService can resume; cancel remains a plain AbortError.
            if (event.pending) throw pausedError()
            const abortError = new Error('The operation was aborted')
            abortError.name = 'AbortError'
            throw abortError
          }
          case 'failure': {
            const failure = new Error(event.error.message)
            failure.name = event.error.code
            throw failure
          }
          default:
            break
        }
      }
      return finalText
    }

    let text = await streamTurn(messages)
    // The deterministic chunk table exists to guarantee complete-interval
    // fidelity when the user ASKED for increments. Gate it on the question:
    // a turn that merely consulted get_time_chunks while researching keeps
    // the model's actual answer instead of having it hijacked by a table.
    if (wantsTimeChunkTable(question)) {
      text = (timeChunkResult && renderTimeChunkAnswer(timeChunkResult)) || text
    }
    const exportFormat = /\b(?:excel|xlsx)\b/i.test(question) ? 'xlsx' : /\bcsv\b/i.test(question) ? 'csv' : null
    const exportPages = (pageVisitResult as PageVisitToolResult | null)?.pages
    if (exportFormat && artifacts.length === 0 && exportPages?.length) {
      await createArtifact(interactionDeps, {
        title: 'Page activity export',
        format: exportFormat,
        columns: ['Title', 'Total time (seconds)', 'Visits', 'URL'],
        rows: exportPages.map((page) => [
          page.pageTitle ?? '',
          page.totalSeconds ?? 0,
          page.visitCount ?? 0,
          page.url ?? '',
        ]),
      })
    }
    let groundingRetried = false

    // Grounding verification: every clock time and quoted entity
    // in the answer must appear in this turn's tool results (or the user's own
    // words). One named-violation retry; a second failure ships anyway with the
    // violation logged — never a crash, the soft-guard philosophy.
    if (text && toolResultStrings.length > 0) {
      const corpus = [...toolResultStrings, ...(packetEvidence ? [packetEvidence] : []), question]
      const timestamps = verifyTimestamps(text, corpus)
      const entities = verifyCitedEntities(text, corpus)
      if (!timestamps.ok || !entities.ok) {
        groundingRetried = true
        const problems = [
          ...timestamps.suspect.map((ts) => `the time ${ts} does not appear in any tool result`),
          ...entities.missingEntities.map((entity) => `"${entity}" does not appear in any tool result`),
        ].join('; ')
        console.warn(`[agent:grounding] retrying answer — ${problems}`)
        const retryMessages: ModelMessage[] = [
          ...messages,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: `Your answer failed the grounding check: ${problems}. Fix ONLY those items and keep everything else exactly as you wrote it: same answer, same voice, same length, same shape. Where a time was one you computed, replace it with the exact start and end the tool result shows, or drop it. You already have the evidence you need, so do not re-run the research you just did. Do not add caveats about coverage, and do not explain what you can or cannot see. Reply with the corrected answer only.`,
          },
        ]
        const replacement = await streamTurn(retryMessages)
        if (replacement) {
          text = replacement
          const recheck = verifyTimestamps(text, [...toolResultStrings, ...(packetEvidence ? [packetEvidence] : []), question])
          if (!recheck.ok) console.warn(`[agent:grounding] still suspect after retry: ${recheck.suspect.join(', ')}`)
        }
      }
    }

    // Resolve the answer's [Cn] markers against the recorded packet: verified
    // citations become superscripts + a citation list; a marker the packet
    // cannot back is dropped, so every persisted citation is real.
    const { text: citedText, citations } = resolvePacketCitations(text, contextPacket)
    text = citedText

    text = sanitizeForRender(text).text
    if (text) await deps.onStreamEvent?.({ delta: text, snapshot: text })

    return {
      text,
      toolTrace,
      artifacts,
      usage,
      stepCount,
      groundingRetried,
      contextPacketId: contextPacket && contextPacketRecorded ? contextPacket.id : null,
      citations,
      fileDisclosures: fileDisclosures.map((row) => ({
        path: row.file_path,
        name: row.display_name,
        versionFingerprint: row.version_fingerprint,
        excerptStart: row.excerpt_start,
        excerptEnd: row.excerpt_end,
        disclosedAt: row.disclosed_at,
      })),
    }
  } finally {
    await mcp.close()
  }
}
