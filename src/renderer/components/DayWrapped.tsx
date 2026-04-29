import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppCategory, DayTimelinePayload } from '@shared/types'
import { dateStringFromMs, dayBounds, formatTime, todayString } from '../lib/format'
import { ipc } from '../lib/ipc'

// ─── Themes ─────────────────────────────────────────────────────────────────

interface SlideTheme { bg: string; accent: string; glow: string; hue: string }

const MORNING_VIDEO_URLS = [
  new URL('../assets/videos/morning-coffee-sunrise.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-forest.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-coffee-bokeh.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-horizon.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-hills.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-hearth.mp4', import.meta.url).href,
]

const MORNING_THEMES: SlideTheme[] = [
  { bg: 'linear-gradient(158deg,#1d180f 0%,#66350d 48%,#ef9a3a 100%)', accent: '#ffd38a', glow: 'rgba(255,179,84,0.42)', hue: 'amber' },
  { bg: 'linear-gradient(144deg,#0b1820 0%,#315a56 48%,#e0a96d 100%)', accent: '#bff0dc', glow: 'rgba(191,240,220,0.28)', hue: 'sage' },
  { bg: 'linear-gradient(166deg,#251126 0%,#74393f 52%,#f2b270 100%)', accent: '#ffc7a0', glow: 'rgba(255,172,116,0.36)', hue: 'rose' },
  { bg: 'linear-gradient(136deg,#101a2a 0%,#234f74 46%,#f5c778 100%)', accent: '#b9ddff', glow: 'rgba(185,221,255,0.3)', hue: 'dawn-blue' },
]

const CAT_THEME: Partial<Record<AppCategory, SlideTheme>> = {
  development:   { bg: 'linear-gradient(150deg,#060d22 0%,#0d1c52 55%,#1a2e7a 100%)', accent: '#b4c5ff', glow: 'rgba(77,142,255,0.38)',   hue: 'blue'    },
  design:        { bg: 'linear-gradient(150deg,#150818 0%,#3d0a48 55%,#6b1280 100%)', accent: '#f472b6', glow: 'rgba(244,114,182,0.38)',  hue: 'pink'    },
  communication: { bg: 'linear-gradient(150deg,#030f0e 0%,#083830 55%,#0d5c50 100%)', accent: '#4fdbc8', glow: 'rgba(79,219,200,0.38)',   hue: 'teal'    },
  research:      { bg: 'linear-gradient(150deg,#0c0718 0%,#260865 55%,#3d0e9c 100%)', accent: '#c084fc', glow: 'rgba(192,132,252,0.38)',  hue: 'violet'  },
  writing:       { bg: 'linear-gradient(150deg,#040b1a 0%,#082060 55%,#0d3690 100%)', accent: '#93c5fd', glow: 'rgba(147,197,253,0.38)',  hue: 'blue'    },
  aiTools:       { bg: 'linear-gradient(150deg,#130618 0%,#480865 55%,#780898 100%)', accent: '#e879f9', glow: 'rgba(232,121,249,0.38)',  hue: 'magenta' },
  productivity:  { bg: 'linear-gradient(150deg,#031208 0%,#083820 55%,#0d5c32 100%)', accent: '#6ee7b7', glow: 'rgba(110,231,183,0.38)',  hue: 'green'   },
  meetings:      { bg: 'linear-gradient(150deg,#130e04 0%,#3d2206 55%,#6b3a06 100%)', accent: '#ffb95f', glow: 'rgba(255,185,95,0.38)',   hue: 'gold'    },
  email:         { bg: 'linear-gradient(150deg,#031214 0%,#084048 55%,#0d6470 100%)', accent: '#67e8f9', glow: 'rgba(103,232,249,0.38)',  hue: 'cyan'    },
  browsing:      { bg: 'linear-gradient(150deg,#140804 0%,#481806 55%,#7a2a06 100%)', accent: '#fb923c', glow: 'rgba(251,146,60,0.38)',   hue: 'orange'  },
  social:        { bg: 'linear-gradient(150deg,#0e0820 0%,#2c1870 55%,#4a2ab0 100%)', accent: '#a78bfa', glow: 'rgba(167,139,250,0.38)',  hue: 'indigo'  },
  entertainment: { bg: 'linear-gradient(150deg,#180808 0%,#5a0c0c 55%,#8c1a1a 100%)', accent: '#f87171', glow: 'rgba(248,113,113,0.38)',  hue: 'red'     },
  system:        { bg: 'linear-gradient(150deg,#080808 0%,#1a1a1a 55%,#2a2a2a 100%)', accent: '#94a3b8', glow: 'rgba(148,163,184,0.3)',   hue: 'gray'    },
  uncategorized: { bg: 'linear-gradient(150deg,#080808 0%,#1a1a1a 55%,#2a2a2a 100%)', accent: '#94a3b8', glow: 'rgba(148,163,184,0.3)',   hue: 'gray'    },
}

const DEFAULT_THEME: SlideTheme = {
  bg: 'linear-gradient(150deg,#060d1a 0%,#0d1c3a 55%,#1a2d5c 100%)',
  accent: '#adc6ff', glow: 'rgba(173,198,255,0.32)', hue: 'blue',
}

const FOCUS_THEME: SlideTheme = {
  bg: 'linear-gradient(150deg,#030f0e 0%,#083830 55%,#0d5c50 100%)',
  accent: '#4fdbc8', glow: 'rgba(79,219,200,0.38)', hue: 'teal',
}

const SCATTERED_THEME: SlideTheme = {
  bg: 'linear-gradient(150deg,#1a0808 0%,#4a0a0a 55%,#7a1010 100%)',
  accent: '#f87171', glow: 'rgba(248,113,113,0.38)', hue: 'red',
}

const STEADY_THEME: SlideTheme = {
  bg: 'linear-gradient(150deg,#031212 0%,#094040 55%,#0f6060 100%)',
  accent: '#4fdbc8', glow: 'rgba(79,219,200,0.38)', hue: 'teal',
}

