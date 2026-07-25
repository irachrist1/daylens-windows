// ---------------------------------------------------------------------------
// The `kind` axis — orthogonal to AppCategory, on every episode.
//
// Daylens has always known *what category* an activity is (development,
// browsing, entertainment…) but never *whether it is work at all*. That single
// missing distinction is the root cause of a whole class of defects: coding
// merged into a video block, a documentary tagged "execution", a leisure day
// scored for focus, and a YouTube title surfaced as "what mattered".
//
// `kind` fixes that. It is resolved from category + domain + app through the
// small, inspectable mapping below. Keep this file boring and declarative — it
// is meant to be read and audited, not clever.
// ---------------------------------------------------------------------------

import type { AppCategory, WorkKind } from './types'
import { FOCUSED_CATEGORIES } from './types'
import { policyForHost } from './domainPolicy'
import { categoryForDomain } from './domainCategories'

export type { WorkKind }

export function partitionDomainsWorkFirst<T>(
  rows: T[],
  domain: (row: T) => string | null | undefined,
): { work: T[]; leisure: T[] } {
  const work: T[] = []
  const leisure: T[] = []
  for (const row of rows) {
    if (kindForDomain(domain(row)) === 'leisure') leisure.push(row)
    else work.push(row)
  }
  return { work, leisure }
}

export interface KindSignal {
  category: AppCategory
  /** Whether the underlying app is a web browser (Safari, Chrome, Arc…). */
  isBrowser?: boolean
  /** Domains active during the activity, most-significant first. */
  domains?: Array<string | null | undefined>
}

export interface KindResolution {
  kind: WorkKind
  confidence: 'high' | 'medium' | 'low'
  // True when the activity carries no kind signal of its own (bare browsing
  // with no domain) and should inherit the surrounding episode's kind rather
  // than force a boundary. This is the spec's dual-use rule: a quick Google
  // search inside a coding stretch stays work; a 2-min tab-flip inside a video
  // stays leisure.
  neutral?: boolean
}

// Categories that are work by their nature, regardless of where they happen.
const WORK_CATEGORIES = new Set<AppCategory>([
  'development',
  'writing',
  'design',
  'aiTools',
  'research',
  'communication',
  'email',
  'meetings',
  'productivity',
])

// Categories that are leisure by their nature.
const LEISURE_CATEGORIES = new Set<AppCategory>([
  'entertainment',
  'social',
])

// Domains that are unambiguously work surfaces. A browser session sitting on
// one of these is work even if the categorizer only knew it was "browsing".
const WORK_DOMAIN_HOSTS = new Set<string>([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'stackoverflow.com',
  'stackexchange.com',
  'claude.ai',
  'chatgpt.com',
  'chat.openai.com',
  'platform.openai.com',
  'console.anthropic.com',
  'docs.google.com',
  'sheets.google.com',
  'colab.research.google.com',
  'notion.so',
  'linear.app',
  'figma.com',
  'vercel.com',
  'netlify.com',
  'localhost',
  'mail.google.com',
  'meet.google.com',
  'calendar.google.com',
  'developer.mozilla.org',
  'npmjs.com',
  'readthedocs.io',
])

const WORK_DOMAIN_SUFFIXES = [
  '.atlassian.net',
  '.slack.com',
  '.zoom.us',
  '.github.io',
  '.notion.site',
  '.sharepoint.com',
]

// Domains that are personal life-admin — neither work nor leisure.
const PERSONAL_DOMAIN_HOSTS = new Set<string>([
  'amazon.com',
  'ebay.com',
  'paypal.com',
  'chase.com',
  'wellsfargo.com',
  'bankofamerica.com',
  'venmo.com',
  'doordash.com',
  'ubereats.com',
  'booking.com',
  'airbnb.com',
  'expedia.com',
])

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null
  const trimmed = host.trim().toLowerCase()
  if (!trimmed) return null
  return trimmed.replace(/^www\./, '')
}

