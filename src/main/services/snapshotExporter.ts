/**
 * SnapshotExporter — builds a DaySnapshot from local SQLite data.
 * Mirrors the macOS SnapshotExporter.swift for parity.
 */
import { getDb } from './database'
import {
  getAppSummariesForRange,
  getSessionsForRange,
  getWebsiteSummariesForRange,
  getTopPagesForDomains,
  getRecentFocusSessions,
} from '../db/queries'
import fs from 'node:fs'
import path from 'node:path'
import { localDateString, localDayBounds } from '../lib/localDate'
import { computeFocusScore, computeFocusScoreV2, isCategoryFocused } from '../lib/focusScore'
import { getTimelineDayPayload, userVisibleLabelForBlock } from './workBlocks'
import { buildRecapSummaries, recapDateWindow } from '../../renderer/lib/recap'
import type {
  AppSummary as AppSummaryOut,
  ArtifactKind,
  ArtifactRollup,
  Category,
  CategoryTotal,
  DaySnapshotV2,
  EntityRollup,
  FocusSession as FocusSessionOut,
  RecapSummaryLite,
  TimelineEntry,
  TopDomain,
  WorkBlockSummary,
  WorkstreamRollup,
} from '@shared/snapshot'
import { SNAPSHOT_SCHEMA_VERSION, type Platform } from '@shared/snapshot'
import type { ArtifactRef, DayTimelinePayload, WorkContextBlock } from '@shared/types'

// ─── Normalization map ───────────────────────────────────────────────────────

interface NormalizationMap {
  aliases: Record<string, string>
  catalog: Record<string, { displayName: string; defaultCategory: string }>
}

const UNTITLED_WORKSTREAM_LABEL = 'Untitled work block'

let _normMap: NormalizationMap | null = null

function currentSnapshotPlatform(): Platform {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

function getNormMap(): NormalizationMap {
  if (_normMap) return _normMap

  const candidates = [
    // Packaged build: extraResources unpacks the JSON next to the asar
    ...(typeof process !== 'undefined' && (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      ? [path.join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, 'app-normalization.v1.json')]
      : []),
    path.join(__dirname, '..', '..', 'shared', 'app-normalization.v1.json'),
    path.join(process.cwd(), 'shared', 'app-normalization.v1.json'),
  ]

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8')
      _normMap = JSON.parse(raw) as NormalizationMap
      return _normMap
    } catch {
      // Try next candidate
    }
  }

  // Fallback — empty map
  console.warn('[snapshot-exporter] normalization map not found, using empty map')
  _normMap = { aliases: {}, catalog: {} }
  return _normMap
}

function normalize(bundleId: string, appName: string): { appKey: string; displayName: string; category: Category } {
  const map = getNormMap()

  // Try exact and normalized bundle IDs first, then just the executable filename.
  const exeName = path.basename(bundleId).toLowerCase()
  const appKey = map.aliases[bundleId]
    || map.aliases[bundleId.toLowerCase()]
    || map.aliases[exeName]
    || exeName.replace(/\.exe$/i, '')

  const catalogEntry = map.catalog[appKey]
  if (catalogEntry) {
    return {
      appKey,
      displayName: catalogEntry.displayName,
      category: catalogEntry.defaultCategory as Category,
    }
  }

  // Not in catalog — use the raw app name
  return {
    appKey,
    displayName: appName || appKey,
    category: 'uncategorized',
  }
}

// ─── Day bounds ──────────────────────────────────────────────────────────────

function dayBounds(dateStr: string): [number, number] {
  return localDayBounds(dateStr)
}

