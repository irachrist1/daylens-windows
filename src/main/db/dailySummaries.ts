// Legacy module — the daily_summaries table was removed in migration v14
// in favour of `daily_entity_rollups`. The attribution pipeline
// (`services/attribution.ts`) writes the new rollups during sessionization.
// These stubs are retained only so existing call sites (e.g. `index.ts`
// startup) keep compiling until the final cleanup removes them.

interface DailySummaryRow {
  date: string
  total_active_sec: number
  focus_sec: number
  app_count: number
  domain_count: number
  session_count: number
  context_switches: number
  focus_score: number
  top_app_bundle_id: string | null
  top_domain: string | null
  ai_summary: string | null
  computed_at: number
}

export function computeDailySummary(_dateStr: string): void {
  // no-op
}

export function getDailySummary(_dateStr: string): DailySummaryRow | undefined {
  return undefined
}

export function computeAllMissingSummaries(): void {
  // no-op
}
