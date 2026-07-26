// External-context tools for the chat agent (docs/north-star/context-agent.md):
// calendar and git through the SAME executors the wrap and the MCP server use
// (src/main/services/wrappedTools.ts), and Granola meeting notes through the
// SAME cache reader the context packet uses. Tier 1 (calendar, git) is always
// on; meeting notes are Tier 2 — on by default, gated by the
// granolaAccessEnabled policy switch in Settings, which is enforced HERE in
// the main process, never left to the model.
//
// Every result passes the same two privacy boundaries as every other AI-bound
// payload: filterTrackingExcludedEvidence + sanitizeToolResult.
import { tool } from 'ai'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { sanitizeToolResult } from '@shared/aiSanitize'
import { filterTrackingExcludedEvidence } from '@shared/evidencePrivacy'
import { trackingControlsStateFromSettings } from '@shared/trackingControls'
import { getSettings } from '../services/settings'
import { getCalendarEvents, getGitActivity } from '../services/wrappedTools'
import { extractGranolaNotes, extractGranolaTranscript, getGranolaConnection } from '../services/granolaCache'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('Local date, YYYY-MM-DD')

const MAX_MEETINGS_LISTED = 20
const MEETING_NOTES_EXCERPT_CHARS = 6_000

const GRANOLA_OFF_REASON =
  'Meeting-notes access is off. The user can turn it on in Settings → Agent file access (Granola meeting notes). '
  + 'Meeting names and times may still appear in calendar data.'

function guarded(raw: unknown): unknown {
  const controls = trackingControlsStateFromSettings(getSettings())
  return sanitizeToolResult(filterTrackingExcludedEvidence(raw, controls))
}

interface MeetingRecordRow {
  source_record_id: string
  date: string | null
  effective_at: number | null
  envelope_json: string
}

function meetingTitle(row: MeetingRecordRow): string {
  try {
    const envelope = JSON.parse(row.envelope_json) as { entity?: { title?: unknown } }
    return typeof envelope.entity?.title === 'string' ? envelope.entity.title : ''
  } catch {
    return ''
  }
}

export interface ContextToolOptions {
  /** Pass false where fresh collection must not run (hermetic tests, read-only
   *  database handles) — stored signals are still served. */
  allowCollect?: boolean
}

export function buildContextTools(db: Database.Database, options: ContextToolOptions = {}) {
  const allowCollect = options.allowCollect ?? true

  return {
    get_calendar_events: tool({
      description: 'The day\'s meetings: calendar events (names, times, durations, attendee counts — never attendee names) plus the day-level resolution of which were actually attended (matched), which were calendar-only, and which meeting-app time had no calendar entry. Use for "what meetings did I have" and to separate scheduled from attended.',
      inputSchema: z.object({ date: DATE }),
      execute: async ({ date }) => {
        const result = await getCalendarEvents({ date }, db, { allowCollect })
        if (!result) {
          return { found: false, reason: `No calendar events or captured meeting evidence for ${date}.` }
        }
        return guarded({ found: true, date, ...result })
      },
    }),

    get_git_activity: tool({
      description: 'The day\'s git story from the stored daily signal: repositories touched, commits (messages + times), and PR activity when the gh CLI was available. Cheaper than the git tool for "what did I commit on <date>" — use the git tool only when you need history outside the stored daily signals.',
      inputSchema: z.object({ date: DATE }),
      execute: async ({ date }) => {
        const result = await getGitActivity({ date }, db, { allowCollect })
        if (!result) {
          return { found: false, reason: `No git activity was recorded for ${date}.` }
        }
        return guarded({ found: true, date, ...result })
      },
    }),

    read_meeting_notes: tool({
      description: 'Granola meeting notes from the local cache. Without meetingId: lists recent meetings (title, date, id), optionally filtered by date range. With meetingId: returns that meeting\'s structured notes (falling back to a transcript excerpt when no notes exist). Gated by the Granola access switch in Settings.',
      inputSchema: z.object({
        meetingId: z.string().min(1).optional().describe('A meeting id from a previous listing call'),
        startDate: DATE.optional(),
        endDate: DATE.optional(),
      }),
      execute: async ({ meetingId, startDate, endDate }) => {
        // The policy gate lives here, outside the model: off means an honest
        // refusal the model can relay, never a silent miss.
        if (getSettings().granolaAccessEnabled === false) {
          return { found: false, reason: GRANOLA_OFF_REASON }
        }
        const connection = getGranolaConnection(db)
        if (!connection) {
          return { found: false, reason: 'Granola is not connected on this machine, so no meeting notes are available.' }
        }

        try {
          if (!meetingId) {
            const conditions = [`connector_id = 'granola'`, `kind = 'meeting_record'`, 'tombstoned_at IS NULL']
            const params: string[] = []
            if (startDate) { conditions.push('date >= ?'); params.push(startDate) }
            if (endDate) { conditions.push('date <= ?'); params.push(endDate) }
            const rows = db.prepare(`
              SELECT source_record_id, date, effective_at, envelope_json FROM connector_records
              WHERE ${conditions.join(' AND ')}
              ORDER BY effective_at DESC
              LIMIT ${MAX_MEETINGS_LISTED + 1}
            `).all(...params) as MeetingRecordRow[]
            if (rows.length === 0) {
              return { found: false, reason: 'No Granola meetings are recorded for that range.' }
            }
            const meetings = rows.slice(0, MAX_MEETINGS_LISTED).map((row) => ({
              meetingId: row.source_record_id,
              title: meetingTitle(row) || '(untitled meeting)',
              date: row.date,
              effectiveAt: row.effective_at,
            }))
            return guarded({ found: true, truncated: rows.length > MAX_MEETINGS_LISTED, meetings })
          }

          const row = db.prepare(`
            SELECT source_record_id, date, effective_at, envelope_json FROM connector_records
            WHERE connector_id = 'granola' AND kind = 'meeting_record' AND tombstoned_at IS NULL
              AND (source_record_id = ? OR source_record_id = ?)
          `).get(meetingId, `note:${meetingId}`) as MeetingRecordRow | undefined
          if (!row) {
            return { found: false, reason: 'No Granola meeting matches that id. List meetings first to get a valid id.' }
          }
          let raw: string
          try {
            raw = readFileSync(connection.cachePath, 'utf8')
          } catch {
            return { found: false, reason: 'The Granola cache file could not be read on this machine.' }
          }
          const docId = row.source_record_id.replace(/^note:/, '')
          const notes = extractGranolaNotes(raw, docId)
          const transcript = notes ? null : extractGranolaTranscript(raw, docId)
          const content = notes ?? transcript
          if (!content) {
            return { found: false, reason: 'That meeting has no readable notes or transcript in the local cache.' }
          }
          return guarded({
            found: true,
            meetingId: row.source_record_id,
            title: meetingTitle(row) || '(untitled meeting)',
            date: row.date,
            source: notes ? 'notes' : 'transcript',
            truncated: content.length > MEETING_NOTES_EXCERPT_CHARS,
            content: content.slice(0, MEETING_NOTES_EXCERPT_CHARS),
          })
        } catch (error) {
          return { found: false, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  }
}
