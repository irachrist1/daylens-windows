// Exact-retrieval memory index (memory-and-entities.md §Memory record,
// §Retrieval flow, DEV-178).
//
// One local, queryable store of "moments worth finding again", built from the
// SAME corrected activity facts Timeline and Apps render — never from raw
// app_sessions directly. Each indexed day is a deterministic projection:
//
//   corrected sessions (canonical focus-event projection, legacy fallback,
//   ignored blocks and evidence exclusions already subtracted)
//     → one memory record per visible session, tagged with its application
//       entity and any client/project the overlapping work session attributes
//   meeting entities observed that day → one record each (entity-named)
//   artifact mentions that day        → one record each (entity-named)
//   corrected browsing that day       → one record per domain (entity-named
//     where a page entity exists), so exact browser retrieval reads this
//     boundary instead of raw website_visits
//
// Because the input is the corrected read model, a deleted block or excluded
// app never enters the index, and reindexing a day after a correction removes
// what the correction removed — results cannot resurrect (spec §Corrections
// and deletion). Entity-named records carry NO index-time text: they are found
// through entity resolution (canonical name + aliases) at query time, so a
// rename changes search results instantly and a removed alias stops matching
// without any reindex.
//
// LOCAL-ONLY: memory_records, memory_record_entities, and memory_index_days
// have no sync-allowlist keys and can never serialize into a remote payload
// (tests/syncAllowlist.test.ts).
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { AppSession } from '@shared/types'
import { localDayBounds, localDateString } from '../lib/localDate'
import { normalizeUrlForStorage } from '../lib/appIdentity'
import {
  getCorrectedSessionsForRange,
  getEvidenceExclusionsForRange,
  getIgnoredBlockSpansForRange,
  type CorrectionSpan,
} from './activityFacts'
import { artifactIdFor } from './workBlocks'
import { mergeGroupIds, resolveMergeChain, type EntityRow } from './entities/entityRepository'

/** Bump to force a full reindex on upgrade (the version is part of every
 *  day fingerprint, so stale-format days re-project lazily). */
export const MEMORY_INDEX_VERSION = 4

export type MemoryRecordKind = 'session' | 'meeting' | 'artifact' | 'page' | 'connected_activity'

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) != null
}

export function memoryIndexAvailable(db: Database.Database): boolean {
  return tableExists(db, 'memory_records') && tableExists(db, 'memory_index_days')
}

function newRecordId(): string {
  return `mem_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

// ─── Day input fingerprint ───────────────────────────────────────────────────
// Cheap, deterministic digest of everything that can change a day's records:
// evidence volume, correction ledger state, attribution, meeting refs, and
// artifact mentions. Same inputs ⇒ same fingerprint ⇒ no reindex.

function countAndMax(
  db: Database.Database,
  sql: string,
  ...params: unknown[]
): string {
  const row = db.prepare(sql).get(...params) as { c: number; m: number | null } | undefined
  return `${row?.c ?? 0}:${row?.m ?? 0}`
}

export function memoryIndexDayFingerprint(db: Database.Database, date: string): string {
  const [fromMs, toMs] = localDayBounds(date)
  const parts = [
    `v${MEMORY_INDEX_VERSION}`,
    `fe:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(ts_ms) AS m FROM focus_events WHERE ts_ms >= ? AND ts_ms < ?`, fromMs, toMs)}`,
    `as:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(start_time) AS m FROM app_sessions WHERE start_time >= ? AND start_time < ?`, fromMs, toMs)}`,
    `rev:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM timeline_block_reviews WHERE date = ?`, date)}`,
    `bnd:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM timeline_boundary_corrections WHERE date = ?`, date)}`,
    `exc:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(created_at) AS m FROM evidence_exclusions WHERE date = ?`, date)}`,
    `ws:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM work_sessions WHERE started_at < ? AND ended_at > ?`, toMs, fromMs)}`,
    `mtg:${countAndMax(db, `
      SELECT COUNT(*) AS c, MAX(r.created_at) AS m
      FROM entity_evidence_refs r
      JOIN entities e ON e.id = r.entity_id AND e.entity_type = 'meeting'
      WHERE r.span_start_ms >= ? AND r.span_start_ms < ?`, fromMs, toMs)}`,
    `art:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(start_time) AS m FROM artifact_mentions WHERE start_time >= ? AND start_time < ?`, fromMs, toMs)}`,
    `wv:${countAndMax(db, `SELECT COUNT(*) AS c, MAX(visit_time) AS m FROM website_visits WHERE visit_time >= ? AND visit_time < ?`, fromMs, toMs)}`,
    `cnr:${tableExists(db, 'connector_records')
      ? countAndMax(db, `SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM connector_records WHERE date = ? AND kind IN ('repository_activity', 'issue_activity', 'meeting_record')`, date)
      : '0:0'}`,
  ]
  return parts.join('|')
}

