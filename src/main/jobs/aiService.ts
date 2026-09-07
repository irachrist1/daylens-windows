// AI service — runs in the main process only and routes to the selected provider.
// Renderer communicates via IPC (never direct SDK access)
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI, type Content as GoogleContent } from '@google/genai'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  appendConversationMessage,
  getAISurfaceSummary,
  getAISurfaceSummarySignature,
  getConversationMessages,
  getOrCreateConversation,
  getThreadMessages,
  getActiveFocusSession,
  getDistractionCountForSession,
  getRecentFocusSessions,
  upsertAISurfaceSummary,
  upsertConversationState,
  upsertWorkContextInsight,
} from '../db/queries'
import {
  buildDeterministicFollowUpCandidates,
  buildFollowUpSuggestionPrompts,
  buildStarterSuggestionPrompts,
  classifyQuestionShape,
  filterFollowUpCandidatesWithReport,
  isIdentityAnswer,
  parseFollowUpSuggestions,
  parseStarterSuggestions,
} from '../lib/followUpSuggestions'
import { transformInstruction } from '@shared/answerTransforms'
import { userVisibleBlockLabel } from '@shared/blockLabel'
import { labelCandidateViolation, labelProvenance, labelVoiceContextForBlock, rawLabelForm } from '@shared/labelVoice'
import { activityCategoryLabel } from '@shared/activityCategories'
import { effectiveBlockKind, partitionDomainsWorkFirst } from '@shared/workKind'
import { appNarrativeScopeKey, THIN_APP_NARRATIVE_SUMMARY } from '@shared/appNarrativeContract'
import { INTERPRETATION_DIRECTIVES } from '@shared/activityDescription'
import { normalizeSummaryVoice, voiceDirective } from '@shared/summaryVoice'
import { userProfileDirective } from '@shared/userProfile'
import { parseDaySummaryResultText } from '../lib/daySummaryParse'
import { shippedRecapVariant, type RecapPromptVariant } from '../ai/recapVariants'
import { claudeCodeChatAvailable, runClaudeCodeChat } from '../agent/claudeCodeChat'
import { buildAgentSystemPrompt } from '../agent/systemPrompt'
import { decodeProviderErrorMeta, isHardProviderWall } from '@shared/aiProviderError'
import { cliToolForProvider, resolveChatSelection } from '@shared/aiProviderState'
import {
  resolveDayContext,
} from '../core/query/attributionResolvers'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { deriveTitleFromMessage, isWeakThreadTitle, parseGeneratedThreadTitle, type ThreadTitleContext } from '../lib/threadTitles'
import { abortError, consumePauseRequest, isAbortError, pausedError, registerAICancellation, runWithAbortSignal, unregisterAICancellation } from '../lib/aiCancellation'
import {
  adoptTurnCheckpointForResume,
  agentTurnCheckpointsAvailable,
  closeTurnCheckpoint,
  getTurnCheckpoint,
  lookupActiveTurnCheckpoint,
  markTurnPaused,
  markTurnRunning,
  markTurnWaiting,
  openTurnCheckpoint,
  recordTurnStatus,
  registerActiveTurnCheckpoint,
  unregisterActiveTurnCheckpoint,
} from '../services/agentTurnState'
import { getDb } from '../services/database'
import { workMemoryPromptBlock, chatMemoryPromptBlock, getWorkMemoryProfile, getClientMemory, findClientScopeForWrite, clientScope as clientScopeId } from '../services/workMemoryProfile'
import { looksLikeMemoryInstruction, extractMemoryOps } from '../ai/memoryWrite'
import { attachActionWidgets, buildMemoryProposal, buildMergeBlocksProposal, buildRenameBlockProposal, filterMemoryOpsForProposal } from '../ai/actions'
import {
  createArtifact,
  createThread,
  getThread,
  getThreadSettings,
  listArtifactsByThread,
  renameThread,
  touchThreadLastMessage,
} from '../services/artifacts'
import { getApiKey, getSettings } from '../services/settings'
import { getCurrentSession, flushCurrentSession } from '../services/tracking'
import { localDayBounds } from '../lib/localDate'
import type {
  AgentTurnCheckpointView,
  AIAgentTurnPhaseEvent,
  AIArtifactKind,
  AIProviderMode,
  AIChatSendRequest,
  AIChatStreamEvent,
  AIMessageArtifact,
  AIMessageAction,
  AIActionWidget,
  AIAnswerKind,
  AIInvocationSource,
  AIChatTurnResult,
  AIConversationSourceKind,
  AIConversationState,
  AIDailyReportPreparationResult,
  AIDaySummaryResult,
  AISurfaceSummary,
  AIThreadMessage,
  AIThreadMessageMetadata,
  AppCategorySuggestion,
  DayTimelinePayload,
  FollowUpSuggestion,
  FocusSession,
  FocusStartPayload,
  LiveSession,
  SummaryVoice,
  WorkContextBlock,
  WorkContextInsight,
} from '@shared/types'
import { ALL_TIME_DAYS } from '@shared/types'
import { blockActiveSeconds } from '@shared/blockDuration'
import { isTrustedTimelineBlock } from '@shared/timelineReview'
import {
  executeTextAIJob,
  providerLabel,
  type AITextJobExecutionOptions,
  type ProviderTextResponse,
  type ResolvedProviderConfig,
} from '../services/aiOrchestration'
import { resolveProviderConfigsForJob, recordChatAgentUsage, jobTimeoutMs } from '../services/aiOrchestration'
import { withProviderCallCount, withProviderRateLimit } from '../services/aiRateLimiter'
import { friendlyProviderError } from '../services/providerErrors'
import { buildAnthropicPromptInput } from '../services/anthropicPromptCaching'
import {
  fallbackNarrativeForBlock,
  getTimelineDayPayload,
  userVisibleLabelForBlock,
} from '../services/workBlocks'
import { getAppDetailPayload } from '../services/appDetail'
import { workerAppDetail } from '../services/rangeWorker'
import { buildCLIProcessPayload, buildCLIProcessSpec } from '../services/cliLaunch'
import { historyWithUserTurn, toChatCompletionMessages, toGoogleHistory } from '../lib/providerChatMessages'
import { inferWorkIntent } from '../../shared/workIntent'
import { registerWrappedNarrativeProvider } from '../services/wrappedNarrative'
import { registerWrappedPeriodNarrativeProvider } from '../services/wrappedPeriodNarrative'
import { registerWrappedQuestionProvider } from '../services/wrappedQuestion'
import { VOICE_SYSTEM_PROMPT, containsEmDash, findBannedVocab, findPlumbingVocab } from '../ai/voiceContract'
import { parseDayRegroupGroups } from '../ai/dayRegroup'
import { maybeStartTrace, setCurrentTrace } from '../ai/trace'
import { runChatAgentTurn } from '../agent/chatAgent'
import { linkContextPacketToMessage } from '../services/contextPacket'
import { providerSupportsAgentTools } from '../agent/providerModel'
import type { AgentQuestion } from '../agent/interactionTools'
import { getAmbientAbortSignal } from '../lib/aiCancellation'
import { app } from 'electron'
import type { LanguageModel } from 'ai'
import { assertRealDayExternalAccessAllowed } from '../lib/realDayHarness'

const GOOGLE_CLIENT_HEADER = 'daylens-windows/1.0.0'
// Block labeling now runs on the user's chosen model (e.g. Sonnet), not a fixed
// fast tier, so the budget must accommodate a frontier model answering a
// foreground "regenerate label" click — 12s was tuned for Haiku and timed out.
const BLOCK_INSIGHT_TIMEOUT_MS = 45_000

type ConversationMessage = { role: 'user' | 'assistant'; content: string }

interface AnswerEnvelope {
  assistantText: string
  answerKind: AIAnswerKind
  sourceKind: AIConversationSourceKind
  conversationState: AIConversationState | null
  agent?: {
    toolTrace: Array<{ tool: string; input: unknown; output: string; failed?: boolean }>
    stepCount: number
    groundingRetried: boolean
    fileDisclosures?: import('@shared/types').AIMessageFileDisclosure[]
    contextPacketId?: string | null
    citations?: import('@shared/types').AIMessageCitation[]
  }
  suggestedFollowUps: FollowUpSuggestion[]
  actions?: AIMessageAction[]
  actionWidgets?: AIActionWidget[]
  artifacts?: AIMessageArtifact[]
}

interface SendMessageOptions {
  onStreamEvent?: (event: AIChatStreamEvent) => void
  /** Resolves the agent's one clarifying question. The IPC handler
   *  wires this to the renderer's question card; the bench scripts it. When
   *  absent the agent is told to answer with its most defensible reading. */
  onAgentQuestion?: (question: AgentQuestion) => Promise<string>
  /** The turn's visible state machine (DEV-200): running / awaiting_user /
   *  paused / terminal transitions, pushed to the renderer as they happen. */
  onPhaseEvent?: (event: AIAgentTurnPhaseEvent) => void
  /** When set and DAYLENS_AI_TRACE_DIR is configured, the trace file is
   *  written as <scenarioId>.json so the behavioural harness can match it. */
  traceScenarioId?: string | null
  /** Injects the model-provider boundary for deterministic verification. All
   * context assembly, tools, persistence, streaming, and grounding remain on
   * the production path. */
  model?: LanguageModel
}


interface ReportContextBundle {
  title: string
  scopeLabel: string
  assistantScaffold: string
  reportMarkdownScaffold: string
  tableColumns: string[]
  tableRows: Array<Record<string, string | number>>
  chartRows: Array<{ label: string; value: number; secondaryValue?: number | null }>
  chartValueLabel: string
  // When present, the report body is rendered deterministically from the
  // bundle's structured data — no LLM call, no fabrication risk. The chat
  // card response is a brief deterministic summary of the same numbers.
  renderDeterministic?: () => { reportMarkdown: string; assistantResponse: string }
}

type CLITool = 'claude' | 'chatgpt' | 'gemini' | 'codex'

interface CLIToolDetectionResult {
  claude: string | null
  chatgpt: string | null
  gemini: string | null
  codex: string | null
}

interface CodexExecCapabilities {
  supportsOutputLastMessage: boolean
  supportsSandbox: boolean
  supportsConfig: boolean
}

interface ResolvedCLITool {
  executablePath: string
  codexExecCapabilities: CodexExecCapabilities | null
}

class CLIProviderError extends Error {
  readonly code: 'not_found' | 'non_zero_exit' | 'timeout' | 'launch_failed'

  constructor(code: CLIProviderError['code'], message: string) {
    super(message)
    this.name = 'CLIProviderError'
    this.code = code
  }
}

const CLI_TIMEOUT_MS = 180_000
const daySummaryCache = new Map<string, AIDaySummaryResult>()
const cliToolCache: Partial<Record<CLITool, Promise<ResolvedCLITool | null>>> = {}
const STREAM_CHUNK_DELAY_MS = 12
const STREAM_CHUNK_SIZE = 32
const USER_VISIBLE_ACTIVITY_PROSE_RULE =
  'Never use raw app names as the activity. Describe activity, work threads, artifacts, pages, or context instead of listing tool names as nouns. '
  + 'When listing apps in response to "what were my top apps" or similar, the PROSE SUBJECT of each row must be the work, not the app. '
  + 'Use the dominantBlockLabel field on each app for the activity. The app name appears as tail-attribution after the activity, never as the row\'s bolded headline. The duration goes last. '
  + 'CORRECT row shape: "Coding in the Building & Testing block (Daylens chat-pipeline work): Kiro, 1h 19m." '
  + 'WRONG row shapes: "**Kiro**, coding in the Building & Testing block (1h 19m)" (app is still the headline); "Kiro, 1h 19m" (no activity at all); "Kiro: 1h 19m of coding" (app is the subject). '
  + 'Do not bold the app name as the row prefix. Do not put the app name before the colon. The colon separates activity (left) from attribution + duration (right). Never use an em dash anywhere in the row.'

// REQ-VIC-004. A block carrying `labelIsTheirOwnWords` was named by the person,
// not by Daylens. Their wording wins over anything the evidence would suggest,
// and it is never re-derived from: a name they typed is not something Daylens
// saw, so it cannot become the basis of an observation about their day.
const USER_AUTHORED_LABEL_RULE =
  'Some blocks carry "labelIsTheirOwnWords": the person renamed that stretch themselves. '
  + 'Use their wording exactly as written, in preference to anything the evidence would suggest for that stretch, and never rewrite, shorten, or "improve" it. '
  + 'What you must NOT do is treat a name inside it as something Daylens observed. If they called a block "Ridgeline renewal" and no page, title, file, or meeting in the evidence names Ridgeline, you may say they called it that; you may not say they worked on the Ridgeline renewal as a fact, and you may not carry "Ridgeline" into any other sentence as evidence.'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function emitTextDeltas(
  text: string,
  onDelta?: ((delta: string) => void | Promise<void>) | null,
): Promise<void> {
  if (!text || !onDelta) return
  for (let index = 0; index < text.length; index += STREAM_CHUNK_SIZE) {
    const chunk = text.slice(index, index + STREAM_CHUNK_SIZE)
    await Promise.resolve(onDelta(chunk))
    if (index + STREAM_CHUNK_SIZE < text.length) {
      await wait(STREAM_CHUNK_DELAY_MS)
    }
  }
}

function createChatStreamAccumulator(requestId: string | null | undefined, options?: SendMessageOptions) {
  let snapshot = ''

  return {
    get snapshot() {
      return snapshot
    },
    get enabled() {
      return Boolean(requestId && options?.onStreamEvent)
    },
    async push(delta: string) {
      if (!delta || !requestId || !options?.onStreamEvent) return
      snapshot += delta
      await Promise.resolve(options.onStreamEvent({
        requestId,
        delta,
        snapshot,
      }))
    },
    /** A line saying what is happening, with no text added to the answer. */
    async pushStatus(status: string) {
      if (!status || !requestId || !options?.onStreamEvent) return
      await Promise.resolve(options.onStreamEvent({
        requestId,
        delta: '',
        snapshot,
        status,
      }))
    },
    async streamText(text: string) {
      if (!text) return
      const nextText = snapshot && text.startsWith(snapshot)
        ? text.slice(snapshot.length)
        : text
      if (!nextText) return
      await emitTextDeltas(nextText, (chunk) => this.push(chunk))
    },
  }
}

function looksLikeFocusStartIntent(message: string): boolean {
  const normalized = message.toLowerCase()
  return /\b(start|begin|kick off|set up|launch|resume)\b(?:\s+(?:a|an|my))?(?:\s+\d{1,3}\s*(?:m|min|mins|minute|minutes))?\s+focus(?:\s+session)?\b/.test(normalized)
    || /\bfocus(?:\s+session)?\b.*\b(start|begin|kick off|set up|launch|resume)\b/.test(normalized)
}

function looksLikeFocusStopIntent(message: string): boolean {
  const normalized = message.toLowerCase()
  return /\b(stop|end|finish|wrap up|close|complete)\b(?:\s+(?:my|the))?(?:\s+(?:current|active))?\s+focus(?:\s+session)?\b/.test(normalized)
    || /\bfocus(?:\s+session)?\b.*\b(stop|end|finish|wrap up|close|complete)\b/.test(normalized)
}

function looksLikeFocusReviewIntent(message: string): boolean {
  const normalized = message.toLowerCase()
  return /\b(review|reflect|reflection|recap)\b.*\bfocus(?:\s+session)?\b/.test(normalized)
    || /\bfocus(?:\s+session)?\b.*\b(review|reflect|reflection|recap)\b/.test(normalized)
}

