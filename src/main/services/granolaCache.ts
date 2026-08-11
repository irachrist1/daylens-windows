// Reading the local Granola cache — ONE reader shared by the context packet's
// transcript excerpts and the chat agent's read_meeting_notes tool, so the
// cache-path resolution and parsing can never diverge between the two.
//
// Granola wraps its state as `{"cache": "<stringified json>"}`; documents live
// in `state.documents` (array or map), transcripts either in a top-level
// `state.transcripts` map (docId → segments or string) or on the document's
// own `transcribe`/`transcript` field, and the structured notes on the
// document itself (`notes_markdown` / `notes_plain`, or a ProseMirror-style
// `notes` tree).
import type Database from 'better-sqlite3'

export interface GranolaConnection {
  status: string
  /** Absolute path of the raw Granola cache file, from the connection config. */
  cachePath: string
}

/** The connected Granola cache location, exactly as the context packet
 *  resolves it: a non-disconnected connector_connections row whose config
 *  carries a cachePath. Null when Granola is not connected or unconfigured. */
export function getGranolaConnection(db: Database.Database): GranolaConnection | null {
  try {
    const connection = db.prepare(
      `SELECT status, config_json FROM connector_connections WHERE connector_id = 'granola'`,
    ).get() as { status: string; config_json: string } | undefined
    if (!connection || connection.status === 'disconnected') return null
    const config = JSON.parse(connection.config_json) as { cachePath?: unknown }
    const cachePath = typeof config.cachePath === 'string' && config.cachePath.trim() ? config.cachePath : null
    if (!cachePath) return null
    return { status: connection.status, cachePath }
  } catch {
    return null
  }
}

function granolaState(raw: string): Record<string, unknown> | null {
  let outer: unknown
  try {
    outer = JSON.parse(raw)
  } catch {
    return null
  }
  if (outer == null || typeof outer !== 'object') return null
  let stateHost = outer as Record<string, unknown>
  if (typeof stateHost.cache === 'string') {
    try {
      const inner = JSON.parse(stateHost.cache)
      if (inner && typeof inner === 'object') stateHost = inner as Record<string, unknown>
    } catch {
      return null
    }
  }
  return (stateHost.state && typeof stateHost.state === 'object'
    ? stateHost.state
    : stateHost) as Record<string, unknown>
}

export function granolaDocumentsOf(state: Record<string, unknown>): Array<Record<string, unknown>> {
  const documents = state.documents
  if (Array.isArray(documents)) {
    return documents.filter((doc): doc is Record<string, unknown> => doc != null && typeof doc === 'object')
  }
  if (documents && typeof documents === 'object') {
    return Object.values(documents as Record<string, unknown>)
      .filter((doc): doc is Record<string, unknown> => doc != null && typeof doc === 'object')
  }
  return []
}

function transcriptEntryText(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null
  if (!Array.isArray(entry)) return null
  const parts: string[] = []
  for (const segment of entry) {
    if (typeof segment === 'string') {
      if (segment.trim()) parts.push(segment.trim())
      continue
    }
    if (segment && typeof segment === 'object') {
      const record = segment as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text : typeof record.content === 'string' ? record.content : null
      if (text?.trim()) parts.push(text.trim())
    }
  }
  return parts.length > 0 ? parts.join(' ') : null
}

/** One document's transcript out of the raw cache file, or null. */
export function extractGranolaTranscript(raw: string, docId: string): string | null {
  const state = granolaState(raw)
  if (!state) return null
  const transcripts = state.transcripts
  if (transcripts && typeof transcripts === 'object' && !Array.isArray(transcripts)) {
    const entry = (transcripts as Record<string, unknown>)[docId]
    const text = transcriptEntryText(entry)
    if (text) return text
  }
  for (const doc of granolaDocumentsOf(state)) {
    if (doc.id !== docId) continue
    return transcriptEntryText(doc.transcribe) ?? transcriptEntryText(doc.transcript)
  }
  return null
}

/** Flatten a ProseMirror-style notes tree ({ type, content: [...], text })
 *  into plain text, paragraph nodes separated by newlines. */
function proseMirrorText(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(proseMirrorText).filter(Boolean).join('\n')
  if (typeof node !== 'object') return ''
  const record = node as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (Array.isArray(record.content)) {
    const joiner = record.type === 'doc' ? '\n' : record.type === 'paragraph' || record.type === 'heading' ? '' : '\n'
    return record.content.map(proseMirrorText).filter(Boolean).join(joiner)
  }
  return ''
}

/** One document's structured notes out of the raw cache file: markdown or
 *  plain notes when present, a flattened ProseMirror tree otherwise. Null when
 *  the document has no notes (callers may fall back to the transcript). */
export function extractGranolaNotes(raw: string, docId: string): string | null {
  const state = granolaState(raw)
  if (!state) return null
  for (const doc of granolaDocumentsOf(state)) {
    if (doc.id !== docId) continue
    for (const field of ['notes_markdown', 'notes_plain'] as const) {
      const value = doc[field]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    const tree = proseMirrorText(doc.notes)
    return tree.trim() || null
  }
  return null
}
