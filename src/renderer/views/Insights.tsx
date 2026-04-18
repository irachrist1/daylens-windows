import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ANALYTICS_EVENT, blockCountBucket, classifyAIOutputIntent, trackedTimeBucket } from '@shared/analytics'
import type {
  AIChatTurnResult,
  AIMessageArtifact,
  AIMessageAction,
  AIThreadMessage,
  AppSettings,
  DayTimelinePayload,
  FocusSession,
} from '@shared/types'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { track } from '../lib/analytics'
import { ipc } from '../lib/ipc'
import { formatDuration, todayString } from '../lib/format'
import { AI_PROVIDER_META, getSelectedModel } from '../lib/aiProvider'
import ConnectAI from '../components/ConnectAI'

type ThreadMessage = Omit<AIThreadMessage, 'id'> & {
  id: string | number
  state: 'complete' | 'pending' | 'error'
}

type MessageAction = 'copy' | 'up' | 'down' | 'retry'

interface ActionFeedbackEntry {
  pulseNonce: number
  success: boolean
}

function actionFeedbackKey(messageId: string | number, action: MessageAction): string {
  return `${String(messageId)}:${action}`
}

function messageActionKey(messageId: string | number, action: AIMessageAction): string {
  const suffix = action.kind === 'start_focus_session'
    ? action.payload.label ?? action.payload.targetMinutes ?? 'start'
    : action.sessionId
  return `${String(messageId)}:${action.kind}:${String(suffix)}`
}

function artifactFormatLabel(artifact: AIMessageArtifact): string {
  switch (artifact.format) {
    case 'csv':
      return 'CSV'
    case 'html':
      return 'HTML'
    case 'json':
      return 'JSON'
    case 'markdown':
    default:
      return 'Markdown'
  }
}

