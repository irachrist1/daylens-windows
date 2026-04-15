// Attribution pipeline (CLAUDE.md, "Attribution Pipeline").
//
// Reads from the immutable raw layer (app_sessions, website_visits,
// activity_state_events) plus the new browser_context_events / file_activity
// streams when available, then writes:
//
//   activity_segments      (Layer 2)
//     + segment_attributions
//   work_sessions          (Layer 3)
//     + work_session_segments + work_session_evidence
//   daily_entity_rollups   (Layer 4)
//
// Every step is idempotent: rerunning over the same time range replaces the
// derived rows in that range. Raw rows are never mutated.

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from './database'
import os from 'node:os'

// ─── Tunables (CLAUDE.md "Attribution Confidence Rules") ─────────────────────
export const MIN_CONFIDENCE_TO_ATTRIBUTE = 0.75
export const MAX_MERGE_GAP_MS = 120_000          // 2 minutes
export const EXCLUDE_IDLE_OVER_MS = 300_000      // 5 minutes
export const NEIGHBOR_PROPAGATION_PENALTY = 0.85 // multiplied into propagated confidence

// Signal weight order — repo > file path > client domain > doc title > generic.
const SIGNAL_BASE_WEIGHT = {
  repo_remote: 1.0,
  file_prefix: 0.95,
  client_domain: 0.9,
  document_title: 0.78,
  generic_domain: 0.45,
  window_title: 0.25,
  app_bundle: 0.35,
} as const
type SignalKind = keyof typeof SIGNAL_BASE_WEIGHT

// ─── Internal types ──────────────────────────────────────────────────────────
interface RawAppSessionRow {
  id: number
  bundle_id: string
  app_name: string
  start_time: number
  end_time: number | null
  duration_sec: number
  is_focused: number
  window_title: string | null
  category: string
}

interface IdlePeriod {
  startedAt: number
  endedAt: number
}

export interface ActivitySegmentRecord {
  id: string
  deviceId: string
  startedAt: number
  endedAt: number
  durationMs: number
  primaryBundleId: string
  windowTitle: string | null
  domain: string | null
  filePath: string | null
  inputScore: number
  attentionScore: number
  idleRatio: number
  class: 'focused' | 'supporting' | 'ambient' | 'idle'
  rawSessionIds: number[]
}

export interface AttributionSignal {
  kind: SignalKind
  value: string
  weight: number
}

export interface SegmentAttributionRecord {
  id: string
  segmentId: string
  clientId: string | null
  projectId: string | null
  score: number
  confidence: number
  rank: number
  decisionSource: 'rule' | 'model' | 'neighbor_propagation' | 'user'
  matchedSignals: AttributionSignal[]
}

interface AppRow {
  bundle_id: string
  attention_class: 'focus' | 'supporting' | 'ambient'
  category: string
}

interface AttributionRuleRow {
  id: string
  client_id: string | null
  project_id: string | null
  signal_type: string
  operator: 'equals' | 'contains' | 'regex' | 'prefix'
  pattern: string
  scope_bundle_id: string | null
  weight: number
  source: 'user' | 'system'
}

// ─── Device helpers ──────────────────────────────────────────────────────────
let cachedDeviceId: string | null = null

