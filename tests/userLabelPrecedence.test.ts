// WO-102 / REQ-VIC-004. A person's own wording for their own work outranks
// anything Daylens infers, is never corrected by the activity-description
// policy, and never becomes evidence for anything else.
//
// Every fixture is invented activity: an invented client (Ridgeline), an
// invented artifact, invented titles. Nothing here comes from a tracked day.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDaySummaryScaffold } from '../src/main/jobs/aiService.ts'
import { userVisibleLabelForBlock } from '../src/main/services/workBlocks.ts'
import { userVisibleBlockLabel } from '../src/shared/blockLabel.ts'
import { labelCandidateViolation, labelProvenance, userAuthoredLabel } from '../src/shared/labelVoice.ts'
import type { AppCategory, DayTimelinePayload, WorkContextBlock } from '../src/shared/types.ts'
import { DEFAULT_TIMELINE_BLOCK_REVIEW } from '../src/shared/timelineReview.ts'

const DAY = '2026-06-22'
const base = new Date('2026-06-22T09:00:00').getTime()

// A label that violates several invariants of the policy at once: a raw URL, a
// judgment word, and browser-tab soup. Daylens must never produce this. A
// person is entitled to write it about their own day.
const UNRULY_USER_LABEL = 'wasted 2h on https://ridgeline.example.dev | tabs | more tabs'

