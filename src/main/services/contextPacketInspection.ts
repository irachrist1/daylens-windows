// Context packet inspection (DEV-183, agent-runtime-and-context.md §Context
// inspection): "what did the model see for this answer", assembled from the
// recorded ledger row — never by re-running assembly, never by calling a
// model. The inspection is read-only and honest:
//
//   grouped — every packet kind appears (empty or not), so the view can state
//     plainly that e.g. no file contents were sent;
//   reasoned — each item keeps its recorded "why was this included" reason,
//     source type, sensitivity, and content version;
//   omissions in plain language — what was considered and deliberately not
//     sent, and why;
//   deletion-coherent — the packet is a historical disclosure record: content
//     that already left the device cannot be un-sent by deleting the evidence
//     later (the deletion machinery separately deletes whole packet rows whose
//     text is in scope of a purge — see trackingHistory's generic scrub). For
//     the rows that remain, each item is checked against the evidence backing
//     it TODAY and labeled when that evidence has since been deleted, the
//     block recomputed, or the file grant revoked (spec §Privacy and
//     disclosure: deletion removes material from FUTURE packets; the recorded
//     disclosure stays truthful about the past).
//
// The inspector never exposes provider system prompts, hidden model
// reasoning, credentials, or security instructions — everything here comes
// from the packet the person's own data produced (spec §Context inspection).
import type Database from 'better-sqlite3'
import { aggregateToolsConsulted } from '@shared/agentTrail'
import type {
  AIThreadMessageMetadata,
  ContextPacketEvidenceState,
  ContextPacketInspection,
  ContextPacketInspectionGroup,
  ContextPacketInspectionItem,
  ContextPacketInspectionOmission,
  ContextPacketListEntry,
  ContextPacketToolConsulted,
} from '@shared/types'
import {
  getContextPacketById,
  getContextPacketForMessage,
  listContextPackets,
  type ContextItemKind,
  type ContextPacketItem,
  type ContextPacketOmission,
  type StoredContextPacket,
} from './contextPacket'

/** Plain-language group headings, in the packet's own kind order. */
export const KIND_LABELS: Record<ContextItemKind, string> = {
  day_fact: 'Facts from your timeline',
  corrected_fact: 'Things Daylens knows about you',
  entity: 'People, projects, and things the question named',
  search_exact: 'Moments matched by exact search',
  search_semantic: 'Moments matched by meaning',
  file_excerpt: 'File excerpts',
}

const KIND_ORDER: ContextItemKind[] = [
  'day_fact',
  'corrected_fact',
  'entity',
  'search_exact',
  'search_semantic',
  'file_excerpt',
]

const OMISSION_KIND_PHRASES: Record<ContextItemKind, [singular: string, plural: string]> = {
  day_fact: ['timeline fact', 'timeline facts'],
  corrected_fact: ['memory fact', 'memory facts'],
  entity: ['entity', 'entities'],
  search_exact: ['search match', 'search matches'],
  search_semantic: ['by-meaning match', 'by-meaning matches'],
  file_excerpt: ['file excerpt', 'file excerpts'],
}

const OMISSION_REASON_PHRASES: Record<ContextPacketOmission['reason'], string> = {
  excluded: 'held back by an applicable exclusion',
  deleted: 'held back because the supporting material was deleted',
  unauthorized: 'held back because the required permission was not granted',
  unavailable: 'held back because the supporting source was unavailable',
  'high-sensitivity': 'held back as high-sensitivity — sending it needs its own explicit permission',
  'tracking-excluded': 'held back by your tracking exclusions',
  'context-budget': 'left for on-demand retrieval because the initial context budget was full',
}

/** "1 file excerpt was considered and not sent: held back as high-sensitivity…" */
export function omissionLabel(omission: ContextPacketOmission): string {
  const [singular, plural] = OMISSION_KIND_PHRASES[omission.kind] ?? ['item', 'items']
  const noun = omission.count === 1 ? singular : plural
  const verb = omission.count === 1 ? 'was' : 'were'
  const reason = OMISSION_REASON_PHRASES[omission.reason] ?? omission.reason
  return `${omission.count} ${noun} ${verb} considered and not sent: ${reason}`
}

// ─── Evidence presence ───────────────────────────────────────────────────────
// Each recorded item names its backing record by typed identity. The check is
// per identity form and conservative: a lookup failure (older install missing
// a table, malformed identity) reports 'unverified' rather than guessing.

