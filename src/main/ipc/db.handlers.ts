import { ipcMain, app } from 'electron'
import {
  setBlockLabelOverride,
  getAppCharacter,
  getAppSummariesForRange,
  getPeakHours,
  getSessionsForRange,
  getSessionsForApp,
  getWebsiteSummariesForRange,
  setCategoryOverride,
  clearCategoryOverride,
  getCategoryOverrides,
} from '../db/queries'
import { getAppDetailProjection, getArtifactDetailProjection, getHistoryDayProjection, getTimelineDayProjection, getWorkflowPatternsProjection, getWeeklySummaryProjection } from '../core/query/projections'
import { invalidateProjectionScope } from '../core/projections/invalidation'
import {
  resolveClientQuery,
  resolveDayContext,
  findClientByName,
  listClients,
  getRollupSummary,
} from '../core/query/attributionResolvers'
import { runAttributionForRange } from '../services/attribution'
import { getDb } from '../services/database'
import { getCurrentSession } from '../services/tracking'
import { getLatestSnapshot } from '../services/processMonitor'
import { getBlockDetailPayload } from '../services/workBlocks'
import { scheduleTimelineAIJobs } from '../services/ai'
import { IPC } from '@shared/types'
import type {
  AppSession,
  WorkSessionPayload,
  WorkSessionApp,
  ActivitySegmentPayload,
  ClientDetailPayload,
  ProjectSummary,
  RollupEntry,
  DayWorkSessionsPayload,
  TimelineWorkSession,
} from '@shared/types'
import { FOCUSED_CATEGORIES } from '@shared/types'

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

// Returns [fromMs, toMs] spanning the full local calendar day for a YYYY-MM-DD string.
// Constructs from year/month/day components so the result is always local midnight,
// regardless of how Date() parses ISO strings (which vary by platform/timezone).
function dayBounds(dateStr: string): [number, number] {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(y, m - 1, d).getTime()  // local midnight
  return [from, from + 86_400_000]
}

// ─── Work session payload helpers ────────────────────────────────────────────

