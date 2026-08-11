// Entity adoption (memory-and-entities.md migration slice 3 + Wave-2 evidence
// sources, DEV-177).
//
// Adopts what the product already knows into the durable entity store, KEEPING
// existing identifiers so attributions, corrections, and references stay
// valid:
//
//   - clients / projects        → client / project entities (same id)
//   - app_identities            → application entities (id = first-seen
//                                 app_instance_id per canonical app)
//   - artifacts                 → page / file / repository entities (same id)
//   - external_signals calendar → meeting entities keyed by their source event
//                                 identity (date + start + exact title from
//                                 the stored payload — two events with similar
//                                 titles/times never merge)
//   - external_signals notes    → meeting entities from meeting-notes payloads
//   - external_signals git      → repository entities (provisional local
//                                 identity — provider identity arrives with
//                                 the Wave-3 connectors)
//
// The whole backfill is idempotent: identity keys dedupe re-runs, and an
// explicit user rename (name_source='user') is never overwritten by a re-run —
// that is the "correction outranks later inference" acceptance criterion.
//
// Person entities are NOT minted from meeting-notes first names: people
// resolve by connector id first, and none of the currently adopted sources
// carries one. Fixtures exercise people through the synthetic connected-source
// envelopes below.
import type Database from 'better-sqlite3'
import type {
  CalendarSignal,
  GitActivitySignal,
  MeetingNotesSignal,
} from '@shared/types'
import {
  addEntityAlias,
  addEntityEvidenceRef,
  addEntityRelationship,
  resolveApplicationEntity,
  resolveMeetingEntity,
  resolveMergeChain,
  resolvePageEntity,
  resolvePersonEntity,
  resolveProjectEntity,
  resolveRepositoryEntity,
  upsertEntity,
  normalizeEntityLabel,
  type EntityRow,
} from './entityRepository'

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) != null
}

function msForClock(dateStr: string, clock: string | null | undefined): number | null {
  if (!clock) return null
  const match = clock.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day, Number(match[1]), Number(match[2]), 0, 0).getTime()
}

// ─── Per-source adoption ─────────────────────────────────────────────────────

function adoptClients(db: Database.Database): void {
  const clients = db.prepare(`SELECT id, name, status, created_at, updated_at FROM clients`).all() as Array<{
    id: string; name: string; status: string; created_at: number; updated_at: number
  }>
  for (const client of clients) {
    ensureSuppliedClientEntity(db, {
      id: client.id,
      name: client.name,
      observedAt: client.created_at,
      aliases: (db.prepare(`SELECT alias, source FROM client_aliases WHERE client_id = ?`)
        .all(client.id) as Array<{ alias: string; source: string }>),
    })
  }
}

function adoptProjects(db: Database.Database): void {
  const projects = db.prepare(`SELECT id, client_id, name, created_at FROM projects`).all() as Array<{
    id: string; client_id: string | null; name: string; created_at: number
  }>
  for (const project of projects) {
    ensureSuppliedProjectEntity(db, {
      id: project.id,
      name: project.name,
      clientId: project.client_id,
      observedAt: project.created_at,
      aliases: (db.prepare(`SELECT alias, source FROM project_aliases WHERE project_id = ?`)
        .all(project.id) as Array<{ alias: string; source: string }>),
    })
  }
}

/** Create or update the supplied client entity in the same identity as the
 *  legacy clients row. Call inside the creation/update transaction. */
export function ensureSuppliedClientEntity(
  db: Database.Database,
  input: {
    id: string
    name: string
    observedAt?: number
    aliases?: Array<{ alias: string; source?: string }>
  },
): EntityRow {
  const entity = upsertEntity(db, {
    type: 'client',
    identityKey: `supplied:${input.id}`,
    name: input.name,
    origin: 'supplied',
    id: input.id,
    observedAt: input.observedAt ?? Date.now(),
  })
  addEntityAlias(db, entity.id, input.name, { rawLabel: input.name, source: 'user' })
  for (const alias of input.aliases ?? []) {
    addEntityAlias(db, entity.id, alias.alias, { rawLabel: alias.alias, source: alias.source ?? 'user' })
  }
  return entity
}

/** Create or update the supplied project entity and, when associated, the
 *  project→client belongs_to relationship (AC-SM-EA-001.3 / 001.4). */
