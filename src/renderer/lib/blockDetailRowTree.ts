// Block detail row tree — the nesting logic behind the "What you were in"
// panel (BlockDetailInspector), pulled out so it can be unit-tested without
// a DOM harness (Pure, no React — same pattern as dayWrapScenes.ts).
//
// A site or page visited inside a browser, or a file/document opened inside
// an app, is a breakdown of that owning app's tracked time, never additional
// time on top of it — app time and site time must never be double-counted.
// This module turns a block's flat evidence arrays
// (topApps, topArtifacts, websites) into a tree: children nest under the app
// row they happened in, everything else stays a top-level sibling.

import type { ArtifactRef, AppCategory, PageRef, WebsiteSummary, WorkContextAppSummary, WorkContextBlock } from '@shared/types'
import { kindForDomain } from '@shared/workKind'

export type DetailRowKind = 'app' | 'artifact' | 'site' | 'residual'

export interface DetailRowNode {
  key: string
  kind: DetailRowKind
  seconds: number
  offTask: boolean
  // The app row this node happens inside, when one of the block's own top
  // apps owns it. Undefined means "top-level" — either a genuine sibling
  // app, or a site/artifact whose owner isn't in the block's top apps.
  ownerKey?: string
  children: DetailRowNode[]
  // Raw source object the renderer needs to build name/detail/icon/onOpen.
  // Exactly one of these is set, matching `kind`.
  app?: WorkContextAppSummary
  artifact?: ArtifactRef
  site?: WebsiteSummary
}

export interface DetailRowTree {
  // Nested, on-task rows: app rows (each with its children already attached)
  // plus any on-task orphan site/artifact rows, sorted by seconds desc.
  evidence: DetailRowNode[]
  // Off-task ("detour") rows, flat, sorted by seconds desc.
  detours: DetailRowNode[]
  detourSeconds: number
  // Sub-minute rows folded out of the lists above, summarized as one quiet line
  // instead of standing as their own 2-second rows.
  briefCount: number
  briefSeconds: number
}

const isOffTaskCategory = (category: AppCategory): boolean =>
  category === 'entertainment' || category === 'social'

// A row shorter than this is noise, not activity — it never stands as its own
// row; it folds into one quiet "brief glimpses" line.
const MIN_EVIDENCE_ROW_SECONDS = 60

// Daylens watching itself is never evidence about the user — including the dev
// build's raw Electron runner. Guarded here too so a historical row captured
// before the tracker's self-exclusion covered dev never reaches the panel.
const SELF_APP_BUNDLE_IDS = new Set([
  'com.daylens.desktop', 'com.daylens.app', 'com.daylens.app.dev',
  'daylens', 'daylens.desktop', 'com.github.electron',
])
function isSelfCaptureApp(app: WorkContextAppSummary): boolean {
  if (SELF_APP_BUNDLE_IDS.has((app.bundleId ?? '').trim().toLowerCase())) return true
  const name = (app.appName ?? '').trim().toLowerCase()
  return name === 'daylens' || name === 'electron'
}

// Keep the rows worth showing; fold anything sub-minute into a running tally.
// If EVERYTHING is sub-minute (a genuinely tiny block), keep the rows rather
// than empty the panel.
function partitionBrief<T extends { seconds: number }>(rows: T[], brief: { count: number; seconds: number }): T[] {
  const significant = rows.filter((row) => row.seconds >= MIN_EVIDENCE_ROW_SECONDS)
  if (significant.length === 0) return rows
  for (const row of rows) {
    if (row.seconds < MIN_EVIDENCE_ROW_SECONDS) {
      brief.count += 1
      brief.seconds += Math.max(0, row.seconds)
    }
  }
  return significant
}

