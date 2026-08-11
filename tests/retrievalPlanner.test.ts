// WO-7 / REQ-SM-001 + REQ-SM-003: the unified retrieval planner end to end.
//
// One query in, one ordered supported result set out. What these cover:
//   1. scope (time range, entities) resolves BEFORE any reader runs, which is
//      what AC-SM-001.1 and .2 actually demand;
//   2. path selection picks structured / exact / semantic on the query's shape;
//   3. semantic being unavailable degrades the plan instead of failing it;
//   4. two representations of one activity reconcile into one result;
//   5. an exact date match is not overtaken by a newer non-match.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { indexMemoryForDay } from '../src/main/services/memoryIndex.ts'
import { upsertEntity, addEntityAlias } from '../src/main/services/entities/entityRepository.ts'
import {
  benefitsFromSemanticRetrieval,
  needsStructuredRetrieval,
  planRetrieval,
  reconciliationKey,
  reconcileResults,
  resolveRetrievalScope,
  resolveTimeRangeFromText,
  type RetrievalScope,
} from '../src/main/services/retrievalPlanner.ts'

const DATE = '2026-04-22'
const NEWER_DATE = '2026-06-01'
// Fixed "now" so recency scoring cannot drift with the wall clock.
const NOW = new Date(2026, 7, 11, 12, 0, 0, 0).getTime()

function localMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  startTime: number,
  durationMinutes: number,
  overrides: { bundleId?: string; appName?: string } = {},
): void {
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

function emptyScope(): RetrievalScope {
  return { timeRangeSource: 'none', lexicalText: '', entities: [], ambiguousEntity: false }
}

// ─── AC-SM-001.1: the time range resolves before retrieval ───────────────────

test('AC-SM-001.1: a requested time range is resolved from the query text', () => {
  const today = '2026-08-11'
  assert.deepEqual(resolveTimeRangeFromText('what did I do today', today), {
    startDate: '2026-08-11', endDate: '2026-08-11', matched: 'today',
  })
  assert.deepEqual(resolveTimeRangeFromText('yesterday figma', today), {
    startDate: '2026-08-10', endDate: '2026-08-10', matched: 'yesterday',
  })
  assert.deepEqual(resolveTimeRangeFromText('the acme call on 2026-04-22', today), {
    startDate: '2026-04-22', endDate: '2026-04-22', matched: '2026-04-22',
  })
  assert.deepEqual(resolveTimeRangeFromText('last 7 days of review', today), {
    startDate: '2026-08-05', endDate: '2026-08-11', matched: 'last 7 days',
  })
  // A bare month resolves backwards, never into the future.
  assert.deepEqual(resolveTimeRangeFromText('the July retro', today), {
    startDate: '2026-07-01', endDate: '2026-07-31', matched: 'july',
  })
  assert.deepEqual(resolveTimeRangeFromText('the December retro', today), {
    startDate: '2025-12-01', endDate: '2025-12-31', matched: 'december',
  })
  // An unrecognized phrase yields nothing rather than a guessed range: a wrong
  // range silently hides evidence.
  assert.equal(resolveTimeRangeFromText('refactor the ranker', today), null)
})

test('an explicit date filter wins over a range in the query text', () => {
  const db = createProductionTestDatabase()
  const scope = resolveRetrievalScope(db, 'what did I do yesterday', {
    startDate: '2026-01-05', endDate: '2026-01-05',
  })
  assert.equal(scope.timeRangeSource, 'filter')
  assert.equal(scope.startDate, '2026-01-05')
  assert.equal(scope.endDate, '2026-01-05')
  db.close()
})

test('the resolved range reaches the readers before retrieval begins', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Quarterly planning session', localMs(2026, 3, 22, 9), 45)
  insertSession(db, 'Quarterly planning session', localMs(2026, 5, 1, 9), 45)
  indexMemoryForDay(db, DATE)
  indexMemoryForDay(db, NEWER_DATE)

  const response = await planRetrieval(db, 'quarterly planning on 2026-04-22', { now: NOW })
  assert.equal(response.plan.scope.timeRangeSource, 'query-text')
  assert.equal(response.plan.scope.startDate, DATE)
  assert.ok(response.results.length > 0, 'the scoped query still returns results')
  for (const result of response.results) {
    assert.equal(result.date, DATE, 'no result from outside the resolved range')
  }
  db.close()
})

// ─── AC-SM-001.2: entities and aliases resolve before retrieval ──────────────

