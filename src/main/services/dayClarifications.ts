// The day-analysis agent's clarification contract (day-recap-and-analysis spec).
// When evidence leaves a material question open — a substantial block the
// labeler could not name, a scheduled meeting with no proof it happened — the
// agent asks the person one answer-or-skip question. Answering writes a durable
// correction (a block label, an attendance mark); skipping is remembered so the
// same question is not re-asked. Detection is deterministic and never blocks the
// recap: it reads the same payload the timeline shows.
import type Database from 'better-sqlite3'
import type {
  DayTimelinePayload,
  TimelineClarification,
  TimelineClarificationAnswer,
  TimelineClarificationOption,
  WorkContextBlock,
} from '@shared/types'
import { blockActiveSeconds } from '@shared/blockDuration'
import { userVisibleBlockLabel } from '@shared/blockLabel'
import { rawLabelForm } from '@shared/labelVoice'
import { localDayBounds } from '../lib/localDate'
import { scheduledEventKey, upsertMeetingAttendanceMark } from './meetingResolution'
import { setBlockLabelOverride } from '../db/queries'
import { writeTimelineBlockReview } from './workBlocks'
import { materializeTimelineDayProjection } from '../core/query/projections'
import { invalidateProjectionScope } from '../core/projections/invalidation'

// Only ask about a stretch big enough that getting its name wrong distorts the
// day; a short block is folded, not interrogated.
const MIN_UNNAMED_BLOCK_SECONDS = 30 * 60
const MIN_MEETING_MINUTES = 15
// A scheduled event is only askable once it is OVER. A meeting still ahead on
// the calendar has trivially no supporting evidence, so without this the day
// asks about every future event on it ("were you in the 3pm?" at 10am) and an
// answer would write an attendance mark for a meeting that has not happened.
// The pad past the end matches the matcher's MATCH_PAD_MS: the tail of a call
// is still being flushed into the facts for a few minutes after it ends, and
// asking inside that window means asking before the evidence arrives.
const MEETING_ENDED_GRACE_MS = 10 * 60 * 1000
// The person's attention is the scarce resource: at most a couple of questions
// per day, the most material first.
const MAX_CLARIFICATIONS = 2

// Labels that name no real activity — a coarse un-analyzed sitting or an
// unnamed block. A block wearing one of these is a candidate to ask about.
const NON_ACTIVITY_LABELS = new Set([
  'morning', 'afternoon', 'evening', 'night', 'late night',
  'earlier today', 'active now', 'untitled block', 'browsing', 'development',
  'communication', 'research', 'writing', 'design', 'meeting',
])

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function timeRange(startMs: number, endMs: number): string {
  return `${clock(startMs)}–${clock(endMs)}`
}

// True when a block carries no activity name a person would recognize — the
// signal that the evidence could not settle what it was.
function labelNamesNoActivity(label: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return true
  if (NON_ACTIVITY_LABELS.has(trimmed.toLowerCase())) return true
  if (rawLabelForm(trimmed)) return true
  return false
}

// Candidate activity names for an unnamed block, drawn only from its own
// evidence — the artifacts and pages actually open. The UI always adds a
// free-text option, so a block with thin evidence still gets answered.
function evidenceOptionsForBlock(block: WorkContextBlock): TimelineClarificationOption[] {
  const seen = new Set<string>()
  const options: TimelineClarificationOption[] = []
  const consider = (raw: string | null | undefined) => {
    const value = (raw ?? '').trim()
    if (!value || value.length > 80) return
    if (rawLabelForm(value)) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    options.push({ id: `opt${options.length}`, label: value })
  }
  for (const artifact of block.topArtifacts ?? []) {
    if (options.length >= 3) break
    consider(artifact.displayTitle)
  }
  for (const page of block.pageRefs ?? []) {
    if (options.length >= 3) break
    consider(page.pageTitle ?? page.displayTitle)
  }
  return options.slice(0, 3)
}

export function getSkippedClarificationIds(db: Database.Database, date: string): Set<string> {
  const rows = db.prepare(
    `SELECT clarification_id FROM timeline_clarification_skips WHERE date = ?`,
  ).all(date) as Array<{ clarification_id: string }>
  return new Set(rows.map((row) => row.clarification_id))
}

function skipClarification(db: Database.Database, date: string, clarificationId: string): void {
  db.prepare(`
    INSERT INTO timeline_clarification_skips (date, clarification_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(date, clarification_id) DO NOTHING
  `).run(date, clarificationId, Date.now())
}

