// External signals — the Wrapped data layer's optional connectors.
//
// The wrap has always known how long the user stared at apps; these connectors
// tell it what was actually produced: git commits and PR activity, calendar
// meetings, focus-app sessions. Each connector is independent and optional —
// unavailable, unpermissioned, or erroring sources skip SILENTLY and the day
// simply has no row for that source. Nothing here may ever throw out of
// collectExternalSignals, block the wrap, or touch the network beyond the
// user's own authenticated CLIs (gh).
//
// Results persist in external_signals keyed by (date, source): a re-run
// replaces the day's row, so the table always holds the freshest read.

import type Database from 'better-sqlite3'
import type { ExternalSignalSource, StoredExternalSignal } from '@shared/types'
import { ANALYTICS_EVENT } from '@shared/analytics'
import { getDb } from './database'
import { capture } from './analytics'
import { getSettings } from './settings'
import { collectGitActivity } from './gitSignals'
import { collectCalendarEvents } from './calendarSignals'
import { collectFocusAppSignals } from './enrichmentDiscovery'
import { localDateString, shiftLocalDateString } from '../lib/localDate'
import { isCaptureConsentCurrent } from '@shared/captureConsent'
import { adoptExternalSignalEntities } from './entities/entityAdoption'

// ─── Store ────────────────────────────────────────────────────────────────────

export function putExternalSignal(
  db: Database.Database,
  date: string,
  source: ExternalSignalSource,
  payload: unknown,
): void {
  db.prepare(`
    INSERT INTO external_signals (date, source, payload_json, captured_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, source) DO UPDATE SET
      payload_json = excluded.payload_json,
      captured_at = excluded.captured_at
  `).run(date, source, JSON.stringify(payload), Date.now())
  // DEV-177: the daily refresh REPLACES this (date, source) row, but the
  // durable entities it feeds resolve by source event identity through the
  // entity repository, so meetings and repositories survive the overwrite
  // instead of being re-minted every day. Best-effort — an entity failure
  // never blocks storing the signal (pre-v50 DBs simply skip it).
  try {
    adoptExternalSignalEntities(db, date, source, payload)
  } catch { /* entity adoption is additive; the signal row is the source of truth */ }
}

/** Tombstone a (date, source): remove the stored row so a connector that now
 *  finds nothing can't keep serving yesterday's commits/meetings. Called after a
 *  REAL connector run returns empty/null — never speculatively. */
export function deleteExternalSignal(
  db: Database.Database,
  date: string,
  source: ExternalSignalSource,
): void {
  try {
    db.prepare('DELETE FROM external_signals WHERE date = ? AND source = ?').run(date, source)
  } catch { /* missing table (pre-v43 DB): nothing to tombstone */ }
}

export function getExternalSignal<T>(
  db: Database.Database,
  date: string,
  source: ExternalSignalSource,
): StoredExternalSignal<T> | null {
  // Tolerate a DB from before migration v43 (e.g. an MCP client pointed at an
  // older copy): a missing table means no signal, never an error.
  try {
    const row = db.prepare(`
      SELECT payload_json, captured_at FROM external_signals
      WHERE date = ? AND source = ?
    `).get(date, source) as { payload_json: string; captured_at: number } | undefined
    if (!row) return null
    return { date, source, payload: JSON.parse(row.payload_json) as T, capturedAt: row.captured_at }
  } catch {
    return null
  }
}

// ─── Scan ledger ──────────────────────────────────────────────────────────────
// external_signals only ever stores NON-EMPTY connector results, so on its own
// it cannot distinguish "collected, nothing found" from "never collected". The
// scan ledger records that a connector RAN TO COMPLETION for a settled day,
// even when it found nothing — without it, on-demand backfill would re-run
// git/EventKit on every wrap regeneration of a commit-less historical day.
// Only a connector that genuinely ran and came back empty is ledgered: an
// unavailable or failed connector THROWS (see gitSignals/calendarSignals) and
// is never marked, so granting Calendar later still enriches old days.

export function recordExternalSignalScan(
  db: Database.Database,
  date: string,
  source: ExternalSignalSource,
): void {
  try {
    db.prepare(`
      INSERT INTO external_signal_scans (date, source, scanned_at)
      VALUES (?, ?, ?)
      ON CONFLICT(date, source) DO UPDATE SET scanned_at = excluded.scanned_at
    `).run(date, source, Date.now())
  } catch { /* pre-v68 DB: no ledger — collection stays re-runnable, never an error */ }
}

export function hasExternalSignalScan(
  db: Database.Database,
  date: string,
  source: ExternalSignalSource,
): boolean {
  try {
    return db.prepare(
      'SELECT 1 FROM external_signal_scans WHERE date = ? AND source = ?',
    ).get(date, source) !== undefined
  } catch {
    return false
  }
}

// ─── Collection ───────────────────────────────────────────────────────────────

/** How stale a stored signal may be before a refresh re-runs its connector.
 *  A finished (past) day's signals never go stale — the day can't change. */
const LIVE_DAY_STALE_MS = 30 * 60 * 1000