export function ensureLocalDevice(db: Database.Database = getDb()): string {
  if (cachedDeviceId) return cachedDeviceId
  const hostname = os.hostname() || 'localhost'
  const platform = process.platform
  const existing = db.prepare(`SELECT id FROM devices WHERE hostname = ?`).get(hostname) as
    | { id: string } | undefined
  if (existing) {
    cachedDeviceId = existing.id
    return existing.id
  }
  const id = `dev_${hostname.replace(/[^a-zA-Z0-9]/g, '_')}`
  db.prepare(`
    INSERT OR IGNORE INTO devices (id, hostname, platform, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, hostname, platform, Date.now())
  cachedDeviceId = id
  return id
}

// ─── App attention class lookup ──────────────────────────────────────────────
function loadAppAttentionMap(db: Database.Database): Map<string, AppRow> {
  const rows = db.prepare(`SELECT bundle_id, attention_class, category FROM apps`).all() as AppRow[]
  return new Map(rows.map((row) => [row.bundle_id, row]))
}

// ─── Step 1 — load idle periods within range ─────────────────────────────────
function loadIdlePeriods(db: Database.Database, fromMs: number, toMs: number): IdlePeriod[] {
  // Real idle_periods rows take precedence; fall back to activity_state_events.
  const direct = db.prepare(`
    SELECT started_at AS startedAt, ended_at AS endedAt
    FROM idle_periods
    WHERE ended_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(fromMs, toMs) as IdlePeriod[]
  if (direct.length > 0) return direct

  const events = db.prepare(`
    SELECT event_ts AS ts, event_type AS type
    FROM activity_state_events
    WHERE event_ts >= ? AND event_ts < ?
    ORDER BY event_ts ASC
  `).all(fromMs, toMs) as { ts: number; type: string }[]

  const periods: IdlePeriod[] = []
  let openStart: number | null = null
  for (const event of events) {
    const lower = event.type.toLowerCase()
    if (lower.includes('idle_start') || lower === 'lock' || lower === 'sleep') {
      if (openStart === null) openStart = event.ts
    } else if (lower.includes('idle_end') || lower === 'unlock' || lower === 'wake' || lower === 'resume') {
      if (openStart !== null && event.ts > openStart) {
        if (event.ts - openStart >= EXCLUDE_IDLE_OVER_MS) {
          periods.push({ startedAt: openStart, endedAt: event.ts })
        }
        openStart = null
      }
    }
  }
  return periods
}

// ─── Step 2 — normalize raw rows into activity_segments ──────────────────────
export function normalizeToSegments(
  deviceId: string,
  fromMs: number,
  toMs: number,
  db: Database.Database = getDb(),
): ActivitySegmentRecord[] {
  const sessions = db.prepare(`
    SELECT id, bundle_id, app_name, start_time, end_time, duration_sec,
           is_focused, window_title, category
    FROM app_sessions
    WHERE COALESCE(end_time, start_time + duration_sec * 1000) > ?
      AND start_time < ?
      AND duration_sec >= 5
    ORDER BY start_time ASC
  `).all(fromMs, toMs) as RawAppSessionRow[]

  if (sessions.length === 0) return []

  const idlePeriods = loadIdlePeriods(db, fromMs, toMs)
  const appMap = loadAppAttentionMap(db)
  const segments: ActivitySegmentRecord[] = []
  const now = Date.now()

  for (const session of sessions) {
    const start = Math.max(session.start_time, fromMs)
    const end = Math.min(session.end_time ?? (session.start_time + session.duration_sec * 1000), toMs)
    if (end <= start) continue

    // Slice around any idle periods overlapping this session.
    const slices = sliceAroundIdle(start, end, idlePeriods)
    for (const slice of slices) {
      const durationMs = slice.end - slice.start
      if (durationMs < 5_000) continue

      const idleOverlap = computeIdleOverlap(slice.start, slice.end, idlePeriods)
      const idleRatio = durationMs > 0 ? idleOverlap / durationMs : 0
      const inputScore = session.is_focused ? 0.85 : 0.55
      const attentionScore = Math.max(0, inputScore * (1 - idleRatio))

      const appRow = appMap.get(session.bundle_id)
      const baseClass = appRow?.attention_class ?? deriveAttentionFromCategory(session.category)
      const segmentClass: ActivitySegmentRecord['class'] =
        idleRatio > 0.7 ? 'idle'
        : baseClass === 'focus' ? 'focused'
        : baseClass

      // Domain enrichment from website_visits inside this slice (if browser).
      const domain = looksLikeBrowser(session.bundle_id, session.app_name)
        ? topDomainInRange(db, slice.start, slice.end, session.bundle_id)
        : null

      segments.push({
        id: `seg_${randomUUID()}`,
        deviceId,
        startedAt: slice.start,
        endedAt: slice.end,
        durationMs,
        primaryBundleId: session.bundle_id,
        windowTitle: session.window_title,
        domain,
        filePath: null,
        inputScore,
        attentionScore,
        idleRatio,
        class: segmentClass,
        rawSessionIds: [session.id],
      })
    }
  }

  // Persist (idempotent for the range — clear then insert).
  persistSegments(db, deviceId, fromMs, toMs, segments, now)
  return segments
}

function sliceAroundIdle(
  start: number, end: number, idle: IdlePeriod[],
): Array<{ start: number; end: number }> {
  const slices: Array<{ start: number; end: number }> = [{ start, end }]
  for (const period of idle) {
    if (period.endedAt <= start || period.startedAt >= end) continue
    const next: Array<{ start: number; end: number }> = []
    for (const slice of slices) {
      if (period.endedAt <= slice.start || period.startedAt >= slice.end) {
        next.push(slice)
        continue
      }
      if (period.startedAt > slice.start) next.push({ start: slice.start, end: period.startedAt })
      if (period.endedAt < slice.end) next.push({ start: period.endedAt, end: slice.end })
    }
    slices.splice(0, slices.length, ...next)
  }
  return slices
}

function computeIdleOverlap(start: number, end: number, idle: IdlePeriod[]): number {
  let overlap = 0
  for (const period of idle) {
    const lo = Math.max(start, period.startedAt)
    const hi = Math.min(end, period.endedAt)
    if (hi > lo) overlap += hi - lo
  }
  return overlap
}

function deriveAttentionFromCategory(category: string): 'focus' | 'supporting' | 'ambient' {
  if (['development', 'design', 'writing', 'research', 'productivity', 'aiTools'].includes(category)) return 'focus'
  if (['communication', 'email', 'meetings'].includes(category)) return 'supporting'
  return 'ambient'
}

function looksLikeBrowser(bundleId: string, appName: string): boolean {
  const lower = `${bundleId} ${appName}`.toLowerCase()
  return /(chrome|safari|firefox|edge|brave|arc|opera|vivaldi|browser)/.test(lower)
}

function topDomainInRange(
  db: Database.Database, start: number, end: number, browserBundleId: string,
): string | null {
  const row = db.prepare(`
    SELECT domain, SUM(duration_sec) AS total
    FROM website_visits
    WHERE visit_time >= ? AND visit_time < ?
      AND (browser_bundle_id = ? OR browser_bundle_id IS NULL)
      AND domain IS NOT NULL
    GROUP BY domain
    ORDER BY total DESC
    LIMIT 1
  `).get(start, end, browserBundleId) as { domain: string; total: number } | undefined
  return row?.domain ?? null
}

function persistSegments(
  db: Database.Database, deviceId: string, fromMs: number, toMs: number,
  segments: ActivitySegmentRecord[], now: number,
): void {
  const insert = db.prepare(`
    INSERT INTO activity_segments (
      id, device_id, started_at, ended_at, duration_ms,
      primary_bundle_id, window_title, domain, file_path,
      input_score, attention_score, idle_ratio, class,
      raw_session_ids_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM activity_segments
      WHERE device_id = ? AND started_at >= ? AND started_at < ?
    `).run(deviceId, fromMs, toMs)
    for (const seg of segments) {
      insert.run(
        seg.id, seg.deviceId, seg.startedAt, seg.endedAt, seg.durationMs,
        seg.primaryBundleId, seg.windowTitle, seg.domain, seg.filePath,
        seg.inputScore, seg.attentionScore, seg.idleRatio, seg.class,
        JSON.stringify(seg.rawSessionIds), now,
      )
    }
  })
  tx()
}

