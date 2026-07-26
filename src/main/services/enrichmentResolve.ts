// Resolve the day's external signals into the shape the wrap WRITER sees.
// The connectors stored raw-ish signals in external_signals;
// this reads them back, sanitizes and humanizes, pre-formats every duration,
// and drops anything the model must never echo (raw paths, branches, clock
// times it cannot ground on a slide). Pure read: never collects, never blocks.
//
// The wrap prompt is resolved DETERMINISTICALLY from this — no tool loop.
// Nothing here may throw: a malformed stored row yields null, never a crash
// that breaks wrap generation.

import type Database from 'better-sqlite3'
import type {
  DayEnrichment,
  FocusAppSignal,
  GitActivitySignal,
  GitRepoActivity,
  MeetingNotesSignal, // notes connector
} from '@shared/types'
import { resolveDayMeetingReport, type DayMeetingReport } from './meetingResolution'
import { formatHm } from '../../renderer/lib/dayWrapScenes'
import { looksLikeRawArtifactLabel } from '../../renderer/lib/wrappedFacts'
import { cleanSubject, stripPathsAndBranches } from './gitSignals'
import { getExternalSignal } from './externalSignals'
import { getSettings } from './settings'
// event-type inference: classify each meeting from signals already on
// CalendarEventSignal (title, attendeeCount, durationMinutes) — pure,
// deterministic, no network/AI. See eventTypeInference.ts for the rules.
import { inferEventType } from './eventTypeInference'

const MAX_PROJECTS = 4
const MAX_HIGHLIGHTS = 6
const MAX_MEETINGS = 5
const MAX_TITLE = 120

/** A clock time embedded in free text ("2pm", "11:15am", "noon"). Enrichment
 *  must carry NO clock strings — the per-slide clock guard would otherwise be
 *  bypassed by a time smuggled inside a meeting title. */
const CLOCK_IN_TEXT = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:noon|midnight|midday)\b/gi

/** "billing-service" / "billing_service" → "billing service". Folder names only,
 *  never a path (the connector already stored the basename). */
function humanizeProject(repo: string): string {
  return repo.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || repo
}

/** Strip a conventional-commit prefix so a subject reads like plain work:
 *  "feat(auth): add login" → "add login", "fix: race" → "race". */
function stripConventionalPrefix(subject: string): string {
  return subject.replace(/^(?:feat|fix|chore|refactor|docs?|test|style|perf|build|ci|revert|wip)(?:\([^)]*\))?!?:\s*/i, '').trim()
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

/** Sanitize a calendar event title for the prompt: strip paths/branches and any
 *  embedded clock time, keep the rest (the user's own words, names and all —
 *  show the real title). Null when nothing usable remains. */
function sanitizeMeetingTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const stripped = stripPathsAndBranches(raw).replace(CLOCK_IN_TEXT, ' ').replace(/\s+/g, ' ').trim()
  if (stripped.length < 2) return null
  if (looksLikeRawArtifactLabel(stripped)) return null
  return stripped.length > MAX_TITLE ? `${stripped.slice(0, MAX_TITLE - 1)}…` : stripped
}

/** Turn stored git into the writer's `shipped` block, or null when empty. */
function resolveShipped(git: GitActivitySignal | null): DayEnrichment['shipped'] {
  if (!git) return null
  const repos = Array.isArray(git.repos) ? git.repos : []
  const prs = Array.isArray(git.prs) ? git.prs : []

  // The spread tells WHEN the commits landed, in part-of-day words only —
  // never a clock (the per-slide clock guard must stay unbypassed). This is
  // what lets the wrap tell an agent-era day honestly: a release wave landing
  // through an evening whose screen showed X is background output, not typing.
  const spreadFor = (r: GitRepoActivity): string | null => {
    const b = r.commitHourBuckets
    if (!b) return null
    const parts = [
      b.overnight > 0 ? `${b.overnight} overnight` : null,
      b.morning > 0 ? `${b.morning} through the morning` : null,
      b.afternoon > 0 ? `${b.afternoon} in the afternoon` : null,
      b.evening > 0 ? `${b.evening} through the evening` : null,
    ].filter((p): p is string => p !== null)
    return parts.length > 0 ? parts.join(', ') : null
  }
  const commitsByProject = repos
    .filter((r) => r && typeof r.commitCount === 'number' && r.commitCount > 0 && typeof r.repo === 'string')
    .map((r) => ({ project: humanizeProject(r.repo), commits: r.commitCount, spread: spreadFor(r) }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, MAX_PROJECTS)

  // Highlights: sanitized commit subjects + PR titles worth naming. cleanSubject
  // is re-applied defensively in case a row was stored before Gap 3 hardened it.
  const seen = new Set<string>()
  const highlights: string[] = []
  const candidates = [
    ...repos.flatMap((r) => (Array.isArray(r?.messages) ? r.messages : [])),
    ...prs.map((p) => p?.title),
  ]
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const cleaned = lowerFirst(stripConventionalPrefix(cleanSubject(raw)))
    if (cleaned.length < 4) continue
    if (looksLikeRawArtifactLabel(cleaned)) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    highlights.push(cleaned)
    if (highlights.length >= MAX_HIGHLIGHTS) break
  }

  const prByKey = new Map<string, { project: string; state: string; count: number }>()
  for (const pr of prs) {
    if (!pr || typeof pr.repo !== 'string') continue
    const project = humanizeProject(pr.repo)
    const state = typeof pr.state === 'string' && pr.state ? pr.state : 'open'
    const key = `${project}|${state}`
    const existing = prByKey.get(key)
    if (existing) existing.count += 1
    else prByKey.set(key, { project, state, count: 1 })
  }
  const pullRequests = [...prByKey.values()].sort((a, b) => b.count - a.count)

  if (commitsByProject.length === 0 && highlights.length === 0 && pullRequests.length === 0) return null
  return { commitsByProject, highlights, pullRequests }
}

