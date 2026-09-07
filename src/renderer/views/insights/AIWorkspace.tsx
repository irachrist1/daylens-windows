import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, Copy, Pencil, RefreshCw, SlidersHorizontal, ThumbsDown, ThumbsUp, Wand2 } from 'lucide-react'
import { ANALYTICS_EVENT } from '@shared/analytics'
import type { AIModelCostCatalog, AIProviderMode, AIStarterSuggestion, AIThreadSettings } from '@shared/types'
import { buildModelSources } from '@shared/aiModelSources'
import { track } from '../../lib/analytics'
import { ipc } from '../../lib/ipc'
import { AI_PROVIDER_META } from '../../lib/aiProvider'
import {
  clearCommandSurfaceActions,
  openCommandPalette,
  setCommandSurfaceActions,
  type CommandSurfaceAction,
} from '../../lib/commandSurface'
import ConnectAI from '../../components/ConnectAI'
import { ContextPacketInspector } from '../../components/ContextPacketInspector'
import { consumePendingChatSeedWhenReady } from '../../lib/aiSeed'
import {
  enqueueComposerPrompt,
  hasQueuedComposerPrompts,
  isAiChatVisible,
  isAiProviderPending,
  peekQueuedComposerPrompt,
  providerProbeFailureKind,
  readQueuedComposerPrompts,
  replaceQueuedComposerPrompts,
  takeQueuedComposerPrompt,
} from '../../lib/aiTabAccess'
import { AICompose, type AIComposeHandle } from './AICompose'
import { ConversationSidebar } from './ConversationSidebar'
import { MessageList } from './MessageList'
import { AgentQuestionCard } from './AgentQuestionCard'
import { ModelSelector } from './ModelSelector'
import { ThreadSettingsPanel } from './ThreadSettingsPanel'
import { McpActivityPanel } from './McpActivityPanel'
import { IconChevronDown, IconNewChat, IconSidebar, IconSparkle } from './icons'
import { useAIChat } from './useAIChat'
import { ANSWER_TRANSFORMS, type ThreadMessage } from './types'

const SIDEBAR_COLLAPSED_KEY = 'daylens.ai.sidebarCollapsed'
const MCP_ACTIVITY_OPEN_KEY = 'daylens.ai.mcpActivityOpen'

// Map a chat provider to the settings key holding its chosen model, so picking a
// model for a brand-new (thread-less) chat updates the right global default.
const PROVIDER_MODEL_KEY: Record<AIProviderMode, 'anthropicModel' | 'openaiModel' | 'googleModel' | 'openrouterModel'> = {
  anthropic: 'anthropicModel',
  'claude-cli': 'anthropicModel',
  openai: 'openaiModel',
  'chatgpt-cli': 'openaiModel',
  'codex-cli': 'openaiModel',
  google: 'googleModel',
  'gemini-cli': 'googleModel',
  openrouter: 'openrouterModel',
}

