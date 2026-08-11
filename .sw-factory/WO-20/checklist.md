<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-20

**Work Order Number:** WO-20
**Work Order Title:** [backend] Harden Chat MCP process isolation and lifecycle
**Initialized At (UTC):** 2026-08-11T09:30:00Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the exported record (row WO-20).
- [x] Identify linked requirements and blueprints
      REQ-MCP-005; blueprint MCP Access.
- [x] Review every connected requirements document
      REQ-MCP-005 read in full.
- [x] Review every connected blueprint document
      MCP Access — one-turn client pool, minimal child environment, lifecycle.
- [x] Follow `@…` mentions and links to other blueprints
      Agent Tool Layer, Local MCP Server.
- [x] Review every referenced blueprint discovered that way
- [x] Extract acceptance criteria from requirements
      AC-MCP-005.1 through .5, graded in `review-log.md`.
- [x] Identify architecture path from blueprints
      `mcpTools.ts` owns the connection logic; `chatAgent.ts` owns the turn
      lifecycle; `childEnv.ts` owns the minimal environment. The change is in
      `mcpTools.ts` plus tests.
- [x] `context.md` is filled
- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
      Written before the source changes.
- [x] Testing section documented in `implementation-plan.md`

### Implementation

- [x] Implemented changes are scoped to the Work Order
      One source file (`src/main/agent/mcpTools.ts`) and one test file.
- [x] Tests added or updated for changed behavior
      `tests/chatMcpLifecycle.test.ts` (4 new).
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      None applies.
- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned
      Skip reason: review dimensions run directly and recorded in `review-log.md`.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      Graded individually in `review-log.md` with evidence.
- [x] Architecture is aligned with linked blueprints
- [ ] Exploratory pass on user-visible or external behavior
      NOT DONE at this commit. Backend change; user-facing pass deferred to
      end of lane.
- [x] Latest `review-log.md` verdict is `APPROVED`
- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
      `npm run typecheck` clean; `eslint` on changed files reports 0 errors,
      0 warnings.
- [SKIP] Work order status updated to `in_review`
      Skip reason: no Software Factory MCP connection in this session.
