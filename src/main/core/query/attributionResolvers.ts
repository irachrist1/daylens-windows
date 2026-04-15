// Query resolvers that produce the structured payloads defined in
// CLAUDE.md Appendix ("AI Context Payload Reference").
//
// resolveClientQuery  → client/project question payload
// resolveDayContext   → full-day context payload

import type Database from 'better-sqlite3'
import { getDb } from '../../services/database'

// ─── Shared row types ────────────────────────────────────────────────────────

interface ClientRow {
  id: string
  name: string
}

interface ProjectRow {
  id: string
  client_id: string
  name: string
}

interface ClientAliasRow {
  alias: string
}

interface WorkSessionRow {
  id: string
  device_id: string
  started_at: number
  ended_at: number
  duration_ms: number
  active_ms: number
  idle_ms: number
  client_id: string | null
  project_id: string | null
  attribution_status: 'attributed' | 'ambiguous' | 'unattributed'
  attribution_confidence: number | null
  title: string | null
  primary_bundle_id: string | null
  app_bundle_ids_json: string
}

interface WorkSessionEvidenceRow {
  evidence_type: string
  evidence_value: string
  weight: number
}

interface SegmentAttributionRow {
  segment_id: string
  client_id: string | null
  project_id: string | null
  confidence: number
  rank: number
}

interface WorkSessionSegmentRow {
  segment_id: string
  role: string
  contribution_ms: number
}

interface AppRow {
  bundle_id: string
  app_name: string
}

interface RollupRow {
  day_local: string
  client_id: string | null
  project_id: string | null
  attributed_ms: number
  ambiguous_ms: number
  session_count: number
}

// ─── Output payload types (matches CLAUDE.md Appendix) ──────────────────────

export interface SessionAppEntry {
  app_name: string
  duration_ms: number
  role: string
}

export interface EvidenceEntry {
  type: string
  value: string
  weight: number
}

export interface SessionPayload {
  work_session_id: string
  start: string
  end: string
  duration_ms: number
  active_ms: number
  project_id: string | null
  project_name: string | null
  confidence: number | null
  apps: SessionAppEntry[]
  evidence: EvidenceEntry[]
}

export interface AmbiguityEntry {
  start: string
  end: string
  duration_ms: number
  candidates: Array<{
    client_id: string | null
    client_name: string | null
    confidence: number
  }>
  reason?: string
}

export interface ClientQueryPayload {
  question: string
  timezone: string
  range: { start: string; end: string }
  target: {
    client_id: string
    client_name: string
    aliases: string[]
  }
  totals: {
    attributed_ms: number
    attributed_hours: number
    ambiguous_ms: number
    excluded_idle_ms: number
    session_count: number
  }
  sessions: SessionPayload[]
  ambiguities: AmbiguityEntry[]
  rules: {
    min_confidence_to_include: number
    max_merge_gap_ms: number
    exclude_idle_over_ms: number
  }
}

export interface DaySessionPayload {
  work_session_id: string
  start: string
  end: string
  duration_ms: number
  active_ms: number
  client: { id: string; name: string } | null
  project: { id: string; name: string } | null
  confidence: number | null
  apps: SessionAppEntry[]
  evidence: EvidenceEntry[]
}

export interface DayAmbiguousSegment {
  start: string
  end: string
  duration_ms: number
  apps: string[]
  candidates: Array<{
    client_id: string | null
    client_name: string | null
    confidence: number
  }>
  reason: string
}

