// The live activity trail behind AI answers: the human one-liners a chat turn
// shows while the agent works, and the quiet summary an answer settles into.
//
// Shared on purpose. The main-process agent loop labels each tool call as it
// runs; the renderer reconstructs the same trail for persisted answers from
// their tool trace; and the summary's counts must agree with the packet
// inspector's tools-consulted list — one aggregation serves both.
//
// Labels are built ONLY from the tool name and a small whitelist of
// human-facing parameters. Raw tool inputs, outputs, file paths, and prompts
// must never reach a label.
import type {
  AIAgentStep,
  AIMessageCitation,
  AIMessageFileDisclosure,
  ContextPacketToolConsulted,
} from './types'

export interface AgentToolTraceEntryLike {
  tool: string
  input: unknown
  output: string
  failed?: boolean
}

/** capture_screen's `reason` is the ONE tool argument shown verbatim — its
 *  schema requires the model to explain the look, and showing it is the
 *  consent story. Bound it so a runaway reason cannot flood a one-liner. */
const SCREEN_REASON_MAX = 120

/** Every string parameter interpolated into a label is bounded: a runaway or
 *  adversarial tool input (a 2KB "entityName", an object where a string was
 *  expected) can never flood a one-liner or leak raw JSON into the trail. */
const PARAM_MAX = 80
function boundedParam(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  return text.length > PARAM_MAX ? `${text.slice(0, PARAM_MAX - 1)}…` : text
}

export function statusForTool(tool: string, input: unknown): string {
  const params = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'get_moment': return `Looking at ${boundedParam(params.date)} ${boundedParam(params.time)}`.trim()
    case 'get_time_chunks': return `Building ${boundedParam(params.incrementMinutes)}-minute intervals`.trim()
    case 'get_day_overview': return `Reading ${boundedParam(params.date) || 'the day'}`
    case 'search_history': return `Searching for "${boundedParam(params.query)}"`
    case 'list_page_visits': return 'Going through your page visits'
    case 'get_app_usage': return `Checking time in ${boundedParam(params.appName) || 'that app'}`
    case 'get_week_summary': return 'Reading the week'
    case 'get_calendar_events': return `Checking your calendar for ${boundedParam(params.date) || 'the day'}`
    case 'get_git_activity': return `Checking your commits for ${boundedParam(params.date) || 'the day'}`
    case 'read_meeting_notes': return params.meetingId ? 'Reading meeting notes' : 'Looking through your meetings'
    case 'get_attribution': return `Checking work for ${boundedParam(params.entityName) || 'that name'}`
    case 'list_clients': return 'Reading your client roster'
    case 'discover_repositories': return 'Finding active repositories'
    case 'search_files': return `Searching files for "${boundedParam(params.query)}"`
    case 'git': return 'Reading git history'
    case 'read_file': return 'Reading a file'
    case 'list_dir': return 'Listing a folder'
    case 'create_artifact': return 'Building your file'
    case 'export_week_excel': return 'Building your weekly Excel export'
    // reason is the ONE human-facing parameter these two carry — shown
    // verbatim (bounded) because the user must always see WHY the agent
    // looked at the screen or ran something.
    case 'capture_screen': {
      const reason = boundedReason(params.reason)
      return reason ? `Looking at your screen — ${reason}` : 'Looking at your screen'
    }
    case 'run_command': {
      const command = typeof params.command === 'string' && /^[\w.-]+$/.test(params.command) ? params.command : 'a command'
      const reason = boundedReason(params.reason)
      return reason ? `Running ${command} — ${reason}` : `Running ${command}`
    }
    case 'ask_user': return 'Asking you'
    case 'propose_memory': return 'Asking to remember'
    case 'propose_correction': return 'Previewing a correction'
    case 'undo_correction': return 'Undoing a correction'
    case 'forget_memory': return 'Asking to forget a memory'
    default: return defaultToolLabel(tool)
  }
}

function boundedReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!reason) return ''
  return reason.length > SCREEN_REASON_MAX ? `${reason.slice(0, SCREEN_REASON_MAX - 1)}…` : reason
}

/** Unknown tools still get a quiet human line — the tool NAME is the only
 *  thing used; inputs never reach a default label, so no raw JSON can leak. */
function defaultToolLabel(tool: string): string {
  if (tool.startsWith('mcp_')) return 'Checking a connected source'
  const words = tool.replace(/[_-]+/g, ' ').trim()
  return words ? `Running ${words}` : 'Working'
}

/** Settle a step in place by id (active → done/failed), keeping its position
 *  and original start time; a new id appends. */
export function upsertStep(steps: readonly AIAgentStep[], step: AIAgentStep): AIAgentStep[] {
  const index = steps.findIndex((existing) => existing.id === step.id)
  if (index < 0) return [...steps, step]
  const next = [...steps]
  next[index] = { ...step, startedAt: steps[index].startedAt }
  return next
}

