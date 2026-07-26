// Daylens data tools for the chat agent. Every tool reads the same
// corrected store the Timeline and Apps views read (via aiTools/executeTool and
// the moment-evidence lib), passes the same two privacy boundaries
// (tracking-exclusion filter + secret sanitizer), and returns either real rows
// or an explicit { found: false, reason } miss — the model never gets an
// ambiguous silence to fill.
import { tool } from 'ai'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { executeTool, execSearchSessionsWithMeaning } from '../services/aiTools'
import { getMomentEvidence } from '../lib/momentEvidence'
import { getWebsiteVisitsForRange } from '../db/queries'
import {
  browserPageCoverageNotes,
  getCorrectedPageFactsForRange,
  getCorrectedSessionsForRange,
  getIgnoredBlockSpansForRange,
} from '../services/activityFacts'
import {
  listFocusEventTimesInRange,
  listMachineStateEventsBefore,
} from '../db/focusEventRepository'
import { getCalendarEvents, getGitActivity } from '../services/wrappedTools'
import { shiftLocalDateString } from '../lib/localDate'
import { sanitizeToolResult } from '@shared/aiSanitize'
import { filterTrackingExcludedEvidence } from '@shared/evidencePrivacy'
import { trackingControlsStateFromSettings } from '@shared/trackingControls'
import { getSettings } from '../services/settings'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('Local date, YYYY-MM-DD')
const TIME = z.string().regex(/^\d{1,2}:\d{2}$/, 'HH:MM').describe('Local clock time, 24h HH:MM')

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_VISIT_RANGE_DAYS = 62
const UNTRACKED_GAP_MS = 15 * 60 * 1000

function guarded(raw: unknown): unknown {
  const controls = trackingControlsStateFromSettings(getSettings())
  return sanitizeToolResult(filterTrackingExcludedEvidence(raw, controls))
}

function dayStartMs(date: string): number {
  const parsed = new Date(`${date}T00:00:00`)
  return parsed.getTime()
}

function captureStateForDay(db: Database.Database, date: string) {
  const fromMs = dayStartMs(date)
  const toMs = fromMs + DAY_MS
  try {
    const prior = listMachineStateEventsBefore(db, fromMs)
    const events = listFocusEventTimesInRange(db, fromMs, toMs)

    const states = new Set<'asleep' | 'locked'>()
    for (const event of prior.reverse()) {
      if (event.event_type === 'sleep') states.add('asleep')
      if (event.event_type === 'wake') states.delete('asleep')
      if (event.event_type === 'lock') states.add('locked')
      if (event.event_type === 'unlock') states.delete('locked')
    }

    const machineStateSpans: Array<{
      startMs: number
      endMs: number
      startTime: string
      endTime: string
      state: string
    }> = []
    let inactiveStart = states.size > 0 ? fromMs : null
    let spanStates = new Set(states)
    for (const event of events) {
      const wasInactive = states.size > 0
      if (event.event_type === 'sleep') states.add('asleep')
      if (event.event_type === 'wake') states.delete('asleep')
      if (event.event_type === 'lock') states.add('locked')
      if (event.event_type === 'unlock') states.delete('locked')
      if (!wasInactive && states.size > 0) {
        inactiveStart = event.ts_ms
        spanStates = new Set(states)
      } else if (wasInactive) {
        for (const state of states) spanStates.add(state)
      }
      if (wasInactive && states.size === 0 && inactiveStart != null) {
        machineStateSpans.push({
          startMs: inactiveStart,
          endMs: event.ts_ms,
          startTime: fmtClock(inactiveStart),
          endTime: fmtClock(event.ts_ms),
          state: [...spanStates].sort().join('_and_'),
        })
        inactiveStart = null
        spanStates.clear()
      }
    }
    if (inactiveStart != null) {
      machineStateSpans.push({
        startMs: inactiveStart,
        endMs: toMs,
        startTime: fmtClock(inactiveStart),
        endTime: fmtClock(toMs),
        state: [...spanStates].sort().join('_and_'),
      })
    }

    const untrackedGaps: Array<{ startMs: number; endMs: number; startTime: string; endTime: string }> = []
    for (let index = 1; index < events.length; index += 1) {
      const startMs = events[index - 1].ts_ms
      const endMs = events[index].ts_ms
      if (endMs - startMs < UNTRACKED_GAP_MS) continue
      const explained = machineStateSpans.some((span) => span.startMs < endMs && span.endMs > startMs)
      if (!explained) {
        untrackedGaps.push({ startMs, endMs, startTime: fmtClock(startMs), endTime: fmtClock(endMs) })
      }
    }

    return {
      machineStateSpans,
      untrackedGaps,
      captureCoverage: {
        eventCount: events.length,
        firstEventMs: events[0]?.ts_ms ?? null,
        lastEventMs: events.at(-1)?.ts_ms ?? null,
      },
    }
  } catch {
    return { machineStateSpans: [], untrackedGaps: [], captureCoverage: null }
  }
}

