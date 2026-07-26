// The ONE deterministic absence guard.
//
// A "real absence" is a stretch of 15+ minutes with no captured activity at
// all — the machine was asleep or locked, the user walked away, or capture was
// off. Whatever the cause, Daylens knows nothing about that time, and a block
// is genuine engagement (invariant 4: block height = duration; invariant 10:
// when Daylens doesn't know, it says so). Therefore NO merge decision — the
// heuristic pipeline, an AI regroup plan, an AI cleanup action, a stored
// boundary correction replayed on rebuild, or a manual user merge — may ever
// join work across a real absence. The AI and the user may propose groupings;
// this guard vetoes any group that spans a real gap.
//
// Every merge path routes through the checks in this module:
//   • mergeTimelineEpisodes (workBlocks.ts) — the single durable merge write
//     used by the manual Merge action, AI block-merge actions
//     (blockCorrections.ts), and the day-regroup in analyzeDay.ts.
//   • scoreBoundary (workBlocks.ts) — the rebuild-time arbiter: a real-absence
//     boundary is a hard cut that outranks every stored merge correction.
//   • analyzeTimelineDay (analyzeDay.ts) — partitions AI-proposed regroup
//     groups at real absences before merging, and detects already-stored
//     blocks that span one (the repair path).
//
// The detection is pure timestamp arithmetic over captured sessions, so it is
// deterministic and identical on macOS, Windows, and Linux.

export const REAL_ABSENCE_MIN_MS = 15 * 60_000

/** The minimal session shape the guard needs — satisfied by AppSession and by
 *  the CandidateBlock/WorkContextBlock session members. */
export interface GuardSession {
  startTime: number
  endTime?: number | null
  durationSeconds: number
}

export interface AbsenceGap {
  startMs: number
  endMs: number
}

/** The end of a session's CAPTURED EVIDENCE, as opposed to its wall-clock
 *  envelope. Exported for the segmentation seam (workBlocks.ts), which must
 *  never let an envelope-stretched row vouch for time nothing captured. */
export function evidenceSessionEndMs(session: GuardSession): number {
  const derived = session.startTime + Math.max(0, session.durationSeconds) * 1000
  if (typeof session.endTime !== 'number' || session.endTime <= session.startTime) return derived

  // end_time is a wall-clock envelope, while duration_sec is the captured
  // activity inside it. Normally they differ only by polling/rounding drift.
  // A difference large enough to be a real absence is not harmless drift:
  // trusting the envelope would manufacture continuous evidence where none
  // was captured (real row 1399 carried 236s across a 2,139s envelope).
  return session.endTime - derived >= REAL_ABSENCE_MIN_MS ? derived : session.endTime
}

/** True when a gap of this length between two stretches of captured activity
 *  is a real absence — the single 15-minute rule, one place. */
export function isRealAbsenceGap(gapMs: number, thresholdMs: number = REAL_ABSENCE_MIN_MS): boolean {
  return gapMs >= thresholdMs
}

/** Every real absence inside a run of sessions: gaps of `thresholdMs`+ between
 *  consecutive captured activity. Sessions may arrive unsorted or overlapping
 *  (browser + focus evidence often do); coverage is tracked by the furthest
 *  end seen so an early-starting long session can never fake a gap. */
export function findRealAbsences(
  sessions: readonly GuardSession[],
  thresholdMs: number = REAL_ABSENCE_MIN_MS,
): AbsenceGap[] {
  if (sessions.length < 2) return []
  const ordered = [...sessions].sort((a, b) => a.startTime - b.startTime)
  const gaps: AbsenceGap[] = []
  let coveredUntil = evidenceSessionEndMs(ordered[0])
  for (let index = 1; index < ordered.length; index++) {
    const session = ordered[index]
    if (isRealAbsenceGap(session.startTime - coveredUntil, thresholdMs)) {
      gaps.push({ startMs: coveredUntil, endMs: session.startTime })
    }
    coveredUntil = Math.max(coveredUntil, evidenceSessionEndMs(session))
  }
  return gaps
}

/** The guard itself: would one block made of exactly these sessions span a
 *  real absence? Returns the first spanned absence, or null when the join is
 *  legitimate. Used both to veto a proposed merge (pass the union of the
 *  merging blocks' sessions) and to detect an already-stored bad block (pass
 *  the block's own sessions). */
export function absenceSpannedBy(
  sessions: readonly GuardSession[],
  thresholdMs: number = REAL_ABSENCE_MIN_MS,
): AbsenceGap | null {
  return findRealAbsences(sessions, thresholdMs)[0] ?? null
}

/** Partition an ordered list of items (blocks) into runs that contain no real
 *  absence between or inside them. An AI regroup group that spans a gap is not
 *  discarded outright — the contiguous stretches on each side of the gap keep
 *  the AI's grouping intent and may still merge among themselves. */
export function partitionAtRealAbsences<T>(
  items: readonly T[],
  sessionsOf: (item: T) => readonly GuardSession[],
  thresholdMs: number = REAL_ABSENCE_MIN_MS,
): T[][] {
  const runs: T[][] = []
  let current: T[] = []
  let currentSessions: GuardSession[] = []
  for (const item of items) {
    const candidateSessions = [...currentSessions, ...sessionsOf(item)]
    if (current.length > 0 && absenceSpannedBy(candidateSessions, thresholdMs)) {
      runs.push(current)
      current = [item]
      currentSessions = [...sessionsOf(item)]
    } else {
      current.push(item)
      currentSessions = candidateSessions
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/** Human-readable clock range for veto/error messages ("8:01 PM – 9:39 PM"). */
export function formatAbsenceRange(gap: AbsenceGap): string {
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${fmt(gap.startMs)} – ${fmt(gap.endMs)}`
}