function extractFocusTargetMinutes(message: string): number | null {
  const match = message.match(/\b(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/i)
  if (!match) return null
  const minutes = Number(match[1])
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return Math.min(minutes, 480)
}

function inferFocusLabel(message: string): string | null {
  const stripped = message
    .replace(/\b(start|begin|kick off|set up|launch|resume)\b/gi, ' ')
    .replace(/\bfocus(?:\s+session)?\b/gi, ' ')
    .replace(/\b(?:a|an|my)\s+\d{1,3}\s*(?:m|min|mins|minute|minutes)\b/gi, ' ')
    .replace(/\bfor\s+\d{1,3}\s*(?:m|min|mins|minute|minutes)\b/gi, ' ')
    .replace(/[?.!,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!stripped) return null
  const trimmed = stripped.replace(/^(on|around|about|called|named)\s+/i, '').trim()
  if (/^(?:for\s+)?(?:what\s+i(?:'m| am)\s+doing\s+now|this\s+work)$/i.test(trimmed)) {
    return null
  }
  if (!trimmed || trimmed.length > 80) return null
  return trimmed
}

function buildFocusStartPayloadFromContext(message: string, liveSession: LiveSession | null): FocusStartPayload {
  const plannedApps = liveSession && liveSession.category !== 'system'
    ? [liveSession.appName]
    : []

  return {
    label: inferFocusLabel(message),
    targetMinutes: extractFocusTargetMinutes(message),
    plannedApps,
  }
}

function formatFocusDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.round((rounded % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${rounded}s`
}

function focusSessionDurationSeconds(session: FocusSession): number {
  if (session.endTime !== null) return session.durationSeconds
  return Math.max(0, Math.round((Date.now() - session.startTime) / 1_000))
}

function buildFocusReviewNote(session: FocusSession, distractionCount: number): string {
  const parts = [
    `Session: ${session.label || 'Focus session'}`,
    `Duration: ${formatFocusDuration(session.durationSeconds)}`,
  ]

  if (session.targetMinutes) {
    parts.push(`Target: ${session.targetMinutes}m`)
  }
  if (session.plannedApps.length > 0) {
    parts.push(`Planned apps: ${session.plannedApps.join(', ')}`)
  }
  if (distractionCount > 0) {
    parts.push(`Distractions noticed: ${distractionCount}`)
  }

  return `${parts.join(' · ')}.\nWhat went well, what interrupted you, and what should the next session keep or change?`
}

// The conversation write path for memory (memory.md §2.1, ai-actions.md). When
// the user tells Daylens to remember/forget/correct something, we extract the
// change and PREVIEW it as a memory card — nothing is written until they
// confirm (invariant 1: never a silent mutation). Returns null when the message
// isn't a memory instruction or the extractor found nothing durable to change,
// so the normal answer path runs untouched.
async function maybeHandleMemoryInstruction(
  message: string,
  runner: typeof sendWithProvider,
  prior: ConversationMessage[],
): Promise<AnswerEnvelope | null> {
  if (!looksLikeMemoryInstruction(message)) return null
  const db = getDb()
  // If the instruction names one client ("remember Acme's deadline is the 30th"),
  // the write goes to that client's scope and the extractor reasons against the
  // client's facts (so a correction updates the right one) — memory.md §2.2.
  // Otherwise it's general memory.
  const clientScope = findClientScopeForWrite(db, message)
  const scopeFacts = clientScope
    ? getClientMemory(db, clientScope.clientId)
    : getWorkMemoryProfile(db).facts
  const currentFacts = scopeFacts.map((fact) => ({ id: fact.id, text: fact.text }))
  const extracted = await extractMemoryOps({ message, currentFacts, runner, prior })
  // Confirmation-gate filter (DEV-185): sensitive facts are never proposed,
  // and a previously rejected fact is not re-proposed without new evidence.
  const ops = filterMemoryOpsForProposal(db, extracted)
  if (ops.length === 0) return null
  const proposal = buildMemoryProposal(
    ops,
    currentFacts,
    clientScope ? { scopeId: clientScopeId(clientScope.clientId), scopeName: clientScope.clientName } : null,
  )
  if (!proposal) return null

  const scopeNote = clientScope ? ` to ${clientScope.clientName}'s memory` : ''
  const opKinds = new Set(proposal.ops.map((op) => op.op))
  const assistantText = opKinds.size === 1 && opKinds.has('add')
    ? (proposal.ops.length === 1
      ? `Want me to remember this${scopeNote}? Confirm and it goes into your memory.`
      : `Want me to remember these${scopeNote}? Confirm and they go into your memory.`)
    : opKinds.size === 1 && opKinds.has('delete')
      ? "Here's what I'd forget — confirm and it's gone for good."
      : opKinds.size === 1 && opKinds.has('update')
        ? "Here's the correction — confirm and I'll update your memory."
        : "Here's the memory change — confirm and I'll apply it."

  return {
    assistantText,
    answerKind: 'freeform_chat',
    sourceKind: 'freeform',
    conversationState: null,
    suggestedFollowUps: [],
    actionWidgets: [proposal],
  }
}

// The block-rename action (ai-actions.md §5). "Rename my afternoon block to
// networking" → resolve the target block from the real day and PREVIEW the
// rename in a block card; the write runs only on confirm. Returns null when it
// can't pin a single block to a clear new name, so the normal path answers.
function maybeHandleRenameInstruction(message: string, contextDate: string | null): AnswerEnvelope | null {
  const proposal = buildRenameBlockProposal(getDb(), message, contextDate)
  if (!proposal) return null
  return {
    assistantText: "Here's the rename — confirm and it sticks across your timeline.",
    answerKind: 'deterministic_stats',
    sourceKind: 'deterministic',
    conversationState: null,
    suggestedFollowUps: [],
    actionWidgets: [proposal],
  }
}

// The merge-blocks action (ai-actions.md §5). "Merge my last two blocks" →
// resolve two adjacent blocks and PREVIEW the merge; it commits only on confirm.
// Merge is destructive (no manual unmerge), so the card uses the stronger
// confirm. Returns null when it can't pin two adjacent blocks.
function maybeHandleMergeInstruction(message: string, contextDate: string | null): AnswerEnvelope | null {
  const proposal = buildMergeBlocksProposal(getDb(), message, contextDate)
  if (!proposal) return null
  return {
    assistantText: "Here's the merge — confirm and these two become one block on your timeline.",
    answerKind: 'deterministic_stats',
    sourceKind: 'deterministic',
    conversationState: null,
    suggestedFollowUps: [],
    actionWidgets: [proposal],
  }
}

function maybeHandleFocusIntent(message: string): AnswerEnvelope | null {
  const db = getDb()
  const activeFocusSession = getActiveFocusSession(db)
  const liveSession = getCurrentSession()

  if (looksLikeFocusStartIntent(message)) {
    if (activeFocusSession) {
      return {
        assistantText: `A focus session is already running${activeFocusSession.label ? ` for ${activeFocusSession.label}` : ''}. Stop that one first if you want to start a fresh session.`,
        answerKind: 'deterministic_stats',
        sourceKind: 'deterministic',
        conversationState: null,
        suggestedFollowUps: [],
        actions: [
          {
            kind: 'stop_focus_session',
            label: 'Stop active focus session',
            sessionId: activeFocusSession.id,
          },
        ],
      }
    }

    const payload = buildFocusStartPayloadFromContext(message, liveSession)
    const label = payload.label ? ` for ${payload.label}` : ''
    const target = payload.targetMinutes ? ` with a ${payload.targetMinutes} minute target` : ''
    const plannedApps = payload.plannedApps && payload.plannedApps.length > 0
      ? ` I can seed it with ${payload.plannedApps.join(', ')} from your current context.`
      : ''

    return {
      assistantText: `I can start a focus session${label}${target}.${plannedApps} Use the button below when you want to begin.`,
      answerKind: 'deterministic_stats',
      sourceKind: 'deterministic',
      conversationState: null,
      suggestedFollowUps: [],
      actions: [
        {
          kind: 'start_focus_session',
          label: payload.targetMinutes ? `Start ${payload.targetMinutes}m focus session` : 'Start focus session',
          payload,
        },
      ],
    }
  }

  if (looksLikeFocusStopIntent(message)) {
    if (!activeFocusSession) {
      return {
        assistantText: 'There is no active focus session running right now, so there is nothing to stop.',
        answerKind: 'deterministic_stats',
        sourceKind: 'deterministic',
        conversationState: null,
        suggestedFollowUps: [],
      }
    }

    return {
      assistantText: `Your current focus session has been running for ${formatFocusDuration(focusSessionDurationSeconds(activeFocusSession))}${activeFocusSession.label ? ` on ${activeFocusSession.label}` : ''}. Use the button below when you want to stop it.`,
      answerKind: 'deterministic_stats',
      sourceKind: 'deterministic',
      conversationState: null,
      suggestedFollowUps: [],
      actions: [
        {
          kind: 'stop_focus_session',
          label: 'Stop focus session',
          sessionId: activeFocusSession.id,
        },
      ],
    }
  }

  if (looksLikeFocusReviewIntent(message)) {
    if (activeFocusSession) {
      return {
        assistantText: 'This focus session is still running. Stop it first, then you can save a reflection right here in the AI surface.',
        answerKind: 'deterministic_stats',
        sourceKind: 'deterministic',
        conversationState: null,
        suggestedFollowUps: [],
        actions: [
          {
            kind: 'stop_focus_session',
            label: 'Stop current focus session',
            sessionId: activeFocusSession.id,
          },
        ],
      }
    }

    const recentCompleted = getRecentFocusSessions(db, 10).find((session) => session.endTime !== null)
    if (!recentCompleted) {
      return {
        assistantText: 'There is no finished focus session to review yet. Start one from here whenever you are ready.',
        answerKind: 'deterministic_stats',
        sourceKind: 'deterministic',
        conversationState: null,
        suggestedFollowUps: [],
      }
    }

    const distractionCount = getDistractionCountForSession(db, recentCompleted.id)
    return {
      assistantText: `Your most recent focus session lasted ${formatFocusDuration(recentCompleted.durationSeconds)}${recentCompleted.label ? ` on ${recentCompleted.label}` : ''}.${distractionCount > 0 ? ` Daylens noticed ${distractionCount} distraction alert${distractionCount === 1 ? '' : 's'} during it.` : ''} Add a short review below and Daylens will keep it with the session.`,
      answerKind: 'deterministic_stats',
      sourceKind: 'deterministic',
      conversationState: null,
      suggestedFollowUps: [],
      actions: [
        {
          kind: 'review_focus_session',
          label: 'Save focus review',
          sessionId: recentCompleted.id,
          placeholder: 'What worked, what got in the way, and what should the next session keep or change?',
          suggestedNote: buildFocusReviewNote(recentCompleted, distractionCount),
        },
      ],
    }
  }

  return null
}










function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function cliBinaryCandidates(tool: CLITool): string[] {
  const appData = process.env.APPDATA
  const userProfile = process.env.USERPROFILE
  const home = os.homedir()
  return [
    appData ? path.join(appData, 'npm', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, 'AppData', 'Roaming', 'npm', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.local', 'bin', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.volta', 'bin', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.npm-global', 'bin', `${tool}.cmd`) : null,
    home ? path.join(home, '.local', 'bin', tool) : null,
    home ? path.join(home, '.volta', 'bin', tool) : null,
    home ? path.join(home, '.npm-global', 'bin', tool) : null,
    home ? path.join(home, '.nvm', 'versions', 'node', 'current', 'bin', tool) : null,
  ].filter((candidate): candidate is string => Boolean(candidate))
}

function uniquePathEntries(entries: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const entry of entries) {
    if (!entry) continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(trimmed)
  }

  return normalized
}

function buildCLIPath(executablePath: string, currentPath?: string): string {
  const appData = process.env.APPDATA
  const userProfile = process.env.USERPROFILE
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']

  return uniquePathEntries([
    path.dirname(executablePath),
    appData ? path.join(appData, 'npm') : null,
    userProfile ? path.join(userProfile, 'AppData', 'Roaming', 'npm') : null,
    userProfile ? path.join(userProfile, '.local', 'bin') : null,
    userProfile ? path.join(userProfile, '.volta', 'bin') : null,
    userProfile ? path.join(userProfile, '.npm-global', 'bin') : null,
    programFiles ? path.join(programFiles, 'nodejs') : null,
    programFilesX86 ? path.join(programFilesX86, 'nodejs') : null,
    ...(currentPath ? currentPath.split(path.delimiter) : []),
  ]).join(path.delimiter)
}

function buildCLIEnv(executablePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: buildCLIPath(executablePath, process.env.PATH),
  }
}

async function findCLIToolPath(tool: CLITool): Promise<string | null> {
  for (const candidate of cliBinaryCandidates(tool)) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }

  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    const child = spawn(command, [tool], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const match = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      resolve(match ?? null)
    })
  })
}

async function runCLIHelpCommand(executablePath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const spec = buildCLIProcessSpec(executablePath, args)
    const child = spawn(spec.command, spec.args, {
      env: buildCLIEnv(executablePath),
      shell: spec.shell,
      stdio: spec.usesJsonStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (spec.usesJsonStdin) {
      child.stdin?.end(buildCLIProcessPayload(executablePath, args))
    }
    const stdoutStream = child.stdout
    const stderrStream = child.stderr
    if (!stdoutStream || !stderrStream) {
      resolve('')
      return
    }

    let stdout = ''
    let stderr = ''
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      child.kill()
      resolve(`${stdout}\n${stderr}`.trim())
    }, 10_000)

    stdoutStream.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    stderrStream.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(`${stdout}\n${stderr}`.trim())
    })
  })
}

async function inspectCodexExecCapabilities(executablePath: string): Promise<CodexExecCapabilities> {
  const [codexHelp, codexExecHelp] = await Promise.all([
    runCLIHelpCommand(executablePath, ['--help']),
    runCLIHelpCommand(executablePath, ['exec', '--help']),
  ])

  const combinedHelp = `${codexHelp}\n${codexExecHelp}`
  return {
    supportsOutputLastMessage: combinedHelp.includes('--output-last-message'),
    supportsSandbox: combinedHelp.includes('--sandbox'),
    supportsConfig: combinedHelp.includes('--config'),
  }
}

async function resolveCLITool(tool: CLITool): Promise<ResolvedCLITool | null> {
  if (!cliToolCache[tool]) {
    cliToolCache[tool] = (async () => {
      const executablePath = await findCLIToolPath(tool)
      if (!executablePath) return null

      return {
        executablePath,
        codexExecCapabilities: tool === 'codex'
          ? await inspectCodexExecCapabilities(executablePath)
          : null,
      }
    })()
  }

  return cliToolCache[tool] ?? null
}

async function resolveCLIToolPath(tool: CLITool): Promise<string | null> {
  const resolved = await resolveCLITool(tool)
  return resolved?.executablePath ?? null
}

export async function detectCLITools(): Promise<CLIToolDetectionResult> {
  const [claude, chatgpt, gemini, codex] = await Promise.all([
    resolveCLIToolPath('claude'),
    resolveCLIToolPath('chatgpt'),
    resolveCLIToolPath('gemini'),
    resolveCLIToolPath('codex'),
  ])
  return { claude, chatgpt, gemini, codex }
}

async function sendWithAnthropic(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  const client = new Anthropic({ apiKey: config.apiKey ?? '', maxRetries: 4 })
  const promptInput = buildAnthropicPromptInput(systemPrompt, prior, userMessage, options)
  const stream = client.messages.stream({
    model: config.model,
    max_tokens: options?.maxOutputTokens ?? 1024,
    ...promptInput,
  }, { signal: options?.signal })
  stream.on('text', (delta) => {
    void options?.onDelta?.(delta)
  })
  // maxAttempts:1 — the Anthropic SDK owns the 429 backoff; this records the
  // call for per-turn instrumentation and honors the shared cooldown gate.
  const response = await withProviderRateLimit('anthropic', () => stream.finalMessage(), { label: 'text job' })

  return {
    text: response.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join(''),
    usage: {
      inputTokens: response.usage.input_tokens ?? null,
      outputTokens: response.usage.output_tokens ?? null,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
    },
  }
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

// OpenRouter is wire-compatible with the OpenAI Chat Completions API, so we reuse
// the OpenAI SDK pointed at OpenRouter's base URL. The ranking headers are
// optional but recommended by OpenRouter.
function createOpenAICompatibleClient(apiKey: string, provider: AIProviderMode): OpenAI {
  if (provider === 'openrouter') {
    return new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': 'https://daylens.app',
        'X-Title': 'Daylens',
      },
    })
  }
  return new OpenAI({ apiKey })
}

// OpenRouter only implements /chat/completions (not OpenAI's Responses API), so
// text jobs routed to OpenRouter use a streaming chat-completions call instead of
// sendWithOpenAI's responses.create path.
async function sendWithOpenRouter(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  const client = createOpenAICompatibleClient(config.apiKey ?? '', 'openrouter')
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    toChatCompletionMessages(systemPrompt, prior, userMessage)
  const stream = await withProviderRateLimit(
    'openrouter',
    () => client.chat.completions.create({
      model: config.model,
      messages,
      max_tokens: options?.maxOutputTokens ?? 1024,
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: options?.signal }),
    { label: 'text job' },
  )
  let text = ''
  let usage: ProviderTextResponse['usage'] = null
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content
    if (delta) {
      text += delta
      await options?.onDelta?.(delta)
    }
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? null,
        outputTokens: chunk.usage.completion_tokens ?? null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }
    }
  }
  return { text, usage }
}

async function sendWithManagedProxy(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  if (!config.baseUrl || !config.apiKey) throw new Error('Daylens managed AI session is unavailable.')
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    defaultHeaders: { 'X-Daylens-Feature': config.feature ?? 'ai' },
  })
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    toChatCompletionMessages(systemPrompt, prior, userMessage)
  const stream = await client.chat.completions.create({
    model: config.model,
    messages,
    max_tokens: options?.maxOutputTokens ?? 1024,
    stream: true,
    stream_options: { include_usage: true },
  }, { signal: options?.signal })
  let text = ''
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let cacheReadTokens: number | null = null
  let costUsd: number | null = null
  for await (const rawChunk of stream) {
    const chunk = rawChunk as typeof rawChunk & {
      daylens_cost_usd?: number
      usage?: {
        prompt_tokens?: number | null
        completion_tokens?: number | null
        prompt_tokens_details?: { cached_tokens?: number | null } | null
      } | null
    }
    const delta = chunk.choices?.[0]?.delta?.content
    if (delta) {
      text += delta
      await options?.onDelta?.(delta)
    }
    if (chunk.usage || typeof chunk.daylens_cost_usd === 'number') {
      inputTokens = chunk.usage?.prompt_tokens ?? inputTokens
      outputTokens = chunk.usage?.completion_tokens ?? outputTokens
      cacheReadTokens = chunk.usage?.prompt_tokens_details?.cached_tokens ?? cacheReadTokens
      costUsd = chunk.daylens_cost_usd ?? costUsd
    }
  }
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: null,
      costUsd,
    },
  }
}

async function sendWithOpenAI(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  const client = new OpenAI({ apiKey: config.apiKey ?? '' })
  const responseStream = await withProviderRateLimit(
    'openai',
    () => client.responses.create({
      model: config.model,
      instructions: systemPrompt,
      input: historyWithUserTurn(prior, userMessage),
      max_output_tokens: options?.maxOutputTokens ?? 1024,
      store: false,
      stream: true,
    }, { signal: options?.signal }),
    { label: 'text job' },
  )
  let text = ''
  let usage: ProviderTextResponse['usage'] = null

  for await (const event of responseStream as AsyncIterable<{
    type: string
    delta?: string
    response?: {
      output_text?: string
      usage?: {
        input_tokens?: number | null
        output_tokens?: number | null
        input_tokens_details?: { cached_tokens?: number | null } | null
      } | null
    }
  }>) {
    if (event.type === 'response.output_text.delta' && event.delta) {
      text += event.delta
      await options?.onDelta?.(event.delta)
      continue
    }

    if (event.type === 'response.completed' && event.response) {
      text = event.response.output_text || text
      usage = {
        inputTokens: event.response.usage?.input_tokens ?? null,
        outputTokens: event.response.usage?.output_tokens ?? null,
        cacheReadTokens: event.response.usage?.input_tokens_details?.cached_tokens ?? null,
        cacheWriteTokens: null,
      }
    }
  }

  return {
    text,
    usage,
  }
}

async function sendWithGoogle(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  const ai = new GoogleGenAI({
    apiKey: config.apiKey ?? '',
    httpOptions: {
      headers: {
        'x-goog-api-client': GOOGLE_CLIENT_HEADER,
      },
    },
  })
  const chat = ai.chats.create({
    model: config.model,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: options?.maxOutputTokens ?? 1024,
      // The chat-level config applies to sendMessageStream,
      // so Stop aborts the in-flight Gemini request.
      abortSignal: options?.signal,
    },
    history: toGoogleHistory(prior) as GoogleContent[],
  })

  const response = await withProviderRateLimit('google', () => chat.sendMessageStream({ message: userMessage }), { label: 'text job' })
  let text = ''
  for await (const chunk of response) {
    let nextText = ''
    try {
      nextText = chunk.text ?? ''
    } catch {
      throw new Error('Gemini blocked the response. Try rephrasing or switch AI provider in Settings.')
    }

    const delta = nextText.startsWith(text)
      ? nextText.slice(text.length)
      : nextText
    text = nextText
    if (delta) {
      await options?.onDelta?.(delta)
    }
  }
  if (!text) {
    throw new Error('Gemini returned an empty response. Try rephrasing your question.')
  }
  return {
    text,
    usage: null,
  }
}