function isFresh(db: Database.Database, date: string, source: ExternalSignalSource): boolean {
  const stored = getExternalSignal(db, date, source)
  if (stored) {
    if (date < localDateString()) return true
    return Date.now() - stored.capturedAt < LIVE_DAY_STALE_MS
  }
  // No stored row: a finished day the connectors already scanned came back
  // empty ("collected, nothing found") and cannot change — don't re-run its
  // connectors on every wrap. A never-scanned date still collects.
  return date < localDateString() && hasExternalSignalScan(db, date, source)
}

let collecting = false

/** The moving parts of a collection run, injectable so the tombstone/toggle
 *  logic can be tested hermetically without git, a calendar, or a live DB. */
export interface CollectExternalSignalsDeps {
  db: Database.Database
  collectGit: (date: string) => Promise<import('@shared/types').GitActivitySignal | null>
  collectCalendar: (date: string) => Promise<import('@shared/types').CalendarSignal | null>
  collectFocus: (date: string) => Promise<import('@shared/types').FocusAppSignal[] | null>
  enrichmentSources: Record<string, boolean>
  isConsentCurrent: () => boolean
}

function currentConsentIsGranted(): boolean {
  try { return isCaptureConsentCurrent(getSettings().captureConsent) } catch { return false }
}

function defaultDeps(): CollectExternalSignalsDeps {
  const enrichmentSources = (() => {
    try { return getSettings().enrichmentSources ?? {} } catch { return {} as Record<string, boolean> }
  })()
  return {
    db: getDb(),
    collectGit: collectGitActivity,
    collectCalendar: collectCalendarEvents,
    // Only read the local store of a focus app whose toggle is on (privacy: a
    // disabled app's store is never opened).
    collectFocus: (date) => collectFocusAppSignals(date, {}, (app) => enrichmentSources[`focus:${app}`] === true),
    enrichmentSources,
    isConsentCurrent: currentConsentIsGranted,
  }
}

/** Run every available connector for a date and persist what they found.
 *  Fire-and-forget safe: never throws, never blocks a wrap. Returns the list
 *  of sources that produced a signal this run (for telemetry and tests). */
export async function collectExternalSignals(
  date: string,
  options: { force?: boolean; deps?: CollectExternalSignalsDeps } = {},
): Promise<ExternalSignalSource[]> {
  const isConsentCurrent = options.deps?.isConsentCurrent ?? currentConsentIsGranted
  if (!isConsentCurrent()) return []
  if (collecting) return []
  collecting = true
  const fired: ExternalSignalSource[] = []
  try {
    const { db, collectGit, collectCalendar, collectFocus, enrichmentSources } =
      options.deps ?? defaultDeps()

    // Git and calendar are ALWAYS-ON: read whenever the underlying source
    // exists (git/gh, EventKit, Outlook COM), no toggle. Focus apps are
    // opt-in per app via the Settings enrichment toggles (`focus:<app>`).
    const focusEnabledFor = (app: string) => enrichmentSources[`focus:${app}`] === true

    // Tombstone rule (Gap 2): a connector that comes back empty must not keep
    // serving stale data — BUT only on an explicit forced refresh (the user
    // asking to replace truth). A background run that returns empty could just
    // be a transient timeout (git/EventKit slow or missing), so it leaves any
    // prior row intact rather than risk deleting good data.
    const tombstoneIfForced = (source: ExternalSignalSource) => {
      if (options.force) deleteExternalSignal(db, date, source)
    }

    // A connector that ran to completion and found nothing is remembered in
    // the scan ledger, so on-demand backfill never re-runs it. A connector
    // that THREW (tool missing, subprocess timeout/error) is not marked — it
    // stays retryable, so a tool installed later still enriches old days.
    //
    // Only dates STRICTLY OLDER than yesterday enter the ledger. Today and
    // yesterday stay on the refresh cadence: yesterday's data can still be
    // arriving (commits fetched this morning from another machine, a calendar
    // store that syncs after wake), and ledgering its first empty completion
    // would freeze that wrap empty forever.
    //
    // The focus scan is recorded regardless of which `focus:<app>` toggles are
    // on — intentionally: enabling a toggle later does not re-open settled
    // days (the ledger records that the connector ran under the settings of
    // the day it was scanned; a forced refresh bypasses it).
    const ledgerCutoff = shiftLocalDateString(localDateString(), -1)
    const markScanned = (source: ExternalSignalSource) => {
      if (date < ledgerCutoff) recordExternalSignalScan(db, date, source)
    }

    if (options.force || !isFresh(db, date, 'git')) {
      if (!isConsentCurrent()) return fired
      try {
        const git = await collectGit(date)
        if (!isConsentCurrent()) return fired
        if (git && (git.repos.length > 0 || git.prs.length > 0)) {
          putExternalSignal(db, date, 'git', git)
          fired.push('git')
        } else {
          tombstoneIfForced('git')
        }
        markScanned('git')
      } catch { /* optional source — connector threw; leave any prior row intact */ }
    }

    if (options.force || !isFresh(db, date, 'calendar')) {
      if (!isConsentCurrent()) return fired
      try {
        const calendar = await collectCalendar(date)
        if (!isConsentCurrent()) return fired
        if (calendar && calendar.events.length > 0) {
          putExternalSignal(db, date, 'calendar', calendar)
          fired.push('calendar')
        } else {
          tombstoneIfForced('calendar')
        }
        markScanned('calendar')
      } catch { /* optional source — connector threw; leave any prior row intact */ }
    }

    if (options.force || !isFresh(db, date, 'focus_app')) {
      if (!isConsentCurrent()) return fired
      try {
        const focus = await collectFocus(date)
        if (!isConsentCurrent()) return fired
        // Only store the apps the user turned on (belt-and-suspenders: the real
        // collector already reads only enabled apps).
        const enabled = (focus ?? []).filter((f) => focusEnabledFor(f.app))
        if (enabled.length > 0) {
          putExternalSignal(db, date, 'focus_app', enabled)
          fired.push('focus_app')
        } else {
          tombstoneIfForced('focus_app')
        }
        markScanned('focus_app')
      } catch { /* optional source — connector threw; leave any prior row intact */ }
    }

    // Which connectors fired, never the data: tells us what to build next.
    if (fired.length > 0 && isConsentCurrent()) {
      capture(ANALYTICS_EVENT.WRAPPED_EXTERNAL_SOURCES, {
        external_sources: fired,
        source_count: fired.length,
      })
    }
  } catch { /* the whole collection is best-effort */ }
  finally {
    collecting = false
  }
  return fired
}