export function ensureSuppliedProjectEntity(
  db: Database.Database,
  input: {
    id: string
    name: string
    clientId?: string | null
    observedAt?: number
    aliases?: Array<{ alias: string; source?: string }>
  },
): EntityRow {
  const entity = upsertEntity(db, {
    type: 'project',
    identityKey: `supplied:${input.id}`,
    name: input.name,
    origin: 'supplied',
    id: input.id,
    observedAt: input.observedAt ?? Date.now(),
  })
  addEntityAlias(db, entity.id, input.name, { rawLabel: input.name, source: 'user' })
  for (const alias of input.aliases ?? []) {
    addEntityAlias(db, entity.id, alias.alias, { rawLabel: alias.alias, source: alias.source ?? 'user' })
  }
  if (input.clientId && db.prepare(`SELECT 1 FROM entities WHERE id = ?`).get(input.clientId)) {
    addEntityRelationship(db, entity.id, input.clientId, 'belongs_to', {
      source: 'user',
      confidence: 1,
    })
  }
  return entity
}

/**
 * Live write-through for an app_identities observation (WO-30). Mirrors
 * adoptApplications so capture does not wait for backfill.
 */
export function adoptAppIdentityWrite(
  db: Database.Database,
  input: {
    appInstanceId: string
    canonicalAppId?: string | null
    displayName: string
    rawAppName?: string | null
    observedAt?: number
  },
): EntityRow {
  const entity = resolveApplicationEntity(db, {
    canonicalAppId: input.canonicalAppId,
    appInstanceId: input.appInstanceId,
    displayName: input.displayName,
    observedAt: input.observedAt,
    id: input.appInstanceId,
  })
  if (input.rawAppName?.trim()) {
    addEntityAlias(db, entity.id, input.rawAppName, {
      rawLabel: input.rawAppName,
      source: 'observed',
    })
  }
  addEntityEvidenceRef(db, entity.id, {
    sourceType: 'app_identity',
    sourceId: input.appInstanceId,
  })
  return entity
}

/**
 * Live write-through for an artifacts row (WO-30). Call after upsertArtifact
 * once the owning lane wires it — helpers live here so capture writers stay
 * thin.
 */
export function adoptArtifactWrite(
  db: Database.Database,
  input: {
    id: string
    artifactType: string
    canonicalKey: string
    displayTitle: string
    firstSeenAt?: number
    lastSeenAt?: number
  },
): EntityRow | null {
  const typeMap: Record<string, 'page' | 'file' | 'repository'> = {
    page: 'page',
    domain: 'page',
    document: 'file',
    repo: 'repository',
  }
  const entityType = typeMap[input.artifactType]
  if (!entityType) return null
  const identityKey = entityType === 'repository'
    ? `local:${normalizeEntityLabel(input.displayTitle)}`
    : `${entityType === 'page' ? 'page' : 'file'}:${input.canonicalKey}`
  const entity = upsertEntity(db, {
    type: entityType,
    identityKey,
    name: input.displayTitle,
    origin: 'observed',
    id: input.id,
    observedAt: input.firstSeenAt,
    metadata: entityType === 'repository' ? { provisionalLocalIdentity: true } : {},
  })
  if (input.lastSeenAt != null) {
    upsertEntity(db, {
      type: entityType,
      identityKey: entity.identity_key,
      name: input.displayTitle,
      origin: 'observed',
      observedAt: input.lastSeenAt,
    })
  }
  addEntityAlias(db, entity.id, input.displayTitle, {
    rawLabel: input.displayTitle,
    source: 'observed',
  })
  addEntityEvidenceRef(db, entity.id, { sourceType: 'artifact', sourceId: input.id })
  return entity
}

/**
 * Live write-through for a website visit host (WO-30). Mint/update a page
 * entity keyed by the normalized domain so connected browsing evidence has a
 * durable graph identity before consumers read it.
 */
export function adoptWebsiteVisitWrite(
  db: Database.Database,
  input: {
    domain: string
    title?: string | null
    visitId?: string | number | null
    observedAt?: number
  },
): EntityRow | null {
  const domain = input.domain.trim().toLowerCase()
  if (!domain) return null
  const name = input.title?.trim() || domain
  const entity = resolvePageEntity(db, {
    canonicalKey: `domain:${domain}`,
    title: name,
    observedAt: input.observedAt,
  })
  addEntityAlias(db, entity.id, domain, { rawLabel: domain, source: 'observed' })
  if (input.visitId != null) {
    addEntityEvidenceRef(db, entity.id, {
      sourceType: 'website_visit',
      sourceId: String(input.visitId),
      spanStartMs: input.observedAt ?? null,
      spanEndMs: input.observedAt ?? null,
    })
  }
  return entity
}