async function runCLIProvider(
  tool: CLITool,
  prompt: string,
  model?: string,
  signal?: AbortSignal,
): Promise<string> {
  assertRealDayExternalAccessAllowed('model-provider')
  if (signal?.aborted) throw abortError()
  const resolvedTool = await resolveCLITool(tool)
  if (!resolvedTool) {
    throw new CLIProviderError('not_found', `${tool} CLI not found`)
  }
  const { executablePath, codexExecCapabilities } = resolvedTool

  const tmpFilePath = path.join(os.tmpdir(), `daylens-${tool}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const args = tool === 'claude'
    ? ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])]
    : tool === 'chatgpt'
      ? [...(model ? ['--model', model] : [])]
      : tool === 'gemini'
        ? [...(model ? ['--model', model] : [])]
        : (() => {
        const nextArgs = ['exec', '--skip-git-repo-check']
        if (codexExecCapabilities?.supportsSandbox) {
          nextArgs.push('--sandbox', 'read-only')
        }
        if (codexExecCapabilities?.supportsConfig) {
          nextArgs.push('--config', 'model_reasoning_effort="low"')
        }
        nextArgs.push('--color', 'never')
        if (codexExecCapabilities?.supportsOutputLastMessage) {
          nextArgs.push('--output-last-message', tmpFilePath)
        }
        if (model) {
          nextArgs.push('--model', model)
        }
        nextArgs.push(prompt)
        return nextArgs
      })()
  const promptViaStdin = tool !== 'codex'

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const spec = buildCLIProcessSpec(executablePath, args)
      const child = spawn(spec.command, spec.args, {
        env: buildCLIEnv(executablePath),
        shell: spec.shell,
        stdio: spec.usesJsonStdin || promptViaStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (spec.usesJsonStdin) {
        child.stdin?.end(buildCLIProcessPayload(executablePath, args))
      } else if (promptViaStdin) {
        child.stdin?.end(prompt)
      }
      const stdoutStream = child.stdout
      const stderrStream = child.stderr
      if (!stdoutStream || !stderrStream) {
        reject(new CLIProviderError('launch_failed', `${tool} CLI did not expose stdout/stderr pipes`))
        return
      }

      let stdout = ''
      let stderr = ''
      let finished = false
      const timer = setTimeout(() => {
        if (finished) return
        finished = true
        child.kill()
        reject(new CLIProviderError('timeout', `${tool} CLI timed out after ${CLI_TIMEOUT_MS / 1000}s`))
      }, CLI_TIMEOUT_MS)

      // Stop kills the CLI child process outright.
      const onAbort = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        child.kill()
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('close', () => signal?.removeEventListener('abort', onAbort))

      stdoutStream.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      stderrStream.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        reject(new CLIProviderError('launch_failed', error.message))
      })
      child.on('close', async (code) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        try {
          const fileOutput = tool === 'codex' && codexExecCapabilities?.supportsOutputLastMessage
            ? (await fs.readFile(tmpFilePath, 'utf8').catch(() => '')).trim()
            : ''
          const finalOutput = (tool === 'codex' && fileOutput ? fileOutput : stdout).trim()
          if (code !== 0) {
            reject(new CLIProviderError('non_zero_exit', (stderr || finalOutput || `${tool} exited with code ${code ?? 1}`).trim()))
            return
          }
          resolve(finalOutput)
        } catch (error) {
          reject(error)
        }
      })
    })

    return output
  } finally {
    if (tool === 'codex' && codexExecCapabilities?.supportsOutputLastMessage) {
      await fs.unlink(tmpFilePath).catch(() => undefined)
    }
  }
}

async function sendWithProvider(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  assertRealDayExternalAccessAllowed('model-provider')
  if (config.transport === 'managed') {
    return sendWithManagedProxy(config, systemPrompt, prior, userMessage, options)
  }
  switch (config.provider) {
    case 'claude-cli':
    case 'chatgpt-cli':
    case 'gemini-cli':
    case 'codex-cli': {
      const existingCLIPrompt = [
        prior.length > 0
          ? `Conversation so far:\n${prior.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n\n')}`
          : null,
        `User: ${userMessage}`,
      ].filter(Boolean).join('\n\n')
      const cliPrompt = `System context:\n${systemPrompt}\n\n${existingCLIPrompt}`
      const tool = config.provider === 'claude-cli'
        ? 'claude'
        : config.provider === 'chatgpt-cli'
          ? 'chatgpt'
          : config.provider === 'gemini-cli'
            ? 'gemini'
            : 'codex'
      const text = await runCLIProvider(tool, cliPrompt, config.model, options?.signal)
      await emitTextDeltas(text, options?.onDelta)
      return {
        text,
        usage: null,
      }
    }
    case 'openai':
      return sendWithOpenAI(config, systemPrompt, prior, userMessage, options)
    case 'openrouter':
      return sendWithOpenRouter(config, systemPrompt, prior, userMessage, options)
    case 'google':
      return sendWithGoogle(config, systemPrompt, prior, userMessage, options)
    case 'anthropic':
    default:
      return sendWithAnthropic(config, systemPrompt, prior, userMessage, options)
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${seconds}s`
}

function dayBounds(date: Date): [number, number] {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  return [from, to]
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function localDateKeyForMs(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}


function parseSurfaceSummaryResult(
  raw: string,
  fallbackTitle: string,
): { title: string; summary: string } | null {
  const normalized = escapeJsonBlock(raw)
  if (!normalized) return null

  try {
    const parsed = JSON.parse(normalized) as { title?: unknown; summary?: unknown }
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
    if (!summary) return null
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallbackTitle,
      summary,
    }
  } catch {
    return {
      title: fallbackTitle,
      summary: normalized,
    }
  }
}

function localDateBoundsFromString(dateStr: string): [number, number] {
  const [year, month, day] = dateStr.split('-').map(Number)
  const from = new Date(year, month - 1, day).getTime()
  return [from, from + 86_400_000]
}

// Work memory handed to the AI as context: the editable, human-readable profile.
// Replaces the old opaque "65% pattern" block. The
// range/limit params are kept for caller compatibility but the profile is
// range-independent — it's who you are, not what happened in a window.
function buildDaylensMemoryPromptBlock(_range: { fromMs: number; toMs: number }, _limit = 10): string {
  try {
    return workMemoryPromptBlock(getDb())
  } catch (error) {
    console.warn('[ai] memory prompt context failed:', error)
    return ''
  }
}

function escapeJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced?.[1]?.trim() ?? raw.trim()
}


function sanitizeConversationHistory(history: AIThreadMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  const prior = history.slice()
  while (prior.length > 0 && prior[prior.length - 1].role === 'user') {
    prior.pop()
  }
  // Strip user+assistant pairs where the assistant content is empty.
  // Keeping empty assistant messages would corrupt the alternation pattern
  // and cause some providers to return an empty response.
  const sanitized: AIThreadMessage[] = []
  let i = 0
  while (i < prior.length) {
    const msg = prior[i]
    if (msg.role === 'user') {
      const next = prior[i + 1]
      if (next?.role === 'assistant' && !next.content.trim()) {
        i += 2
        continue
      }
    }
    sanitized.push(msg)
    i++
  }
  return sanitized.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

// ── Provider history bound ───────────────────────────────────────────
// The SCREEN may hold a whole thread (message paging), but what each turn
// SENDS to the provider must not grow with thread length. The bound is
// recent-N messages: the newest MAX_PROVIDER_HISTORY_MESSAGES entries
// (= MAX_PROVIDER_HISTORY_MESSAGES / 2 user↔assistant exchanges) are kept and
// everything older is dropped. Ten exchanges is enough context for the
// follow-up shapes the app supports ("what about yesterday?", "make that
// shorter", "are you sure?") — those reference the last few turns, and
// longer-range recall goes through the resolvers, not chat history. After the
// cut, any leading assistant message is dropped so the history still starts
// with a user turn (Anthropic/Google reject assistant-first histories).
export const MAX_PROVIDER_HISTORY_MESSAGES = 20

export function boundProviderHistory(prior: ConversationMessage[]): ConversationMessage[] {
  let bounded = prior.length > MAX_PROVIDER_HISTORY_MESSAGES
    ? prior.slice(prior.length - MAX_PROVIDER_HISTORY_MESSAGES)
    : prior.slice()
  const firstUser = bounded.findIndex((message) => message.role === 'user')
  if (firstUser > 0) bounded = bounded.slice(firstUser)
  return firstUser === -1 ? [] : bounded
}

// First send from a new-chat draft (threadId null): reuse the newest EMPTY
// unarchived thread when one exists — a send that failed after thread creation
// leaves exactly such a row behind — and only create a fresh row otherwise.
// Without the reuse, every failed first send minted another identically-titled
// thread, which is how the sidebar grew duplicate "This Week Focus" /
// "Focus Session" entries.
function threadForFirstMessage(userMessage: string): number {
  const thread = createThread(null) // createThread(null) adopts an existing empty draft
  const title = deriveTitleFromMessage(userMessage)
  if (title !== thread.title) renameThread(thread.id, title)
  return thread.id
}

function blockDurationSeconds(block: Pick<WorkContextBlock, 'startTime' | 'endTime' | 'sessions'>): number {
  return blockActiveSeconds(block as WorkContextBlock)
}

function uniqueStrings(values: Array<string | null | undefined>, limit = values.length): string[] {
  const unique: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || unique.includes(trimmed)) continue
    unique.push(trimmed)
    if (unique.length >= limit) break
  }
  return unique
}

function namedEvidenceForSummary(block: WorkContextBlock): string[] {
  return uniqueStrings([
    ...block.topArtifacts.map((artifact) => artifact.displayTitle),
    ...block.pageRefs.map((page) => page.pageTitle ?? page.displayTitle),
    ...block.topApps
      .filter((app) => !app.isBrowser && app.category !== 'system' && app.category !== 'uncategorized')
      .map((app) => app.appName),
  ], 3)
}

function reviewedWorkIntent(block: WorkContextBlock): ReturnType<typeof inferWorkIntent> {
  const intent = inferWorkIntent(block)
  return {
    ...intent,
    role: block.review?.correctedIntentRole ?? intent.role,
    subject: block.review?.correctedIntentSubject ?? intent.subject,
  }
}


// Follow-up chips are fully deterministic and grounded in the answer's own
// named entities. This is a deliberate three-in-one fix:
//   • R1  — no extra provider call per turn (this used to fire 1–2 calls, and
//           even cross-routed to Anthropic, competing with the answer for the
//           per-minute budget).
//   • Q3  — never templates a meta-entity ("How long on Google Gemini?") and
//           shows nothing for identity/meta answers, rather than dumb chips.
//   • Q4  — the same answer always yields the same chips: entities present →
//           grounded chips; none → no chips. Presence is no longer a coin flip
//           that depended on a rate-limited side call succeeding.
// FB10: follow-ups are genuinely good or absent. A real model call (cheap
// economy tier — the `chat_followup_suggestions` job) generates them grounded in
// the answer's actual entities/numbers, then the two-stage filter enforces the
// bar (real answer token, varied shapes, no temporal/generic/header-word chips).
// The deterministic candidates are passed only as shape SEEDS — never templated
// into "How long on ${stray noun}?". If <2 survive, we show none.
async function generateSuggestedFollowUps(
  userQuestion: string,
  answerText: string,
  answerKind: AIAnswerKind,
  state: AIConversationState | null,
): Promise<FollowUpSuggestion[]> {
  if (answerKind === 'error') return []
  if (isIdentityAnswer(answerText)) return []
  // Greetings / one-liners have nothing worth following up on — don't spend a call.
  if (answerText.trim().length < 80) return []

  const justAnsweredShape = classifyQuestionShape(userQuestion)
  const seeds = buildDeterministicFollowUpCandidates(answerKind, state, answerText)

  try {
    const { systemPrompt, userPrompt } = buildFollowUpSuggestionPrompts(userQuestion, answerText, state, seeds)
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'chat_followup_suggestions',
          screen: 'ai_chat',
          triggerSource: 'user',
          systemPrompt,
          userMessage: userPrompt,
          prior: [],
        },
        sendWithProvider,
      ),
      9_000,
      'Follow-up generation timed out',
    )
    const parsed = parseFollowUpSuggestions(text, [])
    const report = filterFollowUpCandidatesWithReport(answerText, parsed, justAnsweredShape)
    // Show ≥2 grounded chips or none — never a single stray chip.
    return report.suggestions.length >= 2 ? report.suggestions.slice(0, 4) : []
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[ai] follow-up generation failed; showing none:', error instanceof Error ? error.message : error)
    }
    return []
  }
}

const starterSuggestionCache = new Map<string, import('@shared/types').AIStarterSuggestionResult>()

function recentQueryFallback(pastQueries: string[]): import('@shared/types').AIStarterSuggestion[] {
  return pastQueries.slice(0, 4).map((query) => ({
    label: query.length > 72 ? `${query.slice(0, 69).trimEnd()}…` : query,
    prompt: query,
    source: 'recent' as const,
  }))
}

// Empty-chat suggestions come from the user's own query history. They use the
// same metered economy job as follow-up chips, so input/output tokens and cost
// land in ai_usage_events and appear under "Suggestions" in Settings.
export async function getStarterSuggestions(): Promise<import('@shared/types').AIStarterSuggestionResult> {
  const db = getDb()
  const rows = db.prepare(`
    SELECT content
    FROM ai_messages
    WHERE role = 'user'
    ORDER BY created_at DESC, id DESC
    LIMIT 60
  `).all() as Array<{ content: string }>

  const seen = new Set<string>()
  const pastQueries = rows
    .map((row) => row.content.trim().replace(/\s+/g, ' '))
    .filter((query) => {
      if (query.length < 8 || query.length > 300) return false
      if (/^(?:yes|no|ok|okay|thanks?|continue|retry)[.!]?$/i.test(query)) return false
      const key = query.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 20)

  if (pastQueries.length < 2) return { suggestions: recentQueryFallback(pastQueries), error: null }
  const signature = hashText(pastQueries.join('\n'))
  const cached = starterSuggestionCache.get(signature)
  if (cached) return cached

  const { systemPrompt, userPrompt } = buildStarterSuggestionPrompts(pastQueries)
  try {
    const { text } = await executeTextAIJob(
      {
        jobType: 'chat_followup_suggestions',
        screen: 'ai_chat',
        triggerSource: 'user',
        systemPrompt,
        userMessage: userPrompt,
        prior: [],
      },
      sendWithProvider,
    )
    const parsed = parseStarterSuggestions(text, pastQueries)
    const suggestions = parsed.length >= 2
      ? parsed.map((suggestion) => ({ ...suggestion, source: 'model' as const }))
      : recentQueryFallback(pastQueries)
    const result = {
      suggestions,
      error: parsed.length >= 2 ? null : "Suggestions couldn't refresh. Showing recent questions.",
    }
    starterSuggestionCache.clear()
    starterSuggestionCache.set(signature, result)
    return result
  } catch (error) {
    console.warn('[ai] starter suggestion generation failed; using recent questions:', error instanceof Error ? error.message : error)
    return {
      suggestions: recentQueryFallback(pastQueries),
      error: "Suggestions couldn't refresh. Showing recent questions.",
    }
  }
}




function buildAssistantMetadata(
  answerKind: AIAnswerKind,
  suggestedFollowUps: FollowUpSuggestion[],
  retrySourceUserMessageId: number | null,
  conversationState: AIConversationState | null,
  actions: AIMessageAction[] = [],
  artifacts: AIMessageArtifact[] = [],
  providerError = false,
  actionWidgets: AIActionWidget[] = [],
  agent: AnswerEnvelope['agent'] = undefined,
): AIThreadMessageMetadata {
  return {
    answerKind,
    suggestedFollowUps,
    retryable: !providerError,
    retrySourceUserMessageId,
    contextSnapshot: conversationState,
    providerError,
    actions,
    actionWidgets,
    artifacts,
    agent,
  }
}

function agentArtifactDir(): string {
  try {
    return path.join(app?.getPath?.('userData') ?? os.tmpdir(), 'artifacts')
  } catch {
    return path.join(os.tmpdir(), 'artifacts')
  }
}

async function persistChatTurn(
  db: ReturnType<typeof getDb>,
  conversationId: number,
  userMessage: string,
  envelope: AnswerEnvelope,
  threadId: number | null = null,
): Promise<AIChatTurnResult> {
  const userEntry = appendConversationMessage(db, conversationId, 'user', userMessage, { threadId })
  const assistantEntry = appendConversationMessage(
    db,
    conversationId,
    'assistant',
    envelope.assistantText,
    {
      threadId,
      metadata: buildAssistantMetadata(
        envelope.answerKind,
        envelope.suggestedFollowUps,
        userEntry.id,
        envelope.conversationState,
        envelope.actions ?? [],
        envelope.artifacts ?? [],
        envelope.answerKind === 'error',
        envelope.actionWidgets ?? [],
        envelope.agent,
      ),
    },
  )
  if (threadId == null) {
    upsertConversationState(db, conversationId, envelope.conversationState)
  }
  if (threadId != null) {
    touchThreadLastMessage(db, threadId, Date.now())
    await queueWeakThreadTitleUpgrade(threadId, userMessage, envelope)
    // Also persist AIMessageArtifact entries into the durable ai_artifacts table.
    if (envelope.artifacts && envelope.artifacts.length > 0) {
      await persistMessageArtifacts(threadId, assistantEntry.id, envelope.artifacts)
    }
  }
  return {
    assistantMessage: assistantEntry,
    conversationState: envelope.conversationState,
    threadId,
  }
}

function threadTitleContextFromEnvelope(envelope: AnswerEnvelope): ThreadTitleContext {
  return {
    answerKind: envelope.answerKind,
    entityName: null,
    entityIntent: null,
    weeklyBriefIntent: null,
  }
}

function maybeRenameWeakThread(
  threadId: number,
  currentTitle: string | null | undefined,
  userMessage: string,
  context?: ThreadTitleContext,
): boolean {
  if (!isWeakThreadTitle(currentTitle)) return false
  const candidate = deriveTitleFromMessage(userMessage, context)
  if (candidate === currentTitle || isWeakThreadTitle(candidate)) return false
  renameThread(threadId, candidate)
  return true
}

async function generateThreadTitle(userMessage: string, answerText: string): Promise<string | null> {
  try {
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'chat_thread_title',
          screen: 'ai_chat',
          triggerSource: 'system',
          systemPrompt: 'Write a specific 2–5 word chat title. Use the user’s topic, not generic words. Return only the title with no quotes, punctuation, or explanation.',
          userMessage: JSON.stringify({ question: userMessage, answerPreview: answerText.slice(0, 600) }),
          prior: [],
        },
        sendWithProvider,
      ),
      9_000,
      'Thread title generation timed out',
    )
    return parseGeneratedThreadTitle(text)
  } catch {
    return null
  }
}

async function queueWeakThreadTitleUpgrade(threadId: number, userMessage: string, envelope: AnswerEnvelope): Promise<void> {
  const context = threadTitleContextFromEnvelope(envelope)
  const currentTitle = getThread(threadId)?.title ?? null
  if (maybeRenameWeakThread(threadId, currentTitle, userMessage, context)) return
  const remainingTitle = getThread(threadId)?.title ?? null
  if (!isWeakThreadTitle(remainingTitle)) return
  const generated = await generateThreadTitle(userMessage, envelope.assistantText)
  if (generated) renameThread(threadId, generated)
}

function mapMessageArtifactKind(
  kind: AIMessageArtifact['kind'],
  format: AIMessageArtifact['format'],
): AIArtifactKind {
  if (kind === 'report') return 'report'
  if (kind === 'chart' || format === 'html') return 'html_chart'
  if (kind === 'table' || format === 'json') return 'json_table'
  if (format === 'csv') return 'csv'
  return 'markdown'
}

async function persistMessageArtifacts(
  threadId: number,
  messageId: number,
  artifacts: AIMessageArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    try {
      let fileContent = ''
      try {
        // Binary formats (xlsx) are referenced by path only — a utf8 read of a
        // zip container would store mojibake as the inline copy.
        if (artifact.format !== 'xlsx') {
          fileContent = await fs.readFile(artifact.path, 'utf8')
        }
      } catch {
        // ignore — createArtifact with existingFilePath still records the row.
      }
      await createArtifact({
        threadId,
        messageId,
        kind: mapMessageArtifactKind(artifact.kind, artifact.format),
        title: artifact.title,
        summary: artifact.subtitle ?? null,
        content: fileContent,
        existingFilePath: artifact.path,
        meta: {
          source: 'assistant_message',
          originalId: artifact.id,
          format: artifact.format,
        },
      })
    } catch (error) {
      console.warn('[ai] failed to persist assistant artifact:', error)
    }
  }
}

// Neutral / placeholder labels that name no real activity — a coarse
// un-analyzed sitting ("Morning") or an unnamed block. The factual fallback
// must not present these as "what you worked on".
const NON_ACTIVITY_LABELS = new Set([
  'morning', 'afternoon', 'evening', 'night', 'late night',
  'earlier today', 'active now', 'untitled block',
])

// The longest block's name, but only when it actually names an activity — never
// a coarse time-of-day placeholder or an unnamed/provisional block.
function recapWorthyLabel(block: WorkContextBlock): string | null {
  if (block.provisional) return null
  const label = userVisibleBlockLabel(block).trim()
  if (!label || NON_ACTIVITY_LABELS.has(label.toLowerCase())) return null
  if (rawLabelForm(label)) return null
  return label
}

// The deterministic factual fallback, shown when the AI recap is unavailable.
// It is deliberately a plain, honest factual line — not prose imitating the AI,
// and free of internal vocabulary ("trusted blocks", "strongest evidence")
// (DEV-275). `degraded` marks it as the "AI couldn't run" line so the UI can
// say so plainly (DEV-270: nothing fails silently).
function fallbackDaySummary(payload: DayTimelinePayload, degraded = false): AIDaySummaryResult {
  if (payload.totalSeconds === 0) {
    return {
      summary: 'No tracked activity yet today. Once Daylens has real local history, this screen can answer questions about your work, files, pages, and focus patterns.',
    }
  }

  const blocks = payload.blocks.filter(isTrustedTimelineBlock)
  const longest = [...blocks].sort((left, right) => blockDurationSeconds(right) - blockDurationSeconds(left))[0]
  const longestName = longest ? recapWorthyLabel(longest) : null
  const entities = (payload.dayEntities ?? [])
    .filter((entity) => entity.seconds >= 300)
    .slice(0, 3)
    .map((entity) => entity.name)

  const summaryParts = [
    `${formatDuration(payload.totalSeconds)} tracked across ${blocks.length} block${blocks.length === 1 ? '' : 's'}.`,
    longestName
      ? `Longest stretch: ${longestName} (${formatDuration(blockDurationSeconds(longest))}).`
      : entities.length > 0 ? `Mostly around ${entities.join(', ')}.` : null,
  ]

  return {
    summary: summaryParts.filter((part): part is string => Boolean(part)).join(' '),
    ...(degraded ? { degraded: true } : {}),
  }
}

function daySummaryCacheKey(payload: DayTimelinePayload): string {
  const trustedBlocks = payload.blocks.filter(isTrustedTimelineBlock)
  return JSON.stringify({
    date: payload.date,
    totalSeconds: payload.totalSeconds,
    focusSeconds: payload.focusSeconds,
    focusPct: payload.focusPct,
    blockCount: trustedBlocks.length,
    ignoredBlockIds: payload.blocks.filter((block) => !isTrustedTimelineBlock(block)).map((block) => block.id),
    blocks: trustedBlocks.map((block) => ({
      id: block.id,
      label: userVisibleBlockLabel(block),
      narrative: block.label.narrative,
      reviewState: block.review.state,
      correctedIntentRole: block.review.correctedIntentRole,
      correctedIntentSubject: block.review.correctedIntentSubject,
      startTime: block.startTime,
      endTime: block.endTime,
      dominantCategory: block.dominantCategory,
      topApps: block.topApps.slice(0, 3).map((app) => ({
        appName: app.appName,
        category: app.category,
        isBrowser: app.isBrowser,
      })),
      domains: block.websites.slice(0, 3).map((site) => site.domain),
      artifacts: block.topArtifacts.slice(0, 3).map((artifact) => artifact.displayTitle),
      pages: block.pageRefs.slice(0, 2).map((page) => page.displayTitle),
      workflows: block.workflowRefs.slice(0, 2).map((workflow) => workflow.label),
    })),
  })
}

// The old scaffold sent the top-4 blocks TWICE
// (once as `dominantBlocks`, again inside `blocks`) and pretty-printed the JSON
// (2-space indent ≈ +20% tokens for pure whitespace). Now each block is sent
// once — the 10 longest, in chronological order, ranked so the model still
// knows which dominated — and the JSON is compact. Rich supporting evidence
// rides only on the top-4 by duration, matching what dominantBlocks carried.
/**
 * The recap's cache key. The tone is part of it because the recap IS the
 * morning brief: without the tone in the key, changing it leaves the cached
 * recap in the old voice for the life of the process and the toggle reads as
 * dead (AC-VIC-002.1).
 */
export function daySummaryPromptCacheKey(
  payload: DayTimelinePayload,
  memoryPrompt: string,
  variantId: string,
  voice: SummaryVoice,
): string {
  return `${daySummaryCacheKey(payload)}:${hashText(memoryPrompt)}:${variantId}:${voice}`
}

/**
 * The recap's system prompt. Composed here rather than inline in
 * `generateDaySummary` so the tone and policy rules can be checked by running
 * the composition, not by scanning this file for a call that might be dead.
 */
export function buildDaySummarySystemPrompt(
  voice: SummaryVoice,
  parts: {
    memoryPrompt?: string
    profileDirective?: string
    variantDirectives?: readonly string[]
  } = {},
): string {
  return [
    VOICE_SYSTEM_PROMPT,
    parts.memoryPrompt,
    parts.profileDirective,
    USER_AUTHORED_LABEL_RULE,
    ...INTERPRETATION_DIRECTIVES,
    voiceDirective(voice),
    ...(parts.variantDirectives ?? []),
  ].filter(Boolean).join('\n')
}

export function buildDaySummaryScaffold(payload: DayTimelinePayload): string {
  const trustedBlocks = payload.blocks.filter(isTrustedTimelineBlock)

  const topCategories = Array.from(trustedBlocks.reduce<Map<string, number>>((map, block) => {
    const durationSeconds = blockDurationSeconds(block)
    map.set(block.dominantCategory, (map.get(block.dominantCategory) ?? 0) + durationSeconds)
    return map
  }, new Map()).entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([category, seconds]) => ({ category, duration: formatDuration(seconds) }))

  const byDuration = [...trustedBlocks].sort((left, right) => blockDurationSeconds(right) - blockDurationSeconds(left))
  const durationRank = new Map(byDuration.map((block, index) => [block.id, index + 1]))
  const selected = byDuration.slice(0, 10).sort((left, right) => left.startTime - right.startTime)

  const blocks = selected.map((block) => {
    const rank = durationRank.get(block.id) ?? Number.MAX_SAFE_INTEGER
    return {
      // The label the Timeline actually shows, never the raw stored one: a
      // block whose `label.current` is a generic floor ("Development") renders
      // as its artifact or AI label on screen, and a recap that names the floor
      // describes a day the person cannot see.
      label: userVisibleBlockLabel(block),
      // Their wording, marked as theirs, so the model quotes it instead of
      // repeating it back as something Daylens observed (AC-VIC-004.3).
      ...(labelProvenance(block) === 'user' ? { labelIsTheirOwnWords: true } : {}),
      narrative: block.label.narrative,
      timeRange: `${formatClock(block.startTime)}-${formatClock(block.endTime)}`,
      duration: formatDuration(blockDurationSeconds(block)),
      durationRank: rank,
      dominantCategory: block.dominantCategory,
      confidence: block.confidence,
      reviewState: block.review.state,
      workIntent: reviewedWorkIntent(block),
      topApps: block.topApps.slice(0, 3).map((app) => ({
        appName: app.appName,
        duration: formatDuration(app.totalSeconds),
      })),
      artifacts: block.topArtifacts.slice(0, 4).map((artifact) => ({
        title: artifact.displayTitle.slice(0, 100),
        type: artifact.artifactType,
      })),
      pages: block.pageRefs.slice(0, 3).map((page) => ({
        title: page.displayTitle.slice(0, 100),
        domain: page.domain,
      })),
      workflows: block.workflowRefs.slice(0, 3).map((workflow) => workflow.label),
      ...(rank <= 4 ? { supportingEvidence: namedEvidenceForSummary(block) } : {}),
    }
  })

  const focusSessions = payload.focusSessions.slice(0, 4).map((session) => ({
    label: session.label,
    duration: formatDuration(session.durationSeconds),
    startedAt: formatClock(session.startTime),
  }))

  // Scheduled calendar events, with the honest scheduling-vs-attendance
  // distinction the authority order requires: a calendar event proves what was
  // PLANNED; only "attended" (the person's own confirmation) or a matched
  // captured block proves it HAPPENED. The model must never assert a meeting
  // occurred from a calendar row alone.
  const meetings = (payload.scheduledMeetings ?? []).map((meeting) => ({
    title: meeting.title,
    scheduled: `${formatClock(meeting.startMs)}-${formatClock(meeting.endMs)}`,
    // What the evidence supports about presence, in plain terms for the model.
    presence: meeting.marked === 'attended'
      ? 'you confirmed you attended'
      : meeting.marked === 'skipped'
        ? 'you marked this skipped'
        : meeting.marked === 'moved'
          ? 'you marked this moved'
          : meeting.marked === 'unrelated'
            ? 'you marked this unrelated'
            : meeting.attendance === 'matched'
              ? 'tracked activity overlaps it (likely occurred)'
              : 'scheduled only — no evidence it occurred',
    attendeeCount: meeting.attendeeCount ?? undefined,
  }))

  // The durable entities the day's evidence supports naming — the real projects,
  // clients, people, and repositories, so the recap names the work, not the tool.
  const entities = (payload.dayEntities ?? [])
    .filter((entity) => entity.seconds >= 60)
    .slice(0, 8)
    .map((entity) => ({ type: entity.type, name: entity.name, duration: formatDuration(entity.seconds) }))

  return JSON.stringify({
    date: payload.date,
    totals: {
      tracked: formatDuration(payload.totalSeconds),
      focus: formatDuration(payload.focusSeconds),
      focusPct: payload.focusPct,
      blockCount: trustedBlocks.length,
      ignoredBlockCount: payload.blocks.length - trustedBlocks.length,
      appCount: payload.appCount,
      siteCount: payload.siteCount,
    },
    topCategories,
    blocks,
    focusSessions,
    ...(meetings.length > 0 ? { meetings } : {}),
    ...(entities.length > 0 ? { entities } : {}),
  })
}

function parseDaySummaryResult(raw: string): AIDaySummaryResult | null {
  return parseDaySummaryResultText(raw)
}

/** Turn a failed recap call into the words the panel shows and whether a retry
 *  could possibly help.
 *
 *  This reason is put on the result and rendered directly, so it never passes
 *  through the renderer's error sanitizer: the structured meta the provider
 *  layer tags onto its messages has to be decoded HERE, or the person reads
 *  ⟦dlerr:{"code":"credit_exhausted"}⟧ in the middle of the sentence telling
 *  them what went wrong. */
export function degradedRecapReason(error: unknown): { degradedReason?: string; degradedNeedsAction?: boolean } {
  const raw = error instanceof Error ? error.message.trim() : typeof error === 'string' ? error.trim() : ''
  const { message, meta } = decodeProviderErrorMeta(raw)
  const clean = message.trim()
  return {
    ...(clean ? { degradedReason: /[.!?…]$/.test(clean) ? clean : `${clean}.` } : {}),
    // A wall only the person can clear (billing, credit, auth, a model that is
    // gone). Offering "try again" against one of those is a lie — the retry
    // cannot succeed until they act.
    ...(meta && isHardProviderWall(meta.code) ? { degradedNeedsAction: true } : {}),
  }
}

function currentLocalDateString(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export async function generateDaySummary(
  dateStr: string,
  options: {
    /** Which recap prompt to run. Defaults to the shipped one; the recap lab
     *  passes each candidate so variants are compared through the exact path
     *  the app uses, not a parallel copy of it. */
    variant?: RecapPromptVariant
    /** The lab needs a fresh call every time; the app wants the cache. */
    bypassCache?: boolean
  } = {},
): Promise<AIDaySummaryResult> {
  const variant = options.variant ?? shippedRecapVariant()
  const db = getDb()
  const liveSession = dateStr === currentLocalDateString() ? getCurrentSession() : null
  // Read the day exactly as the timeline shows it (DEV-247): analysis:false, so
  // the recap describes the same corrected blocks the person sees — an analyzed
  // day's settled blocks, an un-analyzed day's coarse sittings — never a
  // divergent fine build the timeline never rendered.
  const payload = getTimelineDayPayload(db, dateStr, liveSession, { analysis: false })
  const fallback = fallbackDaySummary(payload)

  if (payload.totalSeconds === 0) {
    return fallback
  }

  const [memoryFromMs, memoryToMs] = localDateBoundsFromString(dateStr)
  const memoryPrompt = buildDaylensMemoryPromptBlock({ fromMs: memoryFromMs, toMs: memoryToMs })
  // The recap IS the morning brief (aiFeatures.ts maps day_summary to "Morning
  // brief"), so the person's chosen tone belongs here as much as in Wrapped.
  // It rides the cache key too: without that, changing the tone leaves the
  // cached recap in the old voice for the life of the process and the toggle
  // reads as dead.
  const settings = getSettings()
  const voice = normalizeSummaryVoice(settings.summaryVoice)
  const cacheKey = daySummaryPromptCacheKey(payload, memoryPrompt, variant.id, voice)
  const cached = options.bypassCache ? undefined : daySummaryCache.get(cacheKey)
  if (cached) return cached

  const systemPrompt = buildDaySummarySystemPrompt(voice, {
    memoryPrompt,
    profileDirective: userProfileDirective(settings),
    variantDirectives: variant.directives,
  })

  const userMessage = variant.userMessage(dateStr, buildDaySummaryScaffold(payload))

  try {
    // The belt has to live here: executeTextAIJob does not enforce the budget
    // on its own job definition. It is read from there so the number a caller
    // holds a job to is the number the table documents, never a second literal
    // that drifts. The old 15s literal expired mid-call on a real day and the
    // recap served the factual fallback instead (DEV-292).
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'day_summary',
          screen: 'ai_chat',
          triggerSource: 'user',
          systemPrompt,
          userMessage,
        },
        sendWithProvider,
      ),
      jobTimeoutMs('day_summary'),
      'Day summary timed out',
    )

    const parsed = parseDaySummaryResult(text)
    if (parsed) {
      daySummaryCache.set(cacheKey, parsed)
      return parsed
    }
    // The model answered but its output was unusable. Surface the factual
    // fallback marked degraded, and do NOT cache it, so a later open retries AI.
    return { ...fallback, degraded: true, degradedReason: 'The model replied in a shape Daylens could not read.' }
  } catch (error) {
    // The orchestration layer already shapes provider failures into messages a
    // person can act on ("AI access is paused…", "…timed out"); pass that
    // reason through instead of burying it in the log (DEV-279).
    console.warn(`[ai] day_summary failed for ${dateStr}:`, error)
    return { ...fallback, degraded: true, ...degradedRecapReason(error) }
  }
}

function buildWeekDateRange(weekStartStr: string): { weekStart: string; weekEnd: string; dates: string[] } {
  const [year, month, day] = weekStartStr.split('-').map(Number)
  const start = new Date(year, month - 1, day)
  const dates = Array.from({ length: 7 }, (_, index) => {
    const next = new Date(start)
    next.setDate(start.getDate() + index)
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
  })
  return {
    weekStart: dates[0],
    weekEnd: dates[dates.length - 1],
    dates,
  }
}

// R5 context-32k: feed up to ~28k tokens of evidence to the summary models
// instead of fixed tiny slices, so day reports, week reviews, and app
// narratives draw on the full picture and stop reading thin. 4 chars ~= 1
// token. We hold the input well under the 32k output ceiling so the model has
// room to respond.
const CONTEXT_EVIDENCE_TOKEN_BUDGET = 28_000
const CONTEXT_EVIDENCE_CHAR_BUDGET = CONTEXT_EVIDENCE_TOKEN_BUDGET * 4

// A running char budget shared across every evidence list in one bundle. Each
// `take` call appends items until either the per-list cap or the remaining
// shared budget runs out, so the lists compete for one ~28k-token pool rather
// than each getting an arbitrary fixed slice. The first item of a list is
// always admitted so a list never silently empties.
function createEvidenceBudget(budgetChars = CONTEXT_EVIDENCE_CHAR_BUDGET) {
  let used = 0
  return function take<T>(
    items: readonly T[],
    cost: (item: T) => number,
    maxItems = Number.MAX_SAFE_INTEGER,
  ): T[] {
    const packed: T[] = []
    for (const item of items) {
      if (packed.length >= maxItems) break
      const itemCost = cost(item)
      if (packed.length > 0 && used + itemCost > budgetChars) break
      packed.push(item)
      used += itemCost
    }
    return packed
  }
}

function evidenceCost(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

function buildWeekReviewBundle(weekStartStr: string): ReportContextBundle | null {
  const db = getDb()
  const { weekStart, weekEnd, dates } = buildWeekDateRange(weekStartStr)
  const dayPayloads = dates.map((date) => getTimelineDayPayload(db, date, null))
  const activeDays = dayPayloads.filter((payload) => payload.totalSeconds > 0)
  if (activeDays.length === 0) return null

  const totalTrackedSeconds = activeDays.reduce((sum, payload) => sum + payload.totalSeconds, 0)
  const totalFocusSeconds = activeDays.reduce((sum, payload) => sum + payload.focusSeconds, 0)
  const topArtifacts = activeDays
    .flatMap((payload) => payload.blocks.flatMap((block) => block.topArtifacts.slice(0, 2).map((artifact) => artifact.displayTitle)))
    .filter(Boolean)
    .slice(0, 8)

  const topCategories = Array.from(activeDays.reduce<Map<string, number>>((map, payload) => {
    for (const block of payload.blocks) {
      const durationSeconds = blockActiveSeconds(block)
      map.set(block.dominantCategory, (map.get(block.dominantCategory) ?? 0) + durationSeconds)
    }
    return map
  }, new Map()).entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([category, seconds]) => ({ category, duration: formatDuration(seconds) }))

  const dayRows = activeDays.map((payload) => ({
    date: payload.date,
    tracked: formatDuration(payload.totalSeconds),
    focus: formatDuration(payload.focusSeconds),
    focus_pct: payload.focusPct,
    top_blocks: payload.blocks.slice(0, 3).map((block) => userVisibleBlockLabel(block)).filter(Boolean).join(' | ') || 'No clear blocks',
  }))

  const renderDeterministic = (): { reportMarkdown: string; assistantResponse: string } => {
    const weekFocusPct = totalTrackedSeconds > 0 ? Math.round((totalFocusSeconds / totalTrackedSeconds) * 100) : 0
    const bestDay = activeDays.slice().sort((a, b) => b.focusPct - a.focusPct)[0]
    const longestDay = activeDays.slice().sort((a, b) => b.totalSeconds - a.totalSeconds)[0]
    const dayName = (dateStr: string): string => {
      const [y, m, d] = dateStr.split('-').map((n) => Number(n))
      const dt = new Date(y, (m ?? 1) - 1, d ?? 1)
      return dt.toLocaleDateString('en-US', { weekday: 'long' })
    }
    const lines: string[] = []
    lines.push(`# Week of ${weekStart} to ${weekEnd}`, '')
    lines.push(`Daylens tracked **${formatDuration(totalTrackedSeconds)}** across ${activeDays.length} day${activeDays.length === 1 ? '' : 's'}, of which **${formatDuration(totalFocusSeconds)} (${weekFocusPct}%)** was in focused-category work (development, writing, design, research, AI tools).`, '')
    if (bestDay) {
      lines.push(`Strongest focus day was **${dayName(bestDay.date)}, ${bestDay.date}** at ${bestDay.focusPct}% focused (${formatDuration(bestDay.focusSeconds)} of ${formatDuration(bestDay.totalSeconds)} tracked).`, '')
    }
    if (longestDay && longestDay.date !== bestDay?.date) {
      lines.push(`Longest tracked day was **${dayName(longestDay.date)}, ${longestDay.date}** at ${formatDuration(longestDay.totalSeconds)}.`, '')
    }

    if (topCategories.length > 0) {
      lines.push('## Where time went (by category)', '')
      for (const { category, duration } of topCategories) {
        lines.push(`- **${category}** — ${duration}`)
      }
      lines.push('')
    }

    lines.push('## Day by day', '')
    for (const payload of activeDays) {
      const blocks = payload.blocks
        .slice()
        .sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))
        .slice(0, 4)
      lines.push(`### ${dayName(payload.date)}, ${payload.date} — ${formatDuration(payload.totalSeconds)} tracked, ${formatDuration(payload.focusSeconds)} focused (${payload.focusPct}%)`)
      if (blocks.length === 0) {
        lines.push('No clear blocks captured for this day.', '')
        continue
      }
      for (const block of blocks) {
        const seconds = blockActiveSeconds(block)
        const label = userVisibleBlockLabel(block) || `${block.dominantCategory} block`
        const start = new Date(block.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
        const end = new Date(block.endTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
        const evidenceBits: string[] = []
        const artifactTitles = block.topArtifacts.slice(0, 2).map((a) => a.displayTitle).filter(Boolean)
        if (artifactTitles.length > 0) evidenceBits.push(`artifacts: ${artifactTitles.join('; ')}`)
        const apps = block.topApps.slice(0, 3).map((a) => a.appName).filter(Boolean)
        if (apps.length > 0) evidenceBits.push(`apps: ${apps.join(', ')}`)
        const tail = evidenceBits.length > 0 ? ` — ${evidenceBits.join(' | ')}` : ''
        lines.push(`- **${label}** (${start}–${end}, ${formatDuration(seconds)})${tail}`)
      }
      lines.push('')
    }

    if (topArtifacts.length > 0) {
      lines.push('## Notable artifacts referenced this week', '')
      for (const title of topArtifacts) lines.push(`- ${title}`)
      lines.push('')
    }

    lines.push('---', '', `_Generated deterministically from Daylens local timeline data. Every number above comes from the tracked blocks for ${weekStart} to ${weekEnd}; no AI synthesis was used in the body of this report._`)

    const chatLines: string[] = []
    chatLines.push(`Weekly report for ${weekStart} to ${weekEnd} attached. Headline: **${formatDuration(totalTrackedSeconds)}** tracked across ${activeDays.length} day${activeDays.length === 1 ? '' : 's'}, **${formatDuration(totalFocusSeconds)} focused (${weekFocusPct}%)** in development, writing, design, research, and AI tools.`)
    chatLines.push('')
    chatLines.push('Day by day:')
    for (const payload of activeDays) {
      const topBlock = payload.blocks.slice().sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))[0]
      const topBlockLabel = (topBlock ? userVisibleBlockLabel(topBlock) : '') || (topBlock ? `${topBlock.dominantCategory} block` : 'no clear blocks')
      chatLines.push(`- **${dayName(payload.date)} (${payload.date})** — ${formatDuration(payload.totalSeconds)} tracked, ${formatDuration(payload.focusSeconds)} focused (${payload.focusPct}%); longest block: ${topBlockLabel}`)
    }
    if (bestDay) {
      chatLines.push('')
      chatLines.push(`Strongest focus day was **${dayName(bestDay.date)}** at ${bestDay.focusPct}% (${formatDuration(bestDay.focusSeconds)} of ${formatDuration(bestDay.totalSeconds)} tracked).`)
    }
    chatLines.push('')
    chatLines.push('Every number above is rendered deterministically from the tracked timeline — no AI prose synthesis, so the figures match Daylens exactly. The attached report has the per-block breakdown your manager can read end to end.')

    return {
      reportMarkdown: lines.join('\n'),
      assistantResponse: chatLines.join('\n'),
    }
  }

  return {
    title: `Week review ${weekStart} to ${weekEnd}`,
    scopeLabel: `${weekStart} to ${weekEnd}`,
    renderDeterministic,
    assistantScaffold: JSON.stringify({
      range: { weekStart, weekEnd },
      totals: {
        tracked: formatDuration(totalTrackedSeconds),
        focus: formatDuration(totalFocusSeconds),
        focusPct: totalTrackedSeconds > 0 ? Math.round((totalFocusSeconds / totalTrackedSeconds) * 100) : 0,
        activeDayCount: activeDays.length,
      },
      dailyHighlights: (() => {
        // R5: pack each day's blocks against one shared ~28k-token budget rather
        // than capping every day at three, so a dense week reaches the model in
        // full instead of three-blocks-per-day thin.
        const take = createEvidenceBudget()
        return activeDays.map((payload) => ({
          date: payload.date,
          tracked: formatDuration(payload.totalSeconds),
          focus: formatDuration(payload.focusSeconds),
          focusPct: payload.focusPct,
          topBlocks: take(payload.blocks, evidenceCost).map((block) => ({
            label: userVisibleBlockLabel(block),
            ...(labelProvenance(block) === 'user' ? { labelIsTheirOwnWords: true } : {}),
            duration: formatDuration(blockActiveSeconds(block)),
            artifacts: block.topArtifacts.slice(0, 3).map((artifact) => artifact.displayTitle),
          })),
        }))
      })(),
      topCategories,
      namedArtifacts: topArtifacts,
    }, null, 2),
    reportMarkdownScaffold: '',
    tableColumns: ['date', 'tracked', 'focus', 'focus_pct', 'top_blocks'],
    tableRows: dayRows,
    chartRows: activeDays.map((payload) => ({
      label: payload.date.slice(5),
      value: Number((payload.totalSeconds / 3600).toFixed(1)),
      secondaryValue: Number((payload.focusSeconds / 3600).toFixed(1)),
    })),
    chartValueLabel: 'hours',
  }
}

