import type Database from 'better-sqlite3'
import crypto from 'node:crypto'
import type {
  AppCategory,
  AppDetailPayload,
  AppSession,
  ArtifactRef,
  LiveSession,
  PageRef,
} from '@shared/types'
import { MIN_DOMAIN_ROW_SECONDS } from '@shared/types'
import { appDetailRangeKey } from '@shared/appNarrativeContract'
import {
  browserHasLiveTabSamples,
  getBrowserActivityBreakdown,
} from '../db/queries'
import {
  aggregateAppSummaries,
  browserUnattributedReason,
  getCorrectedSessionFactsForRange,
  getIgnoredBlockSpansForRange,
} from './activityFacts'
import { currentSafariHistoryAccessStatus } from './browserCapability'
import { localDayBounds, shiftLocalDateString } from '../lib/localDate'
import {
  artifactIdFor,
  compactWindowTitle,
  dominantCategoryFromDistribution,
  isBrowserSession,
  loadPersistedAppDetailBlocksForDates,
  localDateKeyForTimestamp,
  localDateStringForOffset,
  memoryRollupsForBlocks,
  mergeLiveSession,
  prettyCategory,
  sanitizeBlockLabel,
  sessionEndMs,
  topAppsFromSessions,
  usefulWindowTitle,
  type AppDetailBlockSlice,
} from './workBlocks'
import {
  normalizeWebsiteTitleForDisplay,
  resolveCanonicalApp,
  websiteDisplayLabel,
} from '../lib/appIdentity'
import { getStoredCanonicalAppLinks } from '../core/inference/appIdentityRegistry'

const APP_DETAIL_FALLBACK_MERGE_GAP_MS = 5 * 60_000

function dominantCategoryForSessions(sessions: AppSession[]): AppCategory {
  const distribution: Partial<Record<AppCategory, number>> = {}
  for (const session of sessions) {
    distribution[session.category] = (distribution[session.category] ?? 0) + session.durationSeconds
  }
  return dominantCategoryFromDistribution(distribution)
}

function labelForSessionCluster(sessions: AppSession[]): string {
  if (sessions.length === 0) return 'Work block'
  const lead = sessions.reduce((best, current) => (
    current.durationSeconds > best.durationSeconds ? current : best
  ))
  const titled = usefulWindowTitle(lead)
  if (titled) return compactWindowTitle(titled)
  const identity = resolveCanonicalApp(lead.bundleId, lead.appName)
  return sanitizeBlockLabel(identity.displayName)
    ?? sanitizeBlockLabel(lead.appName)
    ?? prettyCategory(lead.category)
}