function adoptApplications(db: Database.Database): void {
  const identities = db.prepare(`
    SELECT app_instance_id, canonical_app_id, display_name, raw_app_name, first_seen_at, last_seen_at
    FROM app_identities
    ORDER BY first_seen_at ASC
  `).all() as Array<{
    app_instance_id: string
    canonical_app_id: string | null
    display_name: string
    raw_app_name: string
    first_seen_at: number
    last_seen_at: number
  }>
  for (const identity of identities) {
    const key = `app:${identity.canonical_app_id ?? identity.app_instance_id}`
    // First-seen id is kept as the entity id; a later identity row for the
    // same canonical app extends the observation range instead of colliding.
    const entity = upsertEntity(db, {
      type: 'application', identityKey: key, name: identity.display_name,
      origin: 'observed', id: identity.app_instance_id, observedAt: identity.first_seen_at,
    })
    upsertEntity(db, {
      type: 'application', identityKey: key, name: identity.display_name,
      origin: 'observed', observedAt: identity.last_seen_at,
    })
    addEntityAlias(db, entity.id, identity.display_name, { rawLabel: identity.raw_app_name, source: 'observed' })
    addEntityEvidenceRef(db, entity.id, { sourceType: 'app_identity', sourceId: identity.app_instance_id })
  }
}

function adoptArtifacts(db: Database.Database): void {
  if (!hasTable(db, 'artifacts')) return
  const typeMap: Record<string, 'page' | 'file' | 'repository'> = {
    page: 'page',
    domain: 'page',
    document: 'file',
    repo: 'repository',
  }
  const artifacts = db.prepare(`
    SELECT id, artifact_type, canonical_key, display_title, first_seen_at, last_seen_at
    FROM artifacts
  `).all() as Array<{
    id: string
    artifact_type: string
    canonical_key: string
    display_title: string
    first_seen_at: number
    last_seen_at: number
  }>
  for (const artifact of artifacts) {
    const entityType = typeMap[artifact.artifact_type]
    if (!entityType) continue
    const entity = upsertEntity(db, {
      type: entityType,
      identityKey: entityType === 'repository'
        ? `local:${normalizeEntityLabel(artifact.display_title)}`
        : `${entityType === 'page' ? 'page' : 'file'}:${artifact.canonical_key}`,
      name: artifact.display_title,
      origin: 'observed',
      id: artifact.id,
      observedAt: artifact.first_seen_at,
      metadata: entityType === 'repository' ? { provisionalLocalIdentity: true } : {},
    })
    upsertEntity(db, {
      type: entityType,
      identityKey: entity.identity_key,
      name: artifact.display_title,
      origin: 'observed',
      observedAt: artifact.last_seen_at,
    })
    addEntityAlias(db, entity.id, artifact.display_title, { rawLabel: artifact.display_title, source: 'observed' })
    addEntityEvidenceRef(db, entity.id, { sourceType: 'artifact', sourceId: artifact.id })
  }
}

/** Deterministic source event identity for a stored calendar payload row.
 *  The local calendar source has no opaque event id; the (date, start clock,
 *  exact title) triple IS its source identity. Two events whose titles differ
 *  at all — however similar — get different identities and never merge. */
export function calendarEventSourceId(date: string, startClock: string, title: string): string {
  return `calendar:${date}:${startClock}:${title}`
}

