// Artifact persistence for the AI surface.
//
// Responsibilities:
// - Persist small (< INLINE_LIMIT bytes) artifacts inline in sqlite.
// - Persist larger artifacts to userData/artifacts/<id>.<ext> on disk.
// - Load / open / export artifacts for the renderer.
//
// The artifacts layer is additive — existing AIMessageArtifact metadata on
// assistant messages keeps working; this layer gives us durable rows that
// survive message deletion and can be listed per thread.

import { app, dialog, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type Database from 'better-sqlite3'
import { getDb } from './database'
import type { AIArtifactContent, AIArtifactKind, AIArtifactRecord } from '@shared/types'
import { capture } from './analytics'
import { ANALYTICS_EVENT, byteSizeBucket, type AnalyticsEventName } from '@shared/analytics'
import { DEFAULT_THREAD_TITLE, normalizeThreadTitle } from '../lib/threadTitles'

const INLINE_LIMIT_BYTES = 32 * 1024

function mimeForKind(kind: AIArtifactKind): string {
  switch (kind) {
    case 'markdown': return 'text/markdown'
    case 'csv': return 'text/csv'
    case 'html_chart': return 'text/html'
    case 'json_table': return 'application/json'
    case 'focus_session': return 'application/json'
    case 'report': return 'text/markdown'
  }
}

function extForKind(kind: AIArtifactKind): string {
  switch (kind) {
    case 'markdown': return 'md'
    case 'csv': return 'csv'
    case 'html_chart': return 'html'
    case 'json_table': return 'json'
    case 'focus_session': return 'json'
    case 'report': return 'md'
  }
}

function baseUserDir(): string {
  // app may be undefined in tests / ELECTRON_RUN_AS_NODE contexts.
  try {
    return app?.getPath?.('userData') ?? os.tmpdir()
  } catch {
    return os.tmpdir()
  }
}

async function ensureArtifactDir(): Promise<string> {
  const dir = path.join(baseUserDir(), 'artifacts')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export interface CreateArtifactInput {
  threadId: number | null
  messageId?: number | null
  kind: AIArtifactKind
  title: string
  summary?: string | null
  content: string
  meta?: Record<string, unknown>
  // Pre-existing file on disk. If provided, we reference instead of re-writing.
  existingFilePath?: string | null
  mimeType?: string
  createdAt?: number
}

function rowToRecord(row: {
  id: number
  thread_id: number | null
  message_id: number | null
  kind: string
  title: string
  summary: string | null
  file_path: string | null
  inline_content: string | null
  mime_type: string
  byte_size: number
  meta_json: string
  created_at: number
}): AIArtifactRecord {
  let meta: Record<string, unknown> = {}
  try {
    meta = row.meta_json ? JSON.parse(row.meta_json) : {}
  } catch {
    meta = {}
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    kind: row.kind as AIArtifactKind,
    title: row.title,
    summary: row.summary,
    filePath: row.file_path,
    hasInline: row.inline_content != null,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    meta,
    createdAt: row.created_at,
  }
}

export async function createArtifact(input: CreateArtifactInput): Promise<AIArtifactRecord> {
  const db = getDb()
  const createdAt = input.createdAt ?? Date.now()
  const mime = input.mimeType ?? mimeForKind(input.kind)
  const byteSize = Buffer.byteLength(input.content ?? '', 'utf8')

  let filePath: string | null = null
  let inline: string | null = null

  if (input.existingFilePath) {
    filePath = input.existingFilePath
  } else if (byteSize > INLINE_LIMIT_BYTES) {
    const dir = await ensureArtifactDir()
    // Use a provisional filename now, then rename to include the row id.
    const stamp = new Date(createdAt).toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')
    const stem = (input.title || 'artifact')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'artifact'
    filePath = path.join(dir, `${stamp}-${stem}.${extForKind(input.kind)}`)
    await fs.writeFile(filePath, input.content, 'utf8')
  } else {
    inline = input.content
  }

  const stmt = db.prepare(`
    INSERT INTO ai_artifacts (
      thread_id, message_id, kind, title, summary,
      file_path, inline_content, mime_type, byte_size, meta_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    input.threadId,
    input.messageId ?? null,
    input.kind,
    input.title,
    input.summary ?? null,
    filePath,
    inline,
    mime,
    byteSize,
    JSON.stringify(input.meta ?? {}),
    createdAt,
  )

  const id = result.lastInsertRowid as number
  const row = db.prepare(`SELECT * FROM ai_artifacts WHERE id = ?`).get(id) as Parameters<typeof rowToRecord>[0]
  const record = rowToRecord(row)
  try {
    capture(ANALYTICS_EVENT.ARTIFACT_CREATED, {
      artifact_kind: record.kind,
      byte_size_bucket: byteSizeBucket(record.byteSize),
    })
  } catch {
    // analytics is best-effort; never block artifact creation on telemetry
  }
  return record
}

export function listArtifactsByThread(threadId: number): AIArtifactRecord[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT * FROM ai_artifacts WHERE thread_id = ? ORDER BY created_at DESC, id DESC`)
    .all(threadId) as Parameters<typeof rowToRecord>[0][]
  return rows.map(rowToRecord)
}

export function getArtifact(id: number): AIArtifactRecord | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT * FROM ai_artifacts WHERE id = ?`)
    .get(id) as Parameters<typeof rowToRecord>[0] | undefined
  return row ? rowToRecord(row) : null
}

export async function readArtifactContent(id: number): Promise<AIArtifactContent | null> {
  const record = getArtifact(id)
  if (!record) return null
  if (record.filePath) {
    try {
      const content = await fs.readFile(record.filePath, 'utf8')
      return { record, content }
    } catch (error) {
      console.warn('[artifacts] failed to read file', record.filePath, error)
      return { record, content: null }
    }
  }
  // Inline path — pull raw content from sqlite.
  const db = getDb()
  const row = db
    .prepare(`SELECT inline_content AS content FROM ai_artifacts WHERE id = ?`)
    .get(id) as { content: string | null } | undefined
  return { record, content: row?.content ?? null }
}

export async function deleteArtifact(id: number): Promise<void> {
  const record = getArtifact(id)
  if (!record) return
  if (record.filePath) {
    try { await fs.unlink(record.filePath) } catch { /* best-effort */ }
  }
  const db = getDb()
  db.prepare(`DELETE FROM ai_artifacts WHERE id = ?`).run(id)
}

export async function openArtifact(id: number): Promise<{ ok: boolean; error?: string }> {
  const content = await readArtifactContent(id)
  if (!content) return { ok: false, error: 'Artifact not found' }
  if (content.record.filePath) {
    const err = await shell.openPath(content.record.filePath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  }
  // Inline: materialize to a temp file and hand off to the OS.
  try {
    const tmpDir = path.join(os.tmpdir(), 'daylens-artifacts')
    await fs.mkdir(tmpDir, { recursive: true })
    const tmpPath = path.join(tmpDir, `${content.record.id}.${extForKind(content.record.kind)}`)
    await fs.writeFile(tmpPath, content.content ?? '', 'utf8')
    const err = await shell.openPath(tmpPath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function exportArtifact(
  id: number,
): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }> {
  const loaded = await readArtifactContent(id)
  if (!loaded) return { ok: false, error: 'Artifact not found' }
  const defaultName = `${(loaded.record.title || 'artifact').replace(/[^a-z0-9-_ ]+/gi, '').trim() || 'artifact'}.${extForKind(loaded.record.kind)}`
  const result = await dialog.showSaveDialog({ defaultPath: defaultName })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    if (loaded.record.filePath) {
      await fs.copyFile(loaded.record.filePath, result.filePath)
    } else {
      await fs.writeFile(result.filePath, loaded.content ?? '', 'utf8')
    }
    return { ok: true, path: result.filePath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ─── Thread helpers ──────────────────────────────────────────────────────────

export interface ListThreadsOptions {
  includeArchived?: boolean
  limit?: number
}

export interface ThreadRowLite {
  id: number
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number
  archived: boolean
  messageCount: number
  lastSnippet: string | null
}

export function listThreadsLite(options: ListThreadsOptions = {}): ThreadRowLite[] {
  const db = getDb()
  const where = options.includeArchived ? '' : 'WHERE t.archived = 0'
  const limit = Math.max(1, options.limit ?? 100)
  const rows = db
    .prepare(`
      SELECT
        t.id           AS id,
        t.title        AS title,
        t.created_at   AS createdAt,
        t.updated_at   AS updatedAt,
        t.last_message_at AS lastMessageAt,
        t.archived     AS archived,
        (SELECT COUNT(*) FROM ai_messages m WHERE m.thread_id = t.id) AS messageCount,
        (SELECT content FROM ai_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lastSnippet
      FROM ai_threads t
      ${where}
      ORDER BY t.last_message_at DESC, t.id DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: number
      title: string
      createdAt: number
      updatedAt: number
      lastMessageAt: number
      archived: number
      messageCount: number
      lastSnippet: string | null
    }>

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    archived: row.archived === 1,
    messageCount: row.messageCount,
    lastSnippet: row.lastSnippet ? row.lastSnippet.slice(0, 160) : null,
  }))
}