test('AC-SM-001.2: an alias resolves to its entity before retrieval begins', () => {
  const db = createProductionTestDatabase()
  const entity = upsertEntity(db, {
    type: 'client',
    identityKey: 'client:acme',
    name: 'Acme Corp',
    origin: 'supplied',
  })
  addEntityAlias(db, entity.id, 'acme', { source: 'test' })

  const scope = resolveRetrievalScope(db, 'acme', {})
  assert.equal(scope.entities.length, 1)
  assert.equal(scope.entities[0].name, 'Acme Corp')
  assert.equal(scope.entities[0].id, entity.id)
  assert.ok(scope.entities[0].groupIds.includes(entity.id), 'the merge group travels with the scope')
  assert.equal(scope.ambiguousEntity, false)
  db.close()
})

test('AC-SM-004.3 groundwork: two equally-strong name matches stay separate candidates', () => {
  const db = createProductionTestDatabase()
  // Two different people, both exactly named "Sam" — the resolver must not pick.
  upsertEntity(db, {
    type: 'person', identityKey: 'person:sam-a', name: 'Sam', origin: 'observed',
  })
  upsertEntity(db, {
    type: 'person', identityKey: 'person:sam-b', name: 'Sam', origin: 'connected',
  })

  const scope = resolveRetrievalScope(db, 'Sam', {})
  assert.equal(scope.entities.length, 2, 'both candidates survive')
  assert.equal(scope.ambiguousEntity, true, 'the ambiguity is flagged, not resolved silently')
  db.close()
})

// ─── AC-SM-001.3 / .4 / .5: path selection ──────────────────────────────────

test('AC-SM-001.3: a count or duration question selects structured retrieval', () => {
  const scope = emptyScope()
  assert.ok(needsStructuredRetrieval('how long did I spend in Figma', scope))
  assert.ok(needsStructuredRetrieval('how many hours on acme', scope))
  assert.ok(needsStructuredRetrieval('total time spent on github', scope))
  assert.ok(!needsStructuredRetrieval('the retrieval planner refactor', scope))

  // A resolved range with no searchable words is a question about the period.
  const dated: RetrievalScope = {
    ...emptyScope(), timeRangeSource: 'query-text', startDate: DATE, lexicalText: '',
  }
  assert.ok(needsStructuredRetrieval('yesterday', dated))
})

test('AC-SM-001.5: meaning-based matching is selected only where it helps', () => {
  assert.ok(benefitsFromSemanticRetrieval('what was I working on when the build broke'))
  // A quoted phrase is a demand for those exact words.
  assert.ok(!benefitsFromSemanticRetrieval('"quarterly planning"'))
  // A short literal lookup is already served exactly.
  assert.ok(!benefitsFromSemanticRetrieval('figma'))
  assert.ok(!benefitsFromSemanticRetrieval('acme corp'))
  assert.ok(!benefitsFromSemanticRetrieval('ab'))
})

test('AC-SM-001.4: a quoted phrase runs exact retrieval and finds the moment', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Quarterly planning session', localMs(2026, 3, 22, 9), 45)
  indexMemoryForDay(db, DATE)

  const response = await planRetrieval(db, '"quarterly planning"', { now: NOW })
  assert.ok(response.plan.paths.includes('exact'))
  assert.ok(!response.plan.paths.includes('semantic'), 'a quoted phrase does not go semantic')
  assert.ok(response.results.length > 0)
  assert.equal(response.results[0].signals.exactLexical, 1, 'the quoted phrase scores a full match')
  db.close()
})

// ─── AC-SM-001.6: semantic unavailable degrades, never fails ────────────────

test('AC-SM-001.6: semantic unavailable leaves the other paths answering', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Debugging the retrieval planner ranker', localMs(2026, 3, 22, 9), 45)
  indexMemoryForDay(db, DATE)

  // No local model or vector store exists in the hermetic test environment,
  // which is exactly the unavailable case the criterion is written for.
  const response = await planRetrieval(db, 'what was I debugging in the planner', { now: NOW })

  assert.ok(!response.plan.paths.includes('semantic'), 'semantic did not run')
  const semanticGap = response.plan.unavailable.find((entry) => entry.path === 'semantic')
  assert.ok(semanticGap, 'the plan records that semantic retrieval was unavailable')
  assert.ok(semanticGap.reason.length > 0, 'the reason is a readable sentence, not a code')
  assert.equal(response.degraded, true)

  assert.ok(response.plan.paths.includes('exact'), 'exact retrieval still ran')
  assert.ok(response.results.length > 0, 'the query succeeded rather than failing')
  db.close()
})

// ─── AC-SM-003.1: reconciliation ────────────────────────────────────────────

