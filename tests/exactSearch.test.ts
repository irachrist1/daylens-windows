// DEV-178: exact retrieval over the canonical memory index.
//
// Proves the batch's four load-bearing behaviors end to end on a production
// database:
//   1. a day's corrected facts project into memory records (build +
//      incremental fingerprint), and session search reads them — with the
//      legacy app_sessions_fts fallback covering days the indexer has not
//      reached, so nothing that worked before goes dark;
//   2. corrections and deletions propagate — an ignored block, an evidence
//      exclusion, or purged raw rows disappear from results after the day's
//      re-projection and never resurrect;
//   3. entity resolution is alias- and merge-aware — "acme" finds Acme Corp's
//      attributed moments, a rename changes results instantly (no reindex),
//      and removing the old alias stops the old name from matching;
//   4. meetings and adopted artifacts are findable by their entity names.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  searchSessions,
  searchEntityMoments,
  latestEntityMomentDate,
} from '../src/main/db/queries.ts'
import {
  ensureDayMemoryIndexed,
  indexMemoryForDay,
  listMemoryIndexCandidateDates,
  memoryIndexBackfillStep,
  memoryIndexDayFingerprint,
} from '../src/main/services/memoryIndex.ts'
import {
  resolveQueryEntityMatches,
  searchExact,
  type EntitySearchResult,
} from '../src/main/services/exactSearch.ts'
import {
  addEntityAlias,
  addEntityEvidenceRef,
  resolveMeetingEntity,
  upsertEntity,
} from '../src/main/services/entities/entityRepository.ts'
import { applyEntityCorrection } from '../src/main/services/entities/entityCorrections.ts'
import { adoptConnectedEnvelope } from '../src/main/services/entities/entityAdoption.ts'
import { getCorrectedAppSummariesForRange } from '../src/main/services/activityFacts.ts'
import { localDayBounds } from '../src/main/lib/localDate.ts'

const DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  startHour: number,
  startMinute: number,
  durationMinutes: number,
  overrides: { bundleId?: string; appName?: string } = {},
): void {
  const startTime = localMs(startHour, startMinute)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, 'development', 1, ?, ?, 'test', 1)
  `).run(
    overrides.bundleId ?? 'com.mitchellh.ghostty',
    overrides.appName ?? 'Ghostty',
    startTime,
    startTime + durationMinutes * 60_000,
    durationMinutes * 60,
    title,
    overrides.appName ?? 'Ghostty',
  )
}

function insertAttributedWorkSession(
  db: Database.Database,
  clientId: string | null,
  projectId: string | null,
  startHour: number,
  endHour: number,
): void {
  const startedAt = localMs(startHour)
  const endedAt = localMs(endHour)
  db.prepare(`
    INSERT INTO work_sessions (
      id, device_id, started_at, ended_at, duration_ms, active_ms, idle_ms,
      client_id, project_id, attribution_status, app_bundle_ids_json, created_at, updated_at
    ) VALUES (?, 'dev-test', ?, ?, ?, ?, 0, ?, ?, 'attributed', '[]', ?, ?)
  `).run(
    `ws-${startHour}-${endHour}`,
    startedAt,
    endedAt,
    endedAt - startedAt,
    endedAt - startedAt,
    clientId,
    projectId,
    startedAt,
    startedAt,
  )
}

test('a day projects into memory records; search reads them; unindexed days keep the legacy path', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Refactoring the retrieval planner - Ghostty', 9, 0, 45)
  insertSession(db, 'Reading the sqlite fts5 docs', 14, 0, 30)

  // Before indexing: results come from the legacy fallback (parity: nothing
  // that worked before goes dark while the backfill catches up).
  const legacyResults = searchSessions(db, 'retrieval planner', { limit: 10 })
  assert.equal(legacyResults.length, 1, 'legacy fallback serves the unindexed day')

  const { records } = indexMemoryForDay(db, DATE)
  assert.ok(records >= 2, `expected at least 2 records, got ${records}`)
  assert.ok(
    db.prepare(`SELECT 1 FROM memory_index_days WHERE date = ?`).get(DATE),
    'the day is marked indexed',
  )

  const results = searchSessions(db, 'retrieval planner', { limit: 10 })
  assert.equal(results.length, 1, 'indexed day answers exactly once — no legacy double-count')
  assert.equal(results[0].appName, 'Ghostty')
  assert.match(results[0].excerpt, /\[\[mark\]\]/)
  assert.equal(results[0].date, DATE)

  // Incremental: unchanged inputs are a no-op; new evidence re-projects.
  assert.equal(ensureDayMemoryIndexed(db, DATE), false, 'fingerprint match skips the rebuild')
  insertSession(db, 'Sketching the ranker weights', 16, 0, 20)
  assert.notEqual(
    memoryIndexDayFingerprint(db, DATE),
    db.prepare(`SELECT fingerprint FROM memory_index_days WHERE date = ?`).get(DATE) &&
      (db.prepare(`SELECT fingerprint FROM memory_index_days WHERE date = ?`).get(DATE) as { fingerprint: string }).fingerprint,
  )
  assert.equal(ensureDayMemoryIndexed(db, DATE), true, 'new evidence forces a re-projection')
  assert.equal(searchSessions(db, 'ranker weights', { limit: 10 }).length, 1)
})

test('the backfill step walks stale days and reports done when current', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Backfill target session', 10, 0, 30)

  const first = memoryIndexBackfillStep(db, { daysPerStep: 10 })
  assert.ok(first.indexed >= 1, 'the seeded day was indexed')
  const second = memoryIndexBackfillStep(db, { daysPerStep: 10 })
  assert.equal(second.indexed, 0)
  assert.equal(second.done, true)
})

test('a day of browsing with no session behind it still enters the backfill', () => {
  const db = createProductionTestDatabase()
  const visitTime = localMs(11)
  db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec, browser_bundle_id
    ) VALUES ('sqlite.org', 'SQLite FTS5 documentation', 'https://sqlite.org/fts5.html', ?, ?, 900, 'com.apple.Safari')
  `).run(visitTime, visitTime * 1000)

  assert.ok(listMemoryIndexCandidateDates(db, 30).includes(DATE), 'browser visits are capture evidence')

  const step = memoryIndexBackfillStep(db, { daysPerStep: 10 })
  assert.ok(step.indexed >= 1, 'the browser-only day was indexed')
  assert.ok(
    db.prepare(`SELECT 1 FROM memory_records WHERE date = ? AND record_kind = 'page'`).get(DATE),
    'its pages have a canonical record',
  )
})

test('an ignored block and an evidence exclusion disappear from search after re-projection; undo restores', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Morning secret planning', 9, 0, 60)
  insertSession(db, 'Afternoon public work', 14, 0, 60)
  indexMemoryForDay(db, DATE)
  assert.equal(searchSessions(db, 'secret planning', { limit: 10 }).length, 1)

  // The user deletes the morning block (review_state 'ignored').
  db.prepare(`
    INSERT INTO timeline_block_reviews (id, block_id, date, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at)
    VALUES ('rev-ignore', 'blk-morning', ?, 'ek', 'ignored', ?, '{}', ?, ?)
  `).run(DATE, JSON.stringify({ startTime: localMs(9), endTime: localMs(10) }), Date.now(), Date.now())
  indexMemoryForDay(db, DATE)

  assert.equal(
    searchSessions(db, 'secret planning', { limit: 10 }).length,
    0,
    'the deleted stretch is gone from exact search',
  )
  assert.equal(searchSessions(db, 'public work', { limit: 10 }).length, 1, 'the kept block still answers')
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS c FROM app_sessions`).get() as { c: number }).c,
    2,
    'raw capture stays untouched underneath',
  )

  // Undo the deletion: the stretch returns after re-projection.
  db.prepare(`DELETE FROM timeline_block_reviews WHERE id = 'rev-ignore'`).run()
  indexMemoryForDay(db, DATE)
  assert.equal(searchSessions(db, 'secret planning', { limit: 10 }).length, 1, 'undo restores the result')

  // Evidence exclusion: the app vanishes inside the excluded span.
  db.prepare(`
    INSERT INTO evidence_exclusions (id, date, kind, bundle_id, app_name, domain, span_start_ms, span_end_ms, created_at)
    VALUES ('excl-1', ?, 'app', 'com.mitchellh.ghostty', 'Ghostty', NULL, ?, ?, ?)
  `).run(DATE, localMs(9), localMs(10), Date.now())
  indexMemoryForDay(db, DATE)
  assert.equal(searchSessions(db, 'secret planning', { limit: 10 }).length, 0, 'excluded evidence never surfaces')
})

test('deleted raw evidence never resurrects through the index', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Session to purge later', 11, 0, 30)
  indexMemoryForDay(db, DATE)
  assert.equal(searchSessions(db, 'purge later', { limit: 10 }).length, 1)

  db.prepare(`DELETE FROM app_sessions`).run()
  assert.equal(ensureDayMemoryIndexed(db, DATE), true, 'the deletion changes the fingerprint')
  assert.equal(searchSessions(db, 'purge later', { limit: 10 }).length, 0, 'nothing resurrects')
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS c FROM memory_records WHERE date = ?`).get(DATE) as { c: number }).c,
    0,
    'the day re-projected to zero records',
  )
})

