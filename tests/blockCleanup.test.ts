import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { WorkContextBlock } from '../src/shared/types.ts'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import {
  listPendingWorkContextCleanupDates,
  upsertWorkContextCleanupReview,
  upsertWorkContextInsight,
} from '../src/main/db/queries.ts'
import { backgroundRelabelDispositionForBlock } from '../src/main/services/workBlocks.ts'

function localMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function makeBlock(overrides: Partial<WorkContextBlock> = {}): WorkContextBlock {
  return {
    id: overrides.id ?? 'block-1',
    startTime: overrides.startTime ?? localMs(2026, 4, 12, 10, 0),
    endTime: overrides.endTime ?? localMs(2026, 4, 12, 11, 0),
    dominantCategory: overrides.dominantCategory ?? 'development',
    categoryDistribution: overrides.categoryDistribution ?? { development: 1 },
    ruleBasedLabel: overrides.ruleBasedLabel ?? '',
    aiLabel: overrides.aiLabel ?? null,
    sessions: overrides.sessions ?? [],
    topApps: overrides.topApps ?? [],
    websites: overrides.websites ?? [],
    keyPages: overrides.keyPages ?? [],
    pageRefs: overrides.pageRefs ?? [],
    documentRefs: overrides.documentRefs ?? [],
    topArtifacts: overrides.topArtifacts ?? [],
    workflowRefs: overrides.workflowRefs ?? [],
    label: overrides.label ?? {
      current: '',
      source: 'rule',
      confidence: 0.4,
      narrative: null,
      ruleBased: overrides.ruleBasedLabel ?? '',
      aiSuggested: overrides.aiLabel ?? null,
      override: null,
    },
    focusOverlap: overrides.focusOverlap ?? {
      totalSeconds: 0,
      pct: 0,
      sessionIds: [],
    },
    evidenceSummary: overrides.evidenceSummary ?? {
      apps: [],
      pages: [],
      documents: [],
      domains: [],
    },
    heuristicVersion: overrides.heuristicVersion ?? 'test',
    computedAt: overrides.computedAt ?? Date.now(),
    switchCount: overrides.switchCount ?? 0,
    confidence: overrides.confidence ?? 'medium',
    isLive: overrides.isLive ?? false,
  }
}

