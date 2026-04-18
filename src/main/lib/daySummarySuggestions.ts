const ASSISTANT_TO_USER_STARTERS = [
  /^(?:are|did|do|were|have|has)\s+you\b/i,
  /^(?:is|was)\s+this\b/i,
  /^(?:did|does)\s+task\b/i,
]

const QUESTION_QUERY_STARTERS = [
  /^(?:what|which|where|when|why|how)\b/i,
  /^(?:did|do|was|am|have|should)\s+i\b/i,
  /^(?:can|could|would|will)\s+you\b/i,
]

const REQUEST_QUERY_STARTERS = [
  /^summarize\b/i,
  /^show\b/i,
  /^list\b/i,
  /^compare\b/i,
  /^break down\b/i,
  /^turn\b/i,
  /^make\b/i,
  /^export\b/i,
  /^highlight\b/i,
  /^group\b/i,
  /^surface\b/i,
]

function capitalizeStandaloneI(text: string): string {
  return text.replace(/\bi\b/g, 'I')
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, '\'')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeDaySummaryQuestionSuggestion(text: string): string | null {
  let normalized = normalizeWhitespace(text)
    .replace(/^[-*•]\s*/, '')
    .replace(/^["']+|["']+$/g, '')
    .trim()

  if (!normalized) return null

  const firstQuestionIndex = normalized.indexOf('?')
  if (firstQuestionIndex >= 0) {
    normalized = normalized.slice(0, firstQuestionIndex + 1).trim()
  }

  normalized = normalized.replace(/\s+([?!.,])/g, '$1')
  normalized = normalized.replace(/[.!]+$/, '').trim()
  normalized = capitalizeStandaloneI(normalized)

  if (!normalized) return null
  if (normalized.split(/\s+/).length > 16) return null
  if (ASSISTANT_TO_USER_STARTERS.some((pattern) => pattern.test(normalized))) return null

  const isQuestionQuery = QUESTION_QUERY_STARTERS.some((pattern) => pattern.test(normalized))
  const isRequestQuery = REQUEST_QUERY_STARTERS.some((pattern) => pattern.test(normalized))

  if (!isQuestionQuery && !isRequestQuery) return null

  if (isQuestionQuery && !normalized.endsWith('?')) {
    normalized = `${normalized}?`
  }

  return normalized[0].toUpperCase() + normalized.slice(1)
}

export function fillDaySummaryQuestionSuggestions(
  suggestions: string[],
  fallback: string[],
): string[] {
  const deduped: string[] = []
  const seen = new Set<string>()

  for (const candidate of [...suggestions, ...fallback]) {
    const normalized = normalizeDaySummaryQuestionSuggestion(candidate)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(normalized)
    if (deduped.length >= 3) break
  }

  return deduped
}
