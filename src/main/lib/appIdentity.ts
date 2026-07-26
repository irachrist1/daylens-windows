import fs from 'node:fs'
import path from 'node:path'
import type { AppCategory } from '@shared/types'

interface NormalizationEntry {
  displayName: string
  defaultCategory: AppCategory
  capabilities?: string[]
}

interface NormalizationMap {
  aliases: Record<string, string>
  catalog: Record<string, NormalizationEntry>
}

const WEBSITE_DOMAIN_LABELS: Record<string, string> = {
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
  'reddit.com': 'Reddit',
  'stackoverflow.com': 'Stack Overflow',
  'linkedin.com': 'LinkedIn',
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'slack.com': 'Slack',
  'notion.so': 'Notion',
  'figma.com': 'Figma',
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'discord.com': 'Discord',
}

export interface CanonicalAppIdentity {
  canonicalAppId: string | null
  appInstanceId: string
  displayName: string
  rawAppName: string
  defaultCategory: AppCategory | null
  isBrowser: boolean
}

let cachedNormalizationMap: NormalizationMap | null = null
const CANONICAL_APP_CACHE_LIMIT = 2048
const canonicalAppCache = new Map<string, CanonicalAppIdentity>()

function normalizationCandidates(): string[] {
  return [
    ...(typeof process !== 'undefined' && process.resourcesPath
      ? [path.join(process.resourcesPath, 'app-normalization.v1.json')]
      : []),
    path.join(__dirname, '..', '..', 'shared', 'app-normalization.v1.json'),
    path.join(process.cwd(), 'shared', 'app-normalization.v1.json'),
  ]
}

function loadNormalizationMap(): NormalizationMap {
  if (cachedNormalizationMap) return cachedNormalizationMap

  for (const candidate of normalizationCandidates()) {
    try {
      cachedNormalizationMap = JSON.parse(fs.readFileSync(candidate, 'utf8')) as NormalizationMap
      return cachedNormalizationMap
    } catch {
      // Try the next candidate.
    }
  }

  cachedNormalizationMap = { aliases: {}, catalog: {} }
  return cachedNormalizationMap
}

function stripExecutableSuffix(value: string): string {
  return value
    .replace(/\.exe$/i, '')
    .replace(/\.app$/i, '')
    .trim()
}

// Windows reports an executable's verbose FileDescription as the app name —
// e.g. "Antigravity Agentic Desktop Application". For apps without a catalog
// entry, trim the generic "(Agentic) Desktop Application" tail so the rail
// shows the brand ("Antigravity"), not the installer's description.
function prettifyRawAppName(name: string): string {
  const cleaned = name.replace(/\s+(?:agentic\s+)?desktop\s+application$/i, '').trim()
  return cleaned.length >= 2 ? cleaned : name
}

function basenameLower(value: string): string {
  const base = path.basename(value).trim()
  return base.toLowerCase()
}

export function resolveCanonicalApp(bundleId: string, appName: string): CanonicalAppIdentity {
  const cacheKey = `${bundleId}\u0000${appName}`
  const cached = canonicalAppCache.get(cacheKey)
  if (cached) return cached

  const map = loadNormalizationMap()
  const trimmedBundleId = bundleId.trim()
  const trimmedName = appName.trim() || stripExecutableSuffix(path.basename(trimmedBundleId)) || 'Unknown app'
  const bundleBase = basenameLower(trimmedBundleId)
  const bundleBaseNoExe = stripExecutableSuffix(bundleBase).toLowerCase()
  const lowerName = trimmedName.toLowerCase()
  const lowerNameNoExe = stripExecutableSuffix(trimmedName).toLowerCase()

  const candidates = [
    trimmedBundleId,
    trimmedBundleId.toLowerCase(),
    bundleBase,
    bundleBaseNoExe,
    lowerName,
    lowerNameNoExe,
  ].filter(Boolean)

  let canonicalAppId: string | null = null
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase()
    const resolved = map.aliases[candidate]
      ?? map.aliases[normalizedCandidate]
      ?? (map.catalog[candidate] ? candidate : null)
      ?? (map.catalog[normalizedCandidate] ? normalizedCandidate : null)
    if (resolved) {
      canonicalAppId = resolved
      break
    }
  }

  const catalogEntry = canonicalAppId ? map.catalog[canonicalAppId] : null
  const identity = {
    canonicalAppId,
    appInstanceId: trimmedBundleId || lowerNameNoExe || trimmedName,
    displayName: catalogEntry?.displayName ?? prettifyRawAppName(trimmedName),
    rawAppName: trimmedName,
    defaultCategory: catalogEntry?.defaultCategory ?? null,
    isBrowser: catalogEntry?.capabilities?.includes('browser') ?? false,
  }
  if (canonicalAppCache.size >= CANONICAL_APP_CACHE_LIMIT) {
    canonicalAppCache.clear()
  }
  canonicalAppCache.set(cacheKey, identity)
  return identity
}

