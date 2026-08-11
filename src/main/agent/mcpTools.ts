// MCP client for the chat agent: connects to the MCP servers the
// user has configured and exposes their tools to the loop. MCP is the one
// interface for "whatever's installed on this laptop" — never a parallel
// plugin system. Config lives in settings (`mcpServers`), same shape as
// Claude Desktop's { command, args, env } entries. Servers that fail to start
// are skipped with a warning; a broken server never breaks chat.
import { createMCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import type { ToolSet } from 'ai'
import { sanitizeToolResult } from '@shared/aiSanitize'
import { filterTrackingExcludedEvidence } from '@shared/evidencePrivacy'
import { trackingControlsStateFromSettings } from '@shared/trackingControls'
import { getSettings } from '../services/settings'
import { minimalChildEnv } from '../lib/childEnv'
import { isRealDayHarness } from '../lib/realDayHarness'

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** When false, the server is kept in settings but not connected. Absent
   *  means enabled, so existing stored configs without the field keep working. */
  enabled?: boolean
}

export type McpServerStatus =
  | { name: string; status: 'connected' }
  | { name: string; status: 'skipped'; reason: string }
  | { name: string; status: 'failed'; reason: string }

export interface McpToolPool {
  tools: ToolSet
  close: () => Promise<void>
  serverStatuses: McpServerStatus[]
}

const CONNECT_TIMEOUT_MS = 8_000

// Anything a server genuinely needs beyond launch essentials is set
// explicitly in its settings entry's `env`.
export function mcpChildEnv(configured?: Record<string, string>): Record<string, string> {
  return minimalChildEnv(configured)
}

/** Every MCP tool result crosses the SAME two privacy boundaries as every
 *  built-in tool result (see contextTools.ts's guarded()): the
 *  tracking-exclusion filter (drops excluded apps/sites) and the secret
 *  sanitizer. An external server's output is still content headed for the
 *  model — it never enters the loop raw. */
export function guardMcpToolResult(raw: unknown): unknown {
  const controls = trackingControlsStateFromSettings(getSettings())
  return sanitizeToolResult(filterTrackingExcludedEvidence(raw, controls))
}

/** Wraps each MCP tool so its execute() result is guarded before it returns
 *  toward the model. Tools without an execute (unlikely for MCP) pass
 *  through untouched. Exported for direct testing. */
export function wrapMcpToolsWithGuards(tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {}
  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = toolDef.execute
    if (typeof execute !== 'function') {
      wrapped[name] = toolDef
      continue
    }
    wrapped[name] = {
      ...toolDef,
      execute: async (input: unknown, options: unknown) =>
        guardMcpToolResult(await (execute as (input: unknown, options: unknown) => Promise<unknown>)(input, options)),
    } as ToolSet[string]
  }
  return wrapped
}

/** Produces a unique tool key from a server name and tool name. Normalizes
 *  non-alphanumeric characters to `_`, truncates to 64 chars, and if the
 *  result collides with an already-used key, appends a numeric suffix so two
 *  tools from different servers never silently replace each other.
 *  Pure so the collision behavior is testable without spawning subprocesses. */
export function namespaceMcpToolName(
  serverName: string,
  toolName: string,
  used: Set<string>,
): string {
  const base = `mcp_${serverName}_${toolName}`
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .slice(0, 64)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let suffix = 2
  let candidate: string
  do {
    candidate = `${base}_${suffix}`.slice(0, 64)
    suffix++
  } while (used.has(candidate))
  used.add(candidate)
  return candidate
}

/** Splits configured servers into those to attempt and those to skip. Pure so
 *  the decision is testable without spawning subprocesses. A server without
 *  `enabled` is treated as enabled — backward compatible with configs stored
 *  before the field existed. */
export function selectConnectableMcpServers(
  servers: McpServerConfig[],
): { connectable: McpServerConfig[]; skipped: McpServerStatus[] } {
  const connectable: McpServerConfig[] = []
  const skipped: McpServerStatus[] = []
  for (const server of servers) {
    if (server.enabled === false) {
      skipped.push({ name: server.name, status: 'skipped', reason: 'disabled in settings' })
    } else {
      connectable.push(server)
    }
  }
  return { connectable, skipped }
}

/** Races an async operation against a timeout. On timeout or failure, calls
 *  `cleanup` to release resources the operation allocated (e.g. a spawned
 *  subprocess), and swallows the pending promise's eventual rejection so it
 *  does not surface as an unhandled rejection. On success, returns the result
 *  and the caller owns the resource — cleanup is not called. */
export async function raceConnectWithCleanup<T>(
  connect: () => Promise<T>,
  timeoutMs: number,
  cleanup: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('connect timeout')), timeoutMs)
  })
  const promise = connect()
  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    promise.catch(() => {})
    await cleanup().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer!)
  }
}

export async function connectMcpTools(servers: McpServerConfig[]): Promise<McpToolPool> {
  if (isRealDayHarness()) {
    return { tools: {}, close: async () => undefined, serverStatuses: [] }
  }
  const { connectable, skipped } = selectConnectableMcpServers(servers)
  const clients: Array<{ close: () => Promise<void> }> = []
  const tools: ToolSet = {}
  const statuses: McpServerStatus[] = [...skipped]
  const usedNames = new Set<string>()

  await Promise.all(connectable.map(async (server) => {
    const transport = new StdioMCPTransport({
      command: server.command,
      args: server.args ?? [],
      env: mcpChildEnv(server.env),
    })
    try {
      const client = await raceConnectWithCleanup(
        () => createMCPClient({ transport }),
        CONNECT_TIMEOUT_MS,
        () => transport.close(),
      )
      clients.push(client)
      const serverTools = wrapMcpToolsWithGuards(await client.tools())
      for (const [name, toolDef] of Object.entries(serverTools)) {
        const key = namespaceMcpToolName(server.name, name, usedNames)
        const originalDescription = (toolDef as { description?: string }).description ?? ''
        tools[key] = {
          ...toolDef,
          description: `[MCP:${server.name}] ${originalDescription}`.trim(),
        } as ToolSet[string]
      }
      statuses.push({ name: server.name, status: 'connected' })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[agent:mcp] skipping server "${server.name}": ${reason}`)
      statuses.push({ name: server.name, status: 'failed', reason })
    }
  }))

  return {
    tools,
    serverStatuses: statuses,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()))
    },
  }
}
