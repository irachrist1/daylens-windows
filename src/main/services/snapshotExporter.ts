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
import { computeFocusScore, isCategoryFocused } from '../lib/focusScore'

// ─── Types matching DaySnapshot v1 contract ──────────────────────────────────

interface AppSummaryOut {
  appKey: string
  bundleID?: string
  displayName: string
  category: string
  totalSeconds: number
  sessionCount: number
  iconBase64?: string
}

interface CategoryTotal {
  category: string
  totalSeconds: number
}

interface TimelineEntry {
  appKey: string
  startAt: string
  endAt: string
}

interface TopDomain {
  domain: string
  seconds: number
  category: string
  topPages?: TopPage[]
}

interface TopPage {
  url: string
  title?: string | null
  seconds: number
}

interface FocusSessionOut {
  sourceId: string
  startAt: string
  endAt: string
  actualDurationSec: number
  targetMinutes: number
  status: 'completed' | 'cancelled' | 'active'
}

interface DaySnapshot {
  schemaVersion: 1
  deviceId: string
  platform: 'windows'
  date: string
  generatedAt: string
  isPartialDay: boolean
  focusScore: number
  focusSeconds: number
  appSummaries: AppSummaryOut[]
  categoryTotals: CategoryTotal[]
  timeline: TimelineEntry[]
  topDomains: TopDomain[]
  categoryOverrides: Record<string, string>
  aiSummary: string | null
  focusSessions: FocusSessionOut[]
}

// ─── Normalization map ───────────────────────────────────────────────────────

interface NormalizationMap {
  aliases: Record<string, string>
  catalog: Record<string, { displayName: string; defaultCategory: string }>
}

let _normMap: NormalizationMap | null = null

function getNormMap(): NormalizationMap {
  if (_normMap) return _normMap

  // Try loading from bundled resource, fallback to hardcoded path
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'app-normalization.v1.json'),
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

function normalize(bundleId: string, appName: string): { appKey: string; displayName: string; category: string } {
  const map = getNormMap()

  // Try exact bundleId match first, then just the exe filename
  const exeName = path.basename(bundleId).toLowerCase()
  const appKey = map.aliases[bundleId] || map.aliases[exeName] || exeName.replace(/\.exe$/i, '')

  const catalogEntry = map.catalog[appKey]
  if (catalogEntry) {
    return {
      appKey,
      displayName: catalogEntry.displayName,
      category: catalogEntry.defaultCategory,
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
  const d = new Date(ms)
  const tzOffset = -d.getTimezoneOffset()
  const sign = tzOffset >= 0 ? '+' : '-'
  const absOffset = Math.abs(tzOffset)
  const hh = String(Math.floor(absOffset / 60)).padStart(2, '0')
  const mm = String(absOffset % 60).padStart(2, '0')
  return d.toISOString().replace('Z', `${sign}${hh}:${mm}`)
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function exportSnapshot(dateStr: string, deviceId: string): DaySnapshot {
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
  const catMap = new Map<string, number>()
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

  // Focus score
  const focusScore = computeFocusScore({
    focusedSeconds: focusSeconds,
    totalSeconds: totalTrackedSeconds,
    switchesPerHour,
  })

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
    rawDomains.slice(0, 10).map((domain) => domain.domain),
    5,
  )
  const topDomains: TopDomain[] = rawDomains.slice(0, 10).map((d) => ({
    domain: d.domain,
    seconds: d.totalSeconds,
    category: 'browsing',
    topPages: (topPagesByDomain[d.domain] ?? []).map((page) => ({
      url: page.url,
      title: page.title,
      seconds: page.totalSeconds,
    })),
  }))

  // Category overrides
  const overrideRows = db
    .prepare('SELECT bundle_id, category FROM category_overrides')
    .all() as { bundle_id: string; category: string }[]
  const categoryOverrides: Record<string, string> = {}
  for (const row of overrideRows) {
    const { appKey } = normalize(row.bundle_id, '')
    categoryOverrides[appKey] = row.category
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
      targetMinutes: 0,
      status: f.endTime ? 'completed' as const : 'active' as const,
    }))

  return {
    schemaVersion: 1,
    deviceId,
    platform: 'windows',
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
  }
}
