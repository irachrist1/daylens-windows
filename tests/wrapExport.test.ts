import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWrapExportModels,
  exportWrapDeck,
  renderWrapSlide,
  saveWrapSlide,
  wrapSlideFilename,
  EXPORT_PANEL_H,
  EXPORT_PANEL_W,
  type WrapExportCanvas,
  type WrapExportCtx,
  type WrapExportDeps,
} from '../src/renderer/components/wrap/wrapExport.ts'
import { planPeriodWrapSlides, periodWrapDeckMeta } from '../src/renderer/lib/wrapDeck.ts'
import type { WrappedPeriodFacts } from '../src/shared/types.ts'

// DEV-248: export follows Spotify Wrapped — every slide is its own shareable
// 1080×1350 PNG. The glued mega-image path is gone. The model builder is pure
// and pinned here with real facts; the canvas layer runs against a recording
// stub, so "export produces one file per slide" is proven without a DOM, and
// the two failure guarantees are pinned: a render failure saves NOTHING (no
// partial share on disk), and a save failure rejects so the deck can say so.

function weekFacts(): WrappedPeriodFacts {
  return {
    period: 'week',
    anchorDate: '2026-06-24',
    rangeLabel: 'Jun 22 – Jun 28',
    totalSeconds: 30 * 3600,
    workSeconds: 25 * 3600,
    leisureSeconds: 5 * 3600,
    personalSeconds: 0,
    previousPeriodSeconds: 26 * 3600,
    daysWithActivity: 6,
    dominantWorkCategory: 'development',
    dominantWorkCategoryPct: 62,
    categories: [
      { category: 'development', seconds: 16 * 3600 },
      { category: 'design', seconds: 5 * 3600 },
      { category: 'meetings', seconds: 2 * 3600 },
    ],
    topApps: [
      { appName: 'Cursor', seconds: 14 * 3600 },
      { appName: 'Figma', seconds: 5 * 3600 },
      { appName: 'Zoom', seconds: 2 * 3600 },
      { appName: 'Notion', seconds: 90 * 60 },
    ],
    threads: [
      { subject: 'The timeline rework', seconds: 12 * 3600, daysActive: 4 },
      { subject: 'The onboarding polish', seconds: 6 * 3600, daysActive: 3 },
    ],
    leisureSurfaces: ['YouTube'],
    busiestDay: { dateStr: '2026-06-23', dayLabel: 'Tuesday', totalSeconds: 8 * 3600 },
    quietestActiveDay: { dateStr: '2026-06-27', dayLabel: 'Saturday', totalSeconds: 2 * 3600 },
    longestStretch: { dateStr: '2026-06-23', dayLabel: 'Tuesday', seconds: 152 * 60, label: 'The timeline rework', startClock: '9:04am' },
    buckets: [
      { label: 'Mon', totalSeconds: 6 * 3600, dominantWorkCategory: 'development' },
      { label: 'Tue', totalSeconds: 8 * 3600, dominantWorkCategory: 'development' },
      { label: 'Wed', totalSeconds: 5 * 3600, dominantWorkCategory: 'development' },
    ],
    busiestBucket: { label: 'Tue', totalSeconds: 8 * 3600 },
    days: [
      { dateStr: '2026-06-22', dayLabel: 'Monday', totalSeconds: 6 * 3600, workSeconds: 5 * 3600, leisureSeconds: 3600 },
      { dateStr: '2026-06-23', dayLabel: 'Tuesday', totalSeconds: 8 * 3600, workSeconds: 7 * 3600, leisureSeconds: 3600 },
      { dateStr: '2026-06-24', dayLabel: 'Wednesday', totalSeconds: 5 * 3600, workSeconds: 4 * 3600, leisureSeconds: 3600 },
    ],
    meetingsSeconds: 2 * 3600,
    dayEdges: [],
  }
}

const NARRATIVE = {
  lines: { opening: 'A week that belonged to the rework.' } as Record<string, string | null>,
  question: 'Which day of this week would you actually want back?',
  reflection: 'Tuesday carried the week. You went into the code early and stayed with it, and the rest of the days orbited that one long stretch. An honest, front-loaded week.',
}

function deckAndMeta() {
  const facts = weekFacts()
  const slides = planPeriodWrapSlides(facts)
  const meta = periodWrapDeckMeta(facts)
  return { facts, slides, meta }
}

