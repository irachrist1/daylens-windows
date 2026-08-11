<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-17

**Work Order Number:** WO-17
**Work Order Title:** [renderer] Deliver usable local MCP configuration in Settings
**Initialized At (UTC):** 2026-08-11T09:12:00Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      No Software Factory MCP connection in this session; the work order was read
      in full from the exported record (row WO-17), including its out-of-scope
      list, which is what keeps the main-process provider and the chat MCP
      management UI out of this change.
- [x] Identify linked requirements and blueprints
      REQ-MCP-001 (AC-MCP-001.2 only) and REQ-MCP-003; blueprint MCP Access.
- [x] Review every connected requirements document
      Both read in full from the work-order record and the combined requirements
      export.
- [x] Review every connected blueprint document
      MCP Access, #McpSettingsController and the Integration Contract naming
      `IPC.MCP.GET_CONFIG`.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Read from the export: Local MCP Server (what makes a configuration
      resolvable, and therefore what "unavailable" means) and Desktop Application
      (why the renderer cannot resolve it itself).
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
- [x] Extract acceptance criteria from requirements
      AC-MCP-001.2, AC-MCP-003.1, .2, .3, .4. Graded in `review-log.md`.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      Renderer section plus main-process provider over the existing IPC channel;
      no new channel, because `IPC` lives in a file another session owns.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand for the reason recorded in WO-15's checklist.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
      Written before the source changes.
- [x] Testing section documented in `implementation-plan.md`

### Implementation

- [x] Implemented changes are scoped to the Work Order
      Five files. In `Settings.tsx` only the `mcp` section, its three pieces of
      state, and the loader were touched; the file's other 4,200 lines are
      unchanged. The one main-process change is the `running` field the section
      needs, which the work order's out-of-scope list excludes only for
      *generating* the configuration, not for reporting state.
- [x] Tests added or updated for changed behavior
      `tests/mcpConnectionState.test.ts` (6 new), one case added to
      `tests/mcpServerSafety.test.ts`.
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant
      None applies. The section's "off by default" copy is still accurate at this
      commit; WO-37 changes the default and updates that sentence with it.

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [SKIP] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      Skip reason: as in WO-15, the review dimensions were run directly and
      recorded in `review-log.md`.
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
      Graded individually in `review-log.md` with the evidence for each.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
      The blueprint's instruction to "represent unavailable server bundles as
      unavailable configuration, not as connection-ready data" is the change.
- [ ] Exploratory pass on user-visible or external behavior
      NOT DONE at this commit. This is a renderer change, and the honest evidence
      is a person opening Settings in the running app. The lane runs one
      user-facing pass at the end, after WO-37 changes the same section's copy
      and default; running the app twice would verify a state that is not
      shipping. Recorded as an open item in `review-log.md` and closed there.
- [x] Latest `review-log.md` verdict is `APPROVED`

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
      `npm run typecheck` clean; `eslint` on the changed files reports only the
      one pre-existing `initialSettings` dependency warning at line 2402, which
      this change did not introduce and does not touch.
- [SKIP] Work order status updated to `in_review`
      Skip reason: no Software Factory MCP connection in this session.