function buildAppNameMap(db: ReturnType<typeof getDb>): Map<string, string> {
  const rows = db.prepare(`SELECT bundle_id, app_name FROM apps`).all() as Array<{ bundle_id: string; app_name: string }>
  const map = new Map(rows.map(r => [r.bundle_id, r.app_name]))
  try {
    const legacy = db.prepare(`SELECT DISTINCT bundle_id, app_name FROM app_sessions WHERE bundle_id NOT IN (SELECT bundle_id FROM apps)`).all() as Array<{ bundle_id: string; app_name: string }>
    for (const r of legacy) {
      if (!map.has(r.bundle_id)) map.set(r.bundle_id, r.app_name)
    }
  } catch { /* app_sessions may not exist */ }
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

  const appNameMap = buildAppNameMap(db)

  const clientIds = [...new Set(rows.map(r => r.client_id).filter(Boolean))] as string[]
  const projectIds = [...new Set(rows.map(r => r.project_id).filter(Boolean))] as string[]
  const clientMap = new Map<string, { name: string; color: string | null }>()
  const projectMap = new Map<string, string>()

  for (const cid of clientIds) {
    const row = db.prepare(`SELECT name, color FROM clients WHERE id = ?`).get(cid) as { name: string; color: string | null } | undefined
    if (row) clientMap.set(cid, row)
  }
  for (const pid of projectIds) {
    const row = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(pid) as { name: string } | undefined
    if (row) projectMap.set(pid, row.name)
  }

  return rows.map(ws => {
    const members = db.prepare(`
      SELECT wss.role, wss.contribution_ms, aseg.primary_bundle_id
      FROM work_session_segments wss
      JOIN activity_segments aseg ON aseg.id = wss.segment_id
      WHERE wss.work_session_id = ?
    `).all(ws.id) as Array<{ role: string; contribution_ms: number; primary_bundle_id: string }>

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

    const evidence = db.prepare(`
      SELECT evidence_type, evidence_value, weight
      FROM work_session_evidence WHERE work_session_id = ?
      ORDER BY weight DESC LIMIT 10
    `).all(ws.id) as Array<{ evidence_type: string; evidence_value: string; weight: number }>

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
  // Today's app summaries — uses local calendar day, not UTC day
  ipcMain.handle(IPC.DB.GET_TODAY, () => {
    const [from, to] = dayBounds(localDateString())
    return getAppSummariesForRange(getDb(), from, to)
  })

  // Raw sessions for a given date — used by History and Today timeline
  ipcMain.handle(IPC.DB.GET_HISTORY, (_e, dateStr: string) => {
    const [from, to] = dayBounds(dateStr)
    return mergeLiveSessionForDate(getSessionsForRange(getDb(), from, to), dateStr)
  })

  ipcMain.handle(IPC.DB.GET_HISTORY_DAY, (_e, dateStr: string) => {
    return getHistoryDayProjection(getDb(), dateStr, getLiveSessionForDate(dateStr))
  })

  ipcMain.handle(IPC.DB.GET_TIMELINE_DAY, (_e, dateStr: string) => {
    const payload = getTimelineDayProjection(getDb(), dateStr, getLiveSessionForDate(dateStr))
    scheduleTimelineAIJobs(payload)
    return payload
  })

  // App usage summaries for a range — used by Apps view
  // days=1 → today since local midnight (not rolling 24h)
  // days=7/30 → rolling window ending at end of today
  ipcMain.handle(IPC.DB.GET_APP_SUMMARIES, (_e, days: number = 7) => {
    const [todayFrom, todayTo] = dayBounds(localDateString())
    if (days <= 1) {
      return getAppSummariesForRange(getDb(), todayFrom, todayTo)
    }
    // N days: from (N-1) days before today's midnight to end of today
    const from = todayFrom - (days - 1) * 86_400_000
    return getAppSummariesForRange(getDb(), from, todayTo)
  })

  ipcMain.handle('db:set-category-override', (_e, bundleId: string, category: string) => {
    setCategoryOverride(getDb(), bundleId, category as import('@shared/types').AppCategory)
  })

  ipcMain.handle('db:clear-category-override', (_e, bundleId: string) => {
    clearCategoryOverride(getDb(), bundleId)
  })

  ipcMain.handle('db:get-category-overrides', () => {
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

  ipcMain.handle(IPC.DB.GET_BLOCK_DETAIL, (_e, blockId: string) => {
    return getBlockDetailPayload(getDb(), blockId, getCurrentSession())
  })

  ipcMain.handle(IPC.DB.GET_WORKFLOW_SUMMARIES, (_e, days: number = 14) => {
    return getWorkflowPatternsProjection(getDb(), days)
  })

  ipcMain.handle(IPC.DB.GET_ARTIFACT_DETAILS, (_e, artifactId: string) => {
    return getArtifactDetailProjection(getDb(), artifactId)
  })

  ipcMain.handle(IPC.DB.SET_BLOCK_LABEL_OVERRIDE, (_e, payload: { blockId: string; label: string; narrative?: string | null }) => {
    setBlockLabelOverride(getDb(), payload.blockId, payload.label, payload.narrative ?? null)
    invalidateProjectionScope('timeline', 'block_label_override')
    invalidateProjectionScope('apps', 'block_label_override')
    invalidateProjectionScope('insights', 'block_label_override')
  })

  // Returns the current in-flight session (not yet flushed to DB) so the renderer
  // can display live totals without waiting for the next app switch.
  ipcMain.handle(IPC.TRACKING.GET_LIVE, () => getCurrentSession())

  ipcMain.handle(IPC.TRACKING.GET_PROCESS_METRICS, () => {
    return getLatestSnapshot()
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

    const appNameMap = buildAppNameMap(db)
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

  ipcMain.handle(IPC.ATTRIBUTION.REASSIGN_SESSION, (_e, sessionId: string, clientId: string | null, projectId: string | null) => {
    const db = getDb()
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
  })

  // Returns a base64 PNG data URL for a given bundleId/exe path, or null if unavailable.
  // On Windows the bundleId is the full exe path — passed directly to getFileIcon.
  // On macOS the bundleId is a bundle identifier (e.g. 'com.anthropic.claude') — resolved
  // to the .app path via mdfind before calling getFileIcon.
  ipcMain.handle('app:get-icon', async (_e, bundleId: string): Promise<string | null> => {
    try {
      let filePath = bundleId

      if (process.platform === 'darwin' && !bundleId.startsWith('/')) {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execAsync = promisify(execFile)
        try {
          const { stdout } = await execAsync('mdfind', [
            `kMDItemCFBundleIdentifier == '${bundleId}'`,
          ])
          const resolved = stdout.trim().split('\n').find((p) => p.endsWith('.app'))
          if (!resolved) return null
          filePath = resolved
        } catch {
          return null
        }
      }

      const icon = await app.getFileIcon(filePath, { size: 'normal' })
      return icon.toDataURL()
    } catch {
      return null
    }
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
