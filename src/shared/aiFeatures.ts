// One shared taxonomy of user-facing AI features. Every AI call carries a
// raw job_type; this maps it to the feature name people actually recognise
// ("Timeline labeling", "AI chat"). The Usage screen groups spend by these
// names, and the per-feature daily budgets (DEV-228) are keyed by them — the
// two must agree, which is why this lives in shared/ and not the renderer.
import type { AIJobType } from './types'

export const AI_JOB_FEATURES: Record<AIJobType, string> = {
  block_label_preview: 'Timeline labeling',
  block_label_finalize: 'Timeline labeling',
  block_cleanup_relabel: 'Timeline labeling',
  interpretation_agent: 'Timeline labeling',
  attribution_assist: 'Timeline labeling',
  day_summary: 'Morning brief',
  wrapped_narrative: 'Evening wrap-up',
  wrapped_question: 'Evening wrap-up',
  wrapped_period_narrative: 'Weekly & monthly wrap',
  week_review: 'Week review',
  app_narrative: 'App insights',
  chat_answer: 'AI chat',
  chat_thread_title: 'AI chat',
  chat_followup_suggestions: 'Suggestions',
  search_intent: 'Search',
  report_generation: 'Reports',
  memory_write: 'Memory writes',
  weekly_brief: 'Weekly brief',
}

export function formatJobFeature(feature: string | null | undefined): string {
  if (!feature) return 'Other'
  return AI_JOB_FEATURES[feature as AIJobType]
    ?? feature.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function jobTypesForFeature(feature: string): AIJobType[] {
  return (Object.keys(AI_JOB_FEATURES) as AIJobType[]).filter(
    (jobType) => AI_JOB_FEATURES[jobType] === feature,
  )
}