// ─── Record building ─────────────────────────────────────────────────────────

interface PendingRecord {
  id: string
  kind: MemoryRecordKind
  memoryType: 'observed' | 'connected' | 'supplied' | 'inferred'
  statement: string
  /** Index-time full-text. EMPTY for entity-named records — those match via
   *  entity resolution so renames/alias removals apply instantly. */
  exactText: string
  startMs: number
  endMs: number
  appBundleId: string | null
  appName: string | null
  title: string | null
  /** Set on page records so a browser result can be rebuilt from the record. */
  domain?: string | null
  url?: string | null
  primaryEntityId: string | null
  sourceRefs: string[]
  entityIds: Set<string>
  /** Defaults to 'standard'; connected personal content (meeting notes)
   *  carries its source sensitivity into the record row. */
  sensitivity?: 'standard' | 'personal' | 'high'
}

function startsInsideSpans(startMs: number, spans: readonly CorrectionSpan[]): boolean {
  return spans.some((span) => startMs >= span.startMs && startMs < span.endMs)
}

function activeEntityId(db: Database.Database, id: string): string | null {
  const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow | undefined
  if (!row) return null
  const survivor = resolveMergeChain(db, row)
  return survivor.status === 'deleted' ? null : survivor.id
}

function applicationEntityIdFor(
  db: Database.Database,
  session: AppSession,
  cache: Map<string, string | null>,
): string | null {
  const key = `app:${session.canonicalAppId ?? session.appInstanceId ?? session.bundleId}`
  if (cache.has(key)) return cache.get(key) ?? null
  const row = db.prepare(
    `SELECT * FROM entities WHERE entity_type = 'application' AND identity_key = ?`,
  ).get(key) as EntityRow | undefined
  const survivorId = row ? resolveMergeChain(db, row).id : null
  cache.set(key, survivorId)
  return survivorId
}

function sessionRecords(db: Database.Database, date: string, fromMs: number, toMs: number): PendingRecord[] {
  const sessions = getCorrectedSessionsForRange(db, fromMs, toMs)
  const appEntityCache = new Map<string, string | null>()
  const records: PendingRecord[] = []
  for (const session of sessions) {
    if (session.durationSeconds <= 0) continue
    const title = session.windowTitle?.trim() || null
    const exactText = [title, session.appName].filter(Boolean).join(' ')
    if (!exactText) continue
    const record: PendingRecord = {
      id: newRecordId(),
      kind: 'session',
      memoryType: 'observed',
      statement: title ? `${session.appName} — ${title}` : `Used ${session.appName}`,
      exactText,
      startMs: session.startTime,
      endMs: session.endTime ?? session.startTime + session.durationSeconds * 1000,
      appBundleId: session.bundleId,
      appName: session.appName,
      title,
      primaryEntityId: null,
      sourceRefs: [`corrected_session:${date}:${session.startTime}`],
      entityIds: new Set<string>(),
    }
    const appEntityId = applicationEntityIdFor(db, session, appEntityCache)
    if (appEntityId) record.entityIds.add(appEntityId)
    records.push(record)
  }
  return records
}

/** Tag session records with the client/project the overlapping attributed
 *  work session names — that is what lets "acme" find Acme Corp's days even
 *  when no window title ever contained the word. */
function applyAttributionTags(
  db: Database.Database,
  records: PendingRecord[],
  fromMs: number,
  toMs: number,
): void {
  const attributed = db.prepare(`
    SELECT started_at, ended_at, client_id, project_id
    FROM work_sessions
    WHERE started_at < ? AND ended_at > ?
      AND (client_id IS NOT NULL OR project_id IS NOT NULL)
  `).all(toMs, fromMs) as Array<{
    started_at: number
    ended_at: number
    client_id: string | null
    project_id: string | null
  }>
  if (attributed.length === 0) return
  const entityCache = new Map<string, string | null>()
  const resolve = (id: string | null): string | null => {
    if (!id) return null
    if (!entityCache.has(id)) entityCache.set(id, activeEntityId(db, id))
    return entityCache.get(id) ?? null
  }
  for (const record of records) {
    if (record.kind !== 'session') continue
    for (const span of attributed) {
      if (record.startMs >= span.ended_at || record.endMs <= span.started_at) continue
      const clientEntity = resolve(span.client_id)
      const projectEntity = resolve(span.project_id)
      if (clientEntity) record.entityIds.add(clientEntity)
      if (projectEntity) record.entityIds.add(projectEntity)
    }
  }
}

