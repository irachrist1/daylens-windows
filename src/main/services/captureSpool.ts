// Spool ingestion (DEV-262): the main process's side of the durable capture
// path. The relay appends gated events to spool-YYYY-MM-DD.ndjson files; this
// module tails them with a durable byte cursor and lands the events in
// focus_events with their original timestamps. Because the cursor advances
// only after a successful database write, a crash between reads costs
// nothing — the next ingest re-reads from the last durable position. Events
// observed while the app was frozen or dead are simply waiting in the file.
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { insertFocusEvents } from '../db/focusEventRepository'
import { recordCaptureEventRejection } from '../lib/captureRejections'
import type { FocusEvent, MacFocusEventSource } from '../core/evidence/focusEvent'

const SPOOL_FILE_PATTERN = /^spool-(\d{4}-\d{2}-\d{2})\.ndjson$/

export interface SpoolIngestResult {
  files: number
  events: number
}

function cursorPath(spoolFile: string): string {
  return `${spoolFile}.cursor`
}

function readCursor(spoolFile: string): number {
  try {
    const value = Number.parseInt(fs.readFileSync(cursorPath(spoolFile), 'utf8').trim(), 10)
    return Number.isFinite(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

function writeCursor(spoolFile: string, offset: number): void {
  fs.writeFileSync(cursorPath(spoolFile), String(offset))
}

function parseSpoolLine(line: string): FocusEvent<MacFocusEventSource> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as FocusEvent<MacFocusEventSource>
    // Spool lines are post-gate records the relay wrote itself; a shape check
    // guards against torn writes and hand-edited files, not against content.
    if (typeof parsed.ts_ms !== 'number' || typeof parsed.event_type !== 'string') {
      recordCaptureEventRejection('mac_focus_helper', 'malformed')
      return null
    }
    return parsed
  } catch {
    recordCaptureEventRejection('mac_focus_helper', 'malformed')
    return null
  }
}

function localDateStamp(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Ingest every spool file's unread tail into focus_events. Consumed files
 * from previous days are deleted (with their cursors) once fully ingested;
 * today's file stays, growing, with its cursor trailing the writer.
 */
export function ingestSpool(db: Database.Database, spoolDir: string, now: Date = new Date()): SpoolIngestResult {
  let files = 0
  let events = 0
  let names: string[]
  try {
    names = fs.readdirSync(spoolDir).filter((name) => SPOOL_FILE_PATTERN.test(name)).sort()
  } catch {
    return { files: 0, events: 0 } // no spool directory yet — nothing captured
  }
  const today = localDateStamp(now)

  for (const name of names) {
    const spoolFile = path.join(spoolDir, name)
    let size: number
    try {
      size = fs.statSync(spoolFile).size
    } catch {
      continue
    }
    const cursor = readCursor(spoolFile)

    if (size > cursor) {
      const fd = fs.openSync(spoolFile, 'r')
      let chunk: Buffer
      try {
        chunk = Buffer.alloc(size - cursor)
        fs.readSync(fd, chunk, 0, chunk.length, cursor)
      } finally {
        fs.closeSync(fd)
      }
      const text = chunk.toString('utf8')
      // Only consume up to the last complete line — the relay may be mid-append.
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline >= 0) {
        const complete = text.slice(0, lastNewline)
        const batch: FocusEvent<MacFocusEventSource>[] = []
        for (const line of complete.split('\n')) {
          const event = parseSpoolLine(line)
          if (event) batch.push(event)
        }
        if (batch.length > 0) {
          insertFocusEvents(db, batch)
          events += batch.length
        }
        writeCursor(spoolFile, cursor + Buffer.byteLength(complete, 'utf8') + 1)
        files += 1
      }
    }

    // A previous day's file that is fully consumed has served its purpose.
    const stamp = SPOOL_FILE_PATTERN.exec(name)?.[1]
    if (stamp && stamp < today && readCursor(spoolFile) >= size) {
      try {
        fs.rmSync(spoolFile)
        fs.rmSync(cursorPath(spoolFile), { force: true })
      } catch {
        /* retry next pass */
      }
    }
  }
  return { files, events }
}

/** Consent revoked: nothing already spooled may outlive the decision. */
export function deleteSpool(spoolDir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(spoolDir)
  } catch {
    return
  }
  for (const name of names) {
    if (SPOOL_FILE_PATTERN.test(name) || name.endsWith('.cursor')) {
      try {
        fs.rmSync(path.join(spoolDir, name))
      } catch {
        /* best effort */
      }
    }
  }
}
