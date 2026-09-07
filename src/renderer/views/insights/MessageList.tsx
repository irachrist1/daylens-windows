import { memo, useState } from 'react'
import type { AIActionUndo, AIActionWidget, AIMessageAction, AIProviderMode, FocusSession } from '@shared/types'
import type { AIProviderErrorCode } from '@shared/aiProviderError'
import { ipc } from '../../lib/ipc'
import { MarkdownMessage } from './markdown'
import { MentionText } from './mentions'
import { StreamingMessage } from './StreamingMessage'
import { LiveActivityTrail, PendingFallback, SettledActivityTrail } from './ActivityTrail'
import { ActionWidget } from './ActionWidget'
import {
  IconActionButton,
  IconArtifactFile,
  IconCopy,
  IconExternal,
  IconRetry,
  IconThumbsDown,
  IconThumbsUp,
} from './icons'
import {
  actionFeedbackKey,
  messageActionKey,
  ANSWER_TRANSFORMS,
  type ActionFeedbackEntry,
  type ActionWidgetStateEntry,
  type AnswerTransform,
  type MessageActionStateEntry,
  type ThreadMessage,
} from './types'

type ReviewFocusAction = Extract<AIMessageAction, { kind: 'review_focus_session' }>

function FocusReviewActionCard({
  action,
  state,
  onSave,
}: {
  action: ReviewFocusAction
  state?: MessageActionStateEntry
  onSave: (note: string) => void
}) {
  const [draft, setDraft] = useState(action.suggestedNote ?? '')
  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', padding: 12, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
        Save a short reflection to this focus session.
      </div>
      <textarea
        aria-label="Focus session review"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={action.placeholder ?? 'Add a short focus review'}
        rows={4}
        style={{ width: '100%', resize: 'vertical', borderRadius: 10, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', padding: '10px 12px', fontSize: 12.5, lineHeight: 1.6, outline: 'none' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => onSave(draft)}
          disabled={state?.busy}
          style={{ padding: '8px 12px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 700, cursor: state?.busy ? 'default' : 'pointer', opacity: state?.busy ? 0.7 : 1 }}
        >
          {state?.busy ? 'Saving…' : action.label}
        </button>
        {state?.successLabel && <span style={{ fontSize: 12, color: 'var(--color-focus-green)' }}>{state.successLabel}</span>}
        {state?.error && <span style={{ fontSize: 12, color: '#f87171' }}>{state.error}</span>}
      </div>
    </div>
  )
}

export interface MessageListProps {
  messages: ThreadMessage[]
  latestCompletedAssistantId: string | number | undefined
  actionFeedback: Record<string, ActionFeedbackEntry>
  messageActionState: Record<string, MessageActionStateEntry>
  actionWidgetState: Record<string, ActionWidgetStateEntry>
  reducedMotion: boolean
  activeFocusSession: FocusSession | null
  onCopy: (messageId: string | number, content: string, answerKind: ThreadMessage['answerKind']) => void
  onRate: (message: ThreadMessage, rating: 'up' | 'down' | null) => void
  onRetry: (index: number, message: ThreadMessage) => void
  onErrorRetry: (message: ThreadMessage) => void
  onSwitchProvider: (message: ThreadMessage, provider: AIProviderMode) => void
  onTransform: (kind: AnswerTransform) => void
  providerActionsDisabled?: boolean
  onMessageAction: (messageId: string | number, action: AIMessageAction, options?: { reviewNote?: string }) => void
  onCommitActionWidget: (widget: AIActionWidget) => void
  onUndoActionWidget: (proposalId: string, undo: AIActionUndo) => void
  onDismissActionWidget: (widget: AIActionWidget) => void
  onFollowUpClick: (message: ThreadMessage, suggestionText: string, source: string) => void
  // "What the AI saw" (DEV-183): opens the read-only context-packet inspector
  // for the exchange behind this assistant message.
  onInspectPacket?: (message: ThreadMessage) => void
  // DEV-200: resume / discard a paused turn's row.
  onResumePaused?: (message: ThreadMessage) => void
  onDiscardPaused?: (message: ThreadMessage) => void
  // DEV-200: the in-flight turn's phase, for the honest state line on the
  // pending row ("Waiting for you — file permission").
  turnPhase?: { phase: 'running' | 'awaiting_user'; waitKind: string | null } | null
  scrollToBottom: () => void
  // Opening a conversation loads only the newest page of its history; when
  // older messages exist, a "Load earlier messages" affordance tops the list.
  hasEarlier?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
}

// "Turn into…" — post-answer transforms on the latest answer. Each runs a
// real model call that rewrites THIS answer's grounded content into the chosen
// form (see request.transform); the menu is a small hover-light popover.
function TransformMenu({ onTransform, disabled = false }: { onTransform: (kind: AnswerTransform) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const menuOpen = open && !disabled
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Turn this answer into…"
        style={{ height: 30, padding: '0 10px', borderRadius: 999, border: '1px solid var(--color-border-ghost)', background: menuOpen ? 'var(--color-accent-dim)' : 'transparent', color: 'var(--color-text-secondary)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, fontSize: 12, fontWeight: 600 }}
      >
        Turn into…
      </button>
      {menuOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onClick={() => setOpen(false)} />
          <div role="menu" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 20, minWidth: 180, background: 'var(--color-surface)', border: '1px solid var(--color-border-ghost)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.16)', padding: 5 }}>
            {ANSWER_TRANSFORMS.map((transform) => (
              <button
                key={transform.kind}
                role="menuitem"
                type="button"
                onClick={() => { setOpen(false); onTransform(transform.kind) }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--color-text-primary)', fontSize: 12.5, cursor: 'pointer' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-muted)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                {transform.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Plain-language wait lines for the turn's visible state machine (DEV-200).
const WAIT_LABEL: Record<string, string> = {
  clarification: 'Waiting for your answer to its question',
  file_permission: 'Waiting for you — it asked to open a file',
  memory_confirmation: 'Waiting for you to confirm a memory',
  correction_confirmation: 'Waiting for you to confirm a correction',
}

// Branded header label per error class — never a raw provider/channel string.
const ERROR_HEADER: Record<AIProviderErrorCode, string> = {
  transient_rate_limit: 'Provider busy',
  quota_exhausted: 'Limit reached',
  credit_exhausted: 'Credit low',
  auth: 'Key rejected',
  model_unavailable: 'Model unavailable',
  network: 'No connection',
  unknown: 'Couldn’t complete that',
}

function MessageListImpl({
  messages,
  latestCompletedAssistantId,
  actionFeedback,
  messageActionState,
  actionWidgetState,
  reducedMotion,
  activeFocusSession,
  onCopy,
  onRate,
  onRetry,
  onErrorRetry,
  onSwitchProvider,
  onTransform,
  providerActionsDisabled = false,
  onMessageAction,
  onCommitActionWidget,
  onUndoActionWidget,
  onDismissActionWidget,
  onFollowUpClick,
  onInspectPacket,
  onResumePaused,
  onDiscardPaused,
  turnPhase,
  scrollToBottom,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
}: MessageListProps) {
  // An exchange is inspectable when the packet ledger can be asked about it:
  // the turn carried its packet id, or the message has a persisted id the
  // ledger binding can resolve. Agent-run answers only — other answer shapes
  // never had a packet.
  const canInspect = (message: ThreadMessage): boolean =>
    Boolean(onInspectPacket)
    && message.agent != null
    && (message.agent.contextPacketId != null || typeof message.id === 'number')
  return (
    <div style={{ display: 'grid', gap: 24, contain: 'layout' }}>
      {hasEarlier && onLoadEarlier && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={onLoadEarlier}
            disabled={loadingEarlier}
            style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600, cursor: loadingEarlier ? 'default' : 'pointer', opacity: loadingEarlier ? 0.7 : 1 }}
          >
            {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
          </button>
        </div>
      )}
      {messages.map((message, index) => (
        message.role === 'user' ? (
          <div key={message.id} className="ai-message-in" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ maxWidth: '76%', borderRadius: '14px 14px 6px 14px', background: 'var(--color-accent-dim)', color: 'var(--color-primary)', padding: '11px 14px', fontSize: 13, fontWeight: 550, whiteSpace: 'pre-wrap' }}>
              <MentionText text={message.content} />
            </div>
          </div>
        ) : (
          <div key={message.id} className="ai-message-in" style={{ display: 'flex' }}>
            <div style={{
              flex: 1,
              maxWidth: 720,
              lineHeight: 1.6,
              ...(message.state === 'error' ? {
                borderRadius: 12,
                border: '1px solid rgba(248, 113, 113, 0.28)',
                background: 'rgba(248, 113, 113, 0.08)',
                padding: '14px 16px 10px',
              } : {}),
            }}>
              {message.state === 'pending' ? (
                // The live activity trail (issue #25): tool steps tick off
                // above the streaming answer; the "Thinking" placeholder
                // steps aside once the trail has rows.
                <>
                  {/* The turn's visible state machine (DEV-200): when an
                      agent-initiated card is holding the turn, the pending row
                      says so — the same machine the Pause button drives. */}
                  {turnPhase?.phase === 'awaiting_user' && (
                    <div role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 8, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                      <IconPauseDot />
                      {WAIT_LABEL[turnPhase.waitKind ?? ''] ?? 'Waiting for you'}
                    </div>
                  )}
                  <LiveActivityTrail messageId={String(message.id)} reducedMotion={reducedMotion} />
                  <StreamingMessage
                    messageId={String(message.id)}
                    fallback={<PendingFallback messageId={String(message.id)} />}
                    renderContent={(text) => <><MarkdownMessage content={text} /><span className="ai-caret" /></>}
                    onSnapshotUpdate={scrollToBottom}
                  />
                </>
              ) : message.state === 'paused' ? (
                // A paused turn (DEV-200): honestly resumable — the question is
                // kept, nothing half-finished is shown as an answer, and resume
                // re-runs it against the CURRENT facts (the day may have moved).
                // Distinct from Stop, which discards the turn.
                <div style={{ borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', padding: '12px 14px', display: 'grid', gap: 8 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                    <IconPauseDot />
                    {message.pausedInfo?.pauseKind === 'restart'
                      ? 'Paused — the app closed while this was running'
                      : 'Paused'}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
                    {message.pausedInfo?.lastStatus
                      ? `It was working on: ${message.pausedInfo.lastStatus}. `
                      : ''}
                    Resume picks the question back up with your latest activity — no half answer is kept.
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => onResumePaused?.(message)}
                      disabled={providerActionsDisabled || !message.pausedInfo?.checkpointId || !onResumePaused}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 13px', borderRadius: 9, border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', fontSize: 12.5, fontWeight: 700, cursor: !providerActionsDisabled && message.pausedInfo?.checkpointId ? 'pointer' : 'default', opacity: !providerActionsDisabled && message.pausedInfo?.checkpointId ? 1 : 0.6 }}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      onClick={() => onDiscardPaused?.(message)}
                      disabled={!onDiscardPaused}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 13px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ) : message.state === 'cancelled' ? (
                // An honestly-stopped turn — no partial text presented as an
                // answer, no error card. Retry re-runs the question in place.
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
                    Stopped — no answer was generated.
                  </span>
                  <button
                    type="button"
                    onClick={() => onErrorRetry(message)}
                    disabled={providerActionsDisabled}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12, fontWeight: 700, cursor: providerActionsDisabled ? 'default' : 'pointer', opacity: providerActionsDisabled ? 0.6 : 1 }}
                  >
                    <IconRetry /> Retry
                  </button>
                </div>
              ) : message.state === 'error' ? (
                <>
                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#f87171', marginBottom: 8 }}>
                    {ERROR_HEADER[message.errorInfo?.code ?? 'unknown']}
                  </div>
                  <MarkdownMessage content={message.content} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => onErrorRetry(message)}
                      disabled={providerActionsDisabled}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 700, cursor: providerActionsDisabled ? 'default' : 'pointer', opacity: providerActionsDisabled ? 0.6 : 1 }}
                    >
                      <IconRetry /> Retry
                    </button>
                    {/* On a hard wall, offer a one-tap switch to another
                        configured provider instead of looping on the dead one. */}
                    {message.errorInfo?.alternateProviders?.map((alt) => (
                      <button
                        key={alt.provider}
                        type="button"
                        onClick={() => onSwitchProvider(message, alt.provider)}
                        disabled={providerActionsDisabled}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 700, cursor: providerActionsDisabled ? 'default' : 'pointer', opacity: providerActionsDisabled ? 0.6 : 1 }}
                      >
                        Try on {alt.label}
                      </button>
                    ))}
                    {message.errorInfo?.autoRetryScheduled && (
                      <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Retrying automatically…</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <MarkdownMessage content={message.content} />

                  {(message.actionWidgets?.length ?? 0) > 0 && (
                    <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                      {message.actionWidgets?.map((widget) => (
                        <ActionWidget
                          key={widget.proposalId}
                          widget={widget}
                          state={actionWidgetState[widget.proposalId]}
                          onConfirm={onCommitActionWidget}
                          onUndo={onUndoActionWidget}
                          onDismiss={onDismissActionWidget}
                        />
                      ))}
                    </div>
                  )}

                  {(message.actions?.length ?? 0) > 0 && (
                    <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                      {message.actions?.map((action) => {
                        const key = messageActionKey(message.id, action)
                        const state = messageActionState[key]
                        if (action.kind === 'review_focus_session') {
                          return (
                            <FocusReviewActionCard
                              key={key}
                              action={action}
                              state={state}
                              onSave={(reviewNote) => onMessageAction(message.id, action, { reviewNote })}
                            />
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
                          <div key={key} style={{ borderRadius: 12, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                              {contextHint ?? (action.kind === 'start_focus_session' ? 'Start a focus session from this chat context.' : 'Stop the active focus session from here.')}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                onClick={() => onMessageAction(message.id, action)}
                                disabled={disabled}
                                style={{ padding: '8px 12px', borderRadius: 9, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', color: 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.7 : 1 }}
                              >
                                {state?.busy ? (action.kind === 'start_focus_session' ? 'Starting…' : 'Stopping…') : action.label}
                              </button>
                              {state?.successLabel && <span style={{ fontSize: 12, color: 'var(--color-focus-green)' }}>{state.successLabel}</span>}
                              {state?.error && <span style={{ fontSize: 12, color: '#f87171' }}>{state.error}</span>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {(message.artifacts?.length ?? 0) > 0 && (
                    <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                      {message.artifacts?.map((artifact) => {
                        const color = artifact.format === 'csv' ? '#16a34a' : artifact.format === 'xlsx' ? '#15803d' : artifact.format === 'html' ? '#7c3aed' : artifact.format === 'json' ? '#f59e0b' : artifact.format === 'docx' ? '#1d4ed8' : artifact.format === 'pdf' ? '#b91c1c' : '#2563eb'
                        const kind = artifact.format === 'csv' ? 'csv' : artifact.format === 'html' ? 'html_chart' : 'markdown'
                        const formatLabel = artifact.format === 'docx' ? 'Word' : artifact.format === 'xlsx' ? 'Excel' : artifact.format === 'markdown' ? 'Markdown' : artifact.format.toUpperCase()
                        return (
                          <button
                            key={`${message.id}:${artifact.id}`}
                            type="button"
                            onClick={() => void ipc.shell.openPath(artifact.path)}
                            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface)', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                          >
                            <div style={{ width: 34, height: 34, borderRadius: 8, background: `${color}15`, border: `1px solid ${color}28`, color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <IconArtifactFile kind={kind} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {artifact.title}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                                {formatLabel} · click to open
                              </div>
                            </div>
                            <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, display: 'inline-flex' }}><IconExternal /></span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {(message.agent?.citations?.length ?? 0) > 0 && (
                    // Packet citations (DEV-182): each chip is one recorded
                    // context-packet item the answer's superscripts point at.
                    // Clicking a chip opens the full inspector (DEV-183) on
                    // this exchange's packet.
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 600 }}>From your day record</span>
                      {message.agent?.citations?.map((citation) => (
                        <button
                          key={`${message.id}:cite:${citation.marker}`}
                          type="button"
                          onClick={canInspect(message) ? () => onInspectPacket?.(message) : undefined}
                          title={`${citation.statement}\n${citation.identity}\n${canInspect(message) ? 'Click to see everything the AI was shown' : "Recorded in this answer's context packet"}`}
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', color: 'var(--color-text-secondary)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: canInspect(message) ? 'pointer' : 'default' }}
                        >
                          {citation.marker} · {citation.statement}
                        </button>
                      ))}
                    </div>
                  )}

                  {message.agent != null && (
                    // The settled trail (issue #25) + "What the AI saw"
                    // (DEV-183): the answer's quiet summary and step list,
                    // reconstructed from the persisted tool trace, next to
                    // the recorded context-packet pill. Read-only; works
                    // with no model configured.
                    <SettledActivityTrail
                      message={message}
                      canInspect={canInspect(message)}
                      onInspect={() => onInspectPacket?.(message)}
                      reducedMotion={reducedMotion}
                    />
                  )}

                  {(message.agent?.fileDisclosures?.length ?? 0) > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 600 }}>Files opened</span>
                      {message.agent?.fileDisclosures?.map((disclosure) => (
                        // The chip stays human — just the file name. The
                        // audit detail (path, version, byte range) lives in
                        // the tooltip and the Settings access log, not inline.
                        <span
                          key={`${message.id}:${disclosure.path}:${disclosure.excerptStart}`}
                          title={`${disclosure.path}\nversion ${disclosure.versionFingerprint}\nbytes ${disclosure.excerptStart}–${disclosure.excerptEnd}\nLogged in Settings → Agent file access`}
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--color-border-ghost)', background: 'var(--color-surface-low)', color: 'var(--color-text-secondary)' }}
                        >
                          {disclosure.name}
                        </span>
                      ))}
                    </div>
                  )}

                  {message.id === latestCompletedAssistantId && message.state === 'complete' && (message.suggestedFollowUps?.length ?? 0) >= 2 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                      {message.suggestedFollowUps?.map((suggestion) => (
                        <button
                          key={`${message.id}:${suggestion.text}`}
                          type="button"
                          onClick={() => onFollowUpClick(message, suggestion.text, suggestion.source)}
                          style={{ padding: '7px 12px', borderRadius: 999, border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 12.5 }}
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
                      onClick={() => onCopy(message.id, message.content, message.answerKind)}
                    >
                      <IconCopy />
                    </IconActionButton>
                    <IconActionButton
                      label="Thumbs up"
                      tone="positive"
                      selected={message.rating === 'up'}
                      pulseNonce={actionFeedback[actionFeedbackKey(message.id, 'up')]?.pulseNonce ?? 0}
                      reducedMotion={reducedMotion}
                      onClick={() => onRate(message, message.rating === 'up' ? null : 'up')}
                    >
                      <IconThumbsUp />
                    </IconActionButton>
                    <IconActionButton
                      label="Thumbs down"
                      tone="negative"
                      selected={message.rating === 'down'}
                      pulseNonce={actionFeedback[actionFeedbackKey(message.id, 'down')]?.pulseNonce ?? 0}
                      reducedMotion={reducedMotion}
                      onClick={() => onRate(message, message.rating === 'down' ? null : 'down')}
                    >
                      <IconThumbsDown />
                    </IconActionButton>
                    {message.id === latestCompletedAssistantId && (
                      <IconActionButton
                        label="Retry response"
                        pulseNonce={actionFeedback[actionFeedbackKey(message.id, 'retry')]?.pulseNonce ?? 0}
                        reducedMotion={reducedMotion}
                        onClick={() => onRetry(index, message)}
                        disabled={providerActionsDisabled}
                      >
                        <IconRetry />
                      </IconActionButton>
                    )}
                    {message.id === latestCompletedAssistantId && <TransformMenu onTransform={onTransform} disabled={providerActionsDisabled} />}
                  </div>
                </>
              )}
            </div>
          </div>
        )
      ))}
    </div>
  )
}

// Small pause glyph for the paused row and the waiting state line.
function IconPauseDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4" y="3" width="3" height="10" rx="1.2" />
      <rect x="9" y="3" width="3" height="10" rx="1.2" />
    </svg>
  )
}

export const MessageList = memo(MessageListImpl)
