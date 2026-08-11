// Active duration for a work block.
//
// A block's wall-clock span (`endTime - startTime`) can far exceed the time the
// user was actually working: the block builder permits up to 15 minutes of gap
// between adjacent sessions before splitting (see workBlocks.ts), so a 30 minute
// block can span 2+ hours of wall clock. Use the sum of session durations as the
// truth for displayed durations.
//
// The measure must be additive over sessions: the day total is the sum over
// blocks, and re-partitioning the same sessions (a merge or split) must not
// change it. Clamping the summed durations to the block's span breaks that —
// a merged block spans the gap between its parts, so time clamped away before
// the merge reappears after it. Inflated per-session durations are clamped to
// each session's own span instead, which merges and splits cannot alter.

import type { WorkContextBlock, AppSession } from './types'

function sessionActiveSeconds(session: AppSession): number {
  const duration = Math.max(0, session.durationSeconds || 0)
  if (session.endTime == null) return duration
  const span = Math.max(0, Math.round((session.endTime - session.startTime) / 1000))
  return Math.min(duration, span)
}

export function blockActiveSeconds(block: Pick<WorkContextBlock, 'startTime' | 'endTime' | 'sessions'>): number {
  const span = Math.max(0, Math.round((block.endTime - block.startTime) / 1000))
  const sessions = block.sessions ?? []
  // No hydrated sessions at all (a provisional or calendar-shaped block):
  // the span is the only measure that exists. Such blocks never take part in
  // a merge (merges anchor on sessions), so this exception cannot break the
  // additivity below.
  if (sessions.length === 0) return Math.max(1, span)
  const summed = sessions.reduce(
    (sum, session: AppSession) => sum + sessionActiveSeconds(session),
    0,
  )
  // Sessions exist but carry no time: the additive answer is (almost) zero,
  // and falling back to the span here would let a merge change the total.
  return Math.max(1, summed)
}

// Duration that matches the clock range shown next to it. Clock displays
// truncate to whole minutes (8:55:23 reads as "8:55"), so a block running
// 8:55:23 → 9:09:48 should read "8:55 – 9:09 · 14m" — not 13m, even though
// the active-second sum may round down. Use this only when a duration
// appears alongside a "HH:MM – HH:MM" range; for standalone aggregates
// (rail totals, AI answers), keep blockActiveSeconds. See BUGS.md B11.
export function blockDisplayedSpanSeconds(block: Pick<WorkContextBlock, 'startTime' | 'endTime'>): number {
  const startMinute = Math.floor(block.startTime / 60_000)
  const endMinute = Math.floor(block.endTime / 60_000)
  return Math.max(1, (endMinute - startMinute) * 60)
}
