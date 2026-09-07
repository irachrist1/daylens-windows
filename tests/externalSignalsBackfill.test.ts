// On-demand historical backfill (the "73-commit release day" bug): the
// background collector only walks today and yesterday, so a day from months
// ago never gets external_signals rows. ensureExternalSignalsForDate collects
// once for such a date through the production path, records "collected,
// nothing found" in the scan ledger so a commit-less day is never re-scanned
// on every wrap, and degrades every failure to "no enrichment".
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  collectExternalSignals,
  ensureExternalSignalsForDate,
  getExternalSignal,
  hasExternalSignalScan,
  registerExternalSignalBackfill,
  runExternalSignalBackfill,
  type CollectExternalSignalsDeps,
} from '../src/main/services/externalSignals.ts'
import { collectCalendarEvents } from '../src/main/services/calendarSignals.ts'
import { localDateString, shiftLocalDateString } from '../src/main/lib/localDate.ts'
import type { FocusAppSignal, GitActivitySignal } from '../src/shared/types.ts'

// A finished day far behind the rolling today/yesterday window.
const PAST_DATE = '2026-04-03'

const GIT_SIGNAL: GitActivitySignal = {
  repos: [{ repo: 'daylens', commitCount: 73, messages: ['ship the release'], firstCommitClock: '9:12am', lastCommitClock: '11:30pm' }],
  totalCommits: 73,
  prs: [],
}