export function adoptExternalSignalEntities(
  db: Database.Database,
  date: string,
  source: string,
  payload: unknown,
): void {
  if (source === 'calendar') {
    const calendar = payload as CalendarSignal | null
    for (const event of calendar?.events ?? []) {
      if (!event?.title) continue
      const startMs = msForClock(date, event.startClock)
      const endMs = startMs != null && event.durationMinutes
        ? startMs + event.durationMinutes * 60_000
        : null
      resolveMeetingEntity(db, {
        sourceEventId: calendarEventSourceId(date, event.startClock, event.title),
        title: event.title,
        startMs,
        endMs,
        origin: 'connected',
        sourceType: 'external_signal',
        sourceId: `${date}:calendar`,
      })
    }
    return
  }
  if (source === 'notes') {
    const notes = payload as MeetingNotesSignal | null
    for (const note of notes?.notes ?? []) {
      if (!note?.title) continue
      const clock = note.scheduledClock ?? null
      const startMs = clock ? msForClock(date, clock) : null
      resolveMeetingEntity(db, {
        sourceEventId: `notes:${date}:${clock ?? ''}:${note.title}`,
        title: note.title,
        startMs,
        origin: 'connected',
        sourceType: 'external_signal',
        sourceId: `${date}:notes`,
      })
      // Participant first names are NOT connector ids, so they never mint
      // person entities here (spec: people use connector identifiers first).
    }
    return
  }
  if (source === 'git') {
    const git = payload as GitActivitySignal | null
    for (const repo of git?.repos ?? []) {
      if (!repo?.repo) continue
      const entity = resolveRepositoryEntity(db, {
        localName: repo.repo,
        origin: 'connected',
        observedAt: msForClock(date, repo.lastCommitClock) ?? undefined,
      })
      if (entity) {
        addEntityEvidenceRef(db, entity.id, { sourceType: 'external_signal', sourceId: `${date}:git` })
      }
    }
  }
}

function adoptExternalSignals(db: Database.Database): void {
  if (!hasTable(db, 'external_signals')) return
  const rows = db.prepare(`SELECT date, source, payload_json FROM external_signals`).all() as Array<{
    date: string; source: string; payload_json: string
  }>
  for (const row of rows) {
    try {
      adoptExternalSignalEntities(db, row.date, row.source, JSON.parse(row.payload_json))
    } catch {
      // A malformed stored payload never blocks adoption of the rest.
    }
  }
}

// ─── Synthetic connected-source envelopes — provisional payload shapes owned
// by the memory spec; acceptance fixtures inject these until the connectors
// specification is accepted. ──────

export type ConnectedEnvelope =
  | { kind: 'calendar_event'; sourceEventId: string; title: string; startMs?: number; endMs?: number; attendees?: Array<{ connectorId: string; displayName: string }> }
  | {
    kind: 'meeting_record'
    sourceEventId: string
    title: string
    startMs?: number
    endMs?: number
    participants?: Array<{ connectorId: string; displayName: string }>
    /** Source-native ids of the calendar event this record documents, when
     *  the source carries the link — the strongest attachment corroboration. */
    linkedCalendarEventIds?: string[]
  }
  | {
    kind: 'repository_activity'
    provider: string
    owner: string
    repo: string
    observedAt?: number
    /** What happened, minimally: activity kind, title (a commit subject or
     *  PR/issue title — never a body, diff, or URL), and provider state. */
    activity?: {
      kind: 'commit' | 'pull_request' | 'review' | 'issue'
      title: string
      state?: string | null
      /** Source-native login of who did it, when it was not the account owner. */
      actorLogin?: string | null
    }
    /** People involved OTHER than the account owner, by source-native login. */
    people?: Array<{ connectorId: string; displayName: string }>
  }
  | {
    kind: 'issue_activity'
    provider: string
    /** Workspace / organization identity label (a Linear org url key). */
    workspace: string | null
    /** Opaque source-native issue identity. */
    sourceIssueId: string
    /** Human issue identifier ("DAY-12"). */
    identifier: string
    title: string
    /** Provider state name and state category ("In Progress" / "started"). */
    state?: string | null
    stateType?: string | null
    team?: { key: string; name: string } | null
    /** The provider project this issue belongs to, by source-native identity. */
    project?: { sourceProjectId: string; name: string } | null
    /** The cycle the issue sits in — evidence fields, not an entity. */
    cycle?: { number: number; name?: string | null } | null
    observedAt?: number
    /** People involved OTHER than the account owner, by source-native id. */
    people?: Array<{ connectorId: string; displayName: string }>
  }
  | { kind: 'document_reference'; sourceDocumentId: string; title: string; observedAt?: number }
  | { kind: 'message_reference'; sourceMessageId: string; author?: { connectorId: string; displayName: string }; observedAt?: number }

