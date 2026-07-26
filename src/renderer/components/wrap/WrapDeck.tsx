import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { DayAnalysisVersionSummary, WrappedAskResult } from '@shared/types'
import type { WrapDeckMeta, WrapSlideSpec } from '../../lib/wrapDeck'
import { resolveSlideLine } from '../../lib/wrapDeck'
import { buildWrapExportModels, exportButtonLabel, exportWrapDeck, saveSlideButtonLabel, saveWrapSlide, type WrapExportState, type WrapSlideSaveState } from './wrapExport'
import WrapSlideView from './WrapSlideView'
import { ghostButton, opaqueSlideSurface, pickPalette, prefersReducedMotion, primaryButton, Scene, THEME, type Theme, type WrapPalette } from './wrapKit'

// ─── WrapDeck — the story shell for the deck-era Wrapped ────────────────────────
// Owns everything shared by every wrap: full-bleed frame, per-slide gradient,
// the story progress bar, tap zones, hold/hover/space pause, arrow keys, the
// staged reveals (via WrapSlideView), the inline ask-anything panel, the
// interactive question slide, per-slide save, and the finale with the
// export-everything button. It knows nothing about where the facts came from.

const SCENE_MS = 6800
const REFLECTION_MS = 14_000

export interface WrapDeckNarrativeView {
  lines: Record<string, string | null>
  question: string | null
  reflection: string | null
}

export interface WrapAskInvoke {
  (payload: { slideId: string; slideLine: string | null; question: string; replyingTo: string | null }): Promise<WrappedAskResult>
}

interface AskEntry { question: string; answer: string | null; error: string | null; pending: boolean }

const PALETTE_ORDER: Array<keyof WrapPalette> = ['cover', 'headline', 'did', 'shape', 'standout', 'thread', 'rest', 'finale']

function themeFor(palette: WrapPalette, spec: WrapSlideSpec, index: number): Theme {
  if (spec.kind === 'finale') return palette.finale
  if (spec.kind === 'opening') return palette.cover
  if (spec.kind === 'reflection') return palette.rest
  return palette[PALETTE_ORDER[index % (PALETTE_ORDER.length - 1)]]
}