// ─── Step 3/4 — extract signals + score against attribution_rules ───────────
const GENERIC_TITLE_WORDS = new Set([
  'inbox', 'slack', 'zoom', 'dashboard', 'home', 'untitled', 'new tab',
  'gmail', 'mail', 'calendar', 'meeting', 'meet', 'workspace', 'github',
])
const GENERIC_DOMAINS = new Set([
  'docs.google.com', 'drive.google.com', 'mail.google.com', 'gmail.com',
  'github.com', 'gitlab.com', 'notion.so', 'app.asana.com', 'slack.com',
  'app.slack.com', 'discord.com', 'web.whatsapp.com', 'zoom.us',
  'web.microsoft.com', 'teams.microsoft.com', 'outlook.live.com',
  'outlook.office.com', 'figma.com', 'linear.app',
])

export function extractSignals(segment: ActivitySegmentRecord): AttributionSignal[] {
  const signals: AttributionSignal[] = []

  if (segment.filePath) {
    signals.push({
      kind: 'file_prefix',
      value: segment.filePath,
      weight: SIGNAL_BASE_WEIGHT.file_prefix,
    })
  }

  if (segment.domain) {
    const isGeneric = GENERIC_DOMAINS.has(segment.domain.toLowerCase())
    signals.push({
      kind: isGeneric ? 'generic_domain' : 'client_domain',
      value: segment.domain.toLowerCase(),
      weight: isGeneric ? SIGNAL_BASE_WEIGHT.generic_domain : SIGNAL_BASE_WEIGHT.client_domain,
    })
  }

  if (segment.windowTitle) {
    const cleaned = stripGenericNouns(segment.windowTitle)
    if (cleaned) {
      const isStructured = /\.[a-z0-9]{2,5}\b|\bQ[1-4]\b|—|–|\d{4}/.test(cleaned)
      signals.push({
        kind: isStructured ? 'document_title' : 'window_title',
        value: cleaned,
        weight: isStructured ? SIGNAL_BASE_WEIGHT.document_title : SIGNAL_BASE_WEIGHT.window_title,
      })
    }
  }

  signals.push({
    kind: 'app_bundle',
    value: segment.primaryBundleId,
    weight: SIGNAL_BASE_WEIGHT.app_bundle,
  })

  return signals.sort((left, right) => right.weight - left.weight)
}

