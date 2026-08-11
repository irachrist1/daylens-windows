// Entity corrections (memory-and-entities.md §Corrections and deletion,
// DEV-177) — rename, merge, split, and alias edits as correction commands in
// the EXISTING DEV-172 ledger (correction_undo_log), with the same three
// verbs:
//
//   previewEntityCorrection — merge uses cheap COUNTs (no savepoint); other
//                             kinds still apply inside a SQLite savepoint,
//                             read the result, and roll back.
//   applyEntityCorrection   — one transaction: snapshot the entity-ledger rows
//                             the command touches, apply, record the undo
//                             entry in correction_undo_log.
//   undo                    — via the shared undoCorrection() in
//                             correctionCommands.ts, which dispatches entity
//                             snapshots here (restoreEntityCorrectionSnapshot).
//
// A rename sets name_source='user', which upsertEntity treats as immovable —
// re-running adoption or any later inference can never overwrite it, and the
// row lives in the database, so it survives rebuild and restart. A merge only
// flips the merged entity's status/merged_into_id (aliases and evidence refs
// stay on their original rows), so a split or an undo restores the pre-merge
// world exactly.
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  addEntityAlias,
  getEntityDetail,
  listSuggestedEntityMerges,
  mergeGroupIds,
  resolveMergeChain,
  type EntityRow,
} from './entityRepository'
import { refreshEntitySearchTagsForMany } from './entitySearchTags'

export type EntityCorrectionCommand =
  | { kind: 'entity-rename'; entityId: string; name: string }
  | { kind: 'entity-merge'; targetId: string; sourceId: string }
  | { kind: 'entity-split'; entityId: string }
  | { kind: 'entity-add-alias'; entityId: string; alias: string }
  | { kind: 'entity-remove-alias'; entityId: string; aliasId: string }

export interface EntityCorrectionPreview {
  description: string
  /** The surviving entity after the correction. */
  entity: { id: string; name: string; aliases: string[]; evidenceCount: number } | null
  surfaces: string[]
}

export interface EntityCorrectionApplyResult {
  correctionId: string
  description: string
}

interface EntityLedgerSnapshot {
  /** Discriminator so the shared undo path can dispatch. */
  entityCorrection: true
  entities: EntityRow[]
  aliases: Array<Record<string, unknown>>
}

function localDateString(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function entityById(db: Database.Database, id: string): EntityRow {
  const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow | undefined
  if (!row) throw new Error('That entity no longer exists — refresh and try again.')
  return row
}

function affectedEntityIds(command: EntityCorrectionCommand): string[] {
  switch (command.kind) {
    case 'entity-rename':
    case 'entity-add-alias':
    case 'entity-remove-alias':
    case 'entity-split':
      return [command.entityId]
    case 'entity-merge':
      return [command.targetId, command.sourceId]
  }
}

function describeEntityCommand(db: Database.Database, command: EntityCorrectionCommand): string {
  switch (command.kind) {
    case 'entity-rename': {
      const entity = entityById(db, command.entityId)
      return `Rename "${entity.canonical_name}" to "${command.name.trim()}"`
    }
    case 'entity-merge': {
      const target = entityById(db, command.targetId)
      const source = entityById(db, command.sourceId)
      return `Merge "${source.canonical_name}" into "${target.canonical_name}"`
    }
    case 'entity-split': {
      const entity = entityById(db, command.entityId)
      const survivor = entity.merged_into_id ? entityById(db, entity.merged_into_id) : null
      return survivor
        ? `Split "${entity.canonical_name}" back out of "${survivor.canonical_name}"`
        : `Split "${entity.canonical_name}"`
    }
    case 'entity-add-alias': {
      const entity = entityById(db, command.entityId)
      return `Add the alias "${command.alias.trim()}" to "${entity.canonical_name}"`
    }
    case 'entity-remove-alias': {
      const entity = entityById(db, command.entityId)
      return `Remove an alias from "${entity.canonical_name}"`
    }
  }
}

function applyEntityCommand(db: Database.Database, command: EntityCorrectionCommand): void {
  const now = Date.now()
  switch (command.kind) {
    case 'entity-rename': {
      const name = command.name.trim()
      if (!name) throw new Error('A name is required.')
      const previous = entityById(db, command.entityId)
      // The old name stays resolvable as an alias — a rename never loses the
      // label that produced it (spec §Identity rules).
      addEntityAlias(db, command.entityId, previous.canonical_name, {
        rawLabel: previous.canonical_name,
        source: previous.name_source === 'user' ? 'user' : 'inferred',
      })
      // name_source='user' is the durable "outranks later inference" marker.
      db.prepare(`UPDATE entities SET canonical_name = ?, name_source = 'user', updated_at = ? WHERE id = ?`)
        .run(name, now, command.entityId)
      addEntityAlias(db, command.entityId, name, { rawLabel: name, source: 'user' })
      return
    }
    case 'entity-merge': {
      const target = resolveMergeChain(db, entityById(db, command.targetId))
      const source = resolveMergeChain(db, entityById(db, command.sourceId))
      if (target.id === source.id) throw new Error('Those are already the same entity.')
      if (target.entity_type !== source.entity_type) {
        throw new Error('Only entities of the same type can merge.')
      }
      // The merged entity keeps its aliases and evidence refs; only the
      // pointer changes. That is what makes the merge reversible.
      db.prepare(`UPDATE entities SET status = 'merged', merged_into_id = ?, updated_at = ? WHERE id = ?`)
        .run(target.id, now, source.id)
      db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now, target.id)
      return
    }
    case 'entity-split': {
      const entity = entityById(db, command.entityId)
      if (entity.status !== 'merged') throw new Error('That entity is not merged into anything.')
      db.prepare(`UPDATE entities SET status = 'active', merged_into_id = NULL, updated_at = ? WHERE id = ?`)
        .run(now, command.entityId)
      return
    }
    case 'entity-add-alias': {
      const alias = command.alias.trim()
      if (!alias) throw new Error('An alias is required.')
      addEntityAlias(db, command.entityId, alias, { rawLabel: alias, source: 'user' })
      return
    }
    case 'entity-remove-alias': {
      db.prepare(`DELETE FROM entity_aliases WHERE id = ? AND entity_id = ?`)
        .run(command.aliasId, command.entityId)
      return
    }
  }
}

