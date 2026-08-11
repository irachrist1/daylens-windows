// WO-12 / REQ-SM-005 + REQ-SM-006: canonical memory records as the exact-search
// boundary.
//
// The defect this closes: searchArtifacts carried no correction filter at all,
// so an artifact created inside a span the person marked ignored was still
// returned by exact search. Browsing had no canonical record kind, so the
// browser reader could only re-implement the correction checks by hand against
// raw visits.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  searchArtifacts,
  searchBrowser,
  searchSessions,
} from '../src/main/db/queries.ts'
import {
  ensureDayMemoryIndexed,
  indexMemoryForDay,
  MEMORY_INDEX_VERSION,
} from '../src/main/services/memoryIndex.ts'
import { confirmSuppliedFact, getSuppliedFact } from '../src/main/services/suppliedMemory.ts'

const DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertVisit(
  db: Database.Database,
  domain: string,
  title: string,
  hour: number,
  durationSec = 600,
): void {
  const visitTime = localMs(hour)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec, browser_bundle_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'com.apple.Safari')
  `).run(domain, title, `https://${domain}/page`, visitTime, visitTime * 1000, durationSec)
}

function insertAiArtifact(db: Database.Database, title: string, hour: number): number {
  const info = db.prepare(`
    INSERT INTO ai_artifacts (kind, title, file_path, mime_type, created_at)
    VALUES ('note', ?, ?, 'text/markdown', ?)
  `).run(title, `/tmp/${title}.md`, localMs(hour))
  return Number(info.lastInsertRowid)
}

/** Mark a span ignored, the way a person hiding a block does. */
function ignoreSpan(db: Database.Database, startHour: number, endHour: number): void {
  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id, block_id, date, evidence_key, review_state, original_block_json,
      correction_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'ek', 'ignored', ?, '{}', ?, ?)
  `).run(
    `rev-${startHour}`,
    `block-${startHour}`,
    DATE,
    JSON.stringify({ startTime: localMs(startHour), endTime: localMs(endHour) }),
    Date.now(),
    Date.now(),
  )
}

// ─── AC-SM-005.1 / AC-SM-005.4: browsing has a canonical record ─────────────

test('AC-SM-005.1: a day’s browsing projects into canonical page records', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  insertVisit(db, 'notion.so', 'Roadmap notes', 10)
  insertVisit(db, 'github.com', 'planning issues', 11)
  indexMemoryForDay(db, DATE)

  const pages = db.prepare(
    `SELECT * FROM memory_records WHERE record_kind = 'page' ORDER BY domain`,
  ).all() as Array<Record<string, unknown>>

  assert.equal(pages.length, 2, 'one record per domain, not one per visit')
  assert.deepEqual(pages.map((page) => page.domain), ['github.com', 'notion.so'])
  db.close()
})

test('AC-SM-005.4: a page record keeps its inspectable metadata', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9, 1200)
  insertVisit(db, 'notion.so', 'Roadmap notes', 10, 300)
  indexMemoryForDay(db, DATE)

  const page = db.prepare(
    `SELECT * FROM memory_records WHERE record_kind = 'page' AND domain = 'notion.so'`,
  ).get() as {
    memory_type: string
    provenance: string
    sensitivity: string
    source_refs_json: string
    title: string
    url: string
    start_ms: number
    end_ms: number
    date: string
  }

  assert.equal(page.memory_type, 'observed')
  assert.equal(page.provenance, 'corrected_domain')
  assert.equal(page.sensitivity, 'standard')
  assert.deepEqual(JSON.parse(page.source_refs_json), [`corrected_domain:${DATE}:notion.so`])
  assert.equal(page.title, 'Quarterly planning doc', 'the most-visited title represents the domain')
  assert.match(page.url, /^https:\/\/notion\.so\//)
  assert.equal(page.date, DATE)
  assert.ok(page.end_ms > page.start_ms, 'the effective time range spans the visits')
  db.close()
})

// ─── AC-SM-006.1 / AC-SM-006.3: the two-arm reader ─────────────────────────

test('AC-SM-006.3: an unindexed day answers from the legacy arm', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)

  const results = searchBrowser(db, 'planning', { limit: 10 })
  assert.equal(results.length, 1, 'browsing is findable before the day is indexed')
  assert.equal(results[0].domain, 'notion.so')
  db.close()
})

test('AC-SM-006.3: an indexed day answers exactly once — no legacy double-count', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  insertVisit(db, 'notion.so', 'More planning', 10)
  indexMemoryForDay(db, DATE)

  const results = searchBrowser(db, 'planning', { limit: 10 })
  assert.equal(results.length, 1, 'one canonical record per domain, legacy arm gated off')
  assert.equal(results[0].domain, 'notion.so')
  assert.equal(results[0].date, DATE)
  db.close()
})

test('AC-SM-006.1: a page record is not also returned by the session reader', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  indexMemoryForDay(db, DATE)

  // Both readers see the same FTS index; only the browser reader owns pages.
  const sessions = searchSessions(db, 'planning', { limit: 10 })
  assert.equal(sessions.length, 0, 'the session reader excludes page records')
  assert.equal(searchBrowser(db, 'planning', { limit: 10 }).length, 1)
  db.close()
})

// ─── AC-SM-006.2: corrections propagate ─────────────────────────────────────

test('AC-SM-006.2: an excluded site stops returning after the day re-projects', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  indexMemoryForDay(db, DATE)
  assert.equal(searchBrowser(db, 'planning', { limit: 10 }).length, 1)

  db.prepare(`
    INSERT INTO evidence_exclusions (
      id, kind, domain, date, span_start_ms, span_end_ms, created_at
    ) VALUES ('exc-1', 'site', 'notion.so', ?, ?, ?, ?)
  `).run(DATE, localMs(0), localMs(23, 59), Date.now())

  assert.equal(ensureDayMemoryIndexed(db, DATE), true, 'the exclusion changes the fingerprint')
  assert.equal(
    searchBrowser(db, 'planning', { limit: 10 }).length, 0,
    'the excluded site is gone from exact retrieval',
  )
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS c FROM memory_records WHERE record_kind = 'page'`).get<
      { c: number }>().c,
    0,
    'and left no canonical record behind',
  )
  db.close()
})