export function adoptConnectedEnvelope(db: Database.Database, envelope: ConnectedEnvelope): EntityRow | null {
  switch (envelope.kind) {
    case 'calendar_event':
    case 'meeting_record': {
      const meeting = resolveMeetingEntity(db, {
        sourceEventId: envelope.sourceEventId,
        title: envelope.title,
        startMs: envelope.startMs ?? null,
        endMs: envelope.endMs ?? null,
        origin: 'connected',
        sourceType: 'connected_envelope',
        sourceId: `${envelope.kind}:${envelope.sourceEventId}`,
      })
      const people = envelope.kind === 'calendar_event' ? envelope.attendees : envelope.participants
      for (const person of people ?? []) {
        const entity = resolvePersonEntity(db, {
          connectorId: person.connectorId,
          displayName: person.displayName,
          observedAt: envelope.startMs,
        })
        if (entity) addEntityRelationship(db, entity.id, meeting.id, 'attended', { source: 'connected', confidence: 0.9 })
      }
      return meeting
    }
    case 'repository_activity': {
      const repository = resolveRepositoryEntity(db, {
        provider: envelope.provider,
        owner: envelope.owner,
        repo: envelope.repo,
        origin: 'connected',
        observedAt: envelope.observedAt,
      })
      for (const person of envelope.people ?? []) {
        const entity = resolvePersonEntity(db, {
          connectorId: person.connectorId,
          displayName: person.displayName,
          observedAt: envelope.observedAt,
        })
        if (entity && repository) {
          addEntityRelationship(db, entity.id, repository.id, 'contributed', { source: 'connected', confidence: 0.9 })
        }
      }
      return repository
    }
    case 'issue_activity': {
      // The issue's PROJECT is the durable entity, resolved by provider
      // identity — a renamed project stays one thing; a same-named supplied
      // project stays separate (suggestion, not silent equivalence). An issue
      // without a project contributes no entity; its record still becomes
      // searchable connected memory through the ledger projection.
      const project = envelope.project
        ? resolveProjectEntity(db, {
          provider: envelope.provider,
          sourceProjectId: envelope.project.sourceProjectId,
          name: envelope.project.name,
          origin: 'connected',
          observedAt: envelope.observedAt,
        })
        : null
      for (const person of envelope.people ?? []) {
        const entity = resolvePersonEntity(db, {
          connectorId: person.connectorId,
          displayName: person.displayName,
          observedAt: envelope.observedAt,
        })
        if (entity && project) {
          addEntityRelationship(db, entity.id, project.id, 'contributed', { source: 'connected', confidence: 0.9 })
        }
      }
      return project
    }
    case 'document_reference': {
      const entity = upsertEntity(db, {
        type: 'file',
        identityKey: `document:${envelope.sourceDocumentId}`,
        name: envelope.title,
        origin: 'connected',
        observedAt: envelope.observedAt,
      })
      addEntityAlias(db, entity.id, envelope.title, { rawLabel: envelope.title, source: 'connected' })
      addEntityEvidenceRef(db, entity.id, { sourceType: 'connected_envelope', sourceId: `document_reference:${envelope.sourceDocumentId}` })
      return entity
    }
    case 'message_reference': {
      if (!envelope.author) return null
      return resolvePersonEntity(db, {
        connectorId: envelope.author.connectorId,
        displayName: envelope.author.displayName,
        observedAt: envelope.observedAt,
      })
    }
  }
}

// ─── Local ↔ provider repository identity unification ───────────────────────
// memory-and-entities/connectors §Entity resolution: source-native identity
// outranks display-name similarity, and cross-source matches need
// CORROBORATION. A provisional local-git repository entity merges into the
// provider-keyed one (the survivor keeps provider identity) ONLY when
//   1. the identity keys agree exactly (local:<normalized short name>),
//   2. the local git probe observed that repository on the commit's local day
//      (an external_signal <date>:git evidence ref on the local entity), and
//   3. that day's stored git signal lists the commit's exact subject line
//      under the same repository name.
// A same-name pair WITHOUT that corroboration stays two entities — visible in
// the merge suggestions, decided by a person, never auto-merged. The merge is
// the same reversible pointer flip Settings uses (aliases and evidence refs
// stay on their rows), and a user rename on the local entity blocks the
// automatic merge entirely (corrections outrank inference).

export interface RepositoryUnificationInput {
  providerEntityId: string
  repoShortName: string
  commitSubject: string
  /** Local date of the commit — the day whose git signal must corroborate. */
  date: string
}

