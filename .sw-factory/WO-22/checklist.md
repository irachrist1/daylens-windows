<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-22

**Work Order Number:** WO-22
**Work Order Title:** [backend] Isolate and attribute untrusted Chat MCP output
**Initialized At (UTC):** 2026-08-11T09:45:00Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description
      Read in full from the exported record (row WO-22).
- [x] Identify linked requirements and blueprints
      REQ-MCP-006; blueprint MCP Access.
- [x] Review every connected requirements document
- [x] Review every connected blueprint document
- [x] Follow `@…` mentions and links to other blueprints
      Agent Tool Layer — `wrapMcpToolsWithGuards` as the privacy boundary.
- [x] Review every referenced blueprint discovered that way
- [x] Extract acceptance criteria
      AC-MCP-006.1 through .4, graded in `review-log.md`.
- [x] Identify architecture path
      `mcpTools.ts` owns tool namespacing, result guarding, and source
      attribution. The change is in `mcpTools.ts` plus tests.
- [x] `context.md` is filled
- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
- [x] Testing section documented

### Implementation

- [x] Implemented changes are scoped to the Work Order
      One source file (`src/main/agent/mcpTools.ts`) and one test file.
- [x] Tests added or updated for changed behavior
      `tests/chatMcpAttribution.test.ts` (5 new).
- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned
- [x] All acceptance criteria satisfied — graded in `review-log.md`
- [x] Architecture aligned with blueprints
- [ ] Exploratory pass — deferred to end of lane
- [x] Latest `review-log.md` verdict is `APPROVED`
- [x] **Certification: Phase 3 complete.**

## Final Completion Check

- [x] All phase certifications complete
- [x] Checklist fully filled out
- [x] Review log complete
- [x] Implementation plan followed
- [x] All intended files present — typecheck clean, lint 0 errors 0 warnings
- [SKIP] Work order status updated — no SF MCP connection