// ─── Scheduled context vs an attended meeting ────────────────────────────────
// connectors.md §Google Calendar: "A calendar event is scheduled context. It
// becomes evidence that a meeting occurred only when device activity, call
// presence, Granola, transcript, or explicit confirmation supports that
// interpretation." A calendar-shaped evidence ref — the local calendar day
// signal, a connector's calendar ledger ref, or a calendar_event envelope —
// is a SCHEDULE claim; anything else (meeting notes, meeting_record
// envelopes, any future observed source) supports occurrence. Granola is one
// of the spec's named occurrence sources: a notes record from it — the
// per-record connector ref included — says the meeting HAPPENED.
function isScheduleShapedRef(ref: { source_type: string; source_id: string }): boolean {
  if (ref.source_type === 'connector') return !ref.source_id.startsWith('granola:')
  if (ref.source_type === 'connected_envelope') return ref.source_id.startsWith('calendar_event:')
  if (ref.source_type === 'external_signal') return ref.source_id.endsWith(':calendar')
  return false
}

function meetingHasOccurrenceSupport(db: Database.Database, survivorId: string): boolean {
  const groupIds = mergeGroupIds(db, survivorId)
  const marks = groupIds.map(() => '?').join(', ')
  const refs = db.prepare(
    `SELECT source_type, source_id FROM entity_evidence_refs WHERE entity_id IN (${marks})`,
  ).all(...groupIds) as Array<{ source_type: string; source_id: string }>
  return refs.some((ref) => !isScheduleShapedRef(ref))
}

function meetingRecords(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  ignoredSpans: readonly CorrectionSpan[],
): PendingRecord[] {
  const rows = db.prepare(`
    SELECT e.id AS entity_id, r.span_start_ms, r.span_end_ms, r.source_type, r.source_id
    FROM entity_evidence_refs r
    JOIN entities e ON e.id = r.entity_id AND e.entity_type = 'meeting'
    WHERE r.span_start_ms >= ? AND r.span_start_ms < ?
  `).all(fromMs, toMs) as Array<{
    entity_id: string
    span_start_ms: number
    span_end_ms: number | null
    source_type: string
    source_id: string
  }>
  const byEntity = new Map<string, PendingRecord>()
  for (const row of rows) {
    if (startsInsideSpans(row.span_start_ms, ignoredSpans)) continue
    const survivorId = activeEntityId(db, row.entity_id)
    if (!survivorId) continue
    const survivor = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(survivorId) as EntityRow
    const existing = byEntity.get(survivorId)
    if (existing) {
      existing.startMs = Math.min(existing.startMs, row.span_start_ms)
      existing.endMs = Math.max(existing.endMs, row.span_end_ms ?? row.span_start_ms)
      existing.sourceRefs.push(`${row.source_type}:${row.source_id}`)
      continue
    }
    // People connect through 'attended' relationships (spec: the entity graph
    // connects people and meetings) — tagging them here is what lets a search
    // for a person's name return the meetings they were part of.
    const attendees = db.prepare(`
      SELECT entity_id FROM entity_relationships
      WHERE related_entity_id = ? AND kind = 'attended'
    `).all(survivorId) as Array<{ entity_id: string }>
    const entityIds = new Set([survivorId])
    for (const attendee of attendees) {
      const personId = activeEntityId(db, attendee.entity_id)
      if (personId) entityIds.add(personId)
    }
    byEntity.set(survivorId, {
      id: newRecordId(),
      kind: 'meeting',
      memoryType: 'connected',
      // Scheduled context stays LABELED as scheduled everywhere the statement
      // surfaces (search results, context packets, agent answers) until some
      // non-calendar evidence supports that the meeting actually happened.
      statement: meetingHasOccurrenceSupport(db, survivorId)
        ? `Meeting: ${survivor.canonical_name}`
        : `Scheduled: ${survivor.canonical_name} (calendar event — not confirmed attended)`,
      // Entity-named: found via canonical name + aliases at query time.
      exactText: '',
      startMs: row.span_start_ms,
      endMs: row.span_end_ms ?? row.span_start_ms,
      appBundleId: null,
      appName: null,
      title: null,
      primaryEntityId: survivorId,
      sourceRefs: [`${row.source_type}:${row.source_id}`],
      entityIds,
    })
  }
  return [...byEntity.values()]
}