// More saturated versions for the identity slide
const IDENTITY_CAT_THEME: Partial<Record<AppCategory, SlideTheme>> = {
  development:   { bg: 'linear-gradient(150deg,#000512 0%,#070f3a 45%,#0a1860 100%)',  accent: '#7eb2ff', glow: 'rgba(77,130,255,0.55)',   hue: 'blue'    },
  design:        { bg: 'linear-gradient(150deg,#100514 0%,#350640 45%,#5e0870 100%)',  accent: '#f472b6', glow: 'rgba(244,114,182,0.55)',  hue: 'pink'    },
  communication: { bg: 'linear-gradient(150deg,#020b0a 0%,#062e28 45%,#094a42 100%)',  accent: '#34d9c4', glow: 'rgba(52,217,196,0.55)',   hue: 'teal'    },
  research:      { bg: 'linear-gradient(150deg,#080514 0%,#1e0658 45%,#320890 100%)',  accent: '#b87aff', glow: 'rgba(160,80,255,0.55)',   hue: 'violet'  },
  writing:       { bg: 'linear-gradient(150deg,#030912 0%,#061a52 45%,#092880 100%)',  accent: '#7eb8ff', glow: 'rgba(100,160,255,0.55)',  hue: 'blue'    },
  aiTools:       { bg: 'linear-gradient(150deg,#0e0414 0%,#3c0660 45%,#620878 100%)',  accent: '#e040fb', glow: 'rgba(224,64,251,0.55)',   hue: 'magenta' },
  productivity:  { bg: 'linear-gradient(150deg,#020e06 0%,#063018 45%,#0a5028 100%)',  accent: '#4ade80', glow: 'rgba(74,222,128,0.55)',   hue: 'green'   },
  meetings:      { bg: 'linear-gradient(150deg,#0e0a02 0%,#321c04 45%,#5a3006 100%)',  accent: '#f59e0b', glow: 'rgba(245,158,11,0.55)',   hue: 'gold'    },
  email:         { bg: 'linear-gradient(150deg,#020e10 0%,#063640 45%,#0a5460 100%)',  accent: '#22d3ee', glow: 'rgba(34,211,238,0.55)',   hue: 'cyan'    },
  browsing:      { bg: 'linear-gradient(150deg,#0e0602 0%,#3c1404 45%,#6a2206 100%)',  accent: '#fb923c', glow: 'rgba(251,146,60,0.55)',   hue: 'orange'  },
  social:        { bg: 'linear-gradient(150deg,#080618 0%,#22145e 45%,#3a2298 100%)',  accent: '#a78bfa', glow: 'rgba(167,139,250,0.55)',  hue: 'indigo'  },
  entertainment: { bg: 'linear-gradient(150deg,#140606 0%,#480a0a 45%,#7c1616 100%)',  accent: '#ff6b6b', glow: 'rgba(255,107,107,0.55)',  hue: 'red'     },
}

const FALLBACK_POOL: SlideTheme[] = [
  CAT_THEME.meetings!,
  CAT_THEME.productivity!,
  CAT_THEME.design!,
  CAT_THEME.browsing!,
  CAT_THEME.email!,
  CAT_THEME.social!,
  CAT_THEME.entertainment!,
  CAT_THEME.communication!,
]

function catTheme(cat: AppCategory | string | undefined): SlideTheme {
  return (cat ? CAT_THEME[cat as AppCategory] : undefined) ?? DEFAULT_THEME
}

function identityCatTheme(cat: AppCategory | string | undefined): SlideTheme {
  return (cat ? IDENTITY_CAT_THEME[cat as AppCategory] : undefined) ?? DEFAULT_THEME
}

function dedupeAdjacentThemes(themes: SlideTheme[]): SlideTheme[] {
  const result: SlideTheme[] = []
  for (let i = 0; i < themes.length; i++) {
    let t = themes[i]
    if (i > 0 && result[i - 1].hue === t.hue) {
      const prev = result[i - 1].hue
      const next = i + 1 < themes.length ? themes[i + 1].hue : ''
      const fb = FALLBACK_POOL.find(f => f.hue !== prev && f.hue !== next && f.hue !== t.hue)
      if (fb) t = fb
    }
    result.push(t)
  }
  return result
}

// ─── Identity labels ──────────────────────────────────────────────────────────

const IDENTITY: Partial<Record<AppCategory, string>> = {
  development:   'Builder',
  design:        'Creator',
  communication: 'Connector',
  research:      'Explorer',
  writing:       'Storyteller',
  aiTools:       'Augmented',
  productivity:  'Operator',
  meetings:      'Collaborator',
  email:         'Networker',
  browsing:      'Researcher',
  entertainment: 'Decompressor',
  social:        'Networker',
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 850): number {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (target === 0) { setVal(0); return }
    const start = performance.now()
    let raf: number
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1)
      setVal(Math.round((1 - Math.pow(1 - t, 3)) * target))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}

function useAnimatedFill(target: number, delayMs = 80): number {
  const [fill, setFill] = useState(0)
  useEffect(() => {
    const id = setTimeout(() => setFill(target), delayMs)
    return () => clearTimeout(id)
  }, [target, delayMs])
  return fill
}

// ─── Derived data ─────────────────────────────────────────────────────────────

interface WrappedBlock {
  durationSeconds: number
  startTime: number
  endTime: number
  category: AppCategory
}

interface WrappedData {
  totalSeconds: number
  focusSeconds: number
  focusPct: number
  appCount: number
  blockCount: number
  peakBlock: { label: string; durationSeconds: number; startTime: number; endTime: number; category: AppCategory } | null
  topApp: { appName: string; durationSeconds: number; category: AppCategory } | null
  totalSwitches: number
  dominantCategory: AppCategory
  dominantCategoryPct: number
  blocks: WrappedBlock[]
  firstActivityTime: number | null
  dayStartMs: number
}

