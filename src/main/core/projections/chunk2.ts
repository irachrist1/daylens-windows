// Chunk 2 — Session + Block Projections.
//
// Pure deterministic projection over focus_events. Same events in,
// byte-identical derived_sessions and derived_blocks out. The live day is
// never projected unless an explicit finalize flag is passed — Day rollover
// finalization (D2) is the only caller that sets it for today.

import type Database from 'better-sqlite3'
import { classifyResult } from '../../services/tracking'
import { localDateString } from '../../lib/localDate'
import { ownedDayBounds } from '../../lib/dayOwnership'
import { naturalizeProjectionLabel } from './chunk2Label'
import {
  countFocusEventsInRange,
  listFocusEventsInRange,
  type StoredFocusEvent,
} from '../../db/focusEventRepository'

// Bump when segmentation or labeling logic changes. Reprojection rewrites
// any rows whose stored version is older. Idempotent.
// v2: app_deactivated only closes the session it belongs to — a stale
// deactivation of the PREVIOUS app no longer kills the newly activated one —
// and idle_started ends the open session (idle_ended resumes it when focus
// never moved), so a walk-away without lock/sleep is not counted as active.
export const PROJECTION_VERSION = 2

const IDLE_GAP_MS = 15 * 60 * 1000   // 15 min boundary between blocks
const MIN_SESSION_MS = 1000          // drop sub-second flicker

export interface DerivedSessionRow {
  start_ts_ms: number
  end_ts_ms: number
  active_seconds: number
  app_bundle_id: string | null
  app_name: string | null
  window_title: string | null
  url: string | null
  page_title: string | null
  confidence: 'observed' | 'uncertain'
  category: string
  is_browser: 0 | 1
  domain: string | null
}

interface DerivedBlockDraft {
  start_ts_ms: number
  end_ts_ms: number
  active_seconds: number
  label: string
  label_source: 'artifact' | 'domain' | 'app' | 'ai'
  dominant_category: string
  confidence: 'observed' | 'uncertain'
  session_indices: number[]
}

export interface ProjectDayOptions {
  // Live day projection is forbidden by policy. Day rollover finalization
  // and historical backfill pass `finalize: true` to opt in.
  finalize?: boolean
  // Optional clock override for testing.
  now?: Date
}

export interface ProjectDayResult {
  date: string
  events: number
  sessions: number
  blocks: number
  skipped: boolean
  reason?: string
}

// ---------- public entry point ----------

export function projectDay(
  db: Database.Database,
  date: string,
  opts: ProjectDayOptions = {},
): ProjectDayResult {
  const today = localDateString(opts.now ?? new Date())
  if (date === today && !opts.finalize) {
    return { date, events: 0, sessions: 0, blocks: 0, skipped: true, reason: 'live-day' }
  }
  if (date > today) {
    return { date, events: 0, sessions: 0, blocks: 0, skipped: true, reason: 'future' }
  }

  const [from, to] = ownedDayBounds(db, date)
  const events = listFocusEventsInRange(db, from, to)

  const sessions = foldSessions(events, to)
  const blocks = segmentBlocks(sessions)

  writeProjection(db, date, sessions, blocks)

  return {
    date,
    events: events.length,
    sessions: sessions.length,
    blocks: blocks.length,
    skipped: false,
  }
}

// ---------- projection 1: sessions ----------

interface OpenSession {
  start_ts_ms: number
  app_bundle_id: string | null
  app_name: string | null
  window_title: string | null
  url: string | null
  page_title: string | null
  confidence: 'observed' | 'uncertain'
}

/** Pure session fold over focus_events. Live and historical reads share this. */
export function projectSessionsFromFocusEvents(
  events: readonly StoredFocusEvent[],
  rangeEndMs: number,
): DerivedSessionRow[] {
  return foldSessions(events, rangeEndMs)
}