test('AC-SM-006.2: a visit inside an ignored span never becomes a record', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  insertVisit(db, 'github.com', 'planning issues', 14)
  ignoreSpan(db, 8, 10)
  indexMemoryForDay(db, DATE)

  const results = searchBrowser(db, 'planning', { limit: 10 })
  assert.equal(results.length, 1)
  assert.equal(results[0].domain, 'github.com', 'the ignored span’s visit is gone')
  db.close()
})

test('AC-SM-006.2: an artifact inside an ignored span no longer returns', () => {
  // The defect this work order exists to close. Before, searchArtifacts applied
  // no correction, exclusion, or deletion filter of any kind.
  const db = createProductionTestDatabase()
  insertAiArtifact(db, 'planning-notes', 9)
  insertAiArtifact(db, 'planning-summary', 14)

  assert.equal(
    searchArtifacts(db, 'planning', { limit: 10 }).length, 2,
    'both artifacts are findable to begin with',
  )

  ignoreSpan(db, 8, 10)

  const afterIgnore = searchArtifacts(db, 'planning', { limit: 10 })
  assert.equal(afterIgnore.length, 1, 'the artifact inside the ignored span is gone')
  assert.equal(afterIgnore[0].title, 'planning-summary')
  db.close()
})

// ─── The v70 rebuild must not lose a confirmed fact ─────────────────────────

test('a supplied fact survives a day re-projection under the new index version', () => {
  const db = createProductionTestDatabase()
  const fact = confirmSuppliedFact(db, { statement: 'I run planning on Mondays', source: 'hand' })
  assert.ok(fact)

  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  indexMemoryForDay(db, DATE)

  assert.ok(getSuppliedFact(db, fact.id), 'the fact itself survives')
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS c FROM memory_records WHERE record_kind = 'supplied_fact'`,
    ).get<{ c: number }>().c,
    1,
    'and so does its retrieval mirror',
  )
  db.close()
})

test('the index version is bumped so already-indexed days re-project', () => {
  // Page records only exist from this version on; a day indexed under the old
  // version must not be treated as current.
  assert.ok(MEMORY_INDEX_VERSION >= 3)

  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  indexMemoryForDay(db, DATE)
  assert.equal(ensureDayMemoryIndexed(db, DATE), false, 'a current day is a no-op')

  db.prepare(`UPDATE memory_index_days SET fingerprint = 'v2|stale' WHERE date = ?`).run(DATE)
  assert.equal(ensureDayMemoryIndexed(db, DATE), true, 'a stale-version day re-projects')
  db.close()
})

// ─── The WO-6 filters still reach the new canonical arm ─────────────────────

test('a website filter applies to the canonical page arm', () => {
  const db = createProductionTestDatabase()
  insertVisit(db, 'notion.so', 'Quarterly planning doc', 9)
  insertVisit(db, 'github.com', 'planning issues', 11)
  indexMemoryForDay(db, DATE)

  const scoped = searchBrowser(db, 'planning', { limit: 10, websites: ['notion.so'] })
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].domain, 'notion.so')
  db.close()
})