function captureEntitySnapshot(db: Database.Database, command: EntityCorrectionCommand): EntityLedgerSnapshot {
  // Snapshot the full merge groups of every affected entity so undo restores
  // pointers, names, and aliases exactly as they were.
  const ids = new Set<string>()
  for (const id of affectedEntityIds(command)) {
    for (const member of mergeGroupIds(db, resolveMergeChain(db, entityById(db, id)).id)) ids.add(member)
    ids.add(id)
  }
  const marks = [...ids].map(() => '?').join(', ')
  const entities = db.prepare(`SELECT * FROM entities WHERE id IN (${marks})`).all(...ids) as EntityRow[]
  const aliases = db.prepare(`SELECT * FROM entity_aliases WHERE entity_id IN (${marks})`)
    .all(...ids) as Array<Record<string, unknown>>
  return { entityCorrection: true, entities, aliases }
}

export function isEntityCorrectionSnapshot(snapshot: unknown): snapshot is EntityLedgerSnapshot {
  return typeof snapshot === 'object' && snapshot != null
    && (snapshot as { entityCorrection?: unknown }).entityCorrection === true
}

/** Restore the snapshotted entity rows and their aliases. Called by the shared
 *  undoCorrection() in correctionCommands.ts inside its transaction. */
export function restoreEntityCorrectionSnapshot(db: Database.Database, snapshot: EntityLedgerSnapshot): void {
  for (const entity of snapshot.entities) {
    db.prepare(`
      UPDATE entities
      SET canonical_name = ?, name_source = ?, status = ?, merged_into_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      entity.canonical_name, entity.name_source, entity.status,
      entity.merged_into_id, Date.now(), entity.id,
    )
  }
  const entityIds = snapshot.entities.map((entity) => entity.id)
  if (entityIds.length > 0) {
    const marks = entityIds.map(() => '?').join(', ')
    db.prepare(`DELETE FROM entity_aliases WHERE entity_id IN (${marks})`).run(...entityIds)
    for (const alias of snapshot.aliases) {
      const columns = Object.keys(alias)
      db.prepare(`
        INSERT INTO entity_aliases (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
      `).run(...columns.map((column) => alias[column]))
    }
  }
}

export function previewEntityCorrection(
  db: Database.Database,
  command: EntityCorrectionCommand,
): EntityCorrectionPreview {
  const description = describeEntityCommand(db, command)

  // Merges are pointer updates — compute the union with COUNTs, no savepoint
  // and no loading every evidence row (that path froze Settings on Review).
  if (command.kind === 'entity-merge') {
    const target = resolveMergeChain(db, entityById(db, command.targetId))
    const source = resolveMergeChain(db, entityById(db, command.sourceId))
    if (target.id === source.id) throw new Error('Those are already the same entity.')
    if (target.entity_type !== source.entity_type) {
      throw new Error('Only entities of the same type can merge.')
    }
    const groupIds = [...new Set([...mergeGroupIds(db, target.id), ...mergeGroupIds(db, source.id)])]
    const marks = groupIds.map(() => '?').join(', ')
    const aliases = (db.prepare(`
      SELECT DISTINCT alias FROM entity_aliases WHERE entity_id IN (${marks}) ORDER BY alias
    `).all(...groupIds) as Array<{ alias: string }>).map((row) => row.alias)
    const evidenceCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM entity_evidence_refs WHERE entity_id IN (${marks})
    `).get(...groupIds) as { c: number }).c
    const displayAliases = aliases.filter(
      (alias) => alias.toLowerCase() !== target.canonical_name.toLowerCase(),
    )
    return {
      description,
      entity: {
        id: target.id,
        name: target.canonical_name,
        aliases: displayAliases,
        evidenceCount,
      },
      surfaces: [
        `Aliases carry over — "${target.canonical_name}" will answer to ${displayAliases.length} name${displayAliases.length === 1 ? '' : 's'}.`,
        `Evidence combines: ${evidenceCount} linked item${evidenceCount === 1 ? '' : 's'} back the merged entity.`,
        'Search, @-mentions, and AI answers resolve either name to the merged entity. Undo restores both.',
      ],
    }
  }

  db.exec('SAVEPOINT entity_correction_preview')
  try {
    applyEntityCommand(db, command)
    const detail = getEntityDetail(db, command.entityId)
    const surfaces: string[] = []
    if (command.kind === 'entity-rename' && detail) {
      surfaces.push(`Search and the AI will know this as "${detail.name}". The rename survives every rebuild — later inference can never overwrite it.`)
    }
    if (command.kind === 'entity-split') {
      surfaces.push('Both entities come back with their own aliases and evidence, exactly as before the merge.')
    }
    return {
      description,
      entity: detail
        ? { id: detail.id, name: detail.name, aliases: detail.aliases, evidenceCount: detail.evidenceCount }
        : null,
      surfaces,
    }
  } finally {
    db.exec('ROLLBACK TO entity_correction_preview')
    db.exec('RELEASE entity_correction_preview')
  }
}