export function unifyRepositoryEntityIdentity(
  db: Database.Database,
  input: RepositoryUnificationInput,
): boolean {
  const localKey = `local:${normalizeEntityLabel(input.repoShortName)}`
  const localRow = db.prepare(
    `SELECT * FROM entities WHERE entity_type = 'repository' AND identity_key = ?`,
  ).get(localKey) as EntityRow | undefined
  if (!localRow) return false
  const local = resolveMergeChain(db, localRow)
  if (local.status !== 'active' || local.id === input.providerEntityId) return false
  if (local.name_source === 'user') return false

  const observedLocally = db.prepare(`
    SELECT 1 FROM entity_evidence_refs
    WHERE entity_id = ? AND source_type = 'external_signal' AND source_id = ?
  `).get(local.id, `${input.date}:git`) != null
  if (!observedLocally) return false

  // Read the day row directly (the externalSignals service imports THIS
  // module for adoption, so it cannot be imported back).
  const signalRow = db.prepare(
    `SELECT payload_json FROM external_signals WHERE date = ? AND source = 'git'`,
  ).get(input.date) as { payload_json: string } | undefined
  if (!signalRow) return false
  let payload: GitActivitySignal | null = null
  try {
    payload = JSON.parse(signalRow.payload_json) as GitActivitySignal
  } catch {
    return false
  }
  const repoEntry = payload?.repos?.find((repo) => repo.repo === input.repoShortName)
  if (!repoEntry?.messages?.includes(input.commitSubject)) return false

  const now = Date.now()
  db.prepare(`UPDATE entities SET status = 'merged', merged_into_id = ?, updated_at = ? WHERE id = ?`)
    .run(input.providerEntityId, now, local.id)
  db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now, input.providerEntityId)
  addEntityAlias(db, input.providerEntityId, local.canonical_name, {
    rawLabel: local.canonical_name,
    source: 'connected',
  })
  return true
}

// ─── Meeting-note ↔ scheduled-meeting identity unification ──────────────────
// connectors.md §Entity resolution + §Granola: a meeting-notes record (a
// Granola note) attaches to the calendar meeting it documents ONLY with
// corroboration beyond display-name similarity. The note's meeting entity
// merges into the scheduled meeting's entity (the calendar identity survives;
// the note becomes its occurrence evidence) when at least TWO of the three
// signals agree — exact normalized title, start timing within tolerance, or a
// shared attendee address. A title-only match stays two entities: visible in
// the merge suggestions, decided by a person, never auto-merged. The merge is
// the same reversible pointer flip Settings uses, and a user rename on the
// note's entity blocks it entirely (corrections outrank inference).

export interface MeetingNoteUnificationInput {
  noteEntityId: string
  title: string
  startMs: number | null
  /** Local date of the note's meeting — the day whose scheduled events are candidates. */
  date: string
  /** Participant addresses the note carries, for cross-source corroboration. */
  participantEmails: string[]
  /** Source-native calendar event ids the note links to — an exact identity
   *  match attaches directly (source identity outranks everything else). */
  linkedCalendarEventIds?: string[]
}

const NOTE_MATCH_TOLERANCE_MS = 20 * 60 * 1000

/** Both day-layer clock dialects: 24-hour "14:30" and 12-hour "2:30pm". */
function clockToMs(date: string, clock: string): number | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(clock)
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2] ?? '0')
  const meridiem = match[3]?.toLowerCase() ?? null
  if (minute > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  } else if (hour > 23) {
    return null
  }
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

interface ScheduledMeetingCandidate {
  entityId: string
  startMs: number | null
  normalizedTitle: string
  emails: Set<string>
}

