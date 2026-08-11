// The correction preview → apply → undo flow (timeline spec, Corrections;
// DEV-172). Every non-destructive correction runs through one gesture: the
// caller builds a CorrectionCommand, this hook fetches the exact cross-surface
// preview (the preview IS the apply, dry-run — computed in a savepoint in the
// main process), shows it in a dialog, applies atomically on confirm, and
// leaves an Undo toast up until the next correction replaces it. Permanent
// purges never come through here — they keep their native confirm and no undo.
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { CorrectionBlockDelta, CorrectionCommand, CorrectionPreview } from '@shared/types'
import { activityCategoryLabel } from '@shared/activityCategories'
import { ipc } from '../lib/ipc'
import { sanitizeIpcError } from '../lib/ipcError'
import { formatDuration } from '../lib/format'
import { formatDisplayAppName } from '../lib/apps'

interface PendingPreview {
  command: CorrectionCommand
  preview: CorrectionPreview
  resolve: (applied: boolean) => void
}

interface AppliedCorrection {
  correctionId: string
  description: string
}

export interface CorrectionFlow {
  /**
   * Preview the command and let the user confirm or cancel. Resolves true
   * only after the correction has applied (the caller can then adjust
   * selection state); resolves false on cancel. Throws if the preview itself
   * fails — the caller owns that error surface.
   */
  request: (command: CorrectionCommand) => Promise<boolean>
  /** Render once, near the top of the view — the dialog and the undo toast. */
  overlay: ReactNode
}

export function useCorrectionFlow(onApplied: () => void | Promise<void>): CorrectionFlow {
  const [pending, setPending] = useState<PendingPreview | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applied, setApplied] = useState<AppliedCorrection | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  // The undo toast fades on its own a few seconds after it appears (DEV-230:
  // the "attended" confirmation used to stay up forever). Hovering it — reaching
  // for Undo — pauses the timer, and a mid-undo error keeps it up so the failure
  // isn't lost. A new correction replaces `applied` and restarts the countdown.
  const [toastHovered, setToastHovered] = useState(false)

  const request = useCallback(async (command: CorrectionCommand): Promise<boolean> => {
    const preview = await ipc.db.previewCorrection(command)
    setApplyError(null)
    return new Promise<boolean>((resolve) => {
      setPending((current) => {
        // A second request while a dialog is open cancels the first — the
        // dialog is modal, so this only happens across stale async paths.
        current?.resolve(false)
        return { command, preview, resolve }
      })
    })
  }, [])

  const cancel = () => {
    if (applying || !pending) return
    pending.resolve(false)
    setPending(null)
    setApplyError(null)
  }

  const apply = async () => {
    if (applying || !pending) return
    setApplying(true)
    setApplyError(null)
    try {
      const result = await ipc.db.applyCorrection(pending.command)
      setPending(null)
      pending.resolve(true)
      setApplied(result)
      setUndoError(null)
      await onApplied()
    } catch (err) {
      setApplyError(sanitizeIpcError(err, "Couldn't apply the correction. Try again in a moment.").message)
    } finally {
      setApplying(false)
    }
  }

  useEffect(() => {
    if (!applied || toastHovered || undoBusy || undoError) return
    const timer = setTimeout(() => setApplied(null), 6000)
    return () => clearTimeout(timer)
  }, [applied, toastHovered, undoBusy, undoError])

  const undo = async () => {
    if (undoBusy || !applied) return
    setUndoBusy(true)
    setUndoError(null)
    try {
      const result = await ipc.db.undoCorrection(applied.correctionId)
      if (result.undone) {
        setApplied(null)
        await onApplied()
      } else {
        setUndoError(result.description)
      }
    } catch (err) {
      setUndoError(sanitizeIpcError(err, "Couldn't undo the correction.").message)
    } finally {
      setUndoBusy(false)
    }
  }

  const overlay = (
    <>
      {pending && (
        <CorrectionPreviewDialog
          preview={pending.preview}
          applying={applying}
          error={applyError}
          onCancel={cancel}
          onApply={() => { void apply() }}
        />
      )}
      {!pending && applied && (
        <CorrectionUndoToast
          description={applied.description}
          busy={undoBusy}
          error={undoError}
          onUndo={() => { void undo() }}
          onDismiss={() => { setApplied(null); setUndoError(null) }}
          onHoverChange={setToastHovered}
        />
      )}
    </>
  )

  return { request, overlay }
}

// ─── Preview dialog ──────────────────────────────────────────────────────────
// One sentence naming the correction, then exactly what changes: the day
// total, each affected block before → after, each app's day total, and plain
// sentences on the consuming surfaces (search, AI, client rollups).

const timeOf = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// A block label can be arbitrarily long (a pasted ticket description); the
// preview shows at most two lines of it.
const clampedLabel: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
}

// A merge maps several source blocks onto one surviving block; showing the
// survivor once per source repeats it and reads as noise. Group deltas that
// resolve to the same successor so the preview reads "A + B → merged".
interface DeltaGroup {
  sources: CorrectionBlockDelta[]
  after: CorrectionBlockDelta | null
  categoryChanged: boolean
}

function groupDeltasBySuccessor(deltas: readonly CorrectionBlockDelta[]): DeltaGroup[] {
  const groups: DeltaGroup[] = []
  const byKey = new Map<string, DeltaGroup>()
  for (const delta of deltas) {
    if (delta.labelAfter === null) {
      groups.push({ sources: [delta], after: null, categoryChanged: false })
      continue
    }
    const key = `${delta.labelAfter}:${delta.startMsAfter}:${delta.endMsAfter}`
    const existing = byKey.get(key)
    if (existing) {
      existing.sources.push(delta)
      existing.categoryChanged ||= delta.categoryAfter !== delta.categoryBefore
    } else {
      const group: DeltaGroup = {
        sources: [delta],
        after: delta,
        categoryChanged: delta.categoryAfter !== null && delta.categoryAfter !== delta.categoryBefore,
      }
      byKey.set(key, group)
      groups.push(group)
    }
  }
  return groups
}