test('alias-aware retrieval: "acme" finds Acme Corp days; rename applies instantly; a removed alias stops matching', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Drafting the quarterly report', 9, 0, 60)
  insertSession(db, 'Unrelated evening reading', 20, 0, 30)

  // A supplied client entity known as "acme" (adoption keeps client ids).
  const client = upsertEntity(db, {
    type: 'client',
    identityKey: 'supplied:client-acme',
    name: 'Acme Corp',
    origin: 'supplied',
    id: 'client-acme',
    observedAt: localMs(9),
  })
  addEntityAlias(db, client.id, 'acme', { source: 'user' })
  // The morning is attributed to that client.
  insertAttributedWorkSession(db, 'client-acme', null, 9, 10)

  indexMemoryForDay(db, DATE)

  // Entity resolution: alias → client, merge-aware.
  const matches = resolveQueryEntityMatches(db, 'acme')
  assert.equal(matches[0]?.entity.id, 'client-acme')

  // The full exact-search path: the entity itself + its tagged moments.
  const results = searchExact(db, 'acme', { limit: 20 })
  const entityRow = results.find((r) => r.type === 'entity') as EntitySearchResult | undefined
  assert.ok(entityRow, 'the client appears as an entity result')
  assert.equal(entityRow?.name, 'Acme Corp')
  assert.equal(entityRow?.matchedAlias, 'acme')
  assert.equal(entityRow?.date, DATE, 'the entity points at the day it was last part of')
  const moments = results.filter((r) => r.type === 'session')
  assert.ok(
    moments.some((m) => m.type === 'session' && m.windowTitle === 'Drafting the quarterly report'),
    'the attributed morning moment is found even though no title contains "acme"',
  )
  assert.ok(
    !moments.some((m) => m.type === 'session' && m.windowTitle === 'Unrelated evening reading'),
    'un-attributed moments do not ride along',
  )
  assert.equal(latestEntityMomentDate(db, ['client-acme'])?.date, DATE)

  // Rename the client — search by the NEW name works with NO reindex.
  applyEntityCorrection(db, { kind: 'entity-rename', entityId: 'client-acme', name: 'Initech' })
  const renamed = searchExact(db, 'initech', { limit: 20 })
  assert.ok(
    renamed.some((r) => r.type === 'entity' && r.name === 'Initech'),
    'the new name resolves',
  )
  assert.ok(
    renamed.some((r) => r.type === 'session' && r.windowTitle === 'Drafting the quarterly report'),
    'the same moments answer under the new name',
  )
  // The old name remains an alias (the rename never loses the label)…
  assert.ok(searchExact(db, 'acme corp', { limit: 20 }).some((r) => r.type === 'entity'))

  // …until the person removes the aliases; then the old names stop matching.
  db.prepare(`DELETE FROM entity_aliases WHERE entity_id = 'client-acme' AND alias_normalized IN ('acme', 'acme corp')`).run()
  assert.equal(resolveQueryEntityMatches(db, 'acme').length, 0, 'a removed alias no longer resolves')
  assert.equal(
    searchExact(db, 'acme', { limit: 20 }).filter((r) => r.type === 'session').length,
    0,
    'renamed-away results do not surface',
  )
})