function toISOWithOffset(ms: number): string {
  // Build the timestamp from local date/time components so the wall-clock
  // time is correct. Using toISOString() (UTC) and patching the offset suffix
  // produces an internally inconsistent string.
  const d = new Date(ms)
  const tzOffset = -d.getTimezoneOffset()  // minutes east of UTC
  const sign = tzOffset >= 0 ? '+' : '-'
  const absOffset = Math.abs(tzOffset)
  const oh = String(Math.floor(absOffset / 60)).padStart(2, '0')
  const om = String(absOffset % 60).padStart(2, '0')

  const yr  = d.getFullYear()
  const mo  = String(d.getMonth() + 1).padStart(2, '0')
  const dy  = String(d.getDate()).padStart(2, '0')
  const hr  = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const sec = String(d.getSeconds()).padStart(2, '0')
  const ms3 = String(d.getMilliseconds()).padStart(3, '0')

  return `${yr}-${mo}-${dy}T${hr}:${min}:${sec}.${ms3}${sign}${oh}:${om}`
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function blockDurationSeconds(block: Pick<WorkContextBlock, 'startTime' | 'endTime'>): number {
  return Math.max(1, Math.round((block.endTime - block.startTime) / 1000))
}

function snapshotBlockLabel(block: WorkContextBlock): string {
  return normalizeText(block.label.current) || normalizeText(block.label.override) || UNTITLED_WORKSTREAM_LABEL
}

function snapshotLabelSource(block: WorkContextBlock): WorkBlockSummary['labelSource'] {
  if (block.label.source === 'user') return 'user'
  if (block.label.source === 'ai') return 'ai'
  return 'rule'
}

function artifactKindFor(ref: ArtifactRef): ArtifactKind {
  const target = (ref.path ?? ref.openTarget.value ?? '').toLowerCase()
  if (target.endsWith('.csv')) return 'csv'
  if (target.endsWith('.json')) return 'json_table'
  if (target.endsWith('.html') || target.endsWith('.htm')) return 'html_chart'
  if (target.endsWith('.md') || target.endsWith('.markdown')) return 'markdown'
  return 'report'
}

function artifactByteSize(ref: ArtifactRef): number {
  const metaSize = ref.metadata?.byteSize
  if (typeof metaSize === 'number' && Number.isFinite(metaSize) && metaSize >= 0) {
    return metaSize
  }
  return 0
}

function toRecapLite(summary: ReturnType<typeof buildRecapSummaries>['day']): RecapSummaryLite {
  return {
    headline: summary.headline,
    chapters: summary.chapters.map((chapter) => ({
      id: chapter.id,
      eyebrow: chapter.eyebrow,
      title: chapter.title,
      body: chapter.body,
    })),
    metrics: summary.metrics.map((metric) => ({
      label: metric.label,
      value: metric.value,
      detail: metric.detail,
    })),
    changeSummary: summary.changeSummary,
    promptChips: [...summary.promptChips],
    hasData: summary.hasData,
  }
}

function summarizeWorkBlocks(blocks: WorkContextBlock[]): WorkBlockSummary[] {
  return blocks
    .filter((block) => !block.isLive)
    .map((block) => ({
      id: block.id,
      startAt: toISOWithOffset(block.startTime),
      endAt: toISOWithOffset(block.endTime),
      label: userVisibleLabelForBlock(block),
      labelSource: snapshotLabelSource(block),
      dominantCategory: block.dominantCategory,
      focusSeconds: block.focusOverlap.totalSeconds,
      switchCount: block.switchCount,
      confidence: block.confidence,
      topApps: block.topApps.slice(0, 3).map((app) => ({
        appKey: normalize(app.bundleId, app.appName).appKey,
        seconds: app.totalSeconds,
      })),
      topPages: block.pageRefs.slice(0, 3).map((page) => ({
        domain: page.domain,
        label: page.domain,
        seconds: page.totalSeconds,
      })),
      artifactIds: block.topArtifacts.slice(0, 5).map((artifact) => artifact.id),
    }))
}

function buildWorkstreamRollups(blocks: WorkContextBlock[]): WorkstreamRollup[] {
  const workstreams = new Map<string, WorkstreamRollup>()

  for (const block of blocks) {
    if (block.isLive) continue
    const label = snapshotBlockLabel(block)
    const existing = workstreams.get(label) ?? {
      label,
      seconds: 0,
      blockCount: 0,
      isUntitled: label === UNTITLED_WORKSTREAM_LABEL,
    }
    existing.seconds += blockDurationSeconds(block)
    existing.blockCount += 1
    workstreams.set(label, existing)
  }

  return [...workstreams.values()].sort((left, right) => right.seconds - left.seconds).slice(0, 8)
}

function buildArtifactRollups(blocks: WorkContextBlock[]): ArtifactRollup[] {
  const artifacts = new Map<string, ArtifactRollup>()

  for (const block of blocks) {
    if (block.isLive) continue
    for (const artifact of block.topArtifacts) {
      const existing = artifacts.get(artifact.id)
      if (existing) continue
      artifacts.set(artifact.id, {
        id: artifact.id,
        kind: artifactKindFor(artifact),
        title: artifact.displayTitle,
        byteSize: artifactByteSize(artifact),
        generatedAt: toISOWithOffset(block.endTime),
        threadId: null,
      })
    }
  }

  return [...artifacts.values()].slice(0, 8)
}

function buildRecapPayload(db: ReturnType<typeof getDb>, dateStr: string) {
  const payloads: DayTimelinePayload[] = recapDateWindow(dateStr).map((date) => {
    try {
      return getTimelineDayPayload(db, date)
    } catch {
      return emptyTimelinePayload(date)
    }
  })
  const recap = buildRecapSummaries(payloads, dateStr)
  return {
    recap: {
      day: toRecapLite(recap.day),
      week: recap.week.hasData ? toRecapLite(recap.week) : null,
      month: recap.month.hasData ? toRecapLite(recap.month) : null,
    },
    coverage: recap.day.coverage,
  }
}

function loadEntityRollups(db: ReturnType<typeof getDb>, dateStr: string): EntityRollup[] {
  const rows = db.prepare(`
    SELECT
      'client' AS kind,
      c.id AS id,
      c.name AS label,
      SUM(der.attributed_ms + der.ambiguous_ms) AS total_ms,
      SUM(der.session_count) AS session_count
    FROM daily_entity_rollups der
    JOIN clients c ON c.id = der.client_id
    WHERE der.day_local = ?
    GROUP BY c.id, c.name

    UNION ALL

    SELECT
      'project' AS kind,
      p.id AS id,
      p.name AS label,
      SUM(der.attributed_ms + der.ambiguous_ms) AS total_ms,
      SUM(der.session_count) AS session_count
    FROM daily_entity_rollups der
    JOIN projects p ON p.id = der.project_id
    WHERE der.day_local = ?
    GROUP BY p.id, p.name

    ORDER BY total_ms DESC, label ASC
  `).all(dateStr, dateStr) as Array<{
    kind: 'client' | 'project'
    id: string
    label: string
    total_ms: number
    session_count: number
  }>

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    secondsToday: Math.max(0, Math.round(row.total_ms / 1000)),
    blockCount: row.session_count,
  }))
}