test('AC-SM-003.1: a canonical record and a legacy row for one session reconcile', () => {
  const startTime = localMs(2026, 3, 22, 9)
  // The same activity as the memory-record projection sees it...
  const canonical = {
    type: 'session' as const,
    id: 41,
    appName: 'Ghostty',
    windowTitle: 'Quarterly planning session',
    startTime,
    endTime: startTime + 2_700_000,
    date: DATE,
    excerpt: 'Quarterly planning session',
    sourceType: 'observed' as const,
  }
  // ...and as the legacy app_sessions reader sees it: different id, no
  // sourceType. The old `type:id:startTime` dedupe kept both.
  const legacy = { ...canonical, id: 907, sourceType: undefined }

  assert.equal(
    reconciliationKey(canonical),
    reconciliationKey(legacy),
    'the key is the activity, not the row',
  )

  const groups = reconcileResults([
    { path: 'exact', rows: [canonical] },
    { path: 'structured', rows: [legacy] },
  ])
  assert.equal(groups.length, 1, 'one activity, one result')
  assert.equal(groups[0].representations.length, 2, 'both representations are kept')
  assert.equal(
    groups[0].representations[0].id, 41,
    'the canonical record is the surviving representation, not the legacy row',
  )
  assert.equal(groups[0].foundBy.size, 2, 'corroboration across two paths is recorded')
})

test('distinct activities are not collapsed by reconciliation', () => {
  const base = {
    type: 'session' as const,
    id: 1,
    appName: 'Ghostty',
    windowTitle: 'a',
    startTime: localMs(2026, 3, 22, 9),
    endTime: localMs(2026, 3, 22, 10),
    date: DATE,
    excerpt: 'a',
  }
  const differentTime = { ...base, startTime: localMs(2026, 3, 22, 11) }
  const differentApp = { ...base, appName: 'Figma' }
  const groups = reconcileResults([{ path: 'exact', rows: [base, differentTime, differentApp] }])
  assert.equal(groups.length, 3)
})

test('entity results reconcile on their survivor id', () => {
  const entityRow = {
    type: 'entity' as const,
    id: 'ent-1',
    name: 'Acme Corp',
    entityType: 'client' as const,
    matchedAlias: 'acme',
    sourceType: 'supplied' as const,
    startTime: 0,
    endTime: 0,
    date: DATE,
    excerpt: 'Client',
  }
  const groups = reconcileResults([
    { path: 'exact', rows: [entityRow] },
    { path: 'semantic', rows: [{ ...entityRow, matchedAlias: null }] },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'entity:ent-1')
})

// ─── AC-SM-003.3: an exact match is not overtaken by recency ────────────────

test('AC-SM-003.3: an older exact-date match outranks a newer non-match', async () => {
  const db = createProductionTestDatabase()
  // Both match the words. Only the older one matches the requested date.
  insertSession(db, 'Quarterly planning session', localMs(2026, 3, 22, 9), 45)
  insertSession(db, 'Quarterly planning follow-up', localMs(2026, 5, 1, 9), 45)
  indexMemoryForDay(db, DATE)
  indexMemoryForDay(db, NEWER_DATE)

  const response = await planRetrieval(db, 'quarterly planning 2026-04-22', { now: NOW })
  assert.ok(response.results.length > 0)
  assert.equal(
    response.results[0].date, DATE,
    'the result matching the requested date ranks first despite being older',
  )
  assert.equal(response.results[0].signals.timeRangeFit, 1)
  db.close()
})

test('AC-SM-003.4: no result carries a productivity or focus ranking input', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Quarterly planning session', localMs(2026, 3, 22, 9), 45)
  indexMemoryForDay(db, DATE)

  const response = await planRetrieval(db, 'quarterly planning', { now: NOW })
  assert.ok(response.results.length > 0)
  for (const result of response.results) {
    assert.deepEqual(Object.keys(result.signals).sort(), [
      'confirmedRelationship', 'corroboration', 'entityMatch', 'exactLexical',
      'explicitCorrection', 'queryImpliedRecency', 'semanticSimilarity',
      'sourceQuality', 'timeRangeFit',
    ])
  }
  db.close()
})

// ─── Response shape ─────────────────────────────────────────────────────────

test('an empty query returns an empty plan without touching the readers', async () => {
  const db = createProductionTestDatabase()
  const response = await planRetrieval(db, '   ', { now: NOW })
  assert.deepEqual(response.results, [])
  assert.deepEqual(response.plan.paths, [])
  assert.equal(response.degraded, false)
  db.close()
})

test('every result carries the context a result card needs', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Quarterly planning session', localMs(2026, 3, 22, 9), 45)
  indexMemoryForDay(db, DATE)

  const response = await planRetrieval(db, 'quarterly planning', { now: NOW })
  assert.ok(response.results.length > 0)
  for (const result of response.results) {
    assert.ok(result.title.length > 0, 'a direct title')
    assert.ok(result.date.length > 0, 'its day')
    assert.ok(result.matchExplanation.length > 0, 'why it matched')
    assert.ok(result.sourceType.length > 0, 'its source type')
    assert.ok(result.foundBy.length > 0, 'which paths produced it')
    assert.ok(result.representations.length > 0, 'the evidence behind it')
  }
  db.close()
})