test('meetings are findable by name through their entities', () => {
  const db = createProductionTestDatabase()
  const meeting = resolveMeetingEntity(db, {
    sourceEventId: 'calendar:2026-04-22:10:00:Acme weekly standup',
    title: 'Acme weekly standup',
    startMs: localMs(10),
    endMs: localMs(10, 30),
    origin: 'connected',
    sourceType: 'external_signal',
    sourceId: `${DATE}:calendar`,
  })
  indexMemoryForDay(db, DATE)

  const results = searchExact(db, 'standup', { limit: 20 })
  assert.ok(
    results.some((r) => r.type === 'entity' && r.id === meeting.id),
    'the meeting entity matches',
  )
  // Calendar-only support = SCHEDULED context (connectors.md §Google
  // Calendar): the result says so instead of claiming an attended meeting.
  const moment = results.find((r) => r.type === 'session' && r.appName === 'Scheduled meeting')
  assert.ok(moment, 'the meeting moment is in the results')
  assert.equal(moment?.type === 'session' ? moment.windowTitle : null, 'Acme weekly standup')

  // Entity-named records carry no index-time text: renaming the meeting
  // changes what the result says without any reindex.
  applyEntityCorrection(db, { kind: 'entity-rename', entityId: meeting.id, name: 'Weekly platform sync' })
  const renamed = searchExact(db, 'platform sync', { limit: 20 })
  const renamedMoment = renamed.find((r) => r.type === 'session' && r.appName === 'Scheduled meeting')
  assert.equal(renamedMoment?.type === 'session' ? renamedMoment.windowTitle : null, 'Weekly platform sync')
})

test('adopted artifacts index as entity-named file moments', () => {
  const db = createProductionTestDatabase()
  const now = localMs(15)
  db.prepare(`
    INSERT INTO artifacts (id, artifact_type, canonical_key, display_title, first_seen_at, last_seen_at)
    VALUES ('art-plan', 'document', 'doc:/notes/checkout-plan.md', 'checkout-plan.md', ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO artifact_mentions (id, artifact_id, source_type, source_id, start_time, end_time, confidence, evidence_json)
    VALUES ('am-1', 'art-plan', 'session', '1', ?, ?, 0.9, '{}')
  `).run(now, now + 600_000)
  // Adoption mints the file entity keeping the artifact id.
  const entity = upsertEntity(db, {
    type: 'file',
    identityKey: 'file:doc:/notes/checkout-plan.md',
    name: 'checkout-plan.md',
    origin: 'observed',
    id: 'art-plan',
    observedAt: now,
  })
  addEntityAlias(db, entity.id, 'checkout-plan.md', { source: 'observed' })
  addEntityEvidenceRef(db, entity.id, { sourceType: 'artifact', sourceId: 'art-plan' })

  indexMemoryForDay(db, DATE)
  const results = searchExact(db, 'checkout-plan', { limit: 20 })
  assert.ok(results.some((r) => r.type === 'entity' && r.id === 'art-plan'), 'the file entity matches')
  const moment = results.find((r) => r.type === 'session' && r.appName === 'File')
  assert.equal(moment?.type === 'session' ? moment.windowTitle : null, 'checkout-plan.md')
})

