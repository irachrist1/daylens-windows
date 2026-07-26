// Durable entity repository (memory-and-entities.md, DEV-177).
//
// One store for the things a day is about: applications, pages, files,
// people, meetings, repositories, projects, clients, timeline blocks, AI
// threads. Identity follows the per-type rules in the spec's §Identity rules:
//
//   - people resolve by connector identifier first; names/addresses are only
//     supporting aliases (no connector id → no person entity is minted),
//   - meetings resolve by source event identifier; similar titles and times
//     alone NEVER silently merge two events,
//   - repositories resolve by provider + repository identity when known, never
//     a folder name alone (a bare local folder is an explicitly-marked
//     provisional local identity),
//   - applications resolve by canonical app id / instance identity,
//   - pages resolve by canonical key (normalized URL + source),
//   - clients and projects are supplied records and keep their existing ids.
//
// Merges never rewrite aliases or evidence refs: the merged entity keeps its
// rows and points at the survivor through merged_into_id. Resolution follows
// the chain and unions the merge group, which makes every merge — automatic or
// explicit — trivially reversible (spec: "Automatic merges must be
// reversible"). An explicit rename sets name_source='user'; upsert may then
// never overwrite canonical_name again (spec: "An explicit merge, split,
// rename, or type correction outranks later inference").
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type EntityType =
  | 'application'
  | 'page'
  | 'file'
  | 'person'
  | 'meeting'
  | 'repository'
  | 'project'
  | 'client'
  | 'timeline_block'
  | 'ai_thread'

export type EntityOrigin = 'observed' | 'connected' | 'supplied' | 'inferred'
export type EntitySensitivity = 'standard' | 'personal' | 'high'

export interface EntityRow {
  id: string
  entity_type: EntityType
  identity_key: string
  canonical_name: string
  name_source: 'inferred' | 'user'
  origin: EntityOrigin
  sensitivity: EntitySensitivity
  status: 'active' | 'merged' | 'deleted'
  merged_into_id: string | null
  first_observed_at: number | null
  last_observed_at: number | null
  metadata_json: string
  created_at: number
  updated_at: number
}

export interface EntityAliasRow {
  id: string
  entity_id: string
  alias: string
  alias_normalized: string
  raw_label: string | null
  source: string
  created_at: number
}

export interface EntityEvidenceRefRow {
  id: string
  entity_id: string
  source_type: string
  source_id: string
  span_start_ms: number | null
  span_end_ms: number | null
  created_at: number
}

export interface EntitySummary {
  id: string
  type: EntityType
  name: string
  nameSource: 'inferred' | 'user'
  origin: EntityOrigin
  sensitivity: EntitySensitivity
  status: 'active' | 'merged' | 'deleted'
  firstObservedAt: number | null
  lastObservedAt: number | null
  aliases: string[]
  evidenceCount: number
}

