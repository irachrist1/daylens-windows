import { useEffect, useState } from 'react'
import Mascot from '../Mascot'
import { opaqueSlideSurface, prefersReducedMotion, WRAP_SURFACE_BACKSTOP, type Theme } from './wrapKit'

// The cinematic "Generating your wrap…" screen — what plays while the AI
// assembles the deck on a first open. Fixes the old first-open experience,
// which flashed an unstyled shell with no signal that anything was happening.
// Reduced motion: a calm static card, no drift, no shimmer.

const STATUS_LINES: Record<'day' | 'week' | 'month' | 'year', string[]> = {
  day: ['Reading your day…', 'Finding the long stretches…', 'Checking where the time pooled…', 'Writing it up…'],
  week: ['Reading your week…', 'Lining up the seven days…', 'Finding the stretches that mattered…', 'Comparing it to last week…', 'Writing it up…'],
  month: ['Reading your month…', 'Summing the weeks…', 'Finding what defined it…', 'Writing it up…'],
  year: ['Reading your year…', 'Summing the months…', 'Finding the arc…', 'Writing it up…'],
}

export default function GeneratingScreen({ cadence, theme, onClose }: {
  cadence: 'day' | 'week' | 'month' | 'year'
  theme: Theme
  onClose: () => void
}) {
  const reduced = prefersReducedMotion()
  const lines = STATUS_LINES[cadence]
  const [lineIndex, setLineIndex] = useState(0)

  useEffect(() => {
    if (reduced) return
    const id = setInterval(() => setLineIndex((i) => Math.min(i + 1, lines.length - 1)), 2600)
    return () => clearInterval(id)
  }, [reduced, lines.length])

  return (
    // Opaque root, no opacity animation on it — the fade runs on the gradient
    // layer inside, so a stalled animation can never leave the app showing
    // through (the DEV-248 bleed-through bug; see opaqueSlideSurface).
    <div
      data-testid="wrap-generating"
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: WRAP_SURFACE_BACKSTOP, overflow: 'hidden' }}
    >
      <div style={{ position: 'absolute', inset: 0, ...opaqueSlideSurface(theme), animation: 'wrappedOverlayIn 280ms ease' }} />
      {/* Drifting glow orbs — the "being cooked" atmosphere. */}
      {!reduced && (
        <>
          <Orb color={theme.glow} size="52vmin" left="12%" top="18%" duration="11s" />
          <Orb color={theme.glow} size="38vmin" left="64%" top="52%" duration="14s" delay="-4s" />
          <Orb color={theme.glow} size="30vmin" left="34%" top="66%" duration="17s" delay="-9s" />
        </>
      )}

      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 24px',
      }}>
        <div style={{ marginBottom: 30, animation: reduced ? 'none' : 'wrappedBreath 3.2s ease-in-out infinite' }}>
          <Mascot expression="think" size={96} />
        </div>
        <h1 style={{ fontSize: 'clamp(30px, 5vw, 46px)', fontWeight: 800, letterSpacing: '-0.02em', color: '#fff', margin: 0 }}>
          Generating your wrap
        </h1>
        <p key={lineIndex} style={{
          fontSize: 17, color: 'rgba(255,255,255,0.72)', marginTop: 18, minHeight: 24,
          animation: reduced ? 'none' : 'wrappedRevealUp 480ms ease both',
        }}>
          {lines[lineIndex]}
        </p>

        {/* Indeterminate shimmer bar. */}
        <div style={{ width: 'min(280px, 60vw)', height: 4, borderRadius: 2, marginTop: 34, overflow: 'hidden', background: 'rgba(255,255,255,0.14)' }}>
          <div style={{
            width: '100%', height: '100%',
            background: `linear-gradient(90deg, transparent, ${theme.accent}, transparent)`,
            backgroundSize: '200% 100%',
            animation: reduced ? 'none' : 'wrappedShimmer 1.6s linear infinite',
          }} />
        </div>
      </div>

      <button
        onClick={onClose}
        style={{ position: 'absolute', top: 30, right: 16, zIndex: 10, width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.7)', fontSize: 18, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        aria-label="Close"
      >×</button>
    </div>
  )
}

function Orb({ color, size, left, top, duration, delay }: { color: string; size: string; left: string; top: string; duration: string; delay?: string }) {
  return (
    <div style={{
      position: 'absolute', left, top, width: size, height: size, borderRadius: '50%',
      background: `radial-gradient(circle, ${color}, transparent 70%)`,
      filter: 'blur(6px)',
      animation: `wrappedOrbDrift ${duration} ease-in-out infinite`,
      animationDelay: delay ?? '0s',
    }} />
  )
}
