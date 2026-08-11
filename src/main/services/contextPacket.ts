// The context packet (agent-runtime-and-context.md §Context packet, §Context
// assembly, §Implementation starting point, DEV-181).
//
// The typed, inspectable, deterministic bundle an AI exchange starts from —
// assembled and recorded WITHOUT calling any model. Wiring the live chat loop
// to consume it is the follow-up ticket; this batch owns the structure, the
// assembly rules, and the ledger. The packet is:
//
//   deterministic — the same question against the same day state produces the
//     same items in the same order (proved by content fingerprint; only the
//     packet id and assembled-at timestamp differ between builds),
//   guarded — every item comes from the corrected read models (deleted and
//     excluded content cannot enter), high-sensitivity content stays out
//     unless its own permission allows it, and the same two privacy
//     boundaries as every agent tool result (tracking-exclusion filter +
//     secret sanitizer) run over the assembled items,
//   recorded — the packet is persisted BEFORE the request leaves the local
//     boundary, generalizing the DEV-184 file_disclosures ledger: each item
//     carries identity, version, source type, sensitivity, and the reason it
//     was selected, so "what did the model see" stays answerable later.
//
// The packet orients the agent; it does not replace tools. Narrow read tools
// still exist for on-demand investigation, and their results ride the same
// privacy boundaries they always did.
//
// LOCAL-ONLY: context_packets has no sync-allowlist keys and can never
// serialize into a remote payload (tests/syncAllowlist.test.ts).
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { DayTimelinePayload } from '@shared/types'
import { sanitizeToolResult } from '@shared/aiSanitize'
import { filterTrackingExcludedEvidence } from '@shared/evidencePrivacy'
import { trackingControlsStateFromSettings } from '@shared/trackingControls'
import { localDayBounds } from '../lib/localDate'
import { listFocusEventTimesInRange } from '../db/focusEventRepository'
import { getSettings } from './settings'
import { getTimelineDayPayload, userVisibleLabelForBlock } from './workBlocks'
import { searchExact, resolveQueryEntityMatches } from './exactSearch'
import type { SearchOptions } from '../db/queries'
import { ensureDayMemoryIndexed } from './memoryIndex'
import { searchByMeaning } from './semanticIndex'
import { SEMANTIC_MODEL_ID } from './semanticEmbedder'
import {
  listFileAccessGrants,
  classifyFileSensitivity,
  recordFileDisclosure,
  type FileSensitivity,
} from './fileAccess'
import { getScopedMemoryProfile } from './workMemoryProfile'
import { extractGranolaTranscript, getGranolaConnection } from './granolaCache'
import {
  browserPageCoverageNoteText,
  getCorrectedPageFactsForRange,
  hasMaterialPageCoverageShortfall,
} from './activityFacts'

/** Bump when the assembly rules change; part of every packet and fingerprint,
 *  so two packets are only comparable under the same policy. */
export const CONTEXT_POLICY_VERSION = 2

export type ContextItemKind =
  | 'day_fact'
  | 'corrected_fact'
  | 'entity'
  | 'search_exact'
  | 'search_semantic'
  | 'file_excerpt'

export type ContextSourceType = 'observed' | 'connected' | 'supplied' | 'inferred'

/** One disclosed item — the generalization of a file_disclosures row to every
 *  content kind: stable identity, content version, source type, sensitivity,
 *  and the reason it was selected. */
export interface ContextPacketItem {
  /** Stable identity of the underlying thing: block:<id>, memory:<rowid>,
   *  entity:<id>, fact:<id>, file:<path>, … — never a display name. */
  identity: string
  kind: ContextItemKind
  sourceType: ContextSourceType
  /** The concise factual statement or excerpt actually disclosed. */
  statement: string
  /** Content version when one exists: a file version fingerprint, the
   *  embedding model for by-meaning hits, the day projection the block came
   *  from. Null when the identity alone pins the content. */
  version: string | null
  /** Why this item was selected into the packet. */
  reason: string
  sensitivity: FileSensitivity
  date: string | null
  startMs: number | null
  endMs: number | null
}

export type ContextPurpose = 'answer' | 'interpret' | 'act'

export interface ResolvedContextTimeRange {
  startDate: string
  endDate: string
  dates: string[]
  resolution:
    | 'explicit'
    | 'today'
    | 'yesterday'
    | 'tomorrow'
    | 'relative_day'
    | 'this_week'
    | 'last_week'
    | 'this_month'
    | 'last_month'
    | 'weekday'
    | 'caller'
    | 'default'
}

export interface AgentToolDescriptor {
  name: string
  description: string
  source: 'daylens' | 'connector' | 'mcp'
  permissionState: 'available' | 'requires_permission'
}
export interface ConfirmedPreference {
  key: string
  value: string
}

export interface ContextActionTarget {
  kind: string
  id: string
  version: string | null
}

export interface ContextActionState {
  target: ContextActionTarget
  currentState: Record<string, unknown>
  proposedChange: Record<string, unknown>
  permissionState: 'permitted' | 'requires_permission' | 'denied'
  confirmationState: 'not_required' | 'required' | 'confirmed' | 'declined'
  expectedEffects: string[]
  undoOperation: {
    kind: string
    targetId: string | null
  } | null
}

export interface ContextBudget {
  maxItemsByKind: Record<ContextItemKind, number>
  maxFileExcerptChars: number
}

export interface ContextBudgetInput {
  maxItemsByKind?: Partial<Record<ContextItemKind, number>>
  maxFileExcerptChars?: number
}

export interface ContextPacketOmission {
  kind: ContextItemKind
  count: number
  reason:
    | 'excluded'
    | 'deleted'
    | 'unauthorized'
    | 'unavailable'
    | 'high-sensitivity'
    | 'tracking-excluded'
    | 'context-budget'
}

/** A material disagreement between sources, exposed instead of silently
 *  resolved (spec §Context assembly step 8). Two detectors are live: a
 *  person's correction outranking an automated label, and a browser whose
 *  page-level detail explains materially less time than its own verified
 *  foreground total (limited tab access — app time wins). */
export interface EvidenceConflict {
  kind: 'correction_overrides_inference' | 'page_detail_below_app_time'
  /** The disclosed item the conflict is about (e.g. block:<id>). */
  identity: string
  detail: string
  /** Who wins, per the information-authority order. */
  resolvedBy: 'correction' | 'foreground_time'
}

/** A stretch of a requested day with no capture signal — the packet says so
 *  instead of letting absence read as inactivity. */
export interface EvidenceGap {
  date: string
  startMs: number
  endMs: number
  kind: 'no-signal' | 'no-capture'
  detail: string
}

/** A permission state consulted during assembly. File access is the only
 *  permission system live today (DEV-184); connector and provider permissions
 *  join when their systems ship. */
export interface ContextPermission {
  kind: 'file_access'
  scopeKind: 'file' | 'folder'
  path: string
  state: 'indexed' | 'model_readable'
  allowHighSensitivity: boolean
}

/** The disclosure record for the whole exchange — what was made available,
 *  where it went, under which policy, and what was deliberately left out. */
export interface ContextDisclosure {
  destination: string
  leftDevice: boolean
  policyVersion: number
  itemCount: number
  counts: Partial<Record<ContextItemKind, number>>
  omissions: ContextPacketOmission[]
}