export function newEntityId(): string {
  return `ent_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export function normalizeEntityLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim()
}

// ─── Merge-chain resolution ──────────────────────────────────────────────────

/** Follow merged_into_id to the surviving entity. Cycle-safe. */
export function resolveMergeChain(db: Database.Database, entity: EntityRow): EntityRow {
  const seen = new Set<string>([entity.id])
  let current = entity
  while (current.status === 'merged' && current.merged_into_id) {
    const next = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(current.merged_into_id) as EntityRow | undefined
    if (!next || seen.has(next.id)) break
    seen.add(next.id)
    current = next
  }
  return current
}

/** Every entity id in the merge group whose survivor is `entityId` (including itself). */
export function mergeGroupIds(db: Database.Database, entityId: string): string[] {
  const ids = [entityId]
  const queue = [entityId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const merged = db.prepare(`SELECT id FROM entities WHERE merged_into_id = ? AND status = 'merged'`)
      .all(current) as Array<{ id: string }>
    for (const row of merged) {
      if (!ids.includes(row.id)) {
        ids.push(row.id)
        queue.push(row.id)
      }
    }
  }
  return ids
}

// ─── Core upsert (identity-key based) ─────────────────────────────────────────

export interface UpsertEntityInput {
  type: EntityType
  identityKey: string
  name: string
  origin: EntityOrigin
  /** Keep an existing identifier during adoption (clients/projects/apps/artifacts). */
  id?: string
  sensitivity?: EntitySensitivity
  observedAt?: number | null
  metadata?: Record<string, unknown>
}

/**
 * Resolve-or-create by (type, identity_key), following the merge chain to the
 * survivor. Updates observation times always; updates canonical_name ONLY when
 * name_source is still 'inferred' — an explicit user rename outranks every
 * later inference, including a full re-run of adoption over the same evidence.
 */
export function upsertEntity(db: Database.Database, input: UpsertEntityInput): EntityRow {
  const now = Date.now()
  const observedAt = input.observedAt ?? null
  const existing = db.prepare(`SELECT * FROM entities WHERE entity_type = ? AND identity_key = ?`)
    .get(input.type, input.identityKey) as EntityRow | undefined
  if (existing) {
    const survivor = resolveMergeChain(db, existing)
    const first = observedAt == null
      ? survivor.first_observed_at
      : Math.min(survivor.first_observed_at ?? observedAt, observedAt)
    const last = observedAt == null
      ? survivor.last_observed_at
      : Math.max(survivor.last_observed_at ?? observedAt, observedAt)
    const nextName = survivor.name_source === 'user' ? survivor.canonical_name : input.name
    db.prepare(`
      UPDATE entities
      SET canonical_name = ?, first_observed_at = ?, last_observed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nextName, first, last, now, survivor.id)
    return db.prepare(`SELECT * FROM entities WHERE id = ?`).get(survivor.id) as EntityRow
  }
  const id = input.id ?? newEntityId()
  db.prepare(`
    INSERT INTO entities (
      id, entity_type, identity_key, canonical_name, name_source, origin,
      sensitivity, status, merged_into_id, first_observed_at, last_observed_at,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'inferred', ?, ?, 'active', NULL, ?, ?, ?, ?, ?)
  `).run(
    id, input.type, input.identityKey, input.name, input.origin,
    input.sensitivity ?? 'standard', observedAt, observedAt,
    JSON.stringify(input.metadata ?? {}), now, now,
  )
  return db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow
}

export function addEntityAlias(
  db: Database.Database,
  entityId: string,
  alias: string,
  options: { rawLabel?: string | null; source?: string } = {},
): void {
  const trimmed = alias.trim()
  if (!trimmed) return
  db.prepare(`
    INSERT OR IGNORE INTO entity_aliases (id, entity_id, alias, alias_normalized, raw_label, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `enta_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    entityId,
    trimmed,
    normalizeEntityLabel(trimmed),
    options.rawLabel ?? trimmed,
    options.source ?? 'inferred',
    Date.now(),
  )
}

