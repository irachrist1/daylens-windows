import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { AppSettings, DayTimelinePayload } from '@shared/types'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { ipc } from '../lib/ipc'
import { formatDuration, todayString } from '../lib/format'
import { AI_PROVIDER_META } from '../lib/aiProvider'

interface PersistedChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ThreadMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  state: 'complete' | 'pending' | 'error'
}

function toggleRating(current: Record<number, 'up' | 'down'>, index: number, next: 'up' | 'down') {
  const updated = { ...current }
  if (updated[index] === next) {
    delete updated[index]
    return updated
  }
  updated[index] = next
  return updated
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
  selected = false,
  onClick,
  children,
}: {
  label: string
  selected?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        ...actionButtonStyle,
        color: selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
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

function threadMessagesFromHistory(history: PersistedChatMessage[]): ThreadMessage[] {
  return history.map((message, index) => ({
    id: `history:${index}:${message.role}`,
    role: message.role,
    content: message.content,
    state: 'complete',
  }))
}

export default function Insights() {
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [ratings, setRatings] = useState<Record<number, 'up' | 'down'>>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [cliTools, setCliTools] = useState<{ claude: string | null; codex: string | null } | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const historyHydratedRef = useRef(false)
  loadingRef.current = loading

  const insightsResource = useProjectionResource<{
    history: PersistedChatMessage[]
    settings: AppSettings
    cliTools: { claude: string | null; codex: string | null }
    hasProviderAccess: boolean
    today: DayTimelinePayload | null
  }>({
    scope: 'insights',
    load: async () => {
      const currentSettings = await ipc.settings.get()
      const chatProvider = currentSettings.aiChatProvider ?? currentSettings.aiProvider
      const providersToCheck = Array.from(new Set([
        chatProvider,
        ...(currentSettings.aiFallbackOrder ?? []),
      ]))

      const [history, cliToolsResult, apiProviderAccessChecks, today] = await Promise.all([
        ipc.ai.getHistory().catch(() => []),
        ipc.ai.detectCliTools().catch(() => ({ claude: null, codex: null })),
        Promise.all(providersToCheck
          .filter((provider) => provider !== 'claude-cli' && provider !== 'codex-cli')
          .map((provider) => ipc.settings.hasApiKey(provider).catch(() => false))),
        ipc.db.getTimelineDay(todayString()).catch(() => null),
      ])
      const providerAccess = providersToCheck.some((provider) => (
        provider === 'claude-cli'
          ? !!cliToolsResult.claude
          : provider === 'codex-cli'
            ? !!cliToolsResult.codex
            : apiProviderAccessChecks.shift() ?? false
      ))

      return {
        history: history as PersistedChatMessage[],
        settings: currentSettings,
        cliTools: cliToolsResult as { claude: string | null; codex: string | null },
        hasProviderAccess: providerAccess,
        today: today as DayTimelinePayload | null,
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

  async function handleSend(text?: string) {
    const prompt = (text ?? input).trim()
    if (!prompt || loading || !hasApiKey) return

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const userId = `user:${requestId}`
    const assistantId = `assistant:${requestId}`

    setLoading(true)
    setInput('')
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', content: prompt, state: 'complete' },
      { id: assistantId, role: 'assistant', content: '', state: 'pending' },
    ])

    try {
      const response = await ipc.ai.sendMessage(prompt) as string
      setMessages((current) => current.map((message) => (
        message.id === assistantId
          ? { ...message, content: response, state: 'complete' }
          : message
      )))
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

  async function handleRetry(index: number) {
    const historyUpToMessage = messages.slice(0, index)
    const previousUser = [...historyUpToMessage].reverse().find((message) => message.role === 'user')
    if (!previousUser) return
    await handleSend(previousUser.content)
  }

  async function handleCopy(content: string) {
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      // Ignore clipboard failures on unsupported environments.
    }
  }

  const today = insightsResource.data?.today ?? null
  const chips = starterPrompts(today)
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

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
                  setRatings({})
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
            <div style={{
              borderRadius: 18,
              border: '1px solid var(--color-border-ghost)',
              background: 'var(--color-surface)',
              padding: '22px 24px',
              marginBottom: 20,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>
                Connect an AI provider to ask questions
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--color-text-secondary)', marginBottom: 14 }}>
                {isCliProvider
                  ? `${providerMeta.label} is selected, but it is not available on this machine yet.`
                  : `Add your ${providerMeta.label} key in Settings to turn this into a real query surface.`}
              </div>
              <button
                onClick={() => { window.location.hash = '#/settings' }}
                style={{
                  padding: '8px 14px',
                  borderRadius: 9,
                  border: 'none',
                  background: 'var(--gradient-primary)',
                  color: 'var(--color-primary-contrast)',
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Open Settings
              </button>
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
                    <p style={{ fontSize: 14, lineHeight: 1.75, color: 'var(--color-text-primary)', margin: 0 }}>
                      {summaryText(today)}
                    </p>
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
                      {chips.map((chip) => (
                        <button
                          key={chip}
                          onClick={() => void handleSend(chip)}
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
                            <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                              Thinking…
                            </div>
                          ) : (
                            <>
                              {message.state === 'error' && (
                                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#f87171', marginBottom: 8 }}>
                                  Provider error
                                </div>
                              )}
                              <MarkdownMessage content={message.content} />
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                                <IconActionButton label="Copy response" onClick={() => void handleCopy(message.content)}>
                                  <IconCopy />
                                </IconActionButton>
                                <IconActionButton
                                  label="Thumbs up"
                                  selected={ratings[index] === 'up'}
                                  onClick={() => setRatings((current) => toggleRating(current, index, 'up'))}
                                >
                                  <IconThumbsUp />
                                </IconActionButton>
                                <IconActionButton
                                  label="Thumbs down"
                                  selected={ratings[index] === 'down'}
                                  onClick={() => setRatings((current) => toggleRating(current, index, 'down'))}
                                >
                                  <IconThumbsDown />
                                </IconActionButton>
                                <IconActionButton label="Retry response" onClick={() => void handleRetry(index)}>
                                  <IconRetry />
                                </IconActionButton>
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
}
