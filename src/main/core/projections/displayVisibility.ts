// Per-display visibility projection (#21 part 2).
//
// The cg_display_visibility stream records what each display SHOWED — the
// identity of the window occupying a display full-screen — while the
// foreground stream records what owned input focus. This module folds those
// samples into per-display visible sessions, then derives the honest product
// fact: spans where an app was visibly full-screen on a display while input
// focus lived elsewhere. That time is presence evidence ("visible/playing"),
// never input-focused foreground time, and every consumer must label it so.

import type Database from 'better-sqlite3'
import type { AppSession, SecondaryDisplayVisibleSpan } from '@shared/types'
import {
  listDisplayVisibilityEventsInRange,
  type ProjectionFocusEvent,
} from '../../db/focusEventRepository'
import { resolveCanonicalApp } from '../../lib/appIdentity'
import {
  getEvidenceExclusionsForRange,
  type EvidenceExclusionSpan,
} from '../../services/activityFacts'

// The helper samples every 5s and heartbeats every 10s. A hole longer than
// three heartbeats means the helper stopped proving the window was still
// there (crash, quit, permission loss) — the span ends at the last proof,
// never stretched across the hole.
const MAX_SAMPLE_GAP_MS = 30_000
// Sub-10s visibility is switching noise, mirroring MIN_SESSION_SEC on the
// foreground path.
const MIN_VISIBLE_SESSION_MS = 10_000

const MACHINE_BOUNDARY_EVENTS = new Set([
  'sleep',
  'lock',
  'capture_stopped',
  'capture_paused',
  'capture_failed',
])

export interface DisplayVisibleSession {
  displayId: number
  bundleId: string | null
  appName: string | null
  windowTitle: string | null
  startMs: number
  endMs: number
}

interface OpenVisibleSession {
  displayId: number
  bundleId: string | null
  appName: string | null
  windowTitle: string | null
  startMs: number
  lastProvenMs: number
}

function identityKey(bundleId: string | null, appName: string | null): string {
  return `${(bundleId ?? '').toLowerCase()}|${(appName ?? '').toLowerCase()}`
}

/** Fold display-visibility evidence into per-display visible sessions.
 *  Half-open intervals; a span never extends past its last proof
 *  (heartbeat/change) by more than MAX_SAMPLE_GAP_MS, and machine-state
 *  boundaries (sleep, lock, capture stop/pause/failure) close everything. */
export function foldDisplayVisibleSessions(
  events: readonly ProjectionFocusEvent[],
  rangeEndMs: number,
): DisplayVisibleSession[] {
  const sessions: DisplayVisibleSession[] = []
  const open = new Map<number, OpenVisibleSession>()

  const close = (session: OpenVisibleSession, atMs: number) => {
    // Honesty cap: continuity is only proven up to the last sample plus one
    // tolerated sampling hole.
    const endMs = Math.min(atMs, session.lastProvenMs + MAX_SAMPLE_GAP_MS, rangeEndMs)
    if (endMs - session.startMs >= MIN_VISIBLE_SESSION_MS) {
      sessions.push({
        displayId: session.displayId,
        bundleId: session.bundleId,
        appName: session.appName,
        windowTitle: session.windowTitle,
        startMs: session.startMs,
        endMs,
      })
    }
  }

  const closeAll = (atMs: number) => {
    for (const session of open.values()) close(session, atMs)
    open.clear()
  }

  for (const event of events) {
    if (MACHINE_BOUNDARY_EVENTS.has(event.event_type)) {
      closeAll(event.ts_ms)
      continue
    }
    if (event.source !== 'cg_display_visibility' || event.display_id === null) continue

    const displayId = event.display_id
    const current = open.get(displayId)
    const hasApp = event.app_bundle_id !== null || event.app_name !== null

    if (event.event_type === 'display_visible_sampled') {
      // Identity-free heartbeats ("still watching, nothing full-screen") are
      // capture-health signal only; they neither open nor close spans.
      if (!hasApp) continue
      if (current) {
        const sameIdentity =
          identityKey(current.bundleId, current.appName) === identityKey(event.app_bundle_id, event.app_name)
        // A heartbeat proves continuity only when it arrives inside the
        // tolerated hole; a late or different-identity one closes the old
        // span and opens a new one.
        if (sameIdentity && event.ts_ms - current.lastProvenMs <= MAX_SAMPLE_GAP_MS) {
          current.lastProvenMs = event.ts_ms
          if (event.window_title) current.windowTitle = event.window_title
          continue
        }
        close(current, event.ts_ms)
        open.delete(displayId)
      }
      open.set(displayId, {
        displayId,
        bundleId: event.app_bundle_id,
        appName: event.app_name,
        windowTitle: event.window_title,
        startMs: event.ts_ms,
        lastProvenMs: event.ts_ms,
      })
      continue
    }

    // display_visible_changed: close whatever was visible, open the new
    // occupant when there is one (null identity = the display cleared).
    if (current) {
      close(current, event.ts_ms)
      open.delete(displayId)
    }
    if (hasApp) {
      open.set(displayId, {
        displayId,
        bundleId: event.app_bundle_id,
        appName: event.app_name,
        windowTitle: event.window_title,
        startMs: event.ts_ms,
        lastProvenMs: event.ts_ms,
      })
    }
  }

  closeAll(rangeEndMs)
  return sessions.sort((a, b) => a.startMs - b.startMs || a.displayId - b.displayId)
}

