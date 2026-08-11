// Query resolvers that produce the structured payloads used by
// Daylens AI and work-history queries.
//
// resolveClientQuery  → client/project question payload
// resolveDayContext   → full-day context payload

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { getDb } from '../../services/database'
import { deriveClientAliasTokens } from '../../lib/clientAliases'
import {
  mergeGroupIds,
  normalizeEntityLabel,
  resolveEntityByLabel,
  resolveMergeChain,
  type EntityRow,
  type ResolveByLabelResult,
} from '../../services/entities/entityRepository'

// ─── Shared row types ────────────────────────────────────────────────────────

interface ClientRow {
  id: string
  name: string
}

interface ProjectRow {
  id: string
  /** Nullable since migration v50 — a project may exist without a client. */
  client_id: string | null
  name: string
}

interface ClientAliasRow {
  alias: string
}

interface ProjectAliasRow {
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

interface WorkSessionAppSegmentRow {
  primary_bundle_id: string
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

// ─── Output payload types ───────────────────────────────────────────────────

interface SessionAppEntry {
  app_name: string
  duration_ms: number
  role: string
}

interface EvidenceEntry {
  type: string
  value: string
  weight: number
}

interface SessionPayload {
  work_session_id: string
  start: string
  end: string
  duration_ms: number
  active_ms: number
  attribution_status: 'attributed' | 'ambiguous' | 'unattributed'
  project_id: string | null
  project_name: string | null
  confidence: number | null
  title: string | null
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

export interface ClientPortfolioEntry {
  client_id: string
  client_name: string
  attributed_ms: number
  ambiguous_ms: number
  session_count: number
  project_names: string[]
}

export interface ClientComparisonPayload {
  left: ClientQueryPayload
  right: ClientQueryPayload
  winner_client_id: string | null
}

type ClientEvidenceKind = 'email' | 'workbook' | 'document' | 'tab' | 'file' | 'unknown'

export interface ClientEvidenceItem {
  label: string
  kind: ClientEvidenceKind
  weight: number
  session_count: number
  app_names: string[]
}

export interface ClientEvidencePayload {
  target: ClientQueryPayload['target']
  range: ClientQueryPayload['range']
  items: ClientEvidenceItem[]
}

interface ClientTimelineEntry {
  work_session_id: string
  start: string
  end: string
  duration_ms: number
  title: string | null
  project_name: string | null
  confidence: number | null
  attribution_status: 'attributed' | 'ambiguous' | 'unattributed'
  apps: SessionAppEntry[]
  evidence: EvidenceEntry[]
}

export interface ClientTimelinePayload {
  target: ClientQueryPayload['target']
  range: ClientQueryPayload['range']
  sessions: ClientTimelineEntry[]
}

interface ClientAppBreakdownEntry {
  app_name: string
  duration_ms: number
  session_count: number
  roles: string[]
}

export interface ClientAppBreakdownPayload {
  target: ClientQueryPayload['target']
  range: ClientQueryPayload['range']
  apps: ClientAppBreakdownEntry[]
}

interface ClientInvoiceLineItem {
  label: string
  duration_ms: number
  app_names: string[]
  evidence: string[]
}

export interface ClientInvoicePayload {
  target: ClientQueryPayload['target']
  range: ClientQueryPayload['range']
  line_items: ClientInvoiceLineItem[]
  ambiguous_ms: number
  ambiguous_sessions: SessionPayload[]
}

export interface ProjectQueryPayload {
  question: string
  timezone: string
  range: { start: string; end: string }
  target: {
    project_id: string
    project_name: string
    /** Null for a client-less project (allowed since migration v50). */
    client_id: string | null
    client_name: string | null
    aliases: string[]
  }
  totals: ClientQueryPayload['totals']
  sessions: SessionPayload[]
  rules: ClientQueryPayload['rules']
}

export interface ProjectEvidencePayload {
  target: ProjectQueryPayload['target']
  range: ProjectQueryPayload['range']
  items: ClientEvidenceItem[]
}

export interface ProjectTimelinePayload {
  target: ProjectQueryPayload['target']
  range: ProjectQueryPayload['range']
  sessions: ClientTimelineEntry[]
}

export interface ProjectAppBreakdownPayload {
  target: ProjectQueryPayload['target']
  range: ProjectQueryPayload['range']
  apps: ClientAppBreakdownEntry[]
}

export interface ProjectInvoicePayload {
  target: ProjectQueryPayload['target']
  range: ProjectQueryPayload['range']
  line_items: ClientInvoiceLineItem[]
  ambiguous_ms: number
  ambiguous_sessions: SessionPayload[]
}

export interface EvidenceBackedQueryPayload {
  question: string
  timezone: string
  range: { start: string; end: string }
  target: {
    label: string
  }
  totals: {
    matched_ms: number
    matched_hours: number
    structured_ms: number
    ambiguous_ms: number
    session_count: number
  }
  sessions: SessionPayload[]
}

export interface EvidenceBackedTimelinePayload {
  target: EvidenceBackedQueryPayload['target']
  range: EvidenceBackedQueryPayload['range']
  sessions: ClientTimelineEntry[]
}

export interface EvidenceBackedAppBreakdownPayload {
  target: EvidenceBackedQueryPayload['target']
  range: EvidenceBackedQueryPayload['range']
  apps: ClientAppBreakdownEntry[]
}

interface DaySessionPayload {
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

interface DayAmbiguousSegment {
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
    SELECT
      aseg.primary_bundle_id,
      wss.role,
      wss.contribution_ms
    FROM work_session_segments wss
    JOIN activity_segments aseg ON aseg.id = wss.segment_id
    WHERE wss.work_session_id = ?
  `).all(sessionId) as WorkSessionAppSegmentRow[]

  const appMs = new Map<string, { ms: number; role: string }>()
  for (const member of members) {
    const key = member.primary_bundle_id
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

function classifyEvidenceKind(type: string, value: string): ClientEvidenceKind {
  const normalizedType = type.toLowerCase()
  const normalizedValue = value.toLowerCase()
  if (normalizedType.includes('email')) return 'email'
  if (normalizedType.includes('tab') || normalizedType.includes('domain')) return 'tab'
  if (normalizedValue.match(/\.(xlsx|xls|csv)\b/)) return 'workbook'
  if (normalizedValue.match(/\.(docx|doc|pages|gdoc|md|txt|pdf)\b/)) return 'document'
  if (normalizedType.includes('file')) return 'file'
  return 'unknown'
}

function evidenceLabel(entry: EvidenceEntry): string {
  return entry.value.trim()
}

function projectNamesForClientInRange(
  db: Database.Database,
  clientId: string,
  fromMs: number,
  toMs: number,
): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT p.name
    FROM work_sessions ws
    JOIN projects p ON p.id = ws.project_id
    WHERE ws.client_id = ? AND ws.started_at >= ? AND ws.started_at < ?
    ORDER BY p.name ASC
  `).all(clientId, fromMs, toMs) as Array<{ name: string }>

