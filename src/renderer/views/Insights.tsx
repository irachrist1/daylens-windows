import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { ANALYTICS_EVENT, blockCountBucket, classifyAIOutputIntent, trackedTimeBucket } from '@shared/analytics'
import type {
  AIArtifactRecord,
  AIChatTurnResult,
  AIMessageArtifact,
  AIMessageAction,
  AIThreadMessage,
  AIThreadSummary,
  AppSettings,
  DayTimelinePayload,
  FocusSession,
} from '@shared/types'
import { useProjectionResource } from '../hooks/useProjectionResource'
import { track } from '../lib/analytics'
import { ipc } from '../lib/ipc'
import { formatDuration, todayString } from '../lib/format'
import { AI_PROVIDER_META, getSelectedModel } from '../lib/aiProvider'
import { buildRecapSummaries, recapDateWindow, type RecapChapter, type RecapPeriod, type RecapSummary } from '../lib/recap'
import ConnectAI from '../components/ConnectAI'
import { inferWorkIntent } from '../../shared/workIntent'
import type { DaylensSearchResult } from '../../preload/index'

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

type AIAnswerKind = 'weekly_brief' | 'weekly_literal_list' | 'deterministic_stats' | 'day_summary_style' | 'generated_report' | 'freeform_chat' | 'error'

function disclosureLabel(answerKind: AIAnswerKind | null | undefined, content: string): string {
  if (!answerKind || answerKind === 'error') return ''
  if (answerKind === 'deterministic_stats') return 'Direct from your tracked data'
  const lower = content.slice(0, 160).toLowerCase()
  if (
    lower.startsWith("daylens doesn't") ||
    lower.startsWith("daylens can't") ||
    lower.startsWith("daylens does not") ||
    lower.startsWith("daylens cannot") ||
    lower.includes("doesn't capture") ||
    lower.includes("does not capture") ||
    lower.includes("not something daylens tracks") ||
    lower.includes("outside what daylens tracks")
  ) return 'Outside what Daylens tracks'
  return 'AI synthesis over your evidence'
}

function RecapMetricCard({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div style={{
      borderRadius: 16,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-recap-panel)',
      padding: '14px 14px 12px',
      minHeight: 96,
    }}>
      <div style={{
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        color: 'var(--color-text-tertiary)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 22,
        fontWeight: 760,
        letterSpacing: '-0.03em',
        color: 'var(--color-text-primary)',
        marginTop: 10,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 12.5,
        lineHeight: 1.55,
        color: 'var(--color-text-secondary)',
        marginTop: 6,
      }}>
        {detail}
      </div>
    </div>
  )
}

