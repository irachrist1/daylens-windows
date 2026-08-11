// WO-18 / AC-SM-012: drafted (unconfirmed) work-memory facts must not leak
// into AI context. These tests pin the confirmed-only boundary across every
// AI-context surface: the prompt block, the chat memory block, and the
// context packet's corrected_fact items.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import {
  getScopedMemoryProfile,
  getWorkMemoryProfile,
  addWorkMemoryFact,
  rebuildWorkMemory,
  workMemoryPromptBlock,
  chatMemoryPromptBlock,
  proposeUnstoredMemoryFact,
} from '../src/main/services/workMemoryProfile.ts'
import { recordMemoryProposalRejection } from '../src/main/services/suppliedMemory.ts'

// Recent timestamps — the draft only looks at the last 30 days of evidence.
const BASE = Date.now() - 5 * 86_400_000

function seedEvidence(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  // Heavy dev usage across Cursor + Warp.
  for (let i = 0; i < 5; i++) {
    insert.run(
      'com.cursor.app',
      'Cursor',
      BASE + i * 1000,
      BASE + i * 1000 + 3600_000,
      3600,
      'development',
    )
    insert.run(
      'dev.warp.Warp',
      'Warp',
      BASE + i * 2000,
      BASE + i * 2000 + 3600_000,
      3600,
      'development',
    )
  }
}

test('AC-SM-012.1: drafted facts do not appear in getScopedMemoryProfile confirmed-only', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)
    addWorkMemoryFact(db, 'Acme is my biggest client this quarter.')

    const full = getScopedMemoryProfile(db, false)
    const confirmedOnly = getScopedMemoryProfile(db, true)

    // Drafts exist in the full profile.
    assert.ok(
      full.general.some((f) => f.origin === 'drafted'),
      'full profile should contain drafted facts',
    )

    // Drafts are absent from the confirmed-only profile.
    assert.equal(
      confirmedOnly.general.filter((f) => f.origin === 'drafted').length,
      0,
      'confirmed-only profile must exclude drafts',
    )

    // Confirmed facts are present.
    assert.ok(
      confirmedOnly.general.some((f) => f.origin === 'user'),
      'confirmed-only profile must keep confirmed facts',
    )
  } finally {
    db.close()
  }
})

test('AC-SM-012.1: drafted facts do not appear in workMemoryPromptBlock', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)
    const drafted = getWorkMemoryProfile(db).facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted, 'expected a drafted fact')

    addWorkMemoryFact(db, 'Acme is my biggest client this quarter.')
    const block = workMemoryPromptBlock(db)

    assert.match(block, /Acme is my biggest client/, 'confirmed fact should be in the block')
    assert.ok(
      !block.includes(drafted.text),
      'drafted fact must NOT appear in AI context prompt block',
    )
  } finally {
    db.close()
  }
})

test('AC-SM-012.1: drafted facts do not appear in chatMemoryPromptBlock', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)
    const drafted = getWorkMemoryProfile(db).facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted, 'expected a drafted fact')

    addWorkMemoryFact(db, 'Beacon prefers Friday demos.')
    const block = chatMemoryPromptBlock(db, 'how is the Beacon work going?')

    assert.match(block, /Beacon prefers Friday demos/, 'confirmed fact should be in the block')
    assert.ok(
      !block.includes(drafted.text),
      'drafted fact must NOT appear in chat memory prompt block',
    )
  } finally {
    db.close()
  }
})

test('AC-SM-012.1: management profile still includes drafts as proposals', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)

    const profile = getWorkMemoryProfile(db)
    assert.ok(
      profile.facts.some((f) => f.origin === 'drafted'),
      'manage-memory view must still surface drafts as proposals',
    )
  } finally {
    db.close()
  }
})

test('AC-SM-012.1: drafted facts do not appear as corrected_fact items in context packet', async () => {
  const db = createProductionTestDatabase()
  setTestDb(db)
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)
    const drafted = getWorkMemoryProfile(db).facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted, 'expected a drafted fact')

    // Import after setTestDb so the module-level database stub picks up the test db.
    const { buildContextPacket } = await import('../src/main/services/contextPacket.ts')

    const packet = await buildContextPacket(db, {
      purpose: 'answer',
      question: 'what did I work on',
      dates: ['2026-04-22'],
      now: new Date(2026, 3, 22, 23, 59, 0, 0),
    })
    const corrected = packet.items.filter((item) => item.kind === 'corrected_fact')
    assert.ok(
      !corrected.some((item) => item.statement === drafted.text),
      'drafted fact must NOT appear as a corrected_fact item',
    )
  } finally {
    clearTestDb()
    db.close()
  }
})

test('AC-SM-012.3: a rejected proposal is tombstoned on rebuild and stays gone', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)

    const profile = getWorkMemoryProfile(db)
    const drafted = profile.facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted, 'expected a drafted fact')

    // Simulate declining the proposal in chat.
    recordMemoryProposalRejection(db, { statement: drafted.text })

    // Rebuild — the rejected row should be tombstoned, not refreshed or re-created.
    const after = rebuildWorkMemory(db)
    assert.ok(
      !after.facts.some((f) => f.text === drafted.text),
      'rejected draft must not survive rebuild',
    )

    // And it must not appear in the profile either.
    const profileAfter = getWorkMemoryProfile(db)
    assert.ok(
      !profileAfter.facts.some((f) => f.id === drafted.id),
      'tombstoned row must not appear in any profile',
    )
  } finally {
    db.close()
  }
})

test('AC-SM-012.3: a rejected proposal is never returned by proposeUnstoredMemoryFact after rebuild', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    const proposed = proposeUnstoredMemoryFact(db)
    assert.ok(proposed, 'should propose a fact from evidence')
    recordMemoryProposalRejection(db, { statement: proposed.text })

    rebuildWorkMemory(db)
    // After rebuild, the rejected proposal must not come back.
    const profileAfter = getWorkMemoryProfile(db)
    assert.ok(
      !profileAfter.facts.some((f) => f.text === proposed.text),
      'rejected proposal must stay gone',
    )
  } finally {
    db.close()
  }
})

test('AC-SM-012.4: rebuildWorkMemory does not throw when app_sessions is absent', () => {
  const db = createProductionTestDatabase()
  try {
    db.prepare(`DROP TABLE IF EXISTS app_sessions`).run()
    assert.doesNotThrow(() => rebuildWorkMemory(db))
  } finally {
    db.close()
  }
})

test('AC-SM-012.4: rebuildWorkMemory does not throw when website_visits is absent', () => {
  const db = createProductionTestDatabase()
  try {
    db.prepare(`DROP TABLE IF EXISTS website_visits`).run()
    assert.doesNotThrow(() => rebuildWorkMemory(db))
  } finally {
    db.close()
  }
})

test('AC-SM-012.4: rebuildWorkMemory does not throw when both evidence tables are absent', () => {
  const db = createProductionTestDatabase()
  try {
    db.prepare(`DROP TABLE IF EXISTS app_sessions`).run()
    db.prepare(`DROP TABLE IF EXISTS website_visits`).run()
    assert.doesNotThrow(() => rebuildWorkMemory(db))
  } finally {
    db.close()
  }
})