// ─── The pure model builder ───────────────────────────────────────────────────

test('export models: one model per slide, in deck order', () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  assert.equal(models.length, slides.length)
  assert.deepEqual(models.map((m) => m.id), slides.map((s) => s.id))
})

test('export models: the opening carries the AI line, the question its question, the finale the headline', () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  assert.equal(models.find((m) => m.id === 'opening')!.line, 'A week that belonged to the rework.')
  assert.equal(models.find((m) => m.id === 'question')!.line, NARRATIVE.question)
  assert.equal(models.find((m) => m.id === 'reflection')!.line, NARRATIVE.reflection)
  const finale = models.find((m) => m.id === 'finale')!
  assert.equal(finale.headline, meta.headline)
})

test('export models: chart slides carry ranked rows with real values', () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const apps = models.find((m) => m.id === 'apps')!
  assert.equal(apps.rows[0].name, 'Cursor')
  assert.equal(apps.rows[0].value, '14h')
  assert.equal(apps.rows[0].pct, 100)
  const split = models.find((m) => m.id === 'split')!
  assert.equal(split.rows.length, 2)
  assert.match(split.rows[0].value, /%$/)
})

test('export models: a missing AI line falls back to the deterministic line, never blank', () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, {}, { question: null, reflection: null }, meta, 7)
  for (const model of models) {
    if (model.id === 'finale') continue
    assert.ok(model.line.trim().length > 0, `panel ${model.id} exported blank`)
  }
})

// ─── Filenames ────────────────────────────────────────────────────────────────

test('filenames: story-ordered, zero-padded, carry the scene id, unique', () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const names = models.map((m, i) => wrapSlideFilename('daylens-week-2026-06-24', i, m))
  assert.equal(names[0], 'daylens-week-2026-06-24-slide-01-opening.png')
  assert.equal(new Set(names).size, names.length, 'filenames must be unique')
  for (const [i, name] of names.entries()) {
    assert.match(name, /-slide-\d{2}-[\w.-]+\.png$/)
    assert.ok(name.includes(models[i].id), `${name} must carry its scene id`)
  }
  // Zero padding keeps lexicographic order equal to story order.
  assert.deepEqual([...names].sort(), names)
})

// ─── The canvas layer, against a recording stub ───────────────────────────────

interface RecordedCanvas extends WrapExportCanvas { texts: string[] }

function stubCanvasDeps(): {
  deps: WrapExportDeps
  created: RecordedCanvas[]
  saved: Array<{ blob: Blob; filename: string }>
  savedAll: Array<{ stem: string; files: Array<{ filename: string; blob: Blob }> }>
} {
  const created: RecordedCanvas[] = []
  const saved: Array<{ blob: Blob; filename: string }> = []
  const savedAll: Array<{ stem: string; files: Array<{ filename: string; blob: Blob }> }> = []
  const deps: WrapExportDeps = {
    createCanvas: (width, height) => {
      const texts: string[] = []
      const ctx: WrapExportCtx = {
        fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: 'left', textBaseline: 'alphabetic',
        fillRect: () => {},
        fillText: (text) => { texts.push(text) },
        measureText: (text) => ({ width: text.length * 18 }),
        beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} }),
      }
      const canvas: RecordedCanvas = { width, height, texts, getContext: () => ctx }
      created.push(canvas)
      return canvas
    },
    toBlob: async (canvas) => new Blob([`png:${canvas.width}x${canvas.height}`], { type: 'image/png' }),
    save: async (blob, filename) => { saved.push({ blob, filename }) },
    saveAll: async (stem, files) => { savedAll.push({ stem, files }); return { canceled: false } },
  }
  return { deps, created, saved, savedAll }
}

test('renderWrapSlide: one slide renders into its own 1080×1350 canvas with its content drawn', async () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const { deps, created } = stubCanvasDeps()
  const blob = await renderWrapSlide(models.find((m) => m.id === 'opening')!, meta.footer, deps)
  assert.ok(blob, 'expected a rendered blob')
  assert.equal(blob!.type, 'image/png')
  assert.equal(created.length, 1)
  assert.equal(created[0].width, EXPORT_PANEL_W)
  assert.equal(created[0].height, EXPORT_PANEL_H, 'a slide is exactly one shareable panel')
  const drawn = created[0].texts.join('\n')
  assert.match(drawn, /DAYLENS/, 'watermark brand missing')
  assert.match(drawn, /week that belonged to the rework/, 'opening line missing')
})

