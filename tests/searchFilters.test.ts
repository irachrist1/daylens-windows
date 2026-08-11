// WO-6 / REQ-SM-002: the shared filter contract.
//
// The load-bearing claim is not that a filter narrows its own reader — it is
// that a filter a reader CANNOT express makes that reader return nothing. If an
// unexpressive reader returned its rows unfiltered, narrowing a search to a
// website would still bring back sessions and artifacts, and the filter would
// quietly fail to constrain anything. Those are the "leak" tests below.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  searchAll,
  searchArtifacts,
  searchBlocks,
  searchBrowser,
  searchEntityMoments,
  searchSessions,
} from '../src/main/db/queries.ts'
import { indexMemoryForDay } from '../src/main/services/memoryIndex.ts'
import { planRetrieval } from '../src/main/services/retrievalPlanner.ts'
import { upsertEntity, addEntityAlias } from '../src/main/services/entities/entityRepository.ts'
import { confirmSuppliedFact } from '../src/main/services/suppliedMemory.ts'

const DATE = '2026-04-22'
const NOW = new Date(2026, 7, 11, 12, 0, 0, 0).getTime()

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  hour: number,
  bundleId = 'com.mitchellh.ghostty',
  appName = 'Ghostty',
): void {
  const startTime = localMs(hour)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, 'development', 1, ?, ?, 'test', 1)
  `).run(bundleId, appName, startTime, startTime + 1_800_000, 1800, title, appName)
}

function insertVisit(db: Database.Database, domain: string, title: string, hour: number): void {
  const visitTime = localMs(hour)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec, browser_bundle_id
    ) VALUES (?, ?, ?, ?, ?, 600, 'com.apple.Safari')
  `).run(domain, title, `https://${domain}/planning`, visitTime, visitTime * 1000)
}

function insertArtifact(db: Database.Database, title: string, hour: number): void {
  db.prepare(`
    INSERT INTO ai_artifacts (kind, title, file_path, mime_type, created_at)
    VALUES ('note', ?, ?, 'text/markdown', ?)
  `).run(title, `/tmp/${title}.md`, localMs(hour))
}

/** A fixture where one word — "planning" — matches in every source table. */
function fixture(): Database.Database {
  const db = createProductionTestDatabase()
  insertSession(db, 'Quarterly planning session', 9)
  insertSession(db, 'Planning the design review', 11, 'com.figma.Desktop', 'Figma')
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 13)
  insertVisit(db, 'github.com', 'planning issues', 14)
  insertArtifact(db, 'planning-notes', 15)
  indexMemoryForDay(db, DATE)
  return db
}

// ─── AC-SM-002.2: no filter means the full eligible local history ───────────

test('AC-SM-002.2: with no filter set, every reader answers as before', () => {
  const db = fixture()
  assert.ok(searchSessions(db, 'planning', { limit: 20 }).length >= 2)
  assert.ok(searchBrowser(db, 'planning', { limit: 20 }).length >= 2)
  assert.ok(searchArtifacts(db, 'planning', { limit: 20 }).length >= 1)
  assert.ok(searchAll(db, 'planning', { limit: 20 }).length >= 5)
  db.close()
})

// ─── AC-SM-002.1: application ───────────────────────────────────────────────

test('an application filter narrows sessions to that app', () => {
  const db = fixture()
  const all = searchSessions(db, 'planning', { limit: 20 })
  const figmaOnly = searchSessions(db, 'planning', { limit: 20, applications: ['com.figma.Desktop'] })

  assert.ok(all.length > figmaOnly.length, 'the filter actually narrows')
  assert.ok(figmaOnly.length > 0, 'and does not empty the result set')
  for (const row of figmaOnly) assert.equal(row.appName, 'Figma')
  db.close()
})

test('an application filter matches by display name as well as bundle id', () => {
  const db = fixture()
  const byName = searchSessions(db, 'planning', { limit: 20, applications: ['Figma'] })
  assert.ok(byName.length > 0)
  for (const row of byName) assert.equal(row.appName, 'Figma')
  db.close()
})

test('an application filter eliminates the readers that have no app concept', () => {
  const db = fixture()
  const opts = { limit: 20, applications: ['com.figma.Desktop'] }
  assert.deepEqual(searchArtifacts(db, 'planning', opts), [], 'artifacts have no app column')
  assert.deepEqual(searchBlocks(db, 'planning', opts), [], 'blocks have no app column')
  db.close()
})

// ─── AC-SM-002.1: website, and the leak case ────────────────────────────────

test('a website filter narrows the browser reader to that domain', () => {
  const db = fixture()
  const notion = searchBrowser(db, 'planning', { limit: 20, websites: ['notion.so'] })
  assert.equal(notion.length, 1)
  assert.equal(notion[0].domain, 'notion.so')
  db.close()
})

test('a website filter returns nothing from readers that cannot express it', () => {
  const db = fixture()
  const opts = { limit: 20, websites: ['notion.so'] }
  assert.deepEqual(searchSessions(db, 'planning', opts), [], 'sessions have no domain')
  assert.deepEqual(searchArtifacts(db, 'planning', opts), [], 'artifacts have no domain')
  assert.deepEqual(searchBlocks(db, 'planning', opts), [], 'blocks have no domain')

  // The whole point: the union does not smuggle unfiltered rows back in.
  const unified = searchAll(db, 'planning', opts)
  assert.ok(unified.length > 0, 'the eligible reader still answers')
  for (const row of unified) {
    assert.equal(row.type, 'browser')
    assert.equal(row.domain, 'notion.so')
  }
  db.close()
})

// ─── AC-SM-002.1: entity filters ────────────────────────────────────────────