const APP_NARRATIVE_CACHE_VERSION = 3

function appNarrativeHasStaleMetrics(summary: AISurfaceSummary | null): boolean {
  if (!summary) return false
  const text = summary.summary.toLowerCase()
  return [
    /\bi don't see strong signal\b/,
    /\bno specific (?:artifacts|pages|work blocks|paired applications)\b/,
    /\bacross\s+\d+\s+sessions?\b/,
    /\b\d+\s+sessions?\s+(?:totaling|totalling|totaled|totalled)\b/,
    /\b(?:totaling|totalling|totaled|totalled)\s+\d+\s+(?:hours?|minutes?)\b/,
    /\b\d+\s+(?:hours?|minutes?)\s+(?:across|over|in)\s+\d+\s+sessions?\b/,
    /\b\d+\s+(?:hours?|minutes?|hrs?|mins?)\b/,
  ].some((pattern) => pattern.test(text))
}

function appNarrativeSignature(detail: ReturnType<typeof getAppDetailPayload>): string {
  // B4: totals (totalSeconds, sessionCount) intentionally excluded from
  // the signature. They tick up every minute as the live session ages —
  // including them in the cache key would invalidate the narrative on
  // every render even when nothing about WHAT the user did has changed.
  // The narrative scaffold no longer contains them either; see
  // buildAppNarrativeBundle.
  return hashText(JSON.stringify({
    version: APP_NARRATIVE_CACHE_VERSION,
    canonicalAppId: detail.canonicalAppId,
    rangeKey: detail.rangeKey,
    topArtifacts: detail.topArtifacts.slice(0, 8).map((artifact) => artifact.displayTitle),
    topDomains: (detail.browserActivity?.domains ?? []).slice(0, 8).map((entry) => entry.domain),
    topPages: (detail.browserActivity?.domains ?? []).flatMap((entry) => entry.pages).slice(0, 8).map((page) => page.displayTitle),
    blockAppearances: detail.blockAppearances.slice(0, 8).map((block) => `${block.blockId}:${block.label}:${block.startTime}:${block.endTime}`),
  }))
}

