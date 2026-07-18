import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  clearBlockLabelOverride,
  setBlockLabelOverride,
  getAppCharacter,
  getAllAppsForLabeling,
  getCategoryOverrideEffect,
  getSessionsForRange,
  getSessionsForApp,
  setCategoryOverride,
  clearCategoryOverride,
  getCategoryOverrides,
} from '../db/queries'
import {
  getWorkMemoryProfile,
  updateWorkMemoryFact,
  addWorkMemoryFact,
  forgetWorkMemoryFact,
  rebuildWorkMemory,
  getMemoryAudit,
  getScopedMemoryProfile,
  addClientMemoryFact,
} from '../services/workMemoryProfile'
import { getAppDetailProjection, getArtifactDetailProjection, getHistoryDayProjection, getTimelineDayProjection, getWorkflowPatternsProjection, getWeeklySummaryProjection, materializeTimelineDayProjection } from '../core/query/projections'
import {
  getCorrectedAppSummariesForRange,
  getCorrectedPeakHours as getPeakHours,
  getCorrectedWebsiteSummariesForRange as getWebsiteSummariesForRange,
} from '../services/activityFacts'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import {
  resolveClientQuery,
  resolveDayContext,
  findClientByName,
  listClients,
  listClientsDetailed,
  createClient,
  updateClient,
  archiveClient,
  restoreClient,
  deleteClient,
  getOrCreateClientByName,
  getRollupSummary,
} from '../core/query/attributionResolvers'
import type { ClientRecord } from '../core/query/attributionResolvers'
import { runAttributionForRange } from '../services/attribution'
import { backfillMemoryFromHistory } from '../jobs/eveningConsolidation'
import { getDb, tableExists } from '../services/database'
import { setSettings } from '../services/settings'
import { flushCurrentSession, getCurrentSession, getLinuxTrackingDiagnostics, trackingStatus } from '../services/tracking'
import { getBrowserStatus } from '../services/browser'
import { isWindowsFocusCaptureRunning } from '../services/windowsFocusCapture'
import { deleteHistoryForApp, deleteHistoryForSite, deleteTrackedActivity } from '../services/trackingHistory'
import { getProcessMetrics } from '../services/processMonitor'
import { getBlockDetailPayload, getDistractionCostPayload, getRecapRange, writeTimelineBlockReview, mergeTimelineEpisodes, trimTimelineBlockSpan, invalidateTimelineDayBlocks } from '../services/workBlocks'
import { getTimelineRangeBlocks } from '../services/timelineCalendarRange'
import { computeAppActivityDigest } from '../services/appActivityDigest'
import { analyzeTimelineDay } from '../services/analyzeDay'
import { resolveIcon } from '../services/iconResolver'
import { getLinuxDesktopDiagnostics } from '../services/linuxDesktop'
import { applyTimelineBlockEdit } from '../services/timelineBlockEdits'
import { IPC, isAppCategory } from '@shared/types'
import {
  getTrackingPermissionDetails,
  getTrackingPermissionState,
  requestScreenTrackingPermission,
} from '../services/trackingPermissions'
import type {
  AppSession,
  WorkSessionPayload,
  WorkSessionApp,
  ActivitySegmentPayload,
  ClientDetailPayload,
  IconRequest,
  ProjectSummary,
  RollupEntry,
  DayWorkSessionsPayload,
  DayTimelinePayload,
  WorkContextBlock,
  TimelineWorkSession,
  TimelineBlockReviewUpdate,
  TimelineBlockEditPayload,
  TimelineBlockEditResult,
  PurgeTrackedEvidencePayload,
  WorkMemorySettingsSummary,
} from '@shared/types'
import { FOCUSED_CATEGORIES, ALL_TIME_DAYS } from '@shared/types'
import { isRealDayHarness } from '../lib/realDayHarness'
import { getCaptureEventRejections } from '../lib/captureRejections'

// ─── Date helpers ─────────────────────────────────────────────────────────────

// Returns today's date as a local YYYY-MM-DD string.
// DO NOT use new Date().toISOString().split('T')[0] — that returns the UTC date,
// which is wrong in UTC- timezones (e.g. EST) after ~7pm.
function localDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function syncActiveClientNamesToSettings(db = getDb()): Promise<void> {
  const names = listClientsDetailed(db)
    .filter((client) => client.status === 'active')
    .map((client) => client.name)
  await setSettings({ userClients: names })
}

// Returns [fromMs, toMs] spanning the full local calendar day for a YYYY-MM-DD string.
// Constructs from year/month/day components so the result is always local midnight,
// regardless of how Date() parses ISO strings (which vary by platform/timezone).
function dayBounds(dateStr: string): [number, number] {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(y, m - 1, d).getTime()  // local midnight
  const to = new Date(y, m - 1, d + 1).getTime()
  return [from, to]
}

