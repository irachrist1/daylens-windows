import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import { getWebsiteSummariesForRange, getWebsiteVisitsForRange } from '../db/queries'
import { getTimelineDayPayload } from '../services/workBlocks'
import type { ArtifactRef, WorkContextBlock } from '../../shared/types'

export type WeeklyBriefIntent =
  | 'weekly_browsing_reading_brief'
  | 'weekly_topic_exploration_brief'
  | 'weekly_deepen_followup'

export type WeeklyBriefResponseMode = 'reading' | 'exploration' | 'deepen' | 'literal'

export interface WeeklyDateRange {
  fromMs: number
  toMs: number
  startDate: string
  endDate: string
  label: string
}

export interface WeeklyBriefContext {
  intent: WeeklyBriefIntent
  responseMode: WeeklyBriefResponseMode
  topic: string | null
  dateRange: WeeklyDateRange
  evidenceKey: string | null
}

export interface NamedEvidenceItem {
  title: string
  source: string
  kind: 'page' | 'video' | 'thread' | 'chat' | 'artifact'
  minutes: number
  confidence: number
  url: string | null
  domain: string | null
  note: string | null
}

export interface WeeklyWorkBlockSummary {
  id: string
  label: string
  day: string
  startTime: number
  endTime: number
  minutes: number
  apps: string[]
  artifacts: string[]
}

export interface WeeklyThemeCluster {
  label: string
  summary: string
  minutes: number
  evidence: NamedEvidenceItem[]
  supportingBlocks: WeeklyWorkBlockSummary[]
}

export interface WeeklyAmbientUsageItem {
  source: string
  minutes: number
  note: string
}

export interface WeeklyBriefEvidencePack {
  dateRange: WeeklyDateRange
  topic: string | null
  responseMode: WeeklyBriefResponseMode
  thesis: string
  whatThisSuggests: string | null
  namedEvidence: NamedEvidenceItem[]
  workBlocks: WeeklyWorkBlockSummary[]
  themes: WeeklyThemeCluster[]
  ambientUsage: WeeklyAmbientUsageItem[]
  caveats: string[]
  evidenceKey: string
}

const FACT_QUESTION_PATTERNS = [
  'how much time',
  'how many hours',
  'focus score',
  'top apps',
  'top app',
  'top sites',
  'top site',
  'most used app',
  'most used site',
  'distraction time',
  'what distracted me',
  'biggest distraction',
  'where did my time go',
]

const READING_PATTERNS = [
  'what have i read',
  'what did i read',
  'what have i watched',
  'what did i watch',
  'in my browsers',
  'in the browser',
  'in my browser',
]

const EXPLORATION_PATTERNS = [
  'what have i explored',
  'what did i explore',
  'what have i been exploring',
  'ai related',
  'last week in ai',
  'what have i looked at',
  'what stood out',
  'what themes',
]

const DEEPER_PATTERNS = [
  'go deeper',
  'gooo deep',
  'deeper',
  'try again',
  'whole week',
  'this whole week',
]

const LITERAL_PATTERNS = [
  'exactly what did i read',
  'exactly what have i read',
  'exactly what did i watch',
  'exactly what did i read this week',
]

const TOPIC_AI_PATTERNS = [
  ' ai',
  'ai ',
  'ai-related',
  'anthropic',
  'openai',
  'chatgpt',
  'claude',
  'codex',
  'cursor',
  'windsurf',
  'warp',
  'agent',
  'agents',
  'alignment',
  'prompt',
  'prompts',
  'gemini',
]

const NOISE_DOMAINS = new Set([
  'accounts.google.com',
  'auth.openai.com',
  'platform.claude.com',
])

const GENERIC_TITLE_PATTERNS = [
  /^chatgpt$/i,
  /^claude$/i,
  /^chatgpt\s*$/i,
  /^youtube$/i,
  /^x\.com$/i,
  /^x$/i,
  /^home(?:\s*\/\s*x)?$/i,
  /^\(\d+\)\s*home(?:\s*\/\s*x)?$/i,
  /^github$/i,
  /^linkedin$/i,
  /^canva$/i,
  /^web\.whatsapp$/i,
]

const AI_THEME_RULES: Array<{ label: string; keywords: string[]; summary: string }> = [
  {
    label: 'Agentic coding workflows',
    keywords: ['agent', 'agents', 'codex', 'cursor', 'windsurf', 'warp', 'terminal', 'claude code', 'devin'],
    summary: 'You kept coming back to AI coding agents and the products that package them into everyday development workflows.',
  },
  {
    label: 'Model limits and prompt quality',
    keywords: ['credit limits', 'context', 'prompt', 'prompts', 'limits', 'ux', 'issues', 'day view'],
    summary: 'A second thread was how these systems behave under real constraints: context windows, prompt quality, and interface friction.',
  },
  {
    label: 'Alignment and research',
    keywords: ['alignment', 'weak-to-strong', 'oversight', 'researcher', 'anthropic'],
    summary: 'This week also had a deeper research layer around alignment, scalable oversight, and how capable models should be supervised.',
  },
  {
    label: 'Applying AI to Daylens work',
    keywords: ['daylens', 'timeline', 'backend', 'redesign', 'ui', 'stabilize'],
    summary: 'You were not just reading about AI products from the outside; you were testing them inside live Daylens product work.',
  },
  {
    label: 'Commentary and market narrative',
    keywords: ['youtube', 'new yorker', 'trust issues', 'obsessed with', 'cursor killer', ' on x:'],
    summary: 'You also triangulated through commentary and social discourse, not just official docs and tool surfaces.',
  },
]

const GENERAL_THEME_RULES: Array<{ label: string; keywords: string[]; summary: string }> = [
  {
    label: 'Direct reading and reference',
    keywords: ['guide', 'docs', 'reference', 'use cases', 'read', 'overview'],
    summary: 'The clearest named pages point to direct reading and reference work rather than passive browsing.',
  },
  {
    label: 'Videos and commentary',
    keywords: ['youtube', 'video', 'podcast', 'interview'],
    summary: 'Part of the week was spent in commentary and video-based exploration alongside more direct reading.',
  },
  {
    label: 'Work-in-progress tabs',
    keywords: ['chatgpt', 'claude', 'issue', 'plan', 'redesign', 'prompt'],
    summary: 'A meaningful share of the browser activity looks like active work inside long-lived tabs rather than standalone articles.',
  },
]

function includesAny(normalized: string, patterns: string[]): boolean {
  return patterns.some((pattern) => normalized.includes(pattern))
}

function looksLikeFactQuestion(normalized: string): boolean {
  return includesAny(normalized, FACT_QUESTION_PATTERNS)
}

function looksLikeReadingQuestion(normalized: string): boolean {
  return includesAny(normalized, READING_PATTERNS)
}

function looksLikeExplorationQuestion(normalized: string): boolean {
  return includesAny(normalized, EXPLORATION_PATTERNS)
}

function looksLikeDeeperQuestion(normalized: string): boolean {
  return includesAny(normalized, DEEPER_PATTERNS)
}

function looksLikeLiteralReadingQuestion(normalized: string): boolean {
  return includesAny(normalized, LITERAL_PATTERNS)
}

function hasWeeklyScope(normalized: string): boolean {
  return normalized.includes('this week') || normalized.includes('last week') || normalized.includes('whole week')
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatRangeLabel(start: Date, endInclusive: Date): string {
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endLabel = endInclusive.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${startLabel} - ${endLabel}`
}

function rollingWeekRange(defaultDate: Date, label: 'this week' | 'last week'): WeeklyDateRange {
  const endInclusive = new Date(defaultDate.getFullYear(), defaultDate.getMonth(), defaultDate.getDate())
  const start = new Date(endInclusive)
  start.setDate(start.getDate() - 6)
  const endExclusive = new Date(endInclusive)
  endExclusive.setDate(endExclusive.getDate() + 1)
  return {
    fromMs: start.getTime(),
    toMs: endExclusive.getTime(),
    startDate: formatDateKey(start),
    endDate: formatDateKey(endInclusive),
    label: label === 'last week' ? `last week (${formatRangeLabel(start, endInclusive)})` : `this week (${formatRangeLabel(start, endInclusive)})`,
  }
}

function inferTopic(normalized: string, previous: WeeklyBriefContext | null): string | null {
  if (includesAny(normalized, TOPIC_AI_PATTERNS)) return 'AI'
  if (previous && (looksLikeDeeperQuestion(normalized) || looksLikeLiteralReadingQuestion(normalized) || normalized.includes('this whole week'))) {
    return previous.topic
  }
  return null
}

function topicKeywords(topic: string | null): string[] {
  if (!topic) return []
  if (topic.toLowerCase() === 'ai') {
    return ['ai', 'anthropic', 'openai', 'chatgpt', 'claude', 'codex', 'cursor', 'windsurf', 'warp', 'agent', 'agents', 'alignment', 'prompt', 'gemini']
  }
  return topic.toLowerCase().split(/\s+/).filter(Boolean)
}

function matchesTopic(text: string, topic: string | null): boolean {
  if (!topic) return false
  const normalized = text.toLowerCase()
  return topicKeywords(topic).some((keyword) => normalized.includes(keyword))
}

export function resolveWeeklyBriefContext(
  question: string,
  defaultDate: Date,
  previous: WeeklyBriefContext | null,
): WeeklyBriefContext | null {
  const normalized = question.trim().toLowerCase()
  if (!normalized || looksLikeFactQuestion(normalized)) return null

  if (previous && (looksLikeDeeperQuestion(normalized) || looksLikeLiteralReadingQuestion(normalized) || normalized.includes('this whole week'))) {
    const responseMode: WeeklyBriefResponseMode = looksLikeLiteralReadingQuestion(normalized)
      ? 'literal'
      : 'deepen'
    return {
      ...previous,
      intent: responseMode === 'deepen' ? 'weekly_deepen_followup' : previous.intent,
      responseMode,
    }
  }

  if (!hasWeeklyScope(normalized) && !looksLikeReadingQuestion(normalized) && !looksLikeExplorationQuestion(normalized)) {
    return null
  }

  const topic = inferTopic(normalized, previous)
  let responseMode: WeeklyBriefResponseMode | null = null
  if (looksLikeLiteralReadingQuestion(normalized)) {
    responseMode = 'literal'
  } else if (looksLikeReadingQuestion(normalized)) {
    responseMode = 'reading'
  } else if (looksLikeExplorationQuestion(normalized) || Boolean(topic)) {
    responseMode = 'exploration'
  }

  if (!responseMode) return null

  const label = normalized.includes('last week') ? 'last week' : 'this week'
  return {
    intent: responseMode === 'exploration' ? 'weekly_topic_exploration_brief' : 'weekly_browsing_reading_brief',
    responseMode,
    topic,
    dateRange: rollingWeekRange(defaultDate, label),
    evidenceKey: null,
  }
}

function normalizeEvidenceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim()
}

function titleLooksGeneric(title: string, domain: string): boolean {
  const normalized = title.trim()
  if (!normalized) return true
  if (GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(normalized))) return true
  const lower = normalized.toLowerCase()
  const simplifiedDomain = domain.toLowerCase().replace(/^www\./, '')
  return lower === simplifiedDomain || lower === simplifiedDomain.replace(/\.com$|\.org$|\.io$|\.net$/g, '')
}

function titleLooksNoisy(title: string | null, domain: string, url: string | null): boolean {
  const lowerTitle = title?.toLowerCase().trim() ?? ''
  const lowerUrl = url?.toLowerCase() ?? ''
  if (NOISE_DOMAINS.has(domain.toLowerCase())) return true
  if (!lowerTitle && !lowerUrl) return true
  return (
    lowerTitle.startsWith('sign in')
    || lowerTitle.startsWith('log in')
    || lowerTitle.includes('accountchooser')
    || lowerTitle === 'dashboard'
    || lowerUrl.includes('/signin')
    || lowerUrl.includes('/log-in')
    || lowerUrl.includes('/accountchooser')
  )
}

function inferEvidenceKind(domain: string, title: string): NamedEvidenceItem['kind'] {
  const lowerDomain = domain.toLowerCase()
  const lowerTitle = title.toLowerCase()
  if (lowerDomain.includes('youtube.com')) return 'video'
  if (lowerDomain === 'x.com' && lowerTitle.includes(' on x:')) return 'thread'
  if (lowerDomain.includes('chatgpt.com') || lowerDomain.includes('claude.ai')) return 'chat'
  return 'page'
}

function buildNamedEvidenceFromVisits(
  db: Database.Database,
  context: WeeklyBriefContext,
): { namedEvidence: NamedEvidenceItem[]; ambientUsage: WeeklyAmbientUsageItem[] } {
  const visits = getWebsiteVisitsForRange(db, context.dateRange.fromMs, context.dateRange.toMs)
  const siteSummaries = getWebsiteSummariesForRange(db, context.dateRange.fromMs, context.dateRange.toMs)
  const grouped = new Map<string, {
    title: string
    source: string
    kind: NamedEvidenceItem['kind']
    seconds: number
    confidence: number
    url: string | null
    domain: string | null
    note: string | null
  }>()

  for (const visit of visits) {
    if (titleLooksNoisy(visit.pageTitle, visit.domain, visit.url)) continue

    const rawTitle = visit.pageTitle?.trim() || visit.domain
    const generic = titleLooksGeneric(rawTitle, visit.domain)
    if (generic) continue

    const haystack = `${rawTitle} ${visit.domain} ${visit.url ?? ''}`
    const topicBoost = matchesTopic(haystack, context.topic)
    const key = visit.normalizedUrl?.trim() || visit.url?.trim() || `${visit.domain}:${normalizeEvidenceKey(rawTitle)}`
    const existing = grouped.get(key)
    const confidence = topicBoost ? 0.96 : 0.86
    if (existing) {
      existing.seconds += visit.durationSec
      existing.confidence = Math.max(existing.confidence, confidence)
      continue
    }
    grouped.set(key, {
      title: rawTitle,
      source: visit.domain,
      kind: inferEvidenceKind(visit.domain, rawTitle),
      seconds: visit.durationSec,
      confidence,
      url: visit.url,
      domain: visit.domain,
      note: inferEvidenceKind(visit.domain, rawTitle) === 'chat' ? 'active chat tab' : null,
    })
  }

  const namedEvidence = [...grouped.values()]
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence
      return right.seconds - left.seconds
    })
    .map((entry) => ({
      title: entry.title,
      source: entry.source,
      kind: entry.kind,
      minutes: Math.max(1, Math.round(entry.seconds / 60)),
      confidence: Number(entry.confidence.toFixed(2)),
      url: entry.url,
      domain: entry.domain,
      note: entry.note,
    }))

  const namedSources = new Set(namedEvidence.map((item) => item.source))
  const ambientUsage = siteSummaries
    .filter((site) => !namedSources.has(site.domain))
    .slice(0, 6)
    .map((site) => ({
      source: site.domain,
      minutes: Math.max(1, Math.round(site.totalSeconds / 60)),
      note: titleLooksGeneric(site.topTitle ?? site.domain, site.domain)
        ? 'mostly generic or repeated browser shell usage'
        : 'domain-level context without enough specific named pages',
    }))

  return { namedEvidence, ambientUsage }
}

function summarizeArtifact(artifact: ArtifactRef): NamedEvidenceItem | null {
  const title = artifact.displayTitle.trim()
  if (!title) return null
  if (titleLooksGeneric(title, artifact.host ?? artifact.displayTitle)) return null
  return {
    title,
    source: artifact.host ?? artifact.subtitle ?? artifact.artifactType,
    kind: 'artifact',
    minutes: Math.max(1, Math.round(artifact.totalSeconds / 60)),
    confidence: Number(Math.max(0.7, Math.min(0.98, artifact.confidence || 0.85)).toFixed(2)),
    url: artifact.url ?? null,
    domain: artifact.host ?? null,
    note: artifact.artifactType,
  }
}

function buildBlockSummary(block: WorkContextBlock, day: string): WeeklyWorkBlockSummary {
  return {
    id: block.id,
    label: block.label.current,
    day,
    startTime: block.startTime,
    endTime: block.endTime,
    minutes: Math.max(1, Math.round((block.endTime - block.startTime) / 60_000)),
    apps: block.topApps.slice(0, 4).map((app) => app.appName),
    artifacts: block.topArtifacts.slice(0, 4).map((artifact) => artifact.displayTitle).filter(Boolean),
  }
}

function buildWeeklyBlocks(
  db: Database.Database,
  context: WeeklyBriefContext,
): { workBlocks: WeeklyWorkBlockSummary[]; artifactEvidence: NamedEvidenceItem[] } {
  const blocks: WeeklyWorkBlockSummary[] = []
  const artifactEvidence: NamedEvidenceItem[] = []
  const start = new Date(context.dateRange.fromMs)

  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(start)
    date.setDate(start.getDate() + offset)
    const dateStr = formatDateKey(date)
    const payload = getTimelineDayPayload(db, dateStr, null)
    for (const block of payload.blocks) {
      const minutes = Math.max(1, Math.round((block.endTime - block.startTime) / 60_000))
      const blockText = [
        block.label.current,
        ...block.topArtifacts.map((artifact) => artifact.displayTitle),
        ...block.websites.map((site) => site.topTitle ?? site.domain),
        ...block.topApps.map((app) => app.appName),
      ].join(' ')
      const specificArtifactCount = block.topArtifacts.filter((artifact) => artifact.displayTitle.trim().length > 0).length
      const relevant = minutes >= 10 && (specificArtifactCount > 0 || matchesTopic(blockText, context.topic))
      if (!relevant) continue
      blocks.push(buildBlockSummary(block, dateStr))
      for (const artifact of block.topArtifacts.slice(0, 4)) {
        const item = summarizeArtifact(artifact)
        if (item) artifactEvidence.push(item)
      }
    }
  }

  const workBlocks = blocks
    .sort((left, right) => right.minutes - left.minutes)
    .slice(0, 10)

  return { workBlocks, artifactEvidence }
}

function dedupeEvidence(items: NamedEvidenceItem[]): NamedEvidenceItem[] {
  const deduped = new Map<string, NamedEvidenceItem>()
  for (const item of items) {
    const key = `${normalizeEvidenceKey(item.title)}:${item.source.toLowerCase()}`
    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, item)
      continue
    }
    existing.minutes = Math.max(existing.minutes, item.minutes)
    existing.confidence = Math.max(existing.confidence, item.confidence)
    if (!existing.url && item.url) existing.url = item.url
  }
  return [...deduped.values()]
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence
      return right.minutes - left.minutes
    })
}

function clusterRuleForText(text: string, topic: string | null): { label: string; summary: string } {
  const rules = topic?.toLowerCase() === 'ai' ? AI_THEME_RULES : GENERAL_THEME_RULES
  const normalized = text.toLowerCase()
  return rules.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword))) ?? {
    label: topic?.toLowerCase() === 'ai' ? 'Applied AI work' : 'Named browser work',
    summary: topic?.toLowerCase() === 'ai'
      ? 'The remaining evidence looks like active AI exploration tied to work in progress.'
      : 'The remaining evidence still points to named, specific browser work rather than pure ambient browsing.',
  }
}

function buildThemeClusters(
  namedEvidence: NamedEvidenceItem[],
  workBlocks: WeeklyWorkBlockSummary[],
  topic: string | null,
): WeeklyThemeCluster[] {
  const grouped = new Map<string, WeeklyThemeCluster>()

  for (const evidence of namedEvidence) {
    const rule = clusterRuleForText(`${evidence.title} ${evidence.source} ${evidence.note ?? ''}`, topic)
    const existing = grouped.get(rule.label) ?? {
      label: rule.label,
      summary: rule.summary,
      minutes: 0,
      evidence: [],
      supportingBlocks: [],
    }
    existing.minutes += evidence.minutes
    existing.evidence.push(evidence)
    grouped.set(rule.label, existing)
  }

  for (const block of workBlocks) {
    const rule = clusterRuleForText(`${block.label} ${block.artifacts.join(' ')} ${block.apps.join(' ')}`, topic)
    const existing = grouped.get(rule.label)
    if (!existing) continue
    existing.minutes += Math.round(block.minutes * 0.6)
    if (existing.supportingBlocks.length < 3) existing.supportingBlocks.push(block)
  }

  return [...grouped.values()]
    .map((cluster) => ({
      ...cluster,
      evidence: cluster.evidence
        .sort((left, right) => right.minutes - left.minutes)
        .slice(0, 4),
      supportingBlocks: cluster.supportingBlocks
        .sort((left, right) => right.minutes - left.minutes)
        .slice(0, 2),
    }))
    .sort((left, right) => right.minutes - left.minutes)
    .slice(0, 4)
}

function buildThesis(
  context: WeeklyBriefContext,
  themes: WeeklyThemeCluster[],
  namedEvidence: NamedEvidenceItem[],
): string {
  const topTheme = themes[0]?.label.toLowerCase()
  const secondTheme = themes[1]?.label.toLowerCase()
  if (context.responseMode === 'literal') {
    return 'Here are the clearest named pages, videos, and work artifacts from that week, separated from the generic browser noise.'
  }
  if (context.topic?.toLowerCase() === 'ai' && topTheme && secondTheme) {
    return `The clearest story of the week is AI as working infrastructure, with the strongest evidence around ${topTheme} and ${secondTheme}.`
  }
  if (topTheme) {
    return `The clearest story of the week centers on ${topTheme}, with the rest of the browsing clustering around adjacent work threads.`
  }
  if (namedEvidence[0]) {
    return `The clearest named evidence from the week centers on ${namedEvidence[0].title}, with a smaller set of related pages and tabs around it.`
  }
  return 'The named evidence from the week is thin, but there is still enough specific browsing history to sketch the main threads.'
}

function buildWhatThisSuggests(context: WeeklyBriefContext, themes: WeeklyThemeCluster[]): string | null {
  if (context.responseMode === 'literal') return null
  if (context.topic?.toLowerCase() === 'ai' && themes.length > 1) {
    return 'This looks less like casual AI browsing and more like evaluating how AI tools, limits, and workflows behave inside real product work.'
  }
  if (themes.length > 1) {
    return 'This looks more like a connected browsing thread than random tab churn.'
  }
  return null
}

function buildCaveats(
  context: WeeklyBriefContext,
  namedEvidence: NamedEvidenceItem[],
  ambientUsage: WeeklyAmbientUsageItem[],
): string[] {
  const caveats: string[] = []
  if (namedEvidence.length === 0) {
    caveats.push('The page-level evidence is thin, so any interpretation here should stay cautious.')
  }
  if (ambientUsage.length > 0) {
    caveats.push('Some of the browser time still sits in generic tabs or home feeds, so the named evidence is clearer than the total browsing totals.')
  }
  if (context.responseMode !== 'literal') {
    caveats.push('This summary reflects the strongest named pages and work artifacts, not every tab you opened.')
  }
  return caveats
}

export function buildWeeklyBriefEvidencePack(
  db: Database.Database,
  context: WeeklyBriefContext,
): WeeklyBriefEvidencePack {
  const visitEvidence = buildNamedEvidenceFromVisits(db, context)
  const blockEvidence = buildWeeklyBlocks(db, context)
  const namedEvidence = dedupeEvidence([
    ...visitEvidence.namedEvidence,
    ...blockEvidence.artifactEvidence,
  ]).slice(0, context.responseMode === 'literal' ? 18 : 12)
  const themes = buildThemeClusters(namedEvidence, blockEvidence.workBlocks, context.topic)
  const thesis = buildThesis(context, themes, namedEvidence)
  const whatThisSuggests = buildWhatThisSuggests(context, themes)
  const caveats = buildCaveats(context, namedEvidence, visitEvidence.ambientUsage)
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify({
      range: context.dateRange,
      topic: context.topic,
      mode: context.responseMode,
      titles: namedEvidence.map((item) => item.title),
      blocks: blockEvidence.workBlocks.map((block) => block.id),
    }))
    .digest('hex')
    .slice(0, 12)

  return {
    dateRange: context.dateRange,
    topic: context.topic,
    responseMode: context.responseMode,
    thesis,
    whatThisSuggests,
    namedEvidence,
    workBlocks: blockEvidence.workBlocks,
    themes,
    ambientUsage: visitEvidence.ambientUsage,
    caveats,
    evidenceKey: hash,
  }
}

export function buildWeeklyBriefScaffold(
  context: WeeklyBriefContext,
  pack: WeeklyBriefEvidencePack,
): string {
  const scaffold = {
    userIntent: context.intent,
    responseMode: context.responseMode,
    dateRange: pack.dateRange,
    topic: pack.topic,
    thesis: pack.thesis,
    whatThisSuggests: pack.whatThisSuggests,
    themes: pack.themes.map((theme) => ({
      label: theme.label,
      summary: theme.summary,
      minutes: theme.minutes,
      evidence: theme.evidence.map((evidence) => ({
        title: evidence.title,
        source: evidence.source,
        kind: evidence.kind,
        minutes: evidence.minutes,
        note: evidence.note,
      })),
      supportingBlocks: theme.supportingBlocks.map((block) => ({
        day: block.day,
        label: block.label,
        minutes: block.minutes,
        artifacts: block.artifacts,
      })),
    })),
    namedEvidence: pack.namedEvidence.map((item) => ({
      title: item.title,
      source: item.source,
      kind: item.kind,
      minutes: item.minutes,
      note: item.note,
    })),
    ambientUsage: pack.ambientUsage,
    caveats: pack.caveats,
  }

  return JSON.stringify(scaffold, null, 2)
}