export interface ContextPacket {
  id: string
  purpose: ContextPurpose
  request: {
    originalText: string
    timeRange: ResolvedContextTimeRange
    dates: string[]
    entityIds: string[]
  }
  person: {
    timezone: string
    confirmedPreferences: ConfirmedPreference[]
  }
  items: ContextPacketItem[]
  conflicts: EvidenceConflict[]
  gaps: EvidenceGap[]
  permissions: ContextPermission[]
  tools: AgentToolDescriptor[]
  actionContext: ContextActionState | null
  contextBudget: ContextBudget
  disclosure: ContextDisclosure
  policyVersion: number
  /** sha256 over the deterministic content (request, dates, policy, items,
   *  conflicts, gaps, permissions) — the identity of "what the model would
   *  see", independent of when it was assembled. */
  contentFingerprint: string
  assembledAt: number
}

export interface BuildContextPacketInput {
  purpose: ContextPurpose
  question: string
  /** Explicit day scope. When absent, days are resolved from the question
   *  text (ISO dates, "yesterday") with today as the default. */
  dates?: string[]
  now?: Date
  timezone?: string
  /** Where the packet content is headed, e.g. "anthropic:claude-sonnet-4-5". */
  destination: string
  availableTools?: AgentToolDescriptor[]
  confirmedPreferences?: ConfirmedPreference[]
  actionContext?: ContextActionState | null
  contextBudget?: ContextBudgetInput
  omissions?: ContextPacketOmission[]
  /** Injectable day payloads keyed by date, so a caller that already
   *  materialized the day (day analysis) disclosed EXACTLY what it sends. */
  dayPayloads?: Record<string, DayTimelinePayload>
  /** The same filter scope the person-facing search carries. Assembling AI
   *  context from a filtered query must not widen it back out. */
  filters?: SearchOptions
}

// ─── Caps ────────────────────────────────────────────────────────────────────
// The initial packet orients the agent; tools investigate further. Caps keep
// the bundle inside a predictable budget without removing required evidence
// classes (spec §Context assembly step 10).
const MAX_DAY_FACTS_PER_DAY = 48
const MAX_CORRECTED_FACTS = 30
const MAX_ENTITIES = 8
const MAX_EXACT_HITS = 12
const MAX_SEMANTIC_HITS = 8
const MAX_FILE_EXCERPTS = 5
const FILE_EXCERPT_CHARS = 700
const MAX_CONNECTED_FACTS_PER_DAY = 12
const MAX_TRANSCRIPT_EXCERPTS = 2
const TRANSCRIPT_EXCERPT_CHARS = 700

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxItemsByKind: {
    day_fact: MAX_DAY_FACTS_PER_DAY + MAX_CONNECTED_FACTS_PER_DAY,
    corrected_fact: MAX_CORRECTED_FACTS,
    entity: MAX_ENTITIES,
    search_exact: MAX_EXACT_HITS,
    search_semantic: MAX_SEMANTIC_HITS,
    file_excerpt: MAX_FILE_EXCERPTS + MAX_TRANSCRIPT_EXCERPTS,
  },
  maxFileExcerptChars: FILE_EXCERPT_CHARS,
}

// ─── Time resolution ─────────────────────────────────────────────────────────

const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

function dateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day + days))
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

function dateWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}
function isCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day))
  return value.getUTCFullYear() === year
    && value.getUTCMonth() === month - 1
    && value.getUTCDate() === day
}

function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  for (let cursor = startDate; cursor <= endDate; cursor = shiftDate(cursor, 1)) {
    dates.push(cursor)
  }
  return dates
}

function range(
  dates: string[],
  resolution: ResolvedContextTimeRange['resolution'],
): ResolvedContextTimeRange {
  const invalidDate = dates.find((date) => !isCalendarDate(date))
  if (invalidDate) throw new Error(`Invalid context date: ${invalidDate}`)
  const ordered = [...new Set(dates)].sort()
  if (ordered.length === 0) throw new Error('A context time range requires at least one date')
  return {
    startDate: ordered[0],
    endDate: ordered[ordered.length - 1],
    dates: ordered,
    resolution,
  }
}

export function resolveContextTimeRange(
  question: string,
  now: Date,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ResolvedContextTimeRange {
  const today = dateInTimezone(now, timezone)
  ISO_DATE_RE.lastIndex = 0
  const explicit = [...question.matchAll(ISO_DATE_RE)]
    .map((match) => match[1])
    .filter(isCalendarDate)
  if (explicit.length > 0) return range(explicit, 'explicit')

  if (/\blast week\b/i.test(question)) {
    const thisMonday = shiftDate(today, -((dateWeekday(today) + 6) % 7))
    const endDate = shiftDate(thisMonday, -1)
    return range(datesBetween(shiftDate(endDate, -6), endDate), 'last_week')
  }
  if (/\bthis week\b/i.test(question)) {
    const startDate = shiftDate(today, -((dateWeekday(today) + 6) % 7))
    return range(datesBetween(startDate, today), 'this_week')
  }
  if (/\blast month\b/i.test(question)) {
    const [year, month] = today.split('-').map(Number)
    const endDate = shiftDate(`${year}-${String(month).padStart(2, '0')}-01`, -1)
    return range(datesBetween(`${endDate.slice(0, 7)}-01`, endDate), 'last_month')
  }
  if (/\bthis month\b/i.test(question)) {
    return range(datesBetween(`${today.slice(0, 7)}-01`, today), 'this_month')
  }

  const trailingDays = question.match(/\blast\s+(\d+)\s+days?\b/i)
  if (trailingDays) {
    const dayCount = Number(trailingDays[1])
    if (Number.isSafeInteger(dayCount) && dayCount > 0) {
      return range(datesBetween(shiftDate(today, -(dayCount - 1)), today), 'relative_day')
    }
  }
  const daysAgo = question.match(/\b(\d+)\s+days?\s+ago\b/i)
  if (daysAgo) {
    const dayCount = Number(daysAgo[1])
    if (Number.isSafeInteger(dayCount) && dayCount >= 0) {
      return range([shiftDate(today, -dayCount)], 'relative_day')
    }
  }
  if (/\byesterday\b/i.test(question)) return range([shiftDate(today, -1)], 'yesterday')
  if (/\btomorrow\b/i.test(question)) return range([shiftDate(today, 1)], 'tomorrow')
  if (/\btoday\b/i.test(question)) return range([today], 'today')

  for (const [weekday, name] of WEEKDAYS.entries()) {
    const match = question.match(new RegExp(`\\b(last\\s+)?${name}\\b`, 'i'))
    if (!match) continue
    let daysBack = (dateWeekday(today) - weekday + 7) % 7
    if (match[1] && daysBack === 0) daysBack = 7
    return range([shiftDate(today, -daysBack)], 'weekday')
  }
  return range([today], 'default')
}

export function resolveContextDates(
  question: string,
  now: Date,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string[] {
  return resolveContextTimeRange(question, now, timezone).dates
}

// ─── Assembly ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'how',
  'did',
  'does',
  'that',
  'this',
  'with',
  'about',
  'from',
  'have',
  'has',
  'you',
  'your',
  'today',
  'yesterday',
  'day',
  'week',
  'show',
  'tell',
  'much',
  'many',
  'time',
  'spend',
  'spent',
])

function questionTokens(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
    ),
  ]
}

function fmtClock(ms: number): string {
  const value = new Date(ms)
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

function dayFactItems(
  db: Database.Database,
  date: string,
  injected: DayTimelinePayload | undefined,
): { items: ContextPacketItem[]; conflicts: EvidenceConflict[] } {
  let payload: DayTimelinePayload
  try {
    payload = injected ?? getTimelineDayPayload(db, date, null)
  } catch (error) {
    console.warn('[contextPacket] day payload failed', date, error)
    return { items: [], conflicts: [] }
  }
  const items: ContextPacketItem[] = []
  const conflicts: EvidenceConflict[] = []
  for (const block of payload.blocks) {
    if (block.isLive) continue
    const label = userVisibleLabelForBlock(block)
    if (!label) continue
    const topApp = block.topApps[0]?.appName ?? null
    items.push({
      identity: `block:${block.id}`,
      kind: 'day_fact',
      sourceType: 'observed',
      statement: `${fmtClock(block.startTime)}–${fmtClock(block.endTime)} ${label}${topApp ? ` (${topApp})` : ''}`,
      version: block.heuristicVersion ?? null,
      reason: `Corrected timeline block on ${date}`,
      sensitivity: 'standard',
      date,
      startMs: block.startTime,
      endMs: block.endTime,
    })
    // Correction authority made visible: when a person's correction outranks
    // an automated label, the packet says so instead of silently presenting
    // the corrected text as if it were the only reading (spec §Information
    // authority, §Context assembly step 8).
    const corrected = block.review?.correctedLabel?.trim()
    const automated = block.aiLabel?.trim()
    if (corrected && automated && corrected !== automated) {
      conflicts.push({
        kind: 'correction_overrides_inference',
        identity: `block:${block.id}`,
        detail: `The person's correction "${corrected}" outranks the automated label "${automated}"`,
        resolvedBy: 'correction',
      })
    }
    if (items.length >= MAX_DAY_FACTS_PER_DAY) break
  }
  return { items, conflicts }
}

/** The day's connected-source activity records (repository work synced from a
 *  connector), so "what did I ship" answers can cite the connected evidence
 *  itself. The statement names the provider ("GitHub: merged pull request…")
 *  and the sourceType says 'connected' — never mistaken for captured
 *  activity. Identity shares the memory-record space exact search uses, so a
 *  citation resolves to the same record either path finds. */
function connectedActivityDayItems(db: Database.Database, date: string): ContextPacketItem[] {
  try {
    const rows = db
      .prepare(
        `
      SELECT rowid AS id, statement, start_ms, end_ms, sensitivity
      FROM memory_records
      WHERE date = ? AND record_kind = 'connected_activity' AND deleted_at IS NULL
      ORDER BY start_ms ASC
      LIMIT ?
    `,
      )
      .all(date, MAX_CONNECTED_FACTS_PER_DAY) as Array<{
      id: number
      statement: string
      start_ms: number
      end_ms: number
      sensitivity: 'standard' | 'personal' | 'high'
    }>
    return rows.map((row) => ({
      identity: `session:${row.id}`,
      kind: 'day_fact' as const,
      sourceType: 'connected' as const,
      statement: row.statement,
      version: null,
      reason: `Connected-source record on ${date}`,
      sensitivity: row.sensitivity,
      date,
      startMs: row.start_ms,
      endMs: row.end_ms,
    }))
  } catch (error) {
    console.warn('[contextPacket] connected day facts failed', date, error)
    return []
  }
}

// A browser whose page-level detail explains materially less time than its
// own verified foreground total is a disclosed conflict, not a silent
// undercount: the agent narrates "Dia foreground 3h42m, page detail 0h10m"
// instead of quoting the thin page list as the day (issue #21).
function pageCoverageConflicts(db: Database.Database, date: string): EvidenceConflict[] {
  try {
    const [fromMs, toMs] = localDayBounds(date)
    return getCorrectedPageFactsForRange(db, fromMs, toMs)
      .coverage.filter(hasMaterialPageCoverageShortfall)
      .map((entry) => ({
        kind: 'page_detail_below_app_time' as const,
        identity: `browser:${entry.canonicalBrowserId}:${date}`,
        detail: `On ${date}: ${browserPageCoverageNoteText(entry)}`,
        resolvedBy: 'foreground_time' as const,
      }))
  } catch (error) {
    console.warn('[contextPacket] page coverage check failed', date, error)
    return []
  }
}

// ─── Gaps ────────────────────────────────────────────────────────────────────

const GAP_THRESHOLD_MS = 15 * 60 * 1000
const MAX_GAPS_PER_DAY = 12

/** Stretches of a requested day with no capture signal, so absence is stated
 *  rather than read as inactivity. Named honestly: without machine-state
 *  reconstruction a silent stretch may be sleep, lock, idle, or a capture
 *  failure. */
function dayGaps(db: Database.Database, date: string): EvidenceGap[] {
  try {
    const [fromMs, toMs] = localDayBounds(date)
    const events = listFocusEventTimesInRange(db, fromMs, toMs)
    if (events.length === 0) {
      return [
        {
          date,
          startMs: fromMs,
          endMs: toMs,
          kind: 'no-capture',
          detail: 'No capture signal for this day',
        },
      ]
    }
    const gaps: EvidenceGap[] = []
    for (let index = 1; index < events.length && gaps.length < MAX_GAPS_PER_DAY; index += 1) {
      const startMs = events[index - 1].ts_ms
      const endMs = events[index].ts_ms
      if (endMs - startMs < GAP_THRESHOLD_MS) continue
      gaps.push({
        date,
        startMs,
        endMs,
        kind: 'no-signal',
        detail: `No capture signal ${fmtClock(startMs)}–${fmtClock(endMs)} — asleep, locked, idle, or capture failure`,
      })
    }
    return gaps
  } catch (error) {
    console.warn('[contextPacket] gap scan failed', date, error)
    return []
  }
}

// ─── Permissions ─────────────────────────────────────────────────────────────

/** The permission states consulted during assembly: every unrevoked file
 *  grant, in deterministic order. Inspecting the packet answers "what was the
 *  agent ALLOWED to use", not just what it used. */
function consultedPermissions(db: Database.Database): ContextPermission[] {
  try {
    return listFileAccessGrants(db)
      .map((grant) => ({
        kind: 'file_access' as const,
        scopeKind: grant.scope_kind,
        path: grant.path,
        state: grant.state,
        allowHighSensitivity: grant.allow_high_sensitivity === 1,
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.state.localeCompare(b.state))
  } catch (error) {
    console.warn('[contextPacket] permission snapshot failed', error)
    return []
  }
}

function wordBounded(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(haystack)
}

/**
 * Is the question about Daylens' own memory rather than about the person's day?
 *
 * This decides whether unconfirmed (drafted) profile facts may enter the packet
 * — see `correctedFactItems`. Deliberately narrow: it must match a person
 * asking to see what Daylens believes, and must not match an ordinary activity
 * question that merely contains the word "work" or "know".
 */
const ASKS_WHAT_DAYLENS_KNOWS = [
  /\bwhat\s+(do|does)\s+(you|daylens)\s+(know|remember)\b/i,
  /\bwhat\s+(have|has)\s+(you|daylens)\s+(learned|learnt|inferred|remembered)\b/i,
  /\b(know|knows|remember|remembers)\s+about\s+(me|my)\b/i,
  /\b(your|daylens'?s?)\s+memory\b/i,
]

function asksWhatDaylensKnows(question: string): boolean {
  return ASKS_WHAT_DAYLENS_KNOWS.some((pattern) => pattern.test(question))
}

function correctedFactItems(db: Database.Database, question: string): ContextPacketItem[] {
  const items: ContextPacketItem[] = []
  const push = (fact: { id: string; text: string; origin: string }, reason: string): void => {
    if (items.length >= MAX_CORRECTED_FACTS) return
    items.push({
      identity: `fact:${fact.id}`,
      kind: 'corrected_fact',
      // Only an explicitly confirmed or hand-entered fact is `supplied`;
      // evidence-drafted rows awaiting confirmation are `inferred` (DEV-185,
      // spec §Memory types).
      sourceType: fact.origin === 'user' ? 'supplied' : 'inferred',
      statement: fact.text,
      version: null,
      reason,
      sensitivity: 'standard',
      date: null,
      startMs: null,
      endMs: null,
    })
  }
  try {
    // General memory always rides along (memory.md §2.2); a client's scoped
    // memory joins only when the question names that client.
    //
    // Which tier of the profile rides along depends on what is being asked.
    //
    // For an ordinary question about the person's activity, only CONFIRMED
    // facts enter AI context (WO-18 / AC-SM-012.1). A drafted fact is an
    // unconfirmed inference; carried in as background it reads as something
    // Daylens knows, and the model repeats it as established. That leak stays
    // closed.
    //
    // A question about Daylens' own memory is the one case where withholding
    // them is the dishonest answer: the person is asking to see what Daylens
    // believes about them — largely so they can confirm or reject it — and a
    // confirmed-only reply hides exactly the drafts they asked about. There the
    // drafts do ride along, as `inferred` items whose reason says they are
    // awaiting confirmation, so nothing downstream can mistake one for a fact
    // the person stands behind.
    const confirmedOnly = !asksWhatDaylensKnows(question)
    const profile = getScopedMemoryProfile(db, confirmedOnly)
    for (const fact of profile.general) {
      push(
        fact,
        fact.origin === 'user'
          ? 'Fact the person supplied and confirmed'
          : 'Fact drafted from real evidence, awaiting confirmation in the editable memory profile',
      )
    }
    for (const group of profile.clients) {
      if (group.clientName.trim().length < 3 || !wordBounded(question, group.clientName.trim()))
        continue
      for (const fact of group.facts) {
        push(fact, `Scoped memory for ${group.clientName}, named by the question`)
      }
    }
  } catch (error) {
    console.warn('[contextPacket] corrected facts failed', error)
  }
  return items
}

function entityItems(
  db: Database.Database,
  question: string,
): { items: ContextPacketItem[]; entityIds: string[] } {
  const byId = new Map<string, ContextPacketItem>()
  try {
    const queries = [question, ...questionTokens(question)]
    for (const query of queries) {
      if (byId.size >= MAX_ENTITIES) break
      for (const match of resolveQueryEntityMatches(db, query)) {
        if (byId.size >= MAX_ENTITIES) break
        if (byId.has(match.entity.id)) continue
        byId.set(match.entity.id, {
          identity: `entity:${match.entity.id}`,
          kind: 'entity',
          sourceType: match.entity.origin,
          statement: `${match.entity.entity_type}: ${match.entity.canonical_name}`,
          version: null,
          reason: match.matchedAlias
            ? `The question matched the alias "${match.matchedAlias}"`
            : 'The question named this entity',
          sensitivity: 'standard',
          date: null,
          startMs: null,
          endMs: null,
        })
      }
    }
  } catch (error) {
    console.warn('[contextPacket] entity resolution failed', error)
  }
  const items = [...byId.values()].sort((a, b) => a.identity.localeCompare(b.identity))
  return { items, entityIds: items.map((item) => item.identity.slice('entity:'.length)) }
}

/** True when a session-typed search hit is backed by a memory record marked
 *  high-sensitivity. Exact search may serve such rows to its own surfaces;
 *  the packet keeps them out (spec: high-sensitivity content needs its own
 *  model-access permission, and no memory path grants one today). The rowid
 *  space is shared with the legacy fallback, so a collision drops a standard
 *  row — conservative: an omission, never a leak. */
function backedByHighSensitivityRecord(db: Database.Database, id: number): boolean {
  try {
    return (
      db.prepare(`SELECT 1 FROM memory_records WHERE rowid = ? AND sensitivity = 'high'`).get(id) !=
      null
    )
  } catch {
    return false
  }
}

function exactSearchItems(
  db: Database.Database,
  question: string,
  scope: SearchOptions,
): { items: ContextPacketItem[]; omittedHighSensitivity: number } {
  let omittedHighSensitivity = 0
  try {
    const results = searchExact(db, question, { ...scope, limit: MAX_EXACT_HITS })
    const items: ContextPacketItem[] = []
    for (const result of results) {
      if (result.type === 'entity') continue // covered by the entity section
      if (result.type === 'session' && backedByHighSensitivityRecord(db, result.id)) {
        omittedHighSensitivity += 1
        continue
      }
      const statement =
        result.type === 'session'
          ? `${result.appName}${result.windowTitle ? ` — ${result.windowTitle}` : ''}`
          : result.type === 'browser'
            ? `${result.pageTitle ?? result.domain}${result.url ? ` (${result.url})` : ''}`
            : result.type === 'artifact'
              ? result.title
              : result.label
      items.push({
        identity: `${result.type}:${result.id}`,
        kind: 'search_exact',
        sourceType: ('sourceType' in result ? result.sourceType : undefined) ?? 'observed',
        statement,
        version: null,
        reason: 'Exact local search matched the question',
        sensitivity: 'standard',
        date: result.date || null,
        startMs: result.startTime,
        endMs: result.endTime,
      })
      if (items.length >= MAX_EXACT_HITS) break
    }
    return { items, omittedHighSensitivity }
  } catch (error) {
    console.warn('[contextPacket] exact search failed', error)
    return { items: [], omittedHighSensitivity }
  }
}

async function semanticSearchItems(
  db: Database.Database,
  question: string,
  scope: SearchOptions,
  excludeIdentities: ReadonlySet<string>,
): Promise<ContextPacketItem[]> {
  try {
    const moments = await searchByMeaning(db, question, { ...scope, limit: MAX_SEMANTIC_HITS })
    return moments
      .filter((moment) => !excludeIdentities.has(`session:${moment.id}`))
      .map((moment) => ({
        identity: `session:${moment.id}`,
        kind: 'search_semantic' as const,
        sourceType: moment.sourceType ?? 'observed',
        statement: `${moment.appName}${moment.windowTitle ? ` — ${moment.windowTitle}` : ''}`,
        version: SEMANTIC_MODEL_ID,
        reason: `Similar by meaning (local embedding, similarity ${(moment.similarity ?? 0).toFixed(2)})`,
        sensitivity: 'standard' as const,
        date: moment.date || null,
        startMs: moment.startTime,
        endMs: moment.endTime,
      }))
  } catch (error) {
    console.warn('[contextPacket] semantic search failed; packet unaffected', error)
    return []
  }
}

function derivedTextFingerprint(text: string, extractedAt: number | null): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
  return `${text.length}-${extractedAt ?? 0}-${hash}`
}

function fileExcerptItems(
  db: Database.Database,
  question: string,
  maxExcerptChars: number,
): { items: ContextPacketItem[]; omittedHighSensitivity: number } {
  const items: ContextPacketItem[] = []
  let omittedHighSensitivity = 0
  try {
    const tokens = questionTokens(question)
    if (tokens.length === 0) return { items, omittedHighSensitivity }
    // Only unrevoked model_readable grants may disclose content, and only when
    // the grant already carries locally extracted text — the packet never
    // reads a file the person did not make model-readable.
    const grants = listFileAccessGrants(db)
      .filter((grant) => grant.state === 'model_readable' && grant.derived_text)
      .sort((a, b) => a.path.localeCompare(b.path))
    for (const grant of grants) {
      if (items.length >= MAX_FILE_EXCERPTS) break
      const derived = grant.derived_text ?? ''
      const haystack = `${path.basename(grant.path)} ${derived}`.toLowerCase()
      if (!tokens.some((token) => haystack.includes(token))) continue
      const sensitivity = classifyFileSensitivity(grant.path)
      // High-sensitivity content requires the explicit flag on the covering
      // grant (spec §File and document access) — same rule as the read tools.
      if (sensitivity === 'high' && !grant.allow_high_sensitivity) {
        omittedHighSensitivity += 1
        continue
      }
      const excerpt = derived.slice(0, maxExcerptChars)
      items.push({
        identity: `file:${grant.path}`,
        kind: 'file_excerpt',
        sourceType: 'observed',
        statement: `${path.basename(grant.path)}: ${excerpt}`,
        version: derivedTextFingerprint(derived, grant.derived_text_extracted_at),
        reason: 'Granted model-readable file whose extracted text matches the question',
        sensitivity,
        date: null,
        startMs: null,
        endMs: null,
      })
    }
  } catch (error) {
    console.warn('[contextPacket] file excerpts failed', error)
  }
  return { items, omittedHighSensitivity }
}

// ─── Granola transcript excerpts (DEV-193) ───────────────────────────────────
// Transcripts are HIGH-sensitivity content and are never ingested: no ledger
// row, no day layer, no memory record, no index entry. They can be DISCLOSED
// in exactly one situation — the question EXPLICITLY asks for what was said —
// and the disclosure rides the packet ledger like every other item: recorded
// locally, with identity, sensitivity, and the reason, BEFORE the request
// leaves the device. `kind: 'file_excerpt'` is deliberate: the transcript is
// a local file-backed excerpt and follows the same high-sensitivity item rule
// the file path already enforces.

const TRANSCRIPT_REQUEST_RE =
  /\btranscripts?\b|\bverbatim\b|\bword for word\b|\bexact(?:ly)?\s+(?:what\s+)?(?:was|were)\s+said\b|\bwhat\s+did\s+[^?]{0,60}\bsay\b/i

function granolaTranscriptItems(
  db: Database.Database,
  question: string,
  dates: readonly string[],
  maxExcerptChars: number,
): ContextPacketItem[] {
  // The explicit-need gate: no transcript-shaped question, no retrieval —
  // not even a file read happens.
  if (!TRANSCRIPT_REQUEST_RE.test(question)) return []
  // The SAME policy switch the read_meeting_notes tool enforces
  // (contextTools.ts): Granola access off means no meeting content reaches a
  // prompt through ANY path — the packet must not ship what the tool refuses.
  if (getSettings().granolaAccessEnabled === false) return []
  const items: ContextPacketItem[] = []
  try {
    const connection = getGranolaConnection(db)
    if (!connection) return []
    const cachePath = connection.cachePath

    const tokens = questionTokens(question)
    const marks = dates.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `
      SELECT source_record_id, effective_at, envelope_json FROM connector_records
      WHERE connector_id = 'granola' AND kind = 'meeting_record'
        AND date IN (${marks}) AND tombstoned_at IS NULL
      ORDER BY effective_at ASC
    `,
      )
      .all(...dates) as Array<{
      source_record_id: string
      effective_at: number | null
      envelope_json: string
    }>

    let raw: string | null = null
    for (const row of rows) {
      if (items.length >= MAX_TRANSCRIPT_EXCERPTS) break
      let title = ''
      try {
        const envelope = JSON.parse(row.envelope_json) as { entity?: { title?: unknown } }
        title = typeof envelope.entity?.title === 'string' ? envelope.entity.title : ''
      } catch {
        continue
      }
      // The excerpt is scoped to the meeting the question names; a bare
      // "show me the transcript" with several meetings on the day still
      // discloses only meetings whose title the question mentions — unless
      // the day has exactly one, which needs no name.
      const titleMatches = tokens.some((token) => title.toLowerCase().includes(token))
      if (!titleMatches && rows.length > 1) continue
      const docId = row.source_record_id.replace(/^note:/, '')
      if (raw == null) {
        try {
          raw = readFileSync(cachePath, 'utf8')
        } catch {
          return []
        }
      }
      const transcript = extractGranolaTranscript(raw, docId)
      if (!transcript) continue
      const excerpt = transcript.slice(0, Math.min(maxExcerptChars, TRANSCRIPT_EXCERPT_CHARS))
      items.push({
        identity: `transcript:granola:${docId}`,
        kind: 'file_excerpt',
        sourceType: 'connected',
        statement: `Granola transcript of "${title}": ${excerpt}`,
        version: derivedTextFingerprint(transcript, row.effective_at),
        reason:
          'Transcript excerpt — this question explicitly asked for what was said; disclosed under high-sensitivity rules and recorded here',
        sensitivity: 'high',
        date: null,
        startMs: row.effective_at,
        endMs: row.effective_at,
      })
    }
  } catch (error) {
    console.warn('[contextPacket] transcript excerpts failed', error)
  }
  return items
}

const KIND_ORDER: Record<ContextItemKind, number> = {
  day_fact: 0,
  corrected_fact: 1,
  entity: 2,
  search_exact: 3,
  search_semantic: 4,
  file_excerpt: 5,
}

function sortItems(items: ContextPacketItem[]): ContextPacketItem[] {
  return [...items].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.startMs ?? 0) - (b.startMs ?? 0) ||
      a.identity.localeCompare(b.identity),
  )
}
function boundedInteger(value: number | undefined, fallback: number): number {
  if (value == null) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Context budget values must be non-negative safe integers')
  }
  return Math.min(value, fallback)
}