export interface DayContextPayload {
  date: string
  timezone: string
  day_summary: {
    captured_ms: number
    active_ms: number
    idle_ms: number
    attributed_ms: number
    ambiguous_ms: number
    unattributed_ms: number
  }
  sessions: DaySessionPayload[]
  ambiguous_segments: DayAmbiguousSegment[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE = 0.75
const MAX_MERGE_GAP = 120_000
const EXCLUDE_IDLE_OVER = 300_000

function tz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function msToIso(ms: number, timezone: string): string {
  try {
    const d = new Date(ms)
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const offset = formatTzOffset(d, timezone)
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`
  } catch {
    return new Date(ms).toISOString()
  }
}

function formatTzOffset(date: Date, timezone: string): string {
  try {
    const str = date.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    const match = str.match(/GMT([+-]\d{1,2}(?::\d{2})?)/)
    if (match) {
      const raw = match[1]
      const [h, m] = raw.split(':')
      return `${h.padStart(3, h.startsWith('-') ? '-' : '+')}:${m ?? '00'}`
    }
  } catch { /* fall through */ }
  return '+00:00'
}

function loadAppNameMap(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`SELECT bundle_id, app_name FROM apps`).all() as AppRow[]
  const map = new Map(rows.map((r) => [r.bundle_id, r.app_name]))
  const legacy = db.prepare(`
    SELECT DISTINCT bundle_id, app_name FROM app_sessions
    WHERE bundle_id NOT IN (SELECT bundle_id FROM apps)
  `).all() as AppRow[]
  for (const r of legacy) {
    if (!map.has(r.bundle_id)) map.set(r.bundle_id, r.app_name)
  }
  return map
}

function resolveAppName(bundleId: string, appNameMap: Map<string, string>): string {
  return appNameMap.get(bundleId) ?? bundleId.split('.').pop() ?? bundleId
}

function sessionApps(
  db: Database.Database,
  sessionId: string,
  appNameMap: Map<string, string>,
): SessionAppEntry[] {
  const members = db.prepare(`
    SELECT segment_id, role, contribution_ms
    FROM work_session_segments
    WHERE work_session_id = ?
  `).all(sessionId) as WorkSessionSegmentRow[]

  const appMs = new Map<string, { ms: number; role: string }>()
  for (const member of members) {
    const seg = db.prepare(`
      SELECT primary_bundle_id FROM activity_segments WHERE id = ?
    `).get(member.segment_id) as { primary_bundle_id: string } | undefined
    if (!seg) continue
    const key = seg.primary_bundle_id
    const existing = appMs.get(key)
    if (existing) {
      existing.ms += member.contribution_ms
    } else {
      appMs.set(key, { ms: member.contribution_ms, role: member.role })
    }
  }

  return [...appMs.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([bundleId, { ms, role }]) => ({
      app_name: resolveAppName(bundleId, appNameMap),
      duration_ms: ms,
      role,
    }))
}

function sessionEvidence(db: Database.Database, sessionId: string): EvidenceEntry[] {
  const rows = db.prepare(`
    SELECT evidence_type, evidence_value, weight
    FROM work_session_evidence
    WHERE work_session_id = ?
    ORDER BY weight DESC
    LIMIT 10
  `).all(sessionId) as WorkSessionEvidenceRow[]
  return rows.map((r) => ({ type: r.evidence_type, value: r.evidence_value, weight: r.weight }))
}

// ─── resolveClientQuery ─────────────────────────────────────────────────────

export function resolveClientQuery(
  clientId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ClientQueryPayload | null {
  const timezone = tz()
  const client = db.prepare(`SELECT id, name FROM clients WHERE id = ?`).get(clientId) as ClientRow | undefined
  if (!client) return null

  const aliases = (db.prepare(`
    SELECT alias FROM client_aliases WHERE client_id = ?
  `).all(clientId) as ClientAliasRow[]).map((r) => r.alias)

  const projectMap = new Map<string, string>()
  const projects = db.prepare(`SELECT id, name FROM projects WHERE client_id = ?`).all(clientId) as ProjectRow[]
  for (const p of projects) projectMap.set(p.id, p.name)

  const appNameMap = loadAppNameMap(db)

  // All sessions touching this client in the range
  const sessions = db.prepare(`
    SELECT * FROM work_sessions
    WHERE client_id = ? AND started_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(clientId, fromMs, toMs) as WorkSessionRow[]

  let attributedMs = 0
  let ambiguousMs = 0
  let excludedIdleMs = 0
  const sessionPayloads: SessionPayload[] = []

  for (const ws of sessions) {
    if (ws.attribution_status === 'attributed') attributedMs += ws.active_ms
    else if (ws.attribution_status === 'ambiguous') ambiguousMs += ws.active_ms
    excludedIdleMs += ws.idle_ms

    sessionPayloads.push({
      work_session_id: ws.id,
      start: msToIso(ws.started_at, timezone),
      end: msToIso(ws.ended_at, timezone),
      duration_ms: ws.duration_ms,
      active_ms: ws.active_ms,
      project_id: ws.project_id,
      project_name: ws.project_id ? (projectMap.get(ws.project_id) ?? null) : null,
      confidence: ws.attribution_confidence,
      apps: sessionApps(db, ws.id, appNameMap),
      evidence: sessionEvidence(db, ws.id),
    })
  }

  // Ambiguous segments: sessions where confidence is below threshold
  // but the client is still a candidate
  const ambiguousSessions = db.prepare(`
    SELECT ws.id, ws.started_at, ws.ended_at, ws.duration_ms, ws.app_bundle_ids_json
    FROM work_sessions ws
    WHERE ws.attribution_status = 'ambiguous'
      AND ws.started_at >= ? AND ws.started_at < ?
      AND ws.id IN (
        SELECT DISTINCT sa.segment_id FROM segment_attributions sa
        JOIN work_session_segments wss ON wss.segment_id = sa.segment_id
        WHERE sa.client_id = ? AND sa.confidence > 0.3
      )
  `).all(fromMs, toMs, clientId) as WorkSessionRow[]

  const ambiguities: AmbiguityEntry[] = ambiguousSessions.map((ws) => {
    const segCandidates = db.prepare(`
      SELECT sa.client_id, sa.confidence
      FROM segment_attributions sa
      JOIN work_session_segments wss ON wss.segment_id = sa.segment_id
      WHERE wss.work_session_id = ? AND sa.rank <= 3
      ORDER BY sa.confidence DESC
    `).all(ws.id) as SegmentAttributionRow[]

    const clientNames = new Map<string | null, string | null>()
    for (const c of segCandidates) {
      if (c.client_id && !clientNames.has(c.client_id)) {
        const row = db.prepare(`SELECT name FROM clients WHERE id = ?`).get(c.client_id) as { name: string } | undefined
        clientNames.set(c.client_id, row?.name ?? null)
      }
    }

    const deduped = new Map<string | null, number>()
    for (const c of segCandidates) {
      const existing = deduped.get(c.client_id)
      if (!existing || c.confidence > existing) deduped.set(c.client_id, c.confidence)
    }

    return {
      start: msToIso(ws.started_at, timezone),
      end: msToIso(ws.ended_at, timezone),
      duration_ms: ws.duration_ms,
      candidates: [...deduped.entries()].map(([cid, conf]) => ({
        client_id: cid,
        client_name: clientNames.get(cid) ?? null,
        confidence: Math.round(conf * 100) / 100,
      })),
    }
  })

  return {
    question,
    timezone,
    range: {
      start: msToIso(fromMs, timezone),
      end: msToIso(toMs, timezone),
    },
    target: {
      client_id: client.id,
      client_name: client.name,
      aliases,
    },
    totals: {
      attributed_ms: attributedMs,
      attributed_hours: Math.round((attributedMs / 3_600_000) * 100) / 100,
      ambiguous_ms: ambiguousMs,
      excluded_idle_ms: excludedIdleMs,
      session_count: sessions.length,
    },
    sessions: sessionPayloads,
    ambiguities,
    rules: {
      min_confidence_to_include: MIN_CONFIDENCE,
      max_merge_gap_ms: MAX_MERGE_GAP,
      exclude_idle_over_ms: EXCLUDE_IDLE_OVER,
    },
  }
}

// ─── resolveDayContext ──────────────────────────────────────────────────────

export function resolveDayContext(
  dateStr: string,
  db: Database.Database = getDb(),
): DayContextPayload {
  const timezone = tz()

  // Day bounds in local time
  const [year, month, day] = dateStr.split('-').map(Number)
  const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
  const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999).getTime()

  const appNameMap = loadAppNameMap(db)

  const allSessions = db.prepare(`
    SELECT * FROM work_sessions
    WHERE started_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(dayStart, dayEnd + 1) as WorkSessionRow[]

  const clientMap = new Map<string, string>()
  const projectMap = new Map<string, string>()

  // Lazy-load client/project names
  function clientName(id: string | null): { id: string; name: string } | null {
    if (!id) return null
    if (!clientMap.has(id)) {
      const row = db.prepare(`SELECT name FROM clients WHERE id = ?`).get(id) as { name: string } | undefined
      clientMap.set(id, row?.name ?? id)
    }
    return { id, name: clientMap.get(id)! }
  }
  function projectName(id: string | null): { id: string; name: string } | null {
    if (!id) return null
    if (!projectMap.has(id)) {
      const row = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(id) as { name: string } | undefined
      projectMap.set(id, row?.name ?? id)
    }
    return { id, name: projectMap.get(id)! }
  }

  let capturedMs = 0
  let activeMs = 0
  let idleMs = 0
  let attributedMs = 0
  let ambiguousMs = 0
  let unattributedMs = 0

  const sessionPayloads: DaySessionPayload[] = []
  const ambiguousSegments: DayAmbiguousSegment[] = []

  for (const ws of allSessions) {
    capturedMs += ws.duration_ms
    activeMs += ws.active_ms
    idleMs += ws.idle_ms

    if (ws.attribution_status === 'attributed') attributedMs += ws.active_ms
    else if (ws.attribution_status === 'ambiguous') ambiguousMs += ws.active_ms
    else unattributedMs += ws.active_ms

    sessionPayloads.push({
      work_session_id: ws.id,
      start: msToIso(ws.started_at, timezone),
      end: msToIso(ws.ended_at, timezone),
      duration_ms: ws.duration_ms,
      active_ms: ws.active_ms,
      client: clientName(ws.client_id),
      project: projectName(ws.project_id),
      confidence: ws.attribution_confidence,
      apps: sessionApps(db, ws.id, appNameMap),
      evidence: sessionEvidence(db, ws.id),
    })

    // Collect ambiguous sessions as segments for the payload
    if (ws.attribution_status === 'ambiguous') {
      const bundles: string[] = JSON.parse(ws.app_bundle_ids_json || '[]')
      const appNames = bundles.map((b) => resolveAppName(b, appNameMap))

      const segCandidates = db.prepare(`
        SELECT sa.client_id, sa.confidence
        FROM segment_attributions sa
        JOIN work_session_segments wss ON wss.segment_id = sa.segment_id
        WHERE wss.work_session_id = ? AND sa.rank <= 3
        ORDER BY sa.confidence DESC
      `).all(ws.id) as SegmentAttributionRow[]

      const deduped = new Map<string | null, number>()
      for (const c of segCandidates) {
        const existing = deduped.get(c.client_id)
        if (!existing || c.confidence > existing) deduped.set(c.client_id, c.confidence)
      }

      ambiguousSegments.push({
        start: msToIso(ws.started_at, timezone),
        end: msToIso(ws.ended_at, timezone),
        duration_ms: ws.duration_ms,
        apps: appNames,
        candidates: [...deduped.entries()].map(([cid, conf]) => ({
          client_id: cid,
          client_name: cid ? (clientName(cid)?.name ?? null) : null,
          confidence: Math.round(conf * 100) / 100,
        })),
        reason: 'low confidence; no strong client-specific signal',
      })
    }
  }

  return {
    date: dateStr,
    timezone,
    day_summary: {
      captured_ms: capturedMs,
      active_ms: activeMs,
      idle_ms: idleMs,
      attributed_ms: attributedMs,
      ambiguous_ms: ambiguousMs,
      unattributed_ms: unattributedMs,
    },
    sessions: sessionPayloads,
    ambiguous_segments: ambiguousSegments,
  }
}

// ─── Client lookup helpers ──────────────────────────────────────────────────

export function findClientByName(
  name: string,
  db: Database.Database = getDb(),
): ClientRow | null {
  const normalized = name.toLowerCase().trim()

  // Direct name match
  const direct = db.prepare(`
    SELECT id, name FROM clients
    WHERE LOWER(name) = ? AND status = 'active'
  `).get(normalized) as ClientRow | undefined
  if (direct) return direct

  // Alias match
  const alias = db.prepare(`
    SELECT c.id, c.name FROM clients c
    JOIN client_aliases ca ON ca.client_id = c.id
    WHERE ca.alias_normalized = ? AND c.status = 'active'
  `).get(normalized) as ClientRow | undefined
  if (alias) return alias

  // Fuzzy: contains match
  const fuzzy = db.prepare(`
    SELECT id, name FROM clients
    WHERE LOWER(name) LIKE ? AND status = 'active'
    ORDER BY LENGTH(name) ASC
    LIMIT 1
  `).get(`%${normalized}%`) as ClientRow | undefined
  return fuzzy ?? null
}

export function listClients(
  db: Database.Database = getDb(),
): Array<{ id: string; name: string; projectCount: number }> {
  return db.prepare(`
    SELECT c.id, c.name, COUNT(p.id) AS projectCount
    FROM clients c
    LEFT JOIN projects p ON p.client_id = c.id AND p.status = 'active'
    WHERE c.status = 'active'
    GROUP BY c.id
    ORDER BY c.name ASC
  `).all() as Array<{ id: string; name: string; projectCount: number }>
}

export function getRollupSummary(
  clientId: string | null,
  fromDate: string,
  toDate: string,
  db: Database.Database = getDb(),
): { attributed_ms: number; ambiguous_ms: number; session_count: number; by_day: RollupRow[] } {
  const condition = clientId
    ? `WHERE client_id = ? AND day_local >= ? AND day_local <= ?`
    : `WHERE client_id IS NULL AND day_local >= ? AND day_local <= ?`
  const params = clientId ? [clientId, fromDate, toDate] : [fromDate, toDate]

  const rows = db.prepare(`
    SELECT day_local, client_id, project_id, attributed_ms, ambiguous_ms, session_count
    FROM daily_entity_rollups
    ${condition}
    ORDER BY day_local ASC
  `).all(...params) as RollupRow[]

  let attributed = 0
  let ambiguous = 0
  let sessions = 0
  for (const r of rows) {
    attributed += r.attributed_ms
    ambiguous += r.ambiguous_ms
    sessions += r.session_count
  }

  return { attributed_ms: attributed, ambiguous_ms: ambiguous, session_count: sessions, by_day: rows }
}
