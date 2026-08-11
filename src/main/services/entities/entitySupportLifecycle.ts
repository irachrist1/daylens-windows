// Entity support lifecycle (WO-38 / AC-SM-EA-005).
//
// When supporting evidence is deleted, remove graph state that depends
// exclusively on that evidence, retain entities that still have support or are
// supplied, and notify Search & Memory of the resulting retrieval-eligibility
// change via entity search-tag refresh.
import type Database from 'better-sqlite3'
import { refreshEntitySearchTagsForMany } from './entitySearchTags'
import { mergeGroupIds, resolveMergeChain, type EntityOrigin, type EntityRow } from './entityRepository'

export interface EntitySupportChange {
  removedEvidenceRefIds: string[]
  removedRelationshipIds: string[]
  removedEntityIds: string[]
  retainedEntityIds: string[]
  affectedEntityIds: string[]
  refreshedDates: string[]
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) != null
}

/**
 * Remove or update graph rows that depended exclusively on the deleted
 * evidence source, then hand eligibility changes to Search & Memory.
 */
export function pruneEntitySupportForDeletedEvidence(
  db: Database.Database,
  sourceType: string,
  sourceId: string,
): EntitySupportChange {
  const empty: EntitySupportChange = {
    removedEvidenceRefIds: [],
    removedRelationshipIds: [],
    removedEntityIds: [],
    retainedEntityIds: [],
    affectedEntityIds: [],
    refreshedDates: [],
  }
  if (!tableExists(db, 'entity_evidence_refs')) return empty

  const refs = db.prepare(`
    SELECT * FROM entity_evidence_refs
    WHERE source_type = ? AND source_id = ?
  `).all(sourceType, sourceId) as Array<{
    id: string
    entity_id: string
  }>
  if (refs.length === 0) return empty

  const removedEvidenceRefIds: string[] = []
  const removedRelationshipIds: string[] = []
  const removedEntityIds: string[] = []
  const retainedEntityIds: string[] = []
  const affected = new Set<string>()

  const tx = db.transaction(() => {
    for (const ref of refs) {
      db.prepare(`DELETE FROM entity_evidence_refs WHERE id = ?`).run(ref.id)
      removedEvidenceRefIds.push(ref.id)
      affected.add(ref.entity_id)
    }

    for (const entityId of [...affected]) {
      const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(entityId) as EntityRow | undefined
      if (!row) continue
      const survivor = resolveMergeChain(db, row)
      const groupIds = mergeGroupIds(db, survivor.id)
      const marks = groupIds.map(() => '?').join(', ')
      const remaining = (db.prepare(`
        SELECT COUNT(*) AS c FROM entity_evidence_refs WHERE entity_id IN (${marks})
      `).get(...groupIds) as { c: number }).c

      // Relationships that named this evidence source exclusively are rare;
      // drop inferred/connected relationships that no longer have any evidence
      // on either endpoint when this was the last ref for the subject.
      if (remaining === 0 && survivor.origin !== 'supplied') {
        const rels = db.prepare(`
          SELECT id FROM entity_relationships
          WHERE entity_id IN (${marks}) OR related_entity_id IN (${marks})
        `).all(...groupIds, ...groupIds) as Array<{ id: string }>
        for (const rel of rels) {
          db.prepare(`DELETE FROM entity_relationships WHERE id = ?`).run(rel.id)
          removedRelationshipIds.push(rel.id)
        }
        db.prepare(`
          UPDATE entities SET status = 'deleted', updated_at = ? WHERE id IN (${marks})
        `).run(Date.now(), ...groupIds)
        for (const id of groupIds) removedEntityIds.push(id)
      } else {
        retainedEntityIds.push(survivor.id)
        if (remaining === 0 && survivor.origin === 'supplied') {
          // Supplied entities keep their row; drop only unsupported
          // inferred relationships hanging off deleted support.
          const rels = db.prepare(`
            SELECT id FROM entity_relationships
            WHERE (entity_id IN (${marks}) OR related_entity_id IN (${marks}))
              AND source != 'user'
          `).all(...groupIds, ...groupIds) as Array<{ id: string }>
          for (const rel of rels) {
            db.prepare(`DELETE FROM entity_relationships WHERE id = ?`).run(rel.id)
            removedRelationshipIds.push(rel.id)
          }
        }
      }
    }
  })
  tx()

  const refreshedDates = refreshEntitySearchTagsForMany(db, [...affected])
  return {
    removedEvidenceRefIds,
    removedRelationshipIds,
    removedEntityIds,
    retainedEntityIds,
    affectedEntityIds: [...affected],
    refreshedDates,
  }
}

/**
 * Connector deletion: drop source references and unsupported relationships
 * for every evidence ref that belonged to that connector's records
 * (AC-SM-EA-005.3). Callers pass each (sourceType, sourceId) pair they remove.
 */
export function pruneEntitySupportForConnectorSources(
  db: Database.Database,
  sources: Array<{ sourceType: string; sourceId: string }>,
): EntitySupportChange {
  const merged: EntitySupportChange = {
    removedEvidenceRefIds: [],
    removedRelationshipIds: [],
    removedEntityIds: [],
    retainedEntityIds: [],
    affectedEntityIds: [],
    refreshedDates: [],
  }
  const affected = new Set<string>()
  const dates = new Set<string>()
  for (const source of sources) {
    const change = pruneEntitySupportForDeletedEvidence(db, source.sourceType, source.sourceId)
    merged.removedEvidenceRefIds.push(...change.removedEvidenceRefIds)
    merged.removedRelationshipIds.push(...change.removedRelationshipIds)
    merged.removedEntityIds.push(...change.removedEntityIds)
    merged.retainedEntityIds.push(...change.retainedEntityIds)
    for (const id of change.affectedEntityIds) affected.add(id)
    for (const date of change.refreshedDates) dates.add(date)
  }
  merged.affectedEntityIds = [...affected]
  merged.refreshedDates = [...dates].sort()
  return merged
}

export type { EntityOrigin }