function makeBlock(opts: {
  label: string
  source?: WorkContextBlock['label']['source']
  override?: string | null
  aiLabel?: string | null
  category?: AppCategory
  artifactTitle?: string
}): WorkContextBlock {
  const durationSeconds = 3600
  return {
    id: `b:${opts.label}`,
    startTime: base,
    endTime: base + durationSeconds * 1000,
    kind: 'work',
    dominantCategory: opts.category ?? 'development',
    categoryDistribution: { [opts.category ?? 'development']: durationSeconds },
    ruleBasedLabel: opts.label,
    aiLabel: opts.aiLabel ?? null,
    sessions: [],
    topApps: [
      { appName: 'Cursor', bundleId: 'Cursor', totalSeconds: durationSeconds, category: 'development', isBrowser: false, sessionCount: 1 },
    ],
    websites: [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: (opts.artifactTitle
      ? [{ displayTitle: opts.artifactTitle, artifactType: 'file' }]
      : []) as WorkContextBlock['topArtifacts'],
    workflowRefs: [],
    label: {
      current: opts.label,
      source: opts.source ?? 'rule',
      confidence: 0.9,
      narrative: null,
      ruleBased: opts.label,
      aiSuggested: null,
      override: opts.override ?? null,
    },
    focusOverlap: { totalSeconds: durationSeconds, pct: 100, sessionIds: [] },
    evidenceSummary: { apps: [], pages: [], documents: [], domains: [] },
    heuristicVersion: 'test',
    computedAt: base,
    switchCount: 2,
    confidence: 'high',
    review: { ...DEFAULT_TIMELINE_BLOCK_REVIEW, state: 'auto-approved' },
    isLive: false,
  }
}

function makePayload(blocks: WorkContextBlock[]): DayTimelinePayload {
  const totalSeconds = blocks.reduce((sum, block) => sum + Math.round((block.endTime - block.startTime) / 1000), 0)
  return {
    date: DAY,
    sessions: [],
    websites: [],
    blocks,
    segments: [],
    focusSessions: [],
    computedAt: Date.now(),
    version: 'test',
    totalSeconds,
    focusSeconds: totalSeconds,
    focusPct: 100,
    appCount: 1,
    siteCount: 0,
  }
}

// ── AC-VIC-004.1: verbatim, never policy-corrected ─────────────────────────

test('AC-VIC-004.1: a user label that breaks every policy rule survives byte for byte', () => {
  const block = makeBlock({ label: 'Reworking the sync engine', override: UNRULY_USER_LABEL })
  assert.equal(userVisibleBlockLabel(block), UNRULY_USER_LABEL)
  assert.equal(userVisibleLabelForBlock(block), UNRULY_USER_LABEL)
  assert.equal(userAuthoredLabel(block), UNRULY_USER_LABEL)
})

test('userVisibleLabelForBlock keeps a stored override without a separate argument', () => {
  // Finalize stores the chosen name on both `current` and `override`. Context
  // and moment-evidence callers omit the extra argument; the override must
  // still beat a passing inferred / AI label that the work-name guard would
  // otherwise substitute.
  const block = makeBlock({
    label: 'Cursor Agents',
    source: 'user',
    override: 'Cursor Agents',
    aiLabel: 'daylens timeline',
    artifactTitle: 'daylens timeline',
  })
  assert.equal(userVisibleLabelForBlock(block), 'Cursor Agents')
  assert.equal(userVisibleLabelForBlock(block, null), 'Cursor Agents')
  assert.equal(userVisibleLabelForBlock(block, undefined), 'Cursor Agents')
})

test('userVisibleLabelForBlock prefers label.override over a passing inferred current', () => {
  const block = makeBlock({
    label: 'daylens timeline',
    source: 'rule',
    override: 'Cursor Agents',
    aiLabel: 'daylens timeline',
  })
  assert.equal(userAuthoredLabel(block), 'Cursor Agents')
  assert.equal(userVisibleLabelForBlock(block), 'Cursor Agents')
})

test('AC-VIC-004.1: the same string is rejected when it arrives as a model candidate', () => {
  // The policy is bypassed for one provenance, not weakened. If this ever
  // returns null, the label gate has stopped working.
  assert.ok(labelCandidateViolation(UNRULY_USER_LABEL, { appNames: ['Cursor'] }))
})

test('AC-VIC-004.1: a corrected review is user-authored too, not only an override row', () => {
  // Both user paths set the wording; the review path marks it with source.
  const corrected = makeBlock({ label: UNRULY_USER_LABEL, source: 'user', override: null })
  assert.equal(userAuthoredLabel(corrected), UNRULY_USER_LABEL)
  assert.equal(labelProvenance(corrected), 'user')
})

test('a block with no user input reports evidence provenance', () => {
  const block = makeBlock({ label: 'Reworking the sync engine' })
  assert.equal(userAuthoredLabel(block), null)
  assert.equal(labelProvenance(block), 'evidence')
})

// ── AC-VIC-004.2: the prompt gets the label the screen shows ───────────────

test('AC-VIC-004.2: the recap scaffold carries the user label, not the stored one', () => {
  const block = makeBlock({ label: 'Development', override: 'Ridgeline renewal' })
  const scaffold = JSON.parse(buildDaySummaryScaffold(makePayload([block])))
  assert.equal(scaffold.blocks[0].label, 'Ridgeline renewal')
})

test('AC-VIC-004.2 / D1: a generic floor label never reaches the recap prompt', () => {
  // "Development" is a generic floor: the Timeline resolves past it to the AI
  // label. A recap told "Development" describes a day the person cannot see.
  const block = makeBlock({
    label: 'Development',
    aiLabel: 'Reworking the sync engine',
    artifactTitle: 'scheduler notes',
  })
  assert.equal(userVisibleBlockLabel(block), 'Reworking the sync engine')
  const scaffold = JSON.parse(buildDaySummaryScaffold(makePayload([block])))
  assert.equal(scaffold.blocks[0].label, 'Reworking the sync engine')
  assert.notEqual(scaffold.blocks[0].label, 'Development')
})

// ── AC-VIC-004.3: their words travel marked as theirs ──────────────────────

test('AC-VIC-004.3: a user-authored block is marked as their own words', () => {
  const block = makeBlock({ label: 'Development', override: 'Ridgeline renewal' })
  const scaffold = JSON.parse(buildDaySummaryScaffold(makePayload([block])))
  assert.equal(scaffold.blocks[0].labelIsTheirOwnWords, true)
})

test('AC-VIC-004.3: an evidence-derived block carries no marker, so the marker means something', () => {
  const block = makeBlock({ label: 'Reworking the sync engine' })
  const scaffold = JSON.parse(buildDaySummaryScaffold(makePayload([block])))
  assert.equal('labelIsTheirOwnWords' in scaffold.blocks[0], false)
})
