// WO-30: captured/connected evidence write-through helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  adoptAppIdentityWrite,
  adoptArtifactWrite,
  adoptConnectedEnvelope,
  adoptWebsiteVisitWrite,
} from '../src/main/services/entities/entityAdoption.ts'

test('adoptAppIdentityWrite mints an application entity with evidence support', () => {
  const db = createProductionTestDatabase()
  try {
    const entity = adoptAppIdentityWrite(db, {
      appInstanceId: 'app-1',
      canonicalAppId: 'com.example.editor',
      displayName: 'Example Editor',
      rawAppName: 'example-editor',
      observedAt: Date.UTC(2026, 7, 1, 12),
    })
    assert.equal(entity.entity_type, 'application')
    const refs = db.prepare(`
      SELECT source_type, source_id FROM entity_evidence_refs WHERE entity_id = ?
    `).all(entity.id) as Array<{ source_type: string; source_id: string }>
    assert.ok(refs.some((ref) => ref.source_type === 'app_identity' && ref.source_id === 'app-1'))
  } finally {
    db.close()
  }
})

test('adoptArtifactWrite mints a page entity with artifact evidence', () => {
  const db = createProductionTestDatabase()
  try {
    const entity = adoptArtifactWrite(db, {
      id: 'art-1',
      artifactType: 'page',
      canonicalKey: 'https://learn.example.test/course',
      displayTitle: 'Course home',
      firstSeenAt: Date.UTC(2026, 7, 1, 10),
      lastSeenAt: Date.UTC(2026, 7, 1, 11),
    })
    assert.ok(entity)
    assert.equal(entity!.entity_type, 'page')
    assert.equal(entity!.id, 'art-1')
    const ref = db.prepare(`
      SELECT source_type FROM entity_evidence_refs WHERE entity_id = ? AND source_id = 'art-1'
    `).get(entity!.id) as { source_type: string } | undefined
    assert.equal(ref?.source_type, 'artifact')
  } finally {
    db.close()
  }
})

test('adoptWebsiteVisitWrite mints a page entity and keeps uncertainty when no visit id', () => {
  const db = createProductionTestDatabase()
  try {
    const entity = adoptWebsiteVisitWrite(db, {
      domain: 'learn.example.test',
      title: 'Learning site',
      observedAt: Date.UTC(2026, 7, 2, 9),
    })
    assert.ok(entity)
    assert.equal(entity!.entity_type, 'page')
    // No visit id → no evidence ref yet (uncertainty preserved until a real visit lands).
    const count = (db.prepare(`
      SELECT COUNT(*) AS c FROM entity_evidence_refs WHERE entity_id = ?
    `).get(entity!.id) as { c: number }).c
    assert.equal(count, 0)

    const withVisit = adoptWebsiteVisitWrite(db, {
      domain: 'learn.example.test',
      visitId: 42,
      observedAt: Date.UTC(2026, 7, 2, 10),
    })
    assert.equal(withVisit!.id, entity!.id)
    const refs = (db.prepare(`
      SELECT COUNT(*) AS c FROM entity_evidence_refs
      WHERE entity_id = ? AND source_type = 'website_visit' AND source_id = '42'
    `).get(entity!.id) as { c: number }).c
    assert.equal(refs, 1)
  } finally {
    db.close()
  }
})

test('connected envelope relationships retain source and confidence', () => {
  const db = createProductionTestDatabase()
  try {
    const startMs = Date.UTC(2026, 7, 3, 15)
    const meeting = adoptConnectedEnvelope(db, {
      kind: 'calendar_event',
      sourceEventId: 'gcal:evt-wo30',
      title: 'Design review',
      startMs,
      endMs: startMs + 3_600_000,
      attendees: [{ connectorId: 'google:sam@example.test', displayName: 'Sam' }],
    })
    assert.ok(meeting)
    const rel = db.prepare(`
      SELECT source, confidence, kind FROM entity_relationships
      WHERE related_entity_id = ? AND kind = 'attended'
    `).get(meeting!.id) as { source: string; confidence: number; kind: string } | undefined
    assert.ok(rel)
    assert.equal(rel!.source, 'connected')
    assert.ok(rel!.confidence >= 0.9)
  } finally {
    db.close()
  }
})