  return rows.map((row) => row.name).filter(Boolean)
}

function trackedWorkRange(db: Database.Database): { startMs: number; endMs: number } | null {
  const row = db.prepare(`
    SELECT MIN(started_at) AS start_ms, MAX(ended_at) AS end_ms
    FROM work_sessions
    WHERE client_id IS NOT NULL
  `).get() as { start_ms: number | null; end_ms: number | null } | undefined

  if (!row?.start_ms || !row?.end_ms) return null
  return { startMs: row.start_ms, endMs: row.end_ms + 1 }
}

// ─── resolveClientQuery ─────────────────────────────────────────────────────

function entityTargetNameAndAliases(
  db: Database.Database,
  entityId: string,
  fallbackName: string,
  legacyAliases: string[],
): { name: string; aliases: string[] } {
  let entity: EntityRow | undefined
  try {
    entity = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(entityId) as EntityRow | undefined
  } catch {
    return { name: fallbackName, aliases: legacyAliases }
  }
  if (!entity) {
    return { name: fallbackName, aliases: legacyAliases }
  }
  const survivor = resolveMergeChain(db, entity)
  if (survivor.status === 'deleted') {
    return { name: fallbackName, aliases: legacyAliases }
  }
  const groupIds = mergeGroupIds(db, survivor.id)
  const marks = groupIds.map(() => '?').join(', ')
  const graphAliases = (db.prepare(`
    SELECT DISTINCT alias FROM entity_aliases WHERE entity_id IN (${marks}) ORDER BY alias ASC
  `).all(...groupIds) as Array<{ alias: string }>).map((row) => row.alias)
  const canonical = survivor.canonical_name
  const aliasSet = new Set<string>()
  for (const alias of [...graphAliases, ...legacyAliases]) {
    if (normalizeEntityLabel(alias) === normalizeEntityLabel(canonical)) continue
    aliasSet.add(alias)
  }
  return { name: canonical, aliases: [...aliasSet] }
}

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

  const legacyAliases = (db.prepare(`
    SELECT alias FROM client_aliases WHERE client_id = ?
  `).all(clientId) as ClientAliasRow[]).map((r) => r.alias)
  const target = entityTargetNameAndAliases(db, clientId, client.name, legacyAliases)

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
      attribution_status: ws.attribution_status,
      project_id: ws.project_id,
      project_name: ws.project_id ? (projectMap.get(ws.project_id) ?? null) : null,
      confidence: ws.attribution_confidence,
      title: ws.title,
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
        SELECT DISTINCT wss.work_session_id FROM segment_attributions sa
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
      reason: 'low confidence; competing client evidence',
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
      client_name: target.name,
      aliases: target.aliases,
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

export function resolveProjectQuery(
  projectId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ProjectQueryPayload | null {
  const timezone = tz()
  const project = db.prepare(`SELECT id, client_id, name FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined
  if (!project) return null

  // A project may exist without a client (migration v50); the payload then
  // carries null client fields instead of failing the whole query.
  const client = project.client_id
    ? db.prepare(`SELECT id, name FROM clients WHERE id = ?`).get(project.client_id) as ClientRow | undefined
    : undefined

  const legacyAliases = (db.prepare(`
    SELECT alias FROM project_aliases WHERE project_id = ?
  `).all(projectId) as ProjectAliasRow[]).map((row) => row.alias)
  const target = entityTargetNameAndAliases(db, projectId, project.name, legacyAliases)
  const clientName = client
    ? entityTargetNameAndAliases(db, client.id, client.name, []).name
    : null

  const appNameMap = loadAppNameMap(db)
  const sessions = db.prepare(`
    SELECT * FROM work_sessions
    WHERE project_id = ? AND started_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(projectId, fromMs, toMs) as WorkSessionRow[]

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
      attribution_status: ws.attribution_status,
      project_id: ws.project_id,
      project_name: target.name,
      confidence: ws.attribution_confidence,
      title: ws.title,
      apps: sessionApps(db, ws.id, appNameMap),
      evidence: sessionEvidence(db, ws.id),
    })
  }

