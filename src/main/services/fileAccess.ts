// Safe agent file access (agent-runtime-and-context.md §File and document
// access, DEV-184).
//
// Three separate states above the visible-home path floor in
// src/main/agent/systemTools.ts (the floor ALWAYS runs first — a grant can
// never resurrect a hidden, excluded, or symlink-escaped path):
//
//   Observed        — metadata only. Names, sizes, filename matches, repo
//                     rankings, git metadata. No grant needed; this is
//                     information the product already holds.
//   Indexed         — the person granted a named file or folder for LOCAL
//                     extraction/search. Extraction itself is a stub in this
//                     batch (derived_text on the grant row); the state exists
//                     so revocation semantics and the never-escalates rule are
//                     real from day one.
//   Model-readable  — a relevant excerpt may be disclosed to the selected
//                     model for the current request. Every disclosure is
//                     recorded (identity, version fingerprint, excerpt
//                     location, reason, destination) BEFORE the content is
//                     returned toward the model.
//
// Granting one state never grants the next: an 'indexed' grant does not make
// a file model-readable. A 'model_readable' grant covers local indexing of the
// same path (the lesser use of the same content), which is the only implied
// direction. High-sensitivity files additionally require the grant's explicit
// allow_high_sensitivity flag — the in-chat card can never set it; only
// Settings can.
//
// Revoking a grant stops future disclosure immediately and deletes the derived
// text in the same statement that marks the revocation.
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

export type FileAccessState = 'indexed' | 'model_readable'
export type FileSensitivity = 'standard' | 'personal' | 'high'

export interface FileAccessGrant {
  id: string
  scope_kind: 'file' | 'folder'
  path: string
  state: FileAccessState
  allow_high_sensitivity: number
  source: 'settings' | 'chat'
  derived_text: string | null
  derived_text_extracted_at: number | null
  created_at: number
  revoked_at: number | null
}

export interface FileDisclosureRow {
  id: string
  thread_id: number | null
  message_id: number | null
  file_path: string
  display_name: string
  version_fingerprint: string
  excerpt_start: number
  excerpt_end: number
  reason: string
  sensitivity: FileSensitivity
  destination: string
  left_device: number
  disclosed_at: number
}

// ─── Sensitivity classification ──────────────────────────────────────────────

// The path floor already denies hidden files and credential directories. This
// classifies what survives the floor but still deserves the extra
// high-sensitivity permission (spec: "High-sensitivity content requires an
// explicit model-access permission in addition to file or folder access").
const HIGH_SENSITIVITY_NAME = /(secret|credential|password|passwd|private[-_ ]?key|keychain|wallet|seed[-_ ]?phrase|recovery[-_ ]?code)/i
const HIGH_SENSITIVITY_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx'])

export function classifyFileSensitivity(filePath: string): FileSensitivity {
  const base = path.basename(filePath)
  if (HIGH_SENSITIVITY_EXT.has(path.extname(base).toLowerCase())) return 'high'
  if (HIGH_SENSITIVITY_NAME.test(base)) return 'high'
  return 'standard'
}

// ─── Grants ──────────────────────────────────────────────────────────────────

