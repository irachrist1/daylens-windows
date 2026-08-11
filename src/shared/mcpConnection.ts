// What the MCP settings section is allowed to show, decided in one place.
//
// The section used to render its connection snippet behind
// `enabled && config && (…)`, so an install where the server cannot run showed an
// enabled toggle above an empty panel: no snippet, no explanation, nothing to act
// on. Configuration that is not ready must never reach the copy control, and a
// person must be told which of the three not-ready cases they are in.

/** The launch configuration an MCP client needs, as the main process resolves it.
 *  Structural on purpose: the renderer receives it over IPC and must not import
 *  main-process modules. */
export interface McpClientConfig {
  command: string
  args: string[]
  env: Record<string, string>
  isPackaged: boolean
  dbPath: string
  running: boolean
}

export type McpConnectionState =
  | { kind: 'off' }
  | { kind: 'checking' }
  | { kind: 'ready'; config: McpClientConfig }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }

export interface McpConnectionInput {
  enabled: boolean
  /** Where the last `IPC.MCP.GET_CONFIG` call got to. */
  fetch: 'idle' | 'loading' | 'settled'
  /** The resolved configuration, or null when the main process could not build
   *  one — a packaged install missing its server bundle, or a checkout missing
   *  the loader or entry point. */
  config: McpClientConfig | null
  /** The IPC call itself failed. Distinct from a null configuration: one means
   *  "this install cannot run the server", the other means "Daylens could not
   *  find out". */
  error: string | null
}

export const MCP_UNAVAILABLE_REASON =
  'Daylens could not prepare a connection for this install: the MCP server files that ship with the app '
  + 'are missing, so there is no configuration to give your AI app. Reinstalling Daylens restores them.'

export function describeMcpConnection(input: McpConnectionInput): McpConnectionState {
  if (!input.enabled) return { kind: 'off' }
  if (input.error) return { kind: 'failed', reason: input.error }
  if (input.fetch !== 'settled') return { kind: 'checking' }
  if (!input.config) return { kind: 'unavailable', reason: MCP_UNAVAILABLE_REASON }
  return { kind: 'ready', config: input.config }
}

/** Copying is offered for a configuration that will actually work, and for
 *  nothing else. */
export function canCopyMcpConfig(state: McpConnectionState): boolean {
  return state.kind === 'ready'
}