export function rebuildDisplayVisibleSessions(
  db: Database.Database,
  fromMs: number,
  toMs: number,
): DisplayVisibleSession[] {
  return foldDisplayVisibleSessions(listDisplayVisibilityEventsInRange(db, fromMs, toMs), toMs)
}

function canonicalKey(bundleId: string | null, appName: string | null): string {
  const identity = resolveCanonicalApp(bundleId ?? '', appName ?? '')
  return (identity.canonicalAppId ?? bundleId ?? appName ?? '').toLowerCase()
}

interface Interval {
  start: number
  end: number
}

function subtractIntervals(span: Interval, holes: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [span]
  for (const hole of holes) {
    const next: Interval[] = []
    for (const piece of pieces) {
      if (hole.end <= piece.start || hole.start >= piece.end) {
        next.push(piece)
        continue
      }
      if (hole.start > piece.start) next.push({ start: piece.start, end: hole.start })
      if (hole.end < piece.end) next.push({ start: hole.end, end: piece.end })
    }
    pieces = next
  }
  return pieces
}

function visibleSessionMatchesExclusion(
  session: DisplayVisibleSession,
  exclusion: EvidenceExclusionSpan,
): boolean {
  if (exclusion.kind !== 'app') return false
  return Boolean(
    (exclusion.bundleId && session.bundleId === exclusion.bundleId)
    || (exclusion.appName && session.appName === exclusion.appName),
  )
}

/** The honest secondary-presence facts for a range: spans where an app was
 *  full-screen-visible on a display while it did NOT own input focus. Time an
 *  app was both visible and focused belongs to the foreground stream alone —
 *  it is subtracted here so no minute is ever counted twice. Evidence
 *  exclusions apply as the same final defense the corrected session reads use. */
export function deriveSecondaryVisibleSpans(
  visibleSessions: readonly DisplayVisibleSession[],
  focusedSessions: readonly Pick<AppSession, 'bundleId' | 'appName' | 'startTime' | 'endTime'>[],
  exclusions: readonly EvidenceExclusionSpan[] = [],
): SecondaryDisplayVisibleSpan[] {
  const focusedByApp = new Map<string, Interval[]>()
  for (const session of focusedSessions) {
    const key = canonicalKey(session.bundleId, session.appName)
    if (!key) continue
    const list = focusedByApp.get(key) ?? []
    // A still-open focused session owns focus from its start onward.
    list.push({ start: session.startTime, end: session.endTime ?? Number.MAX_SAFE_INTEGER })
    focusedByApp.set(key, list)
  }

  const spans: SecondaryDisplayVisibleSpan[] = []
  for (const session of visibleSessions) {
    if (exclusions.some((exclusion) =>
      visibleSessionMatchesExclusion(session, exclusion)
      && exclusion.startMs < session.endMs && exclusion.endMs > session.startMs)) {
      // Excluded evidence: drop the overlapping remainder entirely rather
      // than risk resurfacing what the person asked to hide.
      const holes = exclusions
        .filter((exclusion) => visibleSessionMatchesExclusion(session, exclusion))
        .map((exclusion) => ({ start: exclusion.startMs, end: exclusion.endMs }))
      for (const piece of subtractIntervals({ start: session.startMs, end: session.endMs }, holes)) {
        if (piece.end - piece.start >= MIN_VISIBLE_SESSION_MS) {
          spans.push(...visibleRemainder(session, piece, focusedByApp))
        }
      }
      continue
    }
    spans.push(...visibleRemainder(session, { start: session.startMs, end: session.endMs }, focusedByApp))
  }
  return spans.sort((a, b) => a.startTime - b.startTime || a.displayId - b.displayId)
}

function visibleRemainder(
  session: DisplayVisibleSession,
  span: Interval,
  focusedByApp: ReadonlyMap<string, Interval[]>,
): SecondaryDisplayVisibleSpan[] {
  const ownFocus = focusedByApp.get(canonicalKey(session.bundleId, session.appName)) ?? []
  return subtractIntervals(span, ownFocus)
    .filter((piece) => piece.end - piece.start >= MIN_VISIBLE_SESSION_MS)
    .map((piece) => ({
      displayId: session.displayId,
      bundleId: session.bundleId,
      appName: session.appName,
      windowTitle: session.windowTitle,
      startTime: piece.start,
      endTime: piece.end,
      presence: 'visible' as const,
    }))
}

/** Range read used by the Timeline day payload: rebuild visible sessions from
 *  canonical evidence, subtract input-focused ownership, apply exclusions. */
export function getSecondaryDisplayVisibleSpansForRange(
  db: Database.Database,
  fromMs: number,
  toMs: number,
  focusedSessions: readonly Pick<AppSession, 'bundleId' | 'appName' | 'startTime' | 'endTime'>[],
): SecondaryDisplayVisibleSpan[] {
  const visible = rebuildDisplayVisibleSessions(db, fromMs, toMs)
  if (visible.length === 0) return []
  return deriveSecondaryVisibleSpans(visible, focusedSessions, getEvidenceExclusionsForRange(db, fromMs, toMs))
}
