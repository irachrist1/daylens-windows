// DEV-181: the context packet — the typed, recorded, deterministic bundle an
// AI exchange starts from, assembled and inspected WITHOUT calling any model.
//
// Proves the ticket's acceptance criteria end to end on a production database:
//   1. determinism — the same request against the same facts under the same
//      policy version assembles the same packet (only the packet id and
//      assembled-at timestamp differ), proved by items and content
//      fingerprint;
//   2. representative-day fixtures — for each fixture question, the assembled
//      packet contains the expected facts and never contains excluded,
//      deleted, or unauthorized content (fixture-verified, reusing the
//      tests/timeline-eval capture-events fixtures end to end);
//   3. the disclosure record exists before any request would leave the device
//      — the packet row persists with no message binding, and file-excerpt
//      items land in the DEV-184 file_disclosures ledger at record time;
//   4. inspectability — resolved time and entities, corrected facts, evidence
//      with sensitivity, conflicts, gaps, permissions, and per-item
//      identity/version/source-type/reason are all present on the structure
//      and round-trip through persistence.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { setTestDb, clearTestDb } from './support/database-stub.mjs'
import {
  isCaptureEventsDayFixture,
  isNormalizedEvidenceDayFixture,
  loadDayFixtures,
  type CaptureEventsDayFixture,
  type DayFixture,
  type NormalizedEvidenceDayFixture,
} from './support/dayFixture.ts'
import { driveCaptureDay, fixtureClockMs } from './support/captureDay.ts'
import { projectDay } from '../src/main/core/projections/chunk2.ts'
import { materializeTimelineDayProjection } from '../src/main/core/query/projections.ts'
import {
  invalidateTimelineDayBlocks,
  userVisibleLabelForBlock,
  writeTimelineBlockReview,
} from '../src/main/services/workBlocks.ts'
import { writeAIBlockLabel } from '../src/main/db/queries.ts'
import {
  deleteHistoryForApp,
  deleteHistoryForSite,
} from '../src/main/services/trackingHistory.ts'
import { putExternalSignal } from '../src/main/services/externalSignals.ts'
import { addWorkMemoryFact } from '../src/main/services/workMemoryProfile.ts'
import {
  buildContextPacket,
  recordContextPacket,
  linkContextPacketToMessage,
  getContextPacketById,
  getContextPacketForMessage,
  listContextPackets,
  fileMatchesQuestion,
  questionAttachesDayFacts,
  questionAttachesRetrieval,
  renderContextPacketForPrompt,
  resolveContextDates,
  CONTEXT_POLICY_VERSION,
} from '../src/main/services/contextPacket.ts'
import { indexMemoryForDay } from '../src/main/services/memoryIndex.ts'
import {
  addFileAccessGrant,
  revokeFileAccessGrant,
  storeDerivedText,
  listFileDisclosures,
} from '../src/main/services/fileAccess.ts'