// Collapse rows that share a normalized display title, keeping the first
// (highest-duration, since inputs arrive duration-sorted). Prevents the recap
// from naming the same artifact/page twice ("Netflix, Netflix").
function dedupeByTitle<T>(rows: T[], title: (row: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    const key = title(row).trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

// Stable work-first ordering: rows whose domain is leisure (streaming/social)
// sink below the rest, preserving each group's incoming duration order. Work
// surfaces before leisure (spec invariant 8) without dropping anything.
function buildAppNarrativeBundle(
  canonicalAppId: string,
  daysOrDate: number | string = 7,
  // DEV-227: the caller usually already built this payload — at 30 days it
  // costs ~1s of blocking main-thread work, so it must never be rebuilt.
  prebuiltDetail?: ReturnType<typeof getAppDetailPayload>,
): ReportContextBundle | null {
  const detail = prebuiltDetail ?? getAppDetailPayload(getDb(), canonicalAppId, daysOrDate, getCurrentSession())
  if (detail.totalSeconds <= 0) return null

  // DEV-89: "Often used with" is gone from the Apps view, and the recap no
  // longer talks about app pairings — it narrates what was done, grounded in
  // the deduped, work-first domains and pages the view itself shows.

  // Dedupe artifacts by display title so the recap can never repeat an
  // artifact ("Netflix, Netflix"): the same title under two different URLs/ids
  // collapses to one entry, keeping the highest-duration row.
  const dedupedArtifacts = dedupeByTitle(detail.topArtifacts, (a) => a.displayTitle)
  // Work surfaces before leisure: order domains and pages so the model leads
  // with the work the user came to do, mirroring the view's ordering. Both are
  // read from the same reconciled browserActivity tree the view renders, so
  // the recap can never cite a number the screen doesn't show.
  const activityDomains = detail.browserActivity?.domains ?? []
  const domainGroups = partitionDomainsWorkFirst(activityDomains, (d) => d.domain)
  const orderedDomains = [...domainGroups.work, ...domainGroups.leisure]
  const pageGroups = partitionDomainsWorkFirst(
    dedupeByTitle(
      activityDomains.flatMap((entry) => entry.pages).sort((a, b) => b.totalSeconds - a.totalSeconds),
      (p) => p.displayTitle,
    ),
    (p) => p.domain,
  )
  const orderedPages = [...pageGroups.work, ...pageGroups.leisure]

  // B3: collapse the 24-bucket per-hour distribution into the top whole-hour
  // ranges. The model previously confabulated sub-hour windows like
  // "9:00–9:46am" from the raw distribution, producing arithmetically
  // impossible prose (more session-minutes than the window contains). With
  // whole-hour buckets and an explicit rule against minute-precise windows,
  // the model can only cite ranges that exist.
  const totalHourSeconds = detail.timeOfDayDistribution.reduce((sum, entry) => sum + entry.totalSeconds, 0)
  const topHourBuckets = detail.timeOfDayDistribution
    .filter((entry) => entry.totalSeconds > 0)
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
    .slice(0, 3)
    .map((entry) => ({
      range: `${String(entry.hour).padStart(2, '0')}:00-${String((entry.hour + 1) % 24).padStart(2, '0')}:00`,
      duration: formatDuration(entry.totalSeconds),
      sharePct: totalHourSeconds > 0 ? Math.round((entry.totalSeconds / totalHourSeconds) * 100) : 0,
    }))

  // R5: pack artifacts, paired apps, and block appearances against one shared
  // ~28k-token budget instead of fixed slices, so a heavy day's evidence is not
  // clipped to the first handful of items.
  const take = createEvidenceBudget()
  const packedArtifacts = take(dedupedArtifacts, evidenceCost)
  const packedDomains = take(orderedDomains, evidenceCost)
  const packedPages = take(orderedPages, evidenceCost)
  const packedBlockAppearances = take(detail.blockAppearances, evidenceCost)

  const isDate = typeof daysOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(daysOrDate)
  const days = isDate ? 1 : Math.max(1, Number(daysOrDate) || 7)
  const rangeWord = days >= ALL_TIME_DAYS ? 'all time' : days === 1 ? 'day' : `${days} days`
  const title = isDate
    ? `${detail.displayName} on ${daysOrDate}`
    : days >= ALL_TIME_DAYS
      ? `${detail.displayName} across all time`
      : `${detail.displayName} in the last ${rangeWord}`
  const scopeLabel = isDate
    ? `${detail.displayName} on ${daysOrDate}`
    : `${detail.displayName} over ${days >= ALL_TIME_DAYS ? 'all time' : days === 1 ? 'today' : `${days} days`}`
  return {
    title,
    scopeLabel,
    // B4: do NOT feed totalTracked / sessionCount to the narrative model.
    // The rail recomputes those live (and adds live-session minutes) while
    // the narrative is cache-keyed to a snapshot. The two drift within
    // seconds, producing "2h 19m · 64 sessions" in the header next to
    // "2 hours 18 minutes... 59 sessions" in the narrative. Totals belong
    // in the header and footer; the narrative answers "what did you do
    // here," not "how long was it open."
    assistantScaffold: JSON.stringify({
      app: {
        canonicalAppId: detail.canonicalAppId,
        displayName: detail.displayName,
      },
      topArtifacts: packedArtifacts.map((artifact) => ({
        title: artifact.displayTitle,
        subtitle: artifact.subtitle ?? artifact.host ?? artifact.path ?? null,
        duration: formatDuration(artifact.totalSeconds),
      })),
      // Work-first domains and pages — the same evidence the view shows, in the
      // same order, so the recap leads with work and never repeats an artifact.
      topDomains: packedDomains.map((entry) => ({
        domain: entry.domain,
        duration: formatDuration(entry.totalSeconds),
      })),
      topPages: packedPages.map((page) => ({
        title: page.displayTitle,
        domain: page.domain,
        duration: formatDuration(page.totalSeconds),
      })),
      blockAppearances: packedBlockAppearances.map((block) => ({
        label: block.label,
        when: `${localDateKeyForMs(block.startTime)} ${formatClock(block.startTime)}-${formatClock(block.endTime)}`,
      })),
      topHourBuckets,
    }, null, 2),
    reportMarkdownScaffold: '',
    tableColumns: ['block_label', 'when', 'category'],
    tableRows: packedBlockAppearances.map((block) => ({
      block_label: block.label,
      when: `${localDateKeyForMs(block.startTime)} ${formatClock(block.startTime)}-${formatClock(block.endTime)}`,
      category: block.dominantCategory,
    })),
    chartRows: detail.timeOfDayDistribution
      .filter((entry) => entry.totalSeconds > 0)
      .map((entry) => ({
        label: `${String(entry.hour).padStart(2, '0')}:00`,
        value: Number((entry.totalSeconds / 3600).toFixed(1)),
      })),
    chartValueLabel: 'hours',
  }
}

function buildDayReportContentLens(
  payload: DayTimelinePayload,
  dayAttribution: ReturnType<typeof resolveDayContext>,
): Record<string, unknown> {
  const categorySeconds = new Map<string, number>()
  const appSeconds = new Map<string, number>()
  const artifactTitles = new Set<string>()
  const pageTitles = new Set<string>()
  const workflows = new Set<string>()
  const clientSeconds = new Map<string, number>()
  const projectSeconds = new Map<string, number>()

  for (const block of payload.blocks) {
    const durationSeconds = blockDurationSeconds(block)
    categorySeconds.set(block.dominantCategory, (categorySeconds.get(block.dominantCategory) ?? 0) + durationSeconds)
    for (const app of block.topApps.slice(0, 5)) {
      appSeconds.set(app.appName, (appSeconds.get(app.appName) ?? 0) + app.totalSeconds)
    }
    for (const artifact of block.topArtifacts.slice(0, 4)) artifactTitles.add(artifact.displayTitle)
    for (const page of block.pageRefs.slice(0, 4)) {
      const title = page.pageTitle ?? page.displayTitle
      if (title) pageTitles.add(title)
    }
    for (const workflow of block.workflowRefs.slice(0, 3)) workflows.add(workflow.label)
  }

  for (const session of dayAttribution.sessions) {
    if (session.client?.name) {
      clientSeconds.set(session.client.name, (clientSeconds.get(session.client.name) ?? 0) + Math.round(session.active_ms / 1000))
    }
    if (session.project?.name) {
      projectSeconds.set(session.project.name, (projectSeconds.get(session.project.name) ?? 0) + Math.round(session.active_ms / 1000))
    }
  }

  const ranked = (map: Map<string, number>, limit: number) => [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, seconds]) => ({ name, duration: formatDuration(seconds) }))

  const topCategories = ranked(categorySeconds, 4)
  const hasNamedAttribution = clientSeconds.size > 0 || projectSeconds.size > 0
  const primaryCategory = topCategories[0]?.name ?? null
  const dayShape = hasNamedAttribution
    ? 'client_or_project_delivery'
    : primaryCategory === 'development'
      ? 'development_or_technical_work'
      : primaryCategory === 'writing'
        ? 'writing_or_document_work'
        : primaryCategory === 'communication'
          ? 'communication_or_coordination'
          : primaryCategory === 'research'
            ? 'research_or_learning'
            : 'mixed_work'

  return {
    dayShape,
    instruction:
      'Use this as a temporary lens for this report only. Do not store or imply a permanent user role from one day.',
    topCategories,
    topApps: ranked(appSeconds, 6),
    namedClients: ranked(clientSeconds, 6),
    namedProjects: ranked(projectSeconds, 6),
    namedArtifacts: [...artifactTitles].slice(0, 10),
    namedPages: [...pageTitles].slice(0, 10),
    workflows: [...workflows].slice(0, 8),
    confidenceNotes: [
      hasNamedAttribution
        ? 'Named client/project sections may be emphasized because structured attribution exists for today.'
        : 'No strong structured client/project attribution exists for today; avoid consultant-specific framing unless the block evidence itself supports it.',
      'If the day looks mixed, write the report around the content shifts instead of forcing one role.',
    ],
  }
}

function buildDayReportBundle(dateStr: string): ReportContextBundle | null {
  const liveSession = dateStr === currentLocalDateString() ? getCurrentSession() : null
  const payload = getTimelineDayPayload(getDb(), dateStr, liveSession)
  if (payload.totalSeconds <= 0) return null
  const settings = getSettings()
  const personalizationEnabled = settings.aiReportPersonalizationEnabled === true
  const dayAttribution = resolveDayContext(dateStr, getDb())
  const contentLens = buildDayReportContentLens(payload, dayAttribution)

  const categoryRows = Array.from(payload.blocks.reduce<Map<string, number>>((map, block) => {
    const durationSeconds = blockActiveSeconds(block)
    map.set(block.dominantCategory, (map.get(block.dominantCategory) ?? 0) + durationSeconds)
    return map
  }, new Map()).entries())
    .sort((left, right) => right[1] - left[1])

  // R5: pack the day's blocks and named sessions against one shared
  // ~28k-token budget so a long day's evidence is not clipped to the first
  // dozen-ish blocks.
  const take = createEvidenceBudget()
  const packedBlocks = take(payload.blocks, evidenceCost)
  const packedNamedSessions = take(dayAttribution.sessions, evidenceCost)

  return {
    title: `Day report ${dateStr}`,
    scopeLabel: dateStr,
    assistantScaffold: [
      buildDaySummaryScaffold(payload),
      '',
      'Day report lens (JSON):',
      JSON.stringify({
        personalization: {
          enabled: personalizationEnabled,
          rule: personalizationEnabled
            ? 'Use profile signals only as light emphasis after the evidence; never override what the day actually contains.'
            : 'Personalization is off. Do not infer a durable user role or identity; adapt only to today\'s content.',
        },
        contentLens,
        attribution: {
          summary: dayAttribution.day_summary,
          namedSessions: packedNamedSessions.map((session) => ({
            start: session.start,
            end: session.end,
            active_ms: session.active_ms,
            client: session.client?.name ?? null,
            project: session.project?.name ?? null,
            confidence: session.confidence,
            apps: session.apps.slice(0, 4).map((app) => app.app_name),
            evidence: session.evidence.slice(0, 4).map((item) => item.value),
          })),
          ambiguousSegments: dayAttribution.ambiguous_segments.slice(0, 6),
        },
      }, null, 2),
    ].join('\n'),
    reportMarkdownScaffold: '',
    tableColumns: ['start', 'end', 'block', 'category', 'apps', 'artifacts', 'duration'],
    tableRows: packedBlocks.map((block) => ({
      start: formatClock(block.startTime),
      end: formatClock(block.endTime),
      block: userVisibleBlockLabel(block),
      category: block.dominantCategory,
      apps: block.topApps.slice(0, 3).map((app) => app.appName).join(' | ') || 'n/a',
      artifacts: block.topArtifacts.slice(0, 3).map((artifact) => artifact.displayTitle).join(' | ') || 'n/a',
      duration: formatDuration(blockActiveSeconds(block)),
    })),
    chartRows: categoryRows.slice(0, 8).map(([category, seconds]) => ({
      label: category,
      value: Number((seconds / 3600).toFixed(1)),
    })),
    chartValueLabel: 'hours',
  }
}