export default function AIWorkspace() {
  const chat = useAIChat()
  const {
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
    settings,
    cliTools,
    hasApiKey,
    billingAccess,
    activeFocusSession,
    actionFeedback,
    messageActionState,
    actionWidgetState,
    reducedMotion,
    agentQuestion,
    turnPhase,
    latestCompletedAssistantId,
    initialLoading,
    loadError,
    refreshProvider,
    submitMessage,
    cancelGeneration,
    pauseGeneration,
    resumePausedTurn,
    discardPausedTurn,
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
    switchProviderAndRetry,
    alternateProviders,
    transformAnswer,
    answerAgentQuestion,
    dismissAgentQuestion,
    providerAvailability,
    analyticsContext,
  } = chat
  const providerPending = isAiProviderPending(settings, hasApiKey)
  const chatVisible = isAiChatVisible(hasApiKey)

  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<AIComposeHandle>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    // FB4: hidden by default — only an explicit "open" choice persists as '0'.
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== '0' } catch { return true }
  })
  const [mcpActivityOpen, setMcpActivityOpen] = useState(() => {
    try { return localStorage.getItem(MCP_ACTIVITY_OPEN_KEY) === '1' } catch { return false }
  })

  const toggleMcpActivity = useCallback(() => {
    setMcpActivityOpen((open) => {
      const next = !open
      try { localStorage.setItem(MCP_ACTIVITY_OPEN_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  // DEV-183: which exchange's recorded context packet the inspector is open on.
  // Opened from the citation chips or the per-answer affordance; the inspector
  // itself is read-only.
  const [inspectTarget, setInspectTarget] = useState<{ packetId: string | null; messageId: number | null } | null>(null)
  const openPacketInspector = useCallback((message: ThreadMessage) => {
    setInspectTarget({
      packetId: message.agent?.contextPacketId ?? null,
      messageId: typeof message.id === 'number' ? message.id : null,
    })
  }, [])

  // D4: per-thread settings (model override + instructions).
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [threadSettings, setThreadSettings] = useState<AIThreadSettings>({ provider: null, model: null, instructions: null })

  // DEV-201: the picker's provider sources (managed / your keys / your CLI
  // subscriptions, each with honest availability) and per-model costs in money
  // and estimated questions, priced by the main process from the same table
  // billing settlement uses. Costs are fetched when the picker opens.
  const [modelCosts, setModelCosts] = useState<AIModelCostCatalog | null>(null)
  const modelSources = useMemo(() => buildModelSources({
    providerAvailability,
    billing: billingAccess,
  }), [providerAvailability, billingAccess])
  useEffect(() => {
    if (!modelSelectorOpen) return
    let cancelled = false
    const allModels = (Object.keys(AI_PROVIDER_META) as AIProviderMode[]).flatMap((provider) =>
      AI_PROVIDER_META[provider].models.map((model) => ({ provider, modelId: model.id })))
    void ipc.ai.getModelCosts(allModels)
      .then((catalog) => { if (!cancelled) setModelCosts(catalog) })
      .catch(() => { /* the picker still works without cost lines */ })
    return () => { cancelled = true }
  }, [modelSelectorOpen])

  // Load the active thread's overrides so the header subline + the panel reflect
  // them. A brand-new (unsent) chat has no thread row yet, so settings stay empty.
  useEffect(() => {
    if (activeThreadId == null) {
      setThreadSettings({ provider: null, model: null, instructions: null })
      return
    }
    let cancelled = false
    void ipc.ai.getThreadSettings(activeThreadId)
      .then((next) => { if (!cancelled) setThreadSettings(next) })
      .catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [activeThreadId])

  // Empty-database awareness: a brand-new user has no tracked history yet, so the
  // data-dependent starter prompts ("What did I work on today?") would all
  // dead-end. Detect that once and swap to onboarding-focused prompts until real
  // activity exists. Fail open (assume history) so a query hiccup never hides the
  // normal prompts.
  const [hasHistory, setHasHistory] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void ipc.db.getAppSummaries(365)
      .then((rows) => { if (!cancelled) setHasHistory((rows?.length ?? 0) > 0) })
      .catch(() => { if (!cancelled) setHasHistory(true) })
    return () => { cancelled = true }
  }, [])

  const [starterPrompts, setStarterPrompts] = useState<AIStarterSuggestion[]>([])
  const [starterError, setStarterError] = useState<string | null>(null)
  const [hoveredStarter, setHoveredStarter] = useState<number | null>(null)
  useEffect(() => {
    const isSettledEmptyChat = threadsHydrated
      && !threadLoading
      && isNewChatDraft
      && messages.length === 0
    if (!hasApiKey || !isSettledEmptyChat) {
      setStarterPrompts([])
      setStarterError(null)
      return
    }
    let cancelled = false
    void ipc.ai.getStarterSuggestions()
      .then((result) => {
        if (cancelled) return
        setStarterPrompts(result.suggestions)
        setStarterError(result.error)
      })
      .catch(() => {
        if (cancelled) return
        setStarterPrompts([])
        setStarterError("Suggestions couldn't load. Try opening a new chat again.")
      })
    return () => { cancelled = true }
  }, [hasApiKey, isNewChatDraft, messages.length, threadLoading, threadsHydrated])

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [])

  // Prepending an earlier page must not yank the view to the bottom; the flag
  // swallows exactly the messages-change that the prepend causes.
  const suppressAutoScrollRef = useRef(false)
  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false
      return
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const onLoadEarlier = useCallback(() => {
    suppressAutoScrollRef.current = true
    void loadEarlierMessages()
  }, [loadEarlierMessages])

  // U5: rename the active conversation from the header — click the title, type,
  // Enter/blur saves, Escape cancels. Same inline-title pattern as the timeline
  // block editor; the save itself is optimistic with a quiet rollback.
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const startHeaderRename = useCallback(() => {
    if (activeThreadId == null) return
    const current = threads.find((thread) => thread.id === activeThreadId)
    setTitleDraft(current?.title ?? '')
  }, [activeThreadId, threads])
  const commitHeaderRename = useCallback(() => {
    if (titleDraft != null && activeThreadId != null) void renameThread(activeThreadId, titleDraft)
    setTitleDraft(null)
  }, [titleDraft, activeThreadId, renameThread])
  // Switching conversations abandons any unsaved title edit.
  useEffect(() => { setTitleDraft(null) }, [activeThreadId])

  const onNewChat = useCallback(() => {
    handleNewChat()
    composerRef.current?.focus()
  }, [handleNewChat])

  // U3: ⌘N / Ctrl+N starts a new chat while the AI tab is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        onNewChat()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onNewChat])

  // The composer paints before the provider verdict lands. Keep every early
  // submission with the conversation that owned it, then dispatch once access
  // is known. handleSend serializes them through its loading guard.
  const flushQueuedPrompt = useCallback(() => {
    if (providerPending || !hasApiKey || loading) return
    const next = peekQueuedComposerPrompt(activeThreadId)
    if (next == null) return
    if (submitMessage(next.text)) takeQueuedComposerPrompt(activeThreadId)
  }, [providerPending, hasApiKey, loading, activeThreadId, submitMessage])
  const onComposerSubmit = useCallback((text: string) => {
    if (hasApiKey === false) {
      replaceQueuedComposerPrompts(activeThreadId, text)
      return false
    }
    if (hasApiKey !== true || hasQueuedComposerPrompts(activeThreadId)) {
      enqueueComposerPrompt(text, activeThreadId)
      return true
    }
    if (submitMessage(text)) return true
    enqueueComposerPrompt(text, activeThreadId)
    return true
  }, [hasApiKey, activeThreadId, submitMessage])
  useEffect(() => {
    flushQueuedPrompt()
  }, [flushQueuedPrompt])
  const [deniedDraft, setDeniedDraft] = useState('')
  useEffect(() => {
    setDeniedDraft(hasApiKey === false ? readQueuedComposerPrompts(activeThreadId) : '')
  }, [hasApiKey, activeThreadId])
  const preserveQueuedDraft = useCallback((text: string) => {
    if (hasApiKey === false) replaceQueuedComposerPrompts(activeThreadId, text)
  }, [hasApiKey, activeThreadId])

  // Seed a chat from another view (e.g. Settings → Memory → "Chat about your
  // memory"). Always start a NEW thread, then SEND the seed as its first
  // message so the person lands in a conversation that has visibly started
  // (DEV-253) — the server-side thread-creation path handles the draft send.
  // Without AI access the send would silently no-op, so fall back to
  // pre-filling the composer next to the connect prompt.
  const seedChat = useCallback((prompt: string) => {
    handleNewChat()
    // Act after the new-chat state settles this frame: submitMessage reads the
    // latest handleSend via ref, so it sees the fresh draft (threadId null),
    // never the thread that was open before.
    requestAnimationFrame(() => {
      if (hasApiKey) {
        submitMessage(prompt)
      } else {
        enqueueComposerPrompt(prompt, null)
        setDeniedDraft(readQueuedComposerPrompts(null))
      }
      composerRef.current?.focus()
    })
  }, [handleNewChat, hasApiKey, submitMessage])

  // This view mounts only after navigation, so a seed queued before navigate
  // (Settings stashes it, then navigates here) is read on mount. The old
  // event-only path fired before this listener existed and dropped the prompt.
  // Consumption waits for the access verdict: seedChat has to choose between
  // sending and pre-filling, and until settings/hasApiKey resolve there is no
  // verdict to choose on — consuming then would destroy the seed. The one-shot
  // stash means the effect firing again after it resolves cannot double-send.
  useEffect(() => {
    const pending = consumePendingChatSeedWhenReady(settings, hasApiKey)
    if (pending) seedChat(pending)
  }, [seedChat, settings, hasApiKey])

  // Also honour live events for the case where this view is already mounted.
  useEffect(() => {
    const onSeed = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      if (typeof detail === 'string' && detail.trim()) seedChat(detail)
    }
    window.addEventListener('daylens:seed-chat', onSeed)
    return () => window.removeEventListener('daylens:seed-chat', onSeed)
  }, [seedChat])

  const isMac = useMemo(() => navigator.platform.toLowerCase().includes('mac'), [])
  const accel = useCallback(
    (key: string, shift = false) => (isMac ? `${shift ? '⇧ ' : ''}⌘ ${key}` : `Ctrl ${shift ? 'Shift ' : ''}${key}`),
    [isMac],
  )

  const copyChat = useCallback(async () => {
    const text = messages
      .filter((m) => m.state !== 'pending' && m.state !== 'cancelled' && m.state !== 'paused')
      .map((m) => `${m.role === 'user' ? 'You' : 'Daylens'}: ${m.content}`)
      .join('\n\n')
    if (!text.trim()) return
    try { await navigator.clipboard.writeText(text) } catch { /* clipboard unsupported */ }
  }, [messages])

  // The "focused message" the palette acts on is the latest completed answer.
  const latestAssistant = useMemo(() => {
    const index = messages.findIndex((m) => m.id === latestCompletedAssistantId)
    return index >= 0 ? { message: messages[index], index } : null
  }, [messages, latestCompletedAssistantId])

  // FB1: publish this view's contextual actions into the ONE global palette
  // (message actions when a message is focused, plus chat actions). The palette
  // renders them under "Actions for this message" and "Chat".
  useEffect(() => {
    if (hasApiKey === false) { clearCommandSurfaceActions(); return }
    const list: CommandSurfaceAction[] = []
    const target = latestAssistant
    const small = (node: ReactNode) => node
    if (target) {
      list.push({ id: 'msg-copy', group: 'message', label: 'Copy response', accelerator: accel('C', true), icon: small(<Copy size={15} strokeWidth={1.8} />), perform: () => handleCopy(target.message.id, target.message.content, target.message.answerKind) })
      if (!providerPending) {
        list.push({ id: 'msg-regenerate', group: 'message', label: 'Regenerate', accelerator: accel('R'), icon: small(<RefreshCw size={15} strokeWidth={1.8} />), perform: () => handleRetry(target.index, target.message) })
        alternateProviders.forEach((alt, i) => {
          list.push({ id: `msg-regen-${alt.provider}`, group: 'message', label: `Regenerate with ${alt.label}`, hint: 'Switch provider and rerun', accelerator: i === 0 ? accel('R', true) : undefined, icon: small(<RefreshCw size={15} strokeWidth={1.8} />), perform: () => switchProviderAndRetry(target.message, alt.provider) })
        })
      }
      list.push({ id: 'msg-good', group: 'message', label: 'Good response', accelerator: accel('=', true), icon: small(<ThumbsUp size={15} strokeWidth={1.8} />), perform: () => handleRate(target.message, target.message.rating === 'up' ? null : 'up') })
      list.push({ id: 'msg-bad', group: 'message', label: 'Bad response', accelerator: accel('-', true), icon: small(<ThumbsDown size={15} strokeWidth={1.8} />), perform: () => handleRate(target.message, target.message.rating === 'down' ? null : 'down') })
      if (!providerPending) {
        for (const transform of ANSWER_TRANSFORMS) {
          list.push({ id: `msg-transform-${transform.kind}`, group: 'message', label: transform.label, hint: 'Transform the answer', icon: small(<Wand2 size={15} strokeWidth={1.8} />), perform: () => transformAnswer(transform.kind) })
        }
      }
    }
    list.push({ id: 'chat-new', group: 'chat', label: 'New chat', accelerator: accel('N'), icon: small(<IconNewChat />), perform: onNewChat })
    if (!providerPending) list.push({ id: 'chat-model', group: 'chat', label: 'Change model…', hint: 'Pick the model for this chat', icon: small(<SlidersHorizontal size={15} strokeWidth={1.8} />), perform: () => setModelSelectorOpen(true) })
    if (messages.length > 0) {
      list.push({ id: 'chat-copy-all', group: 'chat', label: 'Copy chat', hint: 'Copy the whole conversation', icon: small(<Copy size={15} strokeWidth={1.8} />), perform: () => copyChat() })
    }
    if (activeThreadId != null) {
      list.push({ id: 'chat-rename', group: 'chat', label: 'Rename chat…', icon: small(<Pencil size={15} strokeWidth={1.8} />), perform: startHeaderRename })
      list.push({ id: 'chat-settings', group: 'chat', label: 'Chat settings…', icon: small(<SlidersHorizontal size={15} strokeWidth={1.8} />), perform: () => setSettingsOpen(true) })
    }
    setCommandSurfaceActions(list)
  }, [providerPending, hasApiKey, latestAssistant, alternateProviders, accel, handleCopy, handleRetry, handleRate, switchProviderAndRetry, transformAnswer, onNewChat, copyChat, activeThreadId, messages.length, startHeaderRename])

  // Drop our actions when the AI view unmounts so the palette doesn't show stale
  // chat actions from another tab.
  useEffect(() => () => clearCommandSurfaceActions(), [])

  // Direct accelerators on the focused message (⌘R, ⇧⌘C, etc.). ⌘K is owned by
  // the app shell (App.tsx) — it always opens the one palette, never a chat.
  const accelStateRef = useRef({ providerPending, hasApiKey, latestAssistant, alternateProviders, handleCopy, handleRetry, handleRate, switchProviderAndRetry })
  accelStateRef.current = { providerPending, hasApiKey, latestAssistant, alternateProviders, handleCopy, handleRetry, handleRate, switchProviderAndRetry }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = accelStateRef.current
      if (state.hasApiKey === false) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const target = state.latestAssistant
      if (state.providerPending && (!event.shiftKey || key !== 'c')) return
      if (!event.shiftKey && key === 'r') { if (target) { event.preventDefault(); void state.handleRetry(target.index, target.message) } return }
      if (event.shiftKey && key === 'r') {
        if (target) {
          event.preventDefault()
          const alt = state.alternateProviders[0]
          if (alt) void state.switchProviderAndRetry(target.message, alt.provider)
          else void state.handleRetry(target.index, target.message)
        }
        return
      }
      if (event.shiftKey && key === 'c') { if (target) { event.preventDefault(); void state.handleCopy(target.message.id, target.message.content, target.message.answerKind) } return }
      if (event.shiftKey && (event.code === 'Equal' || key === '=' || key === '+')) { if (target) { event.preventDefault(); void state.handleRate(target.message, target.message.rating === 'up' ? null : 'up') } return }
      if (event.shiftKey && (event.code === 'Minus' || key === '-' || key === '_')) { if (target) { event.preventDefault(); void state.handleRate(target.message, target.message.rating === 'down' ? null : 'down') } return }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const onSelectThread = useCallback((threadId: number) => {
    selectThread(threadId)
    composerRef.current?.focus()
  }, [selectThread])

  const onFollowUpClick = useCallback((message: ThreadMessage, text: string, source: string) => {
    track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_CLICKED, analyticsContext({
      answer_kind: message.answerKind ?? null,
      source,
      trigger: 'suggested',
    }))
    composerRef.current?.setValue(text)
  }, [analyticsContext])

  const openStarterSuggestion = useCallback((suggestion: AIStarterSuggestion) => {
    track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_CLICKED, analyticsContext({
      source: suggestion.source === 'model' ? 'starter' : 'starter_recent',
      trigger: 'suggested',
    }))
    composerRef.current?.setValue(suggestion.prompt)
  }, [analyticsContext])

  // FB8: apply a model choice. For an existing thread → per-chat override (D4).
  // For a brand-new (thread-less) chat → set the global chat model so the first
  // turn uses it. Clearing the override only applies to a thread.
  const onApplyModel = useCallback(async (provider: AIProviderMode | null, model: string | null) => {
    if (activeThreadId != null) {
      try {
        const next = await ipc.ai.setThreadSettings(activeThreadId, {
          provider,
          model,
          instructions: threadSettings.instructions ?? null,
        })
        setThreadSettings(next)
      } catch { /* leave settings as-is on failure */ }
      return
    }
    if (provider && model) {
      try {
        await ipc.settings.set({ aiChatProvider: provider, [PROVIDER_MODEL_KEY[provider]]: model })
        await refreshProvider()
      } catch { /* best-effort */ }
    }
  }, [activeThreadId, threadSettings.instructions, refreshProvider])

  // The probe behind `settings` / `hasApiKey` reads settings, detects keys and
  // CLI tools and asks the billing service, so it can take seconds. Nothing on
  // this screen waits for it: the shell, the header and the composer paint on
  // the first frame and the pieces that genuinely need the verdict fill in when
  // it arrives.
  const probeFailure = providerProbeFailureKind(loadError, initialLoading, providerPending)

  const activeChatProvider = settings ? (settings.aiChatProvider ?? settings.aiProvider) : null
  const providerMeta = activeChatProvider ? AI_PROVIDER_META[activeChatProvider] : null
  const modelLabel = providerMeta
    ? providerMeta.models.find((m) => m.id === activeModel)?.label ?? activeModel ?? providerMeta.shortLabel
    : null
  // D4: when this thread overrides the model, the subline shows THAT model.
  const overrideActive = Boolean(threadSettings.provider && threadSettings.model)
  const displayProviderMeta = overrideActive ? AI_PROVIDER_META[threadSettings.provider!] : providerMeta
  const displayModelId = overrideActive ? threadSettings.model! : activeModel
  const displayModelLabel = displayProviderMeta
    ? displayProviderMeta.models.find((m) => m.id === displayModelId)?.label ?? displayModelId ?? displayProviderMeta.shortLabel
    : null
  const cliTool = activeChatProvider === 'claude-cli'
    ? 'claude'
    : activeChatProvider === 'chatgpt-cli'
      ? 'chatgpt'
      : activeChatProvider === 'gemini-cli'
        ? 'gemini'
        : activeChatProvider === 'codex-cli'
          ? 'codex'
          : null
  const isCliProvider = Boolean(cliTool)
  const cliMissing = cliTool ? !cliTools?.[cliTool] : false
  const hasMessages = messages.length > 0
  const managedAccess = Boolean(billingAccess?.managed)

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* ── D1: time-grouped, searchable conversation list with Archive.
            FB4: always mounted, width-animated so open/close slides smoothly. ── */}
      {chatVisible && (
        <div
          style={{
            flexShrink: 0,
            width: sidebarCollapsed ? 0 : 248,
            overflow: 'hidden',
            transition: 'width 200ms cubic-bezier(0.22, 0.61, 0.36, 1)',
          }}
          aria-hidden={sidebarCollapsed}
        >
          <ConversationSidebar
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={onSelectThread}
            onDelete={deleteThread}
            onArchive={archiveThread}
            onRename={(thread, title) => { void renameThread(thread.id, title) }}
          />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
      {/* ── Top bar: sidebar toggle + thread title + model subline (U2/D2/FB8),
            ⌘K (opens the one palette), chat settings, new chat. ── */}
      <header style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px', borderBottom: '1px solid var(--color-border-ghost)' }}>
        {chatVisible && (
          <button
            type="button"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'Show chat list' : 'Hide chat list'}
            aria-label={sidebarCollapsed ? 'Show chat list' : 'Hide chat list'}
            aria-pressed={!sidebarCollapsed}
            style={{ width: 34, height: 34, padding: 0, borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: sidebarCollapsed ? 'var(--color-surface)' : 'var(--color-surface-high)', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <IconSidebar />
          </button>
        )}
        <div style={{ minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
          {titleDraft != null && activeThreadId != null ? (
            <input
              type="text"
              value={titleDraft}
              autoFocus
              aria-label="Conversation title"
              onFocus={(event) => event.target.select()}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitHeaderRename()
                else if (event.key === 'Escape') setTitleDraft(null)
              }}
              onBlur={commitHeaderRename}
              style={{ display: 'block', width: 'min(340px, 100%)', fontSize: 13, fontWeight: 680, color: 'var(--color-text-primary)', border: 'none', borderBottom: '1.5px solid var(--color-border-ghost)', background: 'transparent', outline: 'none', padding: '0 0 1px' }}
            />
          ) : (
            <button
              type="button"
              onClick={startHeaderRename}
              disabled={activeThreadId == null}
              title={activeThreadId != null ? 'Rename this conversation' : undefined}
              aria-label={activeThreadId != null ? 'Rename this conversation' : undefined}
              style={{ display: 'block', maxWidth: '100%', padding: 0, border: 'none', background: 'transparent', textAlign: 'left', fontSize: 13, fontWeight: 680, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: activeThreadId != null ? 'text' : 'default' }}
            >
              {activeThreadLabel ?? 'New chat'}
            </button>
          )}
          {hasApiKey && displayProviderMeta && (
            <button
              type="button"
              onClick={() => setModelSelectorOpen(true)}
              title="Model for this chat — with what a typical question costs"
              className="ai-model-subline"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 1, padding: '1px 5px', marginLeft: -5, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 11, cursor: 'pointer', maxWidth: '100%', overflow: 'hidden' }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {managedAccess && !overrideActive ? 'Daylens managed AI' : `${displayProviderMeta.shortLabel} · ${displayModelLabel}${overrideActive ? ' · custom' : ''}`}
              </span>
              <span style={{ display: 'inline-flex', flexShrink: 0, opacity: 0.8 }}><IconChevronDown /></span>
            </button>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 8 }} />
        <button
          type="button"
          onClick={() => openCommandPalette()}
          title="Search and commands"
          aria-label="Open command palette"
          style={{ height: 34, padding: '0 11px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, flexShrink: 0 }}
        >
          <span style={{ display: 'inline-flex', color: 'var(--color-text-tertiary)' }}><IconSparkleSearch /></span>
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.02em' }}>{isMac ? '⌘K' : 'Ctrl K'}</span>
        </button>
        {activeThreadId != null && !managedAccess && providerMeta && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={overrideActive ? 'Chat settings (custom model)' : 'Chat settings'}
            aria-label="Chat settings"
            style={{ width: 34, height: 34, padding: 0, borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: overrideActive ? 'var(--color-accent-dim)' : 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <SlidersHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={toggleMcpActivity}
          title={mcpActivityOpen ? 'Hide MCP activity' : 'Show MCP activity'}
          aria-label={mcpActivityOpen ? 'Hide MCP activity' : 'Show MCP activity'}
          aria-pressed={mcpActivityOpen}
          style={{ width: 34, height: 34, padding: 0, borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: mcpActivityOpen ? 'var(--color-surface-high)' : 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <Activity size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onNewChat}
          title="New chat (⌘N)"
          aria-label="New chat"
          style={{ width: 34, height: 34, padding: 0, borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <IconNewChat />
        </button>
      </header>

      {/* ── Conversation ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: '28px 24px 24px', minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
          {probeFailure === 'banner' && (
            <div role="alert" style={{ marginBottom: 16, padding: '10px 12px', borderRadius: 8, background: 'var(--color-surface-high)', color: 'var(--color-text-secondary)', fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span>Couldn't refresh AI settings. {loadError}</span>
              <button type="button" onClick={() => { void refreshProvider() }} style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                Retry
              </button>
            </div>
          )}
          {probeFailure === 'blocking' ? (
            <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', textAlign: 'center', maxWidth: 360 }}>
                Couldn't load AI settings. {loadError}
              </p>
              <button type="button" onClick={() => { void refreshProvider() }} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                Retry
              </button>
            </div>
          ) : settings && hasApiKey === false ? (
            <div style={{ margin: 'auto 0' }}>
              <ConnectAI
                variant="hero"
                initialProvider={settings.aiProvider}
                hasSavedAccess={false}
                onConnected={() => { void refreshProvider() }}
              />
              {deniedDraft && (
                <div style={{ width: '100%', maxWidth: 620, margin: '20px auto 0', textAlign: 'left' }}>
                  <AICompose
                    key={activeThreadId ?? 'new'}
                    ref={composerRef}
                    onSubmit={onComposerSubmit}
                    onCancel={cancelGeneration}
                    onPause={pauseGeneration}
                    loading={loading}
                    initialValue={deniedDraft}
                    onValueChange={preserveQueuedDraft}
                    placeholder="Your message is saved while you connect AI"
                  />
                </div>
              )}
              {isCliProvider && cliMissing && providerMeta && (
                <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-tertiary)' }}>
                  {providerMeta.label} is selected right now, but it is not installed on this machine yet.
                </div>
              )}
            </div>
          ) : hasMessages ? (
            <>
              <MessageList
                messages={messages}
                latestCompletedAssistantId={latestCompletedAssistantId}
                actionFeedback={actionFeedback}
                messageActionState={messageActionState}
                actionWidgetState={actionWidgetState}
                reducedMotion={reducedMotion}
                activeFocusSession={activeFocusSession}
                onCopy={handleCopy}
                onRate={handleRate}
                onRetry={handleRetry}
                onErrorRetry={handleErrorRetry}
                onSwitchProvider={switchProviderAndRetry}
                onTransform={transformAnswer}
                providerActionsDisabled={providerPending}
                onMessageAction={handleMessageAction}
                onCommitActionWidget={commitActionWidget}
                onUndoActionWidget={undoActionWidget}
                onDismissActionWidget={dismissActionWidget}
                onFollowUpClick={onFollowUpClick}
                onInspectPacket={openPacketInspector}
                onResumePaused={(message) => { void resumePausedTurn(message) }}
                onDiscardPaused={(message) => { void discardPausedTurn(message) }}
                turnPhase={turnPhase}
                scrollToBottom={scrollToBottom}
                hasEarlier={hasEarlierMessages}
                loadingEarlier={loadingEarlier}
                onLoadEarlier={onLoadEarlier}
              />
              {inspectTarget && (
                <ContextPacketInspector
                  packetId={inspectTarget.packetId}
                  messageId={inspectTarget.messageId}
                  onClose={() => setInspectTarget(null)}
                />
              )}
              {agentQuestion && (
                <AgentQuestionCard
                  question={agentQuestion}
                  onAnswer={(answer) => void answerAgentQuestion(answer)}
                  onDismiss={dismissAgentQuestion}
                />
              )}
              <div ref={bottomRef} />
            </>
          ) : threadLoading ? (
            <div style={{ margin: 'auto 0', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Loading conversation…</p>
            </div>
          ) : (
            <div style={{ margin: 'auto 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '100%' }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--gradient-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary-contrast)' }}>
                <IconSparkle size={20} />
              </div>
              <div>
                <h1 style={{ fontSize: 18, fontWeight: 720, letterSpacing: '-0.01em', margin: 0, color: 'var(--color-text-primary)' }}>
                  Ask Daylens about your work
                </h1>
                <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: '6px 0 0', lineHeight: 1.5 }}>
                  {hasHistory === false
                    ? 'Daylens is still learning your day. Ask how it works while your timeline fills in.'
                    : 'Grounded in your local history. Ask a question, or request a report, table, or export.'}
                </p>
              </div>
              <div style={{ width: '100%', maxWidth: 620, marginTop: 4, textAlign: 'left' }}>
                <AICompose ref={composerRef} onSubmit={onComposerSubmit} onCancel={cancelGeneration} onPause={pauseGeneration} loading={loading} variant="starter" placeholder="Ask anything" />
              </div>
              <div style={{ width: '100%', maxWidth: 620, textAlign: 'left' }}>
                {starterPrompts.map((suggestion, index) => (
                  <button
                    key={`${suggestion.label}:${index}`}
                    type="button"
                    onClick={() => openStarterSuggestion(suggestion)}
                    onMouseEnter={() => setHoveredStarter(index)}
                    onMouseLeave={() => setHoveredStarter(null)}
                    style={{ position: 'relative', width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none', borderBottom: index < starterPrompts.length - 1 ? '1px solid var(--color-border-ghost)' : 'none', background: hoveredStarter === index ? 'var(--color-surface-high)' : 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 12.5, textAlign: 'left', transition: 'background 120ms ease, color 120ms ease' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={{ color: 'var(--color-text-tertiary)', display: 'inline-flex' }}><IconSparkle size={14} /></span>
                      <span>{suggestion.label}</span>
                    </span>
                    {hoveredStarter === index && suggestion.prompt !== suggestion.label && (
                      <span style={{ position: 'absolute', zIndex: 20, left: 28, bottom: 'calc(100% + 6px)', width: 'min(480px, calc(100% - 36px))', padding: '9px 11px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-high)', boxShadow: 'var(--color-shadow-floating)', color: 'var(--color-text-primary)', fontSize: 11.5, lineHeight: 1.45 }}>
                        {suggestion.prompt}
                      </span>
                    )}
                  </button>
                ))}
                {starterError && (
                  <p role="status" style={{ margin: '8px 12px 0', color: 'var(--color-text-tertiary)', fontSize: 11.5 }}>
                    {starterError}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Docked composer ───────────────────────────────────────────────── */}
      {chatVisible && probeFailure !== 'blocking' && (hasMessages || threadLoading) && (
        <div style={{ flexShrink: 0, padding: '12px 24px 20px' }}>
          <div style={{ maxWidth: 760, margin: '0 auto' }}>
            <AICompose ref={composerRef} onSubmit={onComposerSubmit} onCancel={cancelGeneration} onPause={pauseGeneration} loading={loading} />
          </div>
        </div>
      )}
      </div>
      {modelSelectorOpen && providerMeta && displayProviderMeta && (
        <ModelSelector
          sources={modelSources}
          costs={modelCosts}
          currentProvider={displayProviderMeta.id}
          currentModel={displayModelId}
          isOverride={overrideActive}
          defaultLabel={managedAccess ? 'Daylens managed AI' : `${providerMeta.shortLabel} · ${modelLabel}`}
          managedActive={managedAccess}
          onApply={onApplyModel}
          onClose={() => setModelSelectorOpen(false)}
        />
      )}
      {settingsOpen && activeThreadId != null && !managedAccess && providerMeta && (
        <ThreadSettingsPanel
          threadId={activeThreadId}
          initial={threadSettings}
          providerAvailability={providerAvailability}
          globalLabel={`${providerMeta.shortLabel} · ${modelLabel}`}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => setThreadSettings(next)}
        />
      )}
      <div
        style={{
          flexShrink: 0,
          width: mcpActivityOpen ? 280 : 0,
          overflow: 'hidden',
          transition: 'width 200ms cubic-bezier(0.22, 0.61, 0.36, 1)',
        }}
        aria-hidden={!mcpActivityOpen}
      >
        {mcpActivityOpen && <McpActivityPanel />}
      </div>
    </div>
  )
}

// A search-glyph for the header ⌘K affordance (search now lives in the palette).
function IconSparkleSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  )
}