const DATE = '2026-04-22'
const NOW = new Date(2026, 3, 23, 12, 0, 0, 0)

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertSession(
  db: Database.Database,
  title: string,
  startHour: number,
  startMinute: number,
  durationMinutes: number,
): void {
  const startTime = localMs(startHour, startMinute)
  db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, capture_source, capture_version
    ) VALUES ('com.mitchellh.ghostty', 'Ghostty', ?, ?, ?, 'development', 1, ?, 'Ghostty', 'test', 1)
  `).run(
    startTime,
    startTime + durationMinutes * 60_000,
    durationMinutes * 60,
    title,
  )
}

const DESTINATION = 'anthropic:test-model'

test('resolveContextDates: explicit ISO dates and "yesterday" resolve deterministically; default is today', () => {
  assert.deepEqual(resolveContextDates('what happened on 2026-04-22?', NOW), ['2026-04-22'])
  assert.deepEqual(resolveContextDates('compare 2026-04-22 and 2026-04-20', NOW), ['2026-04-20', '2026-04-22'])
  assert.deepEqual(resolveContextDates('what did I do yesterday', NOW), ['2026-04-22'])
  assert.deepEqual(resolveContextDates('what did I do', NOW), ['2026-04-23'])
})

test('greetings skip retrieval; day dumps need a day question or an explicit range', () => {
  assert.equal(questionAttachesRetrieval('hi'), false)
  assert.equal(questionAttachesRetrieval('hello there'), false)
  assert.equal(questionAttachesRetrieval('thanks'), false)
  assert.equal(questionAttachesRetrieval('what did we decide in the granola meeting'), true)
  const today = { startDate: '2026-04-23', endDate: '2026-04-23', dates: ['2026-04-23'], resolution: 'default' as const }
  const asked = { startDate: '2026-04-22', endDate: '2026-04-22', dates: ['2026-04-22'], resolution: 'explicit' as const }
  assert.equal(questionAttachesDayFacts('hi', today), false)
  assert.equal(questionAttachesDayFacts('what did we decide in the granola meeting', today), false)
  assert.equal(questionAttachesDayFacts('retrieval planner', today), false)
  assert.equal(questionAttachesDayFacts('what did I do today', today), true)
  assert.equal(questionAttachesDayFacts('How did my day go?', today), true)
  assert.equal(questionAttachesDayFacts('show me my day', today), true)
  assert.equal(questionAttachesDayFacts("how's my day", today), true)
  assert.equal(questionAttachesDayFacts('retrieval planner', asked), true)
})

test('file matching requires a whole token, not a substring', () => {
  assert.equal(fileMatchesQuestion('started-writing.md', 'I started writing.', ['art']), false)
  assert.equal(fileMatchesQuestion('product-catalog.md', 'a catalog of widgets', ['log']), false)
  assert.equal(fileMatchesQuestion('runtime-notes.md', 'runtime errors', ['run']), false)
  assert.equal(fileMatchesQuestion('error-log.md', 'the log from deploy', ['log']), true)
  assert.equal(fileMatchesQuestion('modern-art.md', 'notes on modern art', ['art']), true)
  assert.equal(fileMatchesQuestion('granola-kickoff.md', 'Agenda for the Granola kickoff.', ['granola']), true)
})

test('a greeting attaches almost no context even on a busy day with granted files', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Refactoring the retrieval planner', 9, 0, 45)
  insertSession(db, 'Reading an Obsidian essay about meetings', 14, 0, 30)
  indexMemoryForDay(db, DATE)
  const grant = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/Obsidian/personal-essay-7f3a9c.md',
    state: 'model_readable',
  })
  storeDerivedText(db, grant.id, 'A long personal journal about meetings, granola breakfasts, and notes from last week.')

  const packet = await buildContextPacket(db, {
    purpose: 'answer',
    question: 'hi',
    now: NOW,
    destination: DESTINATION,
  })
  assert.equal(packet.items.length, 0, 'hi does not dump the day, search hits, or files')
  assert.deepEqual(packet.gaps, [])
  assert.deepEqual(packet.conflicts, [])
  assert.deepEqual(packet.permissions, [])
  db.close()
})

test('a Granola question does not attach unrelated Obsidian files that merely mention meetings', async () => {
  const db = createProductionTestDatabase()
  const unrelated = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/Obsidian/personal-essay-7f3a9c.md',
    state: 'model_readable',
  })
  storeDerivedText(db, unrelated.id, 'A diary entry about a meeting with friends and some notes.')
  const related = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/notes/granola-kickoff.md',
    state: 'model_readable',
  })
  storeDerivedText(db, related.id, 'Agenda for the Granola kickoff.')

  const packet = await buildContextPacket(db, {
    purpose: 'answer',
    question: 'what did we decide in the granola meeting',
    now: NOW,
    destination: DESTINATION,
  })
  const files = packet.items.filter((item) => item.kind === 'file_excerpt')
  assert.equal(files.length, 1)
  assert.equal(files[0]?.identity, 'file:/home/person/notes/granola-kickoff.md')
  db.close()
})

test('everyday day questions attach today’s timeline facts', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Refactoring the retrieval planner', 9, 0, 45)
  indexMemoryForDay(db, DATE)
  const dayNow = new Date(2026, 3, 22, 18, 0, 0, 0)
  for (const question of ['How did my day go?', 'show me my day']) {
    const packet = await buildContextPacket(db, {
      purpose: 'answer',
      question,
      now: dayNow,
      destination: DESTINATION,
    })
    assert.ok(
      packet.items.some((item) => item.kind === 'day_fact' || item.kind === 'search_exact'),
      `"${question}" still receives the day’s facts`,
    )
    assert.ok(packet.gaps.length > 0 || packet.items.length > 0)
  }
  db.close()
})

test('short question tokens do not fill the file-excerpt budget with substring hits', async () => {
  const db = createProductionTestDatabase()
  const decoys = [
    ['/home/person/notes/aaa-started.md', 'I started writing this morning.'],
    ['/home/person/notes/bbb-started.md', 'We started the catalog later.'],
    ['/home/person/notes/ccc-catalog.md', 'A catalog of runtime notes.'],
    ['/home/person/notes/ddd-runtime.md', 'runtime setup after we started.'],
    ['/home/person/notes/eee-started.md', 'started another catalog page.'],
  ] as const
  for (const [path, text] of decoys) {
    const grant = addFileAccessGrant(db, { scopeKind: 'file', path, state: 'model_readable' })
    storeDerivedText(db, grant.id, text)
  }
  const relevant = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/notes/fff-art.md',
    state: 'model_readable',
  })
  storeDerivedText(db, relevant.id, 'Notes on the art of retrieval.')

  const packet = await buildContextPacket(db, {
    purpose: 'answer',
    question: 'the art log',
    now: NOW,
    destination: DESTINATION,
  })
  const files = packet.items.filter((item) => item.kind === 'file_excerpt')
  assert.deepEqual(files.map((item) => item.identity), ['file:/home/person/notes/fff-art.md'])
  db.close()
})

test('a day question still attaches timeline facts for the asked day', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Refactoring the retrieval planner', 9, 0, 45)
  indexMemoryForDay(db, DATE)
  const packet = await buildContextPacket(db, {
    purpose: 'answer',
    question: 'what happened on 2026-04-22',
    now: NOW,
    destination: DESTINATION,
  })
  assert.ok(
    packet.items.some((item) => item.kind === 'day_fact' || item.kind === 'search_exact'),
    'a day question still receives the day’s facts',
  )
  db.close()
})

test('the same question against the same day state assembles the same packet (modulo id and timestamp)', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Refactoring the retrieval planner', 9, 0, 45)
  insertSession(db, 'Reading the sqlite fts5 docs', 14, 0, 30)
  indexMemoryForDay(db, DATE)

  const input = {
    purpose: 'answer' as const,
    question: 'retrieval planner',
    now: NOW,
    destination: DESTINATION,
  }
  const first = await buildContextPacket(db, input)
  const second = await buildContextPacket(db, input)

  assert.equal(first.policyVersion, CONTEXT_POLICY_VERSION)
  assert.ok(
    first.items.some((item) => item.kind === 'search_exact' && item.statement.includes('retrieval planner')),
    'exact retrieval feeds the packet',
  )
  assert.deepEqual(second.items, first.items, 'items are identical across builds')
  assert.deepEqual(second.gaps, first.gaps, 'gaps are identical across builds')
  assert.deepEqual(second.conflicts, first.conflicts)
  assert.deepEqual(second.permissions, first.permissions)
  assert.equal(second.contentFingerprint, first.contentFingerprint, 'same state ⇒ same fingerprint')
  assert.notEqual(second.id, first.id, 'packet identity is per exchange')
  assert.equal(
    renderContextPacketForPrompt(second).replace(second.id, ''),
    renderContextPacketForPrompt(first).replace(first.id, ''),
    'the rendered form is deterministic too',
  )

  // Every item carries the disclosure fields the ledger promises.
  for (const item of first.items) {
    assert.ok(item.identity.includes(':'), `identity is typed: ${item.identity}`)
    assert.ok(item.statement.length > 0)
    assert.ok(item.reason.length > 0)
    assert.ok(['observed', 'connected', 'supplied', 'inferred'].includes(item.sourceType))
    assert.ok(['standard', 'personal', 'high'].includes(item.sensitivity))
  }

  // A search question does not dump today's timeline or its capture gaps.
  assert.deepEqual(first.gaps, [])
  assert.ok(!first.items.some((item) => item.kind === 'day_fact'))

  // Day state change ⇒ different packet.
  insertSession(db, 'Sketching the retrieval planner ranker', 16, 0, 20)
  indexMemoryForDay(db, DATE)
  const third = await buildContextPacket(db, input)
  assert.ok(
    third.items.some((item) => item.statement.includes('ranker')),
    'the new evidence joins the packet',
  )
  assert.notEqual(third.contentFingerprint, first.contentFingerprint, 'new evidence changes the packet')
  db.close()
})

test('guardrails: deleted/ignored content cannot enter a packet; high-sensitivity memory is omitted and recorded', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Morning secret planning', 9, 0, 60)
  insertSession(db, 'Afternoon public work', 14, 0, 60)
  indexMemoryForDay(db, DATE)

  const input = {
    purpose: 'answer' as const,
    question: 'secret planning',
    now: NOW,
    destination: DESTINATION,
  }
  const before = await buildContextPacket(db, input)
  assert.ok(
    before.items.some((item) => item.kind === 'search_exact' && item.statement.includes('secret planning')),
    'the moment is retrievable before any correction',
  )

  // The person deletes the morning block; the day re-projects.
  db.prepare(`
    INSERT INTO timeline_block_reviews (id, block_id, date, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at)
    VALUES ('rev-ignore', 'blk-morning', ?, 'ek', 'ignored', ?, '{}', ?, ?)
  `).run(DATE, JSON.stringify({ startTime: localMs(9), endTime: localMs(10) }), Date.now(), Date.now())
  indexMemoryForDay(db, DATE)

  const afterDeletion = await buildContextPacket(db, input)
  assert.ok(
    !afterDeletion.items.some((item) => item.statement.includes('secret planning')),
    'deleted content cannot enter a packet',
  )
  assert.notEqual(afterDeletion.contentFingerprint, before.contentFingerprint)

  // Undo restores; then marking the record high-sensitivity omits it again —
  // with the omission recorded in the disclosure.
  db.prepare(`DELETE FROM timeline_block_reviews WHERE id = 'rev-ignore'`).run()
  indexMemoryForDay(db, DATE)
  const restored = await buildContextPacket(db, input)
  assert.ok(restored.items.some((item) => item.statement.includes('secret planning')), 'undo restores the item')

  db.prepare(`UPDATE memory_records SET sensitivity = 'high' WHERE statement LIKE '%secret planning%'`).run()
  const afterSensitivity = await buildContextPacket(db, input)
  assert.ok(
    !afterSensitivity.items.some((item) => item.statement.includes('secret planning')),
    'high-sensitivity memory stays out of the packet',
  )
  assert.ok(
    afterSensitivity.disclosure.omissions.some(
      (omission) => omission.reason === 'high-sensitivity' && omission.count >= 1,
    ),
    'the omission is recorded, not silent',
  )
  db.close()
})

test('guardrails: file excerpts need a model-readable grant; high sensitivity needs the explicit flag; revocation stops future packets', async () => {
  const db = createProductionTestDatabase()
  const input = {
    purpose: 'answer' as const,
    question: 'the launch plan pricing',
    now: NOW,
    destination: DESTINATION,
  }

  // No grant → no file content, ever.
  const empty = await buildContextPacket(db, input)
  assert.equal(empty.items.filter((item) => item.kind === 'file_excerpt').length, 0)
  assert.deepEqual(empty.permissions, [], 'no grants ⇒ no permissions consulted')

  // An indexed grant does NOT escalate to model-readable disclosure.
  const indexedGrant = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/notes/launch-plan.md',
    state: 'indexed',
  })
  storeDerivedText(db, indexedGrant.id, 'Launch plan pricing: three tiers, annual billing.')
  const indexedOnly = await buildContextPacket(db, input)
  assert.equal(
    indexedOnly.items.filter((item) => item.kind === 'file_excerpt').length,
    0,
    'indexing never escalates to model disclosure',
  )
  // …but the consulted permission state is inspectable on the packet.
  assert.deepEqual(indexedOnly.permissions, [{
    kind: 'file_access',
    scopeKind: 'file',
    path: '/home/person/notes/launch-plan.md',
    state: 'indexed',
    allowHighSensitivity: false,
  }])

  // A model-readable grant with extracted text is disclosed — with identity
  // and a version fingerprint.
  const grant = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/notes/launch-pricing.md',
    state: 'model_readable',
  })
  storeDerivedText(db, grant.id, 'Launch plan pricing: three tiers, annual billing.')
  const withFile = await buildContextPacket(db, input)
  const fileItem = withFile.items.find((item) => item.kind === 'file_excerpt')
  assert.ok(fileItem, 'the granted file excerpt joins the packet')
  assert.equal(fileItem?.identity, 'file:/home/person/notes/launch-pricing.md')
  assert.ok(fileItem?.version, 'the excerpt carries a version fingerprint')
  assert.ok(fileItem?.statement.includes('three tiers'))

  // High-sensitivity file without the explicit flag: omitted, recorded.
  const secretGrant = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/secrets/launch-passwords.kdbx',
    state: 'model_readable',
  })
  storeDerivedText(db, secretGrant.id, 'launch pricing vault')
  const withSecret = await buildContextPacket(db, input)
  assert.ok(
    !withSecret.items.some((item) => item.identity.includes('launch-passwords')),
    'high-sensitivity files need the explicit permission',
  )
  assert.ok(
    withSecret.disclosure.omissions.some(
      (omission) => omission.kind === 'file_excerpt' && omission.reason === 'high-sensitivity',
    ),
    'the high-sensitivity omission is recorded',
  )

  // Revocation stops future packets immediately.
  revokeFileAccessGrant(db, grant.id)
  const afterRevoke = await buildContextPacket(db, input)
  assert.equal(
    afterRevoke.items.filter((item) => item.kind === 'file_excerpt').length,
    0,
    'a revoked grant cannot feed a packet',
  )
  db.close()
})

test('a person’s correction outranking an automated label is a visible conflict, not a silent pick', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Quarterly report drafting', 9, 0, 60)
  const payload = materializeTimelineDayProjection(db, DATE, null)
  const block = payload.blocks.find((candidate) => !candidate.isLive)
  assert.ok(block, 'the seeded day produced a block')
  writeAIBlockLabel(db, { blockId: block!.id, label: 'Casual reading', narrative: null })
  writeTimelineBlockReview(db, DATE, block!, { state: 'corrected', correctedLabel: 'Board report drafting' })

  const packet = await buildContextPacket(db, {
    purpose: 'answer',
    question: 'what happened on 2026-04-22',
    now: NOW,
    destination: DESTINATION,
  })
  const conflict = packet.conflicts.find((entry) => entry.identity === `block:${block!.id}`)
  assert.ok(conflict, 'the correction-vs-inference disagreement is recorded on the packet')
  assert.equal(conflict?.kind, 'correction_overrides_inference')
  assert.equal(conflict?.resolvedBy, 'correction')
  assert.ok(conflict?.detail.includes('Board report drafting'))
  assert.ok(conflict?.detail.includes('Casual reading'))
  db.close()
})

test('the disclosure record exists before any request would leave; packets bind to messages and round-trip', async () => {
  const db = createProductionTestDatabase()
  insertSession(db, 'Persistence check session', 10, 0, 30)
  indexMemoryForDay(db, DATE)

  const grant = addFileAccessGrant(db, {
    scopeKind: 'file',
    path: '/home/person/notes/persistence-check.md',
    state: 'model_readable',
  })
  storeDerivedText(db, grant.id, 'persistence check notes')

  const packet = await buildContextPacket(db, {
    purpose: 'answer',
    question: 'persistence check',
    now: NOW,
    destination: DESTINATION,
  })
  assert.ok(packet.items.some((item) => item.kind === 'file_excerpt'))
  recordContextPacket(db, packet, { exchangeKind: 'chat', threadId: 7 })

  const byId = getContextPacketById(db, packet.id)
  assert.ok(byId, 'the packet is durable')
  assert.equal(byId?.exchangeKind, 'chat')
  assert.equal(byId?.threadId, 7)
  assert.equal(byId?.messageId, null, 'the record exists BEFORE any exchange message — nothing has left yet')
  assert.deepEqual(byId?.packet.items, packet.items, 'the full item list round-trips')
  assert.deepEqual(byId?.packet.permissions, packet.permissions, 'permissions round-trip')
  assert.deepEqual(byId?.packet.gaps, packet.gaps, 'gaps round-trip')
  assert.equal(byId?.packet.contentFingerprint, packet.contentFingerprint)
  assert.equal(byId?.destination, DESTINATION)

  // The file-excerpt disclosure also landed in the DEV-184 ledger.
  const disclosures = listFileDisclosures(db)
  assert.ok(
    disclosures.some(
      (row) => row.file_path === '/home/person/notes/persistence-check.md'
        && row.reason.includes(packet.id)
        && row.destination === DESTINATION,
    ),
    'file excerpts in a packet are recorded in file_disclosures too',
  )

  // Binding to a persisted exchange message makes "what did the model see for
  // this answer" a single lookup (the batch-10 inspector's path).
  linkContextPacketToMessage(db, packet.id, 4242)
  assert.equal(getContextPacketForMessage(db, 4242)?.id, packet.id)
  assert.equal(getContextPacketById(db, packet.id)?.messageId, 4242)

  assert.equal(listContextPackets(db, { exchangeKind: 'chat' }).length, 1)
  assert.equal(listContextPackets(db, { exchangeKind: 'day_analysis' }).length, 0)
  db.close()
})

// ─── Representative-day fixtures ─────────────────────────────────────────────
// Acceptance criterion: "For each representative-day fixture question, an
// assembled packet contains the expected facts and never contains excluded,
// deleted, or unauthorized content." The fixtures are the existing
// tests/timeline-eval capture-events days — driven end to end from the source
// boundary (capture → projection → mutations), exactly like the
// representative-day suite, then the packet is assembled per fixture question
// with NO model call anywhere.

const HERE = path.dirname(fileURLToPath(import.meta.url))
type PacketFixture = CaptureEventsDayFixture | NormalizedEvidenceDayFixture
const FIXTURES: PacketFixture[] = loadDayFixtures(path.join(HERE, 'timeline-eval', 'fixtures'))
  .filter((fixture): fixture is PacketFixture =>
    isCaptureEventsDayFixture(fixture) || isNormalizedEvidenceDayFixture(fixture))
  .filter((fixture) => fixture.id !== 'reference-workday')
  .filter((fixture) =>
    (fixture.expected?.search?.length ?? 0) > 0
    || (fixture.expected?.privacy?.prohibitedTerms?.length ?? 0) > 0)

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function includesTerm(haystack: string, term: string): boolean {
  return normalize(haystack).includes(normalize(term))
}

/** A prohibited term whose leak is a known deferred defect (e.g. DEV-214's
 *  Timeline leak) is skipped here too — the packet reads the same corrected
 *  surfaces, so it inherits exactly the same deferral, no more. */
function termHasDeferredLeak(fixture: DayFixture, term: string): boolean {
  return (fixture.expected?.knownIssues ?? []).some((deferral) =>
    deferral.defectSignatures.some((signature) => signature.includes(`"${term}"`)))
}

/** Normalized-evidence fixtures seed the canonical evidence tables directly
 *  (the same inserts the timeline-eval runner performs). */
function seedNormalizedEvidence(db: Database.Database, fixture: NormalizedEvidenceDayFixture): void {
  const insertSessionRow = db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec, category,
      is_focused, window_title, raw_app_name, canonical_app_id, app_instance_id,
      capture_source, ended_reason, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'timeline_eval_fixture', NULL, 2)
  `)
  for (const session of fixture.input.sessions) {
    const startTime = fixtureClockMs(fixture, session.start)
    const endTime = fixtureClockMs(fixture, session.end)
    insertSessionRow.run(
      session.bundleId,
      session.appName,
      startTime,
      endTime,
      Math.max(1, Math.round((endTime - startTime) / 1000)),
      session.category,
      session.title ?? null,
      session.appName,
      session.bundleId,
      session.bundleId,
    )
  }
  const insertVisit = db.prepare(`
    INSERT INTO website_visits (
      domain, page_title, url, visit_time, visit_time_us, duration_sec,
      browser_bundle_id, canonical_browser_id, normalized_url, page_key, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'timeline_eval_fixture')
  `)
  for (const [index, visit] of (fixture.input.browserEvidence ?? []).entries()) {
    const visitTime = fixtureClockMs(fixture, visit.at)
    const durationSeconds = visit.durationSeconds ?? Math.round((visit.durationMinutes ?? 1) * 60)
    insertVisit.run(
      visit.domain,
      visit.title ?? null,
      visit.url,
      visitTime,
      visitTime * 1000 + index,
      durationSeconds,
      visit.browserBundleId ?? null,
      visit.canonicalBrowserId ?? visit.browserBundleId ?? null,
      visit.url,
      visit.url,
    )
  }
  const insertEvent = db.prepare(`
    INSERT INTO activity_state_events (event_ts, event_type, source, metadata_json)
    VALUES (?, ?, 'timeline_eval_fixture', '{}')
  `)
  for (const event of fixture.input.activityEvents ?? []) {
    insertEvent.run(fixtureClockMs(fixture, event.at), event.type)
  }
}

