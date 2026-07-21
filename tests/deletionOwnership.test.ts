// Structural deletion-ownership coverage (canonical-deletion ticket): every
// table in the production schema must be classified in the deletion-ownership
// registry, so a new evidence-derived table cannot silently escape deletion.
// The registry must also stay honest in the other direction — no entries for
// tables that no longer exist.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  DELETION_OWNERSHIP,
  deletionOwnershipFor,
  ftsBaseTable,
} from '../src/main/services/deletionOwnership.ts'

function productionTables(): string[] {
  const db = createProductionTestDatabase()
  try {
    return (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name)
  } finally {
    db.close()
  }
}

test('every production table has a deletion owner', () => {
  const missing = productionTables().filter((table) => deletionOwnershipFor(table) === null)
  assert.deepEqual(
    missing,
    [],
    `Unowned tables found. Classify each in src/main/services/deletionOwnership.ts ` +
    `(evidence/derived tables must name the deletion path that removes their rows): ${missing.join(', ')}`,
  )
})

test('the registry contains no stale entries', () => {
  const tables = new Set(productionTables())
  const stale = Object.keys(DELETION_OWNERSHIP).filter((table) => !tables.has(table))
  assert.deepEqual(stale, [], `Registry entries without a table: ${stale.join(', ')}`)
})

test('every evidence and derived entry names a concrete deletion owner', () => {
  for (const [table, ownership] of Object.entries(DELETION_OWNERSHIP)) {
    if (ownership.kind === 'evidence' || ownership.kind === 'derived') {
      assert.ok(
        ownership.owner.trim().length > 10,
        `${table}: evidence/derived tables must name their deletion path`,
      )
    }
  }
})

test('FTS shadow tables resolve to their base table', () => {
  assert.equal(ftsBaseTable('app_sessions_fts'), 'app_sessions')
  assert.equal(ftsBaseTable('app_sessions_fts_data'), 'app_sessions')
  assert.equal(ftsBaseTable('memory_records_fts_idx'), 'memory_records')
  assert.equal(ftsBaseTable('app_sessions'), null)
  assert.equal(deletionOwnershipFor('website_visits_fts_docsize')?.kind, 'evidence')
})
