import type {
  AIAnswerKind,
  AIConversationState,
  FollowUpAffordance,
  FollowUpSuggestion,
} from '@shared/types'

function titleCaseTopic(topic: string | null): string | null {
  if (!topic) return null
  return topic
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeSuggestion(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function validSuggestion(text: string): boolean {
  const normalized = normalizeSuggestion(text)
  if (!normalized) return false
  if (normalized.split(/\s+/).length > 8) return false
  const lower = normalized.toLowerCase()
  return ![
    'tell me more',
    'anything else',
    'go on',
    'continue',
  ].includes(lower)
}

function dedupeSuggestions(items: FollowUpSuggestion[]): FollowUpSuggestion[] {
  const seen = new Set<string>()
  const deduped: FollowUpSuggestion[] = []
  for (const item of items) {
    const normalized = normalizeSuggestion(item.text)
    const key = normalized.toLowerCase()
    if (!validSuggestion(normalized) || seen.has(key)) continue
    seen.add(key)
    deduped.push({ ...item, text: normalized })
  }
  return deduped
}

function candidate(text: string, affordance: FollowUpAffordance): FollowUpSuggestion {
  return { text, source: 'deterministic', affordance }
}

export function buildDeterministicFollowUpCandidates(
  answerKind: AIAnswerKind,
  state: AIConversationState | null,
): FollowUpSuggestion[] {
  const topic = titleCaseTopic(state?.topic ?? null)
  const rangeLabel = state?.dateRange?.label?.toLowerCase().includes('last week') ? 'last week' : 'this week'
  const suggestions: FollowUpSuggestion[] = []

  switch (answerKind) {
    case 'weekly_brief':
      suggestions.push(
        candidate('Go deeper on the main themes', 'deepen'),
        candidate('Exactly what did I read?', 'literalize'),
        candidate('What was active work vs reading?', 'narrow'),
        candidate(rangeLabel === 'last week' ? 'Compare this with this week' : 'Compare this with last week', 'compare'),
      )
      if (topic) suggestions.unshift(candidate(`Go deeper on ${topic}`, 'deepen'))
      break
    case 'weekly_literal_list':
      suggestions.push(
        candidate('Which of these were AI-related?', 'narrow'),
        candidate('What did I spend longest on?', 'expand'),
        candidate('Show only browser pages', 'narrow'),
        candidate('What was noise vs signal?', 'expand'),
      )
      break
    case 'deterministic_stats':
      suggestions.push(
        candidate('What drove this result?', 'deepen'),
        candidate('Which apps shaped it most?', 'expand'),
        candidate('How did the day break down?', 'expand'),
        candidate(rangeLabel === 'last week' ? 'Compare this with this week' : 'Compare this with yesterday', 'compare'),
      )
      break
    case 'day_summary_style':
      suggestions.push(
        candidate('What did I actually finish?', 'expand'),
        candidate('Which files or pages mattered?', 'narrow'),
        candidate('Where did focus break down?', 'deepen'),
        candidate('What should I pick up next?', 'repair'),
      )
      break
    case 'freeform_chat':
      suggestions.push(
        candidate('Can you be more specific?', 'repair'),
        candidate('What evidence supports that?', 'deepen'),
        candidate('What stood out most?', 'deepen'),
        candidate('Compare that with yesterday', 'compare'),
      )
      break
    case 'error':
    default:
      break
  }

  return dedupeSuggestions(suggestions).slice(0, 6)
}

export function buildFollowUpSuggestionPrompts(
  userQuestion: string,
  answerText: string,
  state: AIConversationState | null,
  candidates: FollowUpSuggestion[],
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    'You write Google-style recommended next questions for Daylens.',
    'Return strict JSON with a single key "suggestions".',
    '"suggestions" must be an array of 3 or 4 short follow-up questions.',
    'Each suggestion must be at most 8 words.',
    'Use concrete nouns and avoid generic filler like "Tell me more".',
    'Stay inside the current topic and time scope unless comparison is explicitly useful.',
    'Prefer suggestions that would help the user refine or deepen the answer immediately.',
  ].join(' ')

  const userPrompt = JSON.stringify({
    userQuestion,
    answerPreview: answerText.slice(0, 1_500),
    conversationState: state,
    candidateSuggestions: candidates.map((item) => item.text),
  }, null, 2)

  return { systemPrompt, userPrompt }
}

export function parseFollowUpSuggestions(
  raw: string,
  fallback: FollowUpSuggestion[],
): FollowUpSuggestion[] {
  const normalized = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  if (!normalized) return dedupeSuggestions(fallback).slice(0, 4)

  try {
    const parsed = JSON.parse(normalized) as { suggestions?: unknown }
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((value): value is string => typeof value === 'string')
      : []
    const rewritten = dedupeSuggestions(
      suggestions.map((text) => ({ text, source: 'model' as const })),
    )
    if (rewritten.length >= 2) return rewritten.slice(0, 4)
  } catch {
    // Fall through to deterministic suggestions.
  }

  return dedupeSuggestions(fallback).slice(0, 4)
}