function resolveContextBudget(
  input: ContextBudgetInput | undefined,
  dayCount: number,
): ContextBudget {
  const defaultDayFacts = DEFAULT_CONTEXT_BUDGET.maxItemsByKind.day_fact * dayCount
  const maxFileExcerptChars = boundedInteger(input?.maxFileExcerptChars, FILE_EXCERPT_CHARS)
  return {
    maxItemsByKind: {
      day_fact: boundedInteger(input?.maxItemsByKind?.day_fact, defaultDayFacts),
      corrected_fact: boundedInteger(input?.maxItemsByKind?.corrected_fact, MAX_CORRECTED_FACTS),
      entity: boundedInteger(input?.maxItemsByKind?.entity, MAX_ENTITIES),
      search_exact: boundedInteger(input?.maxItemsByKind?.search_exact, MAX_EXACT_HITS),
      search_semantic: boundedInteger(input?.maxItemsByKind?.search_semantic, MAX_SEMANTIC_HITS),
      file_excerpt: maxFileExcerptChars === 0
        ? 0
        : boundedInteger(
            input?.maxItemsByKind?.file_excerpt,
            DEFAULT_CONTEXT_BUDGET.maxItemsByKind.file_excerpt,
          ),
    },
    maxFileExcerptChars,
  }
}

