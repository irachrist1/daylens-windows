<!--lint disable strong-marker-->

# Work Order Entity Index: WO-73

**Initialized At (UTC):** 2026-08-11T09:41:53Z
**Current Status:** in_review

## Work Order

- WO-73: [backend] Introduce the provider-independent agent-run contract (`d95a12c1-48bb-4e8d-a5a7-2e634bcd6b71`)

## Requirements

- Agent Runtime & Context Packet (`/Users/tonny/Downloads/Daylens_Combined_Requirements.md#agent-runtime-context-packet`)

## Blueprints

- Agent Runtime & Context Packet (`b3ed6474-1327-4b15-b0fe-6fdb956f9868`)

## Referenced Blueprints

Blueprints reached through `@…` mentions and links while reading linked blueprints.
- None. The linked blueprint section is an unfilled template with no component
  composition, contracts, ADRs, `@…` mentions, or blueprint links.

## Acceptance Criteria

- One provider-independent run boundary accepts a Context packet, permitted
  tools, output requirements, and run limits.
- Provider output is normalized into common text, structured-output, tool,
  permission, person-input, usage, warning, completion, cancellation, and
  failure events.
- Unsupported capabilities fail before provider execution begins.
- Pausing preserves explicit pending state; resuming requires a fresh request so
  current context and permissions are rechecked.
- Cancellation aborts provider streaming and prevents later tool execution.

## Verified Architecture

- `src/main/agent/chatAgent.ts` currently owns the AI SDK `streamText` loop and
  translates provider stream parts directly into the renderer's existing
  `AIStreamEvent` protocol.
- `src/main/agent/providerModel.ts` selects an AI SDK language model and separately
  determines whether that provider supports tool use. There is no shared runtime
  capability contract.
- `src/main/lib/aiCancellation.ts` supplies one abort signal per request.
  `src/main/services/agentTurnState.ts` and `chatAgent.ts` persist resumable
  checkpoints outside the provider stream, then rebuild a fresh Context packet
  when a paused request resumes.
- The incumbent AI SDK stream already exposes text deltas, tool calls/results,
  warnings, usage, step boundaries, completion, cancellation, and failure data.
  Tool names identify permission and person-input interactions that must be
  normalized without changing existing UI events.
- Execution-policy rate, spend, quota, usage-retention, and prompt-cache controls
  belong to WO-74 and are intentionally excluded.
- The detailed live architecture is recorded in
  `docs/specs/agent-runtime-and-context.md`; the linked factory blueprint is an
  unfilled template.

## Delivery

- Branch: wave/1-runtime
- Pull Request URL:
