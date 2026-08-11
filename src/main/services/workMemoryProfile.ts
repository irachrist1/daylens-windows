// Work memory as an editable, human-readable profile (ChatGPT-style), replacing
// the opaque "65% pattern" table.
//
// A profile is a handful of plain sentences. Daylens DRAFTS facts from real
// evidence (the apps/sites you actually use); the user can edit, add, or delete
// any of them by hand. Hand edits and deletes are CORRECTIONS that survive every
// rebuild (same rule as block corrections). The draft is deterministic — no AI
// call — so rebuild is safe to run without provider approval, and there is no
// confidence theater: a fact is stated plainly or left out.
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { AppCategory, WorkMemoryCategory } from '@shared/types'
import { tableExists } from './database'
import { getReconciledDomainIntervals } from '../db/queries'
import {
  confirmSuppliedFact,
  deleteSuppliedFact,
  findMemoryProposalRejection,
  getSuppliedFact,
  isSuppliedFactId,
  listSuppliedFacts,
  suppliedMemoryAvailable,
  updateSuppliedFact,
} from './suppliedMemory'

type WorkMemoryFactOrigin = 'drafted' | 'user'
// Display provenance (memory.md §2.1 "marked as such"). Durability is keyed on
// origin/topic_key, never on source — source only tells the user where a fact
// came from in the Manage-memory view.
type WorkMemoryFactSource = 'evidence' | 'chat' | 'hand'

interface WorkMemoryFact {
  id: string
  text: string
  origin: WorkMemoryFactOrigin
  source: WorkMemoryFactSource
  category: WorkMemoryCategory
  /** True when the fact lives in the supplied-memory store (DEV-185) — the
   *  confirmed "things you've told me" tier, retrievable through search. */
  supplied?: boolean
}

// Group a fact into a readable section for the Manage-memory view (memory.md §3,
// the Claude "Work context / Personal context" split). Deterministic and
// derived — never stored, never a durability signal. Grouping is purely how the
// view reads; getting it slightly wrong only moves a sentence to another heading.
const PREFERENCE_RE =
  /\b(prefer|prefers|like|likes|favou?rite|enjoys?|rather|dark mode|light mode|concise|simple|straight-to-the-point|tone|style)\b/i
const WORK_RE =
  /\b(work|works|working|workplace|job|role|company|employer|client|clients|project|projects|team|colleague|colleagues|office|deadline|manager|report to|engineer|operations|consult|account|business|professional)\b/i

export function classifyWorkMemoryFact(text: string, topicKey?: string | null): WorkMemoryCategory {
  // Drafted facts carry a stable topic_key — categorize by that, not keywords.
  if (topicKey === 'top-apps') return 'work'
  if (topicKey === 'background') return 'personal'
  if (PREFERENCE_RE.test(text)) return 'preferences'
  if (WORK_RE.test(text)) return 'work'
  return 'personal'
}

// Memory scopes (memory.md §2.2 / invariant 3). General memory is always in the
// prompt; a client is a NAMED scope (`client:<id>`) pulled in only when the
// question is about that client. The `scope` column already exists (DEV-107
// schema) — DEV-108 fills the client side, no new column needed.
const GENERAL_SCOPE = 'general'
export function clientScope(clientId: string): string {
  return `client:${clientId}`
}

export interface WorkMemoryProfile {
  facts: WorkMemoryFact[]
}

// One plain-language entry in the memory audit (memory.md §3 / invariant 7).
export interface MemoryAuditEntry {
  id: string
  action: 'remembered' | 'updated' | 'forgot'
  text: string
  source: 'chat' | 'hand'
  createdAt: number
}

// A single extract→update operation (mem0's ADD / UPDATE / DELETE loop). The
// memory extractor (ai/memoryWrite.ts) turns a chat instruction into these;
// applyMemoryWriteOps writes them and records the audit.
export type MemoryWriteAction = 'add' | 'update' | 'delete'

export interface MemoryWriteOp {
  action: MemoryWriteAction
  /** New text for add/update. */
  text?: string
  /** Existing fact id for update/delete. */
  targetId?: string
}

export interface MemoryWriteResult {
  facts: WorkMemoryFact[]
  applied: Array<{ action: MemoryWriteAction; text: string }>
  /** One plain-language line confirming what changed, for the chat reply. */
  summary: string
}

export interface RebuildResult {
  facts: WorkMemoryFact[]
  added: string[]
  changeSummary: string
}

export interface ForgetResult {
  facts: WorkMemoryFact[]
  changeSummary: string
}

interface FactRow {
  id: string
  fact_text: string
  origin: WorkMemoryFactOrigin
  source: WorkMemoryFactSource
  status: 'active' | 'deleted'
  topic_key: string | null
  sort_order: number
}

// Older databases (pre-DEV-107) won't have the source column until the v37
// migration runs; default to 'evidence' so reads never throw on a stale row.
function rowSource(row: {
  source?: string | null
  origin: WorkMemoryFactOrigin
}): WorkMemoryFactSource {
  if (row.source === 'chat' || row.source === 'hand' || row.source === 'evidence') return row.source
  return row.origin === 'user' ? 'hand' : 'evidence'
}

function now(): number {
  return Date.now()
}

function newId(): string {
  return `wmf_${crypto.randomBytes(8).toString('hex')}`
}

function normalizeFactText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function wordSet(text: string): Set<string> {
  return new Set(
    normalizeFactText(text)
      .split(' ')
      .filter((w) => w.length > 2),
  )
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const word of a) {
    if (b.has(word)) intersection++
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

function findDuplicateFact(db: Database.Database, text: string, scope: string): boolean {
  const hasScope = hasColumn(db, 'work_memory_facts', 'scope')
  const scopeClause = hasScope ? `AND scope = ?` : ''
  const params = hasScope ? [scope] : []
  const rows = db
    .prepare(`SELECT fact_text FROM work_memory_facts WHERE status = 'active' ${scopeClause}`)
    .all(...params) as { fact_text: string }[]
  // Supplied facts (DEV-185) count as already-known too, so a rebuild or a
  // chat add cannot duplicate something the person already confirmed.
  const existing = [
    ...rows,
    ...listSuppliedFacts(db, { scope }).map((fact) => ({ fact_text: fact.statement })),
  ]

  const normalized = normalizeFactText(text)
  const newWords = wordSet(text)

  for (const row of existing) {
    const existingNorm = normalizeFactText(row.fact_text)
    if (normalized === existingNorm) return true
    if (normalized.length > 10 && existingNorm.length > 10) {
      if (normalized.includes(existingNorm) || existingNorm.includes(normalized)) return true
    }
    const existingWords = wordSet(row.fact_text)
    if (jaccardSimilarity(newWords, existingWords) >= 0.8) return true
  }
  return false
}

function ready(db: Database.Database): boolean {
  return tableExists(db, 'work_memory_facts')
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

// Read active facts for one scope. General memory (the default) is everything
// without a client scope; a client scope reads only that client's facts. Older
// DBs without the `scope` column only have general memory, so a client read
// returns nothing there.
function readFactsForScope(
  db: Database.Database,
  scope: string,
  confirmedOnly = false,
): WorkMemoryFact[] {
  const sourceCol = hasColumn(db, 'work_memory_facts', 'source') ? 'source' : `NULL AS source`
  const hasScope = hasColumn(db, 'work_memory_facts', 'scope')
  if (!hasScope && scope !== GENERAL_SCOPE) return []
  const scopeClause = hasScope ? `AND scope = ?` : ''
  const params = hasScope ? [scope] : []
  const rows = db
    .prepare(
      `
    SELECT id, fact_text, origin, ${sourceCol}, status, topic_key, sort_order
    FROM work_memory_facts
    WHERE status = 'active' ${scopeClause}
    ORDER BY sort_order ASC, created_at ASC
  `,
    )
    .all(...params) as FactRow[]
  // Active rows in work_memory_facts span two origins: 'drafted' (evidence-
  // derived proposals awaiting confirmation) and 'user' (pre-DEV-185 hand-added
  // facts still living in this table — confirmed, not proposals). Both ride the
  // Manage-memory view; only 'drafted' is suppressed from AI context.
  const activeRows = confirmedOnly ? rows.filter((row) => row.origin !== 'drafted') : rows
  const drafted = activeRows.map((row) => ({
    id: row.id,
    text: row.fact_text,
    origin: row.origin,
    source: rowSource(row),
    category: classifyWorkMemoryFact(row.fact_text, row.topic_key),
  }))
  // Supplied facts (DEV-185) are the confirmed tier of the same profile: they
  // ride every prompt block and the Manage-memory view alongside the drafted
  // facts, and edit/forget route to the supplied store by id.
  const supplied: WorkMemoryFact[] = listSuppliedFacts(db, { scope })
    .map((fact) => ({
      id: fact.id,
      text: fact.statement,
      origin: 'user' as const,
      source: fact.source === 'chat' ? ('chat' as const) : ('hand' as const),
      category: classifyWorkMemoryFact(fact.statement),
      supplied: true,
    }))
    .reverse() // oldest first, matching the drafted ordering
  return [...drafted, ...supplied]
}

export function getWorkMemoryProfile(
  db: Database.Database,
  confirmedOnly = false,
): WorkMemoryProfile {
  if (!ready(db)) return { facts: [] }
  return { facts: readFactsForScope(db, GENERAL_SCOPE, confirmedOnly) }
}

// One client's scoped memory — only pulled in when the question is about that
// client (memory.md §2.2). Editing/forgetting works by fact id, so the general
// updateWorkMemoryFact / forgetWorkMemoryFact handle client facts too.
export function getClientMemory(
  db: Database.Database,
  clientId: string,
  confirmedOnly = false,
): WorkMemoryFact[] {
  if (!ready(db) || !clientId) return []
  return readFactsForScope(db, clientScope(clientId), confirmedOnly)
}

// Hand-editing a fact makes it a user correction — origin flips to 'user' so a
// later rebuild never overwrites it.
export function updateWorkMemoryFact(
  db: Database.Database,
  id: string,
  text: string,
): WorkMemoryProfile {
  if (!ready(db)) return { facts: [] }
  const trimmed = text.trim()
  if (!trimmed) return getWorkMemoryProfile(db)
  applyUpdate(db, id, trimmed, 'hand')
  recordAudit(db, 'updated', trimmed, 'hand')
  return getWorkMemoryProfile(db)
}

// Confirming a drafted fact (spec migration slice 2: evidence-drafted rows are
// re-presented for confirmation, never silently promoted). The drafted topic
// is tombstoned so a rebuild cannot re-draft it, and the text becomes a
// supplied fact — explicitly confirmed, retrievable through search.
export function confirmDraftedWorkMemoryFact(db: Database.Database, id: string): WorkMemoryProfile {
  if (!ready(db)) return { facts: [] }
  const row = db
    .prepare(
      `SELECT id, fact_text, origin, status, topic_key, sort_order FROM work_memory_facts WHERE id = ? AND status = 'active'`,
    )
    .get(id) as FactRow | undefined
  if (!row || row.origin !== 'drafted') return getWorkMemoryProfile(db)
  const scope = factScope(db, row.id)
  promoteToSupplied(db, row, row.fact_text, 'hand', scope, 'Confirmed from a drafted suggestion')
  recordAudit(db, 'remembered', row.fact_text, 'hand', scope)
  return getWorkMemoryProfile(db)
}

export function addWorkMemoryFact(db: Database.Database, text: string): WorkMemoryProfile {
  if (!ready(db)) return { facts: [] }
  const trimmed = text.trim()
  if (!trimmed) return getWorkMemoryProfile(db)
  const id = applyAdd(db, trimmed, 'hand')
  if (id) {
    recordAudit(db, 'remembered', trimmed, 'hand')
  }
  return getWorkMemoryProfile(db)
}

// Add a fact by hand to one client's scoped memory (memory.md §2.2). Edits and
// deletes still go through updateWorkMemoryFact / forgetWorkMemoryFact (by id),
// so the durability rules are identical to general memory.
export function addClientMemoryFact(
  db: Database.Database,
  clientId: string,
  text: string,
): WorkMemoryFact[] {
  if (!ready(db) || !clientId) return getClientMemory(db, clientId)
  const trimmed = text.trim()
  if (!trimmed) return getClientMemory(db, clientId)
  const scope = clientScope(clientId)
  const id = applyAdd(db, trimmed, 'hand', scope)
  if (id) {
    recordAudit(db, 'remembered', trimmed, 'hand', scope)
  }
  return getClientMemory(db, clientId)
}

// Forgetting a fact that came from a drafted topic tombstones that topic so a
// rebuild won't re-add it — even if the user edited it first (an edit flips
// origin to 'user' but keeps the topic_key). A purely hand-added fact has no
// topic_key and is simply removed. This keeps "forgot on purpose stays gone"
// true across the edit-then-forget path (work-memory.md §3.3).
export function forgetWorkMemoryFact(db: Database.Database, id: string): ForgetResult {
  if (!ready(db)) return { facts: [], changeSummary: 'Nothing to forget.' }
  if (isSuppliedFactId(id)) {
    const deleted = deleteSuppliedFact(db, id)
    if (!deleted)
      return { facts: getWorkMemoryProfile(db).facts, changeSummary: 'Nothing to forget.' }
    recordAudit(db, 'forgot', deleted.statement, 'hand', deleted.scope)
    return {
      facts: getWorkMemoryProfile(db).facts,
      changeSummary: `Forgot "${truncate(deleted.statement)}".`,
    }
  }
  const row = db
    .prepare(
      `SELECT id, fact_text, origin, status, topic_key, sort_order FROM work_memory_facts WHERE id = ?`,
    )
    .get(id) as FactRow | undefined
  if (!row) return { facts: getWorkMemoryProfile(db).facts, changeSummary: 'Nothing to forget.' }

  applyDelete(db, row)
  recordAudit(db, 'forgot', row.fact_text, 'hand')
  return {
    facts: getWorkMemoryProfile(db).facts,
    changeSummary: `Forgot "${truncate(row.fact_text)}".`,
  }
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ── Shared mutators (used by both the hand path and the conversation path) ──
// Since DEV-185, every user-confirmed or hand-entered fact lands in the
// supplied-memory store (searchable, packet-visible, individually deletable);
// work_memory_facts keeps only the evidence-drafted proposals and their
// tombstones. Edits and forgets route by id.

function hasSourceColumn(db: Database.Database): boolean {
  return hasColumn(db, 'work_memory_facts', 'source')
}

function factScope(db: Database.Database, id: string): string {
  if (!hasColumn(db, 'work_memory_facts', 'scope')) return GENERAL_SCOPE
  const row = db.prepare(`SELECT scope FROM work_memory_facts WHERE id = ?`).get(id) as
    | { scope: string }
    | undefined
  return row?.scope ?? GENERAL_SCOPE
}

function applyAdd(
  db: Database.Database,
  text: string,
  source: 'chat' | 'hand',
  scope: string = GENERAL_SCOPE,
): string | null {
  if (findDuplicateFact(db, text, scope)) return null
  if (suppliedMemoryAvailable(db)) {
    const fact = confirmSuppliedFact(db, {
      statement: text,
      scope,
      source,
      context: source === 'chat' ? 'Confirmed in chat' : 'Added by hand in Settings',
    })
    return fact?.id ?? null
  }
  // Pre-migration fallback: the legacy user-origin row.
  const id = newId()
  const max = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM work_memory_facts`)
    .get() as { m: number }
  if (hasSourceColumn(db)) {
    db.prepare(
      `
      INSERT INTO work_memory_facts (id, fact_text, origin, status, topic_key, source, scope, sort_order, created_at, updated_at)
      VALUES (?, ?, 'user', 'active', NULL, ?, ?, ?, ?, ?)
    `,
    ).run(id, text, source, scope, (max.m ?? 0) + 1, now(), now())
  } else {
    db.prepare(
      `
      INSERT INTO work_memory_facts (id, fact_text, origin, status, topic_key, sort_order, created_at, updated_at)
      VALUES (?, ?, 'user', 'active', NULL, ?, ?, ?)
    `,
    ).run(id, text, (max.m ?? 0) + 1, now(), now())
  }
  return id
}

// Editing a drafted fact is an explicit confirmation of the edited text (spec
// migration slice 1: hand-edited rows become supplied memory): the drafted
// topic is tombstoned so a rebuild won't re-draft it, and the corrected text
// becomes a supplied fact.
function promoteToSupplied(
  db: Database.Database,
  row: Pick<FactRow, 'id' | 'topic_key'>,
  text: string,
  source: 'chat' | 'hand',
  scope: string,
  context: string,
): string | null {
  if (!suppliedMemoryAvailable(db)) return null
  const promote = db.transaction(() => {
    if (row.topic_key) {
      db.prepare(
        `UPDATE work_memory_facts SET status = 'deleted', updated_at = ? WHERE id = ?`,
      ).run(now(), row.id)
    } else {
      db.prepare(`DELETE FROM work_memory_facts WHERE id = ?`).run(row.id)
    }
    return confirmSuppliedFact(db, { statement: text, scope, source, context })?.id ?? null
  })
  return promote()
}

// An edit flips a fact into the supplied store: supplied facts update in
// place; a drafted row is confirmed with the edited text (the correction rule
// — a rebuild never overwrites it). The legacy in-place path remains only for
// pre-migration databases.
function applyUpdate(
  db: Database.Database,
  id: string,
  text: string,
  source: 'chat' | 'hand',
): void {
  if (isSuppliedFactId(id)) {
    updateSuppliedFact(db, id, text, source)
    return
  }
  const row = db.prepare(`SELECT id, topic_key FROM work_memory_facts WHERE id = ?`).get(id) as
    | Pick<FactRow, 'id' | 'topic_key'>
    | undefined
  if (!row) return
  if (suppliedMemoryAvailable(db)) {
    promoteToSupplied(
      db,
      row,
      text,
      source,
      factScope(db, id),
      'Confirmed by editing a drafted fact',
    )
    return
  }
  if (hasSourceColumn(db)) {
    db.prepare(
      `UPDATE work_memory_facts SET fact_text = ?, origin = 'user', source = ?, updated_at = ? WHERE id = ?`,
    ).run(text, source, now(), id)
  } else {
    db.prepare(
      `UPDATE work_memory_facts SET fact_text = ?, origin = 'user', updated_at = ? WHERE id = ?`,
    ).run(text, now(), id)
  }
}

// A drafted topic is tombstoned (status=deleted) so a rebuild won't drag it
// back; a purely hand/chat-added fact has no topic_key and is removed outright.
// Supplied facts delete through their own store, which removes the retrieval
// mirror in the same transaction.
function applyDelete(db: Database.Database, row: Pick<FactRow, 'id' | 'topic_key'>): void {
  if (isSuppliedFactId(row.id)) {
    deleteSuppliedFact(db, row.id)
    return
  }
  if (row.topic_key) {
    db.prepare(`UPDATE work_memory_facts SET status = 'deleted', updated_at = ? WHERE id = ?`).run(
      now(),
      row.id,
    )
  } else {
    db.prepare(`DELETE FROM work_memory_facts WHERE id = ?`).run(row.id)
  }
}

// ── The conversation write path (memory.md §2.1) ────────────────────────────
// Daylens writes to its own memory from a chat instruction. The ops come from
// the extractor (ai/memoryWrite.ts); this applies them durably and records the
// audit. Everything written here is origin='user' so it survives every rebuild.
export function applyMemoryWriteOps(
  db: Database.Database,
  ops: MemoryWriteOp[],
  source: 'chat' | 'hand' = 'chat',
  // The scope new facts land in. General by default; a `client:<id>` scope when
  // the user told Daylens about a specific client in chat (memory.md §2.2).
  // Update/delete operate by fact id, so they ignore this — only `add` needs it.
  scope: string = GENERAL_SCOPE,
): MemoryWriteResult {
  if (!ready(db)) return { facts: [], applied: [], summary: '' }
  const applied: Array<{ action: MemoryWriteAction; text: string }> = []

  const tx = db.transaction(() => {
    for (const op of ops) {
      if (op.action === 'add') {
        const text = (op.text ?? '').trim()
        if (!text) continue
        const addedId = applyAdd(db, text, source, scope)
        if (addedId) {
          recordAudit(db, 'remembered', text, source, scope)
          applied.push({ action: 'add', text })
        }
      } else if (op.action === 'update') {
        const text = (op.text ?? '').trim()
        if (!text || !op.targetId) continue
        const exists = isSuppliedFactId(op.targetId)
          ? getSuppliedFact(db, op.targetId) != null
          : db.prepare(`SELECT id FROM work_memory_facts WHERE id = ?`).get(op.targetId) != null
        if (!exists) {
          // The target vanished — record it as a fresh memory instead of dropping it.
          applyAdd(db, text, source, scope)
          recordAudit(db, 'remembered', text, source, scope)
          applied.push({ action: 'add', text })
          continue
        }
        applyUpdate(db, op.targetId, text, source)
        recordAudit(db, 'updated', text, source, scope)
        applied.push({ action: 'update', text })
      } else if (op.action === 'delete') {
        if (!op.targetId) continue
        if (isSuppliedFactId(op.targetId)) {
          const deleted = deleteSuppliedFact(db, op.targetId)
          if (!deleted) continue
          recordAudit(db, 'forgot', deleted.statement, source, deleted.scope)
          applied.push({ action: 'delete', text: deleted.statement })
          continue
        }
        const row = db
          .prepare(`SELECT id, fact_text, topic_key FROM work_memory_facts WHERE id = ?`)
          .get(op.targetId) as Pick<FactRow, 'id' | 'fact_text' | 'topic_key'> | undefined
        if (!row) continue
        applyDelete(db, row)
        recordAudit(db, 'forgot', row.fact_text, source, scope)
        applied.push({ action: 'delete', text: row.fact_text })
      }
    }
  })
  tx()

  return {
    facts: getWorkMemoryProfile(db).facts,
    applied,
    summary: summarizeApplied(applied),
  }
}

function summarizeApplied(applied: Array<{ action: MemoryWriteAction; text: string }>): string {
  if (applied.length === 0) return ''
  const parts = applied.map((entry) => {
    const text = truncate(entry.text, 80)
    if (entry.action === 'add') return `I'll remember that ${lowerFirst(text)}`
    if (entry.action === 'update') return `Updated — ${lowerFirst(text)}`
    return `Forgot "${text}"`
  })
  return `${parts.join('. ')}.`
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

// ── The audit (memory.md §3 / invariant 7) ──────────────────────────────────

function recordAudit(
  db: Database.Database,
  action: MemoryAuditEntry['action'],
  text: string,
  source: 'chat' | 'hand',
  scope: string = GENERAL_SCOPE,
): void {
  if (!tableExists(db, 'memory_audit')) return
  db.prepare(
    `
    INSERT INTO memory_audit (id, action, fact_text, source, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    `mau_${crypto.randomBytes(8).toString('hex')}`,
    action,
    text.slice(0, 280),
    source,
    scope,
    now(),
  )
}

export function getMemoryAudit(db: Database.Database, limit = 12): MemoryAuditEntry[] {
  if (!tableExists(db, 'memory_audit')) return []
  const rows = db
    .prepare(
      `
    SELECT id, action, fact_text, source, created_at
    FROM memory_audit
    ORDER BY created_at DESC
    LIMIT ?
  `,
    )
    .all(limit) as Array<{
    id: string
    action: MemoryAuditEntry['action']
    fact_text: string
    source: 'chat' | 'hand'
    created_at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    text: row.fact_text,
    source: row.source,
    createdAt: row.created_at,
  }))
}

// ── Drafting from real evidence ────────────────────────────────────────────

interface DraftFact {
  topicKey: string
  text: string
}

const CATEGORY_PHRASE: Partial<Record<AppCategory, string>> = {
  development: 'development',
  research: 'research and reading',
  writing: 'writing',
  design: 'design',
  communication: 'communication',
  meetings: 'meetings',
  email: 'email',
  aiTools: 'AI tools',
}

const BACKGROUND_DOMAINS = [
  'youtube.com',
  'x.com',
  'twitter.com',
  'reddit.com',
  'netflix.com',
  'instagram.com',
  'tiktok.com',
]

// Build the deterministic draft from the user's real app/site usage. Small,
// plain sentences grounded in evidence — never a number on noise.
function draftFactsFromEvidence(db: Database.Database): DraftFact[] {
  const facts: DraftFact[] = []
  const lookback = now() - 30 * 86_400_000

  // Top apps by time → the names for the sentence (group by app only).
  // Guard on table existence: a database that has work_memory_facts but not yet
  // app_sessions (no capture run) yields no app-based draft rather than a throw.
  if (!tableExists(db, 'app_sessions')) {
    return facts
  }
  const topApps = db
    .prepare(
      `
    SELECT app_name AS appName, SUM(duration_sec) AS total
    FROM app_sessions
    WHERE start_time >= ? AND app_name IS NOT NULL AND app_name != ''
    GROUP BY app_name
    ORDER BY total DESC
    LIMIT 5
  `,
    )
    .all(lookback) as Array<{ appName: string; total: number }>

  // Dominant category → grouped by category (not a non-grouped column), so the
  // phrase reflects real totals rather than an arbitrary per-app category value.
  const categoryTotals = db
    .prepare(
      `
    SELECT category, SUM(duration_sec) AS total
    FROM app_sessions
    WHERE start_time >= ? AND category IS NOT NULL
    GROUP BY category
  `,
    )
    .all(lookback) as Array<{ category: AppCategory; total: number }>

  const focusApps = topApps.filter((row) => (row.total ?? 0) > 1800)
  if (focusApps.length > 0) {
    const names = focusApps.slice(0, 3).map((row) => row.appName)
    const topCategory = mostCommonCategory(categoryTotals)
    const categoryPhrase = topCategory ? ` on ${CATEGORY_PHRASE[topCategory] ?? topCategory}` : ''
    facts.push({
      topicKey: 'top-apps',
      text: `You spend most of your day in ${joinNames(names)}${categoryPhrase}.`,
    })
  }

  // Background sites — what the user treats as not-focus. Reconciled credits
  // so background-tab history accrual can't inflate a domain's ranking (invariant 7).
  // Guard on table existence: website_visits may not exist before capture runs.
  if (tableExists(db, 'website_visits')) {
    const bgByDomain = new Map<string, number>()
    for (const interval of getReconciledDomainIntervals(db, lookback, now())) {
      const domain = interval.domain.replace(/^www\./, '')
      if (BACKGROUND_DOMAINS.some((bg) => domain === bg || domain.endsWith(`.${bg}`))) {
        bgByDomain.set(
          domain,
          (bgByDomain.get(domain) ?? 0) + (interval.end - interval.start) / 1000,
        )
      }
    }
    const background = [...bgByDomain.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([domain]) => domain)
    const uniqueBackground = [...new Set(background)].slice(0, 3)
    if (uniqueBackground.length > 0) {
      facts.push({
        topicKey: 'background',
        text: `You treat ${joinNames(uniqueBackground.map(prettyDomain))} as background, not focus.`,
      })
    }
  }

  // A rejected proposal (declined in chat) is not re-drafted from evidence.
  // The rejection key normalizes statement text, so the same plain-language
  // sentence matches whether it was proposed by the agent or reconstructed
  // from evidence. WO-18 / AC-SM-012.3.
  return facts.filter((draft) => !findMemoryProposalRejection(db, draft.text))
}

function mostCommonCategory(
  rows: Array<{ category: AppCategory; total: number }>,
): AppCategory | null {
  const totals = new Map<AppCategory, number>()
  for (const row of rows) {
    if (!row.category || row.category === 'uncategorized' || row.category === 'system') continue
    totals.set(row.category, (totals.get(row.category) ?? 0) + (row.total ?? 0))
  }
  let best: AppCategory | null = null
  let bestTotal = 0
  for (const [category, total] of totals) {
    if (total > bestTotal) {
      best = category
      bestTotal = total
    }
  }
  return best
}

function prettyDomain(domain: string): string {
  const base = domain.split('.')[0]
  return base.charAt(0).toUpperCase() + base.slice(1)
}

function joinNames(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

// Rebuild re-drafts from current evidence while KEEPING the user's hand edits
// and respecting purposeful deletes, and reports what changed in one line.
export function rebuildWorkMemory(db: Database.Database): RebuildResult {
  if (!ready(db)) return { facts: [], added: [], changeSummary: 'Work memory is unavailable.' }

  const existing = db
    .prepare(`SELECT id, fact_text, origin, status, topic_key, sort_order FROM work_memory_facts`)
    .all() as FactRow[]
  const tombstonedTopics = new Set(
    existing
      .filter((row) => row.status === 'deleted')
      .map((row) => row.topic_key)
      .filter(Boolean) as string[],
  )
  const draftedTopics = new Map(
    existing
      .filter((row) => row.origin === 'drafted' && row.status === 'active')
      .map((row) => [row.topic_key ?? '', row]),
  )

  // A draft that matches a rejected proposal is suppressed, not just skipped on
  // the next draft — tombstone the stored row so the profile stops showing it
  // and the topic can never be re-drafted. WO-18 / AC-SM-012.3.
  for (const row of existing.filter((row) => row.origin === 'drafted' && row.status === 'active')) {
    if (findMemoryProposalRejection(db, row.fact_text)) {
      db.prepare(
        `UPDATE work_memory_facts SET status = 'deleted', updated_at = ? WHERE id = ?`,
      ).run(now(), row.id)
      if (row.topic_key) tombstonedTopics.add(row.topic_key)
      draftedTopics.delete(row.topic_key ?? '')
    }
  }

  const drafts = draftFactsFromEvidence(db)
  const added: string[] = []
  const maxOrderRow = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM work_memory_facts`)
    .get() as { m: number }
  let nextOrder = (maxOrderRow.m ?? 0) + 1

  const insert = db.prepare(`
    INSERT INTO work_memory_facts (id, fact_text, origin, status, topic_key, sort_order, created_at, updated_at)
    VALUES (?, ?, 'drafted', 'active', ?, ?, ?, ?)
  `)
  const refresh = db.prepare(
    `UPDATE work_memory_facts SET fact_text = ?, updated_at = ? WHERE id = ?`,
  )

  for (const draft of drafts) {
    if (tombstonedTopics.has(draft.topicKey)) continue // purposely forgotten — stay gone
    const current = draftedTopics.get(draft.topicKey)
    if (current) {
      if (current.fact_text !== draft.text) refresh.run(draft.text, now(), current.id)
      continue
    }
    insert.run(newId(), draft.text, draft.topicKey, nextOrder++, now(), now())
    added.push(draft.text)
  }

  const facts = getWorkMemoryProfile(db).facts
  const changeSummary =
    added.length > 0
      ? `Rebuilt — added: ${added.map((text) => truncate(text, 50)).join('; ')}.`
      : 'Rebuilt — nothing new to add; your profile already matches your recent activity.'
  return { facts, added, changeSummary }
}

// A drafted fact Daylens noticed from real evidence that the user hasn't stored
// or purposely forgotten — so the assistant can OFFER to remember it rather
// than silently absorbing it (memory.md §2.1). Forgotten topics carry a
// tombstone row (topic_key present, status='deleted'), so they're excluded and
// never proposed again.
export function proposeUnstoredMemoryFact(
  db: Database.Database,
): { topicKey: string; text: string } | null {
  if (!ready(db)) return null
  const drafts = draftFactsFromEvidence(db)
  if (drafts.length === 0) return null
  const known = new Set(
    (
      db
        .prepare(`SELECT topic_key FROM work_memory_facts WHERE topic_key IS NOT NULL`)
        .all() as Array<{ topic_key: string }>
    ).map((row) => row.topic_key),
  )
  for (const draft of drafts) {
    if (!known.has(draft.topicKey)) return { topicKey: draft.topicKey, text: draft.text }
  }
  return null
}

// The profile handed to every AI surface as context (naming, recaps, chat,
// wraps). Only confirmed facts ride this block — drafts are proposals shown in
// the Manage-memory view, not AI context (WO-18 / AC-SM-012.1).
export function workMemoryPromptBlock(db: Database.Database): string {
  const { facts } = getWorkMemoryProfile(db, true)
  if (facts.length === 0) return ''
  return [
    'What Daylens knows about this user (context only — never invent activity beyond the real evidence):',
    ...facts.map((fact) => `- ${fact.text}`),
  ].join('\n')
}

// One client's scoped memory as a prompt block — the archival tier, pulled in
// only when the question is about that client (memory.md §2.2 / invariant 4).
// Context only: it colors how Daylens reads that client's tracked activity, the
// hours still come from the attribution evidence.
export function clientMemoryPromptBlock(
  db: Database.Database,
  clientId: string,
  clientName: string,
): string {
  const facts = getClientMemory(db, clientId, true)
  if (facts.length === 0) return ''
  return [
    `What Daylens knows about ${clientName} (context only — never invent activity beyond the real evidence):`,
    ...facts.map((fact) => `- ${fact.text}`),
  ].join('\n')
}

interface ScopeMatchRow {
  client_id: string
  client_name: string
  alias: string
}

export interface ClientScopeMatch {
  clientId: string
  clientName: string
}

// Every active client whose name/alias appears as a whole word in the text, in
// the order they first match. Word-boundary, case-insensitive; aliases under 3
// characters are ignored so a stray "AB" can't pull a scope in. Shared by the
// read path (scopedMemoryPromptBlock) and the write path (chat "remember Acme…").
function matchClientsInText(db: Database.Database, text: string): ClientScopeMatch[] {
  if (!ready(db) || !text.trim()) return []
  if (!tableExists(db, 'clients') || !tableExists(db, 'client_aliases')) return []
  const lower = ` ${text.toLowerCase()} `
  const rows = db
    .prepare(
      `
    SELECT c.id AS client_id, c.name AS client_name, ca.alias AS alias
    FROM clients c
    JOIN client_aliases ca ON ca.client_id = c.id
    WHERE c.status = 'active'
  `,
    )
    .all() as ScopeMatchRow[]

  const seen = new Set<string>()
  const matches: ClientScopeMatch[] = []
  for (const row of rows) {
    if (seen.has(row.client_id)) continue
    const alias = row.alias.toLowerCase().trim()
    if (alias.length < 3) continue
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(alias)}(?:$|[^a-z0-9])`)
    if (!re.test(lower)) continue
    matches.push({ clientId: row.client_id, clientName: row.client_name })
    seen.add(row.client_id)
  }
  return matches
}

// The single client a memory instruction is about, or null for general memory.
// "remember Acme's deadline is the 30th" → Acme's scope. If the text names more
// than one client we stay general rather than guess which scope to write to.
export function findClientScopeForWrite(
  db: Database.Database,
  text: string,
): ClientScopeMatch | null {
  const matches = matchClientsInText(db, text)
  return matches.length === 1 ? matches[0] : null
}

// If a free-form question names a known client (by name or alias), return that
// client's scoped memory block so the chat answer reads as someone on top of the
// account (memory.md §2.2). Returns '' when no client is mentioned or the client
// has no memory yet.
export function scopedMemoryPromptBlock(db: Database.Database, question: string): string {
  const blocks: string[] = []
  for (const match of matchClientsInText(db, question)) {
    const block = clientMemoryPromptBlock(db, match.clientId, match.clientName)
    if (block) blocks.push(block)
  }
  return blocks.join('\n\n')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The whole memory context for a chat turn: general memory always, plus any
// mentioned client's scoped memory (memory.md §4). General-only callers keep
// using workMemoryPromptBlock.
export function chatMemoryPromptBlock(db: Database.Database, question: string): string {
  const general = workMemoryPromptBlock(db)
  const scoped = scopedMemoryPromptBlock(db, question)
  return [general, scoped].filter((part) => part.trim().length > 0).join('\n\n')
}

// The full memory picture for the Manage-memory view: general facts plus each
// active client's scoped facts, so memory reads "organized under each client"
// (memory.md §3).
export interface ClientMemoryGroup {
  clientId: string
  clientName: string
  color: string | null
  facts: WorkMemoryFact[]
}

export interface ScopedMemoryProfile {
  general: WorkMemoryFact[]
  clients: ClientMemoryGroup[]
}

export function getScopedMemoryProfile(
  db: Database.Database,
  confirmedOnly = false,
): ScopedMemoryProfile {
  if (!ready(db)) return { general: [], clients: [] }
  const general = readFactsForScope(db, GENERAL_SCOPE, confirmedOnly)
  if (!tableExists(db, 'clients')) return { general, clients: [] }
  const clientRows = db
    .prepare(
      `
    SELECT id, name, color FROM clients WHERE status = 'active' ORDER BY name ASC
  `,
    )
    .all() as Array<{ id: string; name: string; color: string | null }>
  const clients = clientRows.map((row) => ({
    clientId: row.id,
    clientName: row.name,
    color: row.color,
    facts: getClientMemory(db, row.id, confirmedOnly),
  }))
  return { general, clients }
}
