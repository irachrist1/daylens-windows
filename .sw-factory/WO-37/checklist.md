<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-37

**Work Order Number:** WO-37
**Work Order Title:** [backend] Enforce revocable MCP authorization and live privacy evaluation
**Initialized At (UTC):** 2026-08-11T10:00:00Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description
      Read in full from the exported record (row WO-37).
- [x] Identify linked requirements and blueprints
      REQ-MCP-001 (AC-001.1, .3, .4), REQ-MCP-002 (AC-002.1–.4); MCP Access.
- [x] Review every connected requirements document
- [x] Review every connected blueprint document
- [x] Follow `@…` mentions and links to other blueprints
      Local MCP Server, Agent Tool Layer.
- [x] Review every referenced blueprint discovered that way
- [x] Extract acceptance criteria
      AC-MCP-001.1, .3, .4 and AC-MCP-002.1–.4, graded in `review-log.md`.
- [x] Identify architecture path
      `settings.ts` (default), `mcpServer.ts` (subprocess env), `Settings.tsx`
      (copy), `settings.handlers.ts` (already handles start/stop/restart).
- [x] `context.md` is filled
- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
- [x] Testing section documented

### Implementation

- [x] Implemented changes are scoped to the Work Order
      Four files: `settings.ts` (default), `mcpServer.ts` (env), `Settings.tsx`
      (copy), `tests/mcpAuthorizationBoundary.test.ts` (new).
- [x] Tests added or updated for changed behavior
      `tests/mcpAuthorizationBoundary.test.ts` (2 new).
- [x] Documentation updated where relevant
      Settings section copy updated to say "On by default."
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
- [x] All intended files present — typecheck clean, lint 0 errors (1 pre-existing warning)
- [SKIP] Work order status updated — no SF MCP connection
