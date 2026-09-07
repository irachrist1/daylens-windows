import { app, ipcMain } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentTurnCheckpointView, AIAgentQuestionEvent } from '@shared/types'
import { cancelAIRequest, pauseAIRequest } from '../lib/aiCancellation'
import { closeTurnCheckpoint, listPausedTurns } from '../services/agentTurnState'
import { getModelCostCatalog, type ModelCatalogRequestEntry } from '../services/modelCatalog'
import { appendDeletionJournalEntry } from '../services/deletionJournal'
import { getThreadMessagesPage, updateAIMessageFeedback, writeAIBlockLabel } from '../db/queries'
import { getDb } from '../services/database'
import { uploadRatedAIMessageFeedback } from '../services/aiFeedbackUpload'
import {
  detectCLITools,
  getAppNarrative,
  generateDaySummary,
  generateWorkBlockInsight,
  getStarterSuggestions,
  getWeekReview,
  sendMessage,
  suggestAppCategory,
  testCLITool,
} from '../services/ai'
import { getWrappedNarrative } from '../services/wrappedNarrative'
import { getWrappedPeriodWrap } from '../services/wrappedPeriodNarrative'
import { listDayAnalysisVersions } from '../db/dayAnalysisVersions'
import { computePeriodRange } from '../lib/wrappedPeriodRange'
import { askWrappedQuestion } from '../services/wrappedQuestion'
import { getWrapProviderState } from '../services/aiOrchestration'
import { getWrapPreflight } from '../services/wrapPreflight'
import { markRecapGenerated } from '../services/dailySummaryNotifier'
import { getTimelineDayPayload, getBlockDetailPayload } from '../services/workBlocks'
import { commitAction, recordMemoryProposalDismissal, undoAction } from '../ai/actions'
import {
  getContextPacketById,
  getContextPacketForMessage,
  listContextPackets,
  type ContextPacketExchangeKind,
} from '../services/contextPacket'
import {
  inspectContextPacket,
  listContextPacketEntries,
} from '../services/contextPacketInspection'
import { getCurrentSession } from '../services/tracking'
import { materializeTimelineDayProjection } from '../core/query/projections'
import { localDateString } from '../lib/localDate'
import {
  archiveThread,
  deleteThread,
  getThread,
  getThreadSettings,
  listThreadsLite,
  openArtifact,
  renameThread,
  setThreadSettings,
} from '../services/artifacts'
import { IPC, type AIActionCommitResult, type AIActionUndo, type AIActionWidget, type AIChatSendRequest, type AIStarterSuggestionResult, type AIThreadDetail, type AIThreadPageRequest, type AIThreadSettings, type AIThreadSummary, type McpActivityLog, type WorkContextBlock, type WrappedAskRequest, type WrappedPeriod } from '@shared/types'
import { mcpActivityLogPath, readMcpActivity } from '@shared/mcpActivityLog'
import { isRealDayHarness } from '../lib/realDayHarness'

// Opening a conversation loads only this many of its newest messages; the
// renderer pages older ones in with "Load earlier messages".
const DEFAULT_THREAD_PAGE_SIZE = 60

function toThreadSummary(row: ReturnType<typeof listThreadsLite>[number]): AIThreadSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    archived: row.archived,
    messageCount: row.messageCount,
    lastSnippet: row.lastSnippet,
  }
}

// The agent's clarifying questions: the ask_user tool pauses the
// loop on a promise; the renderer shows the question card and answers over
// AGENT_ANSWER, which resolves it. A timeout resolves with a no-answer note so
// an unanswered question can never hang a turn forever.
const pendingAgentQuestions = new Map<string, (answer: string) => void>()
const AGENT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000

