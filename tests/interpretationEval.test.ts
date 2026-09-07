// The offline interpretation eval (DEV-206 / agent-runtime-and-context.md):
// the gate the live interpretation switch must pass before it may write
// product state. Runs the REAL analyze pipeline over representative fixture
// days (mocked model, no provider) and scores the interpretation invariants:
// corrections outrank inference, evidence is never destroyed, absences are
// hard boundaries, regroup only merges, labels stay human. Also the
// regression the ticket demands: reprocessing replaces automated inference
// but a user-corrected block is never re-labeled or merged away — and
// provider unavailability yields deterministic blocks, never an error.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import type { AppCategory } from '../src/shared/types.ts'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import { analyzeTimelineDay } from '../src/main/services/analyzeDay.ts'
import { setBlockLabelOverride } from '../src/main/db/queries.ts'
import {
  evaluateInterpretationRun,
  interpretationAgentEnabled,
} from '../src/main/lib/interpretationEval.ts'

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  startMinute: number,
  durationMinutes: number,
  category: AppCategory = 'browsing',
): void {
  const startTime = localMs(9, startMinute)
  const endTime = startTime + durationMinutes * 60_000
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('com.google.Chrome', 'Google Chrome', ?, ?, ?, ?, 1, ?, 'Google Chrome', 'test', 1)
  `).run(startTime, endTime, durationMinutes * 60, category, title)
}

// A representative over-split fixture day: two sustained topics the engine
// splits into 3+ heuristic blocks.
function seedFixtureDay(db: Database.Database): void {
  insertSession(db, 'Camera comparison research - Google Search - Google Chrome', 0, 12)
  insertSession(db, 'Camera comparison research - DPReview - Google Chrome', 12, 10)
  insertSession(db, 'City council election results - Local News - Google Chrome', 22, 12)
  insertSession(db, 'City council election results - Analysis - Google Chrome', 34, 10)
}

// ─── The live switch is OFF by default ───────────────────────────────────────

test('the interpretation-agent live switch is off by default and requires an explicit true', () => {
  assert.equal(interpretationAgentEnabled({}), false)
  assert.equal(interpretationAgentEnabled({ interpretationAgentEnabled: false }), false)
  assert.equal(interpretationAgentEnabled({ interpretationAgentEnabled: true }), true)
})

// ─── A compliant run passes the eval ─────────────────────────────────────────

test('a compliant interpretation run over the fixture day passes every invariant', async () => {
  const db = createProductionTestDatabase()
  try {
    seedFixtureDay(db)
    const before = materializeTimelineDayProjection(db, TEST_DATE, null)

    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async (blocks) => [blocks.map((_, index) => index)],
      blockInsight: async () => ({ label: 'Researching cameras and local news', narrative: 'Merged intent.' }),
    })

    const report = evaluateInterpretationRun({ before, after: result.payload })
    assert.equal(report.pass, true, JSON.stringify(report.violations))
    assert.ok(report.blocksAfter <= report.blocksBefore, 'regroup only merges')
    assert.ok(
      Math.abs(report.observedSecondsBefore - report.observedSecondsAfter) <= 60,
      'interpretation never creates or destroys observed time',
    )
  } finally {
    db.close()
  }
})

// ─── Correction precedence across reprocessing (the ticket's regression) ─────

test('reprocessing replaces automated inference but never a correction: the corrected block survives hostile runs', async () => {
  const db = createProductionTestDatabase()
  try {
    seedFixtureDay(db)
    const before = materializeTimelineDayProjection(db, TEST_DATE, null)
    assert.ok(before.blocks.length >= 2)

    // The person corrects the first block's name.
    const corrected = 'Picking the camera for the trip'
    setBlockLabelOverride(db, before.blocks[0].id, corrected, null)

    // A hostile interpreter tries to fuse EVERYTHING (including the corrected
    // block) and re-label every block.
    const run = async () => analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async (blocks) => [blocks.map((_, index) => index)],
      blockInsight: async () => ({ label: 'One big generated blob', narrative: null }),
    })

    // Twice: reprocessing the same evidence may replace automated inference,
    // never the person's correction.
    const first = await run()
    const second = await run()

    for (const [label, payload] of [['first', first.payload], ['second', second.payload]] as const) {
      const labels = payload.blocks.filter((b) => !b.isLive).map((b) => b.label.current)
      assert.ok(labels.includes(corrected), `${label} run: the corrected label survives verbatim (got: ${labels.join(' | ')})`)
    }

    const report = evaluateInterpretationRun({
      before,
      after: second.payload,
      expectations: { correctedLabels: [corrected] },
    })
    assert.equal(report.pass, true, JSON.stringify(report.violations))
  } finally {
    db.close()
  }
})

// ─── The eval catches a bad interpreter ──────────────────────────────────────

test('the eval fails a run whose labels leak raw artifacts into prose', async () => {
  const db = createProductionTestDatabase()
  try {
    seedFixtureDay(db)
    const before = materializeTimelineDayProjection(db, TEST_DATE, null)

    // The injected interpreter bypasses the jobs-layer raw-label guard, the
    // way a misbehaving future runtime could — the OFFLINE EVAL is the gate
    // that catches it before any rollout.
    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      regroupPlan: async () => [],
      blockInsight: async () => ({ label: 'feat/notifications-v2', narrative: null }),
    })

    assert.equal(
      result.payload.blocks.some((block) => block.label.current === 'feat/notifications-v2'),
      false,
      'the finalize ladder never persists a branch name as a label',
    )

    // The injected interpreter still proposed the leak; the offline eval is
    // the gate that scores a payload carrying it, the way a future runtime
    // that bypassed the chooser would be caught before rollout.
    const leaked = {
      ...result.payload,
      blocks: result.payload.blocks.map((block, index) => (
        index === 0
          ? { ...block, label: { ...block.label, current: 'feat/notifications-v2' } }
          : block
      )),
    }
    const report = evaluateInterpretationRun({ before, after: leaked })
    assert.equal(report.pass, false)
    assert.ok(report.violations.some((v) => v.rule === 'label-unusable'),
      `expected a label-unusable violation, got ${JSON.stringify(report.violations)}`)
  } finally {
    db.close()
  }
})

test('the eval fails a doctored outcome that overwrote a correction or destroyed evidence', async () => {
  const db = createProductionTestDatabase()
  try {
    seedFixtureDay(db)
    const before = materializeTimelineDayProjection(db, TEST_DATE, null)

    // Correction gone + a block dropped entirely (evidence destroyed).
    const doctored = { ...before, blocks: before.blocks.slice(1) }
    const report = evaluateInterpretationRun({
      before,
      after: doctored,
      expectations: { correctedLabels: ['Picking the camera for the trip'] },
    })
    assert.equal(report.pass, false)
    const rules = new Set(report.violations.map((v) => v.rule))
    assert.ok(rules.has('correction-overwritten'), 'the vanished correction is named')
    assert.ok(rules.has('evidence-changed'), 'the destroyed observed time is named')
  } finally {
    db.close()
  }
})

// ─── Provider unavailability → deterministic blocks, no errors ───────────────

test('a dead provider yields the deterministic heuristic blocks and never throws in the automatic path', async () => {
  const db = createProductionTestDatabase()
  try {
    seedFixtureDay(db)
    const before = materializeTimelineDayProjection(db, TEST_DATE, null)

    const result = await analyzeTimelineDay(db, TEST_DATE, {
      triggerSource: 'background',
      surfaceErrors: false, // the automatic finalize path
      regroupPlan: async () => { throw new Error('provider unavailable') },
      blockInsight: async () => { throw new Error('provider unavailable') },
    })

    assert.equal(result.merged, false)
    const labelsBefore = before.blocks.map((b) => b.label.current)
    const labelsAfter = result.payload.blocks.map((b) => b.label.current)
    assert.deepEqual(labelsAfter, labelsBefore, 'the deterministic blocks stand, unchanged')

    const report = evaluateInterpretationRun({ before, after: result.payload })
    assert.equal(report.pass, true, JSON.stringify(report.violations))
  } finally {
    db.close()
  }
})