function foldSessions(events: readonly StoredFocusEvent[], dayEnd: number): DerivedSessionRow[] {
  const out: DerivedSessionRow[] = []
  let open: OpenSession | null = null
  let lastEventTs: number | null = null
  // The session an idle_started interrupted, remembered so idle_ended can
  // resume it: a user who walks away and comes back to the same app produces
  // no app_activated on return, and without the resume the stretch from
  // idle_ended to the next event would vanish.
  let resumeAfterIdle: OpenSession | null = null

  const close = (atMs: number) => {
    if (!open) return
    const start = open.start_ts_ms
    const end = Math.max(start, Math.min(atMs, dayEnd))
    const durationMs = end - start
    if (durationMs >= MIN_SESSION_MS) {
      out.push(buildSessionRow(open, end))
    }
    open = null
  }

  for (const ev of events) {
    switch (ev.event_type) {
      case 'capture_stopped': {
        // Capture is down from here: whatever was focused stops accruing.
        close(ev.ts_ms)
        resumeAfterIdle = null
        break
      }
      case 'capture_started': {
        // A session still open at a capture start means the previous run died
        // without a capture_stopped (crash, kill, wedged shutdown). Its
        // evidence truly ends at the last event that run managed to record —
        // extending it across the dead stretch would count downtime as
        // activity (observed: an overnight crash loop rendered as a night of
        // continuous app use).
        if (open) close(lastEventTs ?? ev.ts_ms)
        resumeAfterIdle = null
        break
      }
      case 'app_activated': {
        close(ev.ts_ms)
        resumeAfterIdle = null
        open = {
          start_ts_ms: ev.ts_ms,
          app_bundle_id: ev.app_bundle_id,
          app_name: ev.app_name,
          window_title: ev.window_title,
          url: null,
          page_title: null,
          confidence: ev.confidence === 'unknown' ? 'uncertain' : 'observed',
        }
        break
      }
      case 'tab_changed':
      case 'tab_sampled': {
        // A tab change ends the current session and starts a new one keyed
        // on the same app + new tab url. Spec: tab boundaries are real
        // boundaries even when the app didn't change.
        if (open) close(ev.ts_ms)
        resumeAfterIdle = null
        open = {
          start_ts_ms: ev.ts_ms,
          app_bundle_id: ev.app_bundle_id,
          app_name: ev.app_name,
          window_title: ev.window_title,
          url: ev.url,
          page_title: ev.page_title,
          confidence: ev.confidence === 'unknown' ? 'uncertain' : 'observed',
        }
        break
      }
      case 'app_deactivated': {
        // Capture emits the new app's activation BEFORE the old app's
        // deactivation (same timestamp, ordered by id). Closing whatever is
        // open on any deactivation let the old app's trailing event kill the
        // session that had just opened — apps that emit no tab events to
        // resurrect them (terminals, agent runners) lost nearly all their
        // time (a 212-minute Ghostty day projected as 12 minutes). Only the
        // deactivated app's own session closes; an event that carries no app
        // identity keeps the old unconditional close.
        if (deactivationClosesOpenSession(open, ev)) close(ev.ts_ms)
        // A deactivation for the idle-interrupted app means focus really
        // moved while the user was away — nothing to resume.
        if (resumeAfterIdle && deactivationClosesOpenSession(resumeAfterIdle, ev)) {
          resumeAfterIdle = null
        }
        break
      }
      case 'idle_started': {
        // The user stopped giving input: whatever is focused stops accruing,
        // exactly like the day-ownership span automaton. Without this cut, a
        // walk-away without lock/sleep counts the whole idle stretch as
        // active session time (a lunch break narrated as a deep-work run).
        // Copied field-by-field, not aliased: tsc 5.9's loop flow analysis
        // mis-narrows a nullable let aliased from another narrowed one.
        if (open) {
          resumeAfterIdle = {
            start_ts_ms: open.start_ts_ms,
            app_bundle_id: open.app_bundle_id,
            app_name: open.app_name,
            window_title: open.window_title,
            url: open.url,
            page_title: open.page_title,
            confidence: open.confidence,
          }
          close(ev.ts_ms)
        }
        break
      }
      case 'idle_ended': {
        // Input resumed. If focus never moved while away (no activation,
        // deactivation, or boundary since), the interrupted session resumes
        // from here — the idle stretch itself stays excluded.
        const interrupted: OpenSession | null = resumeAfterIdle
        if (!open && interrupted) {
          open = { ...interrupted, start_ts_ms: ev.ts_ms }
        }
        resumeAfterIdle = null
        break
      }
      case 'sleep':
      case 'lock': {
        close(ev.ts_ms)
        resumeAfterIdle = null
        break
      }
      case 'window_changed': {
        if (open && ev.window_title) open.window_title = ev.window_title
        break
      }
      // wake / unlock / space_changed do not bound a session by themselves.
      default:
        break
    }
    lastEventTs = ev.ts_ms
  }

  // Open session at end of window — close at day end. (For past days this is
  // exact; for in-progress finalization it bounds to dayEnd.)
  close(dayEnd)

  return out
}