/**
 * The rows the live trail shows for one in-flight turn. Before any structured
 * step arrives, the plain status line (if any) is the single active row.
 * Once tools have run and none is still active, the model is composing the
 * answer — say so instead of leaving the trail with no in-progress row.
 */
export function liveTrailRows(steps: readonly AIAgentStep[], status: string): AIAgentStep[] {
  if (steps.length === 0) {
    return status ? [{ id: 'status', label: status, state: 'active', startedAt: 0 }] : []
  }
  if (steps.some((step) => step.state === 'active')) return [...steps]
  return [...steps, { id: 'composing', label: 'Putting the answer together', state: 'active', startedAt: 0 }]
}

export interface CollapsedTrail {
  visible: AIAgentStep[]
  hiddenCount: number
}

/** Default number of rows a collapsed trail shows before folding the rest
 *  behind an "N earlier steps" affordance. */
export const TRAIL_COLLAPSE_LIMIT = 4

/** Many steps must not flood the chat: keep the newest `limit` rows (the
 *  active one is always last) and report how many earlier rows are folded. */
export function collapseTrail(steps: readonly AIAgentStep[], limit = TRAIL_COLLAPSE_LIMIT): CollapsedTrail {
  if (steps.length <= limit) return { visible: [...steps], hiddenCount: 0 }
  return { visible: steps.slice(steps.length - limit), hiddenCount: steps.length - limit }
}

/** Reconstruct a static trail from a persisted tool trace, so answers from
 *  history show their steps with the same labels the live trail used. */
export function stepsFromToolTrace(trace: readonly AgentToolTraceEntryLike[] | null | undefined): AIAgentStep[] {
  if (!Array.isArray(trace)) return []
  return trace
    .filter((entry) => typeof entry?.tool === 'string')
    .map((entry, index) => ({
      id: `trace:${index}`,
      label: statusForTool(entry.tool, entry.input),
      state: entry.failed ? ('failed' as const) : ('done' as const),
      startedAt: 0,
    }))
}

/** Tools called during a turn — names, call counts, first-use order, MCP
 *  identified. This is the ONE aggregation both the packet inspector's
 *  "tools consulted" list and the answer summary derive from, so their counts
 *  cannot disagree. Null when no trace exists. */
export function aggregateToolsConsulted(
  trace: readonly AgentToolTraceEntryLike[] | null | undefined,
): ContextPacketToolConsulted[] | null {
  if (!Array.isArray(trace)) return null
  const byTool = new Map<string, ContextPacketToolConsulted>()
  for (const entry of trace) {
    const tool = typeof entry?.tool === 'string' ? entry.tool : null
    if (!tool) continue
    const existing = byTool.get(tool)
    if (existing) existing.calls += 1
    else byTool.set(tool, { tool, calls: 1, source: tool.startsWith('mcp_') ? 'mcp' : 'daylens' })
  }
  return [...byTool.values()]
}

/** Tools that interact with the person rather than fetch data — they are
 *  listed among tools consulted but do not count as sources. */
const NON_SOURCE_TOOLS = new Set(['ask_user', 'create_artifact', 'export_week_excel', 'propose_memory', 'forget_memory', 'propose_correction', 'undo_correction'])

export interface AgentTurnSummary {
  /** Identical to the inspector's tools-consulted list for this turn. */
  toolsConsulted: ContextPacketToolConsulted[]
  /** Distinct data sources consulted (tools minus interaction tools). */
  sourceCount: number
  /** Distinct files whose contents were disclosed this turn. */
  fileCount: number
  citationCount: number
  /** Quiet settle line, e.g. "Used 4 sources · 1 file". Empty when the turn
   *  touched nothing worth summarizing. */
  label: string
}

export function summarizeAgentTurn(agent: {
  toolTrace?: AgentToolTraceEntryLike[]
  fileDisclosures?: Array<Pick<AIMessageFileDisclosure, 'path'>>
  citations?: AIMessageCitation[]
} | null | undefined): AgentTurnSummary | null {
  if (!agent) return null
  const toolsConsulted = aggregateToolsConsulted(agent.toolTrace) ?? []
  const sourceCount = toolsConsulted.filter((consulted) => !NON_SOURCE_TOOLS.has(consulted.tool)).length
  const fileCount = new Set((agent.fileDisclosures ?? []).map((disclosure) => disclosure.path)).size
  const citationCount = agent.citations?.length ?? 0
  const parts: string[] = []
  if (sourceCount > 0) parts.push(`${sourceCount} source${sourceCount === 1 ? '' : 's'}`)
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`)
  const label = parts.length > 0
    ? `Used ${parts.join(' · ')}`
    : citationCount > 0
      ? 'Answered from your day record'
      : ''
  return { toolsConsulted, sourceCount, fileCount, citationCount, label }
}