function artifactRecords(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  ignoredSpans: readonly CorrectionSpan[],
): PendingRecord[] {
  const rows = db.prepare(`
    SELECT m.artifact_id, m.start_time, m.end_time, a.display_title, a.artifact_type
    FROM artifact_mentions m
    JOIN artifacts a ON a.id = m.artifact_id
    WHERE m.start_time >= ? AND m.start_time < ?
  `).all(fromMs, toMs) as Array<{
    artifact_id: string
    start_time: number
    end_time: number
    display_title: string
    artifact_type: string
  }>
  const byArtifact = new Map<string, PendingRecord>()
  for (const row of rows) {
    if (startsInsideSpans(row.start_time, ignoredSpans)) continue
    const existing = byArtifact.get(row.artifact_id)
    if (existing) {
      existing.startMs = Math.min(existing.startMs, row.start_time)
      existing.endMs = Math.max(existing.endMs, row.end_time)
      continue
    }
    // Adoption (v50) kept the artifact id as the entity id when it minted a
    // page/file/repository entity for it.
    const entityId = activeEntityId(db, row.artifact_id)
    byArtifact.set(row.artifact_id, {
      id: newRecordId(),
      kind: 'artifact',
      memoryType: 'observed',
      statement: row.display_title,
      // Entity-named when an entity exists; plain text otherwise so the title
      // stays findable either way.
      exactText: entityId ? '' : row.display_title,
      startMs: row.start_time,
      endMs: row.end_time,
      appBundleId: null,
      appName: null,
      title: row.display_title,
      primaryEntityId: entityId,
      sourceRefs: [`artifact:${row.artifact_id}`],
      entityIds: new Set(entityId ? [entityId] : []),
    })
  }
  return [...byArtifact.values()]
}

/**
 * One record per page browsed that day, with the same corrections subtracted
 * that the timeline applies: a visit inside an ignored block span, or on a site
 * excluded over that span, never becomes a record. Re-projecting after a
 * correction therefore removes what the correction removed.
 *
 * Built from visits rather than from `getCorrectedDomainIntervals`. Those
 * intervals clip page time against the browser's corrected foreground
 * ownership, which is right for *time credit* and wrong here: a page visited
 * while the browser was never the foreground app still happened, and a person
 * searching for it should find it. Retrieval asks "did I see this", not "how
 * long does this get credited".
 *
 * The grouping key is the page, not the domain, and that is load-bearing rather
 * than cosmetic. A record is one retrievable unit: its indexed text is what
 * makes it match, and its statement/title/url are what a packet or a result
 * card then shows. Grouping a whole domain into one record breaks that pairing —
 * a day where github.com carried both `acme/portal#218` and `beacon/site#91`
 * produced a single record whose text contained BOTH pull requests while its
 * statement and url named only the busier one. Searching "beacon" matched on
 * beacon's title and returned acme's page: one client's evidence served under
 * another client's query. Keying on the page keeps text and identity describing
 * the same thing, so a scoped query can only return what it actually matched.
 *
 * The key is the canonical page key `workBlocks.ts` derives for page artifacts
 * (normalized URL, else the storage-normalized URL, else the domain), so a page
 * record and its page artifact/entity denote the same page. Repeat visits to
 * one page still collapse into one record — forty visits to that Notion page
 * are one thing a person remembers — so the record count stays proportional to
 * pages seen rather than to raw history size.
 */
