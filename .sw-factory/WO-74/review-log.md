<!--lint disable strong-marker-->

# Review Log: WO-74

**Work Order:** WO-74 — [backend] Route all provider work through the execution-policy choke point
**Initialized At (UTC):** 2026-08-11T09:30:00Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

Scope: uncommitted WO-74 changes —
`src/main/agent/executionPolicy.ts` (new),
`src/main/agent/agentRuntime.ts`,
`src/main/agent/chatAgent.ts`,
and `.sw-factory/WO-74/*`.
Review run directly (no delegated subagent).

### Requirements Alignment

Graded against REQ-AIA-RT-002 / AC-AIA-RT-002.1–002.5.

**Blocking:**

- None.

**Advisory:**

- AC.2 / AC.3 (background spend guardrails and hard-quota cooldown) are already
  enforced inside unowned `executeTextAIJob` / `aiSpendGuardrails` /
  `providerCircuitBreaker`. This work order verified those paths in code rather
  than reimplementing them in the owned lane.
- AC.4 usage retention for chat continues through the existing
  `recordChatAgentUsage` path in unowned `aiService`. That recorder still hardcodes
  analytics `cache_policy: 'off'` even when Anthropic cache markers are applied —
  a cross-lane reporting drift, not a packet/answer-contract change.
- Chat rate-limit wrapping counts the stream start (`streamText`) rather than every
  multi-step HTTP hop; previously `recordProviderCall` ran per finish-step. Spacing
  and cooldown still apply before chat provider work proceeds (AC.1).

### Blueprint Alignment

**Blocking:**

- None.

**Advisory:**

- The linked Agent Runtime & Context Packet blueprint remains an empty template.
  Implementation followed verified orchestration code and
  `docs/specs/agent-runtime-and-context.md`.

### Architecture And Conventions

**Blocking:**

- None.

**Advisory:**

- Owned-lane adapter pattern: `executionPolicy.ts` reuses `withProviderRateLimit`
  and the job `cachePolicy` vocabulary without editing unowned services.
- Prompt-cache markers use AI SDK `SystemModelMessage` + Anthropic
  `cacheControl: ephemeral` on the stable system prefix only; the Context packet
  text remains the dynamic second system message (AC.5).

### Tests And Build

**Commands run:**

```bash
npm run typecheck
# pass

npm run lint
# 0 errors, 128 pre-existing warnings

node scripts/run-tests.mjs agentOnContextPacket agentTurnState aiRateLimiter
# 23 pass, 0 fail
```

**Blocking:**

- None.

**Advisory:**

- No new dedicated `executionPolicy` test file (lane test ownership not expanded).
  Coverage is via chat integration suites plus the existing rate-limiter unit tests.

### User-Facing Verification

**Skipped:** yes — no renderer or Settings UI change; choke-point behavior is
main-process only.

**Evidence:** Focused agent and rate-limiter suites above.

**Blocking:**

- None.

**Advisory:**

- None.

### Security, Privacy, And Data Safety

**Skipped:** no.

**Blocking:**

- None.

**Advisory:**

- No credentials, real activity, or provider secrets entered commits or fixtures.
- Prompt-cache policy does not expand disclosed context; packet assembly and
  answer grounding contracts are unchanged.

### Round 1 Verdict

- Total blocking: 0
- Total advisory: 6
- Files reviewed: 6
- **Verdict:** APPROVED

---