// ─── On-demand backfill ───────────────────────────────────────────────────────
// The background cadence below only walks today and yesterday, so a day from
// months ago has no external_signals rows and no way to ever get them — a wrap
// of a 73-commit release day couldn't mention a single commit. Backfill runs
// the SAME production collection path for one date when a wrap or Analyze
// touches it: git log --since/--until works arbitrarily far back, and the
// calendar readers (EventKit / Outlook COM) accept any date the local store
// still has synced. Idempotent via the stored rows + scan ledger; bounded so a
// slow repo scan can't hold the wrap hostage (a timed-out collection finishes
// in the background and its rows are there for the next open).

/** The sources collectExternalSignals owns; 'notes' has its own pipeline. */
const BACKFILLED_SOURCES: ExternalSignalSource[] = ['git', 'calendar', 'focus_app']

const BACKFILL_TIMEOUT_MS = 15_000

export async function ensureExternalSignalsForDate(
  db: Database.Database,
  date: string,
  options: { timeoutMs?: number; deps?: CollectExternalSignalsDeps } = {},
): Promise<void> {
  try {
    // Fast path — three sync reads: every source already has a stored row, a
    // completed scan, or (live day) a fresh-enough row. Nothing to do.
    if (BACKFILLED_SOURCES.every((source) => isFresh(db, date, source))) return
    const collection = collectExternalSignals(date, { deps: options.deps })
    let timer: ReturnType<typeof setTimeout> | null = null
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs ?? BACKFILL_TIMEOUT_MS)
    })
    try {
      await Promise.race([collection, expired])
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch { /* backfill is best-effort: no enrichment, never a blocked wrap */ }
}

// Production wiring (index.ts) registers the real backfill; the wrap and
// Analyze pipelines call runExternalSignalBackfill without importing the live
// connectors into their call graph. Nothing registers in the hermetic test
// suite, so it is a no-op there — a unit test of getWrappedNarrative must
// never shell out to git or scan the developer's real repos.
let backfillRunner: ((date: string) => Promise<void>) | null = null

export function registerExternalSignalBackfill(runner: (date: string) => Promise<void>): void {
  backfillRunner = runner
}

/** Run the registered backfill for a date. Never throws, no-op when nothing
 *  is registered — a collection failure degrades to "no enrichment". */
export async function runExternalSignalBackfill(date: string): Promise<void> {
  if (!backfillRunner) return
  try {
    await backfillRunner(date)
  } catch { /* degrade to no enrichment; the wrap proceeds on stored data */ }
}

let scheduled: ReturnType<typeof setInterval> | null = null
let initialScheduled: ReturnType<typeof setTimeout> | null = null

/** Background cadence: first pass a couple of minutes after launch (today and
 *  yesterday), then a refresh every 6 hours. Cheap: connectors early-exit when
 *  the stored signal is fresh. */
export function startExternalSignalCollection(): void {
  if (scheduled || initialScheduled) return
  const run = () => {
    const today = localDateString()
    const yesterday = shiftLocalDateString(localDateString(), -1)
    void collectExternalSignals(yesterday).then(() => collectExternalSignals(today))
  }
  initialScheduled = setTimeout(() => {
    initialScheduled = null
    run()
  }, 2 * 60 * 1000)
  scheduled = setInterval(run, 6 * 60 * 60 * 1000)
}

export function stopExternalSignalCollection(): void {
  if (initialScheduled) { clearTimeout(initialScheduled); initialScheduled = null }
  if (scheduled) { clearInterval(scheduled); scheduled = null }
}