function shiftLocalDate(dateStr: string, offset: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(y, m - 1, d + offset)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

function localDateStringForTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function getWorkMemorySettingsSummary(db: ReturnType<typeof getDb>): WorkMemorySettingsSummary {
  if (!tableExists(db, 'context_patterns')) {
    return { promotedCount: 0, totalOccurrences: 0, topPatterns: [] }
  }

  const promoted = db.prepare(`
    SELECT COUNT(*) AS count
    FROM context_patterns
    WHERE status = 'promoted'
  `).get() as { count: number }

  const totalOccurrences = tableExists(db, 'pattern_occurrences')
    ? (db.prepare(`SELECT COUNT(*) AS count FROM pattern_occurrences`).get() as { count: number }).count
    : 0

  const topPatterns = db.prepare(`
    SELECT
      context_patterns.id,
      context_patterns.label_suggestion AS label,
      context_patterns.category_suggestion AS category,
      context_patterns.confidence,
      context_patterns.recall_count AS recallCount,
      context_patterns.updated_at AS updatedAt,
      COUNT(pattern_occurrences.id) AS occurrenceCount
    FROM context_patterns
    LEFT JOIN pattern_occurrences
      ON pattern_occurrences.pattern_id = context_patterns.id
    WHERE context_patterns.status = 'promoted'
    GROUP BY context_patterns.id
    ORDER BY context_patterns.confidence DESC, occurrenceCount DESC, context_patterns.updated_at DESC
    LIMIT 5
  `).all() as WorkMemorySettingsSummary['topPatterns']

  return {
    promotedCount: promoted.count,
    totalOccurrences,
    topPatterns,
  }
}

function forgetWorkMemoryPattern(db: ReturnType<typeof getDb>, patternId: string): WorkMemorySettingsSummary {
  if (tableExists(db, 'pattern_occurrences')) {
    db.prepare(`DELETE FROM pattern_occurrences WHERE pattern_id = ?`).run(patternId)
  }
  if (tableExists(db, 'context_patterns')) {
    db.prepare(`DELETE FROM context_patterns WHERE id = ?`).run(patternId)
  }
  return getWorkMemorySettingsSummary(db)
}

function forgetAllWorkMemory(db: ReturnType<typeof getDb>): WorkMemorySettingsSummary {
  const tables = ['pattern_occurrences', 'context_patterns', 'user_memory_facts', 'daily_memory_archive', 'work_memory_facts']
  for (const table of tables) {
    if (tableExists(db, table)) db.prepare(`DELETE FROM ${table}`).run()
  }
  return getWorkMemorySettingsSummary(db)
}

// ─── Work session payload helpers ────────────────────────────────────────────

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function buildAppNameMap(db: ReturnType<typeof getDb>, bundleIds: string[]): Map<string, string> {
  const uniqueBundleIds = [...new Set(bundleIds.filter(Boolean))]
  const map = new Map<string, string>()
  if (uniqueBundleIds.length === 0) return map

  const inClause = placeholders(uniqueBundleIds)
  const rows = db.prepare(`
    SELECT bundle_id, app_name
    FROM apps
    WHERE bundle_id IN (${inClause})
  `).all(...uniqueBundleIds) as Array<{ bundle_id: string; app_name: string }>
  for (const r of rows) map.set(r.bundle_id, r.app_name)

  const unresolvedBundleIds = uniqueBundleIds.filter((bundleId) => !map.has(bundleId))
  if (unresolvedBundleIds.length > 0) {
    const legacyRows = db.prepare(`
      SELECT sessions.bundle_id, sessions.app_name
      FROM app_sessions sessions
      JOIN (
        SELECT bundle_id, MAX(start_time) AS latest_start
        FROM app_sessions
        WHERE bundle_id IN (${placeholders(unresolvedBundleIds)})
        GROUP BY bundle_id
      ) latest
        ON latest.bundle_id = sessions.bundle_id
       AND latest.latest_start = sessions.start_time
    `).all(...unresolvedBundleIds) as Array<{ bundle_id: string; app_name: string }>
    for (const r of legacyRows) {
      if (!map.has(r.bundle_id)) map.set(r.bundle_id, r.app_name)
    }
  }

  return map
}

interface WsRow {
  id: string
  started_at: number
  ended_at: number
  duration_ms: number
  active_ms: number
  idle_ms: number
  client_id: string | null
  project_id: string | null
  attribution_status: string
  attribution_confidence: number | null
  title: string | null
  primary_bundle_id: string | null
  app_bundle_ids_json: string
}

function buildWorkSessionPayloads(db: ReturnType<typeof getDb>, whereClause: string, params: unknown[]): WorkSessionPayload[] {
  const rows = db.prepare(`SELECT * FROM work_sessions ${whereClause}`).all(...params) as WsRow[]
  if (rows.length === 0) return []

  const sessionIds = rows.map((row) => row.id)
  const sessionInClause = placeholders(sessionIds)

  const memberRows = db.prepare(`
    SELECT wss.work_session_id, wss.role, wss.contribution_ms, aseg.primary_bundle_id
    FROM work_session_segments wss
    JOIN activity_segments aseg ON aseg.id = wss.segment_id
    WHERE wss.work_session_id IN (${sessionInClause})
  `).all(...sessionIds) as Array<{
    work_session_id: string
    role: string
    contribution_ms: number
    primary_bundle_id: string
  }>
  const membersBySession = new Map<string, typeof memberRows>()
  for (const member of memberRows) {
    const existing = membersBySession.get(member.work_session_id)
    if (existing) existing.push(member)
    else membersBySession.set(member.work_session_id, [member])
  }

  const appNameMap = buildAppNameMap(db, memberRows.map((row) => row.primary_bundle_id))

  const clientIds = [...new Set(rows.map(r => r.client_id).filter(Boolean))] as string[]
  const projectIds = [...new Set(rows.map(r => r.project_id).filter(Boolean))] as string[]
  const clientMap = new Map<string, { name: string; color: string | null }>()
  const projectMap = new Map<string, string>()

  if (clientIds.length > 0) {
    const clientRows = db.prepare(`
      SELECT id, name, color
      FROM clients
      WHERE id IN (${placeholders(clientIds)})
    `).all(...clientIds) as Array<{ id: string; name: string; color: string | null }>
    for (const row of clientRows) clientMap.set(row.id, { name: row.name, color: row.color })
  }
  if (projectIds.length > 0) {
    const projectRows = db.prepare(`
      SELECT id, name
      FROM projects
      WHERE id IN (${placeholders(projectIds)})
    `).all(...projectIds) as Array<{ id: string; name: string }>
    for (const row of projectRows) projectMap.set(row.id, row.name)
  }

  const evidenceRows = db.prepare(`
    SELECT work_session_id, evidence_type, evidence_value, weight
    FROM work_session_evidence
    WHERE work_session_id IN (${sessionInClause})
    ORDER BY work_session_id ASC, weight DESC
  `).all(...sessionIds) as Array<{
    work_session_id: string
    evidence_type: string
    evidence_value: string
    weight: number
  }>
  const evidenceBySession = new Map<string, typeof evidenceRows>()
  for (const evidence of evidenceRows) {
    const existing = evidenceBySession.get(evidence.work_session_id)
    if (existing) {
      if (existing.length < 10) existing.push(evidence)
    } else {
      evidenceBySession.set(evidence.work_session_id, [evidence])
    }
  }

  return rows.map(ws => {
    const members = membersBySession.get(ws.id) ?? []

    const appMs = new Map<string, { ms: number; role: string }>()
    for (const m of members) {
      const existing = appMs.get(m.primary_bundle_id)
      if (existing) existing.ms += m.contribution_ms
      else appMs.set(m.primary_bundle_id, { ms: m.contribution_ms, role: m.role })
    }
    const apps: WorkSessionApp[] = [...appMs.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([bundleId, { ms, role }]) => ({
        app_name: appNameMap.get(bundleId) ?? bundleId.split('.').pop() ?? bundleId,
        duration_ms: ms,
        role,
      }))
    const evidence = evidenceBySession.get(ws.id) ?? []

    const clientInfo = ws.client_id ? clientMap.get(ws.client_id) : null

    return {
      id: ws.id,
      started_at: ws.started_at,
      ended_at: ws.ended_at,
      duration_ms: ws.duration_ms,
      active_ms: ws.active_ms,
      idle_ms: ws.idle_ms,
      client_id: ws.client_id,
      client_name: clientInfo?.name ?? null,
      client_color: clientInfo?.color ?? null,
      project_id: ws.project_id,
      project_name: ws.project_id ? (projectMap.get(ws.project_id) ?? null) : null,
      attribution_status: ws.attribution_status as 'attributed' | 'ambiguous' | 'unattributed',
      attribution_confidence: ws.attribution_confidence,
      title: ws.title,
      apps,
      evidence: evidence.map(e => ({ type: e.evidence_type, value: e.evidence_value, weight: e.weight })),
    }
  })
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function registerDbHandlers(): void {
  // Today's app summaries — uses local calendar day, not UTC day.
  // Corrected facts (invariant 7): a Timeline block the user deleted is
  // subtracted here too, so Today's totals agree with the Timeline.
  ipcMain.handle(IPC.DB.GET_TODAY, () => {
    const [from, to] = dayBounds(localDateString())
    return getCorrectedAppSummariesForRange(getDb(), from, to)
  })

  // Raw sessions for a given date — used by History and Today timeline
  ipcMain.handle(IPC.DB.GET_HISTORY, (_e, dateStr: string) => {
    const [from, to] = dayBounds(dateStr)
    return mergeLiveSessionForDate(getSessionsForRange(getDb(), from, to), dateStr)
  })

  ipcMain.handle(IPC.DB.GET_HISTORY_DAY, (_e, dateStr: string) => {
    return getHistoryDayProjection(getDb(), dateStr, getLiveSessionForDate(dateStr), { materialize: false })
  })

  ipcMain.handle(IPC.DB.GET_TIMELINE_DAY, (_e, dateStr: string) => {
    const payload = getTimelineDayProjection(getDb(), dateStr, getLiveSessionForDate(dateStr), { materialize: false })
    return payload
  })

  ipcMain.handle(IPC.DB.REBUILD_TIMELINE_DAY, async (_e, dateStr: string, hint?: string) => {
    // "Rebuild" is intentionally no longer a destructive block wipe. Days
    // already self-heal on open; the useful manual action is to spend AI work
    // only where the day is still on a deterministic floor or low-confidence
    // label, preserving curated AI labels and user overrides. An optional hint
    // (what the user says they actually did today) is passed to the model as a
    // strong grounding signal when the evidence alone is thin.
    // Manual "Analyze" is now a thin wrapper over the one shared analyze
    // pipeline (regroup → merge → relabel) that the automatic day-rollover /
    // startup finalization also runs, so invariant 3 is enforced identically
    // whether or not the user clicks. See services/analyzeDay.ts.
    const result = await analyzeTimelineDay(getDb(), dateStr, {
      userHint: hint?.trim() || undefined,
      resolveLiveSession: getLiveSessionForDate,
      triggerSource: 'user',
    })
    return result.payload
  })

  ipcMain.handle(IPC.DB.GET_RECAP_RANGE, (_e, dates: string[]) => {
    return getRecapRange(getDb(), dates)
  })

  // Calendar month grid — persisted blocks for a date range, one light query.
  ipcMain.handle(IPC.DB.GET_TIMELINE_RANGE_BLOCKS, (_e, fromDate: string, toDate: string) => {
    return getTimelineRangeBlocks(getDb(), fromDate, toDate)
  })

  // App usage summaries for a range — used by Apps view
  // days=1 → today since local midnight (not rolling 24h)
  // days=7/30 → rolling window ending at end of today
  // Corrected facts (invariant 7): deleted Timeline blocks are subtracted, so
  // the Apps list totals never disagree with the Timeline. Raw capture stays
  // stored untouched underneath.
  ipcMain.handle(IPC.DB.GET_APP_SUMMARIES, (_e, days: number = 7) => {
    // Normalize at the boundary so every period reaches one canonical query.
    const normalizedDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 7
    const [todayFrom, todayTo] = dayBounds(localDateString())
    if (normalizedDays <= 1) {
      return getCorrectedAppSummariesForRange(getDb(), todayFrom, todayTo)
    }
    // All-time: one query over all captured history. Avoids the day-by-day
    // cache loop, which would iterate ~36,500 times for this sentinel.
    if (normalizedDays >= ALL_TIME_DAYS) {
      return getCorrectedAppSummariesForRange(getDb(), 0, todayTo)
    }
    const [from] = dayBounds(shiftLocalDate(localDateString(), -(normalizedDays - 1)))
    return getCorrectedAppSummariesForRange(getDb(), from, todayTo)
  })

  // C23 / D6: Apps view date switcher. Returns summaries for a specific
  // calendar day through the same canonical query as Today/7d/30d/All-time.
  // Derived sessions are a Timeline projection and use a different concept of
  // session count; reading them here caused past days to resurrect system noise
  // and thousands of micro-sessions.
  ipcMain.handle(IPC.DB.GET_APP_SUMMARIES_FOR_DATE, (_e, dateStr: string) => {
    const [from, to] = dayBounds(dateStr)
    return getCorrectedAppSummariesForRange(getDb(), from, to)
  })

  ipcMain.handle(IPC.DB.GET_ALL_APPS_FOR_LABELING, () => {
    return getAllAppsForLabeling(getDb())
  })

  ipcMain.handle(IPC.DB.SET_CATEGORY_OVERRIDE, (_e, bundleId: string, category: string) => {
    // Validate at the boundary — never persist an arbitrary renderer string as a category.
    if (!isAppCategory(category)) {
      throw new Error(`Invalid category: ${String(category)}`)
    }
    setCategoryOverride(getDb(), bundleId, category)
    invalidateProjectionScope('timeline', 'category_override')
    invalidateProjectionScope('apps', 'category_override')
    invalidateProjectionScope('insights', 'category_override')
    // Report what the relabel touched so Settings never changes silently.
    return getCategoryOverrideEffect(getDb(), bundleId)
  })

  ipcMain.handle(IPC.DB.CLEAR_CATEGORY_OVERRIDE, (_e, bundleId: string) => {
    clearCategoryOverride(getDb(), bundleId)
    invalidateProjectionScope('timeline', 'category_override')
    invalidateProjectionScope('apps', 'category_override')
    invalidateProjectionScope('insights', 'category_override')
  })

  ipcMain.handle(IPC.DB.GET_CATEGORY_OVERRIDES, () => {
    return getCategoryOverrides(getDb())
  })

  // Per-app session drill-down — used by Apps detail panel
  ipcMain.handle(IPC.DB.GET_APP_SESSIONS, (_e, bundleId: string, days: number = 7) => {
    const [todayFrom, todayTo] = dayBounds(localDateString())
    if (days <= 1) return getSessionsForApp(getDb(), bundleId, todayFrom, todayTo)
    const from = todayFrom - (days - 1) * 86_400_000
    return getSessionsForApp(getDb(), bundleId, from, todayTo)
  })

  // Website summaries — used by Today's Top Websites card
  ipcMain.handle(IPC.DB.GET_WEBSITE_SUMMARIES, (_e, days: number = 1) => {
    const [todayFrom, todayTo] = dayBounds(localDateString())
    if (days <= 1) return getWebsiteSummariesForRange(getDb(), todayFrom, todayTo)
    const from = todayFrom - (days - 1) * 86_400_000
    return getWebsiteSummariesForRange(getDb(), from, todayTo)
  })

  ipcMain.handle(IPC.DB.GET_PEAK_HOURS, () => {
    const now = Date.now()
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000
    return getPeakHours(getDb(), fourteenDaysAgo, now)
  })

  ipcMain.handle(IPC.DB.GET_WEEKLY_SUMMARY, (_e, endDateStr: string) => {
    return getWeeklySummaryProjection(getDb(), endDateStr)
  })

  ipcMain.handle(IPC.DB.GET_APP_CHARACTER, (_e, bundleId: string, daysBack: number) => {
    return getAppCharacter(getDb(), bundleId, daysBack)
  })

  ipcMain.handle(IPC.DB.GET_APP_DETAIL, (_e, canonicalAppId: string, days: number = 7) => {
    return getAppDetailProjection(getDb(), canonicalAppId, days, getCurrentSession())
  })

  // Per-app activity digest. Retained for reuse though the Apps list no longer
  // leads with it (DEV-89 made the app name the row title); the artifact-
  // surfacing policy it encodes is covered by appActivityDigest tests.
  ipcMain.handle(IPC.DB.GET_APP_ACTIVITY_DIGEST, (_e, days: number = 1): import('@shared/types').AppActivityDigest[] => {
    const db = getDb()
    const today = localDateString()
    const dayCount = Math.max(1, days)
    const [todayY, todayM, todayD] = today.split('-').map(Number)
    const blocks: import('@shared/types').WorkContextBlock[] = []
    for (let offset = 0; offset < dayCount; offset++) {
      const dt = new Date(todayY, todayM - 1, todayD)
      dt.setDate(dt.getDate() - offset)
      const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      const payload = getTimelineDayProjection(db, dateStr, getLiveSessionForDate(dateStr), { materialize: false })
      for (const block of payload.blocks) blocks.push(block)
    }
    return computeAppActivityDigest(blocks)
  })

  ipcMain.handle(IPC.DB.GET_WORK_MEMORY_SUMMARY, () => {
    return getWorkMemorySettingsSummary(getDb())
  })

  ipcMain.handle(IPC.DB.FORGET_WORK_MEMORY_PATTERN, (_e, patternId: string) => {
    return forgetWorkMemoryPattern(getDb(), patternId)
  })

  ipcMain.handle(IPC.DB.FORGET_ALL_WORK_MEMORY, () => {
    return forgetAllWorkMemory(getDb())
  })

  ipcMain.handle(IPC.DB.BACKFILL_WORK_MEMORY, () => {
    return backfillMemoryFromHistory(getDb())
  })

  // Editable work-memory profile (ChatGPT-style).
  ipcMain.handle(IPC.DB.GET_WORK_MEMORY_PROFILE, () => {
    return getWorkMemoryProfile(getDb())
  })

  ipcMain.handle(IPC.DB.UPDATE_WORK_MEMORY_FACT, (_e, id: string, text: string) => {
    return updateWorkMemoryFact(getDb(), id, text)
  })

  ipcMain.handle(IPC.DB.ADD_WORK_MEMORY_FACT, (_e, text: string) => {
    return addWorkMemoryFact(getDb(), text)
  })

  ipcMain.handle(IPC.DB.FORGET_WORK_MEMORY_FACT, (_e, id: string) => {
    return forgetWorkMemoryFact(getDb(), id)
  })

  ipcMain.handle(IPC.DB.REBUILD_WORK_MEMORY, () => {
    return rebuildWorkMemory(getDb())
  })

  ipcMain.handle(IPC.DB.GET_MEMORY_AUDIT, () => {
    return getMemoryAudit(getDb())
  })

  // DEV-108: general memory + each client's scoped memory, for the Manage-memory
  // view (memory.md §3 — "organized under each client").
  ipcMain.handle(IPC.DB.GET_SCOPED_MEMORY_PROFILE, () => {
    return getScopedMemoryProfile(getDb())
  })

  ipcMain.handle(IPC.DB.ADD_CLIENT_MEMORY_FACT, (_e, clientId: string, text: string) => {
    return addClientMemoryFact(getDb(), clientId, text)
  })

  ipcMain.handle(IPC.DB.GET_BLOCK_DETAIL, (_e, blockId: string) => {
    return getBlockDetailPayload(getDb(), blockId, getCurrentSession())
  })

  ipcMain.handle(IPC.DB.GET_WORKFLOW_SUMMARIES, (_e, days: number = 14) => {
    return getWorkflowPatternsProjection(getDb(), days)
  })

  ipcMain.handle(IPC.DB.GET_ARTIFACT_DETAILS, (_e, artifactId: string) => {
    return getArtifactDetailProjection(getDb(), artifactId)
  })

  ipcMain.handle(IPC.DB.SET_BLOCK_LABEL_OVERRIDE, (_e, payload: { blockId: string; date?: string | null; label: string; narrative?: string | null }) => {
    const db = getDb()
    let block: WorkContextBlock | null = null
    if (payload.date) {
      const dayPayload = materializeTimelineDayProjection(db, payload.date, getLiveSessionForDate(payload.date))
      block = dayPayload.blocks.find((candidate) => candidate.id === payload.blockId) ?? null
    }
    block = block ?? getBlockDetailPayload(db, payload.blockId, getCurrentSession())
    if (!block) throw new Error('Block not found.')
    const dateStr = payload.date ?? localDateStringForTimestamp(block.startTime)
    writeTimelineBlockReview(db, dateStr, block, {
      state: 'corrected',
      correctedLabel: payload.label,
    })
    setBlockLabelOverride(db, payload.blockId, payload.label, payload.narrative ?? null)
    invalidateProjectionScope('timeline', 'block_label_override')
    invalidateProjectionScope('apps', 'block_label_override')
    invalidateProjectionScope('insights', 'block_label_override')
  })

  ipcMain.handle(IPC.DB.CLEAR_BLOCK_LABEL_OVERRIDE, (_e, blockId: string) => {
    const db = getDb()
    clearBlockLabelOverride(db, blockId)
    // A rename is stored in two places: the override AND an evidence-keyed
    // review correction (so it survives a rebuild). Undo must clear BOTH, or
    // the review's correctedLabel keeps winning and the rename never goes away.
    const block = getBlockDetailPayload(db, blockId, getCurrentSession())
    if (block) {
      writeTimelineBlockReview(db, localDateStringForTimestamp(block.startTime), block, {
        state: 'auto-approved',
        correctedLabel: null,
      })
    }
    invalidateProjectionScope('timeline', 'block_label_override')
    invalidateProjectionScope('apps', 'block_label_override')
    invalidateProjectionScope('insights', 'block_label_override')
  })

  ipcMain.handle(IPC.DB.SET_BLOCK_REVIEW, (_e, payload: TimelineBlockReviewUpdate) => {
    const db = getDb()
    let block: WorkContextBlock | null = null
    if (payload.date) {
      const dayPayload = materializeTimelineDayProjection(db, payload.date, getLiveSessionForDate(payload.date))
      block = dayPayload.blocks.find((candidate) => candidate.id === payload.blockId) ?? null
    }
    block = block ?? getBlockDetailPayload(db, payload.blockId, getCurrentSession())
    if (!block) throw new Error('Block not found.')

    const dateStr = payload.date ?? localDateStringForTimestamp(block.startTime)
    writeTimelineBlockReview(db, dateStr, block, {
      state: payload.state,
      correctedLabel: payload.correctedLabel,
      correctedIntentRole: payload.correctedIntentRole,
      correctedIntentSubject: payload.correctedIntentSubject,
      correctedCategory: payload.correctedCategory,
    })

    if (payload.state === 'corrected' && payload.correctedLabel?.trim()) {
      setBlockLabelOverride(db, payload.blockId, payload.correctedLabel, block.label.narrative)
    }

    invalidateProjectionScope('timeline', 'block_review')
    invalidateProjectionScope('apps', 'block_review')
    invalidateProjectionScope('insights', 'block_review')
  })

  // Delete a block: a native confirm (macOS and Windows message box), then the
  // block is recorded as an 'ignored' review correction. Corrections win and
  // survive rebuilds (invariant 8): every read path filters ignored blocks, and
  // the day rebuilder excludes the deleted span's sessions so the block cannot
  // resurface inside a neighbour on the next Analyze. Raw captured activity is
  // never destroyed.
  ipcMain.handle(IPC.DB.DELETE_TIMELINE_BLOCK, async (event, payload: { blockId: string; date?: string | null }): Promise<{ deleted: boolean }> => {
    const db = getDb()
    let block: WorkContextBlock | null = null
    if (payload.date) {
      const dayPayload = materializeTimelineDayProjection(db, payload.date, getLiveSessionForDate(payload.date))
      block = dayPayload.blocks.find((candidate) => candidate.id === payload.blockId) ?? null
    }
    block = block ?? getBlockDetailPayload(db, payload.blockId, getCurrentSession())
    if (!block) throw new Error('Block not found.')

    const dateStr = payload.date ?? localDateStringForTimestamp(block.startTime)
    const timeRange = `${new Date(block.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(block.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      title: 'Delete this block',
      message: 'Are you sure?',
      detail: `"${block.label.current}" (${timeRange}) will be removed from your timeline and every view that reads it. This survives re-analysis.`,
      buttons: ['Delete', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    }
    const { response } = isRealDayHarness()
      ? { response: 0 }
      : window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
    if (response !== 0) return { deleted: false }

    writeTimelineBlockReview(db, dateStr, block, { state: 'ignored' })
    invalidateProjectionScope('timeline', 'block_review')
    invalidateProjectionScope('apps', 'block_review')
    invalidateProjectionScope('insights', 'block_review')
    return { deleted: true }
  })

  // Trim a block's time range (block editor). Trim-only: edges move inward,
  // never outward — a block is tracked activity, and Daylens never counts
  // idle time as work. Each moved edge is persisted as a user "cut here"
  // that survives every rebuild; the trimmed-off stretch re-forms into its
  // own block(s), so every tracked minute stays accounted for.
  ipcMain.handle(IPC.DB.SET_BLOCK_SPAN, (_e, payload: { blockId: string; date: string; startMs: number; endMs: number }): { changed: boolean } => {
    const db = getDb()
    const dayPayload = materializeTimelineDayProjection(db, payload.date, getLiveSessionForDate(payload.date))
    const block = dayPayload.blocks.find((candidate) => candidate.id === payload.blockId) ?? null
    if (!block) throw new Error('Block not found.')
    if (block.provisional) throw new Error('Analyze the day before editing block times.')
    const result = trimTimelineBlockSpan(db, payload.date, block, payload.startMs, payload.endMs)
    if (result.changed) {
      invalidateProjectionScope('timeline', 'block_span')
      invalidateProjectionScope('apps', 'block_span')
      invalidateProjectionScope('insights', 'block_span')
    }
    return result
  })

  ipcMain.handle(IPC.DB.UPDATE_TIMELINE_BLOCK, (_e, payload: TimelineBlockEditPayload): TimelineBlockEditResult => {
    const db = getDb()
    const dayPayload = materializeTimelineDayProjection(db, payload.date, getLiveSessionForDate(payload.date))
    const block = dayPayload.blocks.find((candidate) => candidate.id === payload.blockId) ?? null
    if (!block) throw new Error('Block not found.')

    const result = applyTimelineBlockEdit(db, block, payload)
    if (result.changed) {
      invalidateProjectionScope('timeline', 'block_edit', { date: payload.date })
      invalidateProjectionScope('apps', 'block_edit', { date: payload.date })
      invalidateProjectionScope('insights', 'block_edit', { date: payload.date })
    }
    return result
  })

  // Permanently purge a sensitive tracked record (block editor → remove
  // entry). This deletes the underlying rows — app sessions, website visits,
  // focus events, matching artifacts — inside the given span, so the record
  // is gone from every surface (timeline, apps, AI, wraps), not hidden. The
  // native confirm makes the irreversibility explicit. Raw data deletion is
  // the point here: sensitive records must be fully removable.
  ipcMain.handle(IPC.DB.PURGE_TRACKED_EVIDENCE, async (event, payload: PurgeTrackedEvidencePayload): Promise<{ purged: boolean }> => {
    const db = getDb()
    const subject = payload.kind === 'site' ? (payload.domain ?? '').trim() : (payload.appName ?? payload.bundleId ?? '').trim()
    if (!subject) throw new Error('Nothing to remove.')
    if (!(payload.toMs > payload.fromMs)) throw new Error('Invalid time span.')

    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      title: 'Remove tracked record',
      message: 'Permanently remove this record?',
      detail: `Everything tracked for "${subject}" in this block will be deleted from Daylens — timeline, apps, and AI. This cannot be undone.`,
      buttons: ['Remove permanently', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }
    const { response } = isRealDayHarness()
      ? { response: 0 }
      : window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
    if (response !== 0) return { purged: false }

    const { fromMs, toMs } = payload
    const run = db.transaction(() => {
      if (payload.kind === 'site' && payload.domain) {
        const domain = payload.domain
        const like = `%${domain}%`
        db.prepare(`DELETE FROM website_visits WHERE domain = ? AND visit_time >= ? AND visit_time < ?`)
          .run(domain, fromMs, toMs)
        db.prepare(`DELETE FROM focus_events WHERE ts_ms >= ? AND ts_ms < ? AND (url LIKE ? OR page_title LIKE ?)`)
          .run(fromMs, toMs, like, like)
        db.prepare(`DELETE FROM derived_sessions WHERE start_ts_ms >= ? AND start_ts_ms < ? AND domain = ?`)
          .run(fromMs, toMs, domain)
        // Artifact identities for the host are display aggregates; remove them
        // outright (mentions cascade). Other days' remaining data regenerates
        // its own artifacts on the next rebuild.
        db.prepare(`DELETE FROM artifacts WHERE host = ?`).run(domain)
      } else {
        const bundleId = payload.bundleId ?? ''
        const appName = payload.appName ?? bundleId
        db.prepare(`DELETE FROM app_sessions WHERE start_time >= ? AND start_time < ? AND (bundle_id = ? OR app_name = ?)`)
          .run(fromMs, toMs, bundleId, appName)
        db.prepare(`DELETE FROM focus_events WHERE ts_ms >= ? AND ts_ms < ? AND (app_bundle_id = ? OR app_name = ?)`)
          .run(fromMs, toMs, bundleId, appName)
        db.prepare(`DELETE FROM derived_sessions WHERE start_ts_ms >= ? AND start_ts_ms < ? AND (app_bundle_id = ? OR app_name = ?)`)
          .run(fromMs, toMs, bundleId, appName)
      }
    })
    run()

    const dateStr = localDateStringForTimestamp(fromMs)
    invalidateTimelineDayBlocks(db, dateStr)
    invalidateProjectionScope('timeline', 'evidence_purge')
    invalidateProjectionScope('apps', 'evidence_purge')
    invalidateProjectionScope('insights', 'evidence_purge')
    return { purged: true }
  })

  // Permanently purge an entire block (block editor → Delete block). Unlike
  // DELETE_TIMELINE_BLOCK (which hides the block behind an 'ignored' review
  // and keeps the raw capture), this deletes every tracked row inside the
  // block's span — app sessions, website visits, focus events, derived
  // sessions, artifact mentions — so a sensitive stretch is gone from every
  // surface and can never resurface on a rebuild. Same policy as
  // the per-record purge: full erasure of sensitive records
  // outranks retention. The 'ignored' review is still written as a backstop
  // for edge-overlapping sessions the span delete can't reach.
  ipcMain.handle(IPC.DB.PURGE_TIMELINE_BLOCK, async (event, payload: { blockId: string; date?: string | null }): Promise<{ purged: boolean }> => {
    const db = getDb()
    let block: WorkContextBlock | null = null
    if (payload.date) {
      const dayPayload = materializeTimelineDayProjection(db, payload.date, getLiveSessionForDate(payload.date))
      block = dayPayload.blocks.find((candidate) => candidate.id === payload.blockId) ?? null
    }
    block = block ?? getBlockDetailPayload(db, payload.blockId, getCurrentSession())
    if (!block) throw new Error('Block not found.')

    const dateStr = payload.date ?? localDateStringForTimestamp(block.startTime)
    const timeRange = `${new Date(block.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(block.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      title: 'Delete block and its data',
      message: 'Permanently delete this block?',
      detail: `"${block.label.current}" (${timeRange}) and everything tracked inside it — apps, sites, page titles — will be deleted from Daylens entirely. This cannot be undone.`,
      buttons: ['Delete permanently', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }
    const { response } = isRealDayHarness()
      ? { response: 0 }
      : window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options)
    if (response !== 0) return { purged: false }

    const fromMs = block.startTime
    const toMs = block.endTime
    const run = db.transaction(() => {
      db.prepare(`DELETE FROM app_sessions WHERE start_time >= ? AND start_time < ?`).run(fromMs, toMs)
      db.prepare(`DELETE FROM website_visits WHERE visit_time >= ? AND visit_time < ?`).run(fromMs, toMs)
      db.prepare(`DELETE FROM focus_events WHERE ts_ms >= ? AND ts_ms < ?`).run(fromMs, toMs)
      db.prepare(`DELETE FROM derived_sessions WHERE start_ts_ms >= ? AND start_ts_ms < ?`).run(fromMs, toMs)
      db.prepare(`DELETE FROM artifact_mentions WHERE start_time >= ? AND start_time < ?`).run(fromMs, toMs)
    })
    run()

    // Backstop: a session that started before the block's edge and bled in
    // survives the span delete — the ignored review keeps any remnant from
    // re-forming into a visible block on the next rebuild.
    writeTimelineBlockReview(db, dateStr, block, { state: 'ignored' })

    invalidateTimelineDayBlocks(db, dateStr)
    invalidateProjectionScope('timeline', 'block_purge')
    invalidateProjectionScope('apps', 'block_purge')
    invalidateProjectionScope('insights', 'block_purge')
    return { purged: true }
  })

  ipcMain.handle(IPC.DB.MERGE_TIMELINE_EPISODES, (_e, payload: { blockIds: [string, string]; date?: string | null }): DayTimelinePayload => {
    const db = getDb()
    const initialDate = payload.date ?? null
    let dayPayload = initialDate
      ? materializeTimelineDayProjection(db, initialDate, getLiveSessionForDate(initialDate))
      : null
    let first = resolveTimelineBlockForEdit(db, payload.blockIds[0], dayPayload)
    let second = resolveTimelineBlockForEdit(db, payload.blockIds[1], dayPayload)

    // If the selection touches the still-live block, close out the in-flight
    // session to the DB first so the merge has a persisted block (real session
    // ids) to anchor its boundary corrections to. Without this the live block
    // re-splits on the very next tracking tick (the "it still splits" bug).
    const touchesLive = [first, second].some(
      (b) => b && (b.isLive || b.provisional || b.sessions.some((s) => s.id < 0)),
    )
    if (touchesLive && initialDate) {
      flushCurrentSession()
      dayPayload = materializeTimelineDayProjection(db, initialDate, getLiveSessionForDate(initialDate))
      first = resolveTimelineBlockForEdit(db, payload.blockIds[0], dayPayload)
      second = resolveTimelineBlockForEdit(db, payload.blockIds[1], dayPayload)
    }
    if (!first || !second) throw new Error('Both blocks must exist to merge.')
    const dateStr = initialDate ?? localDateStringForTimestamp(first.startTime)
    // The renderer sends the two endpoints of the selection. Expand them into the
    // full contiguous span from the freshly materialized projection — a timeline
    // block can't have a hole, so every block between the endpoints is absorbed.
    const [lo, hi] = first.startTime <= second.startTime ? [first, second] : [second, first]
    const spanById = new Map<string, WorkContextBlock>()
    for (const candidate of dayPayload?.blocks ?? []) {
      if (candidate.startTime >= lo.startTime && candidate.startTime <= hi.startTime) {
        spanById.set(candidate.id, candidate)
      }
    }
    spanById.set(lo.id, lo)
    spanById.set(hi.id, hi)
    const span = [...spanById.values()].sort((a, b) => a.startTime - b.startTime)
    mergeTimelineEpisodes(db, dateStr, span)
    invalidateProjectionScope('timeline', 'episode_boundary')
    invalidateProjectionScope('apps', 'episode_boundary')
    invalidateProjectionScope('insights', 'episode_boundary')
    return materializeTimelineDayProjection(db, dateStr, getLiveSessionForDate(dateStr))
  })

  ipcMain.handle(IPC.DB.GET_DISTRACTION_COST, () => {
    return getDistractionCostPayload(getDb())
  })

  // Returns the current in-flight session (not yet flushed to DB) so the renderer
  // can display live totals without waiting for the next app switch.
  ipcMain.handle(IPC.TRACKING.GET_LIVE, () => getCurrentSession())
  ipcMain.handle(IPC.TRACKING.GET_DIAGNOSTICS, () => {
    const since = Date.now() - 15 * 60_000
    const db = getDb()
    const titleRows = db.prepare(`
      SELECT
        COUNT(*) AS recent_samples,
        SUM(CASE WHEN window_title IS NOT NULL AND trim(window_title) <> '' THEN 1 ELSE 0 END) AS with_title,
        MAX(CASE WHEN window_title IS NOT NULL AND trim(window_title) <> '' THEN ts_ms ELSE NULL END) AS last_captured_at
      FROM focus_events
      WHERE source IN ('nsworkspace_event', 'uia_foreground')
        AND event_type IN ('app_activated', 'window_changed', 'space_changed')
        AND ts_ms >= ?
    `).get(since) as {
      recent_samples: number
      with_title: number | null
      last_captured_at: number | null
    }

    let recentSamples = titleRows.recent_samples
    let recentSamplesWithTitle = titleRows.with_title ?? 0
    let lastCapturedAt = titleRows.last_captured_at

    if ((process.platform === 'win32' || process.platform === 'linux') && recentSamplesWithTitle === 0) {
      const sessionRows = db.prepare(`
        SELECT
          COUNT(*) AS recent_samples,
          SUM(CASE WHEN window_title IS NOT NULL AND trim(window_title) <> '' THEN 1 ELSE 0 END) AS with_title,
          MAX(CASE WHEN window_title IS NOT NULL AND trim(window_title) <> '' THEN start_time ELSE NULL END) AS last_captured_at
        FROM app_sessions
        WHERE start_time >= ?
      `).get(since) as {
        recent_samples: number
        with_title: number | null
        last_captured_at: number | null
      }
      recentSamples = Math.max(recentSamples, sessionRows.recent_samples)
      recentSamplesWithTitle = Math.max(recentSamplesWithTitle, sessionRows.with_title ?? 0)
      lastCapturedAt = lastCapturedAt ?? sessionRows.last_captured_at
    }

    const browserStatus = getBrowserStatus()
    const captureHelperRunning = process.platform === 'win32' ? isWindowsFocusCaptureRunning() : null

    return {
      platform: process.platform,
      trackingStatus: { ...trackingStatus },
      captureHealth: {
        permissions: getTrackingPermissionDetails(),
        windowTitles: {
          status: recentSamplesWithTitle > 0
            ? 'healthy'
            : recentSamples > 0
              ? 'missing'
              : 'waiting',
          recentSamples,
          recentSamplesWithTitle,
          lastCapturedAt,
        },
        browsers: {
          discoveredCount: browserStatus.discoveredBrowsers.length,
          names: browserStatus.discoveredBrowsers.map((browser) => browser.name),
          safariHistoryAccess: browserStatus.safariHistoryAccess,
        },
        captureHelperRunning,
        rejectedEvents: getCaptureEventRejections(),
      },
      linuxTracking: getLinuxTrackingDiagnostics(),
      linuxDesktop: getLinuxDesktopDiagnostics(),
    }
  })
  ipcMain.handle(IPC.TRACKING.GET_PERMISSION_STATE, () => getTrackingPermissionState())
  ipcMain.handle(IPC.TRACKING.GET_PERMISSION_DETAILS, () => getTrackingPermissionDetails())
  ipcMain.handle(IPC.TRACKING.REQUEST_SCREEN_PERMISSION, async () => requestScreenTrackingPermission())

  ipcMain.handle(IPC.TRACKING.GET_PROCESS_METRICS, () => {
    return getProcessMetrics()
  })

  // T3: delete already-captured history for an excluded app/site.
  ipcMain.handle(IPC.TRACKING.DELETE_APP_HISTORY, (_e, payload: { bundleId?: string | null; appName?: string | null }) => {
    return deleteHistoryForApp(payload ?? {})
  })
  ipcMain.handle(IPC.TRACKING.DELETE_SITE_HISTORY, (_e, payload: { domain: string }) => {
    return deleteHistoryForSite(payload ?? { domain: '' })
  })
  ipcMain.handle(IPC.TRACKING.DELETE_ACTIVITY, (_e, payload: {
    appSessionIds?: number[] | null
    derivedSessionIds?: number[] | null
    bundleId?: string | null
    canonicalAppId?: string | null
    appName?: string | null
    domain?: string | null
    url?: string | null
    normalizedUrl?: string | null
    pageKey?: string | null
    startTime?: number | null
    endTime?: number | null
    date?: string | null
  }) => {
    return deleteTrackedActivity(payload ?? {})
  })

  // ─── Attribution query resolvers ──────────────────────────────────────────
  ipcMain.handle(IPC.ATTRIBUTION.GET_CLIENT_QUERY, (
    _e, clientId: string, fromMs: number, toMs: number, question: string,
  ) => {
    return resolveClientQuery(clientId, fromMs, toMs, question, getDb())
  })

  ipcMain.handle(IPC.ATTRIBUTION.GET_DAY_CONTEXT, (_e, dateStr: string) => {
    return resolveDayContext(dateStr, getDb())
  })

  ipcMain.handle(IPC.ATTRIBUTION.FIND_CLIENT, (_e, name: string) => {
    return findClientByName(name, getDb())
  })

  ipcMain.handle(IPC.ATTRIBUTION.LIST_CLIENTS, () => {
    return listClients(getDb())
  })

  ipcMain.handle(IPC.ATTRIBUTION.LIST_CLIENTS_DETAILED, (): ClientRecord[] => {
    return listClientsDetailed(getDb())
  })

  ipcMain.handle(IPC.ATTRIBUTION.CREATE_CLIENT, async (_e, payload: { name: string; color?: string | null }): Promise<ClientRecord> => {
    const db = getDb()
    const client = createClient(payload, db)
    await syncActiveClientNamesToSettings(db)
    return client
  })

  ipcMain.handle(IPC.ATTRIBUTION.ENSURE_CLIENTS, async (_e, names: string[]): Promise<ClientRecord[]> => {
    const db = getDb()
    const uniqueNames = Array.from(new Set(
      (Array.isArray(names) ? names : [])
        .map((name) => String(name ?? '').trim())
        .filter(Boolean),
    )).slice(0, 24)
    const ensure = db.transaction(() => uniqueNames.map((name) => getOrCreateClientByName(name, db)))
    const clients = ensure()
    await syncActiveClientNamesToSettings(db)
    return clients
  })

  ipcMain.handle(IPC.ATTRIBUTION.UPDATE_CLIENT, async (_e, payload: { id: string; name?: string; color?: string | null }): Promise<ClientRecord | null> => {
    const db = getDb()
    const client = updateClient(payload, db)
    await syncActiveClientNamesToSettings(db)
    return client
  })

  ipcMain.handle(IPC.ATTRIBUTION.ARCHIVE_CLIENT, async (_e, id: string): Promise<boolean> => {
    const db = getDb()
    const ok = archiveClient(id, db)
    if (ok) {
      await syncActiveClientNamesToSettings(db)
      invalidateProjectionScope('timeline', 'client_archived')
      invalidateProjectionScope('apps', 'client_archived')
      invalidateProjectionScope('insights', 'client_archived')
    }
    return ok
  })

  ipcMain.handle(IPC.ATTRIBUTION.RESTORE_CLIENT, async (_e, id: string): Promise<boolean> => {
    const db = getDb()
    const ok = restoreClient(id, db)
    if (ok) {
      await syncActiveClientNamesToSettings(db)
      invalidateProjectionScope('timeline', 'client_restored')
      invalidateProjectionScope('apps', 'client_restored')
      invalidateProjectionScope('insights', 'client_restored')
    }
    return ok
  })

  ipcMain.handle(IPC.ATTRIBUTION.DELETE_CLIENT, async (_e, id: string): Promise<boolean> => {
    const db = getDb()
    const ok = deleteClient(id, db)
    if (ok) {
      await syncActiveClientNamesToSettings(db)
      invalidateProjectionScope('timeline', 'client_deleted')
      invalidateProjectionScope('apps', 'client_deleted')
      invalidateProjectionScope('insights', 'client_deleted')
    }
    return ok
  })

  ipcMain.handle(IPC.ATTRIBUTION.RUN_FOR_RANGE, (_e, fromMs: number, toMs: number) => {
    return runAttributionForRange(fromMs, toMs, {}, getDb())
  })

  // ─── New attribution data handlers for renderer views ────────────────────

  ipcMain.handle(IPC.ATTRIBUTION.GET_CLIENT_DETAIL, (_e, clientId: string, fromDate: string, toDate: string): ClientDetailPayload | null => {
    const db = getDb()
    const client = db.prepare(`SELECT id, name, color, status FROM clients WHERE id = ?`).get(clientId) as { id: string; name: string; color: string | null; status: string } | undefined
    if (!client) return null

    const projectCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM projects WHERE client_id = ? AND status = 'active'`).get(clientId) as { cnt: number }).cnt
    const projects = db.prepare(`SELECT id, client_id, name, color FROM projects WHERE client_id = ? AND status = 'active' ORDER BY name`).all(clientId) as ProjectSummary[]

    const rollupSummary = getRollupSummary(clientId, fromDate, toDate, db)

    // Get day bounds
    const [fy, fm, fd] = fromDate.split('-').map(Number)
    const [ty, tm, td] = toDate.split('-').map(Number)
    const fromMs = new Date(fy, fm - 1, fd).getTime()
    const toMs = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime()

    const sessions = buildWorkSessionPayloads(db, `WHERE client_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC`, [clientId, fromMs, toMs])
    const ambiguousSessions = buildWorkSessionPayloads(db, `WHERE attribution_status = 'ambiguous' AND started_at >= ? AND started_at <= ? AND id IN (
      SELECT DISTINCT wss.work_session_id FROM work_session_segments wss
      JOIN segment_attributions sa ON sa.segment_id = wss.segment_id
      WHERE sa.client_id = ? AND sa.confidence > 0.3
    ) ORDER BY started_at DESC`, [fromMs, toMs, clientId])

    return {
      client: { ...client, projectCount },
      projects,
      rollups: rollupSummary.by_day,
      sessions,
      ambiguous_sessions: ambiguousSessions,
    }
  })

  ipcMain.handle(IPC.ATTRIBUTION.GET_WORK_SESSIONS_FOR_DAY, (_e, dateStr: string): DayWorkSessionsPayload => {
    const db = getDb()
    const [y, m, d] = dateStr.split('-').map(Number)
    const fromMs = new Date(y, m - 1, d).getTime()
    const toMs = fromMs + 86_400_000

    const sessions = buildWorkSessionPayloads(db, `WHERE started_at >= ? AND started_at < ? ORDER BY started_at ASC`, [fromMs, toMs])

    // Merge live session if applicable
    const live = getCurrentSession()
    const liveEnd = Date.now()
    const liveSessions: TimelineWorkSession[] = sessions.map(s => ({ ...s }))

    if (live && liveEnd > fromMs && live.startTime < toMs) {
      // Check if live session overlaps any existing session
      const hasLive = sessions.some(s => s.started_at === live.startTime)
      if (!hasLive) {
        liveSessions.push({
          id: '__live__',
          started_at: Math.max(live.startTime, fromMs),
          ended_at: liveEnd,
          duration_ms: liveEnd - Math.max(live.startTime, fromMs),
          active_ms: liveEnd - Math.max(live.startTime, fromMs),
          idle_ms: 0,
          client_id: null,
          client_name: null,
          client_color: null,
          project_id: null,
          project_name: null,
          attribution_status: 'unattributed',
          attribution_confidence: null,
          title: live.appName,
          apps: [{ app_name: live.appName, duration_ms: liveEnd - Math.max(live.startTime, fromMs), role: 'primary' }],
          evidence: [],
          is_live: true,
        })
        liveSessions.sort((a, b) => a.started_at - b.started_at)
      }
    }

    let attributed = 0, ambiguous = 0, unattributed = 0
    for (const s of liveSessions) {
      if (s.attribution_status === 'attributed') attributed += s.active_ms
      else if (s.attribution_status === 'ambiguous') ambiguous += s.active_ms
      else unattributed += s.active_ms
    }

    return {
      date: dateStr,
      sessions: liveSessions,
      total_attributed_ms: attributed,
      total_ambiguous_ms: ambiguous,
      total_unattributed_ms: unattributed,
    }
  })

  ipcMain.handle(IPC.ATTRIBUTION.GET_WORK_SESSION_SEGMENTS, (_e, sessionId: string): ActivitySegmentPayload[] => {
    const db = getDb()
    const rows = db.prepare(`
      SELECT as2.id, as2.started_at, as2.ended_at, as2.duration_ms, as2.primary_bundle_id, as2.class
      FROM activity_segments as2
      JOIN work_session_segments wss ON wss.segment_id = as2.id
      WHERE wss.work_session_id = ?
      ORDER BY as2.started_at ASC
    `).all(sessionId) as Array<{ id: string; started_at: number; ended_at: number; duration_ms: number; primary_bundle_id: string; class: string }>

    const appNameMap = buildAppNameMap(db, rows.map((row) => row.primary_bundle_id))
    return rows.map(r => ({
      id: r.id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_ms: r.duration_ms,
      primary_app_name: appNameMap.get(r.primary_bundle_id) ?? r.primary_bundle_id.split('.').pop() ?? r.primary_bundle_id,
      class: r.class,
    }))
  })

  ipcMain.handle(IPC.ATTRIBUTION.GET_ROLLUPS, (_e, clientId: string | null, fromDate: string, toDate: string): RollupEntry[] => {
    const summary = getRollupSummary(clientId, fromDate, toDate, getDb())
    return summary.by_day
  })

  ipcMain.handle(IPC.ATTRIBUTION.GET_APP_WORK_SESSIONS, (_e, bundleId: string, days: number = 7): WorkSessionPayload[] => {
    const db = getDb()
    const [todayFrom, todayTo] = dayBounds(localDateString())
    const fromMs = days <= 1 ? todayFrom : todayFrom - (days - 1) * 86_400_000
    const toMs = todayTo

    // Find work sessions where this app was used (via work_session_segments → activity_segments)
    return buildWorkSessionPayloads(db, `WHERE id IN (
      SELECT DISTINCT wss.work_session_id FROM work_session_segments wss
      JOIN activity_segments aseg ON aseg.id = wss.segment_id
      WHERE aseg.primary_bundle_id = ?
    ) AND started_at >= ? AND started_at < ? ORDER BY started_at DESC LIMIT 50`, [bundleId, fromMs, toMs])
  })

  // Supports two call shapes:
  //   reassign-session(sessionId, clientId, projectId)                    // legacy
  //   reassign-session(sessionId, { clientId?, clientName?, projectId? }) // new
  // When `clientName` is provided without `clientId`, a matching client is created (or reused) before reassigning.
  ipcMain.handle(IPC.ATTRIBUTION.REASSIGN_SESSION, (
    _e,
    sessionId: string,
    secondArg: string | null | { clientId?: string | null; clientName?: string | null; projectId?: string | null },
    thirdArg?: string | null,
  ): { clientId: string | null; projectId: string | null } => {
    const db = getDb()

    let clientId: string | null = null
    let projectId: string | null = null
    if (typeof secondArg === 'object' && secondArg !== null) {
      clientId = secondArg.clientId ?? null
      projectId = secondArg.projectId ?? null
      if (!clientId && secondArg.clientName && secondArg.clientName.trim()) {
        const created = getOrCreateClientByName(secondArg.clientName.trim(), db)
        clientId = created.id
      }
    } else {
      clientId = secondArg ?? null
      projectId = thirdArg ?? null
    }

    db.prepare(`UPDATE work_sessions SET client_id = ?, project_id = ?, attribution_status = CASE WHEN ? IS NOT NULL THEN 'attributed' ELSE 'unattributed' END, attribution_confidence = CASE WHEN ? IS NOT NULL THEN 1.0 ELSE NULL END, updated_at = ? WHERE id = ?`)
      .run(clientId, projectId, clientId, clientId, Date.now(), sessionId)
    // Update segment attributions to reflect user decision
    const segmentIds = db.prepare(`SELECT segment_id FROM work_session_segments WHERE work_session_id = ?`).all(sessionId) as Array<{ segment_id: string }>
    for (const { segment_id } of segmentIds) {
      db.prepare(`UPDATE segment_attributions SET client_id = ?, project_id = ?, decision_source = 'user', confidence = 1.0 WHERE segment_id = ? AND rank = 1`)
        .run(clientId, projectId, segment_id)
    }
    invalidateProjectionScope('timeline', 'session_reassigned')
    invalidateProjectionScope('apps', 'session_reassigned')
    invalidateProjectionScope('insights', 'session_reassigned')
    return { clientId, projectId }
  })

  // Reassign every work_session overlapping a time range to a client (and
  // optionally a project). Either `clientId` or `clientName` may be given;
  // a name without a matching client auto-creates one.
  ipcMain.handle(IPC.ATTRIBUTION.REASSIGN_RANGE, (
    _e,
    payload: { fromMs: number; toMs: number; clientId?: string | null; clientName?: string | null; projectId?: string | null },
  ): { clientId: string | null; projectId: string | null; sessionsUpdated: number } => {
    const db = getDb()
    let clientId: string | null = payload.clientId ?? null
    const projectId: string | null = payload.projectId ?? null
    if (!clientId && payload.clientName && payload.clientName.trim()) {
      const created = getOrCreateClientByName(payload.clientName.trim(), db)
      clientId = created.id
    }

    // Pick any session that overlaps the range (started before toMs, ended after fromMs).
    const sessions = db.prepare(`
      SELECT id FROM work_sessions
      WHERE started_at < ? AND ended_at > ?
    `).all(payload.toMs, payload.fromMs) as Array<{ id: string }>

    const now = Date.now()
    const tx = db.transaction(() => {
      for (const { id } of sessions) {
        db.prepare(`UPDATE work_sessions SET client_id = ?, project_id = ?, attribution_status = CASE WHEN ? IS NOT NULL THEN 'attributed' ELSE 'unattributed' END, attribution_confidence = CASE WHEN ? IS NOT NULL THEN 1.0 ELSE NULL END, updated_at = ? WHERE id = ?`)
          .run(clientId, projectId, clientId, clientId, now, id)
        const segmentIds = db.prepare(`SELECT segment_id FROM work_session_segments WHERE work_session_id = ?`).all(id) as Array<{ segment_id: string }>
        for (const { segment_id } of segmentIds) {
          db.prepare(`UPDATE segment_attributions SET client_id = ?, project_id = ?, decision_source = 'user', confidence = 1.0 WHERE segment_id = ? AND rank = 1`)
            .run(clientId, projectId, segment_id)
        }
      }
    })
    tx()

    invalidateProjectionScope('timeline', 'session_reassigned')
    invalidateProjectionScope('apps', 'session_reassigned')
    invalidateProjectionScope('insights', 'session_reassigned')
    return { clientId, projectId, sessionsUpdated: sessions.length }
  })

  ipcMain.handle(IPC.ICONS.RESOLVE, async (_e, payload: IconRequest) => {
    return resolveIcon(payload)
  })
}

function getLiveSessionForDate(dateStr: string) {
  const live = getCurrentSession()
  if (!live) return null

  const [from, to] = dayBounds(dateStr)
  const liveEnd = Date.now()
  if (liveEnd <= from || live.startTime >= to) return null
  return live
}

// Resolve a block the renderer asked to split/merge. The live (in-flight) block
// is the awkward case: its id embeds its end time (= now), which advances every
// second, so the id the renderer captured at render time has already drifted by
// the time this handler re-materializes the day — an exact id lookup misses and
// the user sees "Both blocks must exist to merge." Fall back to matching the
// live block by its flag; there is at most one per day.
function resolveTimelineBlockForEdit(
  db: ReturnType<typeof getDb>,
  blockId: string,
  dayPayload: DayTimelinePayload | null,
): WorkContextBlock | null {
  const exact = dayPayload?.blocks.find((candidate) => candidate.id === blockId)
    ?? getBlockDetailPayload(db, blockId, getCurrentSession())
  if (exact) return exact
  if (blockId.startsWith('live_')) {
    // The live block's id embeds its end time, which drifts every second, so an
    // exact match misses. Match the flagged live block if one still exists;
    // otherwise (e.g. just after a flush turned it into a persisted block) fall
    // back to the last block of the day, which now covers that trailing time.
    return dayPayload?.blocks.find((candidate) => candidate.isLive)
      ?? (dayPayload ? [...dayPayload.blocks].sort((a, b) => a.startTime - b.startTime).pop() ?? null : null)
  }
  return null
}

function mergeLiveSessionForDate(sessions: AppSession[], dateStr: string): AppSession[] {
  const live = getLiveSessionForDate(dateStr)
  if (!live) return sessions

  const endTime = Date.now()
  return [
    ...sessions,
    {
      id: -1,
      bundleId: live.bundleId,
      appName: live.appName,
      startTime: live.startTime,
      endTime,
      durationSeconds: Math.max(1, Math.round((endTime - live.startTime) / 1000)),
      category: live.category,
      isFocused: FOCUSED_CATEGORIES.includes(live.category),
    },
  ].sort((left, right) => left.startTime - right.startTime)
}