  return {
    question,
    timezone,
    range: {
      start: msToIso(fromMs, timezone),
      end: msToIso(toMs, timezone),
    },
    target: {
      project_id: project.id,
      project_name: target.name,
      client_id: client?.id ?? null,
      client_name: clientName,
      aliases: target.aliases,
    },
    totals: {
      attributed_ms: attributedMs,
      attributed_hours: Math.round((attributedMs / 3_600_000) * 100) / 100,
      ambiguous_ms: ambiguousMs,
      excluded_idle_ms: excludedIdleMs,
      session_count: sessions.length,
    },
    sessions: sessionPayloads,
    rules: {
      min_confidence_to_include: MIN_CONFIDENCE,
      max_merge_gap_ms: MAX_MERGE_GAP,
      exclude_idle_over_ms: EXCLUDE_IDLE_OVER,
    },
  }
}

export function getTrackedWorkRange(
  db: Database.Database = getDb(),
): { startMs: number; endMs: number } | null {
  return trackedWorkRange(db)
}

export function listClientsForRange(
  fromMs: number,
  toMs: number,
  db: Database.Database = getDb(),
): ClientPortfolioEntry[] {
  const rows = db.prepare(`
    SELECT
      ws.client_id AS client_id,
      c.name AS client_name,
      SUM(CASE WHEN ws.attribution_status = 'attributed' THEN ws.active_ms ELSE 0 END) AS attributed_ms,
      SUM(CASE WHEN ws.attribution_status = 'ambiguous' THEN ws.active_ms ELSE 0 END) AS ambiguous_ms,
      COUNT(*) AS session_count
    FROM work_sessions ws
    JOIN clients c ON c.id = ws.client_id
    WHERE ws.client_id IS NOT NULL
      AND c.status = 'active'
      AND ws.started_at >= ?
      AND ws.started_at < ?
    GROUP BY ws.client_id, c.name
    ORDER BY attributed_ms DESC, ambiguous_ms DESC, c.name ASC
  `).all(fromMs, toMs) as Array<{
    client_id: string
    client_name: string
    attributed_ms: number
    ambiguous_ms: number
    session_count: number
  }>

  return rows.map((row) => ({
    ...row,
    project_names: projectNamesForClientInRange(db, row.client_id, fromMs, toMs),
  }))
}

export function compareClientsForRange(
  leftClientId: string,
  rightClientId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ClientComparisonPayload | null {
  const left = resolveClientQuery(leftClientId, fromMs, toMs, question, db)
  const right = resolveClientQuery(rightClientId, fromMs, toMs, question, db)
  if (!left || !right) return null

  const leftTotal = left.totals.attributed_ms
  const rightTotal = right.totals.attributed_ms
  const winner_client_id = leftTotal === rightTotal
    ? null
    : leftTotal > rightTotal
      ? left.target.client_id
      : right.target.client_id

  return { left, right, winner_client_id }
}

export function resolveClientEvidenceForRange(
  clientId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ClientEvidencePayload | null {
  const payload = resolveClientQuery(clientId, fromMs, toMs, question, db)
  if (!payload) return null

  const items = new Map<string, ClientEvidenceItem>()
  for (const session of payload.sessions) {
    const appNames = session.apps.map((app) => app.app_name)
    for (const evidence of session.evidence) {
      const label = evidenceLabel(evidence)
      if (!label) continue
      const kind = classifyEvidenceKind(evidence.type, label)
      const key = `${kind}:${label.toLowerCase()}`
      const existing = items.get(key)
      if (existing) {
        existing.weight = Math.max(existing.weight, evidence.weight)
        existing.session_count += 1
        for (const appName of appNames) {
          if (!existing.app_names.includes(appName)) existing.app_names.push(appName)
        }
        continue
      }

      items.set(key, {
        label,
        kind,
        weight: evidence.weight,
        session_count: 1,
        app_names: [...appNames],
      })
    }

    if (session.title?.trim()) {
      const title = session.title.trim()
      const key = `unknown:${title.toLowerCase()}`
      if (!items.has(key)) {
        items.set(key, {
          label: title,
          kind: classifyEvidenceKind('window_title', title),
          weight: session.confidence ?? 0.5,
          session_count: 1,
          app_names: [...appNames],
        })
      }
    }
  }

  return {
    target: payload.target,
    range: payload.range,
    items: [...items.values()].sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight
      if (right.session_count !== left.session_count) return right.session_count - left.session_count
      return left.label.localeCompare(right.label)
    }),
  }
}

export function resolveClientTimelineForRange(
  clientId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ClientTimelinePayload | null {
  const payload = resolveClientQuery(clientId, fromMs, toMs, question, db)
  if (!payload) return null

  return {
    target: payload.target,
    range: payload.range,
    sessions: payload.sessions.map((session) => ({
      work_session_id: session.work_session_id,
      start: session.start,
      end: session.end,
      duration_ms: session.duration_ms,
      title: session.title,
      project_name: session.project_name,
      confidence: session.confidence,
      attribution_status: session.attribution_status,
      apps: session.apps,
      evidence: session.evidence,
    })),
  }
}

export function resolveClientAmbiguitiesForRange(
  clientId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): AmbiguityEntry[] {
  const payload = resolveClientQuery(clientId, fromMs, toMs, question, db)
  return payload?.ambiguities ?? []
}

export function resolveClientAppBreakdownForRange(
  clientId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ClientAppBreakdownPayload | null {
  const payload = resolveClientQuery(clientId, fromMs, toMs, question, db)
  if (!payload) return null

  const apps = new Map<string, ClientAppBreakdownEntry>()
  for (const session of payload.sessions) {
    for (const app of session.apps) {
      const existing = apps.get(app.app_name)
      if (existing) {
        existing.duration_ms += app.duration_ms
        existing.session_count += 1
        if (!existing.roles.includes(app.role)) existing.roles.push(app.role)
      } else {
        apps.set(app.app_name, {
          app_name: app.app_name,
          duration_ms: app.duration_ms,
          session_count: 1,
          roles: [app.role],
        })
      }
    }
  }

  return {
    target: payload.target,
    range: payload.range,
    apps: [...apps.values()].sort((left, right) => right.duration_ms - left.duration_ms),
  }
}

export function buildClientInvoiceNarrativeForRange(
  clientId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ClientInvoicePayload | null {
  const payload = resolveClientQuery(clientId, fromMs, toMs, question, db)
  if (!payload) return null

  const line_items = payload.sessions
    .filter((session) => session.attribution_status === 'attributed')
    .map((session) => ({
      label: session.title?.trim() || session.project_name || payload.target.client_name,
      duration_ms: session.active_ms,
      app_names: session.apps.map((app) => app.app_name),
      evidence: session.evidence.slice(0, 3).map((item) => item.value),
    }))
    .sort((left, right) => right.duration_ms - left.duration_ms)

  return {
    target: payload.target,
    range: payload.range,
    line_items,
    ambiguous_ms: payload.totals.ambiguous_ms,
    ambiguous_sessions: payload.sessions.filter((session) => session.attribution_status === 'ambiguous'),
  }
}

export function resolveProjectEvidenceForRange(
  projectId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ProjectEvidencePayload | null {
  const payload = resolveProjectQuery(projectId, fromMs, toMs, question, db)
  if (!payload) return null

  const items = new Map<string, ClientEvidenceItem>()
  for (const session of payload.sessions) {
    const appNames = session.apps.map((app) => app.app_name)
    for (const evidence of session.evidence) {
      const label = evidenceLabel(evidence)
      if (!label) continue
      const kind = classifyEvidenceKind(evidence.type, label)
      const key = `${kind}:${label.toLowerCase()}`
      const existing = items.get(key)
      if (existing) {
        existing.weight = Math.max(existing.weight, evidence.weight)
        existing.session_count += 1
        for (const appName of appNames) {
          if (!existing.app_names.includes(appName)) existing.app_names.push(appName)
        }
        continue
      }

      items.set(key, {
        label,
        kind,
        weight: evidence.weight,
        session_count: 1,
        app_names: [...appNames],
      })
    }
  }

  return {
    target: payload.target,
    range: payload.range,
    items: [...items.values()].sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight
      if (right.session_count !== left.session_count) return right.session_count - left.session_count
      return left.label.localeCompare(right.label)
    }),
  }
}

export function resolveProjectTimelineForRange(
  projectId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ProjectTimelinePayload | null {
  const payload = resolveProjectQuery(projectId, fromMs, toMs, question, db)
  if (!payload) return null

  return {
    target: payload.target,
    range: payload.range,
    sessions: payload.sessions.map((session) => ({
      work_session_id: session.work_session_id,
      start: session.start,
      end: session.end,
      duration_ms: session.duration_ms,
      title: session.title,
      project_name: session.project_name,
      confidence: session.confidence,
      attribution_status: session.attribution_status,
      apps: session.apps,
      evidence: session.evidence,
    })),
  }
}

export function resolveProjectAppBreakdownForRange(
  projectId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ProjectAppBreakdownPayload | null {
  const payload = resolveProjectQuery(projectId, fromMs, toMs, question, db)
  if (!payload) return null

  const apps = new Map<string, ClientAppBreakdownEntry>()
  for (const session of payload.sessions) {
    for (const app of session.apps) {
      const existing = apps.get(app.app_name)
      if (existing) {
        existing.duration_ms += app.duration_ms
        existing.session_count += 1
        if (!existing.roles.includes(app.role)) existing.roles.push(app.role)
      } else {
        apps.set(app.app_name, {
          app_name: app.app_name,
          duration_ms: app.duration_ms,
          session_count: 1,
          roles: [app.role],
        })
      }
    }
  }

  return {
    target: payload.target,
    range: payload.range,
    apps: [...apps.values()].sort((left, right) => right.duration_ms - left.duration_ms),
  }
}

export function buildProjectInvoiceNarrativeForRange(
  projectId: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): ProjectInvoicePayload | null {
  const payload = resolveProjectQuery(projectId, fromMs, toMs, question, db)
  if (!payload) return null

  const line_items = payload.sessions
    .filter((session) => session.attribution_status === 'attributed')
    .map((session) => ({
      label: session.title?.trim() || payload.target.project_name,
      duration_ms: session.active_ms,
      app_names: session.apps.map((app) => app.app_name),
      evidence: session.evidence.slice(0, 3).map((item) => item.value),
    }))
    .sort((left, right) => right.duration_ms - left.duration_ms)

  return {
    target: payload.target,
    range: payload.range,
    line_items,
    ambiguous_ms: payload.totals.ambiguous_ms,
    ambiguous_sessions: payload.sessions.filter((session) => session.attribution_status === 'ambiguous'),
  }
}

export function resolveEvidenceBackedQuery(
  label: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): EvidenceBackedQueryPayload | null {
  const trimmed = label.trim()
  if (!trimmed) return null

  const timezone = tz()
  const normalized = `%${trimmed.toLowerCase()}%`
  const appNameMap = loadAppNameMap(db)
  const clientNames = new Map<string, string>()
  const projectNames = new Map<string, string>()

  function clientName(id: string | null): string | null {
    if (!id) return null
    const cached = clientNames.get(id)
    if (cached) return cached
    const row = db.prepare(`SELECT name FROM clients WHERE id = ?`).get(id) as { name: string } | undefined
    if (!row?.name) return null
    clientNames.set(id, row.name)
    return row.name
  }

  function projectName(id: string | null): string | null {
    if (!id) return null
    const cached = projectNames.get(id)
    if (cached) return cached
    const row = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(id) as { name: string } | undefined
    if (!row?.name) return null
    projectNames.set(id, row.name)
    return row.name
  }

  // EXISTS instead of LEFT JOIN + DISTINCT: the join fanned out one row per
  // evidence value before collapsing. The subquery resolves through
  // idx_work_session_evidence_session (work_session_id leading) and the outer
  // range through idx_work_sessions_time, so the substring LIKE only runs over
  // the rows already inside the time window. Match set is unchanged.
  const sessions = db.prepare(`
    SELECT ws.*
    FROM work_sessions ws
    WHERE ws.started_at >= ? AND ws.started_at < ?
      AND (
        LOWER(COALESCE(ws.title, '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM work_session_evidence wse
          WHERE wse.work_session_id = ws.id
            AND LOWER(COALESCE(wse.evidence_value, '')) LIKE ?
        )
      )
    ORDER BY ws.started_at ASC
  `).all(fromMs, toMs, normalized, normalized) as WorkSessionRow[]

  if (sessions.length === 0) return null

  let matchedMs = 0
  let structuredMs = 0
  let ambiguousMs = 0
  const sessionPayloads: SessionPayload[] = []

  for (const ws of sessions) {
    matchedMs += ws.active_ms
    if (ws.client_id || ws.project_id) structuredMs += ws.active_ms
    if (ws.attribution_status === 'ambiguous') ambiguousMs += ws.active_ms

    sessionPayloads.push({
      work_session_id: ws.id,
      start: msToIso(ws.started_at, timezone),
      end: msToIso(ws.ended_at, timezone),
      duration_ms: ws.duration_ms,
      active_ms: ws.active_ms,
      attribution_status: ws.attribution_status,
      project_id: ws.project_id,
      project_name: projectName(ws.project_id),
      confidence: ws.attribution_confidence,
      title: ws.title ?? clientName(ws.client_id),
      apps: sessionApps(db, ws.id, appNameMap),
      evidence: sessionEvidence(db, ws.id),
    })
  }

  return {
    question,
    timezone,
    range: {
      start: msToIso(fromMs, timezone),
      end: msToIso(toMs, timezone),
    },
    target: {
      label: trimmed,
    },
    totals: {
      matched_ms: matchedMs,
      matched_hours: Math.round((matchedMs / 3_600_000) * 100) / 100,
      structured_ms: structuredMs,
      ambiguous_ms: ambiguousMs,
      session_count: sessionPayloads.length,
    },
    sessions: sessionPayloads,
  }
}

export function resolveEvidenceBackedTimelineForRange(
  label: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): EvidenceBackedTimelinePayload | null {
  const payload = resolveEvidenceBackedQuery(label, fromMs, toMs, question, db)
  if (!payload) return null

  return {
    target: payload.target,
    range: payload.range,
    sessions: payload.sessions.map((session) => ({
      work_session_id: session.work_session_id,
      start: session.start,
      end: session.end,
      duration_ms: session.duration_ms,
      title: session.title,
      project_name: session.project_name,
      confidence: session.confidence,
      attribution_status: session.attribution_status,
      apps: session.apps,
      evidence: session.evidence,
    })),
  }
}

export function resolveEvidenceBackedAppBreakdownForRange(
  label: string,
  fromMs: number,
  toMs: number,
  question: string,
  db: Database.Database = getDb(),
): EvidenceBackedAppBreakdownPayload | null {
  const payload = resolveEvidenceBackedQuery(label, fromMs, toMs, question, db)
  if (!payload) return null

  const apps = new Map<string, ClientAppBreakdownEntry>()
  for (const session of payload.sessions) {
    for (const app of session.apps) {
      const existing = apps.get(app.app_name)
      if (existing) {
        existing.duration_ms += app.duration_ms
        existing.session_count += 1
        if (!existing.roles.includes(app.role)) existing.roles.push(app.role)
      } else {
        apps.set(app.app_name, {
          app_name: app.app_name,
          duration_ms: app.duration_ms,
          session_count: 1,
          roles: [app.role],
        })
      }
    }
  }

  return {
    target: payload.target,
    range: payload.range,
    apps: [...apps.values()].sort((left, right) => right.duration_ms - left.duration_ms),
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

// ─── Client / project identity (entity-graph boundary) ───────────────────────

export interface ClientLabelResolution {
  client: ClientRow | null
  matchedBy: ResolveByLabelResult['matchedBy']
  candidates: Array<{ id: string; name: string }>
}

export interface ProjectLabelResolution {
  project: ProjectRow | null
  matchedBy: ResolveByLabelResult['matchedBy']
  candidates: Array<{ id: string; name: string; client_id: string | null }>
}

function activeClientRow(db: Database.Database, id: string): ClientRow | null {
  return db.prepare(`
    SELECT id, name FROM clients WHERE id = ? AND status = 'active'
  `).get(id) as ClientRow | undefined ?? null
}

function activeProjectRow(db: Database.Database, id: string): ProjectRow | null {
  // LEFT JOIN since v50: a client-less project is resolvable; a project that
  // HAS a client still requires that client to be active.
  return db.prepare(`
    SELECT p.id, p.client_id, p.name FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = ? AND p.status = 'active'
      AND (p.client_id IS NULL OR c.status = 'active')
  `).get(id) as ProjectRow | undefined ?? null
}

function legacyExactClientMatch(db: Database.Database, normalized: string): ClientRow[] {
  const byName = db.prepare(`
    SELECT id, name FROM clients
    WHERE LOWER(name) = ? AND status = 'active'
  `).all(normalized) as ClientRow[]
  if (byName.length > 0) return byName
  return db.prepare(`
    SELECT c.id, c.name FROM clients c
    JOIN client_aliases ca ON ca.client_id = c.id
    WHERE ca.alias_normalized = ? AND c.status = 'active'
  `).all(normalized) as ClientRow[]
}

function legacyExactProjectMatch(db: Database.Database, normalized: string): ProjectRow[] {
  const clientGate = `(p.client_id IS NULL OR c.status = 'active')`
  const byName = db.prepare(`
    SELECT p.id, p.client_id, p.name FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE LOWER(p.name) = ? AND p.status = 'active' AND ${clientGate}
  `).all(normalized) as ProjectRow[]
  if (byName.length > 0) return byName
  return db.prepare(`
    SELECT p.id, p.client_id, p.name FROM projects p
    JOIN project_aliases pa ON pa.project_id = p.id
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE pa.alias_normalized = ? AND p.status = 'active' AND ${clientGate}
  `).all(normalized) as ProjectRow[]
}

/**
 * Resolve a client label through the entity graph first. Ambiguous labels
 * return candidates and no selected client (AC-SM-EA-002.5). Legacy exact
 * name/alias match is the fallback when the graph has no hit — never a silent
 * fuzzy `LIMIT 1`.
 */
export function resolveClientByLabel(
  name: string,
  db: Database.Database = getDb(),
): ClientLabelResolution {
  const normalized = normalizeEntityLabel(name)
  if (!normalized) return { client: null, matchedBy: null, candidates: [] }

  const graph = resolveEntityByLabel(db, 'client', name)
  if (graph.entity) {
    const client = activeClientRow(db, graph.entity.id)
    return {
      client,
      matchedBy: graph.matchedBy,
      candidates: client
        ? [{ id: client.id, name: client.name }]
        : graph.candidates.map((row) => ({ id: row.id, name: row.canonical_name })),
    }
  }
  if (graph.candidates.length > 1) {
    return {
      client: null,
      matchedBy: graph.matchedBy,
      candidates: graph.candidates.map((row) => ({ id: row.id, name: row.canonical_name })),
    }
  }

  const legacy = legacyExactClientMatch(db, normalized)
  if (legacy.length === 1) {
    return {
      client: legacy[0],
      matchedBy: 'canonical',
      candidates: [{ id: legacy[0].id, name: legacy[0].name }],
    }
  }
  if (legacy.length > 1) {
    return {
      client: null,
      matchedBy: 'canonical',
      candidates: legacy.map((row) => ({ id: row.id, name: row.name })),
    }
  }
  return { client: null, matchedBy: null, candidates: [] }
}

export function resolveProjectByLabel(
  name: string,
  db: Database.Database = getDb(),
): ProjectLabelResolution {
  const normalized = normalizeEntityLabel(name)
  if (!normalized) return { project: null, matchedBy: null, candidates: [] }

  const graph = resolveEntityByLabel(db, 'project', name)
  if (graph.entity) {
    const project = activeProjectRow(db, graph.entity.id)
    return {
      project,
      matchedBy: graph.matchedBy,
      candidates: project
        ? [{ id: project.id, name: project.name, client_id: project.client_id }]
        : graph.candidates.map((row) => ({ id: row.id, name: row.canonical_name, client_id: null })),
    }
  }
  if (graph.candidates.length > 1) {
    return {
      project: null,
      matchedBy: graph.matchedBy,
      candidates: graph.candidates.map((row) => ({
        id: row.id,
        name: row.canonical_name,
        client_id: null,
      })),
    }
  }

  const legacy = legacyExactProjectMatch(db, normalized)
  if (legacy.length === 1) {
    return {
      project: legacy[0],
      matchedBy: 'canonical',
      candidates: [{ id: legacy[0].id, name: legacy[0].name, client_id: legacy[0].client_id }],
    }
  }
  if (legacy.length > 1) {
    return {
      project: null,
      matchedBy: 'canonical',
      candidates: legacy.map((row) => ({
        id: row.id,
        name: row.name,
        client_id: row.client_id,
      })),
    }
  }
  return { project: null, matchedBy: null, candidates: [] }
}

export function findClientByName(
  name: string,
  db: Database.Database = getDb(),
): ClientRow | null {
  return resolveClientByLabel(name, db).client
}

export function findProjectByName(
  name: string,
  db: Database.Database = getDb(),
): ProjectRow | null {
  return resolveProjectByLabel(name, db).project
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

export function listProjects(
  db: Database.Database = getDb(),
): Array<{ id: string; client_id: string | null; name: string; client_name: string | null }> {
  return db.prepare(`
    SELECT p.id, p.client_id, p.name, c.name AS client_name
    FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'active' AND (p.client_id IS NULL OR c.status = 'active')
    ORDER BY p.name ASC
  `).all() as Array<{ id: string; client_id: string | null; name: string; client_name: string | null }>
}

// Create a project, with or without a client (memory-and-entities.md: "A
// project may exist without a client"). Seeds a user alias like createClient.
export function createProject(
  payload: { name: string; clientId?: string | null; color?: string | null },
  db: Database.Database = getDb(),
): { id: string; client_id: string | null; name: string } {
  const name = payload.name.trim()
  if (!name) throw new Error('Project name is required.')
  const clash = db.prepare(`
    SELECT id FROM projects WHERE LOWER(name) = ? AND status = 'active'
  `).get(normalizeAlias(name)) as { id: string } | undefined
  if (clash) throw new Error(`A project named "${name}" already exists.`)
  const now = Date.now()
  const id = randomUUID()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, client_id, name, code, color, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 'active', ?, ?)
    `).run(id, payload.clientId ?? null, name, payload.color?.trim() || null, now, now)
    db.prepare(`
      INSERT INTO project_aliases (id, project_id, alias, alias_normalized, source, created_at)
      VALUES (?, ?, ?, ?, 'user', ?)
    `).run(randomUUID(), id, name, normalizeAlias(name), now)
  })
  tx()
  return { id, client_id: payload.clientId ?? null, name }
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

// ─── Client CRUD ────────────────────────────────────────────────────────────

export interface ClientRecord {
  id: string
  name: string
  color: string | null
  status: 'active' | 'archived'
  created_at: number
  updated_at: number
  projectCount: number
}

export function listClientsDetailed(
  db: Database.Database = getDb(),
): ClientRecord[] {
  return db.prepare(`
    SELECT c.id, c.name, c.color, c.status, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id AND p.status = 'active') AS projectCount
    FROM clients c
    ORDER BY (c.status = 'active') DESC, c.name ASC
  `).all() as ClientRecord[]
}

function normalizeAlias(name: string): string {
  return name.toLowerCase().trim()
}

// Add the short single-word aliases for a client ("Andersen" for "Andersen in
// Rwanda") so chat references resolve the scope without the full name. Skips any
// already present; marks them source 'derived' so they're distinguishable from
// user/observed aliases. Shared by create + rename, and backfilled by migration.
export function seedClientAliasTokens(
  db: Database.Database,
  clientId: string,
  name: string,
  now: number,
): void {
  const tokens = deriveClientAliasTokens(name)
  if (tokens.length === 0) return
  const existing = new Set(
    (db.prepare(`SELECT alias_normalized FROM client_aliases WHERE client_id = ?`).all(clientId) as { alias_normalized: string }[])
      .map((r) => r.alias_normalized),
  )
  const insert = db.prepare(`
    INSERT INTO client_aliases (id, client_id, alias, alias_normalized, source, created_at)
    VALUES (?, ?, ?, ?, 'derived', ?)
  `)
  for (const token of tokens) {
    if (existing.has(token)) continue
    insert.run(randomUUID(), clientId, token, token, now)
    existing.add(token)
  }
}

export function createClient(
  payload: { name: string; color?: string | null },
  db: Database.Database = getDb(),
): ClientRecord {
  const name = payload.name.trim()
  if (!name) throw new Error('Client name is required.')

  // Case-insensitive uniqueness check against active clients.
  const existing = db.prepare(`
    SELECT id, name, color, status, created_at, updated_at FROM clients
    WHERE LOWER(name) = ? AND status = 'active'
  `).get(normalizeAlias(name)) as Omit<ClientRecord, 'projectCount'> | undefined
  if (existing) {
    throw new Error(`A client named "${existing.name}" already exists.`)
  }

  const now = Date.now()
  const id = randomUUID()
  const color = payload.color?.trim() || null

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO clients (id, name, color, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, name, color, now, now)
    db.prepare(`
      INSERT INTO client_aliases (id, client_id, alias, alias_normalized, source, created_at)
      VALUES (?, ?, ?, ?, 'user', ?)
    `).run(randomUUID(), id, name, normalizeAlias(name), now)
    // Also seed short aliases ("Andersen" for "Andersen in Rwanda") so chat
    // references resolve the scope without the full name (memory.md §2.2).
    seedClientAliasTokens(db, id, name, now)
  })
  tx()

  return { id, name, color, status: 'active', created_at: now, updated_at: now, projectCount: 0 }
}

export function updateClient(
  payload: { id: string; name?: string; color?: string | null },
  db: Database.Database = getDb(),
): ClientRecord | null {
  const current = db.prepare(`SELECT id, name, color, status FROM clients WHERE id = ?`).get(payload.id) as
    | { id: string; name: string; color: string | null; status: string }
    | undefined
  if (!current) return null

  const nextName = payload.name?.trim()
  const renaming = nextName && nextName !== current.name
  if (renaming) {
    const clash = db.prepare(`
      SELECT id FROM clients WHERE LOWER(name) = ? AND status = 'active' AND id <> ?
    `).get(normalizeAlias(nextName!), payload.id) as { id: string } | undefined
    if (clash) throw new Error(`Another active client already uses the name "${nextName}".`)
  }

  const now = Date.now()
  const finalName = renaming ? nextName! : current.name
  const finalColor = payload.color === undefined ? current.color : (payload.color?.trim() || null)

  const tx = db.transaction(() => {
    db.prepare(`UPDATE clients SET name = ?, color = ?, updated_at = ? WHERE id = ?`).run(
      finalName,
      finalColor,
      now,
      payload.id,
    )
    if (renaming) {
      // Keep a user-source alias matching the new display name so the AI router can still resolve by old/new names.
      db.prepare(`
        INSERT OR IGNORE INTO client_aliases (id, client_id, alias, alias_normalized, source, created_at)
        VALUES (?, ?, ?, ?, 'user', ?)
      `).run(randomUUID(), payload.id, finalName, normalizeAlias(finalName), now)
      // Keep short aliases in sync with the new name (memory.md §2.2).
      seedClientAliasTokens(db, payload.id, finalName, now)
    }
  })
  tx()

  const projectCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM projects WHERE client_id = ? AND status = 'active'`).get(payload.id) as { cnt: number }).cnt
  return {
    id: payload.id,
    name: finalName,
    color: finalColor,
    status: current.status as 'active' | 'archived',
    created_at: now,
    updated_at: now,
    projectCount,
  }
}

export function archiveClient(
  id: string,
  db: Database.Database = getDb(),
): boolean {
  const now = Date.now()
  const result = db.prepare(`UPDATE clients SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`).run(now, id)
  return result.changes > 0
}

export function restoreClient(
  id: string,
  db: Database.Database = getDb(),
): boolean {
  const now = Date.now()
  const result = db.prepare(`UPDATE clients SET status = 'active', updated_at = ? WHERE id = ? AND status = 'archived'`).run(now, id)
  return result.changes > 0
}

export function deleteClient(
  id: string,
  db: Database.Database = getDb(),
): boolean {
  const result = db.prepare(`DELETE FROM clients WHERE id = ?`).run(id)
  if (result.changes > 0) {
    db.prepare(`UPDATE work_sessions SET client_id = NULL WHERE client_id = ?`).run(id)
    db.prepare(`UPDATE segment_attributions SET client_id = NULL WHERE client_id = ?`).run(id)
  }
  return result.changes > 0
}

// Idempotent get-or-create used by the "attribute a session to a new client by name"
// shortcut. Returns the existing client when one matches (by name or alias), else creates it.
export function getOrCreateClientByName(
  name: string,
  db: Database.Database = getDb(),
): ClientRecord {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Client name is required.')
  const match = findClientByName(trimmed, db)
  if (match) {
    const row = db.prepare(`SELECT id, name, color, status, created_at, updated_at FROM clients WHERE id = ?`).get(match.id) as
      | Omit<ClientRecord, 'projectCount'>
      | undefined
    if (row) {
      const projectCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM projects WHERE client_id = ? AND status = 'active'`).get(row.id) as { cnt: number }).cnt
      return { ...row, projectCount }
    }
  }
  return createClient({ name: trimmed }, db)
}
