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

const ENTITY_STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'it', 'its', 'my', 'your', 'our', 'his', 'her', 'their',
  'i', 'we', 'he', 'she', 'they', 'you', 'me', 'us', 'him',
  'hi', 'hey', 'hello', 'sup', 'ok', 'okay', 'yes', 'no', 'sure',
  'can', 'could', 'would', 'will', 'should', 'may', 'might',
  'what', 'which', 'where', 'when', 'how', 'why', 'who',
  'all', 'any', 'some', 'more', 'most', 'many', 'much', 'few',
  'new', 'old', 'good', 'great', 'best', 'just', 'now', 'here', 'there',
  'also', 'then', 'let', 'use', 'ask', 'help', 'want', 'need',
  'ai', 'based', 'daylens', 'direct', 'from', 'tracked',
  'e.g', 'i.e', 'etc', 'vs', 'ex',
  // Temporal words that appear capitalized at sentence start but are not entities
  'today', 'yesterday', 'tomorrow',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'morning', 'afternoon', 'evening', 'week', 'month', 'year',
  // Structural words from router answer headers
  'found', 'local', 'evidence', 'data',
])

function normalizeSuggestion(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

const GENERIC_REJECT_PHRASES = [
  'tell me more',
  'anything else',
  'go on',
  'continue',
  'what stood out most',
  'can you be more specific',
  'what evidence supports that',
  'be more specific',
  'say more',
  'expand on that',
  'more details',
  'keep going',
  'what else',
  'is there anything else',
  'tell me about it',
  'go ahead',
]

function validSuggestion(text: string): boolean {
  const normalized = normalizeSuggestion(text)
  if (!normalized) return false
  if (normalized.split(/\s+/).length > 8) return false
  const lower = normalized.toLowerCase()
  return !GENERIC_REJECT_PHRASES.includes(lower)
}

// Model-generated suggestions must name a specific app, file, page, or entity.
// Accepts suggestions that contain a mid-sentence capitalized word (proper noun)
// or a filename-like token (e.g. "index.ts", "Cursor", "Notion").
function hasNamedEntity(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < 2) return false
  return (
    words.slice(1).some((w) => /^[A-Z][a-z]/.test(w) && !ENTITY_STOP_WORDS.has(w.toLowerCase().replace(/\W+$/, ''))) ||
    /\b\w+\.\w{1,6}\b/.test(text)
  )
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

function answerEntity(answerText: string | null | undefined): string | null {
  if (!answerText) return null
  // Require ≥2 chars on both sides of the dot to avoid matching abbreviations
  // like "e.g" or "i.e" that look like filename tokens.
  const filename = answerText.match(/\b\w{2,}\.\w{2,8}\b/)?.[0]
  if (filename && !ENTITY_STOP_WORDS.has(filename.toLowerCase())) return filename

  const matches = answerText.match(/\b[A-Z][A-Za-z0-9][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9][A-Za-z0-9_-]*){0,2}\b/g) ?? []
  for (const match of matches) {
    const normalized = match.trim()
    if (normalized.length < 4) continue
    if (ENTITY_STOP_WORDS.has(normalized.toLowerCase())) continue
    // Reject multi-word matches where any word is a stop word (e.g. "Hey Tonny")
    if (normalized.includes(' ') && normalized.split(' ').some((w) => ENTITY_STOP_WORDS.has(w.toLowerCase()))) continue
    return normalized
  }
  return null
}

function scopedCandidates(entity: string, state: AIConversationState | null): FollowUpSuggestion[] {
  const compareTarget = state?.dateRange?.label?.toLowerCase().includes('last week')
    ? 'this week'
    : 'yesterday'
  return [
    candidate(`What drove ${entity}?`, 'deepen'),
    candidate(`Which windows mention ${entity}?`, 'narrow'),
    candidate(`What overlapped with ${entity}?`, 'expand'),
    candidate(`Compare ${entity} with ${compareTarget}`, 'compare'),
  ]
}

// Minimal stop-word list for router-set topics (state.topic).
// Narrower than ENTITY_STOP_WORDS because the router sets topics deliberately —
// we only want to reject obvious grammar words, not product terms like "AI".
const TOPIC_STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'it', 'my', 'your', 'our', 'his', 'her', 'their',
  'i', 'we', 'he', 'she', 'they', 'you',
  'hi', 'hey', 'hello', 'ok', 'okay', 'yes', 'no', 'sure',
])

export function buildDeterministicFollowUpCandidates(
  answerKind: AIAnswerKind,
  state: AIConversationState | null,
  answerText?: string | null,
): FollowUpSuggestion[] {
  const rawTopic = state?.topic?.trim() ?? null
  const validatedTopic = (
    rawTopic
    && rawTopic.length >= 2
    && !TOPIC_STOP_WORDS.has(rawTopic.toLowerCase())
    && !(rawTopic.includes(' ') && rawTopic.split(' ').some((w) => TOPIC_STOP_WORDS.has(w.toLowerCase())))
  ) ? rawTopic : null
  const topic = titleCaseTopic(validatedTopic) ?? answerEntity(answerText)
  if (topic) return dedupeSuggestions(scopedCandidates(topic, state)).slice(0, 4)

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
  const systemPrompt = `You generate follow-up question chips for Daylens, a local screen-time and productivity tracker.

OUTPUT FORMAT
Return only valid JSON: { "suggestions": ["...", "...", "..."] }
No markdown, no explanation.

RULES
1. Return 3–4 suggestions, or [] if the answer is a greeting or contains no productivity data.
2. Each suggestion must be ≤8 words.
3. Every suggestion must reference a specific named entity that appears in the answer — an app (Cursor, Chrome, Notion), a file, a page title, a person, a project, or a domain. Do not invent names; pull them from the answer text.
4. Vary the question type across suggestions: one about time/duration, one about specific content (windows, pages, files), one about comparison or trend, one about cause or breakdown.
5. Ground each suggestion in what the answer actually said. Do not ask about something the answer did not mention.
6. Forbidden phrases (never use): "Tell me more", "What stood out", "Go deeper", "What else", "Can you explain", "What evidence", "Say more", "Expand on", "Be more specific", "Continue".
7. Forbidden patterns: fragment suggestions like "What drove The?" or "Which windows mention Hey?" — these indicate a stop-word leaked into the entity slot. If you cannot name a real entity, return [].

GOOD EXAMPLES
"How much time in Cursor today?"
"Which Notion pages appeared most?"
"Compare Slack with yesterday"
"What drove Chrome usage this week?"
"Show Coursera time by day"
"Which files opened in VS Code?"

BAD EXAMPLES (never produce these)
"What drove The?" — stop word in entity slot
"Which windows mention Hey Tonny?" — proper name extracted from greeting
"Tell me more about that" — generic filler
"What else happened?" — vague`

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
    if (!Array.isArray(parsed.suggestions)) return dedupeSuggestions(fallback).slice(0, 4)
    // Model explicitly returned empty — no good suggestions for this response.
    if (parsed.suggestions.length === 0) return []
    const suggestions = parsed.suggestions.filter((value): value is string => typeof value === 'string')
    const rewritten = dedupeSuggestions(
      suggestions
        .filter((text) => hasNamedEntity(text))
        .map((text) => ({ text, source: 'model' as const })),
    )
    if (rewritten.length >= 2) return rewritten.slice(0, 4)
  } catch {
    // Fall through to deterministic suggestions.
  }

  return dedupeSuggestions(fallback).slice(0, 4)
}
