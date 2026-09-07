import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ANALYTICS_EVENT, classifyAIOutputIntent } from '@shared/analytics'
import { transformKindFromLabel, transformLabel } from '@shared/answerTransforms'
import type {
  AIActionUndo,
  AIActionWidget,
  AIChatTurnResult,
  AIMessageAction,
  AIProviderMode,
  AIThreadSummary,
  AppSettings,
  BillingAccessSnapshot,
  FocusSession,
  AIAgentQuestionEvent,
  AIAgentTurnPhaseEvent,
  AgentTurnWaitKind,
} from '@shared/types'
import { useProjectionResource } from '../../hooks/useProjectionResource'
import { track } from '../../lib/analytics'
import { ipc } from '../../lib/ipc'
import { AI_PROVIDER_META, getSelectedModel } from '../../lib/aiProvider'
import { sanitizeIpcError } from '../../lib/ipcError'
import { sanitizeForRender } from '../../../shared/aiSanitize'
import { clearStreamingSnapshot, setStreamingSnapshot } from './streamingStore'
import {
  appendPausedCheckpoints,
  attachPausedCheckpointId,
  beginTurn,
  cancelTurn,
  classifyTurnFailure,
  completeTurn,
  failTurn,
  pauseTurn,
  prependEarlierMessages,
  removeTurn,
  shouldAdoptThreadAfterTurn,
} from './chatTurns'
import {
  actionFeedbackKey,
  messageActionKey,
  threadMessagesFromHistory,
  type ActionFeedbackEntry,
  type AltProvider,
  type AnswerTransform,
  type ActionWidgetStateEntry,
  type MessageAction,
  type MessageActionStateEntry,
  type ThreadMessage,
} from './types'


// Providers we can offer as a one-tap switch on a hard wall. CLI providers are
// only surfaced when actually detected on the machine (see the load probe).
const SWITCHABLE_PROVIDERS: AIProviderMode[] = ['anthropic', 'openai', 'google', 'openrouter', 'claude-cli', 'chatgpt-cli', 'gemini-cli', 'codex-cli']
const API_PROVIDERS: AIProviderMode[] = ['anthropic', 'openai', 'google', 'openrouter']

// The thread list includes archived threads (the sidebar shows an Archive
// section), so "adopt a thread" must skip archived ones.
function firstActiveThreadId(rows: AIThreadSummary[]): number | null {
  return rows.find((row) => !row.archived)?.id ?? null
}

// Remembered across remounts (switching away from the AI tab and back) within a
// session, so returning restores what you were on — including a fresh, unsent
// new chat — instead of always re-adopting the most recent conversation.
// `undefined` = never set this session (first open → adopt most recent);
// `null` = you were on a new chat (stay empty).
let rememberedThreadId: number | null | undefined = undefined

type ProviderSnapshot = {
  settings: AppSettings
  cliTools: { claude: string | null; chatgpt: string | null; gemini: string | null; codex: string | null }
  hasProviderAccess: boolean
  // Per-provider key/tool availability, so the error card can offer a
  // concrete one-tap switch on a hard wall.
  providerAvailability: Partial<Record<AIProviderMode, boolean>>
  activeFocusSession: FocusSession | null
  billingAccess: BillingAccessSnapshot
}

// Also remembered across remounts. The probe below re-runs on every mount and
// its slowest leg reaches the billing service over the network, so a tab switch
// would otherwise drop the whole view back to "provider unknown" for as long as
// that call takes. The last verdict of the session stands in until the fresh
// one lands.
let lastProviderSnapshot: ProviderSnapshot | null = null

type SendOptions = {
  contextOverride?: ThreadMessage['contextSnapshot']
  trigger?: 'freeform' | 'suggested' | 'retry' | 'resume'
  // Bounds the rate-limit auto-retry so it fires at most once per turn.
  autoRetryCount?: number
  // When set, the main process rewrites the prior answer into this form.
  transform?: AnswerTransform | null
  // DEV-200: this send resumes the given paused checkpoint — the main process
  // adopts it, rebuilds the context packet fresh, and deletes it on success.
  resumeOfCheckpointId?: string | null
}

/** The in-flight turn's visible state, from the main-process phase events. */
export type TurnPhaseState = {
  phase: 'running' | 'awaiting_user'
  waitKind: AgentTurnWaitKind | null
}

// A turn that never resolves must still leave "Thinking" — convert a stuck
// pending row into a retryable error after this ceiling.
const SEND_TIMEOUT_MS = 90_000

function isCliProvider(provider: string | undefined | null): boolean {
  return provider === 'claude-cli' || provider === 'chatgpt-cli' || provider === 'gemini-cli' || provider === 'codex-cli'
}

function cliToolForProvider(provider: AIProviderMode): 'claude' | 'chatgpt' | 'gemini' | 'codex' | null {
  if (provider === 'claude-cli') return 'claude'
  if (provider === 'chatgpt-cli') return 'chatgpt'
  if (provider === 'gemini-cli') return 'gemini'
  if (provider === 'codex-cli') return 'codex'
  return null
}