function scheduledMeetingCandidates(db: Database.Database, date: string): ScheduledMeetingCandidate[] {
  const candidates: ScheduledMeetingCandidate[] = []
  if (hasTable(db, 'connector_records')) {
    const rows = db.prepare(`
      SELECT entity_id, envelope_json FROM connector_records
      WHERE date = ? AND kind = 'calendar_event' AND tombstoned_at IS NULL
    `).all(date) as Array<{ entity_id: string | null; envelope_json: string }>
    for (const row of rows) {
      if (!row.entity_id) continue
      try {
        const envelope = JSON.parse(row.envelope_json) as {
          entity?: {
            title?: unknown
            startMs?: unknown
            attendees?: Array<{ connectorId?: unknown }>
          }
        }
        const title = typeof envelope.entity?.title === 'string' ? envelope.entity.title : null
        if (!title) continue
        const emails = new Set<string>()
        for (const attendee of envelope.entity?.attendees ?? []) {
          if (typeof attendee.connectorId !== 'string') continue
          const address = attendee.connectorId.split(':').slice(1).join(':').toLowerCase()
          if (address.includes('@')) emails.add(address)
        }
        candidates.push({
          entityId: row.entity_id,
          startMs: typeof envelope.entity?.startMs === 'number' ? envelope.entity.startMs : null,
          normalizedTitle: normalizeEntityLabel(title),
          emails,
        })
      } catch { /* one unreadable envelope never hides the rest */ }
    }
  }
  // The local calendar probe's meeting entities encode (date, clock, title)
  // in their identity key: event:calendar:<date>:<clock>:<title>.
  const prefix = `event:calendar:${date}:`
  const localRows = db.prepare(
    `SELECT id, identity_key FROM entities WHERE entity_type = 'meeting' AND identity_key LIKE ?`,
  ).all(`${prefix}%`) as Array<{ id: string; identity_key: string }>
  for (const row of localRows) {
    const rest = row.identity_key.slice(prefix.length)
    // The clock may itself contain a colon ("10:00" / "2:30pm"), so it is
    // matched as a clock, not split at the first separator.
    const match = /^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?):(.+)$/i.exec(rest)
    if (!match) continue
    const clock = match[1]
    const title = match[2]
    candidates.push({
      entityId: row.id,
      startMs: clockToMs(date, clock),
      normalizedTitle: normalizeEntityLabel(title),
      emails: new Set(),
    })
  }
  return candidates
}

function mergeNoteIntoMeeting(db: Database.Database, note: EntityRow, survivorId: string): void {
  const now = Date.now()
  db.prepare(`UPDATE entities SET status = 'merged', merged_into_id = ?, updated_at = ? WHERE id = ?`)
    .run(survivorId, now, note.id)
  db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now, survivorId)
  addEntityAlias(db, survivorId, note.canonical_name, {
    rawLabel: note.canonical_name,
    source: 'connected',
  })
}

export function unifyMeetingNoteIdentity(
  db: Database.Database,
  input: MeetingNoteUnificationInput,
): boolean {
  const noteRow = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(input.noteEntityId) as EntityRow | undefined
  if (!noteRow) return false
  const note = resolveMergeChain(db, noteRow)
  if (note.status !== 'active') return false
  if (note.name_source === 'user') return false

  // Source identity first: the note links the calendar event it documents,
  // and the calendar connectors key their meeting entities by that same
  // source-native id — an exact match needs no further corroboration.
  for (const linkedId of input.linkedCalendarEventIds ?? []) {
    if (!linkedId.trim()) continue
    for (const identityKey of [`event:gcal:${linkedId}`, `event:outlook:${linkedId}`]) {
      const linkedRow = db.prepare(
        `SELECT * FROM entities WHERE entity_type = 'meeting' AND identity_key = ?`,
      ).get(identityKey) as EntityRow | undefined
      if (!linkedRow) continue
      const survivor = resolveMergeChain(db, linkedRow)
      if (survivor.status !== 'active' || survivor.id === note.id) continue
      mergeNoteIntoMeeting(db, note, survivor.id)
      return true
    }
  }

  const noteTitle = normalizeEntityLabel(input.title)
  const noteEmails = new Set(input.participantEmails.map((address) => address.toLowerCase()))

  for (const candidate of scheduledMeetingCandidates(db, input.date)) {
    if (candidate.entityId === note.id) continue
    const candidateRow = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(candidate.entityId) as EntityRow | undefined
    if (!candidateRow) continue
    const survivor = resolveMergeChain(db, candidateRow)
    if (survivor.status !== 'active' || survivor.id === note.id) continue

    const titleAgrees = noteTitle.length > 0 && candidate.normalizedTitle === noteTitle
    const timingAgrees = input.startMs != null && candidate.startMs != null
      && Math.abs(input.startMs - candidate.startMs) <= NOTE_MATCH_TOLERANCE_MS
    const addressAgrees = noteEmails.size > 0
      && [...candidate.emails].some((address) => noteEmails.has(address))
    const agreements = Number(titleAgrees) + Number(timingAgrees) + Number(addressAgrees)
    if (agreements < 2) continue

    mergeNoteIntoMeeting(db, note, survivor.id)
    return true
  }
  return false
}

// ─── The backfill entrypoint (called by migration v50 and re-runnable) ───────

export function runEntityAdoptionBackfill(db: Database.Database): void {
  adoptClients(db)
  adoptProjects(db)
  adoptApplications(db)
  adoptArtifacts(db)
  adoptExternalSignals(db)
}