function emptyTimelinePayload(dateStr: string): DayTimelinePayload {
  return {
    date: dateStr,
    sessions: [],
    websites: [],
    blocks: [],
    segments: [],
    focusSessions: [],
    computedAt: Date.now(),
    version: 'snapshot-exporter-fallback',
    totalSeconds: 0,
    focusSeconds: 0,
    focusPct: 0,
    appCount: 0,
    siteCount: 0,
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function exportSnapshot(dateStr: string, deviceId: string): DaySnapshotV2 {
  const [fromMs, toMs] = dayBounds(dateStr)
  const db = getDb()

  // Is this today? (partial day) — use local date to match the day boundary on this machine
  const today = localDateString()
  const isPartialDay = dateStr === today

  // App summaries from DB
  const rawSummaries = getAppSummariesForRange(db, fromMs, toMs)

  // Normalize and build appSummaries
  const appSummaries: AppSummaryOut[] = []
  const appKeyTotals = new Map<string, AppSummaryOut>()

  for (const raw of rawSummaries) {
    const { appKey, displayName, category } = normalize(raw.bundleId, raw.appName)
    const existing = appKeyTotals.get(appKey)
    if (existing) {
      existing.totalSeconds += raw.totalSeconds
      existing.sessionCount += raw.sessionCount ?? 1
    } else {
      const entry: AppSummaryOut = {
        appKey,
        bundleID: raw.bundleId,
        displayName,
        category,
        totalSeconds: raw.totalSeconds,
        sessionCount: raw.sessionCount ?? 1,
      }
      appKeyTotals.set(appKey, entry)
      appSummaries.push(entry)
    }
  }

  // Sort by time descending
  appSummaries.sort((a, b) => b.totalSeconds - a.totalSeconds)

  // Category totals
  const catMap = new Map<Category, number>()
  for (const app of appSummaries) {
    catMap.set(app.category, (catMap.get(app.category) ?? 0) + app.totalSeconds)
  }
  const categoryTotals: CategoryTotal[] = [...catMap.entries()]
    .map(([category, totalSeconds]) => ({ category, totalSeconds }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds)

  // Focus seconds
  const focusSeconds = appSummaries
    .filter((a) => isCategoryFocused(a.category))
    .reduce((s, a) => s + a.totalSeconds, 0)

  const totalTrackedSeconds = appSummaries.reduce((s, a) => s + a.totalSeconds, 0)

  // Context switches
  const rawSessions = getSessionsForRange(db, fromMs, toMs)
  let switches = 0
  for (let i = 1; i < rawSessions.length; i++) {
    if (rawSessions[i].bundleId !== rawSessions[i - 1].bundleId) {
      switches++
    }
  }
  const hours = totalTrackedSeconds / 3600
  const switchesPerHour = hours > 0 ? switches / hours : 0

  // Focus score V2 — evidence-grounded composite of coherence, deep-work
  // density, artifact progress, and context-switching penalty. We derive
  // blocks from the timeline payload so the score reflects real work
  // boundaries rather than raw focused-app ratios.
  let blocksForScore: { durationSeconds: number; activeSeconds: number }[] = []
  let timelinePayload: DayTimelinePayload | null = null
  let uniqueArtifactCount: number | undefined
  let uniqueWindowTitleCount: number | undefined
  try {
    timelinePayload = getTimelineDayPayload(db, dateStr)
    blocksForScore = timelinePayload.blocks.map((block) => {
      const span = Math.max(0, Math.round((block.endTime - block.startTime) / 1000))
      const active = block.sessions.reduce((sum, session) => sum + session.durationSeconds, 0)
      return {
        durationSeconds: span,
        activeSeconds: Math.min(active, span) || active || span,
      }
    })
    const artifactIds = new Set<string>()
    for (const block of timelinePayload.blocks) {
      for (const artifact of block.topArtifacts ?? []) artifactIds.add(artifact.id)
      for (const page of block.pageRefs ?? []) {
        if (page.url) artifactIds.add(`page:${page.url}`)
      }
      for (const doc of block.documentRefs ?? []) {
        if (doc.path) artifactIds.add(`doc:${doc.path}`)
      }
    }
    uniqueArtifactCount = artifactIds.size > 0 ? artifactIds.size : undefined
    if (uniqueArtifactCount === undefined) {
      const titles = new Set<string>()
      for (const session of rawSessions) {
        const title = session.windowTitle?.trim()
        if (title) titles.add(title.toLowerCase())
      }
      uniqueWindowTitleCount = titles.size
    }
  } catch {
    // If block reconstruction fails, fall back to a single pseudo-block so
    // the score still bounds itself rather than silently zeroing out.
    blocksForScore = totalTrackedSeconds > 0
      ? [{ durationSeconds: totalTrackedSeconds, activeSeconds: totalTrackedSeconds }]
      : []
  }

  const focusBreakdown = computeFocusScoreV2({
    blocks: blocksForScore,
    totalActiveSeconds: totalTrackedSeconds,
    switchesPerHour,
    uniqueArtifactCount,
    uniqueWindowTitleCount,
  })
  const focusScore = computeFocusScore({
    focusedSeconds: focusSeconds,
    totalSeconds: totalTrackedSeconds,
    switchesPerHour,
  })
  const safeTimelinePayload = timelinePayload ?? emptyTimelinePayload(dateStr)
  const { recap, coverage } = buildRecapPayload(db, dateStr)

  // Timeline — raw sessions mapped to normalized appKeys
  const timeline: TimelineEntry[] = rawSessions.map((s) => {
    const { appKey } = normalize(s.bundleId, s.appName)
    return {
      appKey,
      startAt: toISOWithOffset(s.startTime),
      endAt: toISOWithOffset(s.endTime ?? s.startTime + s.durationSeconds * 1000),
    }
  })

  // Top domains
  const rawDomains = getWebsiteSummariesForRange(db, fromMs, toMs)
  const topPagesByDomain = getTopPagesForDomains(
    db,
    fromMs,
    toMs,
    rawDomains.slice(0, 20).map((domain) => domain.domain),
    5,
  )
  const topDomains: TopDomain[] = rawDomains.slice(0, 20).map((d) => ({
    domain: d.domain,
    seconds: d.totalSeconds,
    category: 'browsing',
    topPages: (topPagesByDomain[d.domain] ?? []).map((page) => ({
      domain: d.domain,
      label: d.domain,
      seconds: page.totalSeconds,
    })),
  }))

  // Category overrides
  const overrideRows = db
    .prepare('SELECT bundle_id, category FROM category_overrides')
    .all() as { bundle_id: string; category: string }[]
  const categoryOverrides: Record<string, Category> = {}
  for (const row of overrideRows) {
    const { appKey } = normalize(row.bundle_id, '')
    categoryOverrides[appKey] = row.category as Category
  }

  // Focus sessions
  const rawFocus = getRecentFocusSessions(db, 50)
  const focusSessions: FocusSessionOut[] = rawFocus
    .filter((f) => f.startTime >= fromMs && f.startTime < toMs)
    .map((f) => ({
      sourceId: `win-focus-${f.id}`,
      startAt: toISOWithOffset(f.startTime),
      endAt: toISOWithOffset(f.endTime ?? Date.now()),
      actualDurationSec: f.durationSeconds,
      targetMinutes: f.targetMinutes ?? 0,
      status: f.endTime ? 'completed' as const : 'active' as const,
    }))

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    deviceId,
    platform: currentSnapshotPlatform(),
    date: dateStr,
    generatedAt: toISOWithOffset(Date.now()),
    isPartialDay,
    focusScore,
    focusSeconds,
    appSummaries,
    categoryTotals,
    timeline,
    topDomains,
    categoryOverrides,
    aiSummary: null,
    focusSessions,
    focusScoreV2: {
      score: focusBreakdown.score,
      coherence: focusBreakdown.coherence,
      deepWorkDensity: focusBreakdown.deepWork,
      artifactProgress: focusBreakdown.artifactProgress,
      switchPenalty: focusBreakdown.switchPenalty,
    },
    workBlocks: summarizeWorkBlocks(safeTimelinePayload.blocks),
    recap,
    coverage,
    topWorkstreams: buildWorkstreamRollups(safeTimelinePayload.blocks),
    standoutArtifacts: buildArtifactRollups(safeTimelinePayload.blocks),
    entities: loadEntityRollups(db, dateStr),
    privacyFiltered: false,
  }
}
