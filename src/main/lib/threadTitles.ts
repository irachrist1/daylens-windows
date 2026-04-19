import type { AIAnswerKind } from '@shared/types'

export interface ThreadTitleContext {
  answerKind?: AIAnswerKind | null
  entityName?: string | null
  entityIntent?: string | null
  weeklyBriefIntent?: string | null
}

export const DEFAULT_THREAD_TITLE = 'New chat'

const MAX_THREAD_TITLE_LENGTH = 60

const GENERIC_TITLES = new Set([
  'new chat',
  'untitled chat',
  'chat',
  'thread',
  'conversation',
])

const WEAK_TITLE_PREFIXES = [
  /^(?:please\s+)?(?:can|could|would|will)\s+you\b/i,
  /^(?:please\s+)?(?:show|tell|give|help|summarize|sum up|explain|compare|review|create|make|draft|turn|generate|write|export)\b/i,
  /^(?:please\s+)?(?:what|how|why|when|where|which)\b/i,
]

const FILLER_PREFIXES = [
  /^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i,
  /^(?:please\s+)?(?:show|tell|give|help|summarize|sum up|explain|compare|review|create|make|draft|turn|generate|write|export)\s+(?:me\s+)?/i,
  /^(?:please\s+)?i\s+(?:want|need|would like)\s+(?:to\s+)?/i,
  /^(?:please\s+)?let(?:'s| us)\s+/i,
]

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[\s?!.,;:]+$/g, '')
}

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function trimTitle(value: string): string {
  const normalized = collapseWhitespace(stripTrailingPunctuation(value))
  if (normalized.length <= MAX_THREAD_TITLE_LENGTH) return normalized

  const words = normalized.split(' ')
  let output = ''
  for (const word of words) {
    const candidate = output ? `${output} ${word}` : word
    if (candidate.length > MAX_THREAD_TITLE_LENGTH - 1) break
    output = candidate
  }

  const clipped = output || normalized.slice(0, MAX_THREAD_TITLE_LENGTH - 1).trimEnd()
  return `${clipped}…`
}

function timeframePrefix(normalized: string): 'Daily' | 'Weekly' | 'Monthly' | null {
  if (/\b(today|yesterday|day)\b/.test(normalized)) return 'Daily'
  if (/\b(this week|last week|week)\b/.test(normalized)) return 'Weekly'
  if (/\b(this month|last month|month)\b/.test(normalized)) return 'Monthly'
  return null
}

function intentTitleFromContext(context?: ThreadTitleContext): string | null {
  const weeklyIntent = context?.weeklyBriefIntent ?? null
  if (weeklyIntent === 'weekly_browsing_reading_brief') return 'Weekly reading recap'
  if (weeklyIntent === 'weekly_topic_exploration_brief') return 'Weekly exploration recap'
  if (weeklyIntent === 'weekly_deepen_followup') return 'Weekly follow-up'

  const entityName = collapseWhitespace(context?.entityName ?? '')
  const entityIntent = context?.entityIntent ?? null
  if (entityName && entityIntent === 'invoice') return trimTitle(`${entityName} invoice`)
  if (entityName && entityIntent === 'time') return trimTitle(`Time on ${entityName}`)
  if (entityName && entityIntent === 'timeline') return trimTitle(`${entityName} timeline`)
  if (entityName && entityIntent === 'appBreakdown') return trimTitle(`${entityName} apps`)
  if (entityName && entityIntent === 'evidence') return trimTitle(`${entityName} evidence`)
  if (entityName && entityIntent === 'ambiguity') return trimTitle(`${entityName} attribution`)

  if (context?.answerKind === 'generated_report') return 'Report'
  return null
}

