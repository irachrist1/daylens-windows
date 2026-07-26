// "Merge all" tells the truth and finishes the job (DEV-257):
//   - a same-name cluster suggests n-1 merges, never the n*(n-1)/2 pair blowup,
//   - one merge-all call collapses every genuine duplicate, past any page cap,
//   - the reported count equals merges that actually flipped a row,
//   - a retry against an already-merged entity is never counted as a success,
//   - pairs a person dismissed as "Not the same" stay unmerged,
//   - a user-renamed entity survives as the merge target.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  listSuggestedEntityMerges,
  upsertEntity,
  type EntityRow,
} from '../src/main/services/entities/entityRepository.ts'
import {
  applyEntityCorrection,
  mergeAllDuplicateEntities,
} from '../src/main/services/entities/entityCorrections.ts'

function mintDuplicates(
  db: Database.Database,
  name: string,
  count: number,
  { baseObservedAt = Date.parse('2026-07-01T09:00:00Z') }: { baseObservedAt?: number } = {},
): EntityRow[] {
  const rows: EntityRow[] = []
  for (let i = 0; i < count; i += 1) {
    rows.push(upsertEntity(db, {
      type: 'application',
      identityKey: `app:${name.toLowerCase()}-${i}`,
      name,
      origin: 'observed',
      observedAt: baseObservedAt + i * 60_000,
    }))
  }
  return rows
}

function activeApplicationIds(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT id FROM entities WHERE entity_type = 'application' AND status = 'active' ORDER BY id`,
  ).all() as Array<{ id: string }>).map((row) => row.id)
}

test('a cluster of n same-name entities suggests n-1 anchored pairs, not every pair', () => {
  const db = createProductionTestDatabase()
  try {
    mintDuplicates(db, 'Netflix', 6)

    const suggestions = listSuggestedEntityMerges(db)
    assert.equal(suggestions.length, 5, 'six duplicates need five merges, not fifteen pairs')

    const anchors = new Set(suggestions.map((item) => item.leftId))
    assert.equal(anchors.size, 1, 'every pair is anchored on the one surviving entity')

    const pairKeys = new Set(suggestions.map((item) =>
      [item.leftId, item.rightId].sort().join(':')))
    assert.equal(pairKeys.size, 5, 'no pair is listed twice')

    const duplicates = new Set(suggestions.map((item) => item.rightId))
    assert.equal(duplicates.size, 5, 'each duplicate appears exactly once')
    assert.ok(!duplicates.has([...anchors][0]!), 'the anchor never pairs with itself')
  } finally {
    db.close()
  }
})

test('one merge-all call collapses every genuine duplicate, well past a 20-pair batch', () => {
  const db = createProductionTestDatabase()
  try {
    // 24 two-entity clusters plus one six-entity cluster: 29 genuine merges.
    for (let i = 0; i < 24; i += 1) mintDuplicates(db, `App ${i}`, 2)
    mintDuplicates(db, 'Netflix', 6)

    assert.equal(listSuggestedEntityMerges(db).length, 29, 'the count tells the truth up front')

    const result = mergeAllDuplicateEntities(db)
    assert.equal(result.merged, 29, 'every genuine duplicate merged in one press')
    assert.equal(result.failed, 0)
    assert.ok(result.lastCorrectionId, 'the last merge stays undoable')

    assert.equal(listSuggestedEntityMerges(db).length, 0, 'nothing needs attention afterwards')
    assert.equal(activeApplicationIds(db).length, 25, '54 entities collapsed to 25 real things')
  } finally {
    db.close()
  }
})

test('the reported count equals real merges; already-merged retries are not successes', () => {
  const db = createProductionTestDatabase()
  try {
    const [a, b] = mintDuplicates(db, 'Canva', 3)

    // The user already merged one pair by hand.
    applyEntityCorrection(db, { kind: 'entity-merge', targetId: a!.id, sourceId: b!.id })

    const result = mergeAllDuplicateEntities(db)
    assert.equal(result.merged, 1, 'only the remaining duplicate counts as a merge')
    assert.equal(result.failed, 0, 'the already-merged pair is skipped, not an error')

    const again = mergeAllDuplicateEntities(db)
    assert.equal(again.merged, 0, 'a second press has nothing left to merge')
    assert.equal(again.failed, 0)
    assert.equal(again.lastCorrectionId, null)

    assert.equal(activeApplicationIds(db).length, 1)
  } finally {
    db.close()
  }
})

test('pairs dismissed as "Not the same" are never merged by merge-all', () => {
  const db = createProductionTestDatabase()
  try {
    mintDuplicates(db, 'Mercury', 2)
    mintDuplicates(db, 'Figma', 2)

    const suggestions = listSuggestedEntityMerges(db)
    const dismissed = suggestions.find((item) => item.leftName === 'Mercury')
    assert.ok(dismissed)

    const result = mergeAllDuplicateEntities(db, {
      excludedPairs: [{ leftId: dismissed!.leftId, rightId: dismissed!.rightId }],
    })
    assert.equal(result.merged, 1, 'only the non-dismissed cluster merged')
    assert.equal(result.failed, 0)

    const remaining = listSuggestedEntityMerges(db)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.leftName, 'Mercury', 'the dismissed pair stays for the person to decide')
    assert.equal(activeApplicationIds(db).length, 3)
  } finally {
    db.close()
  }
})

test('a user-renamed duplicate survives merge-all as the target', () => {
  const db = createProductionTestDatabase()
  try {
    const rows = mintDuplicates(db, 'Traycer', 3)
    // Renaming to the same label still records the explicit user decision
    // (name_source = 'user'), which outranks recency when picking the anchor.
    applyEntityCorrection(db, { kind: 'entity-rename', entityId: rows[0]!.id, name: 'Traycer' })

    const suggestions = listSuggestedEntityMerges(db)
    assert.equal(suggestions.length, 2)
    assert.ok(suggestions.every((item) => item.leftId === rows[0]!.id),
      'the user-named entity anchors every pair')

    const result = mergeAllDuplicateEntities(db)
    assert.equal(result.merged, 2)
    assert.deepEqual(activeApplicationIds(db), [rows[0]!.id],
      'the user-named entity is the one left standing')
  } finally {
    db.close()
  }
})
