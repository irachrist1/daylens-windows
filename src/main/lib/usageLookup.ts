// Website-vs-app lookup for time questions.
//
// A name like "Coursera" is a site. Looking it up as an app (or letting a
// loose app substring steal the match) returns almost nothing; the website
// ledger has the total. Exact app names still win, so "Slack" stays the app
// even when slack.com was also visited.
import { websiteDisplayLabel } from './appIdentity'

export function normalizeUsageLookup(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export interface AppLookupIdentity {
  appName: string
  bundleId: string
  canonicalAppId?: string | null
}

export type UsageLookupKind = 'app' | 'site' | 'none'

export type NamedUsageSubject =
  | { kind: 'app'; name: string }
  | { kind: 'site'; domain: string }

function pathTail(value: string | null | undefined): string | null {
  if (!value) return null
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value
}

export function appLookupCandidates(app: AppLookupIdentity): string[] {
  return [
    app.appName,
    app.bundleId,
    app.canonicalAppId ?? null,
    pathTail(app.bundleId),
    pathTail(app.canonicalAppId ?? null),
  ].filter((value): value is string => !!value)
}

export function appMatchesExactly(app: AppLookupIdentity, lookup: string): boolean {
  return appLookupCandidates(app).some((value) => normalizeUsageLookup(value) === lookup)
}

export function appMatchesLoosely(app: AppLookupIdentity, lookup: string): boolean {
  return appLookupCandidates(app).some((value) => {
    const normalized = normalizeUsageLookup(value)
    if (!normalized) return false
    if (normalized.includes(lookup)) return true
    return normalized.length >= 4 && lookup.includes(normalized)
  })
}

export function siteMatchesLookup(domain: string, lookupRaw: string): boolean {
  const needle = normalizeUsageLookup(lookupRaw)
  if (!needle || needle.length < 3) return false
  const dn = normalizeUsageLookup(domain)
  if (!dn) return false
  if (dn === needle) return true
  if (needle.length >= 4 && dn.includes(needle)) return true
  if (dn.length >= 4 && needle.includes(dn)) return true
  return false
}

export function siteLookupNames(domain: string): string[] {
  const normalized = domain.trim().toLowerCase().replace(/^www\./, '')
  if (!normalized) return []
  const names = new Set<string>([normalized, websiteDisplayLabel(normalized)])
  const base = normalized.split('.')[0]
  if (base && base.length >= 3) names.add(base)
  return [...names]
}

export function resolveUsageLookupKind(input: {
  lookup: string
  apps: readonly AppLookupIdentity[]
  siteDomains: readonly string[]
}): UsageLookupKind {
  const needle = normalizeUsageLookup(input.lookup)
  if (!needle) return 'none'
  if (input.apps.some((app) => appMatchesExactly(app, needle))) return 'app'
  if (input.siteDomains.some((domain) => siteMatchesLookup(domain, input.lookup))) return 'site'
  if (input.apps.some((app) => appMatchesLoosely(app, needle))) return 'app'
  return 'none'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionedInQuestion(question: string, name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 3) return false
  return new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'i').test(question)
}

export function findNamedAppInQuestion(question: string, appNames: readonly string[]): string | null {
  return [...appNames]
    .filter((name) => name.trim().length >= 3)
    .sort((left, right) => right.length - left.length)
    .find((name) => mentionedInQuestion(question, name)) ?? null
}

function dottedSiteInQuestion(question: string, siteDomains: readonly string[]): string | null {
  const tokens = question.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi) ?? []
  for (const token of tokens) {
    const match = siteDomains.find((domain) => siteMatchesLookup(domain, token))
    if (match) return match
  }
  return null
}

export function findNamedSiteDomain(question: string, siteDomains: readonly string[]): string | null {
  const unique = [...new Set(siteDomains.map((domain) => domain.trim()).filter(Boolean))]
  const dotted = dottedSiteInQuestion(question, unique)
  if (dotted) return dotted

  const candidates = unique.flatMap((domain) =>
    siteLookupNames(domain).map((name) => ({ domain, name })),
  ).sort((left, right) => right.name.length - left.name.length)

  return candidates.find((candidate) => mentionedInQuestion(question, candidate.name))?.domain ?? null
}

export function namedUsageSubject(
  question: string,
  appNames: readonly string[],
  siteDomains: readonly string[],
): NamedUsageSubject | null {
  const dottedSite = dottedSiteInQuestion(question, siteDomains)
  if (dottedSite) return { kind: 'site', domain: dottedSite }

  const app = findNamedAppInQuestion(question, appNames)
  if (app) return { kind: 'app', name: app }

  const site = findNamedSiteDomain(question, siteDomains)
  if (site) return { kind: 'site', domain: site }
  return null
}
