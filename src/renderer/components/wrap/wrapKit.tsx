import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { AppCategory } from '@shared/types'
import type { WorkKind } from '@shared/workKind'
import { activityColorForCategory } from '@shared/activityColors'
import { formatHm } from '../../lib/dayWrapScenes'

// ─── Shared Wrapped kit (DEV-114 / DEV-103) ─────────────────────────────────────
// One visual system and story engine for every Wrapped — today, yesterday, week,
// month, year. The day and period stories assemble scenes from these primitives
// and hand them to <WrapStory>. Nothing here knows about day-vs-period; it is
// the look and the motion, shared.

export { formatHm }

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ─── Per-scene gradient identity ────────────────────────────────────────────────

export interface Theme { bg: string; accent: string; glow: string }

// ─── Opaque slide surface (DEV-248) ─────────────────────────────────────────────
// Every full-screen wrap surface paints a SOLID color under its gradient. The
// shipped bleed-through bug: a slide's visibility rode a `forwards`-fill opacity
// animation on the overlay root, and when that animation stalled the whole
// frame stayed translucent — the timeline showed through and "Save slide" sat
// on top of the sidebar's Settings button. Two invariants prevent any repeat:
//  1. a wrap root's steady state is fully opaque with NO opacity animation on
//     the root itself (entrance fades run on inner layers only), and
//  2. the gradient rides backgroundImage over this opaque backstop, so a
//     missing or broken gradient still leaves a solid wall, never a window.

export const WRAP_SURFACE_BACKSTOP = '#05060c'

/** The style for any layer that must never let the app show through: solid
 *  backstop first, the theme gradient painted over it. */
export function opaqueSlideSurface(theme: Theme): CSSProperties {
  return { backgroundColor: WRAP_SURFACE_BACKSTOP, backgroundImage: theme.bg }
}

export const THEME = {
  cover:    { bg: 'linear-gradient(160deg,#0a0f20 0%,#161f52 54%,#2a3fa6 100%)', accent: '#b9ccff', glow: 'rgba(77,120,255,0.42)' },
  headline: { bg: 'linear-gradient(160deg,#0b1224 0%,#15235e 52%,#2747b8 100%)', accent: '#bcd0ff', glow: 'rgba(77,120,255,0.5)' },
  did:      { bg: 'linear-gradient(160deg,#08160f 0%,#0f4034 52%,#16876a 100%)', accent: '#74f0cf', glow: 'rgba(40,210,160,0.42)' },
  shape:    { bg: 'linear-gradient(160deg,#150a22 0%,#421049 52%,#7e1f86 100%)', accent: '#f0a6f5', glow: 'rgba(220,80,230,0.4)' },
  standout: { bg: 'linear-gradient(160deg,#1d1305 0%,#5a3408 52%,#c8841a 100%)', accent: '#ffd79a', glow: 'rgba(255,170,70,0.46)' },
  thread:   { bg: 'linear-gradient(160deg,#08121f 0%,#123a52 52%,#1a6f86 100%)', accent: '#8fe0f5', glow: 'rgba(60,180,220,0.42)' },
  finale:   { bg: 'linear-gradient(160deg,#06070d 0%,#10121c 55%,#1c2233 100%)', accent: '#cfe0ff', glow: 'rgba(150,180,230,0.28)' },
  rest:     { bg: 'linear-gradient(160deg,#0d111a 0%,#222e48 55%,#3a4f74 100%)', accent: '#cdd9f0', glow: 'rgba(160,185,230,0.34)' },
} satisfies Record<string, Theme>

export type WrapPalette = typeof THEME

// ─── Seeded palette + layout (design variance, wrapped.md §7) ─────────────────
// The same kind of day must never LOOK the same twice. A stable per-day seed
// picks one palette family (so the colors change day to day but are identical on
// reopen) and a layout flavor. The chosen voice is still the ceiling for tone;
// this only varies the visual skin, never the words.

