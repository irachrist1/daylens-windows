// AI service — runs in the main process only and routes to the selected provider.
// Renderer communicates via IPC (never direct SDK access)
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI, type Content as GoogleContent } from '@google/genai'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  appendConversationMessage,
  clearConversation,
  getAISurfaceSummary,
  getAISurfaceSummarySignature,
  getConversationMessages,
  getConversationState,
  getOrCreateConversation,
  getThreadMessages,
  getActiveFocusSession,
  getAppSummariesForRange,
  getDistractionCountForSession,
  getPeakHours,
  getSessionsForRange,
  getWebsiteSummariesForRange,
  listPendingWorkContextCleanupDates,
  getRecentFocusSessions,
  getCategoryOverrides,
  upsertAISurfaceSummary,
  upsertConversationState,
  upsertWorkContextCleanupReview,
  upsertWorkContextInsight,
} from '../db/queries'
import { routeInsightsQuestion, type EntityContext, type TemporalContext } from '../lib/insightsQueryRouter'
import { resolveFollowUp } from '../lib/followUpResolver'
import {
  buildDeterministicFollowUpCandidates,
  buildFollowUpSuggestionPrompts,
  parseFollowUpSuggestions,
} from '../lib/followUpSuggestions'
import { fillDaySummaryQuestionSuggestions } from '../lib/daySummarySuggestions'
import { deriveWorkEvidenceSummary } from '../lib/workEvidence'
import { buildAssistantEvidencePack } from '../core/query/assistantEvidence'
import {
  findClientByName,
  findProjectByName,
  listClients,
  listProjects,
  resolveClientQuery,
  resolveDayContext,
  resolveProjectQuery,
} from '../core/query/attributionResolvers'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import { deriveTitleFromMessage, isWeakThreadTitle, type ThreadTitleContext } from '../lib/threadTitles'
import { getDb } from './database'
import {
  createArtifact,
  createThread,
  getThread,
  renameThread,
  touchThreadLastMessage,
} from './artifacts'
import { capture } from './analytics'
import { ANALYTICS_EVENT, classifyFailureKind } from '@shared/analytics'
import { getSettings, hasApiKey } from './settings'
import { computeEnhancedFocusScore } from '../lib/focusScore'
import { getCurrentSession } from './tracking'
import type {
  AIArtifactKind,
  AIChatSendRequest,
  AIChatStreamEvent,
  AIMessageArtifact,
  AIMessageAction,
  AIAnswerKind,
  AIChatTurnResult,
  AIConversationDateRange,
  AIConversationSourceKind,
  AIConversationState,
  AIEntityStateSnapshot,
  AIRoutingContextSnapshot,
  AIDaySummaryResult,
  AISurfaceSummary,
  AIThreadMessage,
  AIThreadMessageMetadata,
  AIWeeklyBriefStateSnapshot,
  AppCategorySuggestion,
  DayTimelinePayload,
  FollowUpSuggestion,
  FocusSession,
  FocusStartPayload,
  LiveSession,
  WorkContextBlock,
  WorkContextInsight,
} from '@shared/types'
import {
  executeTextAIJob,
  modelForProvider,
  providerLabel,
  type AITextJobExecutionOptions,
  type ProviderTextResponse,
  type ResolvedProviderConfig,
} from './aiOrchestration'
import { buildAnthropicPromptInput } from './anthropicPromptCaching'
import {
  backgroundRelabelDispositionForBlock,
  fallbackNarrativeForBlock,
  getAppDetailPayload,
  getTimelineDayPayload,
  getWorkflowSummaries,
  userVisibleLabelForBlock,
} from './workBlocks'
import {
  buildWeeklyBriefEvidencePack,
  buildWeeklyBriefScaffold,
  type WeeklyBriefContext,
  type WeeklyBriefEvidencePack,
} from '../lib/weeklyBrief'
import { buildCLIProcessPayload, buildCLIProcessSpec } from './cliLaunch'
import { inferWorkIntent } from '../../shared/workIntent'

const GOOGLE_CLIENT_HEADER = 'daylens-windows/1.0.0'
const BLOCK_INSIGHT_TIMEOUT_MS = 12_000

type ConversationMessage = { role: 'user' | 'assistant'; content: string }

interface AnswerEnvelope {
  assistantText: string
  answerKind: AIAnswerKind
  sourceKind: AIConversationSourceKind
  resolvedTemporalContext: TemporalContext | null
  conversationState: AIConversationState | null
  suggestedFollowUps: FollowUpSuggestion[]
  actions?: AIMessageAction[]
  artifacts?: AIMessageArtifact[]
}

interface SendMessageOptions {
  onStreamEvent?: (event: AIChatStreamEvent) => void
}

type RequestedOutputKind = 'report' | 'table' | 'chart' | 'export'

interface ReportArtifactSpec {
  kind: AIMessageArtifact['kind']
  title: string
  format: AIMessageArtifact['format']
  contents: string
  subtitle?: string | null
  extension: string
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
}

type DirectReportEntity =
  | { entityType: 'client'; id: string; name: string }
  | { entityType: 'project'; id: string; name: string }