function CorrectionPreviewDialog({
  preview,
  applying,
  error,
  onCancel,
  onApply,
}: {
  preview: CorrectionPreview
  applying: boolean
  error: string | null
  onCancel: () => void
  onApply: () => void
}) {
  const totalChanged = preview.totalSecondsBefore !== preview.totalSecondsAfter
  const countChanged = preview.blockCountBefore !== preview.blockCountAfter

  const sectionTitle: CSSProperties = {
    fontSize: 10.5,
    fontWeight: 800,
    letterSpacing: '0.10em',
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    marginBottom: 8,
  }

  return (
    <div
      data-timeline-inspector="true"
      style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={() => { if (!applying) onCancel() }}
    >
      <div
        role="dialog"
        aria-label="Preview correction"
        style={{
          width: 480,
          maxWidth: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
          borderRadius: 16,
          border: '1px solid var(--color-border-ghost)',
          background: 'var(--color-surface)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
          padding: '18px 22px 18px',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1.4 }}>
          {preview.description}
        </div>

        {(totalChanged || countChanged) && (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginTop: 8, lineHeight: 1.6 }}>
            {totalChanged && (
              <div>
                Day total: {formatDuration(preview.totalSecondsBefore)} → {formatDuration(preview.totalSecondsAfter)}
              </div>
            )}
            {countChanged && (
              <div>
                Blocks: {preview.blockCountBefore} → {preview.blockCountAfter}
              </div>
            )}
          </div>
        )}

        {preview.blocks.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={sectionTitle}>Timeline</div>
            <div style={{ display: 'grid', gap: 12 }}>
              {groupDeltasBySuccessor(preview.blocks).map((group) => (
                <div key={group.sources[0].blockId} style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  {group.sources.map((delta) => (
                    <div key={delta.blockId} style={{ display: 'flex', alignItems: 'baseline', gap: 8, color: 'var(--color-text-tertiary)', textDecoration: group.after === null ? 'line-through' : 'none' }}>
                      <span style={clampedLabel}>{delta.labelBefore}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                        {timeOf(delta.startMsBefore)} – {timeOf(delta.endMsBefore)}
                      </span>
                    </div>
                  ))}
                  {group.after === null ? (
                    <div style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>Removed from the day</div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, color: 'var(--color-text-primary)', fontWeight: 600 }}>
                      <span aria-hidden style={{ flexShrink: 0, color: 'var(--color-text-secondary)', fontWeight: 500 }}>→</span>
                      <span style={clampedLabel}>{group.after.labelAfter}</span>
                      {group.after.startMsAfter != null && group.after.endMsAfter != null && (
                        <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                          {timeOf(group.after.startMsAfter)} – {timeOf(group.after.endMsAfter)}
                        </span>
                      )}
                      {group.categoryChanged && group.after.categoryAfter && (
                        <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                          · {activityCategoryLabel(group.after.categoryAfter)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {preview.apps.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={sectionTitle}>Apps</div>
            <div style={{ display: 'grid', gap: 4 }}>
              {preview.apps.map((delta) => (
                <div key={delta.appName} style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12.5 }}>
                  <span style={{ flex: 1, minWidth: 0, color: 'var(--color-text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatDisplayAppName(delta.appName)}
                  </span>
                  <span style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                    {formatDuration(delta.secondsBefore)} → {formatDuration(delta.secondsAfter)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {preview.surfaces.length > 0 && (
          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
            {preview.surfaces.map((sentence) => (
              <div key={sentence}>{sentence}</div>
            ))}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 11.5, lineHeight: 1.5, color: '#f87171', marginTop: 14 }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            type="button"
            disabled={applying}
            onClick={onCancel}
            style={{ border: '1px solid var(--color-border-ghost)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 12.5, fontWeight: 650, cursor: applying ? 'default' : 'pointer', padding: '7px 14px', borderRadius: 9 }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={applying}
            onClick={onApply}
            style={{ border: 'none', background: 'var(--gradient-primary)', color: 'var(--color-primary-contrast)', fontSize: 12.5, fontWeight: 700, cursor: applying ? 'default' : 'pointer', padding: '7px 16px', borderRadius: 9, opacity: applying ? 0.6 : 1 }}
          >
            {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Undo toast ──────────────────────────────────────────────────────────────
// Stays up until dismissed or replaced by the next correction — only the
// newest un-undone correction of a date can be undone, so one slot is enough.

function CorrectionUndoToast({
  description,
  busy,
  error,
  onUndo,
  onDismiss,
  onHoverChange,
}: {
  description: string
  busy: boolean
  error: string | null
  onUndo: () => void
  onDismiss: () => void
  onHoverChange: (hovered: boolean) => void
}) {
  return (
    <div
      data-timeline-inspector="true"
      role="status"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        zIndex: 85,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 'min(560px, calc(100vw - 48px))',
        borderRadius: 12,
        border: '1px solid var(--color-border-ghost)',
        background: 'var(--color-surface)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.28)',
        padding: '10px 14px',
      }}
    >
      <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {error ?? description}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onUndo}
        style={{ border: 'none', background: 'transparent', color: 'var(--color-primary)', fontSize: 12.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', padding: 0, flexShrink: 0 }}
      >
        {busy ? 'Undoing…' : 'Undo'}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{ border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 14, fontWeight: 700, cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  )
}
