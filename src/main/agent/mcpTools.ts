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
}

export interface McpToolPool {
  tools: ToolSet
  close: () => Promise<void>
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

export async function connectMcpTools(servers: McpServerConfig[]): Promise<McpToolPool> {
  if (isRealDayHarness()) {
    return { tools: {}, close: async () => undefined }
  }
  const clients: Array<{ close: () => Promise<void> }> = []
  const tools: ToolSet = {}

  await Promise.all(servers.map(async (server) => {
    try {
      const client = await Promise.race([
        createMCPClient({
          transport: new StdioMCPTransport({
            command: server.command,
            args: server.args ?? [],
            env: mcpChildEnv(server.env),
          }),
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
        }),
      ])
      clients.push(client)
      const serverTools = wrapMcpToolsWithGuards(await client.tools())
      for (const [name, toolDef] of Object.entries(serverTools)) {
        // Namespace to avoid collisions between servers and with built-ins.
        tools[`mcp_${server.name}_${name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64)] = toolDef
      }
    } catch (error) {
      console.warn(`[agent:mcp] skipping server "${server.name}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }))

  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()))
    },
  }
}