function normalizeTools(tools: readonly AgentToolDescriptor[]): AgentToolDescriptor[] {
  return [...tools]
    .map((tool) => ({ ...tool }))
    .sort((a, b) =>
      a.source.localeCompare(b.source)
      || a.name.localeCompare(b.name)
      || a.description.localeCompare(b.description)
      || a.permissionState.localeCompare(b.permissionState))
}
function normalizeConfirmedPreferences(
  preferences: readonly ConfirmedPreference[],
): ConfirmedPreference[] {
  return [...preferences]
    .map((preference) => ({ ...preference }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value))
}

function fitItemsToBudget(
  items: readonly ContextPacketItem[],
  budget: ContextBudget,
): { items: ContextPacketItem[]; omissions: ContextPacketOmission[] } {
  const counts: Partial<Record<ContextItemKind, number>> = {}
  const omitted: Partial<Record<ContextItemKind, number>> = {}
  const selected: ContextPacketItem[] = []
  for (const item of items) {
    const count = counts[item.kind] ?? 0
    if (count >= budget.maxItemsByKind[item.kind]) {
      omitted[item.kind] = (omitted[item.kind] ?? 0) + 1
      continue
    }
    counts[item.kind] = count + 1
    selected.push(item)
  }
  return {
    items: selected,
    omissions: (Object.keys(KIND_ORDER) as ContextItemKind[])
      .filter((kind) => (omitted[kind] ?? 0) > 0)
      .map((kind) => ({ kind, count: omitted[kind] ?? 0, reason: 'context-budget' })),
  }
}

