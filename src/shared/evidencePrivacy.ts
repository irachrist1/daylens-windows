import {
  isAppExcluded,
  isSiteExcluded,
  type TrackingControlsState,
} from './trackingControls'
import { isSystemNoiseApp } from './systemNoise'

type JsonRecord = Record<string, unknown>

function asString(record: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

// A bare hostname: labels joined by dots, no scheme, no path, no spaces. Used
// to recognise a domain that a resolver stuffed into an app-name-shaped field
// (search "page" hits set appName = the visited domain), so a null-url page hit
// for an excluded site is still caught by site exclusion.
const BARE_HOST_RE = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/i

function domainFromRecord(record: JsonRecord): string | null {
  const direct = asString(record, 'domain', 'host')
  if (direct) return direct
  const rawUrl = asString(record, 'url', 'normalizedUrl')
  if (rawUrl) {
    try {
      return new URL(rawUrl).hostname
    } catch {
      // fall through to the app-name-as-host check
    }
  }
  const nameLike = asString(record, 'appName', 'application', 'ownerAppName', 'displayName')
  if (nameLike && BARE_HOST_RE.test(nameLike)) return nameLike
  return null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Bounded match so a short exclusion like "Arc" redacts "Arc was open" but
// never "architecture". The token must sit on a word boundary (start/end or a
// non-alphanumeric neighbour). Tokens under 3 chars are too noisy to redact.
// App names are proper nouns and many collide with ordinary words ("Messages",
// "Notes", "Music"), so app tokens match case-sensitively — excluding the app
// "Messages" must not redact a label saying "checking messages". Site tokens
// stay case-insensitive: hosts are lowercase while prose brands vary
// ("YouTube" for youtube.com).
function containsBoundedToken(value: string, rawToken: string, caseSensitive = false): boolean {
  const trimmed = rawToken.trim().replace(/^www\./i, '')
  const token = caseSensitive ? trimmed : trimmed.toLowerCase()
  if (token.length < 3) return false
  return new RegExp(
    `(^|[^a-zA-Z0-9])${escapeRegex(token)}(?=$|[^a-zA-Z0-9])`,
    caseSensitive ? '' : 'i',
  ).test(value)
}

// A site exclusion has to redact more than the literal host: derived block
// labels and page titles name the brand, not the domain ("Watching YouTube",
// "… - YouTube"), so excluding "youtube.com" must also redact the bare token
// "youtube". We expand a registrable 2-label host (brand.tld) to its leading
// label; a multi-label host is a specific subdomain the user targeted, so we
// keep only the full host to avoid nuking the parent brand (excluding
// "docs.google.com" must not redact every "Google"). Bounded matching still
// applies, so "youtube" never touches "youtuber".
// Common second-level labels in compound public suffixes (bbc.co.uk,
// abc.com.au, foo.co.jp). Not a full PSL — just enough that the registrable
// brand label is found for the everyday ccTLD cases.
const COMPOUND_SUFFIX_SLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])

function siteExclusionTokens(entry: string): string[] {
  const host = entry.trim().toLowerCase().replace(/^www\./, '')
  if (!host) return []
  const tokens = [host]
  const labels = host.split('.')
  // Registrable brand label: the label just left of the public suffix.
  // "youtube.com" → youtube; "bbc.co.uk" → bbc; but a deeper subdomain the
  // user explicitly targeted ("docs.google.com") keeps only the full host so
  // we never redact the parent brand.
  let brandIdx = -1
  if (labels.length === 2) brandIdx = 0
  else if (labels.length === 3 && labels[1].length <= 3 && COMPOUND_SUFFIX_SLDS.has(labels[1])) brandIdx = 0
  if (brandIdx >= 0 && labels[brandIdx].length >= 3) tokens.push(labels[brandIdx])
  return tokens
}

function containsExcludedText(value: string, controls: TrackingControlsState): boolean {
  return controls.excludedApps.some((entry) => containsBoundedToken(value, entry, true))
    || controls.excludedSites.some((entry) =>
      siteExclusionTokens(entry).some((token) => containsBoundedToken(value, token)))
}

function filterValue(value: unknown, controls: TrackingControlsState): unknown {
  if (typeof value === 'string') {
    return containsExcludedText(value, controls) ? '[excluded]' : value
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => filterValue(entry, controls))
      .filter((entry) => entry !== null)
  }
  if (!value || typeof value !== 'object') return value

  const record = value as JsonRecord
  const bundleId = asString(record, 'bundleId', 'appBundleId', 'browserBundleId', 'ownerBundleId')
  const canonicalAppId = asString(record, 'canonicalAppId', 'canonicalBrowserId')
  const appName = asString(record, 'appName', 'application', 'ownerAppName', 'displayName')
  if (isSystemNoiseApp({ bundleId, appName })) return null
  if (isAppExcluded(controls, { bundleId, canonicalAppId, appName })) return null

  const domain = domainFromRecord(record)
  if (domain && isSiteExcluded(controls, { domain })) return null

  const filtered: JsonRecord = {}
  for (const [key, entry] of Object.entries(record)) {
    const next = filterValue(entry, controls)
    if (next !== null) filtered[key] = next
  }
  return filtered
}

/**
 * Last-line privacy boundary for anything leaving the local resolver layer.
 * Capture-time deletion remains the source-of-truth fix; this prevents a purge
 * miss, stale projection, or legacy row from reaching AI/MCP providers.
 *
 * System noise is always stripped (even with controls off); user exclusions
 * apply only when Tracking Controls is enabled with a non-empty list.
 */
export function filterTrackingExcludedEvidence(
  value: unknown,
  controls: TrackingControlsState,
): unknown {
  if (!controls.enabled || (controls.excludedApps.length === 0 && controls.excludedSites.length === 0)) {
    return filterValue(value, { ...controls, excludedApps: [], excludedSites: [] })
  }
  return filterValue(value, controls)
}
