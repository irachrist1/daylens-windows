// Sidecar log for external MCP tool calls. The Daylens MCP server is
// stdio-spawned by clients and has no live IPC into the app, so each call is
// appended as one JSON line next to the database the server opened.
//
// Entries stay small: tool name, timestamp, sanitized arguments, and
// success/outcome. Full tool results are never written.

import fs from 'node:fs'
import path from 'node:path'
import type { McpActivityEntry } from './types'
import { sanitizeForRender } from './aiSanitize'

export const MCP_ACTIVITY_FILENAME = 'mcp-activity.jsonl'
export type { McpActivityEntry }

const SECRET_KEY = /(?:^|[_-])(?:token|secret|password|passwd|authorization|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)$/i

export function mcpActivityLogPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), MCP_ACTIVITY_FILENAME)
}

function isSecretKey(key: string): boolean {
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SECRET_KEY.test(key) || SECRET_KEY.test(snake)
}

export function stripSecrets(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') return sanitizeForRender(value).text
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripSecrets)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? '[redacted]' : stripSecrets(child)
  }
  return out
}

export function recordMcpActivity(
  logPath: string,
  entry: {
    tool: string
    arguments?: unknown
    ok: boolean
    error?: string
    timestamp?: string
  },
): void {
  const recorded: McpActivityEntry = {
    tool: entry.tool,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    arguments: stripSecrets(entry.arguments ?? {}),
    ok: entry.ok,
  }
  if (!entry.ok) recorded.error = entry.error ?? 'Tool error'
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify(recorded)}\n`)
}

export function parseMcpActivityLine(line: string): McpActivityEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as Record<string, unknown>
  if (typeof row.tool !== 'string' || row.tool.length === 0) return null
  const entry: McpActivityEntry = {
    tool: row.tool,
    timestamp: typeof row.timestamp === 'string' ? row.timestamp : '',
    arguments: 'arguments' in row ? row.arguments : {},
    ok: row.ok !== false,
  }
  if (typeof row.error === 'string') entry.error = row.error
  return entry
}

export function readMcpActivity(logPath: string): McpActivityEntry[] {
  let raw: string
  try {
    raw = fs.readFileSync(logPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw error
  }

  const entries: McpActivityEntry[] = []
  for (const line of raw.split('\n')) {
    const entry = parseMcpActivityLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}
