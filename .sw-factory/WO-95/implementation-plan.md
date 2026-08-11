<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-95

**Work Order:** WO-95 — [backend] Build the deterministic context-packet assembler
**Created At (UTC):** 2026-08-11T08:27:03Z

## Summary
Extend the existing deterministic context-packet assembler to satisfy the full
WO-95 request contract without replacing its proven corrected-fact, retrieval,
privacy, and persistence paths. The packet will preserve the original request,
resolve supported time references in an explicit timezone, carry tool and action
context, make its budget part of deterministic identity, and classify every
required omission reason.

## Code Reuse And Package Structure
Reuse:

- `src/main/services/contextPacket.ts` as the single assembler and packet type
  owner.
- Existing corrected Timeline, entity alias, exact search, semantic search,
  file-grant, connected-source, conflict, gap, exclusion, and sanitization
  paths unchanged.
- `tests/contextPacket.test.ts`, `tests/contextPacketGranolaGate.test.ts`, and
  `tests/agentOnContextPacket.test.ts` as the existing regression suites.

Intentionally modified:

- `src/main/services/contextPacket.ts` — expand the public packet/input contract,
  time resolution, omission taxonomy, deterministic budget representation, and
  prompt rendering.
- `.sw-factory/WO-95/*` — execution context, plan, checklist, and review record.

No migration is needed: WO-95 excludes packet storage, and the existing JSON
packet row can persist additive fields without a schema change. The strict lane
ownership list excludes test files, so no test source will be edited.

## Components And Flow
The linked factory blueprint provides no component definitions. The verified
local specification defines `Context assembler` and `AgentContextPacket`; the
live equivalents are `buildContextPacket` and `ContextPacket`.

`BuildContextPacketInput` will accept the exact request, purpose, optional
timezone, optional explicit dates, available tool descriptors, optional action
context, and an optional deterministic context budget. Time resolution produces
an inspectable range plus the ordered dates queried. The existing source
collectors produce candidate items; privacy and sensitivity gates remove
ineligible items and append typed omission summaries. Stable sorting and budget
selection produce the final disclosed items. The fingerprint covers purpose,
original request, resolved scope, entities, tools, action context, budget,
items, conflicts, gaps, permissions, and policy version.

For action runs, the caller supplies the already resolved immutable action
context; the assembler validates that it exists and carries it unchanged. This
keeps mutation semantics in the correction/action owner instead of guessing
targets from prose.

## Steps
1. **Expand the packet contract** — add purpose, time-range, tool-descriptor,
   action-context, context-budget, and omission types in
   `src/main/services/contextPacket.ts` while retaining compatibility for
   existing answer and interpretation callers.
2. **Resolve time deterministically** — replace the narrow date resolver with
   explicit date, relative day, week, month, and weekday handling against the
   requested IANA timezone, preserving sorted unique dates.
3. **Apply deterministic selection** — make the established per-kind limits an
   inspectable budget, include it in the fingerprint, and append omission
   records without exposing withheld content.
4. **Render the expanded contract** — include resolved scope, eligible tools,
   action readiness, and omission/gap honesty in deterministic agent prompt
   rendering.
5. **Review and verify** — run focused packet suites, typecheck, and lint; record
   strict-lane test-coverage limitations in the review log.

## Testing
Automated:

- `node scripts/run-tests.mjs contextPacket contextPacketGranolaGate agentOnContextPacket`
- `npm run typecheck`
- `npm run lint`

The existing suites cover deterministic fingerprints/order, revocation and
deletion exclusion, high-sensitivity omissions, entity resolution, disclosure
round trips, and chat prompt integration. No test file will be changed because
the assigned lane owns only the listed runtime source files; uncovered
WO-95-specific cases will be documented as a cross-lane dependency.

Manual:

- Inspect two packets assembled from identical fixed inputs and confirm equal
  content fingerprints, scope, tools, action context, budget, items, and
  ordering while per-exchange IDs differ.
- Inspect representative resolved ranges for relative day, week, month, and
  weekday phrases under a fixed timezone.
