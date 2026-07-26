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

export function statusForTool(tool: string, input: unknown): string {
  const params = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'get_moment': return `Looking at ${params.date ?? ''} ${params.time ?? ''}`.trim()
    case 'get_time_chunks': return `Building ${params.incrementMinutes ?? ''}-minute intervals`.trim()
    case 'get_day_overview': return `Reading ${params.date ?? 'the day'}`
    case 'search_history': return `Searching for "${params.query ?? ''}"`
    case 'list_page_visits': return 'Going through your page visits'
    case 'get_app_usage': return `Checking time in ${params.appName ?? 'that app'}`
    case 'get_week_summary': return 'Reading the week'
    case 'discover_repositories': return 'Finding active repositories'
    case 'search_files': return `Searching files for "${params.query ?? ''}"`
    case 'git': return 'Reading git history'
    case 'read_file': return 'Reading a file'
    case 'list_dir': return 'Listing a folder'
    case 'create_artifact': return 'Building your file'
    case 'ask_user': return 'Asking you'
    case 'propose_memory': return 'Asking to remember'
    case 'propose_correction': return 'Previewing a correction'
    case 'undo_correction': return 'Undoing a correction'
    case 'forget_memory': return 'Asking to forget a memory'
    default: return tool.startsWith('mcp_') ? 'Checking a connected source' : 'Working'
  }
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
const NON_SOURCE_TOOLS = new Set(['ask_user', 'create_artifact', 'propose_memory', 'forget_memory', 'propose_correction', 'undo_correction'])

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

/** Human duration for the collapsed trail line: "12s", "1m 42s", "1h 4m".
 *  Never empty and never sub-second noise — anything under a second reads
 *  as one second, since the turn plainly did happen. */
export function formatWorkedDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
}

/** The ONE collapsed line a settled answer leads with (DEV-244, the Codex
 *  pattern): "Worked for 1m 42s" when the turn recorded its duration, an
 *  honest step-count fallback for answers persisted before durations existed,
 *  then the source summary. Empty means the turn has nothing to disclose. */
export function trailHeadline(input: {
  durationMs?: number | null
  stepCount: number
  summaryLabel: string
}): string {
  if (input.durationMs != null && input.durationMs > 0) {
    return `Worked for ${formatWorkedDuration(input.durationMs)}`
  }
  if (input.stepCount > 0) {
    return `Worked through ${input.stepCount} step${input.stepCount === 1 ? '' : 's'}`
  }
  return input.summaryLabel
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