async function seedFixtureDay(db: Database.Database, fixture: PacketFixture): Promise<void> {
  if (isCaptureEventsDayFixture(fixture)) {
    await driveCaptureDay(db, fixture)
    const projection = projectDay(db, fixture.date, {
      finalize: true,
      now: new Date(fixtureClockMs(fixture, '23:59')),
    })
    assert.equal(projection.skipped, false, `${fixture.id}: projection skipped`)
  } else {
    seedNormalizedEvidence(db, fixture)
  }

  if (fixture.context?.calendar) {
    putExternalSignal(db, fixture.date, 'calendar', fixture.context.calendar)
  }
  for (const fact of fixture.context?.memoryFacts ?? []) addWorkMemoryFact(db, fact)

  const timeline = materializeTimelineDayProjection(db, fixture.date, null)
  for (const mutation of fixture.mutations ?? []) {
    if (mutation.kind === 'excludeAndPurgeApp') {
      const purged = deleteHistoryForApp({
        appName: mutation.appName ?? null,
        bundleId: mutation.bundleId ?? null,
      })
      assert.ok(purged.deletedRows > 0, `${fixture.id}: purge deleted nothing`)
    } else if (mutation.kind === 'excludeAndPurgeSite') {
      const purged = deleteHistoryForSite({ domain: mutation.domain })
      assert.ok(purged.deletedRows > 0, `${fixture.id}: site purge deleted nothing`)
    } else {
      const block = timeline.blocks.find((candidate) =>
        mutation.matchLabelIncludes.some((term) =>
          includesTerm(userVisibleLabelForBlock(candidate), term)))
      assert.ok(block, `${fixture.id}: no block matches ${mutation.matchLabelIncludes.join(', ')}`)
      writeTimelineBlockReview(
        db,
        fixture.date,
        block,
        mutation.kind === 'ignoreBlock'
          ? { state: 'ignored' }
          : {
              state: mutation.state ?? 'corrected',
              correctedLabel: mutation.correctedLabel,
              correctedIntentRole: mutation.correctedIntentRole,
              correctedIntentSubject: mutation.correctedIntentSubject,
              correctedCategory: mutation.correctedCategory,
            },
      )
    }
  }
  if ((fixture.mutations ?? []).length > 0) {
    invalidateTimelineDayBlocks(db, fixture.date)
    materializeTimelineDayProjection(db, fixture.date, null)
  }
}