/** Whether an app_deactivated event closes the currently open session: yes
 *  when ANY comparable identity axis (bundle id or app name) matches the open
 *  session — different capture sources can stamp different bundle ids for the
 *  same app — or when no axis is comparable at all (conservative unconditional
 *  close). Only a deactivation whose identity is known and disagrees on every
 *  comparable axis is skipped: that is the previous app's stale trailing
 *  event, not the open session's end. */
function deactivationClosesOpenSession(
  open: OpenSession | null,
  ev: Pick<StoredFocusEvent, 'app_bundle_id' | 'app_name'>,
): boolean {
  if (!open) return false
  const bundleComparable = Boolean(ev.app_bundle_id && open.app_bundle_id)
  const nameComparable = Boolean(ev.app_name && open.app_name)
  if (!bundleComparable && !nameComparable) return true
  if (bundleComparable && ev.app_bundle_id === open.app_bundle_id) return true
  if (nameComparable && ev.app_name === open.app_name) return true
  return false
}

function buildSessionRow(open: OpenSession, endMs: number): DerivedSessionRow {
  const startMs = open.start_ts_ms
  const activeSeconds = Math.max(0, Math.round((endMs - startMs) / 1000))
  const bundleId = open.app_bundle_id ?? ''
  const appName = open.app_name ?? ''
  const { category } = bundleId || appName
    ? classifyResult(bundleId, appName)
    : { category: 'uncategorized' as const }
  const isBrowser = category === 'browsing'
  const domain = isBrowser ? extractDomain(open.url) : null
  return {
    start_ts_ms: startMs,
    end_ts_ms: endMs,
    active_seconds: activeSeconds,
    app_bundle_id: open.app_bundle_id,
    app_name: open.app_name,
    window_title: open.confidence === 'uncertain' ? null : open.window_title,
    url: open.confidence === 'uncertain' ? null : open.url,
    page_title: open.confidence === 'uncertain' ? null : open.page_title,
    confidence: open.confidence,
    category: String(category),
    is_browser: isBrowser ? 1 : 0,
    domain,
  }
}

function extractDomain(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '').toLowerCase() || null
  } catch {
    return null
  }
}

// ---------- projection 2: blocks ----------

function segmentBlocks(sessions: DerivedSessionRow[]): DerivedBlockDraft[] {
  if (sessions.length === 0) return []
  const blocks: DerivedBlockDraft[] = []
  let current: { sessions: DerivedSessionRow[]; indices: number[] } | null = null

  const projectKey = (s: DerivedSessionRow): string => {
    if (s.is_browser && s.domain) return `dom:${s.domain}`
    if (s.app_bundle_id) return `app:${s.app_bundle_id}`
    if (s.app_name) return `app:${s.app_name.toLowerCase()}`
    return 'unknown'
  }

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    if (!current) {
      current = { sessions: [s], indices: [i] }
      continue
    }
    const last = current.sessions[current.sessions.length - 1]
    const gapMs = s.start_ts_ms - last.end_ts_ms

    const breakOnGap = gapMs >= IDLE_GAP_MS
    const breakOnCategory = s.category !== last.category && categoryMajor(s.category) !== categoryMajor(last.category)
    const breakOnProject = projectKey(s) !== projectKey(last) && breakProjectIsHard(last, s)

    if (breakOnGap || breakOnCategory || breakOnProject) {
      blocks.push(finalizeBlock(current.sessions, current.indices))
      current = { sessions: [s], indices: [i] }
    } else {
      current.sessions.push(s)
      current.indices.push(i)
    }
  }

  if (current) blocks.push(finalizeBlock(current.sessions, current.indices))
  return blocks
}

function breakProjectIsHard(prev: DerivedSessionRow, next: DerivedSessionRow): boolean {
  if (prev.category === next.category) {
    if (prev.is_browser && next.is_browser && prev.domain && next.domain) {
      return prev.domain !== next.domain
    }
    return false
  }
  return true
}

