// Settings → Screen context (experiment) — DEV-198.
//
// The opt-in surface for the screen-context experiment on top of the DEV-197
// lifecycle. Everything the spec demands a tester can see and do lives here:
// the explicit consent flow in deliberately plain, scary-clear language; the
// pause switch; the backlog and quarantine with explicit Retry/Delete; the
// per-excluded-app deletion offers; the full wipe; and honest status —
// including the truth that no OS screen sampler ships in this build yet, so
// consent prepares the pipeline rather than starting invisible capture.
import { useCallback, useEffect, useState } from 'react'
import type { ScreenContextBacklogFrame, ScreenContextStatus } from '@shared/types'
import { ipc } from '../../lib/ipc'
import { captureEvidenceLine, describeCaptureBlockReason, screenContextHeadline } from './screenContextCopy'

const buttonStyle: React.CSSProperties = {
  fontSize: 12.5,
  padding: '7px 14px',
  borderRadius: 9,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface-low)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--gradient-primary)',
  color: 'var(--color-primary-contrast)',
  border: 'none',
  fontWeight: 620,
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  color: '#f87171',
  borderColor: 'rgba(248, 113, 113, 0.4)',
}

const cardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  padding: '14px 16px',
  borderRadius: 14,
  border: '1px solid var(--color-border-ghost)',
  background: 'var(--color-surface-low)',
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function frameStateLabel(state: string): string {
  switch (state) {
    case 'captured': return 'Waiting for extraction'
    case 'extracting': return 'Extracting'
    case 'indexed': return 'Extracted, deleting the image'
    case 'safe_to_delete': return 'Deleting the image'
    case 'failed':
    case 'quarantined': return 'Extraction failed, quarantined'
    default: return state
  }
}

function ExperimentBadge() {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid rgba(251, 191, 36, 0.45)',
        color: '#fbbf24',
        background: 'rgba(251, 191, 36, 0.08)',
      }}
    >
      Experiment
    </span>
  )
}

// The consent copy. Deliberately scary-clear (screen-context.md §Product
// behavior): it leads with the uncomfortable fact, then what happens to each
// image, what is never captured, and the ways out. No softening. Kept to one
// short sentence pair per point (DEV-250).
const CONSENT_POINTS: Array<{ title: string; body: string }> = [
  {
    title: 'Daylens will take pictures of your screen.',
    body: 'Still snapshots of your active display, at most one automatic frame every 30 seconds. Never video, never audio.',
  },
  {
    title: 'Each picture is read once, then destroyed.',
    body: 'A frame is stored encrypted on this machine, useful details are extracted, and the image is deleted. Usually within seconds, always within 24 hours.',
  },
  {
    title: 'Some things are never captured.',
    body: 'Private windows, password and payment screens, excluded apps and sites, and anything on screen while you share it. Sampling stops before capture, not after.',
  },
  {
    title: 'Nothing leaves this machine.',
    body: 'Screen details are local only. Never synced, never exported, never sent to an AI provider.',
  },
  {
    title: 'You stay in control.',
    body: 'Pause instantly, inspect and delete every stored frame below, and leave at any time. Leaving deletes unprocessed pictures immediately.',
  },
]

