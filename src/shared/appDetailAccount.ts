import { labelIsCategoryFloor } from './blockLabel'
import type { AppActivityBreakdown, AppDetailPayload } from './types'

const STRUCTURED_TITLE_KEYS = ['title', 'pageTitle', 'displayTitle', 'name', 'label', 'summary', 'text'] as const

export function looksLikeStructuredDump(value: string | null | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) return false
  if (trimmed === '[object Object]') return true
  if (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed)) return true
  if (/"\w+"\s*:/.test(trimmed) && /[{[]/.test(trimmed)) return true
  return false
}

function proseFromUnknown(value: unknown, depth: number): string | null {
  if (depth > 3) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (looksLikeStructuredDump(trimmed)) {
      try {
        return proseFromUnknown(JSON.parse(trimmed) as unknown, depth + 1)
      } catch {
        return null
      }
    }
    return trimmed
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = proseFromUnknown(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of STRUCTURED_TITLE_KEYS) {
      if (key in record) {
        const found = proseFromUnknown(record[key], depth + 1)
        if (found) return found
      }
    }
  }
  return null
}

function extractFromStructured(raw: string): string | null {
  try {
    return proseFromUnknown(JSON.parse(raw) as unknown, 0)
  } catch {
    const field = raw.match(/"(?:title|pageTitle|displayTitle|name|label|summary)"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (!field) return null
    try {
      const value = (JSON.parse(`"${field[1]}"`) as string).trim()
      return value && !looksLikeStructuredDump(value) ? value : null
    } catch {
      return null
    }
  }
}

function normalizedLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function extractDisplayProse(value: string | null | undefined, appName?: string): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const candidate = looksLikeStructuredDump(trimmed) ? extractFromStructured(trimmed) : trimmed
  if (!candidate) return null
  const cleaned = candidate.replace(/\s+/g, ' ').trim()
  if (!cleaned || looksLikeStructuredDump(cleaned) || /^[{[]/.test(cleaned)) return null
  if (!/[A-Za-z]/.test(cleaned)) return null
  if (appName && normalizedLabel(cleaned) === normalizedLabel(appName)) return null
  if (labelIsCategoryFloor(cleaned)) return null
  return cleaned
}

export function evidenceTitlesFromBreakdown(breakdown: AppActivityBreakdown | undefined): string[] {
  if (!breakdown) return []
  const titles: string[] = []
  const seen = new Set<string>()
  const add = (value: string | null | undefined) => {
    const prose = extractDisplayProse(value)
    if (!prose) return
    const key = prose.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    titles.push(prose)
  }
  for (const group of breakdown.groups) {
    add(group.label)
    for (const item of group.items) add(item.displayTitle)
  }
  return titles
}

export function subjectsFromAppDetail(
  detail: Pick<AppDetailPayload, 'activityBreakdown' | 'blockAppearances' | 'displayName'>,
): string[] {
  const subjects: string[] = []
  const seen = new Set<string>()
  const add = (value: string | null | undefined) => {
    const prose = extractDisplayProse(value, detail.displayName)
    if (!prose) return
    const key = prose.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    subjects.push(prose)
  }

  const groups = [...(detail.activityBreakdown?.groups ?? [])]
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
  const items = groups
    .flatMap((group) => group.items)
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
  for (const item of items) add(item.displayTitle)
  if (subjects.length === 0) {
    for (const group of groups) add(group.label)
  }
  if (subjects.length === 0) {
    for (const block of detail.blockAppearances) add(block.label)
  }
  return subjects
}

export function buildAppDetailAccount(subjects: readonly string[]): string | null {
  const lead = subjects[0]?.trim()
  if (!lead) return null
  return `Most of this time was on ${lead}.`
}

export function activityBreakdownHasRows(breakdown: AppActivityBreakdown | undefined): boolean {
  if (!breakdown) return false
  return breakdown.groups.length > 0
    || Boolean(breakdown.everythingElse)
    || breakdown.unattributedSeconds > 0
}

export function resolveAppDetailAccount(
  detail: Pick<AppDetailPayload, 'activityBreakdown' | 'blockAppearances' | 'displayName' | 'totalSeconds'>,
  generatedSummary?: string | null,
): string | null {
  const generated = extractDisplayProse(generatedSummary, detail.displayName)
  if (generated) return generated
  return buildAppDetailAccount(subjectsFromAppDetail(detail))
}

export function visibleAppDetailCopy(
  detail: Pick<AppDetailPayload, 'activityBreakdown' | 'blockAppearances' | 'displayName' | 'totalSeconds'>,
  generatedSummary?: string | null,
): { account: string | null; labels: string[]; showSection: boolean } {
  const account = resolveAppDetailAccount(detail, generatedSummary)
  const labels = [
    ...(account ? [account] : []),
    ...evidenceTitlesFromBreakdown(detail.activityBreakdown),
    ...detail.blockAppearances.map((block) => block.label),
  ]
  return {
    account,
    labels,
    showSection: detail.totalSeconds > 0 || Boolean(account) || activityBreakdownHasRows(detail.activityBreakdown),
  }
}