export function addEntityEvidenceRef(
  db: Database.Database,
  entityId: string,
  ref: { sourceType: string; sourceId: string; spanStartMs?: number | null; spanEndMs?: number | null },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO entity_evidence_refs (id, entity_id, source_type, source_id, span_start_ms, span_end_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `entr_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    entityId,
    ref.sourceType,
    ref.sourceId,
    ref.spanStartMs ?? null,
    ref.spanEndMs ?? null,
    Date.now(),
  )
}

export function addEntityRelationship(
  db: Database.Database,
  entityId: string,
  relatedEntityId: string,
  kind: string,
  options: { confidence?: number; source?: 'inferred' | 'user' | 'connected' } = {},
): void {
  db.prepare(`
    INSERT OR IGNORE INTO entity_relationships (id, entity_id, related_entity_id, kind, confidence, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `entl_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    entityId,
    relatedEntityId,
    kind,
    options.confidence ?? 0.5,
    options.source ?? 'inferred',
    Date.now(),
  )
}

// ─── Per-type resolvers (the spec's identity rules) ──────────────────────────

/** People resolve by connector id FIRST. Without one, no entity is minted —
 *  names alone are not identity (they become aliases once an id exists). */
export function resolvePersonEntity(
  db: Database.Database,
  input: { connectorId: string | null | undefined; displayName: string; origin?: EntityOrigin; observedAt?: number },
): EntityRow | null {
  const connectorId = input.connectorId?.trim()
  if (!connectorId) return null
  const entity = upsertEntity(db, {
    type: 'person',
    identityKey: `connector:${connectorId}`,
    name: input.displayName,
    origin: input.origin ?? 'connected',
    sensitivity: 'personal',
    observedAt: input.observedAt,
  })
  addEntityAlias(db, entity.id, input.displayName, { rawLabel: input.displayName, source: 'connected' })
  return entity
}

/** Meetings resolve by source event id. Two events with the same title and
 *  time but different source ids stay distinct entities — always. */
export function resolveMeetingEntity(
  db: Database.Database,
  input: {
    sourceEventId: string
    title: string
    startMs?: number | null
    endMs?: number | null
    origin?: EntityOrigin
    sourceType?: string
    sourceId?: string
  },
): EntityRow {
  const entity = upsertEntity(db, {
    type: 'meeting',
    identityKey: `event:${input.sourceEventId}`,
    name: input.title,
    origin: input.origin ?? 'connected',
    observedAt: input.startMs ?? undefined,
  })
  addEntityAlias(db, entity.id, input.title, { rawLabel: input.title, source: 'connected' })
  if (input.sourceType && input.sourceId) {
    addEntityEvidenceRef(db, entity.id, {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      spanStartMs: input.startMs ?? null,
      spanEndMs: input.endMs ?? null,
    })
  }
  return entity
}

/** Repositories resolve by provider + repository identity when known. A bare
 *  local folder gets an explicitly provisional `local:` identity, never a
 *  silent equivalence with a provider repo of the same folder name. */
export function resolveRepositoryEntity(
  db: Database.Database,
  input: {
    provider?: string | null
    owner?: string | null
    repo?: string | null
    localName?: string | null
    origin?: EntityOrigin
    observedAt?: number
  },
): EntityRow | null {
  let identityKey: string
  let name: string
  if (input.provider && input.repo) {
    identityKey = `provider:${input.provider.toLowerCase()}/${(input.owner ?? '').toLowerCase()}/${input.repo.toLowerCase()}`
    name = input.repo
  } else if (input.localName) {
    identityKey = `local:${normalizeEntityLabel(input.localName)}`
    name = input.localName
  } else {
    return null
  }
  const entity = upsertEntity(db, {
    type: 'repository',
    identityKey,
    name,
    origin: input.origin ?? 'connected',
    observedAt: input.observedAt,
    metadata: identityKey.startsWith('local:') ? { provisionalLocalIdentity: true } : {},
  })
  addEntityAlias(db, entity.id, name, { rawLabel: name, source: input.origin ?? 'connected' })
  return entity
}

/** Projects from a connected issue tracker resolve by provider + opaque
 *  source-native project identity — never by name, so a renamed Linear
 *  project stays one entity and a same-named supplied project stays separate
 *  (a merge suggestion a person decides, per the entity-resolution spec). */
export function resolveProjectEntity(
  db: Database.Database,
  input: {
    provider: string
    sourceProjectId: string
    name: string
    origin?: EntityOrigin
    observedAt?: number
  },
): EntityRow {
  const entity = upsertEntity(db, {
    type: 'project',
    identityKey: `provider:${input.provider.toLowerCase()}/${input.sourceProjectId}`,
    name: input.name,
    origin: input.origin ?? 'connected',
    observedAt: input.observedAt,
  })
  addEntityAlias(db, entity.id, input.name, { rawLabel: input.name, source: input.origin ?? 'connected' })
  return entity
}

export function resolveApplicationEntity(
  db: Database.Database,
  input: { canonicalAppId?: string | null; appInstanceId: string; displayName: string; observedAt?: number; id?: string },
): EntityRow {
  const entity = upsertEntity(db, {
    type: 'application',
    identityKey: `app:${input.canonicalAppId ?? input.appInstanceId}`,
    name: input.displayName,
    origin: 'observed',
    observedAt: input.observedAt,
    id: input.id,
  })
  addEntityAlias(db, entity.id, input.displayName, { rawLabel: input.displayName, source: 'observed' })
  return entity
}

export function resolvePageEntity(
  db: Database.Database,
  input: { canonicalKey: string; title: string; observedAt?: number; id?: string },
): EntityRow {
  // Page titles are attributes, not identity (spec) — identity is the
  // canonical key derived from the normalized URL + source.
  const entity = upsertEntity(db, {
    type: 'page',
    identityKey: `page:${input.canonicalKey}`,
    name: input.title,
    origin: 'observed',
    observedAt: input.observedAt,
    id: input.id,
  })
  addEntityAlias(db, entity.id, input.title, { rawLabel: input.title, source: 'observed' })
  return entity
}

// ─── Label resolution (alias-aware, merge-aware) ─────────────────────────────

export interface ResolveByLabelResult {
  entity: EntityRow | null
  matchedBy: 'canonical' | 'alias' | 'fuzzy' | null
  /** When the label is ambiguous, candidates instead of a silent pick. */
  candidates: EntityRow[]
}

/**
 * Resolve a free-text label to an entity of a type (or any type). Uncertainty
 * produces candidates, never a silent destructive merge (spec §Failure
 * behavior). Merged entities resolve to their survivor.
 */
export function resolveEntityByLabel(
  db: Database.Database,
  type: EntityType | null,
  label: string,
): ResolveByLabelResult {
  const normalized = normalizeEntityLabel(label)
  if (!normalized) return { entity: null, matchedBy: null, candidates: [] }
  const typeClause = type ? `AND e.entity_type = ?` : ''
  const typeParams = type ? [type] : []

  const surviving = (rows: EntityRow[]): EntityRow[] => {
    const map = new Map<string, EntityRow>()
    for (const row of rows) {
      const survivor = resolveMergeChain(db, row)
      if (survivor.status !== 'deleted') map.set(survivor.id, survivor)
    }
    return [...map.values()]
  }

  const canonical = surviving(db.prepare(`
    SELECT e.* FROM entities e
    WHERE LOWER(e.canonical_name) = ? ${typeClause}
  `).all(normalized, ...typeParams) as EntityRow[])
  if (canonical.length === 1) return { entity: canonical[0], matchedBy: 'canonical', candidates: canonical }
  if (canonical.length > 1) return { entity: null, matchedBy: 'canonical', candidates: canonical }

  const byAlias = surviving(db.prepare(`
    SELECT e.* FROM entities e
    JOIN entity_aliases a ON a.entity_id = e.id
    WHERE a.alias_normalized = ? ${typeClause}
  `).all(normalized, ...typeParams) as EntityRow[])
  if (byAlias.length === 1) return { entity: byAlias[0], matchedBy: 'alias', candidates: byAlias }
  if (byAlias.length > 1) return { entity: null, matchedBy: 'alias', candidates: byAlias }

  const fuzzy = surviving(db.prepare(`
    SELECT e.* FROM entities e
    WHERE LOWER(e.canonical_name) LIKE ? AND e.status = 'active' ${typeClause}
    ORDER BY LENGTH(e.canonical_name) ASC
    LIMIT 5
  `).all(`%${normalized}%`, ...typeParams) as EntityRow[])
  if (fuzzy.length === 1) return { entity: fuzzy[0], matchedBy: 'fuzzy', candidates: fuzzy }
  return { entity: null, matchedBy: fuzzy.length > 0 ? 'fuzzy' : null, candidates: fuzzy }
}

// ─── Listing / detail ────────────────────────────────────────────────────────

export function listEntities(
  db: Database.Database,
  options: { type?: EntityType | null; search?: string | null; limit?: number } = {},
): EntitySummary[] {
  const clauses = [`e.status = 'active'`]
  const params: unknown[] = []
  if (options.type) {
    clauses.push(`e.entity_type = ?`)
    params.push(options.type)
  }
  if (options.search?.trim()) {
    clauses.push(`(LOWER(e.canonical_name) LIKE ? OR e.id IN (
      SELECT entity_id FROM entity_aliases WHERE alias_normalized LIKE ?
    ))`)
    const needle = `%${normalizeEntityLabel(options.search)}%`
    params.push(needle, needle)
  }
  const rows = db.prepare(`
    SELECT e.* FROM entities e
    WHERE ${clauses.join(' AND ')}
    ORDER BY e.last_observed_at IS NULL, e.last_observed_at DESC, e.canonical_name ASC
    LIMIT ?
  `).all(...params, options.limit ?? 200) as EntityRow[]
  return summarizeEntitiesBatched(db, rows)
}

function entitySummary(db: Database.Database, row: EntityRow): EntitySummary {
  const groupIds = mergeGroupIds(db, row.id)
  const marks = groupIds.map(() => '?').join(', ')
  const aliases = (db.prepare(`
    SELECT DISTINCT alias FROM entity_aliases WHERE entity_id IN (${marks}) ORDER BY alias
  `).all(...groupIds) as Array<{ alias: string }>).map((a) => a.alias)
  const evidenceCount = (db.prepare(`
    SELECT COUNT(*) AS c FROM entity_evidence_refs WHERE entity_id IN (${marks})
  `).get(...groupIds) as { c: number }).c
  return {
    id: row.id,
    type: row.entity_type,
    name: row.canonical_name,
    nameSource: row.name_source,
    origin: row.origin,
    sensitivity: row.sensitivity,
    status: row.status,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    aliases: aliases.filter((alias) => normalizeEntityLabel(alias) !== normalizeEntityLabel(row.canonical_name)),
    evidenceCount,
  }
}

/** One aliases query + one evidence-count query for the whole page — not N+1. */
function summarizeEntitiesBatched(db: Database.Database, rows: EntityRow[]): EntitySummary[] {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const marks = ids.map(() => '?').join(', ')

  // Direct merge children only (one hop). Enough for list counts; detail still
  // walks the full chain via mergeGroupIds when you open an entity.
  const children = db.prepare(`
    SELECT id, merged_into_id AS parent_id FROM entities
    WHERE status = 'merged' AND merged_into_id IN (${marks})
  `).all(...ids) as Array<{ id: string; parent_id: string }>

  const groupIdsBySurvivor = new Map<string, string[]>()
  for (const id of ids) groupIdsBySurvivor.set(id, [id])
  for (const child of children) {
    groupIdsBySurvivor.get(child.parent_id)?.push(child.id)
  }
  const allGroupIds = [...new Set([...ids, ...children.map((child) => child.id)])]
  const allMarks = allGroupIds.map(() => '?').join(', ')

  const aliasesByEntity = new Map<string, string[]>()
  for (const alias of db.prepare(`
    SELECT entity_id, alias FROM entity_aliases WHERE entity_id IN (${allMarks}) ORDER BY alias
  `).all(...allGroupIds) as Array<{ entity_id: string; alias: string }>) {
    const list = aliasesByEntity.get(alias.entity_id)
    if (list) list.push(alias.alias)
    else aliasesByEntity.set(alias.entity_id, [alias.alias])
  }

  const evidenceByEntity = new Map<string, number>()
  for (const row of db.prepare(`
    SELECT entity_id, COUNT(*) AS c FROM entity_evidence_refs
    WHERE entity_id IN (${allMarks}) GROUP BY entity_id
  `).all(...allGroupIds) as Array<{ entity_id: string; c: number }>) {
    evidenceByEntity.set(row.entity_id, row.c)
  }

  return rows.map((row) => {
    const groupIds = groupIdsBySurvivor.get(row.id) ?? [row.id]
    const aliasSet = new Set<string>()
    let evidenceCount = 0
    for (const groupId of groupIds) {
      for (const alias of aliasesByEntity.get(groupId) ?? []) aliasSet.add(alias)
      evidenceCount += evidenceByEntity.get(groupId) ?? 0
    }
    const canonical = normalizeEntityLabel(row.canonical_name)
    return {
      id: row.id,
      type: row.entity_type,
      name: row.canonical_name,
      nameSource: row.name_source,
      origin: row.origin,
      sensitivity: row.sensitivity,
      status: row.status,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      aliases: [...aliasSet].filter((alias) => normalizeEntityLabel(alias) !== canonical),
      evidenceCount,
    }
  })
}

export interface EntityDetail extends EntitySummary {
  aliasRows: EntityAliasRow[]
  evidenceRefs: EntityEvidenceRefRow[]
  related: Array<{ id: string; name: string; type: EntityType; kind: string; source: string }>
  mergedEntities: Array<{ id: string; name: string }>
}

export function getEntityDetail(db: Database.Database, entityId: string): EntityDetail | null {
  const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(entityId) as EntityRow | undefined
  if (!row) return null
  const survivor = resolveMergeChain(db, row)
  const groupIds = mergeGroupIds(db, survivor.id)
  const marks = groupIds.map(() => '?').join(', ')
  const aliasRows = db.prepare(`
    SELECT * FROM entity_aliases WHERE entity_id IN (${marks}) ORDER BY created_at ASC
  `).all(...groupIds) as EntityAliasRow[]
  const evidenceRefs = db.prepare(`
    SELECT * FROM entity_evidence_refs WHERE entity_id IN (${marks}) ORDER BY created_at ASC
  `).all(...groupIds) as EntityEvidenceRefRow[]
  const related = db.prepare(`
    SELECT r.kind, r.source, e.id, e.canonical_name AS name, e.entity_type AS type
    FROM entity_relationships r
    JOIN entities e ON e.id = r.related_entity_id
    WHERE r.entity_id IN (${marks})
  `).all(...groupIds) as Array<{ id: string; name: string; type: EntityType; kind: string; source: string }>
  const mergedEntities = db.prepare(`
    SELECT id, canonical_name AS name FROM entities WHERE merged_into_id = ? AND status = 'merged'
  `).all(survivor.id) as Array<{ id: string; name: string }>
  return { ...entitySummary(db, survivor), aliasRows, evidenceRefs, related, mergedEntities }
}

// ─── Suggested merges ────────────────────────────────────────────────────────

export interface SuggestedEntityMerge {
  type: EntityType
  leftId: string
  leftName: string
  rightId: string
  rightName: string
  reason: string
}

/** Low-confidence merge candidates stay SUGGESTED (spec): same-type active
 *  entities sharing a display name. Name matches catch the real duplicates
 *  users see (Canva/Canva, Traycer/Traycer). Never auto-applied. Meetings
 *  stay out — identity is the source event id.
 *
 *  A cluster of n same-name entities yields the n-1 pairs a person actually
 *  has to act on, anchored on one deterministic survivor — never the
 *  n*(n-1)/2 pair explosion a self-join emits (DEV-257: six Netflix rows
 *  produced fifteen pairs pointing at each other). The anchor is the entity
 *  a merge should keep: a user-renamed one first (explicit corrections
 *  outrank inference), then the most recently observed. The scan is one
 *  GROUP BY pass plus one small lookup per cluster, not the O(n²)
 *  entity/alias self-join that froze Settings on large stores.
 *
 *  `limit` is a transport guard for the Settings page, not a work cap: the
 *  default is high enough that the Needs-attention count tells the truth on
 *  any realistic store, and merge-all runs against the unlimited listing. */
export function listSuggestedEntityMerges(
  db: Database.Database,
  limit = 500,
): SuggestedEntityMerge[] {
  const clusters = db.prepare(`
    SELECT entity_type AS type, lower(canonical_name) AS name_key
    FROM entities
    WHERE status = 'active' AND entity_type != 'meeting'
    GROUP BY entity_type, lower(canonical_name)
    HAVING COUNT(*) > 1
    ORDER BY MAX(COALESCE(last_observed_at, 0)) DESC, name_key ASC
  `).all() as Array<{ type: EntityType; name_key: string }>

  const membersStmt = db.prepare(`
    SELECT id, canonical_name, name_source
    FROM entities
    WHERE status = 'active' AND entity_type = ? AND lower(canonical_name) = ?
    ORDER BY (name_source = 'user') DESC,
             last_observed_at IS NULL, last_observed_at DESC,
             id ASC
  `)

  const suggestions: SuggestedEntityMerge[] = []
  for (const cluster of clusters) {
    const members = membersStmt.all(cluster.type, cluster.name_key) as Array<{
      id: string
      canonical_name: string
      name_source: 'inferred' | 'user'
    }>
    const [anchor, ...duplicates] = members
    if (!anchor) continue
    for (const duplicate of duplicates) {
      if (suggestions.length >= limit) return suggestions
      suggestions.push({
        type: cluster.type,
        leftId: anchor.id,
        leftName: anchor.canonical_name,
        rightId: duplicate.id,
        rightName: duplicate.canonical_name,
        reason: 'Same name, likely the same thing twice',
      })
    }
  }
  return suggestions
}