async function generateWeekReview(weekStartStr: string, force = false): Promise<AISurfaceSummary | null> {
  const bundle = buildWeekReviewBundle(weekStartStr)
  if (!bundle) return null

  const scopeKey = `week:${weekStartStr}`
  const { weekStart, weekEnd } = buildWeekDateRange(weekStartStr)
  const [memoryFromMs] = localDateBoundsFromString(weekStart)
  const [, memoryToMs] = localDateBoundsFromString(weekEnd)
  const memoryPrompt = buildDaylensMemoryPromptBlock({ fromMs: memoryFromMs, toMs: memoryToMs })
  // Tone is part of the signature so a Settings voice change does not keep
  // returning a card written in the previous voice (REQ-VIC-002).
  const voice = normalizeSummaryVoice(getSettings().summaryVoice)
  const inputSignature = hashText([bundle.assistantScaffold, memoryPrompt, voice].join('\n'))
  if (!force) {
    const existingSignature = getAISurfaceSummarySignature(getDb(), 'timeline_week', scopeKey)
    if (existingSignature === inputSignature) {
      return getAISurfaceSummary(getDb(), 'timeline_week', scopeKey)
    }
  }

  const fallback = getAISurfaceSummary(getDb(), 'timeline_week', scopeKey, { stale: true })
  const systemPrompt = [
    VOICE_SYSTEM_PROMPT,
    memoryPrompt,
    'You are Daylens, writing the short week-review card for the Timeline week view.',
    'Do not use emoji in any part of your response.',
    USER_VISIBLE_ACTIVITY_PROSE_RULE,
    USER_AUTHORED_LABEL_RULE,
    ...INTERPRETATION_DIRECTIVES,
    voiceDirective(voice),
    'Use only the deterministic local evidence provided.',
    'Focus on the actual work threads, named artifacts, and where the week concentrated.',
    'Avoid dashboard filler or generic productivity language.',
    'Return strict JSON with keys "title" and "summary".',
    '"summary" must be 2-4 sentences and grounded in the evidence.',
  ].filter(Boolean).join('\n')
  const userMessage = [
    `Write a concise week review for ${bundle.scopeLabel}.`,
    '',
    'Structured week evidence (JSON):',
    bundle.assistantScaffold,
  ].join('\n')

  try {
    const { text } = await executeTextAIJob(
      {
        jobType: 'week_review',
        screen: 'timeline_week',
        triggerSource: 'user',
        systemPrompt,
        userMessage,
      },
      sendWithProvider,
    )
    const parsed = parseSurfaceSummaryResult(text, bundle.title)
    if (!parsed) return fallback
    const stored = upsertAISurfaceSummary(getDb(), {
      scopeType: 'timeline_week',
      scopeKey,
      jobType: 'week_review',
      inputSignature,
      title: parsed.title,
      summary: parsed.summary,
    })
    invalidateProjectionScope('timeline', 'ai:week_review')
    return stored
  } catch (error) {
    console.warn(`[ai] week_review failed for ${scopeKey}:`, error)
    return fallback
  }
}

async function generateAppNarrative(
  canonicalAppId: string,
  daysOrDate: number | string = 7,
  force = false,
): Promise<AISurfaceSummary | null> {
  // DEV-227: the detail payload is the expensive multi-day scan — prefer the
  // range worker so Generate never freezes the UI; inline is the fallback.
  const detail = await workerAppDetail<ReturnType<typeof getAppDetailPayload>>(
    canonicalAppId, daysOrDate, getCurrentSession(),
  ).catch(() => getAppDetailPayload(getDb(), canonicalAppId, daysOrDate, getCurrentSession()))
  const bundle = buildAppNarrativeBundle(canonicalAppId, daysOrDate, detail)
  if (!bundle) {
    console.info(`[ai] app_narrative skipped: no bundle (totalSeconds<=0) for ${canonicalAppId} ${daysOrDate}`)
    return null
  }
  const scopeKey = appNarrativeScopeKey(detail.canonicalAppId, detail.rangeKey)
  const isDate = typeof daysOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(daysOrDate)
  const days = isDate ? 1 : Math.max(1, Number(daysOrDate) || 7)
  const [memoryFromMs, memoryToMs] = isDate
    ? localDateBoundsFromString(daysOrDate)
    : (() => {
      const [, todayToMs] = dayBounds(new Date())
      if (days >= ALL_TIME_DAYS) return [0, todayToMs] as const
      const end = new Date(todayToMs)
      const fromMs = new Date(
        end.getFullYear(),
        end.getMonth(),
        end.getDate() - days,
      ).getTime()
      return [fromMs, todayToMs] as const
    })()
  const memoryPrompt = buildDaylensMemoryPromptBlock({
    fromMs: memoryFromMs,
    toMs: memoryToMs,
  })
  // Tone is part of the signature so a Settings voice change does not keep
  // returning a card written in the previous voice (REQ-VIC-002).
  const voice = normalizeSummaryVoice(getSettings().summaryVoice)
  const inputSignature = hashText([appNarrativeSignature(detail), memoryPrompt, voice].join('\n'))
  // Force=true must bypass the signature short-circuit. Without this, clicking
  // Generate/Refresh on an app whose evidence has not changed since the last
  // cached narrative returns the same cached row without ever calling the AI,
  // which surfaces in the UI as "the button does nothing visible" — the most
  // common case being a cached "thin app-specific signal" narrative that the
  // renderer treats as no narrative.
  if (!force) {
    const existingSignature = getAISurfaceSummarySignature(getDb(), 'app_detail', scopeKey)
    if (existingSignature === inputSignature) {
      const existing = getAISurfaceSummary(getDb(), 'app_detail', scopeKey)
      if (!appNarrativeHasStaleMetrics(existing)) {
        console.info(`[ai] app_narrative cache-hit (signature match) for ${scopeKey}`)
        return existing
      }
    }
  }
  console.info(`[ai] app_narrative running model for ${scopeKey} (force=${force})`)

  const cachedFallback = getAISurfaceSummary(getDb(), 'app_detail', scopeKey, { stale: true })
  const fallback = appNarrativeHasStaleMetrics(cachedFallback) ? null : cachedFallback
  const systemPrompt = [
    VOICE_SYSTEM_PROMPT,
    memoryPrompt,
    'You are Daylens, writing the short narrative card for an app detail view.',
    'Do not use emoji in any part of your response.',
    USER_VISIBLE_ACTIVITY_PROSE_RULE,
    ...INTERPRETATION_DIRECTIVES,
    voiceDirective(voice),
    'Explain what this tool was helping with and which artifacts, pages, or sites appeared there. Lead with the work (the domains and pages listed first); mention leisure only briefly if at all.',
    'Use only the deterministic evidence below.',
    'Do not write vanity metrics or generic app summaries.',
    // Citation floor: the summary must name at least two concrete entities
    // from the structured evidence (block labels, artifacts, pages, domains).
    // Evidence-thin apps must say so plainly — a filler sentence like "used
    // for development work" is not acceptable.
    `The "summary" field must cite at least two concrete entities from the evidence: block labels, artifact titles, page titles, or domain names. If the evidence is too thin to cite two entities, say "${THIN_APP_NARRATIVE_SUMMARY}" and stop — do not pad with generic prose.`,
    // DEV-89 invariant 10: never repeat an artifact and never name one absent
    // from the evidence. The evidence is already deduped; do not list the same
    // site, page, or artifact twice ("Netflix, Netflix") or invent one.
    'Never name the same domain, page, or artifact more than once, and never name one that is not in the evidence below.',
    // B4: totals are rendered in the UI header and footer. The narrative
    // must not restate them — the header recomputes live and the cached
    // narrative drifts within seconds. Talk about what was done, not how
    // long it took.
    'Do not state total time, session count, or "across N sessions" / "totaling Xh Ym" framings. Those numbers live in the UI; the narrative says what was done in the app.',
    // DEV-89: the recap no longer discusses which apps were used together —
    // "Often used with" was removed. Do not write a "paired with" / "used
    // alongside" sentence; talk about the work done in this app.
    'Do not describe which other apps this one was used alongside. There is no paired-app evidence; focus on the sites, pages, and artifacts.',
    // B3: minute-precise window confabulation. The model previously wrote
    // "concentrated in the 9:00–9:46am window" — arithmetic that cannot fit
    // the total minutes claimed. `topHourBuckets` holds the only ranges
    // allowed to appear in prose, expressed as whole-hour spans.
    'When citing a time window, you may only use ranges from `topHourBuckets` (whole-hour spans like "9:00-10:00"). Never invent sub-hour minute boundaries such as "9:00-9:46". If activity spans many hours with no single concentration, say it spans the morning/afternoon/evening rather than citing a fake narrow window.',
    'Return strict JSON with keys "title" and "summary".',
    '"summary" must be 2-4 sentences.',
  ].filter(Boolean).join('\n')
  const userMessage = [
    `Write an app narrative for ${bundle.scopeLabel}.`,
    '',
    'Structured app evidence (JSON):',
    bundle.assistantScaffold,
  ].join('\n')

  try {
    const { text } = await executeTextAIJob(
      {
        jobType: 'app_narrative',
        screen: 'app_detail',
        triggerSource: 'user',
        systemPrompt,
        userMessage,
      },
      sendWithProvider,
    )
    const parsed = parseSurfaceSummaryResult(text, bundle.title)
    if (!parsed) {
      console.warn(`[ai] app_narrative parse-failed for ${scopeKey}; falling back`)
      return fallback
    }
    const stored = upsertAISurfaceSummary(getDb(), {
      scopeType: 'app_detail',
      scopeKey,
      jobType: 'app_narrative',
      inputSignature,
      title: parsed.title,
      summary: parsed.summary,
    })
    invalidateProjectionScope('apps', 'ai:app_narrative', {
      canonicalAppId,
    })
    console.info(`[ai] app_narrative stored for ${scopeKey} (summary chars=${parsed.summary.length})`)
    return stored
  } catch (error) {
    console.warn(`[ai] app_narrative failed for ${scopeKey}:`, error)
    throw error
  }
}






// "in word please?", "pdf version", "as markdown" — a bare format request that
// points back at the answer we just gave. Re-render that answer as the requested
// file(s) instead of dead-ending with "I can't export to Word". Returns null when
// the message isn't a pure format ask, names a time period (that's a fresh
// report), or there's nothing prior to export.

// FB7: transforms rewrite the SPECIFIC prior answer (with its grounded numbers)
// into the requested form via a real model call — no re-analysis, no generic day
// bundle. The instructions + labels live in shared/answerTransforms so the
// renderer (menu + retry) and this generation path can never drift.




function parseWorkBlockInsight(raw: string): WorkContextInsight | null {
  const candidate = escapeJsonBlock(raw)
  try {
    const parsed = JSON.parse(candidate) as { label?: unknown; narrative?: unknown }
    return {
      label: typeof parsed.label === 'string' ? parsed.label.trim() : null,
      narrative: typeof parsed.narrative === 'string' ? parsed.narrative.trim() : null,
    }
  } catch {
    const labelMatch = candidate.match(/label\s*:\s*(.+)/i)
    const narrativeMatch = candidate.match(/narrative\s*:\s*([\s\S]+)/i)
    if (!labelMatch && !narrativeMatch) return null
    return {
      label: labelMatch?.[1]?.trim() ?? null,
      narrative: narrativeMatch?.[1]?.trim() ?? null,
    }
  }
}

// Exported for the interpretation-agent relabel (services/interpretationAgent.ts),
// which grounds its tool loop in the SAME per-block evidence prompt the direct
// relabel uses — one evidence contract, two execution modes.
export function workBlockPrompt(block: WorkContextBlock): string {
  const durationMinutes = Math.max(1, Math.round(blockActiveSeconds(block) / 60))

  // Top websites with duration — highest-signal evidence (browser/AI work)
  const websiteLines = block.websites.slice(0, 5).map((site) => {
    const dur = formatDuration(site.totalSeconds)
    const title = site.topTitle ? ` (${site.topTitle.slice(0, 60)})` : ''
    return `  ${site.domain}${title} — ${dur}`
  })

  // Native window titles (non-browser) — document/file context. keyPages often
  // repeats what the window-title and website evidence already carries; each
  // fact is sent once and titles cap at 100 chars.
  const alreadyShownTitles = new Set<string>([
    ...(block.evidenceSummary.windowTitles ?? []).map((w) => (w.title ?? '').trim().toLowerCase()),
    ...block.websites.map((site) => (site.topTitle ?? '').trim().toLowerCase()),
  ])
  const pages = block.keyPages
    .filter(Boolean)
    .filter((page) => !alreadyShownTitles.has(page.trim().toLowerCase()))
    .slice(0, 5)
    .map((page) => page.slice(0, 100))

  // Evidence object: real captured window titles and the files touched.
  // These carry the intent that app names alone never could (the "blindfolded
  // namer" failure) — feed them to the model explicitly.
  const windowTitleLines = (block.evidenceSummary.windowTitles ?? [])
    .filter((w) => w.title?.trim())
    .slice(0, 6)
    .map((w) => `  "${w.title.slice(0, 80)}" — ${w.appName} (${formatDuration(w.totalSeconds)})`)
  const fileLines = (block.evidenceSummary.files ?? [])
    .filter((f) => f.filename?.trim())
    .slice(0, 6)
    .map((f) => `  ${f.filename} — ${f.appName} (${formatDuration(f.totalSeconds)})`)

  // Top apps with duration and category
  const appLines = block.topApps.slice(0, 5).map((app) => {
    return `  ${app.appName} (${app.category}) — ${formatDuration(app.totalSeconds)}`
  })

  // Category time breakdown
  const catLines = (Object.entries(block.categoryDistribution) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, sec]) => `  ${cat}: ${formatDuration(sec)}`)

  const switchNote = block.switchCount >= 5
    ? `App transitions observed: ${block.switchCount}.`
    : block.switchCount >= 2
      ? `App transitions observed: ${block.switchCount}.`
      : ''

  const lines = [
    'Analyze this Daylens work block.',
    'Return strict JSON: {"label":"...","narrative":"..."}',
    'label: a 2-7 word phrase naming what they were DOING, usually verb + object ("Configuring the work network", "Refactoring the timeline engine"). NEVER a raw app name, browser name, page/video title, or bare category ("Chrome", "Cursor", "Watching Netflix", "Browsing", "Development"). NEVER the literal "Computer activity", "Uncategorized", or "Untitled". Never put an em dash in a label; use a comma or the word "and".',
    'narrative: 1-2 plain sentences. Evidence-led, no hype, no "the user" prefix.',
    'Priority rules:',
    '  - Window titles and page titles > artifact names > category descriptions > app names only as last-resort context, never as the label.',
    '  - Browser+AI only ≠ Development → call it Research or Planning.',
    '  - Do NOT return "Building & Testing" without a code editor or terminal in the evidence.',
    '  - This block may already combine several stretches of one activity. Name the WHOLE thing in one coherent title that covers all the evidence (e.g. "Setting up the work network with the Ubiquiti dashboard and Terminal"), not just the first app.',
    '  - A short peek at streaming or social (YouTube, Netflix, X) inside a work block is a side-distraction, not the headline. Name the work, never the peek, since people multi-task with media on the side while actually working.',
    '  - When a terminal, editor, or agent runner (Ghostty, Warp, Codex, cmux, Claude Code) holds a substantial share of the block alongside media, the WORK is the headline and the media is at most an aside. Media titles are more descriptive than terminal windows, never more important: two hours of terminal time next to browser videos is a work block with videos on the side, not "watching videos".',
    '  - An AI-chat conversation title (ChatGPT, Claude, Gemini) names a TOPIC DISCUSSED, never a thing accomplished. Label the block as working through or exploring that topic; NEVER use completion or deployment verbs (deployed, shipped, launched, released, fixed, built) on chat or browser evidence alone, because those verbs need a code editor or terminal in this block actually doing it.',
    '  - Never invent a project, product, or deliverable name. Every proper noun in your label must appear in the evidence above; a plausible-sounding name the evidence does not contain is a fabrication.',
    '  - Name the site or tool where the work happened ("in Notion", "in Google Docs", "in Linear"), not the browser it was rendered in. Mention the browser only as secondary context ("in the Dia browser"), never as the headline location.',
    '  - If you genuinely cannot tell the intent, name it honestly from the real apps and artifacts you DO have ("Focused work in Cursor, Warp, and Terminal"). Never announce failure, never say "Computer activity" or "Uncategorized".',
    '',
    `Duration: ${durationMinutes} minutes`,
    `Dominant category: ${block.dominantCategory}`,
    switchNote,
    '',
    websiteLines.length > 0 ? `Website evidence (highest priority):\n${websiteLines.join('\n')}` : 'Websites: none',
    windowTitleLines.length > 0 ? `Window titles (what was on screen):\n${windowTitleLines.join('\n')}` : '',
    fileLines.length > 0 ? `Files touched:\n${fileLines.join('\n')}` : '',
    pages.length > 0 ? `Page titles:\n${pages.map((p) => `  ${p}`).join('\n')}` : 'Page titles: none',
    appLines.length > 0 ? `Apps used:\n${appLines.join('\n')}` : 'Apps: none',
    catLines.length > 0 ? `Category breakdown:\n${catLines.join('\n')}` : '',
    `Rule-based label (override this if evidence supports better): ${userVisibleLabelForBlock(block)}`,
  ].filter(Boolean)

  return lines.join('\n')
}

function parseSuggestedCategory(raw: string): AppCategorySuggestion | null {
  const candidate = escapeJsonBlock(raw)
  try {
    const parsed = JSON.parse(candidate) as { category?: unknown; reason?: unknown }
    const category = typeof parsed.category === 'string' ? parsed.category.trim() : null
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : null
    return {
      suggestedCategory: isAppCategory(category) ? category : null,
      reason,
    }
  } catch {
    const normalized = candidate.trim().toLowerCase()
    if (isAppCategory(normalized)) {
      return { suggestedCategory: normalized, reason: null }
    }
    return null
  }
}

function isAppCategory(value: string | null): value is import('@shared/types').AppCategory {
  return value !== null && [
    'development',
    'communication',
    'research',
    'writing',
    'aiTools',
    'design',
    'browsing',
    'meetings',
    'entertainment',
    'email',
    'productivity',
    'social',
    'system',
    'uncategorized',
  ].includes(value)
}

function appCategorySuggestionPrompt(bundleId: string, appName: string): string {
  return [
    'Classify this app into one Daylens category.',
    'Return strict JSON: {"category":"...","reason":"..."}',
    'Allowed categories: development, communication, research, writing, aiTools, design, browsing, meetings, entertainment, email, productivity, social, system, uncategorized',
    'Use uncategorized only if the app identity is genuinely ambiguous.',
    `Bundle or executable: ${bundleId || 'Unknown'}`,
    `App name: ${appName || 'Unknown'}`,
  ].join('\n')
}