function mergeOmissions(omissions: readonly ContextPacketOmission[]): ContextPacketOmission[] {
  const counts = new Map<string, ContextPacketOmission>()
  for (const omission of omissions) {
    if (!Number.isSafeInteger(omission.count) || omission.count <= 0) continue
    const key = `${omission.kind}:${omission.reason}`
    const current = counts.get(key)
    counts.set(key, {
      kind: omission.kind,
      reason: omission.reason,
      count: (current?.count ?? 0) + omission.count,
    })
  }
  return [...counts.values()].sort((a, b) =>
    (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    || a.reason.localeCompare(b.reason))
}
function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function contentFingerprint(content: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableJson({ policy: CONTEXT_POLICY_VERSION, ...content }))
    .digest('hex')
}

/**
 * Assemble the packet, deterministically, in the spec's order: resolve time,
 * resolve entities, corrected structured facts before broad search, exact and
 * semantic retrieval inside the resolved scope, granted file excerpts, then
 * exclusion/sensitivity rules and the two privacy boundaries before anything
 * is ranked into the final bundle.
 */
export async function buildContextPacket(
  db: Database.Database,
  input: BuildContextPacketInput,
): Promise<ContextPacket> {
  const now = input.now ?? new Date()
  const originalQuestion = input.question
  const question = input.question.trim()
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const tools = normalizeTools(input.availableTools ?? [])
  const confirmedPreferences = normalizeConfirmedPreferences(input.confirmedPreferences ?? [])
  const actionContext = input.actionContext
    ? JSON.parse(stableJson(input.actionContext)) as ContextActionState
    : null
  if (input.purpose === 'act' && actionContext == null) {
    throw new Error('Action context is required for an action-purpose context packet')
  }
  const timeRange = input.dates && input.dates.length > 0
    ? range(input.dates, 'caller')
    : resolveContextTimeRange(question, now, timezone)
  const dates = timeRange.dates
  const contextBudget = resolveContextBudget(input.contextBudget, dates.length)
  const explicitScope = timeRange.resolution !== 'default'

  // Keep the queried days' projections current so retrieval reads the same
  // corrected facts Timeline shows (cheap fingerprint check when unchanged).
  for (const date of dates) {
    try {
      ensureDayMemoryIndexed(db, date)
    } catch (error) {
      console.warn('[contextPacket] day index refresh failed', date, error)
    }
  }

  // A question with an explicit day scope searches inside it; an open recall
  // question ("that TV page…") searches the whole local history.
  // The caller's filters are the floor; an explicit day scope narrows on top of
  // them. A date the caller filtered to is never widened by the question text.
  const searchScope: SearchOptions = explicitScope
    ? { ...input.filters, startDate: dates[0], endDate: dates[dates.length - 1] }
    : { ...input.filters }

  const dayResults = dates.map((date) => dayFactItems(db, date, input.dayPayloads?.[date]))
  const dayFacts = [
    ...dayResults.flatMap((result) => result.items),
    ...dates.flatMap((date) => connectedActivityDayItems(db, date)),
  ]
  const conflicts = [
    ...dayResults.flatMap((result) => result.conflicts),
    ...dates.flatMap((date) => pageCoverageConflicts(db, date)),
  ].sort((a, b) => a.identity.localeCompare(b.identity))
  const gaps = dates.flatMap((date) => dayGaps(db, date))
  const permissions = consultedPermissions(db)
  const corrected = correctedFactItems(db, question)
  const { items: entities, entityIds } = entityItems(db, question)
  const exact = exactSearchItems(db, question, searchScope)
  const exactIdentities = new Set(exact.items.map((item) => item.identity))
  const semantic = await semanticSearchItems(db, question, searchScope, exactIdentities)
  const files = fileExcerptItems(db, question, contextBudget.maxFileExcerptChars)
  const transcripts = granolaTranscriptItems(db, question, dates, contextBudget.maxFileExcerptChars)

  // One identity appears once: a connected day fact and an exact-search hit
  // can both name the same memory record, and a citation must resolve to a
  // single disclosed item.
  const seenIdentities = new Set<string>()
  const assembled = sortItems([
    ...dayFacts,
    ...corrected,
    ...entities,
    ...exact.items,
    ...semantic,
    ...files.items,
    ...transcripts,
  ]).filter((item) => {
    if (seenIdentities.has(item.identity)) return false
    seenIdentities.add(item.identity)
    return true
  })

  // Defensive final gate: nothing high-sensitivity rides along unless a file
  // grant explicitly allowed it above (memory readers already exclude 'high'
  // at query time; this catches any future source that forgets).
  const afterSensitivity = assembled.filter(
    (item) => item.sensitivity !== 'high' || item.kind === 'file_excerpt',
  )
  const omissions: ContextPacketOmission[] = [...(input.omissions ?? [])]
  if (files.omittedHighSensitivity > 0) {
    omissions.push({
      kind: 'file_excerpt',
      count: files.omittedHighSensitivity,
      reason: 'high-sensitivity',
    })
  }
  const droppedSearch = exact.omittedHighSensitivity + (assembled.length - afterSensitivity.length)
  if (droppedSearch > 0) {
    omissions.push({ kind: 'search_exact', count: droppedSearch, reason: 'high-sensitivity' })
  }

  // The same two privacy boundaries as every agent tool result: the
  // tracking-exclusion filter (drops or redacts excluded apps/sites) and the
  // secret sanitizer.
  const controls = trackingControlsStateFromSettings(getSettings())
  const guarded = sanitizeToolResult(
    filterTrackingExcludedEvidence(afterSensitivity, controls),
  ) as ContextPacketItem[]
  const privacyFilteredItems = guarded.filter((item): item is ContextPacketItem =>
    Boolean(item && typeof item.identity === 'string' && typeof item.statement === 'string'))
  if (privacyFilteredItems.length < afterSensitivity.length) {
    omissions.push({
      kind: 'day_fact',
      count: afterSensitivity.length - privacyFilteredItems.length,
      reason: 'tracking-excluded',
    })
  }
  const fitted = fitItemsToBudget(privacyFilteredItems, contextBudget)
  const items = fitted.items
  omissions.push(...fitted.omissions)
  const resolvedOmissions = mergeOmissions(omissions)

  const counts: Partial<Record<ContextItemKind, number>> = {}
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1

  return {
    id: `ctx_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    purpose: input.purpose,
    request: { originalText: originalQuestion, timeRange, dates, entityIds },
    person: { timezone, confirmedPreferences },
    items,
    conflicts,
    gaps,
    permissions,
    tools,
    actionContext,
    contextBudget,
    disclosure: {
      destination: input.destination,
      leftDevice: true,
      policyVersion: CONTEXT_POLICY_VERSION,
      itemCount: items.length,
      counts,
      omissions: resolvedOmissions,
    },
    policyVersion: CONTEXT_POLICY_VERSION,
    contentFingerprint: contentFingerprint({
      purpose: input.purpose,
      originalQuestion,
      timeRange,
      entityIds,
      timezone,
      confirmedPreferences,
      tools,
      actionContext,
      contextBudget,
      items,
      conflicts,
      gaps,
      permissions,
      omissions: resolvedOmissions,
    }),
    assembledAt: now.getTime(),
  }
}

// ─── Prompt rendering ────────────────────────────────────────────────────────

const KIND_HEADINGS: Record<ContextItemKind, string> = {
  day_fact: 'Corrected timeline facts',
  corrected_fact:
    'What Daylens knows about this user (context only — never invent activity beyond the real evidence)',
  entity: 'Entities the question names',
  search_exact: 'Moments matched by exact local search',
  search_semantic: 'Moments similar by meaning (local embeddings — leads, not exact matches)',
  file_excerpt: 'Granted file excerpts (identity and version recorded in the packet ledger)',
}

function appendPacketContractSections(sections: string[], packet: ContextPacket): void {
  const timeRange = packet.request.timeRange ?? {
    startDate: packet.request.dates[0],
    endDate: packet.request.dates[packet.request.dates.length - 1],
    dates: packet.request.dates,
    resolution: 'explicit' as const,
  }
  const confirmedPreferences = packet.person.confirmedPreferences ?? []
  const tools = packet.tools ?? []
  sections.push(
    `Resolved scope: ${timeRange.startDate} through ${timeRange.endDate} in ${packet.person.timezone} (${timeRange.resolution}).`,
  )
  if (confirmedPreferences.length > 0) {
    sections.push([
      'Confirmed preferences relevant to this run:',
      ...confirmedPreferences.map((preference) =>
        `- ${preference.key}: ${preference.value}`),
    ].join('\n'))
  }
  if (tools.length > 0) {
    sections.push([
      'Tools available for this run:',
      ...tools.map((tool) =>
        `- ${tool.name} [${tool.source}, ${tool.permissionState}]: ${tool.description}`),
    ].join('\n'))
  }
  if (packet.actionContext) {
    const action = packet.actionContext
    sections.push([
      'Action context:',
      `- Target: ${action.target.kind}:${action.target.id}${action.target.version ? ` at ${action.target.version}` : ''}`,
      `- Current state: ${stableJson(action.currentState)}`,
      `- Proposed change: ${stableJson(action.proposedChange)}`,
      `- Permission: ${action.permissionState}`,
      `- Confirmation: ${action.confirmationState}`,
      `- Expected effects: ${action.expectedEffects.join('; ') || 'none recorded'}`,
      `- Undo: ${action.undoOperation ? `${action.undoOperation.kind}${action.undoOperation.targetId ? `:${action.undoOperation.targetId}` : ''}` : 'unavailable'}`,
    ].join('\n'))
  }
  if (packet.disclosure.omissions.length > 0) {
    sections.push([
      'Information considered but not disclosed:',
      ...packet.disclosure.omissions.map((omission) =>
        `- ${omission.count} ${omission.kind} item(s): ${omission.reason}`),
    ].join('\n'))
  }
}

/** Deterministic text rendering of the packet for the model's system context.
 *  Context only — the agent still verifies specifics through tools. */
export function renderContextPacketForPrompt(packet: ContextPacket): string {
  const sections: string[] = [
    `Context packet ${packet.id} — assembled locally from your corrected Daylens data for ${packet.request.dates.join(', ')} before this request; every item below is recorded in the local disclosure ledger. Treat it as orienting context and verify specifics with tools.`,
  ]
  appendPacketContractSections(sections, packet)
  for (const kind of Object.keys(KIND_ORDER) as ContextItemKind[]) {
    const items = packet.items.filter((item) => item.kind === kind)
    if (items.length === 0) continue
    sections.push(
      [`${KIND_HEADINGS[kind]}:`, ...items.map((item) => `- ${item.statement}`)].join('\n'),
    )
  }
  return sections.join('\n\n')
}

/** Deterministic agent-facing rendering (DEV-182): the same disclosed content
 *  as renderContextPacketForPrompt, plus per-item citation markers, the
 *  recorded conflicts and gaps, and the honesty rules the agent answers under.
 *  Marker [Cn] is the 1-based position of the item in packet.items — the same
 *  index resolvePacketCitations later uses to verify an answer's citations
 *  against this exact packet. */
export function renderContextPacketForAgent(packet: ContextPacket): string {
  const sections: string[] = []
  if (packet.items.length === 0) {
    // Honest failure: an empty packet is stated, never papered over. The agent
    // is told to say what is missing rather than to improvise an answer.
    sections.push(
      `Context packet ${packet.id} — assembled locally from your corrected Daylens data for ${packet.request.dates.join(', ')} before this request and recorded in the local disclosure ledger. It contains NO recorded items for this question's scope.`,
      'Daylens has nothing recorded to answer this from. Say plainly what is missing for the requested day(s) and what would help (tracking running, a different day, a granted file or source). You may still verify with tools; if they also come back empty, report the honest miss. Never invent activity.',
    )
  } else {
    sections.push(
      `Context packet ${packet.id} — assembled locally from your corrected Daylens data for ${packet.request.dates.join(', ')} before this request; every item below is recorded in the local disclosure ledger. Treat it as orienting context and verify specifics with tools.`,
      'Citing: every packet item below carries a marker like [C3]. When a claim in your answer comes from a packet item, append that item\'s marker immediately after the claim (e.g. "The morning went to the planner refactor [C1]."). Use only markers printed below — never invent one. Claims grounded in this turn\'s tool results need no marker.',
      'Leads vs facts: items under "Moments similar by meaning" are semantic leads, NOT confirmed facts. Before asserting one as something that happened, verify it with a tool (search or moment); otherwise phrase it as a lead ("a chat that looks like…") or leave it out. The same holds for any inference the packet itself does not state: never present a guess about why something is absent as an observation.',
    )
    for (const kind of Object.keys(KIND_ORDER) as ContextItemKind[]) {
      const lines: string[] = []
      packet.items.forEach((item, index) => {
        if (item.kind !== kind) return
        lines.push(`- [C${index + 1}] ${item.statement}`)
      })
      if (lines.length === 0) continue
      sections.push([`${KIND_HEADINGS[kind]}:`, ...lines].join('\n'))
    }
  }
  appendPacketContractSections(sections, packet)
  if (packet.conflicts.length > 0) {
    sections.push(
      [
        "Where the record disagrees with itself — NAME each disagreement in your answer instead of asserting agreement. The person's correction wins, but the person should hear that the sources differed:",
        ...packet.conflicts.map((conflict) => `- ${conflict.detail} (${conflict.identity})`),
      ].join('\n'),
    )
  }
  if (packet.gaps.length > 0) {
    sections.push(
      [
        'Gaps in the record — state what is missing instead of letting silence read as inactivity:',
        ...packet.gaps.map((gap) => `- ${gap.detail} (${gap.date})`),
      ].join('\n'),
    )
  }
  return sections.join('\n\n')
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export type ContextPacketExchangeKind = 'chat' | 'day_analysis'

