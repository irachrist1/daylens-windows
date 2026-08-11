// DEV-228: per-feature spend budgets. The 250-call cap bounds runaway call
// counts; these tests pin the dollar-denominated layer — spend is attributed
// to the same user-facing feature the Usage screen shows, budgets trip at the
// boundary, and per-feature overrides beat the default.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { startAIUsageEvent, finishAIUsageEvent } from '../src/main/db/queries.ts'
import {
  evaluateFeatureBudget,
  featureBudgetUsd,
  getFeatureSpendTodayUsd,
} from '../src/main/services/aiSpendGuardrails.ts'
import type { AIJobType, AppSettings } from '../src/shared/types.ts'

function settingsWith(partial: Partial<AppSettings>): AppSettings {
  return partial as AppSettings
}

function insertCall(
  db: Database.Database,
  id: string,
  jobType: AIJobType,
  startedAt: number,
  opts: { costUsd?: number | null; outputTokens?: number | null; model?: string; triggerSource?: string } = {},
): void {
  startAIUsageEvent(db, {
    id,
    jobType,
    screen: 'timeline_day',
    triggerSource: opts.triggerSource ?? 'background',
    model: opts.model ?? 'claude-haiku-4-5-20251001',
    startedAt,
  })
  finishAIUsageEvent(db, {
    id,
    model: opts.model ?? 'claude-haiku-4-5-20251001',
    success: true,
    completedAt: startedAt + 500,
    costUsd: opts.costUsd,
    outputTokens: opts.outputTokens,
  })
}

const NOW = new Date(2026, 6, 5, 14, 0, 0, 0).getTime()
const MORNING = new Date(2026, 6, 5, 9, 0, 0, 0).getTime()
const YESTERDAY = new Date(2026, 6, 4, 9, 0, 0, 0).getTime()

test('feature spend sums only today and only the feature’s own job types', () => {
  const db = createProductionTestDatabase()

  insertCall(db, 'label-1', 'block_label_finalize', MORNING, { costUsd: 0.10 })
  insertCall(db, 'label-2', 'block_cleanup_relabel', MORNING + 1_000, { costUsd: 0.15 })
  // Yesterday's spend never counts toward today.
  insertCall(db, 'label-old', 'block_label_finalize', YESTERDAY, { costUsd: 5 })
  // Another feature's spend never counts toward this one.
  insertCall(db, 'chat-1', 'chat_answer', MORNING + 2_000, { costUsd: 3 })

  const spend = getFeatureSpendTodayUsd(db, 'Timeline labeling', NOW)
  assert.ok(Math.abs(spend - 0.25) < 1e-9, `expected 0.25, got ${spend}`)
  db.close()
})

test('rows without a provider cost are priced from their tokens', () => {
  const db = createProductionTestDatabase()

  // No cost_usd on the row — the guardrail estimates from tokens the same way
  // the Usage screen does, so a BYOK runaway is still counted in dollars.
  insertCall(db, 'label-est', 'block_label_finalize', MORNING, {
    costUsd: null,
    outputTokens: 1_000_000,
  })

  const spend = getFeatureSpendTodayUsd(db, 'Timeline labeling', NOW)
  assert.ok(spend > 0, `token-only row must still contribute spend, got ${spend}`)
  db.close()
})

test('budget trips at the boundary and overrides beat the default', () => {
  const db = createProductionTestDatabase()
  insertCall(db, 'label-1', 'block_label_finalize', MORNING, { costUsd: 0.50 })

  const defaults = settingsWith({ aiFeatureDailyBudgetUsd: 0.5 })
  const verdictAtCap = evaluateFeatureBudget(db, defaults, 'block_label_preview', NOW)
  assert.equal(verdictAtCap.feature, 'Timeline labeling')
  assert.equal(verdictAtCap.exhausted, true)

  const roomier = settingsWith({
    aiFeatureDailyBudgetUsd: 0.5,
    aiFeatureBudgetOverridesUsd: { 'Timeline labeling': 2 },
  })
  assert.equal(evaluateFeatureBudget(db, roomier, 'block_label_preview', NOW).exhausted, false)

  // Other features are untouched by Timeline labeling's spend.
  assert.equal(evaluateFeatureBudget(db, defaults, 'memory_write', NOW).exhausted, false)
  db.close()
})

test('budget resolution: override > default setting > built-in default', () => {
  assert.equal(featureBudgetUsd(settingsWith({}), 'Timeline labeling'), 0.5)
  assert.equal(featureBudgetUsd(settingsWith({ aiFeatureDailyBudgetUsd: 1.25 }), 'Timeline labeling'), 1.25)
  assert.equal(
    featureBudgetUsd(
      settingsWith({ aiFeatureDailyBudgetUsd: 1.25, aiFeatureBudgetOverridesUsd: { 'Timeline labeling': 0 } }),
      'Timeline labeling',
    ),
    0,
  )
  // Negative and non-finite overrides are ignored, not enforced.
  assert.equal(
    featureBudgetUsd(settingsWith({ aiFeatureBudgetOverridesUsd: { 'Timeline labeling': -1 } }), 'Timeline labeling'),
    0.5,
  )
})