function deriveData(data: DayTimelinePayload): WrappedData {
  const [dayFrom] = dayBounds(data.date)

  const sortedBlocks = [...data.blocks].sort((a, b) => a.startTime - b.startTime)

  const peakRaw = data.blocks.length > 0
    ? data.blocks.reduce((best, cur) => (cur.endTime - cur.startTime) > (best.endTime - best.startTime) ? cur : best)
    : null
  const peakBlock = peakRaw ? {
    label: peakRaw.label.current,
    durationSeconds: Math.round((peakRaw.endTime - peakRaw.startTime) / 1000),
    startTime: peakRaw.startTime,
    endTime: peakRaw.endTime,
    category: peakRaw.dominantCategory,
  } : null

  const appMap = new Map<string, { appName: string; durationSeconds: number; category: AppCategory }>()
  for (const s of data.sessions) {
    const entry = appMap.get(s.appName)
    if (entry) entry.durationSeconds += s.durationSeconds
    else appMap.set(s.appName, { appName: s.appName, durationSeconds: s.durationSeconds, category: s.category })
  }
  const topApp = appMap.size > 0
    ? [...appMap.values()].reduce((a, b) => a.durationSeconds > b.durationSeconds ? a : b)
    : null

  const totalSwitches = data.blocks.reduce((sum, b) => sum + b.switchCount, 0)

  const catSec = new Map<AppCategory, number>()
  for (const b of data.blocks) {
    const dur = (b.endTime - b.startTime) / 1000
    catSec.set(b.dominantCategory, (catSec.get(b.dominantCategory) ?? 0) + dur)
  }
  let dominantCategory: AppCategory = 'development'
  let domSec = 0
  for (const [cat, sec] of catSec) {
    if (sec > domSec) { domSec = sec; dominantCategory = cat }
  }
  const totalCatSec = [...catSec.values()].reduce((a, b) => a + b, 0)
  const dominantCategoryPct = totalCatSec > 0 ? Math.round((domSec / totalCatSec) * 100) : 0

  const blocks: WrappedBlock[] = sortedBlocks.map(b => ({
    durationSeconds: Math.round((b.endTime - b.startTime) / 1000),
    startTime: b.startTime,
    endTime: b.endTime,
    category: b.dominantCategory,
  }))

  return {
    totalSeconds: data.totalSeconds,
    focusSeconds: data.focusSeconds,
    focusPct: data.focusPct,
    appCount: data.appCount,
    blockCount: data.blocks.length,
    peakBlock, topApp, totalSwitches,
    dominantCategory, dominantCategoryPct,
    blocks,
    firstActivityTime: sortedBlocks.length > 0 ? sortedBlocks[0].startTime : null,
    dayStartMs: dayFrom,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

function isPastLocalDate(dateStr: string): boolean {
  return dateMs(dateStr) < dateMs(todayString())
}

function dateVariant(dateStr: string, modulo: number): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const current = new Date(y, m - 1, d)
  const yearStart = new Date(y, 0, 1)
  const dayOfYear = Math.floor((current.getTime() - yearStart.getTime()) / 86_400_000)
  return Math.abs((y * 37 + dayOfYear) % modulo)
}

function rotateGradientForDate(theme: SlideTheme, dateStr: string): SlideTheme {
  const angle = 142 + dateVariant(dateStr, 9) * 4
  return {
    ...theme,
    bg: theme.bg.replace(/linear-gradient\(\d+deg/, `linear-gradient(${angle}deg`),
  }
}

function formatDurationShort(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${Math.max(1, m)}m`
}

function firstReadableSentence(text: string | null): string | null {
  if (!text) return null
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  const match = cleaned.match(/^(.{24,170}?[.!?])(\s|$)/)
  const sentence = (match?.[1] ?? cleaned.slice(0, 150)).trim()
  return sentence.length > 8 ? sentence : null
}

function humanComparison(seconds: number): string {
  const h = seconds / 3600
  if (h >= 8) return "That's more than a full workday."
  if (h >= 7) return "More than most people sleep."
  if (h >= 5) return "Longer than most movies, twice over."
  if (h >= 3) return "Longer than most films."
  if (h >= 2) return "More than a lunch break and a commute."
  if (h >= 1) return "A solid hour of focused attention."
  return "A short but intentional stretch."
}

function generateTeaser(d: WrappedData): string {
  const h = Math.floor(d.totalSeconds / 3600)
  if (d.focusPct > 70) {
    return `You found your flow early and stayed there — ${h} hours of mostly clear signal.`
  }
  if (d.totalSwitches > 20) {
    return `A scattered day — ${d.totalSwitches} context switches, but some interesting patterns in the noise.`
  }
  if (d.peakBlock) {
    const start = formatTime(d.peakBlock.startTime)
    const end = formatTime(d.peakBlock.endTime)
    return `Your best stretch ran ${start} to ${end}. The rest of the day tells a different story.`
  }
  return `${h} hours tracked, one dominant pattern. Your full AI breakdown is ready.`
}

// ─── Layout ───────────────────────────────────────────────────────────────────

function SlideLeft({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      alignItems: 'flex-start', padding: '88px 64px 60px',
      pointerEvents: 'none',
    }}>
      {children}
    </div>
  )
}

function SlideCenter({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      alignItems: 'center', textAlign: 'center', padding: '88px 48px 60px',
      pointerEvents: 'none',
    }}>
      {children}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function GlowBar({ pct, accent, glow }: { pct: number; accent: string; glow: string }) {
  const fill = useAnimatedFill(pct)
  return (
    <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.07)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{
        width: `${fill}%`, height: '100%',
        background: `linear-gradient(90deg, ${accent}55, ${accent})`,
        borderRadius: 2,
        boxShadow: `0 0 16px ${glow}`,
        transition: 'width 1.3s cubic-bezier(0.16,1,0.3,1)',
      }} />
    </div>
  )
}

// ─── Slides ───────────────────────────────────────────────────────────────────

function SlideScale({ d, theme }: { d: WrappedData; theme: SlideTheme }) {
  const hours = useCountUp(Math.floor(d.totalSeconds / 3600))
  const mins  = useCountUp(Math.floor((d.totalSeconds % 3600) / 60))
  const pct   = Math.min(100, Math.round((d.totalSeconds / (16 * 3600)) * 100))
  const first = d.firstActivityTime ? formatTime(d.firstActivityTime) : null

  return (
    <SlideLeft>
      <h1 style={{
        fontSize: 108, fontWeight: 900, lineHeight: 1,
        letterSpacing: '-0.035em', color: '#fff',
        margin: 0,
      }}>
        <span style={{ color: theme.accent }}>{hours}h {mins}m</span>
      </h1>
      <p style={{ fontSize: 22, fontWeight: 400, color: 'rgba(255,255,255,0.45)', margin: '8px 0 32px', letterSpacing: '-0.01em' }}>
        tracked today.
      </p>

      <div style={{ width: '100%', marginBottom: 24 }}>
        <GlowBar pct={pct} accent={theme.accent} glow={theme.glow} />
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.28)', marginTop: 8, margin: '6px 0 0', letterSpacing: '0.04em' }}>
          {pct}% of a 16-hour day
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.38)', margin: 0, letterSpacing: '-0.01em' }}>
          <span style={{ color: 'rgba(255,255,255,0.72)', fontWeight: 600 }}>{d.appCount}</span>
          {' '}app{d.appCount !== 1 ? 's' : ''}
          <span style={{ opacity: 0.4 }}> · </span>
          <span style={{ color: 'rgba(255,255,255,0.72)', fontWeight: 600 }}>{d.blockCount}</span>
          {' '}work session{d.blockCount !== 1 ? 's' : ''}
          {first && (
            <>
              <span style={{ opacity: 0.4 }}> · </span>
              first active at{' '}
              <span style={{ color: 'rgba(255,255,255,0.72)', fontWeight: 600 }}>{first}</span>
            </>
          )}
        </p>
      </div>
    </SlideLeft>
  )
}

function SlideFocus({ d, theme }: { d: WrappedData; theme: SlideTheme }) {
  const pct    = useCountUp(d.focusPct)
  const focusH = useCountUp(Math.floor(d.focusSeconds / 3600))
  const focusM = useCountUp(Math.floor((d.focusSeconds % 3600) / 60))
  const noFocus = d.focusSeconds < 60

  const maxDur = Math.max(...d.blocks.map(b => b.durationSeconds), 1)
  const pills  = d.blocks.slice(0, 24)

  return (
    <SlideLeft>
      {noFocus ? (
        <h1 style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
          Mostly<br />exploratory<br />work today.
        </h1>
      ) : (
        <h1 style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
          You were locked in{' '}
          <span style={{ color: theme.accent }}>{pct}%</span>
          <br />of the time.
        </h1>
      )}
      {!noFocus && (
        <p style={{ fontSize: 18, fontWeight: 400, lineHeight: 1.5, color: 'rgba(255,255,255,0.5)', marginTop: 20 }}>
          {focusH > 0 ? `${focusH}h ` : ''}{focusM}m of deep focus.
        </p>
      )}
      {pills.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, marginTop: 32, flexWrap: 'wrap', maxWidth: 380 }}>
          {pills.map((b, i) => {
            const rel = b.durationSeconds / maxDur
            const w   = Math.round(8 + rel * 40)
            return (
              <div key={i} style={{
                width: w, height: 8, borderRadius: 4,
                background: theme.accent,
                opacity: 0.18 + rel * 0.72,
              }} />
            )
          })}
        </div>
      )}
    </SlideLeft>
  )
}

function SlidePeakBlock({ d, theme }: { d: WrappedData; theme: SlideTheme }) {
  const dur = d.peakBlock?.durationSeconds ?? 0
  const h   = useCountUp(Math.floor(dur / 3600))
  const m   = useCountUp(Math.floor((dur % 3600) / 60))

  if (!d.peakBlock) {
    return (
      <SlideLeft>
        <h1 style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
          Keep going.
        </h1>
        <p style={{ fontSize: 18, fontWeight: 400, color: 'rgba(255,255,255,0.5)', marginTop: 20 }}>
          No long work blocks recorded today.
        </p>
      </SlideLeft>
    )
  }

  const { label, startTime, endTime } = d.peakBlock
  const fs = label.length > 22 ? 44 : label.length > 14 ? 56 : 72

  const TL_START = d.dayStartMs + 6 * 3600 * 1000
  const TL_END   = d.dayStartMs + 24 * 3600 * 1000
  const TL_RANGE = TL_END - TL_START

  return (
    <SlideLeft>
      <h1 style={{ fontSize: fs, fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.025em', color: theme.accent, margin: 0 }}>
        {label}
      </h1>
      <p style={{ fontSize: 18, fontWeight: 400, color: 'rgba(255,255,255,0.5)', marginTop: 20 }}>
        <span style={{ color: '#fff', fontWeight: 600 }}>
          {h > 0 ? `${h}h ` : ''}{m}m
        </span>
        {' '}of focused work · {formatTime(startTime)}–{formatTime(endTime)}
      </p>

      <div style={{ width: '100%', marginTop: 36 }}>
        <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
          {d.blocks.map((b, i) => {
            const bLeft  = Math.max(0, ((b.startTime - TL_START) / TL_RANGE) * 100)
            const bWidth = Math.max(0.5, ((b.endTime - b.startTime) / TL_RANGE) * 100)
            return (
              <div key={i} style={{
                position: 'absolute',
                left: `${bLeft}%`, width: `${bWidth}%`,
                top: 0, bottom: 0,
                background: 'rgba(255,255,255,0.15)',
                borderRadius: 2,
              }} />
            )
          })}
          {(() => {
            const left  = Math.max(0, ((startTime - TL_START) / TL_RANGE) * 100)
            const width = Math.max(1, ((endTime - startTime) / TL_RANGE) * 100)
            return (
              <div style={{
                position: 'absolute',
                left: `${left}%`, width: `${width}%`,
                top: 0, bottom: 0,
                background: theme.accent,
                borderRadius: 2,
                boxShadow: `0 0 10px ${theme.glow}`,
              }} />
            )
          })()}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 11, color: 'rgba(255,255,255,0.24)', letterSpacing: '0.04em' }}>
          <span>6 AM</span>
          <span>12 PM</span>
          <span>6 PM</span>
          <span>12 AM</span>
        </div>
      </div>
    </SlideLeft>
  )
}

function SlideTopApp({ d, theme }: { d: WrappedData; theme: SlideTheme }) {
  const totalSec = d.topApp?.durationSeconds ?? 0
  const h = useCountUp(Math.floor(totalSec / 3600))
  const m = useCountUp(Math.floor((totalSec % 3600) / 60))
  const name = d.topApp?.appName ?? '—'
  const fs = name.length > 18 ? 44 : name.length > 12 ? 56 : name.length > 7 ? 72 : 88

  return (
    <SlideLeft>
      <h1 style={{ fontSize: fs, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: theme.accent, margin: 0 }}>
        {name}
      </h1>
      {d.topApp && (
        <>
          <p style={{ fontSize: 18, fontWeight: 400, color: 'rgba(255,255,255,0.5)', marginTop: 20 }}>
            <span style={{ color: '#fff', fontWeight: 600 }}>
              {h > 0 ? `${h}h ` : ''}{m}m
            </span>
            {' '}here today.
          </p>
          <p style={{ fontSize: 16, color: 'rgba(255,255,255,0.35)', marginTop: 10, fontStyle: 'italic' }}>
            {humanComparison(totalSec)}
          </p>
        </>
      )}
    </SlideLeft>
  )
}

function SlideContextSwitching({ d, theme }: { d: WrappedData; theme: SlideTheme }) {
  const switches   = useCountUp(d.totalSwitches)
  const isScattered = d.totalSwitches > 20
  const isBalanced  = d.totalSwitches >= 5 && d.totalSwitches <= 20

  const headline = isScattered
    ? <>You were<br />all over<br />the place.</>
    : isBalanced
      ? <>You balanced<br />focus with<br />flexibility.</>
      : <>You stayed<br />in flow.</>

  const visible = d.blocks.slice(0, 40)
  const extra   = d.blocks.length - visible.length

  return (
    <SlideLeft>
      <h1 style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
        {headline}
      </h1>
      <p style={{ fontSize: 18, fontWeight: 400, color: 'rgba(255,255,255,0.5)', marginTop: 20 }}>
        <span style={{ color: theme.accent, fontWeight: 600 }}>{switches}</span>
        {' '}context switch{d.totalSwitches !== 1 ? 'es' : ''} across{' '}
        {d.blockCount} session{d.blockCount !== 1 ? 's' : ''}.
      </p>
      {visible.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 28, maxWidth: 340 }}>
          {visible.map((b, i) => (
            <div key={i} style={{
              width: 12, height: 12, borderRadius: 3,
              background: CAT_THEME[b.category]?.accent ?? DEFAULT_THEME.accent,
              opacity: 0.82,
            }} />
          ))}
          {extra > 0 && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', alignSelf: 'center', marginLeft: 2 }}>
              +{extra}
            </span>
          )}
        </div>
      )}
    </SlideLeft>
  )
}

function SlideCategoryIdentity({ d, theme, morning = false }: { d: WrappedData; theme: SlideTheme; morning?: boolean }) {
  const pct      = useCountUp(d.dominantCategoryPct, 1100)
  const identity = IDENTITY[d.dominantCategory] ?? 'Maker'
  const catLabel = d.dominantCategory === 'aiTools' ? 'AI tools' : d.dominantCategory
  const fs       = identity.length <= 6 ? 144 : identity.length <= 8 ? 120 : identity.length <= 10 ? 96 : 76

  const GRAIN = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.12'/%3E%3C/svg%3E")`

  return (
    <SlideCenter>
      <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse 72% 60% at 50% 50%, ${theme.glow}, transparent 72%)` }} />
      <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN, backgroundSize: '256px 256px', opacity: 0.06, mixBlendMode: 'overlay' }} />

      <div style={{ position: 'relative', userSelect: 'none' }}>
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: fs * 2.2, fontWeight: 900,
          color: theme.accent, opacity: 0.04,
          letterSpacing: '-0.05em', whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}>
          {identity}
        </div>
        <h1 style={{
          fontSize: fs, fontWeight: 900, lineHeight: 1,
          letterSpacing: '-0.04em', color: theme.accent,
          margin: '0 0 28px', position: 'relative',
          textShadow: `0 0 80px ${theme.glow}`,
          animation: 'wrappedIdentityBounce 600ms cubic-bezier(0.34,1.56,0.64,1) forwards',
        }}>
          {identity}
        </h1>
      </div>

      <p style={{ fontSize: 18, fontWeight: 400, color: 'rgba(255,255,255,0.5)', position: 'relative' }}>
        <span style={{ color: theme.accent, fontWeight: 600 }}>{pct}%</span>
        {morning ? ` of yesterday was ${catLabel}.` : ` of your day was ${catLabel}.`}
      </p>
    </SlideCenter>
  )
}

function SlideCTA({ d, onClose, onOpenReport, hasReport, aiTeaser }: {
  d: WrappedData
  onClose: () => void
  onOpenReport: () => void
  hasReport: boolean
  aiTeaser: string | null
}) {
  const teaser = aiTeaser ?? generateTeaser(d)
  return (
    <SlideLeft>
      <h1 style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
        {hasReport ? <>Your AI report<br />is ready.</> : <>Your day<br />is wrapped.</>}
      </h1>
      {hasReport && (
        <p style={{ fontSize: 17, fontWeight: 400, color: 'rgba(255,255,255,0.45)', marginTop: 22, fontStyle: 'italic', maxWidth: '42ch', lineHeight: 1.6 }}>
          "{teaser}"
        </p>
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 44, pointerEvents: 'all' }}>
        <button
          onClick={(e) => { e.stopPropagation(); onOpenReport() }}
          style={{
            padding: '13px 28px', borderRadius: 10,
            background: '#adc6ff', color: '#001a42',
            fontSize: 15, fontWeight: 700, border: 'none', cursor: 'pointer',
            letterSpacing: '-0.01em',
          }}
        >
          Open Report →
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            padding: '13px 28px', borderRadius: 10,
            background: 'rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.65)',
            fontSize: 15, fontWeight: 500,
            border: '1px solid rgba(255,255,255,0.14)',
            cursor: 'pointer',
          }}
        >
          Dismiss
        </button>
      </div>
    </SlideLeft>
  )
}

function morningLead(d: WrappedData, aiTeaser: string | null): string {
  if (aiTeaser) return aiTeaser
  if (d.focusPct >= 65) return `Yesterday, ${d.focusPct}% of your tracked time stayed focused. That is a clean signal to protect today.`
  if (d.peakBlock && d.peakBlock.durationSeconds >= 45 * 60) {
    return `Your clearest stretch ran ${formatTime(d.peakBlock.startTime)} to ${formatTime(d.peakBlock.endTime)}. That window is worth defending.`
  }
  if (d.totalSeconds >= 5 * 3600) return `You tracked ${formatDurationShort(d.totalSeconds)} yesterday across ${d.blockCount} work session${d.blockCount !== 1 ? 's' : ''}.`
  if (d.topApp) return `${d.topApp.appName} carried the strongest signal yesterday. The full recap has the shape of the day.`
  return 'Yesterday left enough signal for a useful read on what to carry into today.'
}

function morningNudge(d: WrappedData, aiTeaser: string | null): string {
  if (aiTeaser && /today|protect|block|carry|keep/i.test(aiTeaser)) return aiTeaser
  if (d.peakBlock && d.peakBlock.durationSeconds >= 45 * 60) {
    return `You hit flow around ${formatTime(d.peakBlock.startTime)} yesterday. Block that window today.`
  }
  if (d.focusPct >= 60) return 'Yesterday had a clean focus pattern. Give the first quiet hour of today a real boundary.'
  if (d.totalSwitches > 20) return 'Yesterday was switch-heavy. Start today by naming the one thread that gets your best attention.'
  return 'Start with the workstream that would make the rest of the day easier.'
}

function SlideMorningGreeting({
  d,
  userName,
  aiTeaser,
}: {
  d: WrappedData
  userName: string | null
  aiTeaser: string | null
}) {
  const name = userName?.trim()
  return (
    <SlideLeft>
      <h1 style={{
        fontSize: name ? 72 : 68,
        fontWeight: 860,
        lineHeight: 1.02,
        letterSpacing: '-0.03em',
        color: '#fffaf0',
        margin: 0,
        textShadow: '0 14px 48px rgba(0,0,0,0.42)',
      }}>
        {name ? `Good morning, ${name}.` : 'Good morning.'}
      </h1>
      <p style={{
        fontSize: 22,
        fontWeight: 430,
        lineHeight: 1.55,
        color: 'rgba(255,250,240,0.72)',
        margin: '24px 0 0',
        maxWidth: '42ch',
        textShadow: '0 10px 32px rgba(0,0,0,0.5)',
      }}>
        {morningLead(d, aiTeaser)}
      </p>
    </SlideLeft>
  )
}

function SlideMorningNudge({ d, aiTeaser }: { d: WrappedData; aiTeaser: string | null }) {
  return (
    <SlideLeft>
      <p style={{
        fontSize: 38,
        fontWeight: 620,
        lineHeight: 1.22,
        letterSpacing: '-0.018em',
        fontStyle: 'italic',
        color: '#fff7e8',
        margin: 0,
        maxWidth: '18ch',
        textShadow: '0 22px 70px rgba(67,31,5,0.42)',
      }}>
        {morningNudge(d, aiTeaser)}
      </p>
    </SlideLeft>
  )
}

function SlideMorningClose({
  hasReport,
  aiTeaser,
  onClose,
  onOpenReport,
}: {
  hasReport: boolean
  aiTeaser: string | null
  onClose: () => void
  onOpenReport: () => void
}) {
  return (
    <SlideLeft>
      <h1 style={{
        fontSize: 76,
        fontWeight: 840,
        lineHeight: 1.04,
        letterSpacing: '-0.03em',
        color: '#fff8ec',
        margin: 0,
        maxWidth: '11ch',
      }}>
        {hasReport ? 'Your full recap is ready.' : "Yesterday's recap is waiting."}
      </h1>
      {hasReport && aiTeaser && (
        <p style={{ fontSize: 17, fontWeight: 430, color: 'rgba(255,248,236,0.62)', marginTop: 22, fontStyle: 'italic', maxWidth: '42ch', lineHeight: 1.6 }}>
          "{aiTeaser}"
        </p>
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 42, pointerEvents: 'all' }}>
        <button
          onClick={(e) => { e.stopPropagation(); onOpenReport() }}
          style={{
            padding: '13px 28px', borderRadius: 12,
            background: 'linear-gradient(145deg,#1a6fd4 0%,#5ab3ff 100%)',
            color: '#061225',
            fontSize: 15, fontWeight: 760, border: 'none', cursor: 'pointer',
            boxShadow: '0 18px 40px rgba(26,111,212,0.28)',
          }}
        >
          See yesterday →
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            padding: '13px 28px', borderRadius: 12,
            background: 'rgba(255,255,255,0.08)',
            color: 'rgba(255,248,236,0.72)',
            fontSize: 15, fontWeight: 540,
            border: '1px solid rgba(255,255,255,0.16)',
            cursor: 'pointer',
          }}
        >
          Dismiss
        </button>
      </div>
    </SlideLeft>
  )
}

// ─── Week-wrap slides ─────────────────────────────────────────────────────────

interface WeekDay {
  dateStr: string
  dayLabel: string
  totalSeconds: number
  dominantCategory: AppCategory
  longestBlockSec: number
}

interface WeekSummary {
  thisWeek: WeekDay[]
  lastWeek: WeekDay[]
}

function useWeekData(enabled: boolean, anchorDate: string): WeekSummary | null {
  const [summary, setSummary] = useState<WeekSummary | null>(null)

  useEffect(() => {
    if (!enabled) return
    const [y, m, d] = anchorDate.split('-').map(Number)
    const anchorMs = new Date(y, m - 1, d).getTime()
    const dates = Array.from({ length: 14 }, (_, i) =>
      dateStringFromMs(anchorMs - (13 - i) * 86_400_000)
    )

    Promise.all(dates.map(date => ipc.db.getTimelineDay(date).catch(() => null)))
      .then(payloads => {
        const process = (p: DayTimelinePayload | null, dateStr: string): WeekDay => {
          const [py, pm, pd] = dateStr.split('-').map(Number)
          const dayLabel = new Date(py, pm - 1, pd).toLocaleDateString('en-US', { weekday: 'short' })
          if (!p || p.totalSeconds === 0) {
            return { dateStr, dayLabel, totalSeconds: 0, dominantCategory: 'development', longestBlockSec: 0 }
          }
          const longestBlockSec = p.blocks.reduce(
            (mx, b) => Math.max(mx, Math.round((b.endTime - b.startTime) / 1000)), 0
          )
          return {
            dateStr, dayLabel,
            totalSeconds: p.totalSeconds,
            dominantCategory: deriveData(p).dominantCategory,
            longestBlockSec,
          }
        }
        const all = payloads.map((p, i) => process(p, dates[i]))
        setSummary({ thisWeek: all.slice(7), lastWeek: all.slice(0, 7) })
      })
      .catch(() => {})
  }, [enabled, anchorDate])

  return summary
}

function SlideWeekChart({ week, theme }: { week: WeekDay[]; theme: SlideTheme }) {
  const maxSec = Math.max(...week.map(d => d.totalSeconds), 1)

  return (
    <SlideLeft>
      <h1 style={{ fontSize: 56, fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.025em', color: '#fff', margin: '0 0 8px' }}>
        Your week<br />at a glance.
      </h1>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 36, height: 120 }}>
        {week.map((day, i) => {
          const rel   = day.totalSeconds / maxSec
          const barH  = Math.max(4, Math.round(rel * 104))
          const color = CAT_THEME[day.dominantCategory]?.accent ?? DEFAULT_THEME.accent
          const isToday = i === week.length - 1
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1 }}>
              <div style={{
                width: '100%', height: barH, borderRadius: 4,
                background: color,
                opacity: isToday ? 1 : 0.45,
                boxShadow: isToday ? `0 0 14px ${CAT_THEME[day.dominantCategory]?.glow ?? theme.glow}` : 'none',
                transition: `height 0.9s ${i * 0.06}s cubic-bezier(0.16,1,0.3,1)`,
              }} />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em', fontWeight: isToday ? 700 : 400 }}>
                {day.dayLabel}
              </span>
            </div>
          )
        })}
      </div>
    </SlideLeft>
  )
}

function SlidePersonalRecord({ week }: { week: WeekDay[] }) {
  const best = week.reduce((b, d) => d.longestBlockSec > b.longestBlockSec ? d : b, week[0])
  const h    = Math.floor(best.longestBlockSec / 3600)
  const m    = Math.floor((best.longestBlockSec % 3600) / 60)
  const durStr = h > 0 ? `${h}h ${m}m` : `${m}m`
  const today  = week[week.length - 1]
  const isTodayBest = best.dateStr === today.dateStr

  return (
    <SlideLeft>
      <h1 style={{ fontSize: 66, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
        This week's<br />longest stretch.
      </h1>
      <p style={{ fontSize: 56, fontWeight: 900, letterSpacing: '-0.03em', color: '#adc6ff', margin: '20px 0 0' }}>
        {durStr}
      </p>
      <p style={{ fontSize: 17, color: 'rgba(255,255,255,0.45)', marginTop: 12 }}>
        {isTodayBest ? 'That was today.' : `That was ${best.dayLabel}.`}
      </p>
    </SlideLeft>
  )
}

function SlideWeekComparison({ thisWeek, lastWeek, theme }: { thisWeek: WeekDay[]; lastWeek: WeekDay[]; theme: SlideTheme }) {
  const thisTotal = thisWeek.reduce((s, d) => s + d.totalSeconds, 0)
  const lastTotal = lastWeek.reduce((s, d) => s + d.totalSeconds, 0)
  const maxTotal  = Math.max(thisTotal, lastTotal, 1)

  const thisH     = Math.floor(thisTotal / 3600)
  const thisM     = Math.floor((thisTotal % 3600) / 60)
  const lastH     = Math.floor(lastTotal / 3600)
  const lastM     = Math.floor((lastTotal % 3600) / 60)

  const diffPct   = lastTotal > 0 ? Math.round(((thisTotal - lastTotal) / lastTotal) * 100) : 0
  const moreLess  = diffPct >= 0 ? 'more' : 'less'
  const absPct    = Math.abs(diffPct)

  const thisBarPct = useAnimatedFill(Math.round((thisTotal / maxTotal) * 100))
  const lastBarPct = useAnimatedFill(Math.round((lastTotal / maxTotal) * 100), 160)

  return (
    <SlideLeft>
      <h1 style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
        This week<br />vs last.
      </h1>

      <div style={{ width: '100%', marginTop: 36, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {[
          { label: 'This week', pct: thisBarPct, total: `${thisH}h ${thisM}m`, accent: theme.accent },
          { label: 'Last week', pct: lastBarPct, total: `${lastH}h ${lastM}m`, accent: 'rgba(255,255,255,0.25)' },
        ].map(row => (
          <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>
              <span>{row.label}</span>
              <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>{row.total}</span>
            </div>
            <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                width: `${row.pct}%`, height: '100%',
                background: row.accent, borderRadius: 3,
                transition: 'width 1.2s cubic-bezier(0.16,1,0.3,1)',
              }} />
            </div>
          </div>
        ))}
      </div>

      {lastTotal > 0 && (
        <p style={{ fontSize: 16, color: 'rgba(255,255,255,0.4)', marginTop: 20 }}>
          {absPct === 0 ? 'About the same as last week.' : `${absPct}% ${moreLess} than last week.`}
        </p>
      )}
    </SlideLeft>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DayWrapped({
  data,
  threadId,
  onClose,
  onOpenReport,
  userName = null,
}: {
  data: DayTimelinePayload
  threadId: number | null
  artifactId: number | null
  onClose: () => void
  onOpenReport: () => void
  userName?: string | null
}) {
  const d = useMemo(() => deriveData(data), [data])
  const isMorning = useMemo(() => isPastLocalDate(data.date), [data.date])
  const hasReport = threadId != null
  const showMorningNudge = Boolean(d.peakBlock && d.peakBlock.durationSeconds > 45 * 60)
  const morningVideoUrl = useMemo(() => MORNING_VIDEO_URLS[dateVariant(data.date, MORNING_VIDEO_URLS.length)], [data.date])
  const [aiTeaser, setAiTeaser] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setAiTeaser(null)
    if (threadId == null) return () => { cancelled = true }

    void ipc.ai.getThread(threadId)
      .then(({ messages }) => {
        if (cancelled) return
        const assistant = [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim())
        setAiTeaser(firstReadableSentence(assistant?.content ?? null))
      })
      .catch(() => {
        if (!cancelled) setAiTeaser(null)
      })

    return () => { cancelled = true }
  }, [threadId])

  const isExtended = useMemo(() => {
    if (isMorning) return false
    const [y, m, day] = data.date.split('-').map(Number)
    const dataDate    = new Date(y, m - 1, day)
    const isFriday    = dataDate.getDay() === 5
    const lastOfMonth = new Date(y, m, 0).getDate() === day
    return isFriday || lastOfMonth
  }, [data.date, isMorning])

  const weekSummary = useWeekData(!isMorning && isExtended, data.date)

  const SLIDE_COUNT = isMorning ? (showMorningNudge ? 4 : 3) : (isExtended && weekSummary ? 10 : 7)

  const [slideIndex, setSlideIndex] = useState(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')

  const advance = useCallback(() => {
    setDirection('forward')
    setSlideIndex(i => Math.min(i + 1, SLIDE_COUNT - 1))
  }, [SLIDE_COUNT])

  const goBack = useCallback(() => {
    setDirection('back')
    setSlideIndex(i => Math.max(i - 1, 0))
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape')     onClose()
      if (e.key === 'ArrowRight') advance()
      if (e.key === 'ArrowLeft')  goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, goBack, onClose])

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('button')) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (e.clientX - rect.left < rect.width / 2) goBack()
    else advance()
  }

  const baseThemes = useMemo<SlideTheme[]>(() => {
    if (isMorning) {
      return showMorningNudge
        ? [MORNING_THEMES[0], MORNING_THEMES[1], MORNING_THEMES[2], MORNING_THEMES[3]]
        : [MORNING_THEMES[0], MORNING_THEMES[1], MORNING_THEMES[3]]
    }
    const sevenSlideThemes = [
      DEFAULT_THEME,
      FOCUS_THEME,
      d.peakBlock ? catTheme(d.peakBlock.category)    : DEFAULT_THEME,
      d.topApp    ? catTheme(d.topApp.category)        : DEFAULT_THEME,
      d.totalSwitches > 20 ? SCATTERED_THEME           : STEADY_THEME,
      identityCatTheme(d.dominantCategory),
      DEFAULT_THEME,
    ]
    if (isExtended && weekSummary) {
      return [
        ...sevenSlideThemes,
        CAT_THEME.productivity ?? DEFAULT_THEME,
        CAT_THEME.meetings     ?? DEFAULT_THEME,
        DEFAULT_THEME,
      ]
    }
    return sevenSlideThemes
  }, [d, isExtended, isMorning, showMorningNudge, weekSummary])

  const slideThemes = useMemo(
    () => dedupeAdjacentThemes(baseThemes).map((entry) => rotateGradientForDate(entry, data.date)),
    [baseThemes, data.date],
  )

  const theme    = slideThemes[Math.min(slideIndex, slideThemes.length - 1)]
  const animName = direction === 'forward' ? 'wrappedEnterFromRight' : 'wrappedEnterFromLeft'

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: '#000', cursor: 'default',
        animation: 'wrappedOverlayIn 280ms ease forwards',
      }}
      onClick={handleClick}
    >
      <div
        key={slideIndex}
        style={{
          position: 'absolute', inset: 0,
          background: theme.bg,
          animation: `${animName} 380ms cubic-bezier(0.34,1.56,0.64,1) forwards`,
          overflow: 'hidden',
        }}
      >
        {isMorning && slideIndex === 0 && (
          <>
            <video
              key={morningVideoUrl}
              src={morningVideoUrl}
              autoPlay
              muted
              loop
              playsInline
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                filter: 'saturate(1.06) contrast(1.08)',
                opacity: 0.9,
              }}
            />
            <div style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(90deg, rgba(5,8,14,0.78) 0%, rgba(8,12,18,0.5) 42%, rgba(8,12,18,0.22) 100%)',
            }} />
            <div style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 28% 64%, rgba(255,177,89,0.18), transparent 42%)',
              mixBlendMode: 'screen',
            }} />
          </>
        )}
        {isMorning && slideIndex > 0 && (
          <>
            <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 74% 18%, rgba(255,246,218,0.16), transparent 36%)' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 18% 82%, rgba(90,36,8,0.24), transparent 42%)' }} />
            <div style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.11'/%3E%3C/svg%3E")`,
              opacity: 0.1,
              mixBlendMode: 'overlay',
            }} />
          </>
        )}

        {isMorning ? (
          <>
            {slideIndex === 0 && <SlideMorningGreeting d={d} userName={userName} aiTeaser={aiTeaser} />}
            {slideIndex === 1 && <SlideCategoryIdentity d={d} theme={theme} morning />}
            {showMorningNudge && slideIndex === 2 && <SlideMorningNudge d={d} aiTeaser={aiTeaser} />}
            {((showMorningNudge && slideIndex === 3) || (!showMorningNudge && slideIndex === 2)) && (
              <SlideMorningClose hasReport={hasReport} aiTeaser={aiTeaser} onClose={onClose} onOpenReport={onOpenReport} />
            )}
          </>
        ) : (
          <>
            {slideIndex === 0 && <SlideScale d={d} theme={theme} />}
            {slideIndex === 1 && <SlideFocus d={d} theme={theme} />}
            {slideIndex === 2 && <SlidePeakBlock d={d} theme={theme} />}
            {slideIndex === 3 && <SlideTopApp d={d} theme={theme} />}
            {slideIndex === 4 && <SlideContextSwitching d={d} theme={theme} />}
            {slideIndex === 5 && <SlideCategoryIdentity d={d} theme={theme} />}
            {slideIndex === 6 && <SlideCTA d={d} onClose={onClose} onOpenReport={onOpenReport} hasReport={hasReport} aiTeaser={aiTeaser} />}
            {slideIndex === 7 && weekSummary && (
              <SlideWeekChart week={weekSummary.thisWeek} theme={theme} />
            )}
            {slideIndex === 8 && weekSummary && (
              <SlidePersonalRecord week={weekSummary.thisWeek} />
            )}
            {slideIndex === 9 && weekSummary && (
              <SlideWeekComparison thisWeek={weekSummary.thisWeek} lastWeek={weekSummary.lastWeek} theme={theme} />
            )}
          </>
        )}
      </div>

      {/* Progress bar — clears macOS traffic lights */}
      <div style={{
        position: 'absolute', top: 46, left: 16, right: 56,
        display: 'flex', gap: 4, zIndex: 10, pointerEvents: 'none',
      }}>
        {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
          <div key={i} style={{
            flex: 1, height: 3, borderRadius: 2,
            background: i <= slideIndex ? theme.accent : 'rgba(255,255,255,0.16)',
            transition: 'background 300ms ease',
          }} />
        ))}
      </div>

      {/* Close button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{
          position: 'absolute', top: 38, right: 16, zIndex: 10,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.12)',
          border: '1px solid rgba(255,255,255,0.16)',
          color: 'rgba(255,255,255,0.7)',
          fontSize: 18, lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  )
}
