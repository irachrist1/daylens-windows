// The work memory profile is editable, hand edits/deletes are corrections
// that survive a rebuild, drafting is grounded in real evidence, and
// rebuild/forget report what changed in plain language. No confidence theater.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  getWorkMemoryProfile,
  addWorkMemoryFact,
  addClientMemoryFact,
  updateWorkMemoryFact,
  forgetWorkMemoryFact,
  rebuildWorkMemory,
  workMemoryPromptBlock,
  chatMemoryPromptBlock,
} from '../src/main/services/workMemoryProfile.ts'

// A client is matched in chat only via a client_aliases row (the read path JOINs
// clients → client_aliases), so seed both — the name doubles as its own alias.
function seedClient(db: Database.Database, id: string, name: string): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO clients (id, name, color, status, created_at, updated_at) VALUES (?, ?, NULL, 'active', ?, ?)`,
  ).run(id, name, now, now)
  db.prepare(
    `INSERT INTO client_aliases (id, client_id, alias, alias_normalized, source, created_at) VALUES (?, ?, ?, ?, 'name', ?)`,
  ).run(`${id}-alias`, id, name, name.toLowerCase(), now)
}

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

test('a hand-added fact appears in the profile and is a user correction', () => {
  const db = createProductionTestDatabase()
  try {
    const profile = addWorkMemoryFact(db, 'Acme is my biggest client.')
    assert.equal(profile.facts.length, 1)
    assert.equal(profile.facts[0].text, 'Acme is my biggest client.')
    assert.equal(profile.facts[0].origin, 'user')
  } finally {
    db.close()
  }
})

test('rebuild drafts facts from real evidence', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    const result = rebuildWorkMemory(db)
    assert.ok(result.facts.length > 0, 'expected drafted facts')
    assert.ok(
      result.facts.some((f) => /Cursor/.test(f.text)),
      'should mention a top app',
    )
    assert.match(result.changeSummary, /Rebuilt/)
  } finally {
    db.close()
  }
})

test('editing a drafted fact makes it a correction that survives rebuild', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)
    const drafted = getWorkMemoryProfile(db).facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted, 'expected a drafted fact')

    updateWorkMemoryFact(db, drafted.id, 'I mostly pair-program in Cursor on Daylens.')
    // A rebuild must NOT overwrite the user-corrected fact. Since DEV-185 the
    // edit is an explicit confirmation: the corrected text becomes a supplied
    // fact (new id in the supplied store) and the drafted topic is tombstoned.
    rebuildWorkMemory(db)
    const facts = getWorkMemoryProfile(db).facts
    const after = facts.find((f) => f.text === 'I mostly pair-program in Cursor on Daylens.')
    assert.ok(after)
    assert.equal(after.origin, 'user')
    assert.equal(after.supplied, true)
    // The tombstoned drafted topic must not come back alongside the correction.
    assert.ok(!facts.some((f) => f.id === drafted.id))
  } finally {
    db.close()
  }
})

test('forgetting a drafted fact keeps it gone across a rebuild', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)
    const drafted = getWorkMemoryProfile(db).facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted)

    const forget = forgetWorkMemoryFact(db, drafted.id)
    assert.match(forget.changeSummary, /Forgot/)
    assert.ok(!getWorkMemoryProfile(db).facts.some((f) => f.id === drafted.id))

    // A rebuild must not drag a purposely-forgotten topic back.
    rebuildWorkMemory(db)
    assert.ok(
      !getWorkMemoryProfile(db).facts.some((f) => f.text === drafted.text),
      'forgotten topic must stay gone',
    )
  } finally {
    db.close()
  }
})

test('an edited-then-forgotten drafted fact does not resurrect on rebuild', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    rebuildWorkMemory(db)
    const drafted = getWorkMemoryProfile(db).facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted)

    // Edit (origin flips to user, topic_key retained) then forget.
    updateWorkMemoryFact(db, drafted.id, 'Cursor is where I live.')
    const edited = getWorkMemoryProfile(db).facts.find((f) => f.text === 'Cursor is where I live.')
    assert.ok(edited)
    forgetWorkMemoryFact(db, edited.id)

    // A rebuild must NOT bring the drafted topic back.
    rebuildWorkMemory(db)
    const facts = getWorkMemoryProfile(db).facts
    assert.ok(
      !facts.some((f) => /spend most of your day/.test(f.text)),
      'forgotten topic must stay gone after editing',
    )
    assert.ok(!facts.some((f) => f.text === 'Cursor is where I live.'))
  } finally {
    db.close()
  }
})

test('client-scoped memory reaches a chat answer only when the question names that client (memory.md invariant 4)', () => {
  const db = createProductionTestDatabase()
  try {
    seedClient(db, 'client-acme', 'Acme')
    addClientMemoryFact(db, 'client-acme', 'Acme prefers Friday demos.')
    addWorkMemoryFact(db, 'I treat YouTube as background, not focus.')

    // A question that names the client pulls general memory PLUS that client's scope.
    const aboutAcme = chatMemoryPromptBlock(db, 'how is the Acme work going this week?')
    assert.match(
      aboutAcme,
      /Acme prefers Friday demos\./,
      'client scope should be injected for a client question',
    )
    assert.match(aboutAcme, /YouTube/, 'general memory should always be present')

    // A question that does NOT name the client gets general memory only — the
    // client scope must not leak into unrelated answers.
    const general = chatMemoryPromptBlock(db, 'what did I work on today?')
    assert.match(general, /YouTube/)
    assert.ok(
      !/Friday demos/.test(general),
      'client-scoped memory must not leak into unrelated questions',
    )
  } finally {
    db.close()
  }
})

test('the prompt block carries the profile as context, or is empty when blank', () => {
  const db = createProductionTestDatabase()
  try {
    assert.equal(workMemoryPromptBlock(db), '')
    addWorkMemoryFact(db, 'I treat YouTube as background, not focus.')
    const block = workMemoryPromptBlock(db)
    assert.match(block, /YouTube/)
    assert.match(block, /context only/)
    // No confidence theater — no percentage badges in the block.
    assert.ok(!/\d+%/.test(block), 'prompt block must not contain confidence percentages')
  } finally {
    db.close()
  }
})

test('drafted facts stay out of the prompt block while confirmed facts ride it', () => {
  const db = createProductionTestDatabase()
  try {
    seedEvidence(db)
    // A rebuild creates drafted (evidence-derived, unconfirmed) facts.
    rebuildWorkMemory(db)
    const drafted = getWorkMemoryProfile(db).facts.find((f) => f.origin === 'drafted')
    assert.ok(drafted, 'expected at least one drafted fact from evidence')

    // Supplied (confirmed) fact rides the prompt block.
    addWorkMemoryFact(db, 'Acme is my biggest client this quarter.')
    const block = workMemoryPromptBlock(db)
    assert.match(block, /Acme is my biggest client/, 'confirmed supplied fact should appear')
    assert.ok(!block.includes(drafted.text), 'drafted fact must NOT appear in AI context')
  } finally {
    db.close()
  }
})