/** Turn the DEV-189 day-level meeting resolution into the writer's `meetings`
 *  block, or null when the day had no meeting signal from EITHER source.
 *  Supersedes the calendar-only resolution (issue #3): a chaired meeting
 *  known only from captured meeting-app evidence is a meeting here, a
 *  calendar event with no supporting evidence is calendar-only context, and
 *  the writer sees the buckets separately. */
function resolveMeetings(report: DayMeetingReport | null): DayEnrichment['meetings'] {
  if (!report || report.meetings.length === 0) return null
  const items = report.meetings
    .slice()
    .sort((a, b) => (b.scheduledMinutes ?? Math.round((b.observedSeconds ?? 0) / 60))
      - (a.scheduledMinutes ?? Math.round((a.observedSeconds ?? 0) / 60)))
    .slice(0, MAX_MEETINGS)
    .map((meeting) => {
      // event-type inference: classify from the scheduled facts (title,
      // attendeeCount, durationMinutes) — the same signals the calendar
      // source produced. Captured-only meetings have no title/attendee
      // evidence to classify from and stay generic.
      const { type, confidence } = meeting.scheduledMinutes != null
        ? inferEventType({
          title: meeting.title ?? '',
          startClock: '',
          durationMinutes: meeting.scheduledMinutes,
          attendeeCount: meeting.attendeeCount,
        })
        : { type: 'generic' as const, confidence: 0 }
      return {
        title: sanitizeMeetingTitle(meeting.title),
        scheduled: meeting.scheduledMinutes != null
          ? formatHm(Math.max(0, meeting.scheduledMinutes) * 60)
          : null,
        observed: meeting.observedSeconds != null
          ? formatHm(Math.max(0, meeting.observedSeconds))
          : null,
        attendance: meeting.attendance,
        type,
        confidence,
      }
    })
  return {
    count: report.meetings.length,
    items,
    matched: report.matchedCount,
    calendarOnly: report.calendarOnlyCount,
    capturedOnly: report.capturedOnlyCount,
  }
}

/** Turn stored focus signals into the barest writer block, or null. Only apps
 *  currently ENABLED via the `focus:<app>` toggle surface (so a since-disabled
 *  app's stale row never leaks). Presence without readable sessions (e.g.
 *  Raycast, encrypted) yields null — there's nothing true to say. */
function resolveFocus(
  focus: FocusAppSignal[] | null,
  focusEnabled: (app: string) => boolean,
): DayEnrichment['focusSessions'] {
  if (!Array.isArray(focus) || focus.length === 0) return null
  for (const app of focus) {
    if (!app || typeof app.app !== 'string' || !focusEnabled(app.app)) continue
    const sessions = Array.isArray(app.sessions) ? app.sessions : []
    const timed = sessions.filter((s) => s && typeof s.durationMinutes === 'number' && s.durationMinutes > 0)
    if (timed.length === 0) continue
    const totalMinutes = timed.reduce((s, x) => s + (x.durationMinutes ?? 0), 0)
    if (totalMinutes <= 0) continue
    return { tool: app.app, sessions: timed.length, focused: formatHm(totalMinutes * 60) }
  }
  return null
}