interface CLIToolDetectionResult {
  claude: string | null
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
const conversationTemporalContext = new Map<number, TemporalContext | null>()
const weeklyBriefCache = new Map<string, WeeklyBriefEvidencePack>()
const daySummaryCache = new Map<string, AIDaySummaryResult>()
const cliToolCache: Partial<Record<'claude' | 'codex', Promise<ResolvedCLITool | null>>> = {}
const STREAM_CHUNK_DELAY_MS = 12
const STREAM_CHUNK_SIZE = 32

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
        resolvedTemporalContext: null,
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
      resolvedTemporalContext: null,
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
        resolvedTemporalContext: null,
        conversationState: null,
        suggestedFollowUps: [],
      }
    }

    return {
      assistantText: `Your current focus session has been running for ${formatFocusDuration(focusSessionDurationSeconds(activeFocusSession))}${activeFocusSession.label ? ` on ${activeFocusSession.label}` : ''}. Use the button below when you want to stop it.`,
      answerKind: 'deterministic_stats',
      sourceKind: 'deterministic',
      resolvedTemporalContext: null,
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
        resolvedTemporalContext: null,
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
        resolvedTemporalContext: null,
        conversationState: null,
        suggestedFollowUps: [],
      }
    }

    const distractionCount = getDistractionCountForSession(db, recentCompleted.id)
    return {
      assistantText: `Your most recent focus session lasted ${formatFocusDuration(recentCompleted.durationSeconds)}${recentCompleted.label ? ` on ${recentCompleted.label}` : ''}.${distractionCount > 0 ? ` Daylens noticed ${distractionCount} distraction alert${distractionCount === 1 ? '' : 's'} during it.` : ''} Add a short review below and Daylens will keep it with the session.`,
      answerKind: 'deterministic_stats',
      sourceKind: 'deterministic',
      resolvedTemporalContext: null,
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

function toAIConversationDateRange(
  range: { fromMs: number; toMs: number; label: string } | null | undefined,
): AIConversationDateRange | null {
  if (!range) return null
  return {
    fromMs: range.fromMs,
    toMs: range.toMs,
    label: range.label,
  }
}

function serializeWeeklyBriefContext(weeklyBrief: WeeklyBriefContext | null): AIWeeklyBriefStateSnapshot | null {
  if (!weeklyBrief) return null
  return {
    intent: weeklyBrief.intent,
    responseMode: weeklyBrief.responseMode,
    topic: weeklyBrief.topic,
    dateRange: {
      fromMs: weeklyBrief.dateRange.fromMs,
      toMs: weeklyBrief.dateRange.toMs,
      label: weeklyBrief.dateRange.label,
    },
    evidenceKey: weeklyBrief.evidenceKey,
  }
}

function deserializeWeeklyBriefContext(snapshot: AIWeeklyBriefStateSnapshot | null): WeeklyBriefContext | null {
  if (!snapshot) return null
  return {
    intent: snapshot.intent as WeeklyBriefContext['intent'],
    responseMode: snapshot.responseMode as WeeklyBriefContext['responseMode'],
    topic: snapshot.topic,
    dateRange: {
      fromMs: snapshot.dateRange.fromMs,
      toMs: snapshot.dateRange.toMs,
      label: snapshot.dateRange.label,
      startDate: new Date(snapshot.dateRange.fromMs).toISOString().slice(0, 10),
      endDate: new Date(snapshot.dateRange.toMs - 1).toISOString().slice(0, 10),
    },
    evidenceKey: snapshot.evidenceKey,
  }
}

function serializeEntityContext(entity: TemporalContext['entity']): AIEntityStateSnapshot | null {
  if (!entity) return null
  return {
    entityId: entity.entityId,
    entityName: entity.entityName,
    entityType: entity.entityType,
    rangeStartMs: entity.rangeStartMs,
    rangeEndMs: entity.rangeEndMs,
    rangeLabel: entity.rangeLabel,
    intent: entity.intent,
  }
}

function deserializeEntityContext(snapshot: AIEntityStateSnapshot | null): EntityContext | null {
  if (!snapshot) return null
  return {
    entityId: snapshot.entityId,
    entityName: snapshot.entityName,
    entityType: snapshot.entityType,
    rangeStartMs: snapshot.rangeStartMs,
    rangeEndMs: snapshot.rangeEndMs,
    rangeLabel: snapshot.rangeLabel,
    intent: snapshot.intent as EntityContext['intent'],
  }
}

function serializeTemporalContext(context: TemporalContext | null): AIRoutingContextSnapshot | null {
  if (!context) return null
  return {
    dateMs: context.date.getTime(),
    timeWindowStartMs: context.timeWindow?.start.getTime() ?? null,
    timeWindowEndMs: context.timeWindow?.end.getTime() ?? null,
    weeklyBrief: serializeWeeklyBriefContext(context.weeklyBrief),
    entity: serializeEntityContext(context.entity),
  }
}

function deserializeTemporalContext(snapshot: AIRoutingContextSnapshot | null): TemporalContext | null {
  if (!snapshot) return null
  return {
    date: new Date(snapshot.dateMs),
    timeWindow: snapshot.timeWindowStartMs !== null && snapshot.timeWindowEndMs !== null
      ? {
        start: new Date(snapshot.timeWindowStartMs),
        end: new Date(snapshot.timeWindowEndMs),
      }
      : null,
    weeklyBrief: deserializeWeeklyBriefContext(snapshot.weeklyBrief),
    entity: deserializeEntityContext(snapshot.entity),
  }
}

function buildConversationState(
  answerKind: AIAnswerKind,
  sourceKind: AIConversationSourceKind,
  resolvedTemporalContext: TemporalContext | null,
  followUpAffordances: AIConversationState['followUpAffordances'],
  extras?: {
    topic?: string | null
    responseMode?: string | null
    lastIntent?: string | null
    evidenceKey?: string | null
    dateRange?: AIConversationDateRange | null
  },
): AIConversationState {
  return {
    dateRange: extras?.dateRange ?? toAIConversationDateRange(resolvedTemporalContext?.weeklyBrief?.dateRange ?? null),
    topic: extras?.topic ?? resolvedTemporalContext?.weeklyBrief?.topic ?? null,
    responseMode: extras?.responseMode ?? resolvedTemporalContext?.weeklyBrief?.responseMode ?? null,
    lastIntent: extras?.lastIntent ?? resolvedTemporalContext?.weeklyBrief?.intent ?? null,
    evidenceKey: extras?.evidenceKey ?? resolvedTemporalContext?.weeklyBrief?.evidenceKey ?? null,
    answerKind,
    sourceKind,
    followUpAffordances,
    routingContext: serializeTemporalContext(resolvedTemporalContext),
  }
}

function inferDateRangeFromQuestion(
  question: string,
  fallback: AIConversationDateRange | null,
): AIConversationDateRange | null {
  const normalized = question.toLowerCase()
  const now = new Date()
  if (normalized.includes('this week') || normalized.includes('last week')) {
    const endInclusive = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const start = new Date(endInclusive)
    start.setDate(start.getDate() - 6)
    const endExclusive = new Date(endInclusive)
    endExclusive.setDate(endExclusive.getDate() + 1)
    return {
      fromMs: start.getTime(),
      toMs: endExclusive.getTime(),
      label: normalized.includes('last week') ? 'last week' : 'this week',
    }
  }
  if (normalized.includes('yesterday')) {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const start = new Date(end)
    start.setDate(start.getDate() - 1)
    return {
      fromMs: start.getTime(),
      toMs: end.getTime(),
      label: 'yesterday',
    }
  }
  if (normalized.includes('today')) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return {
      fromMs: start.getTime(),
      toMs: end.getTime(),
      label: 'today',
    }
  }
  return fallback
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

function cliBinaryCandidates(tool: 'claude' | 'codex'): string[] {
  const appData = process.env.APPDATA
  const userProfile = process.env.USERPROFILE
  return [
    appData ? path.join(appData, 'npm', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, 'AppData', 'Roaming', 'npm', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.local', 'bin', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.volta', 'bin', `${tool}.cmd`) : null,
    userProfile ? path.join(userProfile, '.npm-global', 'bin', `${tool}.cmd`) : null,
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

async function findCLIToolPath(tool: 'claude' | 'codex'): Promise<string | null> {
  for (const candidate of cliBinaryCandidates(tool)) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }

  return new Promise((resolve) => {
    const child = spawn('where.exe', [tool], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

async function resolveCLITool(tool: 'claude' | 'codex'): Promise<ResolvedCLITool | null> {
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

async function resolveCLIToolPath(tool: 'claude' | 'codex'): Promise<string | null> {
  const resolved = await resolveCLITool(tool)
  return resolved?.executablePath ?? null
}

export async function detectCLITools(): Promise<CLIToolDetectionResult> {
  const [claude, codex] = await Promise.all([
    resolveCLIToolPath('claude'),
    resolveCLIToolPath('codex'),
  ])
  return { claude, codex }
}

function openAIInputFromHistory(messages: ConversationMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

function googleHistoryFromMessages(messages: ConversationMessage[]): GoogleContent[] {
  // Google requires strictly alternating user/model roles.
  // Strip consecutive same-role messages, keeping only the last one in each run
  // so corrupted histories (e.g. from a prior failed request) don't break the call.
  const filtered: ConversationMessage[] = []
  for (const message of messages) {
    const last = filtered[filtered.length - 1]
    if (last && last.role === message.role) {
      filtered[filtered.length - 1] = message
    } else {
      filtered.push(message)
    }
  }
  return filtered.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }))
}

async function sendWithAnthropic(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  const client = new Anthropic({ apiKey: config.apiKey ?? '' })
  const promptInput = buildAnthropicPromptInput(systemPrompt, prior, userMessage, options)
  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 1024,
    ...promptInput,
  })
  stream.on('text', (delta) => {
    void options?.onDelta?.(delta)
  })
  const response = await stream.finalMessage()

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

async function sendWithOpenAI(
  config: ResolvedProviderConfig,
  systemPrompt: string,
  prior: ConversationMessage[],
  userMessage: string,
  options?: AITextJobExecutionOptions,
): Promise<ProviderTextResponse> {
  const client = new OpenAI({ apiKey: config.apiKey ?? '' })
  const responseStream = await client.responses.create({
    model: config.model,
    instructions: systemPrompt,
    input: openAIInputFromHistory([
      ...prior,
      { role: 'user', content: userMessage },
    ]),
    max_output_tokens: 1024,
    store: false,
    stream: true,
  })
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
    },
    history: googleHistoryFromMessages(prior),
  })

  const response = await chat.sendMessageStream({ message: userMessage })
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
  tool: 'claude' | 'codex',
  prompt: string,
  model?: string,
): Promise<string> {
  const resolvedTool = await resolveCLITool(tool)
  if (!resolvedTool) {
    throw new CLIProviderError('not_found', `${tool} CLI not found`)
  }
  const { executablePath, codexExecCapabilities } = resolvedTool

  const tmpFilePath = path.join(os.tmpdir(), `daylens-${tool}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const args = tool === 'claude'
    ? ['-p', '--output-format', 'text', ...(model ? ['--model', model] : []), prompt]
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

  try {
    const output = await new Promise<string>((resolve, reject) => {
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
  switch (config.provider) {
    case 'claude-cli':
    case 'codex-cli': {
      const existingCLIPrompt = [
        prior.length > 0
          ? `Conversation so far:\n${prior.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n\n')}`
          : null,
        `User: ${userMessage}`,
      ].filter(Boolean).join('\n\n')
      const cliPrompt = `System context:\n${systemPrompt}\n\n${existingCLIPrompt}`
      const text = await runCLIProvider(config.provider === 'claude-cli' ? 'claude' : 'codex', cliPrompt, config.model)
      await emitTextDeltas(text, options?.onDelta)
      return {
        text,
        usage: null,
      }
    }
    case 'openai':
      return sendWithOpenAI(config, systemPrompt, prior, userMessage, options)
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
  return [from, from + 86_400_000]
}

function countSwitches(sessions: { bundleId: string }[]): number {
  let switches = 0
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].bundleId !== sessions[i - 1].bundleId) {
      switches++
    }
  }
  return switches
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTimeLabel(ms: number): string {
  return `${formatShortDate(ms)} at ${formatClock(ms)}`
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function localDateKeyForMs(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function detectRequestedOutputKinds(question: string): RequestedOutputKind[] {
  const normalized = question.toLowerCase()
  const kinds = new Set<RequestedOutputKind>()

  if (/\bcsv\b|\btable\b|\bspreadsheet\b|\bline items\b/.test(normalized)) {
    kinds.add('table')
  }
  if (/\bchart\b|\bgraph\b|\bplot\b/.test(normalized)) {
    kinds.add('chart')
  }
  if (
    /\breport\b/.test(normalized)
    || /short report i could share/.test(normalized)
    || /something i can send/.test(normalized)
    || /shareable/.test(normalized)
  ) {
    kinds.add('report')
  }
  if (/\bexport\b|\bdownload\b/.test(normalized)) {
    kinds.add('export')
  }

  if (kinds.has('export') && !kinds.has('report') && !kinds.has('table') && !kinds.has('chart')) {
    kinds.add('report')
  }

  return [...kinds]
}

function sanitizeFileStem(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.slice(0, 80) || 'daylens-report'
}

function csvCell(value: string | number): string {
  const raw = String(value ?? '')
  if (!/[",\n]/.test(raw)) return raw
  return `"${raw.replace(/"/g, '""')}"`
}

function buildCsvContent(columns: string[], rows: Array<Record<string, string | number>>): string {
  const header = columns.map(csvCell).join(',')
  const body = rows.map((row) => columns.map((column) => csvCell(row[column] ?? '')).join(','))
  return [header, ...body].join('\n')
}

function buildBarChartHtml(
  title: string,
  subtitle: string,
  valueLabel: string,
  rows: Array<{ label: string; value: number; secondaryValue?: number | null }>,
): string {
  const maxValue = Math.max(1, ...rows.map((row) => row.value))
  const safeRows = rows.slice(0, 12).map((row) => {
    const value = Math.max(0, Number(row.value) || 0)
    const secondaryValue = row.secondaryValue == null ? null : Math.max(0, Number(row.secondaryValue) || 0)
    return {
      label: row.label,
      value,
      secondaryValue,
      widthPct: Math.max(6, Math.round((value / maxValue) * 100)),
      secondaryPct: secondaryValue == null ? null : Math.max(4, Math.round((secondaryValue / maxValue) * 100)),
    }
  })

  const rowMarkup = safeRows.map((row) => `
    <div class="row">
      <div class="label">${row.label}</div>
      <div class="bar-wrap">
        <div class="bar primary" style="width:${row.widthPct}%"></div>
        ${row.secondaryPct == null ? '' : `<div class="bar secondary" style="width:${row.secondaryPct}%"></div>`}
      </div>
      <div class="value">${row.value.toFixed(1)} ${valueLabel}</div>
    </div>
  `).join('\n')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f7f4;
        --surface: #ffffff;
        --text: #171717;
        --muted: #5f5f55;
        --primary: #275efe;
        --secondary: #5ac8a8;
        --border: rgba(23, 23, 23, 0.08);
      }
      body {
        margin: 0;
        font-family: "Segoe UI", "SF Pro Text", "Helvetica Neue", sans-serif;
        background: linear-gradient(180deg, #f9f8f2 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 900px;
        margin: 0 auto;
        padding: 32px 24px 40px;
      }
      h1 {
        margin: 0 0 6px;
        font-size: 28px;
        line-height: 1.1;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .chart {
        margin-top: 24px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px 18px 8px;
        box-shadow: 0 20px 40px rgba(23, 23, 23, 0.06);
      }
      .row {
        display: grid;
        grid-template-columns: 150px minmax(0, 1fr) 90px;
        gap: 14px;
        align-items: center;
        margin-bottom: 14px;
      }
      .label, .value {
        font-size: 13px;
      }
      .bar-wrap {
        position: relative;
        height: 22px;
        border-radius: 999px;
        background: #eceae0;
        overflow: hidden;
      }
      .bar {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        border-radius: 999px;
      }
      .primary {
        background: linear-gradient(90deg, #4b7aff 0%, var(--primary) 100%);
      }
      .secondary {
        background: rgba(90, 200, 168, 0.72);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${subtitle}</p>
      <section class="chart">
        ${rowMarkup || '<p>No chartable data was available for this request.</p>'}
      </section>
    </main>
  </body>
</html>`
}

async function ensureGeneratedReportsDir(): Promise<string> {
  const baseDir = app?.getPath?.('userData') ?? os.tmpdir()
  const reportDir = path.join(baseDir, 'generated-reports')
  await fs.mkdir(reportDir, { recursive: true })
  return reportDir
}

async function writeGeneratedArtifacts(
  title: string,
  artifacts: ReportArtifactSpec[],
): Promise<AIMessageArtifact[]> {
  const outputDir = await ensureGeneratedReportsDir()
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')
  const stem = sanitizeFileStem(title)
  const written: AIMessageArtifact[] = []

  for (const artifact of artifacts) {
    const fileName = `${stamp}-${stem}-${sanitizeFileStem(artifact.title)}.${artifact.extension}`
    const filePath = path.join(outputDir, fileName)
    await fs.writeFile(filePath, artifact.contents, 'utf8')
    written.push({
      id: `${stamp}:${artifact.kind}:${artifact.format}:${artifact.title}`,
      kind: artifact.kind,
      title: artifact.title,
      subtitle: artifact.subtitle ?? null,
      format: artifact.format,
      path: filePath,
      openTarget: { kind: 'local_path', value: filePath },
      createdAt: Date.now(),
    })
  }

  return written
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

function parseGeneratedReportResult(
  raw: string,
  fallbackTitle: string,
): { assistantResponse: string; reportTitle: string; reportMarkdown: string } | null {
  const normalized = escapeJsonBlock(raw)
  if (!normalized) return null

  try {
    const parsed = JSON.parse(normalized) as {
      assistantResponse?: unknown
      reportTitle?: unknown
      reportMarkdown?: unknown
    }
    const assistantResponse = typeof parsed.assistantResponse === 'string' ? parsed.assistantResponse.trim() : ''
    const reportMarkdown = typeof parsed.reportMarkdown === 'string' ? parsed.reportMarkdown.trim() : ''
    const reportTitle = typeof parsed.reportTitle === 'string' && parsed.reportTitle.trim()
      ? parsed.reportTitle.trim()
      : fallbackTitle
    const effectiveBody = reportMarkdown || assistantResponse
    if (!effectiveBody) return null
    return {
      assistantResponse: assistantResponse || `I generated ${reportTitle}.`,
      reportTitle,
      reportMarkdown: effectiveBody,
    }
  } catch {
    return null
  }
}

function uniqueAppNames(names: string[]): string[] {
  return names.filter((name, index) => names.indexOf(name) === index)
}

function sessionEndMs(session: { startTime: number; endTime: number | null; durationSeconds: number }): number {
  return session.endTime ?? (session.startTime + session.durationSeconds * 1000)
}

function buildTodayBlocksContext(): string {
  try {
    const db = getDb()
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const dateStr = `${year}-${month}-${day}`
    const payload = getTimelineDayPayload(db, dateStr, null)

    // Only non-trivial blocks (>= 3 min). If nothing non-trivial, still show a short line.
    const blocks = payload.blocks.filter((b) => b.endTime - b.startTime >= 3 * 60_000)
    if (blocks.length === 0) return ''

    const lines = blocks.slice(0, 12).map((block) => {
      const minutes = Math.max(1, Math.round((block.endTime - block.startTime) / 60_000))
      const label = userVisibleLabelForBlock(block)
      const intent = inferWorkIntent(block)
      const timeRange = `${formatClock(block.startTime)}-${formatClock(block.endTime)}`
      const topApps = block.topApps
        .filter((app) => app.category !== 'system')
        .slice(0, 3)
        .map((app) => app.appName)
      const topSites = block.websites
        .slice(0, 3)
        .map((site) => site.domain.replace(/^www\./, ''))
      const keyPage = block.keyPages.find((t) => t.trim().length > 0)

      const artifacts = block.topArtifacts
        .slice(0, 4)
        .map((a) => a.displayTitle.trim())
        .filter(Boolean)

      const parts = [
        `${timeRange} (${minutes}m) — ${label}`,
        `intent: ${intent.summary}`,
      ]
      if (topApps.length > 0) parts.push(`apps: ${topApps.join(', ')}`)
      if (topSites.length > 0) parts.push(`sites: ${topSites.join(', ')}`)
      if (artifacts.length > 0) parts.push(`artifacts: ${artifacts.join(', ')}`)
      else if (keyPage) parts.push(`key: ${keyPage.slice(0, 80)}`)
      if (block.label.override) parts.push(`user labeled: ${block.label.override}`)
      return `- ${parts.join(' • ')}`
    })

    return ['Today\'s work blocks (chronological):', ...lines].join('\n')
  } catch {
    return ''
  }
}

function buildWorkflowsContext(): string {
  try {
    const db = getDb()
    const workflows = getWorkflowSummaries(db, 14)
    const meaningful = workflows.filter((w) => w.occurrenceCount >= 2).slice(0, 6)
    if (meaningful.length === 0) return ''

    const lines = meaningful.map((w) => {
      const apps = w.canonicalApps.slice(0, 4).join(' + ')
      return `- "${w.label}" (${w.dominantCategory}): ${w.occurrenceCount}× in last 14 days${apps ? ` — ${apps}` : ''}`
    })
    return ['Recurring workflows (last 14 days):', ...lines].join('\n')
  } catch {
    return ''
  }
}

function buildHourlyShapeContext(sessions: { startTime: number; durationSeconds: number; category: string }[]): string {
  if (sessions.length === 0) return ''
  // Build a coarse morning / midday / afternoon / evening profile from today's sessions.
  const buckets: Record<string, Map<string, number>> = {
    morning: new Map(),   // 5-11
    midday: new Map(),    // 11-14
    afternoon: new Map(), // 14-18
    evening: new Map(),   // 18-23
    night: new Map(),     // 23-5
  }
  for (const s of sessions) {
    const hour = new Date(s.startTime).getHours()
    const bucket =
      hour >= 5 && hour < 11 ? 'morning'
      : hour >= 11 && hour < 14 ? 'midday'
      : hour >= 14 && hour < 18 ? 'afternoon'
      : hour >= 18 && hour < 23 ? 'evening'
      : 'night'
    const current = buckets[bucket].get(s.category) ?? 0
    buckets[bucket].set(s.category, current + s.durationSeconds)
  }
  const parts: string[] = []
  for (const [name, map] of Object.entries(buckets)) {
    if (map.size === 0) continue
    const topCat = [...map.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!topCat || topCat[1] < 300) continue // skip buckets with < 5 min
    parts.push(`${name}: mostly ${topCat[0]} (${formatDuration(topCat[1])})`)
  }
  if (parts.length === 0) return ''
  return `Time-of-day shape: ${parts.join('; ')}`
}

function buildRecentFocusContext(): string {
  try {
    const db = getDb()
    const sessions = getRecentFocusSessions(db, 5)
    if (sessions.length === 0) return 'Recent focus sessions: none recorded.'

    const lines = sessions.map((session) => {
      const apps = uniqueAppNames(
        getSessionsForRange(db, session.startTime, sessionEndMs(session))
          .map((item) => item.appName),
      ).slice(0, 5)

      const plan = session.plannedApps.length > 0
        ? session.plannedApps.join(', ')
        : 'not set'
      const observed = apps.length > 0 ? apps.join(', ') : 'none tracked'
      const target = session.targetMinutes ? `, target ${session.targetMinutes}m` : ''

      return `- ${formatDateTimeLabel(session.startTime)}: ${session.label || 'Focus session'} for ${formatDuration(session.durationSeconds)}${target}; planned apps ${plan}; observed apps ${observed}`
    })

    return ['Recent focus sessions:', ...lines].join('\n')
  } catch {
    return 'Recent focus sessions: unavailable.'
  }
}

function parseTimeParts(hourRaw: string, minuteRaw?: string, meridiemRaw?: string): { hour: number; minute: number } | null {
  let hour = Number(hourRaw)
  const minute = Number(minuteRaw ?? '0')
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null

  const meridiem = meridiemRaw?.toLowerCase()
  if (meridiem === 'am') {
    if (hour === 12) hour = 0
  } else if (meridiem === 'pm') {
    if (hour < 12) hour += 12
  }

  if (hour < 0 || hour > 23) return null
  return { hour, minute }
}

function parseTemporalLookup(userMessage: string): { label: string; targetMs: number; dayStart: number; dayEnd: number } | null {
  const lower = userMessage.toLowerCase()
  const now = new Date()

  const relativeFirst = lower.match(/\b(today|yesterday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  const timeFirst = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(today|yesterday)\b/)
  const isoDate = lower.match(/\b(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)

  let baseDate: Date | null = null
  let label = ''
  let timeParts: { hour: number; minute: number } | null = null

  if (relativeFirst) {
    baseDate = new Date(now)
    if (relativeFirst[1] === 'yesterday') baseDate.setDate(baseDate.getDate() - 1)
    label = relativeFirst[1]
    timeParts = parseTimeParts(relativeFirst[2], relativeFirst[3], relativeFirst[4])
  } else if (timeFirst) {
    baseDate = new Date(now)
    if (timeFirst[4] === 'yesterday') baseDate.setDate(baseDate.getDate() - 1)
    label = timeFirst[4]
    timeParts = parseTimeParts(timeFirst[1], timeFirst[2], timeFirst[3])
  } else if (isoDate) {
    const [year, month, day] = isoDate[1].split('-').map(Number)
    baseDate = new Date(year, month - 1, day)
    label = isoDate[1]
    timeParts = parseTimeParts(isoDate[2], isoDate[3], isoDate[4])
  }

  if (!baseDate || !timeParts) return null

  baseDate.setHours(timeParts.hour, timeParts.minute, 0, 0)
  const dayStart = new Date(baseDate)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  return {
    label,
    targetMs: baseDate.getTime(),
    dayStart: dayStart.getTime(),
    dayEnd: dayEnd.getTime(),
  }
}

function buildSpecificTimeContext(userMessage: string): string {
  try {
    const lookup = parseTemporalLookup(userMessage)
    if (!lookup) return ''

    const db = getDb()
    const dayDate = new Date(lookup.dayStart)
    const dateStr = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`

    // Look up the work block covering the queried time — this gives us the task
    // label and artifact refs (file names, document names, project names).
    const dayPayload = getTimelineDayPayload(db, dateStr, null)
    const coveringBlock = dayPayload.blocks.find(
      (block) => lookup.targetMs >= block.startTime && lookup.targetMs < block.endTime,
    )

    const daySessions = getSessionsForRange(db, lookup.dayStart, lookup.dayEnd)
    const containing = daySessions.find((session) => {
      const end = sessionEndMs(session)
      return lookup.targetMs >= session.startTime && lookup.targetMs < end
    })
    const windowStart = lookup.targetMs - 45 * 60 * 1000
    const windowEnd = lookup.targetMs + 45 * 60 * 1000
    const nearby = daySessions
      .filter((session) => sessionEndMs(session) > windowStart && session.startTime < windowEnd)
      .slice(0, 5)
    const nearbySites = getWebsiteSummariesForRange(db, windowStart, windowEnd).slice(0, 3)
    const focusSession = getRecentFocusSessions(db, 50).find((session) => {
      const end = sessionEndMs(session)
      return lookup.targetMs >= session.startTime && lookup.targetMs < end
    })

    const lines: string[] = [
      `Specific timeline lookup for ${lookup.label} (${formatDateTimeLabel(lookup.targetMs)}):`,
    ]

    if (coveringBlock) {
      const blockLabel = userVisibleLabelForBlock(coveringBlock)
      const blockArtifacts = coveringBlock.topArtifacts
        .slice(0, 4)
        .map((a) => a.displayTitle.trim())
        .filter(Boolean)
      const blockApps = coveringBlock.topApps
        .filter((app) => app.category !== 'system')
        .slice(0, 3)
        .map((app) => app.appName)
      lines.push(
        `- Work block: "${blockLabel}" (${formatClock(coveringBlock.startTime)}-${formatClock(coveringBlock.endTime)})` +
        (blockApps.length > 0 ? `, apps: ${blockApps.join(', ')}` : '') +
        (blockArtifacts.length > 0 ? `, artifacts: ${blockArtifacts.join(', ')}` : ''),
      )
    }

    if (containing) {
      lines.push(
        `- Foreground app at that time: ${containing.appName} (${containing.category}), ${formatClock(containing.startTime)}-${formatClock(sessionEndMs(containing))}.`,
      )
    } else if (!coveringBlock) {
      lines.push('- No foreground app session covers that exact time.')
    }

    if (nearby.length > 0) {
      lines.push(
        `- Nearby sessions: ${nearby.map((session) => `${session.appName} ${formatClock(session.startTime)}-${formatClock(sessionEndMs(session))}`).join(', ')}.`,
      )
    }

    if (focusSession) {
      const plan = focusSession.plannedApps.length > 0
        ? focusSession.plannedApps.join(', ')
        : 'not set'
      lines.push(
        `- Focus session overlap: ${focusSession.label || 'Focus session'} for ${formatDuration(focusSession.durationSeconds)}${focusSession.targetMinutes ? ` with ${focusSession.targetMinutes}m target` : ''}; planned apps ${plan}.`,
      )
    }

    if (nearbySites.length > 0) {
      lines.push(
        `- Browser evidence near that time: ${nearbySites.map((site) => `${site.domain} (${formatDuration(site.totalSeconds)})`).join(', ')}.`,
      )
    }

    return lines.join('\n')
  } catch {
    return ''
  }
}

function buildStructuredEvidenceContext(): string {
  try {
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const db = getDb()
    const pack = buildAssistantEvidencePack(db, dateStr)

    const dayCtx = resolveDayContext(dateStr, db)
    const workSessions = dayCtx.sessions.slice(0, 12).map((s) => ({
      id: s.work_session_id,
      start: s.start,
      end: s.end,
      duration_ms: s.duration_ms,
      active_ms: s.active_ms,
      client: s.client,
      project: s.project,
      confidence: s.confidence,
      apps: s.apps.slice(0, 5),
      evidence: s.evidence.slice(0, 5),
    }))

    return JSON.stringify({
      date: pack.date,
      generatedAt: pack.generatedAt,
      totals: pack.totals,
      attribution_summary: {
        captured_ms: dayCtx.day_summary.captured_ms,
        active_ms: dayCtx.day_summary.active_ms,
        attributed_ms: dayCtx.day_summary.attributed_ms,
        ambiguous_ms: dayCtx.day_summary.ambiguous_ms,
        unattributed_ms: dayCtx.day_summary.unattributed_ms,
      },
      work_sessions: workSessions,
      topApps: pack.topApps.map((app) => ({
        appName: app.appName,
        category: app.category,
        totalSeconds: app.totalSeconds,
        canonicalAppId: app.canonicalAppId ?? null,
      })),
      topWebsites: pack.topWebsites.map((site) => ({
        domain: site.domain,
        totalSeconds: site.totalSeconds,
        topTitle: site.topTitle,
      })),
      blocks: pack.timeline.blocks,
      workflows: pack.workflows.map((workflow) => ({
        label: workflow.label,
        dominantCategory: workflow.dominantCategory,
        occurrenceCount: workflow.occurrenceCount,
        canonicalApps: workflow.canonicalApps,
      })),
      focusSessions: pack.focusSessions.map((session) => ({
        label: session.label,
        durationSeconds: session.durationSeconds,
        targetMinutes: session.targetMinutes ?? null,
        plannedApps: session.plannedApps,
      })),
      appSpotlights: pack.appSpotlights.map((app) => ({
        displayName: app.displayName,
        totalSeconds: app.totalSeconds,
        topArtifacts: app.topArtifacts.slice(0, 4).map((artifact) => artifact.displayTitle),
        pairedApps: app.pairedApps.slice(0, 4).map((entry) => entry.displayName),
        workflows: app.workflowAppearances.slice(0, 4).map((workflow) => workflow.label),
      })),
      ambiguous_segments: dayCtx.ambiguous_segments.slice(0, 5),
      caveats: [
        ...pack.caveats,
        'work_sessions are attributed via the pipeline; always separate attributed from ambiguous time.',
        'When answering "how many hours on X", prefer attributed work_sessions when a named client or project exists; otherwise fall back to blocks and artifacts instead of raw app totals alone.',
      ],
    }, null, 2)
  } catch {
    return ''
  }
}

function buildAttributionDayContext(dateStr: string): string {
  try {
    const payload = resolveDayContext(dateStr, getDb())
    if (payload.sessions.length === 0) return ''
    return JSON.stringify(payload, null, 2)
  } catch {
    return ''
  }
}

function buildAttributedEntityContext(userMessage: string): string {
  try {
    const entityMatch = userMessage.match(
      /(?:hours?\s+(?:on|for|with|at)\s+|client\s+|project\s+)['"]?([A-Za-z][\w\s&.-]{1,40})['"]?/i,
    )
    if (!entityMatch) return ''
    const db = getDb()
    const candidate = entityMatch[1].trim()

    const now = new Date()
    const weekAgo = new Date(now)
    weekAgo.setDate(weekAgo.getDate() - 7)
    weekAgo.setHours(0, 0, 0, 0)

    const project = findProjectByName(candidate, db)
    if (project) {
      const payload = resolveProjectQuery(
        project.id, weekAgo.getTime(), now.getTime(),
        userMessage, db,
      )
      if (payload) return JSON.stringify(payload, null, 2)
    }

    const client = findClientByName(candidate, db)
    if (!client) return ''
    const payload = resolveClientQuery(
      client.id, weekAgo.getTime(), now.getTime(),
      userMessage, db,
    )
    if (!payload) return ''
    return JSON.stringify(payload, null, 2)
  } catch {
    return ''
  }
}

// Compact historical summary spanning the entire tracked window. Injected into
// the chat system prompt so the LLM can answer follow-up questions about
// all-time totals (e.g. "how many days is that?") after a deterministic router
// hit, instead of contradicting its previous answer with "I only see today".
function buildAllTimeContext(): string {
  try {
    const db = getDb()
    const toMs = Date.now()
    const fromMs = toMs - 2 * 365 * 24 * 60 * 60 * 1000
    const apps = getAppSummariesForRange(db, fromMs, toMs)
    const sites = getWebsiteSummariesForRange(db, fromMs, toMs)
    if (apps.length === 0 && sites.length === 0) return ''

    const firstSessionRow = db
      .prepare('SELECT MIN(start_time) as t FROM app_sessions')
      .get() as { t: number | null } | undefined
    const firstSessionMs = firstSessionRow?.t ?? fromMs
    const trackingDays = Math.max(1, Math.round((toMs - firstSessionMs) / (24 * 60 * 60 * 1000)))

    const totalSeconds = apps.reduce((sum, app) => sum + app.totalSeconds, 0)
    const focusSeconds = apps.filter((a) => a.isFocused).reduce((sum, app) => sum + app.totalSeconds, 0)
    const focusPct = totalSeconds > 0 ? Math.round((focusSeconds / totalSeconds) * 100) : 0

    const DISTRACTION_DOMAINS = ['youtube.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'tiktok.com', 'netflix.com', 'facebook.com']
    const distractionSites = sites.filter((s) => DISTRACTION_DOMAINS.includes(s.domain.toLowerCase()))
    const distractionSeconds = distractionSites.reduce((sum, s) => sum + s.totalSeconds, 0)

    const topApps = apps
      .slice(0, 10)
      .map((app) => `${app.appName} (${formatDuration(app.totalSeconds)})`)
      .join(', ')
    const topSites = sites
      .slice(0, 10)
      .map((site) => `${site.domain} (${formatDuration(site.totalSeconds)})`)
      .join(', ')

    const topCategories = new Map<string, number>()
    for (const app of apps) {
      topCategories.set(app.category, (topCategories.get(app.category) ?? 0) + app.totalSeconds)
    }
    const topCategoryList = [...topCategories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, sec]) => `${cat} (${formatDuration(sec)})`)
      .join(', ')

    const lines = [
      `Tracking window: ${trackingDays} days (since first recorded session).`,
      `Lifetime tracked time: ${formatDuration(totalSeconds)}, ~${focusPct}% focused.`,
      topCategoryList ? `Lifetime by category: ${topCategoryList}.` : null,
      topApps ? `Lifetime top apps: ${topApps}.` : null,
      topSites ? `Lifetime top sites: ${topSites}.` : null,
      distractionSeconds > 0
        ? `Lifetime distraction time (YouTube, X, Reddit, etc.): ${formatDuration(distractionSeconds)} of ${formatDuration(totalSeconds)} total.`
        : null,
    ].filter((line): line is string => line !== null)

    return lines.join('\n')
  } catch {
    return ''
  }
}

function buildDayContext(): string {
  try {
    const db = getDb()
    const settings = getSettings()
    const now = new Date()
    const [todayFrom, todayTo] = dayBounds(now)
    const summaries = getAppSummariesForRange(db, todayFrom, todayTo)
    const todaySessions = getSessionsForRange(db, todayFrom, todayTo)
    const websites = getWebsiteSummariesForRange(db, todayFrom, todayTo)
    const todayEvidence = deriveWorkEvidenceSummary({
      appSummaries: summaries,
      sessions: todaySessions,
      websiteSummaries: websites,
    })
    const peakHours = getPeakHours(db, todayTo - 14 * 86_400_000, todayTo) ?? undefined

    const totalSec = summaries.reduce((s, a) => s + a.totalSeconds, 0)
    const focusSec = summaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
    const switchesPerHour = totalSec > 0 ? countSwitches(todaySessions) / (totalSec / 3600) : 0
    const focusScore = computeEnhancedFocusScore({
      focusedSeconds: focusSec,
      totalSeconds: totalSec,
      switchesPerHour,
      sessions: todaySessions.map((session) => ({
        durationSeconds: session.durationSeconds,
        isFocused: session.isFocused,
      })),
      peakHours,
      currentHour: now.getHours(),
    })

    // User identity & goals
    const userName = settings.userName || 'the user'
    const goalsStr = settings.userGoals?.length
      ? settings.userGoals.join(', ')
      : 'not specified'

    // Focus sessions
    const focusSessions = getRecentFocusSessions(db, 10).filter((s) => {
      return s.startTime >= todayFrom && s.startTime < todayTo
    })
    const todayFocusSessionCount = focusSessions.length
    const longestFocusSession = focusSessions.reduce((m, s) => Math.max(m, s.durationSeconds), 0)
    const totalFocusSessionSec = focusSessions.reduce((s, x) => s + x.durationSeconds, 0)

    // Category overrides
    const overrides = getCategoryOverrides(db)
    const overrideEntries = Object.entries(overrides)

    // Time context
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' })

    if (summaries.length === 0 && websites.length === 0) {
      return [
        `User: ${userName}`,
        `Goals: ${goalsStr}`,
        `Current time: ${timeStr}, ${dayStr}`,
        '',
        'No activity recorded yet today.',
      ].join('\n')
    }

    const topCategories = new Map<string, number>()
    for (const summary of summaries) {
      topCategories.set(summary.category, (topCategories.get(summary.category) ?? 0) + summary.totalSeconds)
    }
    const topApps = summaries
      .slice(0, 5)
      .map((a) => `${a.appName} (${formatDuration(a.totalSeconds)}, ${a.category})`)
      .join(', ')
    const topSites = websites
      .slice(0, 5)
      .map((site) => `${site.domain} (${formatDuration(site.totalSeconds)})`)
      .join(', ')
    const topCategoryList = [...topCategories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([category, seconds]) => `${category} (${formatDuration(seconds)})`)
      .join(', ')

    const recentDays: string[] = []
    for (let offset = 1; offset <= 6; offset++) {
      const date = new Date(todayFrom - offset * 86_400_000)
      const [fromMs, toMs] = dayBounds(date)
      const daySummaries = getAppSummariesForRange(db, fromMs, toMs)
      const daySessions = getSessionsForRange(db, fromMs, toMs)
      if (daySummaries.length === 0) continue
      const dayTotal = daySummaries.reduce((sum, item) => sum + item.totalSeconds, 0)
      const dayFocus = daySummaries.filter((item) => item.isFocused).reduce((sum, item) => sum + item.totalSeconds, 0)
      const daySwitchesPerHour = dayTotal > 0 ? countSwitches(daySessions) / (dayTotal / 3600) : 0
      const dayFocusScore = computeEnhancedFocusScore({
        focusedSeconds: dayFocus,
        totalSeconds: dayTotal,
        switchesPerHour: daySwitchesPerHour,
        sessions: daySessions.map((session) => ({
          durationSeconds: session.durationSeconds,
          isFocused: session.isFocused,
        })),
      })
      const topApp = daySummaries[0]
      recentDays.push(
        `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ` +
        `${formatDuration(dayTotal)} total, focus score ${dayFocusScore}, top app ${topApp?.appName ?? 'n/a'}`,
      )
    }

    const recentFocusContext = buildRecentFocusContext()
    const todayBlocksContext = buildTodayBlocksContext()
    const workflowsContext = buildWorkflowsContext()
    const structuredEvidenceContext = buildStructuredEvidenceContext()
    const hourlyShapeContext = buildHourlyShapeContext(
      todaySessions.map((s) => ({
        startTime: s.startTime,
        durationSeconds: s.durationSeconds,
        category: s.category,
      })),
    )

    return [
      `User: ${userName}`,
      `Goals: ${goalsStr}`,
      `Current time: ${timeStr}, ${dayStr}`,
      '',
      todayFocusSessionCount > 0
        ? `Focus sessions today: ${todayFocusSessionCount} session${todayFocusSessionCount > 1 ? 's' : ''}, longest ${formatDuration(longestFocusSession)}, total ${formatDuration(totalFocusSessionSec)}`
        : 'Focus sessions today: none',
      overrideEntries.length > 0
        ? `User has recategorized: ${overrideEntries.map(([id, cat]) => `${id} → ${cat}`).join(', ')}`
        : '',
      '',
      'Today (totals):',
      `- Total tracked time: ${formatDuration(totalSec)}`,
      `- Focus score: ${focusScore} (${formatDuration(focusSec)} in focused apps)`,
      `- Evidence summary: ${todayEvidence.evidenceText}`,
      `- Top categories: ${topCategoryList || 'none yet'}`,
      `- Top apps: ${topApps || 'none yet'}`,
      `- Top websites: ${topSites || 'none yet'}`,
      hourlyShapeContext ? `- ${hourlyShapeContext}` : '',
      '',
      todayBlocksContext,
      '',
      workflowsContext,
      '',
      recentDays.length > 0 ? 'Recent days (trend):' : '',
      ...recentDays.map((line) => `- ${line}`),
      '',
      recentFocusContext,
      structuredEvidenceContext ? 'Structured evidence pack (JSON):' : '',
      structuredEvidenceContext,
      '',
      'Data notes:',
      '- App totals come from tracked foreground-window sessions — reliable.',
      '- Work blocks are segmented by the local heuristic; labels may be rule-based or AI-generated.',
      '- Each block includes a deterministic workIntent guess; prefer that over generic home/feed titles when inferring what the person was trying to do.',
      '- Website timing comes from local browser evidence and may undercount background tabs.',
      '- Focus score weights focused categories (development, writing, design, etc.); browser work may be productive but read as unfocused.',
    ]
      .filter((l) => l !== '')
      .join('\n')
  } catch {
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
  return prior.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

function fillQuestionSuggestions(
  suggestions: string[],
  fallback: string[],
): string[] {
  return fillDaySummaryQuestionSuggestions(suggestions, fallback)
}

function blockDurationSeconds(block: Pick<WorkContextBlock, 'startTime' | 'endTime'>): number {
  return Math.max(0, Math.round((block.endTime - block.startTime) / 1000))
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

function leadSentenceForIntent(block: WorkContextBlock): string {
  const duration = formatDuration(blockDurationSeconds(block))
  const intent = inferWorkIntent(block)

  switch (intent.role) {
    case 'execution':
      return intent.subject
        ? `The clearest execution block was ${intent.subject} for ${duration}.`
        : `The clearest block was execution work for ${duration}.`
    case 'research':
      return intent.subject
        ? `A large share of today went into research/context gathering around ${intent.subject} for ${duration}.`
        : `A large share of today went into research/context gathering for ${duration}.`
    case 'review':
      return intent.subject
        ? `A large share of today went into reviewing ${intent.subject} for ${duration}.`
        : `A large share of today went into review work for ${duration}.`
    case 'communication':
      return intent.subject
        ? `A large share of today went into communication around ${intent.subject} for ${duration}.`
        : `A large share of today went into communication work for ${duration}.`
    case 'coordination':
      return intent.subject
        ? `A large share of today went into coordination around ${intent.subject} for ${duration}.`
        : `A large share of today went into coordination work for ${duration}.`
    case 'ambient':
      return intent.subject
        ? `A meaningful chunk of today was ambient browsing on ${intent.subject} for ${duration}.`
        : `A meaningful chunk of today was ambient browsing for ${duration}.`
    case 'ambiguous':
    default:
      return intent.subject
        ? `The day mixed together work touching ${intent.subject} for ${duration}.`
        : `The day mixed together several threads over ${duration}.`
  }
}

function supportingIntentSentence(primary: WorkContextBlock, rankedBlocks: WorkContextBlock[]): string | null {
  const primaryIntent = inferWorkIntent(primary)
  const supporting = rankedBlocks
    .slice(1)
    .map((block) => ({ block, intent: inferWorkIntent(block) }))
    .find(({ intent }) => intent.role !== primaryIntent.role)

  if (!supporting) return null

  if (primaryIntent.role === 'execution' && (supporting.intent.role === 'research' || supporting.intent.role === 'ambient')) {
    return `${supporting.intent.summary} looked more like supporting context than the main deliverable.`
  }

  if ((primaryIntent.role === 'research' || primaryIntent.role === 'ambient') && supporting.intent.role === 'execution') {
    return `The clearer delivery evidence showed up in ${supporting.intent.summary.toLowerCase()}.`
  }

  return null
}

function focusSentence(payload: DayTimelinePayload): string {
  if (payload.focusPct >= 70) {
    return `Focus held for ${formatDuration(payload.focusSeconds)} (${payload.focusPct}% of tracked time).`
  }
  return `Focus was more fragmented, with ${formatDuration(payload.focusSeconds)} counted as focused time (${payload.focusPct}%).`
}

function inferFollowUpAffordances(answerKind: AIAnswerKind): AIConversationState['followUpAffordances'] {
  switch (answerKind) {
    case 'weekly_brief':
      return ['deepen', 'literalize', 'narrow', 'compare', 'switch_topic', 'repair']
    case 'weekly_literal_list':
      return ['narrow', 'expand', 'switch_topic', 'switch_timeframe', 'repair']
    case 'deterministic_stats':
      return ['deepen', 'expand', 'compare', 'repair']
    case 'day_summary_style':
    case 'generated_report':
      return ['deepen', 'expand', 'narrow', 'repair']
    case 'freeform_chat':
      return ['deepen', 'expand', 'repair']
    case 'error':
    default:
      return []
  }
}

async function generateSuggestedFollowUps(
  userQuestion: string,
  answerText: string,
  answerKind: AIAnswerKind,
  state: AIConversationState | null,
): Promise<FollowUpSuggestion[]> {
  const fallback = buildDeterministicFollowUpCandidates(answerKind, state)
  if (fallback.length < 2 || answerKind === 'error') return fallback.slice(0, 4)

  const preferredProviderOverride = await hasApiKey('anthropic') ? 'anthropic' as const : null
  const { systemPrompt, userPrompt } = buildFollowUpSuggestionPrompts(userQuestion, answerText, state, fallback)

  try {
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'chat_followup_suggestions',
          screen: 'ai_chat',
          triggerSource: 'system',
          systemPrompt,
          userMessage: userPrompt,
          preferredProviderOverride,
        },
        sendWithProvider,
      ),
      6_000,
      'Follow-up suggestion generation timed out',
    )
    return parseFollowUpSuggestions(text, fallback).slice(0, 4)
  } catch (error) {
    capture(ANALYTICS_EVENT.AI_FOLLOWUP_SUGGESTIONS_FALLBACK, {
      failure_kind: classifyFailureKind(error),
      answer_kind: answerKind,
      provider: preferredProviderOverride ?? 'anthropic',
      suggestion_count: fallback.length,
    })
    return fallback.slice(0, 4)
  }
}

function restoreConversationState(conversationId: number): AIConversationState | null {
  const db = getDb()
  const persisted = getConversationState(db, conversationId)
  if (!persisted) return null
  if (!conversationTemporalContext.has(conversationId)) {
    conversationTemporalContext.set(conversationId, deserializeTemporalContext(persisted.routingContext))
  }
  return persisted
}

function buildAssistantMetadata(
  answerKind: AIAnswerKind,
  suggestedFollowUps: FollowUpSuggestion[],
  retrySourceUserMessageId: number | null,
  conversationState: AIConversationState | null,
  actions: AIMessageAction[] = [],
  artifacts: AIMessageArtifact[] = [],
  providerError = false,
): AIThreadMessageMetadata {
  return {
    answerKind,
    suggestedFollowUps,
    retryable: !providerError,
    retrySourceUserMessageId,
    contextSnapshot: conversationState,
    providerError,
    actions,
    artifacts,
  }
}

function persistChatTurn(
  db: ReturnType<typeof getDb>,
  conversationId: number,
  userMessage: string,
  envelope: AnswerEnvelope,
  threadId: number | null = null,
): AIChatTurnResult {
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
      ),
    },
  )
  upsertConversationState(db, conversationId, envelope.conversationState)
  conversationTemporalContext.set(conversationId, envelope.resolvedTemporalContext)
  if (threadId != null) {
    touchThreadLastMessage(db, threadId, Date.now())
    queueWeakThreadTitleUpgrade(threadId, userMessage, envelope)
    // Also persist AIMessageArtifact entries into the durable ai_artifacts table.
    if (envelope.artifacts && envelope.artifacts.length > 0) {
      void persistMessageArtifacts(threadId, assistantEntry.id, envelope.artifacts)
    }
  }
  return {
    assistantMessage: assistantEntry,
    conversationState: envelope.conversationState,
  }
}

function threadTitleContextFromEnvelope(envelope: AnswerEnvelope): ThreadTitleContext {
  return {
    answerKind: envelope.answerKind,
    entityName: envelope.resolvedTemporalContext?.entity?.entityName ?? null,
    entityIntent: envelope.resolvedTemporalContext?.entity?.intent ?? null,
    weeklyBriefIntent: envelope.resolvedTemporalContext?.weeklyBrief?.intent ?? null,
  }
}

function maybeRenameWeakThread(
  threadId: number,
  currentTitle: string | null | undefined,
  userMessage: string,
  context?: ThreadTitleContext,
): void {
  if (!isWeakThreadTitle(currentTitle)) return
  const candidate = deriveTitleFromMessage(userMessage, context)
  if (candidate === currentTitle || isWeakThreadTitle(candidate)) return
  renameThread(threadId, candidate)
}

function queueWeakThreadTitleUpgrade(threadId: number, userMessage: string, envelope: AnswerEnvelope): void {
  const context = threadTitleContextFromEnvelope(envelope)
  setTimeout(() => {
    const currentTitle = getThread(threadId)?.title ?? null
    maybeRenameWeakThread(threadId, currentTitle, userMessage, context)
  }, 0)
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
        fileContent = await fs.readFile(artifact.path, 'utf8')
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

function fallbackDaySummary(payload: DayTimelinePayload): AIDaySummaryResult {
  if (payload.totalSeconds === 0) {
    return {
      summary: 'No tracked activity yet today. Once Daylens has real local history, this screen can answer questions about your work, files, pages, and focus patterns.',
      questionSuggestions: [
        'What kinds of questions will you be able to answer once I have more history?',
        'How should I use Daylens if I am not tracking clients?',
        'What should I pay attention to the first few days of tracking?',
      ],
    }
  }

  const rankedBlocks = [...payload.blocks]
    .sort((left, right) => blockDurationSeconds(right) - blockDurationSeconds(left))
    .slice(0, 3)
  const primary = rankedBlocks[0]
  const evidence = primary ? namedEvidenceForSummary(primary) : []

  const summaryParts = [
    `You tracked ${formatDuration(payload.totalSeconds)} across ${payload.blocks.length} block${payload.blocks.length === 1 ? '' : 's'} today.`,
    primary ? leadSentenceForIntent(primary) : null,
    evidence.length > 0 ? `Strongest evidence included ${evidence.join(', ')}.` : null,
    primary ? supportingIntentSentence(primary, rankedBlocks) : null,
    focusSentence(payload),
  ]

  return {
    summary: summaryParts.filter((part): part is string => Boolean(part)).join(' '),
    questionSuggestions: [
      'What did I actually get done today?',
      'Which files, docs, or pages did I touch today?',
      payload.blocks.length >= 3 ? 'Where did my focus break down today?' : 'What should I pick back up next?',
    ],
  }
}

function daySummaryCacheKey(payload: DayTimelinePayload): string {
  return JSON.stringify({
    date: payload.date,
    totalSeconds: payload.totalSeconds,
    focusSeconds: payload.focusSeconds,
    focusPct: payload.focusPct,
    blockCount: payload.blocks.length,
    blocks: payload.blocks.map((block) => ({
      id: block.id,
      label: block.label.current,
      narrative: block.label.narrative,
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

function buildDaySummaryScaffold(payload: DayTimelinePayload): string {
  const dominantBlocks = [...payload.blocks]
    .sort((left, right) => blockDurationSeconds(right) - blockDurationSeconds(left))
    .slice(0, 4)
    .map((block) => ({
      label: block.label.current,
      timeRange: `${formatClock(block.startTime)}-${formatClock(block.endTime)}`,
      duration: formatDuration(blockDurationSeconds(block)),
      workIntent: inferWorkIntent(block),
      supportingEvidence: namedEvidenceForSummary(block),
    }))

  const topCategories = Array.from(payload.blocks.reduce<Map<string, number>>((map, block) => {
    const durationSeconds = blockDurationSeconds(block)
    map.set(block.dominantCategory, (map.get(block.dominantCategory) ?? 0) + durationSeconds)
    return map
  }, new Map()).entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([category, seconds]) => ({ category, duration: formatDuration(seconds) }))

  const blocks = payload.blocks.slice(0, 8).map((block) => ({
    label: block.label.current,
    narrative: block.label.narrative,
    timeRange: `${formatClock(block.startTime)}-${formatClock(block.endTime)}`,
    duration: formatDuration(blockDurationSeconds(block)),
    dominantCategory: block.dominantCategory,
    confidence: block.confidence,
    workIntent: inferWorkIntent(block),
    topApps: block.topApps.slice(0, 3).map((app) => ({
      appName: app.appName,
      duration: formatDuration(app.totalSeconds),
    })),
    artifacts: block.topArtifacts.slice(0, 4).map((artifact) => ({
      title: artifact.displayTitle,
      type: artifact.artifactType,
    })),
    pages: block.pageRefs.slice(0, 3).map((page) => ({
      title: page.displayTitle,
      domain: page.domain,
    })),
    workflows: block.workflowRefs.slice(0, 3).map((workflow) => workflow.label),
  }))

  const focusSessions = payload.focusSessions.slice(0, 4).map((session) => ({
    label: session.label,
    duration: formatDuration(session.durationSeconds),
    startedAt: formatClock(session.startTime),
  }))

  return JSON.stringify({
    date: payload.date,
    totals: {
      tracked: formatDuration(payload.totalSeconds),
      focus: formatDuration(payload.focusSeconds),
      focusPct: payload.focusPct,
      blockCount: payload.blocks.length,
      appCount: payload.appCount,
      siteCount: payload.siteCount,
    },
    topCategories,
    dominantBlocks,
    blocks,
    focusSessions,
  }, null, 2)
}

function parseDaySummaryResult(raw: string, fallbackQuestions: string[]): AIDaySummaryResult | null {
  const normalized = escapeJsonBlock(raw)

  try {
    const parsed = JSON.parse(normalized) as Partial<AIDaySummaryResult>
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null
    return {
      summary: parsed.summary.trim(),
      questionSuggestions: fillQuestionSuggestions(
        Array.isArray(parsed.questionSuggestions)
          ? parsed.questionSuggestions.filter((question): question is string => typeof question === 'string')
          : [],
        fallbackQuestions,
      ),
    }
  } catch {
    if (!normalized) return null
    return {
      summary: normalized,
      questionSuggestions: fillQuestionSuggestions([], fallbackQuestions),
    }
  }
}

function currentLocalDateString(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export async function generateDaySummary(dateStr: string): Promise<AIDaySummaryResult> {
  const db = getDb()
  const liveSession = dateStr === currentLocalDateString() ? getCurrentSession() : null
  const payload = getTimelineDayPayload(db, dateStr, liveSession)
  const fallback = fallbackDaySummary(payload)

  if (payload.totalSeconds === 0) {
    return fallback
  }

  const cacheKey = daySummaryCacheKey(payload)
  const cached = daySummaryCache.get(cacheKey)
  if (cached) return cached

  const systemPrompt = [
    'You are Daylens, writing the opening daily briefing for a desktop work-intelligence app.',
    'Turn deterministic local work evidence into a concise, useful summary.',
    'Focus on what the person was actually working on, what moved forward, and what deserves follow-up.',
    'Prefer the structured workIntent signal over raw homepage, feed, or generic tab labels when they conflict.',
    'Treat generic feed/home usage as context unless the evidence clearly says it was the main task.',
    'Treat X.com, twitter.com, Twitter, and X as the same product; when that evidence appears, refer to it as "X (Twitter)" unless a more specific page or thread title is available.',
    'Ignore badge-count prefixes like "(4)" when interpreting page or tab titles.',
    'Mention exact file, document, page, repo, or artifact names only when they appear verbatim in the evidence.',
    'Do not write like a dashboard, analytics panel, or generic AI recap.',
    'Avoid filler like "based on the provided data", "top apps", or "productive/unproductive".',
    'Use specific time ranges and named work blocks when they make the story clearer.',
    'If the evidence is thin or ambiguous, say so plainly and stay modest.',
    'The summary must be declarative and must not ask the user a question.',
    'Return strict JSON with keys "summary" and "questionSuggestions".',
    '"summary" must be 2-4 sentences.',
    '"questionSuggestions" must contain exactly 3 clickable next-query chips spoken by the user to Daylens.',
    'Write questionSuggestions as first-person user queries or direct requests to the assistant, not as questions back to the user.',
    'Good examples: "What did I actually get done today?", "Which files or pages mattered most today?", "Summarize today as a short report I could share".',
    'Bad examples: "Are you building a model right now?", "Did task planning settle into place?", "Is this still in discovery phase?".',
    'Never ask the user to confirm intent, progress, or motivation.',
  ].join(' ')

  const userMessage = [
    `Date: ${dateStr}`,
    '',
    'Write the opening AI summary card and three suggested next-query chips for this day.',
    'The user should feel like Daylens understood the work, not like it stitched together a template.',
    'The chips will be rendered as buttons under an "Ask Daylens" label, so they must read like things the user would click to ask next.',
    '',
    'Structured day evidence (JSON):',
    buildDaySummaryScaffold(payload),
  ].join('\n')

  try {
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'day_summary',
          screen: 'ai_chat',
          triggerSource: 'system',
          systemPrompt,
          userMessage,
        },
        sendWithProvider,
      ),
      15_000,
      'Day summary timed out',
    )

    const parsed = parseDaySummaryResult(text, fallback.questionSuggestions)
    const result = parsed ?? fallback
    daySummaryCache.set(cacheKey, result)
    return result
  } catch (error) {
    console.warn(`[ai] day_summary failed for ${dateStr}:`, error)
    return fallback
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
      const durationSeconds = Math.max(0, Math.round((block.endTime - block.startTime) / 1000))
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
    top_blocks: payload.blocks.slice(0, 3).map((block) => block.label.current).filter(Boolean).join(' | ') || 'No clear blocks',
  }))

  return {
    title: `Week review ${weekStart} to ${weekEnd}`,
    scopeLabel: `${weekStart} to ${weekEnd}`,
    assistantScaffold: JSON.stringify({
      range: { weekStart, weekEnd },
      totals: {
        tracked: formatDuration(totalTrackedSeconds),
        focus: formatDuration(totalFocusSeconds),
        focusPct: totalTrackedSeconds > 0 ? Math.round((totalFocusSeconds / totalTrackedSeconds) * 100) : 0,
        activeDayCount: activeDays.length,
      },
      dailyHighlights: activeDays.map((payload) => ({
        date: payload.date,
        tracked: formatDuration(payload.totalSeconds),
        focus: formatDuration(payload.focusSeconds),
        focusPct: payload.focusPct,
        topBlocks: payload.blocks.slice(0, 3).map((block) => ({
          label: block.label.current,
          duration: formatDuration(Math.max(0, Math.round((block.endTime - block.startTime) / 1000))),
          artifacts: block.topArtifacts.slice(0, 3).map((artifact) => artifact.displayTitle),
        })),
      })),
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

function appNarrativeSignature(detail: ReturnType<typeof getAppDetailPayload>): string {
  return hashText(JSON.stringify({
    canonicalAppId: detail.canonicalAppId,
    rangeKey: detail.rangeKey,
    totalSeconds: detail.totalSeconds,
    sessionCount: detail.sessionCount,
    topArtifacts: detail.topArtifacts.slice(0, 8).map((artifact) => artifact.displayTitle),
    pairedApps: detail.pairedApps.slice(0, 8).map((item) => item.displayName),
    blockAppearances: detail.blockAppearances.slice(0, 8).map((block) => `${block.blockId}:${block.label}:${block.startTime}:${block.endTime}`),
  }))
}

function buildAppNarrativeBundle(canonicalAppId: string, days = 7): ReportContextBundle | null {
  const detail = getAppDetailPayload(getDb(), canonicalAppId, days, getCurrentSession())
  if (detail.totalSeconds <= 0) return null

  return {
    title: `${detail.displayName} in the last ${days === 1 ? 'day' : `${days} days`}`,
    scopeLabel: `${detail.displayName} over ${days === 1 ? 'today' : `${days} days`}`,
    assistantScaffold: JSON.stringify({
      app: {
        canonicalAppId: detail.canonicalAppId,
        displayName: detail.displayName,
        totalTracked: formatDuration(detail.totalSeconds),
        sessionCount: detail.sessionCount,
      },
      topArtifacts: detail.topArtifacts.slice(0, 8).map((artifact) => ({
        title: artifact.displayTitle,
        subtitle: artifact.subtitle ?? artifact.host ?? artifact.path ?? null,
        duration: formatDuration(artifact.totalSeconds),
      })),
      pairedApps: detail.pairedApps.slice(0, 8).map((item) => ({
        displayName: item.displayName,
        duration: formatDuration(item.totalSeconds),
      })),
      blockAppearances: detail.blockAppearances.slice(0, 10).map((block) => ({
        label: block.label,
        when: `${localDateKeyForMs(block.startTime)} ${formatClock(block.startTime)}-${formatClock(block.endTime)}`,
      })),
      timeOfDay: detail.timeOfDayDistribution.filter((entry) => entry.totalSeconds > 0).map((entry) => ({
        hour: entry.hour,
        duration: formatDuration(entry.totalSeconds),
      })),
    }, null, 2),
    reportMarkdownScaffold: '',
    tableColumns: ['block_label', 'when', 'category'],
    tableRows: detail.blockAppearances.slice(0, 12).map((block) => ({
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

function buildDayReportBundle(dateStr: string): ReportContextBundle | null {
  const liveSession = dateStr === currentLocalDateString() ? getCurrentSession() : null
  const payload = getTimelineDayPayload(getDb(), dateStr, liveSession)
  if (payload.totalSeconds <= 0) return null

  const categoryRows = Array.from(payload.blocks.reduce<Map<string, number>>((map, block) => {
    const durationSeconds = Math.max(0, Math.round((block.endTime - block.startTime) / 1000))
    map.set(block.dominantCategory, (map.get(block.dominantCategory) ?? 0) + durationSeconds)
    return map
  }, new Map()).entries())
    .sort((left, right) => right[1] - left[1])

  return {
    title: `Day report ${dateStr}`,
    scopeLabel: dateStr,
    assistantScaffold: buildDaySummaryScaffold(payload),
    reportMarkdownScaffold: '',
    tableColumns: ['start', 'end', 'block', 'category', 'apps', 'artifacts', 'duration'],
    tableRows: payload.blocks.slice(0, 16).map((block) => ({
      start: formatClock(block.startTime),
      end: formatClock(block.endTime),
      block: block.label.current,
      category: block.dominantCategory,
      apps: block.topApps.slice(0, 3).map((app) => app.appName).join(' | ') || 'n/a',
      artifacts: block.topArtifacts.slice(0, 3).map((artifact) => artifact.displayTitle).join(' | ') || 'n/a',
      duration: formatDuration(Math.max(0, Math.round((block.endTime - block.startTime) / 1000))),
    })),
    chartRows: categoryRows.slice(0, 8).map(([category, seconds]) => ({
      label: category,
      value: Number((seconds / 3600).toFixed(1)),
    })),
    chartValueLabel: 'hours',
  }
}

async function generateWeekReview(weekStartStr: string): Promise<AISurfaceSummary | null> {
  const bundle = buildWeekReviewBundle(weekStartStr)
  if (!bundle) return null

  const scopeKey = `week:${weekStartStr}`
  const inputSignature = hashText(bundle.assistantScaffold)
  const existingSignature = getAISurfaceSummarySignature(getDb(), 'timeline_week', scopeKey)
  if (existingSignature === inputSignature) {
    return getAISurfaceSummary(getDb(), 'timeline_week', scopeKey)
  }

  const fallback = getAISurfaceSummary(getDb(), 'timeline_week', scopeKey, { stale: true })
  const systemPrompt = [
    'You are Daylens, writing the short week-review card for the Timeline week view.',
    'Use only the deterministic local evidence provided.',
    'Focus on the actual work threads, named artifacts, and where the week concentrated.',
    'Avoid dashboard filler or generic productivity language.',
    'Return strict JSON with keys "title" and "summary".',
    '"summary" must be 2-4 sentences and grounded in the evidence.',
  ].join(' ')
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
        triggerSource: 'system',
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
  days = 7,
): Promise<AISurfaceSummary | null> {
  const bundle = buildAppNarrativeBundle(canonicalAppId, days)
  if (!bundle) return null

  const detail = getAppDetailPayload(getDb(), canonicalAppId, days, getCurrentSession())
  const scopeKey = `app:${detail.canonicalAppId}:${detail.rangeKey}`
  const inputSignature = appNarrativeSignature(detail)
  const existingSignature = getAISurfaceSummarySignature(getDb(), 'app_detail', scopeKey)
  if (existingSignature === inputSignature) {
    return getAISurfaceSummary(getDb(), 'app_detail', scopeKey)
  }

  const fallback = getAISurfaceSummary(getDb(), 'app_detail', scopeKey, { stale: true })
  const systemPrompt = [
    'You are Daylens, writing the short narrative card for an app detail view.',
    'Explain what this tool was helping with, which artifacts or contexts appeared there, and what it tended to pair with.',
    'Use only the deterministic evidence below.',
    'Do not write vanity metrics or generic app summaries.',
    'Return strict JSON with keys "title" and "summary".',
    '"summary" must be 2-4 sentences.',
  ].join(' ')
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
        triggerSource: 'system',
        systemPrompt,
        userMessage,
      },
      sendWithProvider,
    )
    const parsed = parseSurfaceSummaryResult(text, bundle.title)
    if (!parsed) return fallback
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
    return stored
  } catch (error) {
    console.warn(`[ai] app_narrative failed for ${scopeKey}:`, error)
    return fallback
  }
}

function buildClientReportBundle(
  clientId: string,
  range: { fromMs: number; toMs: number; label: string },
  question: string,
): ReportContextBundle | null {
  const payload = resolveClientQuery(clientId, range.fromMs, range.toMs, question, getDb())
  if (!payload || payload.sessions.length === 0) return null

  const dailyTotals = new Map<string, { attributedMs: number; ambiguousMs: number }>()
  for (const session of payload.sessions) {
    const key = localDateKeyForMs(new Date(session.start).getTime())
    const existing = dailyTotals.get(key) ?? { attributedMs: 0, ambiguousMs: 0 }
    if (session.attribution_status === 'attributed') existing.attributedMs += session.active_ms
    else if (session.attribution_status === 'ambiguous') existing.ambiguousMs += session.active_ms
    dailyTotals.set(key, existing)
  }

  return {
    title: `${payload.target.client_name} ${range.label} report`,
    scopeLabel: `${payload.target.client_name} in ${range.label}`,
    assistantScaffold: JSON.stringify({
      target: payload.target,
      range: payload.range,
      totals: payload.totals,
      sessions: payload.sessions.slice(0, 16).map((session) => ({
        start: session.start,
        end: session.end,
        active_ms: session.active_ms,
        title: session.title,
        project_name: session.project_name,
        attribution_status: session.attribution_status,
        confidence: session.confidence,
        apps: session.apps.slice(0, 4).map((app) => app.app_name),
        evidence: session.evidence.slice(0, 4).map((item) => item.value),
      })),
      ambiguities: payload.ambiguities.slice(0, 8),
    }, null, 2),
    reportMarkdownScaffold: '',
    tableColumns: ['date', 'start', 'end', 'title', 'project', 'status', 'apps', 'active_hours', 'confidence'],
    tableRows: payload.sessions.slice(0, 32).map((session) => ({
      date: localDateKeyForMs(new Date(session.start).getTime()),
      start: formatClock(new Date(session.start).getTime()),
      end: formatClock(new Date(session.end).getTime()),
      title: session.title?.trim() || session.project_name || payload.target.client_name,
      project: session.project_name ?? '',
      status: session.attribution_status,
      apps: session.apps.slice(0, 4).map((app) => app.app_name).join(' | ') || 'n/a',
      active_hours: Number((session.active_ms / 3_600_000).toFixed(2)),
      confidence: session.confidence == null ? '' : Math.round(session.confidence * 100),
    })),
    chartRows: [...dailyTotals.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, totals]) => ({
        label: date.slice(5),
        value: Number((totals.attributedMs / 3_600_000).toFixed(1)),
        secondaryValue: Number((totals.ambiguousMs / 3_600_000).toFixed(1)),
      })),
    chartValueLabel: 'hours',
  }
}

function buildProjectReportBundle(
  projectId: string,
  range: { fromMs: number; toMs: number; label: string },
  question: string,
): ReportContextBundle | null {
  const payload = resolveProjectQuery(projectId, range.fromMs, range.toMs, question, getDb())
  if (!payload || payload.sessions.length === 0) return null

  const dailyTotals = new Map<string, { attributedMs: number; ambiguousMs: number }>()
  for (const session of payload.sessions) {
    const key = localDateKeyForMs(new Date(session.start).getTime())
    const existing = dailyTotals.get(key) ?? { attributedMs: 0, ambiguousMs: 0 }
    if (session.attribution_status === 'attributed') existing.attributedMs += session.active_ms
    else if (session.attribution_status === 'ambiguous') existing.ambiguousMs += session.active_ms
    dailyTotals.set(key, existing)
  }

  return {
    title: `${payload.target.project_name} ${range.label} report`,
    scopeLabel: `${payload.target.project_name} in ${range.label}`,
    assistantScaffold: JSON.stringify({
      target: payload.target,
      range: payload.range,
      totals: payload.totals,
      sessions: payload.sessions.slice(0, 16).map((session) => ({
        start: session.start,
        end: session.end,
        active_ms: session.active_ms,
        title: session.title,
        attribution_status: session.attribution_status,
        confidence: session.confidence,
        apps: session.apps.slice(0, 4).map((app) => app.app_name),
        evidence: session.evidence.slice(0, 4).map((item) => item.value),
      })),
    }, null, 2),
    reportMarkdownScaffold: '',
    tableColumns: ['date', 'start', 'end', 'title', 'client', 'status', 'apps', 'active_hours', 'confidence'],
    tableRows: payload.sessions.slice(0, 32).map((session) => ({
      date: localDateKeyForMs(new Date(session.start).getTime()),
      start: formatClock(new Date(session.start).getTime()),
      end: formatClock(new Date(session.end).getTime()),
      title: session.title?.trim() || payload.target.project_name,
      client: payload.target.client_name,
      status: session.attribution_status,
      apps: session.apps.slice(0, 4).map((app) => app.app_name).join(' | ') || 'n/a',
      active_hours: Number((session.active_ms / 3_600_000).toFixed(2)),
      confidence: session.confidence == null ? '' : Math.round(session.confidence * 100),
    })),
    chartRows: [...dailyTotals.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([date, totals]) => ({
        label: date.slice(5),
        value: Number((totals.attributedMs / 3_600_000).toFixed(1)),
        secondaryValue: Number((totals.ambiguousMs / 3_600_000).toFixed(1)),
      })),
    chartValueLabel: 'hours',
  }
}

function fallbackGeneratedReportContent(bundle: ReportContextBundle): {
  assistantResponse: string
  reportTitle: string
  reportMarkdown: string
} {
  const previewRows = bundle.tableRows.slice(0, 5)
  const previewLines = previewRows.map((row) => {
    const fields = Object.entries(row)
      .slice(0, 4)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
    return `- ${fields.join(' • ')}`
  })

  return {
    assistantResponse: `I generated a grounded export for ${bundle.scopeLabel}. The files below were built from the local timeline data for that scope.`,
    reportTitle: bundle.title,
    reportMarkdown: [
      `# ${bundle.title}`,
      '',
      `Scope: ${bundle.scopeLabel}`,
      '',
      previewLines.length > 0 ? '## Evidence Preview' : '## Notes',
      ...(previewLines.length > 0 ? previewLines : ['- Daylens generated this export from deterministic local evidence.']),
    ].join('\n'),
  }
}

function detectDirectEntityForOutput(question: string): DirectReportEntity | null {
  const normalized = question.toLowerCase()
  const explicit = question.match(/\b(?:for|on|about)\s+['"]?([A-Za-z][\w\s&.-]{1,40})['"]?(?:\s+(?:this|last|today|yesterday)|\s+as\b|\s+into\b|[?.!,]|$)/i)
  if (explicit?.[1]) {
    const project = findProjectByName(explicit[1].trim(), getDb())
    if (project) return { entityType: 'project', id: project.id, name: project.name }
    const client = findClientByName(explicit[1].trim(), getDb())
    if (client) return { entityType: 'client', id: client.id, name: client.name }
  }

  for (const project of listProjects(getDb())) {
    const escaped = project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped.toLowerCase()}\\b`, 'i').test(normalized)) {
      return { entityType: 'project', id: project.id, name: project.name }
    }
  }

  for (const client of listClients(getDb())) {
    const escaped = client.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped.toLowerCase()}\\b`, 'i').test(normalized)) {
      return { entityType: 'client', id: client.id, name: client.name }
    }
  }

  return null
}

function resolveOutputRange(
  question: string,
  restoredState: AIConversationState | null,
  previousContext: TemporalContext | null,
): { fromMs: number; toMs: number; label: string } {
  const explicit = inferDateRangeFromQuestion(question, restoredState?.dateRange ?? null)
  if (previousContext?.entity) {
    return explicit ?? {
      fromMs: previousContext.entity.rangeStartMs,
      toMs: previousContext.entity.rangeEndMs,
      label: previousContext.entity.rangeLabel,
    }
  }
  if (previousContext?.weeklyBrief) {
    const weeklyRange = previousContext.weeklyBrief.dateRange
    return explicit ?? {
      fromMs: weeklyRange.fromMs,
      toMs: weeklyRange.toMs,
      label: weeklyRange.label,
    }
  }
  if (explicit) {
    return {
      fromMs: explicit.fromMs,
      toMs: explicit.toMs,
      label: explicit.label,
    }
  }

  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return {
    fromMs: start.getTime(),
    toMs: end.getTime(),
    label: 'today',
  }
}

async function maybeGenerateRequestedOutput(params: {
  question: string
  restoredState: AIConversationState | null
  previousContext: TemporalContext | null
  routedContext: TemporalContext | null
  routedAnswer?: string | null
  prior: ConversationMessage[]
}): Promise<AnswerEnvelope | null> {
  const outputKinds = detectRequestedOutputKinds(params.question)
  if (outputKinds.length === 0) return null

  const range = resolveOutputRange(params.question, params.restoredState, params.previousContext)
  const directEntity: DirectReportEntity | null = params.routedContext?.entity
    ? {
      entityType: params.routedContext.entity.entityType,
      id: params.routedContext.entity.entityId,
      name: params.routedContext.entity.entityName,
    }
    : params.previousContext?.entity
      ? {
        entityType: params.previousContext.entity.entityType,
        id: params.previousContext.entity.entityId,
        name: params.previousContext.entity.entityName,
      }
      : detectDirectEntityForOutput(params.question)

  const bundle = directEntity?.entityType === 'client'
    ? buildClientReportBundle(directEntity.id, range, params.question)
    : directEntity?.entityType === 'project'
      ? buildProjectReportBundle(directEntity.id, range, params.question)
      : (range.label.includes('week') || params.previousContext?.weeklyBrief || params.routedContext?.weeklyBrief)
        ? buildWeekReviewBundle(localDateKeyForMs(range.fromMs))
        : buildDayReportBundle(localDateKeyForMs(range.fromMs))

  if (!bundle) return null

  const outputKindsLabel = outputKinds.join(', ')
  const systemPrompt = [
    'You are Daylens, generating shareable work-history outputs from deterministic local evidence.',
    'Use only the facts in the scaffold below.',
    'Return strict JSON with keys "assistantResponse", "reportTitle", and "reportMarkdown".',
    '"assistantResponse" should be 1-3 short paragraphs for the in-app chat card.',
    '"reportMarkdown" should be concise, grounded Markdown that can stand alone as a sendable report.',
    'If tables or charts are requested, assume CSV and HTML companion files will be generated from the deterministic rows provided.',
    'Do not invent extra files, numbers, titles, artifacts, or projects beyond the scaffold.',
  ].join(' ')
  const userMessage = [
    `Original request: ${params.question}`,
    `Requested outputs: ${outputKindsLabel}`,
    params.routedAnswer?.trim() ? `Existing deterministic answer: ${params.routedAnswer.trim()}` : '',
    '',
    'Structured export scaffold (JSON):',
    bundle.assistantScaffold,
  ].filter(Boolean).join('\n')

  let reportContent = fallbackGeneratedReportContent(bundle)
  try {
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: 'report_generation',
          screen: 'ai_chat',
          triggerSource: 'user',
          systemPrompt,
          userMessage,
          prior: params.prior,
        },
        sendWithProvider,
      ),
      15_000,
      'Report generation timed out',
    )
    reportContent = parseGeneratedReportResult(text, bundle.title) ?? reportContent
  } catch (error) {
    console.warn('[ai] report_generation fell back to deterministic export:', error)
  }

  const artifactSpecs: ReportArtifactSpec[] = [
    {
      kind: 'report',
      title: 'shareable-report',
      format: 'markdown',
      extension: 'md',
      subtitle: bundle.scopeLabel,
      contents: [
        `# ${reportContent.reportTitle}`,
        '',
        reportContent.reportMarkdown.trim(),
        '',
        `Generated by Daylens for ${bundle.scopeLabel}.`,
      ].join('\n'),
    },
  ]

  if ((outputKinds.includes('table') || outputKinds.includes('export')) && bundle.tableRows.length > 0) {
    artifactSpecs.push({
      kind: 'table',
      title: 'table-export',
      format: 'csv',
      extension: 'csv',
      subtitle: `${bundle.scopeLabel} table`,
      contents: buildCsvContent(bundle.tableColumns, bundle.tableRows),
    })
  }

  if ((outputKinds.includes('chart') || outputKinds.includes('export')) && bundle.chartRows.length > 0) {
    artifactSpecs.push({
      kind: 'chart',
      title: 'chart-export',
      format: 'html',
      extension: 'html',
      subtitle: `${bundle.scopeLabel} chart`,
      contents: buildBarChartHtml(
        reportContent.reportTitle,
        `Generated from Daylens local evidence for ${bundle.scopeLabel}.`,
        bundle.chartValueLabel,
        bundle.chartRows,
      ),
    })
  }

  const artifacts = await writeGeneratedArtifacts(reportContent.reportTitle, artifactSpecs)
  const resolvedTemporalContext = params.routedContext
    ?? params.previousContext
    ?? {
      date: new Date(range.fromMs),
      timeWindow: null,
      weeklyBrief: null,
      entity: null,
    }

  const conversationState = buildConversationState(
    'generated_report',
    'freeform',
    resolvedTemporalContext,
    inferFollowUpAffordances('generated_report'),
    {
      dateRange: {
        fromMs: range.fromMs,
        toMs: range.toMs,
        label: range.label,
      },
      lastIntent: params.restoredState?.lastIntent ?? null,
      topic: params.restoredState?.topic ?? null,
      responseMode: params.restoredState?.responseMode ?? null,
      evidenceKey: params.restoredState?.evidenceKey ?? null,
    },
  )
  const suggestedFollowUps = await generateSuggestedFollowUps(
    params.question,
    reportContent.assistantResponse,
    'generated_report',
    conversationState,
  )

  return {
    assistantText: reportContent.assistantResponse,
    answerKind: 'generated_report',
    sourceKind: 'freeform',
    resolvedTemporalContext,
    conversationState,
    suggestedFollowUps,
    artifacts,
  }
}

function weeklyBriefPrompts(
  userMessage: string,
  briefContext: WeeklyBriefContext,
  pack: WeeklyBriefEvidencePack,
): { systemPrompt: string; userPrompt: string } {
  const modeInstruction = briefContext.responseMode === 'literal'
    ? 'Lead with the named items themselves. A compact numbered list is allowed here if it makes the answer clearer.'
    : briefContext.responseMode === 'deepen'
      ? 'Assume this is a follow-up. Keep the same week and topic, but deepen the synthesis and relationships between the themes.'
      : briefContext.responseMode === 'reading'
        ? 'Lead with the clearest named pages, videos, docs, and artifacts. Interpretation is secondary.'
        : 'Lead with the story of the week, then support it with named evidence.'

  const systemPrompt = [
    'You are Daylens.',
    'You turn a deterministic weekly browsing evidence pack into a natural editorial briefing.',
    'The evidence selection is already done for you. Your job is writing, not retrieval.',
    'Use only the facts in the scaffold below. Do not invent pages, repos, docs, files, videos, or claims of certainty.',
    'Open with the main idea of the week.',
    'Group the answer into 2-4 short paragraphs or, for literal reading requests, a compact list plus one short caveat.',
    'Mention exact titles when available.',
    'Distinguish named evidence from ambient or generic browser usage.',
    'Use language like "looks like" or "suggests" when interpreting patterns.',
    'Never fall back to dashboard language like top apps, top sites, or distraction time unless the user explicitly asked for stats.',
    'Never say you only have domains if the scaffold includes named pages or artifacts.',
    modeInstruction,
  ].join(' ')

  const userPrompt = [
    `User question: ${userMessage}`,
    '',
    'Structured weekly brief scaffold (JSON):',
    buildWeeklyBriefScaffold(briefContext, pack),
    '',
    'Write the final answer now.',
  ].join('\n')

  return { systemPrompt, userPrompt }
}

function answerKindForWeeklyContext(context: WeeklyBriefContext): AIAnswerKind {
  return context.responseMode === 'literal' ? 'weekly_literal_list' : 'weekly_brief'
}

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

function workBlockPrompt(block: WorkContextBlock): string {
  const durationMinutes = Math.max(1, Math.round((block.endTime - block.startTime) / 60_000))

  // Top websites with duration — highest-signal evidence (browser/AI work)
  const websiteLines = block.websites.slice(0, 5).map((site) => {
    const dur = formatDuration(site.totalSeconds)
    const title = site.topTitle ? ` (${site.topTitle.slice(0, 60)})` : ''
    return `  ${site.domain}${title} — ${dur}`
  })

  // Native window titles (non-browser) — document/file context
  const pages = block.keyPages.filter(Boolean).slice(0, 5)

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
    'label: 3-7 word title-case. NEVER return a bare category name ("Browsing", "Development").',
    'narrative: 1-2 plain sentences. Evidence-led, no hype, no "the user" prefix.',
    'Priority rules:',
    '  - Website titles > window titles > app names > category.',
    '  - Browser+AI only ≠ Development → call it Research or Planning.',
    '  - Do NOT return "Building & Testing" without a code editor or terminal in the evidence.',
    '',
    `Duration: ${durationMinutes} minutes`,
    `Dominant category: ${block.dominantCategory}`,
    switchNote,
    '',
    websiteLines.length > 0 ? `Website evidence (highest priority):\n${websiteLines.join('\n')}` : 'Websites: none',
    pages.length > 0 ? `Window titles:\n${pages.map((p) => `  ${p}`).join('\n')}` : 'Window titles: none',
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

export async function generateWorkBlockInsight(
  block: WorkContextBlock,
  options?: { jobType?: 'block_label_preview' | 'block_label_finalize' | 'block_cleanup_relabel'; triggerSource?: 'system' | 'background' },
): Promise<WorkContextInsight> {
  const systemPrompt = [
    'You are Daylens.',
    'You label productivity timeline blocks from local activity evidence.',
    'Be concrete, restrained, and evidence-led.',
    'Never mention the model provider.',
    'If the evidence is weak, keep the label generic but still useful.',
    'Return only valid JSON.',
  ].join(' ')

  try {
    const { text } = await withTimeout(
      executeTextAIJob(
        {
          jobType: options?.jobType ?? (block.isLive ? 'block_label_preview' : 'block_label_finalize'),
          screen: 'timeline_day',
          triggerSource: options?.triggerSource ?? (block.isLive ? 'system' : 'background'),
          systemPrompt,
          userMessage: workBlockPrompt(block),
        },
        sendWithProvider,
      ),
      BLOCK_INSIGHT_TIMEOUT_MS,
      'Block insight timed out',
    )
    const parsed = parseWorkBlockInsight(text)

    const insight = {
      label: parsed?.label || userVisibleLabelForBlock(block),
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
  } catch {
    const insight = {
      label: userVisibleLabelForBlock(block),
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

const queuedBlockInsightJobs = new Set<string>()
let lastCleanupAnchorDate: string | null = null
const BLOCK_FINALIZE_QUIET_MS = 90_000
const CLEANUP_BLOCK_BATCH_SIZE = 12
const CLEANUP_BATCH_PAUSE_MS = 750

const cleanupQueueState: {
  active: boolean
  pendingDates: string[]
  pendingBlocks: WorkContextBlock[]
} = {
  active: false,
  pendingDates: [],
  pendingBlocks: [],
}
let cleanupQueueTimer: ReturnType<typeof setTimeout> | null = null

function resetCleanupQueue(): void {
  if (cleanupQueueTimer) {
    clearTimeout(cleanupQueueTimer)
    cleanupQueueTimer = null
  }
  cleanupQueueState.active = false
  cleanupQueueState.pendingDates = []
  cleanupQueueState.pendingBlocks = []
}

function markBlockCleanupReviewed(block: WorkContextBlock): void {
  upsertWorkContextCleanupReview(getDb(), {
    startMs: block.startTime,
    endMs: block.endTime,
    stableLabel: block.label.current,
    sourceBlockIds: [block.id],
  })
}

function fillCleanupQueue(): void {
  const db = getDb()
  while (cleanupQueueState.pendingBlocks.length === 0 && cleanupQueueState.pendingDates.length > 0) {
    const dateStr = cleanupQueueState.pendingDates.shift()
    if (!dateStr) break

    const payload = getTimelineDayPayload(db, dateStr, null)
    for (const block of payload.blocks) {
      const disposition = backgroundRelabelDispositionForBlock(block)
      if (disposition === 'review') {
        markBlockCleanupReviewed(block)
        continue
      }
      if (disposition === 'relabel') {
        cleanupQueueState.pendingBlocks.push(block)
      }
    }
  }
}

async function runBlockInsightJob(
  block: WorkContextBlock,
  jobType: 'block_label_finalize' | 'block_cleanup_relabel',
): Promise<void> {
  if (queuedBlockInsightJobs.has(`${jobType}:${block.id}`)) return
  queuedBlockInsightJobs.add(`${jobType}:${block.id}`)

  try {
    await generateWorkBlockInsight(block, { jobType, triggerSource: 'background' })
    invalidateProjectionScope('timeline', `ai:${jobType}`)
    invalidateProjectionScope('apps', `ai:${jobType}`)
    invalidateProjectionScope('insights', `ai:${jobType}`)
  } catch (error) {
    console.warn(`[ai] ${jobType} failed for block ${block.id}:`, error)
  } finally {
    queuedBlockInsightJobs.delete(`${jobType}:${block.id}`)
  }
}

async function processCleanupQueue(): Promise<void> {
  if (!cleanupQueueState.active) return
  if (!getSettings().aiBackgroundEnrichment) {
    resetCleanupQueue()
    return
  }

  try {
    fillCleanupQueue()
    if (cleanupQueueState.pendingBlocks.length === 0) {
      resetCleanupQueue()
      return
    }

    const batch = cleanupQueueState.pendingBlocks.splice(0, CLEANUP_BLOCK_BATCH_SIZE)
    for (const block of batch) {
      await runBlockInsightJob(block, 'block_cleanup_relabel')
    }

    fillCleanupQueue()
    if (cleanupQueueState.pendingBlocks.length === 0 && cleanupQueueState.pendingDates.length === 0) {
      resetCleanupQueue()
      return
    }

    cleanupQueueTimer = setTimeout(() => {
      cleanupQueueTimer = null
      void processCleanupQueue()
    }, CLEANUP_BATCH_PAUSE_MS)
  } catch (error) {
    console.warn('[ai] block cleanup sweep failed:', error)
    resetCleanupQueue()
  }
}

function scheduleOvernightCleanup(anchorDate: string): void {
  if (!getSettings().aiBackgroundEnrichment) return
  if (cleanupQueueState.active) {
    lastCleanupAnchorDate = anchorDate
    return
  }
  if (lastCleanupAnchorDate === anchorDate) return

  const pendingDates = listPendingWorkContextCleanupDates(getDb(), anchorDate)
  lastCleanupAnchorDate = anchorDate
  if (pendingDates.length === 0) return

  cleanupQueueState.active = true
  cleanupQueueState.pendingDates = pendingDates
  cleanupQueueState.pendingBlocks = []
  void processCleanupQueue()
}

export function scheduleTimelineAIJobs(payload: DayTimelinePayload): void {
  const settings = getSettings()
  if (!settings.aiBackgroundEnrichment) return

  const now = Date.now()
  for (const block of payload.blocks) {
    if (backgroundRelabelDispositionForBlock(block) !== 'relabel') continue
    if (now - block.endTime < BLOCK_FINALIZE_QUIET_MS) continue
    void runBlockInsightJob(block, 'block_label_finalize')
  }

  scheduleOvernightCleanup(currentLocalDateString())
}

export async function sendMessage(payload: AIChatSendRequest, options: SendMessageOptions = {}): Promise<AIChatTurnResult> {
  const userMessage = payload.message
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  let threadId = payload.threadId ?? null
  if (threadId == null) {
    // Silently create a thread titled from the first user message so legacy
    // call-sites that omit threadId still end up with durable thread rows.
    const created = createThread(deriveTitleFromMessage(userMessage))
    threadId = created.id
  } else {
    // Ensure the referenced thread exists; if not, fall back to a fresh one.
    const existing = getThread(threadId)
    if (!existing) {
      const created = createThread(deriveTitleFromMessage(userMessage))
      threadId = created.id
    } else {
      maybeRenameWeakThread(threadId, existing.title, userMessage)
    }
  }
  const history = getConversationMessages(db, conversationId)
  const stream = createChatStreamAccumulator(payload.clientRequestId ?? null, options)
  const restoredState = payload.contextOverride ?? restoreConversationState(conversationId)
  const restoredTemporalContext = deserializeTemporalContext(restoredState?.routingContext ?? null)
  const followUpResolution = resolveFollowUp(userMessage, restoredState, history)
  const effectiveUserMessage = followUpResolution.effectivePrompt
  const previousContext = followUpResolution.shouldResetContext
    ? null
    : (restoredTemporalContext
      ?? conversationTemporalContext.get(conversationId)
      ?? null)

  capture(ANALYTICS_EVENT.AI_FOLLOWUP_RESOLUTION, {
    kind: followUpResolution.kind,
    followup_class: followUpResolution.followUpClass,
    reused_context: followUpResolution.shouldReuseContext,
    reset_context: followUpResolution.shouldResetContext,
    answer_kind: restoredState?.answerKind ?? null,
    source_kind: restoredState?.sourceKind ?? null,
  })

  if (process.env.NODE_ENV === 'development') {
    console.log(`[ai:chat] ← "${userMessage.slice(0, 120)}"`)
  }

  const focusIntent = maybeHandleFocusIntent(effectiveUserMessage)
  if (focusIntent) {
    await stream.streamText(focusIntent.assistantText)
    return persistChatTurn(db, conversationId, userMessage, focusIntent, threadId)
  }

  const prior = sanitizeConversationHistory(history)
  const directReportEnvelope = await maybeGenerateRequestedOutput({
    question: effectiveUserMessage,
    restoredState,
    previousContext,
    routedContext: previousContext,
    routedAnswer: null,
    prior,
  })
  if (directReportEnvelope) {
    await stream.streamText(directReportEnvelope.assistantText)
    return persistChatTurn(db, conversationId, userMessage, directReportEnvelope, threadId)
  }

  const routed = await routeInsightsQuestion(effectiveUserMessage, new Date(), previousContext, db)
  const reportEnvelope = await maybeGenerateRequestedOutput({
    question: effectiveUserMessage,
    restoredState,
    previousContext,
    routedContext: routed?.resolvedContext ?? previousContext,
    routedAnswer: routed?.kind === 'answer' ? routed.answer : null,
    prior,
  })
  if (reportEnvelope) {
    await stream.streamText(reportEnvelope.assistantText)
    return persistChatTurn(db, conversationId, userMessage, reportEnvelope, threadId)
  }

  if (routed) {
    if (routed.kind === 'weeklyBrief') {
      const settings = getSettings()
      const chatProvider = settings.aiChatProvider ?? settings.aiProvider ?? 'anthropic'
      const chatModel = modelForProvider(chatProvider, 'quality', settings)
      let pack = routed.briefContext.evidenceKey ? weeklyBriefCache.get(routed.briefContext.evidenceKey) ?? null : null
      if (!pack) {
        pack = buildWeeklyBriefEvidencePack(db, routed.briefContext)
        weeklyBriefCache.set(pack.evidenceKey, pack)
      }
      const resolvedWeeklyContext: WeeklyBriefContext = {
        ...routed.briefContext,
        evidenceKey: pack.evidenceKey,
      }
      const { systemPrompt, userPrompt } = weeklyBriefPrompts(effectiveUserMessage, resolvedWeeklyContext, pack)
      if (process.env.NODE_ENV === 'development') {
        console.log(`[ai:chat] weekly brief → provider=${chatProvider} model=${chatModel} mode=${resolvedWeeklyContext.responseMode} key=${pack.evidenceKey}`)
      }
      const { text: assistantText } = await executeTextAIJob(
        {
          jobType: 'chat_answer',
          screen: 'ai_chat',
          triggerSource: 'user',
          systemPrompt,
          userMessage: userPrompt,
          prior,
        },
        sendWithProvider,
        { onDelta: (delta) => stream.push(delta) },
      )
      await stream.streamText(assistantText)
      if (!assistantText.trim()) {
        throw new Error('The AI returned an empty response. Please try again.')
      }
      const resolvedTemporalContext: TemporalContext = {
        ...routed.resolvedContext,
        weeklyBrief: resolvedWeeklyContext,
      }
      const answerKind = answerKindForWeeklyContext(resolvedWeeklyContext)
      const conversationState = buildConversationState(
        answerKind,
        'weekly_brief',
        resolvedTemporalContext,
        inferFollowUpAffordances(answerKind),
      )
      const suggestedFollowUps = await generateSuggestedFollowUps(userMessage, assistantText, answerKind, conversationState)
      return persistChatTurn(db, conversationId, userMessage, {
        assistantText,
        answerKind,
        sourceKind: 'weekly_brief',
        resolvedTemporalContext,
        conversationState,
        suggestedFollowUps,
      }, threadId)
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[ai:chat] router hit → "${routed.answer.slice(0, 120)}"`)
    }
    const answerKind: AIAnswerKind = 'deterministic_stats'
    const resolvedTemporalContext: TemporalContext = {
      ...routed.resolvedContext,
      weeklyBrief: null,
    }
    const conversationState = buildConversationState(
      answerKind,
      'deterministic',
      resolvedTemporalContext,
      inferFollowUpAffordances(answerKind),
      {
        dateRange: inferDateRangeFromQuestion(effectiveUserMessage, restoredState?.dateRange ?? null),
        topic: followUpResolution.shouldReuseContext ? restoredState?.topic ?? null : null,
        responseMode: null,
        lastIntent: followUpResolution.followUpClass,
        evidenceKey: null,
      },
    )
    const suggestedFollowUps = await generateSuggestedFollowUps(userMessage, routed.answer, answerKind, conversationState)
    await stream.streamText(routed.answer)
    return persistChatTurn(db, conversationId, userMessage, {
      assistantText: routed.answer,
      answerKind,
      sourceKind: 'deterministic',
      resolvedTemporalContext,
      conversationState,
      suggestedFollowUps,
    }, threadId)
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(`[ai:chat] router miss → falling back to LLM`)
  }

  const dayContext = buildDayContext()
  const allTimeContext = buildAllTimeContext()
  const specificTimeContext = buildSpecificTimeContext(userMessage)
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const attributionDayCtx = buildAttributionDayContext(todayStr)
  const attributionEntityCtx = buildAttributedEntityContext(userMessage)
  const settings = getSettings()
  const { userName } = settings
  const persona = userName
    ? `You are Daylens, a personal productivity coach helping ${userName} understand their time.`
    : `You are Daylens, a personal productivity coach embedded in a local screen-time tracker.`
  const preferredProvider = settings.aiChatProvider ?? settings.aiProvider ?? 'anthropic'
  const preferredConfig = {
    provider: preferredProvider,
    model: modelForProvider(preferredProvider, settings),
  }
  const systemPrompt =
    persona + ' You have access to tracked local activity data — app sessions, website visits, attributed work sessions, and recurring workflows.\n\n' +
    'Your job is to synthesize, not recite. The user can already see raw totals in the UI. They come to you to understand what the day actually looked like and what was getting done.\n\n' +
    'How to think:\n' +
    '- Work sessions are the primary data unit. They can carry attributed client/project context, confidence scores, app roles, and evidence trails. Use them when answering grounded questions about named workstreams.\n' +
    '- For attributed entity questions, use attributed work_sessions first. Report attributed hours first, then ambiguous time separately. Never silently include ambiguous time in attributed totals.\n' +
    '- Not every repo, class, research topic, or internal initiative has a first-class attribution record yet. When structured attribution is missing, ground the answer in blocks, artifacts, window titles, and websites instead of pretending the entity is fully attributed.\n' +
    '- Read the work-block structure for additional context. Blocks group related activity with labels, apps, and websites.\n' +
    '- Grounding contract: only mention a file, doc, page, repo, or project name if it appears verbatim in the evidence below (block labels, artifact titles, window titles, websites, or attributed work_sessions).\n' +
    '- If the evidence only shows an app or domain, keep the answer at that level. Do not invent repo names, filenames, meeting titles, or document titles.\n' +
    '- Connect apps to intent carefully: Chrome + docs.google.com + a specific title can indicate a document; Cursor + GitHub can indicate code work; Slack + a long block can indicate a conversation thread.\n' +
    '- Notice patterns: recurring workflows show habitual projects or rituals. Time-of-day shape shows when the user focuses vs. communicates.\n' +
    '- Prefer the specific over the generic. "Drafted the Q2 planning doc in Google Docs around 10-11am, then switched to Slack for 30m" beats "You spent 2h in Chrome."\n' +
    '- When the evidence is ambiguous, say "looks like" or "probably" rather than inventing specifics. Don\'t hallucinate project names or document titles that aren\'t in the evidence.\n' +
    '- You DO have access to all-time tracked data (see "Lifetime tracked data" below) and recent daily history, not just today. Never tell the user "I only have today\'s data" — that is false. If you\'ve already given a lifetime/weekly/yesterday answer earlier in this conversation, treat it as ground truth and use it for follow-ups (e.g. "how many days is that" → the tracking window stated above).\n\n' +
    'How to write:\n' +
    '- Conversational, grounded, slightly social — a thoughtful friend who reviewed your day, not a dashboard.\n' +
    '- Lead with the story of the day (what the user was doing and when), then surface totals only if the user asked or if a number matters.\n' +
    '- Keep it short. 2-5 sentences for most questions. Use bullet points only when listing distinct blocks or suggestions.\n' +
    '- Reference block time ranges and labels when they add specificity: "between 9:30 and 11:00 you were in a research block on arxiv and Claude".\n' +
    '- Never say "the user" — address them directly ("you").\n' +
    '- Always speak as Daylens, never as a raw model/provider persona.\n' +
    `- If asked what model is powering this chat: say you are Daylens, currently routed through ${providerLabel(preferredConfig.provider)} (${preferredConfig.model}).\n` +
    '- If the data genuinely doesn\'t answer the question, say so plainly and offer what you can infer.\n' +
    '- For recommendations, keep them concrete and tied to observed patterns — not generic productivity advice.\n\n' +
    (allTimeContext ? `Lifetime tracked data:\n${allTimeContext}\n\n` : '') +
    (dayContext
      ? `Today's tracked data:\n${dayContext}`
      : 'No activity has been recorded yet today. If the user asks about stats for today specifically, say tracking needs more time — but lifetime data above may still apply.') +
    (specificTimeContext ? `\n\nSpecific historical context:\n${specificTimeContext}` : '') +
    (attributionDayCtx ? `\n\nAttribution-layer work sessions (JSON):\n${attributionDayCtx}` : '') +
    (attributionEntityCtx ? `\n\nClient/project attribution context (JSON):\n${attributionEntityCtx}` : '')

  const chatProvider = settings.aiChatProvider ?? settings.aiProvider ?? 'anthropic'
  const chatModel = modelForProvider(chatProvider, 'quality', settings)
  if (process.env.NODE_ENV === 'development') {
    console.log(`[ai:chat] LLM call → provider=${chatProvider} model=${chatModel}`)
  }
  const { text: assistantText } = await executeTextAIJob(
    {
      jobType: 'chat_answer',
      screen: 'ai_chat',
      triggerSource: 'user',
      systemPrompt,
      userMessage: effectiveUserMessage,
      prior,
    },
    sendWithProvider,
    { onDelta: (delta) => stream.push(delta) },
  )
  await stream.streamText(assistantText)

  // Don't save an empty assistant response — it would corrupt future prior
  // history and cause the AI to receive empty content blocks.
  if (!assistantText.trim()) {
    throw new Error('The AI returned an empty response. Please try again.')
  }

  const answerKind: AIAnswerKind = 'freeform_chat'
  const resolvedTemporalContext: TemporalContext = followUpResolution.shouldReuseContext && previousContext
    ? previousContext
    : {
      date: new Date(),
      timeWindow: null,
      weeklyBrief: null,
      entity: null,
    }
  const conversationState = buildConversationState(
    answerKind,
    'freeform',
    resolvedTemporalContext,
    inferFollowUpAffordances(answerKind),
    {
      dateRange: inferDateRangeFromQuestion(effectiveUserMessage, followUpResolution.shouldReuseContext ? restoredState?.dateRange ?? null : null),
      topic: followUpResolution.shouldReuseContext ? restoredState?.topic ?? null : null,
      responseMode: followUpResolution.shouldReuseContext ? restoredState?.responseMode ?? null : null,
      lastIntent: followUpResolution.followUpClass,
      evidenceKey: followUpResolution.shouldReuseContext ? restoredState?.evidenceKey ?? null : null,
    },
  )
  const suggestedFollowUps = await generateSuggestedFollowUps(userMessage, assistantText, answerKind, conversationState)
  return persistChatTurn(db, conversationId, userMessage, {
    assistantText,
    answerKind,
    sourceKind: 'freeform',
    resolvedTemporalContext,
    conversationState,
    suggestedFollowUps,
  }, threadId)
}

export function getAIHistory(threadId?: number | null): AIThreadMessage[] {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  restoreConversationState(conversationId)
  if (threadId != null) {
    return getThreadMessages(db, threadId)
  }
  return getConversationMessages(db, conversationId)
}

export function getThreadHistory(threadId: number): AIThreadMessage[] {
  return getThreadMessages(getDb(), threadId)
}

export async function getWeekReview(weekStartStr: string): Promise<AISurfaceSummary | null> {
  return generateWeekReview(weekStartStr)
}

export async function getAppNarrative(
  canonicalAppId: string,
  days = 7,
): Promise<AISurfaceSummary | null> {
  return generateAppNarrative(canonicalAppId, days)
}

export function clearAIHistory(): void {
  const db = getDb()
  const conversationId = getOrCreateConversation(db)
  clearConversation(db, conversationId)
  conversationTemporalContext.delete(conversationId)
}

export async function testCLITool(tool: 'claude' | 'codex'): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
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