export function ScreenContextSection() {
  const [status, setStatus] = useState<ScreenContextStatus | null>(null)
  const [backlog, setBacklog] = useState<{ frames: ScreenContextBacklogFrame[]; totals: { frames: number; bytes: number } } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  // DEV-251: the diagnostic click always ends in one of these, on screen.
  const [diagnostic, setDiagnostic] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmingWipe, setConfirmingWipe] = useState(false)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const [leaveWipesEverything, setLeaveWipesEverything] = useState(true)

  const reload = useCallback(async () => {
    try {
      const [nextStatus, nextBacklog] = await Promise.all([
        ipc.screenContext.status(),
        ipc.screenContext.listBacklog(),
      ])
      setStatus(nextStatus)
      setBacklog(nextBacklog)
      setError(null)
    } catch {
      setError('Couldn’t load the experiment status. Try again in a moment.')
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function run(action: () => Promise<{ ok: boolean; reason?: string | null }>) {
    setBusy(true)
    try {
      const result = await action()
      if (!result.ok && result.reason) setError(result.reason)
      else setError(null)
      await reload()
    } catch {
      setError('That didn’t work. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>{error ?? 'Loading…'}</div>
  }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <ExperimentBadge />
      <span style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
        Testing whether screen snapshots explain work that window titles can’t. This may never ship.
      </span>
    </div>
  )

  if (!status.supportedPlatform || (!status.eligible && !status.enabled)) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        {header}
        <div style={cardStyle}>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
            {status.eligibilityReason ?? 'The experiment is not available right now.'}
          </span>
        </div>
      </div>
    )
  }

  if (!status.enabled) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        {header}
        {error && <div style={{ fontSize: 12.5, color: '#f87171' }}>{error}</div>}
        <div style={{ display: 'grid', gap: 14 }}>
          {CONSENT_POINTS.map((point) => (
            <div key={point.title} style={{ display: 'grid', gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--color-text-primary)' }}>{point.title}</span>
              <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>{point.body}</span>
            </div>
          ))}
        </div>
        <div style={cardStyle}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            I understand Daylens will capture images of my screen while this experiment is on.
          </label>
          <div>
            <button
              type="button"
              style={{ ...primaryButtonStyle, opacity: understood && !busy ? 1 : 0.5 }}
              disabled={!understood || busy}
              onClick={() => void run(() => ipc.screenContext.enable())}
            >
              Join the experiment
            </button>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
            Joining is separate from every other Daylens permission. Normal tracking never turns this on.
          </span>
        </div>
      </div>
    )
  }

  const quarantined = backlog?.frames.filter((frame) => frame.state === 'failed' || frame.state === 'quarantined') ?? []

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {header}
      {error && <div style={{ fontSize: 12.5, color: '#f87171' }}>{error}</div>}

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>
            {screenContextHeadline(status)}
          </span>
          {status.samplerActive && (
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: 4, background: '#f87171', display: 'inline-block' }}
            />
          )}
          {status.consentAt && (
            <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
              consented {new Date(status.consentAt).toLocaleDateString()}
            </span>
          )}
          <button
            type="button"
            style={{ ...buttonStyle, marginLeft: 'auto' }}
            disabled={busy}
            onClick={() => void run(() => ipc.screenContext.setPaused(!status.paused))}
          >
            {status.paused ? 'Resume sampling' : 'Pause sampling'}
          </button>
        </div>
        {/* DEV-251: the claim above is backed by evidence, never by a setting. */}
        <span style={{ fontSize: 12.5, fontWeight: 560, color: 'var(--color-text-secondary)' }}>
          {captureEvidenceLine(status)}
        </span>
        {status.samplerInstalled ? (
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
            Excluded apps, private windows, and password or payment screens are refused before any pixel is read.
            Extraction isn’t installed in this build yet, so captured frames wait encrypted below until it ships
            or you delete them.
          </span>
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
            Nothing is being captured: no screen sampler exists on this platform. Your consent prepares the
            pipeline for a supported build.
          </span>
        )}
        {status.samplerInstalled && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy || status.paused}
                onClick={() => {
                  void (async () => {
                    setBusy(true)
                    setDiagnostic(null)
                    try {
                      const result = await ipc.screenContext.diagnosticSample()
                      await reload()
                      if (result.captured) {
                        const fresh = await ipc.screenContext.status()
                        const at = fresh.lastCapturedAt != null ? new Date(fresh.lastCapturedAt).toLocaleTimeString() : null
                        setDiagnostic({
                          ok: true,
                          text: `Sample captured${at ? ` at ${at}` : ''}. It is listed under stored frames below.`,
                        })
                      } else {
                        setDiagnostic({ ok: false, text: describeCaptureBlockReason(result.reason) })
                      }
                    } catch {
                      setDiagnostic({ ok: false, text: 'The diagnostic didn’t run. Try again in a moment.' })
                    } finally {
                      setBusy(false)
                    }
                  })()
                }}
              >
                Capture a diagnostic sample
              </button>
            </div>
            {diagnostic && (
              <span
                role="status"
                style={{ fontSize: 12.5, lineHeight: 1.5, color: diagnostic.ok ? 'var(--color-text-secondary)' : '#fbbf24' }}
              >
                {diagnostic.text}
              </span>
            )}
          </div>
        )}
        {status.backlogCapReached && (
          <span style={{ fontSize: 12.5, color: '#fbbf24' }}>
            The frame backlog is full. Sampling stays paused until you delete frames below.
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>Stored frames</span>
          <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
            {backlog ? `${backlog.totals.frames} on disk · ${fmtBytes(backlog.totals.bytes)}` : ''}
            {status.evidenceCount > 0 ? ` · ${status.evidenceCount} extracted record${status.evidenceCount === 1 ? '' : 's'} (local-only)` : ''}
          </span>
        </div>
        {!backlog || backlog.frames.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 }}>
            No frames stored. Nothing has been captured.
          </div>
        ) : (
          backlog.frames.map((frame) => {
            const isQuarantined = frame.state === 'failed' || frame.state === 'quarantined'
            return (
              <div
                key={frame.id}
                style={{ ...cardStyle, gap: 6, padding: '12px 14px' }}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>
                    {frame.appName ?? 'Unknown app'}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                    {new Date(frame.capturedAt).toLocaleString()} · {fmtBytes(frame.byteSize)} · {frameStateLabel(frame.state)}
                    {frame.retryCount > 0 ? ` · ${frame.retryCount} retr${frame.retryCount === 1 ? 'y' : 'ies'}` : ''}
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    {isQuarantined && (
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={busy}
                        onClick={() => void run(() => ipc.screenContext.retryFrame(frame.id))}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      style={dangerButtonStyle}
                      disabled={busy}
                      onClick={() => void run(async () => ipc.screenContext.deleteFrame(frame.id))}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {isQuarantined && frame.lastError && (
                  <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                    Kept encrypted and out of every product surface until you retry or delete it.
                  </span>
                )}
              </div>
            )
          })
        )}
        {quarantined.length > 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
            Quarantined frames are never deleted automatically. Each is the only copy, and the decision is yours.
          </span>
        )}
      </div>

      {status.exclusionOffers.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>
            Excluded apps with screen records
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
            These apps are excluded now, but screen records from before still exist. Delete them here.
          </span>
          {status.exclusionOffers.map((offer) => (
            <div key={offer.source} style={{ ...cardStyle, gap: 6, padding: '12px 14px' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>{offer.source}</span>
                <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                  {offer.frameCount} frame{offer.frameCount === 1 ? '' : 's'} · {offer.evidenceCount} extracted record{offer.evidenceCount === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  style={{ ...dangerButtonStyle, marginLeft: 'auto' }}
                  disabled={busy}
                  onClick={() => void run(async () => ipc.screenContext.deleteForSource(offer.source))}
                >
                  Delete these records
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 620, color: 'var(--color-text-primary)' }}>Leave or wipe</span>
        {confirmingWipe ? (
          <div style={{ ...cardStyle, borderColor: 'rgba(248, 113, 113, 0.4)' }}>
            <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)', lineHeight: 1.55 }}>
              Delete every screen frame and every extracted screen record on this machine? This cannot be undone.
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                style={dangerButtonStyle}
                disabled={busy}
                onClick={() => { setConfirmingWipe(false); void run(async () => ipc.screenContext.wipe()) }}
              >
                Delete everything
              </button>
              <button type="button" style={buttonStyle} onClick={() => setConfirmingWipe(false)}>Cancel</button>
            </div>
          </div>
        ) : confirmingLeave ? (
          <div style={{ ...cardStyle, borderColor: 'rgba(248, 113, 113, 0.4)' }}>
            <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)', lineHeight: 1.55 }}>
              Leave the experiment? Unprocessed pictures are deleted immediately and no more will ever be taken.
              Normal tracking is unaffected.
            </span>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--color-text-primary)' }}>
              <input
                type="checkbox"
                checked={leaveWipesEverything}
                onChange={(event) => setLeaveWipesEverything(event.target.checked)}
              />
              Also delete everything already extracted (recommended)
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                style={dangerButtonStyle}
                disabled={busy}
                onClick={() => {
                  setConfirmingLeave(false)
                  void run(() => ipc.screenContext.revoke({ wipeEverything: leaveWipesEverything }))
                }}
              >
                Leave the experiment
              </button>
              <button type="button" style={buttonStyle} onClick={() => setConfirmingLeave(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={dangerButtonStyle} disabled={busy} onClick={() => setConfirmingLeave(true)}>
              Leave the experiment…
            </button>
            <button type="button" style={dangerButtonStyle} disabled={busy} onClick={() => setConfirmingWipe(true)}>
              Delete all screen data…
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