function stripGenericNouns(title: string): string {
  const tokens = title.split(/[\s\-—–·|/]+/).filter((token) => {
    const norm = token.trim().toLowerCase()
    return norm.length > 0 && !GENERIC_TITLE_WORDS.has(norm)
  })
  return tokens.join(' ').trim()
}

// ─── Step 4 — score a segment against active rules ──────────────────────────
function loadActiveRules(db: Database.Database): AttributionRuleRow[] {
  return db.prepare(`
    SELECT id, client_id, project_id, signal_type, operator, pattern,
           scope_bundle_id, weight, source
    FROM attribution_rules
    WHERE status = 'active'
  `).all() as AttributionRuleRow[]
}

function ruleMatchesSignal(rule: AttributionRuleRow, signal: AttributionSignal, segment: ActivitySegmentRecord): boolean {
  if (rule.scope_bundle_id && rule.scope_bundle_id !== segment.primaryBundleId) return false

  // Map signal_type → which signal kind to apply against.
  const signalKinds: Record<string, SignalKind[]> = {
    domain: ['client_domain', 'generic_domain'],
    title_contains: ['document_title', 'window_title'],
    title_regex: ['document_title', 'window_title'],
    file_prefix: ['file_prefix'],
    repo_remote: ['repo_remote'],
    email_domain: ['client_domain'],
    app_bundle: ['app_bundle'],
  }
  const allowed = signalKinds[rule.signal_type]
  if (!allowed || !allowed.includes(signal.kind)) return false

  const value = signal.value
  const pattern = rule.pattern
  switch (rule.operator) {
    case 'equals': return value === pattern
    case 'contains': return value.toLowerCase().includes(pattern.toLowerCase())
    case 'prefix': return value.toLowerCase().startsWith(pattern.toLowerCase())
    case 'regex': {
      try { return new RegExp(pattern, 'i').test(value) } catch { return false }
    }
    default: return false
  }
}

export interface ScoredCandidate {
  clientId: string | null
  projectId: string | null
  score: number
  confidence: number
  matchedSignals: AttributionSignal[]
  decisionSource: SegmentAttributionRecord['decisionSource']
}

