// DEV-220: durable deletion journal for the pre-update backup restore paths.
//
// Pre-update backups are binary snapshots of the whole userData dir; a
// per-record deletion does NOT scrub them (spec: privacy-retention-and-sync.md
// §Backups). Instead every user-initiated destructive deletion appends a
// replayable command here, and any restore from a backup replays the journal
// against the restored database immediately — so a restore can never resurrect
// deleted data.
//
// Placement is the crux: the journal must survive the restore itself, so it
// cannot live inside the SQLite database (a restore would roll it back) and
// cannot sit anywhere the restore copy-back overwrites. It lives INSIDE the
// backup root (`<userData>/pre-update-backups/deletion-journal.jsonl`), which
// both restore paths already exclude from the copy-back and which the backup
// copy-forward excludes too — so the journal is never captured into a backup
// either. Device-level deletion removes the whole userData tree including the
// backup root, which is when the "backups exist until device deletion"
// disclosure is satisfied.
//
// Kept free of Electron imports (paths are passed in) so the whole
// append/read/replay/prune path is exercisable by the hermetic test suite.

import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { runWithDb } from './database'
import {
  deleteHistoryForApp,
  deleteHistoryForSite,
  deleteTrackedActivity,
  purgeTrackedEvidenceRows,
  purgeTimelineBlockSpanRows,
  type DeleteTrackedActivityInput,
  type PurgeTrackedEvidenceRowsInput,
  type PurgeTimelineBlockSpanInput,
} from './trackingHistory'
import {
  invalidateTimelineDayBlocks,
  writeIgnoredBlockReviewBackstop,
} from './workBlocks'
import { deleteSuppliedFact } from './suppliedMemory'

// Backstop fields are optional so older {fromMs,toMs}-only journal lines still parse.
export type PurgeBlockJournalParams = PurgeTimelineBlockSpanInput & {
  date?: string
  blockId?: string
  evidenceKey?: string
  originalBlockJson?: string
}

export const BACKUP_ROOT_DIRNAME = 'pre-update-backups'
export const DELETION_JOURNAL_FILENAME = 'deletion-journal.jsonl'

// Each entry mirrors the exact parameter shape of the deletion function it
// replays, so replay can call the real implementation verbatim.
export type DeletionJournalEntry =
  | { kind: 'site-history'; recordedAtMs: number; params: { domain: string } }
  | { kind: 'app-history'; recordedAtMs: number; params: { bundleId?: string | null; appName?: string | null } }
  | { kind: 'tracked-activity'; recordedAtMs: number; params: DeleteTrackedActivityInput }
  | { kind: 'purge-evidence'; recordedAtMs: number; params: PurgeTrackedEvidenceRowsInput }
  | { kind: 'purge-block'; recordedAtMs: number; params: PurgeBlockJournalParams }
  | { kind: 'supplied-fact'; recordedAtMs: number; params: { factId: string } }

// Distributive omit so each union member keeps its kind/params pairing.
type WithoutStamp<T> = T extends { recordedAtMs: number } ? Omit<T, 'recordedAtMs'> : never
export type DeletionJournalEntryInput = WithoutStamp<DeletionJournalEntry>

const JOURNAL_ENTRY_KINDS = new Set<DeletionJournalEntry['kind']>([
  'site-history',
  'app-history',
  'tracked-activity',
  'purge-evidence',
  'purge-block',
  'supplied-fact',
])

export function deletionJournalPath(userDataPath: string): string {
  return path.join(userDataPath, BACKUP_ROOT_DIRNAME, DELETION_JOURNAL_FILENAME)
}

// Pure selector for which userData entries a pre-update backup captures: the
// backup root (and with it this journal) is never copied into a backup, so a
// backup can never carry a stale journal back on restore.
export function selectBackupSourceEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry !== BACKUP_ROOT_DIRNAME)
}

// Backup directories are named with an ISO timestamp whose ':' and '.' were
// replaced by '-' (see backupUserDataForUpdate). Returns the epoch ms, or null
// for names that are not backup directories (e.g. this journal file).
export function parseBackupDirTimestampMs(name: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name)
  if (!match) return null
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isFinite(parsed) ? parsed : null
}