function makeDb(withScanLedger = true): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE external_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, source TEXT NOT NULL,
      payload_json TEXT NOT NULL, captured_at INTEGER NOT NULL,
      UNIQUE(date, source)
    );
  `)
  if (withScanLedger) {
    db.exec(`
      CREATE TABLE external_signal_scans (
        date       TEXT NOT NULL,
        source     TEXT NOT NULL,
        scanned_at INTEGER NOT NULL,
        PRIMARY KEY (date, source)
      );
    `)
  }
  return db
}

/** Injected connectors that count every invocation, whatever they return —
 *  the counters are how the idempotency tests prove "no re-collection". */
function countingDeps(
  db: Database.Database,
  results: {
    git?: () => Promise<GitActivitySignal | null>
    focus?: () => Promise<FocusAppSignal[] | null>
    enrichmentSources?: Record<string, boolean>
    isConsentCurrent?: () => boolean
  } = {},
): CollectExternalSignalsDeps & { calls: Record<'git' | 'calendar' | 'focus', number> } {
  const calls = { git: 0, calendar: 0, focus: 0 }
  return {
    db,
    collectGit: async () => { calls.git += 1; return results.git ? await results.git() : null },
    collectCalendar: async () => { calls.calendar += 1; return null },
    collectFocus: async () => { calls.focus += 1; return results.focus ? await results.focus() : null },
    enrichmentSources: results.enrichmentSources ?? {},
    isConsentCurrent: results.isConsentCurrent ?? (() => true),
    calls,
  }
}

// ─── Backfill for a missing historical date ───────────────────────────────────

test('a historical date with no stored rows collects through the production path', async () => {
  const db = makeDb()
  const deps = countingDeps(db, { git: async () => GIT_SIGNAL })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  const stored = getExternalSignal<GitActivitySignal>(db, PAST_DATE, 'git')
  assert.equal(stored?.payload.totalCommits, 73, 'the release day\'s commits are now stored')
  assert.equal(deps.calls.calendar, 1, 'every connector gets one shot at the date')
  db.close()
})

test('idempotent: a second wrap of the same day re-runs no connector', async () => {
  const db = makeDb()
  const deps = countingDeps(db, { git: async () => GIT_SIGNAL })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.deepEqual(deps.calls, { git: 1, calendar: 1, focus: 1 })
  db.close()
})

test('idempotent: a commit-less day is scanned once, remembered, never re-collected', async () => {
  const db = makeDb()
  const deps = countingDeps(db)
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  // Nothing found → no rows, but the scan ledger remembers the connectors ran.
  assert.equal(getExternalSignal(db, PAST_DATE, 'git'), null)
  assert.ok(hasExternalSignalScan(db, PAST_DATE, 'git'))
  assert.ok(hasExternalSignalScan(db, PAST_DATE, 'calendar'))
  assert.ok(hasExternalSignalScan(db, PAST_DATE, 'focus_app'))

  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.deepEqual(deps.calls, { git: 1, calendar: 1, focus: 1 }, 'the second wrap re-runs nothing')
  db.close()
})

test('a live day never records a scan: the finished day can still collect tomorrow', async () => {
  const db = makeDb()
  const today = localDateString()
  await collectExternalSignals(today, { deps: countingDeps(db) })
  assert.equal(hasExternalSignalScan(db, today, 'git'), false)
  assert.equal(hasExternalSignalScan(db, today, 'calendar'), false)
  db.close()
})

test('yesterday is never ledgered: late-arriving data can still enter its wrap', async () => {
  const db = makeDb()
  const yesterday = shiftLocalDateString(localDateString(), -1)
  const empty = countingDeps(db)
  await ensureExternalSignalsForDate(db, yesterday, { deps: empty })
  assert.equal(hasExternalSignalScan(db, yesterday, 'git'), false)
  assert.equal(hasExternalSignalScan(db, yesterday, 'calendar'), false)

  // The next pass re-collects — commits fetched this morning from another
  // machine, or a calendar store that synced after wake, still land.
  const arriving = countingDeps(db, { git: async () => GIT_SIGNAL })
  await ensureExternalSignalsForDate(db, yesterday, { deps: arriving })
  assert.equal(arriving.calls.git, 1)
  assert.equal(getExternalSignal<GitActivitySignal>(db, yesterday, 'git')?.payload.totalCommits, 73)
  db.close()
})

// ─── Disabled connectors ──────────────────────────────────────────────────────

test('without current consent no connector runs and nothing is marked scanned', async () => {
  const db = makeDb()
  const deps = countingDeps(db, { isConsentCurrent: () => false })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.deepEqual(deps.calls, { git: 0, calendar: 0, focus: 0 })
  assert.equal(hasExternalSignalScan(db, PAST_DATE, 'git'), false, 'a run that never happened is not remembered as one')
  db.close()
})

test('a disabled focus app stores nothing on backfill, and the day is not re-scanned', async () => {
  const db = makeDb()
  const deps = countingDeps(db, {
    focus: async () => [{ app: 'Session', sessions: [{ startClock: '9am', durationMinutes: 50, label: null }] }],
    enrichmentSources: { 'focus:Session': false },
  })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.equal(getExternalSignal(db, PAST_DATE, 'focus_app'), null, 'a disabled app\'s data is never stored')
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.deepEqual(deps.calls, { git: 1, calendar: 1, focus: 1 })
  db.close()
})

// ─── Failure and boundedness ──────────────────────────────────────────────────

test('a throwing connector never breaks the wrap path and stays retryable', async () => {
  const db = makeDb()
  const deps = countingDeps(db, { git: async () => { throw new Error('git exploded') } })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.equal(getExternalSignal(db, PAST_DATE, 'git'), null)
  assert.equal(hasExternalSignalScan(db, PAST_DATE, 'git'), false, 'a transient failure is not "collected, empty"')
  assert.ok(hasExternalSignalScan(db, PAST_DATE, 'calendar'), 'the other connectors still complete')

  // The next wrap retries ONLY the failed connector.
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.deepEqual(deps.calls, { git: 2, calendar: 1, focus: 1 })
  db.close()
})

test('a hanging collection is bounded: the wrap proceeds, the rows land in the background', async () => {
  const db = makeDb()
  let releaseGit: (signal: GitActivitySignal) => void = () => {}
  const hung = new Promise<GitActivitySignal>((resolve) => { releaseGit = resolve })
  const deps = countingDeps(db, { git: () => hung })

  const started = Date.now()
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps, timeoutMs: 30 })
  assert.ok(Date.now() - started < 2_000, 'the wrap is not held hostage by a slow connector')
  assert.equal(getExternalSignal(db, PAST_DATE, 'git'), null, 'nothing stored yet — the connector is still running')

  // The connector finishes after the wrap gave up waiting: its result still
  // lands and is there for the next open.
  releaseGit(GIT_SIGNAL)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(getExternalSignal<GitActivitySignal>(db, PAST_DATE, 'git')?.payload.totalCommits, 73)
  db.close()
})

test('a pre-v68 DB without the scan ledger still backfills, just without the empty-day memo', async () => {
  const db = makeDb(false)
  const deps = countingDeps(db, { git: async () => GIT_SIGNAL })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps })
  assert.equal(getExternalSignal<GitActivitySignal>(db, PAST_DATE, 'git')?.payload.totalCommits, 73)
  assert.equal(hasExternalSignalScan(db, PAST_DATE, 'calendar'), false, 'no ledger reads as never-scanned, never an error')
  db.close()
})

test('real connector chain: missing EventKit helper does NOT ledger, a genuine empty run does', async () => {
  const db = makeDb()
  // Helper missing → collectCalendarEvents throws → the day stays
  // collectable: granting Calendar later can still enrich it.
  const unavailable = countingDeps(db)
  unavailable.collectCalendar = (date) => collectCalendarEvents(date, {
    platform: 'darwin',
    resolveHelper: () => null,
  })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps: unavailable })
  assert.equal(hasExternalSignalScan(db, PAST_DATE, 'calendar'), false, 'an unchecked day is never remembered as empty')

  // Helper present, ran, found nothing → a real answer, ledgered.
  const emptyRun = countingDeps(db)
  emptyRun.collectCalendar = (date) => collectCalendarEvents(date, {
    platform: 'darwin',
    resolveHelper: () => '/fake/calendar-helper',
    run: async () => JSON.stringify({ ok: true, events: [] }),
  })
  await ensureExternalSignalsForDate(db, PAST_DATE, { deps: emptyRun })
  assert.ok(hasExternalSignalScan(db, PAST_DATE, 'calendar'), 'a run that happened and found nothing is remembered')
  db.close()
})

// ─── The registry the wrap/Analyze pipelines call ─────────────────────────────

test('runExternalSignalBackfill is a no-op until production wiring registers a runner', async () => {
  await runExternalSignalBackfill(PAST_DATE) // must not throw
})

test('a rejecting registered runner degrades to no enrichment, never a crash', async () => {
  let ran = 0
  registerExternalSignalBackfill(async () => { ran += 1; throw new Error('collection down') })
  await runExternalSignalBackfill(PAST_DATE)
  assert.equal(ran, 1)
  // Leave a harmless runner behind: the registry is module-global.
  registerExternalSignalBackfill(async () => {})
})