function RecapList({
  title,
  items,
  emptyLabel,
}: {
  title: string
  items: RecapSummary['topWorkstreams']
  emptyLabel: string
}) {
  return (
    <div style={{
      borderRadius: 16,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-recap-panel)',
      padding: '14px 14px 12px',
    }}>
      <div style={{
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        color: 'var(--color-text-tertiary)',
        marginBottom: 12,
      }}>
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-tertiary)' }}>
          {emptyLabel}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {items.map((item) => (
            <div
              key={`${title}:${item.label}`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 10,
                alignItems: 'start',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 650,
                  color: 'var(--color-text-primary)',
                  lineHeight: 1.4,
                }}>
                  {item.label}
                </div>
                <div style={{
                  fontSize: 11.5,
                  color: 'var(--color-text-tertiary)',
                  marginTop: 3,
                }}>
                  {item.detail}
                </div>
              </div>
              <div style={{
                fontSize: 12.5,
                fontWeight: 700,
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
              }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RecapTrend({
  points,
}: {
  points: RecapSummary['trend']
}) {
  if (points.length <= 1) return null

  const maxTracked = Math.max(...points.map((point) => point.trackedSeconds), 1)

  return (
    <div style={{
      borderRadius: 16,
      border: '1px solid var(--color-border-ghost)',
      background: 'var(--color-recap-panel)',
      padding: '14px 14px 12px',
    }}>
      <div style={{
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        color: 'var(--color-text-tertiary)',
        marginBottom: 12,
      }}>
        Day By Day
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`,
        gap: 8,
        alignItems: 'end',
        minHeight: 132,
      }}>
        {points.map((point) => {
          const trackedHeight = point.trackedSeconds > 0 ? Math.max(12, (point.trackedSeconds / maxTracked) * 92) : 4
          const focusHeight = point.trackedSeconds > 0
            ? Math.max(6, trackedHeight * (point.focusSeconds / Math.max(point.trackedSeconds, 1)))
            : 0
          return (
            <div key={point.date} style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
              <div style={{
                width: '100%',
                maxWidth: 42,
                height: 96,
                display: 'flex',
                alignItems: 'end',
                justifyContent: 'center',
              }}>
                <div style={{
                  width: '100%',
                  borderRadius: 14,
                  border: '1px solid var(--color-recap-bar-border)',
                  background: 'var(--color-recap-track)',
                  overflow: 'hidden',
                  height: trackedHeight,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'end',
                }}>
                  {focusHeight > 0 && (
                    <div style={{
                      height: focusHeight,
                      background: 'linear-gradient(180deg, rgba(114, 234, 210, 0.95), rgba(56, 189, 248, 0.86))',
                    }} />
                  )}
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                  {point.shortLabel}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {point.trackedSeconds > 0 ? formatDuration(point.trackedSeconds) : '0m'}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RecapChapterBlock({
  chapter,
  index,
  total,
}: {
  chapter: RecapChapter
  index: number
  total: number
}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '44px 1fr',
      gap: 16,
      alignItems: 'start',
      padding: '16px 22px',
      borderBottom: index < total - 1 ? '1px solid var(--color-recap-divider)' : 'none',
    }}>
      <div style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 2,
      }}>
        <div style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          border: '1px solid var(--color-recap-shell-border)',
          background: 'var(--color-recap-panel-strong)',
          color: 'var(--color-recap-title)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.02em',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {String(index + 1).padStart(2, '0')}
        </div>
        {index < total - 1 && (
          <div style={{
            flex: 1,
            width: 1,
            marginTop: 8,
            minHeight: 24,
            background: 'var(--color-recap-line)',
          }} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--color-recap-dim)',
        }}>
          {chapter.eyebrow}
        </div>
        <div style={{
          fontSize: 16,
          fontWeight: 740,
          letterSpacing: '-0.02em',
          color: 'var(--color-recap-title)',
          marginTop: 6,
          lineHeight: 1.35,
        }}>
          {chapter.title}
        </div>
        <div style={{
          fontSize: 13.5,
          lineHeight: 1.7,
          color: 'var(--color-recap-body)',
          marginTop: 8,
          maxWidth: 680,
        }}>
          {chapter.body}
        </div>
      </div>
    </div>
  )
}

function RecapPanel({
  recap,
  activePeriod,
  onSelectPeriod,
  hasProviderAccess,
  onPromptClick,
}: {
  recap: Record<RecapPeriod, RecapSummary>
  activePeriod: RecapPeriod
  onSelectPeriod: (period: RecapPeriod) => void
  hasProviderAccess: boolean
  onPromptClick: (prompt: string, source: string) => void
}) {
  const active = recap[activePeriod]

  return (
    <div style={{
      borderRadius: 24,
      border: '1px solid var(--color-recap-shell-border)',
      background: 'var(--color-recap-shell)',
      boxShadow: 'var(--color-recap-shell-shadow)',
      overflow: 'hidden',
      marginBottom: 20,
    }}>
      <div style={{
        padding: '22px 22px 20px',
        borderBottom: '1px solid var(--color-recap-divider)',
        background: 'var(--color-recap-hero-glow)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              color: 'var(--color-recap-kicker)',
              marginBottom: 10,
            }}>
              Work recap
            </div>
            <div style={{ fontSize: 28, fontWeight: 780, letterSpacing: '-0.04em', color: 'var(--color-recap-title)' }}>
              {active.title}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-recap-kicker)', marginTop: 6 }}>
              {active.subtitle}
            </div>
          </div>
          <div style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            borderRadius: 999,
            border: '1px solid var(--color-recap-shell-border)',
            background: 'var(--color-recap-panel)',
          }}>
            {(['day', 'week', 'month'] as RecapPeriod[]).map((period) => (
              <button
                key={period}
                type="button"
                onClick={() => onSelectPeriod(period)}
                style={{
                  padding: '7px 12px',
                  borderRadius: 999,
                  border: 'none',
                  background: activePeriod === period ? 'var(--gradient-primary)' : 'transparent',
                  color: activePeriod === period ? 'var(--color-primary-contrast)' : 'var(--color-recap-kicker)',
                  fontSize: 12,
                  fontWeight: 750,
                  cursor: 'pointer',
                }}
              >
                {period === 'day' ? 'Daily' : period === 'week' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>
        <div style={{
          marginTop: 14,
          fontSize: 15,
          lineHeight: 1.7,
          color: 'var(--color-recap-title)',
          maxWidth: 760,
          fontWeight: 560,
          letterSpacing: '-0.005em',
        }}>
          {active.headline}
        </div>
      </div>

      {active.hasData && active.chapters.length > 0 && (
        <div style={{ paddingTop: 4 }}>
          {active.chapters.map((chapter, index) => (
            <RecapChapterBlock
              key={`${active.period}:${chapter.id}`}
              chapter={chapter}
              index={index}
              total={active.chapters.length}
            />
          ))}
        </div>
      )}

      {!active.hasData && (
        <div style={{
          padding: '22px 22px 24px',
          fontSize: 13.5,
          lineHeight: 1.75,
          color: 'var(--color-recap-body)',
          maxWidth: 720,
        }}>
          {active.summary}
        </div>
      )}

      <div style={{
        padding: '20px 22px 22px',
        display: 'grid',
        gap: 16,
        borderTop: '1px solid var(--color-recap-divider)',
        background: 'var(--color-recap-track)',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 12,
        }}>
          {active.metrics.map((metric) => (
            <RecapMetricCard
              key={`${active.period}:${metric.label}`}
              label={metric.label}
              value={metric.value}
              detail={metric.detail}
            />
          ))}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 12,
        }}>
          <RecapList
            title="Top workstreams"
            items={active.topWorkstreams}
            emptyLabel="No clear workstream labels yet."
          />
          <RecapList
            title="Standout artifacts"
            items={active.standoutArtifacts}
            emptyLabel="No named artifacts stood out yet."
          />
        </div>

        <RecapTrend points={active.trend} />

        <div>
          <div style={{
            fontSize: 10.5,
            fontWeight: 800,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--color-text-tertiary)',
            marginBottom: 10,
          }}>
            Ask Daylens from here
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {active.promptChips.map((prompt) => (
              <button
                key={`${active.period}:${prompt}`}
                type="button"
                disabled={!hasProviderAccess}
                onClick={() => onPromptClick(prompt, `recap_${active.period}`)}
                style={{
                  padding: '8px 14px',
                  borderRadius: 999,
                  border: '1px solid var(--color-recap-shell-border)',
                  background: 'var(--color-recap-panel)',
                  color: 'var(--color-recap-title)',
                  fontSize: 12.5,
                  cursor: hasProviderAccess ? 'pointer' : 'default',
                  opacity: hasProviderAccess ? 1 : 0.6,
                }}
              >
                {prompt}
              </button>
            ))}
          </div>
          {!hasProviderAccess && (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 10 }}>
              Connect a provider to turn this recap into chat, reports, and exports.
            </div>
          )}
        </div>
      </div>
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

function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13 13 3" />
      <path d="M5.5 3H13v7.5" />
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

  const rankedBlocks = [...today.blocks]
    .sort((left, right) => (right.endTime - right.startTime) - (left.endTime - left.startTime))
    .slice(0, 3)
  const primaryIntent = rankedBlocks[0] ? inferWorkIntent(rankedBlocks[0]) : null
  const topArtifacts = rankedBlocks
    .flatMap((block) => block.topArtifacts)
    .map((artifact) => artifact.displayTitle)
    .filter(Boolean)
    .filter((title, index, titles) => titles.indexOf(title) === index)
    .slice(0, 3)

  const parts = [
    `You tracked ${formatDuration(today.totalSeconds)} across ${today.blocks.length} block${today.blocks.length !== 1 ? 's' : ''} today.`,
    primaryIntent ? `The clearest thread was ${primaryIntent.summary.toLowerCase()}.` : null,
    topArtifacts.length > 0 ? `Key artifacts included ${topArtifacts.join(', ')}.` : null,
    today.focusPct >= 70
      ? `Focus held for ${formatDuration(today.focusSeconds)} (${today.focusPct}%).`
      : `Focus was more fragmented, with ${formatDuration(today.focusSeconds)} counted as focused time (${today.focusPct}%).`,
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

function formatSearchTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function searchResultIcon(type: DaylensSearchResult['type']): string {
  switch (type) {
    case 'session':
      return 'App'
    case 'block':
      return 'Block'
    case 'browser':
      return 'Web'
    case 'artifact':
      return 'File'
  }
}

function searchResultTitle(result: DaylensSearchResult): string {
  switch (result.type) {
    case 'session':
      return result.windowTitle || result.appName
    case 'block':
      return result.label
    case 'browser':
      return result.pageTitle || result.url || result.domain
    case 'artifact':
      return result.title
  }
}

function searchResultSubtitle(result: DaylensSearchResult): string {
  switch (result.type) {
    case 'session':
      return result.appName
    case 'block':
      return 'Timeline block'
    case 'browser':
      return result.domain
    case 'artifact':
      return result.filePath ? 'Generated artifact' : 'AI artifact'
  }
}

function HighlightedExcerpt({ text }: { text: string }) {
  const parts = text.split(/(\[\[mark\]\]|\[\[\/mark\]\])/g)
  let highlighted = false
  return (
    <>
      {parts.map((part, index) => {
        if (part === '[[mark]]') {
          highlighted = true
          return null
        }
        if (part === '[[/mark]]') {
          highlighted = false
          return null
        }
        if (!part) return null
        return highlighted
          ? <mark key={index} style={{ background: 'rgba(79, 219, 200, 0.18)', color: 'var(--color-text-primary)', borderRadius: 4, padding: '0 2px' }}>{part}</mark>
          : <span key={index}>{part}</span>
      })}
    </>
  )
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
  const [activeRecapPeriod, setActiveRecapPeriod] = useState<RecapPeriod>('day')
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
  const [threads, setThreads] = useState<AIThreadSummary[]>([])
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null)
  const [artifacts, setArtifacts] = useState<AIArtifactRecord[]>([])
  const [artifactPreview, setArtifactPreview] = useState<{ record: AIArtifactRecord; content: string | null } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<DaylensSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [threadPickerOpen, setThreadPickerOpen] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)
  const loadingRef = useRef(false)
  const historyHydratedRef = useRef(false)
  const actionFeedbackTimeoutsRef = useRef<Record<string, number>>({})
  const suggestionImpressionsRef = useRef<Record<string, boolean>>({})
  const aiScreenTrackedRef = useRef(false)
  loadingRef.current = loading
  const currentDate = todayString()

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

  const recapResource = useProjectionResource<DayTimelinePayload[]>({
    scope: 'timeline',
    dependencies: [currentDate],
    intervalMs: 30_000,
    load: async () => {
      const dates = recapDateWindow(currentDate)
      const payloads = await Promise.all(dates.map((date) => ipc.db.getTimelineDay(date).catch(() => null)))
      return payloads.filter((payload): payload is DayTimelinePayload => Boolean(payload))
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
    const textarea = composerTextareaRef.current
    if (!textarea) return

    textarea.style.height = '0px'
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 24), 140)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > 140 ? 'auto' : 'hidden'
  }, [input])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  // Hydrate thread list on mount and whenever a response completes so recent
  // thread titles/timestamps reflect live activity.
  useEffect(() => {
    let cancelled = false
    ipc.ai.listThreads({ includeArchived: false }).then((rows) => {
      if (!cancelled) setThreads(rows)
    }).catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [messages.length])

  // Load artifacts for the currently active thread.
  useEffect(() => {
    if (activeThreadId == null) {
      setArtifacts([])
      return
    }
    let cancelled = false
    ipc.ai.listArtifacts(activeThreadId).then((rows) => {
      if (!cancelled) setArtifacts(rows)
    }).catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [activeThreadId, messages.length])

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
    const query = searchQuery.trim()
    if (!query) {
      setSearchResults([])
      setSearchLoading(false)
      setSearchError(null)
      return
    }

    let cancelled = false
    setSearchLoading(true)
    setSearchError(null)
    const timer = window.setTimeout(() => {
      ipc.search.all(query, { limit: 30 })
        .then((results) => {
          if (!cancelled) setSearchResults(results)
        })
        .catch((error) => {
          if (!cancelled) {
            setSearchResults([])
            setSearchError(error instanceof Error ? error.message : String(error))
          }
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false)
        })
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchQuery])

  useEffect(() => {
    return () => {
      for (const timeout of Object.values(actionFeedbackTimeoutsRef.current)) {
        window.clearTimeout(timeout)
      }
    }
  }, [])

  const today = insightsResource.data?.today ?? null
  const activeFocusSession = insightsResource.data?.activeFocusSession ?? null
  const recapSummaries = useMemo(
    () => buildRecapSummaries(recapResource.data ?? [], currentDate),
    [currentDate, recapResource.data],
  )
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  )
  const activeThreadLabel = activeThread && activeThread.title.trim() && activeThread.title !== 'New chat'
    ? activeThread.title
    : null
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
        threadId: activeThreadId,
      }) as AIChatTurnResult
      try {
        const refreshed = await ipc.ai.listThreads({ includeArchived: false })
        setThreads(refreshed)
        if (activeThreadId == null) {
          // sendMessage silently auto-creates a thread server-side when none is
          // passed; refresh the list and adopt the newest row as the current
          // thread so follow-up turns stay linked.
          const newest = refreshed[0]
          if (newest) setActiveThreadId(newest.id)
        }
      } catch { /* best-effort */ }
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

  async function loadThread(threadId: number, options?: { keepPickerOpen?: boolean }) {
    if (!options?.keepPickerOpen) {
      setThreadPickerOpen(false)
    }
    setActiveThreadId(threadId)
    setArtifactPreview(null)
    try {
      const detail = await ipc.ai.getThread(threadId)
      setMessages(threadMessagesFromHistory(detail.messages))
      historyHydratedRef.current = true
    } catch {
      // best-effort; keep the current UI if the lookup fails
    }
  }

  function resetThreadComposerState() {
    setMessages([])
    setArtifacts([])
    setArtifactPreview(null)
    setActionFeedback({})
    setMessageActionState({})
    setFocusReviewDrafts({})
    suggestionImpressionsRef.current = {}
    historyHydratedRef.current = true
  }

  function restoreThreadPickerAfterUpdate(shouldRestore: boolean) {
    if (!shouldRestore) return
    window.requestAnimationFrame(() => {
      setThreadPickerOpen(true)
    })
  }

  async function handleDeleteThread(thread: AIThreadSummary) {
    const pickerWasOpen = threadPickerOpen
    const confirmed = window.confirm(
      `Delete "${thread.title}"? This removes the chat, messages, and attached artifacts from this device.`,
    )
    if (!confirmed) return

    try {
      await ipc.ai.deleteThread(thread.id)

      const refreshed = await ipc.ai.listThreads({ includeArchived: false })
      setThreads(refreshed)
      restoreThreadPickerAfterUpdate(pickerWasOpen && refreshed.length > 0)

      const nextActiveId = thread.id === activeThreadId
        ? refreshed[0]?.id ?? null
        : activeThreadId !== null && !refreshed.some((entry) => entry.id === activeThreadId)
          ? refreshed[0]?.id ?? null
          : activeThreadId

      if (nextActiveId == null) {
        setActiveThreadId(null)
        resetThreadComposerState()
        historyHydratedRef.current = false
        setThreadPickerOpen(false)
        return
      }

      if (nextActiveId !== activeThreadId || thread.id === activeThreadId) {
        await loadThread(nextActiveId, { keepPickerOpen: pickerWasOpen })
        restoreThreadPickerAfterUpdate(pickerWasOpen && refreshed.length > 0)
      }
    } catch (error) {
      console.error('[ai] failed to delete thread', error)
    }
  }

  async function handleNewChat() {
    const activeThreadIsDraft = Boolean(activeThread && activeThread.messageCount === 0)
    if (activeThreadIsDraft) {
      setThreadPickerOpen(false)
      return
    }

    const reusableDraft = threads.find((thread) => thread.messageCount === 0)
    if (reusableDraft) {
      await loadThread(reusableDraft.id)
      return
    }

    const thread = await ipc.ai.createThread(null)
    setActiveThreadId(thread.id)
    setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)])
    resetThreadComposerState()
    setThreadPickerOpen(false)
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

  function handlePromptChipClick(prompt: string, source: string) {
    if (!hasApiKey) return
    track(ANALYTICS_EVENT.AI_SUGGESTED_QUESTION_CLICKED, analyticsContext({
      source,
      trigger: 'suggested',
    }))
    void handleSend(prompt, { trigger: 'suggested' })
  }

  function handleSearchResultClick(result: DaylensSearchResult) {
    if (result.type === 'artifact') {
      void ipc.ai.openArtifact(result.id)
      return
    }
    if (result.type === 'browser' && result.url) {
      ipc.shell.openExternal(result.url)
      return
    }
    window.location.hash = `/timeline?view=day&date=${encodeURIComponent(result.date)}`
  }

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
              {activeThreadLabel && (
                <p style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', margin: '8px 0 0' }}>
                  In <span style={{ color: 'var(--color-text-secondary)' }}>{activeThreadLabel}</span>
                </p>
              )}
            </div>
            <div style={{ position: 'relative', display: 'flex', gap: 8 }}>
              {threads.length > 0 && (
                <button
                  type="button"
                  onClick={() => setThreadPickerOpen((value) => !value)}
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
                  title={activeThreadLabel ?? 'Browse recent chats'}
                  aria-haspopup="listbox"
                  aria-expanded={threadPickerOpen}
                >
                  Chats
                </button>
              )}
              <button
                type="button"
                onClick={() => { void handleNewChat() }}
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
              {threadPickerOpen && threads.length > 0 && (
                <div
                  role="listbox"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    zIndex: 20,
                    width: 280,
                    maxHeight: 360,
                    overflowY: 'auto',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border-ghost)',
                    borderRadius: 10,
                    boxShadow: 'var(--color-shadow-floating)',
                    padding: 6,
                  }}
                >
                  {threads.map((thread) => (
                    <div
                      key={thread.id}
                      role="option"
                      aria-selected={thread.id === activeThreadId}
                      style={{
                        display: 'flex',
                        alignItems: 'stretch',
                        gap: 6,
                        marginBottom: 4,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => { void loadThread(thread.id) }}
                        style={{
                          display: 'block',
                          flex: 1,
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: 'none',
                          background: thread.id === activeThreadId ? 'var(--color-surface-muted)' : 'transparent',
                          color: 'var(--color-text-primary)',
                          fontSize: 12.5,
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{thread.title}</div>
                          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                            {thread.messageCount} msg{thread.messageCount === 1 ? '' : 's'}
                          </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => { void handleDeleteThread(thread) }}
                        aria-label={`Delete ${thread.title}`}
                        title={`Delete ${thread.title}`}
                        style={{
                          width: 30,
                          flexShrink: 0,
                          border: 'none',
                          borderRadius: 6,
                          background: 'transparent',
                          color: 'var(--color-text-tertiary)',
                          cursor: 'pointer',
                          display: 'grid',
                          placeItems: 'center',
                          transition: 'color 120ms ease, background 120ms ease',
                        }}
                        onMouseEnter={(event) => {
                          event.currentTarget.style.color = '#dc2626'
                          event.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)'
                        }}
                        onMouseLeave={(event) => {
                          event.currentTarget.style.color = 'var(--color-text-tertiary)'
                          event.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderBottom: '1px solid var(--color-border-ghost)',
                paddingBottom: 10,
              }}>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search your history or ask anything."
                  aria-label="Search local Daylens history"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    color: 'var(--color-text-primary)',
                    fontSize: 13.5,
                  }}
                />
                {searchLoading && (
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Searching…</span>
                )}
              </div>

              {searchError && (
                <div style={{ fontSize: 12.5, color: '#f87171', lineHeight: 1.5 }}>
                  Search failed: {searchError}
                </div>
              )}

              {searchQuery.trim() && !searchLoading && !searchError && searchResults.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                  No local matches yet.
                </div>
              )}

              {searchResults.length > 0 && (
                <div style={{ display: 'grid', gap: 8 }}>
                  {searchResults.map((result) => (
                    <button
                      key={`${result.type}:${result.id}:${result.startTime}`}
                      type="button"
                      onClick={() => handleSearchResultClick(result)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '46px minmax(0, 1fr) auto',
                        alignItems: 'start',
                        gap: 12,
                        textAlign: 'left',
                        border: '1px solid var(--color-border-ghost)',
                        borderRadius: 12,
                        background: 'transparent',
                        padding: '10px 12px',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: 24,
                        borderRadius: 999,
                        background: 'var(--color-surface-high)',
                        color: 'var(--color-text-secondary)',
                        fontSize: 10.5,
                        fontWeight: 800,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}>
                        {searchResultIcon(result.type)}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{
                          display: 'block',
                          fontSize: 13,
                          fontWeight: 720,
                          color: 'var(--color-text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {searchResultTitle(result)}
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
                          {searchResultSubtitle(result)}
                        </span>
                        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55, marginTop: 6 }}>
                          <HighlightedExcerpt text={result.excerpt} />
                        </span>
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', paddingTop: 2 }}>
                        {formatSearchTimestamp(result.startTime)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {messages.length === 0 && (
            <RecapPanel
              recap={recapSummaries}
              activePeriod={activeRecapPeriod}
              onSelectPeriod={setActiveRecapPeriod}
              hasProviderAccess={hasApiKey}
              onPromptClick={handlePromptChipClick}
            />
          )}

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
                          onClick={() => handlePromptChipClick(chip, heroQuestions.length > 0 && heroQuestions.includes(chip) ? 'summary_card' : 'default_chip')}
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
                      <div
                        key={message.id}
                        style={{ display: 'flex', gap: 10, alignItems: 'start' }}
                        onMouseEnter={() => setHoveredMessageId(message.id != null ? String(message.id) : null)}
                        onMouseLeave={() => setHoveredMessageId(null)}
                      >
                        <div style={{
                          width: 22,
                          height: 22,
                          borderRadius: 6,
                          border: '1px solid var(--color-border-ghost)',
                          background: 'transparent',
                          color: 'var(--color-text-tertiary)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 800,
                          flexShrink: 0,
                          marginTop: 2,
                          opacity: hoveredMessageId === String(message.id) ? 1 : 0,
                          transition: 'opacity 120ms ease',
                        }}>
                          D
                        </div>
                        <div style={{
                          flex: 1,
                          maxWidth: 680,
                          lineHeight: 1.6,
                          ...(message.state === 'error' ? {
                            borderRadius: 12,
                            border: '1px solid rgba(248, 113, 113, 0.28)',
                            background: 'rgba(248, 113, 113, 0.08)',
                            padding: '14px 16px 10px',
                          } : {}),
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
                              {message.state === 'complete' && (() => {
                                const label = disclosureLabel(message.answerKind, message.content)
                                return label ? (
                                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
                                    {label}
                                  </div>
                                ) : null
                              })()}
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

      {artifacts.length > 0 && (
        <div style={{
          borderTop: '1px solid var(--color-border-ghost)',
          background: 'var(--color-bg)',
          padding: '10px 40px',
        }}>
          <div style={{ maxWidth: 960, margin: '0 auto' }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
              Artifacts
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--color-border-ghost)',
                    background: 'var(--color-surface)',
                    minWidth: 160,
                    maxWidth: 280,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {artifact.title}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
                    {artifact.kind.replace('_', ' ')} · {Math.max(1, Math.round(artifact.byteSize / 1024))} KB
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button
                      type="button"
                      onClick={async () => {
                        const loaded = await ipc.ai.getArtifact(artifact.id)
                        if (loaded) setArtifactPreview({ record: loaded.record, content: loaded.content })
                      }}
                      style={{
                        padding: '3px 8px', fontSize: 11, fontWeight: 700,
                        borderRadius: 6, border: '1px solid var(--color-border-ghost)',
                        background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer',
                      }}
                    >Preview</button>
                    <button
                      type="button"
                      onClick={() => void ipc.ai.openArtifact(artifact.id)}
                      style={{
                        padding: '3px 8px', fontSize: 11, fontWeight: 700,
                        borderRadius: 6, border: '1px solid var(--color-border-ghost)',
                        background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer',
                      }}
                    >Open</button>
                    <button
                      type="button"
                      onClick={() => void ipc.ai.exportArtifact(artifact.id)}
                      style={{
                        padding: '3px 8px', fontSize: 11, fontWeight: 700,
                        borderRadius: 6, border: '1px solid var(--color-border-ghost)',
                        background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer',
                      }}
                    >Export</button>
                  </div>
                </div>
              ))}
            </div>
            {artifactPreview && (
              <div style={{
                marginTop: 10,
                border: '1px solid var(--color-border-ghost)',
                borderRadius: 10,
                background: 'var(--color-surface)',
                padding: 12,
                maxHeight: 320,
                overflow: 'auto',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{artifactPreview.record.title}</div>
                  <button
                    type="button"
                    onClick={() => setArtifactPreview(null)}
                    style={{ fontSize: 11, fontWeight: 700, border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', cursor: 'pointer' }}
                  >Close</button>
                </div>
                {artifactPreview.record.kind === 'html_chart' ? (
                  <iframe
                    title={artifactPreview.record.title}
                    srcDoc={artifactPreview.content ?? ''}
                    sandbox=""
                    style={{ width: '100%', height: 260, border: '1px solid var(--color-border-ghost)', borderRadius: 6, background: 'white' }}
                  />
                ) : (
                  <pre style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--color-text-primary)' }}>
                    {artifactPreview.content ?? '(file not available on disk)'}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {hasApiKey && (
        <div style={{
          background: 'transparent',
          padding: '18px 40px 24px',
        }}>
          <div style={{ maxWidth: 960, margin: '0 auto' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              borderRadius: 18,
              border: '1px solid var(--color-border-ghost)',
              background: 'var(--color-surface)',
              padding: '10px 10px 10px 16px',
              boxShadow: 'var(--color-shadow-floating)',
            }}>
              <textarea
                ref={composerTextareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void handleSend()
                  }
                }}
                disabled={loading}
                rows={1}
                aria-label="Ask Daylens about your work history"
                placeholder="Ask about your day, or ask for a report, chart, table, or export..."
                style={{
                  flex: 1,
                  minHeight: 20,
                  maxHeight: 140,
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--color-text-primary)',
                  fontSize: 13.5,
                  lineHeight: '20px',
                  resize: 'none',
                  padding: '8px 0',
                  display: 'block',
                }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={loading || !input.trim()}
                type="button"
                aria-label="Send message"
                style={{
                  width: 36,
                  height: 36,
                  padding: 0,
                  borderRadius: 999,
                  border: 'none',
                  cursor: loading || !input.trim() ? 'default' : 'pointer',
                  background: input.trim() && !loading ? 'var(--gradient-primary)' : 'var(--color-surface-high)',
                  color: input.trim() && !loading ? 'var(--color-primary-contrast)' : 'var(--color-text-tertiary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <IconSend />
              </button>
            </div>
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