export function scoreSegment(
  segment: ActivitySegmentRecord,
  signals: AttributionSignal[],
  rules: AttributionRuleRow[],
): ScoredCandidate[] {
  const buckets = new Map<string, ScoredCandidate>()
  const key = (clientId: string | null, projectId: string | null) =>
    `${clientId ?? ''}|${projectId ?? ''}`

  for (const rule of rules) {
    for (const signal of signals) {
      if (!ruleMatchesSignal(rule, signal, segment)) continue
      const k = key(rule.client_id, rule.project_id)
      const existing = buckets.get(k)
      const contribution = signal.weight * rule.weight * (rule.source === 'user' ? 1.1 : 1.0)
      if (existing) {
        existing.score += contribution
        if (!existing.matchedSignals.find((s) => s.kind === signal.kind && s.value === signal.value)) {
          existing.matchedSignals.push(signal)
        }
      } else {
        buckets.set(k, {
          clientId: rule.client_id,
          projectId: rule.project_id,
          score: contribution,
          confidence: 0,
          matchedSignals: [signal],
          decisionSource: 'rule',
        })
      }
    }
  }

  // Confidence = sigmoid-ish over score, bounded to [0, 0.99].
  for (const candidate of buckets.values()) {
    candidate.confidence = Math.min(0.99, candidate.score / (candidate.score + 0.6))
  }
  return [...buckets.values()].sort((left, right) => right.confidence - left.confidence)
}

// ─── Step 5 — neighbor propagation ──────────────────────────────────────────
export function propagateAttribution(
  segments: ActivitySegmentRecord[],
  candidatesBySegment: Map<string, ScoredCandidate[]>,
): void {
  const ordered = [...segments].sort((left, right) => left.startedAt - right.startedAt)
  for (let i = 0; i < ordered.length; i++) {
    const segment = ordered[i]
    const top = candidatesBySegment.get(segment.id)?.[0]
    if (top && top.confidence >= MIN_CONFIDENCE_TO_ATTRIBUTE) continue

    const prev = i > 0 ? candidatesBySegment.get(ordered[i - 1].id)?.[0] : undefined
    const next = i < ordered.length - 1 ? candidatesBySegment.get(ordered[i + 1].id)?.[0] : undefined
    if (!prev || !next) continue
    if (prev.confidence < MIN_CONFIDENCE_TO_ATTRIBUTE) continue
    if (next.confidence < MIN_CONFIDENCE_TO_ATTRIBUTE) continue
    if (prev.clientId !== next.clientId || prev.projectId !== next.projectId) continue

    // Reject if current segment has a strong contrary candidate.
    if (top && top.confidence > 0.55 && (top.clientId !== prev.clientId || top.projectId !== prev.projectId)) continue

    const propagated: ScoredCandidate = {
      clientId: prev.clientId,
      projectId: prev.projectId,
      score: prev.score,
      confidence: Math.min(prev.confidence, next.confidence) * NEIGHBOR_PROPAGATION_PENALTY,
      matchedSignals: [],
      decisionSource: 'neighbor_propagation',
    }
    const list = candidatesBySegment.get(segment.id) ?? []
    list.unshift(propagated)
    candidatesBySegment.set(segment.id, list)
  }
}

