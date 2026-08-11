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
import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type Database from 'better-sqlite3'
import os from 'node:os'
import type { AIAgentStep, AIMessageArtifact, AgentTurnWaitKind, SummaryVoice } from '@shared/types'
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
  contextPacketsAvailable,
  recordContextPacket,
  renderContextPacketForAgent,
  type ContextPacket,
} from '../services/contextPacket'
import { resolvePacketCitations, type PacketCitation } from './contextCitations'
import { getCurrentTrace } from '../ai/trace'
import { buildAgentSystemPrompt } from './systemPrompt'
import { renderTimeChunkAnswer, wantsTimeChunkTable, type TimeChunkResult } from './timeChunkAnswer'
import { sanitizeForRender } from '@shared/aiSanitize'

const MAX_STEPS = 14
const MAX_OUTPUT_TOKENS = 8_000
const MAX_TOOL_RESULT_CHARS = 60_000

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
  /** The person's chosen tone, read from settings by the production caller.
   *  Absent in the bench and tests, where it normalizes to the default. */
  summaryVoice?: SummaryVoice | null
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
  // per-item citation markers. Assembly failure degrades to a tools-only turn
  // (the tool results still ride the same privacy boundaries) — it never
  // blocks the answer.
  const destination = `${deps.config.provider}:${deps.config.model}`
  let contextPacket: ContextPacket | null = null
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
    contextPacket = null
  }
  // Packet statements count as evidence for the grounding verifiers: a time or
  // name the packet disclosed is cited, not hallucinated, even when the model
  // answered without re-fetching it through a tool.
  const packetEvidence = contextPacket && contextPacket.items.length > 0
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

    const renderedPacket = contextPacket ? renderContextPacketForAgent(contextPacket) : ''
    // The trace recorder (eval harness / DAYLENS_AI_TRACE_DIR) needs the packet
    // as evidence: facts the model quotes from it are grounded, not fabricated.
    if (renderedPacket) {
      getCurrentTrace()?.addEvent({
        kind: 'context_packet',
        rendered: renderedPacket,
        itemCount: contextPacket?.items.length ?? 0,
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
        summaryVoice: deps.summaryVoice ?? null,
      }),
      renderedPacket,
    ].filter(Boolean).join('\n\n')

    const messages: ModelMessage[] = [
      ...history.map((message) => ({ role: message.role, content: message.content } as ModelMessage)),
      { role: 'user', content: question },
    ]

    const streamTurn = async (turnMessages: ModelMessage[]): Promise<string> => {
      const result = streamText({
        model: deps.model ?? languageModelFor(deps.config),
        system,
        messages: turnMessages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: deps.signal,
      })

      let finalText = ''
      let stepText = ''
      let stepUsedTool = false
      // Tool calls issued in the current step, mirrored into the trace
      // recorder's turn event on finish-step.
      let stepToolUses: Array<{ id: string; name: string; input: unknown }> = []
      // Steps still running, keyed by tool call id, so the result (or error)
      // settles the SAME trail row its call opened.
      const openSteps = new Map<string, AIAgentStep>()
      const settleStep = async (toolCallId: string, state: 'done' | 'failed') => {
        const opened = openSteps.get(toolCallId)
        if (!opened) return
        openSteps.delete(toolCallId)
        await deps.onStreamEvent?.({ delta: '', snapshot: '', step: { ...opened, state } })
      }
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step':
            stepCount += 1
            recordProviderCall()
            stepText = ''
            stepUsedTool = false
            stepToolUses = []
            break
          case 'text-delta': {
            stepText += part.text
            break
          }
          case 'tool-call': {
            stepUsedTool = true
            stepToolUses.push({ id: part.toolCallId, name: part.toolName, input: part.input })
            const step: AIAgentStep = {
              id: part.toolCallId,
              label: statusForTool(part.toolName, part.input),
              state: 'active',
              startedAt: Date.now(),
            }
            openSteps.set(part.toolCallId, step)
            await deps.onStreamEvent?.({ delta: '', snapshot: '', status: step.label, step })
            break
          }
          case 'tool-result': {
            if (part.toolName === 'get_time_chunks') timeChunkResult = part.output as TimeChunkResult
            if (part.toolName === 'list_page_visits') pageVisitResult = part.output as PageVisitToolResult
            const output = JSON.stringify(part.output ?? null)
            const truncated = output.length > MAX_TOOL_RESULT_CHARS
            const bounded = truncated ? `${output.slice(0, MAX_TOOL_RESULT_CHARS)}…` : output
            toolTrace.push({ tool: part.toolName, input: part.input, output: bounded })
            toolResultStrings.push(evidenceWithFormattedTimes(bounded))
            getCurrentTrace()?.addEvent({
              kind: 'tool_result',
              name: part.toolName,
              input: part.input,
              output: truncated ? bounded : part.output ?? null,
              toolUseId: part.toolCallId,
              durationMs: Math.max(0, Date.now() - (openSteps.get(part.toolCallId)?.startedAt ?? Date.now())),
              truncated,
            })
            await settleStep(part.toolCallId, 'done')
            break
          }
          case 'tool-error': {
            const message = JSON.stringify({ found: false, reason: String((part as { error?: unknown }).error ?? 'tool error') })
            toolTrace.push({ tool: part.toolName, input: part.input, output: message, failed: true })
            getCurrentTrace()?.addEvent({
              kind: 'tool_result',
              name: part.toolName,
              input: part.input,
              output: { found: false, reason: 'tool error' },
              toolUseId: part.toolCallId,
              durationMs: Math.max(0, Date.now() - (openSteps.get(part.toolCallId)?.startedAt ?? Date.now())),
              truncated: false,
            })
            await settleStep(part.toolCallId, 'failed')
            break
          }
          case 'finish-step':
            addUsage(part.usage)
            getCurrentTrace()?.addEvent({
              kind: 'turn',
              role: 'assistant',
              text: stepText.trim(),
              toolUses: stepToolUses,
              usage: part.usage
                ? {
                    inputTokens: part.usage.inputTokens,
                    outputTokens: part.usage.outputTokens,
                    cacheReadTokens: part.usage.cachedInputTokens,
                  }
                : null,
            })
            if (!stepUsedTool && stepText.trim()) finalText = stepText.trim()
            break
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
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