// Cache AI category suggestions to avoid re-sending identical classification requests.
// Keyed by "bundleId::appName" (lowercased). Survives for the lifetime of the process.
const _categorySuggestionCache = new Map<string, AppCategorySuggestion>()

export async function suggestAppCategory(bundleId: string, appName: string): Promise<AppCategorySuggestion> {
  const cacheKey = `${bundleId}::${appName}`.toLowerCase()
  const cached = _categorySuggestionCache.get(cacheKey)
  if (cached) return cached

  const systemPrompt = [
    VOICE_SYSTEM_PROMPT,
    'You are Daylens.',
    'You classify productivity apps conservatively.',
    'Prefer email for mail clients, communication for chat clients, browsing only for real web browsers.',
    'Return only valid JSON.',
  ].join(' ')

  try {
    const { text } = await executeTextAIJob(
      {
        jobType: 'attribution_assist',
        screen: 'background',
        triggerSource: 'system',
        systemPrompt,
        userMessage: appCategorySuggestionPrompt(bundleId, appName),
      },
      sendWithProvider,
    )
    const parsed = parseSuggestedCategory(text)
    if (parsed?.suggestedCategory) {
      _categorySuggestionCache.set(cacheKey, parsed)
      return parsed
    }
  } catch {
    // Fall through to no-suggestion result.
  }

  const noSuggestion: AppCategorySuggestion = { suggestedCategory: null, reason: null }
  _categorySuggestionCache.set(cacheKey, noSuggestion)
  return noSuggestion
}

// The deterministic name used when the model cannot produce a voiced label.
// The evidence-based fallback is usually fine, but it can itself be a raw
// artifact form ("handoff.md") — never persist that as an "ai" label; name the
// category honestly instead (a floor the clarification agent then asks about).
function voiceSafeFallbackLabel(block: WorkContextBlock): string {
  const fallback = userVisibleLabelForBlock(block)
  if (!rawLabelForm(fallback)) return fallback
  return activityCategoryLabel(block.dominantCategory)
}

export async function generateWorkBlockInsight(
  block: WorkContextBlock,
  options?: {
    jobType?: 'block_label_preview' | 'block_label_finalize' | 'block_cleanup_relabel'
    triggerSource?: AIInvocationSource
    throwOnError?: boolean
    // When the user explicitly rejects a label and asks for a new one, pass the
    // rejected text so the model is told not to repeat it. Without this the
    // same evidence produces the same label and "Regenerate" feels like a
    // no-op.
    rejectedLabel?: string
    // A freeform note the user typed about what they actually did today (from
    // the "done for the day?" wrap flow). Used as a strong grounding hint when
    // the evidence alone is ambiguous — never overrides the evidence wholesale.
    userHint?: string
    /** Reports the provider model that actually produced the insight, so the
     *  day-analysis version ledger (DEV-206) can record which model wrote it. */
    onModel?: (model: string) => void
  },
): Promise<WorkContextInsight> {
  const systemPrompt = [
    VOICE_SYSTEM_PROMPT,
    'You are Daylens.',
    'You label productivity timeline blocks from local activity evidence.',
    'Do not use emoji in any part of your response.',
    'Be concrete, restrained, and evidence-led.',
    'Never mention the model provider.',
    'If the evidence is weak, keep the label generic but still useful.',
    'Return only valid JSON.',
  ].join(' ')

  // The label-voice contract (label-voice.md, DEV-276): the model's label must
  // clear the invariant rules, must not echo a captured title or a bare app
  // name, and must not present a tool brand/surface, command line, joined tab
  // title, or site surface as the work — even behind a verb lead ("Working on
  // Cursor Agents"). One shared gate (labelCandidateViolation) holds this path
  // and the interpretation agent to the same standard. A rejected label gets
  // exactly one corrective retry with the violation named; if that also fails,
  // the deterministic evidence name (voice gated itself) stands and the block
  // stays a re-analysis target.
  // The block kind matters: without it the leisure-shape rule is inert here
  // and a bare video title would only be caught later by the label chooser.
  const voiceContext = labelVoiceContextForBlock(block, effectiveBlockKind(block))
  const labelRejection = (candidate: string | null | undefined): string | null =>
    labelCandidateViolation(candidate, voiceContext)

  try {
    const requestInsight = async (voiceFeedback?: string) => {
      const { text, config } = await withTimeout(
        executeTextAIJob(
          {
            jobType: options?.jobType ?? (block.isLive ? 'block_label_preview' : 'block_label_finalize'),
            screen: 'timeline_day',
            triggerSource: options?.triggerSource ?? (block.isLive ? 'system' : 'background'),
            systemPrompt,
            userMessage: [
              workBlockPrompt(block),
              options?.rejectedLabel?.trim()
                ? `The previous label "${options.rejectedLabel.trim()}" was marked inaccurate by the user. Produce a clearly different, more accurate label grounded only in the evidence above.`
                : '',
              options?.userHint?.trim()
                ? `The user described their day as: "${options.userHint.trim()}". Treat this as a strong hint for what they were doing, but stay grounded in the evidence above, and only apply it where it fits this block's activity.`
                : '',
              voiceFeedback ?? '',
            ].filter(Boolean).join('\n\n'),
          },
          sendWithProvider,
        ),
        BLOCK_INSIGHT_TIMEOUT_MS,
        'Block insight timed out',
      )
      options?.onModel?.(config.model)
      return parseWorkBlockInsight(text)
    }

    let parsed = await requestInsight()
    let rejection = labelRejection(parsed?.label)
    if (rejection && !block.isLive) {
      parsed = await requestInsight(
        `Your previous label "${parsed?.label ?? ''}" was rejected: ${rejection}. `
        + 'Name what the person was DOING in everyday words (verb + object). '
        + 'Never a window title, page title, filename, app name, ticket text, or JSON.',
      )
      rejection = labelRejection(parsed?.label)
    }

    const label = rejection ? voiceSafeFallbackLabel(block) : parsed!.label!.trim()
    const insight = {
      label,
      narrative: parsed?.narrative || fallbackNarrativeForBlock(block),
    }
    if (!block.isLive) {
      upsertWorkContextInsight(getDb(), {
        startMs: block.startTime,
        endMs: block.endTime,
        insight,
        sourceBlockIds: [block.id],
      })
    }
    return insight
  } catch (error) {
    if (options?.throwOnError) throw error
    const insight = {
      label: voiceSafeFallbackLabel(block),
      narrative: fallbackNarrativeForBlock(block),
    }
    if (!block.isLive && block.aiLabel) {
      upsertWorkContextInsight(getDb(), {
        startMs: block.startTime,
        endMs: block.endTime,
        insight,
        sourceBlockIds: [block.id],
      })
    }
    return insight
  }
}

const DAY_REGROUP_TIMEOUT_MS = 60_000

function hhmmForTimestamp(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// Compact, evidence-led description of every block on the day, in order, for the
// regroup planner. One model call sees the WHOLE day at once so it can decide
// which adjacent blocks are the same continued intent (timeline.md §3.3) — the
// per-block namer never sees its neighbours and so can never make this call.
function dayRegroupPrompt(blocks: WorkContextBlock[], userHint?: string): string {
  const blockLines = blocks.map((block, index) => {
    const dur = Math.max(1, Math.round(blockActiveSeconds(block) / 60))
    const apps = block.topApps.slice(0, 4).map((app) => app.appName).filter(Boolean).join(', ')
    const titles = (block.evidenceSummary.windowTitles ?? [])
      .filter((w) => w.title?.trim())
      .slice(0, 3)
      .map((w) => `"${w.title.slice(0, 60)}"`)
      .join('; ')
    const sites = block.websites.slice(0, 3).map((site) => site.domain).filter(Boolean).join(', ')
    return [
      `[${index}] ${hhmmForTimestamp(block.startTime)}-${hhmmForTimestamp(block.endTime)} (${dur}m) · ${block.dominantCategory}`,
      `    labelled now: ${userVisibleLabelForBlock(block)}`,
      apps ? `    apps: ${apps}` : '',
      titles ? `    on screen: ${titles}` : '',
      sites ? `    sites: ${sites}` : '',
    ].filter(Boolean).join('\n')
  })

  const lines = [
    'Here are today\'s timeline blocks, in order. They were cut by simple rules and tend to be SPLIT TOO FINELY: one real activity is often broken across several adjacent blocks.',
    'Your job: group the blocks that are the SAME continued activity into one block. Return strict JSON: {"groups": [[0,1,2],[3],[4,5]]}.',
    'Rules:',
    '  - Each inner array is a run of CONSECUTIVE block indices that are one continued intent/goal/project and should become a single block.',
    '  - Every index 0..N-1 appears exactly once, in order. A block that stands on its own is its own one-element group.',
    '  - Merge ONLY genuinely-same work: the same task or project continued (e.g. setting up the work network across Terminal, the Ubiquiti dashboard, and diagnostics is ONE thing). A short peek at streaming/social between two stretches of the same work does not break the run, so keep merging across it.',
    '  - Keep genuinely DIFFERENT goals separate: coding a feature, a meeting, and unrelated admin are different blocks even when back-to-back. When unsure, keep them separate.',
    '  - Never group to just shrink the count, and never invent a connection the evidence does not show. You may only GROUP existing blocks, never split one.',
    '',
    `Blocks (${blocks.length}):`,
    blockLines.join('\n'),
    userHint ? `\nThe user described their day as: "${userHint}". Use it only to recognise which blocks are the same thread; never invent activity it does not support.` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

// Plan how to regroup a day's heuristic blocks into fewer, same-intent blocks.
// Returns the runs of consecutive block indices to merge (singletons stay as is)
// or null when the AI is unavailable / returns an unusable plan — the caller
// then leaves the day on its heuristic blocks (timeline.md §5 fallback). The
// merged blocks are NAMED by the existing per-block namer, which reads the full
// combined evidence and produces one coherent title (§3.3).
export async function generateDayRegroupPlan(
  blocks: WorkContextBlock[],
  options?: {
    userHint?: string
    /** Reports the provider model that actually produced the plan, so the
     *  day-analysis version ledger (DEV-206) can record which model wrote it. */
    onModel?: (model: string) => void
  },
): Promise<number[][] | null> {
  if (blocks.length < 2) return null

  const systemPrompt = [
    VOICE_SYSTEM_PROMPT,
    'You are Daylens.',
    'You decide which adjacent timeline blocks are the same continued activity and should be one block.',
    'You only group blocks that are already there, and you never split, rename, or invent activity.',
    'Return only valid JSON.',
  ].join(' ')

  try {
    const { text, config } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'block_cleanup_relabel',
          screen: 'timeline_day',
          triggerSource: 'user',
          systemPrompt,
          userMessage: dayRegroupPrompt(blocks, options?.userHint?.trim() || undefined),
        },
        sendWithProvider,
      ),
      DAY_REGROUP_TIMEOUT_MS,
      'Day regroup timed out',
    )
    options?.onModel?.(config.model)
    return parseDayRegroupGroups(text, blocks.length)
  } catch (error) {
    console.warn('[timeline] AI day regroup failed:', error)
    return null
  }
}



// Translate raw provider SDK errors (e.g. a 429 JSON blob from Gemini) into a
// short, branded, *accurately classified* message before it reaches the chat
// UI (R4 + R2). Delegates to the shared classifier so a transient per-minute
// 429 reads (and behaves) differently from a hard quota/credit/auth wall, and
// so the structured code rides along for the renderer (auto-retry vs
// switch-provider). The default label is the chat provider the UI shows.
function friendlyChatError(err: unknown, label?: string): Error {
  const resolvedLabel = label
    ?? providerLabel(getSettings().aiChatProvider ?? getSettings().aiProvider ?? 'anthropic')
  return friendlyProviderError(err, resolvedLabel)
}

// S1: interpret a natural-language search query into FTS keywords + a one-line
// intent, using the chat provider (cheapest tier, one throttled call). Returns
// null when no provider is configured or the call/parse fails, so search can
// fall back to deterministic term extraction and never hard-fails offline.
export async function interpretSearchIntent(query: string): Promise<{ terms: string[]; intent: string | null } | null> {
  const trimmed = query.trim()
  if (!trimmed) return null
  const systemPrompt = [
    "You turn a user's natural-language search into keywords for a LOCAL full-text search over their tracked activity (app + window titles, web page titles and domains, timeline block labels, saved AI artifacts).",
    'Return STRICT JSON only, no prose, no code fence:',
    '{"terms":["..."],"intent":"<one short clause>"}',
    'Rules:',
    '- terms: 1-6 short lowercase keywords/phrases: the concrete nouns/entities the user means (project names, apps, topics, people, domains). Expand obvious synonyms/abbreviations (e.g. "autoencoders" also "autoencoder"). Drop stopwords and question words.',
    '- Never invent specific names the query does not imply.',
    '- intent: a short human clause like "the autoencoders project" or "anything about the migration".',
  ].join('\n')
  try {
    const { text } = await executeTextAIJob(
      { jobType: 'search_intent', screen: 'ai_chat', triggerSource: 'user', systemPrompt, userMessage: trimmed },
      sendWithProvider,
    )
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { terms?: unknown; intent?: unknown }
    const terms = Array.isArray(parsed.terms)
      ? parsed.terms
          .filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
          .map((term) => term.trim().toLowerCase())
          .slice(0, 6)
      : []
    if (terms.length === 0) return null
    const intent = typeof parsed.intent === 'string' && parsed.intent.trim() ? parsed.intent.trim() : null
    return { terms, intent }
  } catch {
    return null
  }
}

export async function sendMessage(payload: AIChatSendRequest, options: SendMessageOptions = {}): Promise<AIChatTurnResult> {
  const recorder = maybeStartTrace({
    scenarioId: options.traceScenarioId ?? null,
    tag: 'sendMessage',
  })
  // Register this turn's AbortController under the
  // renderer's clientRequestId so ai:cancel-message can abort the in-flight
  // provider request. The signal rides an AsyncLocalStorage context down to
  // every executeTextAIJob call this turn makes.
  const cancelController = new AbortController()
  const cancelKey = payload.clientRequestId ?? null
  if (cancelKey) registerAICancellation(cancelKey, cancelController)
  try {
    // R1: count every provider call this turn makes (tool-loop roundtrips,
    // retries, prose pass) so we can keep the per-turn median low and prove it.
    const result = await runWithAbortSignal(cancelController.signal, () => withProviderCallCount(async (getProviderCallCount) => {
      const inner = await sendMessageInner(payload, options)
      const providerCalls = getProviderCallCount()
      if (process.env.NODE_ENV === 'development') {
        console.log(`[ai:chat] turn used ${providerCalls} provider call(s)`)
      }
      return { ...inner, providerCallCount: providerCalls }
    }))
    // SOFT voice guard (ai.md §5 voice). The answer has already streamed to the
    // user by now, so this only ever LOGS a banned phrase for voice monitoring —
    // it never throws and never rewrites the answer. A hard guard here would
    // crash a live chat over a single word already on screen.
    const answerText = result.assistantMessage?.content
    if (answerText) {
      const banned = findBannedVocab(answerText)
      if (banned) console.warn(`[ai:voice] banned vocabulary in chat answer: "${banned}"`)
      if (containsEmDash(answerText)) console.warn('[ai:voice] em dash in chat answer')
      const plumbing = findPlumbingVocab(answerText)
      if (plumbing) console.warn(`[ai:voice] plumbing vocabulary in chat answer: "${plumbing}"`)
    }
    if (recorder) {
      recorder.finish(result.assistantMessage?.content)
    }
    return result
  } catch (err) {
    // A user-initiated Stop is not a provider failure: nothing was persisted,
    // so surface a plain, recognizable cancellation instead of a branded error.
    if (cancelController.signal.aborted || isAbortError(err)) {
      // Pause and cancel both abort the provider stream, but they settle
      // differently (DEV-200): a pause persists the turn's checkpoint as a
      // resumable row (surviving app restart), while cancel stays what it
      // always was — the turn is discarded, checkpoint and all.
      if (consumePauseRequest(cancelKey)) {
        const checkpointId = lookupActiveTurnCheckpoint(cancelKey)
        let paused: AgentTurnCheckpointView | null = null
        if (checkpointId) {
          try {
            paused = markTurnPaused(getDb(), checkpointId, 'user')
          } catch (error) {
            console.warn('[agent:turn-state] pause checkpoint settle failed:', error)
          }
        }
        if (cancelKey && options.onPhaseEvent) {
          options.onPhaseEvent({ requestId: cancelKey, phase: 'paused', waitKind: null, checkpointId: paused?.id ?? null, pauseKind: 'user' })
        }
        const pausedErr = pausedError()
        if (recorder) recorder.finish(undefined, pausedErr.message)
        throw pausedErr
      }
      settleTurnCheckpointAfterAbandon(cancelKey, 'cancelled', options)
      const cancelled = abortError()
      if (recorder) recorder.finish(undefined, cancelled.message)
      throw cancelled
    }
    // A failed turn is not resumable state: the error card owns the retry of
    // the same question, so keeping a checkpoint would double-represent it.
    settleTurnCheckpointAfterAbandon(cancelKey, 'failed', options)
    const friendly = friendlyChatError(err)
    if (recorder) {
      recorder.finish(undefined, friendly.message)
    }
    throw friendly
  } finally {
    unregisterActiveTurnCheckpoint(cancelKey)
    if (cancelKey) unregisterAICancellation(cancelKey, cancelController)
    if (recorder) setCurrentTrace(null)
  }
}

// Terminal settle for an abandoned turn (cancel / failure): the checkpoint —
// if this turn ever opened one — is deleted, and the phase event says which
// terminal state the machine reached.
function settleTurnCheckpointAfterAbandon(
  cancelKey: string | null,
  phase: 'cancelled' | 'failed',
  options: SendMessageOptions,
): void {
  const checkpointId = lookupActiveTurnCheckpoint(cancelKey)
  if (checkpointId) {
    try {
      closeTurnCheckpoint(getDb(), checkpointId)
    } catch (error) {
      console.warn('[agent:turn-state] checkpoint close failed:', error)
    }
  }
  if (cancelKey && options.onPhaseEvent) {
    options.onPhaseEvent({ requestId: cancelKey, phase, waitKind: null, checkpointId: null, pauseKind: null })
  }
}