// The material questions this day leaves open, most-material first, capped, and
// excluding anything the person already dismissed. Pure over the payload.
export function detectDayClarifications(
  db: Database.Database,
  payload: DayTimelinePayload,
  nowMs: number = Date.now(),
): TimelineClarification[] {
  const skipped = getSkippedClarificationIds(db, payload.date)
  const [dayStartMs] = localDayBounds(payload.date)
  const candidates: Array<{ weight: number; clarification: TimelineClarification }> = []

  // A scheduled meeting with no evidence it happened and no mark from the
  // person. A calendar row proves scheduling, not attendance — so ask.
  for (const meeting of payload.scheduledMeetings ?? []) {
    if (meeting.marked || meeting.attendance === 'matched') continue
    if (meeting.endMs + MEETING_ENDED_GRACE_MS > nowMs) continue
    const minutes = (meeting.endMs - meeting.startMs) / 60_000
    if (minutes < MIN_MEETING_MINUTES) continue
    // Never interrogate a window the person clearly worked through (DEV-284).
    // Tracked blocks covering most of the scheduled span already tell the
    // day's story; the answer would not materially change the account
    // (day-recap-and-analysis spec §The clarification contract).
    const coveredMs = payload.blocks.reduce((sum, block) => sum
      + Math.max(0, Math.min(block.endTime, meeting.endMs) - Math.max(block.startTime, meeting.startMs)), 0)
    if (coveredMs > (meeting.endMs - meeting.startMs) / 2) continue
    const eventKey = scheduledEventKey(Math.round((meeting.startMs - dayStartMs) / 60_000), meeting.title)
    const id = `${payload.date}:meeting:${eventKey}`
    if (skipped.has(id)) continue
    candidates.push({
      weight: meeting.endMs - meeting.startMs,
      clarification: {
        id,
        kind: 'unconfirmed-meeting',
        date: payload.date,
        timeRange: timeRange(meeting.startMs, meeting.endMs),
        question: `Were you in “${meeting.title}” (${timeRange(meeting.startMs, meeting.endMs)})?`,
        options: [
          { id: 'attended', label: 'Yes, I was there' },
          { id: 'skipped', label: 'No, I skipped it' },
          { id: 'moved', label: 'It moved' },
          { id: 'unrelated', label: 'Not a real meeting' },
        ],
        eventKey,
        meetingTitle: meeting.title,
      },
    })
  }

  // A substantial settled block the labeler could not name from evidence. A
  // provisional (un-analyzed) sitting is never interrogated — the whole day is
  // still coarse by design.
  for (const block of payload.blocks) {
    if (block.isLive || block.provisional) continue
    if (blockActiveSeconds(block) < MIN_UNNAMED_BLOCK_SECONDS) continue
    if (!labelNamesNoActivity(userVisibleBlockLabel(block))) continue
    const id = `${payload.date}:block:${block.id}`
    if (skipped.has(id)) continue
    candidates.push({
      weight: blockActiveSeconds(block) * 1000,
      clarification: {
        id,
        kind: 'unnamed-block',
        date: payload.date,
        timeRange: timeRange(block.startTime, block.endTime),
        question: `What were you working on from ${timeRange(block.startTime, block.endTime)}?`,
        options: evidenceOptionsForBlock(block),
        blockId: block.id,
      },
    })
  }

  return candidates
    .sort((left, right) => right.weight - left.weight)
    .slice(0, MAX_CLARIFICATIONS)
    .map((entry) => entry.clarification)
}

// Apply one answer. A skip is remembered; an answer writes the durable
// correction through the same stores a manual edit uses, so it survives every
// rebuild and grounds future days.
export function applyClarificationAnswer(
  db: Database.Database,
  date: string,
  answer: TimelineClarificationAnswer,
): void {
  if (answer.action === 'skip') {
    skipClarification(db, date, answer.id)
    return
  }

  if (answer.kind === 'unconfirmed-meeting' && answer.eventKey && answer.attendance) {
    upsertMeetingAttendanceMark(db, { date, eventKey: answer.eventKey, status: answer.attendance })
    invalidateProjectionScope('timeline', 'clarification-answer')
    return
  }

  if (answer.kind === 'unnamed-block' && answer.blockId && answer.label?.trim()) {
    const label = answer.label.trim()
    // Find the block in the current projection so the review anchors on its
    // evidence key (survives re-segmentation, like every other correction).
    const payload = materializeTimelineDayProjection(db, date, null)
    const block = payload.blocks.find((candidate) => candidate.id === answer.blockId)
    if (block) {
      writeTimelineBlockReview(db, date, block, { state: 'corrected', correctedLabel: label })
    }
    setBlockLabelOverride(db, answer.blockId, label, null)
    invalidateProjectionScope('timeline', 'clarification-answer')
    invalidateProjectionScope('apps', 'clarification-answer')
    invalidateProjectionScope('insights', 'clarification-answer')
  }
}
