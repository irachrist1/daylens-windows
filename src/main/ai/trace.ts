// Per-call trace recorder for AI requests.
//
// When DAYLENS_AI_TRACE_DIR is set, sendMessage opens a recorder, the tool
// loops append events (turn boundaries, tool calls and their full results,
// router decisions, token usage), and the recorder writes a single JSON file
// per call into that directory. The behavioural harness sets the env var
// before running scenarios so every scenario gets its own trace on disk.
//
// In production the env var is unset and every helper is a no-op.

import fs from 'node:fs'
import path from 'node:path'

interface TraceTurnEvent {
  kind: 'turn'
  role: 'assistant'
  text: string
  toolUses: Array<{ id: string; name: string; input: unknown }>
  stopReason?: string | null
  usage?: TraceUsage | null
}

interface TraceToolResultEvent {
  kind: 'tool_result'
  name: string
  input: unknown
  output: unknown
  toolUseId?: string
  durationMs: number
  truncated: boolean
}

interface TraceRouterEvent {
  kind: 'router'
  matched: boolean
  reason: string
  routedKind?: string
  category?: string | null
}

// Emitted when the deterministic router produces an answer. Lets us see the
// structured data the prose-pass will rewrite — without this, scenarios that
// take the router path appear as empty traces.
interface TraceRouterDecisionEvent {
  kind: 'router_decision'
  routedKind: string
  structuredAnswer: string
  resolvedDate?: string | null
  hasTimeWindow?: boolean
}

// Emitted by routerProsePass. `input` is the structured data; `output` is
// what we returned to the user. `fallback` is set when the rewrite was
// rejected (timestamp drift, empty, exception) and the structured data was
// returned verbatim instead.
interface TraceProsePassEvent {
  kind: 'prose_pass'
  input: string
  output: string
  fallback?: 'timestamp_mismatch' | 'empty' | 'error' | 'timeout'
}

// Emitted by the planner: which resolvers it chose, and
// whether that came from a deterministic shortcut, the constrained model call,
// or the nearest-answerable fallback.
interface TracePlannerDecisionEvent {
  kind: 'planner_decision'
  source: 'shortcut' | 'model' | 'fallback'
  queries: unknown[]
}

// Emitted by the phrase pass. `input` is the resolved facts
// block; `output` is the answer handed to the user.
interface TracePhrasePassEvent {
  kind: 'phrase_pass'
  input: string
  output: string
}

interface TraceFinalEvent {
  kind: 'final'
  text: string
  source: string
}

interface TraceCitationEvent {
  kind: 'citation_check'
  ok: boolean
  missing: string[]
  checked: string[]
  retry?: boolean
}

interface TraceErrorEvent {
  kind: 'error'
  message: string
  phase: string
}

// The rendered context packet the agent turn answered from — recorded so the
// eval judge can treat packet statements as authoritative evidence instead of
// grading packet-derived facts as fabrication.
interface TraceContextPacketEvent {
  kind: 'context_packet'
  rendered: string
  itemCount: number
}

export type TraceEvent =
  | TraceTurnEvent
  | TraceToolResultEvent
  | TraceContextPacketEvent
  | TraceRouterEvent
  | TraceRouterDecisionEvent
  | TraceProsePassEvent
  | TracePlannerDecisionEvent
  | TracePhrasePassEvent
  | TraceFinalEvent
  | TraceCitationEvent
  | TraceErrorEvent

interface TraceUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface TraceRecord {
  traceId: string
  scenarioId?: string | null
  startedAt: string
  finishedAt?: string
  provider?: string
  modelId?: string
  systemPrompt?: string
  userMessage?: string
  prior?: Array<{ role: string; content: string }>
  events: TraceEvent[]
  totals: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    toolCallCount: number
    turnCount: number
    totalLatencyMs: number
  }
  phaseLatencyMs: Record<string, number>
  finalText?: string
  error?: string
}

let currentRecorder: TraceRecorder | null = null

export class TraceRecorder {
  readonly trace: TraceRecord
  private readonly outputPath: string
  private readonly start: number

  constructor(traceId: string, outputPath: string, scenarioId?: string | null) {
    this.outputPath = outputPath
    this.start = Date.now()
    this.trace = {
      traceId,
      scenarioId: scenarioId ?? null,
      startedAt: new Date().toISOString(),
      events: [],
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCallCount: 0,
        turnCount: 0,
        totalLatencyMs: 0,
      },
      phaseLatencyMs: {},
    }
  }

  setMeta(meta: Partial<Pick<TraceRecord, 'provider' | 'modelId' | 'systemPrompt' | 'userMessage' | 'prior'>>): void {
    Object.assign(this.trace, meta)
  }

  addEvent(event: TraceEvent): void {
    this.trace.events.push(event)
    if (event.kind === 'turn') {
      this.trace.totals.turnCount += 1
      if (event.usage) {
        this.trace.totals.inputTokens += event.usage.inputTokens ?? 0
        this.trace.totals.outputTokens += event.usage.outputTokens ?? 0
        this.trace.totals.cacheReadTokens += event.usage.cacheReadTokens ?? 0
        this.trace.totals.cacheWriteTokens += event.usage.cacheWriteTokens ?? 0
      }
    } else if (event.kind === 'tool_result') {
      this.trace.totals.toolCallCount += 1
    }
  }

  recordPhase(name: string, ms: number): void {
    this.trace.phaseLatencyMs[name] = (this.trace.phaseLatencyMs[name] ?? 0) + ms
  }

  finish(finalText: string | undefined, error?: string): void {
    this.trace.finishedAt = new Date().toISOString()
    this.trace.totals.totalLatencyMs = Date.now() - this.start
    if (finalText !== undefined) this.trace.finalText = finalText
    if (error) this.trace.error = error
    try {
      fs.mkdirSync(path.dirname(this.outputPath), { recursive: true })
      fs.writeFileSync(this.outputPath, JSON.stringify(this.trace, null, 2))
    } catch {
      // Tracing must never crash the request.
    }
  }
}

export function getCurrentTrace(): TraceRecorder | null {
  return currentRecorder
}

export function setCurrentTrace(recorder: TraceRecorder | null): void {
  currentRecorder = recorder
}

export function maybeStartTrace(opts: { scenarioId?: string | null; tag?: string } = {}): TraceRecorder | null {
  const dir = process.env.DAYLENS_AI_TRACE_DIR
  if (!dir) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeTag = (opts.scenarioId ?? opts.tag ?? 'trace').replace(/[^A-Za-z0-9_-]+/g, '_')
  const traceId = `${stamp}-${safeTag}`
  const outputPath = path.join(dir, `${safeTag}.json`)
  const recorder = new TraceRecorder(traceId, outputPath, opts.scenarioId ?? null)
  setCurrentTrace(recorder)
  return recorder
}