function pageRecords(
  db: Database.Database,
  date: string,
  fromMs: number,
  toMs: number,
  ignoredSpans: readonly CorrectionSpan[],
): PendingRecord[] {
  if (!tableExists(db, 'website_visits')) return []

  const siteExclusions = getEvidenceExclusionsForRange(db, fromMs, toMs)
    .filter((exclusion) => exclusion.kind === 'site' && exclusion.domain)

  const visits = db.prepare(`
    SELECT id, domain, page_title, url, normalized_url, visit_time, duration_sec
    FROM website_visits
    WHERE visit_time >= ? AND visit_time < ?
    ORDER BY visit_time ASC
  `).all(fromMs, toMs) as Array<{
    id: number
    domain: string
    page_title: string | null
    url: string | null
    normalized_url: string | null
    visit_time: number
    duration_sec: number
  }>

  const byPage = new Map<string, {
    domain: string
    startMs: number
    endMs: number
    titleMs: Map<string, number>
    topUrl: string | null
    topUrlMs: number
  }>()

  for (const visit of visits) {
    if (startsInsideSpans(visit.visit_time, ignoredSpans)) continue
    const excluded = siteExclusions.some((exclusion) =>
      exclusion.domain === visit.domain
      && visit.visit_time >= exclusion.startMs
      && visit.visit_time < exclusion.endMs)
    if (excluded) continue

    // Same derivation as the page-artifact canonical key (workBlocks.ts), so a
    // page record and its artifact/entity agree on what "one page" means.
    const pageKey = visit.normalized_url
      ?? normalizeUrlForStorage(visit.url)
      ?? `domain:${visit.domain}`

    const milliseconds = Math.max(0, visit.duration_sec) * 1000
    const entry = byPage.get(pageKey) ?? {
      domain: visit.domain,
      startMs: visit.visit_time,
      endMs: visit.visit_time + milliseconds,
      titleMs: new Map<string, number>(),
      topUrl: null,
      topUrlMs: -1,
    }
    entry.startMs = Math.min(entry.startMs, visit.visit_time)
    entry.endMs = Math.max(entry.endMs, visit.visit_time + milliseconds)
    const title = visit.page_title?.trim()
    if (title) entry.titleMs.set(title, (entry.titleMs.get(title) ?? 0) + milliseconds)
    if (visit.url && milliseconds > entry.topUrlMs) {
      entry.topUrl = visit.url
      entry.topUrlMs = milliseconds
    }
    byPage.set(pageKey, entry)
  }

  const records: PendingRecord[] = []
  for (const [pageKey, entry] of byPage) {
    const titles = [...entry.titleMs.entries()].sort((left, right) => right[1] - left[1])
    const topTitle = titles[0]?.[0] ?? null
    // Adoption keeps the page artifact's id as the entity id, so deriving the
    // artifact id from the same canonical key tags the record with the entity
    // the graph already knows — and entity resolution then finds it by name.
    const entityId = activeEntityId(db, artifactIdFor(`page:${pageKey}`))
    records.push({
      id: newRecordId(),
      kind: 'page',
      memoryType: 'observed',
      // Always indexed, even when an entity tag exists: the tag makes the page
      // findable by its entity's name, never by the words on the page itself.
      // Only this page's own titles go in — pulling in a sibling page's words
      // is what let one client's query return another client's page.
      exactText: [entry.domain, ...titles.slice(0, 5).map(([title]) => title)].join(' '),
      statement: topTitle ? `${entry.domain} — ${topTitle}` : `Visited ${entry.domain}`,
      startMs: entry.startMs,
      endMs: entry.endMs,
      appBundleId: null,
      appName: null,
      title: topTitle,
      domain: entry.domain,
      url: entry.topUrl,
      primaryEntityId: entityId,
      sourceRefs: [`corrected_domain:${date}:${entry.domain}`],
      entityIds: new Set(entityId ? [entityId] : []),
    })
  }
  return records
}

// ─── Connected activity ──────────────────────────────────────────────────────
// One record per non-tombstoned connector ledger row about this day's
// connected work: coding activity (commits, pull requests, reviews, issues),
// issue-tracker movement, and meeting notes. The statement names the
// provider, so search results, packets, and agent answers always show WHERE
// the claim comes from — connected context, not observed activity.

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  github: 'GitHub',
  linear: 'Linear',
}

interface ConnectedActivityEnvelope {
  entity?: {
    kind?: string
    provider?: string
    owner?: string
    repo?: string
    activity?: { kind?: string; title?: string; state?: string | null; actorLogin?: string | null }
    people?: Array<{ connectorId?: string; displayName?: string }>
    // issue_activity fields
    identifier?: string
    title?: string
    state?: string | null
    stateType?: string | null
    team?: { key?: string; name?: string } | null
    project?: { sourceProjectId?: string; name?: string } | null
    cycle?: { number?: number; name?: string | null } | null
    // meeting_record fields
    participants?: Array<{ connectorId?: string; displayName?: string }>
  }
  notesSignal?: { title?: string; actionItems?: string[] }
}

function connectedActivityStatement(
  provider: string,
  repoFullName: string,
  activity: { kind?: string; title?: string; state?: string | null; actorLogin?: string | null },
): string {
  const title = activity.title ?? 'untitled'
  switch (activity.kind) {
    case 'commit':
      return `${provider}: committed "${title}" in ${repoFullName}`
    case 'pull_request': {
      const verb = activity.state === 'merged' ? 'merged'
        : activity.state === 'closed' ? 'closed'
          : activity.state === 'draft' ? 'drafted'
            : 'opened'
      return `${provider}: ${verb} pull request "${title}" in ${repoFullName}`
    }
    case 'review': {
      const outcome = activity.state ? ` (${activity.state})` : ''
      return activity.actorLogin
        ? `${provider}: review by ${activity.actorLogin} on "${title}"${outcome} in ${repoFullName}`
        : `${provider}: reviewed "${title}"${outcome} in ${repoFullName}`
    }
    case 'issue': {
      const state = activity.state ? ` (${activity.state})` : ''
      return `${provider}: issue "${title}"${state} in ${repoFullName}`
    }
    default:
      return `${provider}: activity in ${repoFullName}`
  }
}

