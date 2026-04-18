import type { AIConversationState, AIThreadMessage, FollowUpClass, FollowUpResolution } from '@shared/types'

const DEEPEN_PATTERNS = ['go deeper', 'deeper', 'what stood out', 'say more']
const LITERAL_PATTERNS = ['exactly what did i read', 'exactly what have i read', 'list them', 'be literal']
const NARROW_PATTERNS = ['only ', 'just ', 'show only', 'just browser', 'only browser', 'just ai', 'only ai']
const EXPAND_PATTERNS = ['what else', 'anything i missed', 'what other', 'what else did i']
const COMPARE_PATTERNS = ['compare', 'different from', 'versus', 'vs ']
const REPAIR_PATTERNS = ['try again', 'be more specific', 'too vague', 'more specific']
const TOPIC_PIVOT_PATTERNS = [/^what about\s+(.+)$/i, /^(?:and\s+)?what about\s+(.+)$/i]
const EXPLICIT_TIME_PATTERNS = [
  'today',
  'yesterday',
  'this week',
  'last week',
  'last month',
  'this month',
  'this whole week',
]

function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase()
}

function includesAny(normalized: string, patterns: string[]): boolean {
  return patterns.some((pattern) => normalized.includes(pattern))
}

function classifyFollowUp(normalized: string): FollowUpClass | null {
  if (!normalized) return null
  if (includesAny(normalized, REPAIR_PATTERNS)) return 'repair'
  if (includesAny(normalized, LITERAL_PATTERNS)) return 'literalize'
  if (includesAny(normalized, COMPARE_PATTERNS)) return 'compare'
  if (TOPIC_PIVOT_PATTERNS.some((pattern) => pattern.test(normalized))) return 'topic_pivot'
  if (includesAny(normalized, EXPLICIT_TIME_PATTERNS)) return 'time_override'
  if (includesAny(normalized, NARROW_PATTERNS)) return 'narrow'
  if (includesAny(normalized, EXPAND_PATTERNS)) return 'expand'
  if (includesAny(normalized, DEEPEN_PATTERNS)) return 'deepen'
  return null
}

function extractTopic(question: string): string | null {
  const trimmed = question.trim()
  for (const pattern of TOPIC_PIVOT_PATTERNS) {
    const match = trimmed.match(pattern)
    if (!match?.[1]) continue
    return match[1].replace(/[?.!]+$/g, '').trim() || null
  }

  const narrowMatch = trimmed.match(/(?:show only|only|just)\s+(.+)$/i)
  if (!narrowMatch?.[1]) return null
  return narrowMatch[1].replace(/[?.!]+$/g, '').trim() || null
}

function latestUserMessage(messages: AIThreadMessage[]): AIThreadMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return messages[index]
  }
  return null
}

function buildScopedPrompt(state: AIConversationState, topic: string | null): string {
  const normalizedTopic = topic?.trim()
  const rangeLabel = state.dateRange?.label?.toLowerCase().includes('last week') ? 'last week' : 'this week'
  const responseMode = state.responseMode ?? 'exploration'

  if (responseMode === 'reading' || responseMode === 'literal') {
    if (normalizedTopic) return `what have i read about ${normalizedTopic} ${rangeLabel} in my browsers`
    return `what have i read ${rangeLabel} in my browsers`
  }

  if (normalizedTopic) return `what have i explored ${normalizedTopic} related ${rangeLabel}`
  return `what have i explored ${rangeLabel}`
}

function buildStatsRepairPrompt(question: string, messages: AIThreadMessage[]): string {
  const lastUser = latestUserMessage(messages)
  if (!lastUser) return question
  if (question.toLowerCase().includes('go deeper')) {
    return `Explain ${lastUser.content} in more detail.`
  }
  return `${lastUser.content}\n\nFollow-up: ${question}`
}

export function resolveFollowUp(
  question: string,
  state: AIConversationState | null,
  messages: AIThreadMessage[],
): FollowUpResolution {
  const normalized = normalizeQuestion(question)
  const followUpClass = classifyFollowUp(normalized)

  if (!state || !followUpClass) {
    return {
      kind: 'fresh_query',
      followUpClass,
      effectivePrompt: question,
      shouldReuseContext: false,
      shouldResetContext: false,
    }
  }

  if (followUpClass === 'time_override') {
    return {
      kind: 'followup_with_override',
      followUpClass,
      effectivePrompt: question,
      shouldReuseContext: false,
      shouldResetContext: true,
    }
  }

  if (state.answerKind === 'deterministic_stats' && (followUpClass === 'deepen' || followUpClass === 'repair' || followUpClass === 'expand')) {
    return {
      kind: followUpClass === 'repair' ? 'followup_repair' : 'followup_with_override',
      followUpClass,
      effectivePrompt: buildStatsRepairPrompt(question, messages),
      shouldReuseContext: false,
      shouldResetContext: true,
    }
  }

  if (state.sourceKind === 'weekly_brief') {
    if (followUpClass === 'topic_pivot' || followUpClass === 'narrow') {
      return {
        kind: 'followup_with_override',
        followUpClass,
        effectivePrompt: buildScopedPrompt(state, extractTopic(question)),
        shouldReuseContext: false,
        shouldResetContext: false,
      }
    }

    if (followUpClass === 'compare') {
      return {
        kind: 'followup_with_override',
        followUpClass,
        effectivePrompt: state.dateRange?.label?.toLowerCase().includes('last week')
          ? 'compare this with the previous week'
          : 'compare this with last week',
        shouldReuseContext: false,
        shouldResetContext: false,
      }
    }

    if (followUpClass === 'repair') {
      return {
        kind: 'followup_repair',
        followUpClass,
        effectivePrompt: question,
        shouldReuseContext: true,
        shouldResetContext: false,
      }
    }

    if (followUpClass === 'deepen' || followUpClass === 'literalize' || followUpClass === 'expand') {
      return {
        kind: 'followup_reuse_context',
        followUpClass,
        effectivePrompt: question,
        shouldReuseContext: true,
        shouldResetContext: false,
      }
    }
  }

  return {
    kind: followUpClass === 'repair' ? 'followup_repair' : 'fresh_query',
    followUpClass,
    effectivePrompt: question,
    shouldReuseContext: false,
    shouldResetContext: followUpClass === 'repair',
  }
}