export interface ContextPacketRow {
  id: string
  purpose: ContextPurpose
  exchange_kind: ContextPacketExchangeKind
  thread_id: number | null
  message_id: number | null
  scope_key: string | null
  question: string
  destination: string
  left_device: number
  policy_version: number
  item_count: number
  content_fingerprint: string
  packet_json: string
  created_at: number
}

export interface StoredContextPacket {
  id: string
  exchangeKind: ContextPacketExchangeKind
  threadId: number | null
  messageId: number | null
  scopeKey: string | null
  destination: string
  createdAt: number
  packet: ContextPacket
}

export interface StoredContextDisclosure {
  packetId: string
  itemIndex: number
  threadId: number | null
  messageId: number | null
  destination: string
  leftDevice: boolean
  policyVersion: number
  createdAt: number
  item: ContextPacketItem
}

export interface DeleteThreadContextResult {
  packetsDeleted: number
  fileDisclosuresDeleted: number
}

export function contextPacketsAvailable(db: Database.Database): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_packets'`)
      .get() != null
  )
}

function packetFileDisclosureReason(packetId: string): string {
  return `Included in context packet ${packetId}`
}

/**
 * Persist the packet. Callers MUST do this before the request leaves the
 * local boundary (spec §Context assembly step 12) — the row is the record
 * that something was made available to a model. File-excerpt items also land
 * in the DEV-184 file_disclosures ledger so the Settings surface stays the
 * one place every disclosed file shows up.
 */
