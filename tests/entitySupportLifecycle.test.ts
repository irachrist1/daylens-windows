// WO-38 / WO-41: evidence-support removal and entity search-tag refresh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  addEntityEvidenceRef,
  addEntityRelationship,
  upsertEntity,
} from '../src/main/services/entities/entityRepository.ts'
import { pruneEntitySupportForDeletedEvidence } from '../src/main/services/entities/entitySupportLifecycle.ts'
import { listEntityTaggedDates, refreshEntitySearchTags } from '../src/main/services/entities/entitySearchTags.ts'
import { createClient } from '../src/main/core/query/attributionResolvers.ts'

test('deleting exclusive evidence removes a non-supplied entity', () => {
  const db = createProductionTestDatabase()
  try {
    const entity = upsertEntity(db, {
      type: 'page',
      identityKey: 'page:https://temp.example.test',
      name: 'Temp page',
      origin: 'observed',
      id: 'page-temp',
      observedAt: Date.UTC(2026, 7, 1),
    })
    addEntityEvidenceRef(db, entity.id, { sourceType: 'artifact', sourceId: 'art-temp' })
    addEntityRelationship(db, entity.id, entity.id, 'related', { source: 'inferred', confidence: 0.4 })

    const change = pruneEntitySupportForDeletedEvidence(db, 'artifact', 'art-temp')
    assert.ok(change.removedEvidenceRefIds.length >= 1)
    assert.ok(change.removedEntityIds.includes(entity.id))
    const status = (db.prepare(`SELECT status FROM entities WHERE id = ?`).get(entity.id) as { status: string }).status
    assert.equal(status, 'deleted')
  } finally {
    db.close()
  }
})

test('supplied entities are retained when their last evidence is removed', () => {
  const db = createProductionTestDatabase()
  try {
    const client = createClient({ name: 'Retained Co' }, db)
    addEntityEvidenceRef(db, client.id, { sourceType: 'artifact', sourceId: 'art-only' })
    const change = pruneEntitySupportForDeletedEvidence(db, 'artifact', 'art-only')
    assert.ok(change.retainedEntityIds.includes(client.id))
    assert.ok(!change.removedEntityIds.includes(client.id))
    const status = (db.prepare(`SELECT status FROM entities WHERE id = ?`).get(client.id) as { status: string }).status
    assert.equal(status, 'active')
  } finally {
    db.close()
  }
})

test('remaining evidence keeps the entity active', () => {
  const db = createProductionTestDatabase()
  try {
    const entity = upsertEntity(db, {
      type: 'page',
      identityKey: 'page:https://keep.example.test',
      name: 'Keep page',
      origin: 'observed',
      id: 'page-keep',
    })
    addEntityEvidenceRef(db, entity.id, { sourceType: 'artifact', sourceId: 'art-a' })
    addEntityEvidenceRef(db, entity.id, { sourceType: 'artifact', sourceId: 'art-b' })
    const change = pruneEntitySupportForDeletedEvidence(db, 'artifact', 'art-a')
    assert.ok(change.retainedEntityIds.includes(entity.id))
    const status = (db.prepare(`SELECT status FROM entities WHERE id = ?`).get(entity.id) as { status: string }).status
    assert.equal(status, 'active')
    const remaining = (db.prepare(`
      SELECT COUNT(*) AS c FROM entity_evidence_refs WHERE entity_id = ?
    `).get(entity.id) as { c: number }).c
    assert.equal(remaining, 1)
  } finally {
    db.close()
  }
})

test('refreshEntitySearchTags returns dates for a newly created client', () => {
  const db = createProductionTestDatabase()
  try {
    const client = createClient({ name: 'Taggable Co' }, db)
    const dates = refreshEntitySearchTags(db, client.id)
    assert.ok(dates.length >= 1)
    assert.ok(listEntityTaggedDates(db, client.id).length >= 0)
  } finally {
    db.close()
  }
})
