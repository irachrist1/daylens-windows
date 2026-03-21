import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ipc } from '../lib/ipc'
import { formatDuration } from '../lib/format'
import type { AppUsageSummary } from '@shared/types'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

// ─── Safe markdown renderer ───────────────────────────────────────────────────
// Parses a subset of markdown into React elements without dangerouslySetInnerHTML.
// Supported: **bold**, *italic*, _italic_, `inline code`, - bullets, 1. lists,
// blank-line-separated paragraphs, soft line breaks within a paragraph.

// Inline: converts **bold**, *italic*, _italic_, `code` spans to React nodes.
// Input is plain text — no HTML escaping needed since we never use innerHTML.
function inlineNodes(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const full = m[0]
    if (full.startsWith('**')) {
      parts.push(<strong key={m.index} className="font-semibold">{m[1]}</strong>)
    } else if (full.startsWith('*')) {
      parts.push(<em key={m.index}>{m[2]}</em>)
    } else if (full.startsWith('_')) {
      parts.push(<em key={m.index}>{m[3]}</em>)
    } else {
      // inline code
      parts.push(
        <code
          key={m.index}
          className="bg-[var(--color-surface-high)] px-1 py-px rounded text-[12px] font-mono"
        >
          {m[4]}
        </code>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// Renders a single markdown block (separated by blank lines).
// Detects heading, bullet list, numbered list, table, or paragraph.
function MarkdownBlock({ text, blockKey }: { text: string; blockKey: number }): ReactNode {
  const lines    = text.split('\n').map((l) => l.trimEnd())
  const nonEmpty = lines.filter((l) => l.trim())
  if (nonEmpty.length === 0) return null

  // Heading: starts with ## or ###
  if (/^#{1,4}\s/.test(nonEmpty[0])) {
    const level  = nonEmpty[0].match(/^(#{1,4})/)?.[1].length ?? 2
    const content = nonEmpty[0].replace(/^#{1,4}\s+/, '')
    const sizeClass =
      level === 1 ? 'text-[16px]' :
      level === 2 ? 'text-[14px]' :
      level === 3 ? 'text-[13px]' :
      'text-[12px]'
    return (
      <p
        key={blockKey}
        className={`${sizeClass} font-semibold text-[var(--color-text-primary)] leading-snug`}
      >
        {inlineNodes(content)}
      </p>
    )
  }

  // Table: first non-empty line starts with '|'
  // Render gracefully as plain indented rows rather than raw pipe characters
  if (nonEmpty[0].startsWith('|')) {
    const dataRows = nonEmpty.filter((l) => l.startsWith('|') && !/^\|[-| :]+\|/.test(l))
    if (dataRows.length === 0) return null
    const parseCells = (row: string) =>
      row.split('|').map((c) => c.trim()).filter(Boolean)
    const headers = parseCells(dataRows[0])
    const bodyRows = dataRows.slice(1)
    return (
      <div
        key={blockKey}
        className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-high)]"
      >
        <div className="min-w-[280px]">
          {headers.length > 0 && (
            <div className="flex gap-3 px-3 py-2 border-b border-[var(--color-border)] text-[12px]">
              {headers.map((h, i) => (
                <span key={i} className="font-semibold text-[var(--color-text-secondary)] flex-1">
                  {inlineNodes(h)}
                </span>
              ))}
            </div>
          )}
          {bodyRows.map((row, ri) => (
            <div key={ri} className="flex gap-3 px-3 py-2 text-[12px]">
              {parseCells(row).map((cell, ci) => (
                <span key={ci} className="flex-1 text-[var(--color-text-primary)]">
                  {inlineNodes(cell)}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Bullet list: every non-empty line starts with "- " or "* "
  if (nonEmpty.every((l) => /^[-*]\s/.test(l))) {
    return (
      <ul key={blockKey} className="flex flex-col gap-1 pl-1">
        {nonEmpty.map((l, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed">
            <span className="shrink-0 opacity-40 mt-0.5 select-none">·</span>
            <span>{inlineNodes(l.replace(/^[-*]\s+/, ''))}</span>
          </li>
        ))}
      </ul>
    )
  }

  // Numbered list: every non-empty line starts with a digit and period
  if (nonEmpty.every((l) => /^\d+\.\s/.test(l))) {
    return (
      <ol key={blockKey} className="flex flex-col gap-1 pl-1">
        {nonEmpty.map((l, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed">
            <span className="shrink-0 text-[var(--color-text-tertiary)] tabular-nums min-w-[1.2em] text-right select-none">
              {l.match(/^(\d+)\./)?.[1] ?? i + 1}.
            </span>
            <span>{inlineNodes(l.replace(/^\d+\.\s+/, ''))}</span>
          </li>
        ))}
      </ol>
    )
  }

  // Paragraph — soft line breaks preserved
  return (
    <p key={blockKey} className="text-[13px] leading-relaxed">
      {lines.flatMap((line, i) => {
        const nodes = inlineNodes(line)
        return i < lines.length - 1 ? [...nodes, <br key={`br${i}`} />] : nodes
      })}
    </p>
  )
}

// Top-level markdown component: splits on blank lines, renders each block.
function MarkdownMessage({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  if (blocks.length === 0) return <p className="text-[13px] leading-relaxed">{content}</p>
  return (
    <div className="flex flex-col gap-2.5">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} text={block} blockKey={i} />
      ))}
    </div>
  )
}

// ─── Starter prompts built from real data ────────────────────────────────────

function buildStarterPrompts(summaries: AppUsageSummary[]): string[] {
  const defaults = [
    'How was my focus today?',
    'Which app used most of my time?',
    'Give me a productivity summary for the week.',
    'What patterns do you notice in my app usage?',
  ]

  if (summaries.length === 0) return defaults

  const totalSec = summaries.reduce((s, a) => s + a.totalSeconds, 0)
  const focusSec = summaries.filter((a) => a.isFocused).reduce((s, a) => s + a.totalSeconds, 0)
  const focusPct = totalSec > 0 ? Math.round((focusSec / totalSec) * 100) : 0
  const top      = summaries[0]

  const prompts: string[] = []
  if (top) {
    prompts.push(`I spent ${formatDuration(top.totalSeconds)} in ${top.appName} — is that too much?`)
  }
  prompts.push(`My focus score is ${focusPct}% today. How can I improve it?`)
  prompts.push('What should I focus on for the rest of the day?')
  prompts.push('Summarize my computer usage patterns this week.')
  return prompts.slice(0, 4)
}

function buildOverview(summaries: AppUsageSummary[]): string {
  if (summaries.length === 0) return 'No tracked activity yet today.'

  const totalSec = summaries.reduce((sum, item) => sum + item.totalSeconds, 0)
  const focusSec = summaries.filter((item) => item.isFocused).reduce((sum, item) => sum + item.totalSeconds, 0)
  const top = summaries[0]
  const focusPct = totalSec > 0 ? Math.round((focusSec / totalSec) * 100) : 0

  return `${formatDuration(totalSec)} tracked today, ${focusPct}% focus share, top app ${top?.appName ?? 'none yet'}.`
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function Insights() {
  const [messages, setMessages]   = useState<Message[]>([])
  const [input, setInput]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)  // null = checking
  const [summaries, setSummaries] = useState<AppUsageSummary[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    Promise.all([
      ipc.ai.getHistory(),
      ipc.settings.get(),
      ipc.db.getAppSummaries(1),
    ]).then(([history, settings, today]) => {
      setMessages(history as Message[])
      setHasApiKey(!!settings.anthropicApiKey)
      setSummaries(today as AppUsageSummary[])
    })
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || loading) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: msg }])
    setLoading(true)
    try {
      const reply = (await ipc.ai.sendMessage(msg)) as string
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Error: ' + String(err) },
      ])
    } finally {
      setLoading(false)
    }
  }

  // ── Checking state ───────────────────────────────────────────────────────────
  if (hasApiKey === null) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-7 py-5 border-b border-[var(--color-border)]">
          <p className="section-label mb-0.5">AI</p>
          <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)] tracking-tight leading-none">
            Insights
          </h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[13px] text-[var(--color-text-tertiary)]">Loading…</p>
        </div>
      </div>
    )
  }

  // ── No API key state ─────────────────────────────────────────────────────────
  if (hasApiKey === false) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-7 py-5 border-b border-[var(--color-border)]">
          <p className="section-label mb-0.5">AI</p>
          <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)] tracking-tight leading-none">
            Insights
          </h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <div className="text-3xl mb-4 opacity-20">✦</div>
          <p className="text-[15px] font-semibold text-[var(--color-text-primary)] mb-2">
            API key required
          </p>
          <p className="text-[13px] text-[var(--color-text-secondary)] max-w-xs leading-relaxed mb-6">
            Add your Anthropic API key in Settings to unlock AI-powered productivity insights.
          </p>
          <p className="text-[12px] text-[var(--color-text-tertiary)]">
            Settings → AI → Anthropic API key
          </p>
        </div>
      </div>
    )
  }

  const starterPrompts = buildStarterPrompts(summaries)
  const overview = buildOverview(summaries)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-7 py-5 border-b border-[var(--color-border)]">
        <div>
          <p className="section-label mb-0.5">AI</p>
          <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)] tracking-tight leading-none">
            Insights
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-2 py-1 rounded-full bg-[var(--color-surface-high)] text-[var(--color-text-secondary)]">
            tracked facts first
          </span>
          {messages.length > 0 && (
            <button
              onClick={() => ipc.ai.clearHistory().then(() => setMessages([]))}
              className="text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors px-3 py-1.5 rounded-lg hover:bg-[var(--color-surface-high)]"
            >
              New chat
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-7 py-5 flex flex-col gap-4">
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-3xl mb-3 opacity-20">✦</div>
            <p className="text-[15px] font-medium text-[var(--color-text-primary)] mb-2">
              Ask about your day
            </p>
            <p className="text-[12px] text-[var(--color-text-secondary)] max-w-md leading-relaxed mb-2">
              Answers are grounded in your tracked local activity. When the model goes beyond direct evidence, it should label that as interpretation or advice.
            </p>
            <p className="text-[12px] text-[var(--color-text-tertiary)] mb-5">
              {overview}
            </p>
            {/* Starter prompts grounded in today's data */}
            <div className="flex flex-col gap-2 w-full max-w-sm">
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleSend(prompt)}
                  className="text-left px-4 py-2.5 rounded-xl text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                  style={{
                    background: 'var(--color-surface-card)',
                    border:     '1px solid var(--color-border)',
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === 'user' ? 'self-end max-w-lg' : 'self-start max-w-2xl w-full'}
          >
            <div
              className={[
                'px-4 py-3 rounded-xl',
                m.role === 'user'
                  ? 'bg-[var(--color-accent)] text-[var(--color-surface)] text-[13px] leading-relaxed'
                  : 'bg-[var(--color-surface-card)] text-[var(--color-text-primary)] border border-[var(--color-border)]',
              ].join(' ')}
            >
              {/* User messages: plain text. Assistant messages: safe markdown. */}
              {m.role === 'user'
                ? m.content
                : <MarkdownMessage content={m.content} />}
            </div>
          </div>
        ))}
        {loading && (
          <div className="self-start">
            <div className="px-4 py-3 rounded-xl bg-[var(--color-surface-card)] border border-[var(--color-border)] text-[var(--color-text-secondary)] text-[13px]">
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="px-7 py-4 border-t border-[var(--color-border)]">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about your productivity…"
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-card)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50 transition-colors"
          />
          <button
            onClick={() => handleSend()}
            disabled={loading || !input.trim()}
            className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-surface)] text-[13px] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity shrink-0"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