function exists(db: Database.Database, sql: string, ...params: unknown[]): boolean {
  try {
    return db.prepare(sql).get(...params) != null
  } catch {
    return false
  }
}

export interface EvidencePresence {
  state: ContextPacketEvidenceState
  note: string | null
}

const PRESENT: EvidencePresence = { state: 'present', note: null }

/**
 * Is the evidence behind this disclosed item still part of the record today?
 * Identity forms mirror the assembler's: block:<id>, fact:<id>, entity:<id>,
 * session:<rowid>, browser:<id>, artifact:<id>, file:<path>.
 */
export function resolveEvidencePresence(
  db: Database.Database,
  item: Pick<ContextPacketItem, 'identity' | 'kind'>,
): EvidencePresence {
  const separator = item.identity.indexOf(':')
  if (separator <= 0) {
    return { state: 'unverified', note: 'Daylens cannot check whether this evidence still exists.' }
  }
  const prefix = item.identity.slice(0, separator)
  const id = item.identity.slice(separator + 1)
  switch (prefix) {
    case 'block':
      // Block ids churn on reprojection, so a missing or invalidated row means
      // "no longer in the current timeline" — recomputed or deleted — not
      // necessarily a person's deletion. Say exactly that.
      return exists(db, `SELECT 1 FROM timeline_blocks WHERE id = ? AND invalidated_at IS NULL`, id)
        ? PRESENT
        : {
            state: 'deleted',
            note: 'This timeline block is no longer in your current record — it was recomputed or deleted after this answer.',
          }
    case 'fact':
      // Memory facts live in two stores of one profile: evidence-drafted rows
      // in work_memory_facts and confirmed supplied rows (smf_…) in
      // supplied_memory_facts, which deletes by row removal (DEV-185).
      return exists(db, `SELECT 1 FROM work_memory_facts WHERE id = ? AND status = 'active'`, id)
          || exists(db, `SELECT 1 FROM supplied_memory_facts WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This memory fact has since been forgotten.' }
    case 'entity':
      // A merged entity still exists (it points at its survivor); only a
      // deleted or missing row is gone.
      return exists(db, `SELECT 1 FROM entities WHERE id = ? AND status != 'deleted'`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This entity has since been deleted from your memory.' }
    case 'session':
      // Search hits address memory records by rowid, with legacy app_sessions
      // sharing the id space as a fallback — mirror both.
      return exists(db, `SELECT 1 FROM memory_records WHERE rowid = ? AND deleted_at IS NULL`, id)
          || exists(db, `SELECT 1 FROM app_sessions WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This moment has since been deleted from your history.' }
    case 'browser':
      return exists(db, `SELECT 1 FROM website_visits WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This page visit has since been deleted from your history.' }
    case 'artifact':
      return exists(db, `SELECT 1 FROM ai_artifacts WHERE id = ?`, id)
        ? PRESENT
        : { state: 'deleted', note: 'This exported file has since been deleted.' }
    case 'file':
      // The excerpt was disclosed under a model-readable grant on exactly this
      // path. A revoked grant also deleted its derived text (DEV-184), so the
      // honest state is "access revoked" rather than pretending the read never
      // happened.
      return exists(
        db,
        `SELECT 1 FROM file_access_grants WHERE path = ? AND state = 'model_readable' AND revoked_at IS NULL`,
        id,
      )
        ? PRESENT
        : {
            state: 'access_revoked',
            note: 'Access to this file has since been revoked and its extracted text deleted. This excerpt remains part of the disclosure record because it was already sent.',
          }
    default:
      return { state: 'unverified', note: 'Daylens cannot check whether this evidence still exists.' }
  }
}

// ─── Tools consulted ─────────────────────────────────────────────────────────
// The packet is recorded before the model call, so tool calls live in the
// persisted turn trace, not in the packet: read them from the assistant
// message the packet was later bound to. Only tool NAMES and call counts are
// exposed — never the traced inputs/outputs, which the message view already
// governs separately. An mcp_-prefixed name is one of the person's own MCP
// servers (the namespace connectMcpTools applies), identified as such.

/** Tools called during the exchange, in first-use order; null when no turn
 *  record is bound to the message. */
export function toolsConsultedForMessage(
  db: Database.Database,
  messageId: number | null,
): ContextPacketToolConsulted[] | null {
  if (messageId == null) return null
  let metadataJson: string | undefined
  try {
    const row = db.prepare(`SELECT metadata_json FROM ai_messages WHERE id = ?`).get(messageId) as
      | { metadata_json: string }
      | undefined
    metadataJson = row?.metadata_json
  } catch {
    return null
  }
  if (!metadataJson) return null
  let metadata: AIThreadMessageMetadata
  try {
    metadata = JSON.parse(metadataJson) as AIThreadMessageMetadata
  } catch {
    return null
  }
  return aggregateToolsConsulted(metadata.agent?.toolTrace)
}

// ─── Assembly ────────────────────────────────────────────────────────────────

function toInspectionItem(db: Database.Database, item: ContextPacketItem): ContextPacketInspectionItem {
  const presence = resolveEvidencePresence(db, item)
  return {
    identity: item.identity,
    kind: item.kind,
    sourceType: item.sourceType,
    statement: item.statement,
    version: item.version,
    reason: item.reason,
    sensitivity: item.sensitivity,
    date: item.date,
    evidenceState: presence.state,
    evidenceNote: presence.note,
  }
}

/**
 * The full read-only inspection of one recorded packet. Pure over the stored
 * row apart from the per-item presence checks.
 */
export function assembleContextPacketInspection(
  db: Database.Database,
  stored: StoredContextPacket,
): ContextPacketInspection {
  const { packet } = stored
  const groups: ContextPacketInspectionGroup[] = KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    items: packet.items
      .filter((item) => item.kind === kind)
      .map((item) => toInspectionItem(db, item)),
  }))
  const omissions: ContextPacketInspectionOmission[] = packet.disclosure.omissions.map((omission) => ({
    kind: omission.kind,
    count: omission.count,
    reason: omission.reason,
    label: omissionLabel(omission),
  }))
  return {
    packetId: packet.id,
    exchangeKind: stored.exchangeKind,
    purpose: packet.purpose as ContextPacketInspection['purpose'],
    threadId: stored.threadId,
    messageId: stored.messageId,
    question: packet.request.originalText,
    dates: packet.request.dates,
    timezone: packet.person.timezone,
    createdAt: stored.createdAt,
    policyVersion: packet.policyVersion,
    contentFingerprint: packet.contentFingerprint,
    destination: stored.destination,
    leftDevice: packet.disclosure.leftDevice,
    itemCount: packet.disclosure.itemCount,
    toolsConsulted: toolsConsultedForMessage(db, stored.messageId),
    groups,
    conflicts: packet.conflicts.map((conflict) => ({
      identity: conflict.identity,
      detail: conflict.detail,
      resolvedBy: conflict.resolvedBy,
    })),
    gaps: packet.gaps.map((gap) => ({ date: gap.date, detail: gap.detail, kind: gap.kind })),
    permissions: packet.permissions.map((permission) => ({
      kind: permission.kind,
      scopeKind: permission.scopeKind,
      path: permission.path,
      state: permission.state,
      allowHighSensitivity: permission.allowHighSensitivity,
    })),
    omissions,
  }
}

/**
 * Look the packet up by its id or by the assistant message it answered, then
 * assemble the inspection. Null when nothing was recorded — the UI states
 * that honestly instead of inventing a view.
 */
export function inspectContextPacket(
  db: Database.Database,
  ref: { packetId?: string | null; messageId?: number | null },
): ContextPacketInspection | null {
  const stored = ref.packetId
    ? getContextPacketById(db, ref.packetId)
    : typeof ref.messageId === 'number'
      ? getContextPacketForMessage(db, ref.messageId)
      : null
  return stored ? assembleContextPacketInspection(db, stored) : null
}

/** Lightweight rows for the packet browser — no packet JSON crosses IPC. */
export function listContextPacketEntries(
  db: Database.Database,
  options: { limit?: number } = {},
): ContextPacketListEntry[] {
  return listContextPackets(db, { limit: options.limit ?? 30 }).map((stored) => ({
    packetId: stored.id,
    exchangeKind: stored.exchangeKind,
    threadId: stored.threadId,
    messageId: stored.messageId,
    question: stored.packet.request.originalText,
    destination: stored.destination,
    createdAt: stored.createdAt,
    itemCount: stored.packet.disclosure.itemCount,
    counts: { ...stored.packet.disclosure.counts } as Record<string, number>,
  }))
}
