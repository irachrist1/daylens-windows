import { extractDisplayProse, looksLikeStructuredDump } from './appDetailAccount'

export const THIN_APP_NARRATIVE_SUMMARY = 'Daylens has only thin app-specific signal for this app.'

export function appDetailRangeKey(daysOrDate: number | string, anchorDate: string): string {
  return typeof daysOrDate === 'string'
    ? `1d:${daysOrDate}`
    : `${daysOrDate}d:${anchorDate}`
}

export function appNarrativeScopeKey(canonicalAppId: string, rangeKey: string): string {
  return `app:${canonicalAppId}:${rangeKey}`
}

export function isThinAppNarrative(summary: string | null | undefined): boolean {
  return summary?.trim() === THIN_APP_NARRATIVE_SUMMARY
}

function unwrapCodeFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced?.[1]?.trim() ?? raw.trim()
}

function salvageSummaryField(raw: string): string | null {
  const field = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!field) return null
  try {
    const summary = (JSON.parse(`"${field[1]}"`) as string).trim()
    return summary && !looksLikeStructuredDump(summary) && !/^[{[]/.test(summary) ? summary : null
  } catch {
    return null
  }
}

export function parseSurfaceSummaryResult(
  raw: string,
  fallbackTitle: string,
): { title: string; summary: string } | null {
  const normalized = unwrapCodeFence(raw)
  if (!normalized) return null

  try {
    const parsed = JSON.parse(normalized) as { title?: unknown; summary?: unknown }
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
    if (!summary || looksLikeStructuredDump(summary) || /^[{[]/.test(summary)) return null
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() && !looksLikeStructuredDump(parsed.title)
        ? parsed.title.trim()
        : fallbackTitle,
      summary,
    }
  } catch {
    if (looksLikeStructuredDump(normalized) || /"summary"\s*:/.test(normalized)) {
      const salvaged = salvageSummaryField(normalized)
      if (!salvaged) return null
      return { title: fallbackTitle, summary: salvaged }
    }
    if (looksLikeStructuredDump(normalized)) return null
    return { title: fallbackTitle, summary: normalized }
  }
}

function citationTokens(title: string): string[] {
  const lower = title.toLowerCase().trim()
  const tokens = new Set<string>([lower])
  const withoutExt = lower.replace(/\.[a-z0-9]{1,8}$/i, '')
  if (withoutExt !== lower && withoutExt.length >= 3) tokens.add(withoutExt)
  if (lower.includes('.')) {
    const stem = lower.replace(/^www\./, '').split('.')[0]
    if (stem && stem.length >= 3) tokens.add(stem)
  }
  return [...tokens]
}

function citedEvidenceTitles(summary: string, evidenceTitles: readonly string[]): string[] {
  const haystack = summary.toLowerCase()
  const cited: string[] = []
  const seen = new Set<string>()
  for (const rawTitle of evidenceTitles) {
    const title = rawTitle.trim()
    if (title.length < 3 || /^(files|pages|projects)$/i.test(title)) continue
    for (const token of citationTokens(title)) {
      if (seen.has(token) || !haystack.includes(token)) continue
      seen.add(token)
      cited.push(title)
      break
    }
  }
  return cited
}

export function narrativeCitesEvidence(summary: string, evidenceTitles: readonly string[]): boolean {
  const titles = evidenceTitles.map((title) => title.trim()).filter((title) => title.length >= 3)
  if (titles.length === 0) return false
  return citedEvidenceTitles(summary, titles).length >= (titles.length >= 2 ? 2 : 1)
}

function evidenceNarrative(titles: readonly string[]): string {
  const subjects = titles.length === 1
    ? titles[0]
    : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`
  return `Your recorded activity included ${subjects}.`
}

export function selectVisibleAppNarrative(
  summary: string | null | undefined,
  evidenceTitles: readonly string[],
): string | null {
  if (!summary || isThinAppNarrative(summary)) return null
  const prose = extractDisplayProse(summary)
  if (!prose) return null
  if (evidenceTitles.length === 0) return null
  if (!narrativeCitesEvidence(prose, evidenceTitles)) return null
  const citedTitles = citedEvidenceTitles(prose, evidenceTitles)
  return evidenceNarrative(citedTitles)
}