function intentTitleFromPrompt(message: string): string | null {
  const normalized = collapseWhitespace(message).toLowerCase()
  if (!normalized) return null

  const timeframe = timeframePrefix(normalized)
  const prefix = timeframe ?? ''

  if ((/\b(review|reflect|reflection|recap)\b/.test(normalized) && /\bfocus(?:\s+session)?\b/.test(normalized))) {
    return 'Focus review'
  }
  if ((/\b(start|begin|kick off|set up|launch|resume)\b/.test(normalized) && /\bfocus(?:\s+session)?\b/.test(normalized))) {
    return 'Start focus session'
  }
  if ((/\b(stop|end|finish|wrap up|close|complete)\b/.test(normalized) && /\bfocus(?:\s+session)?\b/.test(normalized))) {
    return 'Stop focus session'
  }
  if (/\bfocus(?:\s+session)?\b/.test(normalized)) {
    return 'Focus session'
  }

  if (/\bexport\b|\bdownload\b/.test(normalized)) {
    return prefix ? `${prefix} export` : 'Export'
  }
  if (/\bchart\b|\bgraph\b|\bplot\b/.test(normalized)) {
    return prefix ? `${prefix} chart` : 'Chart'
  }
  if (/\btable\b|\bcsv\b|\bspreadsheet\b/.test(normalized)) {
    return prefix ? `${prefix} table` : 'Table'
  }
  if (/\breport\b/.test(normalized) || /\bshareable\b/.test(normalized)) {
    return prefix ? `${prefix} report` : 'Report'
  }
  if (/\brecap\b|\bsummary\b/.test(normalized)) {
    return prefix ? `${prefix} recap` : 'Recap'
  }

  return null
}

function extractSubjectTitle(message: string): string | null {
  let cleaned = collapseWhitespace(message)
  if (!cleaned) return null

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of FILLER_PREFIXES) {
      const next = cleaned.replace(pattern, '')
      if (next !== cleaned) {
        cleaned = collapseWhitespace(next)
        changed = true
      }
    }
  }

  const specificPatterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/\beverything i touched for\s+(.+?)(?:\b(?:today|yesterday|this week|last week|this month|last month)\b|[?.!]|$)/i, (match) => match[1] ?? ''],
    [/\b(?:time|hours?) (?:did i spend|i spent|spent)\s+on\s+(.+?)(?:\b(?:today|yesterday|this week|last week|this month|last month)\b|[?.!,]|$)/i, (match) => `Time on ${match[1] ?? ''}`],
    [/\b(?:my\s+)?time on\s+(.+?)(?:\b(?:today|yesterday|this week|last week|this month|last month)\b|[?.!,]|$)/i, (match) => `Time on ${match[1] ?? ''}`],
    [/\b(?:tell me more about|more about|details on|work on|about)\s+(.+?)(?:\b(?:today|yesterday|this week|last week|this month|last month)\b|[?.!,]|$)/i, (match) => match[1] ?? ''],
  ]

  for (const [pattern, mapMatch] of specificPatterns) {
    const match = cleaned.match(pattern)
    if (match) {
      const candidate = collapseWhitespace(mapMatch(match))
      return candidate ? trimTitle(candidate) : null
    }
  }

  cleaned = cleaned
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/^(?:short|quick|brief|shareable)\s+/i, '')
    .replace(/^(?:report|summary|recap)\s+(?:about|of)\s+/i, '')

  const firstClause = cleaned.split(/[.?!]/, 1)[0] ?? cleaned
  const candidate = trimTitle(firstClause)
  return candidate || null
}

export function normalizeThreadTitle(title: string | null | undefined, fallback = DEFAULT_THREAD_TITLE): string {
  const normalized = collapseWhitespace(title ?? '')
  return normalized || fallback
}

export function isWeakThreadTitle(title: string | null | undefined): boolean {
  const normalized = normalizeThreadTitle(title, '').trim()
  if (!normalized) return true
  if (GENERIC_TITLES.has(normalized.toLowerCase())) return true
  if (normalized.endsWith('…')) return true
  return WEAK_TITLE_PREFIXES.some((pattern) => pattern.test(normalized))
}

export function deriveTitleFromMessage(message: string, context?: ThreadTitleContext): string {
  const normalized = collapseWhitespace(message)
  if (!normalized) return DEFAULT_THREAD_TITLE

  const intentTitle = intentTitleFromPrompt(normalized) ?? intentTitleFromContext(context)
  if (intentTitle) return trimTitle(titleCase(intentTitle))

  const extracted = extractSubjectTitle(normalized)
  if (extracted) return extracted

  return trimTitle(normalized)
}
