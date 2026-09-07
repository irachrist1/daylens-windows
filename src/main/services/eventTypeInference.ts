// Calendar event-type inference — what a calendar
// event most likely WAS: a class, a 1:1, a presentation, an interview, a
// workout, a team meeting, a solo deep-work block, or nothing distinctive
// (generic). Pure and deterministic: it only correlates signals Daylens
// ALREADY has on CalendarEventSignal (title, attendeeCount, durationMinutes,
// and an optional recurrence hint no connector populates yet) — no network
// call, no AI, nothing invented.
//
// This feeds resolveMeetings (enrichmentResolve.ts), which rides the result
// into DayEnrichment.meetings.items so the wrap writer MAY say "your ML
// class" instead of "the meeting" — but only when confidence clears the bar.
// A weak read always resolves to 'generic' at its true (low) confidence
// rather than forcing a label the evidence doesn't support (voice.md §2.1:
// never invent, never hedge — here that means "say nothing specific" instead
// of "guess and soften it with a maybe").

import type { CalendarEventSignal, EventType } from '@shared/types'

export interface EventTypeInferenceOptions {
  /** Best-effort "this repeats" signal from the calendar source, when known.
   *  No current connector (EventKit, Outlook COM) surfaces this cheaply, so
   *  it is always undefined/null in production today — accepted here so a
   *  future connector can feed it without changing this function's shape.
   *  null/undefined means "unknown", never treated as "does not recur". */
  isRecurring?: boolean | null
}

export interface EventTypeInference {
  type: EventType
  /** 0 (no signal) to 1 (unambiguous). Below CONFIDENCE_FLOOR the returned
   *  type is always 'generic' — the writer must stay literal. */
  confidence: number
}

/** Below this, we would rather say nothing specific than force a label. */
const CONFIDENCE_FLOOR = 0.5

function clamp01(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100
}

// ─── Title keyword rules ───────────────────────────────────────────────────
// Each rule is title text → (type, base confidence). Keyword evidence is the
// strongest signal we have, so these carry the highest base confidences.

const INTERVIEW_RE = /\binterviews?(ing)?\b/i
const ONE_ON_ONE_RE = /\b1[\s:-]?on[\s:-]?1\b|\b1:1\b|\bone[\s-]on[\s-]one\b/i
/** "- C1", "- CS101", "- BIO 220": a trailing course-code suffix, the
 *  giveaway of a school/course calendar export. */
const COURSE_CODE_RE = /-\s*[A-Za-z]{1,4}\s?\d{1,4}\b/
const CLASS_WORD_RE = /\b(class|lecture|seminar|course|lab|section|recitation)\b/i
const PRESENTATION_RE = /\b(review|proposal|presentation|demo|pitch|showcase|readout)\b/i
const TEAM_MEETING_RE = /\b(standup|stand-up|sync|weekly|training|all[\s-]hands|retro(spective)?)\b/i
const WORKOUT_RE = /\b(workout|gym|hiit|yoga|cardio|spin|pilates|crossfit)\b/i

interface Candidate { type: EventType; confidence: number }

function titleCandidates(title: string): Candidate[] {
  const out: Candidate[] = []
  if (!title) return out
  if (INTERVIEW_RE.test(title)) out.push({ type: 'interview', confidence: 0.92 })
  if (ONE_ON_ONE_RE.test(title)) out.push({ type: 'one_on_one', confidence: 0.9 })
  if (CLASS_WORD_RE.test(title) || COURSE_CODE_RE.test(title)) out.push({ type: 'class', confidence: 0.85 })
  if (WORKOUT_RE.test(title)) out.push({ type: 'workout', confidence: 0.88 })
  if (PRESENTATION_RE.test(title)) out.push({ type: 'presentation', confidence: 0.8 })
  if (TEAM_MEETING_RE.test(title)) out.push({ type: 'team_meeting', confidence: 0.75 })
  return out
}

// ─── Attendee-count rules ──────────────────────────────────────────────────
// Weaker evidence on its own (a 2-person event could be a real 1:1 or just a
// short planning chat), so these sit well below the keyword confidences.