function categoryMajor(category: string): 'focus' | 'supporting' | 'ambient' {
  switch (category) {
    case 'development':
    case 'design':
    case 'writing':
    case 'research':
    case 'productivity':
    case 'aiTools':
    case 'spreadsheet':
    case 'editor':
      return 'focus'
    case 'communication':
    case 'email':
    case 'mail':
    case 'chat':
    case 'meetings':
    case 'meeting':
      return 'supporting'
    default:
      return 'ambient'
  }
}

function finalizeBlock(sessions: DerivedSessionRow[], indices: number[]): DerivedBlockDraft {
  const start = sessions[0].start_ts_ms
  const end = sessions[sessions.length - 1].end_ts_ms
  const activeSeconds = sessions.reduce((acc, s) => acc + s.active_seconds, 0)

  const catTotals = new Map<string, number>()
  for (const s of sessions) catTotals.set(s.category, (catTotals.get(s.category) ?? 0) + s.active_seconds)
  let dominantCategory = sessions[0].category
  let dominantSecs = -1
  for (const [cat, secs] of catTotals) {
    if (secs > dominantSecs) {
      dominantSecs = secs
      dominantCategory = cat
    }
  }

  const confidence: 'observed' | 'uncertain' = sessions.some((s) => s.confidence === 'observed')
    ? 'observed'
    : 'uncertain'

  const { label, source } = chooseLabel(sessions, dominantCategory)

  return {
    start_ts_ms: start,
    end_ts_ms: end,
    active_seconds: activeSeconds,
    label,
    label_source: source,
    dominant_category: dominantCategory,
    confidence,
    session_indices: indices,
  }
}

function chooseLabel(
  sessions: DerivedSessionRow[],
  dominantCategory: string,
): { label: string; source: 'artifact' | 'domain' | 'app' | 'ai' } {
  const dominantMajor = categoryMajor(dominantCategory)
  // C6: development-shaped blocks must not be labeled by browser tab titles.
  // Restrict artifact sourcing to sessions whose own category is coherent
  // with the block's dominant major.
  const coherent = sessions.filter((s) => categoryMajor(s.category) === dominantMajor)
  const pool = coherent.length > 0 ? coherent : sessions

  const artifact = pickArtifact(pool)
  if (artifact) {
    const cleaned = naturalizeProjectionLabel(artifact)
    if (cleaned) return { label: cleaned, source: 'artifact' }
  }

  const domain = pickDomain(pool)
  if (domain) {
    const cleaned = naturalizeProjectionLabel(domain)
    if (cleaned) return { label: cleaned, source: 'domain' }
  }

  const app = pickAppName(pool)
  if (app) {
    const cleaned = naturalizeProjectionLabel(app)
    if (cleaned) return { label: cleaned, source: 'app' }
  }

  return { label: 'Untitled activity', source: 'app' }
}

function pickArtifact(sessions: DerivedSessionRow[]): string | null {
  const totals = new Map<string, number>()
  for (const s of sessions) {
    const candidate = s.page_title || s.window_title
    if (!candidate) continue
    const key = candidate.trim()
    if (!key) continue
    totals.set(key, (totals.get(key) ?? 0) + s.active_seconds)
  }
  return pickMax(totals)
}

function pickDomain(sessions: DerivedSessionRow[]): string | null {
  const totals = new Map<string, number>()
  for (const s of sessions) {
    if (!s.is_browser || !s.domain) continue
    totals.set(s.domain, (totals.get(s.domain) ?? 0) + s.active_seconds)
  }
  return pickMax(totals)
}

function pickAppName(sessions: DerivedSessionRow[]): string | null {
  const totals = new Map<string, number>()
  for (const s of sessions) {
    const name = s.app_name?.trim()
    if (!name) continue
    totals.set(name, (totals.get(name) ?? 0) + s.active_seconds)
  }
  return pickMax(totals)
}

function pickMax(totals: Map<string, number>): string | null {
  let best: string | null = null
  let bestSecs = 0
  for (const [k, secs] of totals) {
    if (secs > bestSecs) {
      bestSecs = secs
      best = k
    }
  }
  return best
}

// ---------- writer ----------