export default function WrapDeck({
  slides, meta, narrative, seed, exportStem, generatedLabel, onRegenerate, onClose, ask, finaleExtra, history,
}: {
  slides: WrapSlideSpec[]
  meta: WrapDeckMeta
  narrative: WrapDeckNarrativeView
  seed: number
  /** Filename stem for exports ("daylens-<date>" / "daylens-week-..."). */
  exportStem: string
  /** "generated 2h ago" marker + Regenerate on the finale, when persisted. */
  generatedLabel?: string | null
  onRegenerate?: () => void
  onClose: () => void
  /** Runs the in-context AI ask. Injected so the deck stays IPC-free. */
  ask: WrapAskInvoke
  /** One extra finale button, e.g. "Open timeline". */
  finaleExtra?: { label: string; onClick: () => void }
  /** DEV-206: this wrap's analysis versions, newest first. When present, the
   *  finale shows "analysis v<N>" with an expandable history — what each
   *  version was, when it was written, and why it replaced the previous one. */
  history?: DayAnalysisVersionSummary[] | null
}) {
  const reduced = prefersReducedMotion()
  const palette = useMemo(() => pickPalette(seed), [seed])
  const sceneCount = Math.max(1, slides.length)
  const [slideIndex, setSlideIndex] = useState(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [hovering, setHovering] = useState(false)
  const [holding, setHolding] = useState(false)

  // Ask-anything: one small conversation per slide id, kept while the wrap is open.
  const [askOpenFor, setAskOpenFor] = useState<string | null>(null)
  const [askThreads, setAskThreads] = useState<Record<string, AskEntry[]>>({})

  const active = slides[Math.min(slideIndex, sceneCount - 1)]
  const isLast = slideIndex >= sceneCount - 1
  const isQuestionSlide = active?.kind === 'question'
  const askOpen = askOpenFor === active?.id || isQuestionSlide
  const paused = hovering || holding || askOpen

  useEffect(() => { setSlideIndex(0) }, [sceneCount])
  useEffect(() => { setAskOpenFor(null) }, [slideIndex])

  const advance = useCallback(() => { setDirection('forward'); setSlideIndex((i) => Math.min(i + 1, sceneCount - 1)) }, [sceneCount])
  const goBack = useCallback(() => { setDirection('back'); setSlideIndex((i) => Math.max(i - 1, 0)) }, [])
  const restart = useCallback(() => { setDirection('back'); setSlideIndex(0) }, [])

  // Auto-advance with a pausable progress fill (rAF, resumes where it left off).
  // The question slide never auto-advances — it is a conversation, not a beat.
  const progressElRef = useRef<HTMLDivElement | null>(null)
  const elapsedRef = useRef(0)
  const sceneMs = active?.kind === 'reflection' ? REFLECTION_MS : SCENE_MS
  useEffect(() => { elapsedRef.current = 0; if (progressElRef.current) progressElRef.current.style.width = reduced ? '100%' : '0%' }, [slideIndex, reduced])
  useEffect(() => {
    if (reduced) return // calm: no auto-advance — page at your pace
    if (isLast || isQuestionSlide) { if (progressElRef.current && isLast) progressElRef.current.style.width = '100%'; return }
    if (paused) return
    let raf = 0, startNow = 0, lastNow = 0, cancelled = false
    function frame(now: number) {
      if (cancelled) return
      if (!startNow) { startNow = now; lastNow = now }
      lastNow = now
      const p = Math.min((elapsedRef.current + (now - startNow)) / sceneMs, 1)
      if (progressElRef.current) progressElRef.current.style.width = `${p * 100}%`
      if (p >= 1) { elapsedRef.current = sceneMs; advance(); return }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelled = true; if (raf) cancelAnimationFrame(raf); if (startNow) elapsedRef.current += (lastNow - startNow) }
  }, [slideIndex, paused, isLast, isQuestionSlide, advance, reduced, sceneMs])

  // Keyboard. Typing in the ask input must never page the deck.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      if (e.key === 'Escape') { if (typing) (target as HTMLInputElement).blur(); else onClose(); return }
      if (typing) return
      if (e.key === 'ArrowRight') advance()
      else if (e.key === 'ArrowLeft') goBack()
      else if (e.key === ' ') { e.preventDefault(); setHolding((h) => !h) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, goBack, onClose])

  // Press-and-hold to pause (touch); a quick tap is a tap-zone nav.
  const holdTimer = useRef<number | null>(null)
  const didHold = useRef(false)
  function onPointerDown() {
    didHold.current = false
    holdTimer.current = window.setTimeout(() => { didHold.current = true; setHolding(true) }, 220)
  }
  function endHold() {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
    setHolding(false)
  }
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement
    if (el.closest('button') || el.closest('input') || el.closest('textarea') || el.closest('[data-wrap-ask]')) return
    if (didHold.current) { didHold.current = false; return }
    const rect = e.currentTarget.getBoundingClientRect()
    if (e.clientX - rect.left < rect.width * 0.32) goBack()
    else advance()
  }

  const theme = active ? themeFor(palette, active, slideIndex) : THEME.rest
  const animName = direction === 'forward' ? 'wrappedEnterFromRight' : 'wrappedEnterFromLeft'

  // Export models — one pure build for per-slide saves and the full export.
  const exportModels = useMemo(
    () => buildWrapExportModels(slides, narrative.lines, { question: narrative.question, reflection: narrative.reflection }, meta, seed),
    [slides, narrative, meta, seed],
  )
  // A failed export is SAID, not swallowed: the old code mapped a false/thrown
  // save back to the idle label, so a null toBlob looked like nothing happened.
  // Failure is now a visible state with an honest label (voice.md errors: one
  // calm line, no sorry). DEV-248: the finale exports one PNG PER SLIDE through
  // a single folder pick; the glued mega-image path is gone.
  const [saveState, setSaveState] = useState<WrapSlideSaveState>('idle')
  const [exportState, setExportState] = useState<WrapExportState>({ kind: 'idle' })
  useEffect(() => { setSaveState('idle') }, [slideIndex])
  const saveSlide = useCallback(() => {
    const model = exportModels[slideIndex]
    if (!model) return
    void saveWrapSlide(model, `${exportStem}-${model.id}.png`, meta.footer)
      .then((ok) => setSaveState(ok ? 'saved' : 'failed'))
      .catch(() => setSaveState('failed'))
  }, [exportModels, slideIndex, exportStem, meta.footer])
  const exportAll = useCallback(() => {
    setExportState({ kind: 'working' })
    void exportWrapDeck(exportModels, exportStem, meta.footer)
      .then((outcome) => {
        if (outcome.kind === 'saved') setExportState({ kind: 'done', count: outcome.count })
        else if (outcome.kind === 'canceled') setExportState({ kind: 'idle' })
        else setExportState({ kind: 'failed', rendered: outcome.rendered, total: outcome.total })
      })
      .catch(() => setExportState({ kind: 'failed' }))
  }, [exportModels, exportStem, meta.footer])

  // The in-context ask.
  const askThread = active ? (askThreads[active.id] ?? []) : []
  const submitAsk = useCallback((text: string) => {
    if (!active) return
    const question = text.trim()
    if (!question) return
    const slideId = active.id
    const slideLine = active.kind === 'question'
      ? (narrative.question ?? active.fallbackLine)
      : resolveSlideLine(active, narrative.lines)
    const replyingTo = active.kind === 'question' ? (narrative.question ?? active.fallbackLine) : null
    setAskThreads((prev) => ({ ...prev, [slideId]: [...(prev[slideId] ?? []), { question, answer: null, error: null, pending: true }] }))
    void ask({ slideId, slideLine, question, replyingTo })
      .catch((error: unknown) => ({ answer: null, error: error instanceof Error ? error.message : 'The question failed.' }))
      .then((result) => {
        setAskThreads((prev) => {
          const entries = [...(prev[slideId] ?? [])]
          const last = entries[entries.length - 1]
          if (last?.pending) entries[entries.length - 1] = { ...last, answer: result.answer, error: result.error, pending: false }
          return { ...prev, [slideId]: entries }
        })
      })
  }, [active, ask, narrative])

  const body = active
    ? active.kind === 'finale'
      ? (
        <FinaleSlide
          meta={meta} theme={theme} slides={slides} narrative={narrative}
          exportState={exportState} onExport={exportAll}
          generatedLabel={generatedLabel} onRegenerate={onRegenerate}
          onRestart={restart} onClose={onClose} finaleExtra={finaleExtra}
          history={history}
        />
      )
      : (
        <WrapSlideView
          spec={active}
          line={resolveSlideLine(active, narrative.lines)}
          question={narrative.question}
          reflection={narrative.reflection}
          theme={theme}
          reduced={reduced}
        />
      )
    : null

  return (
    // The DEV-248 bleed-through fix: the root is opaque black with NO opacity
    // animation on it. The shipped bug put a `forwards`-fill fade on this root;
    // when the animation stalled the whole overlay stayed translucent, the
    // timeline showed through every layer, and "Save slide" landed visually on
    // the sidebar's Settings button. Entrance motion now runs only on the
    // slide layer below, which itself paints an opaque backstop under its
    // gradient (opaqueSlideSurface) — a stalled animation shows black, never
    // the app.
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000', cursor: 'default' }}
      onClick={onClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => { setHovering(false); endHold() }}
      onPointerDown={onPointerDown}
      onPointerUp={endHold}
    >
      <div
        key={slideIndex}
        style={{ position: 'absolute', inset: 0, ...opaqueSlideSurface(theme), animation: reduced ? 'wrappedOverlayIn 200ms ease' : `${animName} 460ms cubic-bezier(0.34,1.4,0.64,1)`, overflow: 'hidden' }}
      >
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse 75% 60% at 50% 40%, ${theme.glow}, transparent 72%)` }} />
        {/* When the ask panel is open, cede the bottom of the frame to it so the
            conversation never sits on top of the slide's own text. */}
        <div style={{ position: 'absolute', inset: 0, paddingBottom: askOpen && active?.kind !== 'finale' ? 'min(42vh, 400px)' : 0, transition: 'padding-bottom 260ms ease' }}>
          {body}
        </div>
      </div>

      {/* Story progress bar */}
      <div style={{ position: 'absolute', top: 18, left: 16, right: onRegenerate ? 106 : 56, display: 'flex', gap: 4, zIndex: 10, pointerEvents: 'none' }}>
        {Array.from({ length: sceneCount }).map((_, i) => (
          <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.18)', overflow: 'hidden' }}>
            <div
              ref={i === slideIndex ? progressElRef : undefined}
              style={{ height: '100%', borderRadius: 2, background: theme.accent, width: i < slideIndex ? '100%' : '0%' }}
            />
          </div>
        ))}
      </div>

      {/* Regenerate — reachable from ANY slide, not just the finale, so a stale
          wrap (old copy, pre-fix narrative) never traps you into paging through
          the whole deck first. Always forces a fresh AI call, even on a wrap
          that was already generated. Hidden on the finale, which has its own. */}
      {onRegenerate && active?.kind !== 'finale' && (
        <button
          onClick={(e) => { e.stopPropagation(); onRegenerate() }}
          style={{ position: 'absolute', top: 30, right: 64, zIndex: 10, width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.7)', fontSize: 17, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          aria-label="Regenerate this wrap with a new AI call"
          title="Regenerate"
        >↻</button>
      )}

      {/* Close */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{ position: 'absolute', top: 30, right: 16, zIndex: 10, width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.7)', fontSize: 18, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        aria-label="Close"
      >×</button>

      {/* Bottom bar: save · ask · next. flexWrap so the long save-failed label
          wraps to a second row at narrow widths instead of pushing buttons
          into each other or off-screen. */}
      {active && active.kind !== 'finale' && (
        <div style={{ position: 'absolute', bottom: 26, left: 22, right: 22, zIndex: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={(e) => { e.stopPropagation(); saveSlide() }} style={pillButton} aria-label="Save this slide as an image">
            {saveSlideButtonLabel(saveState)}
          </button>
          {!isQuestionSlide && (
            <button
              onClick={(e) => { e.stopPropagation(); setAskOpenFor(askOpen ? null : active.id) }}
              style={{ ...pillButton, marginLeft: 'auto', marginRight: 'auto' }}
              aria-label="Ask about this slide"
            >{askOpen ? 'Close' : 'Ask about this'}</button>
          )}
          {!isLast && (
            <button onClick={(e) => { e.stopPropagation(); advance() }} style={{ ...pillButton, marginLeft: isQuestionSlide ? 'auto' : 0 }} aria-label="Next">
              Next ›
            </button>
          )}
        </div>
      )}

      {/* Ask panel — inline conversation on the current slide */}
      {active && askOpen && active.kind !== 'finale' && (
        <AskPanel
          key={active.id}
          entries={askThread}
          placeholder={isQuestionSlide ? 'Your answer…' : 'Ask about this…'}
          accent={theme.accent}
          onSubmit={submitAsk}
        />
      )}
    </div>
  )
}

const pillButton: CSSProperties = {
  padding: '10px 16px', borderRadius: 999, background: 'rgba(255,255,255,0.1)',
  border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.85)',
  fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
}

// ─── Ask panel ──────────────────────────────────────────────────────────────────

function AskPanel({ entries, placeholder, accent, onSubmit }: {
  entries: AskEntry[]
  placeholder: string
  accent: string
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries])
  const pending = entries.some((e) => e.pending)

  function send() {
    const t = text.trim()
    if (!t || pending) return
    setText('')
    onSubmit(t)
  }

  return (
    <div
      data-wrap-ask
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', bottom: 82, left: '50%', transform: 'translateX(-50%)',
        width: 'min(520px, calc(100vw - 44px))', zIndex: 11,
        background: 'rgba(10,12,20,0.86)', backdropFilter: 'blur(14px)',
        border: '1px solid rgba(255,255,255,0.14)', borderRadius: 18, padding: 14,
        animation: 'wrappedRevealUp 320ms ease both',
      }}
    >
      {entries.length > 0 && (
        <div ref={scrollRef} style={{ maxHeight: '32vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12, paddingRight: 4 }}>
          {entries.map((entry, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'rgba(255,255,255,0.12)', borderRadius: '12px 12px 4px 12px', padding: '8px 12px', fontSize: 14, color: '#fff' }}>
                {entry.question}
              </div>
              <div style={{ alignSelf: 'flex-start', maxWidth: '90%', fontSize: 14, lineHeight: 1.5, color: entry.error ? 'rgba(255,160,160,0.9)' : 'rgba(255,255,255,0.88)' }}>
                {entry.pending ? <ThinkingDots accent={accent} /> : (entry.answer ?? entry.error ?? '')}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
          placeholder={placeholder}
          style={{
            flex: 1, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 10, padding: '10px 12px', fontSize: 14, color: '#fff', outline: 'none',
          }}
        />
        <button onClick={send} disabled={pending || !text.trim()} style={{ ...primaryButton(accent), padding: '10px 16px', opacity: pending || !text.trim() ? 0.5 : 1 }}>
          {pending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

function ThinkingDots({ accent }: { accent: string }) {
  return (
    <span aria-label="Thinking" style={{ display: 'inline-flex', gap: 5, padding: '6px 2px' }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%', background: accent,
          animation: 'wrappedBreath 1.1s ease-in-out infinite', animationDelay: `${i * 180}ms`,
        }} />
      ))}
    </span>
  )
}

// ─── Finale ─────────────────────────────────────────────────────────────────────

function FinaleSlide({ meta, theme, slides, narrative, exportState, onExport, generatedLabel, onRegenerate, onRestart, onClose, finaleExtra, history }: {
  meta: WrapDeckMeta
  theme: Theme
  slides: WrapSlideSpec[]
  narrative: WrapDeckNarrativeView
  exportState: WrapExportState
  onExport: () => void
  generatedLabel?: string | null
  onRegenerate?: () => void
  onRestart: () => void
  onClose: () => void
  finaleExtra?: { label: string; onClick: () => void }
  history?: DayAnalysisVersionSummary[] | null
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const currentVersion = history?.[0]?.version ?? null
  // The card shows the deck's own biggest stat slides, top three.
  const statRows = slides
    .filter((s) => s.kind === 'stat' && s.stat?.sublabel && s.stat.seconds != null)
    .slice(0, 3)
  return (
    <Scene>
      <div style={cardSurface}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.18em', color: theme.accent }}>DAYLENS</span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.55)' }}>{meta.rangeLabel}</span>
        </div>
        <div style={{ fontSize: 54, fontWeight: 900, letterSpacing: '-0.045em', color: '#fff', lineHeight: 1 }}>{meta.headline}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 22 }}>
          {statRows.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', gap: 11 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.stat!.sublabel}</span>
              <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>{s.stat!.value}</span>
            </div>
          ))}
        </div>
        {narrative.reflection && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.12)', fontSize: 13.5, lineHeight: 1.55, color: 'rgba(255,255,255,0.78)' }}>
            {narrative.reflection}
          </div>
        )}
      </div>

      {generatedLabel && (
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 16, pointerEvents: 'all' }}>
          generated {generatedLabel}
          {currentVersion != null && currentVersion > 0 && (
            <> · <button onClick={(e) => { e.stopPropagation(); setHistoryOpen((open) => !open) }} style={linkButton}>
              analysis v{currentVersion}
            </button></>
          )}
          {onRegenerate && (
            <> · <button onClick={(e) => { e.stopPropagation(); onRegenerate() }} style={linkButton}>Regenerate</button></>
          )}
        </p>
      )}

      {historyOpen && history && history.length > 0 && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            marginTop: 10, maxWidth: 'min(440px, 84vw)', maxHeight: 180, overflowY: 'auto',
            borderRadius: 12, padding: '12px 16px', pointerEvents: 'all', textAlign: 'left',
            background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          {history.map((entry) => (
            <div key={`${entry.kind}:${entry.version}`} style={{ padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
                v{entry.version} · {historyWhen(entry.createdAt)} · {historyReason(entry.reason)}
                {entry.retiredReason ? ` · retired by ${historyRetirement(entry.retiredReason)}` : ''}
              </div>
              {entry.lead && (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.lead}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={finaleActions}>
        <button onClick={(e) => { e.stopPropagation(); onExport() }} style={primaryButton(theme.accent)} aria-label="Save every slide as its own image">
          {exportButtonLabel(exportState)}
        </button>
        {finaleExtra && (
          <button onClick={(e) => { e.stopPropagation(); finaleExtra.onClick() }} style={ghostButton}>{finaleExtra.label}</button>
        )}
        <button onClick={(e) => { e.stopPropagation(); onRestart() }} style={ghostButton} aria-label="Replay">↺</button>
        <button onClick={(e) => { e.stopPropagation(); onClose() }} style={ghostButton}>Done</button>
      </div>
    </Scene>
  )
}

export const cardSurface: CSSProperties = {
  width: 'min(440px, 84vw)', borderRadius: 22, padding: '30px 30px 26px',
  background: 'linear-gradient(165deg, rgba(255,255,255,0.09), rgba(255,255,255,0.03))',
  border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 30px 70px rgba(0,0,0,0.5)',
  textAlign: 'left', pointerEvents: 'none',
}
export const finaleActions: CSSProperties = { display: 'flex', gap: 12, marginTop: 28, pointerEvents: 'all', flexWrap: 'wrap', justifyContent: 'center' }
const linkButton: CSSProperties = { background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12, padding: 0 }

// ─── Analysis version history (DEV-206) ─────────────────────────────────────
// Plain words for why a version exists — never a raw enum, never a model name
// in product copy (the model rides the stored row for inspection, not the UI).

function historyReason(reason: DayAnalysisVersionSummary['reason']): string {
  switch (reason) {
    case 'initial': return 'first analysis'
    case 'facts-changed': return "written from the day's newer facts"
    case 'correction': return 'rewritten after your correction'
    case 'deletion': return 'rewritten after a deletion'
    case 'evidence-change': return 'rewritten after the evidence changed'
    case 'manual-regenerate': return 'you asked for a regenerate'
    case 'regenerated': return 'regenerated'
    default: return reason
  }
}

function historyRetirement(reason: NonNullable<DayAnalysisVersionSummary['retiredReason']>): string {
  switch (reason) {
    case 'correction': return 'a correction'
    case 'deletion': return 'a deletion'
    case 'evidence-change': return 'an evidence change'
    case 'superseded': return 'a newer version'
    default: return reason
  }
}

function historyWhen(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