test('exportWrapDeck: one PNG per slide reaches the save-all sink, named in story order', async () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const { deps, created, savedAll } = stubCanvasDeps()
  const outcome = await exportWrapDeck(models, 'daylens-week-2026-06-24', meta.footer, deps)
  assert.deepEqual(outcome, { kind: 'saved', count: models.length })
  assert.equal(created.length, models.length, 'every slide gets its own canvas')
  for (const canvas of created) {
    assert.equal(canvas.width, EXPORT_PANEL_W)
    assert.equal(canvas.height, EXPORT_PANEL_H, 'no glued strip: each canvas is one panel')
  }
  assert.equal(savedAll.length, 1, 'one folder pick, one batch')
  assert.equal(savedAll[0].files.length, models.length)
  assert.equal(savedAll[0].files[0].filename, 'daylens-week-2026-06-24-slide-01-opening.png')
  const drawnEverything = created.map((c) => c.texts.join('\n')).join('\n')
  assert.match(drawnEverything, /Cursor/, 'chart content missing')
  assert.match(drawnEverything, /back\?/, 'question panel missing')
})

test('exportWrapDeck: a 30-slide month deck exports 30 individual files, no canvas-cap risk', async () => {
  // The old glued image blew past the ~32k px browser canvas cap at ~24
  // slides. Per-slide export makes deck size irrelevant: every canvas is
  // 1080×1350 no matter how long the story runs.
  const { slides, meta } = deckAndMeta()
  const base = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const models = Array.from({ length: 30 }, (_, i) => ({ ...base[i % base.length], id: `panel-${i}` }))
  const { deps, created, savedAll } = stubCanvasDeps()
  const outcome = await exportWrapDeck(models, 'daylens-month-2026-06', meta.footer, deps)
  assert.deepEqual(outcome, { kind: 'saved', count: 30 })
  assert.equal(created.length, 30)
  assert.ok(created.every((c) => c.width === EXPORT_PANEL_W && c.height === EXPORT_PANEL_H))
  assert.equal(savedAll[0].files.length, 30)
})

test('saveWrapSlide: a single slide save produces one file with the given name', async () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const { deps, created, saved } = stubCanvasDeps()
  const ok = await saveWrapSlide(models[0], 'daylens-week-opening.png', meta.footer, deps)
  assert.equal(ok, true)
  assert.equal(created.length, 1)
  assert.equal(created[0].height, EXPORT_PANEL_H)
  assert.equal(saved[0].filename, 'daylens-week-opening.png')
  assert.ok(saved[0].blob.size > 0, 'the exported file must not be empty')
})

// ─── Failures are visible, never swallowed, never partial ────────────────────

import { exportButtonLabel, saveSlideButtonLabel, wrapExportFailureDetail } from '../src/renderer/components/wrap/wrapExport.ts'

test('failure: a slide that renders to null aborts the export, saves NOTHING, and names the scene', async () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const { deps, savedAll } = stubCanvasDeps()
  let call = 0
  deps.toBlob = async (canvas) => (++call === 3 ? null : new Blob([`png:${canvas.width}x${canvas.height}`], { type: 'image/png' }))
  const outcome = await exportWrapDeck(models, 'daylens-week', meta.footer, deps)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') {
    assert.equal(outcome.total, models.length)
    assert.equal(outcome.rendered, models.length - 1, 'the outcome reports how many scenes rendered')
    assert.deepEqual(outcome.failedIds, [models[2].id], 'the outcome names the scene that did not render')
  }
  assert.equal(savedAll.length, 0, 'no partial share reaches the sink')
})

test('failure: single-slide null blob reports false and nothing reaches the save sink', async () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const { deps, saved } = stubCanvasDeps()
  deps.toBlob = async () => null
  const ok = await saveWrapSlide(models[0], 'daylens-week-opening.png', meta.footer, deps)
  assert.equal(ok, false, 'a produced-nothing save must report failure')
  assert.equal(saved.length, 0)
})

