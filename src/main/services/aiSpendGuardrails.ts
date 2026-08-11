// Per-feature AI spend guardrails (DEV-228). The global 250-call/day cap
// bounds runaway call COUNTS; this bounds runaway COST per user-facing
// feature, alerts the user the moment a feature crosses its budget, and backs
// the "Background AI" kill switch. Enforcement happens at the one choke point
// every text AI job passes through (executeTextAIJob) — user-initiated calls
// are never blocked, matching the existing cap and circuit breaker.
import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import { AI_JOB_FEATURES, jobTypesForFeature } from '@shared/aiFeatures'
import type { AIJobType, AppSettings, SpendGuardrailsReport } from '@shared/types'
import { estimateUsageCostUsd } from './modelPricing'
import { deliverNotification } from './notificationDelivery'

export const DEFAULT_FEATURE_DAILY_BUDGET_USD = 0.5

export function featureBudgetUsd(settings: AppSettings, feature: string): number {
  const override = settings.aiFeatureBudgetOverridesUsd?.[feature]
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return override
  const fallback = settings.aiFeatureDailyBudgetUsd
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return fallback
  return DEFAULT_FEATURE_DAILY_BUDGET_USD
}

function localMidnightMs(now: number): number {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime()
}

// Today's spend for one feature, in dollars. Rows carry a provider-reported
// cost_usd when the provider gave one; otherwise the cost is estimated from
// tokens exactly the way the Usage screen does (billing.ts resolveRowCost), so
// the number the budget enforces is the number the user sees.
export function getFeatureSpendTodayUsd(db: Database.Database, feature: string, now = Date.now()): number {
  const jobTypes = jobTypesForFeature(feature)
  if (jobTypes.length === 0) return 0
  const placeholders = jobTypes.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
    FROM ai_usage_events
    WHERE job_type IN (${placeholders})
      AND started_at >= ?
  `).all(...jobTypes, localMidnightMs(now)) as Array<{
    model: string | null
    cost_usd: number | null
    input_tokens: number | null
    output_tokens: number | null
    cache_read_tokens: number | null
    cache_write_tokens: number | null
  }>

  let total = 0
  for (const row of rows) {
    if (row.cost_usd != null && Number.isFinite(row.cost_usd)) {
      total += row.cost_usd
      continue
    }
    total += estimateUsageCostUsd(
      row.model,
      row.input_tokens,
      row.output_tokens,
      row.cache_read_tokens,
      row.cache_write_tokens,
    ) ?? 0
  }
  return total
}

export interface FeatureBudgetVerdict {
  feature: string
  budgetUsd: number
  spentUsd: number
  exhausted: boolean
}

export function evaluateFeatureBudget(
  db: Database.Database,
  settings: AppSettings,
  jobType: AIJobType,
  now = Date.now(),
): FeatureBudgetVerdict {
  const feature = AI_JOB_FEATURES[jobType]
  const budgetUsd = featureBudgetUsd(settings, feature)
  const spentUsd = getFeatureSpendTodayUsd(db, feature, now)
  return { feature, budgetUsd, spentUsd, exhausted: spentUsd >= budgetUsd }
}

// ─── Runaway-spend alert ────────────────────────────────────────────────────

let alertWindow: BrowserWindow | null = null

export function setSpendAlertWindow(win: BrowserWindow | null): void {
  alertWindow = win
}

function openUsageSettings(): void {
  if (!alertWindow || alertWindow.isDestroyed()) return
  if (alertWindow.isMinimized()) alertWindow.restore()
  alertWindow.show()
  alertWindow.focus()
  alertWindow.webContents.send('navigate', '/settings?section=usage')
}

// One alert per feature per local day — a blocked runaway loop retries every
// few seconds and must not turn into a notification storm.
const alertedFeatureDays = new Map<string, number>()

export function fireRunawaySpendAlertOnce(verdict: FeatureBudgetVerdict, now = Date.now()): boolean {
  const day = localMidnightMs(now)
  if (alertedFeatureDays.get(verdict.feature) === day) return false
  alertedFeatureDays.set(verdict.feature, day)
  deliverNotification({
    title: 'Daylens paused background AI',
    body: `${verdict.feature} hit its daily AI budget ($${verdict.spentUsd.toFixed(2)} of $${verdict.budgetUsd.toFixed(2)}). It resumes tomorrow — tap to review or raise the budget.`,
    actionText: 'Review usage',
    onClick: openUsageSettings,
    surface: 'runaway-spend',
  })
  return true
}

// ─── Usage-screen report ────────────────────────────────────────────────────

export function getSpendGuardrailsReport(
  db: Database.Database,
  settings: AppSettings,
  now = Date.now(),
): SpendGuardrailsReport {
  const features = [...new Set(Object.values(AI_JOB_FEATURES))]
  return {
    backgroundAiEnabled: settings.backgroundAiEnabled !== false,
    defaultDailyBudgetUsd: featureBudgetUsd(settings, ''),
    features: features.map((feature) => {
      const budgetUsd = featureBudgetUsd(settings, feature)
      const spentTodayUsd = getFeatureSpendTodayUsd(db, feature, now)
      return { feature, budgetUsd, spentTodayUsd, exhausted: spentTodayUsd >= budgetUsd }
    }).sort((a, b) => b.spentTodayUsd - a.spentTodayUsd),
  }
}
