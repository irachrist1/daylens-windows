// Daylens MCP server — stdio transport, wraps aiTools.ts executors.
// Spawned by Claude Desktop (or another MCP client) via the config snippet
// shown in Daylens Settings.
//
// Env: DAYLENS_DB_PATH (absolute path to daylens.sqlite) overrides discovery;
// without it the server resolves the same userData directory the app uses.
// Set env ELECTRON_RUN_AS_NODE=1 when launching via the Daylens binary.
import Database from 'better-sqlite3'
import { Server } from '@modelcontextprotocol/sdk/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import type { TrackingControlsState } from '../../../src/shared/trackingControls'
import { mcpToolManifest } from './tools'
import { callDaylensReadTool } from './dispatch'
import { resolveDefaultDbPath } from './dbPath'

const dbPath = process.env.DAYLENS_DB_PATH ?? resolveDefaultDbPath()

if (!fs.existsSync(dbPath)) {
  console.error(`[daylens-mcp] Database not found at ${dbPath}. Set DAYLENS_DB_PATH to the correct location.`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
try { db.pragma('journal_mode = WAL') } catch { /* read-only connection can't change journal mode */ }
db.pragma('busy_timeout = 5000')

// The subprocess can't reach the Electron settings store, so the current
// exclusion set is handed in by env (see mcpServer.ts). Without this the MCP
// boundary would have no exclusion list and excluded apps/sites could leave the
// machine through an MCP client. System noise is stripped regardless.
const trackingControlsEnabled = process.env.DAYLENS_TRACKING_CONTROLS_ENABLED === '1'

// Fail closed: when tracking controls are ON, a malformed exclusion env would
// otherwise silently become [] and the server would serve unfiltered excluded
// data. Refuse to start instead — no data is safer than leaked data. When
// controls are OFF there is nothing to enforce, so a bad/empty value is [].
function envList(name: string): string[] {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') {
    if (trackingControlsEnabled) throw new Error(`${name} missing while tracking controls enabled`)
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (trackingControlsEnabled) throw new Error(`${name} is not valid JSON while tracking controls enabled`)
    return []
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    if (trackingControlsEnabled) throw new Error(`${name} must be a JSON string array while tracking controls enabled`)
    return []
  }
  return parsed as string[]
}

const trackingControls: TrackingControlsState = {
  enabled: trackingControlsEnabled,
  paused: false,
  excludedApps: envList('DAYLENS_TRACKING_EXCLUDED_APPS'),
  excludedSites: envList('DAYLENS_TRACKING_EXCLUDED_SITES'),
  skipIncognito: true,
}

process.on('exit', () => { try { db.close() } catch { /* ignore */ } })
process.on('SIGTERM', () => { db.close(); process.exit(0) })
process.on('SIGINT', () => { db.close(); process.exit(0) })

const server = new Server(
  { name: 'daylens', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: mcpToolManifest().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    const result = await callDaylensReadTool(
      name,
      (args ?? {}) as Record<string, unknown>,
      db,
      trackingControls,
    )
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    }
  }
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