function attendeeCandidate(attendeeCount: number | null): Candidate | null {
  if (attendeeCount == null) return null
  if (attendeeCount === 0) return { type: 'deep_work', confidence: 0.45 }
  if (attendeeCount <= 2) return { type: 'one_on_one', confidence: 0.55 }
  return { type: 'team_meeting', confidence: 0.4 } // 3+: could be class or meeting, both "a room full of people"
}

// ─── Duration modifiers ─────────────────────────────────────────────────────
// A small nudge, never a deciding vote: durations typical for a type add a
// little confidence, wildly atypical durations subtract a little.

function durationModifier(type: EventType, durationMinutes: number): number {
  switch (type) {
    case 'class':
      if (durationMinutes >= 45 && durationMinutes <= 120) return 0.03
      if (durationMinutes < 20 || durationMinutes > 180) return -0.1
      return 0
    case 'workout':
      if (durationMinutes >= 15 && durationMinutes <= 90) return 0.03
      if (durationMinutes > 150) return -0.1
      return 0
    case 'one_on_one':
      if (durationMinutes <= 45) return 0.02
      if (durationMinutes > 120) return -0.05
      return 0
    case 'interview':
      if (durationMinutes >= 20 && durationMinutes <= 90) return 0.03
      return 0
    case 'team_meeting':
      if (durationMinutes <= 60) return 0.02
      if (durationMinutes > 120) return -0.05
      return 0
    case 'deep_work':
      if (durationMinutes >= 45) return 0.05
      if (durationMinutes < 15) return -0.15
      return 0
    default:
      return 0
  }
}

/** A recurring event nudges toward the types that are typically standing
 *  events (classes, standing team syncs, recurring workouts) — small, since
 *  no connector currently supplies this signal. */
function recurrenceModifier(type: EventType, isRecurring: boolean | null | undefined): number {
  if (isRecurring !== true) return 0
  return type === 'class' || type === 'team_meeting' || type === 'workout' ? 0.05 : 0
}

/** Infer what a calendar event most likely was from signals Daylens already
 *  captured: title keywords, attendee count, duration, and (when a future
 *  connector supplies it) recurrence. Pure and deterministic — same input,
 *  same output, every time. Never returns a specific type below
 *  CONFIDENCE_FLOOR; a weak read is honestly 'generic'. */
export function inferEventType(
  event: CalendarEventSignal,
  opts: EventTypeInferenceOptions = {},
): EventTypeInference {
  const title = typeof event?.title === 'string' ? event.title : ''
  const durationMinutes = typeof event?.durationMinutes === 'number' && Number.isFinite(event.durationMinutes)
    ? event.durationMinutes
    : 0
  const attendeeCount = typeof event?.attendeeCount === 'number' ? event.attendeeCount : null

  const fromTitle = titleCandidates(title)
  const fromAttendees = attendeeCandidate(attendeeCount)

  // One score per distinct type: keyword evidence wins when both signals
  // exist for the same type (small agreement bonus); attendee-only evidence
  // is used as-is when no keyword spoke for that type.
  const scores = new Map<EventType, number>()
  for (const c of fromTitle) {
    scores.set(c.type, Math.max(scores.get(c.type) ?? 0, c.confidence))
  }
  if (fromAttendees) {
    const existing = scores.get(fromAttendees.type)
    if (existing != null) {
      scores.set(fromAttendees.type, existing + 0.05) // title + attendee count agree
    } else {
      scores.set(fromAttendees.type, fromAttendees.confidence)
    }
  }

  let bestType: EventType = 'generic'
  let bestScore = 0
  for (const [type, base] of scores) {
    const score = base + durationModifier(type, durationMinutes) + recurrenceModifier(type, opts.isRecurring)
    if (score > bestScore) { bestScore = score; bestType = type }
  }

  if (bestScore < CONFIDENCE_FLOOR) {
    return { type: 'generic', confidence: clamp01(bestScore) }
  }
  return { type: bestType, confidence: clamp01(bestScore) }
}