export function addFileAccessGrant(
  db: Database.Database,
  input: {
    scopeKind: 'file' | 'folder'
    path: string
    state: FileAccessState
    allowHighSensitivity?: boolean
    source?: 'settings' | 'chat'
  },
): FileAccessGrant {
  if (!path.isAbsolute(input.path)) throw new Error('Grants require an absolute path.')
  const id = `fag_${randomUUID().replace(/-/g, '').slice(0, 18)}`
  // Resolve symlinks so stored paths match what resolveVisibleHomePath returns
  // via fs.realpath (on macOS /var → /private/var, etc.).
  let resolvedPath: string
  try {
    resolvedPath = fs.realpathSync(input.path)
  } catch {
    resolvedPath = path.resolve(input.path)
  }
  db.prepare(`
    INSERT INTO file_access_grants (id, scope_kind, path, state, allow_high_sensitivity, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.scopeKind,
    resolvedPath,
    input.state,
    input.allowHighSensitivity ? 1 : 0,
    input.source ?? 'settings',
    Date.now(),
  )
  return db.prepare(`SELECT * FROM file_access_grants WHERE id = ?`).get(id) as FileAccessGrant
}

/** Revocation stops future disclosure AND deletes the derived text (spec:
 *  "Removing access deletes unsupported extracted text, embeddings, summaries,
 *  and cached excerpts") in one statement. */
export function revokeFileAccessGrant(db: Database.Database, grantId: string): boolean {
  const result = db.prepare(`
    UPDATE file_access_grants
    SET revoked_at = ?, derived_text = NULL, derived_text_extracted_at = NULL
    WHERE id = ? AND revoked_at IS NULL
  `).run(Date.now(), grantId)
  return result.changes > 0
}

export function listFileAccessGrants(
  db: Database.Database,
  options: { includeRevoked?: boolean } = {},
): FileAccessGrant[] {
  return db.prepare(`
    SELECT * FROM file_access_grants
    ${options.includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
    ORDER BY created_at DESC
  `).all() as FileAccessGrant[]
}

function grantCovers(grant: FileAccessGrant, realPath: string): boolean {
  const grantPath = path.normalize(grant.path)
  if (grant.scope_kind === 'file') return grantPath === realPath
  const relative = path.relative(grantPath, realPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The unrevoked grant covering realPath at the requested state, if any.
 *  'indexed' is satisfied by an indexed OR model_readable grant;
 *  'model_readable' ONLY by a model_readable grant — indexing never escalates. */
export function findCoveringGrant(
  db: Database.Database,
  realPath: string,
  state: FileAccessState,
): FileAccessGrant | null {
  // Resolve symlinks so the lookup path matches the stored grant paths (which
  // are always real-path-resolved by addFileAccessGrant).
  let resolvedPath: string
  try {
    resolvedPath = fs.realpathSync(realPath)
  } catch {
    resolvedPath = path.resolve(realPath)
  }
  const states = state === 'indexed' ? ['indexed', 'model_readable'] : ['model_readable']
  const grants = db.prepare(`
    SELECT * FROM file_access_grants
    WHERE revoked_at IS NULL AND state IN (${states.map(() => '?').join(', ')})
  `).all(...states) as FileAccessGrant[]
  const covering = grants.filter((grant) => grantCovers(grant, resolvedPath))
  if (covering.length === 0) return null
  // Prefer the most specific (longest) covering path.
  covering.sort((left, right) => right.path.length - left.path.length)
  return covering[0]
}

export interface FileAccessDecision {
  access: 'metadata' | 'indexed' | 'model_readable' | 'denied'
  grant: FileAccessGrant | null
  sensitivity: FileSensitivity
  reason?: string
}

/**
 * Decide what the agent may do with a path that ALREADY passed the visible-home
 * floor. Deny-by-default for content: no covering model_readable grant means
 * the caller must ask, not read.
 */
export function resolveFileAccess(db: Database.Database, realPath: string): FileAccessDecision {
  const sensitivity = classifyFileSensitivity(realPath)
  const modelGrant = findCoveringGrant(db, realPath, 'model_readable')
  if (modelGrant) {
    if (sensitivity === 'high' && !modelGrant.allow_high_sensitivity) {
      return {
        access: 'denied',
        grant: modelGrant,
        sensitivity,
        reason: 'This file looks high-sensitivity. It needs an explicit high-sensitivity permission in Settings → Agent file access, in addition to the folder grant.',
      }
    }
    return { access: 'model_readable', grant: modelGrant, sensitivity }
  }
  const indexGrant = findCoveringGrant(db, realPath, 'indexed')
  if (indexGrant) return { access: 'indexed', grant: indexGrant, sensitivity }
  return { access: 'metadata', grant: null, sensitivity }
}

// ─── Version fingerprint ─────────────────────────────────────────────────────

/** Stable identity for "the version that was disclosed": size, mtime, and a
 *  short content hash of the read range. Changes when the file changes. */
export function fileVersionFingerprint(
  stat: { size: number; mtimeMs: number },
  content: Buffer | string,
): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
  return `${stat.size}-${Math.round(stat.mtimeMs)}-${hash}`
}

// ─── Disclosure ledger ───────────────────────────────────────────────────────

export interface RecordDisclosureInput {
  threadId?: number | null
  messageId?: number | null
  filePath: string
  /** What the ledger names as the disclosed artifact. Defaults to the file's
   *  basename; run_command passes the full command line instead, so the trail
   *  shows WHAT ran, not just where. */
  displayName?: string
  versionFingerprint: string
  excerptStart: number
  excerptEnd: number
  reason: string
  sensitivity?: FileSensitivity
  destination: string
}

/** Write the disclosure row. Callers MUST do this before returning content
 *  toward the model — the ledger is the record that something left. */
export function recordFileDisclosure(db: Database.Database, input: RecordDisclosureInput): FileDisclosureRow {
  const id = `fdis_${randomUUID().replace(/-/g, '').slice(0, 18)}`
  db.prepare(`
    INSERT INTO file_disclosures (
      id, thread_id, message_id, file_path, display_name, version_fingerprint,
      excerpt_start, excerpt_end, reason, sensitivity, destination, left_device, disclosed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    id,
    input.threadId ?? null,
    input.messageId ?? null,
    input.filePath,
    input.displayName ?? path.basename(input.filePath),
    input.versionFingerprint,
    input.excerptStart,
    input.excerptEnd,
    input.reason,
    input.sensitivity ?? classifyFileSensitivity(input.filePath),
    input.destination,
    Date.now(),
  )
  return db.prepare(`SELECT * FROM file_disclosures WHERE id = ?`).get(id) as FileDisclosureRow
}

export function listFileDisclosures(
  db: Database.Database,
  options: { limit?: number; threadId?: number | null } = {},
): FileDisclosureRow[] {
  if (options.threadId != null) {
    return db.prepare(`
      SELECT * FROM file_disclosures WHERE thread_id = ? ORDER BY disclosed_at DESC LIMIT ?
    `).all(options.threadId, options.limit ?? 100) as FileDisclosureRow[]
  }
  return db.prepare(`
    SELECT * FROM file_disclosures ORDER BY disclosed_at DESC LIMIT ?
  `).all(options.limit ?? 100) as FileDisclosureRow[]
}

// ─── Indexed-state extraction stub ───────────────────────────────────────────

/** Store the extraction stub for an indexed grant. Real extraction is future
 *  work; the column exists so revocation ("removing access deletes the derived
 *  text") is a real, testable behavior from the first release of the model. */
export function storeDerivedText(db: Database.Database, grantId: string, text: string): void {
  db.prepare(`
    UPDATE file_access_grants
    SET derived_text = ?, derived_text_extracted_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(text, Date.now(), grantId)
}