export interface MergeAllDuplicatesResult {
  /** Merges that actually flipped a row. A pair whose sides already resolve
   *  to the same survivor is skipped, never counted (DEV-257). */
  merged: number
  /** Pairs that errored. Reported to the caller, never swallowed. */
  failed: number
  lastCorrectionId: string | null
  lastDescription: string | null
}

// One pass merges every current suggestion; further passes only exist to
// catch duplicates that surface as a consequence of merging. The bound keeps
// a pathological store from looping forever.
const MERGE_ALL_MAX_PASSES = 25

function unorderedPairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/** Merge every suggested duplicate, repeating until a pass merges nothing
 *  (fixpoint), so one press collapses the whole duplicate pile rather than a
 *  page-sized batch of it. Runs against the unlimited suggestion listing —
 *  the Settings display cap never bounds the work. `excludedPairs` carries
 *  the pairs a person dismissed as "Not the same"; those are never merged.
 *  Each merge records its own undo-log entry through applyEntityCorrection,
 *  so "Undo reverses the last one" keeps its single-merge meaning. */
export function mergeAllDuplicateEntities(
  db: Database.Database,
  options: { excludedPairs?: Array<{ leftId: string; rightId: string }> } = {},
): MergeAllDuplicatesResult {
  const excluded = new Set(
    (options.excludedPairs ?? []).map((pair) => unorderedPairKey(pair.leftId, pair.rightId)),
  )
  const failedPairs = new Set<string>()
  const result: MergeAllDuplicatesResult = {
    merged: 0,
    failed: 0,
    lastCorrectionId: null,
    lastDescription: null,
  }
  for (let pass = 0; pass < MERGE_ALL_MAX_PASSES; pass += 1) {
    const pairs = listSuggestedEntityMerges(db, Number.MAX_SAFE_INTEGER)
    let mergedThisPass = 0
    for (const pair of pairs) {
      const key = unorderedPairKey(pair.leftId, pair.rightId)
      if (excluded.has(key) || failedPairs.has(key)) continue
      try {
        const target = resolveMergeChain(db, entityById(db, pair.leftId))
        const source = resolveMergeChain(db, entityById(db, pair.rightId))
        // Already one entity (an earlier pair in this run, or an earlier
        // user merge). A retry is not a merge and must not count as one.
        if (target.id === source.id) continue
        const applied = applyEntityCorrection(db, {
          kind: 'entity-merge',
          targetId: target.id,
          sourceId: source.id,
        })
        result.merged += 1
        mergedThisPass += 1
        result.lastCorrectionId = applied.correctionId
        result.lastDescription = applied.description
      } catch (error) {
        console.error(
          `[entities] merge-all pair failed (${pair.leftName} <- ${pair.rightName}):`,
          error,
        )
        result.failed += 1
        failedPairs.add(key)
      }
    }
    if (mergedThisPass === 0) break
  }
  return result
}

export function applyEntityCorrection(
  db: Database.Database,
  command: EntityCorrectionCommand,
): EntityCorrectionApplyResult {
  const description = describeEntityCommand(db, command)
  const snapshot = captureEntitySnapshot(db, command)
  const correctionId = `corr_${randomUUID().replace(/-/g, '').slice(0, 18)}`
  const commit = db.transaction(() => {
    applyEntityCommand(db, command)
    db.prepare(`
      INSERT INTO correction_undo_log (id, date, kind, description, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(correctionId, localDateString(), command.kind, description, JSON.stringify(snapshot), Date.now())
  })
  commit()
  refreshEntitySearchTagsForMany(db, affectedEntityIds(command))
  return { correctionId, description }
}