test('indexed durations reconcile with the corrected Apps totals (structured facts own the numbers)', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Morning implementation pass', 9, 0, 45)
  insertSession(db, 'Afternoon implementation pass', 14, 0, 30)
  // The user deletes the morning block — the reconciliation must hold on the
  // CORRECTED totals, not the raw capture.
  db.prepare(`
    INSERT INTO timeline_block_reviews (id, block_id, date, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at)
    VALUES ('rev-rec', 'blk-rec', ?, 'ek', 'ignored', ?, '{}', ?, ?)
  `).run(DATE, JSON.stringify({ startTime: localMs(9), endTime: localMs(10) }), Date.now(), Date.now())

  indexMemoryForDay(db, DATE)

  const [fromMs, toMs] = localDayBounds(DATE)
  const appsTotal = getCorrectedAppSummariesForRange(db, fromMs, toMs)
    .find((summary) => summary.appName === 'Ghostty')?.totalSeconds ?? 0
  const indexedTotal = (db.prepare(`
    SELECT COALESCE(SUM((end_ms - start_ms) / 1000), 0) AS s
    FROM memory_records
    WHERE date = ? AND record_kind = 'session' AND app_name = 'Ghostty'
  `).get(DATE) as { s: number }).s

  assert.equal(appsTotal, 30 * 60, 'Apps counts only the kept afternoon block')
  assert.equal(
    indexedTotal,
    appsTotal,
    'search moments and Apps totals read the same corrected facts — durations reconcile exactly',
  )
})

test('people resolve and their meetings answer (connected-source envelope); results carry source type', () => {
  const db = createProductionTestDatabase()
  // The Wave-2 synthetic connected-source envelope the spec's acceptance
  // criteria name for entity types without a live connector.
  const meeting = adoptConnectedEnvelope(db, {
    kind: 'calendar_event',
    sourceEventId: 'evt-quarterly-review',
    title: 'Quarterly review with Acme',
    startMs: localMs(11),
    endMs: localMs(12),
    attendees: [{ connectorId: 'cal:jamie@acme.test', displayName: 'Jamie Rivera' }],
  })
  assert.ok(meeting, 'the envelope minted a meeting entity')
  indexMemoryForDay(db, DATE)

  const results = searchExact(db, 'jamie rivera', { limit: 20 })
  const person = results.find((r) => r.type === 'entity' && r.entityType === 'person')
  assert.ok(person, 'the person resolves as an entity result')
  assert.equal(person?.type === 'entity' ? person.sourceType : null, 'connected')
  // A calendar_event envelope alone is scheduled context, not attendance.
  const momentRow = results.find((r) => r.type === 'session' && r.appName === 'Scheduled meeting')
  assert.ok(momentRow, "searching a person finds the meetings they were invited to")
  assert.equal(
    momentRow?.type === 'session' ? momentRow.windowTitle : null,
    'Quarterly review with Acme',
  )
  assert.equal(
    momentRow?.type === 'session' ? momentRow.sourceType : null,
    'connected',
    'meeting moments carry their connected source type',
  )

  // Observed capture carries its source type too.
  insertSession(db, 'Prep notes for the review', 10, 0, 30)
  indexMemoryForDay(db, DATE)
  const prep = searchSessions(db, 'prep notes', { limit: 5 })
  assert.equal(prep[0]?.sourceType, 'observed')
})

test('searchEntityMoments respects date bounds and correction filters', () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Client work in the morning', 9, 0, 60)
  upsertEntity(db, {
    type: 'client', identityKey: 'supplied:client-x', name: 'Client X',
    origin: 'supplied', id: 'client-x', observedAt: localMs(9),
  })
  insertAttributedWorkSession(db, 'client-x', null, 9, 10)
  indexMemoryForDay(db, DATE)

  assert.equal(searchEntityMoments(db, ['client-x'], {}).length, 1)
  assert.equal(
    searchEntityMoments(db, ['client-x'], { startDate: '2026-04-23' }).length,
    0,
    'a date filter before the moment excludes it',
  )

  // A late-landing exclusion is honored at query time even before reindex.
  db.prepare(`
    INSERT INTO evidence_exclusions (id, date, kind, bundle_id, app_name, domain, span_start_ms, span_end_ms, created_at)
    VALUES ('excl-x', ?, 'app', 'com.mitchellh.ghostty', 'Ghostty', NULL, ?, ?, ?)
  `).run(DATE, localMs(9), localMs(10), Date.now())
  assert.equal(
    searchEntityMoments(db, ['client-x'], {}).length,
    0,
    'query-time correction filters hold even when the day has not re-projected yet',
  )
})