function persistSegmentAttributions(
  db: Database.Database,
  deviceId: string,
  fromMs: number, toMs: number,
  segments: ActivitySegmentRecord[],
  candidatesBySegment: Map<string, ScoredCandidate[]>,
): void {
  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO segment_attributions (
      id, segment_id, client_id, project_id, score, confidence, rank,
      decision_source, matched_signals_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM segment_attributions
      WHERE segment_id IN (
        SELECT id FROM activity_segments
        WHERE device_id = ? AND started_at >= ? AND started_at < ?
      )
    `).run(deviceId, fromMs, toMs)
    for (const segment of segments) {
      const list = (candidatesBySegment.get(segment.id) ?? []).slice(0, 5)
      list.forEach((candidate, index) => {
        insert.run(
          `att_${randomUUID()}`,
          segment.id,
          candidate.clientId,
          candidate.projectId,
          candidate.score,
          candidate.confidence,
          index + 1,
          candidate.decisionSource,
          JSON.stringify(candidate.matchedSignals),
          now,
        )
      })
    }
  })
  tx()
}

// ─── Step 6 — sessionize segments into work_sessions ────────────────────────
interface SessionizedGroup {
  segments: ActivitySegmentRecord[]
  topCandidate: ScoredCandidate | null
}

function sessionize(
  segments: ActivitySegmentRecord[],
  candidatesBySegment: Map<string, ScoredCandidate[]>,
): SessionizedGroup[] {
  const ordered = [...segments].sort((left, right) => left.startedAt - right.startedAt)
  const groups: SessionizedGroup[] = []
  for (const segment of ordered) {
    if (segment.class === 'idle') continue
    const top = candidatesBySegment.get(segment.id)?.[0] ?? null
    const last = groups[groups.length - 1]
    if (!last) {
      groups.push({ segments: [segment], topCandidate: top })
      continue
    }
    const lastEnd = last.segments[last.segments.length - 1].endedAt
    const gap = segment.startedAt - lastEnd
    const sameTarget =
      (last.topCandidate?.clientId ?? null) === (top?.clientId ?? null) &&
      (last.topCandidate?.projectId ?? null) === (top?.projectId ?? null)

    if (gap <= MAX_MERGE_GAP_MS && sameTarget) {
      last.segments.push(segment)
      // Keep the strongest candidate seen so far for the merged session.
      if (top && (last.topCandidate == null || top.confidence > last.topCandidate.confidence)) {
        last.topCandidate = top
      }
    } else {
      groups.push({ segments: [segment], topCandidate: top })
    }
  }
  return groups
}

interface PersistedWorkSession {
  id: string
  startedAt: number
  endedAt: number
  durationMs: number
  activeMs: number
  idleMs: number
  clientId: string | null
  projectId: string | null
  status: 'attributed' | 'ambiguous' | 'unattributed'
  confidence: number | null
  title: string | null
  primaryBundleId: string | null
  appBundleIds: string[]
}

function buildSessionTitle(group: SessionizedGroup, candidate: ScoredCandidate | null): string | null {
  const top = candidate?.matchedSignals?.[0]
  const file = group.segments.map((s) => s.filePath).find(Boolean)
  const domain = group.segments.map((s) => s.domain).find(Boolean)
  if (top?.kind === 'file_prefix' || top?.kind === 'document_title') return top.value
  if (file) return file.split(/[\\/]/).pop() ?? file
  if (domain) return domain
  const cleaned = group.segments
    .map((s) => stripGenericNouns(s.windowTitle ?? ''))
    .find((value) => value.length > 0)
  return cleaned ?? null
}

function persistWorkSessions(
  db: Database.Database,
  deviceId: string,
  fromMs: number, toMs: number,
  groups: SessionizedGroup[],
): PersistedWorkSession[] {
  const now = Date.now()
  const insertSession = db.prepare(`
    INSERT INTO work_sessions (
      id, device_id, started_at, ended_at, duration_ms, active_ms, idle_ms,
      client_id, project_id, attribution_status, attribution_confidence,
      title, primary_bundle_id, app_bundle_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMember = db.prepare(`
    INSERT INTO work_session_segments (work_session_id, segment_id, role, contribution_ms)
    VALUES (?, ?, ?, ?)
  `)
  const insertEvidence = db.prepare(`
    INSERT INTO work_session_evidence (
      id, work_session_id, evidence_type, evidence_value, weight,
      source_segment_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const persisted: PersistedWorkSession[] = []

  const tx = db.transaction(() => {
    // Drop existing derived rows in this range, cascade clears members + evidence.
    db.prepare(`
      DELETE FROM work_sessions
      WHERE device_id = ? AND started_at >= ? AND started_at < ?
    `).run(deviceId, fromMs, toMs)

    for (const group of groups) {
      const startedAt = group.segments[0].startedAt
      const endedAt = group.segments[group.segments.length - 1].endedAt
      const durationMs = endedAt - startedAt
      const activeMs = group.segments.reduce((sum, seg) => sum + Math.round(seg.durationMs * (1 - seg.idleRatio)), 0)
      const idleMs = group.segments.reduce((sum, seg) => sum + Math.round(seg.durationMs * seg.idleRatio), 0)

      const candidate = group.topCandidate
      const status: PersistedWorkSession['status'] =
        !candidate || !candidate.clientId ? 'unattributed'
        : candidate.confidence >= MIN_CONFIDENCE_TO_ATTRIBUTE ? 'attributed'
        : 'ambiguous'

      const bundles = [...new Set(group.segments.map((s) => s.primaryBundleId))]
      const primaryBundle = bundles[0] ?? null
      const title = buildSessionTitle(group, candidate)
      const id = `ws_${randomUUID()}`

      insertSession.run(
        id, deviceId, startedAt, endedAt, durationMs, activeMs, idleMs,
        status === 'unattributed' ? null : candidate?.clientId ?? null,
        status === 'unattributed' ? null : candidate?.projectId ?? null,
        status, candidate?.confidence ?? null,
        title, primaryBundle, JSON.stringify(bundles), now, now,
      )

      for (const segment of group.segments) {
        const role: 'primary' | 'supporting' | 'ambient' =
          segment.class === 'focused' ? 'primary'
          : segment.class === 'supporting' ? 'supporting'
          : 'ambient'
        insertMember.run(id, segment.id, role, segment.durationMs)
      }

      // Evidence: dedup top signals across member segments.
      const seen = new Set<string>()
      for (const segment of group.segments) {
        const signals = candidate?.matchedSignals ?? []
        for (const signal of signals) {
          const k = `${signal.kind}|${signal.value}`
          if (seen.has(k)) continue
          seen.add(k)
          insertEvidence.run(
            `wse_${randomUUID()}`, id,
            evidenceTypeForSignal(signal.kind), signal.value, signal.weight,
            segment.id, now,
          )
        }
        if (segment.domain && !seen.has(`domain|${segment.domain}`)) {
          seen.add(`domain|${segment.domain}`)
          insertEvidence.run(
            `wse_${randomUUID()}`, id,
            'domain', segment.domain, SIGNAL_BASE_WEIGHT.client_domain,
            segment.id, now,
          )
        }
        if (segment.windowTitle && !seen.has(`title|${segment.windowTitle}`)) {
          seen.add(`title|${segment.windowTitle}`)
          insertEvidence.run(
            `wse_${randomUUID()}`, id,
            'title', segment.windowTitle, 0.4, segment.id, now,
          )
        }
      }

      persisted.push({
        id,
        startedAt, endedAt, durationMs, activeMs, idleMs,
        clientId: status === 'unattributed' ? null : candidate?.clientId ?? null,
        projectId: status === 'unattributed' ? null : candidate?.projectId ?? null,
        status,
        confidence: candidate?.confidence ?? null,
        title,
        primaryBundleId: primaryBundle,
        appBundleIds: bundles,
      })
    }
  })
  tx()

  return persisted
}

function evidenceTypeForSignal(kind: SignalKind): string {
  switch (kind) {
    case 'repo_remote': return 'repo_remote'
    case 'file_prefix': return 'file_path'
    case 'client_domain':
    case 'generic_domain': return 'domain'
    case 'document_title':
    case 'window_title': return 'title'
    case 'app_bundle': return 'sequence'
  }
}

// ─── Step 7 — rollups ───────────────────────────────────────────────────────
function localDayStringForMs(ms: number, _timezone: string): string {
  // Local date in the user's wall-clock — Electron runs in user's tz.
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function updateRollups(
  fromMs: number, toMs: number,
  timezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  db: Database.Database = getDb(),
): void {
  // Compute aggregates per (day, client, project) directly from work_sessions
  // in the affected range, then UPSERT into daily_entity_rollups. Because the
  // function accepts an arbitrary range we recompute every (day, client_id,
  // project_id) tuple touched by sessions in that range.
  const sessions = db.prepare(`
    SELECT id, started_at, duration_ms, active_ms,
           client_id, project_id, attribution_status
    FROM work_sessions
    WHERE started_at >= ? AND started_at < ?
  `).all(fromMs, toMs) as Array<{
    id: string
    started_at: number
    duration_ms: number
    active_ms: number
    client_id: string | null
    project_id: string | null
    attribution_status: 'attributed' | 'ambiguous' | 'unattributed'
  }>

  type Acc = { attributed: number; ambiguous: number; sessions: number }
  const buckets = new Map<string, Acc>()
  const k = (day: string, clientId: string | null, projectId: string | null) =>
    `${day}|${clientId ?? ''}|${projectId ?? ''}`

  for (const session of sessions) {
    if (!session.client_id) continue
    const day = localDayStringForMs(session.started_at, timezone)
    const key = k(day, session.client_id, session.project_id)
    const acc = buckets.get(key) ?? { attributed: 0, ambiguous: 0, sessions: 0 }
    acc.sessions += 1
    if (session.attribution_status === 'attributed') acc.attributed += session.active_ms
    else if (session.attribution_status === 'ambiguous') acc.ambiguous += session.active_ms
    buckets.set(key, acc)
  }

  const upsert = db.prepare(`
    INSERT INTO daily_entity_rollups (
      day_local, timezone, client_id, project_id,
      attributed_ms, ambiguous_ms, session_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day_local, timezone, client_id, project_id) DO UPDATE SET
      attributed_ms = excluded.attributed_ms,
      ambiguous_ms  = excluded.ambiguous_ms,
      session_count = excluded.session_count,
      updated_at    = excluded.updated_at
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const [key, acc] of buckets) {
      const [day, clientPart, projectPart] = key.split('|')
      upsert.run(
        day, timezone,
        clientPart || null, projectPart || null,
        acc.attributed, acc.ambiguous, acc.sessions, now,
      )
    }
  })
  tx()
}

