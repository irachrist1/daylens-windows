import type { AppCategory, AppSession, AppUsageSummary, WebsiteSummary } from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

export type WorkEvidenceSource = 'appSummary' | 'session' | 'website'

export interface WorkEvidenceSignal {
  source: WorkEvidenceSource
  label: string
  category: AppCategory
  seconds: number
  count: number
  confidence: number
}

export interface WorkEvidenceTaskSummary {
  label: string
  category: AppCategory
  confidence: number
}

export interface WorkEvidenceSummary {
  task: WorkEvidenceTaskSummary
  signals: WorkEvidenceSignal[]
  evidenceText: string
  totalSeconds: number
  focusedSeconds: number
}

export interface WorkEvidenceInput {
  appSummaries?: readonly AppUsageSummary[]
  websiteSummaries?: readonly WebsiteSummary[]
  sessions?: readonly AppSession[]
}

const WEBSITE_CATEGORY_RULES: Array<{ category: AppCategory; patterns: RegExp[] }> = [
  { category: 'aiTools', patterns: [/chatgpt/i, /claude/i, /copilot/i, /perplexity/i, /gemini/i] },
  { category: 'development', patterns: [/github/i, /gitlab/i, /stackoverflow/i, /developer/i, /docs?/i] },
  { category: 'communication', patterns: [/slack/i, /teams/i, /zoom/i, /meet/i, /discord/i] },
  { category: 'email', patterns: [/mail/i, /gmail/i, /outlook/i] },
  { category: 'research', patterns: [/wikipedia/i, /scholar/i, /arxiv/i, /research/i] },
  { category: 'writing', patterns: [/docs\.google/i, /notion/i, /medium/i, /substack/i] },
  { category: 'social', patterns: [/x\.com/i, /twitter/i, /reddit/i, /facebook/i, /instagram/i, /linkedin/i] },
  { category: 'browsing', patterns: [/.*/] },
]

function prettyCategory(category: AppCategory): string {
  if (category === 'aiTools') return 'AI tools'
  return category
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ')
}

function inferWebsiteCategory(site: WebsiteSummary): AppCategory {
  const haystack = `${site.domain} ${site.topTitle ?? ''}`.trim()
  for (const rule of WEBSITE_CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      return rule.category
    }
  }
  return 'browsing'
}

function labelForWebsite(site: WebsiteSummary): string {
  const title = site.topTitle?.trim()
  if (title) return title

  const domain = site.domain.replace(/^www\./, '')
  const base = domain.split('.')[0] ?? domain
  if (!base) return site.domain
  return `${base[0].toUpperCase()}${base.slice(1)}`
}

function collectAppSignals(appSummaries: readonly AppUsageSummary[]): WorkEvidenceSignal[] {
  return appSummaries.map((summary) => ({
    source: 'appSummary',
    label: summary.appName,
    category: summary.category,
    seconds: summary.totalSeconds,
    count: summary.sessionCount ?? 1,
    confidence: clampConfidence(summary.isFocused ? 0.95 : 0.75),
  }))
}

function collectSessionSignals(sessions: readonly AppSession[]): WorkEvidenceSignal[] {
  const grouped = new Map<string, WorkEvidenceSignal>()

  for (const session of sessions) {
    const key = `${session.bundleId}::${session.appName}::${session.category}`
    const existing = grouped.get(key)
    if (existing) {
      existing.seconds += session.durationSeconds
      existing.count += 1
      existing.confidence = clampConfidence(Math.max(existing.confidence, session.isFocused ? 0.9 : 0.7))
      continue
    }

    grouped.set(key, {
      source: 'session',
      label: session.appName,
      category: session.category,
      seconds: session.durationSeconds,
      count: 1,
      confidence: clampConfidence(session.isFocused ? 0.9 : 0.7),
    })
  }

  return Array.from(grouped.values())
}

function collectWebsiteSignals(websiteSummaries: readonly WebsiteSummary[]): WorkEvidenceSignal[] {
  return websiteSummaries.map((site) => ({
    source: 'website',
    label: labelForWebsite(site),
    category: inferWebsiteCategory(site),
    seconds: site.totalSeconds,
    count: site.visitCount,
    confidence: clampConfidence(site.totalSeconds >= 10 * 60 ? 0.8 : 0.6),
  }))
}

