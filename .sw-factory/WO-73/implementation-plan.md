<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-73

**Work Order:** WO-73 — [backend] Introduce the provider-independent agent-run contract
**Created At (UTC):** 2026-08-11T09:41:53Z

## Summary

Introduce a provider-neutral `AgentRuntime` contract and put the incumbent AI
SDK stream behind an adapter. `chatAgent.ts` will consume normalized runtime
events while preserving its renderer-facing stream protocol, durable
checkpointing, and fresh-context resume behavior.

## Code Reuse And Package Structure

Reuse:

- `ContextPacket` from `src/main/services/contextPacket.ts` as the run's
  provider-independent context input.
- AI SDK `streamText` only inside the incumbent adapter; provider stream-part
  knowledge will no longer live in `chatAgent.ts`.
- The existing per-turn `ToolSet`, renderer `AIStreamEvent` protocol, usage
  accumulation, tool tracing, and `MAX_TOOL_STEPS` limit.
- `getAIAbortSignal` and the existing durable checkpoint lifecycle. A resumed
  turn continues to rebuild its packet and permission-bound tools before it
  enters the runtime.
- Existing chat streaming, cancellation, pause, checkpoint, and trace suites as
  regression coverage.

Intentionally modified:

- `src/main/agent/agentRuntime.ts` — new provider-independent input, capability,
  pending-state, and normalized event contract plus the incumbent AI SDK
  adapter.
- `src/main/agent/chatAgent.ts` — delegate provider execution to
  `AgentRuntime` and translate normalized events to the unchanged renderer
  stream.
- `.sw-factory/WO-73/*` — execution context, plan, checklist, and review record.

Tests are outside this lane and will not be edited. Execution-policy controls
remain reserved for WO-74.

## Components And Flow

The linked blueprint defines no concrete components. The implementation will
create the runtime seam required by the complete requirement:

- `AgentRunRequest<TTools>` carries the current Context packet, permitted tools,
  output requirements, run limits, provider-neutral messages, system
  instructions, and cancellation signal.
- `AgentRuntimeCapabilities` and requested requirements permit synchronous
  validation before the adapter invokes a provider.
- `AgentRunEvent` is a discriminated union covering every required event family,
  with step boundaries included so existing multi-step final-answer behavior
  remains deterministic.
- `AgentPendingState` records paused runs without retaining stale Context
  packets or permission objects. `resume` accepts a new complete request and
  validates it again.
- `AISdkAgentRuntime` owns `streamText`, converts stream parts into common
  events, combines internal and external cancellation, and guards every tool
  executor against starting after cancellation.

`chatAgent.ts` constructs the same model, tools, messages, and packet it does
today, passes them through the runtime, and maps common events back to the
unchanged IPC stream. Durable pause/resume remains owned by the outer turn
checkpoint because it survives process restarts; the runtime's explicit pending
state defines the provider-neutral in-process contract.

## Steps

1. **Define the boundary** — add provider-neutral run inputs, capability
   validation, event types, errors, pending-state operations, and adapter
   interfaces in `agentRuntime.ts`.
2. **Adapt the incumbent provider path** — implement the AI SDK adapter,
   cancellation-aware tool guards, event normalization, and pause/resume state
   without adding WO-74 controls.
3. **Move chat onto the boundary** — replace direct provider stream handling in
   `chatAgent.ts` with normalized event consumption while preserving text,
   traces, usage, finish reasons, checkpoints, and UI error behavior.
4. **Review and verify** — inspect the diff for provider leakage and lifecycle
   gaps, then run typecheck, lint, focused agent suites, direct contract checks,
   and the full suite.

## Testing

Automated:

- `npm run typecheck`
- `npm run lint`
- `node scripts/run-tests.mjs chatAgentStreaming chatAgentTraceRecording aiCancellation chatTurnsPause agentTurnState chatTurnReconciliation agentOnContextPacket`
- `node scripts/run-tests.mjs`

Direct contract checks will use an injected fake adapter/model stream to verify:

- unsupported structured output and unsupported tools are rejected before the
  provider factory is invoked;
- every required provider event category has a stable common representation;
- pause records pending state without retaining a Context packet, and resume
  rejects stale or mismatched requests before accepting a fresh one;
- cancellation aborts streaming and a guarded executor refuses a tool call that
  begins afterward.

No test source will be edited because the strict ownership list excludes tests.
