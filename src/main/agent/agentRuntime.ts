import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type { ContextPacket } from '../services/contextPacket'
import {
  withChatProviderExecution,
  type ChatExecutionPolicy,
  type ChatSystemPrompt,
} from './executionPolicy'

export type AgentCapability =
  | 'text'
  | 'structured_output'
  | 'tools'
  | 'permission_requests'
  | 'person_input_requests'
  | 'pause_resume'

export type AgentRuntimeCapabilities = Readonly<Record<AgentCapability, boolean>>

export interface AgentRunMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
}

export type AgentRunOutputRequirement =
  | { kind: 'text' }
  | { kind: 'structured'; name?: string; schema: unknown }

export interface AgentRunLimits {
  maxSteps?: number
  maxOutputTokens?: number
  timeoutMs?: number
  maxRetries?: number
}

export type AgentToolInteraction = 'tool' | 'permission' | 'person_input'

export interface AgentRunRequest<TTools = unknown> {
  runId: string
  contextPacket: ContextPacket
  tools: TTools
  toolInteractions?: Readonly<Record<string, AgentToolInteraction>>
  output: AgentRunOutputRequirement
  limits: AgentRunLimits
  /** Stable and dynamic system text, or a precomposed prompt. Prompt-cache
   *  policy may turn this into provider-native cache markers without changing
   *  the Context packet or answer contract. */
  system?: ChatSystemPrompt
  /** When set, every provider HTTP call for this run waits in the shared
   *  execution-policy rate-limit choke point before it proceeds. */
  execution?: ChatExecutionPolicy
  messages: ReadonlyArray<AgentRunMessage>
  signal?: AbortSignal
  requiredCapabilities?: ReadonlyArray<AgentCapability>
}

export interface AgentRunUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface AgentRunFailure {
  code: string
  message: string
  retryable: boolean
}

interface AgentRunEventBase {
  runId: string
  sequence: number
}

export type AgentRunEvent = AgentRunEventBase & (
  | { type: 'text'; text: string }
  | { type: 'structured_output'; value: unknown }
  | {
      type: 'tool_request'
      toolCallId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'tool_result'
      toolCallId: string
      toolName: string
      output: unknown
      failed: boolean
    }
  | {
      type: 'permission_request'
      requestId: string
      toolCallId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'person_input_request'
      requestId: string
      toolCallId: string
      toolName: string
      input: unknown
    }
  | { type: 'usage'; usage: AgentRunUsage }
  | { type: 'warning'; code: string; message: string }
  | { type: 'step_started' }
  | { type: 'step_completed'; finishReason: string }
  | { type: 'completion'; finishReason: string }
  | { type: 'cancellation'; reason: string; pending: AgentPendingState | null }
  | { type: 'failure'; error: AgentRunFailure }
)

export interface AgentPendingState {
  runId: string
  pausedAt: number
  contextFingerprint: string
  resumeMode: 'fresh_request'
  reason: string
}

export interface AgentRuntime<TTools = unknown> {
  readonly capabilities: AgentRuntimeCapabilities
  run(request: AgentRunRequest<TTools>): AsyncIterable<AgentRunEvent>
  pause(runId: string, reason?: string): AgentPendingState | null
  resume(request: AgentRunRequest<TTools>): AsyncIterable<AgentRunEvent>
  cancel(runId: string, reason?: string): void
  pending(runId: string): AgentPendingState | null
}

export class UnsupportedAgentCapabilityError extends Error {
  readonly capability: AgentCapability

  constructor(capability: AgentCapability) {
    super(`The selected provider does not support the requested agent capability: ${capability}.`)
    this.name = 'UnsupportedAgentCapabilityError'
    this.capability = capability
  }
}

export class AgentRunStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentRunStateError'
  }
}

interface ActiveAgentRun<TTools> {
  request: AgentRunRequest<TTools>
  controller: AbortController
  state: 'running' | 'pausing' | 'cancelling'
  interruptionReason: string | null
}