// Append one JSON line. Best-effort by design — a journal write must never
// block or fail the deletion the user just confirmed — but loud on failure.
export function appendDeletionJournalEntry(
  userDataPath: string,
  entry: DeletionJournalEntryInput,
  nowMs = Date.now(),
): boolean {
  try {
    const journalPath = deletionJournalPath(userDataPath)
    fs.mkdirSync(path.dirname(journalPath), { recursive: true })
    const record: DeletionJournalEntry = { ...entry, recordedAtMs: nowMs } as DeletionJournalEntry
    fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch (err) {
    console.warn('[deletion-journal] failed to record deletion (a backup restore may resurrect it):', err)
    return false
  }
}

function parseJournalLine(line: string): DeletionJournalEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    if (!JOURNAL_ENTRY_KINDS.has(parsed.kind as DeletionJournalEntry['kind'])) return null
    if (typeof parsed.recordedAtMs !== 'number') return null
    if (!parsed.params || typeof parsed.params !== 'object') return null
    return parsed as unknown as DeletionJournalEntry
  } catch {
    return null
  }
}

// Parse the journal, skipping corrupt lines (a torn write on the final line
// must not invalidate the rest of the journal).
export function readDeletionJournal(userDataPath: string): DeletionJournalEntry[] {
  let raw: string
  try {
    raw = fs.readFileSync(deletionJournalPath(userDataPath), 'utf8')
  } catch {
    return []
  }
  const entries: DeletionJournalEntry[] = []
  for (const line of raw.split('\n')) {
    const entry = parseJournalLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

// Drop entries recorded before cutoffMs: an entry older than the oldest
// retained backup can never resurrect anything, so it carries no value.
// Returns the number of entries removed. Best-effort.
export function pruneDeletionJournalOlderThan(userDataPath: string, cutoffMs: number): number {
  try {
    const journalPath = deletionJournalPath(userDataPath)
    if (!fs.existsSync(journalPath)) return 0
    const entries = readDeletionJournal(userDataPath)
    const kept = entries.filter((entry) => entry.recordedAtMs >= cutoffMs)
    if (kept.length === entries.length) return 0
    const body = kept.map((entry) => JSON.stringify(entry)).join('\n')
    fs.writeFileSync(journalPath, body.length > 0 ? `${body}\n` : '', 'utf8')
    return entries.length - kept.length
  } catch (err) {
    console.warn('[deletion-journal] prune failed:', err)
    return 0
  }
}

export interface DeletionJournalReplayResult {
  replayed: number
  failed: number
}

function replayEntry(db: Database.Database, entry: DeletionJournalEntry): void {
  switch (entry.kind) {
    case 'site-history':
      runWithDb(db, () => deleteHistoryForSite(entry.params))
      break
    case 'app-history':
      runWithDb(db, () => deleteHistoryForApp(entry.params))
      break
    case 'tracked-activity':
      runWithDb(db, () => deleteTrackedActivity(entry.params))
      break
    case 'purge-evidence':
      purgeTrackedEvidenceRows(db, entry.params)
      break
    case 'purge-block': {
      const { fromMs, toMs, date, blockId, evidenceKey, originalBlockJson } = entry.params
      purgeTimelineBlockSpanRows(db, { fromMs, toMs })
      if (
        typeof date === 'string' && date.length > 0
        && typeof blockId === 'string' && blockId.length > 0
        && typeof evidenceKey === 'string' && evidenceKey.length > 0
        && typeof originalBlockJson === 'string' && originalBlockJson.length > 0
      ) {
        writeIgnoredBlockReviewBackstop(db, { date, blockId, evidenceKey, originalBlockJson })
        invalidateTimelineDayBlocks(db, date)
      }
      break
    }
    // DEV-185: a deleted supplied fact must not resurrect from a backup
    // restore. Fact ids are stable, so replay deletes by id — a no-op when
    // the restored database never had (or already lost) the fact.
    case 'supplied-fact':
      deleteSuppliedFact(db, entry.params.factId)
      break
    // 'connector-purge' entries from the removed OAuth connector feature are
    // no longer in JOURNAL_ENTRY_KINDS, so old journal lines parse to null
    // and are skipped rather than failing replay.
  }
}

// Re-run every journaled deletion against the given (freshly restored)
// database, oldest first. Replay is idempotent — every underlying deletion is
// a no-op when its rows are already absent — and a single failing entry never
// aborts the rest: log, count, continue.
export function replayDeletionJournal(db: Database.Database, userDataPath: string): DeletionJournalReplayResult {
  const entries = readDeletionJournal(userDataPath)
    .sort((left, right) => left.recordedAtMs - right.recordedAtMs)
  let replayed = 0
  let failed = 0
  for (const entry of entries) {
    try {
      replayEntry(db, entry)
      replayed += 1
    } catch (err) {
      failed += 1
      console.warn(`[deletion-journal] replay failed for ${entry.kind} entry recorded at ${entry.recordedAtMs}:`, err)
    }
  }
  return { replayed, failed }
}
