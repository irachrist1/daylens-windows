<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-74

**Work Order:** WO-74 — [backend] Route all provider work through the execution-policy choke point
**Created At (UTC):** 2026-08-11T10:00:00Z

## Summary

Route chat provider work through one owned execution-policy module that applies the existing rate-limit choke and the selected Anthropic prompt-cache policy without changing the Context packet or answer contract. Background AI already passes through `executeTextAIJob`; this work order documents that path and closes the chat gap left after WO-73.

## Code Reuse And Package Structure

Reuse (import only — do not edit):

- `src/main/services/aiRateLimiter.ts` — `withProviderRateLimit`
- `src/main/services/aiOrchestration.ts` — `JOB_DEFINITIONS.chat_answer.cachePolicy`
- `src/main/services/settings.ts` — `aiPromptCachingEnabled`
- Existing background path in `executeTextAIJob` for spend, breaker, usage, and cache

Intentionally created or modified:

- `src/main/agent/executionPolicy.ts` (new) — owned chat choke: rate-limit wrap + Anthropic stable-prefix system cache markers
- `src/main/agent/agentRuntime.ts` — accept execution-policy options on the run request; wrap `streamText` and shape system content for cache
- `src/main/agent/chatAgent.ts` — pass provider and cache policy into the runtime; stop double-counting provider calls once the rate-limit wrap owns the count
- `.sw-factory/WO-74/*` — factory trail

## Components And Flow

```text
chatAgent
  → buildContextPacket / record (unchanged)
  → AISdkAgentRuntime.run({ ..., execution: { provider, cachePolicy, promptCachingEnabled } })
      → applyPromptCachePolicy(system)   // Anthropic stable_prefix only; no packet change
      → withProviderRateLimit(provider, () => streamText(...))
      → common AgentRunEvent stream
  → aiService.recordChatAgentUsage (unowned, after turn)
```

Background:

```text
executeTextAIJob (unowned) already applies rate limit, spend, breaker, usage, Anthropic cache
```

No product limits are invented; chat reuses `JOB_DEFINITIONS.chat_answer` and settings.

## Steps

1. **Document Phase 1 context** — verified architecture and acceptance criteria in `context.md`.
2. **Add `executionPolicy.ts`** — `withChatProviderExecution` (rate-limit wrap) and `applyChatPromptCacheToSystem` (Anthropic `providerOptions` ephemeral marker on the system message for `stable_prefix` when enabled).
3. **Extend the agent-run request** — optional `execution` block on `AgentRunRequest`; apply cache shaping and rate-limit wrap inside `AISdkAgentRuntime.stream`.
4. **Wire chatAgent** — pass `deps.config.provider`, job cache policy, and settings flag; remove redundant per-step `recordProviderCall` so the rate-limit wrap owns the count for each stream turn.
5. **Review and verify** — typecheck, lint, focused agent/runtime/packet suites; record background-path and analytics cross-lane notes.

## Testing

Automated:

```bash
npm run typecheck
npm run lint
node scripts/run-tests.mjs agentOnContextPacket agentTurnState aiRateLimiter
```

Manual / contract checks:

- Confirm `JOB_DEFINITIONS.chat_answer.cachePolicy` remains `stable_prefix` and chat applies markers only when caching is enabled and provider is Anthropic.
- Confirm Context packet assembly and answer citation contracts are unchanged (existing packet suites).
