import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { buildTabEvidenceFromFocusEvents } from '../src/main/services/workBlocks.ts'
import { buildDetailRowTree } from '../src/renderer/lib/blockDetailRowTree.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'
import type { ArtifactRef, AppCategory, WorkContextAppSummary, WorkContextBlock } from '../src/shared/types.ts'

// The "Active now" detail panel (BlockDetailInspector in Timeline.tsx) must
// nest a browser's pages under the browser's own app row — a Notion page
// visited inside Dia is a breakdown of Dia's tracked time, never additional
// time on top of it, otherwise app time and site time get double-counted.
// This suite pins the pure nesting logic (buildDetailRowTree) the panel now
// delegates to.

function createDb(): Database.Database {
  return createProductionTestDatabase()
}

function insertTabEvent(
  db: Database.Database,
  o: { tsMs: number; bundleId: string; appName: string; url: string; pageTitle: string },
): void {
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, 'tab_changed', ?, ?, 1, ?, ?, ?, 'apple_events_tab', 'observed', 'darwin', 2)
  `).run(o.tsMs, o.tsMs, o.bundleId, o.appName, o.pageTitle, o.url, o.pageTitle)
}

function makeApp(opts: Partial<WorkContextAppSummary> & { bundleId: string; appName: string; totalSeconds: number }): WorkContextAppSummary {
  return {
    canonicalAppId: null,
    category: 'browsing',
    sessionCount: 1,
    isBrowser: false,
    ...opts,
  }
}

function makeBlock(opts: { topApps: WorkContextAppSummary[]; topArtifacts: ArtifactRef[] }): WorkContextBlock {
  const category: AppCategory = 'browsing'
  return {
    id: 'b:test',
    startTime: 0,
    endTime: 44 * 60 * 1000,
    dominantCategory: category,
    categoryDistribution: { [category]: 2640 },
    ruleBasedLabel: 'Browsing',
    aiLabel: null,
    sessions: [],
    topApps: opts.topApps,
    websites: [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: opts.topArtifacts,
    workflowRefs: [],
    label: {
      current: 'Browsing',
      source: 'rule',
      confidence: 0.8,
      narrative: null,
      ruleBased: 'Browsing',
      aiSuggested: null,
      override: null,
    },
    focusOverlap: { totalSeconds: 2640, pct: 100, sessionIds: [] },
    evidenceSummary: { apps: [], pages: [], documents: [], domains: [] },
    heuristicVersion: 'test',
    computedAt: 0,
    switchCount: 0,
    confidence: 'high',
    review: { ...DEFAULT_TIMELINE_BLOCK_REVIEW, state: 'auto-approved' },
    isLive: true,
  }
}

const DIA_BUNDLE = 'company.thebrowser.browser'
const ELECTRON_BUNDLE = 'com.github.Electron'
// A genuine third-party non-browser app for the nesting/residual assertions —
// Electron itself is now filtered as Daylens self-capture (DEV-272), so it can
// no longer stand in as a generic sibling.
const SLACK_BUNDLE = 'com.tinyspeck.slackmacgap'

test('live-day shape: tab-evidence Notion pages nest under Dia, Slack stays a top-level sibling, nothing orphaned', () => {
  const db = createDb()
  const startMs = 0
  const endMs = 44 * 60 * 1000 // 44 minutes, matching a real reported Dia total

  // Two Notion pages visited inside Dia, captured the way today's live block
  // actually captures them: focus_events tab-change samples, not
  // website_visits (which lags behind real-time tab tracking).
  insertTabEvent(db, { tsMs: startMs, bundleId: DIA_BUNDLE, appName: 'Dia', url: 'https://www.notion.so/Project-Plan', pageTitle: 'Project Plan' })
  insertTabEvent(db, { tsMs: startMs + 20 * 60 * 1000, bundleId: DIA_BUNDLE, appName: 'Dia', url: 'https://www.notion.so/Meeting-Notes', pageTitle: 'Meeting Notes' })

  // Run the REAL producer (now fixed to populate owner linkage) rather than
  // hand-rolling PageRefs, so this test tracks what the engine actually emits.
  const notionPages = buildTabEvidenceFromFocusEvents(db, startMs, endMs)
  assert.equal(notionPages.length, 2, 'both Notion pages should be captured as tab evidence')

  const dia = makeApp({ bundleId: DIA_BUNDLE, appName: 'Dia', totalSeconds: 2640, isBrowser: true })
  const slack = makeApp({ bundleId: SLACK_BUNDLE, appName: 'Slack', totalSeconds: 600, category: 'communication' })
  const block = makeBlock({ topApps: [dia, slack], topArtifacts: notionPages })

  const { evidence } = buildDetailRowTree(block)

  // Exactly two top-level rows: Dia and Slack. The Notion pages must not
  // show up as their own top-level ("orphan") entries.
  assert.equal(evidence.length, 2, `expected exactly Dia + Slack at top level, got: ${evidence.map((r) => r.key).join(', ')}`)

  const diaRow = evidence.find((row) => row.key === `app:${DIA_BUNDLE}`)
  const slackRow = evidence.find((row) => row.key === `app:${SLACK_BUNDLE}`)
  assert.ok(diaRow, 'Dia row must be present')
  assert.ok(slackRow, 'Slack row must be present')

  // The Notion pages are children of Dia (depth 2 nesting), not additive
  // top-level rows.
  assert.equal(diaRow!.children.length, 2, 'both Notion pages should nest under Dia')
  for (const child of diaRow!.children) {
    assert.equal(child.kind, 'artifact')
    assert.equal(child.ownerKey, `app:${DIA_BUNDLE}`)
  }
  const childNames = diaRow!.children.map((c) => c.artifact?.displayTitle).sort()
  assert.deepEqual(childNames, ['Meeting Notes', 'Project Plan'])

  // Slack is a true sibling: no children of its own, and it isn't nested
  // under Dia or anything else.
  assert.equal(slackRow!.children.length, 0, 'Slack has no children of its own')
  assert.equal(slackRow!.ownerKey, undefined, 'app rows are never themselves children')
})

test('sub-minute app rows collapse into a brief tally instead of standing on their own (DEV-272)', () => {
  const editor = makeApp({ bundleId: 'com.editor', appName: 'Editor', totalSeconds: 1800, category: 'development' })
  const blip = makeApp({ bundleId: 'com.blip', appName: 'Blip', totalSeconds: 2, category: 'development' })
  const flash = makeApp({ bundleId: 'com.flash', appName: 'Flash', totalSeconds: 16, category: 'development' })
  const { evidence, briefCount } = buildDetailRowTree(makeBlock({ topApps: [editor, blip, flash], topArtifacts: [] }))
  assert.equal(evidence.length, 1, 'only the substantial app row remains')
  assert.equal(evidence[0].key, 'app:com.editor')
  assert.equal(briefCount, 2, 'the 2s and 16s rows fold into the brief tally')
})

test('Daylens watching itself never appears as evidence — the dev Electron shell is filtered (DEV-272)', () => {
  const dia = makeApp({ bundleId: DIA_BUNDLE, appName: 'Dia', totalSeconds: 2640, isBrowser: true })
  const electron = makeApp({ bundleId: ELECTRON_BUNDLE, appName: 'Electron', totalSeconds: 600, category: 'development' })
  const { evidence } = buildDetailRowTree(makeBlock({ topApps: [dia, electron], topArtifacts: [] }))
  assert.equal(evidence.length, 1, 'only Dia remains; Daylens\'s own Electron shell is not evidence about the user')
  assert.equal(evidence[0].key, `app:${DIA_BUNDLE}`)
})

test('a PageRef carrying only browser-owner fields (no ownerBundleId/canonicalAppId) still nests under its browser', () => {
  // Guards the renderer-side fallback independently of the producer fix
  // above: even if a PageRef somewhere only ever sets browserBundleId/
  // canonicalBrowserId (the PageRef-specific linkage), ownerKeyFor must still
  // find the owning app rather than dropping the row into orphans.
  const dia = makeApp({ bundleId: DIA_BUNDLE, appName: 'Dia', canonicalAppId: 'dia', totalSeconds: 120, isBrowser: true })

  const byBundleId: ArtifactRef = {
    id: 'art:by-bundle',
    artifactType: 'page',
    displayTitle: 'By bundle id',
    totalSeconds: 60,
    confidence: 0.85,
    ownerBundleId: null,
    canonicalAppId: null,
    host: 'example.com',
    openTarget: { kind: 'unsupported', value: null },
    // PageRef-only fields, accessed structurally by buildDetailRowTree.
    ...( { browserBundleId: DIA_BUNDLE, canonicalBrowserId: null } as Record<string, unknown>),
  }
  const byCanonicalId: ArtifactRef = {
    id: 'art:by-canonical',
    artifactType: 'page',
    displayTitle: 'By canonical id',
    totalSeconds: 60,
    confidence: 0.85,
    ownerBundleId: null,
    canonicalAppId: null,
    host: 'example.org',
    openTarget: { kind: 'unsupported', value: null },
    ...( { browserBundleId: null, canonicalBrowserId: 'dia' } as Record<string, unknown>),
  }

  const block = makeBlock({ topApps: [dia], topArtifacts: [byBundleId, byCanonicalId] })
  const { evidence } = buildDetailRowTree(block)

  assert.equal(evidence.length, 1, 'only Dia at top level — neither page should orphan')
  const diaRow = evidence[0]
  assert.equal(diaRow.key, `app:${DIA_BUNDLE}`)
  assert.equal(diaRow.children.length, 2, 'both pages nest under Dia via the browser-field fallback')
})

test('a browser row whose children fall short of its total gets an explicit "No page recorded" residual (invariant 7)', () => {
  // Dia tracked 44 minutes; its only nested page accounts for 10. The other
  // 34 minutes must appear as an explicit residual child — never a silent
  // hole that makes the panel's numbers read as a lie.
  const dia = makeApp({ bundleId: DIA_BUNDLE, appName: 'Dia', canonicalAppId: 'dia', totalSeconds: 2640, isBrowser: true })
  const page: ArtifactRef = {
    id: 'art:short',
    artifactType: 'page',
    displayTitle: 'One page',
    totalSeconds: 600,
    confidence: 0.85,
    ownerBundleId: DIA_BUNDLE,
    canonicalAppId: 'dia',
    host: 'example.com',
    openTarget: { kind: 'unsupported', value: null },
  }

  const block = makeBlock({ topApps: [dia], topArtifacts: [page] })
  const { evidence } = buildDetailRowTree(block)

  const diaRow = evidence.find((row) => row.key === `app:${DIA_BUNDLE}`)
  assert.ok(diaRow)
  assert.equal(diaRow!.children.length, 2, 'the page plus the residual footer')
  const residual = diaRow!.children[diaRow!.children.length - 1]
  assert.equal(residual.kind, 'residual')
  assert.equal(residual.seconds, 2640 - 600)
  const childSum = diaRow!.children.reduce((sum, row) => sum + row.seconds, 0)
  assert.equal(childSum, diaRow!.seconds, 'children must sum exactly to the parent row')

  // A non-browser app never gets a residual, and sub-minute residue is
  // rounding, not a hole.
  const nonBrowser = makeApp({ bundleId: SLACK_BUNDLE, appName: 'Slack', totalSeconds: 2640, category: 'communication' })
  const tight = makeApp({ bundleId: DIA_BUNDLE, appName: 'Dia', canonicalAppId: 'dia', totalSeconds: 630, isBrowser: true })
  const tightBlock = makeBlock({ topApps: [nonBrowser, tight], topArtifacts: [page] })
  const { evidence: tightEvidence } = buildDetailRowTree(tightBlock)
  const tightDia = tightEvidence.find((row) => row.key === `app:${DIA_BUNDLE}`)
  assert.equal(tightDia!.children.filter((row) => row.kind === 'residual').length, 0, '30s residue stays invisible')
  const slackRow = tightEvidence.find((row) => row.key === `app:${SLACK_BUNDLE}`)
  assert.equal(slackRow!.children.length, 0)
})