// Classify a single domain into the kind it implies, or null if it carries no
// strong signal on its own.
export function kindForDomain(host: string | null | undefined): WorkKind | null {
  const normalized = normalizeHost(host)
  if (!normalized) return null

  // Leisure/social sinks: domainPolicy already enumerates them.
  const policy = policyForHost(normalized)
  if (policy === 'entertainment' || policy === 'social_feed') {
    return 'leisure'
  }

  if (WORK_DOMAIN_HOSTS.has(normalized)) return 'work'
  for (const suffix of WORK_DOMAIN_SUFFIXES) {
    if (normalized.endsWith(suffix)) return 'work'
  }
  for (const host of WORK_DOMAIN_HOSTS) {
    if (normalized.endsWith(`.${host}`)) return 'work'
  }

  if (PERSONAL_DOMAIN_HOSTS.has(normalized)) return 'personal'
  for (const host of PERSONAL_DOMAIN_HOSTS) {
    if (normalized.endsWith(`.${host}`)) return 'personal'
  }

  // The site → category map (domainCategories.ts) knows far more work surfaces
  // than the short allowlist above — Canva, Figma, Linear, hosted consoles.
  // Before this, a whole browser-based design day on canva.com resolved to
  // "personal" because the domain carried "no signal" here while the category
  // layer knew exactly what it was (a day spent redesigning a website in the
  // browser once read as 50m work / 9h37m personal because of this gap).
  const category = categoryForDomain(normalized)
  if (category) {
    const kind = kindForCategory(category)
    if (kind === 'work' || kind === 'leisure') return kind
  }

  return null
}

export function kindForCategory(category: AppCategory): WorkKind {
  if (WORK_CATEGORIES.has(category)) return 'work'
  if (LEISURE_CATEGORIES.has(category)) return 'leisure'
  // browsing / system / uncategorized: neutral. Generic browsing with no
  // domain signal reads as personal, not work — we do not want to inflate the
  // work column with unattributed tab time.
  return 'personal'
}

// Resolve the kind of one activity from its category, domains, and whether it
// is a browser. Domains are the strongest signal for browser-hosted activity
// (a Safari session on youtube.com is leisure even though the categorizer only
// saw "browsing"); for a native work app the category wins and an incidental
// leaked tab title cannot flip it.
export function resolveKind(signal: KindSignal): KindResolution {
  const domains = (signal.domains ?? []).map(normalizeHost).filter((d): d is string => Boolean(d))
  const domainKinds = domains.map(kindForDomain).filter((k): k is WorkKind => k !== null)
  const categoryKind = kindForCategory(signal.category)

  const browserish = signal.isBrowser
    || signal.category === 'browsing'
    || signal.category === 'entertainment'
    || signal.category === 'social'
    || signal.category === 'research'

  if (browserish) {
    // A leisure domain anywhere in the window pulls the whole thing to leisure
    // — watching is watching even with a work tab open behind it.
    if (domainKinds.includes('leisure')) return { kind: 'leisure', confidence: 'high' }
    if (domainKinds.includes('work')) return { kind: 'work', confidence: 'high' }
    if (domainKinds.includes('personal')) return { kind: 'personal', confidence: 'medium' }
    // No domain signal. entertainment/social/research categories still carry a
    // real signal; bare "browsing" does not — it is neutral and inherits.
    if (signal.category === 'entertainment' || signal.category === 'social') {
      return { kind: 'leisure', confidence: 'medium' }
    }
    if (signal.category === 'research') return { kind: 'work', confidence: 'medium' }
    return { kind: 'personal', confidence: 'low', neutral: true }
  }

  // Native (non-browser) app: trust the category. A leaked leisure domain in a
  // dev session must not reclassify the coding as leisure. An uncategorized or
  // system app carries no signal of its own — treat it as neutral so a sparse
  // helper tool (an un-categorized AI agent, Finder) inherits the surrounding
  // work rather than fracturing it.
  if (signal.category === 'uncategorized' || signal.category === 'system') {
    return { kind: 'personal', confidence: 'low', neutral: true }
  }
  return { kind: categoryKind, confidence: 'high' }
}

const KIND_RANK: Record<WorkKind, number> = { idle: 0, personal: 1, leisure: 2, work: 3 }

// The dominant kind of a set of weighted activities (by seconds). Work wins
// ties so a block that is half coding, half watching reads as work.
export function dominantKind(weighted: Array<{ kind: WorkKind; seconds: number }>): WorkKind {
  const totals = new Map<WorkKind, number>()
  for (const { kind, seconds } of weighted) {
    totals.set(kind, (totals.get(kind) ?? 0) + Math.max(0, seconds))
  }
  let best: WorkKind = 'personal'
  let bestSeconds = -1
  for (const [kind, seconds] of totals) {
    if (seconds > bestSeconds || (seconds === bestSeconds && KIND_RANK[kind] > KIND_RANK[best])) {
      best = kind
      bestSeconds = seconds
    }
  }
  return best
}

interface BlockKindInput {
  kind?: WorkKind
  dominantCategory: AppCategory
  categoryDistribution?: Partial<Record<AppCategory, number>>
  topApps: Array<{ category: AppCategory; totalSeconds: number; isBrowser?: boolean }>
  websites: Array<{ domain: string; totalSeconds: number }>
}

