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
export const PROJECTION_VERSION = 1

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
      case 'app_activated': {
        close(ev.ts_ms)
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
      case 'app_deactivated':
      case 'sleep':
      case 'lock': {
        close(ev.ts_ms)
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
  }

  // Open session at end of window — close at day end. (For past days this is
  // exact; for in-progress finalization it bounds to dayEnd.)
  close(dayEnd)

  return out
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

// ---------- adapter for legacy renderer types (D4) ----------

interface DerivedBlockRow {
  id: number
  date: string
  start_ts_ms: number
  end_ts_ms: number
  active_seconds: number
  label: string
  label_source: string
  dominant_category: string | null
  confidence: 'observed' | 'uncertain'
  projection_version: number
  finalized_at: number
}

interface DerivedSessionRowFull extends DerivedSessionRow {
  id: number
}

function hasDerivedDay(db: Database.Database, date: string): boolean {
  const row = db
    .prepare(`SELECT projection_version FROM derived_projection_runs WHERE date = ?`)
    .get(date) as { projection_version: number } | undefined
  return Boolean(row && row.projection_version === PROJECTION_VERSION)
}

interface DerivedDayBlock {
  id: string
  startTime: number
  endTime: number
  activeSeconds: number
  label: string
  labelSource: 'artifact' | 'domain' | 'app' | 'ai'
  dominantCategory: string
  confidence: 'observed' | 'uncertain'
  sessions: DerivedSessionRowFull[]
  topAppNames: string[]
  topDomains: string[]
}

export interface DerivedDayResult {
  date: string
  blocks: DerivedDayBlock[]
  sessions: DerivedSessionRowFull[]
}

export function readDerivedDay(db: Database.Database, date: string): DerivedDayResult | null {
  if (!hasDerivedDay(db, date)) return null
  const blockRows = db.prepare(`
    SELECT * FROM derived_blocks WHERE date = ? ORDER BY start_ts_ms ASC
  `).all(date) as DerivedBlockRow[]
  const sessionRows = db.prepare(`
    SELECT * FROM derived_sessions WHERE date = ? ORDER BY start_ts_ms ASC
  `).all(date) as DerivedSessionRowFull[]
  const memberRows = db.prepare(`
    SELECT bs.block_id, bs.session_id
      FROM derived_block_sessions bs
      JOIN derived_blocks b ON bs.block_id = b.id
     WHERE b.date = ?
  `).all(date) as Array<{ block_id: number; session_id: number }>

  const sessionsById = new Map<number, DerivedSessionRowFull>()
  for (const s of sessionRows) sessionsById.set(s.id, s)
  const sessionsByBlock = new Map<number, DerivedSessionRowFull[]>()
  for (const m of memberRows) {
    const arr = sessionsByBlock.get(m.block_id) ?? []
    const s = sessionsById.get(m.session_id)
    if (s) arr.push(s)
    sessionsByBlock.set(m.block_id, arr)
  }

  const blocks: DerivedDayBlock[] = blockRows.map((b) => {
    const sessions = sessionsByBlock.get(b.id) ?? []
    sessions.sort((x, y) => x.start_ts_ms - y.start_ts_ms)
    const appTotals = new Map<string, number>()
    const domainTotals = new Map<string, number>()
    for (const s of sessions) {
      if (s.app_name) appTotals.set(s.app_name, (appTotals.get(s.app_name) ?? 0) + s.active_seconds)
      if (s.is_browser && s.domain) domainTotals.set(s.domain, (domainTotals.get(s.domain) ?? 0) + s.active_seconds)
    }
    const topAppNames = [...appTotals.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k).slice(0, 5)
    const topDomains = [...domainTotals.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k).slice(0, 5)
    return {
      id: `derived_${b.id}`,
      startTime: b.start_ts_ms,
      endTime: b.end_ts_ms,
      activeSeconds: b.active_seconds,
      label: b.label,
      labelSource: b.label_source as 'artifact' | 'domain' | 'app' | 'ai',
      dominantCategory: b.dominant_category ?? 'uncategorized',
      confidence: b.confidence,
      sessions,
      topAppNames,
      topDomains,
    }
  })

  return { date, blocks, sessions: sessionRows }
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