function inlineNodes(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`([^`]+)`/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const full = match[0]
    if (full.startsWith('**')) {
      parts.push(<strong key={match.index}>{match[1]}</strong>)
    } else if (full.startsWith('*') || full.startsWith('_')) {
      parts.push(<em key={match.index}>{match[2] ?? match[3]}</em>)
    } else {
      parts.push(<code key={match.index} className="bg-[var(--color-surface-high)] px-1 py-px rounded text-[12px]">{match[4]}</code>)
    }
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function MarkdownBlock({ text, blockKey }: { text: string; blockKey: number }): ReactNode {
  const lines = text.split('\n').map((line) => line.trimEnd())
  const nonEmpty = lines.filter((line) => line.trim())
  if (nonEmpty.length === 0) return null

  if (/^#{1,4}\s/.test(nonEmpty[0])) {
    const level = nonEmpty[0].match(/^(#{1,4})/)?.[1].length ?? 2
    const content = nonEmpty[0].replace(/^#{1,4}\s+/, '')
    const sizeClass = level === 1 ? 'text-[16px]' : level === 2 ? 'text-[14px]' : 'text-[13px]'
    return <p key={blockKey} className={`${sizeClass} font-semibold text-[var(--color-text-primary)] leading-snug`}>{inlineNodes(content)}</p>
  }

  if (nonEmpty.every((line) => /^[-*]\s/.test(line))) {
    return (
      <ul key={blockKey} className="flex flex-col gap-1 pl-1">
        {nonEmpty.map((line, index) => (
          <li key={index} className="flex gap-2 text-[13px] leading-relaxed">
            <span className="shrink-0 opacity-40 mt-0.5">-</span>
            <span>{inlineNodes(line.replace(/^[-*]\s+/, ''))}</span>
          </li>
        ))}
      </ul>
    )
  }

  if (nonEmpty.every((line) => /^\d+\.\s/.test(line))) {
    return (
      <ol key={blockKey} className="flex flex-col gap-1 pl-1">
        {nonEmpty.map((line, index) => (
          <li key={index} className="flex gap-2 text-[13px] leading-relaxed">
            <span className="shrink-0 text-[var(--color-text-tertiary)] tabular-nums min-w-[1.2em] text-right">
              {line.match(/^(\d+)\./)?.[1] ?? index + 1}.
            </span>
            <span>{inlineNodes(line.replace(/^\d+\.\s+/, ''))}</span>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <p key={blockKey} className="text-[13px] leading-relaxed">
      {lines.flatMap((line, index) => {
        const nodes = inlineNodes(line)
        return index < lines.length - 1 ? [...nodes, <br key={`br-${index}`} />] : nodes
      })}
    </p>
  )
}

function MarkdownMessage({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean)
  if (blocks.length === 0) {
    return <p className="text-[13px] leading-relaxed">{content}</p>
  }
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((block, index) => <MarkdownBlock key={index} text={block} blockKey={index} />)}
    </div>
  )
}

function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="3" width="8" height="10" rx="2" />
      <path d="M3.5 11.5h-1A1.5 1.5 0 0 1 1 10V3.5A1.5 1.5 0 0 1 2.5 2H8" />
    </svg>
  )
}

function IconThumbsUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 7 8.8 2.8A1.3 1.3 0 0 1 11.2 4v2h1.4A1.4 1.4 0 0 1 14 7.7l-.8 4A1.8 1.8 0 0 1 11.4 13H6.5" />
      <path d="M2 7h4.5v6H2z" />
    </svg>
  )
}

function IconThumbsDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 9 7.2 13.2A1.3 1.3 0 0 1 4.8 12v-2H3.4A1.4 1.4 0 0 1 2 8.3l.8-4A1.8 1.8 0 0 1 4.6 3h4.9" />
      <path d="M9.5 3H14v6H9.5z" />
    </svg>
  )
}

function IconRetry() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 5V1.8h-3.2" />
      <path d="M13 2.2A6 6 0 1 0 14 8" />
    </svg>
  )
}

function IconActionButton({
  label,
  feedbackLabel,
  selected = false,
  success = false,
  tone = 'neutral',
  pulseNonce = 0,
  reducedMotion = false,
  onClick,
  children,
}: {
  label: string
  feedbackLabel?: string
  selected?: boolean
  success?: boolean
  tone?: 'neutral' | 'positive' | 'negative'
  pulseNonce?: number
  reducedMotion?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const [pressed, setPressed] = useState(false)
  const pulseName = pulseNonce > 0
    ? (pulseNonce % 2 === 0 ? 'insightsActionBounceA' : 'insightsActionBounceB')
    : null

  const selectedBackground = tone === 'negative'
    ? 'rgba(248, 113, 113, 0.10)'
    : 'var(--color-accent-dim)'
  const selectedBorder = tone === 'negative'
    ? 'rgba(248, 113, 113, 0.30)'
    : 'rgba(173, 198, 255, 0.28)'
  const selectedText = tone === 'negative'
    ? '#f87171'
    : 'var(--color-text-primary)'
  const background = success ? 'rgba(79, 219, 200, 0.12)' : selected ? selectedBackground : 'transparent'
  const borderColor = success ? 'rgba(79, 219, 200, 0.30)' : selected ? selectedBorder : 'var(--color-border-ghost)'
  const textColor = success ? 'var(--color-focus-green)' : selected ? selectedText : 'var(--color-text-secondary)'

  return (
    <button
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          setPressed(true)
        }
      }}
      onKeyUp={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          setPressed(false)
        }
      }}
      onBlur={() => setPressed(false)}
      title={feedbackLabel ?? label}
      aria-label={feedbackLabel ?? label}
      style={{
        ...actionButtonStyle,
        color: textColor,
        background,
        borderColor,
        transform: reducedMotion
          ? undefined
          : pressed
            ? 'scale(0.92)'
            : undefined,
        animation: !reducedMotion && pulseName
          ? `${pulseName} 200ms cubic-bezier(0.2, 0.9, 0.2, 1.15)`
          : undefined,
      }}
    >
      {children}
    </button>
  )
}

function summaryText(today: DayTimelinePayload | null): string {
  if (!today || today.totalSeconds === 0) {
    return 'No tracked activity yet today. Once Daylens has real local history, this screen can answer questions about your work, files, pages, and focus patterns.'
  }

  const topBlocks = today.blocks
    .slice(0, 3)
    .map((block) => block.label.current)
    .filter(Boolean)

  const topArtifacts = today.blocks
    .flatMap((block) => block.topArtifacts)
    .slice(0, 3)
    .map((artifact) => artifact.displayTitle)
    .filter(Boolean)

  const parts = [
    `You tracked ${formatDuration(today.totalSeconds)} across ${today.blocks.length} block${today.blocks.length !== 1 ? 's' : ''} today.`,
    topBlocks.length > 0 ? `The strongest threads were ${topBlocks.join(', ')}.` : null,
    topArtifacts.length > 0 ? `Key artifacts included ${topArtifacts.join(', ')}.` : null,
    `Focus time was ${formatDuration(today.focusSeconds)} (${today.focusPct}%).`,
  ]

  return parts.filter(Boolean).join(' ')
}

function starterPrompts(today: DayTimelinePayload | null): string[] {
  if (!today || today.totalSeconds === 0) {
    return [
      'What kinds of questions will you be able to answer once I have more history?',
      'How should I use Daylens if I am not tracking clients?',
      'What should I pay attention to the first few days of tracking?',
      'How can I ask for a report or table later?',
    ]
  }

  return [
    'What did I actually get done today?',
    'Which files, docs, or pages did I touch today?',
    'Where did my focus break down today?',
    'Summarize today as a short report I could share',
    'Compare today with yesterday',
  ]
}

function threadMessagesFromHistory(history: AIThreadMessage[]): ThreadMessage[] {
  return history.map((message, index) => ({
    ...message,
    id: message.id ?? `history:${index}:${message.role}`,
    state: 'complete',
  }))
}

export default function Insights() {
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [actionFeedback, setActionFeedback] = useState<Record<string, ActionFeedbackEntry>>({})
  const [messageActionState, setMessageActionState] = useState<Record<string, { busy: boolean; error: string | null; successLabel: string | null }>>({})
  const [focusReviewDrafts, setFocusReviewDrafts] = useState<Record<string, string>>({})
  const [heroSummary, setHeroSummary] = useState('')
  const [heroQuestions, setHeroQuestions] = useState<string[]>([])
  const [heroSummaryLoading, setHeroSummaryLoading] = useState(false)
  const [heroSummarySignature, setHeroSummarySignature] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [cliTools, setCliTools] = useState<{ claude: string | null; codex: string | null } | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const historyHydratedRef = useRef(false)
  const actionFeedbackTimeoutsRef = useRef<Record<string, number>>({})
  const suggestionImpressionsRef = useRef<Record<string, boolean>>({})
  const aiScreenTrackedRef = useRef(false)
  loadingRef.current = loading

  const insightsResource = useProjectionResource<{
    history: AIThreadMessage[]
    settings: AppSettings
    cliTools: { claude: string | null; codex: string | null }
    hasProviderAccess: boolean
    today: DayTimelinePayload | null
    activeFocusSession: FocusSession | null
  }>({
    scope: 'insights',
    load: async () => {
      const currentSettings = await ipc.settings.get()
      const chatProvider = currentSettings.aiChatProvider ?? currentSettings.aiProvider
      const providersToCheck = Array.from(new Set([
        chatProvider,
        ...(currentSettings.aiFallbackOrder ?? []),
      ]))

      const [history, cliToolsResult, apiProviderAccessChecks, today, activeFocusSession] = await Promise.all([
        ipc.ai.getHistory().catch(() => []),
        ipc.ai.detectCliTools().catch(() => ({ claude: null, codex: null })),
        Promise.all(providersToCheck
          .filter((provider) => provider !== 'claude-cli' && provider !== 'codex-cli')
          .map((provider) => ipc.settings.hasApiKey(provider).catch(() => false))),
        ipc.db.getTimelineDay(todayString()).catch(() => null),
        ipc.focus.getActive().catch(() => null),
      ])
      const providerAccess = providersToCheck.some((provider) => (
        provider === 'claude-cli'
          ? !!cliToolsResult.claude
          : provider === 'codex-cli'
            ? !!cliToolsResult.codex
            : apiProviderAccessChecks.shift() ?? false
      ))

      return {
        history: history as AIThreadMessage[],
        settings: currentSettings,
        cliTools: cliToolsResult as { claude: string | null; codex: string | null },
        hasProviderAccess: providerAccess,
        today: today as DayTimelinePayload | null,
        activeFocusSession: activeFocusSession as FocusSession | null,
      }
    },
  })

  useEffect(() => {
    if (!insightsResource.data) return
    setSettings(insightsResource.data.settings)
    setCliTools(insightsResource.data.cliTools)
    setHasApiKey(insightsResource.data.hasProviderAccess)
    if (!historyHydratedRef.current && !loadingRef.current) {
      setMessages(threadMessagesFromHistory(insightsResource.data.history))
      historyHydratedRef.current = true
    }
  }, [insightsResource.data])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    return ipc.ai.onStream((event) => {
      setMessages((current) => current.map((message) => (
        message.id === `assistant:${event.requestId}`
          ? { ...message, content: event.snapshot }
          : message
      )))
    })
  }, [])

  useEffect(() => {
    return () => {
      for (const timeout of Object.values(actionFeedbackTimeoutsRef.current)) {
        window.clearTimeout(timeout)
      }
    }
  }, [])

  const today = insightsResource.data?.today ?? null
  const activeFocusSession = insightsResource.data?.activeFocusSession ?? null
  const activeProvider = settings ? (settings.aiChatProvider ?? settings.aiProvider) : null
  const activeModel = settings && activeProvider
    ? getSelectedModel({
        aiProvider: activeProvider,
        anthropicModel: settings.anthropicModel,
        openaiModel: settings.openaiModel,
        googleModel: settings.googleModel,
      })
    : null

  function analyticsContext(extra: Record<string, unknown> = {}) {
    return {
      block_count_bucket: blockCountBucket(today?.blocks.length ?? 0),
      has_ai_provider: Boolean(hasApiKey),
      ...(activeModel ? { model: activeModel } : {}),
      ...(activeProvider ? { provider: activeProvider } : {}),
      surface: 'ai',
      tracked_time_bucket: trackedTimeBucket(today?.totalSeconds ?? 0),
      ...extra,
    }
  }

  const latestCompletedAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.state === 'complete')?.id

  useEffect(() => {
    if (!settings || hasApiKey === null || aiScreenTrackedRef.current) return
    aiScreenTrackedRef.current = true
    track(ANALYTICS_EVENT.AI_SCREEN_OPENED, analyticsContext({
      trigger: 'navigation',
      view: 'ai',
    }))
  }, [hasApiKey, settings, today])

  useEffect(() => {
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => (
        message.role === 'assistant'
        && message.state === 'complete'
        && message.id === latestCompletedAssistantId
        && (message.suggestedFollowUps?.length ?? 0) >= 2
      ))

    if (!latestAssistant) return
    const key = String(latestAssistant.id)
    if (suggestionImpressionsRef.current[key]) return
    suggestionImpressionsRef.current[key] = true
    track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_IMPRESSION, analyticsContext({
      answer_kind: latestAssistant.answerKind ?? null,
      suggestion_count: latestAssistant.suggestedFollowUps?.length ?? 0,
      source: 'followup',
    }))
  }, [latestCompletedAssistantId, messages])

  function triggerActionFeedback(
    messageId: string | number,
    action: MessageAction,
    options?: { successMs?: number },
  ) {
    const key = actionFeedbackKey(messageId, action)
    const success = Boolean(options?.successMs)

    if (actionFeedbackTimeoutsRef.current[key]) {
      window.clearTimeout(actionFeedbackTimeoutsRef.current[key])
      delete actionFeedbackTimeoutsRef.current[key]
    }

    setActionFeedback((current) => ({
      ...current,
      [key]: {
        pulseNonce: (current[key]?.pulseNonce ?? 0) + 1,
        success,
      },
    }))

    if (options?.successMs) {
      actionFeedbackTimeoutsRef.current[key] = window.setTimeout(() => {
        setActionFeedback((current) => {
          const entry = current[key]
          if (!entry) return current
          return {
            ...current,
            [key]: {
              ...entry,
              success: false,
            },
          }
        })
        delete actionFeedbackTimeoutsRef.current[key]
      }, options.successMs)
    }
  }

  async function handleSend(
    text?: string,
    options?: {
      contextOverride?: ThreadMessage['contextSnapshot']
      trigger?: 'freeform' | 'suggested' | 'retry'
    },
  ) {
    const prompt = (text ?? input).trim()
    if (!prompt || loading || !hasApiKey) return
    const trigger = options?.trigger ?? 'freeform'
    const queryKind = classifyAIOutputIntent(prompt)

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const createdAt = Date.now()
    const userId = `user:${requestId}`
    const assistantId = `assistant:${requestId}`

    track(ANALYTICS_EVENT.AI_QUERY_SENT, analyticsContext({
      query_kind: queryKind,
      trigger,
    }))
    if (queryKind !== 'question') {
      track(ANALYTICS_EVENT.AI_OUTPUT_REQUESTED, analyticsContext({
        export_type: queryKind,
        trigger,
      }))
    }

    setLoading(true)
    setInput('')
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', content: prompt, createdAt, state: 'complete' },
      { id: assistantId, role: 'assistant', content: '', createdAt, state: 'pending' },
    ])

    try {
      const response = await ipc.ai.sendMessage({
        message: prompt,
        contextOverride: options?.contextOverride ?? null,
        clientRequestId: requestId,
      }) as AIChatTurnResult
      setMessages((current) => current.map((message) => {
        if (message.id !== assistantId) return message
        return { ...response.assistantMessage, state: 'complete' }
      }))
      track(ANALYTICS_EVENT.AI_QUERY_ANSWERED, analyticsContext({
        answer_kind: response.assistantMessage.answerKind ?? null,
        query_kind: queryKind,
        trigger,
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMessages((current) => current.map((entry) => (
        entry.id === assistantId
          ? { ...entry, content: message, state: 'error' }
          : entry
      )))
    } finally {
      setLoading(false)
    }
  }

  async function handleRetry(index: number, message: ThreadMessage) {
    if (message.id !== latestCompletedAssistantId) return
    triggerActionFeedback(message.id, 'retry')
    track(ANALYTICS_EVENT.AI_ANSWER_RETRIED, analyticsContext({
      answer_kind: message.answerKind ?? null,
      trigger: 'retry',
    }))
    const historyUpToMessage = messages.slice(0, index)
    const previousUser = [...historyUpToMessage].reverse().find((message) => message.role === 'user')
    if (!previousUser) return
    await handleSend(previousUser.content, {
      contextOverride: message.contextSnapshot ?? null,
      trigger: 'retry',
    })
  }

  async function handleCopy(messageId: string | number, content: string, answerKind: ThreadMessage['answerKind']) {
    try {
      await navigator.clipboard.writeText(content)
      triggerActionFeedback(messageId, 'copy', { successMs: 900 })
      track(ANALYTICS_EVENT.AI_ANSWER_COPIED, analyticsContext({
        answer_kind: answerKind ?? null,
        trigger: 'copy',
      }))
    } catch {
      // Ignore clipboard failures on unsupported environments.
    }
  }

  async function handleRate(message: ThreadMessage, rating: 'up' | 'down' | null) {
    if (typeof message.id !== 'number') return

    const previousRating = message.rating ?? null
    const previousRatingUpdatedAt = message.ratingUpdatedAt ?? null

    setMessages((current) => current.map((entry) => (
      entry.id === message.id
        ? {
            ...entry,
            rating,
            ratingUpdatedAt: rating ? Date.now() : null,
          }
        : entry
    )))

    try {
      const persisted = await ipc.ai.setMessageFeedback({
        messageId: message.id,
        rating,
      })

      if (persisted) {
        setMessages((current) => current.map((entry) => (
          entry.id === message.id
            ? { ...entry, ...persisted, state: entry.state }
            : entry
        )))
      }
    } catch {
      setMessages((current) => current.map((entry) => (
        entry.id === message.id
          ? {
              ...entry,
              rating: previousRating,
              ratingUpdatedAt: previousRatingUpdatedAt,
            }
          : entry
      )))
    }
  }

  async function handleMessageAction(messageId: string | number, action: AIMessageAction) {
    const key = messageActionKey(messageId, action)
    setMessageActionState((current) => ({
      ...current,
      [key]: {
        busy: true,
        error: null,
        successLabel: null,
      },
    }))

    try {
      if (action.kind === 'start_focus_session') {
        await ipc.focus.start(action.payload)
        setMessageActionState((current) => ({
          ...current,
          [key]: { busy: false, error: null, successLabel: 'Focus session started.' },
        }))
      } else if (action.kind === 'stop_focus_session') {
        await ipc.focus.stop(action.sessionId)
        setMessageActionState((current) => ({
          ...current,
          [key]: { busy: false, error: null, successLabel: 'Focus session stopped.' },
        }))
      } else {
        const draft = (focusReviewDrafts[key] ?? action.suggestedNote ?? '').trim()
        if (!draft) {
          setMessageActionState((current) => ({
            ...current,
            [key]: { busy: false, error: 'Add a short review before saving it.', successLabel: null },
          }))
          return
        }
        await ipc.focus.saveReflection({
          sessionId: action.sessionId,
          note: draft,
        })
        setMessageActionState((current) => ({
          ...current,
          [key]: { busy: false, error: null, successLabel: 'Focus review saved.' },
        }))
      }
      await insightsResource.refresh()
    } catch (error) {
      setMessageActionState((current) => ({
        ...current,
        [key]: {
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          successLabel: null,
        },
      }))
    }
  }

  const defaultSummary = summaryText(today)
  const defaultChips = starterPrompts(today)
  const focusChips = activeFocusSession
    ? [
        'Stop my current focus session',
        'Review my last focus session',
      ]
    : [
        'Start a 45 minute focus session for what I am doing now',
        'Help me set up a focus session for this work',
      ]
  const promptChips = Array.from(new Set([...(heroQuestions.length > 0 ? heroQuestions : defaultChips), ...focusChips])).slice(0, 6)
  const daySummarySignature = today
    ? JSON.stringify({
        date: today.date,
        totalSeconds: today.totalSeconds,
        focusSeconds: today.focusSeconds,
        focusPct: today.focusPct,
        blockCount: today.blocks.length,
        blockLabels: today.blocks.map((block) => block.label.current),
        artifacts: today.blocks.flatMap((block) => block.topArtifacts.slice(0, 2).map((artifact) => artifact.displayTitle)),
      })
    : 'no-day'
  const todayDateKey = today?.date ?? 'no-day'
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const hasHeroSummary = heroSummary.trim().length > 0
  const heroSummaryIsStale = Boolean(heroSummarySignature && heroSummarySignature !== daySummarySignature)
  const canGenerateHeroSummary = Boolean(today && hasApiKey && today.totalSeconds > 0)

  async function handleGenerateHeroSummary() {
    if (!today || !hasApiKey || today.totalSeconds === 0) {
      setHeroSummary(defaultSummary)
      setHeroQuestions([])
      setHeroSummarySignature(null)
      setHeroSummaryLoading(false)
      return
    }

    setHeroSummaryLoading(true)

    try {
      const result = await ipc.ai.generateDaySummary(today.date)
      setHeroSummary(result.summary.trim() || defaultSummary)
      setHeroQuestions(result.questionSuggestions.length > 0 ? result.questionSuggestions : [])
      setHeroSummarySignature(daySummarySignature)
      track(ANALYTICS_EVENT.AI_SUMMARY_GENERATED, analyticsContext({
        answer_kind: 'day_summary_style',
        trigger: 'manual',
      }))
    } catch {
      setHeroSummary(defaultSummary)
      setHeroQuestions([])
      setHeroSummarySignature(daySummarySignature)
    } finally {
      setHeroSummaryLoading(false)
    }
  }

  useEffect(() => {
    setHeroSummary('')
    setHeroQuestions([])
    setHeroSummaryLoading(false)
    setHeroSummarySignature(null)
  }, [hasApiKey, todayDateKey])

  if (!settings || hasApiKey === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Loading AI…</p>
      </div>
    )
  }

  const activeChatProvider = settings.aiChatProvider ?? settings.aiProvider
  const providerMeta = AI_PROVIDER_META[activeChatProvider]
  const isCliProvider = activeChatProvider === 'claude-cli' || activeChatProvider === 'codex-cli'
  const cliMissing = activeChatProvider === 'claude-cli'
    ? !cliTools?.claude
    : activeChatProvider === 'codex-cli'
      ? !cliTools?.codex
      : false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '32px 40px 20px', maxWidth: 960, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 24 }}>
            <div>
              <h1 style={{ fontSize: 30, fontWeight: 780, letterSpacing: '-0.03em', margin: 0, color: 'var(--color-text-primary)' }}>
                AI
              </h1>
              <p style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', margin: '6px 0 0' }}>
                {todayLabel}
              </p>
            </div>
            {messages.length > 0 && (
              <button
                onClick={() => void ipc.ai.clearHistory().then(() => {
                  setMessages([])
                  setActionFeedback({})
                  setMessageActionState({})
                  setFocusReviewDrafts({})
                  suggestionImpressionsRef.current = {}
                  historyHydratedRef.current = true
                })}
                style={{
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border-ghost)',
                  background: 'var(--color-surface)',
                  color: 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                New chat
              </button>
            )}
          </div>

          {!hasApiKey && (
            <div style={{ marginBottom: 20 }}>
              <ConnectAI
                variant="hero"
                initialProvider={settings.aiProvider}
                hasSavedAccess={false}
                onConnected={() => { void insightsResource.refresh() }}
              />
              {isCliProvider && cliMissing && (
                <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-tertiary)' }}>
                  {providerMeta.label} is selected right now, but it is not installed on this machine yet.
                </div>
              )}
            </div>
          )}

          {hasApiKey && (
            <div style={{ display: 'grid', gap: 20 }}>
              {messages.length === 0 && (
                <>
                  <div style={{
                    borderRadius: 18,
                    border: '1px solid var(--color-border-ghost)',
                    background: 'var(--color-surface)',
                    padding: '20px 22px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 14, lineHeight: 1.75, color: 'var(--color-text-primary)', margin: 0 }}>
                          {canGenerateHeroSummary
                            ? (heroSummary || 'Generate a grounded briefing when you want a quick read on today, or jump straight into one of the questions below.')
                            : defaultSummary}
                        </p>
                        {hasHeroSummary && heroSummaryIsStale && (
                          <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-tertiary)', margin: '10px 0 0' }}>
                            More activity has been captured since this summary was generated.
                          </p>
                        )}
                      </div>
                      {canGenerateHeroSummary && (
                        <button
                          onClick={() => void handleGenerateHeroSummary()}
                          disabled={heroSummaryLoading}
                          style={{
                            padding: '9px 14px',
                            borderRadius: 999,
                            border: '1px solid rgba(173, 198, 255, 0.24)',
                            background: 'var(--gradient-primary)',
                            color: 'var(--color-primary-contrast)',
                            fontSize: 12.5,
                            fontWeight: 750,
                            cursor: heroSummaryLoading ? 'progress' : 'pointer',
                            opacity: heroSummaryLoading ? 0.78 : 1,
                            boxShadow: '0 10px 24px rgba(77, 142, 255, 0.18)',
                            flexShrink: 0,
                          }}
                        >
                          {heroSummaryLoading
                            ? 'Generating…'
                            : hasHeroSummary
                              ? (heroSummaryIsStale ? 'Refresh summary' : 'Regenerate summary')
                              : 'Generate summary'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <div style={{
                      fontSize: 10.5,
                      fontWeight: 800,
                      letterSpacing: '0.10em',
                      textTransform: 'uppercase',
                      color: 'var(--color-text-tertiary)',
                      marginBottom: 10,
                    }}>
                      Ask Daylens
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {promptChips.map((chip) => (
                        <button
                          key={chip}
                          onClick={() => {
                            track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_CLICKED, analyticsContext({
                              source: heroQuestions.length > 0 && heroQuestions.includes(chip) ? 'summary_card' : 'default_chip',
                              trigger: 'suggested',
                            }))
                            void handleSend(chip, { trigger: 'suggested' })
                          }}
                          style={{
                            padding: '8px 14px',
                            borderRadius: 999,
                            border: '1px solid var(--color-border-ghost)',
                            background: 'transparent',
                            color: 'var(--color-text-secondary)',
                            cursor: 'pointer',
                            fontSize: 12.5,
                          }}
                        >
                          {chip}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {messages.length > 0 && (
                <div style={{ display: 'grid', gap: 16 }}>
                  {messages.map((message, index) => (
                    message.role === 'user' ? (
                      <div key={message.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <div style={{
                          maxWidth: '76%',
                          borderRadius: '14px 14px 6px 14px',
                          background: 'var(--color-accent-dim)',
                          color: 'var(--color-primary)',
                          padding: '11px 14px',
                          fontSize: 13,
                          fontWeight: 550,
                        }}>
                          {message.content}
                        </div>
                      </div>
                    ) : (
                      <div key={message.id} style={{ display: 'flex', gap: 10, alignItems: 'start' }}>
                        <div style={{
                          width: 26,
                          height: 26,
                          borderRadius: 7,
                          background: 'var(--color-surface-high)',
                          color: 'var(--color-text-primary)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 11,
                          fontWeight: 800,
                          flexShrink: 0,
                          marginTop: 1,
                        }}>
                          D
                        </div>
                        <div style={{
                          flex: 1,
                          borderRadius: 16,
                          border: message.state === 'error'
                            ? '1px solid rgba(248, 113, 113, 0.28)'
                            : '1px solid var(--color-border-ghost)',
                          background: message.state === 'error'
                            ? 'rgba(248, 113, 113, 0.08)'
                            : 'var(--color-surface)',
                          padding: '16px 16px 12px',
                        }}>
                          {message.state === 'pending' ? (
                            message.content.trim()
                              ? (
                                  <>
                                    <MarkdownMessage content={message.content} />
                                    <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 10 }}>
                                      Thinking…
                                    </div>
                                  </>
                                )
                              : (
                                  <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                                    Thinking…
                                  </div>
                                )
                          ) : (
                            <>
                              {message.state === 'error' && (
                                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#f87171', marginBottom: 8 }}>
                                  Provider error
                                </div>
                              )}
                              <MarkdownMessage content={message.content} />
                              {(message.actions?.length ?? 0) > 0 && (
                                <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                                  {message.actions?.map((action) => {
                                    const key = messageActionKey(message.id, action)
                                    const state = messageActionState[key]

                                    if (action.kind === 'review_focus_session') {
                                      const draft = focusReviewDrafts[key] ?? action.suggestedNote ?? ''
                                      return (
                                        <div
                                          key={key}
                                          style={{
                                            borderRadius: 12,
                                            border: '1px solid var(--color-border-ghost)',
                                            background: 'var(--color-surface-low)',
                                            padding: 12,
                                            display: 'grid',
                                            gap: 8,
                                          }}
                                        >
                                          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                                            Save a short reflection to this focus session.
                                          </div>
                                          <textarea
                                            value={draft}
                                            onChange={(event) => {
                                              const value = event.target.value
                                              setFocusReviewDrafts((current) => ({ ...current, [key]: value }))
                                            }}
                                            placeholder={action.placeholder ?? 'Add a short focus review'}
                                            rows={4}
                                            style={{
                                              width: '100%',
                                              resize: 'vertical',
                                              borderRadius: 10,
                                              border: '1px solid var(--color-border-ghost)',
                                              background: 'var(--color-surface)',
                                              color: 'var(--color-text-primary)',
                                              padding: '10px 12px',
                                              fontSize: 12.5,
                                              lineHeight: 1.6,
                                              outline: 'none',
                                            }}
                                          />
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                            <button
                                              type="button"
                                              onClick={() => void handleMessageAction(message.id, action)}
                                              disabled={state?.busy}
                                              style={{
                                                padding: '8px 12px',
                                                borderRadius: 9,
                                                border: '1px solid var(--color-border-ghost)',
                                                background: 'var(--color-surface)',
                                                color: 'var(--color-text-primary)',
                                                fontSize: 12.5,
                                                fontWeight: 700,
                                                cursor: state?.busy ? 'default' : 'pointer',
                                                opacity: state?.busy ? 0.7 : 1,
                                              }}
                                            >
                                              {state?.busy ? 'Saving…' : action.label}
                                            </button>
                                            {state?.successLabel && (
                                              <span style={{ fontSize: 12, color: 'var(--color-focus-green)' }}>{state.successLabel}</span>
                                            )}
                                            {state?.error && (
                                              <span style={{ fontSize: 12, color: '#f87171' }}>{state.error}</span>
                                            )}
                                          </div>
                                        </div>
                                      )
                                    }

                                    const disabled = state?.busy
                                      || (action.kind === 'start_focus_session' && Boolean(activeFocusSession))
                                      || (action.kind === 'stop_focus_session' && activeFocusSession?.id !== action.sessionId)
                                    const contextHint = action.kind === 'start_focus_session' && activeFocusSession
                                      ? 'A focus session is already active.'
                                      : action.kind === 'stop_focus_session' && activeFocusSession?.id !== action.sessionId
                                        ? 'That focus session is no longer active.'
                                        : null

                                    return (
                                      <div
                                        key={key}
                                        style={{
                                          borderRadius: 12,
                                          border: '1px solid var(--color-border-ghost)',
                                          background: 'var(--color-surface-low)',
                                          padding: 12,
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          gap: 12,
                                          flexWrap: 'wrap',
                                        }}
                                      >
                                        <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                                          {contextHint ?? (action.kind === 'start_focus_session'
                                            ? 'Start a focus session from this chat context.'
                                            : 'Stop the active focus session from here.')}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                          <button
                                            type="button"
                                            onClick={() => void handleMessageAction(message.id, action)}
                                            disabled={disabled}
                                            style={{
                                              padding: '8px 12px',
                                              borderRadius: 9,
                                              border: '1px solid var(--color-border-ghost)',
                                              background: 'var(--color-surface)',
                                              color: 'var(--color-text-primary)',
                                              fontSize: 12.5,
                                              fontWeight: 700,
                                              cursor: disabled ? 'default' : 'pointer',
                                              opacity: disabled ? 0.7 : 1,
                                            }}
                                          >
                                            {state?.busy
                                              ? (action.kind === 'start_focus_session' ? 'Starting…' : 'Stopping…')
                                              : action.label}
                                          </button>
                                          {state?.successLabel && (
                                            <span style={{ fontSize: 12, color: 'var(--color-focus-green)' }}>{state.successLabel}</span>
                                          )}
                                          {state?.error && (
                                            <span style={{ fontSize: 12, color: '#f87171' }}>{state.error}</span>
                                          )}
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                              {(message.artifacts?.length ?? 0) > 0 && (
                                <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                                  {message.artifacts?.map((artifact) => (
                                    <div
                                      key={`${message.id}:${artifact.id}`}
                                      style={{
                                        borderRadius: 12,
                                        border: '1px solid var(--color-border-ghost)',
                                        background: 'var(--color-surface-low)',
                                        padding: 12,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: 12,
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                                            {artifact.title}
                                          </span>
                                          <span style={{
                                            borderRadius: 999,
                                            padding: '3px 8px',
                                            background: 'var(--color-surface)',
                                            color: 'var(--color-text-secondary)',
                                            fontSize: 11,
                                            fontWeight: 700,
                                          }}>
                                            {artifactFormatLabel(artifact)}
                                          </span>
                                        </div>
                                        {artifact.subtitle && (
                                          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                                            {artifact.subtitle}
                                          </div>
                                        )}
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => { void ipc.shell.openPath(artifact.path) }}
                                        style={{
                                          padding: '8px 12px',
                                          borderRadius: 9,
                                          border: '1px solid var(--color-border-ghost)',
                                          background: 'var(--color-surface)',
                                          color: 'var(--color-text-primary)',
                                          fontSize: 12.5,
                                          fontWeight: 700,
                                          cursor: 'pointer',
                                        }}
                                      >
                                        Open
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {message.id === latestCompletedAssistantId && message.state === 'complete' && (message.suggestedFollowUps?.length ?? 0) >= 2 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                                  {message.suggestedFollowUps?.map((suggestion) => (
                                    <button
                                      key={`${message.id}:${suggestion.text}`}
                                      onClick={() => {
                                        track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_CLICKED, analyticsContext({
                                          answer_kind: message.answerKind ?? null,
                                          source: suggestion.source,
                                          trigger: 'suggested',
                                        }))
                                        void handleSend(suggestion.text, { trigger: 'suggested' })
                                      }}
                                      style={{
                                        padding: '7px 12px',
                                        borderRadius: 999,
                                        border: '1px solid var(--color-border-ghost)',
                                        background: 'transparent',
                                        color: 'var(--color-text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: 12.5,
                                      }}
                                    >
                                      {suggestion.text}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                                <IconActionButton
                                  label="Copy response"
                                  feedbackLabel={actionFeedback[actionFeedbackKey(message.id, 'copy')]?.success ? 'Copied' : undefined}
                                  success={actionFeedback[actionFeedbackKey(message.id, 'copy')]?.success ?? false}
                                  pulseNonce={actionFeedback[actionFeedbackKey(message.id, 'copy')]?.pulseNonce ?? 0}
                                  reducedMotion={reducedMotion}
                                  onClick={() => void handleCopy(message.id, message.content, message.answerKind)}
                                >
                                  <IconCopy />
                                </IconActionButton>
                                <IconActionButton
                                  label="Thumbs up"
                                  tone="positive"
                                  selected={message.rating === 'up'}
                                  pulseNonce={actionFeedback[actionFeedbackKey(message.id, 'up')]?.pulseNonce ?? 0}
                                  reducedMotion={reducedMotion}
                                  onClick={() => {
                                    const nextRating = message.rating === 'up' ? null : 'up'
                                    triggerActionFeedback(message.id, 'up')
                                    void handleRate(message, nextRating)
                                    track(ANALYTICS_EVENT.AI_ANSWER_RATED, analyticsContext({
                                      answer_kind: message.answerKind ?? null,
                                      rating: nextRating ?? 'cleared',
                                      trigger: 'manual',
                                    }))
                                  }}
                                >
                                  <IconThumbsUp />
                                </IconActionButton>
                                <IconActionButton
                                  label="Thumbs down"
                                  tone="negative"
                                  selected={message.rating === 'down'}
                                  pulseNonce={actionFeedback[actionFeedbackKey(message.id, 'down')]?.pulseNonce ?? 0}
                                  reducedMotion={reducedMotion}
                                  onClick={() => {
                                    const nextRating = message.rating === 'down' ? null : 'down'
                                    triggerActionFeedback(message.id, 'down')
                                    void handleRate(message, nextRating)
                                    track(ANALYTICS_EVENT.AI_ANSWER_RATED, analyticsContext({
                                      answer_kind: message.answerKind ?? null,
                                      rating: nextRating ?? 'cleared',
                                      trigger: 'manual',
                                    }))
                                  }}
                                >
                                  <IconThumbsDown />
                                </IconActionButton>
                                {message.id === latestCompletedAssistantId && (
                                  <IconActionButton
                                    label="Retry response"
                                    pulseNonce={actionFeedback[actionFeedbackKey(message.id, 'retry')]?.pulseNonce ?? 0}
                                    reducedMotion={reducedMotion}
                                    onClick={() => void handleRetry(index, message)}
                                  >
                                    <IconRetry />
                                  </IconActionButton>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  ))}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {hasApiKey && (
        <div style={{
          borderTop: '1px solid var(--color-border-ghost)',
          background: 'var(--color-bg)',
          padding: '12px 40px 14px',
        }}>
          <div style={{ maxWidth: 960, margin: '0 auto' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderRadius: 12,
              border: '1px solid var(--color-border-ghost)',
              background: 'var(--color-surface)',
              padding: '0 6px 0 16px',
            }}>
              <input
                type="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleSend()
                }}
                disabled={loading}
                placeholder="Ask about your day, or ask for a report, chart, table, or export..."
                style={{
                  flex: 1,
                  height: 42,
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--color-text-primary)',
                  fontSize: 13,
                }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={loading || !input.trim()}
                style={{
                  height: 30,
                  padding: '0 14px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: loading || !input.trim() ? 'default' : 'pointer',
                  background: input.trim() && !loading ? 'var(--gradient-primary)' : 'var(--color-surface-high)',
                  color: input.trim() && !loading ? 'var(--color-primary-contrast)' : 'var(--color-text-tertiary)',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                Send
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', margin: '6px 0 0', lineHeight: 1.5 }}>
              {isCliProvider
                ? cliMissing
                  ? `Selected provider: ${providerMeta.label}, but it is not available yet.`
                  : `Answers are grounded in local activity and routed through ${providerMeta.label}.`
                : `Answers are grounded in local activity and routed through ${providerMeta.label}.`}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

const actionButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  borderRadius: 999,
  border: '1px solid var(--color-border-ghost)',
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 140ms ease, background 180ms ease, border-color 180ms ease, color 180ms ease',
  transformOrigin: 'center',
}