function emitThreadEvent(event: AnalyticsEventName, threadId: number): void {
  try {
    capture(event, { thread_action: event })
  } catch { /* analytics best-effort */ }
  void threadId
}

export function createThread(title?: string | null): ThreadRowLite {
  const db = getDb()
  const now = Date.now()
  const finalTitle = normalizeThreadTitle(title, DEFAULT_THREAD_TITLE)
  const result = db
    .prepare(`
      INSERT INTO ai_threads (title, created_at, updated_at, last_message_at, archived, metadata_json)
      VALUES (?, ?, ?, ?, 0, '{}')
    `)
    .run(finalTitle, now, now, now)
  const id = result.lastInsertRowid as number
  emitThreadEvent(ANALYTICS_EVENT.AI_THREAD_CREATED, id)
  return {
    id,
    title: finalTitle,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    archived: false,
    messageCount: 0,
    lastSnippet: null,
  }
}

export function renameThread(threadId: number, title: string): void {
  const db = getDb()
  const nextTitle = normalizeThreadTitle(title, 'Untitled chat')
  db.prepare(`UPDATE ai_threads SET title = ?, updated_at = ? WHERE id = ?`).run(nextTitle, Date.now(), threadId)
}

export function archiveThread(threadId: number, archived: boolean): void {
  const db = getDb()
  db.prepare(`UPDATE ai_threads SET archived = ?, updated_at = ? WHERE id = ?`).run(archived ? 1 : 0, Date.now(), threadId)
  emitThreadEvent(ANALYTICS_EVENT.AI_THREAD_ARCHIVED, threadId)
}

