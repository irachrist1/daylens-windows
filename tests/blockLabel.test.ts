import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkContextBlock } from '../src/shared/types.ts'
import { userVisibleBlockLabel, naturalizeLabel } from '../src/shared/blockLabel.ts'

function makeBlock(overrides: Partial<WorkContextBlock> = {}): WorkContextBlock {
  const base: WorkContextBlock = {
    id: 'b1',
    startTime: 0,
    endTime: 60_000,
    dominantCategory: 'research',
    categoryDistribution: { research: 1 },
    ruleBasedLabel: '',
    aiLabel: null,
    sessions: [],
    topApps: [],
    websites: [],
    keyPages: [],
    pageRefs: [],
    documentRefs: [],
    topArtifacts: [],
    workflowRefs: [],
    label: {
      current: '',
      source: 'rule',
      confidence: 0.5,
      narrative: null,
      ruleBased: '',
      aiSuggested: null,
      override: null,
    },
    focusOverlap: { focusedSeconds: 0, totalSeconds: 0, focusRatio: 0 },
    evidenceSummary: {
      headline: '',
      detail: '',
      categoryCounts: {},
      appCount: 0,
      websiteCount: 0,
      documentCount: 0,
      pageCount: 0,
    },
    heuristicVersion: 'test',
    computedAt: 0,
    switchCount: 0,
    confidence: { score: 0.5, reasons: [] },
    isLive: false,
    ...overrides,
  } as WorkContextBlock
  return base
}

test('rejects browser tab-title soup as a label', () => {
  const block = makeBlock({
    label: {
      current: 'W2_Reading | Introduction to Machine Learning | Perusall',
      source: 'artifact',
      confidence: 0.5,
      narrative: null,
      ruleBased: '',
      aiSuggested: null,
      override: null,
    },
    ruleBasedLabel: 'Course reading',
    websites: [{ domain: 'app.perusall.com', totalSeconds: 600, sessionCount: 1, isPrimary: true } as any],
  })
  const label = userVisibleBlockLabel(block)
  assert.equal(label, 'Course reading')
})

test('falls back to cleaned site name when no useful label exists', () => {
  const block = makeBlock({
    label: {
      current: 'A | B | C',
      source: 'artifact',
      confidence: 0.5,
      narrative: null,
      ruleBased: '',
      aiSuggested: null,
      override: null,
    },
    websites: [{ domain: 'www.perusall.com', totalSeconds: 600, sessionCount: 1, isPrimary: true } as any],
  })
  assert.equal(userVisibleBlockLabel(block), 'Perusall')
})

test('respects user override even if it contains pipes', () => {
  const block = makeBlock({
    label: {
      current: 'AI label',
      source: 'user',
      confidence: 1,
      narrative: null,
      ruleBased: '',
      aiSuggested: null,
      override: 'My | weird | label',
    },
  })
  assert.equal(userVisibleBlockLabel(block), 'My | weird | label')
})

test('keeps a useful AI label over generic rule label', () => {
  const block = makeBlock({
    label: {
      current: 'Chat pipeline refactor',
      source: 'ai',
      confidence: 0.9,
      narrative: null,
      ruleBased: 'Development',
      aiSuggested: 'Chat pipeline refactor',
      override: null,
    },
    aiLabel: 'Chat pipeline refactor',
    ruleBasedLabel: 'Development',
  })
  assert.equal(userVisibleBlockLabel(block), 'Chat pipeline refactor')
})

test('falls back to the category name when nothing more specific is present', () => {
  // A categorized block with no usable label reads as its category ("Research")
  // rather than "Untitled block" — the category agrees with the badge and is a
  // better floor than a blank.
  const block = makeBlock({})
  assert.equal(userVisibleBlockLabel(block), 'Research')
})

test('contentless categories use an honest evidence-based fallback', () => {
  assert.equal(userVisibleBlockLabel(makeBlock({
    dominantCategory: 'uncategorized',
    topApps: [{
      bundleId: 'company.thebrowser.arc',
      appName: 'Arc',
      category: 'uncategorized',
      totalSeconds: 60,
      sessionCount: 1,
      isBrowser: true,
    }],
  })), 'Arc — activity')
  assert.equal(userVisibleBlockLabel(makeBlock({ dominantCategory: 'system', topApps: [] })), 'Untracked time')
})

test('naturalizeLabel strips leading notification counts like "(1) Instagram"', () => {
  assert.equal(naturalizeLabel('(1) Instagram'), 'Instagram')
  assert.equal(naturalizeLabel('(5) Andersen In Rwanda'), 'Andersen In Rwanda')
  assert.equal(naturalizeLabel('(12)  Slack'), 'Slack')
  // A non-count parenthetical is preserved.
  assert.equal(naturalizeLabel('Notes (draft)'), 'Notes (draft)')
})

test('isUsefulLabel rejects a tool-surface name', () => {
  const block = makeBlock({
    dominantCategory: 'development',
    label: {
      current: 'Cursor Agents',
      source: 'artifact',
      confidence: 0.5,
      narrative: null,
      ruleBased: 'Development',
      aiSuggested: 'Working on Cursor Agents',
      override: null,
    },
    ruleBasedLabel: 'Development',
    aiLabel: 'Working on Cursor Agents',
    topApps: [{ appName: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', category: 'development', totalSeconds: 60, isBrowser: false } as never],
    topArtifacts: [{
      id: 'art_ca',
      artifactType: 'window',
      canonicalKey: 'window:cursor:cursor agents',
      displayTitle: 'Cursor Agents',
      totalSeconds: 60,
      confidence: 0.7,
    } as never],
  })
  const label = userVisibleBlockLabel(block)
  assert.notEqual(label, 'Cursor Agents')
  assert.notEqual(label, 'Working on Cursor Agents')
  assert.equal(/cursor agents/i.test(label), false, `visible label "${label}" still names the tool surface`)
})