// ─── Top-level orchestrator ─────────────────────────────────────────────────
export interface AttributionRunResult {
  segmentCount: number
  sessionCount: number
  attributedSessions: number
  ambiguousSessions: number
  unattributedSessions: number
  fromMs: number
  toMs: number
}

export function runAttributionForRange(
  fromMs: number, toMs: number,
  options: { timezone?: string } = {},
  db: Database.Database = getDb(),
): AttributionRunResult {
  const deviceId = ensureLocalDevice(db)
  const segments = normalizeToSegments(deviceId, fromMs, toMs, db)
  const rules = loadActiveRules(db)

  const candidatesBySegment = new Map<string, ScoredCandidate[]>()
  for (const segment of segments) {
    const signals = extractSignals(segment)
    candidatesBySegment.set(segment.id, scoreSegment(segment, signals, rules))
  }
  propagateAttribution(segments, candidatesBySegment)
  persistSegmentAttributions(db, deviceId, fromMs, toMs, segments, candidatesBySegment)

  const groups = sessionize(segments, candidatesBySegment)
  const sessions = persistWorkSessions(db, deviceId, fromMs, toMs, groups)
  updateRollups(fromMs, toMs, options.timezone, db)

  return {
    segmentCount: segments.length,
    sessionCount: sessions.length,
    attributedSessions: sessions.filter((s) => s.status === 'attributed').length,
    ambiguousSessions: sessions.filter((s) => s.status === 'ambiguous').length,
    unattributedSessions: sessions.filter((s) => s.status === 'unattributed').length,
    fromMs, toMs,
  }
}

// ─── Step 8 — backfill from legacy raw data ─────────────────────────────────
export function backfillFromLegacyData(
  options: { batchDays?: number; timezone?: string } = {},
  db: Database.Database = getDb(),
): { dayCount: number; totalSessions: number } {
  const batchDays = Math.max(1, options.batchDays ?? 1)
  const range = db.prepare(`
    SELECT MIN(start_time) AS lo, MAX(COALESCE(end_time, start_time + duration_sec * 1000)) AS hi
    FROM app_sessions
  `).get() as { lo: number | null; hi: number | null }

  if (!range.lo || !range.hi || range.hi <= range.lo) {
    return { dayCount: 0, totalSessions: 0 }
  }

  const dayMs = 86_400_000 * batchDays
  let totalSessions = 0
  let dayCount = 0
  for (let cursor = range.lo; cursor < range.hi; cursor += dayMs) {
    const end = Math.min(range.hi, cursor + dayMs)
    const result = runAttributionForRange(cursor, end, { timezone: options.timezone }, db)
    totalSessions += result.sessionCount
    dayCount += 1
  }
  return { dayCount, totalSessions }
}