function insertAppSession(
  db: Database.Database,
  dateParts: { year: number; month: number; day: number; hour: number },
): void {
  const startTime = localMs(dateParts.year, dateParts.month, dateParts.day, dateParts.hour)
  const endTime = startTime + 3_600_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id,
      app_name,
      start_time,
      end_time,
      duration_sec,
      category,
      is_focused,
      raw_app_name,
      capture_source,
      capture_version
    ) VALUES ('com.microsoft.VSCode', 'Code', ?, ?, 3600, 'development', 1, 'Code', 'test', 1)
  `).run(startTime, endTime)
}

function insertTimelineBlock(
  db: Database.Database,
  payload: {
    id: string
    date: string
    startTime: number
    endTime: number
  },
): void {
  db.prepare(`
    INSERT INTO timeline_blocks (
      id,
      date,
      start_time,
      end_time,
      block_kind,
      dominant_category,
      category_distribution_json,
      switch_count,
      label_current,
      label_source,
      label_confidence,
      narrative_current,
      evidence_summary_json,
      is_live,
      heuristic_version,
      computed_at,
      invalidated_at
    ) VALUES (?, ?, ?, ?, 'work', 'development', '{}', 0, 'Development', 'rule', 0.5, NULL, '{}', 0, 'test', ?, NULL)
  `).run(payload.id, payload.date, payload.startTime, payload.endTime, payload.startTime)
}

test('background relabel only reopens weak fallback or legacy generic AI labels', () => {
  const strongRuleBlock = makeBlock({
    ruleBasedLabel: 'GitHub',
    label: {
      current: 'GitHub',
      source: 'rule',
      confidence: 0.8,
      narrative: null,
      ruleBased: 'GitHub',
      aiSuggested: null,
      override: null,
    },
  })
  assert.equal(backgroundRelabelDispositionForBlock(strongRuleBlock), 'review')

  const weakFallbackBlock = makeBlock({
    id: 'block-2',
    ruleBasedLabel: '',
    label: {
      current: 'Claude',
      source: 'rule',
      confidence: 0.4,
      narrative: null,
      ruleBased: '',
      aiSuggested: null,
      override: null,
    },
  })
  assert.equal(backgroundRelabelDispositionForBlock(weakFallbackBlock), 'relabel')

  const weakAiBlock = makeBlock({
    id: 'block-3',
    aiLabel: 'Research',
    label: {
      current: 'Research',
      source: 'ai',
      confidence: 0.65,
      narrative: null,
      ruleBased: '',
      aiSuggested: 'Research',
      override: null,
    },
  })
  assert.equal(backgroundRelabelDispositionForBlock(weakAiBlock), 'relabel')

  const aiBlock = makeBlock({
    id: 'block-4',
    aiLabel: 'Fixing sync uploader retries',
    label: {
      current: 'Fixing sync uploader retries',
      source: 'ai',
      confidence: 0.65,
      narrative: null,
      ruleBased: '',
      aiSuggested: 'Fixing sync uploader retries',
      override: null,
    },
  })
  assert.equal(backgroundRelabelDispositionForBlock(aiBlock), 'skip')

  const overrideBlock = makeBlock({
    id: 'block-5',
    label: {
      current: 'Client billing follow-up',
      source: 'user',
      confidence: 1,
      narrative: null,
      ruleBased: '',
      aiSuggested: null,
      override: 'Client billing follow-up',
    },
  })
  assert.equal(backgroundRelabelDispositionForBlock(overrideBlock), 'skip')
})

test('pending cleanup dates include only unresolved history days', () => {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)

  insertAppSession(db, { year: 2026, month: 4, day: 9, hour: 9 })

  insertAppSession(db, { year: 2026, month: 4, day: 10, hour: 10 })
  insertTimelineBlock(db, {
    id: 'block-pending',
    date: '2026-04-10',
    startTime: localMs(2026, 4, 10, 10),
    endTime: localMs(2026, 4, 10, 11),
  })

  insertAppSession(db, { year: 2026, month: 4, day: 11, hour: 11 })
  insertTimelineBlock(db, {
    id: 'block-reviewed',
    date: '2026-04-11',
    startTime: localMs(2026, 4, 11, 11),
    endTime: localMs(2026, 4, 11, 12),
  })
  upsertWorkContextCleanupReview(db, {
    startMs: localMs(2026, 4, 11, 11),
    endMs: localMs(2026, 4, 11, 12),
    stableLabel: 'GitHub',
    sourceBlockIds: ['block-reviewed'],
  })

  insertAppSession(db, { year: 2026, month: 4, day: 12, hour: 12 })
  insertTimelineBlock(db, {
    id: 'block-with-weak-ai',
    date: '2026-04-12',
    startTime: localMs(2026, 4, 12, 12),
    endTime: localMs(2026, 4, 12, 13),
  })
  upsertWorkContextInsight(db, {
    startMs: localMs(2026, 4, 12, 12),
    endMs: localMs(2026, 4, 12, 13),
    insight: {
      label: 'Research',
      narrative: null,
    },
    sourceBlockIds: ['block-with-weak-ai'],
  })

  insertAppSession(db, { year: 2026, month: 4, day: 13, hour: 13 })
  insertTimelineBlock(db, {
    id: 'block-override',
    date: '2026-04-13',
    startTime: localMs(2026, 4, 13, 13),
    endTime: localMs(2026, 4, 13, 14),
  })
  db.prepare(`
    INSERT INTO block_label_overrides (block_id, label, narrative, updated_at)
    VALUES ('block-override', 'Renamed block', NULL, ?)
  `).run(Date.now())

  const pending = listPendingWorkContextCleanupDates(db, '2026-04-13')
  assert.deepEqual(pending, ['2026-04-09', '2026-04-10', '2026-04-12'])

  db.close()
})