export function useAIChat() {
  const location = useLocation()
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadsHydrated, setThreadsHydrated] = useState(false)
  const [threads, setThreads] = useState<AIThreadSummary[]>([])
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null)
  const [isNewChatDraft, setIsNewChatDraft] = useState(rememberedThreadId === null)
  // Opening a conversation loads only its newest page of messages; these track
  // whether older ones exist and whether an earlier page is in flight.
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [actionFeedback, setActionFeedback] = useState<Record<string, ActionFeedbackEntry>>({})
  const [messageActionState, setMessageActionState] = useState<Record<string, MessageActionStateEntry>>({})
  const [actionWidgetState, setActionWidgetState] = useState<Record<string, ActionWidgetStateEntry>>({})
  const [reducedMotion, setReducedMotion] = useState(false)
  // The agent's pending clarifying question, if any.
  const [agentQuestion, setAgentQuestion] = useState<AIAgentQuestionEvent | null>(null)
  // The in-flight turn's phase (DEV-200): running vs waiting on a card. One
  // visible state machine — the paused state lives on the message row itself.
  const [turnPhase, setTurnPhase] = useState<TurnPhaseState | null>(null)

  const loadingRef = useRef(false)
  loadingRef.current = loading
  // The turn currently in flight, so Stop knows which request to abort — and
  // which synthetic rows to flip to `cancelled`.
  const inFlightTurnRef = useRef<{ requestId: string; assistantId: string; userId: string; prompt: string } | null>(null)
  // Requests the user cancelled: when their promise later settles (resolve OR
  // reject), the result is dropped so a cancelled turn never mutates the view.
  const cancelledRequestsRef = useRef<Set<string>>(new Set())
  // Requests the user PAUSED (DEV-200): the row already shows its paused
  // state, so the turn's paused rejection is swallowed, never an error card.
  const pausedRequestsRef = useRef<Set<string>>(new Set())
  // Track the most recently requested thread so a slow getThread response for
  // a thread the user already navigated away from never clobbers the view.
  const latestRequestedThreadRef = useRef<number | null>(null)
  // Pending rate-limit auto-retry timers, cleared on unmount / new sends.
  const autoRetryTimeoutsRef = useRef<Record<string, number>>({})
  const actionFeedbackTimeoutsRef = useRef<Record<string, number>>({})
  const suggestionImpressionsRef = useRef<Record<string, boolean>>({})
  const aiScreenTrackedRef = useRef(false)
  const routedReportKeyRef = useRef<string | null>(null)
  const threadsHydratedRef = useRef(false)
  const navigationVersionRef = useRef(0)

  // Provider + environment load. Deliberately NOT keyed on activeThreadId and
  // deliberately free of the today-timeline rebuild + recap range the old tab
  // pulled on mount — those are the expensive projections the perf map flags.
  // CLI detection (which spawns child processes) only runs when a CLI provider
  // is actually selected.
  const providerResource = useProjectionResource<ProviderSnapshot>({
    scope: 'insights',
    load: async () => {
      const currentSettings = await ipc.settings.get()
      const chatProvider = currentSettings.aiChatProvider ?? currentSettings.aiProvider
      const providersToCheck = Array.from(new Set([
        chatProvider,
        ...(currentSettings.aiFallbackOrder ?? []),
      ]))
      const needsCliDetection = providersToCheck.some(isCliProvider)

      // Probe every API provider's key once (cheap keytar reads) so we know
      // which alternates we can offer; CLI detection still only runs when a CLI
      // provider is actually in play (it spawns child processes).
      const [cliToolsResult, apiKeyResults, activeFocusSession, billingAccess] = await Promise.all([
        needsCliDetection
          ? ipc.ai.detectCliTools().catch(() => ({ claude: null, chatgpt: null, gemini: null, codex: null }))
          : Promise.resolve({ claude: null, chatgpt: null, gemini: null, codex: null }),
        Promise.all(API_PROVIDERS.map((provider) => ipc.settings.hasApiKey(provider).catch(() => false))),
        ipc.focus.getActive().catch(() => null),
        ipc.billing.getAccess(),
      ])

      const providerAvailability: Partial<Record<AIProviderMode, boolean>> = {}
      API_PROVIDERS.forEach((provider, index) => { providerAvailability[provider] = apiKeyResults[index] })
      for (const provider of SWITCHABLE_PROVIDERS) {
        const tool = cliToolForProvider(provider)
        if (tool) providerAvailability[provider] = !!cliToolsResult[tool]
      }

      const providerAccess = billingAccess.canUseAI
        || providersToCheck.some((provider) => providerAvailability[provider] ?? false)

      return {
        settings: currentSettings,
        cliTools: cliToolsResult as { claude: string | null; chatgpt: string | null; gemini: string | null; codex: string | null },
        hasProviderAccess: providerAccess,
        providerAvailability,
        activeFocusSession: activeFocusSession as FocusSession | null,
        billingAccess,
      }
    },
    dependencies: [],
  })

  const providerData = providerResource.data ?? lastProviderSnapshot
  useEffect(() => {
    if (providerResource.data) lastProviderSnapshot = providerResource.data
  }, [providerResource.data])

  const settings = providerData?.settings ?? null
  const cliTools = providerData?.cliTools ?? null
  const hasApiKey = providerData ? providerData.hasProviderAccess : null
  const activeFocusSession = providerData?.activeFocusSession ?? null
  const billingAccess = providerData?.billingAccess ?? null
  // `refresh` is stable across renders (useProjectionResource memoizes it), so
  // handlers can depend on it without churning their own identity each render.
  const refreshProvider = providerResource.refresh

  const activeProvider = settings ? (settings.aiChatProvider ?? settings.aiProvider) : null
  const activeModel = settings && activeProvider
    ? getSelectedModel({
        aiProvider: activeProvider,
        anthropicModel: settings.anthropicModel,
        openaiModel: settings.openaiModel,
        googleModel: settings.googleModel,
        openrouterModel: settings.openrouterModel,
      })
    : null

  // Other configured providers we can offer as a one-tap switch when the
  // selected one hits a hard wall (quota/credit/auth). Never auto-routed.
  const providerAvailability = providerData?.providerAvailability ?? {}
  const alternateProviders = useMemo<AltProvider[]>(() => {
    if (!activeProvider) return []
    return SWITCHABLE_PROVIDERS
      .filter((provider) => provider !== activeProvider && (providerAvailability[provider] ?? false))
      .map((provider) => ({ provider, label: AI_PROVIDER_META[provider].shortLabel }))
  }, [activeProvider, providerAvailability])
  const alternateProvidersRef = useRef<AltProvider[]>([])
  alternateProvidersRef.current = alternateProviders

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  )
  const activeThreadLabel = activeThread && activeThread.title.trim() && activeThread.title !== 'New chat'
    ? activeThread.title
    : null

  const answerAgentQuestion = useCallback(async (answer: string) => {
    const pending = agentQuestion
    if (!pending) return
    setAgentQuestion(null)
    try {
      await ipc.ai.answerAgentQuestion({ questionId: pending.questionId, answer })
    } catch {
      // The turn may have finished or been cancelled; nothing to recover.
    }
  }, [agentQuestion])

  const dismissAgentQuestion = useCallback(() => {
    // Dismissing tells the agent to proceed with its best reading rather than
    // leaving the turn paused until the timeout.
    void answerAgentQuestion('(Dismissed — pick the most defensible reading, answer it, and say in one clause what you assumed.)')
  }, [answerAgentQuestion])

  const analyticsContext = useCallback((extra: Record<string, unknown> = {}) => ({
    has_ai_provider: Boolean(hasApiKey),
    ...(activeModel ? { model: activeModel } : {}),
    ...(activeProvider ? { provider: activeProvider } : {}),
    surface: 'ai',
    ...extra,
  }), [hasApiKey, activeModel, activeProvider])

  // ── Streaming: snapshots flow into a per-message store; only <StreamingMessage>
  // re-renders on a chunk, never this hook's consumers or the composer.
  useEffect(() => {
    return ipc.ai.onStream((event) => {
      const { text: safeSnapshot, report } = sanitizeForRender(event.snapshot ?? '')
      if (report.redactionCount > 0) {
        track(ANALYTICS_EVENT.AI_OUTPUT_REDACTED, {
          surface: 'ai_chat',
          request_id: event.requestId,
          redaction_count: report.redactionCount,
          patterns_hit: report.patternsHit,
        })
      }
      const safeStep = event.step
        ? { ...event.step, label: sanitizeForRender(event.step.label).text }
        : undefined
      setStreamingSnapshot(`assistant:${event.requestId}`, safeSnapshot, event.status, safeStep)
    })
  }, [])

  // The agent's clarifying question: shown as a card; answering resumes the
  // paused turn in main. Cleared when the turn ends either way.
  useEffect(() => {
    return ipc.ai.onAgentQuestion((event) => {
      setAgentQuestion(event)
    })
  }, [])

  // The turn's state machine (DEV-200): phase transitions pushed from main.
  // running / awaiting_user drive the live state line; 'paused' confirms the
  // persisted checkpoint id on the (already optimistically paused) row.
  useEffect(() => {
    return ipc.ai.onTurnPhase((event: AIAgentTurnPhaseEvent) => {
      const inFlight = inFlightTurnRef.current
      if (event.phase === 'paused') {
        if (event.checkpointId) {
          const assistantId = `assistant:${event.requestId}`
          setMessages((current) => attachPausedCheckpointId(current, assistantId, event.checkpointId!))
        }
        return
      }
      // Phase lines only describe the CURRENT in-flight turn.
      if (!inFlight || inFlight.requestId !== event.requestId) return
      if (event.phase === 'running' || event.phase === 'awaiting_user') {
        setTurnPhase({ phase: event.phase, waitKind: event.waitKind })
      } else {
        setTurnPhase(null)
      }
    })
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => () => {
    for (const timeout of Object.values(actionFeedbackTimeoutsRef.current)) {
      window.clearTimeout(timeout)
    }
    for (const timeout of Object.values(autoRetryTimeoutsRef.current)) {
      window.clearTimeout(timeout)
    }
  }, [])

  const loadThread = useCallback(async (threadId: number) => {
    // Selecting a thread must load ITS messages, not just update the header.
    // A guard that dropped the fetched messages whenever a send was in flight
    // caused exactly the "header changes, body stays empty" bug. Instead
    // stale-guard by thread id: only the latest requested thread may write.
    setActiveThreadId(threadId)
    setIsNewChatDraft(false)
    rememberedThreadId = threadId
    latestRequestedThreadRef.current = threadId
    setThreadLoading(true)
    setHasEarlierMessages(false)
    try {
      // Paused turns ride along with the history (DEV-200): a turn paused in
      // an earlier session — or interrupted by a restart — reappears as a
      // resumable row at the end of the conversation, never silently lost.
      const [detail, pausedTurns] = await Promise.all([
        ipc.ai.getThread(threadId),
        ipc.ai.listPausedTurns(threadId).catch(() => []),
      ])
      if (latestRequestedThreadRef.current !== threadId) return
      setMessages(appendPausedCheckpoints(threadMessagesFromHistory(detail.messages), pausedTurns))
      setHasEarlierMessages(detail.hasEarlier)
    } catch (error) {
      // Surface the failure as an inline error rather than silently keeping a
      // mismatched view — no raw IPC text.
      if (latestRequestedThreadRef.current !== threadId) return
      const { message } = sanitizeIpcError(error, "Couldn't load this conversation. Try again.")
      setMessages([{ id: `thread-error:${threadId}`, role: 'assistant', content: message, createdAt: Date.now(), state: 'error' }])
    } finally {
      if (latestRequestedThreadRef.current === threadId) setThreadLoading(false)
    }
  }, [])

  // Page in the next-older slice of the active thread's history. The cursor is
  // the oldest already-loaded persisted message; the fetched page is prepended.
  const loadEarlierMessages = useCallback(async () => {
    const threadId = activeThreadId
    if (threadId == null || loadingEarlier || threadLoading || !hasEarlierMessages) return
    const oldest = messages.find((message) => typeof message.id === 'number')
    if (!oldest || typeof oldest.id !== 'number') return
    setLoadingEarlier(true)
    try {
      const detail = await ipc.ai.getThread(threadId, {
        before: { createdAt: oldest.createdAt, id: oldest.id },
      })
      if (latestRequestedThreadRef.current !== threadId) return
      setMessages((current) => prependEarlierMessages(current, threadMessagesFromHistory(detail.messages)))
      setHasEarlierMessages(detail.hasEarlier)
    } catch (error) {
      console.error('[ai] failed to load earlier messages', error)
    } finally {
      setLoadingEarlier(false)
    }
  }, [activeThreadId, loadingEarlier, threadLoading, hasEarlierMessages, messages])

  // Rename a conversation, optimistically: the sidebar/header update at once,
  // and the previous title quietly comes back if the save fails (same contract
  // as archive/rate — no blocking spinner, no modal).
  const renameThread = useCallback(async (threadId: number, title: string) => {
    const nextTitle = title.trim()
    const previous = threads.find((thread) => thread.id === threadId)
    if (!previous || !nextTitle || nextTitle === previous.title) return
    setThreads((current) => current.map((thread) => (
      thread.id === threadId ? { ...thread, title: nextTitle } : thread
    )))
    try {
      await ipc.ai.renameThread(threadId, nextTitle)
    } catch (error) {
      console.error('[ai] failed to rename thread', error)
      setThreads((current) => current.map((thread) => (
        thread.id === threadId ? { ...thread, title: previous.title } : thread
      )))
    }
  }, [threads])

  // Hydrate the thread list once and adopt the most recent thread — unless the
  // tab was opened via a deep link (/ai?threadId=…), in which case the deep-link
  // effect below owns which thread loads and we must not race it.
  useEffect(() => {
    if (threadsHydratedRef.current) return
    const deepLinkThreadId = Number(new URLSearchParams(location.search).get('threadId'))
    const hasDeepLink = Number.isFinite(deepLinkThreadId) && deepLinkThreadId > 0
    let cancelled = false
    ipc.ai.listThreads({ includeArchived: true }).then((rows) => {
      // Mark hydrated only on a load that actually lands. Setting the guard up
      // front meant a cancelled first run (StrictMode's mount→cleanup→mount, or
      // any remount mid-flight) blocked the remount from ever fetching, so the
      // sidebar stayed empty until a send refreshed it. Now a cancelled run
      // leaves the guard down and the next mount hydrates for real.
      if (cancelled) return
      threadsHydratedRef.current = true
      setThreadsHydrated(true)
      setThreads(rows)
      if (hasDeepLink) return // the deep-link effect owns which thread loads
      // Restore the selection from earlier this session so a tab switch doesn't
      // snap you back to the most recent conversation.
      if (rememberedThreadId === null) return // you were on a new chat — stay empty
      if (typeof rememberedThreadId === 'number' && rows.some((row) => row.id === rememberedThreadId)) {
        void loadThread(rememberedThreadId)
        return
      }
      const firstId = firstActiveThreadId(rows)
      if (firstId != null) void loadThread(firstId)
      else {
        setIsNewChatDraft(true)
        rememberedThreadId = null
      }
    }).catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [loadThread, location.search])

  // Screen-open analytics once provider state is known.
  useEffect(() => {
    if (!settings || hasApiKey === null || aiScreenTrackedRef.current) return
    aiScreenTrackedRef.current = true
    track(ANALYTICS_EVENT.AI_SCREEN_OPENED, analyticsContext({ trigger: 'navigation', view: 'ai' }))
  }, [hasApiKey, settings, analyticsContext])

  const latestCompletedAssistantId = useMemo(() => (
    [...messages].reverse().find((m) => m.role === 'assistant' && m.state === 'complete')?.id
  ), [messages])

  // Suggested-question impression analytics.
  useEffect(() => {
    const latest = [...messages].reverse().find((message) => (
      message.role === 'assistant'
      && message.state === 'complete'
      && message.id === latestCompletedAssistantId
      && (message.suggestedFollowUps?.length ?? 0) >= 2
    ))
    if (!latest) return
    const key = String(latest.id)
    if (suggestionImpressionsRef.current[key]) return
    suggestionImpressionsRef.current[key] = true
    track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_IMPRESSION, analyticsContext({
      answer_kind: latest.answerKind ?? null,
      suggestion_count: latest.suggestedFollowUps?.length ?? 0,
      source: 'followup',
    }))
  }, [latestCompletedAssistantId, messages, analyticsContext])

  const triggerActionFeedback = useCallback((
    messageId: string | number,
    action: MessageAction,
    options?: { successMs?: number },
  ) => {
    const key = actionFeedbackKey(messageId, action)
    const success = Boolean(options?.successMs)
    if (actionFeedbackTimeoutsRef.current[key]) {
      window.clearTimeout(actionFeedbackTimeoutsRef.current[key])
      delete actionFeedbackTimeoutsRef.current[key]
    }
    setActionFeedback((current) => ({
      ...current,
      [key]: { pulseNonce: (current[key]?.pulseNonce ?? 0) + 1, success },
    }))
    if (options?.successMs) {
      actionFeedbackTimeoutsRef.current[key] = window.setTimeout(() => {
        setActionFeedback((current) => {
          const entry = current[key]
          if (!entry) return current
          return { ...current, [key]: { ...entry, success: false } }
        })
        delete actionFeedbackTimeoutsRef.current[key]
      }, options.successMs)
    }
  }, [])

  // Keep the sidebar list current after a turn. Thread ADOPTION is separate:
  // the server returns the authoritative threadId with the turn result, so a
  // draft send adopts that exact thread — never "the newest row", which could
  // be a background day-report thread and is how follow-ups used to land in
  // (and duplicate) the wrong conversation.
  const refreshThreadList = useCallback(async () => {
    try {
      const refreshed = await ipc.ai.listThreads({ includeArchived: true })
      setThreads(refreshed)
    } catch { /* best-effort */ }
  }, [])

  const handleSend = useCallback(async (text?: string, options?: SendOptions) => {
    const prompt = (text ?? '').trim()
    if (!prompt || loadingRef.current || !hasApiKey) return
    const trigger = options?.trigger ?? 'freeform'
    const autoRetryCount = options?.autoRetryCount ?? 0
    const queryKind = classifyAIOutputIntent(prompt)

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const createdAt = Date.now()
    const userId = `user:${requestId}`
    const assistantId = `assistant:${requestId}`
    const requestThreadId = activeThreadId
    const navigationVersion = navigationVersionRef.current

    track(ANALYTICS_EVENT.AI_QUERY_SENT, analyticsContext({ query_kind: queryKind, trigger }))
    if (queryKind !== 'question') {
      track(ANALYTICS_EVENT.AI_OUTPUT_REQUESTED, analyticsContext({ export_type: queryKind, trigger }))
    }
    // ai_chat_sent: one per user-initiated send — scheduled auto-retries of a
    // rate-limited turn are not a new user action.
    if (autoRetryCount === 0) {
      track(ANALYTICS_EVENT.AI_CHAT_SENT, {
        thread_id: requestThreadId != null ? String(requestThreadId) : 'new',
        message_length: prompt.length,
        has_date_context: Boolean(options?.contextOverride?.dateRange),
        model_used: activeModel ?? 'unknown',
      })
    }

    // A fresh send supersedes any scheduled rate-limit auto-retry.
    for (const handle of Object.values(autoRetryTimeoutsRef.current)) window.clearTimeout(handle)
    autoRetryTimeoutsRef.current = {}

    setLoading(true)
    inFlightTurnRef.current = { requestId, assistantId, userId, prompt }
    setTurnPhase({ phase: 'running', waitKind: null })
    setMessages((current) => beginTurn(current, { userId, assistantId, prompt, createdAt }))

    // Race the turn against a hard timeout so a stuck request always
    // resolves the pending row to a retryable error — never an eternal spinner.
    let timedOut = false
    let timeoutHandle: number | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = window.setTimeout(() => { timedOut = true; reject(new Error('timeout')) }, SEND_TIMEOUT_MS)
    })

    try {
      const response = await Promise.race([
        ipc.ai.sendMessage({
          message: prompt,
          contextOverride: options?.contextOverride ?? null,
          clientRequestId: requestId,
          threadId: activeThreadId,
          transform: options?.transform ?? null,
          resumeOfCheckpointId: options?.resumeOfCheckpointId ?? null,
        }),
        timeoutPromise,
      ]) as AIChatTurnResult

      // The user stopped this turn; a late completion must never overwrite
      // the cancelled row with a fake "completed" answer.
      if (cancelledRequestsRef.current.has(requestId)) {
        cancelledRequestsRef.current.delete(requestId)
        return
      }
      // Same for a paused turn — the paused row must stay paused.
      if (pausedRequestsRef.current.has(requestId)) {
        pausedRequestsRef.current.delete(requestId)
        return
      }

      // Flip the pending row to the final answer FIRST. The visible
      // completion must not be gated on the thread-list refresh that follows —
      // that ordering was why answers only appeared after navigating away.
      setAgentQuestion(null)
      setMessages((current) => completeTurn(current, assistantId, response.assistantMessage))
      track(ANALYTICS_EVENT.AI_QUERY_ANSWERED, analyticsContext({
        answer_kind: response.assistantMessage.answerKind ?? null,
        query_kind: queryKind,
        trigger,
        provider_calls: response.providerCallCount ?? null,
      }))
      // A draft send adopts the exact thread the server persisted into.
      if (shouldAdoptThreadAfterTurn({
        requestThreadId,
        responseThreadId: response.threadId,
        navigationVersionAtSend: navigationVersion,
        navigationVersionNow: navigationVersionRef.current,
      })) {
        setActiveThreadId(response.threadId)
        setIsNewChatDraft(false)
        rememberedThreadId = response.threadId
      }
      void refreshThreadList()
    } catch (error) {
      // A cancelled turn's rejection (the abort) is not an error — the row is
      // already showing its cancelled state.
      if (cancelledRequestsRef.current.has(requestId)) {
        cancelledRequestsRef.current.delete(requestId)
        return
      }
      // A paused turn's rejection is the pause settling, not a failure — the
      // row is already showing its resumable paused state (DEV-200).
      if (pausedRequestsRef.current.has(requestId)) {
        pausedRequestsRef.current.delete(requestId)
        return
      }
      const sanitized = sanitizeIpcError(
        error,
        timedOut ? 'That took longer than expected. Tap retry to run it again.' : undefined,
      )
      // Ride out a *transient* per-minute limit automatically, once, after a
      // short backoff. A hard wall (daily/free-tier quota gone, credit, auth)
      // is NOT auto-retried — retrying just fails again; instead the card
      // offers switch-provider.
      const failure = classifyTurnFailure(
        { code: sanitized.code, retryAfterSeconds: sanitized.retryAfterSeconds },
        autoRetryCount,
        alternateProvidersRef.current,
      )
      setAgentQuestion(null)
      setMessages((current) => failTurn(
        current,
        assistantId,
        { message: sanitized.message, code: sanitized.code, retryAfterSeconds: sanitized.retryAfterSeconds },
        failure.errorInfo,
      ))
      // Keep the sidebar current — the server may have created the thread
      // before the turn failed (retrying from the draft reuses it server-side).
      void refreshThreadList()
      if (failure.willAutoRetry) {
        const waitMs = Math.min(45, Math.max(8, sanitized.retryAfterSeconds ?? 20)) * 1000
        autoRetryTimeoutsRef.current[assistantId] = window.setTimeout(() => {
          delete autoRetryTimeoutsRef.current[assistantId]
          // Replace the errored turn in place rather than appending a duplicate.
          setMessages((current) => removeTurn(current, assistantId, userId))
          void handleSendRef.current(prompt, {
            contextOverride: options?.contextOverride ?? null,
            trigger: 'retry',
            autoRetryCount: autoRetryCount + 1,
            transform: options?.transform ?? null,
          })
        }, waitMs)
      }
    } finally {
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle)
      if (inFlightTurnRef.current?.requestId === requestId) inFlightTurnRef.current = null
      setLoading(false)
      setTurnPhase(null)
      clearStreamingSnapshot(assistantId)
    }
  }, [activeThreadId, hasApiKey, analyticsContext, activeModel, refreshThreadList])

  // Stable submit reference for the memoized composer: its only re-render
  // trigger should be `loading`, not a fresh callback identity each render.
  const handleSendRef = useRef(handleSend)
  handleSendRef.current = handleSend
  const submitMessage = useCallback((text: string) => { void handleSendRef.current(text) }, [])

  // Stop aborts the in-flight provider request in the main process
  // (ai:cancel-message → AbortController → SDK abort) and flips the pending
  // row to `cancelled` — never a fake completed answer, never an error card.
  // The turn's late settle is suppressed via cancelledRequestsRef.
  const cancelGeneration = useCallback(() => {
    const inFlight = inFlightTurnRef.current
    if (!inFlight) return
    inFlightTurnRef.current = null
    cancelledRequestsRef.current.add(inFlight.requestId)
    void ipc.ai.cancelMessage(inFlight.requestId).catch(() => { /* turn may already be settling */ })
    setAgentQuestion(null)
    setTurnPhase(null)
    setMessages((current) => cancelTurn(current, inFlight.assistantId))
    clearStreamingSnapshot(inFlight.assistantId)
    // Free the composer immediately; the aborted promise settles in the
    // background and is dropped.
    setLoading(false)
  }, [])

  // Pause the in-flight turn (DEV-200). The provider stream stops like Stop
  // does, but the main process persists a resumable checkpoint (surviving app
  // restart) and the row flips to a paused state with Resume/Discard — never
  // the discarded `cancelled` state. The checkpoint id arrives over the
  // turn-phase channel a beat later and fills into the row.
  const pauseGeneration = useCallback(() => {
    const inFlight = inFlightTurnRef.current
    if (!inFlight) return
    inFlightTurnRef.current = null
    pausedRequestsRef.current.add(inFlight.requestId)
    void ipc.ai.pauseMessage(inFlight.requestId).catch(() => { /* turn may already be settling */ })
    setAgentQuestion(null)
    setTurnPhase(null)
    setMessages((current) => pauseTurn(current, inFlight.assistantId, {
      question: inFlight.prompt,
      checkpointId: null,
    }))
    clearStreamingSnapshot(inFlight.assistantId)
    setLoading(false)
  }, [])

  // Resume a paused turn: the pair is re-run in place as a fresh send that
  // adopts the checkpoint — main rebuilds the context packet from the current
  // facts, so the answer reflects the day as it is NOW.
  const resumePausedTurn = useCallback(async (message: ThreadMessage) => {
    if (loadingRef.current) return
    const info = message.pausedInfo
    if (!info?.checkpointId) return
    const userId = String(message.id).replace(/^assistant:/, 'user:')
    setMessages((current) => removeTurn(current, message.id, userId))
    await handleSend(info.question, { trigger: 'resume', resumeOfCheckpointId: info.checkpointId })
  }, [handleSend])

  // Discard a paused turn — the explicit "don't resume this" choice, distinct
  // from both Stop (which never had a checkpoint) and Resume.
  const discardPausedTurn = useCallback(async (message: ThreadMessage) => {
    const info = message.pausedInfo
    const userId = String(message.id).replace(/^assistant:/, 'user:')
    setMessages((current) => removeTurn(current, message.id, userId))
    if (info?.checkpointId) {
      try {
        await ipc.ai.discardPausedTurn(info.checkpointId)
      } catch { /* the row is gone locally; a stale checkpoint resurfaces on reload and can be discarded again */ }
    }
  }, [])

  const handleRetry = useCallback(async (index: number, message: ThreadMessage) => {
    if (message.id !== latestCompletedAssistantId) return
    triggerActionFeedback(message.id, 'retry')
    track(ANALYTICS_EVENT.AI_ANSWER_RETRIED, analyticsContext({ answer_kind: message.answerKind ?? null, trigger: 'retry' }))
    const historyUpToMessage = messages.slice(0, index)
    const previousUser = [...historyUpToMessage].reverse().find((m) => m.role === 'user')
    if (!previousUser) return
    await handleSend(previousUser.content, { contextOverride: message.contextSnapshot ?? null, trigger: 'retry', transform: transformKindFromLabel(previousUser.content) })
  }, [latestCompletedAssistantId, messages, triggerActionFeedback, analyticsContext, handleSend])

  // Retry a turn that ended in an error card. Cancels any pending auto-retry
  // for that row, then re-sends the user message that preceded it.
  const handleErrorRetry = useCallback(async (message: ThreadMessage) => {
    if (loadingRef.current) return
    const key = String(message.id)
    if (autoRetryTimeoutsRef.current[key]) {
      window.clearTimeout(autoRetryTimeoutsRef.current[key])
      delete autoRetryTimeoutsRef.current[key]
    }
    const index = messages.findIndex((m) => m.id === message.id)
    if (index < 0) return
    const previousUser = [...messages.slice(0, index)].reverse().find((m) => m.role === 'user')
    if (!previousUser) return
    track(ANALYTICS_EVENT.AI_ANSWER_RETRIED, analyticsContext({ answer_kind: message.answerKind ?? null, trigger: 'retry' }))
    // Replace the errored turn in place rather than appending a duplicate.
    setMessages((current) => removeTurn(current, message.id, previousUser.id))
    await handleSend(previousUser.content, { contextOverride: message.contextSnapshot ?? null, trigger: 'retry', transform: transformKindFromLabel(previousUser.content) })
  }, [messages, analyticsContext, handleSend])

  // Explicit, user-initiated provider switch from a hard-wall error card.
  // Persists the chat provider (never silent/auto), refreshes the header model,
  // then re-runs the turn on the new provider in place of the errored one.
  const switchProviderAndRetry = useCallback(async (message: ThreadMessage, provider: AIProviderMode) => {
    if (loadingRef.current) return
    const key = String(message.id)
    if (autoRetryTimeoutsRef.current[key]) {
      window.clearTimeout(autoRetryTimeoutsRef.current[key])
      delete autoRetryTimeoutsRef.current[key]
    }
    const index = messages.findIndex((m) => m.id === message.id)
    if (index < 0) return
    const previousUser = [...messages.slice(0, index)].reverse().find((m) => m.role === 'user')
    if (!previousUser) return
    try {
      await ipc.settings.set({ aiChatProvider: provider })
      await refreshProvider()
    } catch {
      return // leave the error card intact if the switch could not be saved
    }
    track(ANALYTICS_EVENT.AI_ANSWER_RETRIED, analyticsContext({
      answer_kind: message.answerKind ?? null,
      trigger: 'switch_provider',
      provider,
    }))
    setMessages((current) => removeTurn(current, message.id, previousUser.id))
    await handleSend(previousUser.content, { contextOverride: message.contextSnapshot ?? null, trigger: 'retry', transform: transformKindFromLabel(previousUser.content) })
  }, [messages, refreshProvider, analyticsContext, handleSend])

  const handleCopy = useCallback(async (messageId: string | number, content: string, answerKind: ThreadMessage['answerKind']) => {
    try {
      await navigator.clipboard.writeText(content)
      triggerActionFeedback(messageId, 'copy', { successMs: 900 })
      track(ANALYTICS_EVENT.AI_ANSWER_COPIED, analyticsContext({ answer_kind: answerKind ?? null, trigger: 'copy' }))
    } catch { /* clipboard unsupported */ }
  }, [triggerActionFeedback, analyticsContext])

  const handleRate = useCallback(async (message: ThreadMessage, rating: 'up' | 'down' | null) => {
    if (typeof message.id !== 'number') return
    const previousRating = message.rating ?? null
    const previousRatingUpdatedAt = message.ratingUpdatedAt ?? null
    setMessages((current) => current.map((entry) => (
      entry.id === message.id ? { ...entry, rating, ratingUpdatedAt: rating ? Date.now() : null } : entry
    )))
    // Pulse the button that was actually clicked. When toggling a rating off,
    // `rating` is null, so fall back to the rating being cleared (message.rating).
    triggerActionFeedback(message.id, (rating ?? previousRating) === 'down' ? 'down' : 'up')
    track(ANALYTICS_EVENT.AI_ANSWER_RATED, analyticsContext({
      answer_kind: message.answerKind ?? null,
      rating: rating ?? 'cleared',
      trigger: 'manual',
    }))
    try {
      const persisted = await ipc.ai.setMessageFeedback({ messageId: message.id, rating })
      if (persisted) {
        setMessages((current) => current.map((entry) => (
          entry.id === message.id ? { ...entry, ...persisted, state: entry.state } : entry
        )))
      }
    } catch {
      setMessages((current) => current.map((entry) => (
        entry.id === message.id ? { ...entry, rating: previousRating, ratingUpdatedAt: previousRatingUpdatedAt } : entry
      )))
    }
  }, [triggerActionFeedback, analyticsContext])

  const handleMessageAction = useCallback(async (
    messageId: string | number,
    action: AIMessageAction,
    options?: { reviewNote?: string },
  ) => {
    const key = messageActionKey(messageId, action)
    setMessageActionState((current) => ({ ...current, [key]: { busy: true, error: null, successLabel: null } }))
    try {
      if (action.kind === 'start_focus_session') {
        await ipc.focus.start(action.payload)
        setMessageActionState((current) => ({ ...current, [key]: { busy: false, error: null, successLabel: 'Focus session started.' } }))
      } else if (action.kind === 'stop_focus_session') {
        await ipc.focus.stop(action.sessionId)
        setMessageActionState((current) => ({ ...current, [key]: { busy: false, error: null, successLabel: 'Focus session stopped.' } }))
      } else {
        const draft = (options?.reviewNote ?? action.suggestedNote ?? '').trim()
        if (!draft) {
          setMessageActionState((current) => ({ ...current, [key]: { busy: false, error: 'Add a short review before saving it.', successLabel: null } }))
          return
        }
        await ipc.focus.saveReflection({ sessionId: action.sessionId, note: draft })
        setMessageActionState((current) => ({ ...current, [key]: { busy: false, error: null, successLabel: 'Focus review saved.' } }))
      }
      await refreshProvider()
    } catch (error) {
      setMessageActionState((current) => ({
        ...current,
        [key]: { busy: false, error: error instanceof Error ? error.message : String(error), successLabel: null },
      }))
    }
  }, [refreshProvider])

  // Commit an action proposal (the user confirmed the preview). The
  // real change runs in main through the manual-edit pipeline; the card flips to
  // a committed state with the confirmation line and an undo when reversible.
  const commitActionWidget = useCallback(async (proposal: AIActionWidget) => {
    const id = proposal.proposalId
    setActionWidgetState((current) => ({ ...current, [id]: { status: 'committing' } }))
    try {
      const result = await ipc.ai.commitAction(proposal)
      if (!result.ok) {
        setActionWidgetState((current) => ({ ...current, [id]: { status: 'error', error: result.error ?? 'Could not apply that.' } }))
        return
      }
      setActionWidgetState((current) => ({
        ...current,
        [id]: { status: 'committed', summary: result.summary, undo: result.undo ?? null },
      }))
    } catch (error) {
      setActionWidgetState((current) => ({
        ...current,
        [id]: { status: 'error', error: error instanceof Error ? error.message : String(error) },
      }))
    }
  }, [])

  const undoActionWidget = useCallback(async (proposalId: string, undo: AIActionUndo) => {
    setActionWidgetState((current) => ({ ...current, [proposalId]: { ...current[proposalId], status: 'undoing' } }))
    try {
      await ipc.ai.undoAction(undo)
      // Back to a confirmable preview — the user can re-apply if they change
      // their mind. The summary line tells them the undo landed.
      setActionWidgetState((current) => ({ ...current, [proposalId]: { status: 'idle', summary: 'Undone.' } }))
    } catch (error) {
      setActionWidgetState((current) => ({
        ...current,
        [proposalId]: { status: 'error', error: error instanceof Error ? error.message : String(error) },
      }))
    }
  }, [])

  const dismissActionWidget = useCallback((widget: AIActionWidget) => {
    // Cancelling a memory preview is a decision — main records the proposed
    // facts as rejections so they are not proposed again (DEV-185).
    // Best-effort: the card dismisses either way.
    void ipc.ai.dismissAction(widget).catch(() => {})
    setActionWidgetState((current) => ({ ...current, [widget.proposalId]: { status: 'idle', dismissed: true } }))
  }, [])

  const clearFeedback = useCallback(() => {
    setActionFeedback({})
    setMessageActionState({})
    suggestionImpressionsRef.current = {}
  }, [])

  const resetComposerState = useCallback(() => {
    setMessages([])
    setHasEarlierMessages(false)
    clearFeedback()
  }, [clearFeedback])

  // Instant new chat: reset to an empty draft synchronously. No createThread
  // round-trip — the server auto-creates the thread on the first send.
  const handleNewChat = useCallback(() => {
    if (loadingRef.current) return
    if (messages.length === 0 && activeThreadId == null) return
    // Cancel a scheduled auto-retry and invalidate any in-flight thread load so
    // neither writes into the fresh chat.
    for (const handle of Object.values(autoRetryTimeoutsRef.current)) window.clearTimeout(handle)
    autoRetryTimeoutsRef.current = {}
    latestRequestedThreadRef.current = null
    navigationVersionRef.current += 1
    setThreadLoading(false)
    setActiveThreadId(null)
    setIsNewChatDraft(true)
    rememberedThreadId = null
    resetComposerState()
  }, [messages.length, activeThreadId, resetComposerState])

  const selectThread = useCallback((threadId: number) => {
    if (threadId === activeThreadId) return
    // Clear per-message UI state but keep the current messages on screen until
    // the new thread's history arrives — switching shouldn't flash an empty view.
    clearFeedback()
    void loadThread(threadId)
  }, [activeThreadId, clearFeedback, loadThread])

  const deleteThread = useCallback(async (thread: AIThreadSummary) => {
    try {
      await ipc.ai.deleteThread(thread.id)
      const refreshed = await ipc.ai.listThreads({ includeArchived: true })
      setThreads(refreshed)
      if (thread.id === activeThreadId) {
        const nextId = firstActiveThreadId(refreshed)
        if (nextId != null) {
          resetComposerState()
          void loadThread(nextId)
        } else {
          setActiveThreadId(null)
          setIsNewChatDraft(true)
          rememberedThreadId = null
          resetComposerState()
        }
      }
    } catch (error) {
      console.error('[ai] failed to delete thread', error)
    }
  }, [activeThreadId, resetComposerState, loadThread])

  // Archive / unarchive a thread. Archiving the active thread moves focus to
  // the next active one (like delete), so the body never strands on a thread
  // the user just tucked away.
  const archiveThread = useCallback(async (thread: AIThreadSummary, archived: boolean) => {
    try {
      await ipc.ai.archiveThread(thread.id, archived)
      const refreshed = await ipc.ai.listThreads({ includeArchived: true })
      setThreads(refreshed)
      if (archived && thread.id === activeThreadId) {
        const nextId = firstActiveThreadId(refreshed)
        if (nextId != null) {
          resetComposerState()
          void loadThread(nextId)
        } else {
          setActiveThreadId(null)
          setIsNewChatDraft(true)
          rememberedThreadId = null
          resetComposerState()
        }
      }
    } catch (error) {
      console.error('[ai] failed to archive thread', error)
    }
  }, [activeThreadId, resetComposerState, loadThread])

  // Deep link from Day Wrapped / notifications: /ai?threadId=…&artifactId=…
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const threadId = Number(params.get('threadId'))
    const artifactId = Number(params.get('artifactId'))
    if (!Number.isFinite(threadId) || threadId <= 0) return
    const routeKey = `${threadId}:${Number.isFinite(artifactId) && artifactId > 0 ? artifactId : 'none'}`
    if (routedReportKeyRef.current === routeKey) return
    routedReportKeyRef.current = routeKey

    void (async () => {
      const refreshed = await ipc.ai.listThreads({ includeArchived: true }).catch(() => null)
      if (refreshed) setThreads(refreshed)
      resetComposerState()
      await loadThread(threadId)
      if (Number.isFinite(artifactId) && artifactId > 0) {
        void ipc.ai.openArtifact(artifactId).catch(() => { /* best-effort */ })
      }
    })()
  }, [location.search, loadThread, resetComposerState])

  const handlePromptChipClick = useCallback((prompt: string, source: string) => {
    if (!hasApiKey) return
    track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_CLICKED, analyticsContext({ source, trigger: 'suggested' }))
    void handleSend(prompt, { trigger: 'suggested' })
  }, [hasApiKey, analyticsContext, handleSend])

  // Transform the previous answer (shorter / checklist / bullets / report).
  // The concise label is the user-visible message; `transform` tells the main
  // process to rewrite the SPECIFIC prior answer faithfully (real numbers, no
  // generic day shell).
  const transformAnswer = useCallback((kind: AnswerTransform) => {
    if (!hasApiKey || loadingRef.current) return
    const label = transformLabel(kind)
    if (!label) return
    track(ANALYTICS_EVENT.AI_OUTPUT_REQUESTED, analyticsContext({ export_type: kind, trigger: 'transform' }))
    void handleSend(label, { trigger: 'suggested', transform: kind })
  }, [hasApiKey, analyticsContext, handleSend])

  return {
    // state
    messages,
    loading,
    threadLoading,
    hasEarlierMessages,
    loadingEarlier,
    threadsHydrated,
    threads,
    activeThreadId,
    isNewChatDraft,
    activeThreadLabel,
    activeModel,
    activeProvider,
    settings,
    cliTools,
    hasApiKey,
    activeFocusSession,
    billingAccess,
    actionFeedback,
    messageActionState,
    actionWidgetState,
    reducedMotion,
    agentQuestion,
    turnPhase,
    latestCompletedAssistantId,
    // resource status (for the error card + ConnectAI refresh)
    initialLoading: providerResource.loading && !providerResource.data,
    loadError: providerResource.error,
    refreshProvider,
    // actions
    submitMessage,
    cancelGeneration,
    pauseGeneration,
    resumePausedTurn,
    discardPausedTurn,
    handleSend,
    handleRetry,
    handleErrorRetry,
    handleCopy,
    handleRate,
    handleMessageAction,
    commitActionWidget,
    undoActionWidget,
    dismissActionWidget,
    handleNewChat,
    selectThread,
    deleteThread,
    archiveThread,
    renameThread,
    loadEarlierMessages,
    triggerActionFeedback,
    handlePromptChipClick,
    switchProviderAndRetry,
    alternateProviders,
    transformAnswer,
    answerAgentQuestion,
    dismissAgentQuestion,
    providerAvailability,
    analyticsContext,
  }
}
