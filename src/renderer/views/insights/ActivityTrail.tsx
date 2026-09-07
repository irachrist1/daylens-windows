// The live activity trail on AI answers: while a turn runs, a calm stack of
// human one-liners under the question — one in-progress row, finished rows
// check-marked, failures stated plainly. When the turn settles, completed
// answers collapse to a Codex-style "Worked for Xm Ys" line that expands on
// demand into the same narration plus inline tool-status chips. The sources
// inspector opens from a Sources chip, not a file-chip wall.
//
// Labels arrive pre-built from the whitelist in shared/agentTrail — this file
// renders them and must never reach into tool inputs or outputs itself.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AIAgentStep } from '@shared/types'
import {
  collapseTrail,
  liveTrailRows,
  shortToolChip,
  showSettledActivity,
  stepsFromToolTrace,
  summarizeAgentTurn,
  formatWorkedDuration,
} from '@shared/agentTrail'
import { getStreamingStatus, getStreamingSteps, subscribeStreaming } from './streamingStore'
import type { ThreadMessage } from './types'

function StepGlyph({ state, reducedMotion }: { state: AIAgentStep['state']; reducedMotion: boolean }) {
  if (state === 'done') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }}>
        <path d="M2.5 6.5 L5 9 L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (state === 'failed') {
    return (
      <span aria-hidden="true" style={{ width: 12, textAlign: 'center', flexShrink: 0, color: '#f59e0b', fontSize: 11, fontWeight: 700, lineHeight: 1 }}>
        !
      </span>
    )
  }
  return (
    <span style={{ width: 12, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
      <span
        className={reducedMotion ? undefined : 'ai-trail-dot'}
        style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--color-primary)' }}
      />
    </span>
  )
}

function StepRow({ step, reducedMotion }: { step: AIAgentStep; reducedMotion: boolean }) {
  const failed = step.state === 'failed'
  const active = step.state === 'active'
  return (
    <div className="ai-message-in" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
      <StepGlyph state={step.state} reducedMotion={reducedMotion} />
      <span style={{
        fontSize: 12.5,
        lineHeight: 1.5,
        color: active ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {step.label}
        {active && '…'}
        {failed && <span style={{ color: '#f59e0b' }}> — couldn’t finish, kept going</span>}
      </span>
    </div>
  )
}

function TrailStack({ steps, reducedMotion }: { steps: AIAgentStep[]; reducedMotion: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const { visible, hiddenCount } = collapseTrail(steps, expanded ? Number.POSITIVE_INFINITY : undefined)
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 12, fontWeight: 600, textAlign: 'left' }}
        >
          <span style={{ width: 12 }} />
          {hiddenCount} earlier step{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
      {visible.map((step) => (
        <StepRow key={step.id} step={step} reducedMotion={reducedMotion} />
      ))}
    </div>
  )
}

function useElapsedMs(active: boolean): number {
  const startedAtRef = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return Math.max(0, now - startedAtRef.current)
}

/**
 * The trail under an in-flight answer. Subscribes to the streaming store per
 * message (same pattern as <StreamingMessage>), so step arrivals re-render
 * only this component — never the list or the composer.
 */
export function LiveActivityTrail({ messageId, reducedMotion }: { messageId: string; reducedMotion: boolean }) {
  const steps = useSyncExternalStore(
    (listener) => subscribeStreaming(messageId, listener),
    () => getStreamingSteps(messageId),
    () => [] as AIAgentStep[],
  )
  const status = useSyncExternalStore(
    (listener) => subscribeStreaming(messageId, listener),
    () => getStreamingStatus(messageId),
    () => '',
  )
  const rows = liveTrailRows(steps, status)
  const elapsedMs = useElapsedMs(rows.length > 0)
  if (rows.length === 0) return null
  return (
    <div style={{ marginBottom: 10, display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>
        {elapsedMs >= 1000 ? `Working · ${formatWorkedDuration(elapsedMs)}` : 'Working…'}
      </div>
      <TrailStack steps={rows} reducedMotion={reducedMotion} />
    </div>
  )
}

/** "Thinking" placeholder that steps aside once the trail has rows to show. */
export function PendingFallback({ messageId }: { messageId: string }) {
  const steps = useSyncExternalStore(
    (listener) => subscribeStreaming(messageId, listener),
    () => getStreamingSteps(messageId),
    () => [] as AIAgentStep[],
  )
  const status = useSyncExternalStore(
    (listener) => subscribeStreaming(messageId, listener),
    () => getStreamingStatus(messageId),
    () => '',
  )
  if (steps.length > 0 || status) return null
  return (
    <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
      Thinking<span className="ai-caret" />
    </div>
  )
}

const pillStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid var(--color-border-ghost)',
  background: 'transparent',
  color: 'var(--color-text-tertiary)',
}

/**
 * The settled trail on a completed answer: a collapsed "Worked for…" line
 * that expands into one-line tool narration and inline tool-status chips.
 * A recorded packet still shows Sources when the turn left no trail rows.
 */
export function SettledActivityTrail({
  message,
  canInspect,
  onInspect,
  reducedMotion,
}: {
  message: ThreadMessage
  canInspect: boolean
  onInspect: () => void
  reducedMotion: boolean
}) {
  const [showSteps, setShowSteps] = useState(false)
  const agent = message.agent
  if (!agent) return null
  const steps = stepsFromToolTrace(agent.toolTrace)
  const summary = summarizeAgentTurn(agent)
  const worked = summary?.label ?? ''
  const citationCount = summary?.citationCount ?? 0
  const hasVisibleWork = steps.length > 0 || citationCount > 0
  if (!showSettledActivity({ hasSteps: steps.length > 0, citationCount, canInspect })) return null
  const chips = summary?.toolsConsulted ?? []
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {hasVisibleWork && (
          <button
            type="button"
            onClick={() => setShowSteps((value) => !value)}
            aria-expanded={showSteps}
            title={showSteps ? 'Hide the steps this answer took' : 'Show the steps this answer took'}
            style={{ ...pillStyle, cursor: 'pointer', color: 'var(--color-text-secondary)' }}
          >
            {showSteps ? '▾' : '▸'} {worked || 'Worked'}
          </button>
        )}
        {showSteps && chips.map((consulted) => (
          <span key={consulted.tool} style={pillStyle}>{shortToolChip(consulted.tool)}</span>
        ))}
        {canInspect && (
          <button
            type="button"
            onClick={onInspect}
            title="Open the recorded sources for this answer"
            style={{ ...pillStyle, cursor: 'pointer' }}
          >
            Sources
          </button>
        )}
      </div>
      {showSteps && steps.length > 0 && (
        <TrailStack steps={steps} reducedMotion={reducedMotion} />
      )}
    </div>
  )
}
