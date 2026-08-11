// WO-33: createClient / createProject also write supplied entities.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  createClient,
  createProject,
} from '../src/main/core/query/attributionResolvers.ts'

test('createClient upserts a supplied client entity with aliases in the same operation', () => {
  const db = createProductionTestDatabase()
  try {
    const client = createClient({ name: 'Acme Industries' }, db)
    const entity = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(client.id) as {
      entity_type: string
      origin: string
      canonical_name: string
      identity_key: string
    } | undefined
    assert.ok(entity)
    assert.equal(entity!.entity_type, 'client')
    assert.equal(entity!.origin, 'supplied')
    assert.equal(entity!.canonical_name, 'Acme Industries')
    assert.equal(entity!.identity_key, `supplied:${client.id}`)
    const aliases = db.prepare(`
      SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias
    `).all(client.id) as Array<{ alias: string }>
    assert.ok(aliases.some((row) => row.alias === 'Acme Industries'))
  } finally {
    db.close()
  }
})

test('createProject with a client stores the belongs_to entity relationship', () => {
  const db = createProductionTestDatabase()
  try {
    const client = createClient({ name: 'Globex' }, db)
    const project = createProject({ name: 'Portal', clientId: client.id }, db)
    const entity = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(project.id) as {
      entity_type: string
      origin: string
    } | undefined
    assert.ok(entity)
    assert.equal(entity!.entity_type, 'project')
    assert.equal(entity!.origin, 'supplied')
    const rel = db.prepare(`
      SELECT kind, source, confidence FROM entity_relationships
      WHERE entity_id = ? AND related_entity_id = ?
    `).get(project.id, client.id) as { kind: string; source: string; confidence: number } | undefined
    assert.ok(rel)
    assert.equal(rel!.kind, 'belongs_to')
    assert.equal(rel!.source, 'user')
    assert.equal(rel!.confidence, 1)
  } finally {
    db.close()
  }
})

test('createProject without a client still mints a supplied project entity', () => {
  const db = createProductionTestDatabase()
  try {
    const project = createProject({ name: 'Solo Work' }, db)
    const entity = db.prepare(`SELECT origin, entity_type FROM entities WHERE id = ?`).get(project.id) as {
      origin: string
      entity_type: string
    } | undefined
    assert.ok(entity)
    assert.equal(entity!.origin, 'supplied')
    assert.equal(entity!.entity_type, 'project')
    const relCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM entity_relationships WHERE entity_id = ?
    `).get(project.id) as { c: number }).c
    assert.equal(relCount, 0)
  } finally {
    db.close()
  }
})
