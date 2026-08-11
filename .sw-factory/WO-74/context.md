<!--lint disable strong-marker-->

# Work Order Entity Index: WO-74

**Initialized At (UTC):** 2026-08-11T10:00:00Z
**Current Status:** in_review

## Work Order

- WO-74: [backend] Route all provider work through the execution-policy choke point (`996564b2-90a2-4759-9b4a-1b8f76fe057d`)

## Requirements

- Agent Runtime & Context Packet (`/Users/tonny/Downloads/Daylens_Combined_Requirements.md#agent-runtime-context-packet`)
  - REQ-AIA-RT-002 / AC-AIA-RT-002.1 through AC-AIA-RT-002.5

## Blueprints

- Agent Runtime & Context Packet (`b3ed6474-1327-4b15-b0fe-6fdb956f9868`)

## Referenced Blueprints

Blueprints reached through `@…` mentions and links while reading linked blueprints.

- None. The linked blueprint section is an unfilled template.

## Acceptance Criteria

- Chat and background provider requests apply rate-limit control before provider work proceeds.
- Background requests that would exceed a spend limit apply the configured guardrail before continuing.
- Hard quota or credit failures record provider state and prevent affected background AI during cooldown.
- Agent-run completion or failure retains provider, model, usage, cost, cache-use, outcome, and retention state.
- Eligible reusable prompt segments apply the selected prompt-cache policy without changing the Context packet or answer contract.

## Verified Architecture

- Background text jobs already choke through `executeTextAIJob` in unowned `aiOrchestration.ts`: rate limit (`withProviderRateLimit`), spend guardrails (`aiSpendGuardrails`), circuit breaker (`providerCircuitBreaker`), usage retention (`recordAIUsage`), and Anthropic cache (`anthropicPromptCaching`).
- Chat after WO-73 runs through owned `agentRuntime.ts` / `chatAgent.ts`. It counts provider steps with `recordProviderCall` but does not wrap streamText in `withProviderRateLimit` and does not apply Anthropic stable-prefix cache markers (job definition declares `cachePolicy: 'stable_prefix'`).
- Chat usage retention already happens after the turn via unowned `recordChatAgentUsage` (called from `aiService.ts`). That path currently hardcodes analytics `cache_policy: 'off'` — a cross-lane advisory once chat actually caches.
- Settings `aiPromptCachingEnabled` defaults true (`settings.ts`).

## Delivery

- Branch: wave/1-runtime
- Pull Request URL:
