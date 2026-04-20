import type {
  AppCategory,
  ArtifactRef,
  PageRef,
  WorkContextAppSummary,
  WorkContextBlock,
  WorkIntentPageKind,
  WorkIntentRole,
  WorkIntentSummary,
} from './types'

type BlockLike = Pick<
  WorkContextBlock,
  'dominantCategory' | 'topApps' | 'websites' | 'pageRefs' | 'documentRefs' | 'topArtifacts' | 'workflowRefs' | 'switchCount'
>

interface PageSignal {
  label: string
  domain: string
  domainLabel: string
  kind: WorkIntentPageKind
  specific: boolean
  generic: boolean
}

interface SubjectCandidate {
  label: string
  source: 'artifact' | 'page' | 'workflow' | 'domain'
}

const DOMAIN_LABELS: Record<string, string> = {
  'x.com': 'X (Twitter)',
  'twitter.com': 'X (Twitter)',
  'youtube.com': 'YouTube',
  'github.com': 'GitHub',
  'mail.google.com': 'Gmail',
  'gmail.com': 'Gmail',
  'docs.google.com': 'Google Docs',
  'meet.google.com': 'Google Meet',
  'calendar.google.com': 'Google Calendar',
  'drive.google.com': 'Google Drive',
  'notion.so': 'Notion',
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'figma.com': 'Figma',
  'linear.app': 'Linear',
  'trello.com': 'Trello',
  'jira.atlassian.com': 'Jira',
}

const SOCIAL_DOMAINS = new Set([
  'x.com',
  'twitter.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'reddit.com',
])

const EXECUTION_CATEGORIES = new Set<AppCategory>([
  'development',
  'writing',
  'design',
])

const RESEARCH_CATEGORIES = new Set<AppCategory>([
  'research',
  'aiTools',
  'browsing',
])

const COMMUNICATION_CATEGORIES = new Set<AppCategory>([
  'communication',
  'email',
])

const COORDINATION_CATEGORIES = new Set<AppCategory>([
  'meetings',
  'productivity',
])

const GENERIC_SUBJECTS = new Set([
  'development',
  'research',
  'communication',
  'coordination',
  'meetings',
  'browsing',
  'social',
  'work',
  'workflow',
  'app',
  'site',
  'website',
  'browser',
  'tab',
  'page',
])

const ENTERTAINMENT_DOMAINS = new Set([
  'goojara.to',
  'ww1.goojara.to',
  'web.wootly.ch',
  'netflix.com',
  'www.netflix.com',
  'primevideo.com',
  'www.primevideo.com',
  'hulu.com',
  'www.hulu.com',
  'max.com',
  'www.max.com',
  'disneyplus.com',
  'www.disneyplus.com',
])

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizedDomain(domain: string | null | undefined): string {
  return (domain ?? '').trim().toLowerCase().replace(/^www\./, '')
}

function domainDisplayLabel(domain: string | null | undefined): string {
  const normalized = normalizedDomain(domain)
  if (!normalized) return ''
  if (DOMAIN_LABELS[normalized]) return DOMAIN_LABELS[normalized]
  const suffixMatch = Object.entries(DOMAIN_LABELS).find(([key]) => normalized.endsWith(`.${key}`))
  if (suffixMatch) return suffixMatch[1]
  const base = normalized.split('.')[0] ?? normalized
  return base ? `${base[0].toUpperCase()}${base.slice(1)}` : normalized
}

function parsePath(page: Pick<PageRef, 'normalizedUrl' | 'url'>): string {
  const candidate = page.normalizedUrl ?? page.url
  if (!candidate) return '/'
  try {
    return new URL(candidate).pathname || '/'
  } catch {
    return '/'
  }
}

function looksLikeBrowserApp(app: WorkContextAppSummary): boolean {
  return app.isBrowser || /chrome|safari|firefox|edge|arc|dia|browser/i.test(app.appName)
}

function usefulText(value: string | null | undefined): string | null {
  const trimmed = compactWhitespace(value ?? '')
  return trimmed.length > 0 ? trimmed : null
}

function looksGenericSubject(label: string | null | undefined): boolean {
  const cleaned = usefulText(label)
  if (!cleaned) return true
  const lower = cleaned.toLowerCase()
  if (GENERIC_SUBJECTS.has(lower)) return true
  if (lower.length < 3) return true
  if (/^(x \(twitter\)|github|chatgpt|claude|gmail|google docs|google calendar|google meet)$/.test(lower)) return true
  if (/^(home|dashboard|inbox|calendar|messages|notifications|new tab|start page)$/.test(lower)) return true
  return false
}

function normalizeSubjectLabel(label: string | null | undefined): string | null {
  const cleaned = usefulText(label)
  if (!cleaned) return null

  const titleHead = cleaned.split(/\s+[—-]\s+/)[0]?.trim()
  if (titleHead && !looksGenericSubject(titleHead)) {
    return titleHead
  }

  const xAuthorMatch = cleaned.match(/^(.+?)\s+on X:/i)
  if (xAuthorMatch?.[1]) {
    const author = usefulText(xAuthorMatch[1])
    if (author && !looksGenericSubject(author)) return `${author} on X`
  }

  if (/\/\s*X$/i.test(cleaned) && cleaned.length > 72) return 'X (Twitter) thread'
  return cleaned
}

function pageLooksLikeNoise(page: PageSignal): boolean {
  const domain = normalizedDomain(page.domain)
  const lowerLabel = page.label.toLowerCase()
  if (page.generic && !page.specific) return true
  if (ENTERTAINMENT_DOMAINS.has(domain)) return true
  if (/^loading(?:\.\.\.|…)?$/i.test(lowerLabel) || /^working(?:\.\.\.|…)?$/i.test(lowerLabel)) return true
  if (domain === 'youtube.com' && lowerLabel === 'youtube') return true
  if (/^watch\s.+\(\d{4}\)$/i.test(page.label)) return true
  return false
}

function domainCandidateIsUseful(label: string | null | undefined, domain: string | null | undefined): boolean {
  const cleaned = usefulText(label)
  const normalized = normalizedDomain(domain)
  if (!cleaned || looksGenericSubject(cleaned)) return false
  if (ENTERTAINMENT_DOMAINS.has(normalized)) return false
  if (/^ww\d+$/i.test(cleaned) || /^app$/i.test(cleaned)) return false
  return true
}

function workflowLabelLooksLikeToolMix(label: string, block: BlockLike, pages: PageSignal[]): boolean {
  const cleaned = usefulText(label)
  if (!cleaned) return true
  const normalized = cleaned.toLowerCase()
  const appNames = new Set(
    block.topApps
      .map((app) => usefulText(app.appName)?.toLowerCase())
      .filter((name): name is string => Boolean(name)),
  )
  const domainLabels = new Set(
    pages
      .map((page) => usefulText(page.domainLabel)?.toLowerCase())
      .filter((label): label is string => Boolean(label)),
  )
  const segments = normalized.split(/\s*\+\s*/).map((segment) => segment.trim()).filter(Boolean)

  if (normalized.endsWith(' loop')) {
    const base = normalized.replace(/\s+loop$/, '')
    if (appNames.has(base) || domainLabels.has(base)) return true
  }

  return segments.length >= 2 && segments.every((segment) => appNames.has(segment) || domainLabels.has(segment))
}

function subjectFromArtifact(artifact: ArtifactRef | undefined): SubjectCandidate | null {
  const label = normalizeSubjectLabel(artifact?.displayTitle)
  if (!label || looksGenericSubject(label)) return null
  return { label, source: 'artifact' }
}

function classifyPage(page: PageRef): PageSignal {
  const domain = normalizedDomain(page.domain)
  const domainLabel = domainDisplayLabel(domain) || usefulText(page.domain) || 'Website'
  const label = usefulText(page.pageTitle ?? page.displayTitle) ?? domainLabel
  const lowerLabel = label.toLowerCase()
  const path = parsePath(page)

  if (domain === 'x.com' || domain === 'twitter.com') {
    if (/\/[^/]+\/status\/\d+/i.test(path)) {
      return { label, domain, domainLabel, kind: 'thread', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
    }
    if (/^\/search/i.test(path) || lowerLabel.includes('explore') || lowerLabel.includes('search')) {
      return { label, domain, domainLabel, kind: 'search', specific: !looksGenericSubject(label), generic: false }
    }
    if (/^\/messages/i.test(path) || lowerLabel.includes('messages')) {
      return { label, domain, domainLabel, kind: 'chat', specific: !looksGenericSubject(label), generic: false }
    }
    return { label: domainLabel, domain, domainLabel, kind: 'feed', specific: false, generic: true }
  }

  if (domain === 'github.com') {
    if (/^\/[^/]+\/[^/]+\/pull\/\d+/i.test(path)) {
      return { label, domain, domainLabel, kind: 'pull_request', specific: !looksGenericSubject(label), generic: false }
    }
    if (/^\/[^/]+\/[^/]+\/issues\/\d+/i.test(path)) {
      return { label, domain, domainLabel, kind: 'issue', specific: !looksGenericSubject(label), generic: false }
    }
    if (/^\/[^/]+\/[^/]+(?:\/|$)/i.test(path)) {
      return { label, domain, domainLabel, kind: 'repo', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
    }
  }

  if (domain === 'docs.google.com') {
    if (/^\/document\//i.test(path)) {
      return { label, domain, domainLabel, kind: 'doc', specific: !looksGenericSubject(label), generic: false }
    }
    if (/^\/spreadsheets\//i.test(path)) {
      return { label, domain, domainLabel, kind: 'sheet', specific: !looksGenericSubject(label), generic: false }
    }
    if (/^\/presentation\//i.test(path)) {
      return { label, domain, domainLabel, kind: 'slide', specific: !looksGenericSubject(label), generic: false }
    }
  }

  if (domain === 'notion.so' || domain.endsWith('.notion.site')) {
    return { label, domain, domainLabel, kind: 'doc', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
  }

  if (domain === 'figma.com') {
    return { label, domain, domainLabel, kind: 'design', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
  }

  if (domain === 'chatgpt.com' || domain === 'chat.openai.com' || domain === 'claude.ai') {
    return { label, domain, domainLabel, kind: 'chat', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
  }

  if (domain === 'mail.google.com' || domain === 'gmail.com') {
    return { label, domain, domainLabel, kind: 'mailbox', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
  }

  if (domain === 'calendar.google.com') {
    return { label, domain, domainLabel, kind: 'calendar', specific: !looksGenericSubject(label), generic: false }
  }

  if (domain === 'meet.google.com' || domain.endsWith('.zoom.us')) {
    return { label, domain, domainLabel, kind: 'meeting', specific: !looksGenericSubject(label), generic: false }
  }

  if (domain === 'youtube.com') {
    return { label, domain, domainLabel, kind: 'video', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
  }

  if (/google\.[a-z.]+$/.test(domain) && /^\/search/i.test(path)) {
    return { label, domain, domainLabel, kind: 'search', specific: !looksGenericSubject(label), generic: false }
  }

  if (domain === 'linear.app' || domain.endsWith('.atlassian.net') || domain === 'trello.com') {
    return { label, domain, domainLabel, kind: 'issue', specific: !looksGenericSubject(label), generic: looksGenericSubject(label) }
  }

  if (SOCIAL_DOMAINS.has(domain) && looksGenericSubject(label)) {
    return { label: domainLabel, domain, domainLabel, kind: 'feed', specific: false, generic: true }
  }

  if (!looksGenericSubject(label)) {
    return { label, domain, domainLabel, kind: 'article', specific: true, generic: false }
  }

  return { label: domainLabel, domain, domainLabel, kind: 'website', specific: false, generic: true }
}

function topUnique<T>(values: T[], limit: number): T[] {
  const unique: T[] = []
  for (const value of values) {
    if (unique.includes(value)) continue
    unique.push(value)
    if (unique.length >= limit) break
  }
  return unique
}

function appNamesFor(block: BlockLike, predicate: (app: WorkContextAppSummary) => boolean): string[] {
  return topUnique(
    block.topApps
      .filter(predicate)
      .map((app) => usefulText(app.appName))
      .filter((name): name is string => Boolean(name)),
    2,
  )
}

function pageSubjectCandidates(pages: PageSignal[]) {
  return pages
    .filter((page) => page.specific && !pageLooksLikeNoise(page))
    .map((page) => ({
      label: normalizeSubjectLabel(page.label),
      source: 'page' as const,
      kind: page.kind,
      domain: page.domain,
      social: SOCIAL_DOMAINS.has(page.domain),
    }))
    .filter((page): page is {
      label: string
      source: 'page'
      kind: WorkIntentPageKind
      domain: string
      social: boolean
    } => Boolean(page.label) && !looksGenericSubject(page.label))
}

function chooseSubject(block: BlockLike, role: WorkIntentRole, pages: PageSignal[]): SubjectCandidate | null {
  const documentCandidate = block.documentRefs
    .map((artifact) => subjectFromArtifact(artifact))
    .find((candidate): candidate is SubjectCandidate => Boolean(candidate))
  const pageCandidates = pageSubjectCandidates(pages)
  const workflowCandidate = block.workflowRefs
    .map((workflow) => usefulText(workflow.label))
    .find((label): label is string => (
      typeof label === 'string'
      && !looksGenericSubject(label)
      && !workflowLabelLooksLikeToolMix(label, block, pages)
    ))
  const domainCandidate = pages
    .find((page) => !pageLooksLikeNoise(page) && domainCandidateIsUseful(page.domainLabel, page.domain))
    ?.domainLabel
    ?? block.websites
      .map((site) => ({ label: domainDisplayLabel(site.domain), domain: site.domain }))
      .find((site) => domainCandidateIsUseful(site.label, site.domain))
      ?.label
  const nonSocialPageCandidate = pageCandidates.find((page) => !page.social)
  const executionPageCandidate = pageCandidates.find((page) => (
    page.kind === 'repo'
    || page.kind === 'pull_request'
    || page.kind === 'issue'
    || page.kind === 'doc'
    || page.kind === 'sheet'
    || page.kind === 'slide'
    || page.kind === 'design'
    || (!page.social && page.kind === 'article')
  ))

  if (role === 'execution') {
    return documentCandidate
      ?? executionPageCandidate
      ?? (workflowCandidate ? { label: workflowCandidate, source: 'workflow' } : null)
  }

  if (role === 'review') {
    return pageCandidates.find((page) => page.kind === 'pull_request' || page.kind === 'issue' || page.kind === 'repo')
      ?? documentCandidate
      ?? (workflowCandidate ? { label: workflowCandidate, source: 'workflow' } : null)
  }

  if (role === 'research') {
    return pageCandidates.find((page) => (
      page.kind === 'doc'
      || page.kind === 'sheet'
      || page.kind === 'slide'
      || page.kind === 'design'
      || page.kind === 'chat'
      || page.kind === 'search'
      || page.kind === 'repo'
      || page.kind === 'pull_request'
      || page.kind === 'issue'
    ))
      ?? nonSocialPageCandidate
      ?? documentCandidate
      ?? (workflowCandidate ? { label: workflowCandidate, source: 'workflow' } : null)
  }

  if (role === 'communication' || role === 'coordination') {
    return pageCandidates.find((page) => page.kind === 'chat' || page.kind === 'mailbox' || page.kind === 'meeting' || page.kind === 'calendar' || page.kind === 'issue')
      ?? documentCandidate
      ?? (workflowCandidate ? { label: workflowCandidate, source: 'workflow' } : null)
  }

  if (documentCandidate) return documentCandidate
  if (nonSocialPageCandidate) return nonSocialPageCandidate
  if (workflowCandidate) return { label: workflowCandidate, source: 'workflow' }
  if (domainCandidate) return { label: domainCandidate, source: 'domain' }
  return null
}

function roleFromSignals(block: BlockLike, pages: PageSignal[]): WorkIntentRole {
  const hasExecutionAnchor = block.topApps.some((app) => EXECUTION_CATEGORIES.has(app.category) && !looksLikeBrowserApp(app))
  const hasCommunicationAnchor = block.topApps.some((app) => COMMUNICATION_CATEGORIES.has(app.category))
  const hasCoordinationAnchor = block.topApps.some((app) => COORDINATION_CATEGORIES.has(app.category) && !looksLikeBrowserApp(app))
  const executionSeconds = block.topApps
    .filter((app) => EXECUTION_CATEGORIES.has(app.category) && !looksLikeBrowserApp(app))
    .reduce((sum, app) => sum + app.totalSeconds, 0)
  const browserSeconds = block.topApps
    .filter((app) => app.category === 'browsing' || looksLikeBrowserApp(app))
    .reduce((sum, app) => sum + app.totalSeconds, 0)
  const hasReviewPages = pages.some((page) => page.kind === 'pull_request' || page.kind === 'issue' || page.kind === 'repo')
  const hasResearchPages = pages.some((page) =>
    page.kind === 'article'
    || page.kind === 'search'
    || page.kind === 'thread'
    || page.kind === 'video'
    || page.kind === 'chat'
    || page.kind === 'doc'
    || page.kind === 'sheet'
    || page.kind === 'slide')
  const hasSpecificDocument = block.documentRefs.some((artifact) => !looksGenericSubject(artifact.displayTitle))
  const hasNonSocialWorkPage = pages.some((page) => (
    page.specific
    && !pageLooksLikeNoise(page)
    && !SOCIAL_DOMAINS.has(page.domain)
    && (
      page.kind === 'article'
      || page.kind === 'repo'
      || page.kind === 'pull_request'
      || page.kind === 'issue'
      || page.kind === 'doc'
      || page.kind === 'sheet'
      || page.kind === 'slide'
      || page.kind === 'design'
      || page.kind === 'chat'
      || page.kind === 'search'
    )
  ))
  const genericFeedsOnly = pages.length > 0 && pages.every((page) => page.kind === 'feed' && page.generic)
  const socialOnly = block.websites.length > 0 && block.websites.every((site) => SOCIAL_DOMAINS.has(normalizedDomain(site.domain)))
  const mixedBrowserBlock = hasExecutionAnchor && (block.dominantCategory === 'browsing' || block.dominantCategory === 'research')
  const browserDominated = browserSeconds > executionSeconds * 1.1

  if (block.dominantCategory === 'meetings') return 'coordination'

  if (!hasExecutionAnchor && (block.dominantCategory === 'communication' || block.dominantCategory === 'email' || hasCommunicationAnchor)) {
    return 'communication'
  }

  if (!hasExecutionAnchor && (hasCoordinationAnchor || pages.some((page) => page.kind === 'calendar' || page.kind === 'meeting'))) {
    return 'coordination'
  }

  if (mixedBrowserBlock && !hasSpecificDocument) {
    if (genericFeedsOnly || socialOnly) return 'ambient'
    if (browserDominated) {
      if (hasReviewPages && !hasResearchPages) return 'review'
      return hasResearchPages || hasNonSocialWorkPage ? 'research' : 'ambiguous'
    }
    if (!hasNonSocialWorkPage && !hasReviewPages) {
      return hasResearchPages ? 'research' : 'ambiguous'
    }
  }

  if (hasExecutionAnchor || EXECUTION_CATEGORIES.has(block.dominantCategory) || (block.dominantCategory === 'productivity' && hasSpecificDocument)) {
    if (!hasExecutionAnchor && hasReviewPages && !hasSpecificDocument && !hasResearchPages) return 'review'
    return hasReviewPages && !hasSpecificDocument && block.switchCount <= 2 ? 'review' : 'execution'
  }

  if (hasReviewPages) return 'review'

  if (RESEARCH_CATEGORIES.has(block.dominantCategory) || hasResearchPages) {
    if (genericFeedsOnly || (socialOnly && !hasSpecificDocument && !hasResearchPages)) return 'ambient'
    return 'research'
  }

  if (block.dominantCategory === 'social' || genericFeedsOnly || socialOnly) return 'ambient'
  if (block.dominantCategory === 'productivity') return 'coordination'
  if (hasCommunicationAnchor) return 'communication'
  return 'ambiguous'
}

function summaryFor(role: WorkIntentRole, subject: string | null): string {
  switch (role) {
    case 'execution':
      return subject ? `Execution work on ${subject}` : 'Execution work'
    case 'research':
      return subject ? `Research/context gathering around ${subject}` : 'Research/context gathering'
    case 'communication':
      return subject ? `Communication around ${subject}` : 'Communication work'
    case 'review':
      return subject ? `Reviewing ${subject}` : 'Review work'
    case 'coordination':
      return subject ? `Coordination around ${subject}` : 'Coordination work'
    case 'ambient':
      return subject ? `Ambient browsing on ${subject}` : 'Ambient browsing'
    case 'ambiguous':
    default:
      return subject ? `Mixed work touching ${subject}` : 'Mixed work with unclear intent'
  }
}

function confidenceFor(
  role: WorkIntentRole,
  block: BlockLike,
  subject: SubjectCandidate | null,
  pages: PageSignal[],
): number {
  let confidence = 0.42
  if (subject && subject.source !== 'domain') confidence += 0.18
  if (pages.some((page) => page.specific)) confidence += 0.12
  if (block.topApps.some((app) => EXECUTION_CATEGORIES.has(app.category) && !looksLikeBrowserApp(app))) confidence += 0.1
  if (role === 'research' && pages.some((page) => page.kind === 'search' || page.kind === 'thread' || page.kind === 'article' || page.kind === 'chat')) confidence += 0.08
  if (role === 'communication' || role === 'coordination' || role === 'review') confidence += 0.06
  if (role === 'ambient' && pages.every((page) => page.generic)) confidence -= 0.04
  if (role === 'ambiguous') confidence = Math.min(confidence, 0.46)
  return Math.max(0.25, Math.min(0.92, Math.round(confidence * 100) / 100))
}

function rationaleFor(
  role: WorkIntentRole,
  block: BlockLike,
  subject: SubjectCandidate | null,
  pages: PageSignal[],
): string[] {
  const reasons: string[] = []

  if (subject && subject.source !== 'domain') {
    reasons.push(`Named evidence: ${subject.label}`)
  }

  const executionApps = appNamesFor(block, (app) => EXECUTION_CATEGORIES.has(app.category) && !looksLikeBrowserApp(app))
  if (executionApps.length > 0) {
    reasons.push(`Execution tools: ${executionApps.join(', ')}`)
  }

  const coordinationApps = appNamesFor(block, (app) => COMMUNICATION_CATEGORIES.has(app.category) || COORDINATION_CATEGORIES.has(app.category))
  if ((role === 'communication' || role === 'coordination') && coordinationApps.length > 0) {
    reasons.push(`Coordination tools: ${coordinationApps.join(', ')}`)
  }

  const pageEvidence = topUnique(
    pages
      .filter((page) => page.specific || page.kind === 'feed')
      .map((page) => page.specific ? page.label : page.domainLabel),
    2,
  )
  if (pageEvidence.length > 0) {
    const prefix = role === 'ambient'
      ? 'Browser evidence stayed generic'
      : role === 'research'
        ? 'Browser evidence'
        : 'Supporting pages'
    reasons.push(`${prefix}: ${pageEvidence.join(', ')}`)
  }

  if (reasons.length === 0 && block.websites[0]) {
    reasons.push(`Top web source: ${domainDisplayLabel(block.websites[0].domain)}`)
  }

  return reasons.slice(0, 3)
}

export function inferWorkIntent(block: BlockLike): WorkIntentSummary {
  const pages = block.pageRefs.map((page) => classifyPage(page))
  const role = roleFromSignals(block, pages)
  const subject = chooseSubject(block, role, pages)

  return {
    role,
    subject: subject?.label ?? null,
    confidence: confidenceFor(role, block, subject, pages),
    summary: summaryFor(role, subject?.label ?? null),
    rationale: rationaleFor(role, block, subject, pages),
    pageKinds: topUnique(pages.map((page) => page.kind), 4),
  }
}