/** "Linear: moved DAY-12 "Fix login" to In Progress in project Onboarding". */
function connectedIssueStatement(provider: string, entity: NonNullable<ConnectedActivityEnvelope['entity']>): string {
  const identifier = entity.identifier ?? 'an issue'
  const title = entity.title ?? 'untitled'
  const where = entity.project?.name
    ? ` in project ${entity.project.name}`
    : entity.team?.name ? ` in ${entity.team.name}` : ''
  const cycle = typeof entity.cycle?.number === 'number' ? ` (cycle ${entity.cycle.number})` : ''
  switch (entity.stateType) {
    case 'completed':
      return `${provider}: completed ${identifier} "${title}"${where}${cycle}`
    case 'canceled':
      return `${provider}: canceled ${identifier} "${title}"${where}${cycle}`
    case 'started':
      return `${provider}: moved ${identifier} "${title}" to ${entity.state ?? 'In Progress'}${where}${cycle}`
    default:
      return entity.state
        ? `${provider}: issue ${identifier} "${title}" (${entity.state})${where}${cycle}`
        : `${provider}: issue ${identifier} "${title}"${where}${cycle}`
  }
}

const MAX_NOTE_STATEMENT_ITEMS = 3
const MAX_NOTE_STATEMENT_ITEM_CHARS = 80

/** "Granola: notes from "Weekly sync" — Ship v2; Dana owns rollout". The
 *  statement carries only a few clipped note lines — minimized, personal
 *  sensitivity rides the record row. */
function connectedNotesStatement(title: string, actionItems: string[]): string {
  const clipped = actionItems
    .slice(0, MAX_NOTE_STATEMENT_ITEMS)
    .map((item) => (item.length > MAX_NOTE_STATEMENT_ITEM_CHARS
      ? `${item.slice(0, MAX_NOTE_STATEMENT_ITEM_CHARS - 1)}…`
      : item))
  return clipped.length > 0
    ? `Granola: notes from "${title}" — ${clipped.join('; ')}`
    : `Granola: notes from "${title}"`
}

function connectedActivityRecords(
  db: Database.Database,
  date: string,
  ignoredSpans: readonly CorrectionSpan[],
): PendingRecord[] {
  if (!tableExists(db, 'connector_records')) return []
  const rows = db.prepare(`
    SELECT id, connector_id, source_record_id, kind, entity_id, effective_at, retrieved_at, sensitivity, envelope_json
    FROM connector_records
    WHERE date = ? AND kind IN ('repository_activity', 'issue_activity', 'meeting_record') AND tombstoned_at IS NULL
  `).all(date) as Array<{
    id: string
    connector_id: string
    source_record_id: string
    kind: string
    entity_id: string | null
    effective_at: number | null
    retrieved_at: number
    sensitivity: 'standard' | 'personal' | 'high'
    envelope_json: string
  }>
  const records: PendingRecord[] = []
  for (const row of rows) {
    let envelope: ConnectedActivityEnvelope
    try {
      envelope = JSON.parse(row.envelope_json) as ConnectedActivityEnvelope
    } catch {
      continue
    }
    const entity = envelope.entity
    if (!entity) continue
    const startMs = row.effective_at ?? row.retrieved_at
    if (startsInsideSpans(startMs, ignoredSpans)) continue

    let statement: string
    let exactText: string
    let title: string
    if (row.kind === 'repository_activity') {
      if (!entity.activity?.title || !entity.provider || !entity.repo) continue
      const provider = PROVIDER_DISPLAY_NAMES[entity.provider] ?? entity.provider
      const repoFullName = entity.owner ? `${entity.owner}/${entity.repo}` : entity.repo
      statement = connectedActivityStatement(provider, repoFullName, entity.activity)
      exactText = `${entity.activity.title} ${repoFullName}`
      title = entity.activity.title
    } else if (row.kind === 'issue_activity') {
      if (!entity.title || !entity.provider) continue
      const provider = PROVIDER_DISPLAY_NAMES[entity.provider] ?? entity.provider
      statement = connectedIssueStatement(provider, entity)
      exactText = [entity.title, entity.identifier, entity.project?.name, entity.team?.key]
        .filter(Boolean).join(' ')
      title = entity.title
    } else {
      // meeting_record: a meeting-notes source (only Granola today). The
      // record is CONTENT memory — what the notes say — next to the meeting
      // entity the note attached to.
      if (row.connector_id !== 'granola' || !entity.title) continue
      const actionItems = envelope.notesSignal?.actionItems ?? []
      statement = connectedNotesStatement(entity.title, actionItems)
      exactText = [entity.title, ...actionItems].join(' ')
      title = entity.title
    }

    const entityIds = new Set<string>()
    if (row.entity_id) {
      const primaryId = activeEntityId(db, row.entity_id)
      if (primaryId) entityIds.add(primaryId)
    }
    for (const person of entity.people ?? entity.participants ?? []) {
      if (!person.connectorId) continue
      const personRow = db.prepare(
        `SELECT * FROM entities WHERE entity_type = 'person' AND identity_key = ?`,
      ).get(`connector:${person.connectorId}`) as EntityRow | undefined
      if (!personRow) continue
      const personId = activeEntityId(db, personRow.id)
      if (personId) entityIds.add(personId)
    }

    records.push({
      id: newRecordId(),
      kind: 'connected_activity',
      memoryType: 'connected',
      statement,
      exactText,
      startMs,
      endMs: startMs,
      appBundleId: null,
      appName: null,
      title,
      primaryEntityId: null,
      sourceRefs: [`connector:${row.connector_id}:${row.source_record_id}`],
      entityIds,
      sensitivity: row.sensitivity,
    })
  }
  return records
}