export function deleteThread(threadId: number): void {
  const db = getDb()
  // Also remove the ai_messages rows referencing this thread (no FK, do it explicitly).
  db.prepare(`DELETE FROM ai_messages WHERE thread_id = ?`).run(threadId)
  // Artifacts cascade via FK on delete.
  db.prepare(`DELETE FROM ai_threads WHERE id = ?`).run(threadId)
  emitThreadEvent(ANALYTICS_EVENT.AI_THREAD_DELETED, threadId)
}

export function touchThreadLastMessage(db: Database.Database, threadId: number, at: number): void {
  db.prepare(`UPDATE ai_threads SET last_message_at = ?, updated_at = ? WHERE id = ?`).run(at, at, threadId)
}

export function getThread(threadId: number): ThreadRowLite | null {
  const rows = listThreadsLite({ includeArchived: true, limit: 1000 })
  return rows.find((row) => row.id === threadId) ?? null
}

export function ensureDefaultThread(conversationId: number): number {
  const db = getDb()
  const existing = db
    .prepare(`
      SELECT thread_id AS threadId FROM ai_messages
      WHERE conversation_id = ? AND thread_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `)
    .get(conversationId) as { threadId: number | null } | undefined
  if (existing?.threadId) return existing.threadId
  const fresh = createThread(DEFAULT_THREAD_TITLE)
  return fresh.id
}