function scoreSignal(signal: WorkEvidenceSignal): number {
  const focusedBonus = FOCUSED_CATEGORIES.includes(signal.category) ? 1.1 : 1
  const sourceWeight = signal.source === 'appSummary' ? 1.25 : signal.source === 'session' ? 1.1 : 0.8
  return signal.seconds * sourceWeight * focusedBonus + signal.count * 20 + signal.confidence * 60
}

function categorySummary(signals: readonly WorkEvidenceSignal[]): { category: AppCategory; seconds: number }[] {
  const totals = new Map<AppCategory, number>()
  for (const signal of signals) {
    totals.set(signal.category, (totals.get(signal.category) ?? 0) + signal.seconds)
  }

  return Array.from(totals.entries())
    .sort((left, right) => {
      if (right[1] === left[1]) return left[0].localeCompare(right[0])
      return right[1] - left[1]
    })
    .map(([category, seconds]) => ({ category, seconds }))
}

function taskLabelForCategory(category: AppCategory, signals: readonly WorkEvidenceSignal[]): string {
  const topLabels = signals.slice(0, 3).map((signal) => signal.label.toLowerCase())
  if (category === 'development') return topLabels.some((label) => label.includes('github') || label.includes('code')) ? 'Development work' : 'Coding work'
  if (category === 'aiTools') return 'AI-assisted work'
  if (category === 'communication') return 'Communication work'
  if (category === 'email') return 'Email work'
  if (category === 'research') return 'Research work'
  if (category === 'writing') return 'Writing work'
  if (category === 'social') return 'Social activity'
  if (category === 'browsing') return 'Browsing session'
  return `${prettyCategory(category)} work`
}

function summarizeSignals(signals: readonly WorkEvidenceSignal[], limit: number): string {
  if (signals.length === 0) return 'No strong evidence.'

  const parts = signals.slice(0, limit).map((signal) => `${signal.label} (${formatDuration(signal.seconds)})`)
  return `Evidence: ${parts.join(', ')}.`
}

export function deriveWorkEvidenceSummary(input: WorkEvidenceInput): WorkEvidenceSummary {
  const signals = [
    ...collectAppSignals(input.appSummaries ?? []),
    ...collectSessionSignals(input.sessions ?? []),
    ...collectWebsiteSignals(input.websiteSummaries ?? []),
  ]
    .sort((left, right) => {
      const difference = scoreSignal(right) - scoreSignal(left)
      if (difference !== 0) return difference
      if (right.seconds !== left.seconds) return right.seconds - left.seconds
      if (left.source !== right.source) return left.source.localeCompare(right.source)
      return normalizeLabel(left.label).localeCompare(normalizeLabel(right.label))
    })

  const totalSeconds = signals.reduce((sum, signal) => sum + signal.seconds, 0)
  const focusedSeconds = signals
    .filter((signal) => FOCUSED_CATEGORIES.includes(signal.category))
    .reduce((sum, signal) => sum + signal.seconds, 0)

  const categoryTotals = categorySummary(signals)
  const primaryCategory = categoryTotals[0]?.category ?? 'uncategorized'
  const task = {
    label: taskLabelForCategory(primaryCategory, signals),
    category: primaryCategory,
    confidence: clampConfidence(categoryTotals.length === 0 || totalSeconds === 0 ? 0 : categoryTotals[0].seconds / totalSeconds),
  }

  const evidenceText = `${task.label}. ${summarizeSignals(signals, 4)}`

  return {
    task,
    signals: signals.slice(0, 8),
    evidenceText,
    totalSeconds,
    focusedSeconds,
  }
}

export function formatWorkEvidenceSummary(summary: WorkEvidenceSummary): string {
  const taskPart = `Likely task: ${summary.task.label}.`
  const evidencePart = summary.evidenceText.trim()
  const totalsPart = `Tracked: ${formatDuration(summary.totalSeconds)} total, ${formatDuration(summary.focusedSeconds)} focused.`
  return [taskPart, evidencePart, totalsPart].join(' ')
}
