// The agent's activity surfaces on AI answers.
//
// While a turn runs (DEV-245): a structured progress panel — a working header
// with elapsed time, one-line narration per tool step with inline status
// chips, and a collapsible working-context section (minimized by default)
// saying what the turn is drawing on.
//
// When the turn settles (DEV-244, the Codex pattern): completed answers lead
// with ONE collapsed line ("Worked for 1m 42s") that expands on demand into
// the step list, the source summary, human-titled citations, opened files,
// and the shared-context inspector affordance. No chip walls; the full
// disclosure record stays one click away, never the default presentation.
//
// Labels arrive pre-built from the whitelist in shared/agentTrail — this file
// renders them and must never reach into tool inputs or outputs itself.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AIAgentStep, AIChatWorkingContext } from '@shared/types'
import {
  collapseTrail,
  formatWorkedDuration,
  liveTrailRows,
  stepsFromToolTrace,
  summarizeAgentTurn,
  trailHeadline,
} from '@shared/agentTrail'
import { citationDisplayTitle, humanizeFileTitle } from '@shared/citationDisplay'
import { getStreamingContext, getStreamingStatus, getStreamingSteps, subscribeStreaming } from './streamingStore'
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

const quietHeadingStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: 'var(--color-text-tertiary)',
}

const disclosureToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  textAlign: 'left',
}

/** The collapsed working-context section of the live panel (DEV-245):
 *  minimized by default, honest about a turn that attached nothing. */
function WorkingContextSection({ context }: { context: AIChatWorkingContext }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={disclosureToggleStyle}
        title={open ? 'Hide what this answer is drawing on' : 'Show what this answer is drawing on'}
      >
        {open ? '▾' : '▸'} Working context
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 4, fontSize: 12, lineHeight: 1.55, color: 'var(--color-text-tertiary)' }}>
          <span>
            {context.itemCount === 0
              ? 'Nothing from your day record is attached to this message.'
              : `Drawing on ${context.itemCount} item${context.itemCount === 1 ? '' : 's'} from your day record${context.dates.length > 0 ? ` for ${context.dates.join(', ')}` : ''}.`}
          </span>
          {context.readablePaths.length > 0 && (
            <span>
              May read: {context.readablePaths.map((path) => path.split('/').pop() || path).join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The structured progress panel under an in-flight answer (DEV-245): steps
 * tick off live with inline status chips, a working header carries elapsed
 * time, and the working-context section sits collapsed underneath. Subscribes
 * to the streaming store per message (same pattern as <StreamingMessage>), so
 * step arrivals re-render only this component — never the list or composer.
 */
export function AgentProgressPanel({ messageId, reducedMotion }: { messageId: string; reducedMotion: boolean }) {
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
  const context = useSyncExternalStore(
    (listener) => subscribeStreaming(messageId, listener),
    () => getStreamingContext(messageId),
    () => null,
  )
  const startedAtRef = useRef(Date.now())
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const rows = liveTrailRows(steps, status)
  if (rows.length === 0 && !context) return null
  const firstStepStart = steps.find((step) => step.startedAt > 0)?.startedAt
  const elapsedMs = Math.max(0, nowMs - (firstStepStart ?? startedAtRef.current))
  return (
    <div style={{ marginBottom: 10, borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', padding: '10px 12px', display: 'grid', gap: 8, maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 12, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
          <span
            className={reducedMotion ? undefined : 'ai-trail-dot'}
            style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--color-primary)' }}
          />
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
          Working · {formatWorkedDuration(elapsedMs)}
        </span>
      </div>
      {rows.length > 0 && <TrailStack steps={rows} reducedMotion={reducedMotion} />}
      {context && <WorkingContextSection context={context} />}
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

/**
 * The settled disclosure on a completed answer (DEV-244): ONE collapsed line
 * ("Worked for 1m 42s") that expands into the reconstructed step list, the
 * source summary, human-titled citations, opened files, and the read-only
 * shared-context inspector. Counts come from the same aggregation the
 * inspector uses. Renders nothing for non-agent answers.
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
  const [open, setOpen] = useState(false)
  const agent = message.agent
  if (!agent) return null
  const steps = stepsFromToolTrace(agent.toolTrace)
  const summary = summarizeAgentTurn(agent)
  const citations = agent.citations ?? []
  const files = agent.fileDisclosures ?? []
  const headline = trailHeadline({
    durationMs: agent.durationMs ?? null,
    stepCount: steps.length,
    summaryLabel: summary?.label ?? '',
  })
  const hasBody = steps.length > 0 || citations.length > 0 || files.length > 0 || Boolean(summary?.label) || canInspect
  if (!headline && !hasBody) return null
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={open ? 'Hide how this answer was put together' : 'Show how this answer was put together'}
        style={disclosureToggleStyle}
      >
        {open ? '▾' : '▸'} {headline || 'Answer details'}
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 10, paddingLeft: 14 }}>
          {steps.length > 0 && <TrailStack steps={steps} reducedMotion={reducedMotion} />}
          {summary?.label && (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{summary.label}</div>
          )}
          {citations.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={quietHeadingStyle}>Sources</span>
              {citations.map((citation) => (
                <button
                  key={`${message.id}:cite:${citation.marker}`}
                  type="button"
                  onClick={canInspect ? onInspect : undefined}
                  title={`${citation.statement}\n${canInspect ? 'Open the shared-context record for this answer' : 'Recorded in this answer’s shared context'}`}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 7, border: 'none', background: 'transparent', padding: 0, textAlign: 'left', cursor: canInspect ? 'pointer' : 'default', fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}
                >
                  <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{citation.marker}.</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {citationDisplayTitle(citation)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={quietHeadingStyle}>Files opened</span>
              {files.map((disclosure) => (
                <span
                  key={`${message.id}:${disclosure.path}:${disclosure.excerptStart}`}
                  title={`${disclosure.path}\nversion ${disclosure.versionFingerprint}\nbytes ${disclosure.excerptStart}–${disclosure.excerptEnd}\nLogged in Settings → Agent file access`}
                  style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {humanizeFileTitle(disclosure.name)}
                </span>
              ))}
            </div>
          )}
          {canInspect && (
            <button
              type="button"
              onClick={onInspect}
              title="Open the exact recorded context behind this answer"
              style={{ ...disclosureToggleStyle, color: 'var(--color-text-secondary)' }}
            >
              See the exact context shared
            </button>
          )}
        </div>
      )}
    </div>
  )
}
