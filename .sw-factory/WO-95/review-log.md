<!--lint disable strong-marker-->

# Review Log: WO-95

**Work Order:** WO-95 — [backend] Build the deterministic context-packet assembler
**Initialized At (UTC):** 2026-08-11T08:27:03Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1
Scope: the uncommitted WO-95 diff in
`src/main/services/contextPacket.ts`,
`src/main/services/contextPacketInspection.ts`, and `.sw-factory/WO-95/*`.
Review delegation was proposed and declined, so all dimensions were reviewed
directly.

### Requirements Alignment
**Blocking:**

- None.

**Advisory:**

- `BuildContextPacketInput` now accepts permitted tool descriptors and confirmed
  preferences, but the live chat caller does not populate them yet. That wiring
  belongs to the provider-independent run boundary in WO-73; WO-95 owns the
  deterministic assembler contract.
- Action packets assemble and fingerprint correctly, but the existing
  `context_packets` table rejects `purpose = 'act'`. Durable action-packet
  support is a WO-68 storage concern and must land before an action caller
  records one.

### Blueprint Alignment
**Blocking:**

- None.

**Advisory:**

- The linked Agent Runtime & Context Packet blueprint is an unfilled template:
  it has no component composition, feature components, contracts, references,
  or ADRs. Implementation was aligned to the complete requirement and
  `docs/specs/agent-runtime-and-context.md`, then verified against the live
  service. The blueprint should be regenerated from the actual architecture;
  it was not edited.

### Architecture And Conventions
**Blocking:**

- None.

**Advisory:**

- `src/shared/types.ts` still limits inspector purpose to `answer | interpret`.
  That file is explicitly outside this lane, so the owned inspector preserves
  runtime action values through a narrow adapter cast. The shared IPC type
  needs an owning-lane update before an action packet is exposed in the
  renderer.
- The review found and fixed an initial default-budget regression that would
  have reduced multi-day day facts and transcript capacity. The final default
  budget reflects the pre-existing per-day/source caps and scales with the
  resolved day count; callers may only narrow it.

### Tests And Build
**Commands run:**

- `npm run typecheck` — pass.
- `npm run lint` — 0 errors, 128 pre-existing warnings; no warning in either
  changed source file.
- `node scripts/run-tests.mjs contextPacket contextPacketGranolaGate agentOnContextPacket`
  — 30 pass, 0 fail, 0 skip.
- Direct fixed-clock checks through `jiti` — pass for Los Angeles cross-midnight
  `yesterday`, `this week`, `last month`, `last monday`, and malformed ISO-date
  rejection.

**Blocking:**

- None.

**Advisory:**

- The strict ownership list excludes test files, so the new action, tool,
  confirmed-preference, and context-budget branches have manual/type coverage
  but no committed focused regression cases in this lane. The owner of the
  relevant test files should add them.

### User-Facing Verification
**Skipped:** yes — WO-95 is a deterministic main-process assembler contract
with no renderer change or externally visible flow. The later Context Inspector
work order owns the visible surface.

**Evidence:** The fixed-clock direct checks inspected the resolved packet scope,
and the existing chat integration suite verified that packet content reaches the
model prompt without disclosure-order regressions.

**Blocking:**

- None.

**Advisory:**

- None.

### Security, Privacy, And Data Safety
**Skipped:** no.

**Blocking:**

- None.

**Advisory:**

- No withheld content is copied into omission records; only kind, count, and
  reason are retained. Revocation, deletion, tracking exclusion, secret
  sanitization, and high-sensitivity gates remain before final budget selection.
- No credential, real activity, provider prompt, or private fixture was added.

### Round 1 Verdict
- Total blocking: 0
- Total advisory: 7
- Files reviewed: 6
- **Verdict:** APPROVED

---