function writeProjection(
  db: Database.Database,
  date: string,
  sessions: DerivedSessionRow[],
  blocks: DerivedBlockDraft[],
): void {
  const [from, to] = ownedDayBounds(db, date)
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM derived_block_sessions WHERE block_id IN (
      SELECT id FROM derived_blocks WHERE date = ?
    )`).run(date)
    db.prepare(`DELETE FROM derived_blocks WHERE date = ?`).run(date)
    db.prepare(`DELETE FROM derived_sessions WHERE date = ?`).run(date)

    const insertSession = db.prepare(`
      INSERT INTO derived_sessions
        (date, start_ts_ms, end_ts_ms, active_seconds,
         app_bundle_id, app_name, window_title, url, page_title,
         confidence, category, is_browser, domain, projection_version)
      VALUES
        (@date, @start_ts_ms, @end_ts_ms, @active_seconds,
         @app_bundle_id, @app_name, @window_title, @url, @page_title,
         @confidence, @category, @is_browser, @domain, @projection_version)
    `)
    const sessionIds: number[] = []
    for (const s of sessions) {
      const info = insertSession.run({
        date,
        start_ts_ms: s.start_ts_ms,
        end_ts_ms: s.end_ts_ms,
        active_seconds: s.active_seconds,
        app_bundle_id: s.app_bundle_id,
        app_name: s.app_name,
        window_title: s.window_title,
        url: s.url,
        page_title: s.page_title,
        confidence: s.confidence,
        category: s.category,
        is_browser: s.is_browser,
        domain: s.domain,
        projection_version: PROJECTION_VERSION,
      })
      sessionIds.push(Number(info.lastInsertRowid))
    }

    const insertBlock = db.prepare(`
      INSERT INTO derived_blocks
        (date, start_ts_ms, end_ts_ms, active_seconds, label, label_source,
         dominant_category, confidence, projection_version, finalized_at)
      VALUES
        (@date, @start_ts_ms, @end_ts_ms, @active_seconds, @label, @label_source,
         @dominant_category, @confidence, @projection_version, @finalized_at)
    `)
    const insertMember = db.prepare(`
      INSERT INTO derived_block_sessions (block_id, session_id) VALUES (?, ?)
    `)
    const now = Date.now()
    for (const b of blocks) {
      const info = insertBlock.run({
        date,
        start_ts_ms: b.start_ts_ms,
        end_ts_ms: b.end_ts_ms,
        active_seconds: b.active_seconds,
        label: b.label,
        label_source: b.label_source,
        dominant_category: b.dominant_category,
        confidence: b.confidence,
        projection_version: PROJECTION_VERSION,
        finalized_at: now,
      })
      const blockId = Number(info.lastInsertRowid)
      for (const idx of b.session_indices) {
        insertMember.run(blockId, sessionIds[idx])
      }
    }

    db.prepare(`
      INSERT INTO derived_projection_runs
        (date, projection_version, events_in, sessions_out, blocks_out, finalized_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        projection_version = excluded.projection_version,
        events_in = excluded.events_in,
        sessions_out = excluded.sessions_out,
        blocks_out = excluded.blocks_out,
        finalized_at = excluded.finalized_at,
        started_at = excluded.started_at
    `).run(date, PROJECTION_VERSION, queryEventCount(db, from, to), sessions.length, blocks.length, now, now)
  })

  tx()
}

function queryEventCount(db: Database.Database, from: number, to: number): number {
  return countFocusEventsInRange(db, from, to)
}

// ---------- reprojection sweep (used by D7 cache invalidation on version bump) ----------

export function reprojectStaleDays(
  db: Database.Database,
  opts: { now?: Date; maxDays?: number } = {},
): { reprojected: string[]; skipped: string[] } {
  const today = localDateString(opts.now ?? new Date())
  const rows = db.prepare(`
    SELECT date, projection_version
      FROM derived_projection_runs
     WHERE projection_version < ?
     ORDER BY date DESC
  `).all(PROJECTION_VERSION) as Array<{ date: string; projection_version: number }>

  const max = opts.maxDays ?? rows.length
  const reprojected: string[] = []
  const skipped: string[] = []
  for (const row of rows.slice(0, max)) {
    if (row.date === today) {
      skipped.push(row.date)
      continue
    }
    const result = projectDay(db, row.date, { finalize: true, now: opts.now })
    if (result.skipped) skipped.push(row.date)
    else reprojected.push(row.date)
  }
  return { reprojected, skipped }
}