function fmtClock(ms: number): string {
  const value = new Date(ms)
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

function minuteOffset(time: string): number | null {
  const [hourRaw, minuteRaw] = time.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
  if (hour === 24 && minute === 0) return 24 * 60
  if (hour < 0 || hour > 23) return null
  return hour * 60 + minute
}

function fmtMinuteOffset(value: number): string {
  const hour = Math.floor(value / 60)
  const minute = value % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function timeChunks(
  db: Database.Database,
  date: string,
  startTime: string,
  endTime: string,
  incrementMinutes: number,
) {
  const startOffset = minuteOffset(startTime)
  const endOffset = minuteOffset(endTime)
  if (startOffset == null || endOffset == null || endOffset <= startOffset) {
    return { found: false, reason: 'Bad time span.' }
  }
  const spanMinutes = endOffset - startOffset
  if (spanMinutes % incrementMinutes !== 0 || spanMinutes / incrementMinutes > 96) {
    return { found: false, reason: 'The span must divide evenly into at most 96 increments.' }
  }

  const dayStart = dayStartMs(date)
  const spanStartMs = dayStart + startOffset * 60_000
  const spanEndMs = dayStart + endOffset * 60_000
  const state = captureStateForDay(db, date)
  // Corrected facts: a deleted Timeline block's stretch is empty space in the
  // chunk view too, for sessions and page visits alike.
  const ignoredSpans = getIgnoredBlockSpansForRange(db, spanStartMs, spanEndMs)
  const visits = getWebsiteVisitsForRange(db, spanStartMs, spanEndMs)
    .filter((visit) => !ignoredSpans.some((span) => span.startMs <= visit.visitTime && span.endMs > visit.visitTime))
  const spanSessions = getCorrectedSessionsForRange(db, spanStartMs, spanEndMs)
  const chunks = []
  for (let offset = startOffset; offset < endOffset; offset += incrementMinutes) {
    const chunkStart = dayStart + offset * 60_000
    const chunkEnd = chunkStart + incrementMinutes * 60_000
    const sessions = spanSessions.filter((session) =>
      session.startTime < chunkEnd
      && (session.endTime ?? session.startTime + session.durationSeconds * 1000) > chunkStart)
    const activity = sessions.map((session) => ({
      appName: session.appName,
      windowTitle: session.windowTitle ?? null,
      category: session.category,
      seconds: Math.max(1, Math.round((Math.min(session.endTime ?? chunkEnd, chunkEnd) - Math.max(session.startTime, chunkStart)) / 1000)),
    })).sort((left, right) => right.seconds - left.seconds).slice(0, 5)
    const pages = visits
      .filter((visit) => visit.visitTime < chunkEnd && visit.visitTime + Math.max(1, visit.durationSec) * 1000 > chunkStart)
      .map((visit) => ({ pageTitle: visit.pageTitle, domain: visit.domain, url: visit.url }))
      .slice(0, 5)
    const machineState = state.machineStateSpans.find((span) => span.startMs < chunkEnd && span.endMs > chunkStart)
    const untracked = state.untrackedGaps.find((gap) => gap.startMs < chunkEnd && gap.endMs > chunkStart)
    const gap = activity.length > 0
      ? null
      : machineState
        ? { kind: machineState.state, label: machineState.state.includes('asleep') ? 'machine asleep/locked' : 'machine locked' }
        : untracked
          ? { kind: 'untracked', label: 'no data captured — possible tracking failure' }
          : { kind: 'idle', label: 'no activity captured — likely away/idle' }
    chunks.push({
      startTime: fmtMinuteOffset(offset),
      endTime: fmtMinuteOffset(offset + incrementMinutes),
      durationMinutes: incrementMinutes,
      activity,
      pages,
      gap,
    })
  }
  return { found: true, date, startTime, endTime, incrementMinutes, chunks }
}

const MAX_CALENDAR_RANGE_DAYS = 31

// ─── Granola meeting notes (DEV-241) ─────────────────────────────────────────
// The chat reads the SAME minimized day layer the wrap enrichment reads: the
// notesSignal each Granola connector record carries (title, date, participant
// first names, capped note lines). Never the raw cache, never transcripts.

interface MeetingNote {
  date: string
  title: string
  scheduledClock: string | null
  participants: string[]
  noteLines: string[]
}

function granolaIsConnected(db: Database.Database): boolean {
  try {
    const row = db.prepare(
      `SELECT 1 FROM connector_connections WHERE connector_id = 'granola' AND status != 'disconnected'`,
    ).get()
    return row != null
  } catch {
    return false
  }
}

function readGranolaMeetingNotes(
  db: Database.Database,
  filters: { date?: string; query?: string; limit: number },
): MeetingNote[] {
  let rows: Array<{ envelope_json: string }> = []
  try {
    rows = db.prepare(`
      SELECT envelope_json FROM connector_records
      WHERE connector_id = 'granola' AND kind = 'meeting_record' AND tombstoned_at IS NULL
      ORDER BY effective_at DESC, updated_at DESC
    `).all() as Array<{ envelope_json: string }>
  } catch {
    return []
  }
  const needle = filters.query?.trim().toLowerCase() || null
  const notes: MeetingNote[] = []
  for (const row of rows) {
    let signal: Record<string, unknown> | null = null
    try {
      const envelope = JSON.parse(row.envelope_json) as { notesSignal?: Record<string, unknown> }
      signal = envelope.notesSignal ?? null
    } catch {
      continue
    }
    if (!signal || typeof signal.date !== 'string' || typeof signal.title !== 'string') continue
    const note: MeetingNote = {
      date: signal.date,
      title: signal.title,
      scheduledClock: typeof signal.scheduledClock === 'string' ? signal.scheduledClock : null,
      participants: Array.isArray(signal.participants)
        ? signal.participants.filter((name): name is string => typeof name === 'string')
        : [],
      noteLines: Array.isArray(signal.actionItems)
        ? signal.actionItems.filter((line): line is string => typeof line === 'string')
        : [],
    }
    if (filters.date && note.date !== filters.date) continue
    if (needle) {
      const haystack = [note.title, ...note.participants, ...note.noteLines].join('\n').toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    notes.push(note)
    if (notes.length >= filters.limit) break
  }
  return notes
}

interface AggregatedPage {
  pageTitle: string | null
  domain: string
  url: string | null
  totalSeconds: number
  visitCount: number
  firstSeen: number
  lastSeen: number
}

export function buildDaylensTools(db: Database.Database) {
  return {
    get_day_overview: tool({
      description: 'The full story of one day: timeline blocks with labels and times, top apps, top sites, and totals. This is the same data the Timeline screen shows. Start here for "what did I do" questions.',
      inputSchema: z.object({ date: DATE }),
      execute: async ({ date }) => guarded({
        ...(executeTool('getDaySummary', { date }, db) as Record<string, unknown>),
        ...captureStateForDay(db, date),
      }),
    }),

    get_moment: tool({
      description: 'What was actually on screen at one specific clock time: the ONE page/video active at that minute (never the whole block), the covering timeline block, and all visits overlapping that minute. Use for "what was I watching/doing at 3pm" and for breaking an hour into increments (call once per increment).',
      inputSchema: z.object({ date: DATE, time: TIME }),
      execute: async ({ date, time }) => guarded(getMomentEvidence(db, date, time)),
    }),

    get_time_chunks: tool({
      description: 'Return a complete time span as exact consecutive increments, including captured apps/pages and explicit asleep, locked, idle, or possible tracking-failure gaps. Use for every request to break a day or span into N-minute chunks.',
      inputSchema: z.object({
        date: DATE,
        startTime: TIME.optional().default('00:00'),
        endTime: z.string().regex(/^(?:\d{1,2}:\d{2}|24:00)$/).optional().default('24:00'),
        incrementMinutes: z.number().int().min(5).max(120),
      }),
      execute: async ({ date, startTime, endTime, incrementMinutes }) => guarded(
        timeChunks(db, date, startTime, endTime, incrementMinutes),
      ),
    }),

    search_history: tool({
      description: 'Full-text fuzzy search over everything captured: app sessions, window titles, page titles and URLs. Use for recall questions ("that drowning video", "the article about transformers"). Returns matches with times, durations, and URLs, or an explicit empty result. When the local semantic index is available, a separate semanticHits array carries moments found by MEANING (on-device embeddings) — present those as "similar meaning" leads, never as exact matches.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search words. Keep it to the distinctive terms.'),
        startDate: DATE.optional(),
        endDate: DATE.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      // DEV-180: exact retrieval plus the by-meaning path, through the same
      // two privacy boundaries as every other tool result.
      execute: async (params) => guarded(await execSearchSessionsWithMeaning(params, db)),
    }),

    get_app_usage: tool({
      description: 'Time in one app over a date range: totals, per-day breakdown, sessions. The same numbers the Apps screen shows.',
      inputSchema: z.object({
        appName: z.string().min(1),
        startDate: DATE.optional(),
        endDate: DATE.optional(),
      }),
      execute: async (params) => guarded(executeTool('getAppUsage', params, db)),
    }),

    get_week_summary: tool({
      description: 'Totals and per-day shape for one week. weekStartDate must be the Monday.',
      inputSchema: z.object({ weekStartDate: DATE }),
      execute: async (params) => guarded(executeTool('getWeekSummary', params, db)),
    }),

    list_page_visits: tool({
      description: 'Website visits over a date range, aggregated per page: title, URL, domain, total time, visit count, first/last seen. Filter by domain (e.g. "youtube.com") or title words. Use for "all YouTube videos this month", podcasts, and export data. Time is reconciled foreground seconds — the same ledger the Apps screen totals — NOT the media\'s own length. When coverageNotes is present, page detail explains less time than the browser verifiably had; quote the note instead of presenting the page list as complete.',
      inputSchema: z.object({
        startDate: DATE,
        endDate: DATE,
        domainContains: z.string().optional().describe('Case-insensitive substring match on domain, e.g. "youtube"'),
        titleContains: z.string().optional().describe('Case-insensitive substring match on page title'),
        limit: z.number().int().min(1).max(500).optional().describe('Max aggregated pages returned, default 500, ordered by total time'),
      }),
      execute: async ({ startDate, endDate, domainContains, titleContains, limit }) => {
        const fromMs = dayStartMs(startDate)
        const toMs = dayStartMs(endDate) + DAY_MS - 1
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
          return { found: false, reason: 'Bad date range.' }
        }
        if ((toMs - fromMs) / DAY_MS > MAX_VISIT_RANGE_DAYS) {
          return { found: false, reason: `Range too wide — ask for at most ${MAX_VISIT_RANGE_DAYS} days at a time.` }
        }
        // One source of truth: the same reconciled + corrected page ledger the
        // Apps view and domain totals read, never raw duration_sec sums.
        const facts = getCorrectedPageFactsForRange(db, fromMs, toMs)
        const coverageNotes = browserPageCoverageNotes(facts.coverage)
        const domainNeedle = domainContains?.toLowerCase() ?? null
        const titleNeedle = titleContains?.toLowerCase() ?? null
        const matching: AggregatedPage[] = []
        for (const page of facts.pages) {
          if (domainNeedle && !page.domain.toLowerCase().includes(domainNeedle)) continue
          if (titleNeedle && !(page.pageTitle ?? '').toLowerCase().includes(titleNeedle)) continue
          matching.push({
            pageTitle: page.pageTitle,
            domain: page.domain,
            url: page.url,
            totalSeconds: page.totalSeconds,
            visitCount: page.visitCount,
            firstSeen: page.firstSeen,
            lastSeen: page.lastSeen,
          })
        }
        const pages = matching.slice(0, limit ?? 500)
        if (pages.length === 0) {
          return {
            found: false,
            reason: `No captured visits match${domainNeedle ? ` domain~"${domainContains}"` : ''}${titleNeedle ? ` title~"${titleContains}"` : ''} between ${startDate} and ${endDate}.`,
            ...(coverageNotes.length > 0 ? { coverageNotes } : {}),
          }
        }
        return guarded({
          found: true,
          pageCount: matching.length,
          truncatedTo: pages.length,
          pages,
          ...(coverageNotes.length > 0 ? { coverageNotes } : {}),
        })
      },
    }),

    get_attribution: tool({
      description: 'Work attributed to one named client or project (partial name match).',
      inputSchema: z.object({ entityName: z.string().min(1) }),
      execute: async (params) => guarded(executeTool('getAttributionContext', params, db)),
    }),

    list_clients: tool({
      description: 'The client/project roster the user has set up, optionally scoped to a date range.',
      inputSchema: z.object({ startDate: DATE.optional(), endDate: DATE.optional() }),
      execute: async (params) => guarded(executeTool('listClients', params, db)),
    }),

    get_calendar_events: tool({
      description: 'Scheduled calendar events for a date or a short date range: titles, start clocks, durations, and attendee counts, plus a meetingReport that says which meetings have supporting captured evidence (matched), which were schedule-only (calendar_only), and which were observed without a calendar entry (captured_only). Works for ANY date, including future ones: "what is on my calendar tomorrow" resolves to tomorrow\'s date and is a legal query. Use for every calendar, schedule, or meeting question. A scheduled event is a plan, not proof the user attended; only the meetingReport\'s matched bucket carries attendance evidence.',
      inputSchema: z.object({
        date: DATE,
        endDate: DATE.optional().describe('Inclusive range end; omit for a single day'),
      }),
      execute: async ({ date, endDate }) => {
        const last = endDate ?? date
        if (last < date) return { found: false, reason: 'endDate is before date.' }
        const spanDays = Math.round((dayStartMs(last) - dayStartMs(date)) / DAY_MS) + 1
        if (!Number.isFinite(spanDays) || spanDays > MAX_CALENDAR_RANGE_DAYS) {
          return { found: false, reason: `Range too wide. Ask for at most ${MAX_CALENDAR_RANGE_DAYS} days at a time.` }
        }
        const days: Array<Record<string, unknown>> = []
        for (let day = date; day <= last; day = shiftLocalDateString(day, 1)) {
          // The same data function the Wrapped/MCP layer serves: stored signal
          // first, one on-demand local-calendar collection when nothing is
          // stored yet (how a future date gets its events).
          const result = await getCalendarEvents({ date: day }, db)
          if (result) days.push({ date: day, ...result })
        }
        if (days.length === 0) {
          const span = date === last ? date : `${date} to ${last}`
          return {
            found: false,
            reason: `No calendar events stored or discoverable for ${span}. The calendar source reads what is synced into this machine's local calendar; an empty result can also mean no readable calendar tool is installed.`,
          }
        }
        return guarded({ found: true, days })
      },
    }),

    get_meeting_notes: tool({
      description: 'Granola meeting notes ingested from the user\'s Granola app: meeting title, date, scheduled clock, participant first names, and the user\'s own note lines. Filter by date and/or a search query over titles, participants, and note text; with no filters it returns the most recent notes. Use for "what did we discuss or decide in that meeting", "what are my notes from Monday", and any Granola question. Notes are minimized excerpts, never transcripts.',
      inputSchema: z.object({
        date: DATE.optional(),
        query: z.string().min(1).optional().describe('Case-insensitive match over title, participants, and note lines'),
        limit: z.number().int().min(1).max(30).optional().describe('Max notes returned, default 10, newest first'),
      }),
      execute: async ({ date, query, limit }) => {
        const notes = readGranolaMeetingNotes(db, { date, query, limit: limit ?? 10 })
        if (notes.length === 0) {
          if (!granolaIsConnected(db)) {
            return {
              found: false,
              reason: 'Granola is not connected, so no meeting notes are available. The user can connect it in Settings under Connections.',
            }
          }
          const filters = [date ? `date ${date}` : null, query ? `query "${query}"` : null].filter(Boolean).join(' and ')
          return {
            found: false,
            reason: filters
              ? `Granola is connected but no meeting notes match ${filters}.`
              : 'Granola is connected but no meeting notes have been ingested yet.',
          }
        }
        return guarded({ found: true, noteCount: notes.length, notes })
      },
    }),

    get_git_activity: tool({
      description: 'The day\'s ingested git signal: repositories with commit counts and messages, plus PR activity from the gh CLI when it is available. Use for "what did I commit or ship on <date>" before crawling repositories by hand; combine with discover_repositories when this signal misses a repository.',
      inputSchema: z.object({ date: DATE }),
      execute: async ({ date }) => {
        const activity = await getGitActivity({ date }, db)
        if (!activity) {
          return { found: false, reason: `No git activity stored or discoverable for ${date}. Commits are read from local repositories and PRs from the gh CLI.` }
        }
        return guarded({ found: true, date, ...activity })
      },
    }),
  }
}