export function registerAIHandlers(): void {
  // DEV-181: fetch the recorded context packet behind an AI exchange, so the
  // renderer can show exactly what the model was given for an answer.
  ipcMain.handle(IPC.CONTEXT_PACKETS.GET, (_e, packetId: string) => {
    return getContextPacketById(getDb(), packetId)
  })

  ipcMain.handle(IPC.CONTEXT_PACKETS.GET_FOR_MESSAGE, (_e, messageId: number) => {
    return getContextPacketForMessage(getDb(), messageId)
  })

  ipcMain.handle(IPC.CONTEXT_PACKETS.LIST, (
    _e,
    payload: { limit?: number; exchangeKind?: ContextPacketExchangeKind; scopeKey?: string } = {},
  ) => {
    return listContextPackets(getDb(), payload)
  })

  // DEV-183: the read-only inspection behind Sources for this answer — the recorded
  // packet grouped per kind, with plain-language omissions and each item
  // checked against the evidence backing it today. Null when no packet was
  // recorded for the reference; the renderer states that honestly.
  ipcMain.handle(IPC.CONTEXT_PACKETS.INSPECT, (
    _e,
    payload: { packetId?: string | null; messageId?: number | null },
  ) => {
    return inspectContextPacket(getDb(), payload)
  })

  // DEV-183: light rows for the packet browser — question, time, item counts.
  ipcMain.handle(IPC.CONTEXT_PACKETS.LIST_ENTRIES, (_e, payload: { limit?: number } = {}) => {
    return listContextPacketEntries(getDb(), payload)
  })

  ipcMain.handle(IPC.AI.SEND_MESSAGE, async (event, payload: AIChatSendRequest) => {
    return sendMessage(payload, {
      onStreamEvent: (streamEvent) => {
        event.sender.send(IPC.AI.STREAM_EVENT, streamEvent)
      },
      // DEV-200: the turn's one visible state machine — running / waiting on
      // a card / paused / terminal — pushed as it transitions.
      onPhaseEvent: (phaseEvent) => {
        event.sender.send(IPC.AI.TURN_PHASE, phaseEvent)
      },
      onAgentQuestion: (question) => new Promise<string>((resolve) => {
        const questionId = randomUUID()
        const timeout = setTimeout(() => {
          pendingAgentQuestions.delete(questionId)
          resolve('(No answer arrived — pick the most defensible reading, answer it, and say in one clause what you assumed.)')
        }, AGENT_QUESTION_TIMEOUT_MS)
        pendingAgentQuestions.set(questionId, (answer) => {
          clearTimeout(timeout)
          pendingAgentQuestions.delete(questionId)
          resolve(answer)
        })
        const questionEvent: AIAgentQuestionEvent = {
          questionId,
          requestId: payload.clientRequestId ?? null,
          question: question.question,
          options: question.options,
          allowFreeText: question.allowFreeText,
        }
        event.sender.send(IPC.AI.AGENT_QUESTION, questionEvent)
      }),
    })
  })

  ipcMain.handle(IPC.AI.AGENT_ANSWER, (_e, payload: { questionId: string; answer: string }): boolean => {
    const resolver = pendingAgentQuestions.get(payload.questionId)
    if (!resolver) return false
    resolver(payload.answer)
    return true
  })

  // Aborts the in-flight provider request for this turn.
  // Returns whether a matching turn was still running.
  ipcMain.handle(IPC.AI.CANCEL_MESSAGE, (_e, payload: { clientRequestId: string }): boolean => {
    return cancelAIRequest(payload.clientRequestId)
  })

  // DEV-200: pause the in-flight turn. The provider stream stops like a
  // cancel, but the turn settles as a persisted checkpoint the user can
  // resume — including after an app restart. Cancel stays distinct.
  ipcMain.handle(IPC.AI.PAUSE_MESSAGE, (_e, payload: { clientRequestId: string }): boolean => {
    return pauseAIRequest(payload.clientRequestId)
  })

  // DEV-200: the paused turns of a thread (or all threads), for rendering
  // resumable rows when a conversation is opened after a pause or restart.
  ipcMain.handle(IPC.AI.LIST_PAUSED_TURNS, (_e, payload: { threadId?: number | null } = {}): AgentTurnCheckpointView[] => {
    return listPausedTurns(getDb(), payload.threadId ?? null)
  })

  // DEV-200: discard a paused turn — the explicit "don't resume this" choice.
  ipcMain.handle(IPC.AI.DISCARD_PAUSED_TURN, (_e, payload: { checkpointId: string }): boolean => {
    return closeTurnCheckpoint(getDb(), payload.checkpointId)
  })

  // DEV-201: per-model cost lines (typical question in USD + questions per
  // dollar) and the managed allowance in money and estimated questions.
  ipcMain.handle(IPC.AI.GET_MODEL_COSTS, async (_e, payload: { models: ModelCatalogRequestEntry[] }) => {
    return getModelCostCatalog(payload.models ?? [])
  })

  ipcMain.handle(IPC.AI.GET_STARTER_SUGGESTIONS, async (): Promise<AIStarterSuggestionResult> => {
    return getStarterSuggestions()
  })

  // DEV-109: commit an AI action proposal — the user confirmed the preview
  // widget, so now run the real change through the manual-edit pipeline. The
  // proposal carries everything needed; nothing was written before this call.
  ipcMain.handle(IPC.AI.COMMIT_ACTION, (_e, action: AIActionWidget): AIActionCommitResult => {
    const result = commitAction(getDb(), action)
    // A confirmed chat delete of a supplied fact is a user-initiated
    // destructive deletion — journal it so a backup restore replays it
    // (DEV-220 semantics, DEV-185 supplied memory).
    if (result.ok && action.kind === 'memory_write') {
      for (const op of action.ops) {
        if (op.op === 'delete' && op.targetId?.startsWith('smf_')) {
          appendDeletionJournalEntry(app.getPath('userData'), {
            kind: 'supplied-fact',
            params: { factId: op.targetId },
          })
        }
      }
    }
    return result
  })

  // The user cancelled a proposal card. For memory previews that is a
  // decision, not silence: the proposed facts are recorded as rejections so
  // the same fact is not proposed again without new evidence (DEV-185).
  ipcMain.handle(IPC.AI.DISMISS_ACTION, (_e, action: AIActionWidget): void => {
    if (action.kind === 'memory_write') {
      recordMemoryProposalDismissal(getDb(), action)
    }
  })

  ipcMain.handle(IPC.AI.UNDO_ACTION, (_e, undo: AIActionUndo): AIActionCommitResult => {
    return undoAction(getDb(), undo)
  })

  ipcMain.handle(IPC.AI.SET_MESSAGE_FEEDBACK, (_e, payload: { messageId: number; rating: 'up' | 'down' | null }) => {
    const db = getDb()
    const updated = updateAIMessageFeedback(db, payload.messageId, payload.rating)
    if (updated && payload.rating) {
      void uploadRatedAIMessageFeedback(db, payload.messageId, payload.rating)
    }
    return updated
  })

  ipcMain.handle(IPC.AI.GENERATE_DAY_SUMMARY, async (_e, date: string) => {
    const result = await generateDaySummary(date)
    // Record that the user generated a recap for this day: suppresses the next
    // morning's "yesterday's recap" notification (§4.1) and freezes the day's
    // snapshot so wraps sum a finalized day (invariant 4).
    markRecapGenerated(date)
    return result
  })

  ipcMain.handle(IPC.AI.GET_WEEK_REVIEW, async (_e, payload: { weekStart: string; force?: boolean }) => {
    return getWeekReview(payload.weekStart, payload.force ?? false)
  })

  ipcMain.handle(IPC.AI.GET_APP_NARRATIVE, async (
    _e,
    payload: { canonicalAppId: string; daysOrDate?: number | string; days?: number; force?: boolean },
  ) => {
    // `days` remains a compatibility fallback for callers from older renderer
    // bundles during development hot reloads.
    return getAppNarrative(
      payload.canonicalAppId,
      payload.daysOrDate ?? payload.days ?? 7,
      payload.force ?? false,
    )
  })

  ipcMain.handle(IPC.AI.GET_WRAPPED_NARRATIVE, async (_e, payload: { date: string; force?: boolean }) => {
    const today = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const liveSession = payload.date === today ? getCurrentSession() : null
    const dayPayload = getTimelineDayPayload(getDb(), payload.date, liveSession)
    return getWrappedNarrative(dayPayload, { triggerSource: 'user', force: payload.force === true })
  })

  ipcMain.handle(IPC.AI.GET_WRAPPED_PERIOD_NARRATIVE, async (_e, payload: { period: WrappedPeriod; anchorDate: string; force?: boolean }) => {
    return getWrappedPeriodWrap(payload.period, payload.anchorDate, { triggerSource: 'user', force: payload.force === true })
  })

  ipcMain.handle(IPC.AI.GET_WRAP_PROVIDER_STATE, async () => {
    return getWrapProviderState()
  })

  // DEV-206: the version history of a day's AI analyses — every generation of
  // the day wrap and every timeline regroup/relabel run, newest first, with
  // facts hash, model, prompt version, and why each version replaced the last.
  // Old versions stay inspectable; retirements name the correction that
  // invalidated them. With `period` set, serves the period wrap's history
  // instead (rows are keyed by the period's start date, derived here from the
  // same range math the wrap itself uses).
  ipcMain.handle(IPC.AI.GET_DAY_ANALYSIS_HISTORY, (_e, payload: { date: string; period?: WrappedPeriod }) => {
    const db = getDb()
    if (payload.period) {
      const periodKey = computePeriodRange(payload.period, payload.date).startDate
      return { day: listDayAnalysisVersions(db, payload.period, periodKey), timeline: [] }
    }
    return {
      day: listDayAnalysisVersions(db, 'day', payload.date),
      timeline: listDayAnalysisVersions(db, 'timeline', payload.date),
    }
  })

  // Pre-flight data quality check: honest, specific
  // warnings before the first generation. Never blocks; the renderer offers a
  // one-tap "Generate anyway".
  ipcMain.handle(IPC.AI.GET_WRAP_PREFLIGHT, async (_e, payload: { date: string }) => {
    return getWrapPreflight(getDb(), payload.date)
  })

  // Ask-anything on a wrap slide (and answering the wrap's own question). One
  // short user-triggered call; no thread is created and nothing is persisted.
  ipcMain.handle(IPC.AI.ASK_WRAPPED, async (_e, payload: WrappedAskRequest) => {
    return askWrappedQuestion(payload)
  })

  ipcMain.handle(IPC.AI.GENERATE_BLOCK_INSIGHT, async (_e, block: WorkContextBlock) => {
    return generateWorkBlockInsight(block, { triggerSource: 'user' })
  })

  ipcMain.handle(IPC.AI.REGENERATE_BLOCK_LABEL, async (_e, blockId: string) => {
    // Load the block on the main side from its id instead of shipping the whole
    // WorkContextBlock (nested sessions, artifacts, websites) across IPC (F44).
    const db = getDb()
    const block = getBlockDetailPayload(db, blockId, getCurrentSession())
    if (!block) throw new Error('Block not found.')

    // Per-block "Regenerate" is the explicit "this label is wrong, fix it"
    // action. Tell the model which label was rejected so it doesn't hand back
    // the same one, then write with force so the redo overrides the existing
    // label.
    const rejectedLabel = block.label.override?.trim() || block.label.current?.trim() || block.aiLabel?.trim()
    const insight = await generateWorkBlockInsight(
      { ...block, label: { ...block.label, override: null } },
      { jobType: 'block_label_finalize', triggerSource: 'user', throwOnError: true, rejectedLabel },
    )
    const label = insight.label?.trim()
    if (!label) throw new Error('AI did not return a label.')

    const blockDate = localDateString(new Date(block.startTime))
    materializeTimelineDayProjection(db, blockDate, blockDate === localDateString() ? getCurrentSession() : null)
    const wrote = writeAIBlockLabel(db, {
      blockId: block.id,
      label,
      narrative: insight.narrative ?? null,
      force: true,
    })
    if (!wrote) {
      throw new Error('AI label could not be persisted. Reopen the timeline and try again.')
    }

    return insight
  })

  ipcMain.handle(IPC.AI.SUGGEST_APP_CATEGORY, async (_e, bundleId: string, appName: string) => {
    return suggestAppCategory(bundleId, appName)
  })

  ipcMain.handle(IPC.AI.DETECT_CLI_TOOLS, async () => {
    return detectCLITools()
  })

  ipcMain.handle(IPC.AI.TEST_CLI_TOOL, async (_e, payload: { tool: 'claude' | 'chatgpt' | 'gemini' | 'codex' }) => {
    return testCLITool(payload.tool)
  })

  // ─── Threads ──────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.AI.LIST_THREADS, (_e, payload?: { includeArchived?: boolean }): AIThreadSummary[] => {
    return listThreadsLite({ includeArchived: payload?.includeArchived ?? false }).map(toThreadSummary)
  })

  ipcMain.handle(IPC.AI.GET_THREAD, (_e, payload: AIThreadPageRequest): AIThreadDetail => {
    const row = getThread(payload.threadId)
    if (!row) return { thread: null, messages: [], hasEarlier: false }
    const page = getThreadMessagesPage(getDb(), payload.threadId, {
      limit: payload.limit ?? DEFAULT_THREAD_PAGE_SIZE,
      before: payload.before ?? null,
    })
    return { thread: toThreadSummary(row), messages: page.messages, hasEarlier: page.hasEarlier }
  })

  ipcMain.handle(IPC.AI.ARCHIVE_THREAD, (_e, payload: { threadId: number; archived: boolean }) => {
    archiveThread(payload.threadId, payload.archived)
  })

  ipcMain.handle(IPC.AI.RENAME_THREAD, (_e, payload: { threadId: number; title: string }) => {
    renameThread(payload.threadId, payload.title)
  })

  ipcMain.handle(IPC.AI.DELETE_THREAD, (_e, payload: { threadId: number }) => {
    return deleteThread(payload.threadId)
  })

  // D4: per-thread model/provider override + additional instructions.
  ipcMain.handle(IPC.AI.GET_THREAD_SETTINGS, (_e, payload: { threadId: number }): AIThreadSettings => {
    return getThreadSettings(payload.threadId)
  })

  ipcMain.handle(IPC.AI.SET_THREAD_SETTINGS, (_e, payload: { threadId: number; settings: AIThreadSettings }): AIThreadSettings => {
    return setThreadSettings(payload.threadId, payload.settings)
  })

  // ─── Artifacts ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.AI.OPEN_ARTIFACT, async (_e, payload: { artifactId: number }) => {
    return openArtifact(payload.artifactId)
  })

  ipcMain.handle(IPC.AI.GET_MCP_ACTIVITY, (): McpActivityLog => {
    if (isRealDayHarness()) return { entries: [] }
    const dbPath = path.join(app.getPath('userData'), 'daylens.sqlite')
    return { entries: readMcpActivity(mcpActivityLogPath(dbPath)) }
  })
}