export function recordContextPacket(
  db: Database.Database,
  packet: ContextPacket,
  meta: {
    exchangeKind: ContextPacketExchangeKind
    threadId?: number | null
    scopeKey?: string | null
  },
): void {
  if (!contextPacketsAvailable(db)) {
    throw new Error('Context packet storage is unavailable')
  }
  db.transaction(() => {
    db.prepare(`
      INSERT INTO context_packets (
        id, purpose, exchange_kind, thread_id, message_id, scope_key, question,
        destination, left_device, policy_version, item_count, content_fingerprint,
        packet_json, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      packet.id,
      packet.purpose,
      meta.exchangeKind,
      meta.threadId ?? null,
      meta.scopeKey ?? null,
      packet.request.originalText,
      packet.disclosure.destination,
      packet.disclosure.leftDevice ? 1 : 0,
      packet.policyVersion,
      packet.disclosure.itemCount,
      packet.contentFingerprint,
      JSON.stringify(packet),
      packet.assembledAt,
    )
    for (const item of packet.items) {
      if (
        item.kind !== 'file_excerpt'
        || !item.identity.startsWith('file:')
        || !packet.disclosure.leftDevice
      ) continue
      recordFileDisclosure(db, {
        threadId: meta.threadId ?? null,
        filePath: item.identity.slice('file:'.length),
        versionFingerprint: item.version ?? 'unversioned',
        excerptStart: 0,
        excerptEnd: item.statement.length,
        reason: packetFileDisclosureReason(packet.id),
        sensitivity: item.sensitivity,
        destination: packet.disclosure.destination,
      })
    }
  })()
}

/** Bind the packet to the persisted assistant message once it exists, so
 *  "what did the model see for THIS answer" is a single lookup. */
export function linkContextPacketToMessage(
  db: Database.Database,
  packetId: string,
  messageId: number,
): void {
  if (!contextPacketsAvailable(db)) return
  db.transaction(() => {
    const packetResult = db.prepare(`
      UPDATE context_packets SET message_id = ? WHERE id = ?
    `).run(messageId, packetId)
    if (packetResult.changes === 0) return
    db.prepare(`
      UPDATE file_disclosures
      SET message_id = ?
      WHERE reason = ?
    `).run(messageId, packetFileDisclosureReason(packetId))
  })()
}

function rowToStored(row: ContextPacketRow): StoredContextPacket {
  return {
    id: row.id,
    exchangeKind: row.exchange_kind,
    threadId: row.thread_id,
    messageId: row.message_id,
    scopeKey: row.scope_key,
    destination: row.destination,
    createdAt: row.created_at,
    packet: JSON.parse(row.packet_json) as ContextPacket,
  }
}

export function getContextPacketById(
  db: Database.Database,
  packetId: string,
): StoredContextPacket | null {
  if (!contextPacketsAvailable(db)) return null
  const row = db.prepare(`SELECT * FROM context_packets WHERE id = ?`).get(packetId) as
    | ContextPacketRow
    | undefined
  return row ? rowToStored(row) : null
}

/** The packet behind one AI exchange, by assistant message id. */
export function getContextPacketForMessage(
  db: Database.Database,
  messageId: number,
): StoredContextPacket | null {
  if (!contextPacketsAvailable(db)) return null
  const row = db
    .prepare(
      `
    SELECT * FROM context_packets WHERE message_id = ? ORDER BY created_at DESC LIMIT 1
  `,
    )
    .get(messageId) as ContextPacketRow | undefined
  return row ? rowToStored(row) : null
}

export function getContextDisclosuresForPacket(
  db: Database.Database,
  packetId: string,
): StoredContextDisclosure[] {
  const stored = getContextPacketById(db, packetId)
  if (!stored) return []
  return stored.packet.items.map((item, itemIndex) => ({
    packetId: stored.id,
    itemIndex,
    threadId: stored.threadId,
    messageId: stored.messageId,
    destination: stored.destination,
    leftDevice: stored.packet.disclosure.leftDevice,
    policyVersion: stored.packet.policyVersion,
    createdAt: stored.createdAt,
    item,
  }))
}

/** Remove every packet and file disclosure owned by a thread.
 *  The AI-thread lifecycle owner can call this interface as part of its broader
 *  message, artifact, checkpoint, and context cleanup transaction. */
export function deleteContextPacketsForThread(
  db: Database.Database,
  threadId: number,
): DeleteThreadContextResult {
  return db.transaction(() => {
    const fileDisclosuresAvailable = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_disclosures'`,
    ).get() != null
    const fileDisclosuresDeleted = fileDisclosuresAvailable
      ? db.prepare(`DELETE FROM file_disclosures WHERE thread_id = ?`).run(threadId).changes
      : 0
    const packetsDeleted = contextPacketsAvailable(db)
      ? db.prepare(`DELETE FROM context_packets WHERE thread_id = ?`).run(threadId).changes
      : 0
    return {
      packetsDeleted,
      fileDisclosuresDeleted,
    }
  })()
}

export function listContextPackets(
  db: Database.Database,
  options: { limit?: number; exchangeKind?: ContextPacketExchangeKind; scopeKey?: string } = {},
): StoredContextPacket[] {
  if (!contextPacketsAvailable(db)) return []
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.exchangeKind) {
    clauses.push('exchange_kind = ?')
    params.push(options.exchangeKind)
  }
  if (options.scopeKey) {
    clauses.push('scope_key = ?')
    params.push(options.scopeKey)
  }
  const rows = db
    .prepare(
      `
    SELECT * FROM context_packets
    ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT ?
  `,
    )
    .all(...params, options.limit ?? 50) as ContextPacketRow[]
  return rows.map(rowToStored)
}