function hsl(h: number, s: number, l: number): string { return `hsl(${h} ${s}% ${l}%)` }

/** A complete scene gradient identity generated from one hue. Bottom stop stays
 *  dark enough that white body text always clears AA. */
function makeTheme(hue: number, finale = false): Theme {
  const bottomL = finale ? 16 : 40
  const midL = finale ? 11 : 22
  return {
    bg: `linear-gradient(160deg, ${hsl(hue, 58, 7)} 0%, ${hsl(hue, 54, midL)} 54%, ${hsl(hue, finale ? 30 : 60, bottomL)} 100%)`,
    accent: hsl(hue, 82, 80),
    glow: `hsl(${hue} 82% 62% / ${finale ? 0.28 : 0.42})`,
  }
}

// Each family is an ordered set of hues for [cover, headline, did, shape,
// standout, thread, finale, rest]. Deliberately distinct families, not random.
const PALETTE_HUES: number[][] = [
  [224, 230, 162, 285, 36, 196, 232, 220], // cool blue (the classic)
  [268, 282, 150, 330, 28, 200, 256, 262], // violet
  [156, 168, 200, 286, 36, 188, 168, 160], // forest
  [16, 32, 152, 286, 200, 210, 18, 22],    // warm amber
  [202, 320, 150, 268, 36, 188, 210, 206], // electric mixed
]

const PALETTE_KEYS = ['cover', 'headline', 'did', 'shape', 'standout', 'thread', 'finale', 'rest'] as const

/** The palette for a given seed. Same shape as THEME, so callers swap THEME for
 *  pickPalette(seed) and keep using .cover / .headline / ... unchanged. */
export function pickPalette(seed: number): WrapPalette {
  const hues = PALETTE_HUES[seed % PALETTE_HUES.length]
  const out = {} as Record<(typeof PALETTE_KEYS)[number], Theme>
  PALETTE_KEYS.forEach((key, i) => { out[key] = makeTheme(hues[i], key === 'finale') })
  return out as WrapPalette
}

// Delegates to the shared, Settings-aware resolver (src/shared/activityColors.ts)
// so Wrapped agrees with the calendar and honors the user's per-category
// overrides — it used to carry its own hardcoded palette here, disconnected
// from Settings → General → Activity colors entirely.
export function categoryColor(category: AppCategory | 'unknown', kind?: WorkKind): string {
  if (kind === 'leisure') return '#ff6b6b'
  if (kind === 'personal') return '#9aa6c2'
  if (category === 'unknown') return activityColorForCategory('uncategorized')
  return activityColorForCategory(category)
}

// ─── Count-up (shared rAF clock, reduced-motion aware) ──────────────────────────

interface CountUpAnim { start: number; duration: number; target: number; set: (v: number) => void }
const activeCountUps = new Set<CountUpAnim>()
let countUpRaf: number | null = null
function pumpCountUps(now: number): void {
  for (const anim of activeCountUps) {
    const t = Math.min((now - anim.start) / anim.duration, 1)
    anim.set(Math.round((1 - Math.pow(1 - t, 3)) * anim.target))
    if (t >= 1) activeCountUps.delete(anim)
  }
  countUpRaf = activeCountUps.size > 0 ? requestAnimationFrame(pumpCountUps) : null
}
export function useCountUp(target: number, duration = 1100): number {
  const [val, setVal] = useState(prefersReducedMotion() ? target : 0)
  useEffect(() => {
    if (prefersReducedMotion() || target === 0) { setVal(target); return }
    setVal(0)
    const anim: CountUpAnim = { start: performance.now(), duration, target, set: setVal }
    activeCountUps.add(anim)
    if (countUpRaf == null) countUpRaf = requestAnimationFrame(pumpCountUps)
    return () => { activeCountUps.delete(anim) }
  }, [target, duration])
  return val
}