export function resolveCanonicalBrowser(browserBundleId: string | null | undefined): {
  canonicalBrowserId: string | null
  browserProfileId: string | null
} {
  if (!browserBundleId) {
    return {
      canonicalBrowserId: null,
      browserProfileId: null,
    }
  }

  const [baseId, profilePart] = browserBundleId.split(':', 2)
  const identity = resolveCanonicalApp(baseId, baseId)
  return {
    canonicalBrowserId: identity.canonicalAppId ?? baseId.trim().toLowerCase(),
    browserProfileId: profilePart?.trim() || 'default',
  }
}

// Query keys that must never be persisted. Tracking params are stripped for
// identity; secrets are stripped before any URL lands in storage.
const TRACKING_QUERY_KEY_RE = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i
const SENSITIVE_QUERY_KEY_RE =
  /^(?:access_token|id_token|refresh_token|auth_token|token|session(?:id|_id)?|sid|code|state|password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|jwt|auth|authorization|oauth[_-]?token)$/i

function rewriteUrlSearch(
  rawUrl: string,
  shouldDrop: (key: string) => boolean,
): string | null {
  try {
    const url = new URL(rawUrl)
    url.hash = ''

    const filteredParams = new URLSearchParams()
    for (const [key, value] of url.searchParams.entries()) {
      if (shouldDrop(key)) continue
      filteredParams.append(key, value)
    }
    url.search = filteredParams.toString()

    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host}${normalizedPath}${url.search ? `?${url.searchParams.toString()}` : ''}`
  } catch {
    return null
  }
}

/** Reopenable URL: fragments and sensitive query values removed; safe params kept. */
export function sanitizeUrlForPersistence(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  return rewriteUrlSearch(rawUrl, (key) => SENSITIVE_QUERY_KEY_RE.test(key))
}

/** Stable identity URL: also drops common tracking parameters. */
export function normalizeUrlForStorage(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  return rewriteUrlSearch(
    rawUrl,
    (key) => SENSITIVE_QUERY_KEY_RE.test(key) || TRACKING_QUERY_KEY_RE.test(key),
  )
}

export function pageKeyForUrl(rawUrl: string | null | undefined): string | null {
  const normalizedUrl = normalizeUrlForStorage(rawUrl)
  if (!normalizedUrl) return null

  try {
    const url = new URL(normalizedUrl)
    return `${url.host}${url.pathname}`.replace(/\/+$/, '') || url.host
  } catch {
    return normalizedUrl
  }
}

function normalizedDomainForDisplay(domain: string | null | undefined): string {
  return (domain ?? '').trim().toLowerCase().replace(/^www\./, '')
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function websiteDisplayLabel(domain: string): string {
  const normalizedDomain = normalizedDomainForDisplay(domain)
  if (!normalizedDomain) return domain

  if (WEBSITE_DOMAIN_LABELS[normalizedDomain]) return WEBSITE_DOMAIN_LABELS[normalizedDomain]
  const suffixMatch = Object.entries(WEBSITE_DOMAIN_LABELS).find(([key]) => normalizedDomain.endsWith(`.${key}`))
  if (suffixMatch) return suffixMatch[1]

  const base = normalizedDomain.split('.')[0] ?? normalizedDomain
  return base ? `${base[0].toUpperCase()}${base.slice(1)}` : domain
}

function stripNotificationBadgePrefix(title: string): string {
  return compactWhitespace(title.replace(/^\(\d+\)\s*/, ''))
}

// Some browsers leak a raw URL or query string into the page-title field — e.g.
// "9917state=%7B%22successPath%22..." — which must never surface as a readable
// "title". These are never human page titles; the caller falls back to the
// site name instead.
function looksLikeRawUrlParams(value: string): boolean {
  if (/%[0-9a-fA-F]{2}/.test(value)) return true            // percent-encoding
  if (/^https?:\/\//i.test(value) || value.includes('://')) return true
  const ampParts = value.split('&').filter((part) => part.includes('='))
  if (ampParts.length >= 2) return true                      // key=val&key=val
  if (!/\s/.test(value) && value.length > 24 && /[=%?&]/.test(value)) return true
  return false
}

// ─── Keyboard-mash detection ─────────────────────────────────────────────────
// A captured page title can carry a garbage string the person never meant to
// keep: a keyboard mash typed into a search box ("wwwtrttgbgggbsvcvgbjmk,l.;
// uk7u7i880p9o8i7u654321` - Google Search") lands verbatim in the title and
// then displays as a real page. These are structural, not dictionary, checks:
// no real word or name has a 7+ letter run without a vowel, four alternations
// between letter and digit runs, or punctuation sprinkled through its middle.

// Only tokens at least this long are judged at all; short tokens (acronyms,
// ticker symbols, model numbers) never trip the detector.
const MASH_MIN_TOKEN_LENGTH = 8
// Longest consonant run in ordinary language stays under 7 ("latchstring"
// reaches 6); treat "y" as a vowel so "rhythms" stays clean.
const MASH_MAX_CONSONANT_RUN = 6
// Letter→digit/digit→letter alternations: identifiers like "win32api" have 2;
// mashed rows of the number line produce many more.
const MASH_MAX_ALTERNATIONS = 3
// A run of 6+ characters that are horizontal neighbors on one QWERTY row
// ("qwertyuiop", "asdfgh") is a hand dragged across the keyboard; real words
// top out around 3 ("were", "tree").
const MASH_MAX_KEYBOARD_ROW_RUN = 5
const QWERTY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']

function longestKeyboardRowRun(token: string): number {
  let longest = 0
  for (const row of QWERTY_ROWS) {
    let run = 0
    let previousIndex = Number.NaN
    for (const char of token.toLowerCase()) {
      const index = row.indexOf(char)
      if (index < 0) {
        run = 0
        previousIndex = Number.NaN
        continue
      }
      run = Math.abs(index - previousIndex) === 1 ? Math.max(run, 1) + 1 : 1
      previousIndex = index
      longest = Math.max(longest, run)
    }
  }
  return longest
}

function tokenLooksMashed(token: string): boolean {
  const trimmed = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')
  if (trimmed.length < MASH_MIN_TOKEN_LENGTH) return false

  let consonantRun = 0
  let maxConsonantRun = 0
  let alternations = 0
  let mashPunctuation = 0
  let previousKind: 'letter' | 'digit' | 'other' | null = null
  for (const char of trimmed) {
    const isLetter = /[a-z]/i.test(char)
    const isDigit = /[0-9]/.test(char)
    const kind = isLetter ? 'letter' : isDigit ? 'digit' : 'other'
    if (isLetter && !/[aeiouy]/i.test(char)) {
      consonantRun += 1
      maxConsonantRun = Math.max(maxConsonantRun, consonantRun)
    } else {
      consonantRun = 0
    }
    if (previousKind && kind !== previousKind && kind !== 'other' && previousKind !== 'other') {
      alternations += 1
    }
    // Dots, hyphens, apostrophes, slashes and similar live inside real words
    // ("state-of-the-art", "node.js", "don't"); only row-of-keys punctuation
    // counts toward the mash signal.
    if (/[,;:`~^\\]/.test(char)) mashPunctuation += 1
    previousKind = kind
  }

  return maxConsonantRun > MASH_MAX_CONSONANT_RUN
    || alternations > MASH_MAX_ALTERNATIONS
    || mashPunctuation >= 2
    || longestKeyboardRowRun(trimmed) > MASH_MAX_KEYBOARD_ROW_RUN
}

/**
 * True when a title's subject reads as keyboard-mash garbage. The subject is
 * the first separator-delimited segment (search pages append the site name:
 * "<query> - Google Search"), and the segment counts as mash when mashed
 * tokens own at least half of its alphanumeric characters — so one stray
 * identifier inside a real sentence never hides the title.
 */
export function titleLooksLikeKeyboardMash(rawTitle: string | null | undefined): boolean {
  if (!rawTitle) return false
  const subject = compactWhitespace(rawTitle).split(/\s+[-–—|·]\s+/)[0] ?? ''
  if (!subject) return false
  const tokens = subject.split(/\s+/)
  let mashedChars = 0
  let totalChars = 0
  for (const token of tokens) {
    const alphanumeric = token.replace(/[^a-z0-9]/gi, '').length
    totalChars += alphanumeric
    if (tokenLooksMashed(token)) mashedChars += alphanumeric
  }
  return totalChars > 0 && mashedChars * 2 >= totalChars
}

export function normalizeWebsiteTitleForDisplay(
  domain: string,
  rawTitle: string | null | undefined,
): string | null {
  if (!rawTitle) return null

  const normalizedDomain = normalizedDomainForDisplay(domain)
  const domainLabel = websiteDisplayLabel(normalizedDomain)
  const cleaned = stripNotificationBadgePrefix(rawTitle)
  if (!cleaned) return null
  if (looksLikeRawUrlParams(cleaned)) return null
  // A mashed subject is not a human title; fall back to the site name so the
  // row still carries its real time without displaying garbage (DEV-239).
  if (titleLooksLikeKeyboardMash(cleaned)) return null

  const lower = cleaned.toLowerCase()
  const simplifiedDomain = normalizedDomain.replace(/\.(com|org|io|net|ai|dev|app|so)$/g, '')

  if (normalizedDomain === 'x.com' || normalizedDomain === 'twitter.com') {
    if (/^(x|x\.com|twitter|home(?:\s*\/\s*x)?)$/i.test(cleaned)) return domainLabel
    if (/^notifications?(?:\s*\/\s*x)?$/i.test(cleaned)) return `${domainLabel} notifications`
    if (/^messages?(?:\s*\/\s*x)?$/i.test(cleaned)) return `${domainLabel} messages`
    if (/^explore(?:\s*\/\s*x)?$/i.test(cleaned)) return `${domainLabel} explore`
    if (/^bookmarks?(?:\s*\/\s*x)?$/i.test(cleaned)) return `${domainLabel} bookmarks`
    if (/^home$/i.test(cleaned)) return domainLabel
  }

  if (
    /^(home|start page|dashboard)$/i.test(cleaned)
    || lower === normalizedDomain
    || lower === simplifiedDomain
    || lower === domainLabel.toLowerCase()
  ) {
    return domainLabel
  }

  return cleaned
}

export function titleLooksUseful(rawTitle: string | null | undefined): rawTitle is string {
  if (!rawTitle) return false
  const title = rawTitle.trim()
  if (!title) return false
  if (/^(new tab|untitled|home|start page)$/i.test(title)) return false
  if (title.length < 3) return false
  return true
}