function normalizedAppActivityLabel(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function labelMatchesSelectedApp(label: string, displayName: string): boolean {
  return normalizedAppActivityLabel(label) === normalizedAppActivityLabel(displayName)
}

function buildSessionDerivedAppDetailBlocksByDate(
  sessions: AppSession[],
  canonicalAppId: string,
): Map<string, AppDetailBlockSlice[]> {
  const sessionsByDate = new Map<string, AppSession[]>()
  for (const session of sessions) {
    const dateKey = localDateKeyForTimestamp(session.startTime)
    const current = sessionsByDate.get(dateKey) ?? []
    current.push(session)
    sessionsByDate.set(dateKey, current)
  }

  const blocksByDate = new Map<string, AppDetailBlockSlice[]>()
  for (const [dateKey, appSessions] of sessionsByDate.entries()) {
    const ordered = [...appSessions].sort((left, right) => left.startTime - right.startTime)
    const clusters: AppSession[][] = []
    for (const session of ordered) {
      const currentCluster = clusters[clusters.length - 1]
      if (!currentCluster || currentCluster.length === 0) {
        clusters.push([session])
        continue
      }
      const previous = currentCluster[currentCluster.length - 1]
      if (session.startTime - sessionEndMs(previous) <= APP_DETAIL_FALLBACK_MERGE_GAP_MS) {
        currentCluster.push(session)
      } else {
        clusters.push([session])
      }
    }

    blocksByDate.set(dateKey, clusters.map((cluster) => {
      const startTime = cluster[0].startTime
      const endTime = cluster.reduce((latest, session) => Math.max(latest, sessionEndMs(session)), startTime)
      const signature = `${canonicalAppId}:${startTime}:${endTime}:${cluster.map((session) => session.id).join(',')}`
      return {
        id: `appd_${crypto.createHash('sha1').update(signature).digest('hex').slice(0, 16)}`,
        startTime,
        endTime,
        dominantCategory: dominantCategoryForSessions(cluster),
        label: { current: labelForSessionCluster(cluster) },
        topApps: topAppsFromSessions(cluster),
        topArtifacts: [],
        pageRefs: [],
        workflowRefs: [],
      }
    }))
  }
  return blocksByDate
}

/**
 * Fold domains under the minimum-row threshold into one "Everything else"
 * aggregate (DEV-239). The folded seconds stay inside attributedSeconds, so
 * the on-screen arithmetic still reconciles exactly:
 * Σ rows + everythingElse = attributedSeconds.
 */
export function foldTinyDomains<T extends { totalSeconds: number; visitCount: number }>(
  domains: readonly T[],
): { rows: T[]; everythingElse?: { totalSeconds: number; domainCount: number; visitCount: number } } {
  const rows = domains.filter((domain) => domain.totalSeconds >= MIN_DOMAIN_ROW_SECONDS)
  const folded = domains.filter((domain) => domain.totalSeconds < MIN_DOMAIN_ROW_SECONDS)
  if (folded.length === 0) return { rows }
  return {
    rows,
    everythingElse: {
      totalSeconds: folded.reduce((sum, domain) => sum + domain.totalSeconds, 0),
      domainCount: folded.length,
      visitCount: folded.reduce((sum, domain) => sum + domain.visitCount, 0),
    },
  }
}

/** Builds the Apps projection. Timeline formation remains in workBlocks; this
 * service owns app-range selection, app-only evidence and reconciliation. */
export function getAppDetailPayload(
  db: Database.Database,
  canonicalAppId: string,
  daysOrDate: number | string = 7,
  liveSession?: LiveSession | null,
): AppDetailPayload {
  const isDate = typeof daysOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(daysOrDate)
  const today = isDate ? daysOrDate as string : localDateStringForOffset(0)
  const rawDays = isDate ? 1 : Number(daysOrDate)
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.floor(rawDays)) : 7
  const [, todayTo] = localDayBounds(today)
  const fromMs = days >= 36500
    ? 0
    : localDayBounds(shiftLocalDateString(today, -Math.max(0, days - 1)))[0]
  const rangeKey = appDetailRangeKey(isDate ? today : days, today)
  const effectiveLiveSession = !isDate || today === localDateStringForOffset(0) ? liveSession : null

  // Corrected truth (invariant 7): the spans of Timeline blocks the user
  // deleted are subtracted from EVERY fact this payload derives — sessions,
  // totals, domain/page credit, appearances — so the Apps panel never
  // disagrees with the Timeline. Raw capture stays stored untouched.
  // Canonical facts already contain the open live interval; the in-memory
  // tracker session is merged only when the range fell back to legacy rows.
  const correctionSpans = getIgnoredBlockSpansForRange(db, fromMs, todayTo)
  const sessionFacts = getCorrectedSessionFactsForRange(db, fromMs, todayTo)
  const rawSessions = sessionFacts.sessions
  const allSessions = sessionFacts.evidenceSource === 'legacy'
    ? mergeLiveSession(rawSessions, effectiveLiveSession)
    : rawSessions
  // Stored registry links (path/bundle → canonical) keep twin identities of
  // one install together, so the detail shows the merged app's whole range.
  const canonicalLinks = getStoredCanonicalAppLinks(db)
  const sessionKey = (bundleId: string, appName: string, sessionCanonicalId: string | null | undefined): string => {
    const identity = resolveCanonicalApp(bundleId, appName)
    const derivedKey = sessionCanonicalId ?? identity.canonicalAppId ?? bundleId
    return canonicalLinks.get(derivedKey) ?? derivedKey
  }
  const sessions = allSessions.filter((session) =>
    sessionKey(session.bundleId, session.appName, session.canonicalAppId) === canonicalAppId)

  const relevantDates = Array.from(new Set(sessions.map((session) => localDateKeyForTimestamp(session.startTime))))
  const historicalDates = relevantDates.filter((date) => !(date === today && effectiveLiveSession))
  const blocksByDate = new Map(loadPersistedAppDetailBlocksForDates(db, historicalDates))
  const sessionDerivedBlocksByDate = buildSessionDerivedAppDetailBlocksByDate(sessions, canonicalAppId)
  for (const date of relevantDates) {
    const fallbackBlocks = sessionDerivedBlocksByDate.get(date) ?? []
    const persistedBlocks = blocksByDate.get(date) ?? []
    if (persistedBlocks.length === 0 && fallbackBlocks.length > 0) blocksByDate.set(date, fallbackBlocks)
    if (date === today && effectiveLiveSession && fallbackBlocks.length > 0) blocksByDate.set(date, fallbackBlocks)
  }

  const relatedBlocks = Array.from(blocksByDate.values()).flat().filter((block) => block.topApps.some((app) =>
    sessionKey(app.bundleId, app.appName, app.canonicalAppId) === canonicalAppId))

  const artifactTotals = new Map<string, ArtifactRef>()
  for (const block of relatedBlocks) {
    const blockContainsOnlySelectedApp = block.topApps.every((app) =>
      sessionKey(app.bundleId, app.appName, app.canonicalAppId) === canonicalAppId)
    for (const artifact of block.topArtifacts) {
      let belongsToSelectedApp: boolean
      if (artifact.canonicalAppId) {
        belongsToSelectedApp = artifact.canonicalAppId === canonicalAppId
      } else if (artifact.ownerBundleId) {
        const owner = resolveCanonicalApp(artifact.ownerBundleId, artifact.ownerAppName ?? artifact.ownerBundleId)
        belongsToSelectedApp = (owner.canonicalAppId ?? artifact.ownerBundleId) === canonicalAppId
      } else if (artifact.artifactType === 'page') {
        const page = artifact as PageRef
        const browserId = page.canonicalBrowserId
          ?? (page.browserBundleId ? resolveCanonicalApp(page.browserBundleId, page.browserBundleId).canonicalAppId : null)
        belongsToSelectedApp = browserId !== null ? browserId === canonicalAppId : false
      } else {
        belongsToSelectedApp = blockContainsOnlySelectedApp
      }
      if (!belongsToSelectedApp) continue
      const existing = artifactTotals.get(artifact.id)
      if (existing) existing.totalSeconds += artifact.totalSeconds
      else artifactTotals.set(artifact.id, { ...artifact })
    }
  }
  const topArtifacts = Array.from(artifactTotals.values()).sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 8)

  const timeOfDayDistribution = Array.from({ length: 24 }, (_, hour) => ({ hour, totalSeconds: 0 }))
  for (const session of sessions) timeOfDayDistribution[new Date(session.startTime).getHours()].totalSeconds += session.durationSeconds

  const sampleSession = sessions[0]
  const displayName = sampleSession
    ? resolveCanonicalApp(sampleSession.bundleId, sampleSession.appName).displayName
    : resolveCanonicalApp(canonicalAppId, canonicalAppId).displayName
  // Appearances come from the same corrected block facts the Timeline shows
  // (invariant 7 / apps.md invariant 13): persisted blocks carry the user's
  // renames and category corrections, and a deleted block never appears. The
  // session-derived clusters only fill in when a day has no persisted blocks
  // yet (today/live) — the fallback already applied in blocksByDate above.
  const rawAppearances = [...relatedBlocks]
    .sort((a, b) => b.startTime - a.startTime)
    .map((block) => ({
      blockId: block.id,
      startTime: block.startTime,
      endTime: block.endTime,
      label: sanitizeBlockLabel(block.label.current) ?? prettyCategory(block.dominantCategory),
      dominantCategory: block.dominantCategory,
    }))
    .filter((block) => !labelMatchesSelectedApp(block.label, displayName))
  const mergedByLabel = new Map<string, typeof rawAppearances[number]>()
  for (const appearance of rawAppearances) {
    const key = appearance.label.toLowerCase()
    const existing = mergedByLabel.get(key)
    if (existing) {
      existing.startTime = Math.min(existing.startTime, appearance.startTime)
      existing.endTime = Math.max(existing.endTime, appearance.endTime)
    } else {
      mergedByLabel.set(key, { ...appearance })
    }
  }
  const blockAppearances = Array.from(mergedByLabel.values()).sort((a, b) => b.startTime - a.startTime).slice(0, 12)
  const blockMemoryRollups = memoryRollupsForBlocks(db, blockAppearances)

  // Aggregate the sessions already fetched above — allSessions is exactly
  // what getCorrectedAppSummariesForRange would re-derive, and re-running the
  // shared query would repeat a full-history scan on the all-time range.
  const summariesForRange = aggregateAppSummaries(allSessions, canonicalLinks)
  const canonicalSummary = summariesForRange.find((row) => row.canonicalAppId === canonicalAppId)
    ?? summariesForRange.find((row) => row.bundleId === canonicalAppId)
    ?? null
  const totalSeconds = canonicalSummary?.totalSeconds ?? sessions.reduce((sum, session) => sum + session.durationSeconds, 0)
  const sessionCount = canonicalSummary?.sessionCount ?? sessions.length

  let browserActivity: AppDetailPayload['browserActivity']
  if (sessions.some((session) => isBrowserSession(session))) {
    const breakdown = getBrowserActivityBreakdown(db, fromMs, todayTo, canonicalAppId, {
      excludeSpans: correctionSpans,
      sessions: rawSessions,
    })
    const unattributedSeconds = Math.max(0, totalSeconds - breakdown.attributedSeconds)
    // The "No page recorded" row must say why the time has no page, not sit
    // there as a dead end (DEV-238). The reason comes from capability
    // evidence: live-tab samples, window titles, and the Safari Full Disk
    // Access state.
    const coverageNote = unattributedSeconds > 0
      ? browserUnattributedReason({
          canonicalBrowserId: canonicalAppId,
          displayName,
          platform: process.platform,
          safariHistoryAccess: currentSafariHistoryAccessStatus(),
          attributedSeconds: breakdown.attributedSeconds,
          hasLiveTabSamples: browserHasLiveTabSamples(db, fromMs, todayTo, canonicalAppId),
          hasUsefulWindowTitles: sessions.some((session) => usefulWindowTitle(session) != null),
        })
      : undefined
    const { rows: rowDomains, everythingElse } = foldTinyDomains(breakdown.domains)
    browserActivity = {
      totalSeconds,
      attributedSeconds: breakdown.attributedSeconds,
      unattributedSeconds,
      coverageNote,
      ...(everythingElse ? { everythingElse } : {}),
      domains: rowDomains.map((domain) => ({
        domain: domain.domain,
        totalSeconds: domain.totalSeconds,
        visitCount: domain.visitCount,
        pages: domain.pages.map((page) => {
          const normalizedTitle = normalizeWebsiteTitleForDisplay(page.domain, page.title)
          const displayTitle = normalizedTitle ?? websiteDisplayLabel(page.domain)
          const canonicalKey = page.normalizedUrl ?? page.pageKey ?? page.url ?? `domain:${page.domain}`
          return {
            id: artifactIdFor(`page:${canonicalKey}`),
            artifactType: 'page' as const,
            canonicalKey: `page:${canonicalKey}`,
            displayTitle,
            subtitle: page.domain,
            totalSeconds: page.totalSeconds,
            confidence: 0.9,
            canonicalAppId,
            url: page.url ?? undefined,
            host: page.domain,
            openTarget: page.url
              ? { kind: 'external_url' as const, value: page.url }
              : { kind: 'unsupported' as const, value: null },
            metadata: { normalizedUrl: page.normalizedUrl },
            domain: page.domain,
            normalizedUrl: page.normalizedUrl,
            pageKey: page.pageKey,
            pageTitle: normalizedTitle,
            visitCount: page.visitCount,
          }
        }),
      })),
    }
  }

  return {
    canonicalAppId,
    displayName,
    totalSeconds,
    sessionCount,
    topArtifacts,
    browserActivity,
    blockAppearances,
    blockMemoryRollups,
    timeOfDayDistribution,
    rangeKey,
  }
}