export function buildDetailRowTree(block: WorkContextBlock): DetailRowTree {
  // Rows carry two possible owner-linkage pairings, because ArtifactRef has
  // two parallel schemes: app-owned artifacts (files/windows) use
  // ownerBundleId/canonicalAppId, while browser-owned pages (PageRef) use
  // browserBundleId/canonicalBrowserId. A PageRef whose ownerBundleId/
  // canonicalAppId weren't populated (e.g. an older/incomplete producer)
  // still nests correctly as long as its browser fields are present.
  const ownerKeyFor = (
    bundleId?: string | null,
    canonicalId?: string | null,
    fallbackBundleId?: string | null,
    fallbackCanonicalId?: string | null,
  ): string | undefined => {
    const owner = block.topApps.slice(0, 8).find((app) =>
      (bundleId != null && app.bundleId === bundleId)
      || (canonicalId != null && app.canonicalAppId === canonicalId)
      || (fallbackBundleId != null && app.bundleId === fallbackBundleId)
      || (fallbackCanonicalId != null && app.canonicalAppId === fallbackCanonicalId))
    return owner ? `app:${owner.bundleId}` : undefined
  }

  const brief = { count: 0, seconds: 0 }

  const appRows: DetailRowNode[] = partitionBrief(
    block.topApps
      .filter((app) => !isSelfCaptureApp(app))
      .slice(0, 8)
      .map((app) => ({
        key: `app:${app.bundleId}`,
        kind: 'app' as const,
        seconds: app.totalSeconds,
        offTask: isOffTaskCategory(app.category),
        children: [],
        app,
      })),
    brief,
  )

  // The same window/page title can arrive several times (a terminal retitling
  // itself, a page reopened); it is one thing, shown once (DEV-272). Dedupe on
  // the title's letters and digits so "⠿ Traycer" and "Traycer" collapse.
  const seenArtifactTitles = new Set<string>()
  const dedupedArtifacts = block.topArtifacts.filter((artifact) => {
    const key = (artifact.displayTitle ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (!key || seenArtifactTitles.has(key)) return false
    seenArtifactTitles.add(key)
    return true
  })

  const artifactRows: DetailRowNode[] = partitionBrief(dedupedArtifacts.slice(0, 8).map((artifact) => {
    const pageRef = artifact as PageRef
    return {
      key: `art:${artifact.id}`,
      kind: 'artifact' as const,
      seconds: artifact.totalSeconds,
      offTask: kindForDomain(artifact.host) === 'leisure',
      children: [],
      artifact,
      ownerKey: ownerKeyFor(
        artifact.ownerBundleId,
        artifact.canonicalAppId,
        pageRef.browserBundleId,
        pageRef.canonicalBrowserId,
      ),
    }
  }), brief)

  // Sites already represented by an artifact row are not repeated.
  const artifactHosts = new Set(block.topArtifacts.map((a) => a.host?.toLowerCase()).filter(Boolean) as string[])
  const siteRows: DetailRowNode[] = partitionBrief(block.websites
    .filter((site) => !artifactHosts.has(site.domain.toLowerCase()))
    .slice(0, 8)
    .map((site) => ({
      key: `site:${site.domain}`,
      kind: 'site' as const,
      seconds: site.totalSeconds,
      offTask: kindForDomain(site.domain) === 'leisure',
      children: [],
      site,
      ownerKey: ownerKeyFor(site.browserBundleId, site.canonicalBrowserId),
    })), brief)

  // Nest each on-task site/page/file under the app it happened in; rows whose
  // app isn't listed stay top-level. Off-task rows keep flowing to detours.
  const childRows = [...artifactRows, ...siteRows].filter((row) => !row.offTask && row.ownerKey)
  const nested = appRows.map((app) => {
    const children = childRows.filter((row) => row.ownerKey === app.key).sort((a, b) => b.seconds - a.seconds)
    // Numbers must reconcile (invariant 7): when a browser row's children
    // don't add up to the parent, the difference is rendered as an explicit
    // "No page recorded" residual instead of a silent hole — same rule the
    // Apps view breakdown follows. Only for browsers with at least one child;
    // sub-minute residue is rounding, not a hole.
    if (app.app?.isBrowser && children.length > 0) {
      const childSeconds = children.reduce((sum, row) => sum + row.seconds, 0)
      const residual = app.seconds - childSeconds
      if (residual >= 60) {
        children.push({
          key: `residual:${app.key}`,
          kind: 'residual',
          seconds: residual,
          offTask: false,
          ownerKey: app.key,
          children: [],
        })
      }
    }
    return { ...app, children }
  })
  const orphanRows = [...artifactRows, ...siteRows].filter((row) => !row.offTask && !row.ownerKey)
  const allEvidence = [...nested, ...orphanRows].sort((a, b) => b.seconds - a.seconds)
  const evidence = allEvidence.filter((row) => !row.offTask)

  // "Detours": where active time went elsewhere inside this block — the
  // leisure sites and apps the user was actually in. Idle/away time is never
  // a detour; it renders as blank space on the grid instead.
  const detours = [
    ...allEvidence.filter((row) => row.offTask),
    ...[...artifactRows, ...siteRows].filter((row) => row.offTask),
  ].sort((a, b) => b.seconds - a.seconds)
  const detourSeconds = detours.reduce((sum, row) => sum + row.seconds, 0)

  return { evidence, detours, detourSeconds, briefCount: brief.count, briefSeconds: brief.seconds }
}