export function HmCountUp({ seconds, style }: { seconds: number; style: CSSProperties }) {
  const minutes = useCountUp(Math.round(seconds / 60))
  return <span style={style}>{formatHm(minutes * 60)}</span>
}

// ─── Layout primitives ──────────────────────────────────────────────────────────

export function Scene({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      textAlign: 'center', padding: 'min(11vh, 96px) clamp(28px, 7vw, 88px) min(12vh, 104px)',
      pointerEvents: 'none',
    }}>
      <div style={{ width: '100%', maxWidth: 720, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {children}
      </div>
    </div>
  )
}

export function Kicker({ children, accent }: { children: ReactNode; accent: string }) {
  return (
    <p style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: accent, margin: '0 0 26px', opacity: 0.92 }}>
      {children}
    </p>
  )
}

export const subtleLine: CSSProperties = {
  fontSize: 'clamp(18px, 2.6vw, 23px)', fontWeight: 400, lineHeight: 1.5,
  color: 'rgba(255,255,255,0.82)', margin: '26px 0 0', maxWidth: '30ch',
}

export function primaryButton(accent: string): CSSProperties {
  return { padding: '13px 26px', borderRadius: 11, background: accent, color: '#06122a', fontSize: 15, fontWeight: 740, border: 'none', cursor: 'pointer', letterSpacing: '-0.01em' }
}
export const ghostButton: CSSProperties = {
  padding: '13px 22px', borderRadius: 11, background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.78)',
  fontSize: 15, fontWeight: 560, border: '1px solid rgba(255,255,255,0.16)', cursor: 'pointer',
}

export function MessageScene({ kicker, title, body, theme, children }: { kicker: string; title: string; body?: string; theme: Theme; children?: ReactNode }) {
  return (
    <Scene>
      <Kicker accent={theme.accent}>{kicker}</Kicker>
      <h1 style={{ fontSize: 'clamp(30px, 5vw, 48px)', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#fff', margin: 0, maxWidth: '20ch' }}>{title}</h1>
      {body && <p style={{ ...subtleLine, maxWidth: '40ch' }}>{body}</p>}
      {children}
    </Scene>
  )
}

/** A single full-screen wrap message (gates: under-threshold, no provider,
 *  quiet day, period still open). The same frame the deck uses, one card. */
export function WrapGate({ theme, kicker, title, body, onClose, children }: {
  theme: Theme; kicker: string; title: string; body?: string; onClose: () => void; children?: ReactNode
}) {
  return (
    // The root is opaque and never animates opacity; the fade-in runs on the
    // inner gradient layer so a stalled animation shows the dark backstop,
    // never the app underneath (see opaqueSlideSurface).
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: WRAP_SURFACE_BACKSTOP, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, ...opaqueSlideSurface(theme), animation: 'wrappedOverlayIn 280ms ease' }} />
      <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse 75% 60% at 50% 40%, ${theme.glow}, transparent 72%)` }} />
      <MessageScene kicker={kicker} title={title} body={body} theme={theme}>
        {children}
      </MessageScene>
      <button
        onClick={onClose}
        style={{ position: 'absolute', top: 30, right: 16, zIndex: 10, width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.7)', fontSize: 18, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        aria-label="Close"
      >×</button>
    </div>
  )
}

// ─── Seeded export gradient ───────────────────────────────────────────────────

/** Gradient stops + accent for the Nth slide of a seeded deck, so the exported
 *  sequence walks the same palette family the on-screen wrap plays through.
 *  The canvas rendering itself lives in wrapExport.ts. */
export function slideGradient(seed: number, slideIndex: number): { gradient: [string, string, string]; accent: string } {
  const hues = PALETTE_HUES[seed % PALETTE_HUES.length]
  const hue = hues[slideIndex % hues.length]
  return {
    gradient: [hsl(hue, 58, 7), hsl(hue, 54, 20), hsl(hue, 58, 36)],
    accent: hsl(hue, 82, 80),
  }
}
