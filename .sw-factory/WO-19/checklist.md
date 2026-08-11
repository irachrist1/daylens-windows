<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-19

**Work Order Number:** WO-19
**Work Order Title:** [backend] Persist and manage explicit Chat MCP servers
**Initialized At (UTC):** 2026-08-11T09:10:25Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      No Software Factory MCP connection; the work order was read in full from
      the exported record (row WO-19), including its in-scope and out-of-scope
      lists.
- [x] Identify linked requirements and blueprints
      REQ-MCP-004; blueprint MCP Access.
- [x] Review every connected requirements document
      REQ-MCP-004 read in full from the work-order record.
- [x] Review every connected blueprint document
      MCP Access — persisted `McpServerConfig` entries and chat-turn eligibility.
- [x] Follow `@…` mentions and links to other blueprints
      Local MCP Server (the `{ command, args, env }` shape), Agent Tool Layer
      (`connectMcpTools` as the single entry point).
- [x] Review every referenced blueprint discovered that way
- [x] Extract acceptance criteria from requirements
      AC-MCP-004.1 through .4, graded in `review-log.md`.
- [x] Identify architecture path from blueprints
      `mcpTools.ts` owns the server config type and the connection logic;
      `aiService.ts` already reads settings fresh each turn and passes the
      array through. The change is in `mcpTools.ts` plus tests.
- [x] `context.md` is filled
- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
      Written before the source changes.
- [x] Testing section documented in `implementation-plan.md`

### Implementation

- [x] Implemented changes are scoped to the Work Order
      One source file (`src/main/agent/mcpTools.ts`) and one test file. No
      files outside the lane were touched; `AppSettings.mcpServers` in
      `src/shared/types.ts` was reused as-is (the `enabled` field lives on
      `McpServerConfig` in `mcpTools.ts`, and stored entries without it
      default to enabled).
- [x] Tests added or updated for changed behavior
      `tests/chatMcpServerManagement.test.ts` (4 new).
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
      NOT DONE at this commit. This is a backend change with no renderer surface
      in scope. The lane runs one user-facing pass at the end.
- [x] Latest `review-log.md` verdict is `APPROVED`
- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
      `npm run typecheck` clean; `eslint` on the changed files reports 0
      errors and 0 warnings.
- [SKIP] Work order status updated to `in_review`
      Skip reason: no Software Factory MCP connection in this session.