// ─── Index maintenance ───────────────────────────────────────────────────────

export interface IndexDayResult {
  date: string
  records: number
}

/** Rebuild one local day's records from the corrected facts, atomically. */
export function indexMemoryForDay(db: Database.Database, date: string): IndexDayResult {
  const [fromMs, toMs] = localDayBounds(date)
  const fingerprint = memoryIndexDayFingerprint(db, date)
  const ignoredSpans = getIgnoredBlockSpansForRange(db, fromMs, toMs)

  const records = sessionRecords(db, date, fromMs, toMs)
  applyAttributionTags(db, records, fromMs, toMs)
  records.push(...meetingRecords(db, fromMs, toMs, ignoredSpans))
  records.push(...artifactRecords(db, fromMs, toMs, ignoredSpans))
  records.push(...pageRecords(db, date, fromMs, toMs, ignoredSpans))
  records.push(...connectedActivityRecords(db, date, ignoredSpans))

  const insertRecord = db.prepare(`
    INSERT INTO memory_records (
      id, record_kind, memory_type, statement, exact_text, semantic_text,
      date, start_ms, end_ms, app_bundle_id, app_name, title, domain, url,
      primary_entity_id, source_refs_json, confidence, provenance,
      sensitivity, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertTag = db.prepare(`
    INSERT OR IGNORE INTO memory_record_entities (record_id, entity_id) VALUES (?, ?)
  `)

  const now = Date.now()
  const commit = db.transaction(() => {
    // Supplied facts are NOT part of the day projection — they exist by
    // explicit confirmation, not evidence (DEV-185) — so a day rebuild must
    // never touch them: neither wiping an active fact nor resurrecting a
    // deleted one.
    db.prepare(`DELETE FROM memory_records WHERE date = ? AND record_kind != 'supplied_fact'`).run(date)
    for (const record of records) {
      insertRecord.run(
        record.id,
        record.kind,
        record.memoryType,
        record.statement,
        record.exactText,
        // Semantic text is the minimized factual representation DEV-180 will
        // embed; written now so the semantic index can build without another
        // full projection pass.
        record.statement,
        date,
        record.startMs,
        record.endMs,
        record.appBundleId,
        record.appName,
        record.title,
        record.domain ?? null,
        record.url ?? null,
        record.primaryEntityId,
        JSON.stringify(record.sourceRefs),
        record.memoryType === 'connected' ? 'corroborated' : 'observed',
        record.kind === 'session' ? 'corrected_session'
          : record.kind === 'page' ? 'corrected_domain'
            : record.kind,
        record.sensitivity ?? 'standard',
        now,
      )
      for (const entityId of record.entityIds) insertTag.run(record.id, entityId)
    }
    db.prepare(`
      INSERT INTO memory_index_days (date, fingerprint, indexed_at, record_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        indexed_at = excluded.indexed_at,
        record_count = excluded.record_count
    `).run(date, fingerprint, now, records.length)
  })
  commit()
  return { date, records: records.length }
}

/** Index the day only when its inputs changed. Cheap when current. */
export function ensureDayMemoryIndexed(db: Database.Database, date: string): boolean {
  if (!memoryIndexAvailable(db)) return false
  const stored = db.prepare(`SELECT fingerprint FROM memory_index_days WHERE date = ?`)
    .get(date) as { fingerprint: string } | undefined
  const current = memoryIndexDayFingerprint(db, date)
  if (stored?.fingerprint === current) return false
  indexMemoryForDay(db, date)
  return true
}

/** After a correction lands or is undone: refresh the affected day so the
 *  correction reaches search immediately. A day that was never indexed is left
 *  for the backfill — its legacy query path applies the correction filters at
 *  query time. */
export function refreshMemoryIndexForDay(db: Database.Database, date: string): void {
  try {
    if (!memoryIndexAvailable(db)) return
    const indexed = db.prepare(`SELECT 1 FROM memory_index_days WHERE date = ?`).get(date)
    if (!indexed && date !== localDateString()) return
    indexMemoryForDay(db, date)
  } catch (error) {
    console.error('[memoryIndex] day refresh failed', date, error)
  }
}

/** Dates with any capture evidence, newest first. */
export function listMemoryIndexCandidateDates(db: Database.Database, limit: number): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT date FROM (
      SELECT DISTINCT strftime('%Y-%m-%d', start_time / 1000, 'unixepoch', 'localtime') AS date FROM app_sessions
      UNION
      SELECT DISTINCT strftime('%Y-%m-%d', ts_ms / 1000, 'unixepoch', 'localtime') AS date FROM focus_events
    )
    WHERE date IS NOT NULL
    ORDER BY date DESC
    LIMIT ?
  `).all(limit) as Array<{ date: string }>
  return rows.map((row) => row.date)
}

export interface BackfillProgress {
  scanned: number
  indexed: number
  done: boolean
}

/** One bounded backfill step: ensure up to `daysPerStep` stale days, newest
 *  first. Already-indexed historical days are skipped without re-computing
 *  their fingerprint — corrections refresh their day synchronously and the
 *  most recent days are always fingerprint-checked, so the steady-state step
 *  is a handful of indexed lookups. Returns done=true when current. */
export function memoryIndexBackfillStep(
  db: Database.Database,
  options: { maxDays?: number; daysPerStep?: number; recentDaysAlwaysChecked?: number } = {},
): BackfillProgress {
  if (!memoryIndexAvailable(db)) return { scanned: 0, indexed: 0, done: true }
  const maxDays = options.maxDays ?? 730
  const daysPerStep = options.daysPerStep ?? 5
  const recentDaysAlwaysChecked = options.recentDaysAlwaysChecked ?? 3
  const candidates = listMemoryIndexCandidateDates(db, maxDays)
  const alreadyIndexed = new Set(
    (db.prepare(`SELECT date FROM memory_index_days`).all() as Array<{ date: string }>)
      .map((row) => row.date),
  )
  let scanned = 0
  let indexed = 0
  for (const [position, date] of candidates.entries()) {
    if (position >= recentDaysAlwaysChecked && alreadyIndexed.has(date)) continue
    scanned += 1
    if (ensureDayMemoryIndexed(db, date)) {
      indexed += 1
      if (indexed >= daysPerStep) return { scanned, indexed, done: false }
    }
  }
  return { scanned, indexed, done: true }
}

let backfillTimer: ReturnType<typeof setTimeout> | null = null

/** Background backfill: a few days per tick so the main process stays
 *  responsive; stops when the index is current. Safe to call repeatedly. */
export function startMemoryIndexBackfill(
  getDatabase: () => Database.Database,
  options: { maxDays?: number; stepDelayMs?: number } = {},
): void {
  if (backfillTimer) return
  const stepDelayMs = options.stepDelayMs ?? 500
  const step = (): void => {
    backfillTimer = null
    let progress: BackfillProgress
    try {
      progress = memoryIndexBackfillStep(getDatabase(), { maxDays: options.maxDays })
    } catch (error) {
      console.error('[memoryIndex] backfill step failed', error)
      return
    }
    if (!progress.done) backfillTimer = setTimeout(step, stepDelayMs)
  }
  backfillTimer = setTimeout(step, stepDelayMs)
}

export function stopMemoryIndexBackfill(): void {
  if (backfillTimer) {
    clearTimeout(backfillTimer)
    backfillTimer = null
  }
}