test('failure: a throwing save-all sink rejects so the caller can surface it', async () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const { deps } = stubCanvasDeps()
  deps.saveAll = async () => { throw new Error('disk full') }
  await assert.rejects(
    () => exportWrapDeck(models, 'daylens-week', meta.footer, deps),
    /disk full/,
    'a failed write must reject, never resolve as success',
  )
})

test('canceled: dismissing the folder picker is a calm no-op outcome, not a failure', async () => {
  const { slides, meta } = deckAndMeta()
  const models = buildWrapExportModels(slides, NARRATIVE.lines, NARRATIVE, meta, 7)
  const { deps } = stubCanvasDeps()
  deps.saveAll = async () => ({ canceled: true })
  const outcome = await exportWrapDeck(models, 'daylens-week', meta.footer, deps)
  assert.deepEqual(outcome, { kind: 'canceled' })
})

test('failure labels: states are said honestly, one calm line, no sorry, no em dash', () => {
  assert.equal(exportButtonLabel({ kind: 'idle' }), 'Export all slides')
  assert.equal(exportButtonLabel({ kind: 'working' }), 'Exporting…')
  assert.equal(exportButtonLabel({ kind: 'done', count: 12 }), 'Saved 12 slides ✓')
  assert.equal(exportButtonLabel({ kind: 'done', count: 1 }), 'Saved 1 slide ✓')
  assert.equal(exportButtonLabel({ kind: 'failed' }), "Export didn't finish. Try again")
  assert.equal(
    exportButtonLabel({ kind: 'failed', rendered: 9, total: 12 }),
    'Only 9 of 12 slides rendered. Nothing was saved. Try again',
    'a render failure reports which scenes rendered',
  )
  assert.equal(
    exportButtonLabel({ kind: 'failed', rendered: 10, total: 12, failedIds: ['shape', 'apps'] }),
    'Only 10 of 12 slides rendered (missing: shape, apps). Nothing was saved. Try again',
    'a render failure names the missing scenes',
  )
  assert.equal(
    exportButtonLabel({ kind: 'failed', detail: 'Writing x.png failed after 2 of 4 slides: disk full' }),
    'Writing x.png failed after 2 of 4 slides: disk full. Try again',
    'a write failure surfaces the real story, not a generic line',
  )
  assert.equal(saveSlideButtonLabel('failed'), "Save didn't finish. Try again")
  assert.equal(saveSlideButtonLabel('saved'), 'Saved ✓')
  assert.equal(saveSlideButtonLabel('idle'), 'Save slide')
  // voice.md errors: never apologize, never spiral. And no em dashes anywhere.
  const allLabels = [
    exportButtonLabel({ kind: 'idle' }), exportButtonLabel({ kind: 'working' }),
    exportButtonLabel({ kind: 'done', count: 3 }), exportButtonLabel({ kind: 'failed' }),
    exportButtonLabel({ kind: 'failed', rendered: 1, total: 2 }),
    saveSlideButtonLabel('idle'), saveSlideButtonLabel('saved'), saveSlideButtonLabel('failed'),
  ]
  for (const label of allLabels) {
    assert.doesNotMatch(label, /sorry|unfortunately|error code/i)
    assert.doesNotMatch(label, /—/, 'no em dashes in product strings')
  }
  assert.notEqual(exportButtonLabel({ kind: 'failed' }), exportButtonLabel({ kind: 'idle' }), 'a failure must be distinguishable from idle')
})

test('wrapExportFailureDetail: strips the Electron invoke machinery so the person reads the message', () => {
  assert.equal(
    wrapExportFailureDetail(new Error("Error invoking remote method 'export:wrap-slides': Error: Writing w-slide-03.png failed after 2 of 4 slides: EDQUOT: quota exceeded")),
    'Writing w-slide-03.png failed after 2 of 4 slides: EDQUOT: quota exceeded',
  )
  assert.equal(wrapExportFailureDetail(new Error('disk full.')), 'disk full')
  assert.equal(wrapExportFailureDetail(new Error('')), null)
  assert.equal(wrapExportFailureDetail(42), null)
  const long = wrapExportFailureDetail(new Error('x'.repeat(500)))
  assert.ok(long && long.length <= 140, 'a runaway message is capped for the button')
})
