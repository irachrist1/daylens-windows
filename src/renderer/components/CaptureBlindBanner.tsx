// Capture-trouble banners, shown across the app on the capture-verification
// channel. Two conditions share the visual system:
//   - DEV-229 blind: the Accessibility grant was revoked or silently died
//     (a rebuild/update invalidates it). Pairs with the native notification;
//     this banner is the in-app path to the re-grant walkthrough.
//   - DEV-261 stalls: the recorder froze repeatedly this session, so today
//     may have holes. Persistent while stalls continue, clears when they stop.
// Blind wins when both hold — it is the one the person can act on.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CaptureVerificationState } from '@shared/types'
import { ipc } from '../lib/ipc'

const bannerStyle: React.CSSProperties = {
  padding: '10px 18px',
  background: 'linear-gradient(180deg, rgba(251,191,36,0.16), rgba(251,191,36,0.08))',
  borderBottom: '1px solid rgba(251,191,36,0.28)',
  color: 'var(--color-text-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 14,
  flexWrap: 'wrap',
  WebkitAppRegion: 'no-drag',
} as React.CSSProperties

const dotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'rgb(251,191,36)',
  boxShadow: '0 0 0 6px rgba(251,191,36,0.12)',
  flexShrink: 0,
}

export default function CaptureBlindBanner() {
  const navigate = useNavigate()
  const [state, setState] = useState<CaptureVerificationState | null>(null)

  useEffect(() => {
    void ipc.tracking.getCaptureVerification().then((initial) => {
      if (initial) setState(initial)
    }).catch(() => {})
    return ipc.tracking.onCaptureVerificationChanged(setState)
  }, [])

  if (!state) return null

  if (state.status === 'blind') {
    return (
      <div role="alert" style={bannerStyle}>
        <span aria-hidden="true" style={dotStyle} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Daylens can’t see window titles
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {state.axTrusted
            ? 'The Accessibility grant stopped working — this happens after updates.'
            : 'Accessibility permission is off.'}
        </span>
        <button
          type="button"
          onClick={() => navigate('/settings?section=capture')}
          style={{
            padding: '4px 12px',
            borderRadius: 8,
            border: '1px solid rgba(251,191,36,0.4)',
            background: 'transparent',
            color: 'var(--color-text-primary)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Fix now
        </button>
      </div>
    )
  }

  if (state.recorderStall) {
    const { stallCount } = state.recorderStall
    return (
      <div role="alert" style={bannerStyle}>
        <span aria-hidden="true" style={dotStyle} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Recording froze, so today may have holes
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {stallCount === 1
            ? 'Daylens stopped responding for a stretch. That stretch is marked on your timeline, and nothing is made up for it.'
            : `Daylens stopped responding ${stallCount} times. Those stretches are marked on your timeline, and nothing is made up for them.`}
        </span>
      </div>
    )
  }

  return null
}