/** The currently-enabled focus predicate from Settings (safe in any context). */
function focusEnabledFromSettings(): (app: string) => boolean {
  let enrichment: Record<string, boolean> = {}
  try { enrichment = getSettings().enrichmentSources ?? {} } catch { /* defaults: none enabled */ }
  return (app: string) => enrichment[`focus:${app}`] === true
}

// notes connector: sanitize + humanize stored meeting notes into the writer's
// `meetingNotes` block. Titles and action items run through the SAME path/branch
// + clock-time strippers as calendar titles (sanitizeMeetingTitle); participants
// are hard-capped to a first name with any email refused.
const MAX_NOTES = 5
const MAX_NOTE_PARTICIPANTS = 8
const MAX_NOTE_ACTION_ITEMS = 6

/** First name only, never an email. Defense in depth over the connector. */
function sanitizeFirstName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || /@|https?:/i.test(trimmed)) return null
  const token = trimmed.split(/[\s,]+/).filter(Boolean)[0]
  if (!token || /@/.test(token)) return null
  return token.length > 40 ? token.slice(0, 40) : token
}

/** An action-item line for the prompt: strip paths/branches and any embedded
 *  clock time (same rules as a meeting title), cap length. Null when empty. */
function sanitizeActionItem(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const stripped = stripPathsAndBranches(raw).replace(CLOCK_IN_TEXT, ' ').replace(/\s+/g, ' ').trim()
  if (stripped.length < 3) return null
  return stripped.length > MAX_TITLE ? `${stripped.slice(0, MAX_TITLE - 1)}…` : stripped
}

/** Turn stored meeting notes into the writer's `meetingNotes` block, or null. */
function resolveMeetingNotes(notes: MeetingNotesSignal | null): DayEnrichment['meetingNotes'] {
  if (!notes || typeof notes.app !== 'string' || !Array.isArray(notes.notes)) return null
  const items: NonNullable<DayEnrichment['meetingNotes']>['items'] = []
  for (const note of notes.notes) {
    if (!note || typeof note !== 'object') continue
    const title = sanitizeMeetingTitle(note.title)
    if (!title) continue // no groundable title: nothing honest to narrate
    const participants = (Array.isArray(note.participants) ? note.participants : [])
      .map(sanitizeFirstName)
      .filter((n): n is string => n !== null)
      .slice(0, MAX_NOTE_PARTICIPANTS)
    const actionItems = (Array.isArray(note.actionItems) ? note.actionItems : [])
      .map(sanitizeActionItem)
      .filter((a): a is string => a !== null)
      .slice(0, MAX_NOTE_ACTION_ITEMS)
    items.push({ title, participants, actionItems })
    if (items.length >= MAX_NOTES) break
  }
  if (items.length === 0) return null
  return { app: notes.app, items }
}

/** The notes off-switch from Settings (default ON): a since-disabled source's
 *  stale row never leaks, mirroring how focus toggles gate resolution. */
function notesEnabledFromSettings(): boolean {
  try { return getSettings().enrichmentSources?.['notes'] !== false } catch { return true }
}

/** The day's resolved enrichment for the wrap writer, or null when no connector
 *  had anything. Reads stored signals only — never collects, never throws. */
export function resolveDayEnrichment(
  db: Database.Database,
  date: string,
  options: { focusEnabled?: (app: string) => boolean; notesEnabled?: boolean } = {},
): DayEnrichment | null {
  try {
    const focusEnabled = options.focusEnabled ?? focusEnabledFromSettings()
    const notesEnabled = options.notesEnabled ?? notesEnabledFromSettings()
    const shipped = resolveShipped(getExternalSignal<GitActivitySignal>(db, date, 'git')?.payload ?? null)
    // Day-level meeting resolution (DEV-189 / issue #3): calendar signal +
    // captured meeting-app evidence, three honest buckets — never calendar
    // alone, so a captured meeting without a calendar event still exists.
    const meetings = resolveMeetings(resolveDayMeetingReport(db, date))
    const focusSessions = resolveFocus(getExternalSignal<FocusAppSignal[]>(db, date, 'focus_app')?.payload ?? null, focusEnabled)
    // notes connector: resolved only when the off-switch is on.
    const meetingNotes = notesEnabled
      ? resolveMeetingNotes(getExternalSignal<MeetingNotesSignal>(db, date, 'notes')?.payload ?? null)
      : null
    if (!shipped && !meetings && !focusSessions && !meetingNotes) return null
    return { shipped, meetings, focusSessions, meetingNotes }
  } catch {
    // A malformed stored row must never break wrap generation.
    return null
  }
}
