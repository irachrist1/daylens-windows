import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { writeAIBlockLabel } from '../src/main/db/queries.ts'
import { snapshotCarryForwardAiLabels } from '../src/main/services/workBlocks.ts'

// Regression for the "timeline didn't save after a restart" bug: a re-segmented
// day mints new block ids and used to strand the AI names keyed to the old ones,
// so blocks fell back to raw artifact titles. The carry-forward snapshot keys
// AI names by their session-set evidence so the rebuild can re-attach them.

const DATE = '2026-04-12'
const START = new Date(2026, 3, 12, 10, 0, 0, 0).getTime()

function seedBlock(db: Database.Database, id: string, invalidated = false): void {
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, 'work', 'development', '{}', 0,
      'Development', 'rule', 0.5, NULL, '{}', 0, 'test', ?, ?)
  `).run(id, DATE, START, START + 3_600_000, START, invalidated ? Date.now() : null)
}

function addSessionMembers(db: Database.Database, blockId: string, sessionIds: number[]): void {
  const stmt = db.prepare(`
    INSERT INTO timeline_block_members (block_id, member_type, member_id, start_time, end_time, weight_seconds)
    VALUES (?, 'app_session', ?, ?, ?, ?)
  `)
  for (const id of sessionIds) stmt.run(blockId, String(id), START, START + 600_000, 600)
}

test('snapshot keys AI names by their session set', () => {
  const db = createProductionTestDatabase()

  seedBlock(db, 'blk-a')
  addSessionMembers(db, 'blk-a', [12, 11]) // out of order on purpose
  writeAIBlockLabel(db, { blockId: 'blk-a', label: 'Refactoring the sync uploader', narrative: 'recap a' })

  seedBlock(db, 'blk-b')
  addSessionMembers(db, 'blk-b', [30])
  writeAIBlockLabel(db, { blockId: 'blk-b', label: 'Reviewing pull requests' })

  const map = snapshotCarryForwardAiLabels(db, DATE)

  // Ids are sorted numerically into the key, regardless of insertion order.
  assert.equal(map.get('sessions:11,12')?.label, 'Refactoring the sync uploader')
  assert.equal(map.get('sessions:11,12')?.narrative, 'recap a')
  assert.equal(map.get('sessions:30')?.label, 'Reviewing pull requests')
  assert.equal(map.size, 2)
  db.close()
})

test('snapshot ignores invalidated blocks and rule-only labels; a member-less block still carries by span', () => {
  const db = createProductionTestDatabase()

  // Invalidated AI block — its name is stale, must not be carried forward.
  seedBlock(db, 'blk-dead', true)
  addSessionMembers(db, 'blk-dead', [1])
  writeAIBlockLabel(db, { blockId: 'blk-dead', label: 'Stale name' })
  db.prepare(`UPDATE timeline_blocks SET invalidated_at = ? WHERE id = 'blk-dead'`).run(Date.now())

  // Rule-only block — never an AI name to carry.
  seedBlock(db, 'blk-rule')
  addSessionMembers(db, 'blk-rule', [2])

  // AI block with no session members — no session key, but its span still
  // identifies the same stretch of work on a rebuild.
  seedBlock(db, 'blk-nomembers')
  writeAIBlockLabel(db, { blockId: 'blk-nomembers', label: 'No evidence' })

  const map = snapshotCarryForwardAiLabels(db, DATE)
  assert.equal(map.get(`span:${START}:${START + 3_600_000}`)?.label, 'No evidence')
  assert.equal(map.size, 1)
  db.close()
})

test('snapshot keys AI names by span as well, and a contested span carries neither name', () => {
  const db = createProductionTestDatabase()

  seedBlock(db, 'blk-a')
  addSessionMembers(db, 'blk-a', [11])
  writeAIBlockLabel(db, { blockId: 'blk-a', label: 'Refactoring the sync uploader' })

  // Same span as blk-a (corrupt data): the span key must go to neither.
  seedBlock(db, 'blk-b')
  addSessionMembers(db, 'blk-b', [30])
  writeAIBlockLabel(db, { blockId: 'blk-b', label: 'Reviewing pull requests' })

  const map = snapshotCarryForwardAiLabels(db, DATE)
  assert.equal(map.get('sessions:11')?.label, 'Refactoring the sync uploader')
  assert.equal(map.get('sessions:30')?.label, 'Reviewing pull requests')
  assert.equal(map.get(`span:${START}:${START + 3_600_000}`), undefined)
  db.close()
})