test('a client filter narrows to that entity’s tagged records', () => {
  const db = createProductionTestDatabase()
  const acme = upsertEntity(db, {
    type: 'client', identityKey: 'client:acme', name: 'Acme Corp', origin: 'supplied',
  })
  const other = upsertEntity(db, {
    type: 'client', identityKey: 'client:other', name: 'Other Ltd', origin: 'supplied',
  })
  addEntityAlias(db, acme.id, 'acme', { source: 'test' })

  insertSession(db, 'Acme planning session', 9)
  insertSession(db, 'Other planning session', 11)
  indexMemoryForDay(db, DATE)

  // Tag the first record to Acme so the filter has something to find.
  const record = db.prepare(
    `SELECT id FROM memory_records WHERE statement LIKE '%Acme%' LIMIT 1`,
  ).get() as { id: string } | undefined
  assert.ok(record, 'the fixture produced an Acme record')
  db.prepare(`INSERT OR IGNORE INTO memory_record_entities (record_id, entity_id) VALUES (?, ?)`)
    .run(record.id, acme.id)

  const scoped = searchSessions(db, 'planning', { limit: 20, clients: [acme.id] })
  assert.equal(scoped.length, 1)
  assert.match(scoped[0].windowTitle ?? '', /Acme/)

  assert.deepEqual(
    searchSessions(db, 'planning', { limit: 20, clients: [other.id] }), [],
    'an entity with no tagged records returns nothing, not everything',
  )

  // An entity filter also eliminates the readers that carry no entity tags.
  assert.deepEqual(searchBrowser(db, 'planning', { limit: 20, clients: [acme.id] }), [])
  assert.deepEqual(searchArtifacts(db, 'planning', { limit: 20, clients: [acme.id] }), [])
  db.close()
})

test('entity moments honour the same filters', () => {
  const db = createProductionTestDatabase()
  const acme = upsertEntity(db, {
    type: 'client', identityKey: 'client:acme', name: 'Acme Corp', origin: 'supplied',
  })
  insertSession(db, 'Acme planning session', 9)
  indexMemoryForDay(db, DATE)
  const record = db.prepare(`SELECT id FROM memory_records LIMIT 1`).get() as { id: string }
  db.prepare(`INSERT OR IGNORE INTO memory_record_entities (record_id, entity_id) VALUES (?, ?)`)
    .run(record.id, acme.id)

  assert.ok(searchEntityMoments(db, [acme.id], { limit: 20 }).length > 0)
  assert.deepEqual(
    searchEntityMoments(db, [acme.id], { limit: 20, websites: ['notion.so'] }), [],
    'a website filter makes the entity-moment reader ineligible',
  )
  db.close()
})

// ─── AC-SM-002.1: source ────────────────────────────────────────────────────

test('a source filter separates supplied facts from observed capture', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Quarterly planning session', 9)
  indexMemoryForDay(db, DATE)
  confirmSuppliedFact(db, { statement: 'I run planning on Mondays', source: 'hand' })

  const supplied = searchSessions(db, 'planning', { limit: 20, sources: ['supplied'] })
  assert.equal(supplied.length, 1)
  assert.equal(supplied[0].sourceType, 'supplied')

  const observed = searchSessions(db, 'planning', { limit: 20, sources: ['observed'] })
  assert.ok(observed.length > 0)
  for (const row of observed) assert.notEqual(row.sourceType, 'supplied')

  // Raw-capture readers can only ever return observed rows, so a supplied-only
  // filter must eliminate them rather than let them through.
  assert.deepEqual(searchArtifacts(db, 'planning', { limit: 20, sources: ['supplied'] }), [])
  assert.deepEqual(searchBlocks(db, 'planning', { limit: 20, sources: ['supplied'] }), [])
  db.close()
})

// ─── Filters intersect ──────────────────────────────────────────────────────

test('a date filter and an application filter intersect rather than union', () => {
  const db = fixture()
  insertSession(db, 'Planning on another day', 9, 'com.figma.Desktop', 'Figma')
  db.prepare(`UPDATE app_sessions SET start_time = ?, end_time = ? WHERE window_title = ?`)
    .run(new Date(2026, 2, 1, 9).getTime(), new Date(2026, 2, 1, 10).getTime(), 'Planning on another day')

  const both = searchSessions(db, 'planning', {
    limit: 20, applications: ['com.figma.Desktop'], startDate: DATE, endDate: DATE,
  })
  assert.ok(both.length > 0)
  for (const row of both) {
    assert.equal(row.appName, 'Figma')
    assert.equal(row.date, DATE)
  }
  db.close()
})

// ─── The filters reach the planner's paths ──────────────────────────────────

test('AC-SM-002.1: the planner applies the filter scope to every path it runs', async () => {
  const db = fixture()
  const unfiltered = await planRetrieval(db, 'planning', { now: NOW, limit: 30 })
  const filtered = await planRetrieval(db, 'planning', {
    now: NOW, limit: 30, websites: ['notion.so'],
  })

  assert.ok(unfiltered.results.length > filtered.results.length, 'the filter narrows the plan')
  assert.ok(filtered.results.length > 0)
  for (const result of filtered.results) {
    const row = result.representations[0]
    assert.equal(row.type, 'browser', 'only the reader that can express the filter contributed')
  }
  db.close()
})

test('AC-SM-002.2: an unfiltered planner query keeps the full local history', async () => {
  const db = fixture()
  const response = await planRetrieval(db, 'planning', { now: NOW, limit: 30 })
  const types = new Set(response.results.map((result) => result.representations[0].type))
  assert.ok(types.size > 1, 'more than one source type answers an unscoped query')
  db.close()
})