const DEFAULT_AI_SDK_CAPABILITIES: AgentRuntimeCapabilities = {
  text: true,
  structured_output: false,
  tools: true,
  permission_requests: true,
  person_input_requests: true,
  pause_resume: true,
}

function requestedCapabilities<TTools>(request: AgentRunRequest<TTools>): Set<AgentCapability> {
  const requested = new Set<AgentCapability>(request.requiredCapabilities ?? [])
  requested.add(request.output.kind === 'structured' ? 'structured_output' : 'text')
  if (request.tools != null && typeof request.tools === 'object' && Object.keys(request.tools).length > 0) {
    requested.add('tools')
  }
  for (const interaction of Object.values(request.toolInteractions ?? {})) {
    if (interaction === 'permission') requested.add('permission_requests')
    if (interaction === 'person_input') requested.add('person_input_requests')
  }
  return requested
}

export function validateAgentRunRequest<TTools>(
  capabilities: AgentRuntimeCapabilities,
  request: AgentRunRequest<TTools>,
): void {
  if (!request.runId.trim()) throw new AgentRunStateError('Agent runs require a non-empty runId.')
  if (!request.contextPacket?.id) throw new AgentRunStateError('Agent runs require a Context packet.')
  for (const capability of requestedCapabilities(request)) {
    if (!capabilities[capability]) throw new UnsupportedAgentCapabilityError(capability)
  }
  for (const [name, value] of Object.entries(request.limits)) {
    if (value != null && (!Number.isInteger(value) || value < 1)) {
      throw new AgentRunStateError(`Agent run limit ${name} must be a positive integer.`)
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function failureFrom(error: unknown): AgentRunFailure {
  const code = error instanceof Error && error.name ? error.name : 'agent_run_failed'
  return { code, message: errorMessage(error), retryable: false }
}

function warningFrom(warning: unknown): { code: string; message: string } {
  if (warning && typeof warning === 'object') {
    const value = warning as { type?: unknown; message?: unknown }
    return {
      code: typeof value.type === 'string' ? value.type : 'provider_warning',
      message: typeof value.message === 'string' ? value.message : errorMessage(warning),
    }
  }
  return { code: 'provider_warning', message: errorMessage(warning) }
}

function normalizeUsage(usage: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: {
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokenDetails?: {
    reasoningTokens?: number
  }
}): AgentRunUsage {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  }
}

function abortReason(signal: AbortSignal, fallback: string): string {
  if (typeof signal.reason === 'string' && signal.reason.trim()) return signal.reason
  if (signal.reason instanceof Error && signal.reason.message) return signal.reason.message
  return fallback
}

// Product pause aborts the ambient signal with no usable reason today. Owned
 // callers can mark the signal before aborting so the runtime records pending
 // state instead of cancelling. Cross-lane: aiCancellation should abort with a
 // pause reason or call signalAgentRunPause before aborting.
const pauseSignaledSignals = new WeakSet<AbortSignal>()

/** Mark an AbortSignal so a later abort is treated as pause, not cancel. */
export function signalAgentRunPause(signal: AbortSignal): void {
  pauseSignaledSignals.add(signal)
}

export function isAgentRunPauseSignaled(signal: AbortSignal): boolean {
  return pauseSignaledSignals.has(signal)
}

function isPauseAbortReason(reason: unknown): boolean {
  if (reason === 'pause') return true
  if (typeof reason === 'string' && reason === 'Generation paused.') return true
  if (reason instanceof Error && reason.message === 'Generation paused.') return true
  return false
}

function shouldPauseFromSignal(signal: AbortSignal): boolean {
  return isAgentRunPauseSignaled(signal) || isPauseAbortReason(signal.reason)
}

export class AISdkAgentRuntime implements AgentRuntime<ToolSet> {
  readonly capabilities: AgentRuntimeCapabilities
  private readonly activeRuns = new Map<string, ActiveAgentRun<ToolSet>>()
  private readonly pendingRuns = new Map<string, AgentPendingState>()

  constructor(
    private readonly model: LanguageModel,
    capabilities: Partial<AgentRuntimeCapabilities> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.capabilities = { ...DEFAULT_AI_SDK_CAPABILITIES, ...capabilities }
  }

  run(request: AgentRunRequest<ToolSet>): AsyncIterable<AgentRunEvent> {
    validateAgentRunRequest(this.capabilities, request)
    if (this.activeRuns.has(request.runId) || this.pendingRuns.has(request.runId)) {
      throw new AgentRunStateError(`Agent run ${request.runId} already exists.`)
    }
    return this.start(request)
  }

  pause(runId: string, reason = 'Paused by the person.'): AgentPendingState | null {
    if (!this.capabilities.pause_resume) throw new UnsupportedAgentCapabilityError('pause_resume')
    const active = this.activeRuns.get(runId)
    if (!active) return this.pendingRuns.get(runId) ?? null
    const pending = this.beginPause(active, reason)
    active.controller.abort(reason)
    return pending
  }

  resume(request: AgentRunRequest<ToolSet>): AsyncIterable<AgentRunEvent> {
    if (!this.capabilities.pause_resume) throw new UnsupportedAgentCapabilityError('pause_resume')
    const pending = this.pendingRuns.get(request.runId)
    if (!pending) throw new AgentRunStateError(`Agent run ${request.runId} is not pending.`)
    if (this.activeRuns.has(request.runId)) {
      throw new AgentRunStateError(`Agent run ${request.runId} has not stopped yet.`)
    }
    if (request.contextPacket.assembledAt < pending.pausedAt) {
      throw new AgentRunStateError(
        `Agent run ${request.runId} must rebuild its Context packet and permissions before resuming.`,
      )
    }
    validateAgentRunRequest(this.capabilities, request)
    this.pendingRuns.delete(request.runId)
    return this.start(request)
  }

  cancel(runId: string, reason = 'Cancelled by the person.'): void {
    this.pendingRuns.delete(runId)
    const active = this.activeRuns.get(runId)
    if (!active) return
    active.state = 'cancelling'
    active.interruptionReason = reason
    active.controller.abort(reason)
  }

  pending(runId: string): AgentPendingState | null {
    return this.pendingRuns.get(runId) ?? null
  }

  private beginPause(active: ActiveAgentRun<ToolSet>, reason: string): AgentPendingState {
    const pending: AgentPendingState = {
      runId: active.request.runId,
      pausedAt: this.now(),
      contextFingerprint: active.request.contextPacket.contentFingerprint,
      resumeMode: 'fresh_request',
      reason,
    }
    active.state = 'pausing'
    active.interruptionReason = reason
    this.pendingRuns.set(active.request.runId, pending)
    return pending
  }

  private interruptFromExternalSignal(active: ActiveAgentRun<ToolSet>, signal: AbortSignal): void {
    if (active.state !== 'running') {
      active.controller.abort(active.interruptionReason ?? undefined)
      return
    }
    if (this.capabilities.pause_resume && shouldPauseFromSignal(signal)) {
      const reason = abortReason(signal, 'Paused by the person.')
      this.beginPause(active, reason)
      active.controller.abort(reason)
      return
    }
    active.state = 'cancelling'
    active.interruptionReason = abortReason(signal, 'Agent run cancelled.')
    active.controller.abort(active.interruptionReason)
  }

  private start(request: AgentRunRequest<ToolSet>): AsyncIterable<AgentRunEvent> {
    const active: ActiveAgentRun<ToolSet> = {
      request,
      controller: new AbortController(),
      state: 'running',
      interruptionReason: null,
    }
    this.activeRuns.set(request.runId, active)
    if (request.signal?.aborted) {
      this.interruptFromExternalSignal(active, request.signal)
    } else {
      request.signal?.addEventListener('abort', () => {
        this.interruptFromExternalSignal(active, request.signal!)
      }, { once: true })
    }
    return this.stream(active)
  }

  private async *stream(active: ActiveAgentRun<ToolSet>): AsyncGenerator<AgentRunEvent> {
    const { request, controller } = active
    let sequence = 0
    const event = <T extends Omit<AgentRunEvent, keyof AgentRunEventBase>>(
      value: T,
    ): AgentRunEvent => ({
      ...value,
      runId: request.runId,
      sequence: sequence++,
    } as AgentRunEvent)
    const cancellation = (): AgentRunEvent => event({
      type: 'cancellation',
      reason: active.interruptionReason ?? abortReason(controller.signal, 'Agent run cancelled.'),
      pending: active.state === 'pausing' ? this.pendingRuns.get(request.runId) ?? null : null,
    })

    try {
      if (controller.signal.aborted) {
        yield cancellation()
        return
      }
      const startStream = () => streamText({
        model: this.model,
        system: request.system,
        messages: [...request.messages] as ModelMessage[],
        tools: request.tools,
        stopWhen: request.limits.maxSteps == null
          ? undefined
          : stepCountIs(request.limits.maxSteps),
        maxOutputTokens: request.limits.maxOutputTokens,
        timeout: request.limits.timeoutMs,
        maxRetries: request.limits.maxRetries,
        abortSignal: controller.signal,
        experimental_onToolCallStart: () => {
          if (controller.signal.aborted) {
            const error = new Error(abortReason(controller.signal, 'Agent run cancelled.'))
            error.name = 'AbortError'
            throw error
          }
        },
      })
      // Rate-limit wait and call counting happen before the provider HTTP
      // request begins. The returned stream still yields tokens as they
      // arrive — the choke point does not buffer the whole turn.
      const result = request.execution
        ? await withChatProviderExecution(request.execution.provider, startStream, {
            label: request.execution.label ?? 'chat_answer',
          })
        : startStream()

      for await (const part of result.fullStream) {
        if (controller.signal.aborted && part.type !== 'abort') {
          yield cancellation()
          return
        }
        switch (part.type) {
          case 'text-delta':
            yield event({ type: 'text', text: part.text })
            break
          case 'tool-call': {
            const interaction = request.toolInteractions?.[part.toolName] ?? 'tool'
            if (interaction === 'person_input') {
              yield event({
                type: 'person_input_request',
                requestId: part.toolCallId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              })
            } else if (interaction === 'permission') {
              yield event({
                type: 'permission_request',
                requestId: part.toolCallId,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              })
            } else {
              yield event({
                type: 'tool_request',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              })
            }
            break
          }
          case 'tool-approval-request':
            yield event({
              type: 'permission_request',
              requestId: part.approvalId,
              toolCallId: part.toolCall.toolCallId,
              toolName: part.toolCall.toolName,
              input: part.toolCall.input,
            })
            break
          case 'tool-result':
            yield event({
              type: 'tool_result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
              failed: false,
            })
            break
          case 'tool-error':
            yield event({
              type: 'tool_result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: failureFrom(part.error),
              failed: true,
            })
            break
          case 'tool-output-denied':
            yield event({
              type: 'tool_result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: { denied: true },
              failed: true,
            })
            break
          case 'start-step':
            yield event({ type: 'step_started' })
            for (const warning of part.warnings) {
              const normalized = warningFrom(warning)
              yield event({ type: 'warning', ...normalized })
            }
            break
          case 'finish-step':
            yield event({ type: 'usage', usage: normalizeUsage(part.usage) })
            yield event({ type: 'step_completed', finishReason: part.finishReason })
            break
          case 'finish':
            yield event({ type: 'completion', finishReason: part.finishReason })
            break
          case 'abort':
            if (part.reason && !active.interruptionReason) active.interruptionReason = part.reason
            yield cancellation()
            return
          case 'error':
            yield event({ type: 'failure', error: failureFrom(part.error) })
            return
          default:
            break
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        yield cancellation()
      } else {
        yield event({ type: 'failure', error: failureFrom(error) })
      }
    } finally {
      this.activeRuns.delete(request.runId)
      if (active.state !== 'pausing') this.pendingRuns.delete(request.runId)
    }
  }
}