for (const fixture of FIXTURES) {
  test(`representative day ${fixture.id}: packets contain the expected facts and never the excluded/deleted content`, async () => {
    const db = createProductionTestDatabase()
    setTestDb(db)
    try {
      await seedFixtureDay(db, fixture)

      const questions = (fixture.expected?.search ?? []).map((entry) => ({
        question: entry.query,
        requiredFacts: entry.requiredFacts ?? [],
        prohibitedFacts: entry.prohibitedFacts ?? [],
      }))
      // Fixtures with only privacy expectations still get a generic question,
      // so the excluded/deleted proof runs over a real packet.
      if (questions.length === 0) {
        questions.push({ question: 'what did I do', requiredFacts: [], prohibitedFacts: [] })
      }

      for (const entry of questions) {
        const packet = await buildContextPacket(db, {
          purpose: 'answer',
          question: entry.question,
          dates: [fixture.date],
          now: new Date(fixtureClockMs(fixture, '23:59')),
          destination: DESTINATION,
        })

        // Expected facts are present…
        const itemsHaystack = JSON.stringify(packet.items)
        for (const fact of entry.requiredFacts) {
          assert.ok(
            includesTerm(itemsHaystack, fact),
            `${fixture.id}: packet for "${entry.question}" missing "${fact}"`,
          )
        }
        // …unauthorized cross-scope facts are not among the retrieval hits…
        const retrievalHaystack = JSON.stringify(
          packet.items.filter((item) => item.kind === 'search_exact' || item.kind === 'search_semantic'),
        )
        for (const fact of entry.prohibitedFacts) {
          assert.ok(
            !includesTerm(retrievalHaystack, fact),
            `${fixture.id}: packet retrieval for "${entry.question}" must not return "${fact}"`,
          )
        }
        // …and excluded/deleted content appears NOWHERE in the whole packet.
        const packetHaystack = JSON.stringify(packet)
        for (const term of fixture.expected?.privacy?.prohibitedTerms ?? []) {
          if (termHasDeferredLeak(fixture, term)) continue
          assert.ok(
            !includesTerm(packetHaystack, term),
            `${fixture.id}: excluded/deleted "${term}" leaked into the packet for "${entry.question}"`,
          )
        }

        // The disclosure record is persistable before anything would leave.
        recordContextPacket(db, packet, { exchangeKind: 'chat', threadId: null })
        assert.ok(getContextPacketById(db, packet.id), `${fixture.id}: packet did not persist`)
      }
    } finally {
      clearTestDb()
      db.close()
    }
  })
}