// Categories that carry no work/leisure signal of their own inside a
// distribution. Browsing seconds are whatever the sites underneath them were;
// the site-weighted split already pulled the identifiable ones into their real
// categories, so what is left as "browsing" is genuinely unattributed.
const NEUTRAL_DISTRIBUTION_CATEGORIES = new Set<AppCategory>(['browsing', 'system', 'uncategorized'])

// Minimum non-neutral evidence before the distribution is trusted for the
// kind call. Below this, fall through to the domain/app resolution.
const DISTRIBUTION_KIND_MIN_SECONDS = 120

/** The kind implied by a block's site-weighted category distribution, or null
 *  when the distribution carries no real signal (all browsing/system). This is
 *  the same reconciled distribution that drives the block's category and color,
 *  so kind and category can no longer disagree: a block that is mostly design
 *  + development seconds is work, even when every one of those seconds
 *  happened inside a browser on a domain the short work-domain allowlist has
 *  never heard of. */
export function kindFromCategoryDistribution(
  distribution: Partial<Record<AppCategory, number>> | undefined,
): WorkKind | null {
  if (!distribution) return null
  const weighted: Array<{ kind: WorkKind; seconds: number }> = []
  let signalSeconds = 0
  for (const [category, seconds] of Object.entries(distribution) as Array<[AppCategory, number]>) {
    if (!seconds || seconds <= 0) continue
    if (NEUTRAL_DISTRIBUTION_CATEGORIES.has(category)) continue
    weighted.push({ kind: kindForCategory(category), seconds })
    signalSeconds += seconds
  }
  if (signalSeconds < DISTRIBUTION_KIND_MIN_SECONDS) return null
  return dominantKind(weighted)
}

// The kind to use for a block: the stored field when present (segmentation
// resolved it from per-session domains), else the site-weighted category
// distribution, else a recomputed fallback from top apps/sites for blocks
// that predate both.
export function effectiveBlockKind(block: BlockKindInput): WorkKind {
  if (block.kind) return block.kind
  // Same rule the block builder applies when it resolves the stored kind
  // (timeline.md §3.2/§3.6): a block whose intent-weighted dominant category
  // is focused work IS work — background-tab media seconds must not outvote
  // the foreground work on the rehydrated path either. Blocks read from the
  // store carry no `kind`, so without this a CI-migration block with a
  // Netflix tab open re-derived as leisure and rendered "Watching Netflix".
  if (FOCUSED_CATEGORIES.includes(block.dominantCategory)) return 'work'
  const fromDistribution = kindFromCategoryDistribution(block.categoryDistribution)
  if (fromDistribution) return fromDistribution
  return resolveBlockKind(block)
}

// The human tag for a block's type — "Focused work", "Meeting", "Research",
// "Leisure"… Derived from real facts (kind + dominant category), never a
// grade or a score. One vocabulary everywhere: the detail panel shows it and
// the day view filters by it.
export function blockTypeTag(block: BlockKindInput): string {
  if (block.dominantCategory === 'meetings') return 'Meeting'
  const kind = effectiveBlockKind(block)
  if (kind === 'leisure') return 'Leisure'
  if (kind === 'personal') return 'Personal'
  switch (block.dominantCategory) {
    case 'development':
    case 'writing':
    case 'design':
      return 'Focused work'
    case 'research':
    case 'aiTools':
      return 'Research'
    case 'communication':
    case 'email':
      return 'Comms'
    case 'browsing':
      return 'Browsing'
    default:
      return 'Work'
  }
}

// Resolve a whole block's kind from its apps and websites. Each native app run
// contributes its own category-kind; browser time is attributed to the kind of
// the domains it sat on (leisure youtube vs work github). The dominant kind by
// seconds wins. Used as the fallback for blocks that predate the stored field.
function resolveBlockKind(block: BlockKindInput): WorkKind {
  const weighted: Array<{ kind: WorkKind; seconds: number }> = []

  for (const app of block.topApps) {
    const browserish = app.isBrowser
      || app.category === 'browsing'
      || app.category === 'entertainment'
      || app.category === 'social'
    if (browserish) continue // attributed via websites below
    weighted.push({ kind: kindForCategory(app.category), seconds: app.totalSeconds })
  }

  for (const site of block.websites) {
    const domainKind = kindForDomain(site.domain)
    weighted.push({ kind: domainKind ?? 'personal', seconds: site.totalSeconds })
  }

  if (weighted.length === 0) {
    return kindForCategory(block.dominantCategory)
  }
  return dominantKind(weighted)
}