async function sendMessageInner(payload: AIChatSendRequest, options: SendMessageOptions = {}): Promise<AIChatTurnResult> {
  const userMessage = payload.message
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  let threadId = payload.threadId ?? null
  // A resume rejoins the thread its checkpoint belongs to (DEV-200) — the
  // renderer may resume from a draft view that never adopted the thread the
  // paused turn was persisted under, and creating a second thread here would
  // orphan the first.
  if (threadId == null && payload.resumeOfCheckpointId) {
    try {
      threadId = getTurnCheckpoint(db, payload.resumeOfCheckpointId)?.threadId ?? null
    } catch { /* fall through to normal thread resolution */ }
  }
  if (threadId == null) {
    // First send from a new-chat draft: adopt (or create) the draft thread and
    // title it from the message.
    threadId = threadForFirstMessage(userMessage)
  } else {
    // Ensure the referenced thread exists; if not, fall back to a fresh one.
    const existing = getThread(threadId)
    if (!existing) {
      threadId = threadForFirstMessage(userMessage)
    } else {
      maybeRenameWeakThread(threadId, existing.title, userMessage)
    }
  }
  const history = threadId == null
    ? getConversationMessages(db, conversationId)
    : getThreadMessages(db, threadId)
  const stream = createChatStreamAccumulator(payload.clientRequestId ?? null, options)

  if (process.env.NODE_ENV === 'development') {
    console.log(`[ai:chat] ← "${userMessage.slice(0, 120)}"`)
  }

  const prior = boundProviderHistory(sanitizeConversationHistory(history))

  const focusIntent = maybeHandleFocusIntent(userMessage)
  if (focusIntent) {
    await stream.streamText(focusIntent.assistantText)
    return persistChatTurn(db, conversationId, userMessage, focusIntent, threadId)
  }

  // Memory is an action attached to the turn, never the answer itself. The old
  // early return persisted the preview and stopped before answering the user.
  // Build the preview now, then carry it through the normal answer path so the
  // response always completes whether the user confirms, cancels, or ignores it.
  const memoryEnvelope = await maybeHandleMemoryInstruction(userMessage, sendWithProvider, prior)
  const withMemoryProposal = (envelope: AnswerEnvelope): AnswerEnvelope => {
    const proposals = memoryEnvelope?.actionWidgets ?? []
    return attachActionWidgets(envelope, proposals)
  }
  const persistTurn = (envelope: AnswerEnvelope) => (
    persistChatTurn(db, conversationId, userMessage, withMemoryProposal(envelope), threadId)
  )

  // "rename my afternoon block to networking" — preview the rename in a block
  // card; it commits only on confirm (ai-actions.md §5).
  const renameEnvelope = maybeHandleRenameInstruction(userMessage, null)
  if (renameEnvelope) {
    await stream.streamText(renameEnvelope.assistantText)
    return persistTurn(renameEnvelope)
  }

  // "merge my last two blocks" — preview the merge in a card; commits only on
  // confirm (ai-actions.md §5). Checked after rename so "rename" wins its verb.
  const mergeEnvelope = maybeHandleMergeInstruction(userMessage, null)
  if (mergeEnvelope) {
    await stream.streamText(mergeEnvelope.assistantText)
    return persistTurn(mergeEnvelope)
  }

  // ── The agent turn. Everything that is not a confirm-gated
  //    mutation goes through ONE loop: the model reads the conversation,
  //    calls read-only tools against the same store the Timeline reads,
  //    optionally asks the user one clarifying question, and streams the
  //    answer in the Daylens voice. The "Turn into…" dropdown becomes a plain
  //    instruction — the loop's history is the transform's source. ──────────
  const question = payload.transform
    ? `${transformInstruction(payload.transform)} Apply it to your previous answer in this conversation.`
    : userMessage

  const settings = getSettings()
  const threadSettings = getThreadSettings(threadId)
  const threadAvailability: Partial<Record<AIProviderMode, boolean>> = {}
  if (threadSettings.provider && threadSettings.model) {
    const tool = cliToolForProvider(threadSettings.provider)
    threadAvailability[threadSettings.provider] = tool
      ? Boolean((await detectCLITools())[tool])
      : Boolean(await getApiKey(threadSettings.provider))
  }
  const selection = resolveChatSelection({
    settings,
    thread: threadSettings,
    providerAvailability: threadAvailability,
  })
  const providerOverride = selection.source === 'thread' ? selection.provider : null
  const configs = await resolveProviderConfigsForJob('chat_answer', settings, providerOverride)
  let agentConfig = configs[0]
  if (selection.source === 'thread' && agentConfig.provider === selection.provider) {
    agentConfig = { ...agentConfig, model: selection.model }
  }

  // A CLI provider cannot make the structured tool calls this loop needs, but
  // the Claude CLI can run a loop of its own over the Daylens MCP server. That
  // branch is taken below, once the system prompt it needs has been built.
  const cliCannotDriveThisLoop = !providerSupportsAgentTools(agentConfig.provider, agentConfig.transport)
  const claudeCodeCanAnswer = cliCannotDriveThisLoop
    && agentConfig.provider === 'claude-cli'
    && claudeCodeChatAvailable()
  if (cliCannotDriveThisLoop && !claudeCodeCanAnswer) {
    const cliNotice = `Chat answers now come from a live agent over your real data, which needs an API provider — ${providerLabel(agentConfig.provider)} runs through a CLI and can't call tools. Pick an API provider in Settings → AI (or a per-chat model from the catalog) and ask me again.`
    await stream.streamText(cliNotice)
    return persistTurn({
      assistantText: cliNotice,
      answerKind: 'deterministic_stats',
      sourceKind: 'deterministic',
      conversationState: null,
      suggestedFollowUps: [],
    })
  }

  // D4 per-thread instructions + memory context (memory.md §4) ride the system
  // prompt. Context only — the hours still come from tool results.
  const threadInstructionBlock = threadSettings.instructions
    ? `The user set these additional instructions for this chat. Follow them unless they conflict with grounding or honesty:\n${threadSettings.instructions}`
    : null
  const memoryContextBlock = (() => {
    try {
      return chatMemoryPromptBlock(db, userMessage) || null
    } catch (error) {
      console.warn('[ai:chat] memory context failed:', error)
      return null
    }
  })()
  const pendingMemoryNote = memoryEnvelope
    ? 'A memory preview is shown separately for this turn. Respond naturally, but do not claim the memory has already been saved, and do not call propose_memory this turn — the preview already covers it.'
    : null
  const extraSystem = [threadInstructionBlock, memoryContextBlock, pendingMemoryNote]
    .filter(Boolean).join('\n\n') || null

  const firstSessionRow = db
    .prepare('SELECT MIN(start_time) as t FROM app_sessions')
    .get() as { t: number | null } | undefined
  const trackingStart = firstSessionRow?.t
    ? new Date(firstSessionRow.t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null

  // Chat on the local Claude Code, driving Daylens' own read-only MCP tools.
  // It gets the same voice contract and operating rules as the in-app agent,
  // so the answer is held to the same grounding and honesty; what it does not
  // get yet is citations, memory writes, or correction previews.
  if (claudeCodeCanAnswer) {
    const claudeTool = await resolveCLITool('claude')
    if (!claudeTool) {
      const missing = 'The Claude CLI is no longer on this machine, so chat has nothing to answer with. Reconnect it in Settings → AI.'
      await stream.streamText(missing)
      return persistTurn({
        assistantText: missing,
        answerKind: 'error',
        sourceKind: 'deterministic',
        conversationState: null,
        suggestedFollowUps: [],
      })
    }
    try {
      const text = await runClaudeCodeChat({
        threadId: String(threadId ?? 'new'),
        question,
        systemPrompt: buildAgentSystemPrompt({
          now: new Date(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          trackingStart,
          providerLabel: providerLabel(agentConfig.provider),
          model: agentConfig.model,
          homeDir: os.homedir(),
          extraSystem,
          summaryVoice: settings.summaryVoice,
        }),
        model: agentConfig.model,
        executablePath: claudeTool.executablePath,
        onDelta: (delta) => stream.push(delta),
        onStatus: (label) => { void stream.pushStatus(label) },
        signal: getAmbientAbortSignal(),
      })
      // Already on screen delta by delta; this only fills a gap if the CLI
      // returned a final result the stream never carried.
      await stream.streamText(text)
      return persistTurn({
        assistantText: text,
        answerKind: 'freeform_chat',
        sourceKind: 'freeform',
        conversationState: null,
        suggestedFollowUps: [],
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      // Never silently fall through to another provider (invariant 12): say
      // what failed and leave the person's choice of provider alone.
      const message = error instanceof Error ? error.message : String(error)
      const notice = `Your local Claude Code could not answer this one: ${message}`
      console.warn('[ai:chat] claude-code path failed:', error)
      await stream.streamText(notice)
      return persistTurn({
        assistantText: notice,
        answerKind: 'error',
        sourceKind: 'deterministic',
        conversationState: null,
        suggestedFollowUps: [],
      })
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(`[ai:chat] agent turn → provider=${agentConfig.provider} model=${agentConfig.model}`)
  }

  const requestId = payload.clientRequestId ?? null
  const startedAt = Date.now()

  // ── The turn's resumable checkpoint (DEV-200). Opened before the agent loop
  //    starts; a resume ADOPTS the paused row (paused → running) instead of
  //    opening a new one. The row is honest outstanding-work state, not
  //    provider session state: this resumed turn rebuilds its context packet
  //    from scratch inside runChatAgentTurn, so the answer reflects the day as
  //    it is NOW, exactly as the runtime spec prescribes. If the checkpoint
  //    the renderer asked to resume is already gone, the send proceeds as a
  //    fresh turn — the question still gets answered.
  let checkpoint: AgentTurnCheckpointView | null = null
  if (agentTurnCheckpointsAvailable(db)) {
    try {
      checkpoint = (payload.resumeOfCheckpointId
        ? adoptTurnCheckpointForResume(db, payload.resumeOfCheckpointId, { clientRequestId: requestId })
        : null)
        ?? openTurnCheckpoint(db, { threadId, clientRequestId: requestId, question: userMessage })
      if (requestId) registerActiveTurnCheckpoint(requestId, checkpoint.id)
    } catch (error) {
      console.warn('[agent:turn-state] checkpoint open failed; turn runs without pause persistence:', error)
      checkpoint = null
    }
  }
  const emitPhase = (
    phase: AIAgentTurnPhaseEvent['phase'],
    waitKind: AIAgentTurnPhaseEvent['waitKind'] = null,
  ) => {
    if (requestId && options.onPhaseEvent) {
      options.onPhaseEvent({ requestId, phase, waitKind, checkpointId: checkpoint?.id ?? null, pauseKind: null })
    }
  }
  emitPhase('running')

  let agentResult: Awaited<ReturnType<typeof runChatAgentTurn>>
  try {
    agentResult = await runChatAgentTurn(question, prior, {
      db,
      config: agentConfig,
      model: options.model,
      onStreamEvent: (event) => {
        // The last status line rides the checkpoint so a paused turn can say
        // what it was doing ("Paused while searching your timeline").
        if (checkpoint && event.status) {
          try {
            recordTurnStatus(db, checkpoint.id, event.status)
          } catch { /* display state only — never fail the turn over it */ }
        }
        if (requestId && options.onStreamEvent) {
          options.onStreamEvent({ requestId, delta: event.delta, snapshot: event.snapshot, status: event.status, step: event.step })
        }
      },
      // Agent-initiated waits and the user pause are ONE machine: the card
      // kinds report through here, persist on the checkpoint, and reach the
      // renderer as the same phase events a pause does.
      onPhase: (event) => {
        if (checkpoint) {
          try {
            if (event.phase === 'awaiting_user' && event.waitKind) markTurnWaiting(db, checkpoint.id, event.waitKind)
            else if (event.phase === 'running') markTurnRunning(db, checkpoint.id)
          } catch { /* display state only */ }
        }
        emitPhase(event.phase, event.waitKind)
      },
      askUser: options.onAgentQuestion
        ?? (async () => '(No answer is available right now — pick the most defensible reading, answer it, and say in one clause what you assumed.)'),
      artifactDir: agentArtifactDir(),
      mcpServers: settings.mcpServers ?? [],
      extraSystem,
      summaryVoice: settings.summaryVoice,
      signal: getAmbientAbortSignal() ?? undefined,
      trackingStart,
      threadId,
      // Agent-applied corrections (DEV-199) behave exactly like Settings-
      // applied ones: same live-session resolution, same pre-merge session
      // flush, same projection invalidation — one corrections machinery.
      corrections: {
        resolveLiveSession: (date) => {
          const live = getCurrentSession()
          if (!live) return null
          const [fromMs, toMs] = localDayBounds(date)
          return Date.now() <= fromMs || live.startTime >= toMs ? null : live
        },
        onBeforeApply: (command) => {
          if (command.kind === 'merge') flushCurrentSession()
        },
        onApplied: (date) => {
          invalidateProjectionScope('timeline', 'correction_command', { date })
          invalidateProjectionScope('apps', 'correction_command', { date })
          invalidateProjectionScope('insights', 'correction_command', { date })
        },
      },
    })
  } catch (error) {
    if (!isAbortError(error)) {
      recordChatAgentUsage({
        config: agentConfig,
        usage: null,
        startedAt,
        success: false,
        failureReason: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
  recordChatAgentUsage({ config: agentConfig, usage: agentResult.usage, startedAt, success: true })

  // Don't save an empty assistant response — it would corrupt future prior
  // history and cause the AI to receive empty content blocks.
  if (!agentResult.text.trim()) {
    throw new Error('The AI returned an empty response. Please try again.')
  }

  const answerKind: AIAnswerKind = 'freeform_chat'
  const suggestedFollowUps = await generateSuggestedFollowUps(userMessage, agentResult.text, answerKind, null)
  const turnResult = await persistTurn({
    assistantText: agentResult.text,
    answerKind,
    sourceKind: 'freeform',
    conversationState: null,
    suggestedFollowUps,
    artifacts: agentResult.artifacts,
    agent: {
      toolTrace: agentResult.toolTrace,
      stepCount: agentResult.stepCount,
      groundingRetried: agentResult.groundingRetried,
      fileDisclosures: agentResult.fileDisclosures,
      contextPacketId: agentResult.contextPacketId,
      citations: agentResult.citations,
    },
  })
  // Bind the recorded packet to the persisted assistant message (DEV-182), so
  // "what did the model see for THIS answer" stays a single lookup. The packet
  // row itself was written before the request left the device.
  if (agentResult.contextPacketId) {
    try {
      linkContextPacketToMessage(db, agentResult.contextPacketId, turnResult.assistantMessage.id)
    } catch (error) {
      console.warn('[ai:chat] context packet message binding failed:', error)
    }
  }
  // The turn completed and the transcript owns it now — the checkpoint (fresh
  // or adopted through a resume) leaves the outstanding-work ledger.
  if (checkpoint) {
    try {
      closeTurnCheckpoint(db, checkpoint.id)
    } catch (error) {
      console.warn('[agent:turn-state] checkpoint close failed:', error)
    }
    unregisterActiveTurnCheckpoint(requestId)
  }
  emitPhase('completed')
  return turnResult
}

export async function prepareDailyReport(dateStr = currentLocalDateString()): Promise<AIDailyReportPreparationResult> {
  try {
    const bundle = buildDayReportBundle(dateStr)
    if (!bundle) {
      return {
        date: dateStr,
        threadId: null,
        artifactId: null,
        prepared: false,
        status: 'no_activity',
      }
    }

    const thread = createThread(`Day report ${dateStr}`)
    await sendMessage({
      message: dateStr === currentLocalDateString()
        ? 'Draft a report for today.'
        : `Draft a report for ${dateStr}.`,
      threadId: thread.id,
    })

    let artifactId: number | null = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reportArtifact = listArtifactsByThread(thread.id)
        .find((artifact) => {
          if (artifact.kind !== 'report' && artifact.kind !== 'markdown') return false
          const source = typeof artifact.meta?.source === 'string' ? artifact.meta.source : ''
          if (source === 'debug_evidence') return false
          return true
        })
      if (reportArtifact) {
        artifactId = reportArtifact.id
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    return {
      date: dateStr,
      threadId: thread.id,
      artifactId,
      prepared: artifactId != null,
      status: artifactId != null ? 'ready' : 'failed',
      error: artifactId == null ? 'No user-facing report artifact was created.' : undefined,
    }
  } catch (error) {
    console.warn(`[ai] failed to prepare daily report for ${dateStr}:`, error)
    return {
      date: dateStr,
      threadId: null,
      artifactId: null,
      prepared: false,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function getWeekReview(
  weekStartStr: string,
  force = false,
): Promise<AISurfaceSummary | null> {
  if (force) return generateWeekReview(weekStartStr, true)

  const bundle = buildWeekReviewBundle(weekStartStr)
  if (!bundle) return null
  const scopeKey = `week:${weekStartStr}`
  const { weekStart, weekEnd } = buildWeekDateRange(weekStartStr)
  const [memoryFromMs] = localDateBoundsFromString(weekStart)
  const [, memoryToMs] = localDateBoundsFromString(weekEnd)
  const memoryPrompt = buildDaylensMemoryPromptBlock({ fromMs: memoryFromMs, toMs: memoryToMs })
  const voice = normalizeSummaryVoice(getSettings().summaryVoice)
  const inputSignature = hashText([bundle.assistantScaffold, memoryPrompt, voice].join('\n'))
  const existingSignature = getAISurfaceSummarySignature(getDb(), 'timeline_week', scopeKey)
  if (existingSignature === inputSignature) {
    return getAISurfaceSummary(getDb(), 'timeline_week', scopeKey)
  }
  // Evidence or tone moved: surface the stored card as stale rather than
  // spending a provider call on a read, and rather than pretending the old
  // voice is current.
  return getAISurfaceSummary(getDb(), 'timeline_week', scopeKey, { stale: true })
}

export async function getAppNarrative(
  canonicalAppId: string,
  daysOrDate: number | string = 7,
  force = false,
): Promise<AISurfaceSummary | null> {
  if (force) return generateAppNarrative(canonicalAppId, daysOrDate, true)

  const detail = getAppDetailPayload(getDb(), canonicalAppId, daysOrDate, getCurrentSession())
  const scopeKey = appNarrativeScopeKey(detail.canonicalAppId, detail.rangeKey)
  const isDate = typeof daysOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(daysOrDate)
  const days = isDate ? 1 : Math.max(1, Number(daysOrDate) || 7)
  const [memoryFromMs, memoryToMs] = isDate
    ? localDateBoundsFromString(daysOrDate)
    : (() => {
      const [, todayToMs] = dayBounds(new Date())
      if (days >= ALL_TIME_DAYS) return [0, todayToMs] as const
      const end = new Date(todayToMs)
      const fromMs = new Date(
        end.getFullYear(),
        end.getMonth(),
        end.getDate() - days,
      ).getTime()
      return [fromMs, todayToMs] as const
    })()
  const memoryPrompt = buildDaylensMemoryPromptBlock({
    fromMs: memoryFromMs,
    toMs: memoryToMs,
  })
  const voice = normalizeSummaryVoice(getSettings().summaryVoice)
  const inputSignature = hashText([appNarrativeSignature(detail), memoryPrompt, voice].join('\n'))
  const existingSignature = getAISurfaceSummarySignature(getDb(), 'app_detail', scopeKey)
  if (existingSignature === inputSignature) {
    const existing = getAISurfaceSummary(getDb(), 'app_detail', scopeKey)
    if (!appNarrativeHasStaleMetrics(existing)) return existing
  }
  return getAISurfaceSummary(getDb(), 'app_detail', scopeKey, { stale: true })
}

export async function testCLITool(tool: CLITool): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const expectedToken = `DAYLENS_OK_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    const output = await runCLIProvider(
      tool,
      `System context:\nYou are a test runner. Reply with exactly ${expectedToken} and nothing else.\n\nUser: Reply with exactly ${expectedToken} and nothing else.`,
    )
    const normalizedOutput = output.trim()
    if (normalizedOutput !== expectedToken) {
      return {
        ok: false,
        error: `Unexpected CLI output: ${normalizedOutput.slice(0, 120) || '(empty response)'}`,
      }
    }
    return { ok: true, output: normalizedOutput }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Hook wrappedNarrative into the shared provider sender so it can run through
// the same execution path (provider fallback, usage logging, prompt caching).
registerWrappedNarrativeProvider(sendWithProvider)
registerWrappedPeriodNarrativeProvider(sendWithProvider)
registerWrappedQuestionProvider(sendWithProvider)
